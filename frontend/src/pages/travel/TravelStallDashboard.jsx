/**
 * Travel Stall Dashboard — Phase 2 operator landing page (TS21)
 *
 * Operator-facing landing surface for the Travel Stall sub-brand (family
 * holidays). Lives at `/travel-stall` and is reachable by admin + manager
 * roles. Mirrors the structural shape of pages/travel/Dashboard.jsx (Travel
 * main dashboard) — 4 quick-action cards stacked in a responsive grid,
 * each CTA-ing into an existing route filtered by `subBrand=travelstall`.
 *
 * This is a SHELL scaffold per portal feature matrix row TS21. The 4
 * cards are placeholders that route to existing surfaces; no aggregate
 * API call yet (the equivalent of GET /api/travel/dashboard scoped to
 * Travel Stall does not exist as a dedicated endpoint — the wider
 * /api/travel/dashboard already returns sub-brand-aware counts that this
 * page will adopt in Cluster F follow-up).
 *
 * Cluster F integration target: this page becomes the host surface for
 * the voyagr CMS lead-capture form (PRD_RATEHAWK + future PRD_BOOKING).
 *
 * Sidebar group: "Travel Stall" under renderTravelNav() (admin + manager).
 */
import { useContext } from "react";
import { Link } from "react-router-dom";
import {
  Sparkles, UserPlus, MessageSquareHeart, Inbox as InboxIcon,
  BarChart3, ArrowRight,
} from "lucide-react";
import { AuthContext } from "../../App";

export default function TravelStallDashboard() {
  const { user, tenant } = useContext(AuthContext) || {};

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <Sparkles size={28} aria-hidden /> Travel Stall
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0 }}>
            Family holidays operator console
            {tenant?.name ? ` · ${tenant.name}` : ""}
            {user?.name || user?.email ? ` · ${user.name || user.email}` : ""}
          </p>
        </div>
        <div
          style={{
            display: "inline-block",
            padding: "0.25rem 0.75rem",
            borderRadius: 999,
            background: "rgba(255, 200, 100, 0.12)",
            border: "1px solid rgba(255, 200, 100, 0.25)",
            color: "var(--text-secondary)",
            fontSize: 12,
            letterSpacing: 0.3,
          }}
        >
          Phase 2 — TS21 scaffold
        </div>
      </div>

      <p style={{ color: "var(--text-secondary)", marginTop: 16, marginBottom: 0, fontSize: 14, lineHeight: 1.5 }}>
        Quick access to the surfaces operators use most for the Travel Stall
        sub-brand. Each card routes to the relevant existing module with the
        sub-brand filter pre-applied.
      </p>

      <div style={gridStyle}>
        <Card
          icon={UserPlus}
          label="Quick lead capture"
          description="Log a new family-holiday inquiry from a walk-in, call, or social DM."
          cta="Open Leads"
          link="/travel/leads?subBrand=travelstall"
        />
        <Card
          icon={MessageSquareHeart}
          label="Family quiz responses"
          description="Review responses from the family-fit diagnostic quiz and convert qualified replies into leads."
          cta="Open Diagnostics"
          link="/travel/diagnostics?subBrand=travelstall"
        />
        <Card
          icon={InboxIcon}
          label="Active inquiries"
          description="Work the live inquiry inbox — assign, reply, and progress conversations to itinerary stage."
          cta="Open Inbox"
          link="/inbox"
        />
        <Card
          icon={BarChart3}
          label="Operator stats"
          description="Travel Stall conversion, response-time, and revenue snapshots for the period."
          cta="Open Reports"
          link="/travel/reports?subBrand=travelstall"
        />
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: "var(--text-secondary)" }}>
        Travel Stall surfaces share data with the broader Travel CRM — sub-brand
        scope, RBAC, and PII gates apply server-side. The dedicated lead-capture
        form (voyagr CMS embed) lands in the Cluster F integration follow-up.
      </p>
    </div>
  );
}

// ─── Building blocks ────────────────────────────────────────────────

function Card({ icon: Icon, label, description, cta, link }) {
  return (
    <Link to={link} style={{ ...cardStyle, ...cardLinkStyle }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13, fontWeight: 600 }}>
        <Icon size={16} aria-hidden /> {label}
      </div>
      <p style={{ marginTop: 8, marginBottom: 12, fontSize: 13, lineHeight: 1.5, color: "var(--text-primary)" }}>
        {description}
      </p>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--primary-color, var(--accent-color))",
        }}
      >
        {cta} <ArrowRight size={14} aria-hidden />
      </div>
    </Link>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: 12,
  marginTop: 20,
};
const cardStyle = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  borderRadius: 12,
  padding: 16,
  boxShadow: "var(--shadow-sm)",
};
const cardLinkStyle = {
  textDecoration: "none",
  color: "inherit",
  display: "block",
  cursor: "pointer",
  transition: "transform 0.1s, box-shadow 0.1s",
};
