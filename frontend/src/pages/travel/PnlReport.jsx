import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, BarChart3, RefreshCw, Wallet } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const ROW_BATCH_SIZE = 10;

function money(value) {
  return `INR ${Number(value || 0).toLocaleString("en-IN")}`;
}

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "-";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function brandLabel(brand) {
  return String(brand || "unknown").replace(/_/g, " ").toUpperCase();
}

export default function TravelPnlReport() {
  const notify = useNotify();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [revenueLimit, setRevenueLimit] = useState(ROW_BATCH_SIZE);
  const [quoteLimit, setQuoteLimit] = useState(ROW_BATCH_SIZE);
  const [costLimit, setCostLimit] = useState(ROW_BATCH_SIZE);

  const url = useMemo(() => {
    const q = new URLSearchParams();
    if (params.get("from")) q.set("from", params.get("from"));
    if (params.get("to")) q.set("to", params.get("to"));
    return `/api/travel/reports/pnl${q.toString() ? `?${q.toString()}` : ""}`;
  }, [params]);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchApi(url)
      .then((res) => setData(res))
      .catch((e) => {
        const msg = e?.body?.error || "Failed to load P&L report";
        setError(msg);
        if (e?.status !== 403) notify.error(msg);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRevenueLimit(ROW_BATCH_SIZE);
    setQuoteLimit(ROW_BATCH_SIZE);
    setCostLimit(ROW_BATCH_SIZE);
  }, [url]);

  const period = params.get("from") || params.get("to")
    ? `${params.get("from") || "start"} to ${params.get("to") || "today"}`
    : "All time";
  const totals = data?.totals || {};
  const revenueRows = data?.revenueRows || [];
  const quoteRows = data?.quoteRows || [];
  const costRows = data?.costRows || [];
  const visibleRevenueRows = revenueRows.slice(0, revenueLimit);
  const visibleQuoteRows = quoteRows.slice(0, quoteLimit);
  const visibleCostRows = costRows.slice(0, costLimit);

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}>
      <header style={headerStyle}>
        <div>
          <button type="button" onClick={() => navigate("/travel/reports")} style={backBtn}>
            <ArrowLeft size={16} aria-hidden /> Back to reports
          </button>
          <h1 style={titleStyle}><Wallet size={28} aria-hidden /> Sub-brand P&amp;L</h1>
          <p style={subtitleStyle}>
            Profit/loss by brand using invoice revenue minus captured supplier/itinerary costs. Accepted quote and flight package lines are shown separately as quoted value. Period: {period}.
          </p>
        </div>
        <button type="button" onClick={load} style={refreshBtn} disabled={loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </header>

      {loading ? <div style={stateBox}>Loading P&amp;L report...</div> : null}
      {error ? <div style={stateBox} role="alert">{error}</div> : null}

      {!loading && !error && data ? (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={summaryGrid}>
            <Metric label="Total revenue" value={money(totals.revenue)} />
            <Metric label="Captured cost" value={money(totals.capturedCost)} />
            <Metric label="Accepted quoted value" value={money(totals.quoteValue)} />
            <Metric label="Net profit/loss" value={money(totals.grossProfit)} tone={Number(totals.grossProfit || 0) >= 0 ? "profit" : "loss"} />
            <Metric label="Margin" value={`${totals.marginPct || 0}%`} />
          </div>

          <section style={cardStyle}>
            <div style={sectionHeader}>
              <h2 style={sectionTitle}><BarChart3 size={16} aria-hidden /> Brand-wise profit/loss</h2>
            </div>
            <div style={tableWrap}>
              <table style={tableStyle}>
                <thead>
                  <tr><th style={th}>Brand</th><th style={thRight}>Revenue</th><th style={thRight}>Cost</th><th style={thRight}>Profit/Loss</th><th style={thRight}>Margin</th><th style={thRight}>Invoices</th><th style={thRight}>Cost lines</th><th style={thRight}>Quote lines</th></tr>
                </thead>
                <tbody>
                  {(data.brands || []).length ? data.brands.map((row) => (
                    <tr key={row.subBrand} style={trStyle}>
                      <td style={td}><span style={brandBadge}>{brandLabel(row.subBrand)}</span></td>
                      <td style={tdRight}>{money(row.revenue)}</td>
                      <td style={tdRight}>{money(row.capturedCost)}</td>
                      <td style={{ ...tdRight, color: Number(row.grossProfit || 0) >= 0 ? "var(--success-color, #10b981)" : "var(--danger-color, #ef4444)", fontWeight: 700 }}>{money(row.grossProfit)}</td>
                      <td style={tdRight}>{row.marginPct || 0}%</td>
                      <td style={tdRight}>{row.invoiceCount || 0}</td>
                      <td style={tdRight}>{row.costLineCount || 0}</td>
                      <td style={tdRight}>{row.quoteLineCount || 0}</td>
                    </tr>
                  )) : <tr><td colSpan="8" style={emptyCell}>No P&amp;L rows captured yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitle}>Revenue source: travel invoices</h2>
            <div data-testid="revenue-source-scroll" style={sourceTableWrap} onScroll={(e) => handleSourceScroll(e, revenueLimit < revenueRows.length, () => setRevenueLimit((n) => Math.min(n + ROW_BATCH_SIZE, revenueRows.length)))}>
              <table style={tableStyle}>
                <thead><tr><th style={th}>Invoice</th><th style={th}>Brand</th><th style={th}>Status</th><th style={thRight}>Amount</th><th style={th}>Created</th></tr></thead>
                <tbody>
                  {revenueRows.length ? visibleRevenueRows.map((row) => (
                    <tr key={row.id} style={trStyle}>
                      <td style={td}><Link to={`/travel/invoices-admin?from=reports&pnl=1`} style={linkStyle}>{row.invoiceNum || `Invoice #${row.id}`}</Link></td>
                      <td style={td}>{brandLabel(row.subBrand)}</td>
                      <td style={td}>{row.status}</td>
                      <td style={tdRight}>{money(row.amount)}</td>
                      <td style={td}>{fmtDate(row.createdAt)}</td>
                    </tr>
                  )) : <tr><td colSpan="5" style={emptyCell}>No issued, partial or paid invoices found.</td></tr>}
                </tbody>
              </table>
            </div>
            <InfiniteRows visible={visibleRevenueRows.length} total={revenueRows.length} />
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitle}>Accepted quote source: quote, flight and package lines</h2>
            <p style={noteStyle}>These rows show accepted quoted selling value from TravelQuoteLine. Draft and sent quotes are excluded until the customer accepts them, and quote values are not subtracted as cost because quote lines do not store supplier cost separately.</p>
            <div data-testid="quote-source-scroll" style={sourceTableWrap} onScroll={(e) => handleSourceScroll(e, quoteLimit < quoteRows.length, () => setQuoteLimit((n) => Math.min(n + ROW_BATCH_SIZE, quoteRows.length)))}>
              <table style={tableStyle}>
                <thead><tr><th style={th}>Quote</th><th style={th}>Brand</th><th style={th}>Status</th><th style={th}>Type</th><th style={th}>Description</th><th style={thRight}>Unit price</th><th style={thRight}>Qty</th><th style={thRight}>Quoted value</th></tr></thead>
                <tbody>
                  {quoteRows.length ? visibleQuoteRows.map((row) => (
                    <tr key={row.id} style={trStyle}>
                      <td style={td}>{row.quoteId ? `Quote #${row.quoteId}` : '-'}</td>
                      <td style={td}>{brandLabel(row.subBrand)}</td>
                      <td style={td}>{row.quoteStatus}</td>
                      <td style={td}>{row.lineType}</td>
                      <td style={td}>{row.description}</td>
                      <td style={tdRight}>{money(row.unitPrice)}</td>
                      <td style={tdRight}>{row.quantity}</td>
                      <td style={tdRight}>{money(row.amount)}</td>
                    </tr>
                  )) : <tr><td colSpan="8" style={emptyCell}>No quote lines found.</td></tr>}
                </tbody>
              </table>
            </div>
            <InfiniteRows visible={visibleQuoteRows.length} total={quoteRows.length} />
          </section>
          <section style={cardStyle}>
            <h2 style={sectionTitle}>Cost source: itinerary item costs</h2>
            <div data-testid="cost-source-scroll" style={sourceTableWrap} onScroll={(e) => handleSourceScroll(e, costLimit < costRows.length, () => setCostLimit((n) => Math.min(n + ROW_BATCH_SIZE, costRows.length)))}>
              <table style={tableStyle}>
                <thead><tr><th style={th}>Itinerary</th><th style={th}>Brand</th><th style={th}>Type</th><th style={th}>Description</th><th style={thRight}>Unit cost</th><th style={thRight}>Qty</th><th style={thRight}>Captured cost</th></tr></thead>
                <tbody>
                  {costRows.length ? visibleCostRows.map((row) => (
                    <tr key={row.id} style={trStyle}>
                      <td style={td}>{row.itineraryId ? <Link to={`/travel/itineraries/${row.itineraryId}`} style={linkStyle}>{row.destination}</Link> : row.destination}</td>
                      <td style={td}>{brandLabel(row.subBrand)}</td>
                      <td style={td}>{row.itemType}</td>
                      <td style={td}>{row.description}</td>
                      <td style={tdRight}>{money(row.unitCost)}</td>
                      <td style={tdRight}>{row.quantity}</td>
                      <td style={tdRight}>{money(row.capturedCost)}</td>
                    </tr>
                  )) : <tr><td colSpan="8" style={emptyCell}>No itinerary cost lines found.</td></tr>}
                </tbody>
              </table>
            </div>
            <InfiniteRows visible={visibleCostRows.length} total={costRows.length} />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function handleSourceScroll(event, hasMore, onMore) {
  if (!hasMore) return;
  const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
  if (scrollHeight - scrollTop - clientHeight <= 48) onMore();
}


function InfiniteRows({ visible, total }) {
  if (!total) return null;
  const hasMore = visible < total;
  return (
    <div style={infiniteStatusStyle}>
      Showing {Math.min(visible, total)} of {total}{hasMore ? " - scroll inside table for more" : ""}
    </div>
  );
}
function Metric({ label, value, tone }) {
  const color = tone === "profit" ? "var(--success-color, #10b981)" : tone === "loss" ? "var(--danger-color, #ef4444)" : "var(--text-primary)";
  return <div style={metricStyle}><div style={metricLabel}>{label}</div><div style={{ ...metricValue, color }}>{value}</div></div>;
}

const headerStyle = { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 16, flexWrap: "wrap" };
const titleStyle = { display: "flex", alignItems: "center", gap: 10, margin: "8px 0 0", color: "var(--text-primary)" };
const subtitleStyle = { margin: "6px 0 0", color: "var(--text-secondary)", maxWidth: 760 };
const backBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--border-color)", borderRadius: 6, background: "var(--surface-color)", color: "var(--text-primary)", cursor: "pointer" };
const refreshBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", border: "1px solid var(--border-color)", borderRadius: 6, background: "var(--surface-color)", color: "var(--text-primary)", cursor: "pointer" };
const stateBox = { padding: 24, border: "1px solid var(--border-color)", borderRadius: 8, color: "var(--text-secondary)", background: "var(--surface-color)" };
const summaryGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 12 };
const metricStyle = { padding: 14, border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--surface-color)" };
const metricLabel = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", letterSpacing: 0.4 };
const metricValue = { marginTop: 6, fontSize: 24, fontWeight: 800 };
const cardStyle = { border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--surface-color)", padding: 14 };
const noteStyle = { margin: "-4px 0 16px", color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5 };
const sectionHeader = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8 };
const sectionTitle = { display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px", fontSize: 16, color: "var(--text-primary)" };
const tableWrap = { overflowX: "auto" };
const sourceTableWrap = { overflow: "auto", maxHeight: 430, border: "1px solid var(--border-light, #2a2f38)", borderRadius: 6, scrollbarGutter: "stable", background: "var(--surface-color, #111318)" };
const tableStyle = { width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 760 };
const th = { textAlign: "left", padding: "11px 10px", height: 38, fontSize: 11, lineHeight: 1.2, textTransform: "uppercase", color: "var(--text-secondary, #a8b0bd)", borderBottom: "1px solid var(--border-color, #303640)", position: "sticky", top: 0, zIndex: 3, background: "var(--surface-color, #111318)", boxShadow: "0 1px 0 var(--border-color, #303640)" };
const thRight = { ...th, textAlign: "right" };
const td = { padding: "9px 10px", height: 39, fontSize: 13, lineHeight: 1.35, color: "var(--text-primary, #f3f4f6)", borderTop: "1px solid var(--border-light, #252a32)", background: "var(--surface-color, #111318)", verticalAlign: "middle" };
const tdRight = { ...td, textAlign: "right" };
const trStyle = { borderTop: "1px solid var(--border-light)" };
const emptyCell = { padding: 24, textAlign: "center", color: "var(--text-secondary)" };
const brandBadge = { padding: "2px 8px", borderRadius: 4, background: "var(--subtle-bg-3)", color: "var(--primary-color)", fontWeight: 700, fontSize: 11 };
const infiniteStatusStyle = { marginTop: 12, color: "var(--text-secondary)", fontSize: 13, minHeight: 20 };
const linkStyle = { color: "var(--primary-color)", fontWeight: 700, textDecoration: "none" };




