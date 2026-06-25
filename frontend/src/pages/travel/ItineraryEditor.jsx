// Travel CRM — Itinerary visual day-by-day editor + map.
//
// PRD_TRAVEL_ITINERARY_UPGRADES FR-3.3 (day-by-day visual editor) +
// FR-3.4 (map preview). Mounts at /travel/itineraries/:id/edit — the read
// view at /travel/itineraries/:id is unchanged. Travel-vertical only
// (wrapped in <TravelOnly> in App.jsx), so wellness/generic never reach it.
//
// What it does:
//   - Loads the itinerary + items (GET /api/travel/itineraries/:id).
//   - Groups items into Day cards by ItineraryItem.dayNumber (S8 column).
//     Items without a dayNumber land in an "Unscheduled" bucket.
//   - Drag an item onto another Day (native HTML5 DnD) → PATCH
//     /items/:itemId { dayNumber } (optimistic; refetches on failure).
//   - Right pane: Leaflet + OpenStreetMap map plotting every item that has
//     latitude + longitude, with day-numbered pins + a day-ordered route
//     polyline. Free OSM tiles — no Mapbox key required.
//
// No schema change — dayNumber/latitude/longitude already exist on
// ItineraryItem. Adding NEW items / editing prices stays on the detail page;
// this editor is about day organisation + the map.
//
// Pins use L.divIcon (a numbered circle) rather than the default Leaflet
// marker image, which sidesteps the well-known marker-asset 404 under
// bundlers — no icon-image import/patch needed.
//
// PRD §4.3 RFU preference filters (gap A7): a collapsible "Hotel rates"
// finder panel queries the cost-master rate book filtered by hotel
// preference attributes (Haram/Kaaba-facing view, floor level, room
// category) so advisors can check preference-matching supplier rates while
// organising days. Read-only lookup — adding items stays on the detail page.
//
// G052 — Bulk-day-add (PRD FR-3.3.g): "Extend by N days" toolbar control
// prompts for N and appends N empty day cards locally. Pure frontend;
// no schema change needed since dayNumber is a client-side mapping for
// existing items. The new empty days surface as drop targets and inline-
// add receivers.
//
// G053 — Conflict warnings (PRD FR-3.3.h): per-item warning chips for
// (a) overlapping start/end times on the same day (parsed from
// detailsJson startTime/endTime fields when present), and (b) future-
// hook for POI-closed-on-visit-day once TravelPoi.closedOn lands. Pure
// client-side computation against already-loaded items.
//
// G056 — Inline +Hotel / +Activity (PRD FR-3.7.b): two per-Day-card
// buttons that open a mini-form right inside the day. Uses existing
// POST /:id/items with itemType discrimination (hotel vs activity).
// Mini-form fields: name, start/end time (hotel uses these as
// check-in/check-out; activity as session window), optional URL/notes
// stored as detailsJson. No schema change.
//
// G057 — Per-day accept/edit/reject + re-prompt-same-draft (PRD FR-3.4.e,
// FR-3.4.f): each Day card grows a "Suggest day plan" button that
// keeps the last LLM draft in component state per day. Accept materialises
// the day's items via POST /:id/items (one call per item); Edit reveals
// the items so the advisor can tweak before accept; Reject discards the
// draft AND triggers a re-roll for that day only. The draft state lives
// in component memory (lost on reload) — operator-prompt content lives
// in detailsJson on materialised items so the audit trail survives.
//
// G060 — Live re-pricing verify (PRD FR-3.3.f): after every item
// POST/PATCH/DELETE the backend syncItineraryAfterItemChange recomputes
// the parent totalAmount; the editor refetches the parent doc to surface
// the new total in the toolbar. Without the refetch, the total chip in
// the header would lag the live items list. The refetch is debounced to
// coalesce drag bursts so we don't hammer the backend during a multi-
// item drag.
//
// G062 — Keyboard shortcuts (PRD FR-3.6): Ctrl+S triggers a manual save
// flush (no-op since we auto-save, but toasts confirmation), Esc
// deselects the currently selected item, "?" opens a shortcut help
// modal. Ctrl+Z/Y are reserved as no-ops with a toast hint (undo stack
// is a multi-day investment tracked separately).

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  ArrowLeft, Plane, Hotel, MapPin, Briefcase, FileText, Shield,
  Train, Bus, Car, Camera, Utensils, Package, GripVertical, MapPinned,
  Sparkles, Layers, BookmarkPlus, AlertTriangle, Keyboard, X, Plus,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { geocode } from "../../lib/geocoder";
import PoiPicker from "../../components/PoiPicker";

// Converts a free-text destination name to a URL-safe slug for PoiPicker.
// e.g. "VIETNAM" → "vietnam", "Goa Beach" → "goa-beach"
const toSlug = (s) =>
  (s || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

const ITEM_ICONS = {
  flight: Plane, train: Train, bus: Bus, cab: Car, transfer: MapPin,
  hotel: Hotel, sightseeing: Camera, activity: Briefcase, meals: Utensils,
  visa: FileText, insurance: Shield, other: Package,
};

// Hotel preference vocabulary — mirrors backend/routes/travel_cost_master.js
// HOTEL_ATTRIBUTES (PRD §4.3 RFU preference filters).
const HOTEL_VIEWS = [
  { value: "", label: "View (any)" },
  { value: "haram_facing", label: "Haram facing" },
  { value: "kaaba_facing", label: "Kaaba facing" },
  { value: "city_view", label: "City view" },
  { value: "standard", label: "Standard" },
];
const HOTEL_FLOORS = [
  { value: "", label: "Floor (any)" },
  { value: "low", label: "Low floor" },
  { value: "mid", label: "Mid floor" },
  { value: "high", label: "High floor" },
];
const ATTR_LABELS = {
  haram_facing: "Haram facing", kaaba_facing: "Kaaba facing",
  city_view: "City view", standard: "Standard",
  low: "Low floor", mid: "Mid floor", high: "High floor",
};

function rateAttrChips(attributes) {
  const chips = [];
  if (attributes?.view) chips.push(ATTR_LABELS[attributes.view] || String(attributes.view));
  if (attributes?.floorLevel) chips.push(ATTR_LABELS[attributes.floorLevel] || String(attributes.floorLevel));
  if (attributes?.roomCategory) chips.push(String(attributes.roomCategory));
  return chips;
}

const rateSelect = {
  padding: "0.35rem 0.5rem", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: "0.8rem", minWidth: 140,
};

// G053 helper — parse the JSON stored in ItineraryItem.detailsJson.
// Returns null on parse failure (the column is a free-form @db.Text so
// legacy rows may not be valid JSON). Used by the conflict-warning
// pass and by the hotel/activity mini-form readback.
function parseDetails(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const obj = JSON.parse(String(raw));
    return obj && typeof obj === "object" ? obj : null;
  } catch (_e) {
    return null;
  }
}

// G053 helper — parse an HH:MM (or HH:MM:SS) time-of-day string into
// minutes-since-midnight. Returns null on garbage so callers can
// short-circuit overlap math without crashing on legacy rows.
function parseTimeToMinutes(s) {
  if (typeof s !== "string") return null;
  const m = /^([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// G053 — detect overlapping time windows on a per-day basis. Two items
// overlap when their [start, end) intervals intersect; items without
// both bounds are excluded from the pass (no false positive). Returns
// a Set of conflicting item ids so the day's render-pass can show a
// warning chip per offender.
function detectOverlapConflicts(dayItems) {
  const intervals = dayItems
    .map((it) => {
      const details = parseDetails(it.detailsJson);
      const start = parseTimeToMinutes(details?.startTime);
      const end = parseTimeToMinutes(details?.endTime);
      if (start == null || end == null || end <= start) return null;
      return { id: it.id, start, end };
    })
    .filter(Boolean);
  const conflicts = new Set();
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i];
      const b = intervals[j];
      if (a.start < b.end && b.start < a.end) {
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }
  }
  return conflicts;
}

function dayPin(dayNumber) {
  const label = dayNumber ? `D${dayNumber}` : "•";
  return L.divIcon({
    className: "itin-day-pin",
    html: `<div style="background:#122647;color:#fff;border:2px solid #fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,0.35)">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// Pans/zooms the map to fit all plotted points whenever they change.
function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points && points.length > 0) {
      try {
        map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 12 });
      } catch (_e) {
        /* ignore degenerate bounds */
      }
    }
  }, [points, map]);
  return null;
}

// Captures map clicks so a selected item can be placed at the clicked point.
function MapClicks({ onPick }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function ItineraryEditor() {
  const { id } = useParams();
  const notify = useNotify();
  const [itin, setItin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [destCenter, setDestCenter] = useState(null); // [lat, lng] geocoded from destination
  const [extraDays, setExtraDays] = useState(0); // local "+ Add day" beyond derived count
  const [dragId, setDragId] = useState(null);
  const [selectedId, setSelectedId] = useState(null); // item selected for "click map to place"
  // G047 lineage chip — when itin.clonedFromTemplateId is present, fetch
  // the parent template's name so the header chip can render "Cloned from
  // <name>". 404s degrade silently (template might have been soft-deleted)
  // — chip just renders "Cloned from template #<id>" instead.
  const [lineageName, setLineageName] = useState(null);
  // G050 — save-as-template progress flag (disables the button while the
  // POST is in flight so multi-clicks don't fire a duplicate create).
  const [savingTemplate, setSavingTemplate] = useState(false);

  // G056 — per-day inline-add mini-form state. `addFormForDay` holds
  // the day-number whose mini-form is currently open, plus its type
  // (hotel vs activity). null = no form open.
  const [addForm, setAddForm] = useState(null); // { day, kind } | null
  const [addFormBusy, setAddFormBusy] = useState(false);

  // G057 — per-day LLM-suggest draft state. Keyed by dayNumber; each
  // entry is { items: [...], promptUsed: string, status: 'draft' | 'editing' }.
  // Persisting only in component memory keeps the surface simple; the
  // "re-prompt same draft" requirement just means the prompt context
  // survives a Reject so Reject + Suggest-again uses the same input.
  const [dayDrafts, setDayDrafts] = useState({}); // { [dayNumber]: { items, promptUsed, status } }
  const [draftBusyDay, setDraftBusyDay] = useState(null);

  // G062 — keyboard shortcut cheat-sheet modal toggle.
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);

  // G060 — debounced re-fetch timer so multi-item drag bursts coalesce
  // into a single refetch (saves ~10 backend hits during a 10-item
  // reorder pass). useRef avoids re-render churn on every keystroke.
  const refetchTimer = useRef(null);

  // Hotel rate finder (PRD §4.3 preference filters) — collapsible panel
  // querying /api/travel/cost-master?category=hotel with view/floorLevel/
  // roomCategory filters.
  const [showRates, setShowRates] = useState(false);
  const [ratePrefs, setRatePrefs] = useState({ view: "", floorLevel: "", roomCategory: "" });
  const [rateResults, setRateResults] = useState([]);
  const [ratesLoading, setRatesLoading] = useState(false);

  useEffect(() => {
    if (!showRates) return undefined;
    let cancelled = false;
    // Small debounce so the roomCategory text input doesn't fire per keystroke.
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ category: "hotel", active: "true", limit: "20" });
      if (ratePrefs.view) qs.set("view", ratePrefs.view);
      if (ratePrefs.floorLevel) qs.set("floorLevel", ratePrefs.floorLevel);
      if (ratePrefs.roomCategory.trim()) qs.set("roomCategory", ratePrefs.roomCategory.trim());
      setRatesLoading(true);
      fetchApi(`/api/travel/cost-master?${qs.toString()}`)
        .then((res) => { if (!cancelled) setRateResults(Array.isArray(res?.rates) ? res.rates : []); })
        .catch(() => { if (!cancelled) setRateResults([]); })
        .finally(() => { if (!cancelled) setRatesLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [showRates, ratePrefs]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchApi(`/api/travel/itineraries/${id}`);
      setItin(data);
    } catch (e) {
      setError(e?.message || "Failed to load itinerary");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Geocode the trip destination so the map opens centred on it (e.g. Tokyo)
  // instead of falling back to the India midpoint when no items are pinned yet.
  useEffect(() => {
    if (!itin?.destination) return;
    let cancelled = false;
    geocode(itin.destination).then((r) => {
      if (!cancelled && r) setDestCenter([r.lat, r.lng]);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [itin?.destination]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-geocode day-planner items that have a description but no saved
  // coordinates. Runs once per itinerary (dep on itin.id). Each geocoded
  // item calls setItemLatLng which optimistically updates local state AND
  // PATCHes the backend — pins appear progressively and survive a reload.
  //
  // Nominatim can't geocode activity sentences ("Day 1 — morning sightseeing
  // in Tokyo"). Extract the trailing capitalised place name after "in " so we
  // query "Tokyo" instead of the full sentence. Falls back to the full
  // description for specific named places ("Visit Shinjuku Gyoen Garden").
  useEffect(() => {
    if (!itin?.id || !Array.isArray(itin.items)) return;
    const needsGeocode = itin.items.filter(
      (it) =>
        it.description &&
        (typeof it.latitude !== "number" || typeof it.longitude !== "number"),
    );
    if (needsGeocode.length === 0) return;
    let cancelled = false;
    // Destination as a disambiguation hint passed to Nominatim so that
    // short descriptions ("ISKCON Temple") resolve to the right city.
    const destHint = (itin?.destination || "").toLowerCase().trim().replace(/\s+/g, " ");
    (async () => {
      for (const it of needsGeocode) {
        if (cancelled) break;
        // Priority order for query extraction:
        // 1. "...in Tokyo" / "...in Paris, France"   → "Tokyo" / "Paris, France"
        // 2. "...to ISKCON Temple, Rajajinagar."      → "ISKCON Temple, Rajajinagar"
        // 3. Full description + destination hint      → "Sandhya aarti bangalore"
        const inMatch  = it.description.match(/\bin\s+([A-Z][^,.]+(?:,\s*[A-Z][^,.]+)?)\s*[.,]?\s*$/);
        const toMatch  = it.description.match(/\bto\s+([A-Z][^,.]+(?:,\s*[A-Z][^,.]+)?)\s*[.,]?\s*$/);
        let query;
        if (inMatch)     query = inMatch[1].trim();
        else if (toMatch) query = toMatch[1].trim();
        else              query = destHint ? `${it.description} ${destHint}` : it.description;

        let r = await geocode(query).catch(() => null);
        // If the hint-augmented query failed, retry with the bare description.
        if (!r && !inMatch && !toMatch && destHint) {
          r = await geocode(it.description).catch(() => null);
        }
        if (!cancelled && r) setItemLatLng(it.id, r.lat, r.lng);
      }
    })();
    return () => { cancelled = true; };
  }, [itin?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // G050 — POST /api/travel/itineraries/:id/save-as-template. The route
  // derives name/destination/duration/basePriceMinor from the itinerary;
  // we let the operator override the name with a window.prompt() so
  // they can label the template ("Goa Beach 5D — Q3 pricing") without
  // navigating away. Empty/cancelled prompt → fall back to backend default.
  const handleSaveAsTemplate = useCallback(async () => {
    if (savingTemplate) return;
    let nameOverride = null;
    try {
      // window.prompt is sync; degrade gracefully if the browser blocks it.
      const proposed = window.prompt(
        "Template name (leave blank to use the itinerary's destination):",
        itin?.destination ? `${itin.destination} template` : "",
      );
      if (proposed === null) return; // user cancelled
      nameOverride = proposed.trim() || null;
    } catch (_e) {
      nameOverride = null;
    }
    setSavingTemplate(true);
    try {
      const body = nameOverride ? { name: nameOverride } : {};
      const tpl = await fetchApi(
        `/api/travel/itineraries/${id}/save-as-template`,
        { method: "POST", body: JSON.stringify(body) },
      );
      notify.success(`Saved as template: "${tpl?.name || "(unnamed)"}"`);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to save as template");
    } finally {
      setSavingTemplate(false);
    }
  }, [id, itin, notify, savingTemplate]);

  // G047 — resolve parent template name for the lineage chip. Only fires
  // when an itinerary has lineage set; the fetch is silent (no error toast)
  // so a missing/soft-deleted template falls through to the numeric chip.
  useEffect(() => {
    const tplId = itin?.clonedFromTemplateId;
    if (!tplId) { setLineageName(null); return undefined; }
    let cancelled = false;
    fetchApi(`/api/travel/itinerary-templates/${tplId}`, { silent: true })
      .then((res) => { if (!cancelled) setLineageName(res?.name || null); })
      .catch(() => { if (!cancelled) setLineageName(null); });
    return () => { cancelled = true; };
  }, [itin?.clonedFromTemplateId]);

  const items = useMemo(() => (itin?.items ? [...itin.items] : []), [itin]);

  // Day count = max(date-range span, highest dayNumber present, 1) + locally-added days.
  const derivedDayCount = useMemo(() => {
    let n = 1;
    if (itin?.startDate && itin?.endDate) {
      const ms = new Date(itin.endDate) - new Date(itin.startDate);
      if (Number.isFinite(ms) && ms >= 0) n = Math.max(n, Math.floor(ms / 86400000) + 1);
    }
    for (const it of items) if (it.dayNumber && it.dayNumber > n) n = it.dayNumber;
    return n;
  }, [itin, items]);

  const dayCount = derivedDayCount + extraDays;

  const itemsForDay = useCallback(
    (day) =>
      items
        .filter((it) => (day === null ? !it.dayNumber : it.dayNumber === day))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [items],
  );

  // Map points in day order (then position) — only items with numeric coords.
  const mapItems = useMemo(
    () =>
      items
        .filter((it) => typeof it.latitude === "number" && typeof it.longitude === "number")
        .sort(
          (a, b) =>
            (a.dayNumber ?? 999) - (b.dayNumber ?? 999) ||
            (a.position ?? 0) - (b.position ?? 0),
        ),
    [items],
  );
  const routeLine = useMemo(() => mapItems.map((it) => [it.latitude, it.longitude]), [mapItems]);

  // G060 — debounced refetch helper. Defined BEFORE moveToDay /
  // setItemLatLng so their useCallback deps array can reference it
  // without a TDZ error (useCallback runs its deps array at render time
  // top-to-bottom, so the binding has to exist by then).
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      load();
    }, 350);
  }, [load]);

  const moveToDay = useCallback(
    async (itemId, day) => {
      const target = items.find((it) => it.id === itemId);
      if (!target || target.dayNumber === day) return;
      // Optimistic local update; PATCH persists. Refetch on failure to restore truth.
      setItin((prev) =>
        prev && {
          ...prev,
          items: prev.items.map((it) => (it.id === itemId ? { ...it, dayNumber: day } : it)),
        });
      try {
        await fetchApi(`/api/travel/itineraries/${id}/items/${itemId}`, {
          method: "PATCH",
          body: JSON.stringify({ dayNumber: day }),
          silent: true,
        });
        // G060 — refetch so the toolbar totalAmount tracks the server's
        // post-syncItineraryAfterItemChange figure even when the move
        // doesn't change line-totals (move alone doesn't shift totals,
        // but follow-on edits piggy-back on the debounced refetch).
        scheduleRefetch();
      } catch (_e) {
        notify?.error?.("Couldn't move item — reverting.");
        load();
      }
    },
    [items, id, notify, load, scheduleRefetch],
  );

  // Place the selected item at a clicked map coordinate (FR-3.4). Optimistic
  // local update + PATCH { latitude, longitude }; refetch on failure.
  const setItemLatLng = useCallback(
    async (itemId, lat, lng) => {
      const latitude = Math.round(lat * 1e6) / 1e6;
      const longitude = Math.round(lng * 1e6) / 1e6;
      setItin((prev) =>
        prev && {
          ...prev,
          items: prev.items.map((it) => (it.id === itemId ? { ...it, latitude, longitude } : it)),
        });
      try {
        await fetchApi(`/api/travel/itineraries/${id}/items/${itemId}`, {
          method: "PATCH",
          body: JSON.stringify({ latitude, longitude }),
          silent: true,
        });
        // G060 — refetch so totalAmount + any server-side recompute lands
        // in the toolbar without manual reload.
        scheduleRefetch();
      } catch (_e) {
        notify?.error?.("Couldn't set location — reverting.");
        load();
      }
    },
    [id, notify, load, scheduleRefetch],
  );

  // G052 — Bulk-day-add. Prompts for N (1-30 clamp) and appends N empty
  // Day cards locally by bumping extraDays. Each new card becomes a
  // drop target and an inline-add receiver. No backend round-trip —
  // dayNumber is a client-side bucket on existing items, and empty
  // days carry no rows yet.
  const handleExtendDays = useCallback(async () => {
    const raw = await notify.prompt({
      title: "Extend itinerary",
      message: "How many extra days to add to the plan?",
      defaultValue: "1",
      placeholder: "e.g. 3",
      confirmText: "Extend",
    });
    if (raw == null) return; // cancelled
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n < 1) {
      notify.error("Enter a whole number of days (1 or more).");
      return;
    }
    const clamped = Math.min(n, 30);
    if (n > 30) notify.info(`Clamped to ${clamped} days (30-day max).`);
    setExtraDays((cur) => cur + clamped);
    notify.success(`Added ${clamped} empty day${clamped === 1 ? "" : "s"} — ready to plan.`);
  }, [notify]);

  // G056 — inline-add submit. Posts to the existing /:id/items endpoint
  // with the appropriate itemType. Hotel uses startTime/endTime as
  // check-in/check-out; activity uses them as session bounds. Both
  // store the times + optional url + notes in detailsJson so they
  // survive a round-trip + can be re-read for G053 conflict detection.
  const submitInlineAdd = useCallback(
    async ({ day, kind, name, startTime, endTime, url, notes, latitude, longitude }) => {
      const itemType = kind === "hotel" ? "hotel" : "activity";
      const description = String(name || "").trim();
      if (!description) {
        notify.error("Name is required.");
        return false;
      }
      const detailsObj = {};
      if (startTime) detailsObj.startTime = startTime;
      if (endTime) detailsObj.endTime = endTime;
      if (url) detailsObj.url = String(url).trim();
      if (notes) detailsObj.notes = String(notes).trim();
      const body = {
        itemType,
        description,
        dayNumber: day,
        detailsJson: Object.keys(detailsObj).length ? JSON.stringify(detailsObj) : null,
      };
      // Carry POI coordinates so the map pin renders immediately (FR-3.3.e).
      if (latitude != null) body.latitude = latitude;
      if (longitude != null) body.longitude = longitude;
      setAddFormBusy(true);
      try {
        await fetchApi(`/api/travel/itineraries/${id}/items`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        notify.success(`${kind === "hotel" ? "Hotel" : "Activity"} added to Day ${day}.`);
        setAddForm(null);
        scheduleRefetch();
        return true;
      } catch (e) {
        notify.error(e?.body?.error || e?.message || "Failed to add item.");
        return false;
      } finally {
        setAddFormBusy(false);
      }
    },
    [id, notify, scheduleRefetch],
  );

  // G057 — per-day Suggest. Calls POST /api/travel/itineraries/suggest
  // with a single-day duration scoped to the editor's destination, and
  // captures the returned suggestion's day[0].items into local draft
  // state. The "re-prompt same draft" requirement means we keep the
  // prompt context (currently { destination, dayNumber }) in draft so a
  // Reject + Suggest-again uses the same input — no re-typing.
  const handleSuggestDay = useCallback(
    async (day) => {
      if (draftBusyDay) return;
      const destination = itin?.destination || "";
      if (!destination) {
        notify.error("Set a destination on the itinerary before suggesting items.");
        return;
      }
      setDraftBusyDay(day);
      try {
        const promptContext = { destination, days: 1, dayLabel: `Day ${day}` };
        const res = await fetchApi(`/api/travel/itineraries/suggest`, {
          method: "POST",
          body: JSON.stringify({
            destination,
            days: 1,
            tier: "primary",
          }),
        });
        const ds = Array.isArray(res?.suggestion?.daySplit) ? res.suggestion.daySplit : [];
        const items = Array.isArray(ds[0]?.items) ? ds[0].items : [];
        if (items.length === 0) {
          notify.info(`No suggestions returned for Day ${day}.`);
          return;
        }
        setDayDrafts((prev) => ({
          ...prev,
          [day]: { items, promptUsed: promptContext, status: "draft" },
        }));
      } catch (e) {
        notify.error(e?.body?.error || e?.message || "Failed to fetch suggestion.");
      } finally {
        setDraftBusyDay(null);
      }
    },
    [draftBusyDay, itin, notify],
  );

  // G057 — Accept the draft for a day. Iterates the draft's items[]
  // and POSTs each to /:id/items with dayNumber set. We use sequential
  // posts (not Promise.all) so position ordering is preserved by the
  // server-side auto-position.
  const handleAcceptDayDraft = useCallback(
    async (day) => {
      const draft = dayDrafts[day];
      if (!draft || !Array.isArray(draft.items)) return;
      setDraftBusyDay(day);
      let posted = 0;
      try {
        for (const src of draft.items) {
          const body = {
            itemType: src.itemType || "activity",
            description: String(src.description || src.name || "(unnamed)"),
            dayNumber: day,
            unitCost: src.estimatedCost != null ? Number(src.estimatedCost) : null,
          };
          // sequential preserves position ordering server-side
          await fetchApi(`/api/travel/itineraries/${id}/items`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          posted += 1;
        }
        notify.success(`Accepted ${posted} item${posted === 1 ? "" : "s"} on Day ${day}.`);
        setDayDrafts((prev) => {
          const next = { ...prev };
          delete next[day];
          return next;
        });
        scheduleRefetch();
      } catch (e) {
        notify.error(`Accepted ${posted}/${draft.items.length} — ${e?.body?.error || e?.message || "stopped"}.`);
        scheduleRefetch();
      } finally {
        setDraftBusyDay(null);
      }
    },
    [dayDrafts, id, notify, scheduleRefetch],
  );

  // G057 — Reject a day's draft AND re-roll using the same prompt
  // context. The "same draft" preservation means we don't drop
  // promptUsed; we re-call /suggest with it. If the operator wants to
  // permanently discard, they'd reject again or just dismiss visually.
  const handleRejectDayDraft = useCallback(
    async (day) => {
      const draft = dayDrafts[day];
      setDayDrafts((prev) => {
        const next = { ...prev };
        delete next[day];
        return next;
      });
      if (!draft?.promptUsed) return;
      // re-prompt automatically with the same context.
      await handleSuggestDay(day);
    },
    [dayDrafts, handleSuggestDay],
  );

  // G057 — Edit a draft: flips status to "editing" so the day card
  // renders inline-editable rows for each suggested item before accept.
  const handleEditDayDraft = useCallback((day) => {
    setDayDrafts((prev) => {
      const cur = prev[day];
      if (!cur) return prev;
      return { ...prev, [day]: { ...cur, status: "editing" } };
    });
  }, []);

  const handleEditDraftItemField = useCallback((day, idx, field, value) => {
    setDayDrafts((prev) => {
      const cur = prev[day];
      if (!cur || !Array.isArray(cur.items)) return prev;
      const items = cur.items.map((it, i) => (i === idx ? { ...it, [field]: value } : it));
      return { ...prev, [day]: { ...cur, items } };
    });
  }, []);

  // G062 — global key handler. Ctrl+S = "manual save" toast (auto-save
  // already covers persistence; the toast confirms to the operator),
  // Esc = deselect, Ctrl+Z/Y = undo placeholder toast, "?" = open help.
  useEffect(() => {
    const onKey = (e) => {
      // Skip when typing in an input/textarea/select.
      const tag = e.target?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        notify.success("Itinerary auto-saves on every change — no manual save needed.");
        return;
      }
      if (meta && (e.key.toLowerCase() === "z" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        if (inField) return;
        e.preventDefault();
        notify.info("Undo isn't wired yet — drag the item back to its previous day to revert.");
        return;
      }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        if (inField) return;
        e.preventDefault();
        notify.info("Redo isn't wired yet.");
        return;
      }
      if (e.key === "Escape") {
        if (shortcutHelpOpen) { setShortcutHelpOpen(false); return; }
        if (addForm) { setAddForm(null); return; }
        if (selectedId != null) setSelectedId(null);
        return;
      }
      if (e.key === "?" && !inField) {
        e.preventDefault();
        setShortcutHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notify, selectedId, addForm, shortcutHelpOpen]);

  if (loading) return <div style={{ padding: "2rem" }}>Loading&hellip;</div>;
  if (error) {
    return (
      <div style={{ padding: "2rem", color: "#A8323F" }}>
        {error} — <Link to={`/travel/itineraries/${id}`}>back to itinerary</Link>
      </div>
    );
  }
  if (!itin) return null;

  const dayBuckets = [null, ...Array.from({ length: dayCount }, (_, i) => i + 1)];
  // Default centre when nothing is placed yet = India (broad view); once any
  // pin exists, FitBounds zooms to the actual points.
  const mapCenter = mapItems.length
    ? [mapItems[0].latitude, mapItems[0].longitude]
    : destCenter || [20, 0];

  return (
    <div data-vertical="travel" style={{ padding: "1.25rem", height: "100%", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link
          to={`/travel/itineraries/${id}`}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.85rem" }}
        >
          <ArrowLeft size={16} /> Back to itinerary
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.15rem", color: "var(--text-primary)" }}>
          {itin.destination || "Itinerary"} — day planner
        </h1>
        {/* G047 — lineage chip (PRD FR-3.1.e). Renders when clonedFromTemplateId
            is set. Falls back to the numeric id if the parent template fetch
            returned no name (soft-deleted / cross-tenant safety). */}
        {itin.clonedFromTemplateId && (
          <span
            data-testid="itinerary-lineage-chip"
            title={`Cloned from itinerary template #${itin.clonedFromTemplateId}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.3rem",
              padding: "0.18rem 0.5rem", borderRadius: 12,
              border: "1px solid var(--border-color)",
              background: "rgba(18,38,71,0.08)",
              color: "var(--primary-color, var(--accent-color))",
              fontSize: "0.72rem", fontWeight: 600,
            }}
          >
            <Layers size={12} aria-hidden />
            Cloned from {lineageName ? `“${lineageName}”` : `template #${itin.clonedFromTemplateId}`}
          </span>
        )}
        <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
          Drag items between days · {mapItems.length}/{items.length} plotted on map
        </span>
        {/* G060 — live total chip. Refreshes after every item POST/PATCH/
            DELETE via scheduleRefetch(). Renders even when totalAmount is
            null so the regression "no chip at all" is visible. */}
        <span
          data-testid="itinerary-total-chip"
          title="Sum of item line totals — recomputed server-side after every change"
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.3rem",
            padding: "0.18rem 0.6rem", borderRadius: 12,
            border: "1px solid var(--border-color)",
            background: "rgba(18,38,71,0.06)",
            color: "var(--text-primary)",
            fontSize: "0.72rem", fontWeight: 600,
          }}
        >
          Total: {itin.totalAmount != null
            ? `${itin.currency || "INR"} ${Number(itin.totalAmount).toLocaleString()}`
            : "—"}
        </span>
        {/* G050 — Save current itinerary as template (PRD FR-3.1.f). Calls
            POST /api/travel/itineraries/:id/save-as-template and toasts the
            resulting template name. ADMIN+MANAGER only at the backend; the
            button still renders for USER so they get the 403 toast (clearer
            UX than a missing button). */}
        <button
          type="button"
          data-testid="save-as-template-btn"
          disabled={savingTemplate}
          onClick={handleSaveAsTemplate}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.35rem 0.7rem", border: "1px solid var(--border-color)", borderRadius: 6, background: "transparent", color: "var(--text-primary)", cursor: savingTemplate ? "wait" : "pointer", fontSize: "0.8rem", opacity: savingTemplate ? 0.6 : 1 }}
          title="Save this itinerary's day-by-day layout as a reusable template"
        >
          <BookmarkPlus size={14} /> {savingTemplate ? "Saving…" : "Save as template"}
        </button>
        {/* G052 — Extend by N days (PRD FR-3.3.g). Prompts for N and appends
            empty Day cards locally; saves a multi-click loop on the
            "+ Add day" pattern when planning long Umrah / school trips. */}
        <button
          type="button"
          data-testid="extend-days-btn"
          onClick={handleExtendDays}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.35rem 0.7rem", border: "1px solid var(--border-color)", borderRadius: 6, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.8rem" }}
          title="Append N empty day cards to the end of the plan"
        >
          <Plus size={14} /> Extend by N days
        </button>
        {/* G062 — Keyboard shortcuts help (PRD FR-3.6). */}
        <button
          type="button"
          data-testid="shortcuts-help-btn"
          onClick={() => setShortcutHelpOpen(true)}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.35rem 0.55rem", border: "1px solid var(--border-color)", borderRadius: 6, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.8rem" }}
          title="Keyboard shortcuts (press ?)"
          aria-label="Show keyboard shortcuts"
        >
          <Keyboard size={14} /> ?
        </button>
        <button
          type="button"
          onClick={() => setShowRates((s) => !s)}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.35rem 0.7rem", border: "1px solid var(--border-color)", borderRadius: 6, background: showRates ? "var(--subtle-bg, rgba(0,0,0,0.04))" : "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.8rem" }}
        >
          <Hotel size={14} /> Hotel rates {showRates ? "▾" : "▸"}
        </button>
      </div>

      {/* Hotel rate finder — preference-filtered cost-master lookup (PRD §4.3). */}
      {showRates && (
        <div style={{ border: "1px solid var(--border-color)", borderRadius: 10, background: "var(--surface-color)", padding: "0.75rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={ratePrefs.view}
              onChange={(e) => setRatePrefs((p) => ({ ...p, view: e.target.value }))}
              style={rateSelect}
              aria-label="View preference"
            >
              {HOTEL_VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
            <select
              value={ratePrefs.floorLevel}
              onChange={(e) => setRatePrefs((p) => ({ ...p, floorLevel: e.target.value }))}
              style={rateSelect}
              aria-label="Floor preference"
            >
              {HOTEL_FLOORS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <input
              value={ratePrefs.roomCategory}
              onChange={(e) => setRatePrefs((p) => ({ ...p, roomCategory: e.target.value }))}
              placeholder="Room category (e.g. Deluxe)"
              style={{ ...rateSelect, minWidth: 180 }}
              aria-label="Room category"
            />
            <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
              {ratesLoading ? "Searching…" : `${rateResults.length} matching rate${rateResults.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {!ratesLoading && rateResults.length === 0 && (
            <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", padding: "0.4rem 0" }}>
              No hotel rates match these preferences.
            </div>
          )}
          {rateResults.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", padding: "0.4rem 0.5rem", border: "1px solid var(--border-color)", borderRadius: 6, background: "var(--subtle-bg, rgba(0,0,0,0.02))" }}>
              <Hotel size={14} style={{ color: "var(--primary-color, var(--accent-color))", flexShrink: 0 }} />
              <code style={{ fontSize: "0.75rem" }}>{r.routeOrSku}</code>
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                ₹{Number(r.baseRate).toLocaleString()}
              </span>
              {rateAttrChips(r.attributes).map((c) => (
                <span key={c} style={{ padding: "1px 7px", borderRadius: 10, fontSize: "0.68rem", fontWeight: 600, border: "1px solid var(--border-color)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                  {c}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: "1rem", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
        {/* Day cards */}
        <div style={{ flex: "1 1 420px", minWidth: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {dayBuckets.map((day) => {
            const dayItems = itemsForDay(day);
            // G053 — detect overlapping start/end time intervals within
            // this day. Cheap O(n²) since a day rarely has >10 items.
            const conflictIds = day === null ? new Set() : detectOverlapConflicts(dayItems);
            const draft = day !== null ? dayDrafts[day] : null;
            const formOpen = addForm && addForm.day === day;
            return (
              <div
                key={day === null ? "unscheduled" : day}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId != null) moveToDay(dragId, day);
                  setDragId(null);
                }}
                style={{ border: "1px solid var(--border-color)", borderRadius: 10, background: "var(--surface-color)", padding: "0.75rem" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
                    {day === null ? "Unscheduled" : `Day ${day}`}
                  </strong>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                    {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
                  </span>
                  {conflictIds.size > 0 && (
                    <span
                      data-testid={`day-${day}-conflict-banner`}
                      title="One or more items have overlapping start/end times"
                      style={{
                        display: "inline-flex", alignItems: "center", gap: "0.25rem",
                        padding: "1px 6px", borderRadius: 10,
                        border: "1px solid #D97706",
                        background: "#FEF3C7",
                        color: "#92400E",
                        fontSize: "0.62rem", fontWeight: 700,
                      }}
                    >
                      <AlertTriangle size={10} aria-hidden /> {conflictIds.size} conflict{conflictIds.size === 1 ? "" : "s"}
                    </span>
                  )}
                  {/* G056 inline-add buttons + G057 suggest control. Only on
                      real days, not the Unscheduled bucket. */}
                  {day !== null && (
                    <div style={{ marginLeft: "auto", display: "inline-flex", gap: "0.25rem", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        data-testid={`day-${day}-add-hotel-btn`}
                        onClick={() => setAddForm({ day, kind: "hotel" })}
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", padding: "0.18rem 0.45rem", border: "1px solid var(--border-color)", borderRadius: 5, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.7rem" }}
                        title="Add a hotel stay to this day"
                      >
                        <Hotel size={11} /> + Hotel
                      </button>
                      <button
                        type="button"
                        data-testid={`day-${day}-add-activity-btn`}
                        onClick={() => setAddForm({ day, kind: "activity" })}
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", padding: "0.18rem 0.45rem", border: "1px solid var(--border-color)", borderRadius: 5, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.7rem" }}
                        title="Add an activity to this day"
                      >
                        <Briefcase size={11} /> + Activity
                      </button>
                      <button
                        type="button"
                        data-testid={`day-${day}-suggest-btn`}
                        disabled={draftBusyDay === day}
                        onClick={() => handleSuggestDay(day)}
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", padding: "0.18rem 0.45rem", border: "1px solid var(--border-color)", borderRadius: 5, background: "transparent", color: "var(--primary-color, var(--accent-color))", cursor: draftBusyDay === day ? "wait" : "pointer", fontSize: "0.7rem" }}
                        title="Ask the AI to suggest items for this day"
                      >
                        <Sparkles size={11} /> {draftBusyDay === day ? "Suggesting…" : "Suggest"}
                      </button>
                    </div>
                  )}
                </div>
                {/* G056 — inline-add mini-form. Appears between the header
                    and items when "+ Hotel" or "+ Activity" is clicked. */}
                {formOpen && (
                  <InlineAddForm
                    day={day}
                    kind={addForm.kind}
                    busy={addFormBusy}
                    onCancel={() => setAddForm(null)}
                    onSubmit={(payload) => submitInlineAdd({ day, kind: addForm.kind, ...payload })}
                    destinationSlug={toSlug(itin?.destination)}
                  />
                )}
                {/* G057 — pending draft strip. Shows the suggestion's items
                    with Accept / Edit / Reject controls. In "editing" mode
                    each row exposes inline description + cost fields so the
                    advisor can tweak before commit. */}
                {draft && Array.isArray(draft.items) && draft.items.length > 0 && (
                  <div
                    data-testid={`day-${day}-draft-strip`}
                    style={{
                      marginTop: "0.4rem", padding: "0.5rem",
                      border: "1px dashed #E0C68A",
                      borderRadius: 6, background: "#FBF4DF",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.35rem", flexWrap: "wrap" }}>
                      <Sparkles size={12} aria-hidden style={{ color: "#6B4F1B" }} />
                      <strong style={{ fontSize: "0.72rem", color: "#6B4F1B" }}>
                        AI-suggested · {draft.items.length} item{draft.items.length === 1 ? "" : "s"}
                      </strong>
                      <div style={{ marginLeft: "auto", display: "inline-flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          data-testid={`day-${day}-draft-accept-btn`}
                          disabled={draftBusyDay === day}
                          onClick={() => handleAcceptDayDraft(day)}
                          style={{ padding: "0.18rem 0.55rem", border: "1px solid #6B4F1B", borderRadius: 4, background: "#6B4F1B", color: "#fff", cursor: draftBusyDay === day ? "wait" : "pointer", fontSize: "0.68rem", fontWeight: 600 }}
                        >
                          {draftBusyDay === day ? "Accepting…" : "Accept"}
                        </button>
                        <button
                          type="button"
                          data-testid={`day-${day}-draft-edit-btn`}
                          onClick={() => handleEditDayDraft(day)}
                          style={{ padding: "0.18rem 0.55rem", border: "1px solid #6B4F1B", borderRadius: 4, background: "transparent", color: "#6B4F1B", cursor: "pointer", fontSize: "0.68rem", fontWeight: 600 }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          data-testid={`day-${day}-draft-reject-btn`}
                          onClick={() => handleRejectDayDraft(day)}
                          style={{ padding: "0.18rem 0.55rem", border: "1px solid #A8323F", borderRadius: 4, background: "transparent", color: "#A8323F", cursor: "pointer", fontSize: "0.68rem", fontWeight: 600 }}
                          title="Discard this draft and re-roll with the same prompt"
                        >
                          Reject + retry
                        </button>
                      </div>
                    </div>
                    {draft.items.map((di, idx) => (
                      <div key={idx} style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.25rem 0", fontSize: "0.72rem", color: "#3F2F0C" }}>
                        <span style={{ minWidth: 60, fontWeight: 600, textTransform: "capitalize" }}>{di.itemType || "item"}</span>
                        {draft.status === "editing" ? (
                          <>
                            <input
                              value={di.description || ""}
                              onChange={(e) => handleEditDraftItemField(day, idx, "description", e.target.value)}
                              style={{ flex: 1, padding: "0.15rem 0.35rem", border: "1px solid #D8C28A", borderRadius: 3, fontSize: "0.72rem" }}
                              aria-label="Draft item description"
                            />
                            <input
                              type="number"
                              value={di.estimatedCost ?? ""}
                              onChange={(e) => handleEditDraftItemField(day, idx, "estimatedCost", e.target.value)}
                              placeholder="cost"
                              style={{ width: 70, padding: "0.15rem 0.35rem", border: "1px solid #D8C28A", borderRadius: 3, fontSize: "0.72rem" }}
                              aria-label="Draft item estimated cost"
                            />
                          </>
                        ) : (
                          <>
                            <span style={{ flex: 1 }}>{di.description}</span>
                            {di.estimatedCost != null && (
                              <span style={{ fontVariantNumeric: "tabular-nums" }}>₹{Number(di.estimatedCost).toLocaleString()}</span>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {dayItems.length === 0 && !formOpen && !draft && (
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", padding: "0.5rem", border: "1px dashed var(--border-color)", borderRadius: 6, textAlign: "center" }}>
                    Drop items here
                  </div>
                )}
                {dayItems.map((it) => {
                  const Icon = ITEM_ICONS[it.itemType] || Package;
                  const hasGeo = typeof it.latitude === "number" && typeof it.longitude === "number";
                  const inConflict = conflictIds.has(it.id);
                  return (
                    <div
                      key={it.id}
                      draggable
                      onDragStart={() => setDragId(it.id)}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => setSelectedId((cur) => (cur === it.id ? null : it.id))}
                      title="Click to select, then click the map to place this item"
                      style={{
                        display: "flex", alignItems: "center", gap: "0.5rem",
                        padding: "0.5rem", marginTop: "0.4rem",
                        border: selectedId === it.id
                          ? "2px solid var(--primary-color, var(--accent-color))"
                          : (inConflict ? "1px solid #D97706" : "1px solid var(--border-color)"),
                        borderRadius: 6,
                        background: selectedId === it.id ? "rgba(18,38,71,0.06)" : "var(--subtle-bg, rgba(0,0,0,0.02))",
                        cursor: "grab", opacity: dragId === it.id ? 0.5 : 1,
                      }}
                    >
                      <GripVertical size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                      <Icon size={15} style={{ color: "var(--primary-color, var(--accent-color))", flexShrink: 0 }} />
                      <span style={{ fontSize: "0.8rem", color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.description}
                      </span>
                      {/* G053 — overlap conflict chip. Shows when this
                          item's [startTime, endTime) overlaps any sibling
                          on the same day. detailsJson-driven so legacy
                          rows without time bounds stay un-flagged. */}
                      {inConflict && (
                        <span
                          data-testid={`itinerary-item-conflict-${it.id}`}
                          title="Time overlaps another item on this day"
                          style={{
                            display: "inline-flex", alignItems: "center", gap: "0.2rem",
                            padding: "1px 6px", borderRadius: 10,
                            border: "1px solid #D97706",
                            background: "#FEF3C7",
                            color: "#92400E",
                            fontSize: "0.62rem", fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          <AlertTriangle size={10} aria-hidden /> conflict
                        </span>
                      )}
                      {/* G051 — AI-drafted provenance badge (PRD FR-3.4.h).
                          Surfaces only on items materialised via POST
                          /itineraries/from-suggestion. Manual + legacy items
                          default to draftedByAi=false and stay un-badged. */}
                      {it.draftedByAi && (
                        <span
                          data-testid={`itinerary-item-ai-badge-${it.id}`}
                          title="Drafted by AI (review before sending to customer)"
                          style={{
                            display: "inline-flex", alignItems: "center", gap: "0.2rem",
                            padding: "1px 6px", borderRadius: 10,
                            border: "1px solid #E0C68A",
                            background: "#FBF4DF",
                            color: "#6B4F1B",
                            fontSize: "0.62rem", fontWeight: 700,
                            letterSpacing: 0.2, flexShrink: 0,
                          }}
                        >
                          <Sparkles size={10} aria-hidden /> AI-drafted
                        </span>
                      )}
                      {hasGeo ? (
                        <MapPinned size={13} style={{ color: "#2F7A4D", flexShrink: 0 }} aria-label="On map" />
                      ) : (
                        <MapPin size={13} style={{ color: "var(--border-color)", flexShrink: 0 }} aria-label="No coordinates" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setExtraDays((n) => n + 1)}
            style={{ alignSelf: "flex-start", padding: "0.4rem 0.8rem", border: "1px dashed var(--border-color)", borderRadius: 6, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.8rem" }}
          >
            + Add day
          </button>
        </div>

        {/* Map — always rendered so you can click to place pins. */}
        <div style={{ flex: "1 1 380px", minWidth: 300, minHeight: 360, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border-color)", position: "relative" }}>
          <div style={{ position: "absolute", zIndex: 1000, top: 8, left: 8, right: 8, padding: "0.45rem 0.65rem", borderRadius: 6, background: "rgba(18,38,71,0.88)", color: "#fff", fontSize: "0.72rem", pointerEvents: "none", lineHeight: 1.3 }}>
            {selectedId
              ? `Click the map to place “${items.find((i) => i.id === selectedId)?.description || "item"}”.`
              : mapItems.length === 0
                ? "No pins yet — select an item on the left, then click the map to drop its location."
                : "Select an item on the left, then click the map to set/move its pin."}
          </div>
          <MapContainer
            center={mapCenter}
            zoom={mapItems.length ? 6 : destCenter ? 10 : 4}
            style={{ height: "100%", width: "100%", minHeight: 360, cursor: selectedId ? "crosshair" : "grab" }}
            scrollWheelZoom
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            {routeLine.length >= 2 && (
              <Polyline positions={routeLine} pathOptions={{ color: "#122647", weight: 3, opacity: 0.6, dashArray: "6 6" }} />
            )}
            {mapItems.map((it) => (
              <Marker key={it.id} position={[it.latitude, it.longitude]} icon={dayPin(it.dayNumber)}>
                <Popup>
                  <strong>{it.dayNumber ? `Day ${it.dayNumber}` : "Unscheduled"}</strong>
                  <br />
                  {it.description}
                </Popup>
              </Marker>
            ))}
            <FitBounds points={routeLine} />
            <MapClicks onPick={(lat, lng) => { if (selectedId != null) setItemLatLng(selectedId, lat, lng); }} />
          </MapContainer>
        </div>
      </div>
      {/* G062 — Keyboard shortcut cheat-sheet (PRD FR-3.6). Lightweight
          modal overlay; closes on Esc (handled by the global keydown
          handler above) or click on the backdrop / Close button. */}
      {shortcutHelpOpen && (
        <div
          data-testid="shortcuts-help-modal"
          onClick={() => setShortcutHelpOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 5000,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            role="dialog"
            aria-label="Keyboard shortcuts"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface-color)", color: "var(--text-primary)",
              borderRadius: 10, padding: "1.1rem 1.3rem",
              minWidth: 320, maxWidth: 460,
              boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: "0.75rem" }}>
              <Keyboard size={16} style={{ marginRight: "0.4rem", color: "var(--primary-color, var(--accent-color))" }} />
              <strong style={{ fontSize: "0.95rem" }}>Keyboard shortcuts</strong>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setShortcutHelpOpen(false)}
                style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
              >
                <X size={16} />
              </button>
            </div>
            <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
              <tbody>
                {[
                  ["Ctrl + S", "Confirm auto-save (no manual save needed)"],
                  ["Ctrl + Z", "Undo (placeholder — drag back to revert)"],
                  ["Ctrl + Y", "Redo (placeholder)"],
                  ["Esc", "Deselect item / close modal / close form"],
                  ["?", "Open this help"],
                ].map(([key, desc]) => (
                  <tr key={key}>
                    <td style={{ padding: "0.3rem 0.5rem 0.3rem 0", fontWeight: 600, whiteSpace: "nowrap" }}>
                      <kbd style={{ padding: "1px 6px", border: "1px solid var(--border-color)", borderRadius: 4, background: "var(--subtle-bg, rgba(0,0,0,0.04))", fontFamily: "monospace" }}>{key}</kbd>
                    </td>
                    <td style={{ padding: "0.3rem 0", color: "var(--text-secondary)" }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// G056 helper — inline-add mini-form rendered inside a Day card.
// For activities (kind="activity"), a PoiPicker sits above the name
// field so reps can search the approved POI catalog (FR-3.6, FR-3.7).
// Selecting a POI auto-fills the name and carries lat/lng into the
// submit payload so the map pin renders immediately. When the catalog
// has no match the PoiPicker shows "+ Add new POI" which opens the
// AddPoiModal (FR-3.7a) — the modal POSTs to /api/travel/pois and the
// suggested POI lands in pendingApproval=true state for admin review.
// Hotels keep the plain-text name input (no POI catalog for hotels).
function InlineAddForm({ day, kind, busy, onCancel, onSubmit, destinationSlug }) {
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedPoi, setSelectedPoi] = useState(null);
  const [poiAddOpen, setPoiAddOpen] = useState(false);
  const [poiAddInitialName, setPoiAddInitialName] = useState("");

  const label = kind === "hotel" ? "Hotel" : "Activity";
  const startLabel = kind === "hotel" ? "Check-in" : "Start";
  const endLabel = kind === "hotel" ? "Check-out" : "End";

  const handlePoiChange = (poi) => {
    setSelectedPoi(poi);
    if (poi) setName(poi.name || "");
  };

  const handleAddNew = (query) => {
    setPoiAddInitialName(query);
    setPoiAddOpen(true);
  };

  const handlePoiCreated = (poiName) => {
    setName(poiName);
    setPoiAddOpen(false);
  };

  return (
    <>
      <form
        data-testid={`day-${day}-inline-add-form`}
        data-kind={kind}
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await onSubmit({
            name, startTime, endTime, url, notes,
            latitude: selectedPoi?.latitude ?? null,
            longitude: selectedPoi?.longitude ?? null,
          });
          if (ok) {
            setName(""); setStartTime(""); setEndTime(""); setUrl(""); setNotes("");
            setSelectedPoi(null);
          }
        }}
        style={{
          marginTop: "0.4rem", padding: "0.6rem",
          border: "1px solid var(--border-color)", borderRadius: 6,
          background: "var(--subtle-bg, rgba(0,0,0,0.03))",
          display: "flex", flexDirection: "column", gap: "0.4rem",
        }}
      >
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: "0.75rem", color: "var(--text-primary)" }}>+ {label} · Day {day}</strong>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
          >
            <X size={13} />
          </button>
        </div>

        {/* FR-3.7 — POI catalog picker for activities. Hotel stays plain-text. */}
        {kind === "activity" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
              Pick from POI catalog (optional)
            </span>
            <PoiPicker
              value={selectedPoi}
              onChange={handlePoiChange}
              destinationSlug={destinationSlug}
              onAddNew={handleAddNew}
              placeholder="Search attractions, landmarks…"
            />
          </div>
        )}

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === "hotel" ? "Hotel name (e.g. Hilton Garden Inn)" : "Activity name (e.g. Spice plantation tour)"}
          required
          aria-label={`${label} name`}
          style={{ padding: "0.3rem 0.5rem", border: "1px solid var(--border-color)", borderRadius: 4, fontSize: "0.78rem" }}
        />
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.15rem", fontSize: "0.7rem", color: "var(--text-secondary)" }}>
            {startLabel}
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              aria-label={`${startLabel} time`}
              style={{ padding: "0.25rem 0.4rem", border: "1px solid var(--border-color)", borderRadius: 4, fontSize: "0.78rem" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.15rem", fontSize: "0.7rem", color: "var(--text-secondary)" }}>
            {endLabel}
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              aria-label={`${endLabel} time`}
              style={{ padding: "0.25rem 0.4rem", border: "1px solid var(--border-color)", borderRadius: 4, fontSize: "0.78rem" }}
            />
          </label>
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Booking URL (optional)"
          aria-label={`${label} URL`}
          style={{ padding: "0.3rem 0.5rem", border: "1px solid var(--border-color)", borderRadius: 4, fontSize: "0.78rem" }}
        />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          rows={2}
          aria-label={`${label} notes`}
          style={{ padding: "0.3rem 0.5rem", border: "1px solid var(--border-color)", borderRadius: 4, fontSize: "0.78rem", resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ padding: "0.3rem 0.7rem", border: "1px solid var(--border-color)", borderRadius: 4, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.75rem" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            data-testid={`day-${day}-inline-add-submit-${kind}`}
            style={{ padding: "0.3rem 0.8rem", border: "1px solid var(--primary-color, var(--accent-color))", borderRadius: 4, background: "var(--primary-color, var(--accent-color))", color: "#fff", cursor: busy ? "wait" : "pointer", fontSize: "0.75rem", fontWeight: 600 }}
          >
            {busy ? "Adding…" : `Add ${label}`}
          </button>
        </div>
      </form>

      {poiAddOpen && (
        <AddPoiModal
          destinationSlug={destinationSlug}
          initialName={poiAddInitialName}
          onClose={() => setPoiAddOpen(false)}
          onCreated={handlePoiCreated}
        />
      )}
    </>
  );
}

// FR-3.7a — Inline "Add new POI" modal. Operator fills name, category,
// lat/lng and optional fields; submit POSTs to POST /api/travel/pois
// which creates the row with pendingApproval=true. ADMIN then reviews
// it in the /travel/pois/pending queue. On success the activity name
// is auto-filled with the new POI's name so the operator can continue
// building the itinerary without leaving the editor.
const POI_CATEGORIES = [
  "cultural", "historical", "religious", "natural",
  "beach", "mountain", "food", "shopping", "entertainment", "museum",
];

function AddPoiModal({ destinationSlug, initialName, onClose, onCreated }) {
  const notify = useNotify();
  const [name, setName] = useState(initialName || "");
  const [locationSearch, setLocationSearch] = useState(initialName || "");
  const [nameLocal, setNameLocal] = useState("");
  const [category, setCategory] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [country, setCountry] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageUploading, setImageUploading] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  // Build a Google Maps search URL from the current locationSearch value so
  // the rep can open Maps, right-click the pin → "What's here?" and copy coords.
  const gmapsUrl = `https://maps.google.com/maps?q=${encodeURIComponent(
    locationSearch.trim() || name.trim() || destinationSlug || ""
  )}`;

  const handleLocate = async () => {
    const query = (locationSearch.trim() || name.trim());
    if (!query) { notify.error("Enter a location to search first."); return; }
    setLocating(true);
    try {
      // Try the query as typed first, then with destinationSlug appended
      // as a disambiguation hint (e.g. "ISKCON Temple" → "ISKCON Temple bangalore").
      let result = await geocode(query);
      if (!result && destinationSlug) {
        result = await geocode(`${query} ${destinationSlug.replace(/-/g, ' ')}`);
      }
      if (result) {
        setLatitude(result.lat.toFixed(6));
        setLongitude(result.lng.toFixed(6));
        notify.success("Coordinates found — verify them on the map.");
      } else {
        notify.error("Couldn't auto-locate. Use the Google Maps link below to find coordinates manually.");
      }
    } finally {
      setLocating(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!name.trim() || !category) {
      notify.error("Name and category are required.");
      return;
    }
    if (isNaN(lat) || lat < -90 || lat > 90) {
      notify.error("Latitude must be between -90 and 90.");
      return;
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      notify.error("Longitude must be between -180 and 180.");
      return;
    }
    setBusy(true);
    try {
      await fetchApi("/api/travel/pois", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          nameLocal: nameLocal.trim() || undefined,
          category,
          latitude: lat,
          longitude: lng,
          destinationSlug,
          country: country.trim() || undefined,
          imageUrl: imageUrl.trim() || undefined,
          descriptionShort: description.trim() || undefined,
        }),
      });
      notify.success(`"${name.trim()}" suggested — pending admin approval.`);
      onCreated(name.trim());
    } catch (err) {
      if (err?.body?.code === "POI_DUPLICATE_NEARBY") {
        notify.error(
          `A POI already exists ${Math.round(err.body.distance)}m away. Use that one or adjust coordinates.`,
        );
      } else {
        notify.error(err?.body?.error || "Failed to suggest POI.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add new POI"
      data-testid="add-poi-modal"
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--surface-color, #fff)",
        borderRadius: 10, padding: "1.2rem 1.4rem",
        width: "100%", maxWidth: 440,
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        display: "flex", flexDirection: "column", gap: "0.7rem",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <strong style={{ fontSize: "0.95rem" }}>Add new POI to catalog</strong>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
            <X size={16} />
          </button>
        </div>
        <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", margin: 0 }}>
          This POI will be submitted for admin approval before appearing in other reps' searches.
        </p>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {/* POI name — what gets stored in the catalog */}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="POI name * (e.g. Sandhya Aarti at ISKCON)"
            required
            aria-label="POI name"
            style={{ padding: "0.35rem 0.55rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.82rem" }}
          />
          <input
            value={nameLocal}
            onChange={(e) => setNameLocal(e.target.value)}
            placeholder="Local name (e.g. संध्या आरती)"
            aria-label="Local name"
            style={{ padding: "0.35rem 0.55rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.82rem" }}
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
            aria-label="Category"
            style={{ padding: "0.35rem 0.55rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.82rem", background: "var(--surface-color, #fff)", color: "var(--text-primary)" }}
          >
            <option value="">Category *</option>
            {POI_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
            ))}
          </select>

          {/* Coordinates section — separate search field so the POI name
              doesn't need to be geocodable (e.g. "Sandhya Aarti" won't be
              found but "ISKCON Temple Rajajinagar Bangalore" will). */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem",
            padding: "0.6rem", border: "1px solid var(--border-color)", borderRadius: 6,
            background: "var(--subtle-bg, rgba(0,0,0,0.02))" }}>
            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)" }}>
              Coordinates *
            </span>
            {/* Search location — can differ from POI name */}
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <input
                value={locationSearch}
                onChange={(e) => setLocationSearch(e.target.value)}
                placeholder="Search location (e.g. ISKCON Temple Rajajinagar Bangalore)"
                aria-label="Search location"
                style={{ flex: 1, padding: "0.32rem 0.5rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.78rem" }}
              />
              <button
                type="button"
                onClick={handleLocate}
                disabled={locating}
                style={{
                  padding: "0.32rem 0.65rem", border: "1px solid var(--border-color)",
                  borderRadius: 5, background: "var(--surface-muted, rgba(0,0,0,0.05))",
                  color: "var(--text-secondary)", cursor: locating ? "wait" : "pointer",
                  fontSize: "0.78rem", whiteSpace: "nowrap", fontWeight: 500,
                }}
              >
                {locating ? "…" : "📍 Locate"}
              </button>
            </div>
            {/* Coord fields — filled by Locate or pasted from Google Maps */}
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <input
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="Latitude"
                required
                aria-label="Latitude"
                type="number"
                step="any"
                style={{ flex: 1, padding: "0.32rem 0.5rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.78rem", background: latitude ? "var(--surface-color,#fff)" : "var(--surface-muted,rgba(0,0,0,0.03))" }}
              />
              <input
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="Longitude"
                required
                aria-label="Longitude"
                type="number"
                step="any"
                style={{ flex: 1, padding: "0.32rem 0.5rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.78rem", background: longitude ? "var(--surface-color,#fff)" : "var(--surface-muted,rgba(0,0,0,0.03))" }}
              />
            </div>
            {/* Google Maps fallback — always visible */}
            <a
              href={gmapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "0.72rem", color: "var(--primary-color, var(--accent-color, #265855))" }}
            >
              Can't locate? Open in Google Maps → right-click the pin → copy coordinates
            </a>
          </div>
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="Country code (e.g. IN)"
            aria-label="Country"
            maxLength={8}
            style={{ padding: "0.35rem 0.55rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.82rem" }}
          />
          {/* Image upload — POSTs to /api/uploads/image (S3) */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)" }}>
              Photo (optional)
            </span>
            {imageUrl ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <img
                  src={imageUrl}
                  alt="POI preview"
                  style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border-color)" }}
                />
                <button
                  type="button"
                  onClick={() => setImageUrl("")}
                  style={{ fontSize: "0.75rem", color: "var(--danger-color, #b91c1c)", background: "transparent", border: "none", cursor: "pointer", padding: "0.2rem 0.4rem" }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", cursor: imageUploading ? "wait" : "pointer", fontSize: "0.8rem", color: "var(--primary-color, var(--accent-color, #265855))", fontWeight: 500 }}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  style={{ display: "none" }}
                  disabled={imageUploading}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setImageUploading(true);
                    try {
                      const fd = new FormData();
                      fd.append("image", file);
                      const res = await fetchApi("/api/uploads/image", { method: "POST", body: fd });
                      if (res?.url) setImageUrl(res.url);
                      else notify.error("Upload succeeded but no URL returned.");
                    } catch (err) {
                      notify.error(err?.message || "Image upload failed.");
                    } finally {
                      setImageUploading(false);
                    }
                  }}
                />
                {imageUploading ? "Uploading…" : "📷 Upload photo"}
              </label>
            )}
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short description (optional)"
            rows={2}
            aria-label="Description"
            style={{ padding: "0.35rem 0.55rem", border: "1px solid var(--border-color)", borderRadius: 5, fontSize: "0.82rem", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose}
              style={{ padding: "0.35rem 0.8rem", border: "1px solid var(--border-color)", borderRadius: 5, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.8rem" }}>
              Cancel
            </button>
            <button type="submit" disabled={busy}
              style={{ padding: "0.35rem 0.9rem", border: "none", borderRadius: 5, background: "var(--primary-color, var(--accent-color))", color: "#fff", cursor: busy ? "wait" : "pointer", fontSize: "0.8rem", fontWeight: 600 }}>
              {busy ? "Submitting…" : "Suggest POI"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
