// Travel CRM — Itineraries list view.
//
// Lands at /travel/itineraries. Operator-facing list with sub-brand +
// status filters. Each row shows the destination, status, contact,
// total amount, and item count. Click → detail view (TBD — Phase 1.5).
//
// The header CTA "+ Create Itinerary" opens a drawer with contact picker
// + sub-brand + destination + dates + currency + total amount. Posts to
// /api/travel/itineraries; the backend enforces the diagnostic-first
// guard (PRD §4.1) — if the contact hasn't completed a diagnostic for
// the chosen sub-brand, the POST returns 403 and notify.error surfaces
// the message. Itineraries can still be drafted from a Deal page once
// the Day 7 Deal-extension CTA lands.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Map, Filter, Plane, Hotel, MapPin, Briefcase, FileText, Shield, Plus, X,
} from "lucide-react";
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

// #879 (Itineraries slice) — pre-refactor used inline `${bg}` + `${color}`
// from a hex/rgba lookup map for each status pill. Refactored to a
// `.travel-itin-status-pill .travel-itin-status-pill--<variant>` class
// pair so travel dark-mode can override the tinted-pill bg+fg without JS.
// Unknown statuses fall through to `other`.
const STATUS_VARIANT = {
  draft: "draft",
  sent: "sent",
  revised: "revised",
  accepted: "accepted",
  rejected: "rejected",
};

// PRD §6.4 — tier badge palette. productTier on each Itinerary is captured
// at creation from the contact's latest diagnostic (recommendedTier).
// Neutral / travel-navy / warm-gold for entry / primary / premium.
// #879 refactor: same class-pair pattern as STATUS_VARIANT above so the
// tier-pill bg+fg tokens can be overridden per-theme via CSS-only.
const TIER_VARIANT = {
  entry: "entry",
  primary: "primary",
  premium: "premium",
};

const ITEM_ICONS = {
  flight: Plane,
  hotel: Hotel,
  transfer: MapPin,
  activity: Briefcase,
  visa: FileText,
  insurance: Shield,
};

const EMPTY_FORM = {
  contactId: "", subBrand: "tmc", destination: "",
  startDate: "", endDate: "", currency: "INR", totalAmount: "",
};

const CURRENCIES = ["INR", "USD", "EUR"];

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
  const variant = TIER_VARIANT[tier] || "other";
  return (
    <span className={`travel-itin-tier-pill travel-itin-tier-pill--${variant}`}>
      {tier}
    </span>
  );
}

export default function Itineraries() {
  const notify = useNotify();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [contacts, setContacts] = useState([]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setCreating(true);
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.contactId) {
      notify.error("Contact is required");
      return;
    }
    if (!form.destination.trim()) {
      notify.error("Destination is required");
      return;
    }
    setSaving(true);
    try {
      const body = {
        contactId: parseInt(form.contactId, 10),
        subBrand: form.subBrand,
        destination: form.destination.trim(),
        status: "draft",
        currency: form.currency,
      };
      if (form.startDate) body.startDate = form.startDate;
      if (form.endDate) body.endDate = form.endDate;
      if (form.totalAmount) body.totalAmount = Number(form.totalAmount);
      await fetchApi("/api/travel/itineraries", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Itinerary created");
      setCreating(false);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create itinerary");
    } finally {
      setSaving(false);
    }
  };

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

  // Close drawer on Escape
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setCreating(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating]);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <header style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        gap: 12, marginBottom: 4,
      }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, marginBottom: 4 }}>
            <Map size={28} aria-hidden /> Itineraries
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
            Multi-product trip itineraries (RFU + Travel Stall + visa). Create one
            here or build from a linked Deal in the sales pipeline.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          style={primaryBtn}
          aria-label="Create a new itinerary"
        >
          <Plus size={14} /> Create Itinerary
        </button>
      </header>

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
            No itineraries yet. Use the &quot;Create Itinerary&quot; button above, or
            build one from a linked Deal in the sales pipeline.
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
                const statusVariant = STATUS_VARIANT[it.status] || "other";
                return (
                  <tr
                    key={it.id}
                    onClick={() => navigate(`/travel/itineraries/${it.id}`)}
                    style={{ borderTop: "1px solid var(--border-light)", cursor: "pointer" }}
                    aria-label={`Open itinerary ${it.destination}`}
                  >
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
                      <span className={`travel-itin-status-pill travel-itin-status-pill--${statusVariant}`}>
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

      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setCreating(false); }}
          className="travel-itin-drawer-backdrop"
          style={{
            position: "fixed", inset: 0,
            display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
            zIndex: 1000,
          }}
        >
          <form onSubmit={submitCreate} style={drawerStyle} className="travel-itin-drawer">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>New Itinerary</h2>
              <button type="button" onClick={() => setCreating(false)} aria-label="Close" style={iconBtn}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={fieldLabel}>
                Contact
                <select
                  required
                  value={form.contactId}
                  onChange={(e) => setForm({ ...form, contactId: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">— select contact —</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.email || `Contact #${c.id}`}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                Sub-brand
                <select
                  value={form.subBrand}
                  onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                  style={inputStyle}
                >
                  {SUB_BRANDS.filter((s) => s.value).map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                Destination
                <input
                  required type="text" value={form.destination}
                  onChange={(e) => setForm({ ...form, destination: e.target.value })}
                  style={inputStyle}
                  placeholder='e.g. "Andaman Islands"'
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label style={fieldLabel}>
                  Start date
                  <input
                    type="date" value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label style={fieldLabel}>
                  End date
                  <input
                    type="date" value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    style={inputStyle}
                  />
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
                <label style={fieldLabel}>
                  Currency
                  <select
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    style={inputStyle}
                  >
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label style={fieldLabel}>
                  Total amount
                  <input
                    type="number" min="0" step="any" value={form.totalAmount}
                    onChange={(e) => setForm({ ...form, totalAmount: e.target.value })}
                    style={inputStyle}
                    placeholder="0"
                  />
                </label>
              </div>
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>
                The contact must have completed a diagnostic for this sub-brand
                (PRD &sect;4.1). If not, the server will reject and you can route
                them through the diagnostic first.
              </p>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button type="button" onClick={() => setCreating(false)} style={refreshBtn}>Cancel</button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? "Creating…" : "Create Itinerary"}
              </button>
            </div>
          </form>
        </div>
      )}
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

const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
  cursor: "pointer",
};

// #879 — boxShadow refactored to a CSS class so the dark-mode override can
// deepen the shadow opacity (`rgba(0,0,0,0.5)`) to read as a real lifted
// surface against the dark body. Light-mode preserved byte-for-byte.
const drawerStyle = {
  background: "var(--surface-color)", color: "var(--text-primary)",
  width: "100%", maxWidth: 460, height: "100vh", overflowY: "auto",
  padding: 20,
};

const iconBtn = {
  background: "transparent", border: "none", color: "var(--text-secondary)",
  cursor: "pointer", padding: 4,
};

const fieldLabel = {
  display: "flex", flexDirection: "column", gap: 4,
  fontSize: 12, color: "var(--text-secondary)", fontWeight: 500,
};

const inputStyle = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))", color: "var(--text-primary)",
  fontSize: 14,
};
