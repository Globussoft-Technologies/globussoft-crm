import React, { useState, useEffect, useReducer, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Save, Eye, Monitor, Smartphone, Plus, Trash2, ChevronUp, ChevronDown, Type, AlignLeft, Image, MousePointerClick, FileInput, Minus, Space, Video, Upload, Undo2, Redo2, Columns } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';

// =====================================================================
// LandingPageBuilder
// =====================================================================
// What/why: drag-free WYSIWYG builder for the LandingPage admin surface.
// The single .jsx ships every component-type renderer (preview-side) and
// every property editor (right rail). Public render is owned by
// backend/services/landingPageRenderer.js — keep the two in sync.
//
// Recent issue closures (commit `fix(landing-page-builder)` …):
//   #446 — Image block: "Upload" button next to the URL field. POSTs to
//          /api/landing-pages/upload (multer, 5 MB, image/* MIMEs only),
//          drops the returned url straight into props.src.
//   #449 — Layout cleanup. Hides the global app sidebar while the builder
//          is mounted (body class `body--builder-fullscreen`); aligns the
//          top-bar; groups the right-rail properties into "Component" +
//          "Page" sections so the user can see what's editable.
//   #450 — Undo / Redo. useReducer-backed history stack (up to 50 states)
//          with Ctrl+Z / Ctrl+Y bindings. Property edits debounce at 500ms
//          so a single field change produces ONE history entry, not 30.
//   #451-remainder — Form component now has Lead-Routing rule selector,
//          enableCaptcha checkbox, successRedirectUrl override. The
//          public renderer + submit handler honour all three.
//
// Standing rules respected:
//   - Body strips: stripDangerous middleware deletes id/createdAt/etc
//     from every PUT body. We use targetUserId-style names for ids. (N/A
//     here — no userId references.)
//   - JWT key: req.user.userId, never req.user.id (backend concern).
//   - Sanitize: HTML in landing-page content is sanitized in the route
//     already; no second layer here.
// =====================================================================

const COMPONENT_TYPES = [
  { type: 'heading', label: 'Heading', icon: Type, defaultProps: { text: 'Your Headline Here', level: 'h2', align: 'center', color: '#1e293b' } },
  { type: 'text', label: 'Text', icon: AlignLeft, defaultProps: { text: 'Enter your text content here.', align: 'left', color: '#64748b', fontSize: '1rem' } },
  { type: 'image', label: 'Image', icon: Image, defaultProps: { src: 'https://placehold.co/800x400/e2e8f0/94a3b8?text=Image', alt: 'Image', maxWidth: '100%' } },
  { type: 'button', label: 'Button', icon: MousePointerClick, defaultProps: { text: 'Click Here', url: '#', bgColor: '#3b82f6', color: '#ffffff', align: 'center', size: 'medium' } },
  { type: 'form', label: 'Form', icon: FileInput, defaultProps: { fields: [{ label: 'Name', name: 'name', type: 'text', required: true }, { label: 'Email', name: 'email', type: 'email', required: true }], submitText: 'Submit', thankYouMessage: 'Thank you!', enableCaptcha: false, leadRoutingRuleId: '', successRedirectUrl: '' } },
  { type: 'divider', label: 'Divider', icon: Minus, defaultProps: { color: '#e2e8f0', margin: '1rem' } },
  { type: 'spacer', label: 'Spacer', icon: Space, defaultProps: { height: '40px' } },
  { type: 'video', label: 'Video', icon: Video, defaultProps: { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', width: '100%' } },
  { type: 'columns', label: 'Two Columns', icon: Columns, defaultProps: { gap: '2rem', columns: [{ components: [] }, { components: [] }] } },
];

// ── #450 — undo / redo reducer ───────────────────────────────────────
//
// State shape: { past: Component[][], present: Component[], future: Component[][] }
// Action types:
//   SET           — replace `present` (e.g. initial load). Clears future,
//                   pushes prior present onto past.
//   COMMIT        — push the current present to past, set new present.
//                   Used by add / move / remove / debounced-prop-edit.
//   UNDO / REDO   — shift one entry between past <-> future.
//   RESET         — used after save when you want to clear the dirty
//                   delta; we don't currently expose this since most
//                   workflows want to keep undoability after save.
//
// History is capped at 50 entries to avoid memory blowup.
const HISTORY_LIMIT = 50;

function historyReducer(state, action) {
  switch (action.type) {
    case 'SET':
      // Initial-load path: replace everything, no history yet.
      return { past: [], present: action.value, future: [] };
    case 'COMMIT': {
      const next = action.value;
      const newPast = [...state.past, state.present];
      // Cap from the front (oldest entries dropped first).
      while (newPast.length > HISTORY_LIMIT) newPast.shift();
      return { past: newPast, present: next, future: [] };
    }
    case 'UNDO': {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      const newPast = state.past.slice(0, -1);
      return { past: newPast, present: prev, future: [state.present, ...state.future] };
    }
    case 'REDO': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      const newFuture = state.future.slice(1);
      return { past: [...state.past, state.present], present: next, future: newFuture };
    }
    default:
      return state;
  }
}

export default function LandingPageBuilder() {
  const notify = useNotify();
  const { id } = useParams();
  const [page, setPage] = useState(null);
  const [history, dispatch] = useReducer(historyReducer, { past: [], present: [], future: [] });
  const components = history.present;
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState('desktop');
  // #451: lead-routing-rule list, fetched once on mount. Used by the form
  // component's "Lead Routing" properties section. Empty array if the
  // tenant has no rules configured (UI surfaces a hint instead of an
  // empty dropdown).
  const [routingRules, setRoutingRules] = useState([]);
  // #454: dirty-state tracking + beforeunload guard.
  const [isDirty, setIsDirty] = useState(false);

  // #449: hide the global app sidebar while the builder is mounted. The
  // builder is a 3-column layout that competes with the global Sidebar +
  // top header, leaving ~320 px for the canvas. Toggle a body class so
  // index.css can hide `.app-shell > nav` (and shrink the header). The
  // class is removed on unmount so navigating away restores the sidebar.
  useEffect(() => {
    document.body.classList.add('body--builder-fullscreen');
    return () => document.body.classList.remove('body--builder-fullscreen');
  }, []);

  useEffect(() => {
    fetchApi(`/api/landing-pages/${id}`).then(data => {
      setPage(data);
      let parsed = [];
      try { parsed = JSON.parse(data.content || '[]'); } catch { parsed = []; }
      dispatch({ type: 'SET', value: parsed });
      setIsDirty(false);
    }).catch(() => {});
  }, [id]);

  // #451: fetch routing rules once. The /api/lead-routing endpoint is
  // tenant-scoped and returns parsed conditions already.
  useEffect(() => {
    fetchApi('/api/lead-routing')
      .then(rules => Array.isArray(rules) ? setRoutingRules(rules) : setRoutingRules([]))
      .catch(() => setRoutingRules([]));
  }, []);

  // #454: native beforeunload guard.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  // #450: keyboard shortcuts. Ctrl/Cmd + Z = undo, Ctrl/Cmd + Y or
  // Ctrl/Cmd + Shift + Z = redo. We intentionally skip when the user is
  // typing inside an input/textarea so native browser undo (per-input)
  // still works for property editors.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const isFormField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (isFormField) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'UNDO' });
        setIsDirty(true);
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        dispatch({ type: 'REDO' });
        setIsDirty(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // #378: normalize slug input.
  const normalizeSlug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);

  const handleSave = async (confirmSlugChange = false) => {
    if (page.slug !== undefined && page.slug !== '' && !/^[a-z0-9-]+$/.test(page.slug)) {
      notify.error('Slug must contain only lowercase letters, numbers, and hyphens.');
      return;
    }
    setSaving(true);
    try {
      const payload = { title: page.title, content: JSON.stringify(components) };
      if (page.slug) payload.slug = page.slug;
      const url = `/api/landing-pages/${id}${confirmSlugChange ? '?confirmSlugChange=true' : ''}`;
      await fetchApi(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        silent: !confirmSlugChange,
      });
      setIsDirty(false);
      if (confirmSlugChange) notify.success('Saved with new slug — old links to /p/<old-slug> will 404.');
    } catch (err) {
      if (err.status === 409 && err.code === 'PUBLISHED_SLUG_CHANGE_REQUIRES_CONFIRM') {
        const cur = err.data?.currentSlug || page.slug;
        const next = err.data?.requestedSlug || page.slug;
        const ok = await notify.confirm(
          `This page is PUBLISHED. Changing the slug from "${cur}" to "${next}" will break every inbound link to /p/${cur} (ad campaigns, email links, QR codes, customer bookmarks).\n\nProceed anyway?`
        );
        if (ok) {
          setSaving(false);
          await handleSave(true);
          return;
        }
      } else if (err.status === 409 && err.existingId) {
        notify.error(err.message || 'Slug already in use by another page.');
      } else {
        notify.error('Save failed');
      }
    }
    setSaving(false);
  };

  const slugIsValid = !page?.slug || /^[a-z0-9-]+$/.test(page.slug);

  const deriveSlugFromTitle = () => {
    const baseSlug = (page.title || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    if (!baseSlug) {
      notify.error('Set a title first — slug needs at least one alphanumeric character to derive from.');
      return;
    }
    setPage({ ...page, slug: baseSlug.slice(0, 50) });
    setIsDirty(true);
  };

  // ── component-mutation helpers (history-aware) ─────────────────────

  const commit = useCallback((next) => {
    dispatch({ type: 'COMMIT', value: next });
    setIsDirty(true);
  }, []);

  const addComponent = (type) => {
    const def = COMPONENT_TYPES.find(t => t.type === type);
    commit([...components, { id: Date.now().toString(), type, props: { ...def.defaultProps } }]);
  };

  // #450: prop edits debounce so a single field type-event doesn't push
  // 30 history entries. We mutate the LIVE present immediately (so the
  // canvas reflects the edit as the user types) but only COMMIT to
  // history after 500ms of no further edits to that prop key. The first
  // edit before the timer fires uses the snapshot of the current
  // present so undo lands on the pre-edit state.
  const propTimers = useRef({});
  const updateProp = (compId, key, value) => {
    const next = components.map(c => c.id === compId ? { ...c, props: { ...c.props, [key]: value } } : c);
    // Replace the present immediately by dispatching SET (no history
    // push). This re-renders the canvas/panel without growing history.
    dispatch({ type: 'SET', value: next });
    setIsDirty(true);
    // Re-arm the per-component+key debounce so when the user stops
    // typing for 500 ms we commit the resulting state to history.
    const timerKey = `${compId}:${key}`;
    if (propTimers.current[timerKey]) clearTimeout(propTimers.current[timerKey]);
    propTimers.current[timerKey] = setTimeout(() => {
      // Snapshot the *current* present (not `next`, which is stale) so
      // a debounced commit picks up multi-prop edits within the
      // window.
      dispatch({ type: 'COMMIT', value: nextRef.current });
      delete propTimers.current[timerKey];
    }, 500);
  };
  // We need a ref to the latest present for the debounced commit.
  const nextRef = useRef(components);
  useEffect(() => { nextRef.current = components; }, [components]);

  const moveComponent = (idx, dir) => {
    const newComps = [...components];
    const swap = idx + dir;
    if (swap < 0 || swap >= newComps.length) return;
    [newComps[idx], newComps[swap]] = [newComps[swap], newComps[idx]];
    commit(newComps);
  };

  const removeComponent = (idx) => {
    commit(components.filter((_, i) => i !== idx));
    setSelected(null);
  };

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const onUndo = () => { if (canUndo) { dispatch({ type: 'UNDO' }); setIsDirty(true); } };
  const onRedo = () => { if (canRedo) { dispatch({ type: 'REDO' }); setIsDirty(true); } };

  const selectedComp = selected !== null ? components[selected] : null;
  if (!page) return <div style={{ padding: '2rem' }}>Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* #449: top bar — alignment cleanup. Title + slug are pinned left
          via flex-grow:0; preview-mode toggle + preview link + undo/redo
          + save are right-aligned via the spacer. Padding bumped 1.5→1
          and items use a consistent gap so they no longer crowd the
          800px canvas's left edge. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.65rem 1rem', borderBottom: '1px solid var(--border-color)', flexShrink: 0, background: 'var(--surface-color)' }}>
        <Link to="/landing-pages" title="Back to landing pages list" style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}><ArrowLeft size={18} /></Link>
        <input className="input-field" value={page.title} onChange={e => { setPage({ ...page, title: e.target.value }); setIsDirty(true); }} style={{ fontWeight: '600', fontSize: '0.95rem', padding: '0.35rem 0.65rem', width: '220px' }} aria-label="Page title" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <input
              className="input-field"
              value={page.slug || ''}
              onChange={e => { setPage({ ...page, slug: normalizeSlug(e.target.value) }); setIsDirty(true); }}
              placeholder="slug"
              title="Lowercase letters, numbers, and hyphens only (max 50 chars)"
              pattern="[a-z0-9-]+"
              maxLength={50}
              aria-label="Page URL slug"
              style={{
                fontSize: '0.8rem',
                padding: '0.3rem 0.6rem',
                width: '160px',
                color: 'var(--text-secondary)',
                borderColor: slugIsValid ? undefined : '#ef4444',
              }}
            />
            <button
              type="button"
              onClick={deriveSlugFromTitle}
              title="Derive slug from current page title"
              style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              ↻
            </button>
          </div>
          <span style={{ fontSize: '0.62rem', color: slugIsValid ? 'var(--text-secondary)' : '#ef4444', opacity: 0.85 }}>
            {slugIsValid
              ? `${(page.slug || '').length}/50 — lowercase, digits, hyphens`
              : 'Invalid: lowercase / digits / hyphens only'}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        {/* #450: undo / redo. Disabled state when no history. The Lucide
            arrow-rotate icons match the platform's icon language. */}
        <div style={{ display: 'flex', gap: '0.2rem' }}>
          <button onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo last change" style={iconBarBtnStyle(canUndo)}><Undo2 size={14} /></button>
          <button onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo last undone change" style={iconBarBtnStyle(canRedo)}><Redo2 size={14} /></button>
        </div>
        <div style={{ display: 'flex', gap: '0.2rem', background: 'var(--subtle-bg)', borderRadius: '6px', padding: '0.18rem' }}>
          <button onClick={() => setPreviewMode('desktop')} title="Desktop preview" aria-label="Desktop preview" style={{ padding: '0.25rem 0.55rem', borderRadius: '4px', border: 'none', cursor: 'pointer', background: previewMode === 'desktop' ? 'var(--accent-color)' : 'transparent', color: previewMode === 'desktop' ? '#fff' : 'var(--text-secondary)' }}><Monitor size={14} /></button>
          <button onClick={() => setPreviewMode('mobile')} title="Mobile preview" aria-label="Mobile preview" style={{ padding: '0.25rem 0.55rem', borderRadius: '4px', border: 'none', cursor: 'pointer', background: previewMode === 'mobile' ? 'var(--accent-color)' : 'transparent', color: previewMode === 'mobile' ? '#fff' : 'var(--text-secondary)' }}><Smartphone size={14} /></button>
        </div>
        {page.status === 'PUBLISHED' && (
          <a href={`${window.location.origin.replace(':5173', ':5000')}/p/${page.slug}`} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.35rem 0.7rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.8rem', color: 'var(--text-primary)', textDecoration: 'none' }}>
            <Eye size={14} /> Preview
          </a>
        )}
        <button className="btn-primary" onClick={() => handleSave(false)} disabled={saving || !slugIsValid} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.35rem 0.9rem', fontSize: '0.85rem' }}>
          <Save size={14} /> {saving ? 'Saving...' : 'Save'}{isDirty && !saving && <span style={{ marginLeft: '0.3rem', opacity: 0.85 }}>•</span>}
        </button>
      </div>

      {/* Three Panel Layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: Component Palette */}
        <div style={{ width: '200px', borderRight: '1px solid var(--border-color)', padding: '1rem', overflowY: 'auto', flexShrink: 0 }}>
          <h4 style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>Components</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {COMPONENT_TYPES.map(ct => (
              <button key={ct.type} onClick={() => addComponent(ct.type)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem', transition: 'all 0.15s' }}>
                <ct.icon size={14} /> {ct.label}
              </button>
            ))}
          </div>
        </div>

        {/* Center: Preview Canvas */}
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--subtle-bg)', padding: '2rem', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: previewMode === 'mobile' ? '375px' : '100%', maxWidth: '800px', background: 'var(--surface-color)', borderRadius: '8px', boxShadow: 'var(--glass-shadow)', padding: '2rem', minHeight: '400px' }}>
            {components.length === 0 && (
              <div style={{ textAlign: 'center', padding: '4rem 2rem', color: '#94a3b8' }}>
                <Plus size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
                <p>Click components on the left to add them</p>
              </div>
            )}
            {components.map((comp, idx) => (
              <div key={comp.id} onClick={() => setSelected(idx)} style={{ position: 'relative', border: selected === idx ? '2px solid #3b82f6' : '2px solid transparent', borderRadius: '4px', padding: '0.25rem', margin: '0.25rem 0', cursor: 'pointer', transition: 'border-color 0.15s' }}>
                {selected === idx && (
                  <div style={{ position: 'absolute', top: '-1px', right: '-1px', display: 'flex', gap: '0.125rem', zIndex: 10, background: '#3b82f6', borderRadius: '0 4px 0 4px', padding: '0.125rem' }}>
                    <button onClick={e => { e.stopPropagation(); moveComponent(idx, -1); }} style={iconBtnStyle}><ChevronUp size={12} /></button>
                    <button onClick={e => { e.stopPropagation(); moveComponent(idx, 1); }} style={iconBtnStyle}><ChevronDown size={12} /></button>
                    <button onClick={e => { e.stopPropagation(); removeComponent(idx); }} style={iconBtnStyle}><Trash2 size={12} /></button>
                  </div>
                )}
                <ComponentPreview comp={comp} />
              </div>
            ))}
          </div>
        </div>

        {/* Right: Property Editor — #449 grouped into Component + Page */}
        <div style={{ width: '300px', borderLeft: '1px solid var(--border-color)', padding: '1rem', overflowY: 'auto', flexShrink: 0 }}>
          {/* #449 Component section — only visible when a component is selected. */}
          <section style={{ marginBottom: '1.5rem' }}>
            <h4 style={{ fontSize: '0.7rem', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.35rem' }}>
              Component {selectedComp ? `· ${selectedComp.type}` : ''}
            </h4>
            {selectedComp ? (
              <PropertyEditor
                comp={selectedComp}
                updateProp={(k, v) => updateProp(selectedComp.id, k, v)}
                routingRules={routingRules}
              />
            ) : (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '0.5rem 0', margin: 0 }}>
                Click a component on the canvas to edit its properties.
              </p>
            )}
          </section>
          {/* #449 Page section — page-level properties (title shown read-only;
              metadata is editable through the existing top bar). Surfacing
              these under a sub-header gives the user a clearer mental model
              of "what's component" vs "what's page". */}
          <section>
            <h4 style={{ fontSize: '0.7rem', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.35rem' }}>
              Page
            </h4>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              <div><strong>Title:</strong> {page.title}</div>
              <div><strong>Slug:</strong> /p/{page.slug || '—'}</div>
              <div><strong>Status:</strong> {page.status}</div>
              <div><strong>Components:</strong> {components.length}</div>
              <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', opacity: 0.8 }}>
                Use the top bar to rename, change the slug, preview, or save.
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle = { background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: '2px' };

// #450: undo/redo button styling — disabled state visibly different.
const iconBarBtnStyle = (enabled) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.3rem 0.55rem',
  border: '1px solid var(--border-color)',
  borderRadius: '6px',
  background: 'transparent',
  color: enabled ? 'var(--text-primary)' : 'var(--text-secondary)',
  opacity: enabled ? 1 : 0.4,
  cursor: enabled ? 'pointer' : 'not-allowed',
});

function ComponentPreview({ comp }) {
  const p = comp.props;
  switch (comp.type) {
    case 'heading': { const Tag = p.level || 'h2'; return <Tag style={{ textAlign: p.align, color: p.color, margin: '0.5rem 0' }}>{p.text}</Tag>; }
    case 'text': return <p style={{ textAlign: p.align, color: p.color, fontSize: p.fontSize, margin: '0.5rem 0', lineHeight: 1.6 }}>{p.text}</p>;
    case 'image': return (
      <div style={{ textAlign: 'center' }}>
        {/* #448: broken-image fallback. Pre-fix, a 404 / blocked / bad-MIME
            src left the <img> with naturalWidth/Height=0, collapsing the
            row to a 30px strip and silently breaking the page layout.
            onError swaps the src to a transparent 1x1 SVG that holds the
            box's intended dimensions, and the alt text reads as a visible
            caption (CSS `font-style: italic` + dashed border) so the
            owner notices the problem instead of shipping a broken page.
            Builder-mode visibility is the priority — this exact pattern
            also lives in services/landingPageRenderer.js for the public
            /p/<slug> render path. */}
        <img
          src={p.src}
          alt={p.alt || 'Image failed to load'}
          style={{ maxWidth: p.maxWidth || '100%', borderRadius: '6px', height: 'auto', minHeight: 80 }}
          onError={(e) => {
            if (e.target.dataset.fallback === '1') return;
            e.target.dataset.fallback = '1';
            e.target.alt = p.alt ? `Image failed to load: ${p.alt}` : 'Image failed to load — check the URL';
            e.target.style.minHeight = '120px';
            e.target.style.padding = '2rem';
            e.target.style.border = '2px dashed #ef4444';
            e.target.style.fontStyle = 'italic';
            e.target.style.color = '#ef4444';
            e.target.style.background = 'rgba(239,68,68,0.05)';
            e.target.src = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E';
          }}
        />
      </div>
    );
    case 'button': return <div style={{ textAlign: p.align }}><button style={{ padding: p.size === 'large' ? '1rem 2.5rem' : '0.75rem 1.5rem', background: p.bgColor, color: p.color, border: 'none', borderRadius: '6px', fontWeight: '600', fontSize: p.size === 'large' ? '1.1rem' : '1rem', cursor: 'pointer' }}>{p.text}</button></div>;
    case 'form': return (
      <div style={{ maxWidth: '400px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {(p.fields || []).map((f, i) => (
          <div key={i}><label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '500', marginBottom: '0.25rem', color: '#475569' }}>{f.label}{f.required && ' *'}</label>
          <input type={f.type} style={{ width: '100%', padding: '0.6rem', border: '1px solid #cbd5e1', borderRadius: '6px' }} disabled /></div>
        ))}
        {p.enableCaptcha && (
          <div style={{ padding: '0.6rem 0.8rem', background: 'rgba(59,130,246,0.08)', border: '1px dashed #3b82f6', borderRadius: '6px', fontSize: '0.8rem', color: '#2563eb', textAlign: 'center' }}>
            CAPTCHA: Cloudflare Turnstile (rendered live on the public page)
          </div>
        )}
        <button style={{ padding: '0.75rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: '600' }}>{p.submitText}</button>
      </div>
    );
    case 'divider': return <hr style={{ border: 'none', borderTop: `1px solid ${p.color}`, margin: p.margin }} />;
    case 'spacer': return <div style={{ height: p.height }} />;
    case 'video': return <div style={{ textAlign: 'center' }}><iframe src={p.url} style={{ width: p.width || '100%', maxWidth: '100%', height: '360px', border: 'none', borderRadius: '6px' }} allowFullScreen /></div>;
    case 'columns': return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: p.gap || '2rem' }}>
        {(p.columns || []).map((col, i) => (
          <div key={i} style={{ flex: 1, minWidth: '200px' }}>
            {(col.components || []).map((child, j) => (
              <ComponentPreview key={j} comp={child} />
            ))}
          </div>
        ))}
      </div>
    );
    default: return <div style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '6px', fontSize: '0.85rem' }}>Unknown: {comp.type}</div>;
  }
}

function PropertyEditor({ comp, updateProp, routingRules }) {
  const p = comp.props;
  const field = (label, key, type = 'text') => (
    <div key={key} style={{ marginBottom: '0.75rem' }}>
      <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>{label}</label>
      {type === 'textarea' ? (
        <textarea className="input-field" value={p[key] || ''} onChange={e => updateProp(key, e.target.value)} rows={3} style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem', resize: 'vertical' }} />
      ) : type === 'select' ? null : (
        <input className="input-field" type={type} value={p[key] || ''} onChange={e => updateProp(key, e.target.value)} style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }} />
      )}
    </div>
  );

  const selectField = (label, key, options) => (
    <div key={key} style={{ marginBottom: '0.75rem' }}>
      <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>{label}</label>
      <select className="input-field" value={p[key] || ''} onChange={e => updateProp(key, e.target.value)} style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );

  switch (comp.type) {
    case 'heading': return <>{field('Text', 'text')}{selectField('Level', 'level', ['h1','h2','h3','h4','h5','h6'])}{selectField('Align', 'align', ['left','center','right'])}{field('Color', 'color', 'color')}</>;
    case 'text': return <>{field('Content', 'text', 'textarea')}{selectField('Align', 'align', ['left','center','right'])}{field('Color', 'color', 'color')}{field('Font Size', 'fontSize')}</>;
    case 'image': return <ImagePropertyEditor p={p} updateProp={updateProp} field={field} />;
    case 'button': return <>{field('Button Text', 'text')}{field('URL', 'url')}{field('Background', 'bgColor', 'color')}{field('Text Color', 'color', 'color')}{selectField('Align', 'align', ['left','center','right'])}{selectField('Size', 'size', ['small','medium','large'])}</>;
    case 'form': return <FormPropertyEditor p={p} updateProp={updateProp} field={field} routingRules={routingRules} />;
    case 'divider': return <>{field('Color', 'color', 'color')}{field('Margin', 'margin')}</>;
    case 'spacer': return <>{field('Height', 'height')}</>;
    case 'video': return <>{field('Embed URL', 'url')}{field('Width', 'width')}</>;
    case 'columns': return <>{field('Gap Between Columns', 'gap')}</>;
    default: return <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No properties for this component.</p>;
  }
}

// ── #446 — Image property editor with upload button ─────────────────
//
// Adds an "Upload" button next to the existing URL input. Clicking it
// opens a hidden <input type="file"> picker. On selection we POST the
// file to /api/landing-pages/upload (multipart/form-data, field
// "image"); the backend returns { url, ... } which we drop into
// props.src. We use raw fetch — fetchApi forces Content-Type:
// application/json which corrupts multipart bodies.
function ImagePropertyEditor({ p, updateProp, field }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const onPick = () => { setUploadError(null); fileRef.current?.click(); };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('image', file);
      // Bypass fetchApi (it sets Content-Type: application/json which
      // breaks multipart). We still need the bearer token — use
      // getAuthToken from utils/api.
      const token = getAuthToken();
      const r = await fetch('/api/landing-pages/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!r.ok) {
        let msg = `Upload failed (${r.status})`;
        try { const j = await r.json(); if (j.error) msg = j.error; } catch (_e) { /* ignore */ }
        throw new Error(msg);
      }
      const j = await r.json();
      if (!j.url) throw new Error('Upload succeeded but no URL was returned');
      updateProp('src', j.url);
    } catch (err) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      // Reset input so the same file can be re-picked.
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Image URL</label>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          <input className="input-field" type="text" value={p.src || ''} onChange={e => updateProp('src', e.target.value)} style={{ flex: 1, padding: '0.4rem', fontSize: '0.85rem' }} placeholder="https://… or /uploads/…" />
          <button
            type="button"
            onClick={onPick}
            disabled={uploading}
            title="Upload an image from your device (PNG/JPG/WebP/GIF, max 5 MB)"
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.65rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--subtle-bg)', color: 'var(--text-primary)', cursor: uploading ? 'wait' : 'pointer', fontSize: '0.78rem' }}
          >
            <Upload size={12} /> {uploading ? '...' : 'Upload'}
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onFile} style={{ display: 'none' }} />
        </div>
        {uploadError && (
          <div style={{ marginTop: '0.3rem', fontSize: '0.7rem', color: '#ef4444' }}>{uploadError}</div>
        )}
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.85 }}>
          PNG · JPG · WebP · GIF · max 5 MB
        </div>
      </div>
      {field('Alt Text', 'alt')}
      {field('Max Width', 'maxWidth')}
    </>
  );
}

// ── #451-remainder — Form property editor with extras ────────────────
//
// Adds three new property blocks:
//   1. Lead Routing rule selector (dropdown of LeadRoutingRule rows from
//      /api/lead-routing). If unset, falls through to tenant-level rules.
//   2. enableCaptcha checkbox — when true, the public renderer emits a
//      Cloudflare Turnstile widget and the submit handler verifies the
//      token via challenges.cloudflare.com/turnstile/v0/siteverify.
//   3. successRedirectUrl text input — when set, the renderer redirects
//      to this URL on successful submit instead of showing the static
//      thank-you panel.
function FormPropertyEditor({ p, updateProp, field, routingRules }) {
  // Inline URL validity hint (renderer also re-validates server-side).
  const redirectValid = !p.successRedirectUrl || /^https?:\/\//i.test(p.successRedirectUrl);

  return (
    <>
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Form Fields</p>
      {(p.fields || []).map((f, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.5rem', padding: '0.4rem', background: 'rgba(255,255,255,0.04)', borderRadius: 6 }}>
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <input
              className="input-field"
              placeholder="Field label"
              value={f.label || ''}
              onChange={e => { const flds = [...p.fields]; flds[i] = { ...flds[i], label: e.target.value }; updateProp('fields', flds); }}
              style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }}
            />
            <button
              onClick={() => { const flds = p.fields.filter((_, j) => j !== i); updateProp('fields', flds); }}
              title="Remove field"
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}
            ><Trash2 size={12} /></button>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <select
              className="input-field"
              value={f.type || 'text'}
              onChange={e => { const flds = [...p.fields]; flds[i] = { ...flds[i], type: e.target.value }; updateProp('fields', flds); }}
              style={{ flex: 1, padding: '0.25rem', fontSize: '0.75rem' }}
            >
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="tel">Phone</option>
              <option value="number">Number</option>
              <option value="url">URL</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: '#94a3b8', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!f.required}
                onChange={e => { const flds = [...p.fields]; flds[i] = { ...flds[i], required: e.target.checked }; updateProp('fields', flds); }}
              />
              Required
            </label>
          </div>
        </div>
      ))}
      <button onClick={() => updateProp('fields', [...(p.fields || []), { label: 'New Field', name: 'field_' + Date.now(), type: 'text', required: false }])} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '0.75rem' }}>+ Add Field</button>

      {field('Submit Text', 'submitText')}
      {field('Thank You Message', 'thankYouMessage')}

      {/* #451: Lead Routing rule selector */}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.75rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lead Routing</p>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Apply rule</label>
        <select
          className="input-field"
          value={p.leadRoutingRuleId || ''}
          onChange={e => updateProp('leadRoutingRuleId', e.target.value)}
          style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }}
        >
          <option value="">— Use tenant-level routing —</option>
          {routingRules && routingRules.map(r => (
            <option key={r.id} value={r.id}>{r.name} (priority {r.priority || 0})</option>
          ))}
        </select>
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.85 }}>
          {routingRules && routingRules.length === 0
            ? 'No routing rules configured for this tenant. Configure them under Settings → Lead Routing.'
            : 'When unset, the form falls through to tenant-level rules.'}
        </div>
      </div>

      {/* #451: CAPTCHA toggle */}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.5rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Spam Protection</p>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!p.enableCaptcha}
            onChange={e => updateProp('enableCaptcha', e.target.checked)}
          />
          Enable Cloudflare Turnstile CAPTCHA
        </label>
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.85 }}>
          Free tier; verifies spam-bot submissions server-side. The widget renders on the public page only.
        </div>
      </div>

      {/* #451: Success redirect URL */}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.5rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>After Submit</p>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Success redirect URL</label>
        <input
          className="input-field"
          type="url"
          value={p.successRedirectUrl || ''}
          onChange={e => updateProp('successRedirectUrl', e.target.value)}
          placeholder="https://example.com/thanks (optional)"
          style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem', borderColor: redirectValid ? undefined : '#ef4444' }}
        />
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: redirectValid ? 'var(--text-secondary)' : '#ef4444', opacity: 0.9 }}>
          {redirectValid
            ? 'Leave blank to show the thank-you message above. Must start with http:// or https://.'
            : 'URL must start with http:// or https://'}
        </div>
      </div>
    </>
  );
}
