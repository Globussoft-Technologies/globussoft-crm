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
import {
  AlertCircle, BarChart3, Globe, MapPin, RefreshCw, School, Star, TrendingUp, Download,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const TABS = [
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
  return d.toISOString().split("T")[0];
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
  const [tab, setTab] = useState("tmc");
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
    const q = new URLSearchParams({ tab });
    if (dateParams.from) q.set("from", dateParams.from);
    if (dateParams.to) q.set("to", dateParams.to);
    fetch(`/api/travel/reports/export-pdf?${q.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => { if (!res.ok) throw new Error("PDF export failed"); return res.blob(); })
      .then((blob) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `travel-${tab}-report.pdf`;
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
          <Download size={14} /> {exporting ? "Preparing…" : "Download PDF"}
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

// ─── TMC tab ───────────────────────────────────────────────────────

function TmcTab({ dateParams }) {
  const { data, loading, error, reload } = useReport("/api/travel/reports/tmc", dateParams);

  return (
    <StateShell loading={loading} error={error} reload={reload}>
      {data && (
        <div style={gridStyle}>
          <Tile
            icon={MapPin}
            label="Total revenue (active trips)"
            primary={`₹${Number(data.revenue.total).toLocaleString("en-IN")}`}
            footer={`${data.trips.active} active trips · ${data.trips.total} all-time`}
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
          />

          <Card title="Trip status">
            <KeyValueList obj={data.trips.byStatus} formatter={(v) => String(v)} empty="No trips yet." />
          </Card>

          <QuoteFunnelCard quotes={data.quotes} />

          <Card title="Deal funnel">
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
          </Card>

          <Card title="Diagnostics by classification">
            <KeyValueList obj={data.diagnostics.byClassification} formatter={(v) => String(v)} empty="No diagnostics yet." />
          </Card>

          <Card title={`Top destinations by revenue (top ${Math.min(10, data.revenue.topDestinations.length)})`} wide>
            {data.revenue.topDestinations.length === 0 ? (
              <div style={empty}>No revenue recorded yet.</div>
            ) : (
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

  return (
    <StateShell loading={loading} error={error} reload={reload}>
      {data && (
        <div style={gridStyle}>
          <Tile
            icon={TrendingUp}
            label="Itineraries"
            primary={data.itineraries.total}
            footer={
              data.customers.unique > 0
                ? `${data.customers.unique} customers · ${data.customers.repeat} repeat (${data.customers.repeatRatePct}%)`
                : "no customers yet"
            }
          />
          <Tile
            icon={Star}
            label="Diagnostic tier mix"
            primary={Object.values(data.diagnostics.byTier).reduce((a, b) => a + b, 0)}
            footer={byKeyInline(data.diagnostics.byTier) || "no diagnostics yet"}
          />

          <Card title="Itinerary revenue by status">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr><th style={th}>Status</th><th style={thRight}>Count</th><th style={thRight}>Revenue</th></tr>
              </thead>
              <tbody>
                {Object.keys(data.itineraries.byStatus).length === 0 && (
                  <tr><td colSpan="3" style={emptyCell}>No itineraries yet.</td></tr>
                )}
                {Object.entries(data.itineraries.byStatus).map(([status, count]) => (
                  <tr key={status} style={trStyle}>
                    <td style={td}>{status}</td>
                    <td style={tdRight}>{count}</td>
                    <td style={tdRight}>₹{Number(data.itineraries.amountByStatus[status] || 0).toLocaleString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <QuoteFunnelCard quotes={data.quotes} />

          <Card title="Deal funnel">
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
          </Card>

          <Card title="Diagnostics by classification" wide>
            <KeyValueList obj={data.diagnostics.byClassification} formatter={(v) => String(v)} empty="No diagnostics yet." />
          </Card>
        </div>
      )}
    </StateShell>
  );
}

// ─── Cross-brand tab ───────────────────────────────────────────────

function CrossBrandTab({ dateParams }) {
  const { data, loading, error, reload } = useReport("/api/travel/reports/cross-brand", dateParams);

  return (
    <StateShell loading={loading} error={error} reload={reload}>
      {data && (
        <Card title="Won-revenue + conversion by sub-brand" wide>
          {Object.keys(data.subBrands).length === 0 ? (
            <div style={empty}>No deal activity across any sub-brand yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={th}>Sub-brand</th>
                  <th style={thRight}>Quotes</th>
                  <th style={thRight}>Accepted</th>
                  <th style={thRight}>Quote revenue</th>
                  <th style={thRight}>Quote conv. %</th>
                  <th style={thRight}>Won (deals)</th>
                  <th style={thRight}>Diagnostics</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.subBrands).map(([brand, m]) => (
                  <tr key={brand} style={trStyle}>
                    <td style={td}><span style={brandBadge}>{brand}</span></td>
                    <td style={tdRight}>{m.quotesTotal ?? 0}</td>
                    <td style={tdRight}>{m.quotesAccepted ?? 0}</td>
                    <td style={tdRight}>₹{Number(m.quoteRevenue || 0).toLocaleString("en-IN")}</td>
                    <td style={tdRight}>{m.quoteConversionPct ?? 0}%</td>
                    <td style={tdRight}>{m.won}</td>
                    <td style={tdRight}>{m.diagnostics}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </StateShell>
  );
}

// ─── Building blocks ────────────────────────────────────────────────

function Tile({ icon: Icon, label, primary, footer }) {
  return (
    <div style={tileStyle}>
      <div style={tileLabelRow}>
        <Icon size={16} aria-hidden /> {label}
      </div>
      <div style={tilePrimary}>{primary ?? 0}</div>
      {footer && <div style={tileFooter}>{footer}</div>}
    </div>
  );
}

function Card({ title, children, wide }) {
  return (
    <section style={{ ...cardStyle, gridColumn: wide ? "1 / -1" : undefined }}>
      <h2 style={cardTitle}>{title}</h2>
      {children}
    </section>
  );
}

// The real travel sales funnel — TravelQuote by status (count + ₹). Travel
// never creates generic Deal rows, so the legacy "Deal funnel" was always
// empty; this surfaces the actual quote pipeline that DOES have data.
function QuoteFunnelCard({ quotes }) {
  const byStatus = (quotes && quotes.byStatus) || {};
  const amt = (quotes && quotes.amountByStatus) || {};
  const entries = Object.entries(byStatus);
  return (
    <Card title="Quote pipeline">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr><th style={th}>Status</th><th style={thRight}>Count</th><th style={thRight}>Amount</th></tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr><td colSpan="3" style={emptyCell}>No quotes yet.</td></tr>
          )}
          {entries.map(([status, count]) => (
            <tr key={status} style={trStyle}>
              <td style={td}>{status}</td>
              <td style={tdRight}>{count}</td>
              <td style={tdRight}>₹{Number(amt[status] || 0).toLocaleString("en-IN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function KeyValueList({ obj, formatter, empty: emptyText }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) return <div style={empty}>{emptyText}</div>;
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {entries.map(([k, v]) => (
        <li key={k} style={kvRow}>
          <span>{k}</span>
          <span style={{ fontWeight: 600 }}>{formatter(v)}</span>
        </li>
      ))}
    </ul>
  );
}

function byKeyInline(obj) {
  if (!obj || Object.keys(obj).length === 0) return null;
  const entries = Object.entries(obj).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

// ─── Styles ─────────────────────────────────────────────────────────

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

