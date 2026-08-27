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
//   - Landing pages     total + published
//   - Cost master       active rows + by-subBrand breakdown
//   - Pricing rules     seasons + markup rules
//   - Web check-ins     total + pending/done/missed breakdown
//
// Plus a "Recent trips" panel below with the newest 5 trips and quick
// links into the detail page, and — for MANAGER/ADMIN — a "Team workload"
// panel backed by GET /api/travel/dashboard/workload (PRD §4.1 manager
// view: open/overdue tasks per staff member with a per-brand split).

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle, BadgePercent, Calendar as CalendarIcon,
  ClipboardCheck, Compass, IndianRupee, FileText, Luggage,
  Map as MapIcon, RefreshCw, ShieldCheck, Ticket, Users, X,
} from "lucide-react";
import { AuthContext } from "../../App";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { useActiveSubBrand } from "../../utils/subBrand";
import TopScrollSync from "../../components/TopScrollSync";

export default function TravelDashboard() {
  const { user, tenant } = useContext(AuthContext) || {};
  const notify = useNotify();
  const { activeSubBrand } = useActiveSubBrand();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  // Team workload (PRD §4.1 manager view, gap A9b) — MANAGER/ADMIN only;
  // the endpoint 403s for USER role so we don't even fetch for them.
  const isManager = user?.role === "ADMIN" || user?.role === "MANAGER";
  const [workload, setWorkload] = useState(null);
  // System readiness panel — shows which customer-connectable integrations
  // are wired up (Gmail, Calendar, WhatsApp, Drive, AI, Razorpay).
  const [readiness, setReadiness] = useState(null);
  const [showReadiness, setShowReadiness] = useState(false);
  const hasDataRef = useRef(false);

  const loadReadiness = () => {
    fetchApi("/api/travel/dashboard/readiness")
      .then(setReadiness)
      .catch(() => setReadiness(null));
  };

  const load = useCallback(() => {
    const hasExistingData = hasDataRef.current;
    if (hasExistingData) {
      setRefreshing(true);
      setData(null);
    }
    setLoading(true);
    // Mirror the sidebar sub-brand switcher: when a brand is active, scope
    // every tile to it via ?subBrand=. "All" (activeSubBrand=null) sends no
    // param so the endpoint falls back to the caller's full access set.
    const qs = activeSubBrand ? `?subBrand=${encodeURIComponent(activeSubBrand)}` : "";
    fetchApi(`/api/travel/dashboard${qs}`)
      .then((nextData) => {
        setData(nextData);
        setLastRefreshedAt(new Date());
      })
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load dashboard");
        setData(null);
      })
      .finally(() => {
        setRefreshing(false);
        setLoading(false);
      });
    // Workload is a secondary panel — failures degrade to "panel hidden"
    // rather than a page-level error toast.
    if (isManager) {
      fetchApi(`/api/travel/dashboard/workload${qs}`)
        .then(setWorkload)
        .catch(() => setWorkload(null));
    }
    loadReadiness();
  }, [activeSubBrand, isManager, notify]);
  const reload = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);
  // Re-fetch on mount AND whenever the active sub-brand changes, so flipping
  // the switcher recomputes the KPI tiles instead of showing stale "All" data.
  useEffect(() => {
    load();
  }, [activeSubBrand, load, reloadTick]);
  useEffect(() => {
    hasDataRef.current = data != null;
  }, [data]);

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
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <button
            type="button"
            onClick={reload}
            style={refreshBtn}
            aria-label={refreshing ? "Refreshing dashboard" : "Refresh dashboard"}
            disabled={loading || refreshing}
          >
            <RefreshCw size={14} style={refreshing ? { animation: "spin 1s linear infinite" } : undefined} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", minHeight: 16 }}>
            {lastRefreshedAt ? `Updated ${lastRefreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : " "}
          </span>
        </div>
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
              icon={FileText}
              label="Landing pages"
              value={data.landingPages.total}
              footer={`${data.landingPages.published} published`}
              link="/landing-pages"
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
            {activeSubBrand !== "tmc" && (
              <Tile
                icon={Ticket}
                label="Web check-ins"
                value={data.webCheckins?.total ?? 0}
                accent={
                  (data.webCheckins?.missed ?? 0) > 0 ? (
                    <span style={{ color: "var(--danger-color)", fontWeight: 600 }}>
                      {data.webCheckins.missed} missed
                    </span>
                  ) : null
                }
                footer={`${data.webCheckins?.done ?? 0} delivered · ${data.webCheckins?.pending ?? 0} pending · ${data.webCheckins?.missed ?? 0} missed`}
                link="/travel/web-checkins"
              />
            )}
            <Tile
              icon={ShieldCheck}
              label="System Readiness"
              value={readiness ? `${readiness.readyCount}/${readiness.totalCount}` : "—"}
              accent={
                readiness && readiness.readyCount < readiness.totalCount ? (
                  <span style={{ color: "var(--warning-color)", fontWeight: 600 }}>
                    {readiness.totalCount - readiness.readyCount} items need attention
                  </span>
                ) : readiness ? (
                  <span style={{ color: "var(--success-color)", fontWeight: 600 }}>
                    All set
                  </span>
                ) : null
              }
              footer={readiness ? <ReadinessTileFooter checks={readiness.checks} /> : "Loading readiness…"}
              onClick={() => setShowReadiness(true)}
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
              <TopScrollSync>
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
              </TopScrollSync>
            )}
          </section>

          {isManager && workload && (
            <section style={{ ...card, marginTop: 16 }}>
              <h2 style={sectionTitle}>
                <Users size={18} aria-hidden style={{ marginRight: 6, verticalAlign: -3 }} />
                Team workload
              </h2>
              {workload.perUser.length === 0 && workload.unassigned.openTasks === 0 ? (
                <div style={empty}>No open tasks across the team.</div>
              ) : (
                <TopScrollSync>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={th}>Staff</th>
                      <th style={th}>Role</th>
                      <th style={th}>Open</th>
                      <th style={th}>Overdue</th>
                      <th style={th}>By brand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workload.perUser.map((r) => (
                      <tr key={r.userId} style={trStyle}>
                        <td style={td}>
                          <Link
                            to={`/staff?highlight=${encodeURIComponent(String(r.userId))}`}
                            style={{
                              color: "var(--primary-color)",
                              fontWeight: 600,
                              textDecoration: "none",
                            }}
                            title="Open Staff page"
                            aria-label={`Open staff page for ${r.name || r.email || `User #${r.userId}`}`}
                          >
                            {r.name || r.email || `User #${r.userId}`}
                          </Link>
                        </td>
                        <td style={td}>{r.role || "—"}</td>
                        <td style={td}>{r.openTasks}</td>
                        <td style={td}>
                          <span style={overdueStyle(r.overdueTasks)}>{r.overdueTasks}</span>
                        </td>
                        <td style={td}>{brandSplit(r.bySubBrand)}</td>
                      </tr>
                    ))}
                    {workload.unassigned.openTasks > 0 && (
                      <tr style={trStyle}>
                        <td style={{ ...td, fontStyle: "italic" }}>Unassigned</td>
                        <td style={td}>—</td>
                        <td style={td}>{workload.unassigned.openTasks}</td>
                        <td style={td}>
                          <span style={overdueStyle(workload.unassigned.overdueTasks)}>
                            {workload.unassigned.overdueTasks}
                          </span>
                        </td>
                        <td style={td}>{brandSplit(workload.unassigned.bySubBrand)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                </TopScrollSync>
              )}
              <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8, marginBottom: 0 }}>
                {workload.totals.openTasks} open · {workload.totals.overdueTasks} overdue team-wide.
                Brand split comes from each task&apos;s linked contact; untagged tasks show as &ldquo;untagged&rdquo;.
              </p>
            </section>
          )}

          <p style={{ marginTop: 16, fontSize: 12, color: "var(--text-secondary)" }}>
            <FileText size={12} aria-hidden style={{ marginRight: 4, verticalAlign: -1 }} />
            Sub-brand scope, RBAC, and PII gates apply server-side. Drill into the linked surfaces above to see participant-level detail.
          </p>

          {showReadiness && (
            <ReadinessModal readiness={readiness} onClose={() => setShowReadiness(false)} />
          )}
        </>
      )}
    </div>
  );
}

// ─── Building blocks ────────────────────────────────────────────────

function Tile({ icon: Icon, label, value, footer, accent, link, onClick, style }) {
  const [isHovered, setIsHovered] = useState(false);
  const clickable = Boolean(onClick);
  const content = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13, fontWeight: 600 }}>
        <Icon size={16} aria-hidden /> {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, marginTop: 6, color: "var(--text-primary)" }}>
        {value ?? 0}
      </div>
      {accent != null && accent !== "" && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{accent}</div>
      )}
    {footer && (
      <div
        style={{
          borderTop: "1px solid var(--border-color)",
          marginTop: 8,
          paddingTop: 8,
        }}
      >
        {typeof footer === "string" ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              marginTop: 8,
              lineHeight: 1.5,
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              columnGap: 0,
              rowGap: 4,
            }}
          >
            {String(footer)
              .split(" · ")
              .map((item, index) => {
                let rawKey;
                let value;

                if (item.includes(":")) {
                  // Example: level_1: 123
                  const parts = item.split(":");

                  rawKey = parts[0].trim().toLowerCase();
                  value = parts.slice(1).join(":").trim();
                } else {
                  // Example: 20 seasons / 1 pending
                  const match = item.trim().match(/^(\d+)\s+(.+)$/);

                  if (match) {
                    value = match[1];
                    rawKey = match[2].trim().toLowerCase();
                  } else {
                    rawKey = item.trim().toLowerCase();
                    value = "";
                  }
                }

                const colorMap = {
                  // Trips
                  cancelled: "var(--danger-color)",
                  completed: "var(--success-color)",
                  confirmed: "var(--primary-color)",
                  "in-trip": "var(--warning-color)",

                  // Diagnostics
                  level_1: "var(--primary-color)",
                  level_2: "var(--warning-color)",
                  level_3: "var(--success-color)",

                  // Itineraries
                  accepted: "var(--success-color)",
                  advance_paid: "var(--primary-color)",
                  draft: "var(--warning-color)",
                  fully_paid: "var(--success-color)",
                  rejected: "var(--danger-color)",
                  revised: "var(--primary-color)",
                  sent: "var(--success-color)",

                  // Other cards
                  published: "var(--success-color)",
                  rfu: "var(--primary-color)",
                  tmc: "var(--success-color)",
                  seasons: "var(--primary-color)",
                  "markup rules": "var(--success-color)",
                  delivered: "var(--success-color)",
                  pending: "var(--warning-color)",
                  missed: "var(--danger-color)",
                };

                const displayLabel =
                  rawKey === "rfu" || rawKey === "tmc"
                    ? rawKey.toUpperCase()
                    : rawKey
                      .replace(/_/g, " ")
                      .replace(/-/g, " ")
                      .replace(/\b\w/g, (char) => char.toUpperCase());

                return (
                  <span
                    key={index}
                    style={{
                      minWidth: 0,
                      overflowWrap: "anywhere",
                      color: colorMap[rawKey] || "var(--text-secondary)",
                      borderLeft:
                        index % 2 === 1
                          ? "1px solid var(--border-color)"
                          : "none",
                      paddingLeft: index % 2 === 1 ? 10 : 0,
                    }}
                  >
                    {displayLabel}: {value}
                  </span>
                );
              })}
          </div>
        ) : (
          footer
        )}
      </div>
    )}
    </>
  );
  if (link) {
    return (
      <Link
        to={link}
        style={{
          ...tileStyle,
          ...style,
          ...tileLinkStyle,
          ...(isHovered ? tileLinkHoverStyle : {}),
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocus={() => setIsHovered(true)}
        onBlur={() => setIsHovered(false)}
      >
        {content}
      </Link>
    );
  }
  if (clickable) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(e); }}
        style={{
          ...tileStyle,
          ...style,
          ...tileLinkStyle,
          ...(isHovered ? tileLinkHoverStyle : {}),
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocus={() => setIsHovered(true)}
        onBlur={() => setIsHovered(false)}
      >
        {content}
      </div>
    );
  }
  return <div style={{ ...tileStyle, ...style }}>{content}</div>;
}
function byKeyFooter(obj) {
  if (!obj || Object.keys(obj).length === 0) return null;

  const entries = Object.entries(obj).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;

  return entries
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

function ReadinessTileFooter({ checks }) {
  if (!Array.isArray(checks)) {
    return <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Loading readiness…</div>;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: "4px 12px",
        fontSize: 12,
      }}
    >
      {checks.map((check, index) => (
        <div
          key={check.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            borderLeft: index % 2 === 1 ? "1px solid var(--border-color)" : "none",
            paddingLeft: index % 2 === 1 ? 10 : 0,
          }}
          title={`${check.label}: ${check.ready ? "Connected" : "Needs attention"}`}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: check.ready ? "var(--success-color)" : "var(--warning-color)",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text-secondary)",
            }}
          >
            {check.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReadinessModal({ readiness, onClose }) {
  if (!readiness) return null;
  const { checks, readyCount, totalCount } = readiness;
  const allReady = readyCount === totalCount;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="readiness-title"
      style={modalOverlayStyle}
      onClick={onClose}
    >
      <div
        style={modalContentStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 id="readiness-title" style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
            <ShieldCheck size={22} aria-hidden /> System Readiness
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={modalCloseStyle}
          >
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            ...modalBannerStyle,
            background: allReady ? "rgba(47,122,77,0.12)" : "rgba(200,154,78,0.15)",
            color: allReady ? "var(--success-color)" : "var(--warning-color)",
          }}
        >
          {allReady
            ? `All ${totalCount} readiness checks passed.`
            : `${readyCount} of ${totalCount} checks ready · ${totalCount - readyCount} need attention`}
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {checks.map((check) => (
            <div
              key={check.id}
              style={{
                ...modalRowStyle,
                borderLeftColor: check.ready ? "var(--success-color)" : "var(--warning-color)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: check.ready ? "var(--success-color)" : "var(--warning-color)",
                    flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>{check.label}</div>
                  {check.detail && (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
                      {check.detail}
                    </div>
                  )}
                </div>
              </div>
              <Link
                to={check.link}
                onClick={onClose}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  background: check.ready ? "var(--subtle-bg)" : "var(--primary-color, var(--accent-color))",
                  color: check.ready ? "var(--text-secondary)" : "#fff",
                }}
              >
                {check.ready ? "Manage" : "Connect"}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

// "tmc: 3 (1 late) · rfu: 2" from a workload bySubBrand split. "_none"
// (task whose contact carries no sub-brand tag, or no contact at all)
// renders as "untagged".
function brandSplit(by) {
  const entries = Object.entries(by || {}).filter(([, v]) => v && v.open > 0);
  if (entries.length === 0) return "—";
  return entries
    .map(([k, v]) => `${k === "_none" ? "untagged" : k}: ${v.open}${v.overdue > 0 ? ` (${v.overdue} late)` : ""}`)
    .join(" · ");
}

function overdueStyle(count) {
  return count > 0
    ? { color: "var(--danger-color)", fontWeight: 600 }
    : { color: "var(--text-secondary)" };
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
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 250px), 1fr))",
  gridAutoRows: "minmax(180px, auto)",
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
  transition: "transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background-color 0.16s ease",
};
const tileLinkHoverStyle = {
  transform: "translateY(-4px)",
  boxShadow: "var(--shadow-md)",
  
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
const modalOverlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};
const modalContentStyle = {
  backgroundColor: "var(--modal-bg)",
  border: "1px solid var(--border-color)",
  borderRadius: 14,
  padding: 22,
  width: "100%",
  maxWidth: 520,
  maxHeight: "80vh",
  overflowY: "auto",
  boxShadow: "var(--shadow-lg, 0 16px 48px rgba(0,0,0,0.2))",
};
const modalCloseStyle = {
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const modalBannerStyle = {
  padding: "10px 14px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 16,
};
const modalRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--border-color)",
  borderLeft: "4px solid",
  background: "var(--bg-color, var(--surface-color))",
};
