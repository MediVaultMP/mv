import { keccak256, toUtf8Bytes } from 'ethers';
import { AppError } from '../utils/app-error.js';
import {
  basicProfileChainId,
  basicProfileSha256
} from './basic-profile-signature.js';
import {
  clinicalSha256,
  medicationsSha256,
  prescriptionRootSha256
} from './prescription-document.js';

const EXPLORERS = {
  1: 'https://etherscan.io',
  11155111: 'https://sepolia.etherscan.io'
};

const MAX_ACTIVITY = 40;
const PROFILE_EDITABLE = ['bloodGroup', 'dateOfBirth', 'emergencyContactName', 'emergencyContactPhone'];

function withPrefix(hash) {
  return hash ? `0x${String(hash).trim().replace(/^0x/i, '').toLowerCase()}` : null;
}

// Settles every promise, turning failures into null so one slow or failing
// RPC call never hides the rest of the ledger.
async function settle(promises) {
  const results = await Promise.allSettled(promises);
  return results.map((result) => (result.status === 'fulfilled' ? result.value : null));
}

// Builds the patient's "Blockchain" view: every record whose fingerprint is
// anchored on chain, with the database hash next to the hash read live from
// the contract, plus the access and audit transactions about the patient.
// Everything here is read-only.
export class BlockchainLedgerService {
  constructor({
    database,
    recordRegistryClient,
    emergencyProfileRepository,
    medicalStorage,
    fileEncryptionService,
    chainId,
    contractAddress,
    isMockChain = false
  }) {
    this.database = database;
    this.recordRegistryClient = recordRegistryClient;
    this.emergencyProfileRepository = emergencyProfileRepository;
    this.medicalStorage = medicalStorage;
    this.fileEncryptionService = fileEncryptionService;
    this.chainId = Number(chainId);
    this.contractAddress = contractAddress;
    this.isMockChain = isMockChain;
  }

  explorerUrl() {
    return this.isMockChain ? null : EXPLORERS[this.chainId] ?? null;
  }

  // The bytes32 key the contract stores a record under (topic 1 on Etherscan).
  chainKey(recordId) {
    return this.isMockChain ? null : keccak256(toUtf8Bytes(`medivault-record:${recordId}`));
  }

  async chainHash(recordId, version) {
    const client = this.recordRegistryClient;
    if (!client) return null;
    if (version && typeof client.getRecordVersion === 'function') {
      const entry = await client.getRecordVersion({ recordId, version });
      return withPrefix(entry?.contentHash);
    }
    const entry = await client.getRegisteredRecord({ recordId });
    return withPrefix(entry?.contentHash);
  }

  async blockNumber(transactionHash) {
    if (!transactionHash || typeof this.recordRegistryClient?.getTransactionBlock !== 'function') return null;
    return this.recordRegistryClient.getTransactionBlock(transactionHash.trim());
  }

  async loadBlocks(patientUserId) {
    const [profile, profileHistory, recordVersions, prescriptions] = await Promise.all([
      this.database.query(
        `SELECT version, profile_sha256, blockchain_status, blockchain_tx_hash, signer_address,
                signed_at, updated_at, created_at
           FROM patient_emergency_profiles WHERE patient_user_id = $1`,
        [patientUserId]
      ),
      this.database.query(
        `SELECT DISTINCT ON (version) version, profile_sha256, created_at
           FROM patient_emergency_profile_audit
          WHERE patient_user_id = $1 AND profile_sha256 IS NOT NULL AND version IS NOT NULL
          ORDER BY version, created_at`,
        [patientUserId]
      ),
      this.database.query(
        `SELECT v.id, v.medical_record_id, v.version_number, v.title, v.category, v.content_sha256,
                v.blockchain_status, v.blockchain_tx_hash, v.created_at, r.signer_address
           FROM medical_record_versions v
           JOIN medical_records r ON r.id = v.medical_record_id
          WHERE r.patient_user_id = $1
          ORDER BY v.created_at`,
        [patientUserId]
      ),
      this.database.query(
        `SELECT id, title, content_sha256, medications_sha256, clinical_sha256, blockchain_status,
                blockchain_tx_hash, signer_address, created_at
           FROM prescriptions WHERE patient_user_id = $1
          ORDER BY created_at`,
        [patientUserId]
      )
    ]);

    const blocks = [];
    const current = profile.rows[0];

    if (current?.profile_sha256) {
      const chainId = basicProfileChainId(patientUserId);
      const history = new Map(profileHistory.rows.map((row) => [Number(row.version), row]));
      for (let version = 1; version <= Number(current.version); version += 1) {
        const isCurrent = version === Number(current.version);
        const past = history.get(version);
        const hash = isCurrent ? current.profile_sha256 : past?.profile_sha256;
        if (!hash) continue;
        blocks.push({
          kind: 'basic_profile',
          label: version === 1 ? 'Basic profile created' : `Basic profile updated (version ${version})`,
          resourceId: patientUserId,
          version,
          chainRecordId: chainId,
          createdAt: isCurrent ? current.signed_at ?? current.updated_at ?? current.created_at : past.created_at,
          dbHash: hash,
          dbLocation: { table: 'patient_emergency_profiles', column: 'profile_sha256', rowKey: `patient_user_id = ${patientUserId}` },
          txHash: isCurrent ? current.blockchain_tx_hash : null,
          status: isCurrent ? current.blockchain_status : 'registered',
          signerAddress: isCurrent ? current.signer_address : null,
          canSimulate: isCurrent
        });
      }
    }

    for (const row of recordVersions.rows) {
      blocks.push({
        kind: 'lab_report',
        label: row.version_number > 1
          ? `${row.title || 'Lab report'} (version ${row.version_number})`
          : row.title || 'Lab report',
        resourceId: row.medical_record_id,
        version: Number(row.version_number),
        chainRecordId: row.medical_record_id,
        createdAt: row.created_at,
        dbHash: row.content_sha256,
        dbLocation: { table: 'medical_record_versions', column: 'content_sha256', rowKey: `id = ${row.id}` },
        txHash: row.blockchain_tx_hash,
        status: row.blockchain_status,
        signerAddress: row.signer_address,
        category: row.category,
        canSimulate: false
      });
    }

    for (const row of prescriptions.rows) {
      blocks.push({
        kind: 'prescription',
        label: row.title || 'Prescription',
        resourceId: row.id,
        version: null,
        chainRecordId: row.id,
        createdAt: row.created_at,
        dbHash: row.content_sha256,
        dbLocation: { table: 'prescriptions', column: 'content_sha256', rowKey: `id = ${row.id}` },
        txHash: row.blockchain_tx_hash,
        status: row.blockchain_status,
        signerAddress: row.signer_address,
        canSimulate: Boolean(row.medications_sha256 && row.clinical_sha256)
      });
    }

    blocks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return blocks;
  }

  async loadActivity(patientUserId) {
    const result = await this.database.query(
      `SELECT e.id, e.event_type, e.created_at, e.blockchain_tx_hash, e.resource_type,
              a.name AS actor_name, a.role AS actor_role
         FROM audit_events e
         LEFT JOIN users a ON a.id = e.actor_user_id
        WHERE (e.subject_user_id = $1 OR e.actor_user_id = $1)
          AND e.blockchain_tx_hash IS NOT NULL
        ORDER BY e.created_at DESC
        LIMIT $2`,
      [patientUserId, MAX_ACTIVITY]
    );

    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      createdAt: row.created_at,
      txHash: row.blockchain_tx_hash?.trim() ?? null,
      dbLocation: { table: 'audit_events', column: 'blockchain_tx_hash', rowKey: `id = ${row.id}` }
    }));
  }

  async getPatientLedger(patientUserId) {
    const [blocks, activity, patient] = await Promise.all([
      this.loadBlocks(patientUserId),
      this.loadActivity(patientUserId),
      this.database.query('SELECT blockchain_address FROM users WHERE id = $1', [patientUserId])
    ]);

    const [chainHashes, blockNumbers] = await Promise.all([
      settle(blocks.map((block) => this.chainHash(block.chainRecordId, block.version))),
      settle(blocks.map((block) => this.blockNumber(block.txHash)))
    ]);

    let previousHash = null;
    const chain = blocks.map((block, index) => {
      const dbHash = withPrefix(block.dbHash);
      const chainHash = chainHashes[index];
      const item = {
        index: index + 1,
        kind: block.kind,
        label: block.label,
        resourceId: block.resourceId,
        version: block.version,
        category: block.category ?? null,
        createdAt: block.createdAt,
        dbHash,
        chainHash,
        matches: chainHash === null ? null : chainHash === dbHash,
        status: block.status,
        txHash: block.txHash?.trim() || null,
        blockNumber: blockNumbers[index],
        chainKey: this.chainKey(block.chainRecordId),
        signerAddress: block.signerAddress ?? null,
        dbLocation: block.dbLocation,
        previousHash,
        canSimulate: block.canSimulate
      };
      previousHash = dbHash;
      return item;
    });

    return {
      network: this.isMockChain ? 'mock' : this.chainId === 11155111 ? 'sepolia' : String(this.chainId),
      explorerUrl: this.explorerUrl(),
      contractAddress: this.contractAddress,
      patientAddress: patient.rows[0]?.blockchain_address ?? null,
      checkedAt: new Date().toISOString(),
      summary: {
        total: chain.length,
        verified: chain.filter((item) => item.matches === true).length,
        mismatched: chain.filter((item) => item.matches === false).length
      },
      blocks: chain,
      activity
    };
  }

  // Shows what would happen if someone edited a record: recomputes the
  // fingerprint with the edit applied and compares it with the chain. Nothing
  // is saved and nothing is sent to the chain.
  async simulateEdit(patientUserId, { kind, resourceId, changes }) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new AppError(400, 'Describe the edit to try.', 'INVALID_SIMULATION');
    }

    if (kind === 'basic_profile') return this.simulateProfileEdit(patientUserId, changes);
    if (kind === 'prescription') return this.simulatePrescriptionEdit(patientUserId, resourceId, changes);

    throw new AppError(400, 'Only the basic profile and prescriptions can be tried here.', 'INVALID_SIMULATION');
  }

  async simulateProfileEdit(patientUserId, changes) {
    const profile = await this.emergencyProfileRepository.findByPatientId(patientUserId);
    if (!profile?.signature?.profileSha256) {
      throw new AppError(404, 'There is no signed basic profile yet.', 'EMERGENCY_PROFILE_NOT_FOUND');
    }

    const edited = {
      ...profile,
      emergencyContactName: profile.emergencyContact?.name ?? null,
      emergencyContactPhone: profile.emergencyContact?.phone ?? null,
      emergencyContactRelationship: profile.emergencyContact?.relationship ?? null
    };
    const before = {
      bloodGroup: profile.bloodGroup ?? null,
      dateOfBirth: profile.dateOfBirth ?? null,
      emergencyContactName: profile.emergencyContact?.name ?? null,
      emergencyContactPhone: profile.emergencyContact?.phone ?? null
    };
    const applied = {};
    for (const key of PROFILE_EDITABLE) {
      if (typeof changes[key] === 'string' && changes[key].trim()) {
        edited[key] = changes[key].trim().slice(0, 200);
        applied[key] = { from: before[key], to: edited[key] };
      }
    }
    delete edited.emergencyContact;

    const version = Number(profile.version);
    const recomputed = withPrefix(basicProfileSha256(patientUserId, version, { ...profile }));
    const editedHash = withPrefix(basicProfileSha256(patientUserId, version, edited));
    const chainHash = await settle([this.chainHash(basicProfileChainId(patientUserId), version)]);

    return this.simulationResult({
      dbHash: withPrefix(profile.signature.profileSha256),
      recomputed,
      editedHash,
      chainHash: chainHash[0],
      applied
    });
  }

  async simulatePrescriptionEdit(patientUserId, prescriptionId, changes) {
    const result = await this.database.query(
      'SELECT * FROM prescriptions WHERE id = $1 AND patient_user_id = $2',
      [prescriptionId, patientUserId]
    );
    const prescription = result.rows[0];
    if (!prescription || !prescription.medications_sha256) {
      throw new AppError(404, 'Prescription not found.', 'PRESCRIPTION_NOT_FOUND');
    }

    const { body: ciphertext } = await this.medicalStorage.get({ key: prescription.storage_key });
    const document = JSON.parse(this.fileEncryptionService.decrypt(ciphertext, prescription).toString('utf8'));

    // Hashed exactly as stored, the same way the integrity check does it.
    const medications = (document.medications ?? []).map((m) => ({ ...m }));
    const applied = {};
    const first = medications[0];
    for (const key of ['dose', 'frequency', 'duration']) {
      if (first && typeof changes[key] === 'string' && changes[key].trim()) {
        applied[`${first.name} ${key}`] = { from: first[key], to: changes[key].trim().slice(0, 100) };
        first[key] = changes[key].trim().slice(0, 100);
      }
    }

    const clinicalHash = clinicalSha256(document);
    const rootOf = (meds) => withPrefix(prescriptionRootSha256({
      patientUserId,
      medicationsHash: medicationsSha256(meds),
      clinicalHash
    }));

    const chainHash = await settle([this.chainHash(prescription.id)]);

    return this.simulationResult({
      dbHash: withPrefix(prescription.content_sha256),
      recomputed: rootOf(document.medications ?? []),
      editedHash: rootOf(medications),
      chainHash: chainHash[0],
      applied,
      original: { medicine: document.medications[0] ?? null }
    });
  }

  simulationResult({ dbHash, recomputed, editedHash, chainHash, applied, original = null }) {
    return {
      dbHash,
      recomputedHash: recomputed,
      editedHash,
      chainHash,
      originalMatchesChain: chainHash ? recomputed === chainHash : null,
      editedMatchesChain: chainHash ? editedHash === chainHash : null,
      changed: editedHash !== recomputed,
      applied,
      original
    };
  }
}
