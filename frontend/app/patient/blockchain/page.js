"use client";
import { useCallback, useEffect, useState } from "react";
import PortalShell from "../../../components/PortalShell";
import { EmptyState, fmtDateTime } from "../../../components/ui";
import { toast } from "../../../components/Toast";
import { api } from "../../../lib/api";

const KIND_LABEL = {
  basic_profile: "Basic profile",
  prescription: "Prescription",
  lab_report: "Lab report",
};

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const FIELD_LABEL = {
  bloodGroup: "Blood group",
  dateOfBirth: "Date of birth",
  emergencyContactName: "Emergency contact name",
  emergencyContactPhone: "Emergency contact phone",
};

const EVENT_LABEL = {
  consent_granted: "Doctor linked",
  consent_revoked: "Doctor unlinked",
  basic_profile_created: "Basic profile created",
  basic_profile_updated: "Basic profile updated",
  prescription_created: "Prescription added",
  prescription_requested: "Doctor asked to add a prescription",
  prescription_request_approved: "You approved a prescription",
  prescription_shared: "Prescription shared with a pharmacy",
  record_created: "Lab report added",
  record_creation_requested: "Doctor asked to add a lab report",
  record_creation_approved: "You approved a lab report",
  emergency_profile_permission_requested: "Doctor asked to create your basic profile",
  prescription_dispensed: "Pharmacy dispensed a prescription",
  prescription_accessed: "Prescription opened",
  record_accessed: "Lab report opened",
};

function eventLabel(type) {
  return EVENT_LABEL[type] || type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function short(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function copy(text) {
  try {
    navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy. Select the text instead.");
  }
}

function CopyButton({ value, label = "Copy" }) {
  if (!value) return null;
  return (
    <button type="button" className="btn btn-ghost btn-sm chain-copy" onClick={() => copy(value)} aria-label={`${label}: ${value}`}>
      Copy
    </button>
  );
}

// Shows a hash with the characters that differ from `against` in red.
function DiffHash({ value, against }) {
  if (!value) return <span className="mono">—</span>;
  return (
    <span className="mono chain-hash">
      {value.split("").map((c, i) => (
        <span key={i} className={against && against[i] !== c ? "chain-diff" : undefined}>{c}</span>
      ))}
    </span>
  );
}

function ExplorerLink({ explorer, path, children }) {
  if (!explorer) return <span className="mono">{children}</span>;
  return (
    <a className="mono" href={`${explorer}/${path}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function MatchBadge({ matches, status }) {
  if (status !== "registered") return <span className="badge badge-amber">{status === "failed" ? "Not on chain" : "Pending"}</span>;
  if (matches === true) return <span className="badge badge-mint">Matches blockchain</span>;
  if (matches === false) return <span className="badge badge-red">Does not match</span>;
  return <span className="badge badge-muted">Chain not reachable</span>;
}

function EditCheck({ block }) {
  const [value, setValue] = useState(block.kind === "basic_profile" ? "O+" : "2 tablets");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function run(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const changes = block.kind === "basic_profile" ? { bloodGroup: value } : { dose: value };
      setResult(await api.simulateEdit({ kind: block.kind, resourceId: block.resourceId, changes }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const applied = result ? Object.entries(result.applied || {}) : [];

  return (
    <div className="chain-sim">
      <div className="chain-sim-title">What if someone edits this record?</div>
      <p className="chain-sim-help">
        Try a change below. MediVault works out the new fingerprint and compares it with the one on the blockchain.
        Nothing is saved and nothing is sent to the chain.
      </p>
      <form onSubmit={run} className="chain-sim-form">
        <label>
          {block.kind === "basic_profile" ? "Change blood group to" : "Change the first medicine's dose to"}
          {block.kind === "basic_profile" ? (
            <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          ) : (
            <input className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={100} />
          )}
        </label>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Check this edit"}
        </button>
      </form>

      {result && (
        <div className="chain-sim-result">
          {applied.map(([field, change]) => (
            <div key={field} className="chain-sim-change">
              Edit tried: <strong>{FIELD_LABEL[field] || field}</strong> {String(change.from ?? "—")} → {String(change.to)}
            </div>
          ))}
          <div className="chain-row">
            <div className="chain-row-label">Fingerprint on the blockchain</div>
            <DiffHash value={result.chainHash} />
          </div>
          <div className="chain-row">
            <div className="chain-row-label">Fingerprint of the edited record</div>
            <DiffHash value={result.editedHash} against={result.chainHash} />
          </div>
          {result.editedMatchesChain === false ? (
            <div className="chain-verdict chain-verdict-bad">
              Doesn't match. Changing even one value gives a completely different fingerprint, so this edit would be caught.
            </div>
          ) : result.editedMatchesChain === true ? (
            <div className="chain-verdict chain-verdict-ok">No change made, so the fingerprint still matches.</div>
          ) : (
            <div className="chain-verdict">The blockchain could not be reached to compare.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Block({ block, explorer, isLast }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="chain-item">
      <div className={`card chain-block ${block.matches === false ? "chain-block-bad" : ""}`}>
        <div className="chain-block-head">
          <span className="chain-index">Block {block.index}</span>
          <div className="chain-title">
            <div className="chain-kind">{KIND_LABEL[block.kind] || block.kind}</div>
            <div className="chain-label">{block.label}</div>
          </div>
          <div className="chain-meta">
            <MatchBadge matches={block.matches} status={block.status} />
            <div className="chain-date">{fmtDateTime(block.createdAt)}</div>
          </div>
        </div>

        {block.previousHash && (
          <div className="chain-prev">
            Previous block: <span className="mono">{short(block.previousHash)}</span>
          </div>
        )}

        <div className="chain-compare">
          <div className="chain-side">
            <div className="chain-side-title">Database (Supabase)</div>
            <DiffHash value={block.dbHash} />
            <CopyButton value={block.dbHash?.replace(/^0x/, "")} label="Copy database hash" />
            <div className="chain-where">
              Table <code>{block.dbLocation.table}</code>, column <code>{block.dbLocation.column}</code>
              <br />
              Row: <span className="mono">{block.dbLocation.rowKey}</span>
            </div>
          </div>
          <div className="chain-side">
            <div className="chain-side-title">Blockchain (read live)</div>
            <DiffHash value={block.chainHash} against={block.dbHash} />
            <CopyButton value={block.chainHash} label="Copy blockchain hash" />
            <div className="chain-where">Returned by the MediVault contract for this record.</div>
          </div>
        </div>

        <div className="chain-facts">
          <div>
            <div className="chain-row-label">Transaction</div>
            {block.txHash ? (
              <>
                <ExplorerLink explorer={explorer} path={`tx/${block.txHash}`}>{short(block.txHash)}</ExplorerLink>
                <CopyButton value={block.txHash} label="Copy transaction hash" />
              </>
            ) : (
              <span className="chain-muted">Not stored for older versions</span>
            )}
          </div>
          <div>
            <div className="chain-row-label">Block number</div>
            {block.blockNumber ? (
              <ExplorerLink explorer={explorer} path={`block/${block.blockNumber}`}>{block.blockNumber.toLocaleString()}</ExplorerLink>
            ) : (
              <span className="chain-muted">—</span>
            )}
          </div>
          {block.chainKey && (
            <div>
              <div className="chain-row-label">On-chain record ID (Etherscan topic 1)</div>
              <span className="mono">{short(block.chainKey)}</span>
              <CopyButton value={block.chainKey} label="Copy on-chain record ID" />
            </div>
          )}
        </div>

        {block.canSimulate && (
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? "Hide edit check" : "What if someone edits it?"}
            </button>
            {open && <EditCheck block={block} />}
          </div>
        )}
      </div>
      {!isLast && <div className="chain-link" aria-hidden="true" />}
    </div>
  );
}

export default function PatientBlockchain() {
  const [ledger, setLedger] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setLedger(await api.getMyBlockchain());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const explorer = ledger?.explorerUrl;
  const summary = ledger?.summary;

  return (
    <PortalShell
      role="patient"
      eyebrow="Patient Portal"
      title="Blockchain"
      subtitle="Every record a doctor adds gets a fingerprint (a SHA-256 hash). The fingerprint is saved in the database and also written to the blockchain, where nobody can change it. Here you can compare the two."
    >
      {error && <div className="error-text" role="alert">{error}</div>}

      <div className="card card-pad chain-summary">
        <div>
          <div className="chain-summary-big">
            {summary ? `${summary.verified} of ${summary.total} records match the blockchain` : loading ? "Checking the blockchain…" : "—"}
          </div>
          {summary?.mismatched > 0 && (
            <div className="chain-verdict chain-verdict-bad" style={{ marginTop: 8 }}>
              {summary.mismatched} record{summary.mismatched === 1 ? "" : "s"} no longer match the blockchain.
            </div>
          )}
          {ledger && (
            <div className="chain-summary-facts">
              <span>
                Network: <strong>{ledger.network === "sepolia" ? "Ethereum Sepolia" : ledger.network === "mock" ? "Local test chain" : ledger.network}</strong>
              </span>
              <span>
                Contract:{" "}
                <ExplorerLink explorer={explorer} path={`address/${ledger.contractAddress}`}>{short(ledger.contractAddress)}</ExplorerLink>
              </span>
              {ledger.patientAddress && (
                <span>
                  Your blockchain address: <span className="mono">{short(ledger.patientAddress)}</span>
                  <CopyButton value={ledger.patientAddress} label="Copy your blockchain address" />
                </span>
              )}
              <span>Checked {fmtDateTime(ledger.checkedAt)}</span>
            </div>
          )}
        </div>
        <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
          {loading ? "Checking…" : "Check again"}
        </button>
      </div>

      {ledger && ledger.blocks.length === 0 && (
        <EmptyState title="Nothing on the blockchain yet" body="Once a doctor creates your basic profile or adds a record, it shows up here." />
      )}

      {ledger && ledger.blocks.length > 0 && (
        <div className="chain-list">
          {ledger.blocks.map((block, i) => (
            <Block key={`${block.kind}-${block.resourceId}-${block.version ?? 0}`} block={block} explorer={explorer} isLast={i === ledger.blocks.length - 1} />
          ))}
        </div>
      )}

      {ledger && ledger.activity.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 24 }}>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>Access and activity on the blockchain</h3>
          <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
            Each of these actions was also written to the blockchain as an audit event. They are saved in the <code>audit_events</code> table.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>What happened</th>
                  <th>By</th>
                  <th>When</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {ledger.activity.map((event) => (
                  <tr key={event.id}>
                    <td>{eventLabel(event.eventType)}</td>
                    <td>{event.actorName || "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(event.createdAt)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <ExplorerLink explorer={explorer} path={`tx/${event.txHash}`}>{short(event.txHash)}</ExplorerLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PortalShell>
  );
}
