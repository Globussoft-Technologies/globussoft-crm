import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Search, Crosshair, X, MapPin, Layers, Loader2 } from 'lucide-react';
import { geocodeSuggest, reverseGeocode } from '../lib/geocoder';
import { useNotify } from '../utils/notify';

// Same Vite asset-pipeline fix MapPreview.jsx applies — leaflet's default
// marker icon URLs are relative paths that Vite rewrites away, so markers
// render as broken images in a production build unless the three icon URLs
// are imported explicitly and merged into L.Icon.Default.
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

/**
 * frontend/src/components/GeofencePicker.jsx
 *
 * "Search a place -> drop a pin -> drag a radius" geofence editor, replacing
 * the three bare lat/lng/radius text inputs on the wellness Locations form.
 *
 * What it gives the operator
 *   - Type "Nexus Mall Koramangala" and pick from a live suggestion list;
 *     latitude, longitude (and optionally city/state/pincode) fill in.
 *   - A map preview with a draggable pin and a red radius circle that
 *     resizes live as the range slider moves, plus a breathing pulse ring
 *     so the enforced boundary is unmissable.
 *   - Click anywhere on the map to move the pin, with a reverse-geocoded
 *     label so the admin can confirm they hit the right building.
 *   - "Use my current location" for the stand-at-the-front-desk workflow.
 *
 * Zero new dependencies
 *   leaflet + react-leaflet were already in package.json (shipped for the
 *   travel itinerary MapPreview). Tiles are key-less OpenStreetMap; place
 *   search is the key-less Photon proxy at /api/geocode. Nothing here needs
 *   a Google Maps API key or a billing account.
 *
 * Controlled component
 *   Owns no coordinate state of its own — `value` in, `onChange` out — so
 *   the parent form stays the single source of truth and submit-time
 *   validation is unchanged.
 *
 * Props
 *   value:    { latitude, longitude, geofenceRadiusM } — strings or numbers;
 *             '' / null means "no geofence configured".
 *   onChange: (patch) => void — called with a PARTIAL patch of the same
 *             shape. When a search suggestion is picked and
 *             `fillAddressFields` is true, the patch may also carry
 *             { addressLine, city, state, pincode }.
 *   defaultRadiusM:  radius applied when a point is set but no radius is
 *                    (mirrors backend DEFAULT_RADIUS_M).
 *   minRadiusM / maxRadiusM / radiusStepM: slider bounds.
 *   fillAddressFields: when true, picking a suggestion also patches the
 *                    sibling address fields. Default false.
 *   searchBbox: "minLon,minLat,maxLon,maxLat" biasing place search toward a
 *                region (defaults to India, this CRM's market). Pass null to
 *                search worldwide from the first keystroke.
 *   searchPlaceholder / height: cosmetic overrides.
 *
 * jsdom note
 *   Leaflet needs real layout (getBoundingClientRect, CSS transforms) which
 *   jsdom does not model. Tests mock react-leaflet's exports and assert on
 *   the props we pass — see GeofencePicker.test.jsx.
 */

const DEFAULT_HEIGHT = 320;
const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LEN = 3;
// Zoom used when a point exists but we cannot derive a sensible fit.
const POINT_ZOOM = 16;
// Opening view when nothing is set yet — centred on India, the only market
// this CRM currently sells into, so the first frame is not an empty ocean.
const FALLBACK_CENTER = [20.5937, 78.9629];
const FALLBACK_ZOOM = 4;

// Rough bounding box for India: "minLon,minLat,maxLon,maxLat".
//
// Why any box at all: Photon ranks purely on string similarity, with no
// country weighting worth the name (its lat/lon bias parameters barely
// reorder anything). Searching "Dr Arora Wellness Ranchi" unboxed returns a
// same-named beauty salon in Airdrie, Canada as the top hit. Upstream treats
// bbox as a HARD filter, so the search below retries WITHOUT it whenever the
// box comes back empty — an overseas clinic stays findable, it just does not
// outrank the local one.
const INDIA_BBOX = '68.1,6.5,97.4,35.7';

const BASEMAPS = {
  map: {
    label: 'Map',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  // Key-less Esri World Imagery. Attribution is mandatory under Esri's terms
  // of use; if a deployment's licence review rejects it, delete this entry
  // and the toggle disappears on its own (the control renders from the keys
  // of this object).
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  },
};

/** Coerce a form field (string | number | null | '') to a finite number or null. */
export function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True when both coordinates parse — i.e. there is something to draw. */
export function hasPoint(value) {
  return toNum(value?.latitude) !== null && toNum(value?.longitude) !== null;
}

/**
 * Map a Photon suggestion onto the address fields of the clinic form.
 * Exported for tests — this mapping is the part most likely to regress when
 * the upstream property names shift.
 */
export function addressPatchFromSuggestion(s) {
  const patch = {};
  // Prefer the street line; fall back to the POI name so "Nexus Mall" still
  // lands in the address box rather than being dropped.
  const line = s?.street || s?.name || '';
  if (line) patch.addressLine = line;
  if (s?.city) patch.city = s.city;
  if (s?.state) patch.state = s.state;
  // Indian PIN codes are exactly 6 digits and the form's own input enforces
  // that, so do not push a foreign postcode through and trip its pattern.
  if (s?.postcode && /^\d{6}$/.test(String(s.postcode))) patch.pincode = String(s.postcode);
  return patch;
}

/**
 * Keeps the leaflet viewport in sync with the pin.
 *
 * Two separate concerns, deliberately not merged:
 *   - `center` changes (new search pick / current-location capture) recentre
 *     immediately — the user just asked to go somewhere.
 *   - `radius` changes re-fit only after the slider has been still for a
 *     beat, so dragging from 50m to 1km does not fight the user with a zoom
 *     animation on every tick, yet a 1km circle still ends up in frame.
 */
function ViewportSync({ center, radius, fitKey }) {
  const map = useMap();
  const lastFitKey = useRef(null);

  useEffect(() => {
    if (!map || !center) return;
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;
    try {
      const nextZoom = Math.max(map.getZoom() ?? POINT_ZOOM, POINT_ZOOM);
      map.setView(center, nextZoom, { animate: true });
    } catch { /* leaflet throws on non-finite input — fail soft */ }
  }, [map, center, fitKey]);

  useEffect(() => {
    if (!map || !center || !radius) return undefined;
    const t = setTimeout(() => {
      try {
        // toBounds() takes the box SIDE in metres, so 2x radius is the
        // circle's diameter; the extra 20% keeps the stroke off the edge.
        map.fitBounds(L.latLng(center[0], center[1]).toBounds(radius * 2.4), {
          padding: [16, 16],
          animate: true,
        });
      } catch { /* fail soft */ }
    }, 400);
    return () => clearTimeout(t);
  }, [map, center, radius]);

  // Leaflet measures its container on mount. When the picker mounts inside a
  // form that was just toggled open, that measurement can land before the
  // grid settles, leaving grey tiles until the next resize. One deferred
  // invalidateSize is the standard fix.
  useEffect(() => {
    if (!map) return undefined;
    const t = setTimeout(() => { try { map.invalidateSize(); } catch { /* noop */ } }, 60);
    return () => clearTimeout(t);
  }, [map]);

  return null;
}

/** Click-to-place: any click on the basemap moves the pin. */
function ClickToPlace({ onPick }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function GeofencePicker({
  value,
  onChange,
  defaultRadiusM = 150,
  minRadiusM = 25,
  maxRadiusM = 1000,
  radiusStepM = 25,
  fillAddressFields = false,
  searchBbox = INDIA_BBOX,
  searchPlaceholder = 'Search a place — e.g. Nexus Mall Koramangala, Bengaluru',
  height = DEFAULT_HEIGHT,
}) {
  const notify = useNotify();

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [resolvedLabel, setResolvedLabel] = useState('');
  // Set when the exact query found nothing and we fell back to a broader
  // term, so the dropdown can say WHAT it actually searched for.
  const [relaxedTerm, setRelaxedTerm] = useState('');
  const [resolvingLabel, setResolvingLabel] = useState(false);
  const [locating, setLocating] = useState(false);
  const [basemap, setBasemap] = useState('map');

  const boxRef = useRef(null);
  // Picking a suggestion writes its label back into the search box, which is
  // a `query` change like any other — without this latch the debounced effect
  // below would re-search for the place the user just chose and pop the
  // dropdown straight back open on top of the form.
  const skipNextSearch = useRef(false);
  // Bumped on every deliberate "go here" action so ViewportSync can tell a
  // real recentre apart from a re-render that happens to carry the same
  // coordinates.
  const [fitKey, setFitKey] = useState(0);

  const lat = toNum(value?.latitude);
  const lng = toNum(value?.longitude);
  const pointSet = lat !== null && lng !== null;
  const radius = toNum(value?.geofenceRadiusM) ?? defaultRadiusM;

  const center = useMemo(() => (pointSet ? [lat, lng] : null), [pointSet, lat, lng]);

  // -- Search --------------------------------------------------------
  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      setSearching(false);
      return undefined;
    }
    const q = query.trim();
    if (q.length < MIN_QUERY_LEN) {
      setSuggestions([]);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const search = async (term) => {
        const boxed = await geocodeSuggest(term, 6, { bbox: searchBbox || undefined });
        // The box is a hard upstream filter. Empty inside it does not mean
        // the place does not exist — widen to a worldwide search rather than
        // telling the operator "no matches" for a real address abroad.
        if (boxed.length > 0 || !searchBbox) return boxed;
        return geocodeSuggest(term, 6);
      };

      let results = await search(q);
      let relaxed = '';

      // Nothing matched the phrase as typed. A clinic name is very often
      // absent from OpenStreetMap entirely, or spelled differently there —
      // "udaymentsion koramangala" finds nothing even though Koramangala is
      // perfectly mappable. Rather than dead-ending the operator, drop
      // leading words one at a time and retry: the unrecognised business
      // name is almost always first and the locality last, so the tail of
      // the phrase is the part with a real chance of resolving.
      if (results.length === 0) {
        const words = q.split(/\s+/).filter(Boolean);
        for (let i = 1; i < words.length; i++) {
          const tail = words.slice(i).join(' ');
          if (tail.length < MIN_QUERY_LEN) break;
          // Sequential on purpose: stop at the FIRST tail that resolves, so a
          // two-word query never fires four parallel requests to discard three.
          const hit = await search(tail);
          if (hit.length > 0) {
            results = hit;
            relaxed = tail;
            break;
          }
        }
      }

      if (cancelled) return;
      setSuggestions(results);
      setRelaxedTerm(relaxed);
      setActiveIndex(results.length > 0 ? 0 : -1);
      setOpen(true);
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, searchBbox]);

  // Close the dropdown on an outside click — without this it survives until
  // the next keystroke and overlaps the lat/lng fields below.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const applyPoint = useCallback((nextLat, nextLng, extra = {}) => {
    onChange({
      latitude: Number(nextLat).toFixed(6),
      longitude: Number(nextLng).toFixed(6),
      // A point with no radius would be enforced at the backend default
      // invisibly. Materialise the default so what is on screen is what
      // gets saved.
      geofenceRadiusM: toNum(value?.geofenceRadiusM) ?? defaultRadiusM,
      ...extra,
    });
    setFitKey((k) => k + 1);
  }, [onChange, value?.geofenceRadiusM, defaultRadiusM]);

  const pickSuggestion = useCallback((s) => {
    if (!s) return;
    const extra = fillAddressFields ? addressPatchFromSuggestion(s) : {};
    applyPoint(s.lat, s.lng, extra);
    setResolvedLabel(s.display_name || '');
    skipNextSearch.current = true;
    setQuery(s.display_name || '');
    setOpen(false);
    setSuggestions([]);
    setRelaxedTerm('');
  }, [applyPoint, fillAddressFields]);

  const onSearchKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      // The picker lives inside the clinic <form> — a bare Enter here would
      // submit a half-filled form instead of choosing the highlighted place.
      e.preventDefault();
      pickSuggestion(suggestions[activeIndex] ?? suggestions[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // -- Map interactions ----------------------------------------------
  const placeFromMap = useCallback(async (nextLat, nextLng) => {
    applyPoint(nextLat, nextLng);
    setResolvedLabel('');
    setResolvingLabel(true);
    const hit = await reverseGeocode(nextLat, nextLng);
    setResolvedLabel(hit?.display_name || '');
    setResolvingLabel(false);
  }, [applyPoint]);

  const useCurrentLocation = () => {
    if (!('geolocation' in navigator)) {
      notify.error('Geolocation is not supported by this browser');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        placeFromMap(pos.coords.latitude, pos.coords.longitude);
        notify.success('Coordinates captured from your current position');
        setLocating(false);
      },
      () => {
        notify.error('Could not read current location — check browser permissions');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const clearGeofence = () => {
    onChange({ latitude: '', longitude: '', geofenceRadiusM: '' });
    setResolvedLabel('');
    setQuery('');
    setSuggestions([]);
    setRelaxedTerm('');
    setOpen(false);
  };

  const tiles = BASEMAPS[basemap] || BASEMAPS.map;
  // "Food Basics, Sarjapur Road, Kormangala West, Bangalore, ..." -> the
  // first two parts, which is the building + street an operator recognises.
  const shortLabel = resolvedLabel.split(',').slice(0, 2).join(',').trim();

  return (
    <div className="geofence-picker" style={wrapStyle}>
      {/* -- Left: search + numeric controls -- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', minWidth: 0 }}>
        <div ref={boxRef} style={{ position: 'relative' }}>
          <label htmlFor="geofence-search" style={labelStyle}>Find the clinic on the map</label>
          <div style={{ position: 'relative' }}>
            <Search
              size={15}
              style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }}
            />
            <input
              id="geofence-search"
              type="text"
              autoComplete="off"
              role="combobox"
              aria-expanded={open}
              aria-controls="geofence-suggestions"
              aria-autocomplete="list"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => suggestions.length > 0 && setOpen(true)}
              onKeyDown={onSearchKeyDown}
              style={{ ...inputStyle, width: '100%', paddingLeft: '2rem', paddingRight: '2rem' }}
            />
            {searching && (
              <Loader2
                size={14}
                className="geofence-spin"
                style={{ position: 'absolute', right: 10, top: '50%', marginTop: -7, color: 'var(--text-secondary)' }}
              />
            )}
          </div>

          {open && suggestions.length > 0 && (
            <ul id="geofence-suggestions" role="listbox" style={dropdownStyle}>
              {relaxedTerm && (
                // Say plainly that these are NOT matches for what was typed.
                // Presenting a relaxed result as an exact hit is how an admin
                // ends up geofencing the wrong side of the city.
                <li
                  aria-disabled="true"
                  style={{
                    padding: '0.4rem 0.65rem',
                    fontSize: '0.72rem',
                    color: 'var(--warning-color, #f59e0b)',
                    background: 'rgba(245,158,11,0.08)',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  No exact match — showing places near “{relaxedTerm}”. Pick the
                  closest one, then drag the pin onto your building.
                </li>
              )}
              {suggestions.map((s, i) => (
                <li
                  key={`${s.lat},${s.lng},${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.5rem',
                    padding: '0.5rem 0.65rem',
                    cursor: 'pointer',
                    fontSize: '0.82rem',
                    background: i === activeIndex ? 'rgba(99,102,241,0.14)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <MapPin size={13} style={{ marginTop: 2, flexShrink: 0, color: 'var(--accent-color)' }} />
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{s.display_name}</span>
                </li>
              ))}
            </ul>
          )}
          {open && !searching && suggestions.length === 0 && query.trim().length >= MIN_QUERY_LEN && (
            <div style={{ ...dropdownStyle, padding: '0.6rem 0.65rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              Nothing found for that, even after searching the area name on its own.
              Clinic names are often missing from OpenStreetMap — try the street or
              locality instead, or just click the map to drop the pin yourself.
            </div>
          )}
        </div>

        {/* The coordinates alone tell an operator nothing about whether they
            hit the right building. Naming the point they actually landed on —
            in the same block as the numbers, not as a footnote below — is what
            makes a click-to-place verifiable. */}
        {(pointSet || resolvingLabel) && (
          <div style={{ minWidth: 0 }}>
            <label htmlFor="geofence-place" style={labelStyle}>Selected point</label>
            <div
              id="geofence-place"
              style={{
                ...inputStyle,
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.8rem',
                color: resolvedLabel ? 'var(--success-color)' : 'var(--text-secondary)',
                background: 'rgba(16,185,129,0.06)',
                borderColor: 'rgba(16,185,129,0.22)',
              }}
            >
              <MapPin size={13} style={{ flexShrink: 0 }} />
              <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
                {resolvingLabel
                  ? 'Looking up this point…'
                  : (resolvedLabel || 'Unnamed spot — coordinates below are still valid')}
              </span>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: '0.5rem' }}>
          <div style={{ minWidth: 0 }}>
            <label htmlFor="geofence-lat" style={labelStyle}>Latitude</label>
            <input
              id="geofence-lat"
              inputMode="decimal"
              placeholder="e.g. 23.344100"
              value={value?.latitude ?? ''}
              onChange={(e) => onChange({ latitude: e.target.value })}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <label htmlFor="geofence-lng" style={labelStyle}>Longitude</label>
            <input
              id="geofence-lng"
              inputMode="decimal"
              placeholder="e.g. 85.309600"
              value={value?.longitude ?? ''}
              onChange={(e) => onChange({ longitude: e.target.value })}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
            <label htmlFor="geofence-radius" style={labelStyle}>Check-in radius</label>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent-color)' }}>
              {radius} m
            </span>
          </div>
          <input
            id="geofence-radius"
            type="range"
            min={minRadiusM}
            max={maxRadiusM}
            step={radiusStepM}
            value={Math.min(Math.max(radius, minRadiusM), maxRadiusM)}
            disabled={!pointSet}
            onChange={(e) => onChange({ geofenceRadiusM: String(e.target.value) })}
            className="geofence-range"
            style={{ width: '100%', cursor: pointSet ? 'pointer' : 'not-allowed', opacity: pointSet ? 1 : 0.45 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
            <span>{minRadiusM} m</span>
            <span>{maxRadiusM} m</span>
          </div>
          {pointSet && (radius < minRadiusM || radius > maxRadiusM) && (
            // Rows saved before this picker existed had a free-text radius
            // box, so a legacy value can sit outside the slider's range. The
            // readout and the circle both show the TRUE saved value; only the
            // thumb is clamped. Say so, rather than letting the thumb quietly
            // contradict the number above it.
            <div style={{ fontSize: '0.68rem', color: 'var(--warning-color, #f59e0b)', marginTop: '0.2rem' }}>
              The saved radius ({radius} m) is outside this slider&apos;s {minRadiusM}–{maxRadiusM} m range.
              It stays as-is until you move the slider.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          <button
            type="button"
            onClick={useCurrentLocation}
            disabled={locating}
            style={ghostButtonStyle(locating)}
          >
            <Crosshair size={14} /> {locating ? 'Locating…' : 'Use my current location'}
          </button>
          {pointSet && (
            <button
              type="button"
              onClick={clearGeofence}
              style={{ ...ghostButtonStyle(false), color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' }}
            >
              <X size={14} /> Clear geofence
            </button>
          )}
        </div>

        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.45, margin: 0 }}>
          {pointSet
            ? <>Staff assigned here must be within <strong>{radius} m</strong> of the pin to clock in or out. Drag the pin — or click the map — to fine-tune it.</>
            : <>Leave this blank to skip geofencing — staff assigned here can clock in from anywhere. Search above, or click the map to drop a pin.</>}
        </p>
      </div>

      {/* -- Right: map preview -- */}
      <div style={mapShellStyle}>
        <MapContainer
          center={center || FALLBACK_CENTER}
          zoom={center ? POINT_ZOOM : FALLBACK_ZOOM}
          scrollWheelZoom
          style={{ height, width: '100%', background: 'rgba(255,255,255,0.03)' }}
        >
          <TileLayer key={basemap} attribution={tiles.attribution} url={tiles.url} />
          <ClickToPlace onPick={placeFromMap} />
          <ViewportSync center={center} radius={pointSet ? radius : null} fitKey={fitKey} />
          {pointSet && (
            <>
              {/* Solid disc — the actual enforced area, radius in metres.
                  interactive={false} matters: an interactive leaflet path
                  swallows the click, so the operator could not reposition the
                  pin anywhere INSIDE the circle — precisely where they are
                  most likely to click. The disc has no behaviour of its own,
                  so nothing is lost by letting clicks fall through to the map. */}
              <Circle
                center={center}
                radius={radius}
                interactive={false}
                pathOptions={{ color: '#ef4444', weight: 2, fillColor: '#ef4444', fillOpacity: 0.18 }}
              />
              {/* Second ring on the SAME radius, animated by CSS. Purely
                  decorative — identical radius to the disc above, so it can
                  never imply a boundary that is not enforced. */}
              <Circle
                center={center}
                radius={radius}
                interactive={false}
                pathOptions={{ className: 'geofence-pulse-ring', color: '#ef4444', weight: 3, fill: false }}
              />
              <Marker
                position={center}
                draggable
                eventHandlers={{
                  dragend: (e) => {
                    const p = e.target.getLatLng();
                    placeFromMap(p.lat, p.lng);
                  },
                }}
              >
                {shortLabel && (
                  // Permanent (not hover) — the whole point is to confirm at a
                  // glance that the pin landed on the right building. Trimmed
                  // to the first two comma-parts; the full line is in the
                  // "Selected point" field, and a 7-part address in a tooltip
                  // would cover the map it is describing.
                  <Tooltip direction="top" offset={[0, -34]} permanent>
                    {shortLabel}
                  </Tooltip>
                )}
              </Marker>
            </>
          )}
        </MapContainer>

        {Object.keys(BASEMAPS).length > 1 && (
          <div style={basemapToggleStyle}>
            <Layers size={12} style={{ opacity: 0.7 }} />
            {Object.entries(BASEMAPS).map(([key, cfg]) => (
              <button
                key={key}
                type="button"
                onClick={() => setBasemap(key)}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0.2rem 0.5rem',
                  borderRadius: 5,
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  background: basemap === key ? 'var(--primary-color, var(--accent-color))' : 'transparent',
                  color: basemap === key ? '#fff' : 'inherit',
                }}
              >
                {cfg.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const wrapStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
  gap: '1rem',
  alignItems: 'start',
};

const mapShellStyle = {
  position: 'relative',
  minWidth: 0,
  borderRadius: 12,
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.08)',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.72rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.25rem',
};

const inputStyle = {
  padding: '0.55rem 0.75rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const dropdownStyle = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  // Leaflet's own controls sit at z-index 1000; the suggestion list has to
  // clear them or it renders behind the map on narrow layouts.
  zIndex: 1200,
  margin: 0,
  padding: 0,
  listStyle: 'none',
  maxHeight: 240,
  overflowY: 'auto',
  background: 'var(--card-bg, #1b1b23)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
};

const basemapToggleStyle = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.2rem 0.35rem',
  borderRadius: 7,
  background: 'var(--card-bg, rgba(20,20,26,0.92))',
  border: '1px solid rgba(255,255,255,0.12)',
  color: 'var(--text-primary)',
};

function ghostButtonStyle(busy) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
    padding: '0.5rem 0.7rem',
    background: 'rgba(99,102,241,0.1)',
    border: '1px solid rgba(99,102,241,0.3)',
    color: 'var(--accent-color)',
    borderRadius: 8,
    cursor: busy ? 'wait' : 'pointer',
    fontSize: '0.8rem',
  };
}
