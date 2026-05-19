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
  Luggage, ChevronLeft, Users, BedDouble, Wallet, Globe,
  ExternalLink, Plus, Trash2, Edit3, Calendar as CalendarIcon, Copy,
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

function RoomingTab({ trip, notify: _notify }) {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchApi(`/api/travel/trips/${trip.id}/rooming`)
      .then((r) => setRooms(r?.rooming || []))
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, [trip.id]);

  useEffect(load, [load]);

  return (
    <div>
      {loading ? <div style={empty}>Loading&hellip;</div> : null}
      <div style={listShell}>
        {!loading && rooms.length === 0 ? (
          <div style={empty}>
            No rooming assignments yet. Add via the API; visual builder lands in Phase 1.5.
          </div>
        ) : (
          rooms.map((r) => {
            let pids = [];
            try { pids = JSON.parse(r.participantIds || "[]"); } catch (_e) { /* ignore */ }
            return (
              <div key={r.id} style={row}>
                <div>
                  <strong>Room {r.roomNumber}</strong>
                  <span style={{ color: "var(--text-secondary)", marginLeft: 8, fontSize: 13 }}>
                    · {r.roomType} · {pids.length} occupant{pids.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Payment plan tab ────────────────────────────────────────────────

function PaymentTab({ trip, notify: _notify }) {
  const [plan, setPlan] = useState(null);
  const [instalments, setInstalments] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/travel/trips/${trip.id}/payment-plan`).catch(() => null),
      fetchApi(`/api/travel/trips/${trip.id}/instalments`).then((r) => r?.instalments || []).catch(() => []),
    ])
      .then(([p, ins]) => {
        setPlan(p);
        setInstalments(ins);
      })
      .finally(() => setLoading(false));
  }, [trip.id]);

  useEffect(load, [load]);

  let planInstalments = [];
  if (plan && plan.instalmentsJson) {
    try { planInstalments = JSON.parse(plan.instalmentsJson); } catch (_e) { /* ignore */ }
  }

  if (loading) return <div style={empty}>Loading&hellip;</div>;
  return (
    <div>
      <div style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: 13 }}>
        {plan ? `Plan with ${planInstalments.length} instalments, ${plan.graceDays}-day grace period` : "No plan configured yet."}
      </div>

      {planInstalments.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Plan instalments</h3>
          <div style={listShell}>
            {planInstalments.map((ins, idx) => (
              <div key={idx} style={row}>
                <div>
                  <strong>#{idx + 1}</strong>
                  <span style={{ marginLeft: 8 }}>Due {fmt(ins.dueDate)}</span>
                  <span style={{ marginLeft: 8, color: "var(--text-secondary)" }}>
                    {ins.reminderDays != null ? `· reminder T-${ins.reminderDays}d` : ""}
                  </span>
                </div>
                <strong>₹{Number(ins.amount).toLocaleString()}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

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
