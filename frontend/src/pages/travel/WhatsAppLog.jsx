// Travel CRM — WhatsApp dispatch log (Wati transport, Q9).
//
// Read-only operator surface listing every WhatsAppMessage row the travel
// vertical's watiClient (backend/services/watiClient.js) persists — OTPs,
// payment/journey reminders, itinerary share links, boarding-pass
// deliveries, greetings. Linked from the travel sidebar's "Customer comms"
// cluster; route is wrapped in <TravelOnly> in App.jsx so wellness/generic
// tenants never reach it (their WhatsApp surfaces are separate and
// untouched).
//
// Endpoints consumed (tenant-scoped via verifyToken):
//   GET /api/whatsapp/messages?status=&direction=&page=&limit= (existing)
//     → { messages: [{ id, to, from, body, direction, status,
//          templateName, errorMessage, createdAt,
//          contact?: { id, name, phone } }],
//         pagination: { total, page, limit, pages } }
//   DELETE /api/whatsapp/messages/dispatch-log (2026-07-08, ADMIN only)
//     → { success, deletedCount } — permanently clears every logged
//       dispatch with no linked chat thread (threadId=null). Live customer
//       chat conversations (WhatsAppMessage rows with a threadId) are never
//       touched by this action.
//
// Status semantics (watiClient contract):
//   QUEUED  — stub mode (WATI_API_ENDPOINT / WATI_ACCESS_TOKEN not set):
//             the dispatch was logged + persisted but NOT sent.
//   SENT    — Wati accepted the real send.
//   DELIVERED / READ — webhook receipt updates (post-webhook wire-in).
//   FAILED  — Wati rejected; errorMessage carries the reason.

import { useEffect, useState } from "react";
import { MessageSquare, RefreshCw, AlertTriangle, Trash2 } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "QUEUED", label: "Queued (stub)" },
  { value: "SENT", label: "Sent" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "READ", label: "Read" },
  { value: "FAILED", label: "Failed" },
];

const DIRECTION_FILTERS = [
  { value: "", label: "All directions" },
  { value: "OUTBOUND", label: "Outbound" },
  { value: "INBOUND", label: "Inbound" },
];

const PAGE_SIZE = 25;

const STATUS_BADGE_COLORS = {
  QUEUED: { background: "rgba(245, 158, 11, 0.18)", color: "var(--warning-color, #f59e0b)" },
  SENT: { background: "rgba(59, 130, 246, 0.18)", color: "#3b82f6" },
  DELIVERED: { background: "rgba(34, 197, 94, 0.18)", color: "var(--success-color, #22c55e)" },
  READ: { background: "rgba(34, 197, 94, 0.28)", color: "var(--success-color, #16a34a)" },
  FAILED: { background: "rgba(244, 63, 94, 0.18)", color: "var(--danger-color, #f43f5e)" },
};

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export default function TravelWhatsAppLog() {
  const notify = useNotify();
  const [messages, setMessages] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = () => {
    setLoading(true);
    setLoadError(false);
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (statusFilter) qs.set("status", statusFilter);
    if (directionFilter) qs.set("direction", directionFilter);
    fetchApi(`/api/whatsapp/messages?${qs.toString()}`)
      .then((d) => {
        const rows = Array.isArray(d?.messages) ? d.messages : [];
        setMessages(rows);
        setTotal(Number.isFinite(d?.pagination?.total) ? d.pagination.total : rows.length);
        setPages(Number.isFinite(d?.pagination?.pages) ? Math.max(1, d.pagination.pages) : 1);
      })
      .catch(() => {
        setMessages([]);
        setTotal(0);
        setPages(1);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, statusFilter, directionFilter]);

  // Filter changes reset to page 1 so the new filter never lands on a
  // now-out-of-range page.
  const onStatusChange = (v) => { setStatusFilter(v); setPage(1); };
  const onDirectionChange = (v) => { setDirectionFilter(v); setPage(1); };

  const anyQueued = messages.some((m) => m.status === "QUEUED");

  // "Clear dispatch log" (2026-07-08) — permanently deletes every logged
  // dispatch (OTPs, cron reminders, itinerary/boarding-pass pushes) for
  // this tenant. Backend scopes the delete to threadId=null rows only, so
  // messages that are part of a live customer chat thread are never
  // touched — see routes/whatsapp.js's DELETE /messages/dispatch-log.
  const [clearing, setClearing] = useState(false);
  const handleClearLog = async () => {
    const ok = await notify.confirm({
      title: "Clear dispatch log",
      message: "This permanently deletes all WhatsApp dispatch log entries for this tenant (OTPs, reminders, itinerary/boarding-pass pushes). This cannot be undone. Live chat conversations are not affected.",
      confirmText: "Clear log",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    setClearing(true);
    try {
      const res = await fetchApi("/api/whatsapp/messages/dispatch-log", { method: "DELETE" });
      notify.success(`Dispatch log cleared (${res?.deletedCount ?? 0} message${res?.deletedCount === 1 ? "" : "s"} deleted).`);
      setPage(1);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to clear dispatch log.");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1200,
        margin: "0 auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              fontSize: "1.75rem",
              fontWeight: 600,
            }}
          >
            <MessageSquare size={26} aria-hidden /> WhatsApp
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              marginTop: 4,
              fontSize: "0.9rem",
            }}
          >
            Travel WhatsApp dispatch log (Wati) — OTPs, reminders, itinerary
            shares and boarding-pass deliveries. {total.toLocaleString()}{" "}
            message{total === 1 ? "" : "s"}.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={load}
            style={secondaryBtn}
            aria-label="Refresh messages"
          >
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
          <button
            type="button"
            onClick={handleClearLog}
            disabled={clearing || total === 0}
            style={{
              ...secondaryBtn,
              color: "var(--danger-color, #f43f5e)",
              opacity: clearing || total === 0 ? 0.5 : 1,
            }}
            aria-label="Clear dispatch log"
          >
            <Trash2 size={14} aria-hidden /> {clearing ? "Clearing…" : "Clear dispatch log"}
          </button>
        </div>
      </header>

      {anyQueued && (
        <div
          className="glass"
          style={{
            padding: "10px 14px",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: "var(--text-secondary)",
          }}
          data-testid="stub-mode-hint"
        >
          <AlertTriangle size={15} aria-hidden style={{ color: "var(--warning-color, #f59e0b)", flexShrink: 0 }} />
          <span>
            <strong style={{ color: "var(--text-primary)" }}>Queued</strong>{" "}
            messages were logged in stub mode — they send for real once the
            Wati credentials (WATI_API_ENDPOINT + WATI_ACCESS_TOKEN) are set
            in the backend .env and the server restarts.
          </span>
        </div>
      )}

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
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={directionFilter}
          onChange={(e) => onDirectionChange(e.target.value)}
          style={selectStyle}
          aria-label="Filter by direction"
        >
          {DIRECTION_FILTERS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div className="glass" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={empty} role="status">Loading&hellip;</div>
        ) : loadError ? (
          <div style={{ ...empty, color: "var(--danger-color, #f43f5e)" }} role="alert">
            Failed to load WhatsApp messages. Use Refresh to retry.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <th style={th}>Time</th>
                <th style={th}>Direction</th>
                <th style={th}>To / From</th>
                <th style={th}>Contact</th>
                <th style={th}>Template</th>
                <th style={th}>Message</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr
                  key={m.id}
                  style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                >
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtDateTime(m.createdAt)}</td>
                  <td style={td}>
                    <span
                      style={{
                        ...statusBadge,
                        background: "rgba(255,255,255,0.08)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {m.direction === "INBOUND" ? "IN" : "OUT"}
                    </span>
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 13 }}>
                    {m.direction === "INBOUND" ? (m.from || "—") : (m.to || "—")}
                  </td>
                  <td style={td}>{m.contact?.name || "—"}</td>
                  <td style={td}>{m.templateName || "—"}</td>
                  <td
                    style={{
                      ...td,
                      maxWidth: 360,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={m.body || ""}
                  >
                    {m.body || "—"}
                    {m.status === "FAILED" && m.errorMessage && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--danger-color, #f43f5e)",
                          whiteSpace: "normal",
                        }}
                      >
                        {m.errorMessage}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        ...statusBadge,
                        ...(STATUS_BADGE_COLORS[m.status] || {
                          background: "rgba(148, 163, 184, 0.18)",
                          color: "var(--text-secondary)",
                        }),
                      }}
                    >
                      {m.status || "—"}
                    </span>
                  </td>
                </tr>
              ))}
              {messages.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--text-secondary)", padding: "1.5rem 1rem" }}>
                    <MessageSquare size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                    <div>No WhatsApp messages yet.</div>
                    <div style={{ fontSize: "0.85rem", marginTop: 6 }}>
                      Messages appear here when you share an itinerary,
                      request a microsite OTP, deliver a boarding pass, or
                      when reminder crons fire.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {!loading && !loadError && pages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 10,
            marginTop: 12,
            fontSize: 13,
            color: "var(--text-secondary)",
          }}
        >
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{ ...secondaryBtn, opacity: page <= 1 ? 0.5 : 1 }}
            aria-label="Previous page"
          >
            Prev
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page >= pages}
            style={{ ...secondaryBtn, opacity: page >= pages ? 0.5 : 1 }}
            aria-label="Next page"
          >
            Next
          </button>
        </div>
      )}
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
const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};
const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};
