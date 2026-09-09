import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import TallySectionNav, { TallyWriteGate } from "./TallySectionNav";
import { fetchApi } from "../../../utils/api";

export default function TallySyncErrorsPage() {
  const [errors, setErrors] = useState([]);
  const [selected, setSelected] = useState(null);
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("OPEN");
  const load = () => fetchApi("/api/travel/tally/sync-errors").then((data) => setErrors(data?.errors || []));
  useEffect(() => { load(); const timer = setInterval(load, 30000); return () => clearInterval(timer); }, []);
  const createLedger = async (id) => { await fetchApi(`/api/travel/tally/sync-queue/${id}/create-ledger`, { method: "POST" }); await load(); };
  const retry = async (id) => { await fetchApi(`/api/travel/tally/sync-queue/${id}/retry`, { method: "POST" }); await load(); };
  const preview = async (id) => setSelected((await fetchApi(`/api/travel/tally/sync-queue/${id}/preview`)) || null);
  const mappingPath = (row) => {
    if (row.queue?.sourceType === "OFFICE_EXPENSE" || row.queue?.sourceType === "TRIP_EXPENSE") return "/travel/tally/mapping/expense";
    if (row.queue?.sourceType === "SALARY_INCENTIVE") return "/travel/tally/mapping/expense";
    if (row.queue?.sourceType === "TRAVEL_PAYMENT" || row.queue?.sourceType === "SUPPLIER_PAYABLE_PAYMENT") return "/travel/tally/mapping/payment";
    if (row.queue?.sourceType === "TRAVEL_INVOICE" || row.queue?.sourceType === "TRAVEL_INVOICE_PAYMENT") return "/travel/tally/mapping/party";
    return "/travel/tally/ledger";
  };
  const visibleErrors = errors.filter((row) => { const text = [row.errorCode, row.errorMessage, row.queue?.reference, row.queue?.partyName].filter(Boolean).join(" ").toLowerCase(); return (!search || text.includes(search.toLowerCase())) && (statusFilter === "ALL" || (statusFilter === "OPEN" ? !row.resolvedAt : Boolean(row.resolvedAt))); });
  return <main style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}><TallySectionNav /><h1>Sync Errors</h1><p style={{ color: "var(--text-secondary)" }}>Errors are retained for review and retry. No live Tally call is made yet.</p><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 8, margin: "14px 0" }}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search code, message, reference" aria-label="Search sync errors" /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter error status"><option value="OPEN">Open</option><option value="RESOLVED">Resolved</option><option value="ALL">All errors</option></select></div><div style={{ overflowX: "auto" }}><table><thead><tr><th>Date</th><th>Code</th><th>Message</th><th>Queue Item</th><th>Status</th><th>Recovery</th></tr></thead><tbody>{visibleErrors.length ? visibleErrors.map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString()}</td><td>{row.errorCode}</td><td>{row.errorMessage}</td><td>{row.queue?.reference || `#${row.queueId}`}</td><td>{row.resolvedAt ? `Resolved ${new Date(row.resolvedAt).toLocaleString()}` : "Open"}</td><td>{!row.resolvedAt && <><button type="button" onClick={() => preview(row.queueId)}>Preview</button><button type="button" onClick={() => navigate(mappingPath(row))} style={{ marginLeft: 8 }}>Select Existing Ledger</button><button type="button" onClick={() => navigate(mappingPath(row))} style={{ marginLeft: 8 }}>Change Mapping</button><TallyWriteGate><button type="button" onClick={() => createLedger(row.queueId)} style={{ marginLeft: 8 }}>Create Ledger</button><button type="button" onClick={() => retry(row.queueId)} style={{ marginLeft: 8 }}>Retry</button></TallyWriteGate></>}</td></tr>) : <tr><td colSpan="6">No sync errors match these filters.</td></tr>}</tbody></table></div>{selected && <section style={panelStyle}><div style={{ display: "flex", justifyContent: "space-between" }}><h2>Failed Voucher Preview</h2><button type="button" onClick={() => setSelected(null)}>Close</button></div><pre style={{ overflow: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify(selected.payload, null, 2)}</pre></section>}</main>;
}

const panelStyle = { marginTop: 20, padding: 18, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 12 };
