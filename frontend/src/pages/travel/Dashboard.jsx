// Travel CRM — Owner Dashboard.
//
// Lives at /travel for tenants with vertical="travel". KPI grid backed by
// the GET /api/travel/dashboard aggregate (one round-trip). Sub-brand
// scoping happens server-side via the caller's subBrandAccess — a TMC-ops
// user only sees TMC counts; admins see everything.
//
// Tiles (each is a small card):
//   - Active trips      total + by-status row + upcoming-30d highlight
//   - Diagnostics 30d   total + classification breakdown
//   - Itineraries       total + by-status row
//   - Microsites        published + expired
//   - Cost master       active rows + by-subBrand breakdown
//   - Pricing rules     seasons + markup rules
//
// Plus a "Recent trips" panel below with the newest 5 trips and quick
// links into the detail page.

import { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle, BadgePercent, Calendar as CalendarIcon,
  ClipboardCheck, Compass, IndianRupee, FileText, Globe, Luggage,
  Map as MapIcon, RefreshCw,
} from "lucide-react";
import { AuthContext } from "../../App";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

export default function TravelDashboard() {
  const { user, tenant } = useContext(AuthContext) || {};
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetchApi("/api/travel/dashboard")
      .then(setData)
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load dashboard");
        setData(null);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <Compass size={28} aria-hidden /> Travel CRM
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0 }}>
            {tenant?.name || "Travel Stall"} · {user?.name || user?.email}
          </p>
        </div>
        <button type="button" onClick={load} style={refreshBtn} aria-label="Refresh dashboard">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {loading && !data ? (
        <div style={loadingBox}>Loading dashboard&hellip;</div>
      ) : !data ? (
        <div style={errorBox}>
          <AlertCircle size={18} aria-hidden style={{ color: "var(--warning-color)" }} />
          <span>Dashboard data is unavailable. Try refreshing.</span>
        </div>
      ) : (
        <>
          <div style={gridStyle}>
            <Tile
              icon={Luggage}
              label="Active trips"
              value={data.trips.total}
              footer={byKeyFooter(data.trips.byStatus)}
              accent={`${data.trips.upcoming30d} departing in 30 days`}
              link="/travel/trips"
            />
            <Tile
              icon={ClipboardCheck}
              label="Diagnostics (last 30 days)"
              value={data.diagnostics.totalLast30d}
              footer={byKeyFooter(data.diagnostics.byClassification)}
              link="/travel/diagnostics"
            />
            <Tile
              icon={MapIcon}
              label="Itineraries"
              value={data.itineraries.total}
              footer={byKeyFooter(data.itineraries.byStatus)}
              link="/travel/itineraries"
            />
            <Tile
              icon={Globe}
              label="Microsites"
              value={data.microsites.published}
              footer={
                data.microsites.expired > 0
                  ? `${data.microsites.expired} expired`
                  : "all current"
              }
            />
            <Tile
              icon={IndianRupee}
              label="Cost master (active rates)"
              value={data.costMaster.activeRows}
              footer={byKeyFooter(data.costMaster.bySubBrand)}
              link="/travel/cost-master"
            />
            <Tile
              icon={BadgePercent}
              label="Pricing rules"
              value={data.pricingRules.seasons + data.pricingRules.markupRules}
              footer={`${data.pricingRules.seasons} seasons · ${data.pricingRules.markupRules} markup rules`}
              link="/travel/pricing-rules"
            />
          </div>

          <section style={{ ...card, marginTop: 16 }}>
            <h2 style={sectionTitle}>
              <CalendarIcon size={18} aria-hidden style={{ marginRight: 6, verticalAlign: -3 }} />
              Recent trips
            </h2>
            {data.recentTrips.length === 0 ? (
              <div style={empty}>No trips yet. Create one via <code>POST /api/travel/trips</code> or the Trips page.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Trip</th>
                    <th style={th}>Destination</th>
                    <th style={th}>Departs</th>
                    <th style={th}>Returns</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.recentTrips || []).map((t) => (
                    <tr key={t.id} style={trStyle}>
                      <td style={td}>
                        <Link to={`/travel/trips/${t.id}`} style={tripLink}>
                          <code>{t.tripCode}</code>
                        </Link>
                      </td>
                      <td style={td}>{t.destination}</td>
                      <td style={td}>{fmtDate(t.departDate)}</td>
                      <td style={td}>{fmtDate(t.returnDate)}</td>
                      <td style={td}><span style={statusBadge(t.status)}>{t.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p style={{ marginTop: 16, fontSize: 12, color: "var(--text-secondary)" }}>
            <FileText size={12} aria-hidden style={{ marginRight: 4, verticalAlign: -1 }} />
            Sub-brand scope, RBAC, and PII gates apply server-side. Drill into the linked surfaces above to see participant-level detail.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Building blocks ────────────────────────────────────────────────

function Tile({ icon: Icon, label, value, footer, accent, link }) {
  const content = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13, fontWeight: 600 }}>
        <Icon size={16} aria-hidden /> {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, marginTop: 6, color: "var(--text-primary)" }}>
        {value ?? 0}
      </div>
      {accent && (
        <div style={{ fontSize: 12, color: "var(--primary-color)", marginTop: 2 }}>{accent}</div>
      )}
      {footer && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8, lineHeight: 1.5 }}>
          {footer}
        </div>
      )}
    </>
  );
  if (link) {
    return (
      <Link to={link} style={{ ...tileStyle, ...tileLinkStyle }}>
        {content}
      </Link>
    );
  }
  return <div style={tileStyle}>{content}</div>;
}

function byKeyFooter(obj) {
  if (!obj || Object.keys(obj).length === 0) return null;
  const entries = Object.entries(obj).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function statusBadge(status) {
  const base = {
    padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
  switch (status) {
    case "confirmed":
      return { ...base, background: "var(--subtle-bg-2)", color: "var(--success-color)" };
    case "in-trip":
      return { ...base, background: "var(--subtle-bg-3)", color: "var(--primary-color)" };
    case "completed":
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-secondary)" };
    case "cancelled":
      return { ...base, background: "var(--subtle-bg)", color: "var(--danger-color)" };
    default:
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-secondary)" };
  }
}

// ─── Styles ─────────────────────────────────────────────────────────

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: 12,
  marginTop: 20,
};
const tileStyle = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  borderRadius: 12,
  padding: 16,
  boxShadow: "var(--shadow-sm)",
};
const tileLinkStyle = {
  textDecoration: "none",
  color: "inherit",
  display: "block",
  cursor: "pointer",
  transition: "transform 0.1s, box-shadow 0.1s",
};
const card = {
  background: "var(--surface-color)",
  borderRadius: 12,
  border: "1px solid var(--border-color)",
  padding: 16,
};
const sectionTitle = {
  margin: "0 0 12px",
  fontSize: 16,
  display: "flex",
  alignItems: "center",
};
const refreshBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 500, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-secondary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const loadingBox = {
  padding: 40, textAlign: "center",
  color: "var(--text-secondary)",
  background: "var(--subtle-bg)",
  borderRadius: 12, marginTop: 20,
};
const errorBox = {
  marginTop: 20, padding: 16, borderRadius: 12,
  background: "var(--subtle-bg)",
  border: "1px solid var(--border-color)",
  display: "flex", alignItems: "center", gap: 10,
  color: "var(--text-secondary)", fontSize: 14,
};
const empty = {
  padding: 24, textAlign: "center",
  color: "var(--text-secondary)", fontSize: 14,
};
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const trStyle = { borderTop: "1px solid var(--border-light)" };
const tripLink = {
  color: "var(--primary-color)", textDecoration: "none", fontWeight: 600,
};
