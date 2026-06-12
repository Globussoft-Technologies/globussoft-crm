// Travel CRM — Passport verification queue (slice C2, PRD_PASSPORT_OCR FR-6/FR-7).
//
// Sits on top of backend/routes/travel_passport.js (slice C2). The OCR
// client is STUB-mode while PC-1 vendor decision is pending; the
// canned extraction lets the operator UI ship + go green on CI ahead
// of the cred drop. Real-mode swap touches only the service client.
//
// Endpoints consumed (per row kind — see below):
//   GET    /api/travel/passport/verification-queue                          — pending list
//   POST   /api/travel/passport/participants/:id/passport-verify            — trip rows
//   DELETE /api/travel/passport/participants/:id/passport-extraction        — trip rows
//   POST   /api/travel/passport/customer-travellers/:id/passport-verify     — customer rows
//   DELETE /api/travel/passport/customer-travellers/:id/passport-extraction — customer rows
//
// The queue unions two passport sources: TMC TripParticipant rows
// (kind "trip") and unified customer-portal CustomerTraveller rows
// (kind "customer", any of the 4 sub-brands). Each row carries a `kind`
// discriminator; ids can collide across the two tables, so the UI keys on
// `${kind}:${id}` and routes verify/reject/clear to the kind-correct
// endpoint.
//
// Access: ADMIN+MANAGER only. Backend RBAC enforces the gate; this page
// renders a graceful "access denied" surface for USER role rather than
// crashing on the 403.

import { useEffect, useState } from "react";
import {
  BadgeCheck,
  XCircle,
  RefreshCw,
  Eye,
  Pencil,
  Trash2,
  ShieldAlert,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const REJECT_REASONS = [
  { value: "blurry_photo", label: "Blurry / unreadable photo" },
  { value: "wrong_document", label: "Wrong document (not a passport)" },
  { value: "expired_passport", label: "Passport expired" },
  { value: "name_mismatch", label: "Name / DOB mismatch with trip record" },
  { value: "other", label: "Other (operator note)" },
];

function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleString();
}

function fmtConfidence(c) {
  if (typeof c !== "number") return "—";
  return `${Math.round(c * 100)}%`;
}

// Rows come from two tables (TripParticipant vs CustomerTraveller) whose ids
// can collide, so identity + endpoint routing key on (kind, id).
function rowKey(row) {
  return `${row.kind || "trip"}:${row.id ?? row.participantId}`;
}
function rowBase(row) {
  const id = row.id ?? row.participantId;
  return row.kind === "customer"
    ? `/api/travel/passport/customer-travellers/${id}`
    : `/api/travel/passport/participants/${id}`;
}

const SUB_BRAND_LABEL = {
  tmc: "TMC",
  rfu: "RFU",
  travel_stall: "Travel Stall",
  visa_sure: "Visa Sure",
};

export default function PassportVerificationQueue() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState("blurry_photo");
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchApi("/api/travel/passport/verification-queue")
      .then((data) => {
        setRows(Array.isArray(data?.pending) ? data.pending : []);
        setLoading(false);
      })
      .catch((e) => {
        setError(e?.message || "Failed to load verification queue");
        setLoading(false);
      });
  };

  useEffect(() => { load(); }, []);

  const startEdit = (row) => {
    setEditingId(rowKey(row));
    setEditDraft({
      passportNumber: row.extraction?.passportNumber || "",
      dateOfExpiry: row.extraction?.dateOfExpiry || "",
      surname: row.extraction?.surname || "",
      givenNames: row.extraction?.givenNames || "",
      dateOfBirth: row.extraction?.dateOfBirth || "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft({});
  };

  const handleApprove = (row, withEdits = false) => {
    setBusyId(rowKey(row));
    const body = { approved: true };
    if (withEdits) body.editedFields = editDraft;
    fetchApi(`${rowBase(row)}/passport-verify`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then(() => {
        notify.success(`Passport approved for ${row.fullName}`);
        cancelEdit();
        load();
      })
      .catch((e) => notify.error(e?.message || "Failed to approve passport"))
      .finally(() => setBusyId(null));
  };

  const startReject = (row) => {
    setRejectingId(rowKey(row));
    setRejectReason("blurry_photo");
  };

  const cancelReject = () => {
    setRejectingId(null);
  };

  const confirmReject = (row) => {
    setBusyId(rowKey(row));
    fetchApi(`${rowBase(row)}/passport-verify`, {
      method: "POST",
      body: JSON.stringify({ approved: false, reason: rejectReason }),
    })
      .then(() => {
        notify.info(`Passport rejected for ${row.fullName}`);
        setRejectingId(null);
        load();
      })
      .catch((e) => notify.error(e?.message || "Failed to reject passport"))
      .finally(() => setBusyId(null));
  };

  const clearExtraction = (row) => {
    setBusyId(rowKey(row));
    fetchApi(`${rowBase(row)}/passport-extraction`, {
      method: "DELETE",
    })
      .then(() => {
        notify.info(`Extraction cleared for ${row.fullName} — re-upload now allowed`);
        load();
      })
      .catch((e) => notify.error(e?.message || "Failed to clear extraction"))
      .finally(() => setBusyId(null));
  };

  // ── Styles (theme variables) ──────────────────────────────────────

  const wrap = { padding: 24, maxWidth: 1280, margin: "0 auto" };
  const headerStyle = {
    display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
  };
  const subStyle = {
    color: "var(--text-secondary)", fontSize: 13, marginBottom: 24,
  };
  const card = {
    background: "var(--surface-color)",
    border: "1px solid var(--border-color)",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  };
  const fieldGrid = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
    gap: 8,
    marginTop: 12,
  };
  const fieldBox = {
    background: "var(--subtle-bg, var(--bg-color))",
    padding: "8px 10px",
    borderRadius: 4,
    fontSize: 13,
  };
  const labelStyle = {
    fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5,
  };
  const actionRow = {
    display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12,
  };
  const primaryBtn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "6px 12px",
    background: "var(--primary-color, var(--accent-color))",
    color: "white", border: "none", borderRadius: 4,
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
  const secondaryBtn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "6px 12px",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border-color)", borderRadius: 4,
    fontSize: 13, fontWeight: 500, cursor: "pointer",
  };
  const dangerBtn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "6px 12px",
    background: "transparent",
    color: "#A8323F",
    border: "1px solid #A8323F", borderRadius: 4,
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
  const editInput = {
    padding: "4px 8px",
    border: "1px solid var(--border-color)",
    borderRadius: 4, fontSize: 13, width: "100%",
    background: "var(--bg-color)", color: "var(--text-primary)",
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={wrap}>
      <div style={headerStyle}>
        <BadgeCheck size={22} aria-hidden style={{ color: "var(--primary-color, var(--accent-color))" }} />
        <h1 style={{ margin: 0, fontSize: 22 }}>Passport Verification</h1>
        <button
          type="button"
          onClick={load}
          style={{ ...secondaryBtn, marginLeft: "auto" }}
          aria-label="Refresh queue"
        >
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </div>
      <p style={subStyle}>
        Review OCR-extracted passport fields, correct any errors, then approve or reject.
        STUB mode: extractions returned by the canned vendor stub pending PC-1 decision.
      </p>

      {loading && <div style={card}>Loading verification queue&hellip;</div>}

      {error && (
        <div style={{
          ...card,
          background: "rgba(168,50,63,0.08)",
          borderColor: "#A8323F",
          color: "#A8323F",
        }}>
          <ShieldAlert size={14} aria-hidden style={{ marginRight: 4 }} />
          {error}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ ...card, textAlign: "center", color: "var(--text-secondary)" }}>
          No pending passport verifications.
        </div>
      )}

      {!loading && !error && rows.map((row) => {
        const ex = row.extraction || {};
        const key = rowKey(row);
        const isEditing = editingId === key;
        const isRejecting = rejectingId === key;
        const isBusy = busyId === key;

        return (
          <div key={key} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
                  {row.fullName}
                  {row.rejectedAt && (
                    <span style={{
                      marginLeft: 8, fontSize: 11, fontWeight: 600,
                      background: "rgba(168,50,63,0.12)",
                      color: "#A8323F", padding: "2px 6px", borderRadius: 4,
                    }}>
                      Previously rejected
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                  {row.kind === "customer" ? (
                    <>
                      Source: <strong>{SUB_BRAND_LABEL[row.subBrand] || row.subBrand || "Customer"}</strong>
                      {" · "}customer portal
                      {row.relationship ? ` · ${row.relationship}` : ""}
                    </>
                  ) : (
                    <>
                      Trip: <strong>{row.trip?.tripCode || "—"}</strong>
                      {row.trip?.destination ? ` · ${row.trip.destination}` : ""}
                    </>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                  Extracted {fmtDateTime(row.extractedAt)}
                  {row.provider ? ` · provider: ${row.provider}` : ""}
                  {row.confidence != null ? ` · confidence: ${fmtConfidence(row.confidence)}` : ""}
                </div>
              </div>
              {row.imageUrl && (
                <a
                  href={row.imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    ...secondaryBtn,
                    color: "var(--primary-color, var(--accent-color))",
                    textDecoration: "none",
                  }}
                  aria-label={`View passport image for ${row.fullName}`}
                >
                  <Eye size={14} aria-hidden /> View image
                </a>
              )}
            </div>

            {/* Manual-entry guidance when OCR couldn't extract the MRZ. */}
            {row.note && (
              <div style={{
                marginTop: 12, padding: "8px 12px", borderRadius: 4, fontSize: 13,
                background: "rgba(200,154,78,0.12)", color: "#9A6F2E",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <ShieldAlert size={14} aria-hidden /> {row.note}
              </div>
            )}

            {/* Extracted fields */}
            <div style={fieldGrid}>
              <div style={fieldBox}>
                <div style={labelStyle}>Passport #</div>
                {isEditing ? (
                  <input
                    style={editInput}
                    value={editDraft.passportNumber}
                    onChange={(e) => setEditDraft({ ...editDraft, passportNumber: e.target.value })}
                    aria-label="Edit passport number"
                  />
                ) : (
                  <div>{ex.passportNumber || "—"}</div>
                )}
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>Expiry</div>
                {isEditing ? (
                  <input
                    style={editInput}
                    value={editDraft.dateOfExpiry}
                    onChange={(e) => setEditDraft({ ...editDraft, dateOfExpiry: e.target.value })}
                    aria-label="Edit date of expiry"
                  />
                ) : (
                  <div>{ex.dateOfExpiry || "—"}</div>
                )}
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>Surname</div>
                {isEditing ? (
                  <input
                    style={editInput}
                    value={editDraft.surname}
                    onChange={(e) => setEditDraft({ ...editDraft, surname: e.target.value })}
                    aria-label="Edit surname"
                  />
                ) : (
                  <div>{ex.surname || "—"}</div>
                )}
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>Given names</div>
                {isEditing ? (
                  <input
                    style={editInput}
                    value={editDraft.givenNames}
                    onChange={(e) => setEditDraft({ ...editDraft, givenNames: e.target.value })}
                    aria-label="Edit given names"
                  />
                ) : (
                  <div>{ex.givenNames || "—"}</div>
                )}
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>DOB</div>
                {isEditing ? (
                  <input
                    style={editInput}
                    value={editDraft.dateOfBirth}
                    onChange={(e) => setEditDraft({ ...editDraft, dateOfBirth: e.target.value })}
                    aria-label="Edit date of birth"
                  />
                ) : (
                  <div>{ex.dateOfBirth || "—"}</div>
                )}
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>Nationality</div>
                <div>{ex.nationality || "—"}</div>
              </div>
            </div>

            {/* Reject reason picker */}
            {isRejecting && (
              <div style={{ marginTop: 12, padding: 12, background: "rgba(168,50,63,0.06)", borderRadius: 4 }}>
                <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                  Reason for rejection:
                </label>
                <select
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  style={{ ...editInput, maxWidth: 320 }}
                  aria-label="Reject reason"
                >
                  {REJECT_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <div style={{ ...actionRow, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => confirmReject(row)}
                    style={dangerBtn}
                    disabled={isBusy}
                  >
                    <XCircle size={14} aria-hidden /> Confirm reject
                  </button>
                  <button
                    type="button"
                    onClick={cancelReject}
                    style={secondaryBtn}
                    disabled={isBusy}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Action buttons */}
            {!isRejecting && (
              <div style={actionRow}>
                {!isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleApprove(row, false)}
                      style={primaryBtn}
                      disabled={isBusy}
                      aria-label={`Approve passport for ${row.fullName}`}
                    >
                      <BadgeCheck size={14} aria-hidden />
                      {isBusy ? "Working…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      style={secondaryBtn}
                      disabled={isBusy}
                      aria-label={`Edit extracted fields for ${row.fullName}`}
                    >
                      <Pencil size={14} aria-hidden /> Edit & approve
                    </button>
                    <button
                      type="button"
                      onClick={() => startReject(row)}
                      style={dangerBtn}
                      disabled={isBusy}
                      aria-label={`Reject passport for ${row.fullName}`}
                    >
                      <XCircle size={14} aria-hidden /> Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => clearExtraction(row)}
                      style={{ ...secondaryBtn, marginLeft: "auto" }}
                      disabled={isBusy}
                      aria-label={`Clear extraction for ${row.fullName}`}
                    >
                      <Trash2 size={14} aria-hidden /> Clear (re-upload)
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => handleApprove(row, true)}
                      style={primaryBtn}
                      disabled={isBusy}
                    >
                      <BadgeCheck size={14} aria-hidden />
                      Save & approve
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      style={secondaryBtn}
                      disabled={isBusy}
                    >
                      Cancel edit
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
