import { useCallback, useEffect, useState } from "react";
import { ClipboardList, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";

const PAGE_SIZE = 50;

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function statusStyle(status) {
  if (status === "SUCCEEDED") return { color: "#22c55e", background: "rgba(34,197,94,0.12)" };
  if (status === "FAILED") return { color: "#ef4444", background: "rgba(239,68,68,0.12)" };
  return { color: "#f59e0b", background: "rgba(245,158,11,0.12)" };
}

export default function SuperAdminOrganizationAuditLog() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    try {
      const response = await superAdminFetch(`/tenant-management/organization-audit-log?${params.toString()}`);
      setEntries(Array.isArray(response?.entries) ? response.entries : []);
      setTotal(Number(response?.total || 0));
    } catch (err) {
      setError(err.message || "Failed to load organization audit log.");
    } finally {
      setLoading(false);
    }
  }, [offset, query, status]);

  useEffect(() => { load(); }, [load]);

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}><ClipboardList size={24} color="var(--accent-color)" /> Organization Audit Log</h1>
          <p style={{ margin: "0.4rem 0 0", color: "var(--text-secondary)" }}>Permanent record of Super Admin organization deletion requests and outcomes.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={load} disabled={loading} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><RefreshCw size={15} /> Refresh</button>
      </header>

      <section className="card" style={{ padding: "1rem", display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(160px, 220px)", gap: "0.75rem" }} aria-label="Audit log filters">
        <label style={{ position: "relative", display: "block" }}>
          <span style={{ position: "absolute", left: 12, top: 13, color: "var(--text-secondary)" }}><Search size={15} /></span>
          <input className="input-field" aria-label="Search audit log" placeholder="Search organization, owner, actor, or reason" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} style={{ width: "100%", paddingLeft: "2.2rem" }} />
        </label>
        <select className="input-field" aria-label="Filter by outcome" value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} style={{ background: "var(--input-bg)" }}>
          <option value="">All outcomes</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="SUCCEEDED">Succeeded</option>
          <option value="FAILED">Failed</option>
        </select>
      </section>

      {error && <div role="alert" className="card" style={{ padding: "0.85rem 1rem", borderLeft: "4px solid #ef4444" }}>{error}</div>}

      <section className="card" style={{ overflow: "hidden" }} aria-label="Organization deletion history">
        {loading ? (
          <div style={{ padding: "2rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-secondary)" }}><LoaderCircle size={17} /> Loading audit history...</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>No organization deletion actions found.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900, fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)" }}>
                  <th style={{ padding: "0.8rem" }}>Time</th>
                  <th style={{ padding: "0.8rem" }}>Organization</th>
                  <th style={{ padding: "0.8rem" }}>Action</th>
                  <th style={{ padding: "0.8rem" }}>Actor</th>
                  <th style={{ padding: "0.8rem" }}>Outcome</th>
                  <th style={{ padding: "0.8rem" }}>Reason / details</th>
                  <th style={{ padding: "0.8rem", textAlign: "left" }}>Tenant rows removed</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                    <td style={{ padding: "0.8rem", whiteSpace: "nowrap" }}><div>{formatDate(entry.createdAt)}</div><div style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>Audit #{entry.id}</div></td>
                    <td style={{ padding: "0.8rem", minWidth: 190 }}><strong>{entry.organizationName}</strong><div style={{ color: "var(--text-secondary)", fontSize: "0.78rem" }}>ID {entry.organizationId ?? "-"}{entry.organizationSlug ? ` · ${entry.organizationSlug}` : ""}{entry.ownerEmail ? ` · ${entry.ownerEmail}` : ""}</div></td>
                    <td style={{ padding: "0.8rem" }}>Permanent deletion</td>
                    <td style={{ padding: "0.8rem" }}>{entry.actor}</td>
                    <td style={{ padding: "0.8rem" }}><span style={{ ...statusStyle(entry.status), display: "inline-block", borderRadius: 999, padding: "0.25rem 0.55rem", fontWeight: 700, fontSize: "0.74rem" }}>{entry.status.replaceAll("_", " ")}</span>{entry.completedAt && <div style={{ color: "var(--text-secondary)", fontSize: "0.74rem", marginTop: 4 }}>{formatDate(entry.completedAt)}</div>}</td>
                    <td style={{ padding: "0.8rem", minWidth: 220, maxWidth: 360, overflowWrap: "anywhere" }}><div>{entry.reason || "-"}</div>{entry.errorMessage && <div style={{ color: "#ef4444", marginTop: 4 }}>{entry.errorMessage}</div>}</td>
                    <td style={{ padding: "0.8rem", textAlign: "left" }}>{entry.deletedRowCount == null ? "-" : Number(entry.deletedRowCount).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
        <span>Showing {start}-{end} of {total}</span>
        <div style={{ display: "flex", gap: "0.55rem" }}>
          <button type="button" className="btn-secondary" disabled={offset === 0 || loading} onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}>Previous</button>
          <button type="button" className="btn-secondary" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset((current) => current + PAGE_SIZE)}>Next</button>
        </div>
      </div>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.78rem" }}>
        Row counts include records with a tenant ID. Related records removed by database cascades may not be included in the count.
      </p>
    </div>
  );
}
