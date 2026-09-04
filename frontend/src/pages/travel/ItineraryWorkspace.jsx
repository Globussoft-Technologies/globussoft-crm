// Travel CRM — unified Itinerary Workspace.
//
// Replaces the old two-page split (ItineraryDetail = money/status/lifecycle,
// ItineraryEditor = days/map/AI). That split was the core usability problem:
// neither page could see the other's half of the same record, so an operator
// had to bounce between routes to give one item both a day and a price, and
// the day planner had no edit or delete at all.
//
// Everything now lives on /travel/itineraries/:id behind four tabs:
//   Plan     day-by-day planner — quick-add, expand-in-place editing, drag
//   Pricing  per-line money table grouped by day, plus the trip rollup
//   Details  title / intro / inclusions / exclusions / other / terms — the
//            content blocks the branded PDF renders
//   Context  diagnostic + curriculum + quote context, AI draft summary
//
// Item ordering is (dayNumber, startTime, position). startTime/endTime/
// locationName are real columns now; legacy rows that kept them inside
// detailsJson are read through readSchedule() so both shapes behave the same.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft, Plane, Hotel, MapPin, Car, Bus, Train, Camera, Utensils,
  FileText, Shield, Package, Plus, Trash2, Copy, GripVertical, Sparkles,
  Download, Share2, Cloud, BookmarkPlus, Clock, ChevronDown,
  ChevronRight, X, Check, Calendar, ExternalLink, Loader2, Tag, Info,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import MapPreview from "../../components/MapPreview";
import LocationAutocomplete from "../../components/travel/LocationAutocomplete";
import { geocode } from "../../lib/geocoder";
import { buildItineraryGeocodeQuery } from "../../lib/travelLocationResolver";

// The 12 server-validated itemTypes (backend VALID_ITEM_TYPES). Order here is
// the order they appear in the type picker — most-used first.
const ITEM_TYPES = [
  { value: "activity", label: "Activity", Icon: Camera },
  { value: "sightseeing", label: "Sightseeing", Icon: MapPin },
  { value: "meals", label: "Meals", Icon: Utensils },
  { value: "hotel", label: "Hotel", Icon: Hotel },
  { value: "transfer", label: "Transfer", Icon: Car },
  { value: "flight", label: "Flight", Icon: Plane },
  { value: "train", label: "Train", Icon: Train },
  { value: "bus", label: "Bus", Icon: Bus },
  { value: "cab", label: "Cab", Icon: Car },
  { value: "visa", label: "Visa", Icon: FileText },
  { value: "insurance", label: "Insurance", Icon: Shield },
  { value: "other", label: "Other", Icon: Package },
];
const TYPE_META = Object.fromEntries(ITEM_TYPES.map((t) => [t.value, t]));
const ITEM_UNITS = ["per_person", "per_night", "per_room_night", "per_day", "per_group"];

// Item-type-specific detail fields. The generic Location field (below) covers
// sightseeing/activity/meals/other/custom types adequately; these types get
// something more useful instead. Values live inside detailsJson, keyed the
// same as here, so opening an existing item repopulates the right fields.
const TYPE_DETAIL_SCHEMAS = {
  flight: [
    { key: "fromLocation", label: "From", type: "location" },
    { key: "toLocation", label: "To", type: "location" },
    { key: "airline", label: "Airline", type: "text", width: 140 },
    { key: "flightNumber", label: "Flight #", type: "text", width: 100 },
    { key: "pnr", label: "PNR", type: "text", width: 100 },
  ],
  train: [
    { key: "fromLocation", label: "From", type: "location" },
    { key: "toLocation", label: "To", type: "location" },
    { key: "trainNumber", label: "Train #", type: "text", width: 120 },
  ],
  bus: [
    { key: "fromLocation", label: "From", type: "location" },
    { key: "toLocation", label: "To", type: "location" },
  ],
  cab: [
    { key: "fromLocation", label: "From", type: "location" },
    { key: "toLocation", label: "To", type: "location" },
  ],
  transfer: [
    { key: "fromLocation", label: "From", type: "location" },
    { key: "toLocation", label: "To", type: "location" },
  ],
  hotel: [
    { key: "checkInDate", label: "Check-in", type: "date", width: 140 },
    { key: "checkOutDate", label: "Check-out", type: "date", width: 140 },
    { key: "roomType", label: "Room type", type: "text", width: 150 },
    { key: "mealPlan", label: "Meal plan", type: "text", width: 130 },
  ],
  visa: [
    { key: "provider", label: "Provider", type: "text", width: 180 },
    { key: "referenceNumber", label: "Reference #", type: "text", width: 150 },
  ],
  insurance: [
    { key: "provider", label: "Provider", type: "text", width: 180 },
    { key: "referenceNumber", label: "Policy #", type: "text", width: 150 },
  ],
};
// Types that replace the single generic Location field with From/To instead
// of showing both — a flight doesn't have one place, it has two.
const FROM_TO_TYPES = new Set(["flight", "train", "bus", "cab", "transfer"]);
// Every key any schema manages, so switching an item's type can strip the
// previous type's now-irrelevant fields out of detailsJson instead of letting
// them linger as orphaned data (e.g. a `roomType` surviving a Hotel → Flight
// change).
const ALL_SCHEMA_KEYS = new Set(
  Object.values(TYPE_DETAIL_SCHEMAS).flatMap((fields) => fields.map((f) => f.key)),
);

// Read the type-specific extras back out of an item's detailsJson.
function readTypeDetails(item) {
  if (!item?.detailsJson) return {};
  try {
    const parsed = typeof item.detailsJson === "string" ? JSON.parse(item.detailsJson) : item.detailsJson;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const key of ALL_SCHEMA_KEYS) if (parsed[key] != null) out[key] = parsed[key];
    return out;
  } catch { return {}; }
}

// Merge new type-specific extras into an item's existing detailsJson,
// preserving unrelated keys (notes, pricingLink, poiId, …) and dropping stale
// fields from whatever the PREVIOUS item type left behind.
function buildDetailsJson(item, itemType, extra) {
  let details = {};
  if (item?.detailsJson) {
    try {
      const parsed = typeof item.detailsJson === "string" ? JSON.parse(item.detailsJson) : item.detailsJson;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = { ...parsed };
    } catch { details = {}; }
  }
  for (const key of ALL_SCHEMA_KEYS) delete details[key];
  delete details.startTime;
  delete details.endTime;
  delete details.locationName;
  const schema = TYPE_DETAIL_SCHEMAS[itemType];
  if (schema) {
    for (const f of schema) {
      const v = extra[f.key];
      if (v != null && String(v).trim() !== "") details[f.key] = String(v).trim();
    }
  }
  return Object.keys(details).length ? JSON.stringify(details) : null;
}

const TABS = [
  { id: "plan", label: "Plan" },
  { id: "pricing", label: "Pricing" },
  { id: "details", label: "Details" },
  { id: "template", label: "Template details" },
  { id: "context", label: "Context" },
];

// ── pure helpers ──────────────────────────────────────────────────────

// Legacy read-compat mirror of the backend's resolveItemSchedule(): rows
// created before startTime/endTime/locationName became columns still carry
// them inside detailsJson. Column wins whenever it's set.
function readSchedule(item) {
  let details = null;
  if (item?.detailsJson) {
    try {
      const parsed = typeof item.detailsJson === "string" ? JSON.parse(item.detailsJson) : item.detailsJson;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed;
    } catch { details = null; }
  }
  const pick = (col, key) => {
    if (col != null && String(col).trim() !== "") return String(col);
    const v = details && details[key];
    return v != null && String(v).trim() !== "" ? String(v) : "";
  };
  return {
    startTime: pick(item?.startTime, "startTime"),
    endTime: pick(item?.endTime, "endTime"),
    locationName: pick(item?.locationName, "locationName"),
    notes: pick(null, "notes"),
  };
}

function timeRank(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  // Untimed items sort after timed ones, then fall back to `position`.
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.MAX_SAFE_INTEGER;
}

function sortDayItems(list) {
  return [...list].sort((a, b) => {
    const ta = timeRank(readSchedule(a).startTime);
    const tb = timeRank(readSchedule(b).startTime);
    if (ta !== tb) return ta - tb;
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

function money(value, currency = "INR") {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${currency === "INR" ? "₹" : `${currency} `}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function parseBullets(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((s) => String(s));
  } catch { /* fall through to newline split */ }
  return String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function dayDateLabel(startDate, dayNumber) {
  if (!startDate || !dayNumber) return null;
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + (dayNumber - 1));
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

// ── item type combobox ────────────────────────────────────────────────
//
// A custom dropdown (not a native <select>) so each row can carry an icon,
// built-in types read from ITEM_TYPES and tenant-defined ones from
// `customTypes` (fetched once at the Workspace level and shared by every
// picker instance). Typing a name that doesn't match anything offers
// "Add <name>" inline; custom rows get a small delete (×) the built-ins don't.

function ItemTypeCombobox({ value, onChange, customTypes, onAddCustom, onDeleteCustom, ariaLabel, width }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const allOptions = useMemo(() => [
    ...ITEM_TYPES,
    ...customTypes.map((t) => ({ value: t.key, label: t.label, Icon: Tag, custom: true, id: t.id })),
  ], [customTypes]);

  const current = allOptions.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const filtered = q ? allOptions.filter((o) => o.label.toLowerCase().includes(q)) : allOptions;
  const exactMatch = allOptions.some((o) => o.label.toLowerCase() === q);

  const commitAdd = async () => {
    const label = query.trim();
    if (!label || adding) return;
    setAdding(true);
    const created = await onAddCustom(label);
    setAdding(false);
    if (created) {
      onChange(created.key);
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: width || 150 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={S.comboTrigger}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current?.Icon ? <current.Icon size={14} /> : <Tag size={14} />}
        <span style={S.comboTriggerLabel}>{current?.label || "Select type"}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div style={S.comboPopover} role="listbox" aria-label={ariaLabel}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && q && !exactMatch) { e.preventDefault(); commitAdd(); }
            }}
            placeholder="Search or add a type…"
            style={S.comboSearch}
            aria-label="Search item types"
          />
          <div style={S.comboList}>
            {filtered.map((o) => (
              <div key={o.value} style={S.comboRow}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === o.value}
                  onClick={() => { onChange(o.value); setOpen(false); setQuery(""); }}
                  style={{ ...S.comboOption, ...(value === o.value ? S.comboOptionActive : null) }}
                >
                  <o.Icon size={14} /> {o.label}
                </button>
                {o.custom && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteCustom(o.id, o.value);
                    }}
                    style={S.comboDeleteBtn}
                    aria-label={`Delete ${o.label}`}
                    title="Delete this custom type"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
            {filtered.length === 0 && !q && (
              <div style={S.comboEmpty}>No types yet.</div>
            )}
            {q && !exactMatch && (
              <button type="button" onClick={commitAdd} disabled={adding} style={S.comboAddOption}>
                <Plus size={14} /> {adding ? "Adding…" : `Add "${query.trim()}"`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────

export default function ItineraryWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();

  const [itin, setItin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("plan");
  // The Pricing tab is hidden entirely in planning-only mode — if the
  // operator was sitting on it when they (or someone else) flip the toggle
  // off, bounce back to Plan rather than leaving a tab open that no longer
  // has a button pointing at it.
  useEffect(() => {
    if (itin && !itin.moneyEnabled && tab === "pricing") setTab("plan");
  }, [itin, tab]);

  const [templates, setTemplates] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [customItemTypes, setCustomItemTypes] = useState([]);
  const [cancellationPolicies, setCancellationPolicies] = useState([]);
  const [extraDays, setExtraDays] = useState(0);
  const [busyAction, setBusyAction] = useState(null); // 'catalogue' | 'kb' | 'template' | 'share'
  const [shareUrl, setShareUrl] = useState(null);
  const [dragItemId, setDragItemId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { day, index } | null
  const [aiFillBusy, setAiFillBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchApi(`/api/travel/itineraries/${id}`);
      setItin(data);
      setError(null);
    } catch (e) {
      setError(e?.body?.error || e?.message || "Failed to load itinerary");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Template picker + supplier picker feeds. Both silent — a failure here
  // must not block the planner.
  useEffect(() => {
    if (!itin?.subBrand) return undefined;
    let cancelled = false;
    const qs = new URLSearchParams({ isActive: "true", subBrand: itin.subBrand, limit: "200" });
    fetchApi(`/api/travel/itinerary-templates?${qs}`, { silent: true })
      .then((r) => { if (!cancelled) setTemplates(Array.isArray(r?.items) ? r.items : []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [itin?.subBrand]);

  useEffect(() => {
    let cancelled = false;
    fetchApi("/api/travel/suppliers?limit=500", { silent: true })
      .then((r) => {
        if (cancelled) return;
        const rows = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
        setSuppliers(rows);
      })
      .catch(() => { if (!cancelled) setSuppliers([]); });
    return () => { cancelled = true; };
  }, []);

  const loadCustomItemTypes = useCallback(() => {
    if (!itin?.subBrand) return;
    fetchApi(`/api/travel/item-types?subBrand=${encodeURIComponent(itin.subBrand)}&active=true`, { silent: true })
      .then((r) => setCustomItemTypes(Array.isArray(r?.itemTypes) ? r.itemTypes : []))
      .catch(() => setCustomItemTypes([]));
  }, [itin?.subBrand]);
  useEffect(() => { loadCustomItemTypes(); }, [loadCustomItemTypes]);

  useEffect(() => {
    if (!itin?.subBrand) return undefined;
    let cancelled = false;
    fetchApi(`/api/travel/cancellation-policies?subBrand=${encodeURIComponent(itin.subBrand)}&active=true`, { silent: true })
      .then((r) => { if (!cancelled) setCancellationPolicies(Array.isArray(r?.policies) ? r.policies : []); })
      .catch(() => { if (!cancelled) setCancellationPolicies([]); });
    return () => { cancelled = true; };
  }, [itin?.subBrand]);

  const addCustomItemType = useCallback(async (label) => {
    try {
      const created = await fetchApi("/api/travel/item-types", {
        method: "POST",
        body: JSON.stringify({ label, subBrand: itin?.subBrand || null }),
      });
      setCustomItemTypes((prev) => [...prev, created]);
      return created;
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to add item type");
      return null;
    }
  }, [itin?.subBrand, notify]);

  const deleteCustomItemType = useCallback(async (typeId) => {
    const ok = await notify.confirm("Delete this item type? Items already using it keep working — it just stops appearing as an option.");
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/item-types/${typeId}`, { method: "DELETE" });
      setCustomItemTypes((prev) => prev.filter((t) => t.id !== typeId));
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to delete item type");
    }
  }, [notify]);

  const items = useMemo(() => (Array.isArray(itin?.items) ? itin.items : []), [itin]);
  const currency = itin?.currency || "INR";

  // Day count = date-range span ∪ highest dayNumber in use ∪ 1, plus any days
  // the operator appended locally with "+ Add day".
  const dayCount = useMemo(() => {
    let n = 1;
    if (itin?.startDate && itin?.endDate) {
      const ms = new Date(itin.endDate) - new Date(itin.startDate);
      if (Number.isFinite(ms) && ms >= 0) n = Math.max(n, Math.floor(ms / 86400000) + 1);
    }
    for (const it of items) if (it.dayNumber && it.dayNumber > n) n = it.dayNumber;
    return n + extraDays;
  }, [itin?.startDate, itin?.endDate, items, extraDays]);

  const itemsByDay = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      const key = it.dayNumber ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    for (const [k, v] of map) map.set(k, sortDayItems(v));
    return map;
  }, [items]);

  // Day-then-time order (NOT raw item-array/position order) so the route
  // map's connecting line traces the trip the way it's actually planned —
  // day 1's stops, then day 2's, etc. — instead of whatever order the
  // items happened to be created or fetched in.
  const mapItems = useMemo(() => {
    const flat = [];
    for (let d = 1; d <= dayCount; d += 1) flat.push(...(itemsByDay.get(d) || []));
    flat.push(...(itemsByDay.get(null) || [])); // unscheduled — pinned, but after every real day
    return flat
      .filter((it) => Number.isFinite(Number(it.latitude)) && Number.isFinite(Number(it.longitude)))
      .map((it) => ({ ...it, locationName: readSchedule(it).locationName || it.description }));
  }, [itemsByDay, dayCount]);

  // ── mutations ───────────────────────────────────────────────────────
  // Every mutation reloads the itinerary rather than patching local state,
  // because the server recomputes totalAmount (and can revive a `rejected`
  // itinerary to `revised`) on each item write.

  const patchItinerary = useCallback(async (body, { quiet = false } = {}) => {
    try {
      await fetchApi(`/api/travel/itineraries/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
      if (!quiet) notify.success("Saved");
      return true;
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to save");
      return false;
    }
  }, [id, load, notify]);

  const createItem = useCallback(async (body) => {
    try {
      await fetchApi(`/api/travel/itineraries/${id}/items`, { method: "POST", body: JSON.stringify(body) });
      await load();
      return true;
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to add item");
      return false;
    }
  }, [id, load, notify]);

  const updateItem = useCallback(async (itemId, body) => {
    try {
      await fetchApi(`/api/travel/itineraries/${id}/items/${itemId}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
      return true;
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to update item");
      return false;
    }
  }, [id, load, notify]);

  const deleteItem = useCallback(async (item) => {
    const ok = await notify.confirm(`Remove "${item.description}"?`);
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/itineraries/${id}/items/${item.id}`, { method: "DELETE" });
      await load();
      notify.success("Item removed");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to remove item");
    }
  }, [id, load, notify]);

  const duplicateItem = useCallback(async (item) => {
    try {
      await fetchApi(`/api/travel/itineraries/${id}/items/${item.id}/duplicate`, { method: "POST", body: JSON.stringify({}) });
      await load();
      notify.success("Item duplicated");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to duplicate item");
    }
  }, [id, load, notify]);

  // Reorder within a day, or move an item to a different day at a specific
  // position — both drag-and-drop cases collapse into the same operation:
  // "this item now belongs at index `index` of day `targetDay`". Renumbering
  // only the TARGET day's positions is sufficient — position only has to be
  // unique/ordered within its own day (see the per-day auto-position note on
  // the backend), so a gap left behind in the source day after a cross-day
  // move is harmless.
  const reorderItem = useCallback(async (itemId, targetDay, index) => {
    const dragged = items.find((i) => i.id === itemId);
    if (!dragged) return;
    const targetItems = sortDayItems(itemsByDay.get(targetDay) || []).filter((i) => i.id !== itemId);
    const clampedIndex = Math.max(0, Math.min(index, targetItems.length));
    targetItems.splice(clampedIndex, 0, dragged);

    // Optimistic local update so the row jumps immediately.
    setItin((prev) => prev && ({
      ...prev,
      items: prev.items.map((i) => {
        if (i.id !== itemId) return i;
        return { ...i, dayNumber: targetDay };
      }),
    }));

    const calls = [];
    targetItems.forEach((it, idx) => {
      const body = {};
      if (it.position !== idx) body.position = idx;
      if (it.id === itemId && (dragged.dayNumber ?? null) !== targetDay) body.dayNumber = targetDay;
      if (Object.keys(body).length) {
        calls.push(
          fetchApi(`/api/travel/itineraries/${id}/items/${it.id}`, { method: "PATCH", body: JSON.stringify(body) }),
        );
      }
    });
    try {
      await Promise.all(calls);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to reorder items");
    } finally {
      await load();
    }
  }, [items, itemsByDay, id, load, notify]);

  // Adding/removing a day must keep the trip's real endDate in sync — the
  // header's date range reads itin.endDate directly, so if we only bumped
  // the local extraDays counter the header would silently drift out of sync
  // with the day cards below it. When a startDate is set, extend/shrink the
  // real endDate; only fall back to the local-only extraDays counter when
  // there's no startDate yet to anchor a real date against.
  const addDay = useCallback(async () => {
    if (itin?.startDate) {
      const base = itin.endDate ? new Date(itin.endDate) : new Date(itin.startDate);
      base.setDate(base.getDate() + 1);
      await patchItinerary({ endDate: base.toISOString().slice(0, 10) }, { quiet: true });
    } else {
      setExtraDays((n) => n + 1);
    }
  }, [itin?.startDate, itin?.endDate, patchItinerary]);

  // Deleting a day removes its items, shifts every later day's items down by
  // one so there's no gap, and shrinks the trip's end date (or the
  // locally-added day count when there's no startDate) by one — the exact
  // mirror of what addDay does, so the header and the visible days never
  // drift apart.
  const deleteDay = useCallback(async (dayNum) => {
    if (dayCount <= 1) return;
    const dayItems = itemsByDay.get(dayNum) || [];
    const laterItems = items.filter((it) => it.dayNumber && it.dayNumber > dayNum);
    const ok = await notify.confirm(
      dayItems.length
        ? `Delete Day ${dayNum} and its ${dayItems.length} item${dayItems.length === 1 ? "" : "s"}? Later days shift up by one.`
        : `Delete Day ${dayNum}? Later days shift up by one.`,
    );
    if (!ok) return;
    try {
      await Promise.all([
        ...dayItems.map((it) => fetchApi(`/api/travel/itineraries/${id}/items/${it.id}`, { method: "DELETE" })),
        ...laterItems.map((it) => fetchApi(`/api/travel/itineraries/${id}/items/${it.id}`, {
          method: "PATCH",
          body: JSON.stringify({ dayNumber: it.dayNumber - 1 }),
        })),
      ]);
      if (itin?.startDate) {
        const base = itin.endDate ? new Date(itin.endDate) : new Date(itin.startDate);
        base.setDate(base.getDate() - 1);
        if (base >= new Date(itin.startDate)) {
          await fetchApi(`/api/travel/itineraries/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ endDate: base.toISOString().slice(0, 10) }),
          });
        }
      } else {
        setExtraDays((n) => Math.max(0, n - 1));
      }
      notify.success(`Day ${dayNum} deleted`);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to delete day");
    } finally {
      await load();
    }
  }, [id, items, itemsByDay, dayCount, itin?.startDate, itin?.endDate, load, notify]);

  // AI Suggest — drafts a day plan from the trip's destination via the
  // existing stateless suggest endpoint, then materialises the items
  // directly onto THIS itinerary (unlike /from-suggestion, which creates a
  // brand new one). Every materialised row is draftedByAi:true and, being
  // ordinary items, immediately editable through the same inline editor as
  // anything typed by hand.
  //
  // Always requests the FULL trip length (dayCount), never just
  // targetDayNumbers.length — the suggest endpoint treats a "days" request as
  // a self-contained trip, meaning day 1 gets an arrival flight and the LAST
  // day gets a return flight. Requesting `days: 1` for a single-day "AI fill"
  // on (say) day 3 of a 6-day trip made EVERY day look like day 1-of-1: its
  // own arrival flight AND its own return flight, duplicated across every
  // day the operator filled that way. Asking for the real trip length and
  // picking out just the requested day(s) by their actual position keeps
  // transport items where they belong — only on the trip's real first/last day.
  const aiFillDays = useCallback(async (targetDayNumbers) => {
    if (aiFillBusy) return;
    setAiFillBusy(true);
    try {
      const res = await fetchApi("/api/travel/itineraries/suggest", {
        method: "POST",
        body: JSON.stringify({
          destination: itin.destination,
          days: dayCount,
          subBrand: itin.subBrand,
        }),
      });
      const suggestedDays = Array.isArray(res?.suggestion?.days) ? res.suggestion.days : [];
      const creates = [];
      targetDayNumbers.forEach((targetDay) => {
        const day = suggestedDays[targetDay - 1];
        if (!day) return;
        (day.items || []).forEach((it) => {
          const locationQuery = buildItineraryGeocodeQuery(it, itin.destination);
          creates.push(
            (async () => {
              let coordinates = null;
              if (Number.isFinite(Number(it.latitude)) && Number.isFinite(Number(it.longitude))) {
                coordinates = { latitude: Number(it.latitude), longitude: Number(it.longitude) };
              } else if (locationQuery) {
                const resolved = await geocode(locationQuery).catch(() => null);
                if (resolved) coordinates = { latitude: resolved.lat, longitude: resolved.lng };
              }
              return fetchApi(`/api/travel/itineraries/${id}/items`, {
              method: "POST",
              body: JSON.stringify({
                itemType: it.itemType || "activity",
                description: it.description || it.name || "Suggested activity",
                dayNumber: targetDay,
                unitCost: it.estimatedCost ?? it.unitCost ?? null,
                // Carrying the suggested time through is what makes the
                // generated PDF show its TIME column — the reference
                // brochures all have one, and it stays blank if every item
                // on the trip is untimed.
                startTime: it.startTime ?? null,
                locationName: it.locationName ?? null,
                latitude: coordinates?.latitude ?? null,
                longitude: coordinates?.longitude ?? null,
                draftedByAi: true,
              }),
              });
            })(),
          );
        });
      });
      if (!creates.length) {
        notify.info("The AI didn't return any suggestions for this trip — try again or add items manually.");
        return;
      }
      await Promise.all(creates);
      await load();
      notify.success(`AI filled ${creates.length} item${creates.length === 1 ? "" : "s"} — review and edit freely.`);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "AI suggestion failed");
    } finally {
      setAiFillBusy(false);
    }
  }, [aiFillBusy, itin, dayCount, id, load, notify]);

  const handleShare = async () => {
    setBusyAction("share");
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/share`, { method: "POST", body: JSON.stringify({}) });
      const url = res?.shareUrl || res?.url || null;
      if (url) { setShareUrl(url); notify.success("Share link ready"); }
      else notify.info("Share link generated");
      await load();
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to create share link");
    } finally { setBusyAction(null); }
  };

  const handleAddToCatalogue = async () => {
    setBusyAction("catalogue");
    try {
      const res = await fetchApi(`/api/travel/itineraries/${id}/add-to-catalogue`, { method: "POST" });
      notify.success("Added to Drive catalogue");
      setItin((prev) => prev && ({
        ...prev,
        catalogueDriveFileId: res?.driveFileId,
        catalogueDriveViewLink: res?.driveViewLink,
      }));
    } catch (e) {
      const code = e?.body?.code;
      if (code === "DRIVE_NOT_CONNECTED") notify.error("Connect Google Drive in Travel Knowledge Base settings first");
      else if (code === "KB_ROOT_NOT_CONFIGURED") notify.error("Configure the Knowledge Base Drive root folder first");
      else notify.error(e?.body?.error || "Failed to add to catalogue");
    } finally { setBusyAction(null); }
  };

  const handleSaveAsTemplate = async () => {
    setBusyAction("template");
    try {
      const tpl = await fetchApi(`/api/travel/itineraries/${id}/save-as-template`, { method: "POST", body: JSON.stringify({}) });
      notify.success(`Saved as template: "${tpl?.name || "untitled"}"`);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to save as template");
    } finally { setBusyAction(null); }
  };

  if (loading) return <div style={S.pad}>Loading itinerary…</div>;
  if (error) return <div style={{ ...S.pad, color: "#A8323F" }}>{error} — <Link to="/travel/itineraries">back to itineraries</Link></div>;
  if (!itin) return null;

  const token = typeof getAuthToken === "function" ? getAuthToken() : null;
  const pdfHref = `/api/travel/itineraries/${id}/pdf${token ? `?_t=${encodeURIComponent(token)}` : ""}`;
  const perPerson = itin.totalAmount != null && itin.pax ? Number(itin.totalAmount) / Number(itin.pax) : null;
  const dayNumbers = Array.from({ length: dayCount }, (_, i) => i + 1);
  const unscheduled = itemsByDay.get(null) || [];

  return (
    <div data-vertical="travel" style={S.page}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={S.header}>
        <div style={S.headerTop}>
          <Link to="/travel/itineraries" style={S.backLink}>
            <ArrowLeft size={16} /> Itineraries
          </Link>
          <InlineText
            value={itin.title || itin.destination || "Untitled itinerary"}
            onSave={(v) => patchItinerary({ title: v }, { quiet: true })}
            style={S.title}
            ariaLabel="Itinerary title"
          />
          <span style={S.statusPill(itin.status)}>{String(itin.status || "draft").replace(/_/g, " ")}</span>
          <div style={{ flex: 1 }} />
          <a href={pdfHref} target="_blank" rel="noreferrer" style={{ ...S.btn, ...S.btnPrimary, textDecoration: "none" }}>
            <Download size={14} /> Generate PDF
          </a>
          <button type="button" onClick={handleShare} disabled={busyAction === "share"} style={S.btn}>
            <Share2 size={14} /> Share
          </button>
        </div>

        <div style={S.metaRow}>
          <Chip>{itin.subBrand?.toUpperCase()}</Chip>
          <Chip><Calendar size={11} />{itin.startDate ? new Date(itin.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "No dates"}
            {itin.endDate ? ` → ${new Date(itin.endDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}</Chip>
          <Chip>
            <span style={S.chipLabel}>Travellers</span>
            <InlineText
              value={String(itin.pax ?? 1)}
              onSave={(v) => patchItinerary({ pax: Number(v) || 1 }, { quiet: true })}
              style={S.paxInput}
              ariaLabel="Travellers"
              numeric
            />
          </Chip>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(itin.moneyEnabled)}
            onClick={() => patchItinerary({ moneyEnabled: !itin.moneyEnabled }, { quiet: true })}
            style={S.moneyToggle(itin.moneyEnabled)}
            title={itin.moneyEnabled ? "Pricing is on — click to switch this itinerary to planning-only (no cost/tally anywhere)" : "Planning-only — no pricing shown. Click to turn pricing back on for this itinerary."}
          >
            <span style={S.switchTrack(itin.moneyEnabled)}>
              <span style={S.switchKnob(itin.moneyEnabled)} />
            </span>
            {itin.moneyEnabled ? "Pricing on" : "Planning only"}
          </button>
          {itin.moneyEnabled && (
            <>
              <Chip><span style={S.chipLabel}>Per person</span>{money(perPerson, currency)}</Chip>
              <Chip strong><span style={S.chipLabel}>Total</span>{money(itin.totalAmount, currency)}</Chip>
            </>
          )}
          {itin.clonedFromTemplateId && (
            <Chip><span style={S.chipLabel}>Template</span>{templates.find((t) => t.id === itin.clonedFromTemplateId)?.name || `#${itin.clonedFromTemplateId}`}</Chip>
          )}
        </div>

        {shareUrl && (
          <div style={S.shareStrip}>
            <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{shareUrl}</code>
            <button type="button" style={S.btnSm} onClick={() => { navigator.clipboard?.writeText(shareUrl); notify.success("Copied"); }}>Copy</button>
            <button type="button" style={S.btnSm} onClick={() => setShareUrl(null)}><X size={12} /></button>
          </div>
        )}

        <div style={S.tabRow} role="tablist" aria-label="Itinerary sections">
          {TABS.filter((t) => {
            if (t.id === "pricing" && !itin.moneyEnabled) return false;
            if (t.id === "template" && !itin.pdfTemplateId && !itin.clonedFromTemplateId) return false;
            return true;
          }).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={tab === t.id ? S.tabActive : S.tabIdle}
            >
              {t.label}
              {t.id === "plan" && items.length > 0 && <span style={S.tabCount}>{items.length}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Plan tab ───────────────────────────────────────────── */}
      {tab === "plan" && (
        <div style={S.planGrid}>
          <div style={S.planMain}>
            <div style={S.planToolbar}>
              <button
                type="button"
                onClick={() => aiFillDays(dayNumbers)}
                disabled={aiFillBusy || !itin.destination}
                style={{ ...S.btn, ...S.btnAi }}
                title={itin.destination ? "Draft a full day-by-day plan with AI — every item stays fully editable" : "Set a destination first"}
              >
                <Sparkles size={14} /> {aiFillBusy ? "Generating plan…" : "AI Suggest — fill whole trip"}
              </button>
              <button type="button" onClick={addDay} style={S.addDayBtn}>
                <Plus size={14} /> Add day
              </button>
            </div>

            {unscheduled.length > 0 && (
              <DayCard
                key="unscheduled"
                dayNumber={null}
                label="Unscheduled"
                dateLabel="Drag these onto a day"
                items={unscheduled}
                currency={currency}
                moneyEnabled={itin.moneyEnabled}
                suppliers={suppliers}
                customItemTypes={customItemTypes}
                onAddCustomType={addCustomItemType}
                onDeleteCustomType={deleteCustomItemType}
                onCreate={createItem}
                onUpdate={updateItem}
                onDelete={deleteItem}
                onDuplicate={duplicateItem}
                onReorder={reorderItem}
                dragItemId={dragItemId}
                setDragItemId={setDragItemId}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
              />
            )}
            {dayNumbers.map((d) => (
              <DayCard
                key={d}
                dayNumber={d}
                label={`Day ${d}`}
                dateLabel={dayDateLabel(itin.startDate, d)}
                items={itemsByDay.get(d) || []}
                currency={currency}
                moneyEnabled={itin.moneyEnabled}
                suppliers={suppliers}
                destination={itin.destination}
                customItemTypes={customItemTypes}
                onAddCustomType={addCustomItemType}
                onDeleteCustomType={deleteCustomItemType}
                onCreate={createItem}
                onUpdate={updateItem}
                onDelete={deleteItem}
                onDuplicate={duplicateItem}
                onReorder={reorderItem}
                onAiFillDay={() => aiFillDays([d])}
                onDeleteDay={dayCount > 1 ? () => deleteDay(d) : undefined}
                aiFillBusy={aiFillBusy}
                dragItemId={dragItemId}
                setDragItemId={setDragItemId}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
              />
            ))}
          </div>

          <aside style={S.rail}>
            <div style={S.railCard}>
              <div style={S.railHead}>Route map</div>
              {mapItems.length > 0 ? (
                <MapPreview items={mapItems} height={280} showRoute />
              ) : (
                <div style={S.railEmpty}>
                  No pinned locations yet. Set a location on an item to plot it here.
                </div>
              )}
            </div>

            {itin.moneyEnabled && (
              <div style={S.railCard}>
                <div style={S.railHead}>Cost by day</div>
                {dayNumbers.map((d) => {
                  const dayItems = itemsByDay.get(d) || [];
                  const sum = dayItems.reduce((s, it) => s + (Number(it.totalPrice) || 0), 0);
                  if (!dayItems.length) return null;
                  return (
                    <div key={d} style={S.railRow}>
                      <span>Day {d} <span style={S.muted}>· {dayItems.length} item{dayItems.length === 1 ? "" : "s"}</span></span>
                      <strong>{money(sum, currency)}</strong>
                    </div>
                  );
                })}
                <div style={{ ...S.railRow, borderTop: "1px solid var(--border-color)", paddingTop: 8, marginTop: 4 }}>
                  <span><strong>Trip total</strong></span>
                  <strong>{money(itin.totalAmount, currency)}</strong>
                </div>
              </div>
            )}

            <div style={S.railCard}>
              <div style={S.railHead}>Publish</div>
              <div style={S.railLabelRow}>
                <span style={S.railLabelText}>PDF template</span>
                <span
                  title="Picks the branded PDF this itinerary's 'Generate PDF' uses — your real trip content (days, pricing, terms) gets overlaid on this template's design. Doesn't change any of the itinerary's actual content, only how the PDF looks."
                  style={S.infoIcon}
                >
                  <Info size={12} />
                </span>
              </div>
              <select
                value={itin.pdfTemplateId || ""}
                onChange={async (e) => {
                  const templateId = e.target.value || null;
                  const saved = await patchItinerary({ pdfTemplateId: templateId }, { quiet: true });
                  if (saved && templateId) setTab("template");
                }}
                style={S.select}
                aria-label="PDF template"
              >
                <option value="">No template — plain layout</option>
                {/* Only actual branded-PDF templates — a content-only "trip
                    template" (no PDF uploaded) has nothing for Generate PDF
                    to render onto, so listing it here was misleading: it
                    could be "selected" without doing anything. */}
                {templates.filter((t) => t.isPdfTemplate).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {/* Same live-render endpoint the header's "Generate PDF"
                  button uses — always up to date with the itinerary's
                  current content, so "view" and "generate" are the same
                  action. Surfacing it right here means the operator doesn't
                  have to scroll back up after picking a template to see
                  the result. */}
              <a href={pdfHref} target="_blank" rel="noreferrer" style={S.railLink}>
                <ExternalLink size={11} /> View PDF
              </a>
              <button type="button" onClick={handleAddToCatalogue} disabled={busyAction === "catalogue"} style={S.railBtn}>
                <Cloud size={14} /> {busyAction === "catalogue" ? "Adding…" : "Add to TMC catalogue"}
              </button>
              {itin.catalogueDriveViewLink && (
                <a href={itin.catalogueDriveViewLink} target="_blank" rel="noreferrer" style={S.railLink}>
                  <ExternalLink size={11} /> View in Drive
                </a>
              )}
              <button type="button" onClick={handleSaveAsTemplate} disabled={busyAction === "template"} style={S.railBtn}>
                <BookmarkPlus size={14} /> Save as template
              </button>
            </div>
          </aside>
        </div>
      )}

      {tab === "pricing" && (
        <PricingTab itin={itin} itemsByDay={itemsByDay} dayNumbers={dayNumbers} currency={currency} customItemTypes={customItemTypes} />
      )}

      {tab === "details" && (
        <DetailsTab itin={itin} onSave={patchItinerary} cancellationPolicies={cancellationPolicies} navigate={navigate} />
      )}

      {tab === "template" && (
        <TemplateDetailsTab itin={itin} onSave={patchItinerary} notify={notify} />
      )}

      {tab === "context" && (
        <ContextTab itin={itin} onReload={load} notify={notify} id={id} />
      )}
    </div>
  );
}

// ── Day card ──────────────────────────────────────────────────────────

function DayCard({
  dayNumber, label, dateLabel, items, currency, moneyEnabled, suppliers, destination,
  customItemTypes, onAddCustomType, onDeleteCustomType,
  onCreate, onUpdate, onDelete, onDuplicate, onReorder, onAiFillDay, onDeleteDay, aiFillBusy,
  dragItemId, setDragItemId, dropTarget, setDropTarget,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const dayTotal = items.reduce((s, it) => s + (Number(it.totalPrice) || 0), 0);
  const isDropDay = dropTarget?.day === dayNumber;

  // Cursor position within a row decides whether the drop lands before or
  // after it — the indicator (a thin highlight bar) tracks live as the drag
  // passes over each row, then the drop zone at the bottom of the list
  // catches "insert at the end" when the cursor is below every row.
  const rowDragOver = (e, index) => {
    e.preventDefault();
    if (dragItemId == null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    setDropTarget({ day: dayNumber, index: before ? index : index + 1 });
  };

  const commitDrop = () => {
    if (dragItemId != null && dropTarget?.day === dayNumber) {
      onReorder(dragItemId, dayNumber, dropTarget.index);
    }
    setDragItemId(null);
    setDropTarget(null);
  };

  return (
    <section style={S.dayCard}>
      <header style={S.dayHead}>
        <button type="button" onClick={() => setCollapsed((c) => !c)} style={S.collapseBtn} aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}>
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
        <strong style={S.dayTitle}>{label}</strong>
        {dateLabel && <span style={S.dayDate}>{dateLabel}</span>}
        <div style={{ flex: 1 }} />
        {onAiFillDay && items.length === 0 && (
          <button
            type="button"
            onClick={onAiFillDay}
            disabled={aiFillBusy}
            style={S.dayAiBtn}
            title="Draft this one day with AI"
          >
            <Sparkles size={12} /> AI fill
          </button>
        )}
        <span style={S.muted}>{items.length} item{items.length === 1 ? "" : "s"}</span>
        {moneyEnabled && dayTotal > 0 && <span style={S.dayTotal}>{money(dayTotal, currency)}</span>}
        {onDeleteDay && (
          <button
            type="button"
            onClick={onDeleteDay}
            style={S.dayDeleteBtn}
            title={`Delete ${label} — later days shift up by one`}
            aria-label={`Delete ${label}`}
          >
            <Trash2 size={13} />
          </button>
        )}
      </header>

      {!collapsed && (
        <>
          {items.map((item, index) => (
            <div key={item.id}>
              {isDropDay && dropTarget?.index === index && dragItemId !== item.id && (
                <div style={S.dropIndicator} />
              )}
              <ItemRow
                item={item}
                currency={currency}
                moneyEnabled={moneyEnabled}
                suppliers={suppliers}
                destination={destination}
                customItemTypes={customItemTypes}
                onAddCustomType={onAddCustomType}
                onDeleteCustomType={onDeleteCustomType}
                expanded={expandedId === item.id}
                dimmed={dragItemId === item.id}
                onToggle={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                onDragStart={() => setDragItemId(item.id)}
                onDragEnd={() => { setDragItemId(null); setDropTarget(null); }}
                onDragOver={(e) => rowDragOver(e, index)}
                onDrop={(e) => { e.preventDefault(); commitDrop(); }}
              />
            </div>
          ))}
          {items.length === 0 && (
            <div style={S.dayEmpty}>Nothing planned yet — add the first item below, or drag one in.</div>
          )}
          {/* End-of-list drop zone — catches drags released below the last row. */}
          <div
            style={{ ...S.dayEndDropZone, ...(isDropDay && dropTarget?.index === items.length ? S.dayEndDropZoneActive : null) }}
            onDragOver={(e) => { e.preventDefault(); if (dragItemId != null) setDropTarget({ day: dayNumber, index: items.length }); }}
            onDrop={(e) => { e.preventDefault(); commitDrop(); }}
          />
          <QuickAdd dayNumber={dayNumber} onCreate={onCreate} customItemTypes={customItemTypes} onAddCustomType={onAddCustomType} onDeleteCustomType={onDeleteCustomType} moneyEnabled={moneyEnabled} />
        </>
      )}
    </section>
  );
}

// ── Item row (collapsed summary + expand-in-place editor) ─────────────

function ItemRow({
  item, currency, moneyEnabled, suppliers, destination, expanded, dimmed,
  customItemTypes, onAddCustomType, onDeleteCustomType,
  onToggle, onUpdate, onDelete, onDuplicate,
  onDragStart, onDragEnd, onDragOver, onDrop,
}) {
  const sched = readSchedule(item);
  const customMeta = customItemTypes.find((t) => t.key === item.itemType);
  const meta = TYPE_META[item.itemType] || (customMeta ? { label: customMeta.label, Icon: Tag } : TYPE_META.other);
  const Icon = meta.Icon;
  const typeDetails = readTypeDetails(item);
  const routeLabel = typeDetails.fromLocation && typeDetails.toLocation
    ? `${typeDetails.fromLocation} → ${typeDetails.toLocation}`
    : null;

  if (!expanded) {
    return (
      <div
        style={{ ...S.itemRow, ...(dimmed ? S.itemRowDimmed : null) }}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
      >
        <GripVertical size={14} style={S.grip} aria-hidden />
        <span style={S.itemTime}>{sched.startTime || "—"}</span>
        <span style={S.itemIcon} title={meta.label}><Icon size={14} /></span>
        <span style={S.itemDesc}>
          {item.description}
          {routeLabel && <span style={S.itemLoc}> · {routeLabel}</span>}
          {!routeLabel && sched.locationName && <span style={S.itemLoc}> · {sched.locationName}</span>}
          {item.draftedByAi && <span style={S.aiBadge}>AI</span>}
        </span>
        {moneyEnabled && <span style={S.itemCost}>{item.totalPrice != null ? money(item.totalPrice, currency) : ""}</span>}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(item); }}
          style={S.itemDeleteBtn}
          title={`Remove "${item.description}"`}
          aria-label={`Remove ${item.description}`}
        >
          <Trash2 size={13} />
        </button>
      </div>
    );
  }

  return (
    <ItemEditor
      item={item}
      sched={sched}
      currency={currency}
      moneyEnabled={moneyEnabled}
      suppliers={suppliers}
      destination={destination}
      customItemTypes={customItemTypes}
      onAddCustomType={onAddCustomType}
      onDeleteCustomType={onDeleteCustomType}
      onCancel={onToggle}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
    />
  );
}

function ItemEditor({ item, sched, currency, moneyEnabled, suppliers, destination, customItemTypes, onAddCustomType, onDeleteCustomType, onCancel, onUpdate, onDelete, onDuplicate }) {
  const [form, setForm] = useState({
    description: item.description || "",
    itemType: item.itemType || "activity",
    startTime: sched.startTime || "",
    endTime: sched.endTime || "",
    locationName: sched.locationName || "",
    latitude: item.latitude ?? "",
    longitude: item.longitude ?? "",
    supplierId: item.supplierId ?? "",
    unit: item.unit || "per_person",
    quantity: item.quantity != null ? String(item.quantity) : "1",
    unitCost: item.unitCost != null ? String(item.unitCost) : "",
    markup: item.markup != null ? String(item.markup) : "",
    gstAmount: item.gstAmount != null ? String(item.gstAmount) : "",
  });
  const [extra, setExtra] = useState(() => readTypeDetails(item));
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setExtraField = (k, v) => setExtra((f) => ({ ...f, [k]: v }));

  const detailSchema = TYPE_DETAIL_SCHEMAS[form.itemType] || null;
  const showFromTo = FROM_TO_TYPES.has(form.itemType);

  const handleDeleteCustomType = async (typeId, typeKey) => {
    await onDeleteCustomType(typeId);
    if (form.itemType === typeKey) set("itemType", "other");
  };

  const lineTotal = useMemo(() => {
    const rate = Number(form.unitCost) || 0;
    const qty = Number(form.quantity) || 1;
    return rate * qty + (Number(form.markup) || 0) + (Number(form.gstAmount) || 0);
  }, [form.unitCost, form.quantity, form.markup, form.gstAmount]);

  const submit = async () => {
    if (!form.description.trim()) return;
    setSaving(true);
    const ok = await onUpdate(item.id, {
      description: form.description.trim(),
      itemType: form.itemType,
      startTime: form.startTime || null,
      endTime: form.endTime || null,
      locationName: form.locationName || null,
      latitude: form.latitude === "" ? null : Number(form.latitude),
      longitude: form.longitude === "" ? null : Number(form.longitude),
      supplierId: form.supplierId === "" ? null : Number(form.supplierId),
      unit: form.unit,
      quantity: form.quantity === "" ? 1 : Number(form.quantity),
      unitCost: form.unitCost === "" ? null : Number(form.unitCost),
      markup: form.markup === "" ? null : Number(form.markup),
      gstAmount: form.gstAmount === "" ? null : Number(form.gstAmount),
      detailsJson: buildDetailsJson(item, form.itemType, extra),
    });
    setSaving(false);
    if (ok) onCancel();
  };

  return (
    <div style={S.itemEditor}>
      <div style={S.editRow}>
        <Fld label="Time" width={90}>
          <input type="time" value={form.startTime} onChange={(e) => set("startTime", e.target.value)} style={S.input} aria-label="Start time" />
        </Fld>
        <Fld label="Ends" width={90}>
          <input type="time" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} style={S.input} aria-label="End time" />
        </Fld>
        <Fld label="Type" width={150}>
          <ItemTypeCombobox
            value={form.itemType}
            onChange={(v) => set("itemType", v)}
            customTypes={customItemTypes}
            onAddCustom={onAddCustomType}
            onDeleteCustom={handleDeleteCustomType}
            ariaLabel="Item type"
            width={150}
          />
        </Fld>
        <Fld label="What happens" grow>
          <input
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            style={S.input}
            aria-label="Description"
            placeholder="e.g. Facilities tour at the academy"
          />
        </Fld>
      </div>

      {showFromTo ? (
        <div style={S.editRow}>
          {detailSchema.filter((f) => f.type === "location").map((f) => (
            <Fld key={f.key} label={f.label} grow>
              <LocationAutocomplete
                value={extra[f.key] || ""}
                onChange={(v) => setExtraField(f.key, v)}
                onSelect={(s) => setExtraField(f.key, s?.display_name || extra[f.key] || "")}
                style={S.input}
                inputProps={{ placeholder: `Search a place…`, "aria-label": f.label }}
              />
            </Fld>
          ))}
          {detailSchema.filter((f) => f.type === "text").map((f) => (
            <Fld key={f.key} label={f.label} width={f.width || 120}>
              <input value={extra[f.key] || ""} onChange={(e) => setExtraField(f.key, e.target.value)} style={S.input} aria-label={f.label} />
            </Fld>
          ))}
          <Fld label="Supplier" width={160}>
            <select value={form.supplierId} onChange={(e) => set("supplierId", e.target.value)} style={S.input} aria-label="Supplier">
              <option value="">—</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Fld>
        </div>
      ) : (
        <div style={S.editRow}>
          <Fld label="Location" grow>
            <LocationAutocomplete
              value={form.locationName}
              onChange={(v) => set("locationName", v)}
              onSelect={(s) => {
                set("locationName", s?.display_name || form.locationName);
                if (s?.lat != null) set("latitude", s.lat);
                if (s?.lng != null) set("longitude", s.lng);
              }}
              style={S.input}
              inputProps={{ placeholder: destination ? `Search a place in ${destination}` : "Search a place", "aria-label": "Location" }}
            />
          </Fld>
          <Fld label="Supplier" width={180}>
            <select value={form.supplierId} onChange={(e) => set("supplierId", e.target.value)} style={S.input} aria-label="Supplier">
              <option value="">—</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Fld>
        </div>
      )}

      {!showFromTo && detailSchema && (
        <div style={S.editRow}>
          {detailSchema.map((f) => (
            <Fld key={f.key} label={f.label} width={f.width || 130}>
              {f.type === "date" ? (
                <input type="date" value={extra[f.key] || ""} onChange={(e) => setExtraField(f.key, e.target.value)} style={S.input} aria-label={f.label} />
              ) : (
                <input value={extra[f.key] || ""} onChange={(e) => setExtraField(f.key, e.target.value)} style={S.input} aria-label={f.label} />
              )}
            </Fld>
          ))}
        </div>
      )}

      {moneyEnabled && (
        <div style={S.editRow}>
          <Fld label="Basis" width={140}>
            <select value={form.unit} onChange={(e) => set("unit", e.target.value)} style={S.input} aria-label="Pricing basis">
              {ITEM_UNITS.map((u) => <option key={u} value={u}>{u.replace(/_/g, " ")}</option>)}
            </select>
          </Fld>
          <Fld label="Qty" width={70}>
            <input type="number" min="0" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} style={S.input} aria-label="Quantity" />
          </Fld>
          <Fld label="Rate" width={100}>
            <input type="number" min="0" value={form.unitCost} onChange={(e) => set("unitCost", e.target.value)} style={S.input} aria-label="Rate" />
          </Fld>
          <Fld label="Markup" width={100}>
            <input type="number" value={form.markup} onChange={(e) => set("markup", e.target.value)} style={S.input} aria-label="Markup" />
          </Fld>
          <Fld label="GST" width={100}>
            <input type="number" value={form.gstAmount} onChange={(e) => set("gstAmount", e.target.value)} style={S.input} aria-label="GST" />
          </Fld>
          <Fld label="Line total" width={120}>
            <div style={S.readonlyTotal}>{money(lineTotal, currency)}</div>
          </Fld>
        </div>
      )}

      <div style={S.editActions}>
        <button type="button" onClick={submit} disabled={saving || !form.description.trim()} style={{ ...S.btn, ...S.btnPrimary }}>
          <Check size={14} /> {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} style={S.btn}>Cancel</button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => onDuplicate(item)} style={S.btn}><Copy size={13} /> Duplicate</button>
        <button type="button" onClick={() => onDelete(item)} style={{ ...S.btn, color: "#c0392b" }}><Trash2 size={13} /> Remove</button>
      </div>
    </div>
  );
}

// ── Quick add ─────────────────────────────────────────────────────────
//
// The fast path: time + what happens + optional cost, Enter to commit. Keeps
// focus in the description field afterwards so a whole day can be typed in
// without touching the mouse.

function QuickAdd({ dayNumber, onCreate, customItemTypes, onAddCustomType, onDeleteCustomType, moneyEnabled }) {
  const [startTime, setStartTime] = useState("");
  const [description, setDescription] = useState("");
  const [itemType, setItemType] = useState("activity");
  const [unitCost, setUnitCost] = useState("");
  const [busy, setBusy] = useState(false);
  const descRef = useRef(null);

  const submit = async () => {
    const desc = description.trim();
    if (!desc || busy) return;
    setBusy(true);
    const ok = await onCreate({
      itemType,
      description: desc,
      dayNumber,
      startTime: startTime || null,
      unitCost: unitCost === "" ? null : Number(unitCost),
      quantity: 1,
    });
    setBusy(false);
    if (ok) {
      setDescription("");
      setUnitCost("");
      setStartTime("");
      descRef.current?.focus();
    }
  };

  return (
    <div style={S.quickAdd}>
      <Clock size={13} style={{ color: "var(--text-secondary)", flexShrink: 0 }} aria-hidden />
      <input
        type="time"
        value={startTime}
        onChange={(e) => setStartTime(e.target.value)}
        style={{ ...S.input, width: 96 }}
        aria-label={`Start time for new item on ${dayNumber ? `day ${dayNumber}` : "unscheduled"}`}
      />
      <ItemTypeCombobox
        value={itemType}
        onChange={setItemType}
        customTypes={customItemTypes}
        onAddCustom={onAddCustomType}
        onDeleteCustom={async (typeId, typeKey) => {
          await onDeleteCustomType(typeId);
          if (itemType === typeKey) setItemType("other");
        }}
        ariaLabel="New item type"
        width={140}
      />
      <input
        ref={descRef}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        placeholder="Add an activity, transfer, meal… then press Enter"
        style={{ ...S.input, flex: 1 }}
        aria-label={`Description for new item on ${dayNumber ? `day ${dayNumber}` : "unscheduled"}`}
      />
      {moneyEnabled && (
        <input
          type="number"
          min="0"
          value={unitCost}
          onChange={(e) => setUnitCost(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="Cost"
          style={{ ...S.input, width: 96 }}
          aria-label="Cost for new item"
        />
      )}
      <button type="button" onClick={submit} disabled={!description.trim() || busy} style={{ ...S.btnSm, ...S.btnPrimary }}>
        {busy ? <Loader2 size={13} /> : <Plus size={13} />} Add
      </button>
    </div>
  );
}

// ── Pricing tab ───────────────────────────────────────────────────────

function PricingTab({ itin, itemsByDay, dayNumbers, currency, customItemTypes }) {
  const typeLabel = (itemType) => {
    if (TYPE_META[itemType]) return TYPE_META[itemType].label;
    const custom = customItemTypes.find((t) => t.key === itemType);
    return custom ? custom.label : TYPE_META.other.label;
  };
  const groups = [
    ...(itemsByDay.get(null)?.length ? [{ key: "unscheduled", label: "Unscheduled", items: itemsByDay.get(null) }] : []),
    ...dayNumbers
      .filter((d) => (itemsByDay.get(d) || []).length > 0)
      .map((d) => ({ key: d, label: `Day ${d}`, items: itemsByDay.get(d) })),
  ];

  return (
    <div style={S.tabBody}>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Time</th>
            <th style={S.th}>Type</th>
            <th style={S.th}>Description</th>
            <th style={S.th}>Basis</th>
            <th style={{ ...S.th, textAlign: "right" }}>Qty</th>
            <th style={{ ...S.th, textAlign: "right" }}>Rate</th>
            <th style={{ ...S.th, textAlign: "right" }}>Markup</th>
            <th style={{ ...S.th, textAlign: "right" }}>GST</th>
            <th style={{ ...S.th, textAlign: "right" }}>Line total</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr><td colSpan={9} style={S.tdEmpty}>No items priced yet.</td></tr>
          )}
          {groups.map((g) => {
            const groupTotal = g.items.reduce((s, it) => s + (Number(it.totalPrice) || 0), 0);
            return (
              <Fragment key={g.key}>
                <tr>
                  <td colSpan={8} style={S.groupTd}>{g.label}</td>
                  <td style={{ ...S.groupTd, textAlign: "right" }}>{money(groupTotal, currency)}</td>
                </tr>
                {g.items.map((it) => {
                  const sched = readSchedule(it);
                  return (
                    <tr key={it.id}>
                      <td style={S.td}>{sched.startTime || "—"}</td>
                      <td style={S.td}>{typeLabel(it.itemType)}</td>
                      <td style={S.td}>{it.description}{sched.locationName ? <span style={S.muted}> · {sched.locationName}</span> : null}</td>
                      <td style={S.td}>{(it.unit || "per_person").replace(/_/g, " ")}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{it.quantity ?? 1}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{money(it.unitCost, currency)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{money(it.markup, currency)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{money(it.gstAmount, currency)}</td>
                      <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>{money(it.totalPrice, currency)}</td>
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={8} style={S.totalTd}>Trip total ({itin.pax || 1} traveller{(itin.pax || 1) === 1 ? "" : "s"})</td>
            <td style={{ ...S.totalTd, textAlign: "right" }}>{money(itin.totalAmount, currency)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Details tab ───────────────────────────────────────────────────────

// Cancellation-policy tiers render as readable prose for a starting point in
// the Terms textarea — the operator can edit freely afterwards, this just
// saves retyping the same policy by hand for every trip that uses it.
function formatPolicyAsTerms(policy) {
  const lines = [];
  if (policy.description) lines.push(policy.description);
  try {
    const tiers = JSON.parse(policy.tiersJson || "[]");
    if (Array.isArray(tiers) && tiers.length) {
      lines.push(...tiers.map((t) => `${t.daysBeforeServiceStart}+ days before departure: ${t.refundPercent}% refundable`));
    }
  } catch { /* description alone is fine */ }
  return lines.join("\n");
}

function DetailsTab({ itin, onSave, cancellationPolicies, navigate }) {
  const [form, setForm] = useState({
    title: itin.title || "",
    introText: itin.introText || "",
    inclusions: parseBullets(itin.inclusionsJson).join("\n"),
    exclusions: parseBullets(itin.exclusionsJson).join("\n"),
    otherDetails: parseBullets(itin.otherDetailsJson).join("\n"),
    termsText: itin.termsText || "",
    cancellationPolicyId: itin.cancellationPolicyId ?? "",
    staticPageText: itin.staticPageText || "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // What the bound template's own closing/contact page currently says —
  // read-only, fetched once per template so the operator can see exactly
  // what they'd be replacing instead of typing a replacement blind.
  const [templateText, setTemplateText] = useState(null); // null = loading/none, "" = no static page, string = content
  useEffect(() => {
    let cancelled = false;
    setTemplateText(null);
    // The static page comes from whichever template actually has a PDF —
    // pdfTemplateId when set, else clonedFromTemplateId as a fallback
    // (mirrors the backend's own precedence). Skip the fetch only when
    // NEITHER is set — there's nothing for the server to look up.
    if (!itin.pdfTemplateId && !itin.clonedFromTemplateId) return undefined;
    fetchApi(`/api/travel/itineraries/${itin.id}/static-page-preview`, { silent: true })
      .then((res) => { if (!cancelled) setTemplateText(res && res.hasTemplate ? (res.text || "") : ""); })
      .catch(() => { if (!cancelled) setTemplateText(""); });
    return () => { cancelled = true; };
  }, [itin.id, itin.pdfTemplateId, itin.clonedFromTemplateId]);

  const save = async () => {
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  const CANCEL_ADD_NEW = "__add_new__";
  const handlePolicyChange = (raw) => {
    if (raw === CANCEL_ADD_NEW) {
      navigate("/travel/cancellation-policies");
      return;
    }
    set("cancellationPolicyId", raw);
    if (!raw) return;
    const policy = cancellationPolicies.find((p) => String(p.id) === String(raw));
    // Seed the Terms box from the chosen policy, but only when it's still
    // empty — never clobber terms the operator already wrote by hand.
    if (policy && !form.termsText.trim()) {
      set("termsText", formatPolicyAsTerms(policy));
    }
  };

  return (
    <div style={S.tabBody}>
      <p style={S.tabIntro}>
        These blocks are what the branded PDF renders — the cover blurb, the
        Inclusions / Exclusions lists and the terms page. One bullet per line.
      </p>

      <Fld label="Title" grow>
        <input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder={itin.destination} style={S.input} aria-label="Title" />
      </Fld>

      <Fld label="Cover blurb" grow>
        <textarea
          value={form.introText}
          onChange={(e) => set("introText", e.target.value)}
          rows={5}
          placeholder="The one or two paragraphs that open the brochure — what this trip is and what students take away from it. Leave blank and a short factual line is used instead."
          style={{ ...S.input, resize: "vertical" }}
          aria-label="Cover blurb"
        />
      </Fld>

      <div style={S.detailsGrid}>
        <Fld label="Inclusions (one per line)" grow>
          <textarea value={form.inclusions} onChange={(e) => set("inclusions", e.target.value)} rows={8} style={{ ...S.input, resize: "vertical" }} placeholder={"1 Lunch\nAll activities mentioned in the itinerary\nTour directors"} aria-label="Inclusions" />
        </Fld>
        <Fld label="Exclusions (one per line)" grow>
          <textarea value={form.exclusions} onChange={(e) => set("exclusions", e.target.value)} rows={8} style={{ ...S.input, resize: "vertical" }} placeholder={"Transfer to & from school\nPersonal & shopping expenses"} aria-label="Exclusions" />
        </Fld>
      </div>

      <Fld label="Other details (one per line)" grow>
        <textarea value={form.otherDetails} onChange={(e) => set("otherDetails", e.target.value)} rows={5} style={{ ...S.input, resize: "vertical" }} placeholder={"1 teacher accompanies every 20 students\nPackage applicable for a minimum of 45 students"} aria-label="Other details" />
      </Fld>

      <div style={S.sectionDivider} />

      <Fld label="Cancellation policy" grow>
        <select value={form.cancellationPolicyId} onChange={(e) => handlePolicyChange(e.target.value)} style={S.input} aria-label="Cancellation policy">
          <option value={CANCEL_ADD_NEW}>+ Add cancellation policy…</option>
          <option value="">— None selected —</option>
          {cancellationPolicies.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.subBrand ? "" : " (tenant default)"}</option>
          ))}
        </select>
        <span style={S.fieldHint}>Picking a policy fills in the Terms box below (only if it&apos;s still empty) — still fully editable after.</span>
      </Fld>

      <Fld label="Terms / cancellation policy" grow>
        <textarea value={form.termsText} onChange={(e) => set("termsText", e.target.value)} rows={6} style={{ ...S.input, resize: "vertical" }} placeholder="Refund policy, cancellation windows, disclaimers…" aria-label="Terms" />
      </Fld>

      <Fld label="Closing / contact page (optional)" grow>
        <span style={S.fieldHint}>
          {(itin.pdfTemplateId || itin.clonedFromTemplateId)
            ? "Compare what the template's closing page says today against what you want it to say for THIS trip only — the template itself is unaffected."
            : "This itinerary isn't attached to a PDF template yet, so there's no closing page to preview or replace."}
        </span>
        {(itin.pdfTemplateId || itin.clonedFromTemplateId) && (
          <div style={S.staticCompareGrid}>
            <div>
              <div style={S.staticBoxLabel}>What the template says today</div>
              <div style={S.staticReadonlyBox}>
                {templateText === null
                  ? "Loading…"
                  : templateText === ""
                    ? "No closing page detected on this template, or it has no readable text."
                    : templateText}
              </div>
            </div>
            <div>
              <div style={S.staticBoxLabel}>What you want it to say instead</div>
              <textarea
                value={form.staticPageText}
                onChange={(e) => set("staticPageText", e.target.value)}
                rows={9}
                style={{ ...S.input, resize: "vertical", height: "100%", minHeight: 140 }}
                placeholder={"Leave blank to keep the template's closing page exactly as uploaded.\nOr write replacement text for this trip — e.g. a school-specific note or different contact details.\nA short line reads as a heading; longer lines as body text."}
                aria-label="Closing page replacement text"
              />
            </div>
          </div>
        )}
      </Fld>

      <div style={{ marginTop: 14 }}>
        <button type="button" onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrimary }}>
          <Check size={14} /> {saving ? "Saving…" : "Save details"}
        </button>
      </div>
    </div>
  );
}

function readTemplateData(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function automaticTemplateValue(field, itin) {
  const values = {
    title: itin.title || itin.destination || "",
    destination: itin.destination || "",
    startDate: itin.startDate ? String(itin.startDate).slice(0, 10) : "",
    endDate: itin.endDate ? String(itin.endDate).slice(0, 10) : "",
    pax: itin.pax || 1,
    introText: itin.introText || "",
    inclusions: parseBullets(itin.inclusionsJson).join("\n"),
    exclusions: parseBullets(itin.exclusionsJson).join("\n"),
    termsText: itin.termsText || "",
  };
  if (field.key === "duration" && itin.startDate && itin.endDate) {
    const days = Math.max(1, Math.floor((new Date(itin.endDate) - new Date(itin.startDate)) / 86400000) + 1);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return values[field.key] ?? "Filled from the itinerary";
}

function TemplateDetailsTab({ itin, onSave, notify }) {
  const [schema, setSchema] = useState(null);
  const [values, setValues] = useState(() => readTemplateData(itin.templateDataJson));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    fetchApi(`/api/travel/itineraries/${itin.id}/template-schema`, { silent: true })
      .then((result) => {
        if (cancelled) return;
        setSchema(result || { fields: [] });
        setValues(result?.values || readTemplateData(itin.templateDataJson));
      })
      .catch(() => { if (!cancelled) setSchema({ fields: [], error: true }); });
    return () => { cancelled = true; };
  }, [itin.id, itin.pdfTemplateId, itin.clonedFromTemplateId, itin.templateDataJson]);

  // Cover photo. Offered for every PDF template, not just ones with detected
  // fields: without it the hero is the destination's Wikipedia lead image, so
  // every Goa trip ships with the identical photograph.
  const [coverUrl, setCoverUrl] = useState(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const coverInputRef = useRef(null);

  useEffect(() => { setCoverUrl(schema?.coverImageUrl || null); }, [schema]);

  const uploadCover = async (file) => {
    if (!file) return;
    setCoverBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await fetchApi(`/api/travel/itineraries/${itin.id}/cover-image`, { method: "POST", body: fd });
      setCoverUrl(data.coverImageUrl);
      // Keep the local copy in step. "Save template details" posts `values`
      // wholesale, so without this the next save would write back a snapshot
      // taken before the upload and silently drop the cover again.
      setValues((old) => ({ ...old, coverImageUrl: data.coverImageUrl }));
      notify.success("Cover photo updated");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Could not upload the cover photo");
    } finally {
      setCoverBusy(false);
      if (coverInputRef.current) coverInputRef.current.value = "";
    }
  };

  const removeCover = async () => {
    setCoverBusy(true);
    try {
      await fetchApi(`/api/travel/itineraries/${itin.id}/cover-image`, { method: "DELETE" });
      setCoverUrl(null);
      setValues((old) => {
        const next = { ...old };
        delete next.coverImageUrl;
        return next;
      });
      notify.success("Cover photo removed - the destination photo will be used");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Could not remove the cover photo");
    } finally {
      setCoverBusy(false);
    }
  };

  const fields = Array.isArray(schema?.fields) ? schema.fields : [];
  const customFields = fields.filter((field) => field.source !== "auto");
  const automaticFields = fields.filter((field) => field.source === "auto");
  const save = async () => {
    setSaving(true);
    await onSave({ templateData: values });
    setSaving(false);
  };

  return (
    <div style={S.tabBody}>
      <p style={S.tabIntro}>
        Your template has a few labelled slots that the itinerary itself cannot fill - things printed on the
        brochure that live nowhere in the trip data. Everything else (title, dates, route, day plan, pricing)
        is filled in automatically. Fill these in and they will be printed in the spot described under each one.
      </p>
      {!schema && <div style={S.contextCard}>Analyzing the selected template...</div>}
      {schema?.hasTemplate && (
        <div style={{ ...S.contextCard, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Cover photo</div>
          <div style={{ ...S.muted, marginBottom: 10 }}>
            {coverUrl
              ? "Used as the hero image on the first page."
              : "No cover set, so the first page uses a stock photo of the destination - the same one for every trip there. Upload your own to replace it."}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {coverUrl && (
              <img
                src={coverUrl}
                alt="Cover"
                style={{ width: 132, height: 84, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border-color)" }}
              />
            )}
            <input
              ref={coverInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(e) => uploadCover(e.target.files?.[0])}
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              disabled={coverBusy}
              style={{ ...S.btn, ...(coverBusy ? {} : S.btnPrimary) }}
            >
              {coverBusy ? "Working..." : coverUrl ? "Replace photo" : "Upload photo"}
            </button>
            {coverUrl && (
              <button type="button" onClick={removeCover} disabled={coverBusy} style={S.btn}>
                Remove
              </button>
            )}
          </div>
        </div>
      )}
      {schema?.error && <div style={S.contextCard}>The template field analysis could not be loaded. You can still generate using the standard itinerary details.</div>}
      {automaticFields.length > 0 && (
        <div style={S.detailsGrid}>
          {automaticFields.map((field) => (
            <Fld key={field.key} label={`${field.label} - automatic`} grow>
              <div style={S.staticReadonlyBox}>{automaticTemplateValue(field, itin)}</div>
            </Fld>
          ))}
        </div>
      )}
      {customFields.length > 0 ? (
        <div style={S.detailsGrid}>
          {customFields.map((field) => (
            <Fld key={field.key} label={`${field.label}${field.required ? " *" : " (optional)"}`} grow>
              {field.type === "textarea" ? (
                <textarea rows={5} value={values[field.key] || ""} onChange={(e) => setValues((old) => ({ ...old, [field.key]: e.target.value }))} style={{ ...S.input, resize: "vertical" }} />
              ) : (
                <input type={field.type === "number" || field.type === "date" ? field.type : "text"} value={values[field.key] || ""} onChange={(e) => setValues((old) => ({ ...old, [field.key]: e.target.value }))} style={S.input} />
              )}
              {/* Where it prints. Without this the operator sees a bare label
                  like "Trip style" with no way to know what it means or where
                  it will end up. */}
              <div style={S.fieldHint}>
                {field.hint || `Printed on page ${field.pageIndex || 1} of the template.`}
                {field.hint && field.pageIndex ? ` (page ${field.pageIndex})` : ""}
              </div>
            </Fld>
          ))}
        </div>
      ) : schema && !schema.error ? (
        <div style={S.contextCard}>
          This template has no extra slots to fill - every part of it can be built from the itinerary itself.
        </div>
      ) : null}
      {schema && !schema.error && customFields.length > 0 && (
        <button type="button" onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrimary, marginTop: 14 }}>
          <Check size={14} /> {saving ? "Saving..." : "Save template details"}
        </button>
      )}
    </div>
  );
}

// ── Context tab ───────────────────────────────────────────────────────

function ContextTab({ itin, onReload, notify, id }) {
  const [regenerating, setRegenerating] = useState(false);
  const ctx = itin.relatedContext || {};
  const diag = ctx.latestDiagnostic || null;

  const regen = async () => {
    setRegenerating(true);
    try {
      await fetchApi(`/api/travel/itineraries/${id}/draft/regen`, { method: "POST", body: JSON.stringify({}) });
      await onReload();
      notify.success("Draft summary regenerated");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to regenerate draft");
    } finally { setRegenerating(false); }
  };

  return (
    <div style={S.tabBody}>
      <div style={S.contextGrid}>
        <div style={S.contextCard}>
          <div style={S.contextEyebrow}>Diagnostic</div>
          {diag ? (
            <>
              <div style={S.contextTitle}>Score {diag.score ?? "—"}</div>
              <div style={S.muted}>{diag.classification || "—"} · tier {diag.tier || "—"}</div>
            </>
          ) : <div style={S.muted}>No diagnostic linked to this contact yet.</div>}
        </div>
        <div style={S.contextCard}>
          <div style={S.contextEyebrow}>Commercial</div>
          {itin.moneyEnabled ? (
            <div style={S.contextTitle}>{money(itin.totalAmount, itin.currency)}</div>
          ) : (
            <div style={S.contextTitle}>Planning only</div>
          )}
          <div style={S.muted}>Status: {String(itin.status || "draft").replace(/_/g, " ")}</div>
        </div>
        <div style={S.contextCard}>
          <div style={S.contextEyebrow}>Drive</div>
          {itin.catalogueDriveViewLink ? (
            <a href={itin.catalogueDriveViewLink} target="_blank" rel="noreferrer" style={S.railLink}>
              <ExternalLink size={11} /> Open in Drive
            </a>
          ) : <div style={S.muted}>Not published to the Drive catalogue yet.</div>}
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <div style={S.sectionHead}>
          <strong>AI draft summary</strong>
          <button type="button" onClick={regen} disabled={regenerating} style={S.btnSm}>
            <Sparkles size={13} /> {regenerating ? "Generating…" : "Regenerate"}
          </button>
        </div>
        <div style={S.draftBox}>
          {itin.draftSummary || "No draft generated yet."}
        </div>
      </div>
    </div>
  );
}

// ── small shared bits ─────────────────────────────────────────────────

function Chip({ children, strong }) {
  return <span style={{ ...S.chip, ...(strong ? S.chipStrong : null) }}>{children}</span>;
}

function Fld({ label, children, width, grow }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, ...(grow ? { flex: 1, minWidth: 160 } : { width }) }}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

// Click-to-edit text that commits on blur or Enter and reverts on Escape.
function InlineText({ value, onSave, style, ariaLabel, numeric }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} style={{ ...S.inlineDisplay, ...style }} title="Click to edit" aria-label={ariaLabel}>
        {value}
      </button>
    );
  }
  return (
    <input
      autoFocus
      type={numeric ? "number" : "text"}
      value={draft}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft !== value) onSave(draft); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === "Escape") { setDraft(value); setEditing(false); }
      }}
      style={{ ...S.input, ...style }}
    />
  );
}

// ── styles ────────────────────────────────────────────────────────────

const BORDER = "1px solid var(--border-color)";

const S = {
  page: { padding: "1.1rem 1.25rem 2rem", display: "flex", flexDirection: "column", gap: "0.9rem" },
  pad: { padding: "2rem", color: "var(--text-secondary)" },

  header: { display: "flex", flexDirection: "column", gap: "0.55rem" },
  headerTop: { display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" },
  backLink: { display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.82rem" },
  title: { fontSize: "1.2rem", fontWeight: 700, color: "var(--text-primary)" },

  metaRow: { display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" },
  chip: { display: "inline-flex", alignItems: "center", gap: 5, padding: "0.2rem 0.55rem", borderRadius: 12, border: BORDER, background: "var(--surface-color)", fontSize: "0.74rem", color: "var(--text-primary)" },
  chipStrong: { fontWeight: 700, background: "rgba(59,130,246,0.08)", borderColor: "rgba(59,130,246,0.3)" },
  chipLabel: { color: "var(--text-secondary)", fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em" },
  paxInput: { width: 46, fontSize: "0.74rem", padding: "0.1rem 0.25rem" },
  moneyToggle: (on) => ({
    display: "inline-flex", alignItems: "center", gap: 7, padding: "0.2rem 0.6rem 0.2rem 0.4rem", borderRadius: 12,
    border: on ? "1px solid rgba(16,185,129,0.35)" : BORDER,
    background: on ? "rgba(16,185,129,0.1)" : "var(--surface-color)",
    color: on ? "#059669" : "var(--text-secondary)",
    fontSize: "0.74rem", fontWeight: 600, cursor: "pointer",
  }),
  // A real sliding switch (track + knob) — the previous small-dot pill read
  // as a status chip, not something clickable, and the user called it out
  // as unclear. This is the conventional on/off toggle shape.
  switchTrack: (on) => ({
    position: "relative", display: "inline-block", width: 30, height: 17, borderRadius: 9,
    background: on ? "#10b981" : "var(--border-color)", transition: "background 0.15s ease", flexShrink: 0,
  }),
  switchKnob: (on) => ({
    position: "absolute", top: 2, left: on ? 15 : 2, width: 13, height: 13, borderRadius: "50%",
    background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.35)", transition: "left 0.15s ease",
  }),

  statusPill: (status) => {
    const s = String(status || "draft");
    const tone = s === "accepted" || s === "fully_paid" ? ["rgba(16,185,129,0.14)", "#059669"]
      : s === "rejected" || s === "expired" ? ["rgba(239,68,68,0.14)", "#dc2626"]
        : s === "advance_paid" || s === "sent" ? ["rgba(59,130,246,0.14)", "#2563eb"]
          : ["rgba(120,120,120,0.14)", "var(--text-secondary)"];
    return { padding: "0.15rem 0.5rem", borderRadius: 10, background: tone[0], color: tone[1], fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" };
  },

  shareStrip: { display: "flex", alignItems: "center", gap: 8, padding: "0.4rem 0.6rem", border: BORDER, borderRadius: 6, background: "var(--surface-color)", fontSize: "0.76rem" },

  tabRow: { display: "flex", gap: 2, borderBottom: BORDER },
  tabIdle: { padding: "0.45rem 0.9rem", border: "none", borderBottom: "2px solid transparent", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.86rem", fontWeight: 500 },
  tabActive: { padding: "0.45rem 0.9rem", border: "none", borderBottom: "2px solid var(--accent-color, #3b82f6)", background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.86rem", fontWeight: 700 },
  tabCount: { marginLeft: 6, padding: "0 5px", borderRadius: 8, background: "rgba(120,120,120,0.16)", fontSize: "0.68rem" },

  planGrid: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: "1rem", alignItems: "start" },
  planMain: { display: "flex", flexDirection: "column", gap: "0.7rem", minWidth: 0 },
  planToolbar: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  btnAi: { background: "rgba(139,92,246,0.12)", borderColor: "rgba(139,92,246,0.4)", color: "#7c3aed", fontWeight: 600 },
  dayAiBtn: { display: "inline-flex", alignItems: "center", gap: 4, padding: "0.18rem 0.5rem", borderRadius: 10, border: "1px solid rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.1)", color: "#7c3aed", cursor: "pointer", fontSize: "0.7rem", fontWeight: 600, marginRight: 8 },
  rail: { display: "flex", flexDirection: "column", gap: "0.7rem", position: "sticky", top: 12 },
  railCard: { border: BORDER, borderRadius: 8, background: "var(--surface-color)", padding: "0.7rem", display: "flex", flexDirection: "column", gap: 6 },
  railHead: { fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-secondary)" },
  railEmpty: { fontSize: "0.78rem", color: "var(--text-secondary)", padding: "1.4rem 0.5rem", textAlign: "center" },
  railRow: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.78rem", padding: "0.15rem 0" },
  railBtn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "0.4rem 0.6rem", border: BORDER, borderRadius: 6, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.78rem" },
  railLink: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.74rem", color: "var(--accent-color, #3b82f6)", textDecoration: "none" },
  railLabelRow: { display: "flex", alignItems: "center", gap: 4, marginTop: 2 },
  railLabelText: { fontSize: "0.74rem", color: "var(--text-secondary)" },
  infoIcon: { display: "inline-flex", color: "var(--text-secondary)", cursor: "help" },

  dayCard: { border: BORDER, borderRadius: 8, background: "var(--surface-color)", overflow: "hidden" },
  dayHead: { display: "flex", alignItems: "center", gap: 8, padding: "0.5rem 0.65rem", borderBottom: BORDER, background: "rgba(120,120,120,0.04)" },
  collapseBtn: { border: "none", background: "transparent", cursor: "pointer", color: "var(--text-secondary)", display: "flex", padding: 0 },
  dayTitle: { fontSize: "0.86rem", color: "var(--text-primary)" },
  dayDate: { fontSize: "0.76rem", color: "var(--text-secondary)" },
  dayTotal: { fontSize: "0.78rem", fontWeight: 700, color: "var(--text-primary)" },
  dayDeleteBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, marginLeft: 8, borderRadius: 6, border: "1px solid transparent", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" },
  dayEmpty: { padding: "0.7rem 0.8rem", fontSize: "0.78rem", color: "var(--text-secondary)", fontStyle: "italic" },
  dayEndDropZone: { height: 10 },
  dayEndDropZoneActive: { height: 10, borderTop: "2px solid var(--accent-color, #3b82f6)" },
  dropIndicator: { height: 2, background: "var(--accent-color, #3b82f6)", margin: "0 8px" },

  itemRow: { display: "flex", alignItems: "center", gap: 8, padding: "0.42rem 0.65rem", borderBottom: "1px solid rgba(120,120,120,0.12)", cursor: "pointer", fontSize: "0.82rem" },
  itemRowDimmed: { opacity: 0.35 },
  grip: { color: "var(--text-secondary)", cursor: "grab", flexShrink: 0 },
  itemTime: { width: 46, flexShrink: 0, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", fontSize: "0.78rem" },
  itemIcon: { display: "flex", color: "var(--accent-color, #3b82f6)", flexShrink: 0 },
  itemDesc: { flex: 1, minWidth: 0, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  itemLoc: { color: "var(--text-secondary)" },
  itemCost: { flexShrink: 0, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" },
  aiBadge: { marginLeft: 6, padding: "0 4px", borderRadius: 4, background: "rgba(139,92,246,0.16)", color: "#7c3aed", fontSize: "0.62rem", fontWeight: 700 },
  itemDeleteBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, flexShrink: 0, borderRadius: 6, border: "1px solid transparent", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" },

  itemEditor: { padding: "0.7rem 0.65rem", borderBottom: "1px solid rgba(120,120,120,0.12)", background: "rgba(59,130,246,0.03)", display: "flex", flexDirection: "column", gap: 8 },
  editRow: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" },
  editActions: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  readonlyTotal: { padding: "0.32rem 0.5rem", border: BORDER, borderRadius: 5, background: "rgba(120,120,120,0.06)", fontSize: "0.82rem", fontWeight: 700 },

  quickAdd: { display: "flex", alignItems: "center", gap: 6, padding: "0.45rem 0.65rem", background: "rgba(120,120,120,0.03)" },

  input: { padding: "0.32rem 0.5rem", border: BORDER, borderRadius: 5, background: "var(--surface-color)", color: "var(--text-primary)", fontSize: "0.82rem", fontFamily: "inherit", minWidth: 0 },
  select: { padding: "0.35rem 0.5rem", border: BORDER, borderRadius: 5, background: "var(--surface-color)", color: "var(--text-primary)", fontSize: "0.8rem", width: "100%" },

  comboTrigger: { display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "0.32rem 0.5rem", border: BORDER, borderRadius: 5, background: "var(--surface-color)", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.82rem" },
  comboTriggerLabel: { flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  comboPopover: { position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 40, width: 220, background: "var(--surface-color)", border: BORDER, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: 6, display: "flex", flexDirection: "column", gap: 4 },
  comboSearch: { padding: "0.3rem 0.5rem", border: BORDER, borderRadius: 5, background: "var(--surface-color)", color: "var(--text-primary)", fontSize: "0.8rem" },
  comboList: { maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 },
  comboRow: { display: "flex", alignItems: "center", gap: 2 },
  comboOption: { flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "0.35rem 0.4rem", border: "none", borderRadius: 5, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.8rem", textAlign: "left" },
  comboOptionActive: { background: "rgba(59,130,246,0.12)", fontWeight: 600 },
  comboDeleteBtn: { display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, border: "none", borderRadius: 4, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", flexShrink: 0 },
  comboEmpty: { padding: "0.5rem", fontSize: "0.76rem", color: "var(--text-secondary)", textAlign: "center" },
  comboAddOption: { display: "flex", alignItems: "center", gap: 6, padding: "0.4rem", border: "1px dashed var(--border-color)", borderRadius: 5, background: "transparent", color: "var(--accent-color, #3b82f6)", cursor: "pointer", fontSize: "0.78rem", marginTop: 2 },
  fieldLabel: { fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)", fontWeight: 600 },
  inlineDisplay: { border: "1px solid transparent", background: "transparent", cursor: "text", padding: "0.1rem 0.25rem", borderRadius: 4, textAlign: "left", font: "inherit", color: "inherit" },

  btn: { display: "inline-flex", alignItems: "center", gap: 5, padding: "0.38rem 0.7rem", border: BORDER, borderRadius: 6, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.8rem" },
  btnSm: { display: "inline-flex", alignItems: "center", gap: 4, padding: "0.28rem 0.55rem", border: BORDER, borderRadius: 5, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.75rem" },
  btnPrimary: { background: "var(--accent-color, #3b82f6)", borderColor: "var(--accent-color, #3b82f6)", color: "#fff", fontWeight: 600 },
  addDayBtn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "0.5rem 0.8rem", border: "1px dashed var(--border-color)", borderRadius: 8, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.82rem", alignSelf: "flex-start" },

  tabBody: { border: BORDER, borderRadius: 8, background: "var(--surface-color)", padding: "1rem", display: "flex", flexDirection: "column", gap: 12 },
  tabIntro: { margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" },
  detailsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 },
  sectionDivider: { borderTop: "1px solid var(--border-color)", margin: "6px 0 2px" },
  fieldHint: { fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: 3 },
  staticCompareGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10, alignItems: "stretch" },
  staticBoxLabel: { fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 },
  staticReadonlyBox: { minHeight: 140, height: "calc(100% - 20px)", padding: "0.55rem 0.65rem", borderRadius: 6, border: "1px solid var(--border-color)", background: "var(--bg-color, #f7f7f9)", color: "var(--text-secondary)", fontSize: "0.82rem", lineHeight: 1.5, whiteSpace: "pre-wrap", overflow: "auto" },
  sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, fontSize: "0.86rem" },
  draftBox: { padding: "0.7rem", border: BORDER, borderRadius: 6, background: "rgba(120,120,120,0.04)", fontSize: "0.82rem", lineHeight: 1.55, whiteSpace: "pre-wrap", color: "var(--text-primary)" },

  contextGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 },
  contextCard: { border: BORDER, borderRadius: 8, padding: "0.7rem", display: "flex", flexDirection: "column", gap: 4 },
  contextEyebrow: { fontSize: "0.64rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-secondary)", fontWeight: 700 },
  contextTitle: { fontSize: "1rem", fontWeight: 700, color: "var(--text-primary)" },

  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" },
  th: { textAlign: "left", padding: "0.45rem 0.5rem", borderBottom: BORDER, color: "var(--text-secondary)", fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 },
  td: { padding: "0.4rem 0.5rem", borderBottom: "1px solid rgba(120,120,120,0.12)", color: "var(--text-primary)" },
  tdEmpty: { padding: "1.4rem", textAlign: "center", color: "var(--text-secondary)" },
  groupTd: { padding: "0.4rem 0.5rem", background: "rgba(120,120,120,0.07)", fontWeight: 700, fontSize: "0.75rem", color: "var(--text-primary)" },
  totalTd: { padding: "0.55rem 0.5rem", borderTop: `2px solid var(--border-color)`, fontWeight: 700 },

  muted: { color: "var(--text-secondary)", fontSize: "0.76rem" },
};
