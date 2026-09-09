import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import TallySectionNav, { TallyWriteGate } from "./TallySectionNav";
import { fetchApi } from "../../../utils/api";

const statusColor = { PENDING: "#b7791f", READY: "#2563eb", FAILED: "#c53030", SYNCED: "#2f855a", CANCELLED: "#718096" };
const statusLabel = { PENDING: "Pending", READY: "Ready", FAILED: "Failed", SYNCED: "Synced", CANCELLED: "Cancelled", MAPPING_REQUIRED: "Mapping Required" };
const mappingPathFor = (row) => {
  if (["OFFICE_EXPENSE", "TRIP_EXPENSE", "SALARY_INCENTIVE"].includes(row.sourceType)) return "/travel/tally/mapping/expense";
  if (["TRAVEL_PAYMENT", "SUPPLIER_PAYABLE_PAYMENT"].includes(row.sourceType)) return "/travel/tally/mapping/payment";
  if (["TRAVEL_INVOICE", "TRAVEL_INVOICE_PAYMENT", "SUPPLIER_PAYABLE"].includes(row.sourceType)) return "/travel/tally/mapping/party";
  return "/travel/tally/mapping/voucher";
};

export default function TallySyncQueuePage() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [validating, setValidating] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [mappingFilter, setMappingFilter] = useState("");

  const load = async () => {
    setLoading(true);
    try { setQueue((await fetchApi("/api/travel/tally/sync-queue"))?.queue || []); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const prepare = async () => {
    setPreparing(true);
    try { await fetchApi("/api/travel/tally/sync-queue/prepare", { method: "POST" }); await load(); } finally { setPreparing(false); }
  };
  const validate = async () => { setValidating(true); try { await fetchApi("/api/travel/tally/sync-queue/validate", { method: "POST" }); await load(); } finally { setValidating(false); } };
  const preview = async (id) => setSelected((await fetchApi(`/api/travel/tally/sync-queue/${id}/preview`)) || null);
  const retry = async (id) => { await fetchApi(`/api/travel/tally/sync-queue/${id}/retry`, { method: "POST" }); await load(); };
  const visibleQueue = queue.filter((row) => {
    const text = [row.reference, row.partyName, row.tripId, row.transactionType, row.voucherType].filter(Boolean).join(" ").toLowerCase();
    return (!search || text.includes(search.toLowerCase()))
      && (!statusFilter || row.status === statusFilter)
      && (!mappingFilter || row.mappingStatus === mappingFilter);
  });

  return <main className="tally-sync-page" style={{ padding: 24, maxWidth: 1180, margin: "0 auto" }}>
    <TallySectionNav />
    <div className="tally-sync-header">
      <div><span className="tally-sync-eyebrow">Finance / Tally</span><h1>Pending Tally Sync</h1><p>Review, validate, and prepare transactions for accounting export.</p></div>
      <div className="tally-sync-actions"><button className="btn-secondary" type="button" onClick={load} disabled={loading}>Refresh Queue</button><TallyWriteGate><><button className="btn-secondary" type="button" onClick={prepare} disabled={preparing}>{preparing ? "Preparing…" : "Prepare Transactions"}</button><button className="btn-primary" type="button" onClick={validate} disabled={validating}>{validating ? "Validating…" : "Validate Mappings"}</button></></TallyWriteGate></div>
    </div>
    <div className="tally-sync-filters"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search reference, party, trip" aria-label="Search sync queue" /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter sync status"><option value="">All statuses</option><option value="PENDING">Pending</option><option value="FAILED">Failed</option><option value="SYNCED">Synced</option><option value="CANCELLED">Cancelled</option></select><select value={mappingFilter} onChange={(event) => setMappingFilter(event.target.value)} aria-label="Filter mapping status"><option value="">All mapping statuses</option><option value="READY">Ready</option><option value="MAPPING_REQUIRED">Mapping required</option></select></div>
    <section className="tally-sync-card">
      <div className="tally-sync-card-heading"><div><h2>Transaction queue</h2><p>Transactions are prepared locally. Live Tally connection is deferred.</p></div><span className="tally-sync-count">{visibleQueue.length} {visibleQueue.length === 1 ? "transaction" : "transactions"}</span></div>
    {loading ? <p className="tally-sync-empty">Loading queue…</p> : <div className="tally-sync-table-wrap"><table><thead><tr><th>Reference</th><th>Date</th><th>Type</th><th>Trip</th><th>Party</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      {visibleQueue.length === 0 ? <tr><td className="tally-sync-empty" colSpan="8">No transactions match these filters.</td></tr> : visibleQueue.map((row) => <tr key={row.id}><td><strong>{row.reference}</strong></td><td>{row.createdAt ? new Date(row.createdAt).toLocaleDateString("en-IN") : "—"}</td><td><span className="tally-type-pill">{row.voucherType}</span></td><td>{row.tripId ? `TRIP-${row.tripId}` : "—"}</td><td>{row.partyName || "—"}</td><td className="tally-amount">₹{Number(row.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td><td><strong className="tally-status-pill" style={{ color: statusColor[row.status] || "inherit", borderColor: statusColor[row.status] || "#718096" }}>{statusLabel[row.status] || row.status}</strong><small className={row.mappingStatus === "MAPPING_REQUIRED" ? "tally-mapping-warning" : "tally-mapping-state"}>{statusLabel[row.mappingStatus] || row.mappingStatus}</small></td><td className="tally-row-actions"><button className="btn-secondary" type="button" onClick={() => preview(row.id)}>Preview</button>{row.mappingStatus === "MAPPING_REQUIRED" && <button className="btn-secondary" type="button" onClick={() => navigate(mappingPathFor(row))}>Mapping</button>}{row.status === "FAILED" && <TallyWriteGate><button className="btn-secondary" type="button" onClick={() => retry(row.id)}>Retry</button></TallyWriteGate>}</td></tr>)}
    </tbody></table></div>}
    </section>
    {selected && <section style={panelStyle}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><h2 style={{ marginBottom: 4 }}>Voucher Preview</h2><small style={{ color: "var(--text-secondary)" }}>{selected.queue?.reference || "Queued transaction"} · {selected.queue?.voucherType || "Voucher"}</small></div><button type="button" onClick={() => setSelected(null)}>Close</button></div><table style={{ width: "100%", marginTop: 16 }}><thead><tr><th style={{ textAlign: "left" }}>Ledger</th><th style={{ textAlign: "right" }}>Debit</th><th style={{ textAlign: "right" }}>Credit</th></tr></thead><tbody>{(selected.payload?.accountingLines || []).map((line, index) => <tr key={`${line.ledger}-${index}`}><td>{line.ledger}</td><td style={{ textAlign: "right" }}>{Number(line.debit || 0).toFixed(2)}</td><td style={{ textAlign: "right" }}>{Number(line.credit || 0).toFixed(2)}</td></tr>)}</tbody><tfoot><tr><th style={{ textAlign: "left" }}>Totals</th><th style={{ textAlign: "right" }}>{Number(selected.payload?.totalDebit || 0).toFixed(2)}</th><th style={{ textAlign: "right" }}>{Number(selected.payload?.totalCredit || 0).toFixed(2)}</th></tr></tfoot></table><p style={{ marginBottom: 0, color: Math.abs(Number(selected.payload?.totalDebit || 0) - Number(selected.payload?.totalCredit || 0)) < 0.01 ? "#2f855a" : "#c53030", fontWeight: 700 }}>{Math.abs(Number(selected.payload?.totalDebit || 0) - Number(selected.payload?.totalCredit || 0)) < 0.01 ? "Balanced voucher" : "Unbalanced voucher — fix mappings before sync"}</p></section>}
  </main>;
}

const panelStyle = { marginTop: 20, padding: 18, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 12 };
