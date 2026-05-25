// Travel CRM — Payables (cross-supplier A/P ledger) page.
//
// Lands at /travel/payables. Operator-facing cross-supplier view of every
// outstanding TravelSupplierPayable across the tenant. Distinct from
// SuppliersAdmin (slice 4, 1267abb6) which surfaces payables nested under
// each supplier row via an expand panel; this page is the month-end AP
// review surface where the operator wants ALL payables in one table.
//
// Backend contract (currently per-supplier only):
//   GET /api/travel/suppliers                  list (commit 192b8c1)
//   GET /api/travel/suppliers/:id/payables     per-supplier (commit 59336ab7)
//
// TODO #903 slice 6: replace per-supplier fan-out with a single
// cross-supplier endpoint GET /api/travel/payables that returns every
// payable (joined with supplier name/category/subBrand) in one round-trip.
// Until that endpoint lands, this page does the fan-out client-side —
// fetch the supplier list, then issue one GET per supplier for its
// payables, then merge + flatten + render. Inefficient (N+1 round-trips)
// but functional placeholder so the page is in place when the consolidating
// endpoint ships.
//
// Filters (client-side, applied AFTER the fan-out merge):
//   - status chips (pending | scheduled | paid | cancelled) + "All"
//   - supplier text search (case-insensitive substring against supplier name)
//   - due-date from / to (ISO date inputs)
//
// KPI cards:
//   - Pending / Scheduled / Paid / Cancelled — count + summed amount
//     (summed in display currency; mixed-currency totals are best-effort
//     because we don't FX-convert client-side — the figure represents the
//     payable's raw amount summed within its own currency token).
//
// Pagination: client-side (PAGE_SIZE = 50) since backend has no batch
// endpoint yet. Once slice 6 ships, swap to server-side pagination.

import { useEffect, useMemo, useState } from "react";
import { Wallet, Search } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SUB_BRAND_BG } from "../../utils/travelSubBrand";
import { formatMoney } from "../../utils/money";

const STATUS_CHIPS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "scheduled", label: "Scheduled" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
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

// daysUntilDue computed client-side from dueDate. Returns null when no
// dueDate is set (the column displays "—"). The route doesn't compute this
// server-side for payables (unlike payment-schedules' upcoming endpoint).
function computeDaysUntilDue(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const ms = target.getTime() - today.getTime();
  return Math.round(ms / 86400000);
}

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
  const [rows, setRows] = useState([]); // flattened: each row has supplier{} + payable fields
  const [loading, setLoading] = useState(true);

  // Filter state — all client-side since fan-out result is already in memory.
  const [status, setStatus] = useState("");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [offset, setOffset] = useState(0);

  // Fan-out load: GET supplier list, then GET payables per supplier.
  // TODO #903 slice 6: replace per-supplier fan-out with cross-supplier
  // endpoint GET /api/travel/payables. The single round-trip will return
  // each payable already joined with supplier.{name,category,subBrand}, so
  // this page can drop the per-supplier loop entirely and read directly
  // from the response payload.
  const load = async () => {
    setLoading(true);
    try {
      const supplierResp = await fetchApi("/api/travel/suppliers?includeInactive=1");
      const suppliers = Array.isArray(supplierResp?.suppliers) ? supplierResp.suppliers : [];

      const flattened = [];
      // Sequential rather than Promise.all to avoid a thundering herd of
      // requests on tenants with many suppliers. Pagination clamps this
      // back when the consolidating endpoint lands.
      for (const s of suppliers) {
        try {
          const payResp = await fetchApi(`/api/travel/suppliers/${s.id}/payables`);
          const payables = Array.isArray(payResp?.payables) ? payResp.payables : [];
          for (const p of payables) {
            flattened.push({
              ...p,
              supplier: {
                id: s.id,
                name: s.name,
                supplierCategory: s.supplierCategory,
                subBrand: s.subBrand,
              },
            });
          }
        } catch (err) {
          // Surface 5xx (or any non-2xx with a status >= 500) so the operator
          // knows ONE supplier's fan-out failed — but don't abort the whole
          // load; the rest of the suppliers' rows still render.
          if (err?.status >= 500) {
            notify.error(`Failed to load payables for ${s.name}`);
          }
          // 4xx silent (fetchApi already auto-toasts) — keep the page useful.
        }
      }
      setRows(flattened);
    } catch (err) {
      setRows([]);
      if (err?.status >= 500) {
        notify.error("Failed to load suppliers — please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset to page 0 whenever filters change so the operator doesn't end up
  // viewing an empty middle page after a narrowing filter.
  useEffect(() => {
    setOffset(0);
  }, [status, supplierSearch, dueFrom, dueTo]);

  // Client-side filtering — applied to the flattened row set produced by
  // the fan-out. Keep the filter logic pure so the SUT can be reasoned
  // about as input → output.
  const filtered = useMemo(() => {
    const term = supplierSearch.trim().toLowerCase();
    const fromTime = dueFrom ? new Date(dueFrom).getTime() : null;
    const toTime = dueTo ? new Date(dueTo).getTime() : null;
    return rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (term) {
        const name = (r.supplier?.name || "").toLowerCase();
        if (!name.includes(term)) return false;
      }
      if (fromTime != null) {
        if (!r.dueDate) return false;
        const dt = new Date(r.dueDate).getTime();
        if (Number.isNaN(dt) || dt < fromTime) return false;
      }
      if (toTime != null) {
        if (!r.dueDate) return false;
        const dt = new Date(r.dueDate).getTime();
        if (Number.isNaN(dt) || dt > toTime) return false;
      }
      return true;
    });
  }, [rows, status, supplierSearch, dueFrom, dueTo]);

  // KPI summary — derived from the filtered set so chip-narrowed view
  // surfaces the within-filter totals.
  const summary = useMemo(() => {
    const acc = {
      pending: { count: 0, amount: 0 },
      scheduled: { count: 0, amount: 0 },
      paid: { count: 0, amount: 0 },
      cancelled: { count: 0, amount: 0 },
    };
    for (const r of filtered) {
      const key = r.status || "pending";
      if (!acc[key]) continue;
      acc[key].count += 1;
      const n = Number(r.amount);
      if (Number.isFinite(n)) acc[key].amount += n;
    }
    return acc;
  }, [filtered]);

  const totalFiltered = filtered.length;
  const pageRows = filtered.slice(offset, offset + PAGE_SIZE);

  const handleNext = () => {
    if (offset + PAGE_SIZE >= totalFiltered) return;
    setOffset(offset + PAGE_SIZE);
  };
  const handlePrev = () => {
    if (offset <= 0) return;
    setOffset(Math.max(0, offset - PAGE_SIZE));
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", animation: "fadeIn 0.4s ease-out" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
          <Wallet size={26} aria-hidden /> All Payables
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
          Cross-supplier A/P ledger — every payable across every supplier in one view. {totalFiltered.toLocaleString()} payable{totalFiltered === 1 ? "" : "s"} match.
        </p>
      </header>

      {/* KPI cards — counts + amounts grouped by status, drawn from the
          filter-narrowed set. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <KpiCard label="Pending" count={summary.pending.count} amount={summary.pending.amount} color="var(--warning-color, #f59e0b)" />
        <KpiCard label="Scheduled" count={summary.scheduled.count} amount={summary.scheduled.amount} color="#3b82f6" />
        <KpiCard label="Paid" count={summary.paid.count} amount={summary.paid.amount} color="var(--success-color, #22c55e)" />
        <KpiCard label="Cancelled" count={summary.cancelled.count} amount={summary.cancelled.amount} color="var(--text-secondary)" />
      </div>

      {/* Filter chrome — status chips + supplier search + date range. */}
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
                  background: active ? "var(--primary-color, var(--accent-color))" : "var(--surface-color)",
                  color: active ? "#fff" : "var(--text-primary)",
                  borderColor: active ? "var(--primary-color, var(--accent-color))" : "var(--border-color)",
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

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
      <div className="glass" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : pageRows.length === 0 ? (
          <div style={empty}>No payables found</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
              {pageRows.map((r) => {
                const days = computeDaysUntilDue(r.dueDate);
                const statusKey = r.status || "pending";
                return (
                  <tr
                    key={`${r.supplier?.id}-${r.id}`}
                    data-testid={`payable-row-${r.id}`}
                    style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <td style={td}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <strong>{r.supplier?.name || "—"}</strong>
                        {r.supplier?.subBrand && (
                          <span
                            style={{
                              ...brandBadge,
                              background: SUB_BRAND_BG[r.supplier.subBrand] || "rgba(255,255,255,0.08)",
                              alignSelf: "flex-start",
                            }}
                          >
                            {r.supplier.subBrand}
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
                    <td style={{ ...td, ...daysCellStyle(days) }}>{daysCellText(days)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {totalFiltered > 0
            ? `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, totalFiltered)} of ${totalFiltered.toLocaleString()}`
            : "No payables to show"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={handlePrev}
            disabled={offset <= 0}
            style={offset <= 0 ? secondaryBtnDisabled : secondaryBtn}
            aria-label="Previous page"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={offset + PAGE_SIZE >= totalFiltered}
            style={offset + PAGE_SIZE >= totalFiltered ? secondaryBtnDisabled : secondaryBtn}
            aria-label="Next page"
          >
            Next
          </button>
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
  background: "var(--subtle-bg)",
  fontWeight: 600,
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
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
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const secondaryBtnDisabled = { ...secondaryBtn, opacity: 0.4, cursor: "not-allowed" };
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
