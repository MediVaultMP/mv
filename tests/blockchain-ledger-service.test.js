import { describe, expect, it } from 'vitest';
import { BlockchainLedgerService } from '../src/services/blockchain-ledger-service.js';
import { MockRecordRegistryClient } from '../src/blockchain/mock-record-registry-client.js';
import { basicProfileChainId, basicProfileSha256 } from '../src/services/basic-profile-signature.js';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const profile = {
  patientUserId: PATIENT,
  version: 1,
  bloodGroup: 'B+',
  gender: 'female',
  dateOfBirth: '1998-04-12',
  emergencyContact: { name: 'Ravi', phone: '+91 9876543210', relationship: 'Father' },
  allergies: [],
  allergiesStatus: 'none_known',
  chronicConditions: [],
  chronicConditionsStatus: 'none_known',
  currentMedications: [],
  medicationsStatus: 'none_known'
};
const profileHash = basicProfileSha256(PATIENT, 1, profile);

function fakeDatabase({ recordHash }) {
  return {
    async query(sql) {
      if (sql.includes('FROM patient_emergency_profiles')) {
        return { rows: [{ version: 1, profile_sha256: profileHash, blockchain_status: 'registered', blockchain_tx_hash: `0x${'1'.repeat(64)}`, created_at: '2026-01-01T00:00:00Z' }] };
      }
      if (sql.includes('FROM medical_record_versions')) {
        return { rows: [{ id: 'v1', medical_record_id: RECORD, version_number: 1, title: 'CBC', category: 'lab-result', content_sha256: recordHash, blockchain_status: 'registered', blockchain_tx_hash: `0x${'2'.repeat(64)}`, created_at: '2026-01-02T00:00:00Z' }] };
      }
      if (sql.includes('FROM users')) return { rows: [{ blockchain_address: '0xabc' }] };
      return { rows: [] };
    }
  };
}

async function setup(recordHash) {
  const chain = new MockRecordRegistryClient();
  await chain.registerRecord({ recordId: basicProfileChainId(PATIENT), contentSha256: profileHash, patientAddress: '0xabc' });
  await chain.registerRecord({ recordId: RECORD, contentSha256: HASH_A, patientAddress: '0xabc' });
  return new BlockchainLedgerService({
    database: fakeDatabase({ recordHash }),
    recordRegistryClient: chain,
    emergencyProfileRepository: { findByPatientId: async () => ({ ...profile, signature: { profileSha256: profileHash } }) },
    chainId: 11155111,
    contractAddress: '0x0000000000000000000000000000000000000000',
    isMockChain: true
  });
}

describe('blockchain ledger', () => {
  it('lists blocks in order with the database hash next to the chain hash', async () => {
    const ledger = await (await setup(HASH_A)).getPatientLedger(PATIENT);

    expect(ledger.blocks.map((b) => b.kind)).toEqual(['basic_profile', 'lab_report']);
    expect(ledger.blocks.every((b) => b.matches === true)).toBe(true);
    expect(ledger.blocks[1].previousHash).toBe(`0x${profileHash}`);
    expect(ledger.summary).toEqual({ total: 2, verified: 2, mismatched: 0 });
  });

  it('flags a block whose database hash no longer matches the chain', async () => {
    const ledger = await (await setup(HASH_B)).getPatientLedger(PATIENT);

    expect(ledger.blocks[1].matches).toBe(false);
    expect(ledger.summary.mismatched).toBe(1);
  });

  it('shows that an edited profile no longer matches the chain, without saving it', async () => {
    const result = await (await setup(HASH_A)).simulateEdit(PATIENT, { kind: 'basic_profile', changes: { bloodGroup: 'O+' } });

    expect(result.originalMatchesChain).toBe(true);
    expect(result.editedMatchesChain).toBe(false);
    expect(result.applied.bloodGroup).toEqual({ from: 'B+', to: 'O+' });
  });
});
