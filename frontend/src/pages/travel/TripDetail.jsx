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
  MapPin, IndianRupee, FileText, CheckCircle2, AlertCircle, Clock, TrendingUp,
  Sparkles, ArrowRight,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const TABS = [
  { key: "overview", label: "Overview", icon: Luggage },
  // Per decision #7, Participants is the SINGLE home for both
  // PendingTripRegistration drafts (DRAFT / OTP_VERIFIED / REJECTED)
  // AND actual TripParticipant rows (pending / approved / rejected /
  // waitlisted). No separate "Pending Registrations" tab.
  { key: "participants", label: "Participants", icon: Users },
  { key: "rooming", label: "Rooming", icon: BedDouble },
  { key: "payment", label: "Payment plan", icon: Wallet },
  // Per decision #10, the Trip is the single owner of the public
  // experience — the tab now surfaces BOTH the LandingPage (marketing
  // + registration draft collection) AND the Microsite (secure
  // operational portal). Tab key stays "microsite" for URL back-compat.
  { key: "microsite", label: "Public Experience", icon: Globe },
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

      {tab === "overview" && <OverviewTab trip={trip} onJump={setTab} />}
      {tab === "participants" && <ParticipantsTab trip={trip} onChange={load} notify={notify} />}
      {tab === "rooming" && <RoomingTab trip={trip} notify={notify} />}
      {tab === "payment" && <PaymentTab trip={trip} notify={notify} />}
      {tab === "microsite" && <MicrositeTab trip={trip} onChange={load} notify={notify} />}
    </div>
  );
}

// ─── Overview tab ────────────────────────────────────────────────────
//
// Wires up the /trips/:id/ops-dashboard endpoint (already exists, returns
// departureReadiness score + component %s + payment buckets + rooming/doc
// rollups) so the overview shows live trip health rather than 9 static
// labels. Cards are clickable — clicking jumps to the relevant tab.

function OverviewTab({ trip, onJump }) {
  const [ops, setOps] = useState(null);

  // silent:true — ops-dashboard is an enhancement, not a requirement.
  // If it 404s on a not-yet-confirmed trip the page falls back to plain
  // trip data instead of red-toasting.
  useEffect(() => {
    fetchApi(`/api/travel/trips/${trip.id}/ops-dashboard`, { silent: true })
      .then(setOps)
      .catch(() => setOps(null));
  }, [trip.id]);

  const participants = trip.participants || [];
  const partCount = participants.length;
  const docCount = (trip.documentRequirements || []).length;
  const score = ops?.departureReadiness?.score;
  const comp = ops?.departureReadiness?.components || {};
  const pay = ops?.payments;
  const room = ops?.rooming;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Hero band — destination + dates + readiness gauge */}
      <div style={{
        background: "var(--surface-color)", border: "1px solid var(--border-color)",
        borderRadius: 12, padding: 20,
        display: "grid", gap: 16,
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
        alignItems: "center",
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", marginBottom: 6 }}>
            <MapPin size={14} aria-hidden /> Destination
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{trip.destination || "—"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontSize: 13, color: "var(--text-secondary)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <CalendarIcon size={13} aria-hidden /> {fmt(trip.departDate)} → {fmt(trip.returnDate)}
            </span>
            {trip.legalEntity && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <FileText size={13} aria-hidden /> {trip.legalEntity}
              </span>
            )}
            {trip.pricePerStudent != null && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontVariantNumeric: "tabular-nums" }}>
                <IndianRupee size={13} aria-hidden /> {Number(trip.pricePerStudent).toLocaleString()} / student
              </span>
            )}
          </div>
        </div>
        <ReadinessGauge score={score} components={comp} />
      </div>

      {/* KPI strip — participants / docs / status */}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}>
        <KpiCard
          icon={Users}
          label="Participants"
          value={partCount}
          hint={(() => {
            // Prefer the application-status breakdown when the ops-dashboard
            // call has returned it (server-computed). Fall back to consent
            // count for pre-ops-dashboard states, then to a friendly empty
            // hint when no participants have registered yet.
            const pr = ops?.participants;
            if (pr && typeof pr.approved === "number") {
              const bits = [];
              if (pr.approved) bits.push(`${pr.approved} approved`);
              if (pr.pendingReview) bits.push(`${pr.pendingReview} pending`);
              if (pr.rejected) bits.push(`${pr.rejected} rejected`);
              if (bits.length) return bits.join(" · ");
            }
            if (ops?.participants?.capturedConsent != null) {
              return `${ops.participants.capturedConsent} consent captured`;
            }
            return partCount === 0 ? "Add the first one" : null;
          })()}
          onClick={() => onJump?.("participants")}
        />
        <KpiCard
          icon={FileText}
          label="Required docs"
          value={docCount}
          hint={docCount === 0 ? "None required yet" : `${ops?.documents?.submittedCount ?? 0} submitted`}
        />
        <KpiCard
          icon={CheckCircle2}
          label="Trip status"
          value={(trip.status || "—").toUpperCase()}
          hint={ops?.computedAt ? "Live rollup" : "—"}
          tone={trip.status}
        />
      </div>

      {/* Payment band — wider visualisation */}
      <SummaryBand
        icon={Wallet}
        title="Payment plan"
        onClick={() => onJump?.("payment")}
        status={trip.paymentPlan ? "Configured" : "Not set yet"}
        statusTone={trip.paymentPlan ? "good" : "warn"}
      >
        {pay && pay.expectedTotalRupees > 0 ? (
          <PaymentBand pay={pay} />
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {trip.paymentPlan
              ? "Plan set — instalments will materialise once participants are linked."
              : "No payment plan yet. Open Payment plan tab to create one."}
          </div>
        )}
      </SummaryBand>

      {/* Rooming band */}
      <SummaryBand
        icon={BedDouble}
        title="Rooming"
        onClick={() => onJump?.("rooming")}
        status={room?.assignmentCount ? `${room.assignmentCount} room${room.assignmentCount === 1 ? "" : "s"}` : "No rooms yet"}
        statusTone={room?.assignmentCount ? "good" : "muted"}
      >
        {room && partCount > 0 ? (
          <RoomingBand room={room} totalParticipants={partCount} pct={comp.roomingPct} />
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {partCount === 0 ? "Add participants first, then assign rooms." : "No rooming assignments yet."}
          </div>
        )}
      </SummaryBand>

      {/* Public Experience band — landing page + microsite live under
          one tab per decision #10; the Overview band keeps the existing
          status pill (driven by microsite presence) for back-compat. */}
      <SummaryBand
        icon={Globe}
        title="Public Experience"
        onClick={() => onJump?.("microsite")}
        status={trip.microsite ? "Published" : "Not published"}
        statusTone={trip.microsite ? "good" : "muted"}
      >
        {trip.microsite ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={14} aria-hidden style={{ color: "var(--primary-color)" }} />
            Public itinerary live at <code style={{ fontSize: 12, color: "var(--text-primary)" }}>{trip.microsite.subdomain || trip.microsite.publicUuid}</code>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Publish a public registration page that parents can use to sign their children up for this trip.
          </div>
        )}
      </SummaryBand>
    </div>
  );
}

function ReadinessGauge({ score, components }) {
  // score === null when insufficient data (no participants OR no expected
  // payments). Show "Insufficient data" rather than a fabricated 0%.
  const hasScore = typeof score === "number";
  const color = !hasScore ? "var(--text-secondary)"
    : score >= 80 ? "#2F7A4D"
    : score >= 50 ? "#9A6F2E"
    : "#A8323F";
  const ringPct = hasScore ? score : 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{
        position: "relative", width: 96, height: 96, flexShrink: 0,
        borderRadius: "50%",
        background: `conic-gradient(${color} ${ringPct * 3.6}deg, var(--subtle-bg) 0)`,
      }}>
        <div style={{
          position: "absolute", inset: 6, borderRadius: "50%",
          background: "var(--surface-color)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
            {hasScore ? score : "—"}
          </div>
          {hasScore && <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>%</div>}
        </div>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
          <TrendingUp size={13} aria-hidden /> Departure readiness
        </div>
        {hasScore ? (
          <div style={{ display: "grid", gap: 4, fontSize: 11 }}>
            <MiniBar label="Consent" pct={components.consentPct} />
            <MiniBar label="Docs" pct={components.docsPct} />
            <MiniBar label="Payment" pct={components.paymentPct} />
            <MiniBar label="Rooming" pct={components.roomingPct} />
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Add participants and a payment plan to compute readiness.
          </div>
        )}
      </div>
    </div>
  );
}

function MiniBar({ label, pct }) {
  const v = typeof pct === "number" ? pct : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 32px", alignItems: "center", gap: 6 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ background: "var(--subtle-bg)", borderRadius: 3, height: 6, overflow: "hidden" }}>
        <span style={{ display: "block", width: `${v}%`, height: "100%", background: "var(--primary-color)" }} />
      </span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{v}%</span>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, hint, onClick, tone }) {
  const interactive = typeof onClick === "function";
  const toneColor =
    tone === "completed" ? "#265855" :
    tone === "confirmed" ? "#2F7A4D" :
    tone === "in-trip" ? "#9A6F2E" :
    tone === "cancelled" ? "#A8323F" :
    "var(--text-primary)";
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      style={{
        textAlign: "left", width: "100%",
        background: "var(--surface-color)", border: "1px solid var(--border-color)",
        borderRadius: 10, padding: 14,
        cursor: interactive ? "pointer" : "default",
        transition: "border-color 120ms, transform 120ms",
        color: "inherit",
      }}
      onMouseEnter={(e) => {
        if (interactive) e.currentTarget.style.borderColor = "var(--primary-color)";
      }}
      onMouseLeave={(e) => {
        if (interactive) e.currentTarget.style.borderColor = "var(--border-color)";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon size={13} aria-hidden /> {label}
        </span>
        {interactive && <ArrowRight size={12} aria-hidden style={{ opacity: 0.5 }} />}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: toneColor, lineHeight: 1.1 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>{hint}</div>}
    </button>
  );
}

function SummaryBand({ icon: Icon, title, status, statusTone, children, onClick }) {
  const interactive = typeof onClick === "function";
  const bg =
    statusTone === "good" ? "rgba(47,122,77,0.14)" :
    statusTone === "warn" ? "rgba(200,154,78,0.18)" :
    "var(--subtle-bg)";
  const fg =
    statusTone === "good" ? "#2F7A4D" :
    statusTone === "warn" ? "#9A6F2E" :
    "var(--text-secondary)";
  return (
    <div
      onClick={interactive ? onClick : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      style={{
        background: "var(--surface-color)", border: "1px solid var(--border-color)",
        borderRadius: 10, padding: 14,
        cursor: interactive ? "pointer" : "default",
        transition: "border-color 120ms",
      }}
      onMouseEnter={(e) => { if (interactive) e.currentTarget.style.borderColor = "var(--primary-color)"; }}
      onMouseLeave={(e) => { if (interactive) e.currentTarget.style.borderColor = "var(--border-color)"; }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600 }}>
          <Icon size={16} aria-hidden style={{ color: "var(--primary-color)" }} /> {title}
        </div>
        <span style={{ background: bg, color: fg, padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
          {status}
        </span>
      </div>
      {children}
    </div>
  );
}

function PaymentBand({ pay }) {
  const pct = pay.expectedTotalRupees > 0
    ? Math.min(100, Math.round((pay.receivedRupees / pay.expectedTotalRupees) * 100))
    : 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <span style={{ color: "var(--text-secondary)" }}>
          ₹{pay.receivedRupees.toLocaleString()} <span style={{ opacity: 0.7 }}>of</span> ₹{pay.expectedTotalRupees.toLocaleString()} received
        </span>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{pct}%</strong>
      </div>
      <div style={{ background: "var(--subtle-bg)", borderRadius: 4, height: 8, overflow: "hidden", marginBottom: 10 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--primary-color)" }} />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
        <PayChip icon={CheckCircle2} count={pay.paidCount} label="paid" color="#2F7A4D" />
        <PayChip icon={Clock} count={pay.partialCount} label="partial" color="#9A6F2E" />
        <PayChip icon={Clock} count={pay.pendingCount} label="pending" color="var(--text-secondary)" />
        <PayChip icon={AlertCircle} count={pay.overdueCount} label="overdue" color="#A8323F" />
      </div>
    </div>
  );
}

function PayChip({ icon: Icon, count, label, color }) {
  if (!count) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600,
      border: `1px solid ${color}`, color,
      background: "var(--surface-color)",
    }}>
      <Icon size={11} aria-hidden /> {count} {label}
    </span>
  );
}

function RoomingBand({ room, totalParticipants, pct }) {
  const roomed = room.participantsRoomed || 0;
  const unroomed = room.participantsUnroomed || 0;
  const ringPct = typeof pct === "number" ? pct : (totalParticipants > 0 ? Math.round((roomed / totalParticipants) * 100) : 0);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <span style={{ color: "var(--text-secondary)" }}>
          {roomed} <span style={{ opacity: 0.7 }}>of</span> {totalParticipants} participant{totalParticipants === 1 ? "" : "s"} assigned
          {unroomed > 0 && <> · <strong style={{ color: "#9A6F2E" }}>{unroomed} unassigned</strong></>}
        </span>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{ringPct}%</strong>
      </div>
      <div style={{ background: "var(--subtle-bg)", borderRadius: 4, height: 8, overflow: "hidden" }}>
        <div style={{ width: `${ringPct}%`, height: "100%", background: "var(--primary-color)" }} />
      </div>
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

// Application-status pill colours mirror the Overview KPI hint colours so an
// operator's eye can track a single visual language across both surfaces.
const APP_STATUS_STYLES = {
  pending:    { label: "PENDING REVIEW", bg: "rgba(200,154,78,0.18)", color: "#9A6F2E" },
  approved:   { label: "APPROVED",       bg: "rgba(47,122,77,0.14)",  color: "#2F7A4D" },
  rejected:   { label: "REJECTED",       bg: "rgba(168,50,63,0.14)",  color: "#A8323F" },
  waitlisted: { label: "WAITLISTED",     bg: "rgba(38,88,85,0.16)",   color: "#265855" },
};

function StatusPill({ status }) {
  const s = APP_STATUS_STYLES[status] || APP_STATUS_STYLES.pending;
  return (
    <span style={{
      background: s.bg, color: s.color,
      padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600,
      letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>{s.label}</span>
  );
}

function ParticipantsTab({ trip, onChange, notify }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ fullName: "", parentName: "", parentPhone: "" });
  // Tracks which participant row currently has an approve / reject call in
  // flight so we can disable BOTH buttons on that row (avoid double-click
  // races) without disabling everyone else's controls.
  const [decidingId, setDecidingId] = useState(null);
  // Phase 8 — pending registrations (PendingTripRegistration rows
  // surfaced alongside participants per decision #7). Fetched on
  // mount + after every approve/reject so the unified list stays
  // current. The composite row key uses a "reg:" / "participant:"
  // prefix so React doesn't collide on id since the two tables share
  // an autoincrement keyspace.
  const [pendingRegs, setPendingRegs] = useState([]);
  const [decidingRegId, setDecidingRegId] = useState(null);

  const loadPendingRegs = useCallback(async () => {
    try {
      const rows = await fetchApi(`/api/travel/trips/${trip.id}/registrations`);
      setPendingRegs(Array.isArray(rows) ? rows : []);
    } catch (_e) {
      // Non-fatal — the unified list still shows participants
      setPendingRegs([]);
    }
  }, [trip.id]);

  useEffect(() => {
    loadPendingRegs();
  }, [loadPendingRegs]);

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

  // Approve / reject a participant's registration. Uses dedicated POST
  // endpoints (not PATCH) so the audit trail captures the decision cleanly
  // and the workflow engine can hook off the verb later.
  const decide = async (pid, action) => {
    if (action === "reject") {
      const ok = await notify.confirm({
        title: "Reject application",
        message: "Mark this participant as rejected? You can re-approve later if needed.",
        confirmText: "Reject",
        destructive: true,
      });
      if (!ok) return;
    }
    setDecidingId(pid);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/participants/${pid}/${action}`, {
        method: "POST",
      });
      notify.success(action === "approve" ? "Application approved" : "Application rejected");
      onChange();
    } catch (e) {
      notify.error(e?.body?.error || `Failed to ${action}`);
    } finally {
      setDecidingId(null);
    }
  };

  // Phase 8 — approve / reject a PendingTripRegistration. Uses the
  // /registrations/:rid/approve|reject endpoints from Phase 5. Approve
  // creates a TripParticipant{applicationStatus:"approved"} server-
  // side (decision #8 — no second approval workflow), so we refresh
  // BOTH the parent trip (to get the new participant row) AND the
  // pending-registration list (to reflect status=CONVERTED).
  const decideRegistration = async (rid, action) => {
    if (action === "reject") {
      const ok = await notify.confirm({
        title: "Reject registration",
        message: "Mark this registration as rejected? It will be removed from the review queue.",
        confirmText: "Reject",
        destructive: true,
      });
      if (!ok) return;
    }
    setDecidingRegId(rid);
    try {
      await fetchApi(`/api/travel/trips/${trip.id}/registrations/${rid}/${action}`, {
        method: "POST",
      });
      notify.success(
        action === "approve"
          ? "Registration approved — added as a participant"
          : "Registration rejected",
      );
      // Refresh both lists in parallel
      await Promise.all([loadPendingRegs(), Promise.resolve(onChange?.())]);
    } catch (e) {
      notify.error(e?.body?.error || `Failed to ${action} registration`);
    } finally {
      setDecidingRegId(null);
    }
  };

  // Phase 8 — filter pending registrations to those still in the
  // review queue. CONVERTED drafts have already become participants;
  // they show up in trip.participants and shouldn't double-render here.
  // REJECTED drafts are kept visible so operators can see what got
  // declined (separately styled in the list).
  const reviewableRegs = pendingRegs.filter((r) => r.status !== "CONVERTED");

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 12, color: "var(--text-secondary)", fontSize: 13, flexWrap: "wrap" }}>
          <span>
            {trip.participants?.length || 0} participant{(trip.participants?.length || 0) === 1 ? "" : "s"}
          </span>
          {reviewableRegs.length > 0 && (
            <span data-testid="pending-regs-count" style={{ color: "var(--text-secondary)" }}>
              · {reviewableRegs.length} pending registration{reviewableRegs.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
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

      {/* Phase 8 — pending registrations from the landing-page wizard
          render above the participants list. Each row gets a status-
          aware presentation:
            DRAFT          → "Awaiting verification" (no actions; we're
                              still waiting on the parent's phone OTP)
            OTP_VERIFIED   → "Awaiting review" + Approve / Reject CTAs
            REJECTED       → grayed out; can be re-approved
          The list shares the same listShell + row styles as
          participants so they read as one continuous review surface. */}
      {reviewableRegs.length > 0 && (
        <div style={{ ...listShell, marginBottom: 12 }} data-testid="pending-registrations-list">
          <div style={{ padding: "8px 12px", fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid var(--border-color)" }}>
            Pending registrations
          </div>
          {reviewableRegs.map((r) => {
            const busy = decidingRegId === r.id;
            const isOtpVerified = r.status === "OTP_VERIFIED";
            const isRejected = r.status === "REJECTED";
            const pillStyle = isRejected
              ? { bg: "rgba(168,50,63,0.14)", color: "#A8323F", label: "REJECTED" }
              : isOtpVerified
                ? { bg: "rgba(154,111,46,0.18)", color: "#9A6F2E", label: "AWAITING REVIEW" }
                : { bg: "rgba(100,116,139,0.18)", color: "#64748b", label: "AWAITING VERIFICATION" };
            return (
              <div key={`reg:${r.id}`} style={{ ...row, opacity: isRejected ? 0.6 : 1 }} data-testid={`pending-reg-row-${r.id}`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>{r.studentName}</strong>
                    <span
                      style={{
                        background: pillStyle.bg, color: pillStyle.color,
                        fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                        padding: "2px 8px", borderRadius: 999, textTransform: "uppercase",
                      }}
                    >
                      {pillStyle.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2 }}>
                    {r.parentName && (
                      <span>
                        <span style={{ opacity: 0.7 }}>Parent</span> · {r.parentName}
                      </span>
                    )}
                    {r.parentPhone && <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.parentPhone}</span>}
                    {r.parentEmail && <span style={{ opacity: 0.85 }}>{r.parentEmail}</span>}
                  </div>
                  {r.reviewNotes && (
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", fontStyle: "italic", marginTop: 2 }}>
                      Note: {r.reviewNotes}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
                  {/* Approve is available for every registration that is
                      not already final. CONVERTED rows are filtered out
                      above; REJECTED rows stay visible so they can be
                      re-approved. The OTP gate was relaxed on the backend
                      because production tenants collect consent outside
                      the microsite OTP flow. */}
                  <button
                    type="button"
                    onClick={() => decideRegistration(r.id, "approve")}
                    disabled={busy}
                    data-testid={`approve-registration-${r.id}`}
                    style={{
                      ...secondaryBtn, padding: "5px 10px", fontSize: 12,
                      color: "#2F7A4D", borderColor: "rgba(47,122,77,0.4)",
                      opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer",
                    }}
                    aria-label={`Approve registration for ${r.studentName}`}
                  >
                    <CheckCircle2 size={13} aria-hidden /> Approve
                  </button>
                  {!isRejected && (
                    <button
                      type="button"
                      onClick={() => decideRegistration(r.id, "reject")}
                      disabled={busy}
                      data-testid={`reject-registration-${r.id}`}
                      style={{
                        ...secondaryBtn, padding: "5px 10px", fontSize: 12,
                        color: "#A8323F", borderColor: "rgba(168,50,63,0.4)",
                        opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer",
                      }}
                      aria-label={`Reject registration for ${r.studentName}`}
                    >
                      <AlertCircle size={13} aria-hidden /> Reject
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={listShell}>
        {(trip.participants || []).length === 0 ? (
          <div style={{ ...empty, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <Users size={28} aria-hidden style={{ opacity: 0.4 }} />
            <div>No participants yet</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Click <em>Add participant</em> above to enrol the first student.
            </div>
          </div>
        ) : (
          trip.participants.map((p) => {
            // Default to "pending" so legacy rows (pre-applicationStatus
            // column) read as pending review rather than as an unknown
            // status. The schema default already covers new rows.
            const status = p.applicationStatus || "pending";
            const isPending = status === "pending";
            const isApproved = status === "approved";
            const isRejected = status === "rejected";
            const busy = decidingId === p.id;
            return (
              <div key={p.id} style={row}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>{p.fullName}</strong>
                    <StatusPill status={status} />
                  </div>
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
                  {p.reviewNotes && (
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", fontStyle: "italic", marginTop: 2 }}>
                      Note: {p.reviewNotes}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
                  {/* Approve/Reject CTAs — visible only when an action makes sense.
                      Pending → both. Approved → "Reject" so a wrongly-approved
                      row can be reversed. Rejected → "Approve" so a re-review
                      is one click away. */}
                  {(isPending || isRejected) && (
                    <button
                      type="button"
                      onClick={() => decide(p.id, "approve")}
                      disabled={busy}
                      style={{
                        ...secondaryBtn, padding: "5px 10px", fontSize: 12,
                        color: "#2F7A4D", borderColor: "rgba(47,122,77,0.4)",
                        opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer",
                      }}
                      aria-label={`Approve ${p.fullName}`}
                    >
                      <CheckCircle2 size={13} aria-hidden /> Approve
                    </button>
                  )}
                  {(isPending || isApproved) && (
                    <button
                      type="button"
                      onClick={() => decide(p.id, "reject")}
                      disabled={busy}
                      style={{
                        ...secondaryBtn, padding: "5px 10px", fontSize: 12,
                        color: "#A8323F", borderColor: "rgba(168,50,63,0.4)",
                        opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer",
                      }}
                      aria-label={`Reject ${p.fullName}`}
                    >
                      <AlertCircle size={13} aria-hidden /> Reject
                    </button>
                  )}
                  <PassportCell participant={p} notify={notify} onChange={onChange} />
                  <button type="button" onClick={() => remove(p.id)} style={iconBtn} aria-label={`Remove ${p.fullName}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })
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
          <div style={{ ...empty, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <BedDouble size={28} aria-hidden style={{ opacity: 0.4 }} />
            <div>No rooming assignments yet</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Click <em>Add room</em> to start grouping participants into single, twin, triple or quad rooms.
            </div>
          </div>
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
    // silent:true on both — a fresh trip with no plan returns 404 on
    // payment-plan; the dedicated catch handles it. Without silent, fetchApi
    // would red-toast "Payment plan not found" before the catch runs.
    Promise.all([
      fetchApi(`/api/travel/trips/${trip.id}/payment-plan`, { silent: true }).catch(() => null),
      fetchApi(`/api/travel/trips/${trip.id}/instalments`, { silent: true }).then((r) => r?.instalments || []).catch(() => []),
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
            <div style={{ ...empty, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <Wallet size={28} aria-hidden style={{ opacity: 0.4 }} />
              <div>No instalments yet</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Click <em>Add instalment</em> below to schedule the first payment.
              </div>
            </div>
          ) : (
            <>
              {/* Column header row — only shown when instalments exist. */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "32px 1fr 1fr 130px 90px",
                gap: 8,
                padding: "8px 14px",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--text-secondary)",
                background: "var(--subtle-bg)",
                borderBottom: "1px solid var(--border-color)",
              }}>
                <span>#</span>
                <span>Due date</span>
                <span>Amount (₹)</span>
                <span>Reminder (days)</span>
                <span style={{ textAlign: "right" }}>Actions</span>
              </div>
              {editInstalments.map((ins, idx) => (
                <div key={idx} style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr 1fr 130px 90px",
                  gap: 8,
                  padding: "10px 14px",
                  alignItems: "center",
                  borderTop: idx === 0 ? "none" : "1px solid var(--border-light)",
                }}>
                  <strong style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)" }}>#{idx + 1}</strong>
                  <input
                    type="date"
                    value={toDateInput(ins.dueDate)}
                    onChange={(e) => updateInstalment(idx, { dueDate: e.target.value })}
                    style={{ ...input, width: "100%", boxSizing: "border-box" }}
                    aria-label={`Instalment ${idx + 1} due date`}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={ins.amount ?? ""}
                    onChange={(e) => updateInstalment(idx, { amount: e.target.value === "" ? "" : Number(e.target.value) })}
                    style={{ ...input, width: "100%", boxSizing: "border-box", fontVariantNumeric: "tabular-nums" }}
                    aria-label={`Instalment ${idx + 1} amount`}
                  />
                  <input
                    type="number"
                    min="0"
                    placeholder="blank = off"
                    value={ins.reminderDays ?? ""}
                    onChange={(e) => updateInstalment(idx, { reminderDays: e.target.value === "" ? null : Number(e.target.value) })}
                    style={{ ...input, width: "100%", boxSizing: "border-box" }}
                    aria-label={`Instalment ${idx + 1} reminder days before due`}
                    title="Days before dueDate to fire reminder (blank = no reminder)"
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
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
                </div>
              ))}
            </>
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
            <span style={{ fontSize: 13, color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span>
                Per participant: <strong style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                  ₹{total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </strong>
              </span>
              {(trip.participants || []).length > 0 && total > 0 && (
                <span style={{ opacity: 0.7 }}>
                  · × {trip.participants.length} = <strong style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                    ₹{(total * trip.participants.length).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </strong> gross
                </span>
              )}
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
          <div style={{ ...empty, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <Users size={24} aria-hidden style={{ opacity: 0.4 }} />
            <div>No per-participant instalments yet</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Once the plan is saved and participants are linked, individual instalments appear here.
            </div>
          </div>
        ) : (
          instalments.map((i) => {
            const participant = (trip.participants || []).find((p) => p.id === i.participantId);
            const name = participant?.fullName || `Participant #${i.participantId}`;
            const statusBg =
              i.status === "paid" ? "rgba(47,122,77,0.14)" :
              i.status === "partial" ? "rgba(200,154,78,0.18)" :
              i.status === "overdue" ? "rgba(168,50,63,0.14)" :
              "var(--subtle-bg)";
            const statusColor =
              i.status === "paid" ? "#2F7A4D" :
              i.status === "partial" ? "#9A6F2E" :
              i.status === "overdue" ? "#A8323F" :
              "var(--text-secondary)";
            return (
              <div key={i.id} style={row}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ fontSize: 14 }}>{name}</strong>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                    Instalment #{i.instalmentIndex + 1} · due {fmt(i.dueDate)}
                  </div>
                </div>
                <div style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    ₹{Number(i.amount).toLocaleString()}
                  </div>
                  <span style={{
                    background: statusBg, color: statusColor,
                    padding: "2px 8px", borderRadius: 10,
                    fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                  }}>
                    {i.status}
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

// Convert a LandingPage content payload (block-array or template object)
// into a pre-filled itinerary HTML string for the microsite editor.
// Prioritises explicit itineraryTimeline blocks; returns null when nothing
// usable is found so the caller can fall back to the placeholder.
function extractItineraryHtmlFromLandingPage(page) {
  if (!page) return null;
  let content;
  try {
    content = typeof page.content === "string" ? JSON.parse(page.content || "{}") : (page.content || {});
  } catch {
    return null;
  }

  // Block-based pages (legacy manual builder): array of components.
  if (Array.isArray(content)) {
    const timeline = content.find((c) => c?.type === "itineraryTimeline");
    const days = Array.isArray(timeline?.props?.days) ? timeline.props.days : [];
    if (days.length === 0) return null;
    return days
      .map((d) => {
        const bullets = Array.isArray(d.bullets) ? d.bullets.filter(Boolean) : [];
        const body = bullets.length ? `<ul>${bullets.map((b) => `<li>${escapeHtml(String(b))}</li>`).join("")}</ul>` : "<p>—</p>";
        return `<h2>Day ${Number(d.day) || 1}${d.title ? ` — ${escapeHtml(String(d.title))}` : ""}</h2>\n${body}`;
      })
      .join("\n");
  }

  // Template-driven pages (wanderlux-v1 and registered templates): object
  // with a sections[] array. Look for any section that carries days.
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const fromSection = sections.find((s) => s?.type === "itinerary" || Array.isArray(s?.days));
  const sectionDays = Array.isArray(fromSection?.days) ? fromSection.days : [];
  if (sectionDays.length > 0) {
    return sectionDays
      .map((d) => {
        const bullets = Array.isArray(d.bullets) ? d.bullets.filter(Boolean) : [d.description].filter(Boolean);
        const body = bullets.length ? `<ul>${bullets.map((b) => `<li>${escapeHtml(String(b))}</li>`).join("")}</ul>` : "<p>—</p>";
        return `<h2>Day ${Number(d.day) || 1}${d.title ? ` — ${escapeHtml(String(d.title))}` : ""}</h2>\n${body}`;
      })
      .join("\n");
  }

  return null;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Convert the structured suggestion returned by POST /itineraries/suggest
// into the HTML shape the microsite editor stores.
function suggestionToHtml(suggestion, destination) {
  const daySplit = Array.isArray(suggestion?.daySplit)
    ? suggestion.daySplit
    : (Array.isArray(suggestion?.days) ? suggestion.days : []);
  if (daySplit.length === 0) return "";
  return daySplit
    .map((day, idx) => {
      const items = Array.isArray(day?.items) ? day.items : [];
      const title = day?.title || (idx === 0 ? `Arrival in ${destination || ""}` : `Day ${idx + 1}`);
      const body = items.length
        ? `<ul>${items.map((it) => `<li>${escapeHtml(String(it.description || it.name || ""))}</li>`).join("")}</ul>`
        : "<p>—</p>";
      return `<h2>Day ${idx + 1} — ${escapeHtml(String(title))}</h2>\n${body}`;
    })
    .join("\n");
}

function tripDurationDays(trip) {
  if (!trip?.departDate || !trip?.returnDate) return 7;
  const ms = new Date(trip.returnDate) - new Date(trip.departDate);
  const days = Math.max(1, Math.floor(ms / 86400000) + 1);
  return days > 30 ? 30 : days;
}

async function generateItineraryHtml(trip, notify) {
  const destination = trip?.destination;
  if (!destination) {
    notify.error("Trip destination is required to generate an itinerary.");
    return null;
  }
  const days = tripDurationDays(trip);
  try {
    const res = await fetchApi(`/api/travel/itineraries/suggest`, {
      method: "POST",
      body: JSON.stringify({ destination, days, tier: "primary" }),
    });
    const html = suggestionToHtml(res?.suggestion, destination);
    if (!html) {
      notify.info("AI returned an empty itinerary — try editing the trip dates or destination.");
      return null;
    }
    return html;
  } catch (e) {
    notify.error(e?.body?.error || e?.message || "Failed to generate itinerary");
    return null;
  }
}

// Phase 8 — Public Experience tab. Per decision #10 the Trip owns
// BOTH the landing page (marketing + registration draft collection)
// AND the microsite (secure operational portal), so this tab now
// surfaces them as two stacked cards. The microsite card is the
// existing MicrositeTab content (no UX changes); the landing-page
// card is new and lets operators edit / preview / publish / copy URL
// from one place.
function MicrositeTab({ trip, onChange, notify }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <LandingPageCard trip={trip} notify={notify} />
      <MicrositeCard trip={trip} onChange={onChange} notify={notify} />
    </div>
  );
}

function MicrositeCard({ trip, onChange, notify }) {
  const ms = trip.microsite;
  if (ms) return <MicrositeEditor trip={trip} ms={ms} onChange={onChange} notify={notify} />;
  return <MicrositeCreate trip={trip} onChange={onChange} notify={notify} />;
}

// LandingPageCard — read-only summary + jump-out to the existing
// Landing Pages module. Per operator feedback we do NOT create,
// edit, AI-generate, or publish landing pages from this trip-detail
// surface — those flows all live in the existing /landing-pages
// module (sidebar). This card is a single source of truth for
// "which page (if any) is linked to this trip" plus a redirect.
//
// To link a landing page to a trip, the operator uses the
// "Link to TMC trip" picker in the Landing Pages builder. The schema
// link (LandingPage.tripId @unique) is what makes the
// registration-draft branch fire — without it the wizard submission
// falls back to the legacy lead-capture path.
function LandingPageCard({ trip, notify }) {
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await fetchApi(`/api/travel/trips/${trip.id}/landing-page`);
      setPage(p);
    } catch (e) {
      if (e?.status === 404 || e?.body?.code === "NOT_LINKED") {
        setPage(null);
      } else {
        notify.error(e?.body?.error || "Failed to load landing page");
      }
    } finally {
      setLoading(false);
    }
  }, [trip.id, notify]);

  useEffect(() => { load(); }, [load]);

  return (
    <div data-testid="landing-page-card">
      <h3 style={{ margin: "0 0 12px", fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
        <Globe size={16} aria-hidden /> Landing page
      </h3>
      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</div>
      ) : !page ? (
        <div style={{
          background: "linear-gradient(135deg, rgba(38,88,85,0.10), rgba(38,88,85,0.02))",
          border: "1px solid var(--border-color)", borderRadius: 10, padding: 14,
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: "var(--primary-color)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <Sparkles size={18} aria-hidden />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>
              No landing page linked yet
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Generate, edit, and publish landing pages in the Landing Pages module.
              Then use the &ldquo;Link to TMC trip&rdquo; picker on the page&apos;s editor
              to point it at <strong>{trip.tripCode}</strong>.
            </div>
          </div>
          <Link
            to="/landing-pages"
            data-testid="goto-landing-pages-link"
            style={{ ...primaryBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <ExternalLink size={14} aria-hidden /> Go to Landing Pages
          </Link>
        </div>
      ) : (
        <div style={{
          border: "1px solid var(--border-color)", borderRadius: 10, padding: 14,
          background: "var(--surface-color)",
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>{page.title}</strong>
              <StatusBadge status={page.status} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Edit, preview, publish, AI-generate — everything for this page happens in the Landing Pages module.
              Published landing pages appear at <code style={{ fontSize: 11 }}>/trips</code>.
            </div>
          </div>
          <Link
            to={`/landing-pages/builder/${page.id}`}
            data-testid="manage-landing-page-link"
            style={{ ...primaryBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Edit3 size={14} aria-hidden /> Manage in Landing Pages
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Create form (no microsite yet) ──────────────────────────────────

function MicrositeCreate({ trip, onChange, notify }) {
  const [subdomain, setSubdomain] = useState(`trip-${trip.tripCode}`);
  const [itineraryHtml, setItineraryHtml] = useState(ITINERARY_PLACEHOLDER);
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [prefillSource, setPrefillSource] = useState(null);

  // Pre-fill itinerary from the linked landing page when available.
  useEffect(() => {
    let cancelled = false;
    fetchApi(`/api/travel/trips/${trip.id}/landing-page`, { silent: true })
      .then((page) => {
        if (cancelled) return;
        const html = extractItineraryHtmlFromLandingPage(page);
        if (html) {
          setItineraryHtml(html);
          setPrefillSource(page.title ? `Prefilled from “${page.title}”` : "Prefilled from linked landing page");
        }
      })
      .catch(() => {
        // No linked landing page → keep placeholder.
      });
    return () => { cancelled = true; };
  }, [trip.id]);

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

  const handleAiGenerate = async () => {
    setAiBusy(true);
    const html = await generateItineraryHtml(trip, notify);
    if (html) {
      setItineraryHtml(html);
      setPrefillSource("Generated by AI");
    }
    setAiBusy(false);
  };

  return (
    <div style={{ background: "var(--surface-color)", border: "1px solid var(--border-color)", borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: "var(--primary-color)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <Sparkles size={20} aria-hidden />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Create a public registration page</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Pick a subdomain, fill the editor below, and hit Publish — parents and teachers get a shareable link where they can read the trip plan and register students.
          </div>
          {prefillSource && (
            <div style={{ fontSize: 11, color: "var(--primary-color)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
              <CheckCircle2 size={11} aria-hidden /> {prefillSource}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleAiGenerate}
            disabled={aiBusy}
            style={{ ...secondaryBtn, color: "var(--primary-color)", borderColor: "rgba(18,38,71,0.35)" }}
          >
            <Sparkles size={14} /> {aiBusy ? "Generating…" : "AI Generate itinerary"}
          </button>
          <button type="button" onClick={submit} disabled={saving} style={saving ? primaryBtnDisabled : primaryBtn}>
            <Save size={14} /> {saving ? "Publishing…" : "Publish public page"}
          </button>
        </div>
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
  const [aiBusy, setAiBusy] = useState(false);

  // Public-facing microsite is the rendered PAGE (PublicTripMicrosite, routed
  // at /p/tripmicrosite/:publicUuid) — NOT the raw JSON API endpoint. The page
  // fetches /api/travel/microsites/public/:uuid itself; linking parents at the
  // API would show them raw JSON.
  const publicUrl = `${window.location.origin}/p/tripmicrosite/${ms.publicUuid}`;
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

  const handleAiGenerate = async () => {
    setAiBusy(true);
    const html = await generateItineraryHtml(trip, notify);
    if (html) setItineraryHtml(html);
    setAiBusy(false);
  };

  return (
    <div style={{ background: "var(--surface-color)", border: "1px solid var(--border-color)", borderRadius: 12, padding: 16 }}>
      {/* Live-link hero: promotes the public URL and hosts the primary
          action buttons (Save / Unpublish / AI Generate) at the TOP of the
          card so operators don't have to scroll to the bottom to act. */}
      <div style={{
        background: "linear-gradient(135deg, rgba(38,88,85,0.12), rgba(38,88,85,0.04))",
        border: "1px solid var(--border-color)", borderRadius: 12, padding: 14,
        marginBottom: 16,
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: "var(--primary-color)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <Globe size={20} aria-hidden />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              background: "rgba(47,122,77,0.14)", color: "#2F7A4D",
              padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: 0.5,
            }}>
              <Sparkles size={10} aria-hidden /> Live
            </span>
            {ms.publishedAt && (
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                Published {fmt(ms.publishedAt)}
              </span>
            )}
            {ms.expiresAt && (
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                · expires {fmt(ms.expiresAt)}
              </span>
            )}
          </div>
          <div style={{
            fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            color: "var(--text-primary)", wordBreak: "break-all",
          }}>
            {publicUrl}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleAiGenerate}
            disabled={aiBusy || previewing}
            style={{ ...secondaryBtn, color: "var(--primary-color)", borderColor: "rgba(18,38,71,0.35)", opacity: aiBusy || previewing ? 0.5 : 1 }}
          >
            <Sparkles size={14} /> {aiBusy ? "Generating…" : "AI Generate itinerary"}
          </button>
          <button type="button" onClick={() => setPreviewing((p) => !p)} style={secondaryBtn}>
            {previewing ? <><Edit3 size={14} /> Edit</> : <><Eye size={14} /> Preview</>}
          </button>
          <button type="button" onClick={copy} style={secondaryBtn}>
            <Copy size={14} /> Copy
          </button>
          <a href={publicUrl} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn, textDecoration: "none" }}>
            <ExternalLink size={14} /> Open
          </a>
          <button type="button" onClick={save} disabled={saving || previewing} style={(saving || previewing) ? primaryBtnDisabled : primaryBtn}>
            <Save size={14} /> {saving ? "Saving…" : "Save changes"}
          </button>
          <button type="button" onClick={unpublish} disabled={unpublishing} style={dangerBtn}>
            <Trash2 size={14} /> {unpublishing ? "Unpublishing…" : "Unpublish"}
          </button>
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
