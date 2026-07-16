// Travel CRM — Itineraries list view.
//
// Lands at /travel/itineraries. Operator-facing list with sub-brand +
// status filters. Each row shows the destination, status, contact,
// total amount, and item count. Click → detail view (TBD — Phase 1.5).
//
// The header CTA "+ Create Itinerary" opens a drawer with contact picker
// + sub-brand + destination + dates + currency + total amount. Posts to
// /api/travel/itineraries. The PRD §4.1 diagnostic-first guard is
// DISABLED (2026-06-25) so WhatsApp / inbound leads can be sent an
// itinerary without first completing the diagnostic. Itineraries can
// still be drafted from a Deal page once the Day 7 Deal-extension CTA lands.

import { useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Map, Filter, Plane, Hotel, MapPin, Briefcase, FileText, Shield, Plus, X,
  Sparkles, AlertTriangle, Trash2, Train, Bus, Car, Camera, Utensils, Search,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import PermissionGate from "../../components/PermissionGate";
import { useActiveSubBrand } from "../../utils/subBrand";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";
// S81 — MapPreview wire-in. Items in the list response already include
// latitude/longitude/dayNumber per backend/routes/travel_itineraries.js:141
// (`include: { items: { orderBy: { position: "asc" } } }`), so we can render
// the selected itinerary's map directly from list state without fanning out
// per-row fetches. The S10 MapPreview component is fully self-contained
// (leaflet + OSM tiles, no API key) and pinnableItems silently drops draft
// rows without lat/lng — so a partially-geocoded itinerary still maps the
// rows that do have coordinates.
import MapPreview from "../../components/MapPreview";

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
  { value: "expired", label: "Expired" },
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
  // expired = advisor-cancelled for non-payment (cron/paymentDeadlineEngine
  // flags it; advisor sets the status). Reuses the "rejected" red-ish pill.
  expired: "rejected",
};

// cancellationStatus is a separate, later-added lifecycle field (independent
// of `status` — see backend/prisma/schema.prisma) that the customer-initiated
// cancellation flow advances through requested → cancelled → refunded. It
// takes display PRECEDENCE over the stale `status` value once set, mirroring
// ItineraryDetail.jsx's cancellation banner. Without this, a cancelled/
// refunded booking keeps showing whatever `status` it had before cancellation
// (e.g. "accepted") since the cancellation PATCH never touches `status`.
const CANCELLATION_LABEL = {
  requested: "Cancellation requested",
  cancelled: "Cancelled",
  refunded: "Cancelled & refunded",
};
const CANCELLATION_VARIANT = {
  requested: "sent",
  cancelled: "rejected",
  refunded: "rejected",
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

// Per-item-type icon + accent colour for the redesigned day cards in the
// Suggest-itinerary preview. Falls back to a neutral briefcase + slate.
const DAY_ITEM_VISUAL = {
  flight: { Icon: Plane, color: "#2563eb" },
  train: { Icon: Train, color: "#4f46e5" },
  bus: { Icon: Bus, color: "#0e7c86" },
  cab: { Icon: Car, color: "#0e7c86" },
  transfer: { Icon: Car, color: "#0e7c86" },
  hotel: { Icon: Hotel, color: "#7c3aed" },
  sightseeing: { Icon: Camera, color: "#d97706" },
  activity: { Icon: Briefcase, color: "#ea580c" },
  meals: { Icon: Utensils, color: "#e11d48" },
  visa: { Icon: FileText, color: "#475569" },
  insurance: { Icon: Shield, color: "#16a34a" },
};
function dayItemVisual(itemType) {
  return DAY_ITEM_VISUAL[String(itemType || "").toLowerCase()] || { Icon: Briefcase, color: "#64748b" };
}
// Hex → rgba tint for icon-chip backgrounds (so each type reads at a glance).
function tintBg(hex, alpha = 0.14) {
  const h = String(hex || "#64748b").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const EMPTY_FORM = {
  contactId: "", subBrand: "tmc", destination: "",
  startDate: "", endDate: "", currency: "INR", totalAmount: "",
};

const CURRENCIES = ["INR", "USD", "EUR"];

// Geocode cache: city name → { lat, lng } resolved via Nominatim (same OSM
// data-source as our map tiles — no API key required, free to use).
const geocodeCache = {};
async function geocodeCity(cityName) {
  const key = cityName.toLowerCase().trim();
  if (geocodeCache[key]) return geocodeCache[key];
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key)}&format=json&limit=1`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'GlobusSoftCRM/1.0' } },
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const { lat, lon } = data[0];
      const coords = { lat: parseFloat(lat), lng: parseFloat(lon) };
      geocodeCache[key] = coords;
      return coords;
    }
  } catch (_) { /* Nominatim unreachable — silently skip */ }
  return null;
}

// Translate the verbose raw AI-provider error (Google dumps 500+ chars
// of JSON + stack into the message) into a short plain-English sentence
// the operator can act on. Mirrors the helper in MarketingFlyerStudio.jsx
// — kept inline rather than extracted to a shared util because the two
// pages are the only consumers today.
function friendlyAiError(rawError) {
  if (!rawError) return "AI service is temporarily unavailable. Please try again.";
  const m = String(rawError).toLowerCase();
  if (/429|too many requests|exceeded.*quota|quota exceeded|rate limit/.test(m)) {
    return "AI service is currently busy — daily limit reached on multiple models. Please try again later or upgrade the API plan.";
  }
  if (/401|unauthorized|invalid.*api.*key|api key.*invalid|incorrect.*key/.test(m)) {
    return "AI service rejected the API key. Please check the key configuration in the backend .env file.";
  }
  if (/403|forbidden|permission/.test(m)) {
    return "AI service blocked the request. Your API key may not have access to this model.";
  }
  if (/404|does not exist|unknown model|model.*not.*found/.test(m)) {
    return "AI model not available. Please contact support to update the model configuration.";
  }
  if (/timeout|abort|aborted/.test(m)) {
    return "AI service timed out. Please try again in a moment.";
  }
  if (/safety|blocked|finishreason.*safety/.test(m)) {
    return "AI service blocked the prompt for safety reasons. Try rephrasing the destination or theme.";
  }
  if (/json.*parse|parse.*failed|invalid.*response/.test(m)) {
    return "AI service returned a malformed response. Please try again.";
  }
  if (/network|fetch.*failed|enotfound|econnrefused/.test(m)) {
    return "Cannot reach the AI service. Please check your internet connection.";
  }
  return "AI service is temporarily unavailable. Please try again in a moment.";
}

// PRD FR-3.6 step (a) — Suggest itinerary CTA modal form. Defaults mirror
// the route's valid ranges (durationDays 1..30; budgetTier economy|mid|luxury).
// Interests + pace are captured as plain text; the backend assembles the
// structured theme JSON from them, so operators never hand-author JSON.
const SUGGEST_BUDGET_TIERS = [
  { value: "economy", label: "Economy" },
  { value: "mid", label: "Mid" },
  { value: "luxury", label: "Luxury" },
];

const SUGGEST_PACE_OPTIONS = [
  { value: "relaxed", label: "Relaxed" },
  { value: "moderate", label: "Moderate" },
  { value: "packed", label: "Packed" },
];

const SUGGEST_TRANSPORT_OPTIONS = [
  { value: "flight", label: "Flight" },
  { value: "train", label: "Train" },
  { value: "car", label: "Car / Road" },
  { value: "none", label: "Not applicable" },
];

const EMPTY_SUGGEST_FORM = {
  destination: "",
  departureCity: "",
  transportPreference: "flight",
  durationDays: 5,
  startDate: "",
  budgetTier: "mid",
  interests: "",
  pace: "relaxed",
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

// Sum the per-person estimated costs of a suggestion day's items (FR-3.6 —
// Gemini supplies per-item estimatedCost; the operator reviews these before
// materialising + can edit each line afterwards).
function dayEstTotal(day) {
  if (!day || !Array.isArray(day.items)) return 0;
  return day.items.reduce((s, it) => {
    const c = Number(it.estimatedCost);
    return s + (Number.isFinite(c) && c > 0 ? c : 0);
  }, 0);
}

// Sum every day's per-person estimate across the whole suggestion.
function suggestionEstTotal(suggestion) {
  if (!suggestion || !Array.isArray(suggestion.days)) return 0;
  return suggestion.days.reduce((s, day) => s + dayEstTotal(day), 0);
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
  const [deletingId, setDeletingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // { id, destination }
  const [searchQuery, setSearchQuery] = useState("");
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);

  // S81 — selected itinerary for the top-of-page MapPreview panel. Null →
  // no map shown (default). User picks a row's "Map" button to surface the
  // selected itinerary's items on a Leaflet+OSM canvas. Re-clicking the
  // same row's Map button clears the selection (toggle).
  const [selectedItineraryId, setSelectedItineraryId] = useState(null);
  const selectedItinerary = useMemo(
    () => (selectedItineraryId
      ? items.find((it) => it.id === selectedItineraryId)
      : null),
    [items, selectedItineraryId],
  );

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const dest = (it.destination || "").toLowerCase();
      const contact = [
        it.contact?.firstName, it.contact?.lastName, it.contact?.name,
      ].filter(Boolean).join(" ").toLowerCase();
      return dest.includes(q) || contact.includes(q);
    });
  }, [items, searchQuery]);
  // Items array passed to MapPreview. When the itinerary has geocoded items
  // those are used directly. When there are none we geocode the destination
  // city names via Nominatim (same OSM data used for tiles) and show those
  // as fallback destination-level pins.
  const [mapItems, setMapItems] = useState([]);
  useEffect(() => {
    if (!selectedItinerary) { setMapItems([]); return; }
    const raw = selectedItinerary.items || [];
    const hasPins = raw.some(
      (it) => it && it.latitude != null && it.longitude != null
        && Number.isFinite(Number(it.latitude)) && Number.isFinite(Number(it.longitude)),
    );
    if (hasPins) { setMapItems(raw); return; }
    if (!selectedItinerary.destination) { setMapItems(raw); return; }
    // Parse destination into city words and geocode each via Nominatim.
    const words = selectedItinerary.destination
      .split(/[_\s/,;-]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    let cancelled = false;
    (async () => {
      const synth = [];
      for (let i = 0; i < words.length; i++) {
        const coords = await geocodeCity(words[i]);
        if (cancelled) return;
        if (coords) {
          synth.push({
            id: `dest-${i}`,
            latitude: coords.lat,
            longitude: coords.lng,
            locationName: words[i],
            dayNumber: null,
          });
        }
      }
      if (!cancelled) setMapItems(synth.length > 0 ? synth : raw);
    })();
    return () => { cancelled = true; };
  }, [selectedItinerary]);

  // PRD FR-3.6 — "Suggest itinerary" modal state. Separate from the create
  // drawer above so the operator can iterate on suggestions independently
  // of opening the manual-create flow.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestForm, setSuggestForm] = useState(EMPTY_SUGGEST_FORM);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestResult, setSuggestResult] = useState(null);
  const [suggestFieldErrors, setSuggestFieldErrors] = useState({});

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setSelectedTemplateId(null);
    setTemplateSearch("");
    setShowTemplates(false);
    setCreating(true);
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
    setTemplatesLoading(true);
    fetchApi("/api/travel/itinerary-templates?limit=100&isActive=true")
      .then((res) => setTemplates(Array.isArray(res?.items) ? res.items : []))
      .catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false));
  };

  const handleDelete = (e, itinerary) => {
    e.stopPropagation();
    setConfirmDelete({ id: itinerary.id, destination: itinerary.destination });
  };

  const confirmDoDelete = async () => {
    if (!confirmDelete) return;
    const { id, destination } = confirmDelete;
    setConfirmDelete(null);
    setDeletingId(id);
    try {
      await fetchApi(`/api/travel/itineraries/${id}`, { method: 'DELETE' });
      notify.success(`Deleted "${destination}"`);
      if (selectedItineraryId === id) setSelectedItineraryId(null);
      load();
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to delete itinerary');
    } finally {
      setDeletingId(null);
    }
  };

  // PRD FR-3.6 step (a) — open the Suggest Itinerary modal.
  const openSuggest = () => {
    setSuggestForm(EMPTY_SUGGEST_FORM);
    setSuggestResult(null);
    setSuggestFieldErrors({});
    setSuggesting(true);
  };

  const closeSuggest = () => {
    setSuggesting(false);
    setSuggestResult(null);
    setSuggestFieldErrors({});
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

    if (Object.keys(errors).length > 0) {
      setSuggestFieldErrors(errors);
      return;
    }
    setSuggestFieldErrors({});

    setSuggestLoading(true);
    setSuggestResult(null);
    try {
      // The backend reads `days` (not durationDays) and assembles the theme
      // JSON from the plain-text interests + pace fields, so we send them raw
      // and let the server normalise + convert.
      const body = {
        destination: dest,
        departureCity: (suggestForm.departureCity || "").trim(),
        transportPreference: suggestForm.transportPreference || "flight",
        days: dd,
        budgetTier: suggestForm.budgetTier,
        interests: (suggestForm.interests || "").trim(),
        pace: suggestForm.pace || "",
      };
      const res = await fetchApi("/api/travel/itineraries/suggest", {
        method: "POST",
        body: JSON.stringify(body),
      });
      // When real-mode tried but failed, the backend returns the stub
      // envelope + a `realModeError` field. Surface a friendly toast
      // instead of silently showing the synthetic [STUB] content as
      // if it were a real Gemini suggestion.
      if (res?.stub && res?.realModeError) {
        notify.error(friendlyAiError(res.realModeError));
        return;
      }
      setSuggestResult(res);
    } catch (err) {
      notify.error(
        friendlyAiError(err?.body?.error || err?.message || "")
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
    if (!suggestResult || !suggestResult.suggestion) {
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
        suggestionJson: suggestResult.suggestion,
        contactId: cid,
        subBrand: effectiveSubBrand,
        // Send the real destination the suggestion was generated for, so the
        // backend doesn't fall back to the (long) summary for the Itinerary's
        // destination column.
        destination: (suggestForm.destination || "").trim(),
        // Travel start date (optional) — backend derives endDate from day count.
        startDate: suggestForm.startDate || undefined,
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
    if (!suggestResult || !suggestResult.suggestion) return;
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
      if (selectedTemplateId) body.clonedFromTemplateId = selectedTemplateId;
      await fetchApi("/api/travel/itineraries", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success(selectedTemplateId ? "Itinerary created from template" : "Itinerary created");
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
          {/* Both header CTAs lead to itinerary creation — gate on
              `itineraries.write`. PermissionGate hides the buttons
              entirely when the role lacks the grant. Backend POST
              endpoints already enforce the same gate (requirePermission
              middleware on routes/travel_itineraries.js); the UI gate
              prevents users from seeing actions they can't perform. */}
          <PermissionGate module="itineraries" action="write">
            <button
              type="button"
              onClick={openSuggest}
              style={secondaryBtn}
              aria-label="Suggest itinerary using AI"
            >
              <Sparkles size={14} /> Suggest itinerary
            </button>
          </PermissionGate>
          <PermissionGate module="itineraries" action="write">
            <button
              type="button"
              onClick={openCreate}
              style={primaryBtn}
              aria-label="Create a new itinerary"
            >
              <Plus size={14} /> Create Itinerary
            </button>
          </PermissionGate>
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
        <div style={{ position: "relative", display: "flex", alignItems: "center", flex: "1 1 180px", minWidth: 160, maxWidth: 320 }}>
          <Search size={14} aria-hidden style={{ position: "absolute", left: 8, color: "var(--text-secondary)", pointerEvents: "none" }} />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search destination or name…"
            aria-label="Search itineraries by destination or contact name"
            style={{
              ...selectStyle,
              paddingLeft: 28,
              paddingRight: searchQuery ? 28 : 8,
              width: "100%",
              boxSizing: "border-box",
            }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              style={{
                position: "absolute", right: 6, background: "none", border: "none",
                cursor: "pointer", color: "var(--text-secondary)", display: "flex", alignItems: "center", padding: 2,
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button type="button" onClick={load} style={refreshBtn} aria-label="Reload list">Refresh</button>
      </div>

      {/* S81 — selected-itinerary map panel. Shown only when the operator
          picks a row's "Map" button. Items in the list response already
          include latitude/longitude/dayNumber (backend list endpoint
          includes items by default), so no extra fetch is needed.
          MapPreview's pinnableItems silently drops rows without
          coordinates, so an itinerary with only some geocoded items
          still maps the geocoded subset; a fully-empty result still
          renders the world-view fallback rather than nothing. */}
      {selectedItinerary && (
        <div
          data-testid="itineraries-selected-map"
          style={{
            background: "var(--surface-color)", borderRadius: 8,
            border: "1px solid var(--border-color)", overflow: "hidden",
            marginBottom: 16,
          }}
        >
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 12px", borderBottom: "1px solid var(--border-light)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Map size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
              <strong style={{ fontSize: 13 }}>{selectedItinerary.destination}</strong>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                {mapItems.length} item{mapItems.length === 1 ? "" : "s"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedItineraryId(null)}
              aria-label="Close map preview"
              style={iconBtn}
            >
              <X size={14} />
            </button>
          </div>
          <MapPreview
            items={mapItems}
            height={320}
            onMarkerClick={(it) => {
              // Optional UX: log marker click for now. Future: scroll the
              // row into view or open a side-panel with the item detail.
              if (typeof console !== "undefined") {
                console.log("[Itineraries] map marker click", it);
              }
            }}
          />
        </div>
      )}

      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "visible",
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div style={empty}>
            No itineraries yet. Use the &quot;Create Itinerary&quot; button above, or
            build one from a linked Deal in the sales pipeline.
          </div>
        ) : filteredItems.length === 0 ? (
          <div style={empty}>
            No itineraries match &ldquo;{searchQuery}&rdquo;.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: "1000px", borderCollapse: "collapse" }}>
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
                <th style={th}>Map</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((it) => {
                // cancellationStatus (once set) overrides the stale `status`
                // pill — see CANCELLATION_LABEL comment above.
                const statusLabel = it.cancellationStatus
                  ? CANCELLATION_LABEL[it.cancellationStatus] || it.cancellationStatus
                  : it.status;
                const statusVariant = it.cancellationStatus
                  ? CANCELLATION_VARIANT[it.cancellationStatus] || "other"
                  : STATUS_VARIANT[it.status] || "other";
                return (
                  <tr
                    key={it.id}
                    onClick={() => navigate(`/travel/itineraries/${it.id}`)}
                    style={{ borderTop: "1px solid var(--border-light)", cursor: "pointer" }}
                    aria-label={`Open itinerary ${it.destination}`}
                  >
                    <td style={td}><strong>{it.destination}</strong></td>
                    <td style={td}><span style={brandBadge}>{it.subBrand}</span></td>
                    <td style={td}>{it.contact ? (it.contact.name || it.contact.email || `#${it.contact.id}`) : "—"}</td>
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
                        {statusLabel}
                      </span>
                      {/* Pay-or-cancel at-risk flag: an accepted booking whose
                          50% deposit deadline passed unpaid (paymentOverdueAt
                          set by cron/paymentDeadlineEngine). Prompts the advisor
                          to follow up or set status → expired. Suppressed once
                          a cancellation is in play (requested/cancelled/
                          refunded) — the booking is no longer an active unpaid
                          deposit risk, it's a cancellation being processed. */}
                      {!it.cancellationStatus && it.status === "accepted" && it.paymentOverdueAt && (
                        <span
                          title={`Deposit overdue since ${fmt(it.paymentOverdueAt)} — review for cancellation`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            marginLeft: 6,
                            padding: "1px 6px",
                            borderRadius: 10,
                            fontSize: 11,
                            fontWeight: 600,
                            background: "rgba(220,38,38,0.12)",
                            color: "#b91c1c",
                          }}
                        >
                          <AlertTriangle size={11} aria-hidden="true" /> Deposit overdue
                        </span>
                      )}
                    </td>
                    <td style={td}><TierBadge tier={it.productTier} /></td>
                    <td style={td}>{new Date(it.updatedAt).toLocaleDateString()}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {/* S81 — per-row Map toggle. stopPropagation so the
                          row's navigate-on-click doesn't fire alongside. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedItineraryId((prev) =>
                            (prev === it.id ? null : it.id));
                        }}
                        aria-label={
                          selectedItineraryId === it.id
                            ? `Hide map for ${it.destination}`
                            : `Show map for ${it.destination}`
                        }
                        aria-pressed={selectedItineraryId === it.id}
                        style={{
                          ...refreshBtn,
                          padding: "4px 8px",
                          fontSize: 12,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <Map size={12} aria-hidden />
                        {selectedItineraryId === it.id ? "Hide" : "Map"}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, it)}
                        disabled={deletingId === it.id}
                        aria-label={`Delete itinerary ${it.destination}`}
                        style={{
                          marginLeft: 6,
                          padding: "4px 6px",
                          fontSize: 12,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          border: "1px solid rgba(220,38,38,0.4)",
                          borderRadius: 4,
                          background: "transparent",
                          color: deletingId === it.id ? "var(--text-secondary)" : "#dc2626",
                          cursor: deletingId === it.id ? "not-allowed" : "pointer",
                        }}
                      >
                        <Trash2 size={12} aria-hidden />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setCreating(false); }}
          className="travel-itin-drawer-backdrop"
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1000, padding: "1rem",
          }}
        >
          <form onSubmit={submitCreate} className="card travel-itin-drawer" role="dialog" aria-modal="true" style={createModalStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>New Itinerary</h2>
              <button type="button" onClick={() => setCreating(false)} aria-label="Close" style={iconBtn}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

              {/* ── Template picker ── */}
              <div style={{ borderRadius: 8, border: "1px solid var(--border-color)", overflow: "hidden" }}>
                <button
                  type="button"
                  onClick={() => setShowTemplates((v) => !v)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "9px 12px", background: showTemplates ? "rgba(200,154,78,0.1)" : "var(--surface-color)",
                    border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                    color: showTemplates ? "var(--accent-color, #C89A4E)" : "var(--text-primary)",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <FileText size={14} aria-hidden />
                    Start from a template
                    {selectedTemplateId && (
                      <span style={{ fontWeight: 400, fontSize: 11, color: "var(--success-color, #22c55e)" }}>
                        ✓ selected
                      </span>
                    )}
                  </span>
                  {showTemplates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                {showTemplates && (
                  <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-color)", background: "rgba(0,0,0,0.15)" }}>
                    {/* Search inside templates */}
                    <div style={{ position: "relative", marginBottom: 10 }}>
                      <Search size={13} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)", pointerEvents: "none" }} />
                      <input
                        type="search"
                        value={templateSearch}
                        onChange={(e) => setTemplateSearch(e.target.value)}
                        placeholder="Search templates…"
                        style={{ ...inputStyle, paddingLeft: 28, width: "100%", boxSizing: "border-box", fontSize: 12 }}
                      />
                    </div>

                    {templatesLoading ? (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "6px 0" }}>Loading templates…</div>
                    ) : templates.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "6px 0" }}>No templates available yet.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                        {templates
                          .filter((t) => {
                            const q = templateSearch.trim().toLowerCase();
                            if (!q) return true;
                            return (
                              (t.name || "").toLowerCase().includes(q) ||
                              (t.destinationName || "").toLowerCase().includes(q) ||
                              (t.category || "").toLowerCase().includes(q)
                            );
                          })
                          .map((t) => {
                            const isSelected = selectedTemplateId === t.id;
                            const price = t.basePriceMinor ? `${t.currency || "INR"} ${(t.basePriceMinor / 100).toLocaleString()}` : null;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => {
                                  if (isSelected) {
                                    setSelectedTemplateId(null);
                                  } else {
                                    setSelectedTemplateId(t.id);
                                    setForm((prev) => ({
                                      ...prev,
                                      destination: t.destinationName || prev.destination,
                                      subBrand: t.subBrand || prev.subBrand,
                                      currency: t.currency || prev.currency,
                                      totalAmount: t.basePriceMinor ? String(t.basePriceMinor / 100) : prev.totalAmount,
                                    }));
                                  }
                                }}
                                style={{
                                  display: "flex", alignItems: "flex-start", gap: 10, textAlign: "left",
                                  padding: "8px 10px", borderRadius: 6, cursor: "pointer",
                                  border: isSelected ? "1px solid var(--accent-color, #C89A4E)" : "1px solid var(--border-light, rgba(255,255,255,0.08))",
                                  background: isSelected ? "rgba(200,154,78,0.12)" : "rgba(255,255,255,0.03)",
                                  color: "var(--text-primary)",
                                }}
                              >
                                <FileText size={14} style={{ marginTop: 1, flexShrink: 0, color: isSelected ? "var(--accent-color, #C89A4E)" : "var(--text-secondary)" }} aria-hidden />
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {t.name || t.destinationName || `Template #${t.id}`}
                                  </div>
                                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 1, display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    {t.destinationName && <span>{t.destinationName}</span>}
                                    {t.durationDays && <span>{t.durationDays}d</span>}
                                    {t.category && <span>{t.category}</span>}
                                    {price && <span>{price}</span>}
                                    {t.usageCount > 0 && <span>Used {t.usageCount}×</span>}
                                  </div>
                                </div>
                                {isSelected && <span style={{ fontSize: 11, color: "var(--accent-color, #C89A4E)", fontWeight: 600, flexShrink: 0 }}>✓</span>}
                              </button>
                            );
                          })}
                      </div>
                    )}

                    {selectedTemplateId && (
                      <button
                        type="button"
                        onClick={() => setSelectedTemplateId(null)}
                        style={{ marginTop: 8, fontSize: 11, color: "var(--text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                      >
                        × Clear template selection
                      </button>
                    )}
                  </div>
                )}
              </div>

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
                You can create and send an itinerary for any contact — including
                WhatsApp / inbound leads who haven&apos;t taken the diagnostic yet.
                Running the diagnostic first is still recommended for accurate
                tier-based pricing.
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
            background: "rgba(8,11,20,0.82)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            // High z-index so the dimmer sits ABOVE the app top-bar/sidebar
            // (they sit above the prior z-index 1000, so the page bled through).
            zIndex: 3000, padding: "1rem",
          }}
        >
          <form
            onSubmit={submitSuggest}
            role="dialog"
            aria-labelledby="suggest-itin-title"
            aria-modal="true"
            style={suggestModalStyle}
            className="card travel-itin-suggest-modal"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 38, height: 38, borderRadius: 11, flexShrink: 0,
                  background: "linear-gradient(135deg, var(--primary-color, var(--accent-color)) 0%, #6366f1 100%)",
                  color: "#fff", boxShadow: "0 4px 12px rgba(79,70,229,0.35)",
                }}>
                  <Sparkles size={20} aria-hidden />
                </span>
                <div>
                  <h2 id="suggest-itin-title" style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: 0.2 }}>
                    Suggest itinerary
                  </h2>
                  <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--text-secondary)" }}>
                    AI builds a day-by-day outline — review it, then create the itinerary.
                  </p>
                </div>
              </div>
              <button type="button" onClick={closeSuggest} aria-label="Close" style={iconBtn}>
                <X size={18} />
              </button>
            </div>
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
                  Departure city (optional)
                  <input
                    type="text"
                    value={suggestForm.departureCity}
                    onChange={(e) => setSuggestForm({ ...suggestForm, departureCity: e.target.value })}
                    style={inputStyle}
                    placeholder='e.g. "Mumbai", "Delhi"'
                    aria-label="Departure / pickup city"
                  />
                </label>
                <label style={fieldLabel}>
                  Travelling by
                  <select
                    value={suggestForm.transportPreference}
                    onChange={(e) => setSuggestForm({ ...suggestForm, transportPreference: e.target.value })}
                    style={modalSelectStyle}
                    aria-label="Travelling by"
                  >
                    {SUGGEST_TRANSPORT_OPTIONS.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              </div>
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
                    style={modalSelectStyle}
                  >
                    {SUGGEST_BUDGET_TIERS.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label style={fieldLabel}>
                Travel start date (optional)
                <input
                  type="date"
                  value={suggestForm.startDate}
                  onChange={(e) => setSuggestForm({ ...suggestForm, startDate: e.target.value })}
                  style={inputStyle}
                />
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  End date is set automatically from the trip length. The customer can adjust dates when they accept.
                </span>
              </label>
              <label style={fieldLabel}>
                Interests (optional)
                <input
                  type="text"
                  value={suggestForm.interests}
                  onChange={(e) => setSuggestForm({ ...suggestForm, interests: e.target.value })}
                  style={inputStyle}
                  placeholder="e.g. historical, beaches, food (comma-separated)"
                  aria-label="Interests, comma-separated"
                />
              </label>
              <label style={fieldLabel}>
                Pace (optional)
                <select
                  value={suggestForm.pace}
                  onChange={(e) => setSuggestForm({ ...suggestForm, pace: e.target.value })}
                  style={modalSelectStyle}
                  aria-label="Trip pace"
                >
                  {SUGGEST_PACE_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
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

            {suggestResult && suggestResult.suggestion && (
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
                {suggestResult.suggestion.summary && (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
                    {suggestResult.suggestion.summary}
                  </p>
                )}
                {suggestionEstTotal(suggestResult.suggestion) > 0 && (
                  <div
                    data-testid="suggest-est-total"
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      marginBottom: 8,
                    }}
                  >
                    Estimated total:{" "}
                    {fmtMoney(suggestionEstTotal(suggestResult.suggestion), "INR")} / person
                    {suggestResult.costSource === "stub" && (
                      <span style={{ fontWeight: 400, fontSize: 11, color: "var(--text-secondary)" }}>
                        {" "}— rough fallback estimate (AI pricing unavailable)
                      </span>
                    )}
                  </div>
                )}
                {Array.isArray(suggestResult.suggestion.days) && suggestResult.suggestion.days.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 8 }}>
                    {suggestResult.suggestion.days.map((day, idx) => {
                      const dn = day.dayNumber ?? idx + 1;
                      return (
                        <div
                          key={day.dayNumber ?? idx}
                          style={dayCard}
                          data-testid={`suggest-day-${dn}`}
                        >
                          <div style={dayCardHead}>
                            <span style={dayBadge}>{dn}</span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text-primary)", lineHeight: 1.2 }}>
                                Day {dn}
                              </div>
                              {day.theme ? (
                                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{day.theme}</div>
                              ) : null}
                            </div>
                            {dayEstTotal(day) > 0 && (
                              <span style={dayHeadTotal}>{fmtMoney(dayEstTotal(day), "INR")}</span>
                            )}
                          </div>
                          {Array.isArray(day.items) && day.items.length > 0 && (
                            <div>
                              {day.items.map((item, i) => {
                                const { Icon, color } = dayItemVisual(item.itemType);
                                const free = item.estimatedCost === 0;
                                return (
                                  <div key={i} style={dayItemRow}>
                                    <span style={{ ...dayItemIcon, background: tintBg(color), color }}>
                                      <Icon size={14} aria-hidden />
                                    </span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color }}>
                                        {item.itemType || "item"}
                                      </span>
                                      {item.description ? (
                                        <span style={{ fontSize: 12, color: "var(--text-primary)" }}> {item.description}</span>
                                      ) : null}
                                    </div>
                                    {item.estimatedCost != null && (
                                      <span style={{ whiteSpace: "nowrap", fontSize: 12, fontWeight: 600, color: free ? "var(--text-secondary)" : "var(--text-primary)" }}>
                                        {free ? "Free" : fmtMoney(item.estimatedCost, "INR")}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {dayEstTotal(day) > 0 && (
                            <div style={dayCardFoot}>
                              Day subtotal: <strong style={{ color: "var(--text-primary)" }}>{fmtMoney(dayEstTotal(day), "INR")}</strong> / person
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
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
                    {JSON.stringify(suggestResult.suggestion, null, 2)}
                  </pre>
                )}
                {suggestResult.suggestion.thematicNotes && (
                  <p style={{ margin: 0, marginTop: 8, fontSize: 11, color: "var(--text-secondary)", fontStyle: "italic" }}>
                    {suggestResult.suggestion.thematicNotes}
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
                      style={modalSelectStyle}
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
                      style={modalSelectStyle}
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

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1100,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}
        >
          <div
            className="card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            style={{
              background: "var(--bg-color)",
              borderRadius: 10,
              padding: 28,
              width: "100%",
              maxWidth: 420,
              boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 40, height: 40, borderRadius: "50%",
                background: "rgba(220,38,38,0.12)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>
                <Trash2 size={18} style={{ color: "#dc2626" }} />
              </div>
              <div>
                <h3 id="delete-confirm-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                  Delete itinerary?
                </h3>
                <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
                  <strong>{confirmDelete.destination}</strong> will be permanently removed.
                  This cannot be undone.
                </p>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                style={{ ...refreshBtn, padding: "8px 16px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDoDelete}
                disabled={!!deletingId}
                style={{
                  padding: "8px 16px", borderRadius: 6, fontWeight: 600, fontSize: 13,
                  background: "#dc2626", color: "#fff",
                  border: "1px solid #dc2626", cursor: "pointer",
                  display: "inline-flex", alignItems: "center", gap: 6,
                  opacity: deletingId ? 0.6 : 1,
                }}
              >
                <Trash2 size={14} /> {deletingId ? "Deleting…" : "Yes, delete"}
              </button>
            </div>
          </div>
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

// Centred modal for the "Create Itinerary" form. Mirrors suggestModalStyle
// below so the two creation flows feel consistent. Earlier this was a
// right-edge drawer (`width: 100%; maxWidth: 460; height: 100vh`) but
// against the dark travel theme the side panel read as semi-transparent
// (table content visible behind the form header), so the operator
// couldn't distinguish modal chrome from page chrome. Centred dialog +
// explicit backdrop + boxShadow gives a clean lifted surface in both
// light and dark themes.
// `.card` provides the chrome (border-radius, border, box-shadow, blur);
// we force `background: var(--bg-color)` inline to override its
// glassmorphic `var(--surface-color)` rgba — without this, the panel
// reads as semi-transparent over the page content behind it.
const createModalStyle = {
  background: "var(--bg-color)",
  color: "var(--text-primary)",
  width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto",
  padding: "1.5rem",
};

const iconBtn = {
  background: "transparent", border: "none", color: "var(--text-secondary)",
  cursor: "pointer", padding: 4,
};

const fieldLabel = {
  display: "flex", flexDirection: "column", gap: 6,
  fontSize: 11, color: "var(--text-secondary)", fontWeight: 600,
  letterSpacing: 0.3, textTransform: "uppercase",
};

const inputStyle = {
  padding: "10px 12px", borderRadius: 9,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))", color: "var(--text-primary)",
  fontSize: 14, outline: "none", width: "100%", boxSizing: "border-box",
};

// Native <select> with a custom chevron (the default OS arrow looks dated). We
// strip the browser appearance and paint a chevron via an inline SVG background.
// Used by the Suggest-itinerary modal + create drawer selects.
const modalSelectStyle = {
  ...inputStyle,
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  cursor: "pointer",
  paddingRight: 34,
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23889' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 11px center",
};

// Redesigned day-card styling for the Suggest-itinerary preview (the operator
// reviews these before materialising). Each day = a bordered card with a
// gradient day-badge header, icon-tagged item rows, and a subtotal footer.
const dayCard = {
  border: "1px solid var(--border-color)", borderRadius: 12,
  background: "var(--surface-color)", overflow: "hidden",
  boxShadow: "0 1px 2px rgba(0,0,0,0.05), 0 6px 16px rgba(0,0,0,0.05)",
};
const dayCardHead = {
  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
  background: "linear-gradient(135deg, rgba(37,99,235,0.12), rgba(99,102,241,0.05))",
};
const dayBadge = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 30, height: 30, borderRadius: 9, flexShrink: 0,
  background: "linear-gradient(135deg, var(--primary-color, var(--accent-color)) 0%, #6366f1 100%)",
  color: "#fff", fontWeight: 800, fontSize: 14,
  boxShadow: "0 3px 8px rgba(79,70,229,0.30)",
};
const dayHeadTotal = {
  marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "var(--text-primary)",
  background: "var(--bg-color)", padding: "3px 10px", borderRadius: 20, whiteSpace: "nowrap",
};
const dayItemRow = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "9px 12px", borderTop: "1px solid var(--border-color)",
};
const dayItemIcon = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 26, height: 26, borderRadius: 7, flexShrink: 0,
};
const dayCardFoot = {
  fontSize: 11.5, color: "var(--text-secondary)", textAlign: "right",
  padding: "8px 12px", background: "var(--bg-color)",
  borderTop: "1px solid var(--border-color)",
};

// PRD FR-3.6 — Suggest itinerary modal styling. Centred dialog (not the
// right-edge drawer used by Create Itinerary) since the operator may need
// to spend a moment reviewing the suggestion preview before committing.
const suggestModalStyle = {
  background: "var(--bg-color)",
  color: "var(--text-primary)",
  width: "100%", maxWidth: 580, maxHeight: "90vh", overflowY: "auto",
  padding: "1.5rem",
  borderRadius: 16,
  border: "1px solid var(--border-color)",
  boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
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
