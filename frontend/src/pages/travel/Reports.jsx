// Travel CRM — Reports page (PRD §4.9 / §7).
//
// Lives at /travel/reports. Three tabs:
//   - TMC          revenue by destination, repeat schools, deal funnel
//   - RFU          itinerary revenue by status, diagnostic tier mix, repeat customers
//   - Cross-brand  side-by-side won-revenue + conversion across all
//                  sub-brands the caller can see
//
// Each tab is a single round-trip to its dedicated endpoint. Cards stack
// vertically on narrow screens; on wider screens they sit in a responsive
// grid. Sub-brand scoping happens server-side via the caller's
// subBrandAccess — a TMC-ops user gets 403 on the RFU tab and vice versa.
import { useEffect, useMemo, useState } from "react";
import { useNavigateSafe } from "../../utils/routerSafe";
import {
  AlertCircle, BarChart3, ChevronDown, ChevronRight, FileCheck2, Globe, MapPin, PlaneTakeoff, RefreshCw, School, Star, TrendingUp, Download, Users, Wallet,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";

const TABS = [
  { key: "overview", label: "Overview", icon: BarChart3 },
  { key: "tmc", label: "TMC", icon: School },
  { key: "rfu", label: "RFU", icon: Globe },
  { key: "cross-brand", label: "Cross-brand", icon: BarChart3 },
];

const DATE_PRESETS = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "last7", label: "Last 7 days" },
  { key: "last28", label: "Last 28 days" },
  { key: "custom", label: "Custom" },
];

function formatDateInput(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPresetRange(key) {
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  switch (key) {
    case "today": {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: formatDateInput(start), to: formatDateInput(endOfDay) };
    }
    case "last7": {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      return { from: formatDateInput(start), to: formatDateInput(endOfDay) };
    }
    case "last28": {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 27);
      return { from: formatDateInput(start), to: formatDateInput(endOfDay) };
    }
    default:
      return { from: "", to: "" };
  }
}

export default function TravelReports() {
  const [tab, setTab] = useState("overview");
  const [datePreset, setDatePreset] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const notify = useNotify();
  const [exporting, setExporting] = useState(false);

  const dateParams = useMemo(() => {
    if (datePreset === "custom") {
      return { from: customFrom, to: customTo };
    }
    return getPresetRange(datePreset);
  }, [datePreset, customFrom, customTo]);

  // Download the ACTIVE tab as a branded, tabular PDF. Raw fetch (not fetchApi)
  // because we need the binary blob + auth header, mirroring Reports.jsx.
  const downloadPdf = () => {
    setExporting(true);
    const token = getAuthToken();
    const exportTab = "overview";
    const q = new URLSearchParams({ tab: exportTab });
    if (dateParams.from) q.set("from", dateParams.from);
    if (dateParams.to) q.set("to", dateParams.to);
    fetch(`/api/travel/reports/export-pdf?${q.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => { if (!res.ok) throw new Error("PDF export failed"); return res.blob(); })
      .then((blob) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "travel-report.pdf";
        link.click();
        URL.revokeObjectURL(link.href);
      })
      .catch(() => notify.error("Failed to export PDF (you may not have access to this sub-brand)"))
      .finally(() => setExporting(false));
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <header style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <BarChart3 size={28} aria-hidden /> Travel Reports
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0 }}>
            Drill-down analytics per sub-brand. Sub-brand access enforced server-side.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadPdf}
          disabled={exporting}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px",
            borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: exporting ? "default" : "pointer",
            background: "var(--primary-color, var(--accent-color))", color: "#fff", border: "none", opacity: exporting ? 0.7 : 1,
          }}
          aria-label="Download this report as PDF"
        >
          <Download size={14} /> {exporting ? "Preparing..." : "Download PDF"}
        </button>
      </header>

      <div style={filterBar}>
        <div style={filterGroup}>
          <label htmlFor="date-preset" style={filterLabel}>Date range</label>
          <select
            id="date-preset"
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value)}
            style={filterSelect}
          >
            {DATE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </div>
        {datePreset === "custom" && (
          <>
            <div style={filterGroup}>
              <label htmlFor="custom-from" style={filterLabel}>From</label>
              <input
                id="custom-from"
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={filterInput}
              />
            </div>
            <div style={filterGroup}>
              <label htmlFor="custom-to" style={filterLabel}>To</label>
              <input
                id="custom-to"
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                style={filterInput}
              />
            </div>
          </>
        )}
      </div>

      <div role="tablist" aria-label="Report tabs" style={tabStrip}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                ...tabBtn,
                borderBottom: active ? "2px solid var(--primary-color)" : "2px solid transparent",
                color: active ? "var(--primary-color)" : "var(--text-secondary)",
              }}
            >
              <Icon size={16} aria-hidden /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <OverviewTab dateParams={dateParams} onSelectTab={setTab} />}
      {tab === "tmc" && <TmcTab dateParams={dateParams} />}
      {tab === "rfu" && <RfuTab dateParams={dateParams} />}
      {tab === "cross-brand" && <CrossBrandTab dateParams={dateParams} />}
    </div>
  );
}

// ─── Shared loader + error chrome ──────────────────────────────────

function useReport(path, params = null) {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const url = useMemo(() => {
    if (!params || (!params.from && !params.to)) return path;
    const q = new URLSearchParams();
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    return `${path}?${q.toString()}`;
  }, [path, params]);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchApi(url)
      .then((res) => { setData(res); setError(null); })
      .catch((e) => {
        const msg = e?.body?.error || "Failed to load report";
        setError(msg);
        // 403 is expected when sub-brand access denies the tab — surface
        // quietly without the toast spam.
        if (e?.status !== 403) notify.error(msg);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, loading, error, reload: load };
}

function StateShell({ loading, error, reload, children }) {
  if (loading) return <div style={loadingBox}>Loading report&hellip;</div>;
  if (error) {
    return (
      <div style={errorBox} role="alert">
        <AlertCircle size={18} aria-hidden style={{ color: "var(--warning-color)" }} />
        <div>
          <div>{error}</div>
          <button type="button" onClick={reload} style={refreshBtn}>
            <RefreshCw size={14} aria-hidden /> Retry
          </button>
        </div>
      </div>
    );
  }
  return children;
}

// Complete Reports overview: baseline report areas requested by the client.
function OverviewTab({ dateParams, onSelectTab }) {
  const { data, loading, error, reload } = useReport("/api/travel/reports/summary", dateParams);
  const navigate = useNavigateSafe();

  const reportQuery = () => {
    const q = new URLSearchParams({ source: "reports" });
    if (dateParams?.from) q.set("from", dateParams.from);
    if (dateParams?.to) q.set("to", dateParams.to);
    return q.toString();
  };
  return (
    <StateShell loading={loading} error={error} reload={reload}>
      {data && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={summaryBand}>
            <SummaryMetric label="Active TMC trips" value={data.tmc?.trips?.active ?? 0} helper={`${data.tmc?.trips?.total ?? 0} total trips`} />
            <SummaryMetric label="RFU itineraries" value={data.rfu?.itineraries?.total ?? 0} helper={`Revenue ${money(data.rfu?.itineraries?.revenue)}`} />
            <SummaryMetric label="Sub-brands" value={data.crossBrand?.subBrandCount ?? 0} helper={`${data.crossBrand?.conversionPct ?? 0}% deal conversion`} />
            <SummaryMetric label="Generated" value={data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"} helper="latest snapshot" />
          </div>

          <div style={gridStyle}>
            <ReportAreaCard
              icon={TrendingUp}
              title="Sales funnel"
              status="Wired"
              primary={`${data.salesFunnel?.conversionPct ?? 0}% quote conversion`}
              details={[
                `${data.salesFunnel?.total ?? 0} quotes`,
                `${data.salesFunnel?.accepted ?? 0} accepted`,
                `${data.salesFunnel?.rejected ?? 0} rejected`,
              ]}
              actionLabel="Open TMC/RFU funnels"
              onClick={() => onSelectTab("tmc")}
            />
            <ReportAreaCard
              icon={Users}
              title="Agent productivity"
              status="Staff quote actions"
              primary={`${data.agentProductivity?.agents?.length ?? 0} active agents`}
              details={[
                "Counts quote create, update, share, accept, decline and related staff actions.",
                ...(data.agentProductivity?.agents || []).slice(0, 2).map((a) => (
                  `${a.name}: ${a.totalActions} actions (${a.createdQuotes || 0} created, ${a.sentQuotes || 0} sent, ${a.acceptedQuotes || 0} accepted, ${a.paidQuotes || 0} paid, ${money(a.paymentAmount || 0)} collected)`
                )),
              ]}
              empty="No staff-owned quote actions recorded yet."
            />
            <ReportAreaCard
              icon={Wallet}
              title="Sub-brand P&L"
              status="Revenue vs captured cost"
              primary={money(Object.values(data.subBrandPnl?.rows || {}).reduce((sum, row) => sum + Number(row.grossProfit || 0), 0))}
              details={[
                "P&L = invoice revenue minus itinerary item costs captured in masters/itineraries.",
                "Revenue uses issued, partial and paid travel invoices; costs use unit cost x quantity.",
                ...Object.entries(data.subBrandPnl?.rows || {}).slice(0, 2).map(([brand, row]) => `${brand}: revenue ${money(row.revenue)} / cost ${money(row.capturedCost)}`),
              ]}
              empty="No invoice/cost rows captured yet."
              actionLabel="View detailed P&L"
              onClick={() => navigate(`/travel/reports/pnl?${reportQuery()}`)}
            />
            <ReportAreaCard
              icon={FileCheck2}
              title="Visa approval rate"
              status="Wired"
              primary={`${data.visaApproval?.approvalRatePct ?? 0}% approved`}
              details={[
                `${data.visaApproval?.approved ?? 0} approved`,
                `${data.visaApproval?.rejected ?? 0} rejected`,
                `${data.visaApproval?.total ?? 0} applications`,
              ]}
              actionLabel="Open Visa reports"
              onClick={() => navigate(`/travel/visa/reports?${reportQuery()}`)}
            />
            <ReportAreaCard
              icon={PlaneTakeoff}
              title="Check-in miss rate"
              status="Wired"
              primary={`${data.checkinMiss?.missRatePct ?? 0}% missed/at-risk`}
              details={[
                `${data.checkinMiss?.completed ?? 0} completed`,
                `${data.checkinMiss?.missed ?? 0} failed or manual fallback`,
                `${data.checkinMiss?.total ?? 0} check-ins`,
              ]}
              actionLabel="Open check-ins"
              onClick={() => navigate(`/travel/web-checkins?${reportQuery()}`)}
            />
            <ReportAreaCard
              icon={BarChart3}
              title="Brand drill-downs"
              status="Available"
              primary="TMC, RFU, Cross-brand"
              details={["Revenue, trip status, diagnostics, quote pipeline", "Use tabs above for detailed tables and PDF export"]}
              actionLabel="Open cross-brand"
              onClick={() => onSelectTab("cross-brand")}
            />
          </div>
        </div>
      )}
    </StateShell>
  );
}

function SummaryMetric({ label, value, helper, onClick = null }) {
  const interactive = typeof onClick === "function";
  return (
    <div
      style={{ ...summaryMetric, cursor: interactive ? "pointer" : undefined }}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Open ${label}` : undefined}
    >
      <div style={summaryMetricLabel}>{label}</div>
      <div style={summaryMetricValue}>{value}</div>
      <div style={summaryMetricHelper}>{helper}</div>
    </div>
  );
}

function DetailMetric({ label, value, helper }) {
  return (
    <div style={detailMetric}>
      <div style={summaryMetricLabel}>{label}</div>
      <div style={detailMetricValue}>{value}</div>
      <div style={summaryMetricHelper}>{helper}</div>
    </div>
  );
}

function conversionPct(part, total) {
  return total > 0 ? Number(((Number(part || 0) / Number(total || 0)) * 100).toFixed(2)) : 0;
}

function revenueShare(value, total) {
  return total > 0 ? Number(((Number(value || 0) / Number(total || 0)) * 100).toFixed(2)) : 0;
}

function diagnosticShare(value, total) {
  return total > 0 ? Number(((Number(value || 0) / Number(total || 0)) * 100).toFixed(2)) : 0;
}

function ReportAreaCard({ icon: Icon, title, status, primary, details, empty: emptyText, actionLabel, onClick }) {
  const interactive = typeof onClick === "function";
  return (
    <section
      style={{ ...cardStyle, cursor: interactive ? "pointer" : undefined }}
      onClick={onClick}
      onKeyDown={interactive ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `${title} - ${actionLabel}` : undefined}
    >
      <div style={cardHeaderRow}>
        <h2 style={{ ...cardTitle, display: "inline-flex", alignItems: "center", gap: 8 }}><Icon size={16} aria-hidden /> {title}</h2>
        <span style={statusPill}>{status}</span>
      </div>
      <div style={areaPrimary}>{primary}</div>
      {details?.length ? (
        <ul style={areaList}>{details.map((item) => <li key={item} style={areaItem}>{item}</li>)}</ul>
      ) : <div style={{ ...empty, padding: "8px 0", textAlign: "left" }}>{emptyText}</div>}
      {actionLabel ? <div style={{ ...cardActionText, marginTop: 12 }}>{actionLabel}</div> : null}
    </section>
  );
}

function money(value) {
  return `INR ${Number(value || 0).toLocaleString("en-IN")}`;
}
// ─── TMC tab ───────────────────────────────────────────────────────

function TmcTab({ dateParams }) {
  const { data, loading, error, reload } = useReport("/api/travel/reports/tmc", dateParams);
  const navigate = useNavigateSafe();
  const [detailView, setDetailView] = useState(null);

  const tmcReportQuery = (extra = {}) => {
    const q = new URLSearchParams({ source: "reports", subBrand: "tmc", ...extra });
    if (dateParams.from) q.set("fromDate", dateParams.from);
    if (dateParams.to) q.set("toDate", dateParams.to);
    return q;
  };

  const openTrips = (status = "", search = "") => {
    const q = tmcReportQuery(status ? { status } : {});
    if (search) q.set("search", search);
    q.set("from", "reports");
    navigate(`/travel/trips?${q.toString()}`);
  };

  const openTmcQuotes = (status = "") => {
    const q = tmcReportQuery(status ? { status } : {});
    navigate(`/travel/quotes-admin?${q.toString()}`);
  };

  const openTripDetail = (id) => {
    navigate(`/travel/trips/${id}`, { state: { backTo: "/travel/reports", backLabel: "Back to reports" } });
  };

  const showRevenueDetail = () => setDetailView((current) => (current === "revenue" ? null : "revenue"));
  const showSchoolDetail = () => setDetailView((current) => (current === "schools" ? null : "schools"));
  const showTripDetail = () => setDetailView((current) => (current === "trips" ? null : "trips"));

  return (
    <StateShell loading={loading} error={error} reload={reload}>
      {data && (
        <div style={gridStyle}>
          <Tile
            icon={MapPin}
            label="Total revenue (active trips)"
            primary={`₹${Number(data.revenue.total).toLocaleString("en-IN")}`}
            footer={`${data.trips.active} active trips · ${data.trips.total} all-time`}
            onClick={showRevenueDetail}
          />
          <Tile
            icon={School}
            label="Schools"
            primary={data.schools.unique}
            footer={
              data.schools.unique > 0
                ? `${data.schools.repeat} repeat (${data.schools.repeatRatePct}%)`
                : "no schools yet"
            }
            onClick={showSchoolDetail}
          />

          <Card
            title="Trip status"
            onClick={showTripDetail}
            interactive
            actionLabel="View trip detail"
          >
            <KeyValueList
              obj={data.trips.byStatus}
              formatter={(v) => String(v)}
              empty="No trips yet."
              onItemClick={(status) => openTrips(status)}
            />
          </Card>

          {(detailView === "revenue" || detailView === "trips") && (
            <TmcRevenueDetail
              rows={data.revenue.rows || []}
              onOpenTrip={openTripDetail}
              title={detailView === "revenue" ? "TMC revenue source detail" : "TMC trip source detail"}
            />
          )}

          {detailView === "schools" && (
            <TmcSchoolDetail rows={data.revenue.rows || []} onOpenTrip={openTripDetail} />
          )}

          <QuoteFunnelCard quotes={data.quotes} onStatusClick={(status) => openTmcQuotes(status)} />

          <Card title="Deal funnel">
            <TopScrollSync>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr><th style={th}>Stage</th><th style={thRight}>Count</th><th style={thRight}>Amount</th></tr>
              </thead>
              <tbody>
                {Object.keys(data.deals.byStage).length === 0 && (
                  <tr><td colSpan="3" style={emptyCell}>No deals yet.</td></tr>
                )}
                {Object.entries(data.deals.byStage).map(([stage, count]) => (
                  <tr key={stage} style={trStyle}>
                    <td style={td}>{stage}</td>
                    <td style={tdRight}>{count}</td>
                    <td style={tdRight}>₹{Number(data.deals.amountByStage[stage] || 0).toLocaleString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </TopScrollSync>
          </Card>

          <Card title="Diagnostics by lead type">
            <KeyValueList
              obj={data.diagnostics.byClassification}
              formatter={(v) => String(v)}
              labelForKey={diagnosticClassificationLabel}
              empty="No diagnostics yet."
            />
          </Card>

          <Card title={`Top destinations by revenue (top ${Math.min(10, data.revenue.topDestinations.length)})`} wide>
            {data.revenue.topDestinations.length === 0 ? (
              <div style={empty}>No revenue recorded yet.</div>
            ) : (
              <TopScrollSync>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr><th style={th}>Destination</th><th style={thRight}>Revenue</th></tr>
                </thead>
                <tbody>
                  {data.revenue.topDestinations.map((row) => (
                    <tr key={row.destination} style={trStyle}>
                      <td style={td}>{row.destination}</td>
                      <td style={tdRight}>₹{Number(row.revenue).toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </TopScrollSync>
            )}
          </Card>
        </div>
      )}
    </StateShell>
  );
}

// ─── RFU tab ───────────────────────────────────────────────────────

function RfuTab({ dateParams }) {
  const { data, loading, error, reload } = useReport("/api/travel/reports/rfu", dateParams);
  const navigate = useNavigateSafe();
  const [detailView, setDetailView] = useState(null);

  const analytics = useMemo(() => {
    if (!data) return null;
    const quoteTotal = Object.values(data.quotes?.byStatus || {}).reduce((sum, n) => sum + Number(n || 0), 0);
    const quoteAccepted = Object.entries(data.quotes?.byStatus || {})
      .filter(([status]) => ["Accepted", "advance_paid", "fully_paid", "accepted"].includes(status))
      .reduce((sum, [, n]) => sum + Number(n || 0), 0);
    const quoteRevenue = Object.entries(data.quotes?.amountByStatus || {})
      .filter(([status]) => ["Accepted", "advance_paid", "fully_paid", "accepted"].includes(status))
      .reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
    const itineraryRevenue = Object.values(data.itineraries?.amountByStatus || {}).reduce((sum, amount) => sum + Number(amount || 0), 0);
    const diagnosticsTotal = Object.values(data.diagnostics?.byTier || {}).reduce((sum, n) => sum + Number(n || 0), 0);
    const topStatus = Object.entries(data.itineraries?.amountByStatus || {})
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0] || null;
    const topTier = Object.entries(data.diagnostics?.byTier || {})
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0] || null;
    const agents = data.agentProductivity?.agents || [];
    const topAgent = agents[0] || null;
    return { quoteTotal, quoteAccepted, quoteRevenue, itineraryRevenue, diagnosticsTotal, topStatus, topTier, agents, topAgent };
  }, [data]);

  const reportQuery = (extra = {}) => {
    const q = new URLSearchParams({ source: "reports", subBrand: "rfu", ...extra });
    if (dateParams.from) q.set("from", dateParams.from);
    if (dateParams.to) q.set("to", dateParams.to);
    return q.toString();
  };

  const openRfuItineraries = (status = "") => {
    const q = reportQuery(status ? { status } : {});
    navigate(`/travel/itineraries?${q}`);
  };

  const openRfuQuotes = (status = "") => {
    const q = reportQuery(status ? { status } : {});
    navigate(`/travel/quotes-admin?${q}`);
  };

  const openRfuItinerary = (id) => {
    navigate(`/travel/itineraries/${id}`, { state: { backTo: "/travel/reports", backLabel: "Back to reports" } });
  };

  const openRfuQuote = (id) => {
    navigate(`/travel/quotes/builder/${id}`, { state: { backTo: "/travel/reports", backLabel: "Back to reports" } });
  };

  const showRevenueDetail = () => setDetailView((current) => (current === "revenue" ? null : "revenue"));
  const showAdvisorDetail = () => setDetailView((current) => (current === "advisors" ? null : "advisors"));

  return (
    <StateShell loading={loading} error={error} reload={reload}>
      {data && analytics && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={summaryBand}>
            <SummaryMetric label="RFU itinerary revenue" value={money(analytics.itineraryRevenue)} helper={`${data.itineraries.total} itineraries`} onClick={showRevenueDetail} />
            <SummaryMetric label="Quote acceptance" value={`${conversionPct(analytics.quoteAccepted, analytics.quoteTotal)}%`} helper={`${analytics.quoteAccepted}/${analytics.quoteTotal} accepted or paid`} onClick={showAdvisorDetail} />
            <SummaryMetric label="Repeat customers" value={`${data.customers.repeatRatePct}%`} helper={`${data.customers.repeat} repeat from ${data.customers.unique} customers`} />
            <SummaryMetric label="Active advisors" value={analytics.agents.length} helper={analytics.topAgent ? `Top: ${analytics.topAgent.name}` : "No advisor actions yet"} />
          </div>

          <div style={gridStyle}>
            <Card title="Revenue health" onClick={showRevenueDetail} interactive actionLabel="View revenue detail">
              <div style={areaPrimary}>{money(analytics.itineraryRevenue)}</div>
              <ul style={areaList}>
                <li style={areaItem}>Quote revenue accepted/paid: {money(analytics.quoteRevenue)}</li>
                <li style={areaItem}>Top itinerary status: {analytics.topStatus ? `${analytics.topStatus[0]} (${money(analytics.topStatus[1])})` : "No status revenue yet"}</li>
                <li style={areaItem}>Customer repeat rate: {data.customers.repeatRatePct}%</li>
              </ul>
            </Card>

            <Card title="Advisor activity" onClick={showAdvisorDetail} interactive actionLabel="View advisor detail">
              {analytics.agents.length === 0 ? (
                <div style={{ ...empty, padding: "8px 0", textAlign: "left" }}>No RFU advisor quote activity yet.</div>
              ) : (
                <ul style={areaList}>
                  {analytics.agents.slice(0, 4).map((agent) => (
                    <li key={agent.userId} style={areaItem}>
                      <strong style={{ color: "var(--text-primary)" }}>{agent.name}</strong>: {agent.totalActions} actions ({agent.createdQuotes || 0} created, {agent.sentQuotes || 0} sent, {agent.acceptedQuotes || 0} accepted, {agent.paidQuotes || 0} paid, {money(agent.paymentAmount || 0)} collected)
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Diagnostics intelligence">
              <div style={areaPrimary}>{analytics.diagnosticsTotal} diagnostics</div>
              <ul style={areaList}>
                <li style={areaItem}>Top package fit: {analytics.topTier ? `${diagnosticTierLabel(analytics.topTier[0])} (${analytics.topTier[1]})` : "No package-fit data"}</li>
                <li style={areaItem}>Lead type mix: {byKeyInline(data.diagnostics.byClassification, diagnosticClassificationLabel) || "No lead-type data"}</li>
                <li style={areaItem}>Use lower-readiness cohorts for advisor follow-up and nurture campaigns.</li>
              </ul>
            </Card>
          </div>

          {detailView === "revenue" && (
            <RfuRevenueDetail
              rows={data.revenueRows || []}
              payments={data.agentProductivity?.payments || []}
              onOpenItinerary={openRfuItinerary}
              onOpenQuote={openRfuQuote}
            />
          )}

          {detailView === "advisors" && (
            <RfuAdvisorDetail
              agents={analytics.agents}
              payments={data.agentProductivity?.payments || []}
              onOpenQuote={openRfuQuote}
            />
          )}

          <Card title="Itinerary revenue by status" wide>
            <TopScrollSync>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr><th style={th}>Status</th><th style={thRight}>Count</th><th style={thRight}>Revenue</th><th style={thRight}>Revenue share</th></tr>
              </thead>
              <tbody>
                {Object.keys(data.itineraries.byStatus).length === 0 && (
                  <tr><td colSpan="4" style={emptyCell}>No itineraries yet.</td></tr>
                )}
                {Object.entries(data.itineraries.byStatus).map(([status, count]) => {
                  const amount = Number(data.itineraries.amountByStatus[status] || 0);
                  return (
                    <tr key={status} style={{ ...trStyle, cursor: "pointer" }} onClick={() => openRfuItineraries(status)} title={`Open RFU ${status} itineraries`}>
                      <td style={td}>{status}</td>
                      <td style={tdRight}>{count}</td>
                      <td style={tdRight}>{money(amount)}</td>
                      <td style={tdRight}>{revenueShare(amount, analytics.itineraryRevenue)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </TopScrollSync>
          </Card>

          <div style={gridStyle}>
            <QuoteFunnelCard quotes={data.quotes} onStatusClick={(status) => openRfuQuotes(status)} />

            <Card title="Deal funnel">
              <TopScrollSync>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr><th style={th}>Stage</th><th style={thRight}>Count</th><th style={thRight}>Amount</th></tr>
                </thead>
                <tbody>
                  {Object.keys(data.deals.byStage).length === 0 && (
                    <tr><td colSpan="3" style={emptyCell}>No deals yet.</td></tr>
                  )}
                  {Object.entries(data.deals.byStage).map(([stage, count]) => (
                    <tr key={stage} style={trStyle}>
                      <td style={td}>{stage}</td>
                      <td style={tdRight}>{count}</td>
                      <td style={tdRight}>{money(data.deals.amountByStage[stage] || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </TopScrollSync>
            </Card>
          </div>

          <Card title="Diagnostics by lead type" wide>
            <KeyValueList
              obj={data.diagnostics.byClassification}
              formatter={(v) => String(v)}
              labelForKey={diagnosticClassificationLabel}
              empty="No diagnostics yet."
            />
          </Card>
        </div>
      )}
    </StateShell>
  );
}

function CrossBrandTab({ dateParams }) {
  const { data, loading, error, reload } = useReport("/api/travel/reports/cross-brand", dateParams);
  const [expandedBrand, setExpandedBrand] = useState(null);

  const brands = useMemo(() => Object.entries(data?.subBrands || {})
    .map(([brand, m]) => ({
      brand,
      quotesTotal: Number(m.quotesTotal || 0),
      quotesAccepted: Number(m.quotesAccepted || 0),
      quoteRevenue: Number(m.quoteRevenue || 0),
      quoteConversionPct: Number(m.quoteConversionPct || 0),
      won: Number(m.won || 0),
      lost: Number(m.lost || 0),
      wonRevenue: Number(m.wonRevenue || 0),
      diagnostics: Number(m.diagnostics || 0),
    }))
    .sort((a, b) => b.quoteRevenue - a.quoteRevenue), [data]);

  const totals = useMemo(() => brands.reduce((acc, row) => {
    acc.quotesTotal += row.quotesTotal;
    acc.quotesAccepted += row.quotesAccepted;
    acc.quoteRevenue += row.quoteRevenue;
    acc.won += row.won;
    acc.lost += row.lost;
    acc.wonRevenue += row.wonRevenue;
    acc.diagnostics += row.diagnostics;
    return acc;
  }, {
    quotesTotal: 0, quotesAccepted: 0, quoteRevenue: 0,
    won: 0, lost: 0, wonRevenue: 0, diagnostics: 0,
  }), [brands]);

  const topRevenue = brands[0] || null;
  const topConversion = [...brands]
    .filter((row) => row.quotesTotal > 0)
    .sort((a, b) => b.quoteConversionPct - a.quoteConversionPct)[0] || null;
  const maxRevenue = Math.max(...brands.map((row) => row.quoteRevenue), 1);
  const expanded = brands.find((row) => row.brand === expandedBrand) || brands[0] || null;

  return (
    <StateShell loading={loading} error={error} reload={reload}>
      {data && (
        <div style={{ display: "grid", gap: 12 }}>
          {brands.length === 0 ? (
            <div style={empty}>No deal activity across any sub-brand yet.</div>
          ) : (
            <>
              <div style={summaryBand}>
                <SummaryMetric label="Sub-brands active" value={brands.length} helper={`${totals.quotesTotal} quotes tracked`} />
                <SummaryMetric label="Accepted quotes" value={totals.quotesAccepted} helper={`${conversionPct(totals.quotesAccepted, totals.quotesTotal)}% acceptance`} />
                <SummaryMetric label="Quote revenue" value={money(totals.quoteRevenue)} helper={topRevenue ? `Top: ${topRevenue.brand}` : "No revenue yet"} />
                <SummaryMetric label="Diagnostics" value={totals.diagnostics} helper={topConversion ? `Best conversion: ${topConversion.brand}` : "No quote activity yet"} />
              </div>

              <Card title="Brand comparison" wide actionLabel="Click a row to expand">
                <div style={{ display: "grid", gap: 10 }}>
                  {brands.map((row) => {
                    const active = expandedBrand ? expandedBrand === row.brand : expanded?.brand === row.brand;
                    return (
                      <button
                        key={row.brand}
                        type="button"
                        onClick={() => setExpandedBrand(active ? null : row.brand)}
                        style={{ ...brandCompareRow, borderColor: active ? "var(--primary-color)" : "var(--border-color)" }}
                        aria-expanded={active}
                      >
                        <div style={brandCompareMain}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            {active ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
                            <span style={brandBadge}>{row.brand}</span>
                          </div>
                          <div style={brandCompareStats}>
                            <span>{row.quotesAccepted}/{row.quotesTotal} accepted</span>
                            <span>{money(row.quoteRevenue)}</span>
                            <span>{row.diagnostics} diagnostics</span>
                          </div>
                        </div>
                        <div style={barTrack} aria-hidden>
                          <div style={{ ...barFill, width: `${Math.max(4, (row.quoteRevenue / maxRevenue) * 100)}%` }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Card>

              {expanded && (
                <Card title={`${expanded.brand.toUpperCase()} detailed view`} wide>
                  <div style={detailGrid}>
                    <DetailMetric label="Quote acceptance" value={`${conversionPct(expanded.quotesAccepted, expanded.quotesTotal)}%`} helper={`${expanded.quotesAccepted} accepted from ${expanded.quotesTotal} quotes`} />
                    <DetailMetric label="Quote revenue" value={money(expanded.quoteRevenue)} helper={`${revenueShare(expanded.quoteRevenue, totals.quoteRevenue)}% of cross-brand quote revenue`} />
                    <DetailMetric label="Deal movement" value={`${expanded.won} won`} helper={`${expanded.lost} lost deals recorded`} />
                    <DetailMetric label="Diagnostics load" value={expanded.diagnostics} helper={`${diagnosticShare(expanded.diagnostics, totals.diagnostics)}% of diagnostics`} />
                  </div>
                  <div style={insightPanel}>
                    <div style={insightTitle}>What this means</div>
                    <ul style={areaList}>
                      <li style={areaItem}>
                        {expanded.quoteRevenue > 0
                          ? `${expanded.brand.toUpperCase()} is contributing ${revenueShare(expanded.quoteRevenue, totals.quoteRevenue)}% of visible quote revenue.`
                          : `${expanded.brand.toUpperCase()} has no accepted quote revenue in this date range.`}
                      </li>
                      <li style={areaItem}>
                        {expanded.quotesTotal > 0
                          ? `${expanded.quotesTotal - expanded.quotesAccepted} quotes are still not accepted or are outside accepted/paid states.`
                          : "No quote pipeline is visible for this brand in the selected range."}
                      </li>
                      <li style={areaItem}>
                        {expanded.diagnostics > 0
                          ? `${expanded.diagnostics} diagnostics are available to review demand and qualification quality.`
                          : "No diagnostics have been captured for this brand yet."}
                      </li>
                    </ul>
                  </div>
                </Card>
              )}

              <Card title="Raw brand metrics" wide>
                <TopScrollSync>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={th}>Sub-brand</th>
                      <th style={thRight}>Quotes</th>
                      <th style={thRight}>Accepted</th>
                      <th style={thRight}>Quote revenue</th>
                      <th style={thRight}>Quote conv. %</th>
                      <th style={thRight}>Won deals</th>
                      <th style={thRight}>Diagnostics</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brands.map((row) => (
                      <tr key={row.brand} style={trStyle}>
                        <td style={td}><span style={brandBadge}>{row.brand}</span></td>
                        <td style={tdRight}>{row.quotesTotal}</td>
                        <td style={tdRight}>{row.quotesAccepted}</td>
                        <td style={tdRight}>{money(row.quoteRevenue)}</td>
                        <td style={tdRight}>{row.quoteConversionPct}%</td>
                        <td style={tdRight}>{row.won}</td>
                        <td style={tdRight}>{row.diagnostics}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TopScrollSync>
              </Card>
            </>
          )}
        </div>
      )}
    </StateShell>
  );
}

// Building blocks

function Tile({ icon: Icon, label, primary, footer, onClick = null }) {
  const interactive = typeof onClick === "function";
  return (
    <div
      style={{ ...tileStyle, cursor: interactive ? "pointer" : undefined }}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Open ${label}` : undefined}
    >
      <div style={tileLabelRow}>
        <Icon size={16} aria-hidden /> {label}
      </div>
      <div style={tilePrimary}>{primary ?? 0}</div>
      {footer && <div style={tileFooter}>{footer}</div>}
    </div>
  );
}

function Card({ title, children, wide, interactive, onClick, actionLabel }) {
  const isInteractive = interactive === true && typeof onClick === "function";
  const label = actionLabel ? `${title} - ${actionLabel}` : title;
  return (
    <section
      style={{ ...cardStyle, cursor: isInteractive ? "pointer" : undefined, gridColumn: wide ? "1 / -1" : undefined }}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={isInteractive ? label : undefined}
      onClick={isInteractive ? onClick : undefined}
      onKeyDown={isInteractive ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      } : undefined}
    >
      <h2 style={cardTitle}>{title}</h2>
      {children}
    </section>
  );
}

// The real travel sales funnel — TravelQuote by status (count + ₹). Travel
// never creates generic Deal rows, so the legacy "Deal funnel" was always
// empty; this surfaces the actual quote pipeline that DOES have data.


function TmcRevenueDetail({ rows = [], onOpenTrip, title = "TMC revenue source detail" }) {
  const total = rows.reduce((sum, row) => sum + Number(row.revenue || 0), 0);
  return (
    <Card title={title} wide>
      <div style={detailHelpText}>
        TMC revenue is calculated from active school trips only: price per student multiplied by confirmed participant count. Cancelled trips are excluded from revenue totals.
      </div>
      <TopScrollSync>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
          <thead>
            <tr><th style={th}>Trip</th><th style={th}>School</th><th style={th}>Status</th><th style={thRight}>Participants</th><th style={thRight}>Price/student</th><th style={thRight}>Revenue</th><th style={th}>Dates</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="7" style={emptyCell}>No active TMC trip revenue rows yet.</td></tr>}
            {rows.slice(0, 50).map((row) => (
              <tr key={row.id} style={{ ...trStyle, cursor: "pointer" }} onClick={() => onOpenTrip(row.id)} title="Open trip detail">
                <td style={td}><span style={linkLike}>{row.tripCode || `Trip #${row.id}`}</span><div style={mutedSmall}>{row.destination || "-"}</div></td>
                <td style={td}>{row.schoolName || (row.schoolId ? `School #${row.schoolId}` : "-")}</td>
                <td style={td}>{humanizeKey(row.status)}</td>
                <td style={tdRight}>{row.participants || 0}</td>
                <td style={tdRight}>{money(row.pricePerStudent || 0)}</td>
                <td style={tdRight}>{money(row.revenue || 0)}</td>
                <td style={td}>{formatReportDate(row.departDate)} - {formatReportDate(row.returnDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TopScrollSync>
      <div style={mutedFooter}>Showing {Math.min(rows.length, 50)} of {rows.length} active trip rows. Visible revenue total {money(total)}.</div>
    </Card>
  );
}

function TmcSchoolDetail({ rows = [], onOpenTrip }) {
  const bySchool = new Map();
  for (const row of rows) {
    const key = row.schoolId || row.schoolName || "unknown";
    const current = bySchool.get(key) || {
      key,
      schoolName: row.schoolName || (row.schoolId ? `School #${row.schoolId}` : "Unknown school"),
      trips: 0,
      participants: 0,
      revenue: 0,
      lastTripId: row.id,
    };
    current.trips += 1;
    current.participants += Number(row.participants || 0);
    current.revenue += Number(row.revenue || 0);
    current.lastTripId = row.id;
    bySchool.set(key, current);
  }
  const schools = [...bySchool.values()].sort((a, b) => b.revenue - a.revenue);
  return (
    <Card title="TMC school performance detail" wide>
      <div style={detailHelpText}>
        School analytics are grouped from the tenant's active TMC trips so repeat schools, participant volume, and revenue can be checked without leaving reports.
      </div>
      <TopScrollSync>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
          <thead>
            <tr><th style={th}>School</th><th style={thRight}>Trips</th><th style={thRight}>Participants</th><th style={thRight}>Revenue</th><th style={th}>Follow-up</th></tr>
          </thead>
          <tbody>
            {schools.length === 0 && <tr><td colSpan="5" style={emptyCell}>No active school trip rows yet.</td></tr>}
            {schools.map((school) => (
              <tr key={school.key} style={{ ...trStyle, cursor: "pointer" }} onClick={() => onOpenTrip(school.lastTripId)} title="Open latest trip detail">
                <td style={td}><span style={linkLike}>{school.schoolName}</span></td>
                <td style={tdRight}>{school.trips}</td>
                <td style={tdRight}>{school.participants}</td>
                <td style={tdRight}>{money(school.revenue)}</td>
                <td style={td}>{school.trips >= 2 ? "Repeat school" : "First trip"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TopScrollSync>
    </Card>
  );
}

function formatReportDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function RfuRevenueDetail({ rows = [], payments = [], onOpenItinerary, onOpenQuote }) {
  const paidTotal = payments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return (
    <Card title="RFU revenue source detail" wide>
      <div style={detailHelpText}>
        Org-level RFU revenue is backed by itinerary totals. Payment rows below show the exact successful collections linked back to the quote/advisor where CRM has the quote or invoice reference.
      </div>
      <TopScrollSync>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
          <thead>
            <tr><th style={th}>Itinerary</th><th style={th}>Customer</th><th style={th}>Status</th><th style={thRight}>Pax</th><th style={thRight}>Revenue</th><th style={th}>Updated</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="6" style={emptyCell}>No RFU itinerary revenue rows yet.</td></tr>}
            {rows.slice(0, 25).map((row) => (
              <tr key={row.id} style={{ ...trStyle, cursor: "pointer" }} onClick={() => onOpenItinerary(row.id)} title="Open itinerary detail">
                <td style={td}><span style={linkLike}>Itinerary #{row.id}</span><div style={mutedSmall}>{row.destination || "Untitled itinerary"}</div></td>
                <td style={td}>{row.contactName || "-"}</td>
                <td style={td}>{humanizeKey(row.status)}</td>
                <td style={tdRight}>{row.pax || 1}</td>
                <td style={tdRight}>{money(row.amount)}</td>
                <td style={td}>{formatReportDate(row.updatedAt || row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TopScrollSync>
      <div style={sectionSubhead}>Successful payment collections linked to RFU quotes</div>
      <TopScrollSync>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr><th style={th}>Quote</th><th style={th}>Advisor</th><th style={th}>Quote status</th><th style={thRight}>Quote total</th><th style={thRight}>Collected</th><th style={th}>Paid on</th></tr>
          </thead>
          <tbody>
            {payments.length === 0 && <tr><td colSpan="6" style={emptyCell}>No successful RFU quote payments are linked yet.</td></tr>}
            {payments.slice(0, 25).map((row) => (
              <tr key={`${row.paymentId || "payment"}-${row.quoteId}`} style={{ ...trStyle, cursor: row.quoteId ? "pointer" : undefined }} onClick={() => row.quoteId && onOpenQuote(row.quoteId)} title={row.quoteId ? "Open quote detail" : undefined}>
                <td style={td}>{row.quoteId ? <span style={linkLike}>Quote #{row.quoteId}</span> : "-"}</td>
                <td style={td}>{row.agentName || "Unassigned"}</td>
                <td style={td}>{humanizeKey(row.quoteStatus || "unknown")}</td>
                <td style={tdRight}>{row.quoteTotal != null ? money(row.quoteTotal) : "-"}</td>
                <td style={tdRight}>{money(row.amount)}</td>
                <td style={td}>{formatReportDate(row.paidAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TopScrollSync>
      <div style={mutedFooter}>Showing {Math.min(rows.length, 25)} of {rows.length} itinerary rows and {Math.min(payments.length, 25)} of {payments.length} payment rows. Linked collections total {money(paidTotal)}.</div>
    </Card>
  );
}

function RfuAdvisorDetail({ agents = [], payments = [], onOpenQuote }) {
  return (
    <Card title="RFU advisor deal and collection detail" wide>
      <div style={detailHelpText}>
        Advisor analytics are built from quote audit history plus customer decisions and successful payment rows. Payment collection is attributed to the advisor who last shared the quote, falling back to the quote creator when share history is not available.
      </div>
      <TopScrollSync>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
          <thead>
            <tr><th style={th}>Advisor</th><th style={thRight}>Actions</th><th style={thRight}>Created</th><th style={thRight}>Sent</th><th style={thRight}>Accepted</th><th style={thRight}>Paid</th><th style={thRight}>Collected</th></tr>
          </thead>
          <tbody>
            {agents.length === 0 && <tr><td colSpan="7" style={emptyCell}>No advisor activity yet.</td></tr>}
            {agents.map((agent) => (
              <tr key={agent.userId} style={trStyle}>
                <td style={td}>{agent.name}</td>
                <td style={tdRight}>{agent.totalActions || 0}</td>
                <td style={tdRight}>{agent.createdQuotes || 0}</td>
                <td style={tdRight}>{agent.sentQuotes || 0}</td>
                <td style={tdRight}>{agent.acceptedQuotes || 0}</td>
                <td style={tdRight}>{agent.paidQuotes || 0}</td>
                <td style={tdRight}>{money(agent.paymentAmount || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TopScrollSync>
      <div style={sectionSubhead}>Paid quote rows by advisor</div>
      <TopScrollSync>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr><th style={th}>Advisor</th><th style={th}>Quote</th><th style={th}>Status</th><th style={thRight}>Collected</th><th style={th}>Paid on</th></tr>
          </thead>
          <tbody>
            {payments.length === 0 && <tr><td colSpan="5" style={emptyCell}>No successful quote payment rows are attributed yet.</td></tr>}
            {payments.map((row) => (
              <tr key={`${row.paymentId || "payment"}-${row.quoteId}`} style={{ ...trStyle, cursor: row.quoteId ? "pointer" : undefined }} onClick={() => row.quoteId && onOpenQuote(row.quoteId)} title={row.quoteId ? "Open quote detail" : undefined}>
                <td style={td}>{row.agentName || "Unassigned"}</td>
                <td style={td}>{row.quoteId ? <span style={linkLike}>Quote #{row.quoteId}</span> : "-"}</td>
                <td style={td}>{humanizeKey(row.quoteStatus || "unknown")}</td>
                <td style={tdRight}>{money(row.amount)}</td>
                <td style={td}>{formatReportDate(row.paidAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TopScrollSync>
    </Card>
  );
}

function QuoteFunnelCard({ quotes, onStatusClick = null }) {
  const byStatus = (quotes && quotes.byStatus) || {};
  const amt = (quotes && quotes.amountByStatus) || {};
  const entries = Object.entries(byStatus);
  const clickable = typeof onStatusClick === "function";
  return (
    <Card title="Quote pipeline">
      <TopScrollSync>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr><th style={th}>Status</th><th style={thRight}>Count</th><th style={thRight}>Amount</th></tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr><td colSpan="3" style={emptyCell}>No quotes yet.</td></tr>
          )}
          {entries.map(([status, count]) => (
            <tr
              key={status}
              style={{ ...trStyle, cursor: clickable ? "pointer" : undefined }}
              onClick={clickable ? () => onStatusClick(status) : undefined}
              title={clickable ? `Open ${status} quotes` : undefined}
            >
              <td style={td}>{status}</td>
              <td style={tdRight}>{count}</td>
              <td style={tdRight}>INR {Number(amt[status] || 0).toLocaleString("en-IN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </TopScrollSync>
    </Card>
  );
}

function KeyValueList({ obj, formatter, empty: emptyText, onItemClick = null, labelForKey = (key) => key }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) return <div style={empty}>{emptyText}</div>;
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {entries.map(([k, v]) => {
        const clickable = typeof onItemClick === "function";
        return (
          <li
            key={k}
            style={{ ...kvRow, cursor: clickable ? "pointer" : undefined }}
            onClick={clickable ? (e) => {
              e.stopPropagation();
              onItemClick(k, v);
            } : undefined}
            onKeyDown={clickable ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onItemClick(k, v);
              }
            } : undefined}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-label={clickable ? `Open ${labelForKey(k)} trips` : undefined}
          >
            <span>{labelForKey(k)}</span>
            <span style={{ fontWeight: 600 }}>{formatter(v)}</span>
          </li>
        );
      })}
    </ul>
  );
}

const DIAGNOSTIC_CLASSIFICATION_LABELS = {
  fit: "Good fit",
  partial: "Needs review",
  unfit: "Not a fit yet",
  ready: "Ready to proceed",
  blocked: "Blocked / needs attention",
  level_1: "Standard readiness",
  level_2: "Confident readiness",
  level_3: "Premium readiness",
  level_4: "High-touch support",
};

const DIAGNOSTIC_TIER_LABELS = {
  entry: "Entry package",
  primary: "Primary package",
  premium: "Premium package",
  engine: "TMC engine",
  tier_1: "Entry package",
  tier_2: "Primary package",
  tier_3: "Premium package",
};

function humanizeKey(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase()) || "Unknown";
}

function diagnosticClassificationLabel(key) {
  const normalized = String(key || "").toLowerCase();
  return DIAGNOSTIC_CLASSIFICATION_LABELS[normalized] || humanizeKey(key);
}

function diagnosticTierLabel(key) {
  const normalized = String(key || "").toLowerCase();
  return DIAGNOSTIC_TIER_LABELS[normalized] || humanizeKey(key);
}

function byKeyInline(obj, labelForKey = (key) => key) {
  if (!obj || Object.keys(obj).length === 0) return null;
  const entries = Object.entries(obj).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${labelForKey(k)}: ${v}`).join(" / ");
}

// ─── Styles ─────────────────────────────────────────────────────────

const summaryBand = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
  gap: 10,
  padding: 12,
  border: "1px solid var(--border-color)",
  borderRadius: 8,
  background: "var(--surface-color)",
};
const summaryMetric = {
  padding: 10,
  borderRadius: 6,
  background: "var(--bg-color)",
  border: "1px solid var(--border-light)",
};
const summaryMetricLabel = { fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.4 };
const summaryMetricValue = { marginTop: 4, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" };
const summaryMetricHelper = { marginTop: 2, fontSize: 12, color: "var(--text-secondary)" };
const statusPill = {
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700,
  background: "rgba(92,124,250,0.14)", color: "var(--primary-color)",
};
const areaPrimary = { fontSize: 20, fontWeight: 700, marginBottom: 10, color: "var(--text-primary)" };
const cardHeaderRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  marginBottom: 8,
};
const cardActionText = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--primary-color)",
};
const areaList = { margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6, fontSize: 13, color: "var(--text-secondary)" };
const areaItem = { paddingTop: 6, borderTop: "1px solid var(--border-light)" };
const detailHelpText = {
  marginBottom: 8,
  color: "var(--text-secondary)",
  fontSize: 13,
  lineHeight: 1.45,
};
const sectionSubhead = {
  marginTop: 16,
  fontSize: 13,
  fontWeight: 800,
  color: "var(--text-primary)",
};
const mutedSmall = { marginTop: 2, color: "var(--text-secondary)", fontSize: 12 };
const mutedFooter = { marginTop: 10, color: "var(--text-secondary)", fontSize: 12 };
const linkLike = { color: "var(--primary-color)", fontWeight: 700 };
const detailGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))",
  gap: 10,
};
const detailMetric = {
  padding: 12,
  borderRadius: 8,
  background: "var(--bg-color)",
  border: "1px solid var(--border-light)",
};
const detailMetricValue = { marginTop: 5, fontSize: 20, fontWeight: 800, color: "var(--text-primary)" };
const brandCompareRow = {
  width: "100%",
  padding: 12,
  borderRadius: 8,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)",
  color: "var(--text-primary)",
  cursor: "pointer",
  textAlign: "left",
};
const brandCompareMain = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};
const brandCompareStats = {
  display: "flex",
  gap: 16,
  flexWrap: "wrap",
  fontSize: 12,
  color: "var(--text-secondary)",
  fontWeight: 700,
};
const barTrack = {
  height: 6,
  marginTop: 10,
  borderRadius: 999,
  overflow: "hidden",
  background: "var(--border-light)",
};
const barFill = {
  height: "100%",
  borderRadius: 999,
  background: "var(--primary-color)",
};
const insightPanel = {
  marginTop: 12,
  padding: 12,
  borderRadius: 8,
  background: "var(--bg-color)",
  border: "1px solid var(--border-light)",
};
const insightTitle = { fontSize: 13, fontWeight: 800, color: "var(--text-primary)", marginBottom: 4 };
const filterBar = {
  display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
  marginBottom: 16, padding: "12px 16px", borderRadius: 12,
  background: "var(--surface-color)", border: "1px solid var(--border-color)",
};
const filterGroup = { display: "flex", alignItems: "center", gap: 10, minWidth: 0 };
const filterLabel = { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const filterSelect = {
  padding: "8px 28px 8px 10px", borderRadius: 6, fontSize: 13,
  background: "var(--panel-bg, var(--bg-color))", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", outline: "none",
  minWidth: 140, appearance: "menulist",
};
const filterInput = {
  padding: "8px 10px", borderRadius: 6, fontSize: 13,
  background: "var(--panel-bg, var(--bg-color))", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", outline: "none",
  minWidth: 130,
};
const tabStrip = {
  display: "flex", gap: 4, borderBottom: "1px solid var(--border-color)",
  marginBottom: 16, flexWrap: "wrap",
};
const tabBtn = {
  padding: "8px 16px", border: "none", background: "transparent",
  fontWeight: 600, fontSize: 14, cursor: "pointer",
  display: "inline-flex", alignItems: "center", gap: 6, marginBottom: -1,
};
const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
  gap: 12,
};
const tileStyle = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  borderRadius: 12, padding: 16, boxShadow: "var(--shadow-sm)",
};
const tileLabelRow = {
  display: "flex", alignItems: "center", gap: 8,
  color: "var(--text-secondary)", fontSize: 13, fontWeight: 600,
};
const tilePrimary = {
  fontSize: 28, fontWeight: 700, marginTop: 6, color: "var(--text-primary)",
};
const tileFooter = {
  fontSize: 12, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.5,
};
const cardStyle = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  borderRadius: 12, padding: 16,
};
const cardTitle = {
  margin: "0 0 12px", fontSize: 15,
  color: "var(--text-primary)",
};
const loadingBox = {
  padding: 40, textAlign: "center",
  color: "var(--text-secondary)",
  background: "var(--subtle-bg)",
  borderRadius: 12,
};
const errorBox = {
  padding: 16, borderRadius: 12,
  background: "var(--subtle-bg)",
  border: "1px solid var(--border-color)",
  display: "flex", alignItems: "flex-start", gap: 10,
  color: "var(--text-secondary)", fontSize: 14,
};
const refreshBtn = {
  marginTop: 6,
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 500,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const empty = {
  padding: 24, textAlign: "center",
  color: "var(--text-secondary)", fontSize: 14,
};
const emptyCell = {
  padding: 24, textAlign: "center",
  color: "var(--text-secondary)", fontSize: 14,
};
const th = {
  textAlign: "left", padding: "8px 10px", fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
};
const thRight = { ...th, textAlign: "right" };
const td = { padding: "8px 10px", fontSize: 13, color: "var(--text-primary)" };
const tdRight = { ...td, textAlign: "right" };
const trStyle = { borderTop: "1px solid var(--border-light)" };
const kvRow = {
  display: "flex", justifyContent: "space-between",
  padding: "6px 0", fontSize: 13,
  borderTop: "1px solid var(--border-light)",
};
const brandBadge = {
  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg-3)", color: "var(--primary-color)",
  textTransform: "uppercase", letterSpacing: 0.5,
};





