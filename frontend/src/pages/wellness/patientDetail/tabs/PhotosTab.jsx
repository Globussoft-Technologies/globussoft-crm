import { useEffect, useRef, useState } from 'react';
import { Trash2, X, ZoomIn, ZoomOut, Maximize, Minimize } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { formatDate } from '../../../utils/date';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../components/wellness/DateRangeFilter';
import { labelStyle, inputStyle } from '../shared/helpers';

// ── Photos tab — before/after upload per visit ────────────────────
export default function PhotosTab({ patient, onSaved }) {
  const notify = useNotify();
  const [visitId, setVisitId] = useState(patient.visits[0]?.id || '');
  const [kind, setKind] = useState('before');
  const [uploading, setUploading] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const visits = patient.visits || [];
  const visibleVisits = (rangeStart && rangeEnd)
    ? visits.filter((v) => {
        const ts = new Date(v.visitDate).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : visits;

  const visit = visits.find((v) => v.id === parseInt(visitId));
  const before = visit?.photosBefore ? JSON.parse(visit.photosBefore) : [];
  const after  = visit?.photosAfter  ? JSON.parse(visit.photosAfter)  : [];

  const upload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !visitId) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('photos', f);
      fd.append('kind', kind);
      const token = getAuthToken();
      const r = await fetch(`/api/wellness/visits/${visitId}/photos`, {
        method: 'POST', body: fd,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      e.target.value = '';
      onSaved();
    } catch (err) { notify.error(`Upload failed: ${err.message}`); }
    setUploading(false);
  };

  const remove = async (url, k) => {
    if (!await notify.confirm('Delete this photo?')) return;
    await fetchApi(`/api/wellness/visits/${visitId}/photos`, {
      method: 'DELETE', body: JSON.stringify({ url, kind: k }),
    });
    onSaved();
  };

  return (
    <div className="glass" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0 }}>Visit photos</h3>
        {patient.visits.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <DateRangeFilter value={filter} onChange={setFilter} label={null} />
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '0.5rem', marginBottom: '1rem', alignItems: 'end' }}>
        <div>
          <label style={labelStyle}>Visit</label>
          <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle}>
            <option value="">— select visit —</option>
            {visibleVisits.map((v) => (
              <option key={v.id} value={v.id}>
                {formatDate(v.visitDate)} — {v.service?.name || 'Consultation'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle}>
            <option value="before">Before</option>
            <option value="after">After</option>
          </select>
        </div>
        <label style={{ padding: '0.55rem 1rem', background: 'var(--accent-color)', color: '#fff', borderRadius: 8, cursor: 'pointer', display: 'inline-block' }}>
          {uploading ? 'Uploading…' : 'Upload photos'}
          <input type="file" multiple accept="image/*" onChange={upload} style={{ display: 'none' }} disabled={!visitId || uploading} />
        </label>
      </div>

      {visit && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <PhotoColumn title="Before" urls={before} onRemove={(u) => remove(u, 'before')} onView={setLightboxUrl} />
          <PhotoColumn title="After"  urls={after}  onRemove={(u) => remove(u, 'after')}  onView={setLightboxUrl} />
        </div>
      )}

      {lightboxUrl && (
        <Lightbox url={displayPhotoSrc(lightboxUrl)} onClose={() => setLightboxUrl(null)} />
      )}
    </div>
  );
}

// Photos uploaded before the /api/uploads mount landed are stored as bare
// `/uploads/...` URLs. Nginx + Vite only proxy `/api/*` to the backend, so
// the bare path falls through the SPA catch-all and the <img> renders as
// broken. Rewrite for display only — the original URL is what the DELETE
// endpoint matches against in the stored JSON array, so onRemove still
// receives the raw value.
function displayPhotoSrc(u) {
  if (typeof u !== 'string') return u;
  if (u.startsWith('/uploads/')) return `/api${u}`;
  return u;
}

function PhotoColumn({ title, urls, onRemove, onView }) {
  return (
    <div>
      <h4 style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title} ({urls.length})</h4>
      {urls.length === 0 && <div style={{ padding: '1rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No photos yet.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.5rem' }}>
        {urls.map((u) => (
          <div key={u} style={{ position: 'relative' }}>
            <img
              src={displayPhotoSrc(u)}
              alt=""
              onClick={() => onView && onView(u)}
              title="Click to view"
              style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)', cursor: onView ? 'zoom-in' : 'default' }}
            />
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(u); }}
              aria-label="Delete photo"
              style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.7)', border: 'none', color: '#fff', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Image preview overlay — no chrome around the image, close button on the
// image itself, zoom controls in a bottom pill, and a fullscreen toggle
// that uses the browser Fullscreen API on the wrapper. Backdrop click +
// ESC dismiss; clicks on the image / controls / close stay open
// (stopPropagation).
function Lightbox({ url, onClose }) {
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 5;
  const ZOOM_STEP = 0.25;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const draggingRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [url]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose();
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
      else if (e.key === '-' || e.key === '_') setZoom((z) => {
        const next = Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
      else if (e.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (wrapperRef.current?.requestFullscreen) {
        await wrapperRef.current.requestFullscreen();
      }
    } catch (_e) {
      /* swallow */
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    setZoom((z) => {
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + dir * ZOOM_STEP).toFixed(2)));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const onMouseDown = (e) => {
    if (zoom <= 1) return;
    e.preventDefault();
    draggingRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onMouseMove = (e) => {
    if (!draggingRef.current) return;
    const { startX, startY, panX, panY } = draggingRef.current;
    setPan({ x: panX + (e.clientX - startX), y: panY + (e.clientY - startY) });
  };
  const onMouseUp = () => { draggingRef.current = null; };

  return (
    <div
      onClick={onClose}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      role="dialog"
      aria-modal="true"
      aria-label="Photo preview"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: '1rem', cursor: 'zoom-out',
      }}
    >
      <div
        ref={wrapperRef}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        style={{
          position: 'relative',
          display: isFullscreen ? 'flex' : 'inline-block',
          alignItems: isFullscreen ? 'center' : undefined,
          justifyContent: isFullscreen ? 'center' : undefined,
          background: isFullscreen ? '#000' : 'transparent',
          width: isFullscreen ? '100vw' : 'auto',
          height: isFullscreen ? '100vh' : 'auto',
          overflow: 'hidden',
          cursor: zoom > 1 ? 'grab' : 'default',
          userSelect: 'none',
          lineHeight: 0,
        }}
      >
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            display: 'block',
            maxWidth: isFullscreen ? '100vw' : 'min(85vw, 1000px)',
            maxHeight: isFullscreen ? '100vh' : '80vh',
            width: isFullscreen ? '100%' : 'auto',
            height: isFullscreen ? '100%' : 'auto',
            objectFit: 'contain',
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: draggingRef.current ? 'none' : 'transform 120ms ease-out',
            pointerEvents: 'none',
          }}
        />

        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close preview"
          style={lightboxIconBtn({ top: 12, right: 12 })}
        >
          <X size={18} />
        </button>

        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', gap: '0.4rem', alignItems: 'center',
            background: 'rgba(0,0,0,0.65)', borderRadius: 999, padding: '0.35rem 0.6rem',
            border: '1px solid rgba(255,255,255,0.15)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <button
            onClick={() => setZoom((z) => {
              const next = Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2));
              if (next === 1) setPan({ x: 0, y: 0 });
              return next;
            })}
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_MIN}
            style={lightboxControlBtn(zoom <= ZOOM_MIN)}
          >
            <ZoomOut size={16} />
          </button>
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            aria-label="Reset zoom"
            title="Reset zoom (0)"
            style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '0.78rem', minWidth: 44, textAlign: 'center', fontVariantNumeric: 'tabular-nums', cursor: 'pointer', padding: 0 }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_MAX}
            style={lightboxControlBtn(zoom >= ZOOM_MAX)}
          >
            <ZoomIn size={16} />
          </button>
          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.2)', margin: '0 0.2rem' }} />
          <button
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            style={lightboxControlBtn(false)}
          >
            {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function lightboxIconBtn(pos) {
  return {
    position: 'absolute', ...pos, background: 'rgba(0,0,0,0.65)',
    border: '1px solid rgba(255,255,255,0.2)', color: '#fff', borderRadius: 999,
    width: 36, height: 36, display: 'flex', alignItems: 'center',
    justifyContent: 'center', cursor: 'pointer',
    backdropFilter: 'blur(4px)',
  };
}
function lightboxControlBtn(disabled) {
  return {
    background: 'transparent', border: 'none', color: '#fff',
    width: 28, height: 28, borderRadius: 6, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
  };
}
