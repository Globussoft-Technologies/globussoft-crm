// Travel CRM — MilestoneTracker page (Arc 2 #901 slice 7 frontend consumer).
//
// Operator-facing cross-invoice milestone summary. Consumes the
// /api/travel/payment-schedules/upcoming aggregate endpoint shipped in
// commit e4832fee (slice 7) — one round-trip returns:
//   - milestones[]   — per-row dueDate / expectedAmount / status /
//                      receivedAmount / daysUntilDue (server-computed) +
//                      parent-invoice context (invoiceNum / subBrand /
//                      contactId joined via Prisma include).
//   - total          — full-population count for pagination.
//   - limit / offset — echoed back (server clamps limit to [1, 500]).
//   - summary        — { byStatus, totalExpected, totalReceived,
//                        currencyBreakdown } computed across the returned
//                        PAGE (server-side note: pagers want current-page
//                        totals; full-population totals require limit=500).
//
// Filter surface mirrors the backend's query-param contract:
//   - status (pending|partial|paid|overdue|waived) — filter chip strip.
//   - within (positive int, presets 7|14|30|60|90 days) — window dropdown.
//   - subBrand (tmc|rfu|travelstall|visasure) — dropdown.
//   - overdueOnly (boolean) — toggle; overrides ?within when truthy.
//
// Decisions:
//   - Status chips include "All" + the 5 enum values. Clicking "All" clears
//     the ?status= param.
//   - The daysUntilDue cell rendering is the page's only conditional style
//     surface (positive=neutral, 0=warning, negative=red "N days overdue"
//     per the slice prompt).
//   - Pagination uses prev/next buttons (no jump-to-page) — simple operator
//     UX matching WebCheckinQueue.jsx pattern.
//   - Currency breakdown emits a footer row (NOT a card) because the
//     currency keys are dynamic (every tenant has different sets); a fixed
//     card grid would be wrong.
//   - Empty-state copy is "No upcoming milestones in this window." (period)
//     verbatim per slice prompt.
//   - PERMISSION-DENIED rendering: fetchApi auto-toasts 4xx/5xx; we still
//     surface notify.error to be explicit for 5xx so the operator gets
//     unambiguous feedback (the toast from fetchApi may be deduped within
//     1.5s if the user clicks twice fast).

import { useEffect, useState } from "react";
import { Bell, CalendarClock, AlertTriangle, CheckCircle2, Clock, Send } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { formatMoney } from "../../utils/money";

// Sub-brand selector — mirror of the four canonical travel sub-brands.
// Keep in lockstep with the backend's VALID_SUB_BRANDS list; mismatch
// surfaces as a silent empty result via the __none__ substitution.
const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

// Window presets — backend accepts any positive integer; the prompt named
// 7 / 14 / 30 / 60 / 90 day presets and we expose those (default 30, the
// backend's DEFAULT_WITHIN_DAYS).
const WINDOWS = [
  { value: 7, label: "Next 7 days" },
  { value: 14, label: "Next 14 days" },
  { value: 30, label: "Next 30 days" },
  { value: 60, label: "Next 60 days" },
  { value: 90, label: "Next 90 days" },
];

// Status enum — pending|partial|paid|overdue|waived (lower-case, matches
// backend assertValidScheduleStatus). The "All" chip clears the filter.
const STATUS_CHIPS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "partial", label: "Partial" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "waived", label: "Waived" },
];

// Status colours — mirror the lightweight badge palette used by
// InvoicesAdmin's STATUS_BG; we keep `var(--*-color, <hex>)` fallbacks so
// the page renders sanely against both light-mode + dark-mode tokens.
const STATUS_BG = {
  pending: "rgba(245, 158, 11, 0.18)",   // amber/yellow
  partial: "rgba(59, 130, 246, 0.18)",   // blue
  paid: "rgba(34, 197, 94, 0.18)",       // green
  overdue: "rgba(244, 63, 94, 0.20)",    // rose/red
  waived: "rgba(148, 163, 184, 0.18)",   // slate/grey
};
const STATUS_COLOR = {
  pending: "var(--warning-color, #f59e0b)",
  partial: "#3b82f6",
  paid: "var(--success-color, #22c55e)",
  overdue: "var(--danger-color, #f43f5e)",
  waived: "var(--text-secondary)",
};

const PAGE_SIZE = 50;

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

// daysUntilDue styling — positive=neutral text, zero=warning (amber, "due
// today"), negative=red "N days overdue". The SUT relies on a server-
// computed integer; null falls through to "—".
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

export default function MilestoneTracker() {
  const notify = useNotify();
  const [milestones, setMilestones] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ byStatus: {}, totalExpected: "0.00", totalReceived: "0.00", currencyBreakdown: {} });
  const [loading, setLoading] = useState(true);

  const [status, setStatus] = useState("");
  const [within, setWithin] = useState(30);
  const [subBrand, setSubBrand] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  // Per-row "Notify" in-flight + just-sent markers, keyed by milestone id.
  const [notifying, setNotifying] = useState({});
  const [notified, setNotified] = useState({});

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (subBrand) qs.set("subBrand", subBrand);
    if (overdueOnly) {
      qs.set("overdueOnly", "true");
    } else {
      qs.set("within", String(within));
    }
    qs.set("limit", String(PAGE_SIZE));
    qs.set("offset", String(offset));
    const url = `/api/travel/payment-schedules/upcoming?${qs.toString()}`;
    fetchApi(url)
      .then((d) => {
        const rows = Array.isArray(d?.milestones) ? d.milestones : [];
        setMilestones(rows);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setSummary({
          byStatus: d?.summary?.byStatus || {},
          totalExpected: d?.summary?.totalExpected || "0.00",
          totalReceived: d?.summary?.totalReceived || "0.00",
          currencyBreakdown: d?.summary?.currencyBreakdown || {},
        });
      })
      .catch((err) => {
        setMilestones([]);
        setTotal(0);
        setSummary({ byStatus: {}, totalExpected: "0.00", totalReceived: "0.00", currencyBreakdown: {} });
        // fetchApi auto-toasts; for 5xx surface an explicit notify.error so
        // the operator gets unambiguous feedback (dedup window means the
        // duplicate is dropped if the global toast already fired).
        if (err?.status >= 500) {
          notify.error("Failed to load milestones — please try again.");
        }
      })
      .finally(() => setLoading(false));
  };

  // Re-fetch whenever any filter or pagination input changes. Offset resets
  // to 0 on filter change so the page doesn't desync (next-page button is
  // the only thing that increments offset).
  useEffect(load, [status, within, subBrand, overdueOnly, offset]);

  // Filter changes other than offset reset offset to 0 so a /page=5 view
  // doesn't survive a status flip (which would return empty).
  useEffect(() => {
    setOffset(0);
  }, [status, within, subBrand, overdueOnly]);

  // Operator "Notify" — send an on-demand payment reminder to the customer
  // behind this milestone (email + WhatsApp, best-effort, server-side). Only
  // offered for not-yet-settled milestones (pending/partial/overdue).
  const notifyCustomer = (m) => {
    if (!m || notifying[m.id]) return;
    setNotifying((prev) => ({ ...prev, [m.id]: true }));
    fetchApi(`/api/travel/payment-schedules/${m.id}/remind`, { method: "POST" })
      .then((res) => {
        const channels = Array.isArray(res?.channels) ? res.channels : [];
        const who = res?.contactName || m.contactName || "the customer";
        if (res?.ok && channels.length > 0) {
          const linkNote = res?.payUrl ? " with a pay link" : "";
          notify.success(`Reminder${linkNote} sent to ${who} via ${channels.join(" + ")}.`);
          setNotified((prev) => ({ ...prev, [m.id]: true }));
        } else {
          // Recipient exists but no channel actually delivered (e.g. email not
          // configured + WhatsApp not linked).
          notify.info(`No channel could reach ${who} — check email/WhatsApp setup.`);
        }
      })
      .catch((err) => {
        // fetchApi auto-toasts; add an explicit message for the common 422
        // (no contact channel) so the operator knows WHY it didn't send.
        if (err?.status === 422) {
          notify.error("This customer has no email or phone on file to notify.");
        } else if (err?.status >= 500) {
          notify.error("Failed to send reminder — please try again.");
        }
      })
      .finally(() => {
        setNotifying((prev) => {
          const next = { ...prev };
          delete next[m.id];
          return next;
        });
      });
  };

  const handleNext = () => {
    if (offset + PAGE_SIZE >= total) return;
    setOffset(offset + PAGE_SIZE);
  };
  const handlePrev = () => {
    if (offset <= 0) return;
    setOffset(Math.max(0, offset - PAGE_SIZE));
  };

  const pendingCount = summary.byStatus.pending || 0;
  const partialCount = summary.byStatus.partial || 0;
  const paidCount = summary.byStatus.paid || 0;
  const overdueCount = summary.byStatus.overdue || 0;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", animation: "fadeIn 0.4s ease-out" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
          <CalendarClock size={26} aria-hidden /> Milestone Tracker
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
          Cross-invoice payment milestones — pending, partial, paid, overdue. {total.toLocaleString()} milestone{total === 1 ? "" : "s"} match.
        </p>
      </header>

      {/* KPI cards from summary.byStatus */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <KpiCard
          icon={<Clock size={18} />}
          label="Pending"
          value={pendingCount}
          color="var(--warning-color, #f59e0b)"
        />
        <KpiCard
          icon={<Bell size={18} />}
          label="Partial"
          value={partialCount}
          color="#3b82f6"
        />
        <KpiCard
          icon={<CheckCircle2 size={18} />}
          label="Paid"
          value={paidCount}
          color="var(--success-color, #22c55e)"
        />
        <KpiCard
          icon={<AlertTriangle size={18} />}
          label="Overdue"
          value={overdueCount}
          color="var(--danger-color, #f43f5e)"
        />
      </div>

      {/* Filter chrome — chips + dropdowns */}
      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 10,
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

        <select
          value={within}
          onChange={(e) => setWithin(parseInt(e.target.value, 10))}
          style={selectStyle}
          aria-label="Window (days from now)"
          disabled={overdueOnly}
          title={overdueOnly ? "Window disabled while 'Overdue only' is active" : "Window (days from now)"}
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>

        <select
          value={subBrand}
          onChange={(e) => setSubBrand(e.target.value)}
          style={selectStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value || "all"} value={s.value}>{s.label}</option>
          ))}
        </select>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--text-primary)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            aria-label="Overdue only"
          />
          Overdue only
        </label>
      </div>

      {/* Table */}
      <div className="glass" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : milestones.length === 0 ? (
          <div style={empty}>No upcoming milestones in this window.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Invoice #</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Customer</th>
                <th style={th}>Milestone #</th>
                <th style={th}>Due date</th>
                <th style={th}>Expected amount</th>
                <th style={th}>Status</th>
                <th style={th}>Days until due</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map((m) => (
                <tr key={m.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ ...td, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
                    {m.invoiceNum || `#${m.invoiceId}`}
                  </td>
                  <td style={td}>{m.subBrand || "—"}</td>
                  <td style={td}>
                    {m.contactName || m.contactPhone || m.contactEmail ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontWeight: 600 }}>{m.contactName || "Unnamed"}</span>
                        {(m.contactPhone || m.contactEmail) && (
                          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                            {m.contactPhone || m.contactEmail}
                          </span>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={td}>{m.milestoneOrder ?? "—"}</td>
                  <td style={td}>{formatDate(m.dueDate)}</td>
                  <td style={td}>
                    {formatMoney(m.expectedAmount, { currency: m.expectedCurrency || "INR" })}
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        ...statusBadge,
                        background: STATUS_BG[m.status] || "rgba(255,255,255,0.08)",
                        color: STATUS_COLOR[m.status] || "var(--text-primary)",
                      }}
                    >
                      {m.status || "—"}
                    </span>
                  </td>
                  <td style={{ ...td, ...daysCellStyle(m.daysUntilDue) }}>
                    {daysCellText(m.daysUntilDue)}
                  </td>
                  <td style={td}>
                    {m.status === "paid" || m.status === "waived" ? (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => notifyCustomer(m)}
                        disabled={Boolean(notifying[m.id])}
                        aria-label={`Notify customer for ${m.invoiceNum || `#${m.invoiceId}`} milestone ${m.milestoneOrder ?? ""}`}
                        title="Send a payment reminder to the customer (email + WhatsApp)"
                        style={{
                          ...notifyBtn,
                          opacity: notifying[m.id] ? 0.5 : 1,
                          cursor: notifying[m.id] ? "not-allowed" : "pointer",
                        }}
                      >
                        <Send size={13} />
                        {notifying[m.id] ? "Sending…" : notified[m.id] ? "Sent ✓" : "Notify"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Currency breakdown footer */}
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
          {total > 0 ? `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total.toLocaleString()}` : "No milestones to show"}
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
            disabled={offset + PAGE_SIZE >= total}
            style={offset + PAGE_SIZE >= total ? secondaryBtnDisabled : secondaryBtn}
            aria-label="Next page"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, color }) {
  return (
    <div
      className="glass"
      style={{
        padding: 14,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
      role="group"
      aria-label={`KPI ${label}`}
    >
      <div
        aria-hidden
        style={{
          width: 34,
          height: 34,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,255,255,0.06)",
          color,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
          {value.toLocaleString()}
        </div>
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
const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
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
const secondaryBtnDisabled = {
  ...secondaryBtn,
  opacity: 0.4,
  cursor: "not-allowed",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "capitalize",
};
const notifyBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 10px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  whiteSpace: "nowrap",
};
