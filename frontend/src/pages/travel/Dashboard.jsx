// Travel CRM — Day 1 placeholder Dashboard.
//
// Lives at /travel for tenants with vertical="travel". The real Owner
// Dashboard (Phase 1 deliverable) replaces this once the diagnostic
// engine + itinerary builder land.
//
// For Day 1, this surface exists so the vertical is addressable end-to-end:
// - Login → vertical=travel → lands on /travel
// - Sidebar renders the travel nav skeleton
// - Theme overrides activate
//
// Anything below this comment block is intentionally minimal — it will
// be replaced by the real Owner Dashboard once Phase 1 cards land
// (TMC trips, RFU pilgrim queue, diagnostic completions, supplier P&L).
import { useContext } from "react";
import { AuthContext } from "../../App";
import { Compass, MapPin, FileText, AlertCircle } from "lucide-react";

export default function TravelDashboard() {
  const { user, tenant } = useContext(AuthContext) || {};

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <Compass size={28} aria-hidden /> Travel CRM
      </h1>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        {tenant?.name || "Travel Stall"} · {user?.name || user?.email}
      </p>

      <div
        role="status"
        style={{
          background: "var(--subtle-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 12,
          padding: 20,
          marginTop: 20,
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}
      >
        <AlertCircle size={20} aria-hidden style={{ color: "var(--warning-color)", flexShrink: 0, marginTop: 2 }} />
        <div>
          <strong>Phase 1 — Day 1 scaffolding.</strong>
          <p style={{ margin: "4px 0 0", color: "var(--text-secondary)" }}>
            This dashboard is a placeholder. The real Owner Dashboard ships in Phase 1 with
            diagnostic completion cards, TMC trip pipeline, RFU pilgrim queue, supplier P&amp;L,
            and KPI tiles. See{" "}
            <a
              href="https://github.com/Globussoft-Technologies/globussoft-crm/blob/main/docs/TRAVEL_CRM_PRD.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--primary-color)" }}
            >
              the PRD
            </a>{" "}
            for the Phase 1 deliverable list.
          </p>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
          gap: 16,
          marginTop: 24,
        }}
      >
        <PlaceholderCard
          icon={<MapPin size={24} aria-hidden />}
          title="Sub-brand workspace"
          body="Switch between TMC (school trips), RFU (Umrah), Travel Stall (family holidays), and Visa Sure (visa assurance) from the sidebar."
        />
        <PlaceholderCard
          icon={<FileText size={24} aria-hidden />}
          title="Diagnostic engine"
          body="Weighted-scoring questionnaires classify leads into tiers before any quote is shown. Phase 1 deliverable for TMC + RFU."
        />
        <PlaceholderCard
          icon={<Compass size={24} aria-hidden />}
          title="Itinerary builder"
          body="Polymorphic itinerary items (flight / hotel / transfer / activity / visa) backed by RateHawk + airline portals. Phase 1 deliverable."
        />
      </div>
    </div>
  );
}

function PlaceholderCard({ icon, title, body }) {
  return (
    <div
      style={{
        background: "var(--surface-color)",
        border: "1px solid var(--border-color)",
        borderRadius: 12,
        padding: 20,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, color: "var(--primary-color)" }}>
        {icon}
        <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
      </div>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.5 }}>{body}</p>
    </div>
  );
}
