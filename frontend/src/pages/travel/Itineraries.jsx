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

import { useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Map, Filter, Plane, Hotel, MapPin, Briefcase, FileText, Shield, Plus, X,
  Sparkles,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import { useActiveSubBrand } from "../../utils/subBrand";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";

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

// PRD FR-3.6 step (a) — Suggest itinerary CTA modal form. Defaults mirror
// the route's valid ranges (durationDays 1..30; budgetTier economy|mid|luxury).
// `themeJson` is a free-form textarea — operator types a JSON object;
// validation happens on submit (parse + INVALID_THEME_JSON inline error).
const SUGGEST_BUDGET_TIERS = [
  { value: "economy", label: "Economy" },
  { value: "mid", label: "Mid" },
  { value: "luxury", label: "Luxury" },
];

const EMPTY_SUGGEST_FORM = {
  destination: "",
  durationDays: 5,
  budgetTier: "mid",
  themeJsonRaw: "",
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
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  // Sub-brands this user may create itineraries under. Single-brand users
  // are locked to their one brand (read-only field); multi-brand users get
  // a dropdown limited to THEIR brands. See defaultSubBrandFor.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [contacts, setContacts] = useState([]);

  // PRD FR-3.6 — "Suggest itinerary" modal state. Separate from the create
  // drawer above so the operator can iterate on suggestions independently
  // of opening the manual-create flow.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestForm, setSuggestForm] = useState(EMPTY_SUGGEST_FORM);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestResult, setSuggestResult] = useState(null);
  const [suggestThemeError, setSuggestThemeError] = useState("");
  const [suggestFieldErrors, setSuggestFieldErrors] = useState({});

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setCreating(true);
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
  };

  // PRD FR-3.6 step (a) — open the Suggest Itinerary modal.
  const openSuggest = () => {
    setSuggestForm(EMPTY_SUGGEST_FORM);
    setSuggestResult(null);
    setSuggestThemeError("");
    setSuggestFieldErrors({});
    setSuggesting(true);
  };

  const closeSuggest = () => {
    setSuggesting(false);
    setSuggestResult(null);
    setSuggestThemeError("");
    setSuggestFieldErrors({});
  };

  // Validate the themeJson textarea on blur. Empty is fine (optional field).
  // Non-empty must parse to a plain object — array / scalar rejected to
  // match the route's INVALID_THEME_JSON gate.
  const validateThemeJson = () => {
    const raw = (suggestForm.themeJsonRaw || "").trim();
    if (!raw) {
      setSuggestThemeError("");
      return { ok: true, parsed: undefined };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setSuggestThemeError("themeJson must be a JSON object (not array / scalar).");
        return { ok: false };
      }
      setSuggestThemeError("");
      return { ok: true, parsed };
    } catch (e) {
      setSuggestThemeError(`Invalid JSON: ${e.message}`);
      return { ok: false };
    }
  };

  const submitSuggest = async (e) => {
    e.preventDefault();
    const errors = {};
    const dest = (suggestForm.destination || "").trim();
    if (!dest) errors.destination = "Destination is required";
    const dd = Number(suggestForm.durationDays);
    if (!Number.isInteger(dd) || dd < 1 || dd > 30) {
      errors.durationDays = "Duration must be an integer 1..30";
    }
    if (!suggestForm.budgetTier) errors.budgetTier = "Budget tier is required";

    const themeCheck = validateThemeJson();
    if (!themeCheck.ok) {
      setSuggestFieldErrors(errors);
      // themeError is already set by validateThemeJson; abort.
      return;
    }
    if (Object.keys(errors).length > 0) {
      setSuggestFieldErrors(errors);
      return;
    }
    setSuggestFieldErrors({});

    setSuggestLoading(true);
    setSuggestResult(null);
    try {
      const body = {
        destination: dest,
        durationDays: dd,
        budgetTier: suggestForm.budgetTier,
      };
      if (themeCheck.parsed !== undefined) body.themeJson = themeCheck.parsed;
      const res = await fetchApi("/api/travel/itineraries/suggest", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSuggestResult(res);
    } catch (err) {
      notify.error(
        err?.body?.error
        || err?.message
        || "Failed to generate suggestion",
      );
    } finally {
      setSuggestLoading(false);
    }
  };

  // S90 — Materialise-from-suggestion materialise state.
  //
  // The /suggest endpoint doesn't need contactId or subBrand (it's a pure
  // LLM/stub brainstorm). Materialising into a real Itinerary DOES — we
  // surface a tiny picker inline in the preview pane so the operator can
  // pick the contact + sub-brand at the moment of commit. (We could also
  // navigate to the Create drawer pre-filled, but that's a heavier UX
  // and would require lifting the suggestion through state. The inline
  // picker keeps the flow one click.)
  const [materialiseContactId, setMaterialiseContactId] = useState("");
  const [materialiseSubBrand, setMaterialiseSubBrand] = useState("");
  const [materialising, setMaterialising] = useState(false);

  // PRD FR-3.6 step (d) — Materialise the suggestion into an Itinerary +
  // ItineraryItem rows by POST /api/travel/itineraries/from-suggestion.
  // On success → navigate to the detail page if it exists; otherwise
  // close the modal and refresh the list.
  const createFromSuggestion = async () => {
    if (!suggestResult || !suggestResult.suggestionJson) {
      notify.error("No suggestion to materialise");
      return;
    }
    if (!materialiseContactId) {
      notify.error("Pick a contact to attach the itinerary to");
      return;
    }
    const cid = parseInt(materialiseContactId, 10);
    if (!Number.isFinite(cid)) {
      notify.error("Invalid contact selection");
      return;
    }
    const effectiveSubBrand = materialiseSubBrand
      || defaultSubBrandFor(user, activeSubBrand);
    setMaterialising(true);
    try {
      const body = {
        suggestionJson: suggestResult.suggestionJson,
        contactId: cid,
        subBrand: effectiveSubBrand,
      };
      const res = await fetchApi(
        "/api/travel/itineraries/from-suggestion",
        { method: "POST", body: JSON.stringify(body) },
      );
      const itemsCreated = (res && typeof res.itemsCreated === "number")
        ? res.itemsCreated
        : (res && res.itinerary && Array.isArray(res.itinerary.items))
          ? res.itinerary.items.length
          : 0;
      notify.success(`Itinerary created with ${itemsCreated} items`);
      closeSuggest();
      const newId = res && res.itinerary && res.itinerary.id;
      if (newId) {
        // Detail page exists (Day 11 ItineraryDetail). Navigate so the
        // operator can review + edit before sending.
        navigate(`/travel/itineraries/${newId}`);
      } else {
        load();
      }
    } catch (err) {
      notify.error(
        err?.body?.error
        || err?.message
        || "Failed to materialise itinerary",
      );
    } finally {
      setMaterialising(false);
    }
  };

  // Load contacts for the materialise picker when the preview pane opens.
  // Reuses the same /api/contacts feed as the Create drawer.
  useEffect(() => {
    if (!suggestResult || !suggestResult.suggestionJson) return;
    if (contacts.length > 0) return;
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
  }, [suggestResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset materialise picker state every time the suggestion changes.
  useEffect(() => {
    setMaterialiseContactId("");
    setMaterialiseSubBrand(defaultSubBrandFor(user, activeSubBrand));
  }, [suggestResult]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // PRD FR-3.6 — close Suggest modal on Escape.
  useEffect(() => {
    if (!suggesting) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeSuggest(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [suggesting]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={openSuggest}
            style={secondaryBtn}
            aria-label="Suggest itinerary using AI"
          >
            <Sparkles size={14} /> Suggest itinerary
          </button>
          <button
            type="button"
            onClick={openCreate}
            style={primaryBtn}
            aria-label="Create a new itinerary"
          >
            <Plus size={14} /> Create Itinerary
          </button>
        </div>
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
                {lockedBrand ? (
                  // Single-brand users can't change sub-brand — the value
                  // is already pinned in form.subBrand via defaultSubBrandFor.
                  <input
                    type="text"
                    value={subBrandShortLabel(lockedBrand)}
                    readOnly
                    disabled
                    aria-label="Sub-brand (locked to your assigned brand)"
                    style={{ ...inputStyle, opacity: 0.7, cursor: "not-allowed" }}
                  />
                ) : (
                  <select
                    value={form.subBrand}
                    onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                    style={inputStyle}
                  >
                    {myBrands.map((b) => (
                      <option key={b} value={b}>{subBrandShortLabel(b)}</option>
                    ))}
                  </select>
                )}
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

      {suggesting && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeSuggest(); }}
          className="travel-itin-suggest-backdrop"
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1000, padding: 24,
          }}
        >
          <form
            onSubmit={submitSuggest}
            role="dialog"
            aria-labelledby="suggest-itin-title"
            aria-modal="true"
            style={suggestModalStyle}
            className="travel-itin-suggest-modal"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 id="suggest-itin-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <Sparkles size={18} aria-hidden /> Suggest itinerary
              </h2>
              <button type="button" onClick={closeSuggest} aria-label="Close" style={iconBtn}>
                <X size={16} />
              </button>
            </div>
            <p style={{ margin: 0, marginBottom: 16, fontSize: 12, color: "var(--text-secondary)" }}>
              AI-generated day-by-day outline. Review the suggestion below
              before creating an itinerary. PRD FR-3.6.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={fieldLabel}>
                Destination
                <input
                  type="text"
                  value={suggestForm.destination}
                  onChange={(e) => setSuggestForm({ ...suggestForm, destination: e.target.value })}
                  style={inputStyle}
                  placeholder='e.g. "Goa", "Paris", "Kyoto"'
                  aria-invalid={suggestFieldErrors.destination ? "true" : "false"}
                  aria-describedby={suggestFieldErrors.destination ? "suggest-dest-error" : undefined}
                />
                {suggestFieldErrors.destination && (
                  <span id="suggest-dest-error" style={errorTextStyle}>
                    {suggestFieldErrors.destination}
                  </span>
                )}
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label style={fieldLabel}>
                  Duration (days)
                  <input
                    type="number"
                    min="1"
                    max="30"
                    step="1"
                    value={suggestForm.durationDays}
                    onChange={(e) => setSuggestForm({ ...suggestForm, durationDays: e.target.value })}
                    style={inputStyle}
                    aria-invalid={suggestFieldErrors.durationDays ? "true" : "false"}
                    aria-describedby={suggestFieldErrors.durationDays ? "suggest-dur-error" : undefined}
                  />
                  {suggestFieldErrors.durationDays && (
                    <span id="suggest-dur-error" style={errorTextStyle}>
                      {suggestFieldErrors.durationDays}
                    </span>
                  )}
                </label>
                <label style={fieldLabel}>
                  Budget tier
                  <select
                    value={suggestForm.budgetTier}
                    onChange={(e) => setSuggestForm({ ...suggestForm, budgetTier: e.target.value })}
                    style={inputStyle}
                  >
                    {SUGGEST_BUDGET_TIERS.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label style={fieldLabel}>
                Theme JSON (optional)
                <textarea
                  value={suggestForm.themeJsonRaw}
                  onChange={(e) => setSuggestForm({ ...suggestForm, themeJsonRaw: e.target.value })}
                  onBlur={validateThemeJson}
                  style={{ ...inputStyle, minHeight: 80, fontFamily: "monospace", fontSize: 12 }}
                  placeholder='{"interests":["historical","beaches"],"pace":"relaxed"}'
                  aria-invalid={suggestThemeError ? "true" : "false"}
                  aria-describedby={suggestThemeError ? "suggest-theme-error" : undefined}
                />
                {suggestThemeError && (
                  <span id="suggest-theme-error" style={errorTextStyle}>
                    {suggestThemeError}
                  </span>
                )}
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={closeSuggest} style={refreshBtn}>
                Cancel
              </button>
              <button type="submit" disabled={suggestLoading} style={primaryBtn}>
                {suggestLoading ? "Generating suggestion…" : "Suggest"}
              </button>
            </div>

            {suggestResult && suggestResult.suggestionJson && (
              <div
                style={{
                  marginTop: 20, padding: 12, borderRadius: 8,
                  border: "1px solid var(--border-color)",
                  background: "var(--subtle-bg, var(--surface-color))",
                }}
                data-testid="suggest-preview-pane"
                aria-label="Suggested itinerary preview"
              >
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  Suggested itinerary
                  {suggestResult.stub ? (
                    <span
                      style={{
                        marginLeft: 8, padding: "2px 6px", borderRadius: 4, fontSize: 10,
                        background: "var(--subtle-bg-3)", color: "var(--text-secondary)",
                        textTransform: "uppercase", fontWeight: 600,
                      }}
                    >
                      Stub
                    </span>
                  ) : null}
                </h3>
                {suggestResult.suggestionJson.summary && (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
                    {suggestResult.suggestionJson.summary}
                  </p>
                )}
                {Array.isArray(suggestResult.suggestionJson.daySplit) && suggestResult.suggestionJson.daySplit.length > 0 ? (
                  <ol style={{ paddingLeft: 18, margin: 0, marginBottom: 8 }}>
                    {suggestResult.suggestionJson.daySplit.map((day, idx) => (
                      <li
                        key={day.dayNumber ?? idx}
                        style={{ marginBottom: 8 }}
                        data-testid={`suggest-day-${day.dayNumber ?? idx + 1}`}
                      >
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          Day {day.dayNumber ?? idx + 1}
                          {day.theme ? ` — ${day.theme}` : ""}
                        </div>
                        {Array.isArray(day.items) && day.items.length > 0 && (
                          <ul style={{ paddingLeft: 18, margin: 0 }}>
                            {day.items.map((item, i) => (
                              <li key={i} style={{ fontSize: 12, color: "var(--text-primary)" }}>
                                <strong>{item.itemType || "item"}</strong>
                                {item.description ? ` — ${item.description}` : ""}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  // Fallback: shape unfamiliar — render raw JSON so the
                  // operator can still see what came back.
                  <pre
                    style={{
                      background: "var(--surface-color)",
                      padding: 8, borderRadius: 4, fontSize: 11,
                      overflow: "auto", maxHeight: 200,
                    }}
                  >
                    {JSON.stringify(suggestResult.suggestionJson, null, 2)}
                  </pre>
                )}
                {suggestResult.suggestionJson.thematicNotes && (
                  <p style={{ margin: 0, marginTop: 8, fontSize: 11, color: "var(--text-secondary)", fontStyle: "italic" }}>
                    {suggestResult.suggestionJson.thematicNotes}
                  </p>
                )}
                {/* S90 — materialise picker: contact + sub-brand inline so
                    the operator picks them at commit time without leaving
                    the modal. */}
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                  }}
                  data-testid="materialise-picker"
                >
                  <label style={fieldLabel}>
                    Attach to contact
                    <select
                      value={materialiseContactId}
                      onChange={(e) => setMaterialiseContactId(e.target.value)}
                      style={inputStyle}
                      aria-label="Contact for materialised itinerary"
                    >
                      <option value="">— pick a contact —</option>
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
                      value={materialiseSubBrand}
                      onChange={(e) => setMaterialiseSubBrand(e.target.value)}
                      style={inputStyle}
                      aria-label="Sub-brand for materialised itinerary"
                      disabled={!!lockedBrand}
                    >
                      {lockedBrand
                        ? (
                          <option value={lockedBrand}>
                            {subBrandShortLabel(lockedBrand) || lockedBrand}
                          </option>
                        )
                        : (myBrands.length > 0 ? myBrands : ["tmc", "rfu", "travelstall", "visasure"])
                          .map((sb) => (
                            <option key={sb} value={sb}>
                              {subBrandShortLabel(sb) || sb}
                            </option>
                          ))}
                    </select>
                  </label>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    onClick={() => setSuggestResult(null)}
                    style={refreshBtn}
                    aria-label="Discard suggestion"
                    disabled={materialising}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={createFromSuggestion}
                    style={primaryBtn}
                    aria-label="Create itinerary from this suggestion"
                    disabled={materialising || !materialiseContactId}
                  >
                    {materialising
                      ? "Creating itinerary…"
                      : "Create itinerary from this suggestion"}
                  </button>
                </div>
              </div>
            )}
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

// PRD FR-3.6 — Suggest itinerary modal styling. Centred dialog (not the
// right-edge drawer used by Create Itinerary) since the operator may need
// to spend a moment reviewing the suggestion preview before committing.
const suggestModalStyle = {
  background: "var(--surface-color)", color: "var(--text-primary)",
  width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto",
  padding: 20, borderRadius: 12,
  border: "1px solid var(--border-color)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
};

const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)",
  color: "var(--primary-color, var(--accent-color))",
  border: "1px solid var(--primary-color, var(--accent-color))",
  cursor: "pointer",
};

const errorTextStyle = {
  fontSize: 11, color: "var(--danger-color, #c0392b)",
  marginTop: 2,
};
