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

import { useEffect, useMemo, useState, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  Filter,
  Ticket,
  Calendar as CalendarIcon,
  Upload,
  Send,
  UserCheck,
  RefreshCw,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import CountBadge from "../../components/CountBadge";
import PatientPager from "../wellness/patients/PatientPager";
import TopScrollSync from "../../components/TopScrollSync";

// Rewrite /uploads/... → /api/uploads/... so production deployments (where the
// frontend SPA catches /uploads/* before it reaches the backend static mount)
// still serve boarding-pass files. Backward-compatible: absolute URLs and
// already-/api uploads pass through unchanged.
function normalizeUploadUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (url.startsWith("/uploads/")) {
    return `/api/uploads/${url.slice("/uploads/".length)}`;
  }
  return url;
}

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

const TABLE_MIN_WIDTH = 1340;

const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};

function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleString();
}

export default function WebCheckinQueue() {
  const notify = useNotify();
  const location = useLocation();
  const openedFromReports = useMemo(
    () => new URLSearchParams(location.search).get("source") === "reports",
    [location.search],
  );
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [upcomingOnly, setUpcomingOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState("");
  const [staff, setStaff] = useState([]);
  const [uploadingId, setUploadingId] = useState(null);
  const [deliveringId, setDeliveringId] = useState(null);
  const [reassigningId, setReassigningId] = useState(null);
  // Per-row hidden file input refs keyed by checkin id.
  const fileInputs = useRef({});
  const loadReqRef = useRef(0);

  const load = async ({ reset = false } = {}) => {
    const reqId = ++loadReqRef.current;
    if (reset) {
      setLoading(true);
      setRows([]);
      setTotal(0);
    } else {
      setLoading(true);
    }

    try {
      if (upcomingOnly) {
        const res = await fetchApi("/api/travel/webcheckins/upcoming");
        if (reqId !== loadReqRef.current) return;
        const list = Array.isArray(res?.webcheckins) ? res.webcheckins : [];
        setRows(list);
        setTotal(Number.isFinite(Number(res?.total)) ? Number(res.total) : list.length);
        return;
      }

      const batchSize = 200;
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      qs.set("limit", String(batchSize));
      qs.set("offset", String(0));

      const first = await fetchApi(`/api/travel/webcheckins?${qs.toString()}`);
      if (reqId !== loadReqRef.current) return;
      let list = Array.isArray(first?.webcheckins) ? first.webcheckins : [];
      const totalCount = Number.isFinite(Number(first?.total))
        ? Number(first.total)
        : list.length;

      if (totalCount > list.length) {
        const extra = [];
        for (let offset = batchSize; offset < totalCount; offset += batchSize) {
          const nextQs = new URLSearchParams(qs);
          nextQs.set("offset", String(offset));
          extra.push(fetchApi(`/api/travel/webcheckins?${nextQs.toString()}`));
        }
        const batches = await Promise.all(extra);
        if (reqId !== loadReqRef.current) return;
        list = list.concat(
          batches.flatMap((batch) =>
            Array.isArray(batch?.webcheckins) ? batch.webcheckins : [],
          ),
        );
      }

      setRows(list);
      setTotal(list.length);
    } catch (e) {
      if (e?.status !== 401 && reqId === loadReqRef.current) {
        setRows([]);
        setTotal(0);
      }
    } finally {
      if (reqId === loadReqRef.current) {
        setLoading(false);
      }
    }
  };

  // Staff list for the reassign dropdown — loaded once. /api/staff is
  // tolerant of every authed role and returns a small list per tenant.
  useEffect(() => {
    fetchApi("/api/staff", { silent: true })
      .then((data) => setStaff(Array.isArray(data) ? data : []))
      .catch(() => setStaff([]));
  }, []);

  useEffect(() => {
    load({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, upcomingOnly]);

  useEffect(() => {
    setPage(1);
  }, [status, upcomingOnly, pageSize]);

  useEffect(() => {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (page > pageCount) setPage(pageCount);
  }, [page, pageSize, total]);

  const visibleRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize]);

  // Filter changes keep the visible list in sync.
  const onStatusChange = (v) => {
    setStatus(v);
  };
  const onUpcomingToggle = (e) => {
    setUpcomingOnly(e.target.checked);
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
      const res = await fetch(
        `/api/travel/webcheckins/${id}/upload-boarding-pass`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${getAuthToken()}` },
          body: form,
        },
      );
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
        body: JSON.stringify({
          assignedAgentId: agentId ? parseInt(agentId, 10) : null,
        }),
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
  return (
    <div
      style={{
        padding: 24,
        width: "100%",
        maxWidth: 1480,
        margin: "0 auto",
        boxSizing: "border-box",
      }}
    >
      {openedFromReports ? (
        <Link to="/travel/reports" style={backLinkStyle}>
          <ArrowLeft size={15} aria-hidden /> Back to reports
        </Link>
      ) : null}
      <h1
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: 0,
          marginBottom: 4,
        }}
      >
        <Ticket size={28} aria-hidden /> Web Check-ins
        <CountBadge count={total} title={`${total.toLocaleString()} check-ins`} />
      </h1>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Flight check-in queue. Rows auto-spawn when itineraries with flight
        items are accepted; the scheduler cron handles reminders. Upload the
        boarding pass + mark delivered once the airline check-in is done.
      </p>

      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          background: "var(--surface-color)",
          padding: 12,
          borderRadius: 8,
          border: "1px solid var(--border-color)",
          marginBottom: 16,
        }}
      >
        <Filter
          size={16}
          aria-hidden
          style={{ color: "var(--text-secondary)" }}
        />
        <select
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
          disabled={upcomingOnly}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
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
      </div>

      {/* Table */}
      {loading ? (
        <div style={empty}>Loading&hellip;</div>
      ) : total === 0 ? (
        <div style={empty}>
          No web check-ins yet. They appear automatically when itineraries
          with flights are accepted.
        </div>
      ) : (
        <div
          data-testid="webcheckins-table-scroll"
          style={{
            background: "var(--surface-color)",
            borderRadius: 8,
            border: "1px solid var(--border-color)",
            maxWidth: "100%",
            minWidth: 0,
          }}
        >
          <TopScrollSync forceScrollbar scrollWidth={`${TABLE_MIN_WIDTH}px`}>
            <table
              className="stable-table webcheckins-table"
              style={{
                width: "100%",
                minWidth: `${TABLE_MIN_WIDTH}px`,
                borderCollapse: "collapse",
              }}
            >
              <colgroup>
                <col style={{ width: "116px" }} />
                <col style={{ width: "88px" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: "78px" }} />
                <col style={{ width: "178px" }} />
                <col style={{ width: "170px" }} />
                <col style={{ width: "150px" }} />
                <col style={{ width: "140px" }} />
                <col style={{ width: "330px" }} />
              </colgroup>
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
                {visibleRows.map((r) => {
                  const sc = STATUS_COLORS[r.status] || {
                    bg: "var(--subtle-bg)",
                    color: "var(--text-secondary)",
                  };
                  return (
                    <tr
                      key={r.id}
                      style={{ borderTop: "1px solid var(--border-light)" }}
                    >
                      <td style={td}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <CalendarIcon size={12} aria-hidden />
                          {fmtDateTime(r.windowOpenAt)}
                        </span>
                      </td>
                      <td style={td}>
                        <code>{r.pnr}</code>
                      </td>
                      <td style={td}>{r.flightNumber}</td>
                      <td style={td}>{r.airlineCode}</td>
                      <td style={td}>{fmtDateTime(r.departureAt)}</td>
                      <td style={td}>{r.passengerName}</td>
                      <td style={td}>
                        <span
                          data-testid={`status-badge-${r.id}`}
                          style={{
                            background: sc.bg,
                            color: sc.color,
                            padding: "4px 8px",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                            display: "inline-flex",
                            alignItems: "center",
                            height: 24,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td style={td}>
                        {r.boardingPassUrl ? (
                          <a
                            href={normalizeUploadUrl(r.boardingPassUrl)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              padding: "4px 8px",
                              borderRadius: 4,
                              border: "1px solid rgba(47,122,77,0.35)",
                              background: "rgba(47,122,77,0.10)",
                              color: "var(--text-primary)",
                              textDecoration: "none",
                              fontSize: 12,
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            View file
                          </a>
                        ) : (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              padding: "4px 8px",
                              borderRadius: 4,
                              border: "1px solid var(--border-color)",
                              background: "var(--subtle-bg)",
                              color: "var(--text-secondary)",
                              fontSize: 12,
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            Not uploaded
                          </span>
                        )}
                      </td>
                      <td style={td}>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            flexWrap: "nowrap",
                            alignItems: "center",
                            minWidth: 0,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => onUploadClick(r.id)}
                            style={actionBtn}
                            disabled={uploadingId === r.id}
                            aria-label={`Upload boarding pass for ${r.pnr}`}
                            title={
                              uploadingId === r.id
                                ? "Uploading…"
                                : "Upload boarding pass"
                            }
                          >
                            <Upload
                              size={12}
                              aria-hidden
                              style={{ marginRight: 3, flexShrink: 0 }}
                            />
                            <span style={{ whiteSpace: "nowrap" }}>
                              {uploadingId === r.id ? "Uploading…" : "Upload"}
                            </span>
                          </button>
                          <input
                            ref={(el) => {
                              fileInputs.current[r.id] = el;
                            }}
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
                            title={
                              r.deliveredAt
                                ? "Already delivered"
                                : deliveringId === r.id
                                  ? "Sending…"
                                  : "Send to passenger"
                            }
                          >
                            <Send
                              size={12}
                              aria-hidden
                              style={{ marginRight: 3, flexShrink: 0 }}
                            />
                            <span style={{ whiteSpace: "nowrap" }}>
                              {r.deliveredAt
                                ? "Delivered"
                                : deliveringId === r.id
                                  ? "Sending…"
                                  : "Deliver"}
                            </span>
                          </button>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              minWidth: 0,
                              flexShrink: 0,
                            }}
                          >
                            <UserCheck
                              size={12}
                              aria-hidden
                              style={{
                                color: "var(--text-secondary)",
                                flexShrink: 0,
                              }}
                            />
                            <select
                              value={r.assignedAgentId ?? ""}
                              onChange={(e) => onReassign(r, e.target.value)}
                              disabled={reassigningId === r.id}
                              aria-label={`Reassign agent for ${r.pnr}`}
                              style={miniSelectStyle}
                              title="Assign operator to handle this check-in"
                            >
                              <option value="">Unassigned</option>
                              {staff.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name || u.email}
                                </option>
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
          </TopScrollSync>
        </div>
      )}

      {!loading && total > 0 && (
        <PatientPager
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          isCustomPageSize={isCustomPageSize}
          setIsCustomPageSize={setIsCustomPageSize}
          customPageSize={customPageSize}
          setCustomPageSize={setCustomPageSize}
          label="web check-ins"
        />
      )}
    </div>
  );
}

const th = {
  padding: "10px 12px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  borderBottom: "1px solid var(--border-color)",
};

const td = {
  padding: "10px 12px",
  verticalAlign: "top",
  fontSize: 13,
  color: "var(--text-primary)",
  minWidth: 0,
};
const backLinkStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 12,
  padding: "6px 10px",
  borderRadius: 6,
  textDecoration: "none",
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontWeight: 600,
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
const miniSelectStyle = {
  padding: "3px 6px",
  borderRadius: 4,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 12,
  minWidth: 104,
  height: 28,
  flexShrink: 0,
};
const refreshBtn = {
  display: "inline-flex",
  alignItems: "center",
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13,
  cursor: "pointer",
};
const actionBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 12,
  cursor: "pointer",
  height: 28,
  minWidth: 75,
  whiteSpace: "nowrap",
  flexShrink: 0,
};
