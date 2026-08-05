// Travel CRM — Payables (cross-supplier A/P ledger) page.
//
// Lands at /travel/payables. Operator-facing cross-supplier view of every
// outstanding TravelSupplierPayable across the tenant. Distinct from
// SuppliersAdmin (slice 4, 1267abb6) which surfaces payables nested under
// each supplier row via an expand panel; this page is the month-end AP
// review surface where the operator wants ALL payables in one table.
//
// Backend contract (Arc 2 #903 slice 5, commit f7cfc364):
//   GET /api/travel/payables
//     ?status=pending|scheduled|paid|cancelled
//     ?supplierCategory=hotel|flight|transport|visa-consul|other
//     ?subBrand=tmc|rfu|travelstall|visasure
//     ?dueBefore=ISO date
//     ?dueAfter=ISO date
//     ?limit=N (default 100, clamped to 500)
//     ?offset=N
//   →
//   {
//     payables: [{
//       id, supplierId, supplierName, supplierCategory, subBrand,
//       poNumber, description, amount, currency, dueDate, status,
//       paidAt, daysUntilDue, createdAt
//     }],
//     total, limit, offset,
//     summary: { byStatus, totalPending, totalScheduled, totalPaid,
//                currencyBreakdown }
//   }
//
// Slice 6 (this commit) retires the previous per-supplier fan-out (which
// hit /api/travel/suppliers then issued one /payables GET per supplier
// and merged client-side) in favour of the single consolidated round-trip.
// The supplier-name client-side substring search is preserved — the
// endpoint doesn't filter by supplier name yet (future slice).
//
// Filter surface (now server-side via query params except supplier-name
// substring + the chip-driven status which also goes server-side):
//   - status chips → ?status= (pending | scheduled | paid | cancelled)
//   - subBrand     → ?subBrand=
//   - supplierCategory → ?supplierCategory=
//   - dueFrom/dueTo    → ?dueAfter / ?dueBefore
//   - supplier text search → client-side substring on payable.supplierName
//
// Defensive fallback: if /api/travel/payables returns 404 (endpoint not
// yet deployed on this stack), notify.error + render the empty state
// rather than crashing.

import { useEffect, useMemo, useRef, useState } from "react";
import { Wallet, Search } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SUB_BRAND_BG } from "../../utils/travelSubBrand";
import { formatMoney } from "../../utils/money";
import { useActiveSubBrand } from "../../utils/subBrand";
// Branding Wave 4 G102: per-sub-brand brand-kit lookup for active-chip tint.
import { useBrandKit, brandPrimaryColor } from "../../hooks/useBrandKit";

const STATUS_CHIPS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "scheduled", label: "Scheduled" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
];

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const SUPPLIER_CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "hotel", label: "Hotel" },
  { value: "flight", label: "Flight" },
  { value: "transport", label: "Transport" },
  { value: "visa-consul", label: "Visa / Consul" },
  { value: "other", label: "Other" },
];

// Status badge palette — mirrors PAYABLE_STATUS_STYLE in SuppliersAdmin.jsx
// slice 4 so the visual is consistent across the two surfaces.
const STATUS_BG = {
  pending: "rgba(245, 158, 11, 0.18)",
  scheduled: "rgba(59, 130, 246, 0.18)",
  paid: "rgba(34, 197, 94, 0.18)",
  cancelled: "rgba(148, 163, 184, 0.18)",
};
const STATUS_COLOR = {
  pending: "var(--warning-color, #f59e0b)",
  scheduled: "#3b82f6",
  paid: "var(--success-color, #22c55e)",
  cancelled: "var(--text-secondary)",
};

const PAGE_SIZE = 50;

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

// daysUntilDue styling — positive=neutral text, zero=warning (amber, "due
// today"), negative=red "N days overdue". Server-computed (slice 5);
// null falls through to "—".
function daysCellStyle(days) {
  if (days == null) return { color: "var(--text-secondary)" };
  if (days < 0) return { color: "var(--danger-color, #f43f5e)", fontWeight: 600 };
  if (days === 0) return { color: "var(--warning-color, #f59e0b)", fontWeight: 600 };
  return { color: "var(--text-primary)" };
}

function daysCellText(days) {
  if (days == null) return "—";
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return "Due today";
  return `${days} days`;
}

export default function Payables() {
  const notify = useNotify();
  // G102: branded primary accent from the active sub-brand's BrandKit (or
  // the CSS-var fallback when no kit configured).
  const { activeSubBrand } = useActiveSubBrand();
  const { brandKit } = useBrandKit(activeSubBrand);
  const primaryTint = brandPrimaryColor(brandKit);
  const [payables, setPayables] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({
    byStatus: {},
    totalPending: "0.00",
    totalScheduled: "0.00",
    totalPaid: "0.00",
    currencyBreakdown: {},
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Server-side filter state.
  const [status, setStatus] = useState("");
  const [subBrand, setSubBrand] = useState("");
  const [supplierCategory, setSupplierCategory] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const payablesRef = useRef([]);
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  // Client-side filter — supplier-name substring; the endpoint doesn't
  // accept this yet (future slice).
  const [supplierSearch, setSupplierSearch] = useState("");

  const load = ({ reset = false } = {}) => {
    if (reset) {
      offsetRef.current = 0;
      payablesRef.current = [];
      hasMoreRef.current = true;
      setPayables([]);
      setHasMore(true);
      setLoading(true);
      loadingRef.current = true;
    } else {
      if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return;
      setLoadingMore(true);
      loadingMoreRef.current = true;
    }

    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (subBrand) qs.set("subBrand", subBrand);
    if (supplierCategory) qs.set("supplierCategory", supplierCategory);
    if (dueFrom) qs.set("dueAfter", dueFrom);
    if (dueTo) qs.set("dueBefore", dueTo);
    qs.set("limit", String(PAGE_SIZE));
    const startOffset = reset ? 0 : offsetRef.current;
    qs.set("offset", String(startOffset));
    const url = `/api/travel/payables?${qs.toString()}`;
    fetchApi(url)
      .then((d) => {
        const rows = Array.isArray(d?.payables) ? d.payables : [];
        const nextRows = reset ? rows : [...payablesRef.current, ...rows];
        const totalRows = Number.isFinite(d?.total) ? d.total : nextRows.length;
        payablesRef.current = nextRows;
        offsetRef.current = startOffset + rows.length;
        hasMoreRef.current = offsetRef.current < totalRows;
        setPayables(nextRows);
        setTotal(totalRows);
        setHasMore(hasMoreRef.current);
        setSummary({
          byStatus: d?.summary?.byStatus || {},
          totalPending: d?.summary?.totalPending || "0.00",
          totalScheduled: d?.summary?.totalScheduled || "0.00",
          totalPaid: d?.summary?.totalPaid || "0.00",
          currencyBreakdown: d?.summary?.currencyBreakdown || {},
        });
      })
      .catch((err) => {
        if (reset) {
          payablesRef.current = [];
          offsetRef.current = 0;
          hasMoreRef.current = false;
          setPayables([]);
          setTotal(0);
          setHasMore(false);
          setSummary({
            byStatus: {},
            totalPending: "0.00",
            totalScheduled: "0.00",
            totalPaid: "0.00",
            currencyBreakdown: {},
          });
        }
        // Defensive fallback: 404 means the consolidated endpoint isn't on
        // this stack yet (e.g. demo not yet deployed past slice 5); surface
        // a friendly notify.error and leave the empty state showing rather
        // than crashing the page.
        if (err?.status === 404) {
          notify.error(
            "Cross-supplier payables endpoint not available on this server yet.",
          );
        } else if (err?.status >= 500) {
          notify.error("Failed to load payables — please try again.");
        }
      })
      .finally(() => {
        if (reset) {
          setLoading(false);
          loadingRef.current = false;
        } else {
          setLoadingMore(false);
          loadingMoreRef.current = false;
        }
      });
  };

  useEffect(() => {
    load({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, subBrand, supplierCategory, dueFrom, dueTo]);

  const handleTableScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 180) {
      load();
    }
  };

  // Client-side filtering — only the supplier-name substring narrows the
  // server-returned page further.
  const filtered = useMemo(() => {
    const term = supplierSearch.trim().toLowerCase();
    if (!term) return payables;
    return payables.filter((r) => {
      const name = (r.supplierName || "").toLowerCase();
      return name.includes(term);
    });
  }, [payables, supplierSearch]);

  const pendingCount = summary.byStatus?.pending || 0;
  const scheduledCount = summary.byStatus?.scheduled || 0;
  const paidCount = summary.byStatus?.paid || 0;
  const cancelledCount = summary.byStatus?.cancelled || 0;

  return (
    <div style={{ padding: 24, width: "100%", maxWidth: 1440, margin: "0 auto", boxSizing: "border-box", animation: "fadeIn 0.4s ease-out" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
          <Wallet size={26} aria-hidden /> All Payables
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
          Cross-supplier A/P ledger — every payable across every supplier in one view. {total.toLocaleString()} payable{total === 1 ? "" : "s"} match.
        </p>
      </header>

      {/* KPI cards — counts + amounts grouped by status, read from
          summary.byStatus + summary.total* returned by the server (which
          is authoritative — server aggregates over the current page). */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <KpiCard label="Pending" count={pendingCount} amount={summary.totalPending} color="var(--warning-color, #f59e0b)" />
        <KpiCard label="Scheduled" count={scheduledCount} amount={summary.totalScheduled} color="#3b82f6" />
        <KpiCard label="Paid" count={paidCount} amount={summary.totalPaid} color="var(--success-color, #22c55e)" />
        <KpiCard label="Cancelled" count={cancelledCount} amount="0.00" color="var(--text-secondary)" />
      </div>

      {/* Filter chrome — status chips + sub-brand + category + supplier
          search + date range. */}
      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div role="group" aria-label="Status filter chips" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUS_CHIPS.map((c) => {
            const active = status === c.value;
            return (
              <button
                key={c.value || "all"}
                type="button"
                onClick={() => setStatus(c.value)}
                aria-pressed={active}
                aria-label={`Filter by status: ${c.label}`}
                style={{
                  ...chipStyle,
                  background: active ? primaryTint : "var(--surface-color)",
                  color: active ? "#fff" : "var(--text-primary)",
                  borderColor: active ? primaryTint : "var(--border-color)",
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <select
          value={subBrand}
          onChange={(e) => setSubBrand(e.target.value)}
          style={inputStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value || "all"} value={s.value}>{s.label}</option>
          ))}
        </select>

        <select
          value={supplierCategory}
          onChange={(e) => setSupplierCategory(e.target.value)}
          style={inputStyle}
          aria-label="Filter by supplier category"
        >
          {SUPPLIER_CATEGORIES.map((c) => (
            <option key={c.value || "all"} value={c.value}>{c.label}</option>
          ))}
        </select>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Search size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
          <input
            type="text"
            placeholder="Search supplier"
            value={supplierSearch}
            onChange={(e) => setSupplierSearch(e.target.value)}
            style={inputStyle}
            aria-label="Search supplier"
          />
        </div>

        <input
          type="date"
          value={dueFrom}
          onChange={(e) => setDueFrom(e.target.value)}
          style={inputStyle}
          aria-label="Due date from"
        />
        <input
          type="date"
          value={dueTo}
          onChange={(e) => setDueTo(e.target.value)}
          style={inputStyle}
          aria-label="Due date to"
        />
      </div>

      {/* Table */}
      <div className="glass" onScroll={handleTableScroll} style={tableFrame}>
        {loading && payables.length === 0 ? (
          <div style={empty}>Loading&hellip;</div>
        ) : filtered.length === 0 ? (
          <div style={empty}>No payables found</div>
        ) : (
          <table style={{ width: "100%", minWidth: 1500, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Supplier</th>
                <th style={th}>PO #</th>
                <th style={th}>Description</th>
                <th style={th}>Amount</th>
                <th style={th}>Due date</th>
                <th style={th}>Status</th>
                <th style={th}>Days until due</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const statusKey = r.status || "pending";
                return (
                  <tr
                    key={`${r.supplierId}-${r.id}`}
                    data-testid={`payable-row-${r.id}`}
                    style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <td style={td}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <strong>{r.supplierName || "—"}</strong>
                        {r.subBrand && (
                          <span
                            style={{
                              ...brandBadge,
                              background: SUB_BRAND_BG[r.subBrand] || "rgba(255,255,255,0.08)",
                              alignSelf: "flex-start",
                            }}
                          >
                            {r.subBrand}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...td, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
                      {r.poNumber || "—"}
                    </td>
                    <td style={td}>{r.description || "—"}</td>
                    <td style={td}>
                      {r.amount != null
                        ? formatMoney(r.amount, { currency: r.currency || "INR" })
                        : "—"}
                    </td>
                    <td style={td}>{formatDate(r.dueDate)}</td>
                    <td style={td}>
                      <span
                        data-testid={`payable-status-${r.id}`}
                        style={{
                          ...statusBadge,
                          background: STATUS_BG[statusKey] || "rgba(255,255,255,0.08)",
                          color: STATUS_COLOR[statusKey] || "var(--text-primary)",
                          textTransform: "capitalize",
                        }}
                      >
                        {statusKey}
                      </span>
                    </td>
                    <td style={{ ...td, ...daysCellStyle(r.daysUntilDue) }}>{daysCellText(r.daysUntilDue)}</td>
                  </tr>
                );
              })}
            </tbody>
            {loadingMore && (
              <tfoot>
                <tr>
                  <td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--text-secondary)" }}>
                    Loading more&hellip;
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {/* Currency breakdown footer — read directly from
          summary.currencyBreakdown (server is authoritative). */}
      {Object.keys(summary.currencyBreakdown).length > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
          aria-label="Currency breakdown"
        >
          <strong style={{ color: "var(--text-primary)" }}>Currency breakdown (this page):</strong>
          {Object.entries(summary.currencyBreakdown).map(([cur, amt]) => (
            <span key={cur} data-currency={cur}>
              {cur}: {formatMoney(amt, { currency: cur })}
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {total > 0
            ? `Showing ${Math.min(payables.length, total).toLocaleString()} of ${total.toLocaleString()}${hasMore ? "" : " - end of table"}`
            : "No payables to show"}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, count, amount, color }) {
  return (
    <div
      className="glass"
      style={{ padding: 14 }}
      role="group"
      aria-label={`KPI ${label}`}
    >
      <div
        style={{
          fontSize: 12,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 4 }}>
        {count.toLocaleString()}
      </div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
        {formatMoney(amount, { currency: "INR" })}
      </div>
    </div>
  );
}

const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--modal-bg, var(--bg-color))",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
  position: "sticky",
  top: 0,
  zIndex: 3,
  fontWeight: 600,
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const tableFrame = {
  padding: 0,
  overflow: "auto",
  height: "calc(100vh - 360px)",
  minHeight: 520,
  maxHeight: 760,
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const inputStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13,
  minWidth: 140,
};
const chipStyle = {
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid var(--border-color)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};
const brandBadge = {
  display: "inline-block",
  padding: "2px 6px",
  borderRadius: 8,
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-primary)",
};
