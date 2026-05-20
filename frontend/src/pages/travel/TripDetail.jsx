// Travel CRM — TMC trip detail view.
//
// Lands at /travel/trips/:id. Tabbed surface:
//   Overview — trip card + status / dates / destination
//   Participants — list, add, edit, remove (Aadhaar-safe inputs)
//   Rooming — assignment list with capacity guards
//   Payment plan — upsert plan + materialised per-participant instalments
//   Microsite — preview + admin link + publicUuid copy

import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Luggage, ChevronLeft, ChevronUp, ChevronDown, Users, BedDouble, Wallet, Globe,
  ExternalLink, Plus, Trash2, Edit3, Calendar as CalendarIcon, Copy, Save,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
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
      {tab === "microsite" && <MicrositeTab trip={trip} notify={notify} />}
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
    if (!confirm("Remove this participant?")) return;
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
            <input placeholder="Parent phone" value={form.parentPhone} onChange={(e) => setForm({ ...form, parentPhone: e.target.value })} style={input} />
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
              <div>
                <strong>{p.fullName}</strong>
                {p.parentName && <span style={{ color: "var(--text-secondary)", marginLeft: 8, fontSize: 13 }}>· parent: {p.parentName}</span>}
                {p.parentPhone && <span style={{ color: "var(--text-secondary)", marginLeft: 8, fontSize: 13 }}>{p.parentPhone}</span>}
              </div>
              <button type="button" onClick={() => remove(p.id)} style={iconBtn} aria-label={`Remove ${p.fullName}`}>
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
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
            participantIds: Array.isArray(pids) ? pids.map(Number).filter(Number.isFinite) : [],
          };
        }
        setBuffers(buf);
      })
      .catch(() => {
        setRooms([]);
        setBuffers({});
      })
      .finally(() => setLoading(false));
  }, [trip.id]);

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
        {!newRoom && (
          <button type="button" onClick={startNew} style={addBtn}>
            <Plus size={14} aria-hidden /> Add room
          </button>
        )}
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

function MicrositeTab({ trip, notify }) {
  const ms = trip.microsite;
  if (!ms) {
    return (
      <div style={empty}>
        No microsite published yet. Create via{" "}
        <code>POST /api/travel/trips/{trip.id}/microsite</code> (admin builder UI lands in Phase 1.5).
      </div>
    );
  }
  const publicUrl = `${window.location.origin}/api/travel/microsites/public/${ms.publicUuid}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      notify.success("Public URL copied");
    } catch {
      /* clipboard not available */
    }
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <strong>Subdomain:</strong> <code>{ms.subdomain}</code>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={copy} style={secondaryBtn}>
            <Copy size={14} /> Copy public URL
          </button>
          <a href={publicUrl} target="_blank" rel="noopener noreferrer" style={primaryBtn}>
            <ExternalLink size={14} /> Open
          </a>
        </div>
      </div>
      <div style={{ background: "var(--surface-color)", border: "1px solid var(--border-color)", borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>publicUuid (treat as semi-public per Q21)</div>
        <code style={{ fontSize: 13 }}>{ms.publicUuid}</code>
      </div>
      <div style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>Itinerary HTML</h3>
        <div
          style={{
            background: "var(--surface-color)", border: "1px solid var(--border-color)",
            borderRadius: 8, padding: 16, maxHeight: 400, overflow: "auto", fontSize: 13,
          }}
          // Note: itineraryHtml is admin-authored content; sanitization happens
          // at the route layer's sanitizeBody middleware on write. Rendering as
          // HTML here matches the public microsite's intended UX.
          dangerouslySetInnerHTML={{ __html: ms.itineraryHtml }}
        />
      </div>
    </div>
  );
}

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
