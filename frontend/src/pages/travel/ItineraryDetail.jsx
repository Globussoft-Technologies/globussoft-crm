// Travel CRM — Itinerary detail page.
//
// Mounts at /travel/itineraries/:id. Four sections:
//   1. Header bar — destination + status + sub-brand badge + admin/manager
//      action cluster (accept/reject/regen/share/PDF).
//   2. Draft summary — LLM-generated prose from
//      POST /api/travel/itineraries/:id/draft/regen (PRD §4.3 + §9.1).
//      Persisted on Itinerary.draftSummary; surfaced here so the third
//      LLM-router consumer becomes user-visible.
//   3. Items table — flight / hotel / transfer / activity / visa /
//      insurance rows with edit + delete (admin/manager). "Add item"
//      inline form.
//   3a. Trip map (S127) — Leaflet+OSM MapPreview rendered above the day-
//       by-day breakdown when the itinerary has ≥1 item. Items already
//       carry lat/lng from the GET response; MapPreview drops rows
//       without coordinates silently. Mirrors the S81 list-page pattern.
//   4. Day costs panel (#907 slice 4) — collapsible section consuming
//      GET /api/travel/itineraries/:id/day-costs (slice 2, commit
//      5ca25585). Shows summary tiles (totalDays / grandTotal /
//      averageDailyCost) + per-day breakdown table with byType chips.
//      Lazy-loads on first expand; cached for the page lifetime.
//
//      #907 slice 5 adds the per-day margin breakdown surfaced by the
//      lib helper (supplierCost / markupTotal / gstTotal) plus the
//      grand-total mirror (grandSupplierCost / grandMarkupTotal /
//      grandGstTotal). The summary-tile row gains three margin tiles;
//      each day-row gains a margin sub-row beneath the totalCost.
//      PRD §3.6(d) pricing transparency.

import { useEffect, useState, useContext } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Map as MapIcon, Plane, Hotel, MapPin, Briefcase, FileText, Shield,
  Plus, Pencil, Trash2, X, Sparkles, Share2, Download, Check, XCircle, Copy,
  Calendar, ChevronDown, ChevronRight,
  Train, Bus, Car, Camera, Utensils, Package,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { geocode } from "../../lib/geocoder";
import { AuthContext } from "../../App";
// S127 — MapPreview wire-in for the detail surface. The /api/travel/itineraries/:id
// GET already includes items with latitude/longitude/dayNumber, so the spatial
// preview renders directly off itin.items with no extra fetch. pinnableItems
// inside MapPreview silently drops draft rows without coordinates, so a
// partially-geocoded itinerary still maps the subset that has coords.
// Mirrors the S81 list-page wire-in pattern.
import MapPreview from "../../components/MapPreview";

// Item types cover both fly + non-fly (domestic) trips and general expenses.
// Keep in sync with VALID_ITEM_TYPES in backend/routes/travel_itineraries.js.
const ITEM_TYPES = [
  "flight", "train", "bus", "cab", "transfer", "hotel",
  "sightseeing", "activity", "meals", "visa", "insurance", "other",
];

const ITEM_ICONS = {
  flight: Plane,
  train: Train,
  bus: Bus,
  cab: Car,
  transfer: MapPin,
  hotel: Hotel,
  sightseeing: Camera,
  activity: Briefcase,
  meals: Utensils,
  visa: FileText,
  insurance: Shield,
  other: Package,
};

const STATUS_COLORS = {
  draft: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  sent: { bg: "rgba(47,122,77,0.14)", color: "#2F7A4D" },
  revised: { bg: "rgba(200,154,78,0.16)", color: "#9A6F2E" },
  accepted: { bg: "rgba(38,88,85,0.16)", color: "#265855" },
  rejected: { bg: "rgba(168,50,63,0.14)", color: "#A8323F" },
  advance_paid: { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
  fully_paid: { bg: "rgba(38,88,85,0.22)", color: "#1F4644" },
};

const TIER_COLORS = {
  entry: { bg: "rgba(120,120,120,0.12)", color: "#5C6E82" },
  primary: { bg: "rgba(18,38,71,0.14)", color: "#122647" },
  premium: { bg: "rgba(200,154,78,0.22)", color: "#7A5419" },
};

const EMPTY_ITEM = {
  itemType: "flight",
  description: "",
  unitCost: "",
  markup: "",
  gstAmount: "",
  totalPrice: "",
  position: "",
  detailsJson: "",
  supplierId: "",
  unit: "per_person",
  quantity: "1",
  direction: "",
};

// Pricing-basis options + labels (mirror VALID_ITEM_UNITS in the backend).
const ITEM_UNITS = [
  { value: "per_person", label: "Per person" },
  { value: "per_night", label: "Per night" },
  { value: "per_room_night", label: "Per room-night" },
  { value: "per_day", label: "Per day" },
  { value: "per_group", label: "Whole group (flat)" },
];
const unitLabel = (u) => (ITEM_UNITS.find((x) => x.value === u) || {}).label || u || "";
// Transport types where a one-way / round-trip distinction matters.
const TRANSPORT_TYPES = ["flight", "train", "bus", "cab", "transfer"];
const DIRECTIONS = [
  { value: "", label: "—" },
  { value: "one_way", label: "One-way" },
  { value: "round_trip", label: "Round-trip" },
];
// Compute the line total the same way the server does (rate × qty + markup + GST).
function lineTotalOf(v) {
  const rate = v.unitCost !== "" && v.unitCost != null ? Number(v.unitCost) : 0;
  let qty = v.quantity !== "" && v.quantity != null ? Number(v.quantity) : 1;
  if (!Number.isFinite(qty) || qty < 0) qty = 1;
  const mk = v.markup !== "" && v.markup != null ? Number(v.markup) : 0;
  const gst = v.gstAmount !== "" && v.gstAmount != null ? Number(v.gstAmount) : 0;
  return Math.round((rate * qty + mk + gst) * 100) / 100;
}

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

export default function ItineraryDetail() {
  const { id } = useParams();
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const isManager = user?.role === "MANAGER";
  const canEdit = isAdmin || isManager;

  const [itin, setItin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [regenStub, setRegenStub] = useState(null); // { model, stub } from last regen
  const [shareUrl, setShareUrl] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState(EMPTY_ITEM);
  const [editing, setEditing] = useState(null);
  // S82 — true while geocode(description) is in flight before the POST so the
  // Save button is locked. PRD FR-3.4 + carry-over from S10 (frontend-side
  // wire-in keeps the per-user rate-limit semantics of lib/geocoder.js).
  const [geocoding, setGeocoding] = useState(false);
  // Day costs panel (#907 slice 4) — collapsible + lazy-fetched.
  const [dayCostsOpen, setDayCostsOpen] = useState(false);
  const [dayCosts, setDayCosts] = useState(null); // { days, grandTotal, totalDays, averageDailyCost }
  const [dayCostsLoading, setDayCostsLoading] = useState(false);
  // Suppliers for the item form's supplier picker (replaces the raw numeric
  // "Supplier ID" field). Fetched once; tolerant of failure (picker just
  // shows "— None —").
  const [suppliers, setSuppliers] = useState([]);
  // Map state — client-side geocoded copy of itin.items (never saved to server
  // from here; the editor handles persistence). Items without lat/lng get
  // geocoded progressively so markers appear as they resolve.
  const [mapItems, setMapItems] = useState([]);
  const [destCenter, setDestCenter] = useState(null); // { lat, lng } for destination fallback

  const load = () => {
    setLoading(true);
    fetchApi(`/api/travel/itineraries/${id}`)
      .then((res) => setItin(res))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load itinerary");
        setItin(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchApi("/api/travel/suppliers?limit=500")
      .then((res) => setSuppliers(Array.isArray(res) ? res : (res?.suppliers || [])))
      .catch(() => setSuppliers([]));
  }, []);

  // Geocode missing coordinates for map display. Runs whenever the itinerary
  // loads or changes. Uses the existing geocoder.js LRU + 1 req/sec rate limiter
  // so we never hammer Nominatim. Updates mapItems progressively (one marker
  // appears at a time) rather than waiting for all geocodes to complete.
  useEffect(() => {
    if (!itin) { setMapItems([]); setDestCenter(null); return; }

    const items = Array.isArray(itin.items) ? itin.items : [];
    // Seed immediately with existing data so already-geocoded items show at once.
    // Normalise locationName from description so MapPreview popup has a label.
    setMapItems(items.map((it) => ({ ...it, locationName: it.description || '' })));
    setDestCenter(null);

    let cancelled = false;
    (async () => {
      // 1. Geocode the trip destination (e.g. "Paris") for center fallback.
      if (itin.destination) {
        const r = await geocode(itin.destination).catch(() => null);
        if (!cancelled && r) setDestCenter({ lat: r.lat, lng: r.lng });
      }
      // 2. Geocode each item that has a description but no coordinates yet.
      for (const it of items) {
        if (cancelled) break;
        if (!it.description) continue;
        if (it.latitude != null && it.longitude != null) continue;
        const r = await geocode(it.description).catch(() => null);
        if (!cancelled && r) {
          setMapItems((prev) =>
            prev.map((m) =>
              m.id === it.id ? { ...m, latitude: r.lat, longitude: r.lng } : m
            )
          );
        }
      }
    })();
    return () => { cancelled = true; };
  }, [itin]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async () => {
    if (!await notify.confirm({
      title: "Accept Itinerary",
      message: "Mark this itinerary as accepted? This also fans out WebCheckin rows for every flight item.",
      confirmText: "Accept",
    })) return;
    try {
      await fetchApi(`/api/travel/itineraries/${id}/accept`, { method: "POST", body: JSON.stringify({}) });
      notify.success("Itinerary accepted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to accept itinerary");
    }
  };

  const reject = async () => {
    const reason = await notify.prompt({
      title: "Reject Itinerary",
      message: "Reason for rejection? (optional, logged for audit)",
      placeholder: "Enter reason…",
    });
    if (reason === null) return; // user cancelled prompt
    try {
      await fetchApi(`/api/travel/itineraries/${id}/reject`, {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      });
      notify.success("Itinerary rejected");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to reject itinerary");
    }
  };

  const regenDraft = async () => {
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/draft/regen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setRegenStub({ model: res?.model, stub: Boolean(res?.stub) });
      notify.success("Draft regenerated");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to regenerate draft");
    }
  };

  // Admin resolution of a customer-initiated cancellation request.
  // decision ∈ "approve" | "decline" | "refunded".
  const resolveCancellation = async (decision) => {
    const r = itin.cancellationRefund;
    const cur = (itin.currency || "INR") === "INR" ? "₹" : `${itin.currency} `;
    const refundAmt = r && r.computable && r.refundAmount != null ? Number(r.refundAmount) : null;
    const refundedMsg = refundAmt
      ? `Process the refund of ${cur}${refundAmt.toLocaleString("en-IN")} to the customer via Razorpay, per the cancellation policy${r.policyName ? ` (${r.policyName})` : ""}? This cannot be undone.`
      : "Mark the refund as processed? No gateway charge was found for this booking, so record the refund in your books. The customer will be notified.";
    const confirms = {
      approve: "Approve this cancellation? The booking will be marked cancelled and the customer notified — then process the policy refund.",
      decline: "Decline this cancellation request? The booking continues and the customer is notified.",
      refunded: refundedMsg,
    };
    if (!await notify.confirm({
      title: "Confirm Action",
      message: confirms[decision],
      confirmText: decision === "refunded" ? "Process refund" : "Confirm",
      destructive: decision !== "decline",
    })) return;
    const note = await notify.prompt({
      title: "Customer Note",
      message: "Add a short note for the customer (optional)",
      placeholder: "Note…",
    });
    if (note === null) return; // operator cancelled the prompt
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/cancellation`, {
        method: "PATCH",
        body: JSON.stringify({ decision, note: note || undefined }),
      });
      if (decision === "refunded") {
        const g = res?.refund?.gatewayRefund;
        notify.success(
          g?.id
            ? `Refund of ${cur}${Number(g.amount).toLocaleString("en-IN")} processed (${g.id})`
            : "Refund recorded",
        );
      } else {
        notify.success(decision === "approve" ? "Cancellation approved" : "Cancellation request declined");
      }
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to update the cancellation");
    }
  };

  const generateShare = async () => {
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/share`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      // Build the share link from the CURRENT origin so it matches the
      // environment the advisor is in — localhost in dev, the staging host
      // on staging, the prod domain in prod — instead of the server's
      // hardcoded PUBLIC_BASE_URL fallback. Fall back to the server-built
      // shareUrl if the token isn't present for any reason.
      const link = res?.shareToken
        ? `${window.location.origin}/p/itinerary/${res.shareToken}`
        : res?.shareUrl || null;
      setShareUrl(link);
      notify.success("Share link generated");
      // Sharing promotes a draft to "sent" server-side so the public link
      // works — refresh so the status badge reflects it without a reload.
      if (res?.status && itin && res.status !== itin.status) load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to generate share link");
    }
  };

  const copyShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      notify.success("Copied to clipboard");
    } catch {
      notify.error("Copy failed — select + Ctrl+C the URL");
    }
  };

  const addItem = async () => {
    if (!newItem.itemType || !newItem.description.trim()) {
      notify.error("itemType + description required");
      return;
    }
    try {
      const body = {
        itemType: newItem.itemType,
        description: newItem.description,
      };
      if (newItem.position !== "") body.position = Number(newItem.position);
      if (newItem.detailsJson !== "") body.detailsJson = newItem.detailsJson;
      if (newItem.supplierId !== "") body.supplierId = Number(newItem.supplierId);
      if (newItem.unitCost !== "") body.unitCost = Number(newItem.unitCost);
      if (newItem.markup !== "") body.markup = Number(newItem.markup);
      if (newItem.gstAmount !== "") body.gstAmount = Number(newItem.gstAmount);
      if (newItem.unit) body.unit = newItem.unit;
      if (newItem.quantity !== "") body.quantity = Number(newItem.quantity);
      if (newItem.direction) body.direction = newItem.direction;

      // S82 — geocode-on-create (PRD FR-3.4 carry-over from S10). If the
      // user hasn't manually placed the item on the map (latitude/longitude
      // not provided), try resolving the typed description ("Goa beach",
      // "Sheikh Zayed Mosque Abu Dhabi") via lib/geocoder.js's
      // free-text → {lat, lng} Nominatim wrapper.
      //
      // Fail-soft: geocode returns null on no-match, throws on network
      // outage — either way the POST proceeds without coords so the item
      // create flow is never blocked by a transient geocoder hiccup. The
      // 1-req/sec rate-limit + 500-entry LRU live inside lib/geocoder.js
      // so this call site stays trivially small.
      const manualLat = newItem.latitude;
      const manualLng = newItem.longitude;
      const hasManual =
        (manualLat !== undefined && manualLat !== null && manualLat !== "") ||
        (manualLng !== undefined && manualLng !== null && manualLng !== "");
      if (hasManual) {
        if (manualLat !== undefined && manualLat !== null && manualLat !== "") {
          body.latitude = Number(manualLat);
        }
        if (manualLng !== undefined && manualLng !== null && manualLng !== "") {
          body.longitude = Number(manualLng);
        }
      } else if (newItem.description && newItem.description.trim()) {
        setGeocoding(true);
        try {
          const hit = await geocode(newItem.description);
          if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) {
            body.latitude = hit.lat;
            body.longitude = hit.lng;
          }
        } catch (_e) {
          // Swallow — the user can still place the pin manually on the
          // day-planner page after the item is created.
        } finally {
          setGeocoding(false);
        }
      }
      // totalPrice is computed server-side (Rate × Qty + Markup + GST).
      await fetchApi(`/api/travel/itineraries/${id}/items`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Item added");
      setNewItem(EMPTY_ITEM);
      setAdding(false);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add item");
    }
  };

  const saveItem = async () => {
    if (!editing) return;
    if (!editing.itemType || !editing.description?.trim()) {
      notify.error("itemType + description required");
      return;
    }
    try {
      const body = {
        itemType: editing.itemType,
        description: editing.description,
      };
      if (editing.position !== "" && editing.position != null) body.position = Number(editing.position);
      if (editing.detailsJson !== "" && editing.detailsJson != null) body.detailsJson = editing.detailsJson;
      if (editing.supplierId !== "" && editing.supplierId != null) body.supplierId = Number(editing.supplierId);
      if (editing.unitCost !== "" && editing.unitCost != null) body.unitCost = Number(editing.unitCost);
      if (editing.markup !== "" && editing.markup != null) body.markup = Number(editing.markup);
      if (editing.gstAmount !== "" && editing.gstAmount != null) body.gstAmount = Number(editing.gstAmount);
      if (editing.unit) body.unit = editing.unit;
      if (editing.quantity !== "" && editing.quantity != null) body.quantity = Number(editing.quantity);
      body.direction = editing.direction || "";
      // totalPrice is computed server-side (Rate × Qty + Markup + GST).
      await fetchApi(`/api/travel/itineraries/${id}/items/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      notify.success("Item saved");
      setEditing(null);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save item");
    }
  };

  const deleteItem = async (item) => {
    if (!await notify.confirm({ title: "Delete Item", message: `Delete "${item.description}"?`, confirmText: "Delete", destructive: true })) return;
    try {
      await fetchApi(`/api/travel/itineraries/${id}/items/${item.id}`, { method: "DELETE" });
      notify.success("Item deleted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete item");
    }
  };

  // Day costs panel (#907 slice 4) — lazy fetch on first expand.
  // Consumes GET /api/travel/itineraries/:id/day-costs (slice 2 / 5ca25585).
  // Response envelope: { itineraryId, days[], grandTotal, totalDays, averageDailyCost }
  // where each day = { dayOffset, items[], totalCost, itemCount, byType }.
  const loadDayCosts = async () => {
    setDayCostsLoading(true);
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/day-costs`);
      setDayCosts(res || null);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to load day costs");
      setDayCosts(null);
    } finally {
      setDayCostsLoading(false);
    }
  };

  const toggleDayCosts = () => {
    const next = !dayCostsOpen;
    setDayCostsOpen(next);
    // Lazy fetch on first expand; refetch only via explicit refresh action.
    if (next && dayCosts == null && !dayCostsLoading) {
      loadDayCosts();
    }
  };

  if (loading) {
    return <div style={{ padding: 24 }}>Loading&hellip;</div>;
  }
  if (!itin) {
    return <div style={{ padding: 24 }}>Itinerary not found.</div>;
  }

  const status = itin.status || "draft";
  const isTerminal = status === "accepted" || status === "rejected"
    || status === "advance_paid" || status === "fully_paid";
  // totalAmount is the GROUP total (sum of item line totals); per-person is
  // derived as group / travelers.
  const pax = itin.pax && itin.pax > 0 ? itin.pax : 1;
  const perPerson = itin.totalAmount != null
    ? Math.round((Number(itin.totalAmount) / pax) * 100) / 100
    : null;
  const savePax = async (n) => {
    const p = parseInt(n, 10);
    if (!Number.isFinite(p) || p < 1 || p === pax) return;
    try {
      await fetchApi(`/api/travel/itineraries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pax: p }),
      });
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to update travelers");
    }
  };
  // PDF download uses a plain link; back-end accepts cookie OR bearer.
  // For bearer-only sessions, append token via query string would require a
  // server tweak — keep the link simple for now and document inline.
  const token = typeof getAuthToken === "function" ? getAuthToken() : null;
  const pdfHref = `/api/travel/itineraries/${id}/pdf${token ? `?_t=${encodeURIComponent(token)}` : ""}`;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
              <MapIcon size={28} aria-hidden /> {itin.destination || "Itinerary"}
            </h1>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <span style={{
                background: "var(--subtle-bg-3, var(--subtle-bg))", color: "var(--primary-color, var(--accent-color))",
                padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: 0.5,
              }}>
                {itin.subBrand}
              </span>
              <StatusBadge status={status} />
              <TierBadge tier={itin.productTier} />
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                {fmtDate(itin.startDate)} → {fmtDate(itin.endDate)}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 13 }}>
                Travelers:
                {canEdit ? (
                  <input
                    type="number"
                    min={1}
                    defaultValue={pax}
                    onBlur={(e) => savePax(e.target.value)}
                    aria-label="Number of travelers"
                    style={{ width: 56, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border-color)", background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13 }}
                  />
                ) : (
                  <strong style={{ color: "var(--text-primary)" }}>{pax}</strong>
                )}
              </span>
              <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>
                Per person: {fmtMoney(perPerson, itin.currency)}
              </span>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Group ({pax}): {fmtMoney(itin.totalAmount, itin.currency)}
              </span>
              {itin.updatedAt && (
                <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                  Updated {new Date(itin.updatedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canEdit && !isTerminal && (
              <>
                <button type="button" onClick={accept} style={primaryBtn} aria-label="Accept itinerary">
                  <Check size={14} /> Accept
                </button>
                <button type="button" onClick={reject} style={dangerBtn} aria-label="Reject itinerary">
                  <XCircle size={14} /> Reject
                </button>
              </>
            )}
            {canEdit && (
              <button type="button" onClick={regenDraft} style={secondaryBtn} aria-label="Regenerate draft summary">
                <Sparkles size={14} /> Regenerate draft
              </button>
            )}
            <button type="button" onClick={generateShare} style={secondaryBtn} aria-label="Generate share link">
              <Share2 size={14} /> Share link
            </button>
            <a href={pdfHref} target="_blank" rel="noreferrer" style={{ ...secondaryBtn, textDecoration: "none" }}>
              <Download size={14} /> PDF
            </a>
            {/* FR-3.3/3.4 — open the visual day-by-day planner + map editor. */}
            <Link to={`/travel/itineraries/${id}/edit`} style={{ ...secondaryBtn, textDecoration: "none" }} aria-label="Open the day-by-day planner and map">
              <MapIcon size={14} /> Day planner
            </Link>
          </div>
        </div>
        {shareUrl && (
          <div style={{
            marginTop: 12, display: "flex", gap: 8, alignItems: "center",
            background: "var(--surface-color)", padding: 8, borderRadius: 6,
            border: "1px solid var(--border-color)",
          }}>
            <input
              type="text"
              readOnly
              value={shareUrl}
              aria-label="Share URL"
              style={{ ...input, flex: 1, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            />
            <button type="button" onClick={copyShare} style={iconBtn} aria-label="Copy share URL">
              <Copy size={16} />
            </button>
          </div>
        )}
      </header>

      {/* Customer-initiated cancellation — admin resolution surface. The portal
          sets cancellationStatus; here the advisor approves/declines/refunds. */}
      {itin.cancellationStatus && (
        <section
          aria-label="Cancellation request"
          style={{
            marginBottom: 20,
            padding: 16,
            borderRadius: 10,
            border: "1px solid",
            borderColor:
              itin.cancellationStatus === "refunded" ? "rgba(22,163,74,0.5)"
                : itin.cancellationStatus === "cancelled" ? "rgba(168,50,63,0.5)"
                  : "rgba(217,119,6,0.5)",
            background:
              itin.cancellationStatus === "refunded" ? "rgba(22,163,74,0.10)"
                : itin.cancellationStatus === "cancelled" ? "rgba(168,50,63,0.10)"
                  : "rgba(217,119,6,0.10)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <XCircle size={16} />
            <strong style={{ fontSize: 14 }}>
              {itin.cancellationStatus === "requested" && "Cancellation requested by customer"}
              {itin.cancellationStatus === "cancelled" && "Booking cancelled — refund pending"}
              {itin.cancellationStatus === "refunded" && "Booking cancelled & refunded"}
            </strong>
          </div>
          {itin.cancellationReason && (
            <p style={{ margin: "0 0 6px", fontSize: 13, color: "var(--text-secondary)" }}>
              Reason: &ldquo;{itin.cancellationReason}&rdquo;
            </p>
          )}
          <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--text-secondary)" }}>
            {Number(itin.advancePaidAmount) > 0
              ? `Paid so far: ${(itin.currency || "INR") === "INR" ? "₹" : `${itin.currency} `}${Number(itin.advancePaidAmount).toLocaleString("en-IN")}`
              : "No payment recorded yet."}
            {itin.cancellationRequestedAt && ` · Requested ${new Date(itin.cancellationRequestedAt).toLocaleDateString()}`}
          </p>
          {/* Policy-driven refund the approval will apply (computed server-side). */}
          {(() => {
            const r = itin.cancellationRefund;
            if (!r) return null;
            const cur = (r.currency || "INR") === "INR" ? "₹" : `${r.currency} `;
            const box = {
              margin: "0 0 12px", padding: "8px 10px", borderRadius: 8,
              background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-color)",
              fontSize: 12.5,
            };
            if (r.computable && r.refundAmount != null) {
              return (
                <div style={box}>
                  <strong>Refund per policy{r.policyName ? ` · ${r.policyName}` : ""}:</strong>{" "}
                  {cur}{Number(r.refundAmount).toLocaleString("en-IN")} ({r.refundPercent}% of {cur}{Number(r.paidAmount).toLocaleString("en-IN")} paid)
                  {r.daysRemaining != null && (
                    <span style={{ color: "var(--text-secondary)" }}> · {r.daysRemaining} day{r.daysRemaining === 1 ? "" : "s"} to departure</span>
                  )}
                </div>
              );
            }
            return (
              <div style={{ ...box, color: "var(--text-secondary)" }}>
                Refund can&apos;t be auto-calculated — {r.policyName ? "set a travel start date" : "assign a cancellation policy"} on this booking, then approve. Settle the refund manually per policy.
              </div>
            );
          })()}
          {canEdit && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {itin.cancellationStatus === "requested" && (
                <>
                  <button type="button" onClick={() => resolveCancellation("approve")} style={dangerBtn} aria-label="Approve cancellation">
                    <Check size={14} /> Approve cancellation
                  </button>
                  <button type="button" onClick={() => resolveCancellation("decline")} style={secondaryBtn} aria-label="Decline cancellation request">
                    <X size={14} /> Decline request
                  </button>
                </>
              )}
              {itin.cancellationStatus === "cancelled" && (
                <button type="button" onClick={() => resolveCancellation("refunded")} style={primaryBtn} aria-label="Process refund">
                  <Check size={14} /> Process refund
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <section style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Draft summary</h2>
          {regenStub && (
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              LLM: {regenStub.model || "—"}{regenStub.stub ? " (stub)" : ""}
            </span>
          )}
        </div>
        <div style={{
          background: "var(--surface-color)", padding: 16, borderRadius: 8,
          border: "1px solid var(--border-color)",
          whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5,
          color: itin.draftSummary ? "var(--text-primary)" : "var(--text-secondary)",
        }}>
          {itin.draftSummary || "No draft generated yet. Click Regenerate draft to create one."}
        </div>
      </section>

      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Items</h2>
          {canEdit && !adding && (
            <button type="button" onClick={() => setAdding(true)} style={primaryBtn}>
              <Plus size={14} /> Add item
            </button>
          )}
        </div>

        {adding && (
          <div style={{ background: "var(--surface-color)", padding: 16, borderRadius: 8, border: "1px solid var(--border-color)", marginBottom: 16 }}>
            <ItemFields values={newItem} suppliers={suppliers} onChange={(patch) => setNewItem({ ...newItem, ...patch })} />
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={addItem}
                disabled={geocoding}
                style={{ ...primaryBtn, opacity: geocoding ? 0.6 : 1, cursor: geocoding ? "wait" : "pointer" }}
              >
                {geocoding ? "Resolving location…" : "Save item"}
              </button>
              <button type="button" onClick={() => { setNewItem(EMPTY_ITEM); setAdding(false); }} style={secondaryBtn}>Cancel</button>
            </div>
          </div>
        )}

        <div style={{
          background: "var(--surface-color)", borderRadius: 8,
          border: "1px solid var(--border-color)", overflow: "hidden",
        }}>
          {!itin.items || itin.items.length === 0 ? (
            <div style={{ ...empty, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <span>No items yet. Add hotels, flights, transport and other trip costs here.</span>
              {canEdit && !adding && (
                <button type="button" onClick={() => setAdding(true)} style={primaryBtn}>
                  <Plus size={14} /> Add item
                </button>
              )}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Type</th>
                  <th style={th}>Description</th>
                  <th style={th}>Basis</th>
                  <th style={th}>Rate</th>
                  <th style={th}>Markup</th>
                  <th style={th}>Line total</th>
                  {canEdit && <th style={th} colSpan={2}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {itin.items.map((item) => {
                  const Icon = ITEM_ICONS[item.itemType] || Briefcase;
                  return (
                    <tr key={item.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                      <td style={td}>{item.position}</td>
                      <td style={td}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <Icon size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
                          {item.itemType}
                        </span>
                        {item.direction && (
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            {item.direction === "round_trip" ? "round-trip" : "one-way"}
                          </div>
                        )}
                      </td>
                      <td style={td}><strong>{item.description}</strong></td>
                      <td style={{ ...td, fontSize: 12, color: "var(--text-secondary)" }}>
                        {unitLabel(item.unit)}
                        {item.quantity != null ? ` × ${Number(item.quantity)}` : ""}
                      </td>
                      <td style={td}>{fmtMoney(item.unitCost, itin.currency)}</td>
                      <td style={td}>{fmtMoney(item.markup, itin.currency)}</td>
                      <td style={td}>{fmtMoney(item.totalPrice, itin.currency)}</td>
                      {canEdit && (
                        <>
                          <td style={{ ...td, width: 0 }}>
                            <button type="button" onClick={() => setEditing({ ...item })} style={iconBtn} aria-label={`Edit item ${item.description}`}>
                              <Pencil size={16} />
                            </button>
                          </td>
                          <td style={{ ...td, width: 0 }}>
                            <button type="button" onClick={() => deleteItem(item)} style={{ ...iconBtn, color: "var(--danger-color)" }} aria-label={`Delete item ${item.description}`}>
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* S127 — MapPreview block above the day-by-day breakdown. Items
          returned by GET /api/travel/itineraries/:id already carry
          latitude/longitude/dayNumber (backend includes items in the
          detail-endpoint response), so the map renders directly off
          itin.items without an extra fetch. Suppressed when the
          itinerary has no items at all — MapPreview's own pinnableItems
          handles the partially-geocoded case (some items missing
          coords) by silently skipping them, so we only short-circuit on
          truly-empty lists. */}
      {Array.isArray(itin.items) && itin.items.length > 0 && (
        <section style={{ marginTop: 20 }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 8,
          }}>
            <h2 style={{ margin: 0, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <MapIcon size={18} aria-hidden /> Trip map
            </h2>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {mapItems.some((it) => it.latitude != null && it.longitude != null)
                ? "Pins show day-planner locations — colour-coded by day"
                : destCenter
                  ? `Centred on ${itin.destination} — geocoding places…`
                  : "Geocoding locations…"}
            </span>
          </div>
          <div style={{
            background: "var(--surface-color)", borderRadius: 8,
            border: "1px solid var(--border-color)", overflow: "hidden",
          }}>
            {(() => {
              const hasPins = mapItems.some(
                (it) => it.latitude != null && it.longitude != null &&
                         Number.isFinite(Number(it.latitude)) && Number.isFinite(Number(it.longitude))
              );
              return (
                <MapPreview
                  items={mapItems}
                  height={320}
                  centerLat={!hasPins && destCenter ? destCenter.lat : undefined}
                  centerLng={!hasPins && destCenter ? destCenter.lng : undefined}
                  zoom={!hasPins && destCenter ? 11 : undefined}
                />
              );
            })()}
          </div>
        </section>
      )}

      <section style={{ marginTop: 20 }}>
        <button
          type="button"
          onClick={toggleDayCosts}
          aria-expanded={dayCostsOpen}
          aria-controls="day-costs-panel"
          style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            justifyContent: "flex-start", padding: "10px 12px",
            background: "var(--subtle-bg)", border: "1px solid var(--border-color)",
            borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {dayCostsOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          <Calendar size={16} aria-hidden style={{ color: "var(--primary-color, var(--accent-color))" }} />
          Day costs
          <span style={{ flex: 1 }} />
          {dayCosts && (
            <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 400 }}>
              {dayCosts.totalDays} day{dayCosts.totalDays === 1 ? "" : "s"} · {fmtMoney(dayCosts.grandTotal, itin.currency)}
            </span>
          )}
        </button>

        {dayCostsOpen && (
          <div
            id="day-costs-panel"
            role="region"
            aria-label="Day costs breakdown"
            style={{
              marginTop: 8, background: "var(--surface-color)",
              border: "1px solid var(--border-color)", borderRadius: 8,
              padding: 16,
            }}
          >
            {dayCostsLoading ? (
              <div style={empty}>Loading day costs&hellip;</div>
            ) : !dayCosts ? (
              <div style={empty}>Day costs unavailable.</div>
            ) : !dayCosts.days || dayCosts.days.length === 0 ? (
              <div style={empty}>No items in this itinerary &mdash; add items to see day-by-day costs.</div>
            ) : (
              <>
                <div style={{
                  display: "grid", gap: 12,
                  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
                  marginBottom: 16,
                }}>
                  <SummaryTile label="Total days" value={String(dayCosts.totalDays)} />
                  <SummaryTile label="Grand total" value={fmtMoney(dayCosts.grandTotal, itin.currency)} />
                  <SummaryTile label="Avg daily cost" value={fmtMoney(dayCosts.averageDailyCost, itin.currency)} />
                  {/* #907 slice 5 — per-trip margin breakdown. Rendered when
                      the envelope carries the new fields (older backends
                      may not). PRD §3.6(d) pricing transparency. */}
                  {dayCosts.grandSupplierCost != null && (
                    <SummaryTile
                      label="Supplier cost"
                      value={fmtMoney(dayCosts.grandSupplierCost, itin.currency)}
                    />
                  )}
                  {dayCosts.grandMarkupTotal != null && (
                    <SummaryTile
                      label="Markup"
                      value={fmtMoney(dayCosts.grandMarkupTotal, itin.currency)}
                    />
                  )}
                  {dayCosts.grandGstTotal != null && (
                    <SummaryTile
                      label="GST"
                      value={fmtMoney(dayCosts.grandGstTotal, itin.currency)}
                    />
                  )}
                </div>

                <div style={{
                  background: "var(--bg-color)", borderRadius: 6,
                  border: "1px solid var(--border-light, var(--border-color))",
                  overflowX: "auto",
                }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={th}>Day</th>
                        <th style={th}>Items</th>
                        <th style={th}>Total</th>
                        <th style={th}>By type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dayCosts.days.map((d) => (
                        <tr key={d.dayOffset} style={{ borderTop: "1px solid var(--border-light)" }}>
                          <td style={td}>
                            <strong>Day {d.dayOffset + 1}</strong>
                          </td>
                          <td style={td}>{d.itemCount}</td>
                          <td style={td}>
                            <div>{fmtMoney(d.totalCost, itin.currency)}</div>
                            {/* #907 slice 5 — per-day margin caption.
                                Rendered when the envelope carries the
                                breakdown (older backends may not). */}
                            {(d.supplierCost != null || d.markupTotal != null || d.gstTotal != null) && (
                              <div
                                style={{
                                  fontSize: 11, color: "var(--text-secondary)",
                                  marginTop: 4, lineHeight: 1.4,
                                }}
                                aria-label={`Day ${d.dayOffset + 1} margin breakdown`}
                              >
                                {d.supplierCost != null && (
                                  <span>Supplier {fmtMoney(d.supplierCost, itin.currency)}</span>
                                )}
                                {d.markupTotal != null && (
                                  <span> · Markup {fmtMoney(d.markupTotal, itin.currency)}</span>
                                )}
                                {d.gstTotal != null && (
                                  <span> · GST {fmtMoney(d.gstTotal, itin.currency)}</span>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={td}>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {Object.entries(d.byType || {}).map(([type, amount]) => {
                                const Icon = ITEM_ICONS[type] || Briefcase;
                                return (
                                  <span
                                    key={type}
                                    title={`${type}: ${fmtMoney(amount, itin.currency)}`}
                                    style={{
                                      display: "inline-flex", alignItems: "center", gap: 4,
                                      padding: "2px 8px", borderRadius: 12, fontSize: 11,
                                      background: "var(--subtle-bg)", color: "var(--text-primary)",
                                      border: "1px solid var(--border-light, var(--border-color))",
                                    }}
                                  >
                                    <Icon size={11} aria-hidden style={{ color: "var(--text-secondary)" }} />
                                    {type} · {fmtMoney(amount, itin.currency)}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {editing && (
        <div
          role="dialog"
          aria-label="Edit item"
          onClick={() => setEditing(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface-color)", padding: 24, borderRadius: 12,
              maxWidth: 720, width: "100%", border: "1px solid var(--border-color)",
              maxHeight: "90vh", overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <strong>Edit item</strong>
              <button type="button" onClick={() => setEditing(null)} style={iconBtn} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <ItemFields values={editing} suppliers={suppliers} onChange={(patch) => setEditing({ ...editing, ...patch })} />
            <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setEditing(null)} style={secondaryBtn}>Cancel</button>
              <button type="button" onClick={saveItem} style={primaryBtn}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div style={{
      background: "var(--bg-color)", padding: 12, borderRadius: 6,
      border: "1px solid var(--border-light, var(--border-color))",
    }}>
      <div style={{
        fontSize: 11, color: "var(--text-secondary)",
        textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

function ItemFields({ values, suppliers = [], onChange }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
        <label style={fieldLabel}>
          Type
          <select value={values.itemType} onChange={(e) => onChange({ itemType: e.target.value })} style={input}>
            {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {TRANSPORT_TYPES.includes(values.itemType) && (
          <label style={fieldLabel}>
            Direction
            <select value={values.direction ?? ""} onChange={(e) => onChange({ direction: e.target.value })} style={input}>
              {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <span style={hintLabel}>One-way or round-trip.</span>
          </label>
        )}
        <label style={fieldLabel}>
          Order
          <input
            type="number"
            min={0}
            value={values.position ?? ""}
            onChange={(e) => onChange({ position: e.target.value })}
            style={input}
            placeholder="auto"
          />
          <span style={hintLabel}>Sequence in the trip. Leave blank to add at the end.</span>
        </label>
        <label style={fieldLabel}>
          Supplier
          <select
            value={values.supplierId ?? ""}
            onChange={(e) => onChange({ supplierId: e.target.value })}
            style={input}
          >
            <option value="">— None —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.subBrand ? ` (${s.subBrand})` : ""}
              </option>
            ))}
          </select>
          <span style={hintLabel}>Who you&rsquo;re booking this through (optional).</span>
        </label>
      </div>
      <label style={fieldLabel}>
        Description
        <input value={values.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} style={input} placeholder="e.g. IndiGo 6E-237 BLR → MAA" />
      </label>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))" }}>
        <label style={fieldLabel}>
          Basis
          <select value={values.unit ?? "per_person"} onChange={(e) => onChange({ unit: e.target.value })} style={input}>
            {ITEM_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
          <span style={hintLabel}>What the rate is for.</span>
        </label>
        <label style={fieldLabel}>
          Quantity
          <input type="number" step="0.01" min={0} value={values.quantity ?? ""} onChange={(e) => onChange({ quantity: e.target.value })} style={input} placeholder="1" />
          <span style={hintLabel}>How many units (travelers, nights…).</span>
        </label>
        <label style={fieldLabel}>
          Rate
          <input type="number" step="0.01" min={0} value={values.unitCost ?? ""} onChange={(e) => onChange({ unitCost: e.target.value })} style={input} />
          <span style={hintLabel}>Cost of one unit (supplier price).</span>
        </label>
        <label style={fieldLabel}>
          Markup
          <input type="number" step="0.01" min={0} value={values.markup ?? ""} onChange={(e) => onChange({ markup: e.target.value })} style={input} />
          <span style={hintLabel}>Your margin on top of cost.</span>
        </label>
        <label style={fieldLabel}>
          GST amount
          <input type="number" step="0.01" min={0} value={values.gstAmount ?? ""} onChange={(e) => onChange({ gstAmount: e.target.value })} style={input} />
        </label>
        <label style={fieldLabel}>
          Line total
          <input type="text" readOnly value={lineTotalOf(values).toLocaleString("en-IN")} style={{ ...input, opacity: 0.75, cursor: "not-allowed" }} />
          <span style={hintLabel}>Rate × Qty + Markup + GST (auto).</span>
        </label>
      </div>
      <label style={fieldLabel}>
        Details JSON (optional, type-specific payload)
        <textarea
          value={values.detailsJson ?? ""}
          onChange={(e) => onChange({ detailsJson: e.target.value })}
          placeholder='e.g. {"pnr":"ABC123","cabin":"economy"}'
          style={{ ...input, minHeight: 80, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
        />
      </label>
    </div>
  );
}

const input = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13,
  width: "100%",
};
const fieldLabel = {
  display: "grid", gap: 4, fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)",
};
const hintLabel = {
  fontSize: 11, textTransform: "none", letterSpacing: 0,
  color: "var(--text-secondary)", opacity: 0.8, fontWeight: 400,
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color, var(--accent-color))", color: "#fff",
  border: "none", cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const dangerBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--danger-color, #A8323F)", color: "#fff",
  border: "none", cursor: "pointer",
};
const iconBtn = {
  padding: 6, borderRadius: 4,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
