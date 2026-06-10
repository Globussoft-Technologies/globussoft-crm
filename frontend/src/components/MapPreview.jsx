import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * frontend/src/components/MapPreview.jsx
 *
 * Per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.4 — Leaflet+OSM map preview
 * for ItineraryItems with lat/lng. Renders one marker per item with a
 * day-coloured popup showing "Day N: locationName".
 *
 * Props
 *   - items: Array<{ id, latitude, longitude, locationName, dayNumber, sortOrder }>
 *     Items without finite lat/lng are silently skipped (caller may still
 *     have draft rows without coordinates).
 *   - height: number | string — CSS height; default 400.
 *   - onMarkerClick(item): optional click handler fired with the item object.
 *   - centerLat / centerLng / zoom: optional manual override. If omitted,
 *     the map auto-fits the bounding box of all items' coordinates.
 *
 * Why
 *   Itineraries.jsx + ItineraryDetail.jsx + ItineraryDayEditor.jsx all
 *   need a shared "show me where this trip goes" surface. Shipping one
 *   reusable component avoids the three-page divergence we saw with the
 *   trip-billing currency renderers.
 *
 * Free + key-less
 *   No API key. Tiles come from the public OSM tile server (requires the
 *   "© OpenStreetMap contributors" attribution, embedded below). Geocoding
 *   lives in ../lib/geocoder.js — the caller is responsible for resolving
 *   text → lat/lng before passing items in.
 *
 * jsdom note
 *   Leaflet's DOM manipulation requires a real browser (it uses
 *   `getBoundingClientRect` + transforms that jsdom doesn't model). Tests
 *   mock react-leaflet's exports — see MapPreview.test.jsx.
 */

// Distinct palette rotated by dayNumber. Picked from a colour-blind-safe
// palette (Wong 2011) so the markers stay distinguishable on print + for
// reps with colour-vision deficiency.
const DAY_COLOR_PALETTE = [
  '#0072B2', // blue       — day 1
  '#E69F00', // orange     — day 2
  '#009E73', // bluish-green — day 3
  '#CC79A7', // reddish-purple — day 4
  '#D55E00', // vermilion  — day 5
  '#56B4E9', // sky blue   — day 6
  '#F0E442', // yellow     — day 7
  '#999999', // grey       — day 8+
];

const DEFAULT_CENTER = [0, 0]; // world view fallback when no items
const DEFAULT_ZOOM = 1;
const FALLBACK_ITEM_ZOOM = 12;

export function colorForDay(dayNumber) {
  const d = Number(dayNumber);
  if (!Number.isFinite(d) || d < 1) return DAY_COLOR_PALETTE[0];
  return DAY_COLOR_PALETTE[(Math.floor(d) - 1) % DAY_COLOR_PALETTE.length];
}

/**
 * Filter items down to those with finite lat/lng pairs that we can
 * actually pin on the map. Strips draft rows from the editor.
 */
export function pinnableItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((it) => {
    if (!it) return false;
    // Number(null) === 0 (finite!) — so explicitly reject null/undefined/''
    // BEFORE coercing. A draft row from the editor sends latitude:null
    // which would otherwise pin to the equator.
    if (it.latitude === null || it.latitude === undefined || it.latitude === '') return false;
    if (it.longitude === null || it.longitude === undefined || it.longitude === '') return false;
    const lat = Number(it.latitude);
    const lng = Number(it.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng);
  });
}

/**
 * Compute the bounding box for a list of pinnable items.
 * Returns null when there are no items (caller falls back to DEFAULT_CENTER).
 */
export function computeBounds(items) {
  const pins = pinnableItems(items);
  if (pins.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const it of pins) {
    const lat = Number(it.latitude);
    const lng = Number(it.longitude);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return [[minLat, minLng], [maxLat, maxLng]];
}

// Inner helper — uses the leaflet map instance to fit bounds whenever the
// items prop changes. Runs as a child of MapContainer so it has access
// to the map via useMap().
function FitBounds({ bounds }) {
  const map = useMap();
  React.useEffect(() => {
    if (!map || !bounds) return;
    try {
      // Single-pin case: don't try to fitBounds on a degenerate box;
      // setView with a sensible zoom looks better.
      const [[s, w], [n, e]] = bounds;
      if (s === n && w === e) {
        map.setView([s, w], FALLBACK_ITEM_ZOOM);
      } else {
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    } catch (err) {
      // Leaflet throws if bounds are invalid (e.g. NaN). Fail-soft.
      console.warn('[MapPreview] fitBounds failed:', err?.message || err);
    }
  }, [map, bounds]);
  return null;
}

export default function MapPreview({
  items,
  height = 400,
  onMarkerClick,
  centerLat,
  centerLng,
  zoom,
}) {
  const pins = useMemo(() => pinnableItems(items), [items]);
  const bounds = useMemo(() => computeBounds(items), [items]);

  // Manual centre overrides bbox auto-fit. If neither provided, use a
  // bbox fit (when we have pins) or fall back to a world view.
  const hasManualCenter =
    Number.isFinite(Number(centerLat)) && Number.isFinite(Number(centerLng));
  const initialCenter = hasManualCenter
    ? [Number(centerLat), Number(centerLng)]
    : DEFAULT_CENTER;
  const initialZoom = Number.isFinite(Number(zoom))
    ? Number(zoom)
    : DEFAULT_ZOOM;

  // When user supplies manual centre we suppress auto-fit; otherwise
  // FitBounds runs on every items change.
  const autoFitBounds = !hasManualCenter ? bounds : null;

  return (
    <div
      data-testid="map-preview"
      data-pin-count={pins.length}
      className="map-preview"
      style={{ width: '100%', height, position: 'relative' }}
    >
      <MapContainer
        center={initialCenter}
        zoom={initialZoom}
        scrollWheelZoom={true}
        style={{ width: '100%', height: '100%' }}
        data-testid="map-container"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          data-testid="tile-layer"
        />
        {autoFitBounds ? <FitBounds bounds={autoFitBounds} /> : null}
        {pins.map((it) => {
          const day = Number(it.dayNumber) || 1;
          const color = colorForDay(day);
          return (
            <Marker
              key={it.id}
              position={[Number(it.latitude), Number(it.longitude)]}
              data-testid={`marker-${it.id}`}
              data-day-color={color}
              eventHandlers={{
                click: () => {
                  if (typeof onMarkerClick === 'function') onMarkerClick(it);
                },
              }}
            >
              <Popup data-testid={`popup-${it.id}`}>
                <div style={{ fontWeight: 600, color }}>
                  {`Day ${day}: ${it.locationName || ''}`}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
      {/* Explicit attribution text — tile-layer attribution is the canonical
          OSM-required line, but we also render a visible label so the
          requirement is impossible to miss in screenshots / print exports.
          S83: gained a stable className `map-preview__attribution` so
          print.css's @media print rules can force position:static +
          visibility:visible regardless of how the print engine handles
          absolute-positioned overlays. The inline style is the
          screen-mode contract; print.css overrides it via !important
          inside @media print only. */}
      <div
        data-testid="map-attribution"
        className="map-preview__attribution"
        style={{
          position: 'absolute',
          bottom: 4,
          right: 4,
          fontSize: 10,
          background: 'rgba(255, 255, 255, 0.8)',
          padding: '2px 6px',
          borderRadius: 3,
          color: '#333',
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      >
        <span>© OpenStreetMap contributors</span>
      </div>
    </div>
  );
}
