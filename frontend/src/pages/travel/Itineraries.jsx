// Travel CRM — Itineraries list view.
//
// Lands at /travel/itineraries. Operator-facing list with sub-brand +
// status filters. Each row shows the destination, status, contact,
// total amount, and item count. Click → detail view (TBD — Phase 1.5).
//
// Phase 1 doesn't ship a creation UI here — itineraries are usually
// drafted from a Deal page (the "Build itinerary from this lead" CTA
// lands in Day 7's Deal-extension pass). The list view itself is the
// operator's daily working surface.

import { useEffect, useState } from "react";
import { Map, Filter, Plane, Hotel, MapPin, Briefcase, FileText, Shield } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "revised", label: "Revised" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
];

const STATUS_COLORS = {
  draft: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  sent: { bg: "rgba(47,122,77,0.14)", color: "#2F7A4D" },
  revised: { bg: "rgba(200,154,78,0.16)", color: "#9A6F2E" },
  accepted: { bg: "rgba(38,88,85,0.16)", color: "#265855" },
  rejected: { bg: "rgba(168,50,63,0.14)", color: "#A8323F" },
};

// PRD §6.4 — tier badge palette. productTier on each Itinerary is captured
// at creation from the contact's latest diagnostic (recommendedTier).
// Neutral / travel-navy / warm-gold for entry / primary / premium.
const TIER_COLORS = {
  entry: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  primary: { bg: "rgba(18,38,71,0.14)", color: "#122647" },
  premium: { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
};

const ITEM_ICONS = {
  flight: Plane,
  hotel: Hotel,
  transfer: MapPin,
  activity: Briefcase,
  visa: FileText,
  insurance: Shield,
};

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function fmtMoney(amt, currency = "INR") {
  if (amt == null) return "—";
  const n = Number(amt);
  if (!Number.isFinite(n)) return "—";
  // Compact for big rupee amounts
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

export default function Itineraries() {
  const notify = useNotify();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [status, setStatus] = useState("");

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (status) qs.set("status", status);
    qs.set("limit", "100");
    fetchApi(`/api/travel/itineraries?${qs.toString()}`)
      .then((res) => setItems(Array.isArray(res?.itineraries) ? res.itineraries : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load itineraries");
        setItems([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand, status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, marginBottom: 4 }}>
        <Map size={28} aria-hidden /> Itineraries
      </h1>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Multi-product trip itineraries (RFU + Travel Stall + visa). Build new ones
        from the linked Deal in the sales pipeline.
      </p>

      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
        background: "var(--surface-color)", padding: 12, borderRadius: 8,
        border: "1px solid var(--border-color)", marginBottom: 16,
      }}>
        <Filter size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={subBrand} onChange={(e) => setSubBrand(e.target.value)} style={selectStyle} aria-label="Filter by sub-brand">
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle} aria-label="Filter by status">
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button type="button" onClick={load} style={refreshBtn} aria-label="Reload list">Refresh</button>
      </div>

      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "hidden",
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div style={empty}>
            No itineraries yet. New itineraries are built from the linked Deal in the sales pipeline.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Destination</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Contact</th>
                <th style={th}>Dates</th>
                <th style={th}>Items</th>
                <th style={th}>Total</th>
                <th style={th}>Status</th>
                <th style={th}>Tier</th>
                <th style={th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const sc = STATUS_COLORS[it.status] || { bg: "var(--subtle-bg)", color: "var(--text-secondary)" };
                return (
                  <tr key={it.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={td}><strong>{it.destination}</strong></td>
                    <td style={td}><span style={brandBadge}>{it.subBrand}</span></td>
                    <td style={td}>{it.contactId ? `#${it.contactId}` : "—"}</td>
                    <td style={td}>
                      {it.startDate || it.endDate
                        ? `${fmt(it.startDate)} → ${fmt(it.endDate)}`
                        : "—"}
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 4 }}>
                        {(it.items || []).slice(0, 5).map((item) => {
                          const Icon = ITEM_ICONS[item.itemType] || Briefcase;
                          return (
                            <Icon
                              key={item.id}
                              size={14}
                              aria-label={item.itemType}
                              title={`${item.itemType}: ${item.description}`}
                              style={{ color: "var(--text-secondary)" }}
                            />
                          );
                        })}
                        {(it.items || []).length > 5 && (
                          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            +{it.items.length - 5}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={td}>{fmtMoney(it.totalAmount, it.currency)}</td>
                    <td style={td}>
                      <span style={{
                        background: sc.bg, color: sc.color,
                        padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: 0.5,
                      }}>
                        {it.status}
                      </span>
                    </td>
                    <td style={td}><TierBadge tier={it.productTier} /></td>
                    <td style={td}>{new Date(it.updatedAt).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  minWidth: 160, fontSize: 13,
};

const refreshBtn = {
  padding: "6px 12px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: 13, cursor: "pointer",
};

const empty = {
  padding: 32, textAlign: "center",
  color: "var(--text-secondary)", fontSize: 14,
};

const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};

const td = {
  padding: "10px 12px", fontSize: 14,
  color: "var(--text-primary)",
};

const brandBadge = {
  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg-3)", color: "var(--primary-color)",
  textTransform: "uppercase", letterSpacing: 0.5,
};
