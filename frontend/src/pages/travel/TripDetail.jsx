// Travel CRM — TMC trip detail view.
//
// Lands at /travel/trips/:id. Tabbed surface:
//   Overview — trip card + status / dates / destination
//   Participants — list, add, edit, remove (Aadhaar-safe inputs)
//   Rooming — assignment list with capacity guards
//   Payment plan — upsert plan + materialised per-participant instalments
//   Microsite — preview + admin link + publicUuid copy

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Luggage, ChevronLeft, ChevronUp, ChevronDown, Users, BedDouble, Wallet, Globe,
  ExternalLink, Plus, Trash2, Edit3, Calendar as CalendarIcon, Copy, Save,
  Bold, Italic, Heading, Link2, List, Image as ImageIcon, Eye, Download, Upload,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const TABS = [
  { key: "overview", label: "Overview", icon: Luggage },
  { key: "participants", label: "Participants", icon: Users },
  { key: "rooming", label: "Rooming", icon: BedDouble },
  { key: "payment", label: "Payment plan", icon: Wallet },
  { key: "microsite", label: "Microsite", icon: Globe },
];

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

// Convert an ISO date string / Date / YYYY-MM-DD into the YYYY-MM-DD shape
// that <input type="date"> binds to. Returns '' for missing / unparseable.
/** Lightweight client-side HTML sanitiser — strips scripts, event handlers,
 *  and javascript: URLs as defence-in-depth even though the server already
 *  runs sanitizeBody on storage. */
function sanitizeHtml(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw;
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  s = s.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
  s = s.replace(/(href|src|action)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]*)/gi, '$1="#"');
  s = s.replace(/(href|src|action)\s*=\s*("data:[^"]*"|'data:[^']*'|data:[^\s>]*)/gi, '$1="#"');
  return s;
}

function toDateInput(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function TripDetail() {
  const { id } = useParams();
  const notify = useNotify();
  const [tab, setTab] = useState("overview");
  const [trip, setTrip] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchApi(`/api/travel/trips/${id}`)
      .then(setTrip)
      .catch((e) => notify.error(e?.body?.error || "Failed to load trip"))
      .finally(() => setLoading(false));
  }, [id, notify]);

  useEffect(load, [load]);

  if (loading) return <div style={{ padding: 24 }}>Loading&hellip;</div>;
  if (!trip) return (
    <div style={{ padding: 24 }}>
      <Link to="/travel/trips" style={backLink}><ChevronLeft size={16} /> Back to trips</Link>
      <p style={{ color: "var(--text-secondary)" }}>Trip not found.</p>
    </div>
  );

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <Link to="/travel/trips" style={backLink}><ChevronLeft size={16} /> Trips</Link>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 0 4px" }}>
            <Luggage size={28} aria-hidden /> {trip.tripCode}
          </h1>
          <div style={{ color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
            <CalendarIcon size={14} /> {fmt(trip.departDate)} → {fmt(trip.returnDate)} · {trip.destination}
          </div>
        </div>
        <StatusBadge status={trip.status} />
      </div>

      {/* Tab strip */}
      <div role="tablist" aria-label="Trip sections" style={{
        display: "flex", gap: 4, borderBottom: "1px solid var(--border-color)",
        marginTop: 20, marginBottom: 16, flexWrap: "wrap",
      }}>
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
                padding: "8px 16px", border: "none", background: "transparent",
                fontWeight: 600, fontSize: 14, cursor: "pointer",
                borderBottom: active ? "2px solid var(--primary-color)" : "2px solid transparent",
                color: active ? "var(--primary-color)" : "var(--text-secondary)",
                display: "inline-flex", alignItems: "center", gap: 6, marginBottom: -1,
              }}
            >
              <Icon size={16} aria-hidden /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <OverviewTab trip={trip} />}
      {tab === "participants" && <ParticipantsTab trip={trip} onChange={load} notify={notify} />}
      {tab === "rooming" && <RoomingTab trip={trip} notify={notify} />}
      {tab === "payment" && <PaymentTab trip={trip} notify={notify} />}
      {tab === "microsite" && <MicrositeTab trip={trip} onChange={load} notify={notify} />}
    </div>
  );
}

// ─── Overview tab ────────────────────────────────────────────────────

function OverviewTab({ trip }) {
  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
      <Card label="Destination" value={trip.destination} />
      <Card label="Depart" value={fmt(trip.departDate)} />
      <Card label="Return" value={fmt(trip.returnDate)} />
      <Card label="Legal entity" value={trip.legalEntity} />
      <Card label="Price / student" value={trip.pricePerStudent != null ? `₹${Number(trip.pricePerStudent).toLocaleString()}` : "—"} />
      <Card label="Participants" value={(trip.participants || []).length} />
      <Card label="Required docs" value={(trip.documentRequirements || []).length} />
      <Card label="Payment plan" value={trip.paymentPlan ? "configured" : "not set"} />
      <Card label="Microsite" value={trip.microsite ? "published" : "not published"} />
    </div>
  );
}

function Card({ label, value }) {
  return (
    <div style={{
      background: "var(--surface-color)", border: "1px solid var(--border-color)",
      borderRadius: 8, padding: 16,
    }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = {
    confirmed: { bg: "rgba(47,122,77,0.14)", color: "#2F7A4D" },
    "in-trip": { bg: "rgba(200,154,78,0.18)", color: "#9A6F2E" },
    completed: { bg: "rgba(38,88,85,0.16)", color: "#265855" },
    cancelled: { bg: "rgba(168,50,63,0.14)", color: "#A8323F" },
  };
  const sc = colors[status] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
  return (
    <span style={{
      background: sc.bg, color: sc.color,
      padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {status}
    </span>
  );
}

// ─── Participants tab ────────────────────────────────────────────────

function ParticipantsTab({ trip, onChange, notify }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ fullName: "", parentName: "", parentPhone: "" });

  const add = async () => {
    if (!form.fullName.trim()) {
      notify.error("Full name required");
      return;
    }
    // Mirror backend `toE164` — accept bare 10-digit Indian mobile (6-9 prefix),
    // 12-digit `91XXXXXXXXXX`, or already-`+`-prefixed E.164 (10-15 digits).
    // Backend auto-prepends +91 on save, so parents can type "9876543210".
    if (form.parentPhone.trim()) {
      const raw = form.parentPhone.trim();
      const digits = raw.replace(/\D/g, "");
      const ok = (raw.startsWith("+") && digits.length >= 10 && digits.length <= 15)
        || (digits.length === 10 && /^[6-9]/.test(digits))
        || (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2)));
      if (!ok) {
        notify.error("Parent phone must be a 10-digit Indian mobile (e.g. 9876543210) or an international number with country code");
        return;
      }
    }
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/participants`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      notify.success("Participant added");
      setForm({ fullName: "", parentName: "", parentPhone: "" });
      setAdding(false);
      onChange();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add");
    }
  };

  const remove = async (pid) => {
    const ok = await notify.confirm({
      title: "Remove participant",
      message: "Remove this participant? This cannot be undone.",
      confirmText: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/participants/${pid}`, { method: "DELETE" });
      notify.success("Removed");
      onChange();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to remove");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {trip.participants?.length || 0} participant{(trip.participants?.length || 0) === 1 ? "" : "s"}
        </span>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} style={addBtn}>
            <Plus size={14} /> Add participant
          </button>
        )}
      </div>

      {adding && (
        <div style={{ background: "var(--surface-color)", padding: 16, borderRadius: 8, border: "1px solid var(--border-color)", marginBottom: 12 }}>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
            <input placeholder="Full name *" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} style={input} />
            <input placeholder="Parent name" value={form.parentName} onChange={(e) => setForm({ ...form, parentName: e.target.value })} style={input} />
            <input placeholder="Parent phone (e.g. 9876543210)" value={form.parentPhone} onChange={(e) => setForm({ ...form, parentPhone: e.target.value })} style={input} />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={add} style={primaryBtn}>Add</button>
            <button type="button" onClick={() => setAdding(false)} style={secondaryBtn}>Cancel</button>
          </div>
        </div>
      )}

      <div style={listShell}>
        {(trip.participants || []).length === 0 ? (
          <div style={empty}>No participants yet.</div>
        ) : (
          trip.participants.map((p) => (
            <div key={p.id} style={row}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>{p.fullName}</strong>
                {(p.parentName || p.parentPhone) && (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2 }}>
                    {p.parentName && (
                      <span>
                        <span style={{ opacity: 0.7 }}>Parent</span> · {p.parentName}
                      </span>
                    )}
                    {p.parentPhone && <span style={{ fontVariantNumeric: "tabular-nums" }}>{p.parentPhone}</span>}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
                <PassportCell participant={p} notify={notify} onChange={onChange} />
                <button type="button" onClick={() => remove(p.id)} style={iconBtn} aria-label={`Remove ${p.fullName}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Passport upload cell (PRD_PASSPORT_OCR FR-1 operator-side) ──────
//
// Per-participant upload control feeding the verification queue at
// /travel/passport-verification. Status derives from the passport columns
// the trip GET already returns on each participant row:
//   passportVerifiedAt   → "Passport verified" badge + Clear & re-upload
//   passportRejectedAt   → "Passport rejected" badge + Re-upload CTA
//   passportExtractedAt  → "Pending verification" badge + Re-upload CTA
//   (none)               → "No passport" badge + Upload CTA
// No plain upload CTA once verified: the upload route keeps
// passportVerifiedAt intact, so a fresh extraction would never re-enter
// the queue (it filters on verifiedAt IS NULL). The Clear & re-upload
// action calls DELETE /passport-extraction (ADMIN/MANAGER-gated
// server-side), which resets all markers so the next upload queues
// normally. The queue page can't host that reset — it only lists
// unverified rows.
//
// Upload calls pass { silent: true } and own ALL error toasts locally:
// fetchApi's auto-toast would otherwise show the raw server string next
// to (not deduped against) the friendlier vendor-pending copy below.

const PASSPORT_ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";
// Mirrors the multer cap in backend/routes/travel_passport.js (PRD FR-1).
const PASSPORT_MAX_BYTES = 5 * 1024 * 1024;

function passportState(p) {
  if (p.passportVerifiedAt) return { label: "Passport verified", bg: "rgba(47,122,77,0.14)", color: "#2F7A4D", canUpload: false };
  if (p.passportRejectedAt) return { label: "Passport rejected", bg: "rgba(168,50,63,0.14)", color: "#A8323F", canUpload: true };
  if (p.passportExtractedAt) return { label: "Pending verification", bg: "rgba(200,154,78,0.18)", color: "#9A6F2E", canUpload: true };
  return { label: "No passport", bg: "var(--subtle-bg)", color: "var(--text-secondary)", canUpload: true };
}

function PassportCell({ participant: p, notify, onChange }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const state = passportState(p);
  // WCAG 2.5.3 Label in Name — the accessible name must contain the
  // visible text, so the aria-label tracks the Re-upload/Upload state.
  const isReupload = Boolean(p.passportExtractedAt || p.passportRejectedAt);
  const ctaText = isReupload ? "Re-upload" : "Upload passport";
  const ctaAria = `${isReupload ? "Re-upload" : "Upload"} passport for ${p.fullName}`;

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset so picking the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;
    const mime = (file.type || "").toLowerCase();
    if (!["image/jpeg", "image/png", "application/pdf"].includes(mime)) {
      notify.error("Unsupported file type — JPG, PNG or PDF only");
      return;
    }
    if (file.size > PASSPORT_MAX_BYTES) {
      notify.error("File exceeds the 5 MB limit");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    setBusy(true);
    try {
      await fetchApi(`/api/travel/passport/participants/${p.id}/passport-upload`, {
        method: "POST",
        body: fd,
        silent: true,
      });
      notify.success(`Passport uploaded for ${p.fullName} — queued for verification`);
      onChange();
    } catch (err) {
      // silent:true skips fetchApi's 401 redirect — restore it here since
      // this is a user-initiated action (an expired session must boot).
      if (err?.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (err?.code === "PASSPORT_OCR_NOT_YET_ENABLED") {
        notify.error("Passport OCR isn't enabled for this tenant yet (vendor integration pending) — please try again after it goes live.");
      } else {
        notify.error(err?.data?.error || err?.message || "Failed to upload passport");
      }
    } finally {
      setBusy(false);
    }
  };

  // Verified-state escape hatch: a verified passport that needs replacing
  // (renewal, mistaken approval) has to be cleared first. Rendered for all
  // roles (this page does no client-side role gating); the DELETE route
  // 403s non-ADMIN/MANAGER users with a friendly RBAC toast.
  const clearAndReupload = async () => {
    if (!confirm(`Clear ${p.fullName}'s verified passport so a new one can be uploaded?`)) return;
    setBusy(true);
    try {
      await fetchApi(`/api/travel/passport/participants/${p.id}/passport-extraction`, {
        method: "DELETE",
      });
      notify.success("Passport extraction cleared — upload a new one");
      onChange();
    } catch (err) {
      notify.error(err?.data?.error || "Failed to clear passport extraction");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{
        background: state.bg, color: state.color,
        padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600,
        whiteSpace: "nowrap",
      }}>
        {state.label}
      </span>
      {state.canUpload ? (
        <>
          <button
            type="button"
            onClick={() => fileRef.current && fileRef.current.click()}
            disabled={busy}
            aria-label={ctaAria}
            style={{
              ...secondaryBtn, padding: "5px 10px", fontSize: 12,
              opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer",
            }}
          >
            <Upload size={13} aria-hidden /> {busy ? "Uploading…" : ctaText}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={PASSPORT_ACCEPT}
            onChange={handleFile}
            disabled={busy}
            aria-label={`Passport file for ${p.fullName}`}
            style={visuallyHiddenInput}
          />
        </>
      ) : (
        <button
          type="button"
          onClick={clearAndReupload}
          disabled={busy}
          aria-label={`Clear & re-upload passport for ${p.fullName}`}
          style={{
            ...secondaryBtn, padding: "5px 10px", fontSize: 12,
            opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer",
          }}
        >
          Clear &amp; re-upload
        </button>
      )}
    </span>
  );
}

// ─── Rooming tab ─────────────────────────────────────────────────────

const ROOM_CAPACITY = { single: 1, twin: 2, triple: 3, quad: 4 };
const ROOM_TYPES = ["single", "twin", "triple", "quad"];

function RoomingTab({ trip, notify }) {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  // Edit buffer per existing room (keyed by room.id). Local edits live
  // here until Save → PATCH; the server response then re-hydrates on load.
  const [buffers, setBuffers] = useState({});
  // In-progress new-room form, or null when the form is closed.
  const [newRoom, setNewRoom] = useState(null);
  // 'new' or a room.id while an API call is in flight; used to disable
  // its row's Save/Delete buttons.
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    // Filter stored participantIds against the current trip's participants so
    // orphaned references (participants deleted after the room was saved) don't
    // inflate the room-tile "X / capacity" count nor the header "unassigned"
    // count. Without this, removed-but-still-referenced IDs disagreed with the
    // visible checkbox state (only real participants render checkboxes).
    const validIds = new Set((trip.participants || []).map((p) => p.id));
    fetchApi(`/api/travel/trips/${trip.id}/rooming`)
      .then((r) => {
        const rs = r?.rooming || [];
        setRooms(rs);
        const buf = {};
        for (const room of rs) {
          let pids = [];
          try { pids = JSON.parse(room.participantIds || "[]"); } catch (_e) { /* ignore */ }
          buf[room.id] = {
            roomNumber: room.roomNumber || "",
            roomType: room.roomType || "twin",
            participantIds: Array.isArray(pids)
              ? pids.map(Number).filter(Number.isFinite).filter((id) => validIds.has(id))
              : [],
          };
        }
        setBuffers(buf);
      })
      .catch(() => {
        setRooms([]);
        setBuffers({});
      })
      .finally(() => setLoading(false));
  }, [trip.id, trip.participants]);

  useEffect(load, [load]);

  const participants = Array.isArray(trip.participants) ? trip.participants : [];

  // Live unassigned count — derived from current edit buffers + the
  // in-flight new-room form. Helps the operator see at a glance which
  // participants still need a bed.
  const assigned = new Set();
  for (const b of Object.values(buffers)) {
    for (const pid of (b.participantIds || [])) assigned.add(Number(pid));
  }
  if (newRoom) {
    for (const pid of newRoom.participantIds) assigned.add(Number(pid));
  }
  const unassignedCount = participants.filter((p) => !assigned.has(p.id)).length;

  const updateBuf = (id, patch) =>
    setBuffers((b) => ({ ...b, [id]: { ...b[id], ...patch } }));

  const toggleParticipant = (id, pid) => {
    const buf = buffers[id];
    if (!buf) return;
    const next = buf.participantIds.includes(pid)
      ? buf.participantIds.filter((x) => x !== pid)
      : [...buf.participantIds, pid];
    updateBuf(id, { participantIds: next });
  };

  const saveRoom = async (id) => {
    const buf = buffers[id];
    if (!buf || !buf.roomNumber.trim()) {
      notify.error("roomNumber is required");
      return;
    }
    setBusyId(id);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/rooming/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          roomNumber: buf.roomNumber.trim(),
          roomType: buf.roomType,
          participantIds: buf.participantIds.map(Number),
        }),
      });
      notify.success("Room saved");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save room");
    } finally {
      setBusyId(null);
    }
  };

  const deleteRoom = async (id) => {
    if (!window.confirm("Delete this room?")) return;
    setBusyId(id);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/rooming/${id}`, { method: "DELETE" });
      notify.success("Room deleted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete room");
    } finally {
      setBusyId(null);
    }
  };

  const startNew = () =>
    setNewRoom({ roomNumber: "", roomType: "twin", participantIds: [] });

  const cancelNew = () => setNewRoom(null);

  const toggleNewParticipant = (pid) => {
    if (!newRoom) return;
    const next = newRoom.participantIds.includes(pid)
      ? newRoom.participantIds.filter((x) => x !== pid)
      : [...newRoom.participantIds, pid];
    setNewRoom({ ...newRoom, participantIds: next });
  };

  const createRoom = async () => {
    if (!newRoom) return;
    if (!newRoom.roomNumber.trim()) {
      notify.error("roomNumber is required");
      return;
    }
    setBusyId("new");
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/rooming`, {
        method: "POST",
        body: JSON.stringify({
          roomNumber: newRoom.roomNumber.trim(),
          roomType: newRoom.roomType,
          participantIds: newRoom.participantIds.map(Number),
        }),
      });
      notify.success("Room added");
      setNewRoom(null);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add room");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <div style={empty}>Loading&hellip;</div>;

  // XLSX download uses a plain link; back-end accepts cookie OR bearer.
  // Append the bearer token via ?_t= when present (mirrors the PDF link
  // pattern at ItineraryDetail.jsx:281). target=_blank so the download
  // doesn't replace the current SPA route.
  const xlsxToken = typeof getAuthToken === "function" ? getAuthToken() : null;
  const xlsxHref =
    `/api/travel/trips/${trip.id}/rooming/export.xlsx` +
    (xlsxToken ? `?_t=${encodeURIComponent(xlsxToken)}` : "");

  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 12, flexWrap: "wrap", gap: 8,
      }}>
        <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {rooms.length} room{rooms.length === 1 ? "" : "s"} ·{" "}
          {unassignedCount} of {participants.length} participant{participants.length === 1 ? "" : "s"} unassigned
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a
            href={xlsxHref}
            target="_blank"
            rel="noreferrer"
            style={{ ...secondaryBtn, textDecoration: "none" }}
            aria-label="Download rooming as XLSX"
          >
            <Download size={14} aria-hidden /> Download XLSX
          </a>
          {!newRoom && (
            <button type="button" onClick={startNew} style={addBtn}>
              <Plus size={14} aria-hidden /> Add room
            </button>
          )}
        </div>
      </div>

      {newRoom && (
        <RoomCard
          buf={newRoom}
          isNew
          busy={busyId === "new"}
          participants={participants}
          onChangeRoomNumber={(v) => setNewRoom({ ...newRoom, roomNumber: v })}
          onChangeRoomType={(v) => setNewRoom({ ...newRoom, roomType: v })}
          onToggleParticipant={toggleNewParticipant}
          onSave={createRoom}
          onCancel={cancelNew}
        />
      )}

      {rooms.length === 0 && !newRoom ? (
        <div style={listShell}>
          <div style={empty}>No rooming assignments yet — click <em>Add room</em> to start.</div>
        </div>
      ) : (
        rooms.map((room) => {
          const buf = buffers[room.id] || {
            roomNumber: room.roomNumber,
            roomType: room.roomType,
            participantIds: [],
          };
          return (
            <RoomCard
              key={room.id}
              buf={buf}
              busy={busyId === room.id}
              participants={participants}
              onChangeRoomNumber={(v) => updateBuf(room.id, { roomNumber: v })}
              onChangeRoomType={(v) => updateBuf(room.id, { roomType: v })}
              onToggleParticipant={(pid) => toggleParticipant(room.id, pid)}
              onSave={() => saveRoom(room.id)}
              onDelete={() => deleteRoom(room.id)}
            />
          );
        })
      )}
    </div>
  );
}

function RoomCard({
  buf, isNew, busy, participants,
  onChangeRoomNumber, onChangeRoomType, onToggleParticipant,
  onSave, onDelete, onCancel,
}) {
  const capacity = ROOM_CAPACITY[buf.roomType] || 0;
  const count = buf.participantIds.length;
  const overCapacity = count > capacity;
  const atCapacity = count >= capacity;
  return (
    <div style={{ ...listShell, marginBottom: 12, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <input
          type="text"
          value={buf.roomNumber}
          onChange={(e) => onChangeRoomNumber(e.target.value)}
          placeholder="Room # (e.g. 101)"
          style={{ ...input, flex: "1 1 140px" }}
          aria-label="Room number"
        />
        <select
          value={buf.roomType}
          onChange={(e) => onChangeRoomType(e.target.value)}
          style={{ ...input, flex: "0 0 140px" }}
          aria-label="Room type"
        >
          {ROOM_TYPES.map((t) => (
            <option key={t} value={t}>{t} ({ROOM_CAPACITY[t]})</option>
          ))}
        </select>
        <span style={{
          fontSize: 12, fontWeight: 600,
          color: overCapacity ? "var(--danger-color)" : "var(--text-secondary)",
        }}>
          {count} / {capacity} assigned
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            style={{ ...primaryBtn, opacity: busy ? 0.5 : 1, cursor: busy ? "not-allowed" : "pointer" }}
            aria-label={isNew ? "Add room" : "Save room"}
          >
            <Save size={14} aria-hidden /> {busy ? (isNew ? "Adding…" : "Saving…") : (isNew ? "Add room" : "Save")}
          </button>
          {isNew ? (
            <button type="button" onClick={onCancel} style={secondaryBtn} aria-label="Cancel new room">
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              style={{ ...iconBtn, opacity: busy ? 0.5 : 1 }}
              title="Delete room"
              aria-label="Delete room"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {participants.length === 0 ? (
          <span style={{ ...empty, padding: 0 }}>No participants on this trip yet.</span>
        ) : (
          participants.map((p) => {
            const checked = buf.participantIds.includes(p.id);
            const disabled = !checked && atCapacity;
            return (
              <label
                key={p.id}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 10px", borderRadius: 6,
                  border: "1px solid var(--border-color)",
                  background: checked ? "var(--primary-color)" : "var(--surface-color)",
                  color: checked ? "#fff" : "var(--text-primary)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.45 : 1,
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleParticipant(p.id)}
                  disabled={disabled}
                  style={{ margin: 0 }}
                />
                {p.fullName || `Participant #${p.id}`}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Payment plan tab ────────────────────────────────────────────────

function PaymentTab({ trip, notify }) {
  const [plan, setPlan] = useState(null);
  const [instalments, setInstalments] = useState([]);
  const [loading, setLoading] = useState(true);

  // Editor state — always editable. Hydrated from the loaded plan; an
  // empty plan starts blank.
  const [graceDays, setGraceDays] = useState(0);
  const [editInstalments, setEditInstalments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/travel/trips/${trip.id}/payment-plan`).catch(() => null),
      fetchApi(`/api/travel/trips/${trip.id}/instalments`).then((r) => r?.instalments || []).catch(() => []),
    ])
      .then(([p, ins]) => {
        setPlan(p);
        setInstalments(ins);
        if (p) {
          setGraceDays(p.graceDays ?? 0);
          let parsed = [];
          try { parsed = JSON.parse(p.instalmentsJson || "[]"); } catch (_e) { /* ignore */ }
          setEditInstalments(Array.isArray(parsed) ? parsed : []);
        } else {
          setGraceDays(0);
          setEditInstalments([]);
        }
      })
      .finally(() => setLoading(false));
  }, [trip.id]);

  useEffect(load, [load]);

  const addInstalment = () => {
    setEditInstalments([
      ...editInstalments,
      { dueDate: "", amount: 0, reminderDays: 7 },
    ]);
  };

  const updateInstalment = (idx, patch) => {
    setEditInstalments(editInstalments.map((it, j) => (j === idx ? { ...it, ...patch } : it)));
  };

  const removeInstalment = (idx) => {
    setEditInstalments(editInstalments.filter((_it, j) => j !== idx));
  };

  const moveInstalment = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= editInstalments.length) return;
    const next = editInstalments.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    setEditInstalments(next);
  };

  const onSave = async () => {
    if (editInstalments.length === 0) {
      notify.error("Add at least one instalment");
      return;
    }
    for (let i = 0; i < editInstalments.length; i++) {
      const ins = editInstalments[i];
      if (!ins.dueDate) {
        notify.error(`Instalment ${i + 1}: due date is required`);
        return;
      }
      if (!ins.amount || Number(ins.amount) <= 0) {
        notify.error(`Instalment ${i + 1}: amount must be > 0`);
        return;
      }
    }
    setSaving(true);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/payment-plan`, {
        method: "PUT",
        body: JSON.stringify({
          instalmentsJson: JSON.stringify(editInstalments),
          graceDays: Number(graceDays) || 0,
        }),
      });
      notify.success(`Payment plan saved (${editInstalments.length} instalments).`);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save payment plan");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!window.confirm("Delete payment plan? Per-participant instalments are NOT deleted.")) return;
    setDeleting(true);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/payment-plan`, { method: "DELETE" });
      notify.success("Payment plan deleted.");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete payment plan");
    } finally {
      setDeleting(false);
    }
  };

  const total = editInstalments.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);

  if (loading) return <div style={empty}>Loading&hellip;</div>;
  return (
    <div>
      <section style={{ marginBottom: 20 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 10, flexWrap: "wrap", gap: 8,
        }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>
            {plan ? "Edit payment plan" : "Create payment plan"}
          </h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <span style={{ color: "var(--text-secondary)" }}>Grace days</span>
            <input
              type="number"
              min="0"
              value={graceDays}
              onChange={(e) => setGraceDays(e.target.value === "" ? 0 : Number(e.target.value))}
              style={{ ...input, width: 70 }}
              aria-label="Grace days"
            />
          </label>
        </div>

        <div style={listShell}>
          {editInstalments.length === 0 ? (
            <div style={empty}>No instalments — click <em>Add instalment</em> to start.</div>
          ) : (
            editInstalments.map((ins, idx) => (
              <div key={idx} style={{ ...row, flexWrap: "wrap", gap: 8 }}>
                <strong style={{ minWidth: 28 }}>#{idx + 1}</strong>
                <input
                  type="date"
                  value={toDateInput(ins.dueDate)}
                  onChange={(e) => updateInstalment(idx, { dueDate: e.target.value })}
                  style={{ ...input, flex: "1 1 140px" }}
                  aria-label={`Instalment ${idx + 1} due date`}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="amount"
                  value={ins.amount ?? ""}
                  onChange={(e) => updateInstalment(idx, { amount: e.target.value === "" ? "" : Number(e.target.value) })}
                  style={{ ...input, flex: "1 1 110px" }}
                  aria-label={`Instalment ${idx + 1} amount`}
                />
                <input
                  type="number"
                  min="0"
                  placeholder="reminder days"
                  value={ins.reminderDays ?? ""}
                  onChange={(e) => updateInstalment(idx, { reminderDays: e.target.value === "" ? null : Number(e.target.value) })}
                  style={{ ...input, flex: "0 0 130px" }}
                  aria-label={`Instalment ${idx + 1} reminder days before due`}
                  title="Days before dueDate to fire reminder (blank = no reminder)"
                />
                <button
                  type="button"
                  onClick={() => moveInstalment(idx, -1)}
                  disabled={idx === 0}
                  style={{ ...iconBtn, opacity: idx === 0 ? 0.4 : 1 }}
                  title="Move up"
                  aria-label={`Move instalment ${idx + 1} up`}
                >
                  <ChevronUp size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => moveInstalment(idx, 1)}
                  disabled={idx === editInstalments.length - 1}
                  style={{ ...iconBtn, opacity: idx === editInstalments.length - 1 ? 0.4 : 1 }}
                  title="Move down"
                  aria-label={`Move instalment ${idx + 1} down`}
                >
                  <ChevronDown size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => removeInstalment(idx)}
                  style={iconBtn}
                  title="Remove instalment"
                  aria-label={`Remove instalment ${idx + 1}`}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            ))
          )}
        </div>

        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 10, flexWrap: "wrap", gap: 8,
        }}>
          <button type="button" onClick={addInstalment} style={addBtn}>
            <Plus size={14} aria-hidden /> Add instalment
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Total: <strong style={{ color: "var(--text-primary)" }}>
                ₹{total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </strong>
            </span>
            {plan && (
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting}
                style={{ ...secondaryBtn, opacity: deleting ? 0.5 : 1 }}
                aria-label="Delete payment plan"
              >
                <Trash2 size={14} aria-hidden /> {deleting ? "Deleting…" : "Delete plan"}
              </button>
            )}
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              style={{ ...primaryBtn, opacity: saving ? 0.5 : 1, cursor: saving ? "not-allowed" : "pointer" }}
              aria-label="Save payment plan"
            >
              <Save size={14} aria-hidden /> {saving ? "Saving…" : "Save plan"}
            </button>
          </div>
        </div>
      </section>

      <h3 style={{ fontSize: 14, marginBottom: 8 }}>Per-participant instalments</h3>
      <div style={listShell}>
        {instalments.length === 0 ? (
          <div style={empty}>No per-participant instalments yet.</div>
        ) : (
          instalments.map((i) => (
            <div key={i.id} style={row}>
              <div>
                <strong>Participant #{i.participantId}</strong>
                <span style={{ marginLeft: 8, color: "var(--text-secondary)" }}>
                  #{i.instalmentIndex + 1} · due {fmt(i.dueDate)}
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div>₹{Number(i.amount).toLocaleString()}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase" }}>
                  {i.status}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Microsite tab ───────────────────────────────────────────────────
//
// Inline editor (Phase 1.5 / 8d). Two states:
//   - no microsite yet → Create form (subdomain default + initial itineraryHtml).
//   - already published → Edit form for subdomain + itineraryHtml + faqJson + expiresAt,
//     plus Copy/Open/Preview buttons and Unpublish (ADMIN-only).
//
// Rich-text uses native `contenteditable` + document.execCommand (B / I / H2 /
// list / link / image) rather than TipTap/Lexical/Slate. Trade-off: less
// flexibility but zero new npm deps — avoids the Windows-npm-lockfile gotcha
// (see project_frontend_npm_windows memory + the v3.9 handoff). The output
// is plain HTML which is what the backend's itineraryHtml column already stores
// and sanitizes via the global sanitizeBody middleware.

const ITINERARY_PLACEHOLDER = `<h2>Day 1 — Arrival</h2>
<p>Welcome and orientation. Hotel check-in.</p>
<h2>Day 2 — Excursion</h2>
<p>Full-day guided tour.</p>`;

function MicrositeTab({ trip, onChange, notify }) {
  const ms = trip.microsite;
  if (ms) return <MicrositeEditor trip={trip} ms={ms} onChange={onChange} notify={notify} />;
  return <MicrositeCreate trip={trip} onChange={onChange} notify={notify} />;
}

// ─── Create form (no microsite yet) ──────────────────────────────────

function MicrositeCreate({ trip, onChange, notify }) {
  const [subdomain, setSubdomain] = useState(`trip-${trip.tripCode}`);
  const [itineraryHtml, setItineraryHtml] = useState(ITINERARY_PLACEHOLDER);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!itineraryHtml.trim()) {
      notify.error("Itinerary content required");
      return;
    }
    setSaving(true);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/microsite`, {
        method: "POST",
        body: JSON.stringify({ subdomain: subdomain.trim() || undefined, itineraryHtml }),
      });
      notify.success("Microsite published");
      onChange?.();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to publish microsite");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ background: "var(--subtle-bg)", border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 13, color: "var(--text-secondary)" }}>
        No microsite published yet. Fill the editor and click <strong>Publish</strong> to create one.
      </div>
      <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
        Subdomain
      </label>
      <input
        type="text"
        value={subdomain}
        onChange={(e) => setSubdomain(e.target.value)}
        placeholder={`trip-${trip.tripCode}`}
        style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 12 }}
        aria-label="Microsite subdomain"
      />
      <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
        Itinerary content
      </label>
      <RichTextEditor
        value={itineraryHtml}
        onChange={setItineraryHtml}
        tripId={trip.id}
        notify={notify}
      />
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button type="button" onClick={submit} disabled={saving} style={saving ? primaryBtnDisabled : primaryBtn}>
          <Save size={14} /> {saving ? "Publishing…" : "Publish microsite"}
        </button>
      </div>
    </div>
  );
}

// ─── Edit form (microsite exists) ────────────────────────────────────

function MicrositeEditor({ trip, ms, onChange, notify }) {
  const [subdomain, setSubdomain] = useState(ms.subdomain || "");
  const [itineraryHtml, setItineraryHtml] = useState(ms.itineraryHtml || "");
  const [faqJson, setFaqJson] = useState(ms.faqJson || "");
  const [expiresAt, setExpiresAt] = useState(toDateInput(ms.expiresAt));
  const [saving, setSaving] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const publicUrl = `${window.location.origin}/api/travel/microsites/public/${ms.publicUuid}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      notify.success("Public URL copied");
    } catch {
      /* clipboard not available */
    }
  };

  const save = async () => {
    if (!itineraryHtml.trim()) {
      notify.error("Itinerary content required");
      return;
    }
    if (faqJson.trim()) {
      try { JSON.parse(faqJson); }
      catch { notify.error("faqJson is not valid JSON"); return; }
    }
    setSaving(true);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/microsite`, {
        method: "PATCH",
        body: JSON.stringify({
          subdomain: subdomain.trim(),
          itineraryHtml,
          faqJson: faqJson.trim() ? faqJson : null,
          expiresAt: expiresAt || null,
        }),
      });
      notify.success("Microsite updated");
      onChange?.();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const unpublish = async () => {
    if (!window.confirm("Unpublish this microsite? The public URL will stop responding.")) return;
    setUnpublishing(true);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/microsite`, { method: "DELETE" });
      notify.success("Microsite unpublished");
      onChange?.();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to unpublish");
    } finally {
      setUnpublishing(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          <code style={{ fontSize: 11 }}>{ms.publicUuid}</code>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setPreviewing((p) => !p)} style={secondaryBtn}>
            {previewing ? <><Edit3 size={14} /> Edit</> : <><Eye size={14} /> Preview</>}
          </button>
          <button type="button" onClick={copy} style={secondaryBtn}>
            <Copy size={14} /> Copy URL
          </button>
          <a href={publicUrl} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn, textDecoration: "none" }}>
            <ExternalLink size={14} /> Open
          </a>
        </div>
      </div>

      {previewing ? (
        <div
          style={{
            background: "var(--surface-color)", border: "1px solid var(--border-color)",
            borderRadius: 8, padding: 16, maxHeight: 500, overflow: "auto", fontSize: 14,
          }}
          // itineraryHtml is admin-authored; sanitization happens at the route's
          // sanitizeBody middleware on write. Preview renders the in-edit state.
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(itineraryHtml) }}
        />
      ) : (
        <>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", marginBottom: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
                Subdomain
              </label>
              <input
                type="text"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                style={{ ...input, width: "100%", boxSizing: "border-box" }}
                aria-label="Microsite subdomain"
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
                Expires (optional)
              </label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                style={{ ...input, width: "100%", boxSizing: "border-box" }}
                aria-label="Microsite expiry date"
              />
            </div>
          </div>

          <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
            Itinerary content
          </label>
          <RichTextEditor
            value={itineraryHtml}
            onChange={setItineraryHtml}
            tripId={trip.id}
            notify={notify}
          />

          <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, marginTop: 12 }}>
            FAQ (optional, JSON array of {`{ q, a }`})
          </label>
          <textarea
            value={faqJson}
            onChange={(e) => setFaqJson(e.target.value)}
            placeholder='[{"q":"What to pack?","a":"Sunscreen + ID."}]'
            spellCheck={false}
            style={{ ...input, width: "100%", boxSizing: "border-box", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, minHeight: 80, resize: "vertical" }}
            aria-label="Microsite FAQ JSON"
          />
        </>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <button type="button" onClick={save} disabled={saving || previewing} style={(saving || previewing) ? primaryBtnDisabled : primaryBtn}>
          <Save size={14} /> {saving ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={unpublish} disabled={unpublishing} style={dangerBtn}>
          <Trash2 size={14} /> {unpublishing ? "Unpublishing…" : "Unpublish"}
        </button>
      </div>
    </div>
  );
}

// ─── Rich-text editor (contenteditable + execCommand) ────────────────
//
// document.execCommand is technically deprecated but is the only thing
// every modern browser supports for contenteditable formatting without
// a 100KB library. We use a narrow command set (bold, italic, H2, lists,
// link, image) — the parts that work uniformly across Chrome / Edge /
// Firefox / Safari. If we eventually adopt TipTap/Lexical (when the
// Windows-lockfile gotcha is solved) this component is the sole replace-
// site; the parent components pass HTML strings through opaquely.

function RichTextEditor({ value, onChange, tripId, notify }) {
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  // Inject value into the contenteditable div when the prop changes.
  // The innerHTML guard prevents fighting the browser's caret state
  // on every keystroke — `value` only changes from the parent, not
  // during local typing. We also skip the sync when the editor has
  // focus so the parent re-rendering doesn't clobber the caret.
  useEffect(() => {
    if (
      editorRef.current &&
      editorRef.current.innerHTML !== value &&
      document.activeElement !== editorRef.current
    ) {
      editorRef.current.innerHTML = value || "";
    }
  }, [value]);

  const handleInput = () => {
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  };

  const exec = (cmd, arg) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, arg);
    handleInput();
  };

  const insertLink = () => {
    const url = window.prompt("Link URL", "https://");
    if (!url) return;
    exec("createLink", url);
  };

  const insertHeading = () => {
    // execCommand "formatBlock" with H2 — wraps the current block in <h2>.
    exec("formatBlock", "H2");
  };

  const insertImage = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/travel/trips/${tripId}/microsite/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Upload failed (${res.status})`);
      exec("insertImage", body.url);
      notify.success("Image inserted");
    } catch (e) {
      notify.error(e.message || "Failed to upload image");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div style={{ background: "var(--surface-color)", border: "1px solid var(--border-color)", borderRadius: 8, overflow: "hidden" }}>
      <div style={toolbar} role="toolbar" aria-label="Formatting toolbar">
        <ToolButton onClick={() => exec("bold")} label="Bold (Ctrl+B)"><Bold size={14} /></ToolButton>
        <ToolButton onClick={() => exec("italic")} label="Italic (Ctrl+I)"><Italic size={14} /></ToolButton>
        <ToolButton onClick={insertHeading} label="Heading"><Heading size={14} /></ToolButton>
        <ToolButton onClick={() => exec("insertUnorderedList")} label="Bulleted list"><List size={14} /></ToolButton>
        <ToolButton onClick={insertLink} label="Insert link"><Link2 size={14} /></ToolButton>
        <ToolButton onClick={() => fileRef.current?.click()} label="Insert image" disabled={uploading}>
          <ImageIcon size={14} /> {uploading && <span style={{ marginLeft: 4, fontSize: 11 }}>…</span>}
        </ToolButton>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={insertImage}
          style={{ display: "none" }}
          aria-label="Upload image"
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-secondary)", padding: "0 6px" }}>
          B / I / H2 / list / link / image · output is HTML
        </span>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        style={{
          padding: 16,
          minHeight: 240,
          maxHeight: 500,
          overflow: "auto",
          background: "var(--bg-color)",
          color: "var(--text-primary)",
          fontSize: 14,
          lineHeight: 1.5,
          outline: "none",
        }}
        aria-label="Itinerary content editor"
      />
    </div>
  );
}

function ToolButton({ children, onClick, label, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        ...toolBtn,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

const toolbar = {
  display: "flex", alignItems: "center", gap: 4, padding: 6,
  background: "var(--subtle-bg)", borderBottom: "1px solid var(--border-color)",
  flexWrap: "wrap",
};
const toolBtn = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  padding: "6px 8px", borderRadius: 4, border: "1px solid transparent",
  background: "transparent", color: "var(--text-primary)",
  cursor: "pointer",
};
const primaryBtnDisabled = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color)", color: "#fff",
  border: "none", opacity: 0.5, cursor: "not-allowed",
};
const dangerBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--danger-color)",
  border: "1px solid var(--danger-color)", cursor: "pointer",
};

// ─── Shared styles ───────────────────────────────────────────────────

const backLink = {
  display: "inline-flex", alignItems: "center", gap: 4,
  fontSize: 13, color: "var(--text-secondary)", textDecoration: "none",
  padding: "4px 8px", borderRadius: 4,
};
const listShell = {
  background: "var(--surface-color)", borderRadius: 8,
  border: "1px solid var(--border-color)", overflow: "hidden",
};
const row = {
  padding: "10px 14px", display: "flex", justifyContent: "space-between",
  alignItems: "center", borderTop: "1px solid var(--border-light)",
};
const empty = {
  padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14,
};
const input = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)", background: "var(--bg-color)",
  color: "var(--text-primary)", fontSize: 13,
};
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color)", color: "#fff",
  border: "none", cursor: "pointer", textDecoration: "none",
};
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const addBtn = {
  ...primaryBtn,
};
const iconBtn = {
  padding: 6, borderRadius: 4,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
// Visually hidden but still in the accessibility tree (display:none would
// drop it for screen readers AND RTL label queries).
const visuallyHiddenInput = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};
