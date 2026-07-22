// Travel CRM — TMC microsite preview admin overview (Phase 2 T22 SHELL).
//
// Per Yasin's TMC brief ("Trip management system → Auto-generate trip
// microsite"), this admin OVERVIEW lists confirmed-trip microsites for the
// TMC sub-brand so an admin can spot-check publish state / expiry / public
// URLs without diving into per-trip operator screens. The real editor flow
// lives at /travel/trips/:id (admin edit per-trip via routes/travel_microsites.js).
//
// FALLBACK NOTE: backend has no `GET /api/travel/microsites?subBrand=tmc`
// list endpoint as of this commit — the only list-shaped access is
// per-trip via `GET /api/travel/trips/:tripId/microsite`. This page lists
// TMC trips first (GET /api/travel/trips), then fans out one microsite
// GET per trip (in parallel, with not-found tolerated), and filters to
// trips that actually have a microsite. TODO: when a list endpoint lands,
// collapse to a single fetch.

import { useEffect, useState, useContext, useCallback } from "react";
import { Globe, ExternalLink, Copy } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import TopScrollSync from "../../components/TopScrollSync";

function micrositePublicUrl(publicUuid) {
  if (typeof window === "undefined") return `/p/tripmicrosite/${publicUuid}`;
  return `${window.location.origin}/p/tripmicrosite/${publicUuid}`;
}

function badgeForState(ms) {
  if (!ms) return null;
  if (ms.expiresAt && new Date(ms.expiresAt) < new Date()) {
    return { label: "Expired", style: badgeExpired };
  }
  if (ms.publishedAt) {
    return { label: "Published", style: badgeActive };
  }
  return { label: "Draft", style: badgeInactive };
}

export default function TmcMicrositePreview() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";

  // Each row is { trip, microsite }. Only trips with a microsite land here.
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const tripsRes = await fetchApi("/api/travel/trips?limit=200");
      const trips = Array.isArray(tripsRes?.trips) ? tripsRes.trips : [];
      // Fan out — tolerate per-trip 404 (no microsite for that trip).
      const settled = await Promise.allSettled(
        trips.map((t) =>
          fetchApi(`/api/travel/trips/${t.id}/microsite`).then((ms) => ({ trip: t, microsite: ms })),
        ),
      );
      const hits = settled
        .filter((s) => s.status === "fulfilled" && s.value && s.value.microsite && s.value.microsite.publicUuid)
        .map((s) => s.value)
        // Most-recently-published first; null publishedAt sinks to bottom.
        .sort((a, b) => {
          const ap = a.microsite.publishedAt ? new Date(a.microsite.publishedAt).getTime() : 0;
          const bp = b.microsite.publishedAt ? new Date(b.microsite.publishedAt).getTime() : 0;
          return bp - ap;
        });
      setRows(hits);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to load microsites");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  const copyUrl = async (publicUuid) => {
    const url = micrositePublicUrl(publicUuid);
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        notify.success("URL copied");
      } else {
        notify.info(url);
      }
    } catch {
      notify.info(url);
    }
  };

  if (!isAdmin) {
    return (
      <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Globe size={28} aria-hidden /> TMC Microsite Preview
        </h1>
        <div style={empty}>Admin role required to view this page.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <Globe size={28} aria-hidden /> TMC Microsite Preview
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4 }}>
            Admin overview of TMC trip microsites — name, publish state, expiry, public URL.
            Real editing lives on the per-trip detail screen.
          </p>
        </div>
      </div>

      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "visible", marginTop: 16,
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : rows.length === 0 ? (
          <div style={empty}>
            No TMC microsites yet. Microsites are created from the per-trip detail screen
            (POST <code>/api/travel/trips/:tripId/microsite</code>).
          </div>
        ) : (
          <TopScrollSync>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Trip</th>
                <th style={th}>Destination</th>
                <th style={th}>Subdomain</th>
                <th style={th}>State</th>
                <th style={th}>Expires</th>
                <th style={th} colSpan={2}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ trip, microsite }) => {
                const badge = badgeForState(microsite);
                const url = micrositePublicUrl(microsite.publicUuid);
                return (
                  <tr key={microsite.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={td}>
                      <strong>{trip.tripCode}</strong>
                    </td>
                    <td style={td}>{trip.destination}</td>
                    <td style={{ ...td, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                      {microsite.subdomain || "—"}
                    </td>
                    <td style={td}>
                      {badge && <span style={badge.style}>{badge.label}</span>}
                    </td>
                    <td style={td}>
                      {microsite.expiresAt
                        ? new Date(microsite.expiresAt).toLocaleDateString()
                        : <span style={{ color: "var(--text-secondary)" }}>—</span>}
                    </td>
                    <td style={{ ...td, width: 0 }}>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={primaryLinkBtn}
                        aria-label={`Preview microsite for trip ${trip.tripCode}`}
                      >
                        <ExternalLink size={14} /> Preview
                      </a>
                    </td>
                    <td style={{ ...td, width: 0 }}>
                      <button
                        type="button"
                        onClick={() => copyUrl(microsite.publicUuid)}
                        style={secondaryBtn}
                        aria-label={`Copy public URL for trip ${trip.tripCode}`}
                      >
                        <Copy size={14} /> Copy URL
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </div>
    </div>
  );
}

const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const primaryLinkBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 12,
  background: "var(--primary-color, var(--accent-color))", color: "#fff",
  border: "none", cursor: "pointer", textDecoration: "none",
};
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 12,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const badgeActive = {
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: "rgba(34,197,94,0.15)", color: "var(--success-color, #16a34a)",
};
const badgeInactive = {
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: "rgba(148,163,184,0.18)", color: "var(--text-secondary)",
};
const badgeExpired = {
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: "rgba(239,68,68,0.15)", color: "var(--danger-color, #dc2626)",
};
