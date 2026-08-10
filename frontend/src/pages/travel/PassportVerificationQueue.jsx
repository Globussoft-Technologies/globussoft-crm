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

import { useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  XCircle,
  RefreshCw,
  Eye,
  Pencil,
  Trash2,
  ShieldAlert,
  Upload,
  List,
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

function candidateLabel(candidate) {
  if (!candidate) return "Existing passport record";
  const name = candidate.fullName || candidate.contact?.name || "Existing passport record";
  const source = candidate.sourceType ? ` (${candidate.sourceType})` : "";
  return `${name}${source}`;
}

function matchLabel(candidate) {
  if (candidate?.matchedBy === "name_dob_phone") return "name + DOB + phone";
  return "passport number";
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

function PassportVerificationTab() {
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

  const wrap = { padding: 24, width: "100%", maxWidth: 1480, margin: "0 auto", boxSizing: "border-box" };
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

            {Array.isArray(row.identityCandidates) && row.identityCandidates.length > 0 && (
              <div style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 6,
                fontSize: 13,
                background: "rgba(200,154,78,0.12)",
                border: "1px solid rgba(200,154,78,0.35)",
                color: "#8A5F1D",
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Possible existing master/client match
                </div>
                {row.identityCandidates.slice(0, 3).map((candidate) => (
                  <div key={`${candidate.sourceType}:${candidate.sourceId}`}>
                    {candidateLabel(candidate)} matched by {matchLabel(candidate)}
                    {candidate.contact?.id ? ` - Contact #${candidate.contact.id}` : ""}
                  </div>
                ))}
                <div style={{ marginTop: 4, color: "var(--text-secondary)" }}>
                  Check before approving so we do not create or keep duplicate passport records.
                </div>
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


function PassportListTab() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({
    total: 0,
    page: 1,
    pageSize: 3,
    totalPages: 1,
    hasPrev: false,
    hasNext: false,
  });
  const [archiveFile, setArchiveFile] = useState(null);
  const [directFiles, setDirectFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [assigningId, setAssigningId] = useState(null);
  const [contactSearch, setContactSearch] = useState('');
  const [contactOptions, setContactOptions] = useState([]);
  const [contactLoading, setContactLoading] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState('');
  const [selectedContactLabel, setSelectedContactLabel] = useState('');
  const [assignRelationship, setAssignRelationship] = useState('self');
  const [assigningBusy, setAssigningBusy] = useState(false);
  const listRef = useRef(null);
  const sentinelRef = useRef(null);
  const loadingMoreRef = useRef(false);

  const load = (
    nextPage = page,
    nextSearch = search,
    nextStatus = statusFilter,
    nextSource = sourceFilter,
    mode = nextPage === 1 ? 'replace' : 'append',
  ) => {
    const isAppend = mode === 'append' && nextPage > 1;
    if (isAppend) setLoadingMore(true);
    else setLoading(true);
    loadingMoreRef.current = isAppend;
    setError(null);
    const params = new URLSearchParams({
      page: String(nextPage),
      pageSize: '3',
      q: nextSearch,
      status: nextStatus,
      source: nextSource,
    });
    fetchApi(`/api/travel/passport/passport-list?${params.toString()}`)
      .then((data) => {
        const nextRows = Array.isArray(data?.passports) ? data.passports : [];
        setRows((current) => (isAppend ? [...current, ...nextRows] : nextRows));
        setMeta({
          total: Number(data?.total) || 0,
          page: Number(data?.page) || nextPage,
          pageSize: Number(data?.pageSize) || 3,
          totalPages: Number(data?.totalPages) || 1,
          hasPrev: Boolean(data?.hasPrev),
          hasNext: Boolean(data?.hasNext),
        });
      })
      .catch((e) => {
        setError(e?.message || 'Failed to load passport list');
      })
      .finally(() => {
        loadingMoreRef.current = false;
        if (isAppend) setLoadingMore(false);
        else setLoading(false);
      });
  };

  useEffect(() => {
    load(page, search, statusFilter, sourceFilter, page === 1 ? 'replace' : 'append');
  }, [page, search, statusFilter, sourceFilter]);

  useEffect(() => {
    if (!listRef.current || loading || loadingMore || !meta.hasNext || rows.length === 0) return;
    const listEl = listRef.current;
    if (listEl.clientHeight <= 0) return;
    if (listEl.scrollHeight <= listEl.clientHeight + 24) {
      setPage((current) => current + 1);
    }
  }, [rows, meta.hasNext, loading, loadingMore]);

  useEffect(() => {
    if (!listRef.current || !sentinelRef.current) return undefined;
    if (typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (loading || loadingMoreRef.current || !meta.hasNext) return;
        setPage((current) => current + 1);
      },
      {
        root: listRef.current,
        rootMargin: '0px 0px 160px 0px',
        threshold: 0.1,
      },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [meta.hasNext, loading, rows.length]);

  const resetAndReload = (next = {}) => {
    const nextSearch = next.search ?? search;
    const nextStatus = next.statusFilter ?? statusFilter;
    const nextSource = next.sourceFilter ?? sourceFilter;
    setRows([]);
    setPage(1);
    load(1, nextSearch, nextStatus, nextSource, 'replace');
  };

  const searchContacts = async (query = '') => {
    setContactLoading(true);
    try {
      const params = new URLSearchParams({ q: query, limit: '10' });
      const data = await fetchApi(`/api/travel/passport/contact-search?${params.toString()}`);
      setContactOptions(Array.isArray(data?.contacts) ? data.contacts : []);
    } catch (e) {
      const msg = String(e?.message || '');
      if (/endpoint not found/i.test(msg) || /404/.test(msg)) {
        try {
          const fallback = await fetchApi('/api/contacts?fields=summary&limit=200');
          const list = Array.isArray(fallback) ? fallback : [];
          const q = String(query || '').trim().toLowerCase();
          const filtered = list
            .filter((contact) => {
              if (!q) return true;
              const hay = [contact?.name, contact?.email, contact?.phone].filter(Boolean).join(' ').toLowerCase();
              return hay.includes(q);
            })
            .slice(0, 10)
            .map((contact) => ({
              id: contact.id,
              name: contact.name,
              email: contact.email,
              phone: contact.phone,
              subBrand: contact.subBrand,
            }));
          setContactOptions(filtered);
          return;
        } catch (fallbackErr) {
          notify.error(fallbackErr?.message || 'Failed to load customers');
        }
      } else {
        notify.error(e?.message || 'Failed to search contacts');
      }
      setContactOptions([]);
    } finally {
      setContactLoading(false);
    }
  };

  const openAssignPanel = (row) => {
    setAssigningId(`${row.kind}:${row.id}`);
    setContactSearch('');
    setSelectedContactId('');
    setSelectedContactLabel('');
    setSelectedContactLabel('');
    setAssignRelationship('self');
    setContactOptions([]);
    searchContacts('');
  };

  const closeAssignPanel = () => {
    setAssigningId(null);
    setContactSearch('');
    setSelectedContactId('');
    setAssignRelationship('self');
    setContactOptions([]);
  };

  const assignContact = async (row) => {
    if (!selectedContactId) {
      notify.error('Select a contact first.');
      return;
    }
    setAssigningBusy(true);
    try {
      const result = await fetchApi(`/api/travel/passport/customer-travellers/${row.id}/assign-contact`, {
        method: 'POST',
        body: JSON.stringify({
          contactId: Number(selectedContactId),
          relationship: assignRelationship,
        }),
      });
      notify.success(`Passport assigned to ${result?.contactName || 'contact'}`);
      closeAssignPanel();
      resetAndReload();
    } catch (e) {
      notify.error(e?.message || 'Failed to assign passport');
    } finally {
      setAssigningBusy(false);
    }
  };

  const pickArchive = (e) => {
    const next = e.target.files?.[0] || null;
    setArchiveFile(next);
    if (next) setDirectFiles([]);
  };

  const pickFiles = (e) => {
    const next = Array.from(e.target.files || []);
    setDirectFiles(next);
    if (next.length > 0) setArchiveFile(null);
  };

  const submitBulkUpload = async () => {
    if (!archiveFile && directFiles.length === 0) {
      notify.error('Choose a ZIP archive or one or more passport files first.');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      if (archiveFile) form.append('archive', archiveFile, archiveFile.name);
      else directFiles.forEach((file) => form.append('files', file, file.name));
      const result = await fetchApi('/api/travel/passport/bulk-upload', {
        method: 'POST',
        body: form,
      });
      setSummary(result || null);
      notify.success(`Bulk upload complete - queued ${result?.queued || 0} passport${result?.queued === 1 ? '' : 's'}`);
      setArchiveFile(null);
      setDirectFiles([]);
      resetAndReload();
    } catch (e) {
      notify.error(e?.message || 'Bulk upload failed');
    } finally {
      setUploading(false);
    }
  };

  const wrap = { display: 'flex', flexDirection: 'column', gap: 16 };
  const card = { background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 };
  const label = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-secondary)' };
  const input = { padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--bg-color)', color: 'var(--text-primary)' };
  const selectStyle = { ...input, minWidth: 0 };
  const primaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
  const secondaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' };

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Passport List</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
              Upload passports in bulk, filter the queue sensibly, and assign imported passports to the right contact.
            </div>
          </div>
          <button type="button" onClick={() => resetAndReload()} style={secondaryBtn} aria-label="Refresh passport list">
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) repeat(2, minmax(180px, 0.75fr))', gap: 12, marginBottom: 16 }}>
          <label style={label}>
            Search passports
            <input
              type="search"
              value={search}
              onChange={(e) => {
                const value = e.target.value;
                setSearch(value);
                setRows([]);
                setPage(1);
              }}
              placeholder="Search full passport database by name, passport #, file name, contact, trip, or status"
              aria-label="Search passports"
              style={input}
            />
          </label>
          <label style={label}>
            Status
            <select
              value={statusFilter}
              onChange={(e) => {
                const value = e.target.value;
                setStatusFilter(value);
                setRows([]);
                setPage(1);
              }}
              aria-label="Filter passport status"
              style={selectStyle}
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="verified">Verified</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <label style={label}>
            Source
            <select
              value={sourceFilter}
              onChange={(e) => {
                const value = e.target.value;
                setSourceFilter(value);
                setRows([]);
                setPage(1);
              }}
              aria-label="Filter passport source"
              style={selectStyle}
            >
              <option value="">All sources</option>
              <option value="inbox">Imported inbox</option>
              <option value="customer">Assigned customer travellers</option>
              <option value="trip">Trip participants</option>
            </select>
          </label>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Search runs against the full passport database. Filters help staff focus on imported inbox passports, unresolved pending items, or verified trip-linked records.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 12 }}>
          <label style={label}>
            ZIP archive
            <input type="file" accept=".zip" onChange={pickArchive} aria-label="Passport ZIP archive" style={input} />
          </label>
          <label style={label}>
            Direct files
            <input type="file" multiple accept=".jpg,.jpeg,.png,.pdf" onChange={pickFiles} aria-label="Passport files" style={input} />
          </label>
        </div>

        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
          For best auto-matching, name each file after the traveller's full name. Unmatched files are kept in the imported passport inbox for contact assignment later.
        </div>

        {(archiveFile || directFiles.length > 0) && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            {archiveFile ? `Selected ZIP: ${archiveFile.name}` : `Selected files: ${directFiles.map((f) => f.name).join(', ')}`}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" onClick={submitBulkUpload} disabled={uploading} style={primaryBtn} aria-label="Upload passports in bulk">
            <Upload size={14} aria-hidden /> {uploading ? 'Uploading...' : 'Upload bulk passports'}
          </button>
          <button type="button" onClick={() => { setArchiveFile(null); setDirectFiles([]); setSummary(null); }} disabled={uploading} style={secondaryBtn}>
            Clear selection
          </button>
        </div>

        {summary && (
          <div data-testid="passport-bulk-summary" style={{ marginTop: 16, padding: 12, borderRadius: 6, background: 'var(--subtle-bg, rgba(255,255,255,0.04))', border: '1px solid var(--border-color)' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Bulk upload summary</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Total: {summary.total || 0} - Queued: {summary.queued || 0} - Skipped: {summary.skipped || 0} - Failed: {summary.failed || 0}
            </div>
            {Array.isArray(summary.results) && summary.results.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {summary.results.slice(0, 12).map((item) => (
                  <div key={`${item.fileName}-${item.status}`} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--text-primary)' }}>{item.fileName}</strong> - {item.status}
                    {item.matchedTo ? ` - ${item.matchedTo}` : ''}
                    {item.message ? ` - ${item.message}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {loading && <div style={card}>Loading passport list...</div>}
      {error && <div style={{ ...card, color: '#A8323F', borderColor: '#A8323F' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && <div style={card}>No uploaded passports found for the current search and filters.</div>}

      {!loading && !error && rows.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Loaded {rows.length} of {meta.total} passport{meta.total === 1 ? '' : 's'} - more load automatically as you scroll
            </div>
          </div>

          <div
            ref={listRef}
            style={{ maxHeight: 520, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {rows.map((row) => {
              const key = `${row.kind}:${row.id}`;
              const isInbox = row.importInbox || row.relationship === 'bulk_import_inbox' || row.subBrand === 'passport_inbox';
              const isAssigning = assigningId === key;
              return (
                <div key={key} style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600 }}>{row.fullName}</div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                        {row.kind === 'trip'
                          ? `Trip: ${row.trip?.tripCode || '-'}${row.trip?.destination ? ` - ${row.trip.destination}` : ''}`
                          : isInbox
                            ? 'Imported passport inbox'
                            : `Customer traveller - ${row.subBrand || 'travel'}`}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                        Passport #: {row.passportNumber || '-'} - Uploaded: {fmtDateTime(row.extractedAt)}
                        {row.verifiedAt ? ` - Verified: ${fmtDateTime(row.verifiedAt)}` : ''}
                      </div>
                      {row.kind === 'customer' && row.contactId > 0 && row.contactName && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                          Linked contact: {row.contactName}
                          {row.contactEmail ? ` - ${row.contactEmail}` : ''}
                          {row.contactPhone ? ` - ${row.contactPhone}` : ''}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ padding: '4px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: row.status === 'verified' ? 'rgba(47,122,77,0.14)' : row.status === 'rejected' ? 'rgba(168,50,63,0.14)' : 'rgba(200,154,78,0.18)', color: row.status === 'verified' ? '#2F7A4D' : row.status === 'rejected' ? '#A8323F' : '#9A6F2E' }}>
                        {row.status}
                      </span>
                      {isInbox && (
                        <button type="button" onClick={() => openAssignPanel(row)} style={secondaryBtn} aria-label={`Assign contact for ${row.fullName}`}>
                          Assign Contact
                        </button>
                      )}
                      {row.imageUrl && (
                        <a href={row.imageUrl} target="_blank" rel="noopener noreferrer" style={{ ...secondaryBtn, textDecoration: 'none' }}>View</a>
                      )}
                    </div>
                  </div>

                  {isAssigning && (
                    <div style={{ marginTop: 14, padding: 14, borderRadius: 6, background: 'var(--subtle-bg, rgba(255,255,255,0.04))', border: '1px solid var(--border-color)', display: 'grid', gap: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>Assign this imported passport to a contact</div>
                      <label style={label}>
                        Search contact
                        <input
                          type="search"
                          value={contactSearch}
                          onChange={(e) => {
                            const value = e.target.value;
                            setContactSearch(value);
                            setSelectedContactId('');
                            searchContacts(value);
                          }}
                          placeholder="Search by contact name, email, or phone"
                          aria-label="Search contact for passport assignment"
                          style={input}
                        />
                      </label>
                      <div style={{ display: 'grid', gap: 8 }}>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Matching customers</div>
                        <div style={{ border: '1px solid var(--border-color)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg-color)' }}>
                          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                            {contactOptions.length === 0 ? (
                              <div style={{ padding: '12px', fontSize: 13, color: 'var(--text-secondary)' }}>
                                {contactLoading ? 'Searching customers...' : 'No matching customers found.'}
                              </div>
                            ) : (
                              contactOptions.map((contact) => {
                                const labelText = (contact.name || `Contact #${contact.id}`)
                                  + (contact.email ? ` - ${contact.email}` : '')
                                  + (contact.phone ? ` - ${contact.phone}` : '');
                                const isSelected = String(contact.id) === String(selectedContactId);
                                return (
                                  <button
                                    key={contact.id}
                                    type="button"
                                    onClick={() => {
                                      setSelectedContactId(String(contact.id));
                                      setSelectedContactLabel(labelText);
                                      setContactSearch(contact.name || labelText);
                                    }}
                                    style={{
                                      width: '100%',
                                      textAlign: 'left',
                                      padding: '12px',
                                      border: 'none',
                                      borderTop: '1px solid var(--border-color)',
                                      background: isSelected ? 'rgba(200,154,78,0.16)' : 'transparent',
                                      color: 'var(--text-primary)',
                                      cursor: 'pointer',
                                      fontSize: 13,
                                    }}
                                    aria-label={`Select ${contact.name || `contact ${contact.id}`} for passport assignment`}
                                  >
                                    {labelText}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                        {selectedContactId && (
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            Selected customer: <span style={{ color: 'var(--text-primary)' }}>{selectedContactLabel || selectedContactId}</span>
                          </div>
                        )}
                      </div>
                      <label style={label}>
                        Relationship
                        <select
                          value={assignRelationship}
                          onChange={(e) => setAssignRelationship(e.target.value)}
                          aria-label="Relationship for assigned passport"
                          style={selectStyle}
                        >
                          <option value="self">Self</option>
                          <option value="spouse">Spouse</option>
                          <option value="child">Child</option>
                          <option value="parent">Parent</option>
                          <option value="other">Other</option>
                        </select>
                      </label>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => assignContact(row)} disabled={assigningBusy || !selectedContactId} style={primaryBtn}>
                          {assigningBusy ? 'Assigning...' : 'Save Assignment'}
                        </button>
                        <button type="button" onClick={closeAssignPanel} disabled={assigningBusy} style={secondaryBtn}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {loadingMore && (
              <div style={{ padding: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
                Loading more passports...
              </div>
            )}

            <div ref={sentinelRef} style={{ height: 1 }} aria-hidden />

            {!meta.hasNext && rows.length > 0 && (
              <div style={{ padding: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>
                End of passport list
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PassportVerificationQueue() {
  const [activeTab, setActiveTab] = useState('verification');
  const tabBtn = (isActive) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    borderRadius: 999,
    border: isActive ? '1px solid var(--primary-color, var(--accent-color))' : '1px solid var(--border-color)',
    background: isActive ? 'rgba(200,154,78,0.16)' : 'transparent',
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  });

  return (
    <div style={{ padding: 24, width: '100%', maxWidth: 1480, margin: '0 auto', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <BadgeCheck size={22} aria-hidden style={{ color: 'var(--primary-color, var(--accent-color))' }} />
        <h1 style={{ margin: 0, fontSize: 22 }}>Passport</h1>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
        Manage uploaded passports, bulk imports, and the existing verification workflow from one place.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        <button type="button" onClick={() => setActiveTab('verification')} style={tabBtn(activeTab === 'verification')} aria-label="Passport Verification tab">
          <BadgeCheck size={14} aria-hidden /> Passport Verification
        </button>
        <button type="button" onClick={() => setActiveTab('list')} style={tabBtn(activeTab === 'list')} aria-label="Passport List tab">
          <List size={14} aria-hidden /> Passport List
        </button>
      </div>
      {activeTab === 'verification' ? <PassportVerificationTab /> : <PassportListTab />}
    </div>
  );
}
