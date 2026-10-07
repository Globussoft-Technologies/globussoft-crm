import { useEffect, useMemo, useState } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import { LocateFixed, RotateCcw, Search, Trash2, Undo2 } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { geocodeSuggest } from '../lib/geocoder';
import {
  calculateBoundaryAreaSqFt,
  coordinatesToText,
  parseCoordinateText,
} from '../utils/plotBoundary';

const FALLBACK_CENTER = [20.5937, 78.9629];
const FALLBACK_ZOOM = 4;

const BASEMAPS = {
  map: {
    label: 'Map',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  },
};

function ViewportSync({ positions, focus }) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const timer = setTimeout(() => {
      try { map.invalidateSize(); } catch { /* no-op */ }
      if (positions.length >= 2) {
        try { map.fitBounds(positions, { padding: [28, 28], maxZoom: 20 }); } catch { /* no-op */ }
      } else if (focus) {
        try { map.setView(focus, 19, { animate: true }); } catch { /* no-op */ }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [map, positions, focus]);

  return null;
}

function BoundaryClick({ enabled, onPoint }) {
  useMapEvents(enabled ? {
    click(event) { onPoint(event.latlng.lat, event.latlng.lng); },
  } : {});
  return null;
}

export default function PlotBoundaryMap({
  boundary = [],
  onChange,
  address = '',
  areaSqFt,
  editable = false,
  height = 360,
}) {
  const [basemap, setBasemap] = useState('satellite');
  const [coordinateText, setCoordinateText] = useState(() => coordinatesToText(boundary));
  const [coordinateError, setCoordinateError] = useState('');
  const [locating, setLocating] = useState(false);
  const [focus, setFocus] = useState(null);

  useEffect(() => { setCoordinateText(coordinatesToText(boundary)); }, [boundary]);

  const positions = useMemo(() => boundary.map((point) => [Number(point.latitude), Number(point.longitude)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)), [boundary]);
  const liveArea = areaSqFt ?? calculateBoundaryAreaSqFt(boundary);

  const setBoundary = (points) => {
    setCoordinateError('');
    onChange?.(points);
  };

  const applyCoordinates = () => {
    try {
      setBoundary(parseCoordinateText(coordinateText));
    } catch (error) {
      setCoordinateError(error.message);
    }
  };

  const locateAddress = async () => {
    if (!address.trim()) {
      setCoordinateError('Enter the plot address first.');
      return;
    }
    setLocating(true);
    setCoordinateError('');
    const results = await geocodeSuggest(address.trim(), 1);
    setLocating(false);
    if (!results.length) {
      setCoordinateError('Address could not be located. Paste GPS coordinates or find the plot manually.');
      return;
    }
    setFocus([results[0].lat, results[0].lng]);
  };

  return (
    <section aria-label={editable ? 'Plot boundary editor' : 'Highlighted plot boundary'}>
      {editable && (
        <div style={{ display: 'grid', gap: 10, marginBottom: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn-secondary" onClick={locateAddress} disabled={locating}>
              <Search size={14} /> {locating ? 'Locating…' : 'Locate address'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setBoundary(boundary.slice(0, -1))} disabled={!boundary.length}>
              <Undo2 size={14} /> Undo point
            </button>
            <button type="button" className="btn-secondary" onClick={() => setBoundary([])} disabled={!boundary.length}>
              <Trash2 size={14} /> Clear boundary
            </button>
          </div>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            Locate the address, zoom to the parcel, then click each survey corner in order. Use Satellite view for roof and plot-line detail.
          </p>
        </div>
      )}

      <div style={{ position: 'relative', height, border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
        <MapContainer center={positions[0] || focus || FALLBACK_CENTER} zoom={positions.length ? 19 : FALLBACK_ZOOM} style={{ width: '100%', height: '100%' }}>
          <TileLayer key={basemap} url={BASEMAPS[basemap].url} attribution={BASEMAPS[basemap].attribution} />
          <ViewportSync positions={positions} focus={focus} />
          <BoundaryClick enabled={editable} onPoint={(latitude, longitude) => setBoundary([...boundary, { latitude, longitude }])} />
          {positions.length >= 3 ? (
            <Polygon positions={positions} pathOptions={{ color: '#0f766e', fillColor: '#14b8a6', fillOpacity: 0.35, weight: 3 }}>
              {liveArea && <Tooltip permanent direction="center">{Math.round(liveArea).toLocaleString()} sq ft</Tooltip>}
            </Polygon>
          ) : positions.length >= 2 ? (
            <Polyline positions={positions} pathOptions={{ color: '#0f766e', weight: 3, dashArray: '7 6' }} />
          ) : null}
          {positions.map((position, index) => (
            <CircleMarker key={`${position[0]}-${position[1]}-${index}`} center={position} radius={5} pathOptions={{ color: '#fff', fillColor: '#0f766e', fillOpacity: 1, weight: 2 }}>
              <Tooltip>{`Corner ${index + 1}`}</Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
        <div style={{ position: 'absolute', zIndex: 500, top: 10, right: 10, display: 'flex', gap: 4, padding: 4, borderRadius: 8, background: 'var(--popover-bg, #fff)', boxShadow: '0 2px 10px rgba(15,23,42,.2)' }}>
          {Object.entries(BASEMAPS).map(([key, layer]) => (
            <button key={key} type="button" onClick={() => setBasemap(key)} aria-pressed={basemap === key} className={basemap === key ? 'btn-primary' : 'btn-secondary'} style={{ padding: '0.3rem 0.5rem', fontSize: '0.72rem' }}>{layer.label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <strong style={{ color: 'var(--primary-color, var(--accent-color))' }}>
          {liveArea ? `Mapped area: ${Math.round(liveArea).toLocaleString()} sq ft` : `${boundary.length} boundary point${boundary.length === 1 ? '' : 's'}`}
        </strong>
        {editable && boundary.length > 0 && boundary.length < 3 && <span style={{ color: '#b45309', fontSize: '0.8rem' }}>Add {3 - boundary.length} more point{3 - boundary.length === 1 ? '' : 's'} to close the area.</span>}
      </div>

      {editable && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem' }}><LocateFixed size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />Paste GPS coordinates</summary>
          <label style={{ display: 'block', marginTop: 8, color: 'var(--text-secondary)', fontSize: '0.78rem', fontWeight: 700 }}>
            One latitude, longitude pair per line
            <textarea className="input-field" rows="5" value={coordinateText} onChange={(event) => setCoordinateText(event.target.value)} placeholder={'12.9351234, 77.6101234\n12.9351234, 77.6102345\n12.9352345, 77.6102345'} style={{ width: '100%', marginTop: 5, boxSizing: 'border-box', fontFamily: 'monospace' }} />
          </label>
          <button type="button" className="btn-secondary" onClick={applyCoordinates} style={{ marginTop: 8 }}><RotateCcw size={14} /> Apply coordinates</button>
        </details>
      )}
      {coordinateError && <div role="alert" style={{ marginTop: 8, color: '#b91c1c', fontSize: '0.8rem' }}>{coordinateError}</div>}
    </section>
  );
}
