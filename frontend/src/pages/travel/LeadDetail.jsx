// Travel CRM — Unified lead detail (contact-centric) page.
//
// Mounts at /travel/leads/:contactId. The Leads.jsx list routes the
// Title column to /deals/:id (the generic CRM deal page that knows
// nothing about sub-brand). This page is the travel-specific drilldown
// for a single Contact — it aggregates every travel artifact attached
// to that contact in one screen:
//
//   1. Header — contact identity (name / email / phone / company)
//      + cross-links to /contacts/:id (generic) and /travel/rfu/customers/:id
//      (only when at least one RFU diagnostic OR itinerary exists for the
//      contact — keeps the action cluster relevant per sub-brand context).
//   2. Diagnostics summary — most recent only, with classification +
//      recommended tier + a link to drill into the full diagnostic.
//      "+N more" link to /travel/diagnostics when total > 1.
//   3. Itineraries — read-only table; each row → /travel/itineraries/:id.
//   4. TMC trips — only rendered when ≥1 trip exists, since the section
//      is irrelevant for non-school contacts. Each row → /travel/trips/:id.
//
// Each fetch is in its own try/catch so partial data still renders.
// Page-level "Loading…" is only on the initial contact fetch; sub-
// sections lazy-load.
//
// Style constants (primaryBtn, secondaryBtn, iconBtn, th, td, etc.) are
// copied verbatim from ItineraryDetail.jsx so the look-and-feel stays
// consistent across the Travel surface.

import { useEffect, useState, useContext } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  UserCircle, Mail, Phone, Building, Tag, MapPin, Briefcase,
  ExternalLink, MessageSquareText,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const STATUS_COLORS = {
  draft: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  sent: { bg: "rgba(47,122,77,0.14)", color: "#2F7A4D" },
  revised: { bg: "rgba(200,154,78,0.16)", color: "#9A6F2E" },
  accepted: { bg: "rgba(38,88,85,0.16)", color: "#265855" },
  rejected: { bg: "rgba(168,50,63,0.14)", color: "#A8323F" },
  advance_paid: { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
  fully_paid: { bg: "rgba(38,88,85,0.22)", color: "#1F4644" },
  confirmed: { bg: "rgba(38,88,85,0.16)", color: "#265855" },
  "in-trip": { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
  completed: { bg: "rgba(47,122,77,0.14)", color: "#2F7A4D" },
  cancelled: { bg: "rgba(168,50,63,0.14)", color: "#A8323F" },
};

const TIER_COLORS = {
  entry: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  primary: { bg: "rgba(18,38,71,0.14)", color: "#122647" },
  premium: { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
};

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function fmtMoney(amt, currency = "INR") {
  if (amt == null || amt === "") return "—";
  const n = Number(amt);
  if (!Number.isFinite(n)) return "—";
  if (currency === "INR" && n >= 100000) {
    return `₹${(n / 100000).toFixed(2)}L`;
  }
  return `${currency === "INR" ? "₹" : currency + " "}${n.toLocaleString()}`;
}

function TierBadge({ tier }) {
  if (!tier) return <span style={{ color: "var(--text-secondary)" }}>—</span>;
  const tc = TIER_COLORS[tier] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
  return (
    <span style={{
      background: tc.bg, color: tc.color,
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {tier}
    </span>
  );
}

function StatusBadge({ status }) {
  if (!status) return <span style={{ color: "var(--text-secondary)" }}>—</span>;
  const sc = STATUS_COLORS[status] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
  return (
    <span style={{
      background: sc.bg, color: sc.color,
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {status}
    </span>
  );
}

function SubBrandBadge({ subBrand }) {
  if (!subBrand) return <span style={{ color: "var(--text-secondary)" }}>—</span>;
  return (
    <span style={{
      background: "var(--subtle-bg-3, var(--subtle-bg))", color: "var(--primary-color, var(--accent-color))",
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {subBrand}
    </span>
  );
}

export default function LeadDetail() {
  const { contactId } = useParams();
  const notify = useNotify();
  const navigate = useNavigate();
  useContext(AuthContext); // surface AuthContext to keep parity with sibling pages
                            // (no role-gated affordance on this page yet — read-only view).

  const [contact, setContact] = useState(null);
  const [contactLoading, setContactLoading] = useState(true);
  const [contactError, setContactError] = useState(null);

  const [diagnostics, setDiagnostics] = useState(null);
  const [diagTotal, setDiagTotal] = useState(0);
  const [diagError, setDiagError] = useState(null);

  const [itineraries, setItineraries] = useState(null);
  const [itinError, setItinError] = useState(null);

  const [trips, setTrips] = useState(null);
  const [tripsError, setTripsError] = useState(null);

  // ─── Contact (page-level required fetch) ────────────────────────────
  useEffect(() => {
    setContactLoading(true);
    setContactError(null);
    fetchApi(`/api/contacts/${contactId}`)
      .then((res) => setContact(res || null))
      .catch((e) => {
        setContactError(e?.body?.error || "Failed to load contact");
        notify.error(e?.body?.error || "Failed to load contact");
        setContact(null);
      })
      .finally(() => setContactLoading(false));
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Diagnostics (most-recent first, limit 5 — only top one rendered) ─
  useEffect(() => {
    setDiagError(null);
    fetchApi(`/api/travel/diagnostics?contactId=${contactId}&limit=5`)
      .then((res) => {
        setDiagnostics(Array.isArray(res?.diagnostics) ? res.diagnostics : []);
        setDiagTotal(Number(res?.total) || 0);
      })
      .catch((e) => {
        setDiagError(e?.body?.error || "Diagnostics unavailable");
        setDiagnostics([]);
      });
  }, [contactId]);

  // ─── Itineraries ─────────────────────────────────────────────────────
  useEffect(() => {
    setItinError(null);
    fetchApi(`/api/travel/itineraries?contactId=${contactId}&limit=20`)
      .then((res) => {
        setItineraries(Array.isArray(res?.itineraries) ? res.itineraries : []);
      })
      .catch((e) => {
        setItinError(e?.body?.error || "Itineraries unavailable");
        setItineraries([]);
      });
  }, [contactId]);

  // ─── TMC trips (schoolContactId, not contactId — see route doc) ─────
  useEffect(() => {
    setTripsError(null);
    fetchApi(`/api/travel/trips?schoolContactId=${contactId}&limit=20`)
      .then((res) => {
        setTrips(Array.isArray(res?.trips) ? res.trips : []);
      })
      .catch((e) => {
        // Trips endpoint 403s for users without TMC sub-brand access —
        // treat that as "no trips visible" rather than a hard error, since
        // a sales-CRM user can legitimately have a non-TMC contact.
        setTripsError(e?.body?.error || "Trips unavailable");
        setTrips([]);
      });
  }, [contactId]);

  if (contactLoading) {
    return <div style={{ padding: 24 }}>Loading&hellip;</div>;
  }
  if (contactError || !contact) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--danger-color, #A8323F)" }}>
          {contactError || "Contact not found."}
        </p>
        <Link to="/leads" style={dealLink}>← Back to leads</Link>
      </div>
    );
  }

  // Derive sub-brand presence to decide whether to show the RFU profile link.
  const hasRfu =
    (diagnostics || []).some((d) => d.subBrand === "rfu") ||
    (itineraries || []).some((it) => it.subBrand === "rfu");
  const latestDiag = diagnostics && diagnostics.length > 0 ? diagnostics[0] : null;
  const tripsToShow = trips || [];

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      {/* ─── Section 1: Header ────────────────────────────────────── */}
      <header style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
              <UserCircle size={28} aria-hidden /> {contact.name || `Contact #${contact.id}`}
            </h1>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 6, flexWrap: "wrap", color: "var(--text-secondary)", fontSize: 13 }}>
              {contact.email && (
                <span style={metaSpan}><Mail size={14} aria-hidden /> {contact.email}</span>
              )}
              {contact.phone && (
                <span style={metaSpan}><Phone size={14} aria-hidden /> {contact.phone}</span>
              )}
              {contact.company && (
                <span style={metaSpan}><Building size={14} aria-hidden /> {contact.company}</span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link to={`/contacts/${contact.id}`} style={{ ...secondaryBtn, textDecoration: "none" }}>
              <ExternalLink size={14} /> Open in CRM Contacts
            </Link>
            {hasRfu && (
              <Link to={`/travel/rfu/customers/${contact.id}`} style={{ ...secondaryBtn, textDecoration: "none" }}>
                <ExternalLink size={14} /> Open RFU profile
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* ─── Section: AI conversation history (from "Sync Lead") ──── */}
      {contact.description && (
        <section style={sectionStyle}>
          <div style={sectionHeader}>
            <h2 style={sectionTitle}><MessageSquareText size={16} aria-hidden /> Chat Summary</h2>
          </div>
          <div style={cardWrap}>
            <pre style={{
              margin: 0, padding: 16, whiteSpace: "pre-wrap", wordBreak: "break-word",
              fontFamily: "inherit", fontSize: 13, lineHeight: 1.6, color: "var(--text-primary)",
              maxHeight: 480, overflowY: "auto",
            }}>
              {contact.description}
            </pre>
          </div>
        </section>
      )}

      {/* ─── Section 2: Diagnostics summary ──────────────────────── */}
      <section style={sectionStyle}>
        <div style={sectionHeader}>
          <h2 style={sectionTitle}><Tag size={16} aria-hidden /> Latest diagnostic</h2>
          {diagTotal > 1 && (
            <Link to={`/travel/diagnostics?contactId=${contactId}`} style={{ ...dealLink, fontSize: 12 }}>
              +{diagTotal - 1} more →
            </Link>
          )}
        </div>
        <div style={cardWrap}>
          {diagError ? (
            <div style={emptyError}>Diagnostics unavailable: {diagError}</div>
          ) : !latestDiag ? (
            <div style={empty}>No diagnostic on file yet.</div>
          ) : (
            <div style={{ padding: 16, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <SubBrandBadge subBrand={latestDiag.subBrand} />
              {latestDiag.classificationLabel && (
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  {latestDiag.classificationLabel}
                </span>
              )}
              <TierBadge tier={latestDiag.recommendedTier} />
              {Number.isFinite(Number(latestDiag.score)) && (
                <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                  Score: <strong style={{ color: "var(--text-primary)" }}>{latestDiag.score}</strong>
                </span>
              )}
              <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: "auto" }}>
                Submitted {fmtDate(latestDiag.createdAt)}
              </span>
              <Link to={`/travel/diagnostics/${latestDiag.id}`} style={{ ...dealLink, fontSize: 13 }}>
                View diagnostic →
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* ─── Section 3: Itineraries table ─────────────────────────── */}
      <section style={sectionStyle}>
        <div style={sectionHeader}>
          <h2 style={sectionTitle}><MapPin size={16} aria-hidden /> Itineraries</h2>
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
            {(itineraries || []).length} {(itineraries || []).length === 1 ? "itinerary" : "itineraries"}
          </span>
        </div>
        <div style={cardWrap}>
          {itinError ? (
            <div style={emptyError}>Itineraries unavailable: {itinError}</div>
          ) : !itineraries || itineraries.length === 0 ? (
            <div style={empty}>No itineraries linked to this contact yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Destination</th>
                  <th style={th}>Sub-brand</th>
                  <th style={th}>Status</th>
                  <th style={th}>Dates</th>
                  <th style={thRight}>Total</th>
                </tr>
              </thead>
              <tbody>
                {itineraries.map((it) => (
                  <tr
                    key={it.id}
                    style={{ ...trStyle, cursor: "pointer" }}
                    onClick={() => navigate(`/travel/itineraries/${it.id}`)}
                    role="link"
                    aria-label={`Open itinerary ${it.destination || it.id}`}
                  >
                    <td style={td}><strong>{it.destination || `Itinerary #${it.id}`}</strong></td>
                    <td style={td}><SubBrandBadge subBrand={it.subBrand} /></td>
                    <td style={td}><StatusBadge status={it.status} /></td>
                    <td style={td}>{fmtDate(it.startDate)} → {fmtDate(it.endDate)}</td>
                    <td style={tdRight}>{fmtMoney(it.totalAmount, it.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ─── Section 4: TMC trips (only render if ≥1 trip exists) ── */}
      {tripsToShow.length > 0 && (
        <section style={sectionStyle}>
          <div style={sectionHeader}>
            <h2 style={sectionTitle}><Briefcase size={16} aria-hidden /> TMC Trips</h2>
            <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              {tripsToShow.length} {tripsToShow.length === 1 ? "trip" : "trips"}
            </span>
          </div>
          <div style={cardWrap}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Trip code</th>
                  <th style={th}>Destination</th>
                  <th style={th}>Status</th>
                  <th style={th}>Dates</th>
                  <th style={thRight}>Pax</th>
                </tr>
              </thead>
              <tbody>
                {tripsToShow.map((t) => (
                  <tr
                    key={t.id}
                    style={{ ...trStyle, cursor: "pointer" }}
                    onClick={() => navigate(`/travel/trips/${t.id}`)}
                    role="link"
                    aria-label={`Open trip ${t.tripCode || t.id}`}
                  >
                    <td style={td}><strong>{t.tripCode || `Trip #${t.id}`}</strong></td>
                    <td style={td}>{t.destination || "—"}</td>
                    <td style={td}><StatusBadge status={t.status} /></td>
                    <td style={td}>{fmtDate(t.departDate)} → {fmtDate(t.returnDate)}</td>
                    <td style={tdRight}>{t?._count?.participants ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {/* Suppress the unused-error lint when trips section is hidden — */}
      {/* still expose the error inline if it's a real problem AND the */}
      {/* user has any RFU/TMC evidence elsewhere so we don't pollute */}
      {/* generic contact views with a "trips unavailable" line. */}
      {tripsToShow.length === 0 && tripsError && hasRfu && (
        <div style={{ ...empty, marginTop: 12 }}>Trips unavailable: {tripsError}</div>
      )}
    </div>
  );
}

// ─── Style constants (copied verbatim from ItineraryDetail.jsx) ──────
const sectionStyle = { marginBottom: 24 };
const sectionHeader = {
  display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8,
};
const sectionTitle = {
  margin: 0, fontSize: 16, display: "inline-flex", alignItems: "center", gap: 6,
};
const cardWrap = {
  background: "var(--surface-color)", borderRadius: 8,
  border: "1px solid var(--border-color)", overflow: "hidden",
};
const metaSpan = { display: "inline-flex", alignItems: "center", gap: 4 };
const empty = { padding: 24, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const emptyError = { padding: 24, textAlign: "center", color: "var(--danger-color, #A8323F)", fontSize: 13 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const thRight = { ...th, textAlign: "right" };
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const tdRight = { ...td, textAlign: "right" };
const trStyle = { borderTop: "1px solid var(--border-light)" };
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const dealLink = {
  color: "var(--primary-color, var(--accent-color))", textDecoration: "none", fontWeight: 600,
  display: "inline-flex", alignItems: "center", gap: 4,
};
