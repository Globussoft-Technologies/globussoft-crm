// PRD_TRAVEL_BILLING G024 (FR-3.6.c) — settlement-timeline Gantt view.
//
// Read-only operator surface for the cash-in (TravelPaymentSchedule) +
// cash-out (TravelSupplierPayable) flow across a date range. Consumes
// GET /api/travel/settlements/timeline (backend route
// travel_settlement_timeline.js).
//
// Layout: simple SVG-rectangle Gantt — one row per item, sorted by
// dueDate. Each row's bar position is proportional to (dueDate - from) /
// (to - from); width is fixed (3% of axis) since each item is a one-day
// event, not a date span. Colour: green = settled (paid/waived/cancelled),
// amber = upcoming (pending/partial/scheduled), red = overdue (past
// dueDate AND still not settled).
//
// Filters: date range (from / to) + subBrand. Operator can click a bar to
// open a detail panel with the item's full payload.

import { useEffect, useMemo, useState } from "react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

function todayPlus(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function classifyStatus(item) {
  const settled = ["paid", "waived", "cancelled"];
  const dueMs = item.dueDate ? new Date(item.dueDate).getTime() : null;
  if (settled.includes(item.status)) return "settled";
  if (dueMs != null && dueMs < Date.now()) return "overdue";
  return "upcoming";
}

const STATUS_COLOURS = {
  settled: "#16a34a", // green
  upcoming: "#d97706", // amber
  overdue: "#dc2626", // red
};

const TYPE_LABELS = {
  invoice_payment_schedule: "Inflow",
  supplier_payable: "Outflow",
};

function formatMoney(n, currency) {
  if (n == null) return "—";
  const symbol = currency === "INR" ? "₹" : currency === "USD" ? "$" : "";
  return `${symbol}${Number(n).toLocaleString()}`;
}

export default function SettlementGantt() {
  const notify = useNotify();
  const [from, setFrom] = useState(todayPlus(-30));
  const [to, setTo] = useState(todayPlus(90));
  const [subBrand, setSubBrand] = useState("");
  const [data, setData] = useState({ items: [], summary: null });
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ from, to });
    if (subBrand) params.set("subBrand", subBrand);
    fetchApi(`/api/travel/settlements/timeline?${params.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setData({ items: res.items || [], summary: res.summary || null });
      })
      .catch((err) => {
        if (cancelled) return;
        notify.error?.(err?.message || "Failed to load timeline");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, subBrand, notify]);

  const range = useMemo(() => {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    return { fromMs, toMs, spanMs: Math.max(toMs - fromMs, 1) };
  }, [from, to]);

  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Settlement timeline</h1>
        <p style={{ color: "var(--text-secondary, #6b7280)", fontSize: 14 }}>
          Customer inflow + supplier outflow on a single Gantt. Green = settled, amber = upcoming, red = overdue.
        </p>
      </header>

      <section style={filterBar}>
        <label style={field}>
          <span style={fieldLabel}>From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={input}
          />
        </label>
        <label style={field}>
          <span style={fieldLabel}>To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={input}
          />
        </label>
        <label style={field}>
          <span style={fieldLabel}>Sub-brand</span>
          <select
            value={subBrand}
            onChange={(e) => setSubBrand(e.target.value)}
            style={input}
          >
            {SUB_BRANDS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </label>
      </section>

      {data.summary && (
        <section style={summaryBar}>
          <div style={summaryCell}>
            <div style={summaryLabel}>Expected inflow</div>
            <div style={{ ...summaryValue, color: STATUS_COLOURS.settled }}>
              {formatMoney(data.summary.totalInflowExpected, "INR")}
            </div>
          </div>
          <div style={summaryCell}>
            <div style={summaryLabel}>Expected outflow</div>
            <div style={{ ...summaryValue, color: STATUS_COLOURS.overdue }}>
              {formatMoney(data.summary.totalOutflowExpected, "INR")}
            </div>
          </div>
          <div style={summaryCell}>
            <div style={summaryLabel}>Net expected</div>
            <div style={summaryValue}>{formatMoney(data.summary.netExpected, "INR")}</div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 16, border: "1px solid var(--border-color, #e5e7eb)", borderRadius: 8 }}>
        {loading && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary, #6b7280)" }}>
            Loading timeline…
          </div>
        )}
        {!loading && data.items.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary, #6b7280)" }}>
            No settlements in this date range.
          </div>
        )}
        {!loading && data.items.length > 0 && (
          <div role="table" aria-label="Settlement timeline" style={{ minWidth: 0 }}>
            <div role="row" style={ganttHeader}>
              <span style={ganttHeaderLabel}>Type</span>
              <span style={ganttHeaderLabel}>Label</span>
              <span style={ganttHeaderLabel}>Amount</span>
              <span style={{ ...ganttHeaderLabel, flex: 3 }}>Timeline</span>
            </div>
            {data.items.map((item) => {
              const status = classifyStatus(item);
              const dueMs = item.dueDate ? new Date(item.dueDate).getTime() : null;
              const leftPct = dueMs != null
                ? Math.min(Math.max(((dueMs - range.fromMs) / range.spanMs) * 100, 0), 96)
                : 0;
              const widthPct = 4;
              return (
                <button
                  type="button"
                  role="row"
                  key={`${item.type}-${item.id}`}
                  onClick={() => setSelected(item)}
                  data-status={status}
                  data-type={item.type}
                  style={ganttRow}
                >
                  <span style={ganttCell}>{TYPE_LABELS[item.type] || item.type}</span>
                  <span style={{ ...ganttCell, fontWeight: 500 }}>{item.label}</span>
                  <span style={ganttCell}>{formatMoney(item.amount, item.currency)}</span>
                  <span style={{ ...ganttCell, flex: 3, position: "relative", height: 24 }}>
                    <span
                      style={{
                        position: "absolute",
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        top: 4,
                        bottom: 4,
                        background: STATUS_COLOURS[status],
                        borderRadius: 4,
                      }}
                      aria-label={`${item.label} — ${status}`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selected && (
        <aside style={detailPanel}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>Detail</h2>
            <button type="button" onClick={() => setSelected(null)} style={closeBtn}>×</button>
          </header>
          <dl style={detailGrid}>
            <dt style={detailLabel}>Type</dt>
            <dd>{TYPE_LABELS[selected.type] || selected.type}</dd>
            <dt style={detailLabel}>Label</dt>
            <dd>{selected.label}</dd>
            <dt style={detailLabel}>Amount</dt>
            <dd>{formatMoney(selected.amount, selected.currency)}</dd>
            <dt style={detailLabel}>Status</dt>
            <dd>{selected.status}</dd>
            <dt style={detailLabel}>Due date</dt>
            <dd>{selected.dueDate ? new Date(selected.dueDate).toLocaleDateString() : "—"}</dd>
            {selected.invoiceId && (
              <>
                <dt style={detailLabel}>Invoice ID</dt>
                <dd>{selected.invoiceId}</dd>
              </>
            )}
            {selected.supplierId && (
              <>
                <dt style={detailLabel}>Supplier ID</dt>
                <dd>{selected.supplierId}</dd>
              </>
            )}
          </dl>
        </aside>
      )}
    </div>
  );
}

const filterBar = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  alignItems: "flex-end",
  marginBottom: 12,
};
const field = { display: "flex", flexDirection: "column", gap: 4 };
const fieldLabel = { fontSize: 12, color: "var(--text-secondary, #6b7280)" };
const input = {
  padding: "6px 10px",
  border: "1px solid var(--border-color, #d1d5db)",
  borderRadius: 6,
  background: "var(--surface-bg, #fff)",
};
const summaryBar = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
  gap: 12,
  marginBottom: 12,
};
const summaryCell = {
  padding: 12,
  border: "1px solid var(--border-color, #e5e7eb)",
  borderRadius: 8,
};
const summaryLabel = { fontSize: 12, color: "var(--text-secondary, #6b7280)", marginBottom: 4 };
const summaryValue = { fontSize: 20, fontWeight: 600 };
const ganttHeader = {
  display: "flex",
  padding: "8px 12px",
  background: "var(--surface-subtle-bg, #f9fafb)",
  borderBottom: "1px solid var(--border-color, #e5e7eb)",
  fontWeight: 500,
  fontSize: 12,
  color: "var(--text-secondary, #6b7280)",
};
const ganttHeaderLabel = { flex: 1, textAlign: "left" };
const ganttRow = {
  display: "flex",
  padding: "6px 12px",
  borderBottom: "1px solid var(--border-color, #f3f4f6)",
  background: "transparent",
  border: "none",
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  alignItems: "center",
};
const ganttCell = { flex: 1, fontSize: 13, minWidth: 0 };
const detailPanel = {
  marginTop: 16,
  padding: 16,
  border: "1px solid var(--border-color, #e5e7eb)",
  borderRadius: 8,
  background: "var(--surface-bg, #fff)",
};
const closeBtn = {
  fontSize: 24,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 4,
  lineHeight: 1,
};
const detailGrid = {
  display: "grid",
  gridTemplateColumns: "160px 1fr",
  rowGap: 8,
};
const detailLabel = { fontSize: 13, color: "var(--text-secondary, #6b7280)" };
