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

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  ArrowLeft, Plane, Hotel, MapPin, Briefcase, FileText, Shield,
  Train, Bus, Car, Camera, Utensils, Package, GripVertical, MapPinned,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const ITEM_ICONS = {
  flight: Plane, train: Train, bus: Bus, cab: Car, transfer: MapPin,
  hotel: Hotel, sightseeing: Camera, activity: Briefcase, meals: Utensils,
  visa: FileText, insurance: Shield, other: Package,
};

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
  const [extraDays, setExtraDays] = useState(0); // local "+ Add day" beyond derived count
  const [dragId, setDragId] = useState(null);
  const [selectedId, setSelectedId] = useState(null); // item selected for "click map to place"

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
      } catch (_e) {
        notify?.error?.("Couldn't move item — reverting.");
        load();
      }
    },
    [items, id, notify, load],
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
      } catch (_e) {
        notify?.error?.("Couldn't set location — reverting.");
        load();
      }
    },
    [id, notify, load],
  );

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
  const mapCenter = mapItems.length ? [mapItems[0].latitude, mapItems[0].longitude] : [22.5, 79];

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
        <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
          Drag items between days · {mapItems.length}/{items.length} plotted on map
        </span>
      </div>

      <div style={{ display: "flex", gap: "1rem", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
        {/* Day cards */}
        <div style={{ flex: "1 1 420px", minWidth: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {dayBuckets.map((day) => {
            const dayItems = itemsForDay(day);
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
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <strong style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
                    {day === null ? "Unscheduled" : `Day ${day}`}
                  </strong>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                    {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
                  </span>
                </div>
                {dayItems.length === 0 && (
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", padding: "0.5rem", border: "1px dashed var(--border-color)", borderRadius: 6, textAlign: "center" }}>
                    Drop items here
                  </div>
                )}
                {dayItems.map((it) => {
                  const Icon = ITEM_ICONS[it.itemType] || Package;
                  const hasGeo = typeof it.latitude === "number" && typeof it.longitude === "number";
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
                        border: selectedId === it.id ? "2px solid var(--primary-color, var(--accent-color))" : "1px solid var(--border-color)",
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
            zoom={mapItems.length ? 6 : 4}
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
    </div>
  );
}
