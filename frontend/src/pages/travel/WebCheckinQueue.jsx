// Travel CRM — WebCheckinQueue operator UI (PRD §4.6 + §7 row 20).
//
// Top-1 refreshed cron pick from docs/TRAVEL_CRM_GAP_AUDIT_2026-05-22.md.
//
// Backend has had 7-endpoint CRUD + auto-create-on-Itinerary.accept fan-out
// since commit 9898e87 (backend/routes/travel_webcheckin.js) — but the
// table the scheduler cron (backend/cron/webCheckinScheduler.js) scans was
// invisible to operators. This page is that visibility + the per-row
// actions the cron-pipeline can't perform autonomously (uploading the
// boarding pass, marking the agent delivered it, reassigning to a
// fallback agent).
//
// Endpoints consumed:
//   GET    /api/travel/webcheckins                         — paginated list
//   GET    /api/travel/webcheckins/upcoming                — windowOpenAt ≤48h
//   POST   /api/travel/webcheckins/:id/upload-boarding-pass — multipart (8MB)
//   POST   /api/travel/webcheckins/:id/deliver             — mark delivered
//   PATCH  /api/travel/webcheckins/:id                     — reassign agent
//   GET    /api/staff                                      — reassign dropdown
//
// No auto-poll — operators hit Refresh. Boarding-pass preview is a
// new-tab link to boardingPassUrl, not an inline iframe (lighter UI,
// PDF + image both handled by the browser).

import { useEffect, useState, useRef } from "react";
import { Filter, Ticket, Calendar as CalendarIcon, Upload, Send, UserCheck, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "reminded", label: "Reminded" },
  { value: "in-progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "fallback-agent", label: "Fallback agent" },
  { value: "failed", label: "Failed" },
];

// Status badge palette — schema enum is pending|reminded|in-progress|done|
// fallback-agent|failed (backend/routes/travel_webcheckin.js:VALID_STATUSES).
const STATUS_COLORS = {
  pending: { bg: "rgba(38,99,180,0.14)", color: "#1F5DAA" },
  reminded: { bg: "rgba(40,160,180,0.16)", color: "#1E7E8C" },
  "in-progress": { bg: "rgba(200,154,78,0.18)", color: "#9A6F2E" },
  done: { bg: "rgba(47,122,77,0.16)", color: "#2F7A4D" },
  "fallback-agent": { bg: "rgba(168,50,63,0.16)", color: "#A8323F" },
  failed: { bg: "rgba(168,50,63,0.18)", color: "#A8323F" },
};

const PAGE_SIZE = 50;

function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleString();
}

export default function WebCheckinQueue() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [upcomingOnly, setUpcomingOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [staff, setStaff] = useState([]);
  const [uploadingId, setUploadingId] = useState(null);
  const [deliveringId, setDeliveringId] = useState(null);
  const [reassigningId, setReassigningId] = useState(null);
  // Per-row hidden file input refs keyed by checkin id.
  const fileInputs = useRef({});

  const load = () => {
    setLoading(true);
    const url = upcomingOnly
      ? `/api/travel/webcheckins/upcoming`
      : (() => {
          const qs = new URLSearchParams();
          if (status) qs.set("status", status);
          qs.set("limit", String(PAGE_SIZE));
          qs.set("offset", String(offset));
          return `/api/travel/webcheckins?${qs.toString()}`;
        })();
    fetchApi(url)
      .then((res) => {
        const list = Array.isArray(res?.webcheckins) ? res.webcheckins : [];
        setRows(list);
        setTotal(Number.isFinite(res?.total) ? res.total : list.length);
      })
      .catch((e) => {
        // fetchApi already toasted; just zero the state.
        if (e?.status !== 401) {
          setRows([]);
          setTotal(0);
        }
      })
      .finally(() => setLoading(false));
  };

  // Staff list for the reassign dropdown — loaded once. /api/staff is
  // tolerant of every authed role and returns a small list per tenant.
  useEffect(() => {
    fetchApi("/api/staff", { silent: true })
      .then((data) => setStaff(Array.isArray(data) ? data : []))
      .catch(() => setStaff([]));
  }, []);

  useEffect(load, [status, upcomingOnly, offset]);

  // Filter changes reset offset to 0 so the user doesn't land mid-page
  // on a smaller filtered result-set.
  const onStatusChange = (v) => {
    setStatus(v);
    setOffset(0);
  };
  const onUpcomingToggle = (e) => {
    setUpcomingOnly(e.target.checked);
    setOffset(0);
  };

  // ─── Per-row actions ──────────────────────────────────────────────

  const onUploadClick = (id) => {
    const input = fileInputs.current[id];
    if (input) input.click();
  };

  const onUploadFileChange = async (id, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingId(id);
    try {
      const form = new FormData();
      form.append("file", file);
      // Multipart upload — fetchApi forces Content-Type: application/json
      // which would corrupt the multipart boundary, so use raw fetch +
      // manual Authorization header (same pattern as TripDetail.jsx).
      const res = await fetch(`/api/travel/webcheckins/${id}/upload-boarding-pass`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.error || `Upload failed (${res.status})`;
        notify.error(msg);
        return;
      }
      notify.success("Boarding pass uploaded.");
      load();
    } catch (err) {
      notify.error(err?.message || "Upload failed");
    } finally {
      setUploadingId(null);
      if (e.target) e.target.value = "";
    }
  };

  const onDeliver = async (row) => {
    const ok = await notify.confirm({
      title: "Deliver boarding pass?",
      message: `Send PNR ${row.pnr} (${row.passengerName}) to the passenger and mark delivered?`,
      confirmText: "Deliver",
    });
    if (!ok) return;
    setDeliveringId(row.id);
    try {
      await fetchApi(`/api/travel/webcheckins/${row.id}/deliver`, {
        method: "POST",
        silent: true,
      });
      notify.success("Marked delivered.");
      load();
    } catch (err) {
      // 409 NO_BOARDING_PASS is the most common — surface it as a clear toast.
      if (err?.code === "NO_BOARDING_PASS") {
        notify.error("Upload the boarding pass first, then deliver.");
      } else {
        notify.error(err?.message || "Failed to mark delivered");
      }
    } finally {
      setDeliveringId(null);
    }
  };

  const onReassign = async (row, agentId) => {
    setReassigningId(row.id);
    try {
      await fetchApi(`/api/travel/webcheckins/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedAgentId: agentId ? parseInt(agentId, 10) : null }),
      });
      notify.success(agentId ? "Reassigned." : "Unassigned.");
      load();
    } catch (err) {
      notify.error(err?.message || "Failed to reassign");
    } finally {
      setReassigningId(null);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────

  const showingPagination = !upcomingOnly && total > PAGE_SIZE;
  const fromIdx = total === 0 ? 0 : offset + 1;
  const toIdx = Math.min(offset + rows.length, total);

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, marginBottom: 4 }}>
        <Ticket size={28} aria-hidden /> Web Check-ins
      </h1>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Flight check-in queue. Rows auto-spawn when itineraries with flight
        items are accepted; the scheduler cron handles reminders. Upload the
        boarding pass + mark delivered once the airline check-in is done.
      </p>

      {/* Filter bar */}
      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
        background: "var(--surface-color)", padding: 12, borderRadius: 8,
        border: "1px solid var(--border-color)", marginBottom: 16,
      }}>
        <Filter size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
          disabled={upcomingOnly}
        >
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <label style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 13, color: "var(--text-primary)", cursor: "pointer",
        }}>
          <input
            type="checkbox"
            checked={upcomingOnly}
            onChange={onUpcomingToggle}
            aria-label="Show only upcoming (within 48h)"
          />
          Upcoming only (≤48h)
        </label>
        <button
          type="button"
          onClick={load}
          style={refreshBtn}
          aria-label="Refresh"
        >
          <RefreshCw size={14} aria-hidden style={{ marginRight: 4 }} /> Refresh
        </button>
        {showingPagination && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-secondary)" }}>
            {fromIdx}&ndash;{toIdx} of {total}
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "auto",
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : rows.length === 0 ? (
          <div style={empty}>
            No web check-ins yet. They appear automatically when itineraries with
            flights are accepted.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={th}>Window opens</th>
                <th style={th}>PNR</th>
                <th style={th}>Flight</th>
                <th style={th}>Airline</th>
                <th style={th}>Departure</th>
                <th style={th}>Passenger</th>
                <th style={th}>Status</th>
                <th style={th}>Boarding pass</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sc = STATUS_COLORS[r.status] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
                return (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={td}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <CalendarIcon size={12} aria-hidden />
                        {fmtDateTime(r.windowOpenAt)}
                      </span>
                    </td>
                    <td style={td}><code>{r.pnr}</code></td>
                    <td style={td}>{r.flightNumber}</td>
                    <td style={td}>{r.airlineCode}</td>
                    <td style={td}>{fmtDateTime(r.departureAt)}</td>
                    <td style={td}>{r.passengerName}</td>
                    <td style={td}>
                      <span
                        data-testid={`status-badge-${r.id}`}
                        style={{
                          background: sc.bg, color: sc.color,
                          padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                          textTransform: "uppercase", letterSpacing: 0.5,
                        }}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td style={td}>
                      {r.boardingPassUrl ? (
                        <a
                          href={r.boardingPassUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "var(--primary-color)", textDecoration: "none", fontWeight: 600 }}
                        >
                          View
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>—</span>
                      )}
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <button
                          type="button"
                          onClick={() => onUploadClick(r.id)}
                          style={actionBtn}
                          disabled={uploadingId === r.id}
                          aria-label={`Upload boarding pass for ${r.pnr}`}
                        >
                          <Upload size={12} aria-hidden style={{ marginRight: 4 }} />
                          {uploadingId === r.id ? "Uploading…" : "Upload"}
                        </button>
                        <input
                          ref={(el) => { fileInputs.current[r.id] = el; }}
                          type="file"
                          accept="application/pdf,image/*"
                          style={{ display: "none" }}
                          onChange={(e) => onUploadFileChange(r.id, e)}
                          aria-label={`Boarding pass file for ${r.pnr}`}
                        />
                        <button
                          type="button"
                          onClick={() => onDeliver(r)}
                          style={actionBtn}
                          disabled={deliveringId === r.id || !!r.deliveredAt}
                          aria-label={`Deliver boarding pass for ${r.pnr}`}
                        >
                          <Send size={12} aria-hidden style={{ marginRight: 4 }} />
                          {r.deliveredAt ? "Delivered" : (deliveringId === r.id ? "Sending…" : "Deliver")}
                        </button>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <UserCheck size={12} aria-hidden style={{ color: "var(--text-secondary)" }} />
                          <select
                            value={r.assignedAgentId ?? ""}
                            onChange={(e) => onReassign(r, e.target.value)}
                            disabled={reassigningId === r.id}
                            aria-label={`Reassign agent for ${r.pnr}`}
                            style={miniSelectStyle}
                          >
                            <option value="">Unassigned</option>
                            {staff.map((u) => (
                              <option key={u.id} value={u.id}>{u.name || u.email}</option>
                            ))}
                          </select>
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination — only when not in upcoming mode and total exceeds page. */}
      {showingPagination && (
        <div style={{
          display: "flex", justifyContent: "flex-end", alignItems: "center",
          gap: 8, marginTop: 12,
        }}>
          <button
            type="button"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            style={pagerBtn}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} aria-hidden /> Prev
          </button>
          <button
            type="button"
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + rows.length >= total}
            style={pagerBtn}
            aria-label="Next page"
          >
            Next <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  minWidth: 160, fontSize: 13,
};
const miniSelectStyle = {
  padding: "2px 6px", borderRadius: 4,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: 12, minWidth: 110,
};
const refreshBtn = {
  display: "inline-flex", alignItems: "center",
  padding: "6px 12px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: 13, cursor: "pointer",
};
const actionBtn = {
  display: "inline-flex", alignItems: "center",
  padding: "4px 8px", borderRadius: 4,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: 12, cursor: "pointer",
};
const pagerBtn = {
  display: "inline-flex", alignItems: "center", gap: 2,
  padding: "6px 12px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: 13, cursor: "pointer",
};
const empty = {
  padding: 32, textAlign: "center",
  color: "var(--text-secondary)", fontSize: 14,
};
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)", whiteSpace: "nowrap",
};
const td = {
  padding: "10px 12px", fontSize: 14,
  color: "var(--text-primary)", verticalAlign: "middle",
};
