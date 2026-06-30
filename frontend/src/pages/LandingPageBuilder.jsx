import React, { useState, useEffect, useReducer, useRef, useCallback } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft, Save, Eye, Monitor, Smartphone, Plus, Trash2, ChevronUp, ChevronDown, Type, AlignLeft, Image, MousePointerClick, FileInput, Minus, Space, Video, Upload, Undo2, Redo2, Columns, MapPin, Building2, Sparkles, ListChecks, CalendarDays, IndianRupee, HelpCircle, MessageSquare, AlertCircle, CheckCircle2, Globe, Film, Shield, FileDown, PhoneCall, History, X, RotateCcw, UserPlus } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { PRESETS as REG_FORM_PRESETS, listPresets as listRegFormPresets, defaultPropsFor as regFormDefaultPropsFor } from '../utils/travelRegistrationPresets';
import LandingPageTemplateEditor from './LandingPageTemplateEditor';
import LandingPageWanderluxEditor, { LayoutPanel as WanderluxLayoutPanel } from './LandingPageWanderluxEditor';
import { TeeDecisionPanel } from '../components/TeeDecisionPanel';

// Phase D1 — registered travel-page template ids. When a page's
// templateType matches one of these, the builder mounts the
// LandingPageTemplateEditor (form-based, content-as-object) instead
// of the block-array canvas. The list is kept in sync with the
// backend registry at backend/services/templates/index.js — adding a
// new template needs both ends to know about it.
const TEMPLATE_TYPE_IDS = new Set([
  'educational-trip-v1',
  'travel-premium-v1',
  'religious-tour-v1',
  'luxury-tour-v1',
  'family-trip-v1',
  // Road A (2026-06-23) — Wanderlux dynamic generator. Stores content as a
  // CONFIG OBJECT (not block array). Without this entry, the builder fell
  // into the block-array branch and crashed with "components.map is not a
  // function" on every wanderlux page (e.g. /landing-pages/builder/18?ai=1).
  'wanderlux-v1',
]);
function isTemplatePageType(t) { return typeof t === 'string' && TEMPLATE_TYPE_IDS.has(t); }
// Branding Wave 4 G094 (FR-3.3.h): per-sub-brand BrandKit lookup for the
// preview canvas. Admin picks a sub-brand via the `?sub_brand=tmc` URL
// param (or future picker UI); the resolved kit's logoUrl + primaryColor
// + tagline propagate into the preview canvas chrome so the admin sees
// what the public render will look like.
import { useBrandKit, brandLogoUrl, brandPrimaryColor } from '../hooks/useBrandKit';

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
  // ── Generic blocks (work on every landing page) ──────────────────
  { type: 'heading', label: 'Heading', icon: Type, group: 'generic', defaultProps: { text: 'Your Headline Here', level: 'h2', align: 'center', color: '#1e293b' } },
  { type: 'text', label: 'Text', icon: AlignLeft, group: 'generic', defaultProps: { text: 'Enter your text content here.', align: 'left', color: '#64748b', fontSize: '1rem' } },
  { type: 'image', label: 'Image', icon: Image, group: 'generic', defaultProps: { src: 'https://placehold.co/800x400/e2e8f0/94a3b8?text=Image', alt: 'Image', maxWidth: '100%' } },
  { type: 'button', label: 'Button', icon: MousePointerClick, group: 'generic', defaultProps: { text: 'Click Here', url: '#', bgColor: '#3b82f6', color: '#ffffff', align: 'center', size: 'medium' } },
  { type: 'form', label: 'Form', icon: FileInput, group: 'generic', defaultProps: { fields: [{ label: 'Name', name: 'name', type: 'text', required: true }, { label: 'Email', name: 'email', type: 'email', required: true }], submitText: 'Submit', thankYouMessage: 'Thank you!', enableCaptcha: false, leadRoutingRuleId: '', successRedirectUrl: '' } },
  { type: 'divider', label: 'Divider', icon: Minus, group: 'generic', defaultProps: { color: '#e2e8f0', margin: '1rem' } },
  { type: 'spacer', label: 'Spacer', icon: Space, group: 'generic', defaultProps: { height: '40px' } },
  { type: 'video', label: 'Video', icon: Video, group: 'generic', defaultProps: { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', width: '100%' } },
  { type: 'columns', label: 'Two Columns', icon: Columns, group: 'generic', defaultProps: { gap: '2rem', columns: [{ components: [] }, { components: [] }] } },
  // ── Travel destination blocks (visual parity with /trips) ──────
  // All 8 blocks are scoped by `.trips-page .t-*` CSS injected by
  // backend/services/landingPageRenderer.travel.css on the public
  // render. defaultProps mirror the seed shape the AI generator
  // emits so previews are immediate.
  { type: 'destinationHero', label: 'Destination Hero', icon: MapPin, group: 'travel', defaultProps: { destination: '', headline: '', subhead: '', posterUrl: null, countdownTo: null, ctaText: 'Reserve Your Spot', ctaScrollTarget: '', palette: { bg: '#1f1a17', fg: '#ffffff', accent: '#b8893b' } } },
  { type: 'cityCards', label: 'City Cards', icon: Building2, group: 'travel', defaultProps: { title: 'Where You’ll Go', subtitle: '', cards: [{ tag: '', title: '', img: null, body: '' }] } },
  { type: 'highlightsGrid', label: 'Highlights', icon: Sparkles, group: 'travel', defaultProps: { title: 'Why This Destination', subtitle: '', items: [{ icon: '◈', title: '', body: '' }] } },
  { type: 'inclusionsGrid', label: 'Inclusions', icon: ListChecks, group: 'travel', defaultProps: { title: 'What’s Included', subtitle: '', items: [''] } },
  { type: 'itineraryTimeline', label: 'Itinerary', icon: CalendarDays, group: 'travel', defaultProps: { title: 'Day-by-day', subtitle: '', days: [{ day: 1, title: '', bullets: [''] }] } },
  { type: 'tierPricing', label: 'Tier Pricing', icon: IndianRupee, group: 'travel', defaultProps: { title: 'Investment', subtitle: '', currency: '₹', tiers: [{ step: 1, label: '', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null }] } },
  { type: 'faqAccordion', label: 'FAQ', icon: HelpCircle, group: 'travel', defaultProps: { title: 'Frequently Asked Questions', subtitle: '', categories: [{ id: 'all', label: 'All', icon: '◇' }], faqs: [{ cat: '', q: '', a: '' }] } },
  { type: 'reviewCarousel', label: 'Reviews (manual)', icon: MessageSquare, group: 'travel', defaultProps: { title: 'What People Say', subtitle: '', reviews: [{ name: '', initial: '', text: '' }] } },
  // PR-C: 4 new travel blocks. travelVideo + brochureDownload are
  // operator-added (AI never emits URLs); safetyFeatures + contactFooter
  // are emitted by the AI as shells.
  { type: 'travelVideo', label: 'Video', icon: Film, group: 'travel', defaultProps: { title: 'See the Experience', subtitle: '', url: '', aspectRatio: '16:9' } },
  { type: 'safetyFeatures', label: 'Safety', icon: Shield, group: 'travel', defaultProps: { title: 'Engineered for Safety', subtitle: '', items: [{ icon: '◈', title: '', body: '' }, { icon: '⊕', title: '', body: '' }, { icon: '⌂', title: '', body: '' }] } },
  { type: 'brochureDownload', label: 'Brochure', icon: FileDown, group: 'travel', defaultProps: { title: 'Download the Brochure', subtitle: '', ctaText: 'Get the Brochure', fileUrl: null, formFields: [{ label: 'Full name', name: 'name', type: 'text', required: true }, { label: 'Email', name: 'email', type: 'email', required: true }, { label: 'Phone', name: 'phone', type: 'tel', required: false }] } },
  { type: 'contactFooter', label: 'Contact Footer', icon: PhoneCall, group: 'travel', defaultProps: { brandName: '', phone: null, email: null, ctaText: 'Reserve Your Spot', ctaUrl: '' } },
  // Audience-aware registration form. defaultProps seed from the TMC
  // preset (most common request: school-trip parent capture); admin can
  // switch the audience picker to RFU/Travel Stall/Visa Sure/Inquiry/
  // Custom from the right-rail editor and the field set refreshes.
  // Preset shapes live in frontend/src/utils/travelRegistrationPresets.js
  // (mirrored by backend/lib/travelRegistrationPresets.js).
  { type: 'registrationForm', label: 'Registration Form', icon: UserPlus, group: 'travel', defaultProps: regFormDefaultPropsFor('tmc') },
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

// Human-readable labels for the LandingPageVersion.source enum. Mirrors
// the VERSION_SOURCES set in backend/lib/landingPageVersions.js — keep
// the two in sync when adding a new source.
function formatVersionSource(source) {
  switch (source) {
    case 'CREATE': return 'Created';
    case 'MANUAL_SAVE': return 'Manual save';
    case 'PUBLISH': return 'Published';
    case 'AI_GENERATION': return 'AI generation';
    case 'RESTORE': return 'Restored';
    default: return source || 'Unknown';
  }
}

function formatVersionTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function LandingPageBuilder() {
  const notify = useNotify();
  const { id } = useParams();
  // G094: sub-brand preview context. Admin lands at
  //   /landing-pages/<id>/builder?sub_brand=tmc
  // to preview the page chrome under the TMC brand kit; absent param
  // resolves to the tenant-wide kit (FR-3.3 fallback chain).
  const [searchParams] = useSearchParams();
  const previewSubBrand = searchParams.get('sub_brand') || null;
  const { brandKit: previewBrandKit } = useBrandKit(previewSubBrand);
  const previewLogo = brandLogoUrl(previewBrandKit);
  const previewAccent = brandPrimaryColor(previewBrandKit);
  const [page, setPage] = useState(null);
  const [history, dispatch] = useReducer(historyReducer, { past: [], present: [], future: [] });
  const components = history.present;
  // Phase D1 — template-driven page content (JSON object, not array).
  // Used when page.templateType is a registered template id. Sibling
  // state of `components` so block-based pages stay untouched.
  const [templateContent, setTemplateContent] = useState(null);
  const isTemplateMode = isTemplatePageType(page && page.templateType);
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState('desktop');
  // Publish-gate state: when the user clicks Publish we save-then-check,
  // and surface the issues modal if the backend rejects with code
  // PUBLISH_GATE_FAILED. The modal is also reachable proactively via
  // "Check readiness" so the operator can audit before clicking Publish.
  const [publishing, setPublishing] = useState(false);
  const [publishIssues, setPublishIssues] = useState(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  // #451: lead-routing-rule list, fetched once on mount. Used by the form
  // component's "Lead Routing" properties section. Empty array if the
  // tenant has no rules configured (UI surfaces a hint instead of an
  // empty dropdown).
  const [routingRules, setRoutingRules] = useState([]);
  // Trip-link picker — populated only when the operator is on the TMC
  // sub-brand (the only sub-brand that owns trips today). Empty array
  // for non-TMC pages so the picker stays hidden.
  const [tmcTrips, setTmcTrips] = useState([]);
  const [linkingTripId, setLinkingTripId] = useState(null);
  // #454: dirty-state tracking + beforeunload guard.
  const [isDirty, setIsDirty] = useState(false);
  // Version-history drawer state. Lightweight versioning per PRD —
  // snapshots are captured server-side on create / manual save /
  // publish / AI generation / restore; the drawer just lists them
  // and offers a Restore button per row.
  const [showVersionsDrawer, setShowVersionsDrawer] = useState(false);
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState(null);

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
      // Phase D1 — template pages store content as a JSON OBJECT
      // keyed to template slots (hero/programme/cultural/etc).
      // Detect and route to the matching state slot.
      if (isTemplatePageType(data.templateType)) {
        let obj = {};
        try {
          const parsed = typeof data.content === 'string' ? JSON.parse(data.content || '{}') : (data.content || {});
          obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch { obj = {}; }
        setTemplateContent(obj);
        dispatch({ type: 'SET', value: [] });
      } else {
        let parsed = [];
        try { parsed = JSON.parse(data.content || '[]'); } catch { parsed = []; }
        dispatch({ type: 'SET', value: parsed });
        setTemplateContent(null);
      }
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

  // Fetch TMC trips for the "Link to trip" picker. Travel admins only;
  // 403 (non-travel tenant or non-TMC sub-brand access) → silently
  // leave the picker empty so the toolbar renders without the dropdown
  // for generic users.
  useEffect(() => {
    fetchApi('/api/travel/trips?limit=200')
      .then(res => Array.isArray(res?.trips) ? setTmcTrips(res.trips) : setTmcTrips([]))
      .catch(() => setTmcTrips([]));
  }, []);
  // Sync linking state with the page's persisted tripId so the
  // dropdown reflects "Linked to trip X" on load.
  useEffect(() => {
    if (page?.tripId !== undefined) setLinkingTripId(page.tripId ?? null);
  }, [page?.tripId]);

  // Link / unlink the page to a TMC trip via the existing PUT endpoint.
  // Schema enforces 1:1 (LandingPage.tripId @unique) — server returns
  // 409 TRIP_ALREADY_LINKED if another page already claims this trip.
  const handleLinkToTrip = async (nextTripId) => {
    // nextTripId === '' means "unlink" — translate to null for the API
    const payload = nextTripId === '' || nextTripId === null
      ? { tripId: null }
      : { tripId: parseInt(nextTripId, 10) };
    try {
      const updated = await fetchApi(`/api/landing-pages/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        silent: true,
      });
      setPage(updated);
      setLinkingTripId(updated.tripId ?? null);
      if (payload.tripId == null) {
        notify.success('Unlinked — wizard submissions will fall back to lead capture.');
      } else {
        const trip = tmcTrips.find(t => t.id === payload.tripId);
        notify.success(`Linked to ${trip ? trip.tripCode : `trip #${payload.tripId}`}`);
      }
    } catch (err) {
      if (err.status === 409 && err.body?.code === 'TRIP_ALREADY_LINKED') {
        notify.error(err.body.error || 'Another landing page is already linked to this trip.');
      } else if (err.status === 404 && err.body?.code === 'TRIP_NOT_FOUND') {
        notify.error('That trip is not in your tenant.');
      } else {
        notify.error('Failed to update trip link');
      }
      // Restore dropdown to the persisted value
      setLinkingTripId(page?.tripId ?? null);
    }
  };

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
      // Phase D1 — when the page is in template mode, the persisted
      // content is the object payload (not the block array). Block-
      // based pages keep their existing array shape.
      const contentSerialized = isTemplateMode
        ? JSON.stringify(templateContent || {})
        : JSON.stringify(components);
      const payload = { title: page.title, content: contentSerialized };
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

  // Publish flow — save first, then run the backend readiness check,
  // then call /publish. The /publish endpoint also enforces the gate
  // server-side; the client preview lets the user see the issues
  // immediately without a publish attempt.
  const handleCheckReadiness = async () => {
    if (!page?.id) return;
    setPublishIssues(null);
    try {
      // Save any in-flight edits first so the readiness check evaluates
      // the operator's current canvas, not the stale persisted row.
      if (isDirty) await handleSave(false);
      const verdict = await fetchApi(`/api/landing-pages/${page.id}/publish-check`);
      setPublishIssues(verdict);
      setShowPublishModal(true);
    } catch (err) {
      notify.error(err?.message || 'Failed to check readiness.');
    }
  };

  const handlePublish = async () => {
    if (!page?.id || publishing) return;
    setPublishing(true);
    try {
      if (isDirty) await handleSave(false);
      await fetchApi(`/api/landing-pages/${page.id}/publish`, { method: 'POST' });
      setPage({ ...page, status: 'PUBLISHED', publishedAt: new Date().toISOString() });
      setPublishIssues({ ok: true, issues: [] });
      setShowPublishModal(false);
      notify.success(`Published — public URL is /trips.`);
    } catch (err) {
      if (err?.status === 409 && err?.code === 'PUBLISH_GATE_FAILED') {
        setPublishIssues({ ok: false, issues: err.data?.issues || [] });
        setShowPublishModal(true);
      } else {
        notify.error(err?.message || 'Publish failed.');
      }
    } finally {
      setPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    if (!page?.id) return;
    const ok = await notify.confirm(`Unpublish "${page.title}"? The public URL /trips will return 404 until you re-publish.`);
    if (!ok) return;
    try {
      await fetchApi(`/api/landing-pages/${page.id}/unpublish`, { method: 'POST' });
      setPage({ ...page, status: 'DRAFT' });
      notify.success('Unpublished.');
    } catch (err) {
      notify.error(err?.message || 'Unpublish failed.');
    }
  };

  // ── Version history ──────────────────────────────────────────────
  const loadVersions = async () => {
    if (!page?.id) return;
    setVersionsLoading(true);
    try {
      const data = await fetchApi(`/api/landing-pages/${page.id}/versions`);
      setVersions(Array.isArray(data?.versions) ? data.versions : []);
    } catch (err) {
      notify.error(err?.message || 'Failed to load version history.');
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleOpenVersions = async () => {
    setShowVersionsDrawer(true);
    await loadVersions();
  };

  // PR-E Phase 2.3 — preview a historical version snapshot without
  // restoring first. Mints a fresh preview token (5-min single-use)
  // and appends ?version=N so the production renderer renders the
  // snapshot instead of the live state. Used by the "Preview" button
  // on each row in the version drawer so operators can compare BEFORE
  // restoring (Generate → Edit → Preview → Restore → Preview → Publish).
  const handlePreviewVersion = async (version) => {
    if (!page?.id) return;
    try {
      const { token } = await fetchApi(`/api/landing-pages/${page.id}/preview-token`, { method: 'POST' });
      if (!token) throw new Error('No token returned');
      const url = `/api/landing-pages/${page.id}/preview?previewToken=${encodeURIComponent(token)}&version=${version.versionNumber}`;
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      notify.error(err?.message || 'Could not open version preview.');
    }
  };

  const handleRestoreVersion = async (version) => {
    if (!page?.id || restoringVersionId) return;
    const ok = await notify.confirm(
      `Restore to version #${version.versionNumber} (${formatVersionSource(version.source)})? Your current content will be saved as a new version, so nothing is lost.`,
    );
    if (!ok) return;
    setRestoringVersionId(version.id);
    try {
      const result = await fetchApi(`/api/landing-pages/${page.id}/versions/${version.id}/restore`, { method: 'POST' });
      if (result?.page) {
        setPage(result.page);
        let parsed = [];
        try { parsed = JSON.parse(result.page.content || '[]'); } catch { parsed = []; }
        dispatch({ type: 'SET', value: parsed });
        setIsDirty(false);
        if (result.slugKept) {
          notify.info(`Restored content. Slug kept as "${result.page.slug}" because another page is already using "${version.slug}".`);
        } else {
          notify.success(`Restored to version #${version.versionNumber}.`);
        }
        await loadVersions();
      }
    } catch (err) {
      notify.error(err?.message || 'Restore failed.');
    } finally {
      setRestoringVersionId(null);
    }
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
          <button onClick={handleOpenVersions} title="View saved versions and restore" aria-label="View version history" style={iconBarBtnStyle(true)}><History size={14} /></button>
        </div>
        <div style={{ display: 'flex', gap: '0.2rem', background: 'var(--subtle-bg)', borderRadius: '6px', padding: '0.18rem' }}>
          <button onClick={() => setPreviewMode('desktop')} title="Desktop preview" aria-label="Desktop preview" style={{ padding: '0.25rem 0.55rem', borderRadius: '4px', border: 'none', cursor: 'pointer', background: previewMode === 'desktop' ? 'var(--accent-color)' : 'transparent', color: previewMode === 'desktop' ? '#fff' : 'var(--text-secondary)' }}><Monitor size={14} /></button>
          <button onClick={() => setPreviewMode('mobile')} title="Mobile preview" aria-label="Mobile preview" style={{ padding: '0.25rem 0.55rem', borderRadius: '4px', border: 'none', cursor: 'pointer', background: previewMode === 'mobile' ? 'var(--accent-color)' : 'transparent', color: previewMode === 'mobile' ? '#fff' : 'var(--text-secondary)' }}><Smartphone size={14} /></button>
        </div>
        {/* Draft preview — opens the production renderer for the
            page's current state (works for DRAFT and PUBLISHED).
            Mints a short-lived (5-min) single-purpose preview token
            via POST /preview-token, then opens
            /preview?previewToken=<jwt> in a new tab. window.open
            cannot carry an Authorization header, so the token rides
            in the URL — the 5-min expiry + previewOnly claim keeps
            the leak window tiny. */}
        <button
          type="button"
          onClick={async () => {
            // Save first if dirty so the preview reflects the latest
            // edits rather than a stale row.
            if (isDirty && slugIsValid) {
              await handleSave(false);
            }
            try {
              const { token } = await fetchApi(`/api/landing-pages/${page.id}/preview-token`, { method: 'POST' });
              if (!token) throw new Error('No token returned');
              window.open(`/api/landing-pages/${page.id}/preview?previewToken=${encodeURIComponent(token)}`, '_blank', 'noopener');
            } catch (_err) {
              notify.error('Could not open preview — try again or save the page first.');
            }
          }}
          title={isDirty ? "Save first, then open the production preview in a new tab" : "Open the production preview in a new tab"}
          style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.35rem 0.7rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.8rem', color: 'var(--text-primary)', background: 'transparent', cursor: 'pointer' }}
        >
          <Eye size={14} /> Preview
        </button>
        {page.status === 'PUBLISHED' && (
          <a href={`${window.location.origin}/trips`} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.35rem 0.7rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.8rem', color: 'var(--text-primary)', textDecoration: 'none' }}>
            <Globe size={14} /> Open live
          </a>
        )}
        {/* Link-to-trip picker — only renders when the operator has at
            least one TMC trip available. Hidden on tenants without
            travel access. Saves immediately on change via the existing
            PUT endpoint (tripId field, Phase 11). Linking defaults the
            registration block to lead mode, so wizard submissions create
            a Contact + Deal + TripParticipant and show up immediately in
            the trip participants list. Explicit register.mode =
            "registration-draft" is required to use the OTP/hybrid draft
            flow instead. */}
        {tmcTrips.length > 0 && (
          <select
            value={linkingTripId ?? ''}
            onChange={(e) => handleLinkToTrip(e.target.value)}
            title="Link this landing page to a TMC trip so wizard submissions enrol participants immediately"
            aria-label="Link landing page to TMC trip"
            data-testid="link-to-tmc-trip-picker"
            style={{ padding: '0.3rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.78rem', background: 'var(--surface-color)', color: 'var(--text-primary)', cursor: 'pointer', maxWidth: 180 }}
          >
            <option value="">— Not linked to a trip —</option>
            {tmcTrips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.tripCode} ({t.destination})
              </option>
            ))}
          </select>
        )}
        <button className="btn-primary" onClick={() => handleSave(false)} disabled={saving || !slugIsValid} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.35rem 0.9rem', fontSize: '0.85rem' }}>
          <Save size={14} /> {saving ? 'Saving...' : 'Save'}{isDirty && !saving && <span style={{ marginLeft: '0.3rem', opacity: 0.85 }}>•</span>}
        </button>
        {/* Publish controls — visible for every page. The "Check
            readiness" button runs the backend gate without mutating
            status so the user can iterate. Publish runs the gate then
            flips status to PUBLISHED; Unpublish reverts to DRAFT. */}
        <button
          onClick={handleCheckReadiness}
          title="Check what's still missing before this page can be published"
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.35rem 0.7rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-primary)' }}
        >
          <CheckCircle2 size={13} /> Check
        </button>
        {page.status === 'PUBLISHED' ? (
          <button
            onClick={handleUnpublish}
            title="Take the public URL offline"
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.35rem 0.85rem', border: '1px solid #f59e0b', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontSize: '0.8rem', color: '#f59e0b', fontWeight: 600 }}
          >
            <Globe size={13} /> Unpublish
          </button>
        ) : (
          <button
            onClick={handlePublish}
            disabled={publishing || !slugIsValid}
            title={!slugIsValid ? 'Fix the slug first' : 'Publish — runs the readiness check then makes the page public'}
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.35rem 0.95rem', border: 'none', borderRadius: 6, background: slugIsValid ? '#10b981' : 'var(--subtle-bg)', cursor: publishing || !slugIsValid ? 'not-allowed' : 'pointer', fontSize: '0.85rem', color: '#fff', fontWeight: 600, opacity: publishing ? 0.7 : 1 }}
          >
            <Globe size={13} /> {publishing ? 'Publishing…' : 'Publish'}
          </button>
        )}
      </div>

      {/* Phase D1 — template-driven page editor takes over when the
          page's templateType matches a registered template id. The
          block-array 3-panel layout (palette / canvas / properties)
          stays in place for every other page so non-template flows
          are unaffected. */}
      {isTemplateMode ? (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {/* Wanderlux pages use a different config schema than the
                four family templates (brand.name vs brand.programmeName,
                hero.titleLines vs hero.headline, etc.). Route them to
                the schema-matched editor so the form fields actually
                read + write the right keys. Everything else still uses
                the legacy editor for back-compat. */}
            {page && page.templateType === 'wanderlux-v1' ? (
              <LandingPageWanderluxEditor
                content={templateContent}
                onChange={(next) => { setTemplateContent(next); setIsDirty(true); }}
              />
            ) : (
              <LandingPageTemplateEditor
                content={templateContent}
                onChange={(next) => { setTemplateContent(next); setIsDirty(true); }}
                templateType={page && page.templateType}
              />
            )}
          </div>
          <aside style={{ width: page && page.templateType === 'wanderlux-v1' ? '340px' : '280px', borderLeft: '1px solid var(--border-color)', padding: '1rem', overflowY: 'auto', flexShrink: 0, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {/* Wanderlux-only: layout panel pinned at the top of the
                aside so reorder / show-hide / add-custom-block is the
                first thing operators see. Mirrors the manual builder's
                left-rail Components palette, but on the right because
                the main column is field-form-shaped (not canvas-shaped). */}
            {page && page.templateType === 'wanderlux-v1' && (
              <WanderluxLayoutPanel
                cfg={templateContent || {}}
                onChange={(next) => { setTemplateContent(next); setIsDirty(true); }}
                isDirty={isDirty}
              />
            )}
            <h4 style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.35rem' }}>Page</h4>
            <div style={{ lineHeight: 1.6 }}>
              <div><strong>Template:</strong> {page.templateType}</div>
              <div><strong>Title:</strong> {page.title}</div>
              <div><strong>Slug:</strong> /p/{page.slug || '—'}</div>
              <div><strong>Status:</strong> {page.status}</div>
              {page.status === 'PUBLISHED' && (
                <div style={{ marginTop: '0.6rem' }}>
                  <a href={`${window.location.origin}/trips`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-color)' }}>Open public page →</a>
                </div>
              )}
            </div>
            <p style={{ marginTop: '0.85rem', fontSize: '0.72rem', opacity: 0.85 }}>
              This page renders through the {page.templateType} template. The renderer owns the layout — you only edit content slots on the left.
            </p>
            {/* PR-E Phase 2.3.5 / 2.3.6 — TEE Decision Panel + Regenerate
                Strategy. Surfaces the _tee block stamped onto content by
                teeContentBridge so demos can explain WHY a page chose
                this family / theme / visualMood / composition. The panel
                also hosts the Regenerate Strategy modal (R3) — operators
                can re-classify without rebuilding the page. */}
            <TeeDecisionPanel
              teeBlock={templateContent && templateContent._tee}
              pageId={page && page.id}
              page={page}
              onReclassified={(newTee) => {
                // Stamp the new TEE block onto content metadata. Content
                // + images stay; only the decision log updates. The
                // operator can then click "Generate with TEE" to rebuild
                // the actual page under the new strategy.
                if (!templateContent || !newTee) return;
                const next = { ...templateContent, _tee: {
                  ...(templateContent._tee || {}),
                  family: newTee.family,
                  themeId: newTee.themeId,
                  visualMood: newTee.traits && newTee.traits.visualMood,
                  composition: newTee.composition,
                  traits: newTee.traits,
                  decisions: newTee.decisionLog,
                  reclassifiedAt: new Date().toISOString(),
                }};
                setTemplateContent(next);
                setIsDirty(true);
              }}
            />
          </aside>
        </div>
      ) : (
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: Component Palette — grouped by `group` so travel blocks
            sit visually distinct from generic ones. Two sections render
            in declaration order; the palette stays scrollable. */}
        <div style={{ width: '200px', borderRight: '1px solid var(--border-color)', padding: '1rem', overflowY: 'auto', flexShrink: 0 }}>
          {[
            { id: 'generic', label: 'Components' },
            { id: 'travel', label: 'Travel Destination' },
          ].map((grp) => {
            const items = COMPONENT_TYPES.filter((ct) => (ct.group || 'generic') === grp.id);
            if (items.length === 0) return null;
            return (
              <div key={grp.id} style={{ marginBottom: '1rem' }}>
                <h4 style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                  {grp.label}
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {items.map((ct) => (
                    <button
                      key={ct.type}
                      onClick={() => addComponent(ct.type)}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem', transition: 'all 0.15s', textAlign: 'left' }}
                    >
                      <ct.icon size={14} /> {ct.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Center: Preview Canvas */}
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--subtle-bg)', padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
          {/* G094: BrandKit preview ribbon. Renders a small chrome strip
              above the canvas showing the resolved logo + tagline + accent
              so the admin sees the sub-brand context the public render
              will inherit. Absent when there's no sub-brand context AND no
              tenant-wide kit. */}
          {(previewLogo || previewBrandKit?.tagline) && (
            <div
              data-testid="landing-builder-brand-kit-ribbon"
              style={{
                width: previewMode === 'mobile' ? '375px' : '100%',
                maxWidth: '800px',
                background: 'var(--surface-color)',
                borderRadius: '8px',
                boxShadow: 'var(--glass-shadow)',
                padding: '0.5rem 1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                borderLeft: `4px solid ${previewAccent}`,
              }}
            >
              {previewLogo && (
                <img
                  src={previewLogo}
                  alt="Brand logo preview"
                  style={{ maxHeight: 28, maxWidth: 120, objectFit: 'contain' }}
                />
              )}
              {previewBrandKit?.tagline && (
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {previewBrandKit.tagline}
                </span>
              )}
              {previewSubBrand && (
                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Preview: {previewSubBrand}
                </span>
              )}
            </div>
          )}
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
      )}

      {/* Publish-readiness modal. Surfaces the issues array the backend
          returned (publish-check OR a publish 409 PUBLISH_GATE_FAILED).
          When issues is empty, shows a green "ready to publish" panel
          and exposes the Publish button so the user can confirm. */}
      {showPublishModal && publishIssues && (
        <PublishReadinessModal
          verdict={publishIssues}
          page={page}
          publishing={publishing}
          onPublish={handlePublish}
          onClose={() => setShowPublishModal(false)}
          onJumpToBlock={(blockIndex) => {
            if (typeof blockIndex === 'number') setSelected(blockIndex);
            setShowPublishModal(false);
          }}
        />
      )}

      {/* Version-history drawer. Lightweight per PRD — list + Restore.
          Snapshots are captured server-side on the 5 mutation events
          (create / manual save / publish / AI generation / restore).
          No diff view, no branching, no merge. */}
      {showVersionsDrawer && (
        <VersionsDrawer
          versions={versions}
          loading={versionsLoading}
          restoringVersionId={restoringVersionId}
          onClose={() => setShowVersionsDrawer(false)}
          onRestore={handleRestoreVersion}
          onPreview={handlePreviewVersion}
          onRefresh={loadVersions}
        />
      )}
    </div>
  );
}

// ── Version history drawer ────────────────────────────────────────────
//
// Right-side panel listing every snapshot the backend has captured for
// this page. Each row shows version number, source (Created / Manual
// save / Published / AI generation / Restored), timestamp, and a
// Restore button. The newest version sits at the top.
//
// Restoring a version writes a NEW snapshot server-side so prior
// versions remain available — the list reloads after each restore.
function VersionsDrawer({ versions, loading, restoringVersionId, onClose, onRestore, onPreview, onRefresh }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Version history"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60,
        display: 'flex', justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '380px', maxWidth: '100vw', height: '100vh', background: 'var(--surface-color)',
          borderLeft: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column',
          boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.85rem 1rem', borderBottom: '1px solid var(--border-color)' }}>
          <History size={16} />
          <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, flex: 1 }}>Version history</h2>
          <button onClick={onRefresh} title="Refresh" style={{ background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.25rem 0.5rem', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.72rem' }}>Refresh</button>
          <button onClick={onClose} aria-label="Close version history" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid var(--border-color)', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          Snapshots are captured automatically on save, publish, AI generation, and restore. Restoring keeps every prior version.
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
          {loading ? (
            <div style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading…</div>
          ) : versions.length === 0 ? (
            <div style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              No versions yet. Save or publish this page to create the first snapshot.
            </div>
          ) : (
            versions.map((v, idx) => {
              const isCurrent = idx === 0;
              const restoring = restoringVersionId === v.id;
              return (
                <div
                  key={v.id}
                  style={{
                    border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.65rem 0.75rem',
                    marginBottom: '0.5rem', background: isCurrent ? 'var(--subtle-bg, rgba(0,0,0,0.02))' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginBottom: '0.2rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>v{v.versionNumber}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>·</span>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{formatVersionSource(v.source)}</span>
                    {isCurrent && (
                      <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#10b981', fontWeight: 600, textTransform: 'uppercase' }}>Current</span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: '0.15rem' }}>
                    {formatVersionTimestamp(v.createdAt)}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '0.4rem' }} title={v.title}>
                    {v.title || '(untitled)'} <span style={{ opacity: 0.7 }}>· /p/{v.slug || '—'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    {/* PR-E Phase 2.3 — Preview this version (without restoring).
                        Opens the production renderer with ?version=N so the
                        operator can compare BEFORE deciding to restore. */}
                    <button
                      onClick={() => onPreview && onPreview(v)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                        background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 6,
                        padding: '0.3rem 0.6rem', cursor: 'pointer',
                        fontSize: '0.72rem', color: 'var(--text-primary)',
                      }}
                      title={isCurrent
                        ? "Preview the current live state in a new tab"
                        : `Preview version #${v.versionNumber} in a new tab (does not modify the live page)`}
                    >
                      <Eye size={12} /> Preview
                    </button>
                    {!isCurrent && (
                      <button
                        onClick={() => onRestore(v)}
                        disabled={restoring}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                          background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 6,
                          padding: '0.3rem 0.6rem', cursor: restoring ? 'not-allowed' : 'pointer',
                          fontSize: '0.72rem', color: 'var(--text-primary)', opacity: restoring ? 0.6 : 1,
                        }}
                      >
                        <RotateCcw size={12} /> {restoring ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

const iconBtnStyle = { background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: '2px' };

// ── Publish-readiness modal ──────────────────────────────────────────
//
// Shows the operator what's missing before this page can go PUBLISHED.
// Backend gate (validatePublishReadiness in routes/landing_pages.js) is
// authoritative; this modal is a UX shell over it. Clicking an issue
// jumps to the offending block on the canvas (when blockIndex is
// supplied by the backend) so the operator can fix it inline.
function PublishReadinessModal({ verdict, page, publishing, onPublish, onClose, onJumpToBlock }) {
  const ok = verdict?.ok && Array.isArray(verdict.issues) && verdict.issues.length === 0;
  const issues = Array.isArray(verdict?.issues) ? verdict.issues : [];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-readiness-title"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}
    >
      {/* className="card" inherits the theme-aware surface + blur from
          index.css (.card uses var(--surface-color) which adapts to
          dark / light). Pre-fix this used `var(--card-bg, #fff)` —
          --card-bg isn't defined anywhere, so the fallback white made
          the modal render white-on-white in dark mode (text was
          var(--text-primary) which is white in dark mode → invisible). */}
      <div className="card" style={{ padding: '1.5rem', width: 'min(520px, 92vw)', maxHeight: '85vh', overflowY: 'auto', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          {ok ? <CheckCircle2 size={20} style={{ color: '#10b981' }} /> : <AlertCircle size={20} style={{ color: '#f59e0b' }} />}
          <h3 id="publish-readiness-title" style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>
            {ok ? 'Ready to publish' : `${issues.length} issue${issues.length === 1 ? '' : 's'} to fix`}
          </h3>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '1.1rem', lineHeight: 1 }}>✕</button>
        </div>
        {ok ? (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
              Page passes every readiness check. Click Publish to make <code>/trips</code> public.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button onClick={onClose} style={{ padding: '0.5rem 1rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }}>Cancel</button>
              <button
                onClick={onPublish}
                disabled={publishing}
                style={{ padding: '0.5rem 1rem', border: 'none', borderRadius: 6, background: '#10b981', color: '#fff', cursor: publishing ? 'wait' : 'pointer', fontWeight: 600 }}
              >
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              Resolve every item below before publishing. Click an item to jump to the block on the canvas.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {issues.map((it, i) => (
                <li key={i}>
                  <button
                    onClick={() => onJumpToBlock(it.blockIndex)}
                    /* Theme-aware issue card: subtle-bg adapts to dark
                       (rgba white .05) and light (rgba black .04); the
                       amber left-border gives the severity hint without
                       relying on a faint amber tint that washed out
                       text in either theme. */
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      display: 'flex',
                      gap: '0.6rem',
                      alignItems: 'flex-start',
                      padding: '0.7rem 0.85rem',
                      border: '1px solid var(--border-color)',
                      borderLeft: '3px solid #f59e0b',
                      borderRadius: 6,
                      background: 'var(--subtle-bg)',
                      color: 'var(--text-primary)',
                      cursor: typeof it.blockIndex === 'number' ? 'pointer' : 'default',
                      fontSize: '0.85rem',
                      lineHeight: 1.5,
                    }}
                  >
                    <AlertCircle size={14} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 3 }} />
                    <span style={{ flex: 1, color: 'var(--text-primary)' }}>
                      <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.7rem', color: 'var(--text-secondary)', background: 'var(--subtle-bg-3)', padding: '1px 6px', borderRadius: 3, marginRight: '0.5rem' }}>{it.code}</code>
                      {it.message}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{ padding: '0.5rem 1rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

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
    case 'video': return <GenericVideoPreview p={p} />;
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
    // ── Travel block previews ────────────────────────────────────
    // The builder canvas can't reach the server-injected
    // `landingPageRenderer.travel.css`, so each preview ships a small,
    // theme-faithful inline render — enough for the operator to see
    // the structure + content while they edit. Public-render fidelity
    // happens on /p/<slug>.
    case 'destinationHero': return <DestinationHeroPreview p={p} />;
    case 'cityCards': return <CityCardsPreview p={p} />;
    case 'highlightsGrid': return <HighlightsGridPreview p={p} />;
    case 'inclusionsGrid': return <InclusionsGridPreview p={p} />;
    case 'itineraryTimeline': return <ItineraryTimelinePreview p={p} />;
    case 'tierPricing': return <TierPricingPreview p={p} />;
    case 'faqAccordion': return <FaqAccordionPreview p={p} />;
    case 'reviewCarousel': return <ReviewCarouselPreview p={p} />;
    case 'travelVideo': return <TravelVideoPreview p={p} />;
    case 'safetyFeatures': return <SafetyFeaturesPreview p={p} />;
    case 'brochureDownload': return <BrochureDownloadPreview p={p} />;
    case 'registrationForm': return <RegistrationFormPreview p={p} />;
    case 'contactFooter': return <ContactFooterPreview p={p} />;
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
    case 'video': return <GenericVideoEditor p={p} updateProp={updateProp} field={field} />;
    case 'columns': return <>{field('Gap Between Columns', 'gap')}</>;
    case 'destinationHero': return <DestinationHeroEditor p={p} updateProp={updateProp} field={field} />;
    case 'cityCards': return <CityCardsEditor p={p} updateProp={updateProp} field={field} />;
    case 'highlightsGrid': return <HighlightsGridEditor p={p} updateProp={updateProp} field={field} />;
    case 'inclusionsGrid': return <InclusionsGridEditor p={p} updateProp={updateProp} field={field} />;
    case 'itineraryTimeline': return <ItineraryTimelineEditor p={p} updateProp={updateProp} field={field} />;
    case 'tierPricing': return <TierPricingEditor p={p} updateProp={updateProp} field={field} />;
    case 'faqAccordion': return <FaqAccordionEditor p={p} updateProp={updateProp} field={field} />;
    case 'reviewCarousel': return <ReviewCarouselEditor p={p} updateProp={updateProp} field={field} />;
    case 'travelVideo': return <TravelVideoEditor p={p} updateProp={updateProp} field={field} />;
    case 'safetyFeatures': return <SafetyFeaturesEditor p={p} updateProp={updateProp} field={field} />;
    case 'brochureDownload': return <BrochureDownloadEditor p={p} updateProp={updateProp} field={field} />;
    case 'registrationForm': return <RegistrationFormEditor p={p} updateProp={updateProp} field={field} routingRules={routingRules} />;
    case 'contactFooter': return <ContactFooterEditor p={p} updateProp={updateProp} field={field} />;
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

// ── Travel block sub-components ──────────────────────────────────────
//
// Each travel block exports a paired Preview + Editor below. The previews
// mirror — at a smaller fidelity — what the server's
// landingPageRenderer.travel.css will produce on the public page. Inline
// styles use the same palette tokens (`#1f1a17` / `#b8893b` / `#6f655c`)
// the public CSS uses so the builder canvas and the public render don't
// diverge visually.
//
// Editors reuse the existing `field(label, key, type)` helper from
// PropertyEditor for primitive fields and inline list-of-objects editing
// for cards / cities / tiers / faqs / days. AI-emitted images come back
// as `null`; the editor renders a clear "upload required" placeholder so
// the operator notices before publishing (the backend publish gate
// re-enforces this).

// Shared image picker for travel blocks. Reuses the same multer endpoint
// as the generic Image block (5 MB, PNG/JPG/WebP/GIF allowlist). Renders
// a placeholder when value is null/empty so the empty state is visible.
function TravelImageField({ label, value, onChange, hint }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const onPick = () => { setErr(null); fileRef.current?.click(); };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('image', file);
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
      onChange(j.url);
    } catch (e2) {
      setErr(e2.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const empty = !value;
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>{label}</label>
      <div style={{ display: 'flex', gap: '0.3rem' }}>
        <input
          className="input-field"
          type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value || null)}
          style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}
          placeholder="https://… or /uploads/…"
        />
        <button
          type="button"
          onClick={onPick}
          disabled={uploading}
          title="Upload an image (PNG/JPG/WebP/GIF, max 5 MB)"
          style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.6rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--subtle-bg)', color: 'var(--text-primary)', cursor: uploading ? 'wait' : 'pointer', fontSize: '0.75rem' }}
        >
          <Upload size={11} /> {uploading ? '…' : 'Upload'}
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onFile} style={{ display: 'none' }} />
      </div>
      {err && <div style={{ marginTop: '0.25rem', fontSize: '0.7rem', color: '#ef4444' }}>{err}</div>}
      {empty && !err && (
        <div style={{ marginTop: '0.25rem', fontSize: '0.7rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <AlertCircle size={11} /> No image set — publish is blocked until uploaded.
        </div>
      )}
      {hint && <div style={{ marginTop: '0.2rem', fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.8 }}>{hint}</div>}
    </div>
  );
}

// Wrapper used by every travel preview so they share the cream/gold
// palette + serif headings the public page uses.
function TravelPreviewBox({ children, accent = '#b8893b', dark = false }) {
  return (
    <div
      style={{
        background: dark ? '#1f1a17' : '#f4efe6',
        color: dark ? '#fff' : '#1f1a17',
        padding: '1.4rem 1.2rem',
        borderRadius: 4,
        borderLeft: `3px solid ${accent}`,
        fontFamily: '"Helvetica Neue", Arial, sans-serif',
      }}
    >
      {children}
    </div>
  );
}

// ── destinationHero ──────────────────────────────────────────────────
function DestinationHeroPreview({ p }) {
  const palette = p.palette || {};
  const bg = palette.bg || '#1f1a17';
  const accent = palette.accent || '#b8893b';
  const fg = palette.fg || '#fff';
  const posterStyle = p.posterUrl
    ? { backgroundImage: `linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.65)),url('${p.posterUrl}')`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: bg };
  return (
    <div style={{ ...posterStyle, color: fg, padding: '2.2rem 1.2rem', textAlign: 'center', borderRadius: 4, fontFamily: '"Helvetica Neue", Arial, sans-serif' }}>
      {p.destination && (
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.22em', textTransform: 'uppercase', color: accent, fontWeight: 700, marginBottom: '0.5rem' }}>{p.destination}</div>
      )}
      <h1 style={{ fontFamily: 'Georgia, serif', fontSize: '1.8rem', lineHeight: 1.1, margin: '0 0 0.6rem', fontWeight: 400 }}>
        {p.headline || <span style={{ opacity: 0.5, fontStyle: 'italic' }}>Add a hero headline</span>}
      </h1>
      {p.subhead && <p style={{ fontSize: '0.9rem', opacity: 0.9, margin: '0 0 1rem' }}>{p.subhead}</p>}
      <button style={{ background: accent, color: '#fff', padding: '0.65rem 1.4rem', border: 'none', borderRadius: 2, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: '0.75rem', cursor: 'default' }}>{p.ctaText || 'Reserve'}</button>
      {!p.posterUrl && (
        <div style={{ marginTop: '0.85rem', fontSize: '0.7rem', color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
          <AlertCircle size={11} /> Hero image not set — upload before publishing.
        </div>
      )}
    </div>
  );
}

function DestinationHeroEditor({ p, updateProp, field }) {
  const palette = p.palette || {};
  const setPalette = (k, v) => updateProp('palette', { ...palette, [k]: v });
  return (
    <>
      {field('Destination label', 'destination')}
      {field('Headline', 'headline', 'textarea')}
      {field('Subhead', 'subhead', 'textarea')}
      <TravelImageField label="Hero image" value={p.posterUrl} onChange={(v) => updateProp('posterUrl', v)} hint="Used as the full-bleed background. 16:9 photo recommended." />
      {field('CTA text', 'ctaText')}
      {field('CTA scrolls to (block id)', 'ctaScrollTarget')}
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Countdown to (ISO date or blank)</label>
        <input className="input-field" type="text" value={p.countdownTo || ''} onChange={e => updateProp('countdownTo', e.target.value || null)} placeholder="2026-06-30T23:59:59+05:30" style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem' }} />
        <div style={{ marginTop: '0.2rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>Leave blank to hide the countdown.</div>
      </div>
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.5rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Palette</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', marginBottom: '0.75rem' }}>
        <div><label style={{ fontSize: '0.65rem', color: '#94a3b8' }}>BG</label><input type="color" value={palette.bg || '#1f1a17'} onChange={e => setPalette('bg', e.target.value)} style={{ width: '100%', height: 28, border: '1px solid var(--border-color)', borderRadius: 4 }} /></div>
        <div><label style={{ fontSize: '0.65rem', color: '#94a3b8' }}>FG</label><input type="color" value={palette.fg || '#ffffff'} onChange={e => setPalette('fg', e.target.value)} style={{ width: '100%', height: 28, border: '1px solid var(--border-color)', borderRadius: 4 }} /></div>
        <div><label style={{ fontSize: '0.65rem', color: '#94a3b8' }}>Accent</label><input type="color" value={palette.accent || '#b8893b'} onChange={e => setPalette('accent', e.target.value)} style={{ width: '100%', height: 28, border: '1px solid var(--border-color)', borderRadius: 4 }} /></div>
      </div>
    </>
  );
}

// ── cityCards ────────────────────────────────────────────────────────
function CityCardsPreview({ p }) {
  const cards = Array.isArray(p.cards) ? p.cards : [];
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.9rem', fontWeight: 400 }}>{p.title}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.6rem' }}>
        {cards.map((c, i) => (
          <div key={i} style={{ background: '#fffdf8', border: '1px solid #e3d9c8', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ aspectRatio: '4 / 3', background: c.img ? `url(${c.img}) center/cover` : 'repeating-linear-gradient(45deg, #ece2cd, #ece2cd 8px, #e3d9c8 8px, #e3d9c8 16px)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6f655c', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              {!c.img && 'image'}
            </div>
            <div style={{ padding: '0.5rem 0.7rem' }}>
              {c.tag && <div style={{ fontSize: '0.55rem', letterSpacing: '0.18em', color: '#b8893b', fontWeight: 700, textTransform: 'uppercase' }}>{c.tag}</div>}
              <div style={{ fontFamily: 'Georgia, serif', fontSize: '0.95rem' }}>{c.title || '—'}</div>
              {c.body && <div style={{ fontSize: '0.7rem', color: '#6f655c', marginTop: '0.2rem', lineHeight: 1.4 }}>{c.body}</div>}
              {c.benefit && <div style={{ fontSize: '0.65rem', color: '#1f1a17', fontStyle: 'italic', marginTop: '0.35rem', borderTop: '1px dashed #e3d9c8', paddingTop: '0.3rem' }}>&ldquo;{c.benefit}&rdquo;</div>}
            </div>
          </div>
        ))}
      </div>
    </TravelPreviewBox>
  );
}

function CityCardsEditor({ p, updateProp, field }) {
  const cards = Array.isArray(p.cards) ? p.cards : [];
  const setCard = (i, patch) => updateProp('cards', cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const addCard = () => updateProp('cards', [...cards, { tag: '', title: '', img: null, body: '' }]);
  const removeCard = (i) => updateProp('cards', cards.filter((_, j) => j !== i));
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Cities</p>
      {cards.map((c, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.55rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>City #{i + 1}</span>
            <button onClick={() => removeCard(i)} title="Remove city" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          <input className="input-field" placeholder="Tag (e.g. ICONIC)" value={c.tag || ''} onChange={e => setCard(i, { tag: e.target.value })} style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', marginBottom: '0.3rem' }} />
          <input className="input-field" placeholder="City title" value={c.title || ''} onChange={e => setCard(i, { title: e.target.value })} style={{ width: '100%', padding: '0.3rem', fontSize: '0.8rem', marginBottom: '0.3rem' }} />
          <textarea className="input-field" placeholder="What you'll experience in this city" value={c.body || ''} onChange={e => setCard(i, { body: e.target.value })} rows={3} style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', marginBottom: '0.3rem', resize: 'vertical' }} />
          <textarea className="input-field" placeholder="Derived benefit (pull quote — optional)" value={c.benefit || ''} onChange={e => setCard(i, { benefit: e.target.value })} rows={2} style={{ width: '100%', padding: '0.3rem', fontSize: '0.72rem', marginBottom: '0.3rem', resize: 'vertical', fontStyle: 'italic' }} />
          <TravelImageField label="City image" value={c.img} onChange={(v) => setCard(i, { img: v })} hint="4:3 photo recommended." />
        </div>
      ))}
      <button onClick={addCard} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add City</button>
    </>
  );
}

// ── highlightsGrid ───────────────────────────────────────────────────
function HighlightsGridPreview({ p }) {
  const items = Array.isArray(p.items) ? p.items : [];
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.9rem', fontWeight: 400 }}>{p.title}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.8rem' }}>
        {items.map((it, i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.4rem', color: '#b8893b', marginBottom: '0.25rem' }}>{it.icon || '◈'}</div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: '0.85rem' }}>{it.title || '—'}</div>
            {it.body && <div style={{ fontSize: '0.7rem', color: '#6f655c', marginTop: '0.15rem' }}>{it.body}</div>}
          </div>
        ))}
      </div>
    </TravelPreviewBox>
  );
}

function HighlightsGridEditor({ p, updateProp, field }) {
  const items = Array.isArray(p.items) ? p.items : [];
  const setItem = (i, patch) => updateProp('items', items.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const addItem = () => updateProp('items', [...items, { icon: '◈', title: '', body: '' }]);
  const removeItem = (i) => updateProp('items', items.filter((_, j) => j !== i));
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Highlights</p>
      {items.map((it, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.5rem', marginBottom: '0.45rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
            <input className="input-field" value={it.icon || ''} onChange={e => setItem(i, { icon: e.target.value })} placeholder="◈" style={{ width: 42, padding: '0.3rem', fontSize: '1rem', textAlign: 'center' }} />
            <input className="input-field" value={it.title || ''} onChange={e => setItem(i, { title: e.target.value })} placeholder="Title" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
            <button onClick={() => removeItem(i)} title="Remove" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          <textarea className="input-field" value={it.body || ''} onChange={e => setItem(i, { body: e.target.value })} placeholder="Body" rows={2} style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', resize: 'vertical' }} />
        </div>
      ))}
      <button onClick={addItem} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add Highlight</button>
    </>
  );
}

// ── inclusionsGrid ───────────────────────────────────────────────────
function InclusionsGridPreview({ p }) {
  const items = Array.isArray(p.items) ? p.items : [];
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.7rem', fontWeight: 400 }}>{p.title}</h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.4rem 1rem' }}>
        {items.map((s, i) => (
          <li key={i} style={{ display: 'flex', gap: '0.4rem', fontSize: '0.85rem' }}>
            <span style={{ color: '#b8893b', fontWeight: 700 }}>✓</span>
            <span>{s || '—'}</span>
          </li>
        ))}
      </ul>
    </TravelPreviewBox>
  );
}

function InclusionsGridEditor({ p, updateProp, field }) {
  const items = Array.isArray(p.items) ? p.items : [];
  const setItem = (i, v) => updateProp('items', items.map((s, j) => (j === i ? v : s)));
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Items</p>
      {items.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.35rem' }}>
          <input className="input-field" value={s || ''} onChange={e => setItem(i, e.target.value)} placeholder="Inclusion item" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
          <button onClick={() => updateProp('items', items.filter((_, j) => j !== i))} title="Remove" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
        </div>
      ))}
      <button onClick={() => updateProp('items', [...items, ''])} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add Item</button>
    </>
  );
}

// ── itineraryTimeline ────────────────────────────────────────────────
function ItineraryTimelinePreview({ p }) {
  const days = Array.isArray(p.days) ? p.days : [];
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.9rem', fontWeight: 400 }}>{p.title}</h3>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {days.map((d, i) => (
          <li key={i} style={{ display: 'flex', gap: '0.7rem', padding: '0.5rem 0', borderBottom: i < days.length - 1 ? '1px solid #e3d9c8' : 'none' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#b8893b', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Georgia, serif', fontWeight: 600, flexShrink: 0, fontSize: d.icon ? '1rem' : '0.9rem' }}>{d.icon || d.day || '?'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: '0.9rem' }}>{d.title || `Day ${d.day || i + 1}`}</div>
              {(d.bullets || []).filter(Boolean).slice(0, 3).map((b, bi) => (
                <div key={bi} style={{ fontSize: '0.7rem', color: '#6f655c' }}>· {b}</div>
              ))}
              {d.notes && <div style={{ fontSize: '0.65rem', color: '#6f655c', fontStyle: 'italic', marginTop: '0.25rem', paddingLeft: '0.7rem', borderLeft: '2px solid #e3d9c8' }}>{d.notes}</div>}
            </div>
          </li>
        ))}
      </ol>
    </TravelPreviewBox>
  );
}

function ItineraryTimelineEditor({ p, updateProp, field }) {
  const days = Array.isArray(p.days) ? p.days : [];
  const setDay = (i, patch) => updateProp('days', days.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const addDay = () => updateProp('days', [...days, { day: days.length + 1, title: '', bullets: [''] }]);
  const removeDay = (i) => updateProp('days', days.filter((_, j) => j !== i));
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Days</p>
      {days.map((d, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.55rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', marginBottom: '0.3rem' }}>
            <input className="input-field" type="number" value={Number.isFinite(d.day) ? d.day : i + 1} onChange={e => setDay(i, { day: parseInt(e.target.value, 10) || i + 1 })} style={{ width: 56, padding: '0.3rem', fontSize: '0.8rem' }} />
            <input className="input-field" value={d.icon || ''} onChange={e => setDay(i, { icon: e.target.value || null })} placeholder="◈" maxLength={3} style={{ width: 42, padding: '0.3rem', fontSize: '1rem', textAlign: 'center' }} title="Optional icon shown in the day marker (replaces the number)" />
            <input className="input-field" value={d.title || ''} onChange={e => setDay(i, { title: e.target.value })} placeholder="Day title" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
            <button onClick={() => removeDay(i)} title="Remove day" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          <textarea
            className="input-field"
            value={(d.bullets || []).join('\n')}
            onChange={e => setDay(i, { bullets: e.target.value.split('\n') })}
            placeholder="One bullet per line"
            rows={3}
            style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', resize: 'vertical', marginBottom: '0.3rem' }}
          />
          <input
            className="input-field"
            value={d.notes || ''}
            onChange={e => setDay(i, { notes: e.target.value || null })}
            placeholder="Optional notes (e.g. 'Optional evening activity', 'Free time')"
            style={{ width: '100%', padding: '0.3rem', fontSize: '0.72rem', fontStyle: 'italic' }}
          />
        </div>
      ))}
      <button onClick={addDay} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add Day</button>
    </>
  );
}

// ── tierPricing ──────────────────────────────────────────────────────
// Pricing values are operator-entered, never AI-generated. The publish
// gate refuses to push the page until every tier has a non-empty amount.
// (A future PR may reintroduce a "link to CRM Trip pricing" capability
// once the instalment-mapping product semantics are decided.)
function TierPricingPreview({ p }) {
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];
  const currency = p.currency || '₹';
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.9rem', fontWeight: 400 }}>{p.title}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem' }}>
        {tiers.map((t, i) => (
          <div key={i} style={{ background: '#fffdf8', borderTop: t.badge ? '5px solid #b8893b' : '3px solid #b8893b', border: '1px solid #e3d9c8', padding: '0.85rem 0.75rem', textAlign: 'center', position: 'relative', boxShadow: t.badge ? '0 4px 12px rgba(184,137,59,0.18)' : 'none' }}>
            {t.badge && (
              <span style={{ position: 'absolute', top: -9, left: '50%', transform: 'translateX(-50%)', background: '#b8893b', color: '#fff', padding: '0.18rem 0.55rem', borderRadius: 2, fontSize: '0.55rem', letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 700, whiteSpace: 'nowrap' }}>
                {t.badge}
              </span>
            )}
            <div style={{ fontSize: '0.6rem', letterSpacing: '0.22em', color: '#b8893b', fontWeight: 700, textTransform: 'uppercase' }}>Step {t.step ?? i + 1}</div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: '0.95rem', margin: '0.25rem 0 0.4rem' }}>{t.label || '—'}</div>
            {t.amount ? (
              <div style={{ fontFamily: 'Georgia, serif', fontSize: '1.25rem', fontWeight: 600 }}>{currency}{t.amount}</div>
            ) : (
              <div style={{ fontSize: '0.75rem', fontStyle: 'italic', color: '#6f655c', border: '1px dashed #e3d9c8', padding: '0.35rem 0.5rem', borderRadius: 4 }}>
                Pricing TBD
              </div>
            )}
            {t.dueDate && <div style={{ fontSize: '0.7rem', color: '#6f655c', marginTop: '0.35rem' }}>Due: {t.dueDate}</div>}
            {t.vendor && <div style={{ fontSize: '0.65rem', color: '#6f655c', opacity: 0.85 }}>{t.vendor}</div>}
          </div>
        ))}
      </div>
    </TravelPreviewBox>
  );
}

function TierPricingEditor({ p, updateProp, field }) {
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];
  const setTier = (i, patch) => updateProp('tiers', tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const addTier = () => updateProp('tiers', [...tiers, { step: tiers.length + 1, label: '', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null }]);
  const removeTier = (i) => updateProp('tiers', tiers.filter((_, j) => j !== i));
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Currency symbol</label>
        <input className="input-field" value={p.currency || '₹'} onChange={e => updateProp('currency', e.target.value)} style={{ width: 80, padding: '0.3rem', fontSize: '0.85rem', textAlign: 'center' }} />
      </div>
      <div style={{ padding: '0.5rem 0.6rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, marginBottom: '0.75rem', display: 'flex', alignItems: 'flex-start', gap: '0.4rem', fontSize: '0.72rem', color: 'var(--text-primary)' }}>
        <AlertCircle size={14} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
        <span>AI never fills pricing values. Enter the amount for every tier manually — the publish gate blocks pages with empty tier amounts.</span>
      </div>
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tiers</p>
      {tiers.map((t, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.55rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', marginBottom: '0.35rem' }}>
            <input className="input-field" type="number" value={Number.isFinite(t.step) ? t.step : i + 1} onChange={e => setTier(i, { step: parseInt(e.target.value, 10) || i + 1 })} style={{ width: 52, padding: '0.3rem', fontSize: '0.8rem' }} placeholder="#" />
            <input className="input-field" value={t.label || ''} onChange={e => setTier(i, { label: e.target.value })} placeholder="Tier label" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
            <button onClick={() => removeTier(i)} title="Remove tier" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          <input className="input-field" value={t.subtitle || ''} onChange={e => setTier(i, { subtitle: e.target.value })} placeholder="Subtitle" style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', marginBottom: '0.3rem' }} />
          <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
            <input className="input-field" value={t.amount == null ? '' : t.amount} onChange={e => setTier(i, { amount: e.target.value === '' ? null : e.target.value })} placeholder="Amount" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
            <input className="input-field" value={t.dueDate || ''} onChange={e => setTier(i, { dueDate: e.target.value || null })} placeholder="Due date" style={{ flex: 1, padding: '0.3rem', fontSize: '0.75rem' }} />
          </div>
          <input className="input-field" value={t.vendor || ''} onChange={e => setTier(i, { vendor: e.target.value || null })} placeholder="Vendor (optional)" style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', marginBottom: '0.3rem' }} />
          <input className="input-field" value={t.tag || ''} onChange={e => setTier(i, { tag: e.target.value || null })} placeholder="Tag (e.g. Non-refundable)" style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', marginBottom: '0.3rem' }} />
          {/* PR-C: prominent ribbon badge (visually distinct from `tag`).
              Allowlist surfaces 4 common choices + lets the operator type
              a custom one. AI never fills this. */}
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', color: '#94a3b8', minWidth: 50 }}>Badge</span>
            <select
              className="input-field"
              value={['Most Popular','Early Bird','Recommended','Best Value'].includes(t.badge) ? t.badge : (t.badge ? 'Custom' : '')}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '') setTier(i, { badge: null });
                else if (v === 'Custom') setTier(i, { badge: t.badge || 'Custom' });
                else setTier(i, { badge: v });
              }}
              style={{ flex: 1, padding: '0.3rem', fontSize: '0.75rem' }}
            >
              <option value="">— None —</option>
              <option value="Most Popular">Most Popular</option>
              <option value="Early Bird">Early Bird</option>
              <option value="Recommended">Recommended</option>
              <option value="Best Value">Best Value</option>
              <option value="Custom">Custom…</option>
            </select>
          </div>
          {t.badge && !['Most Popular','Early Bird','Recommended','Best Value'].includes(t.badge) && (
            <input
              className="input-field"
              value={t.badge || ''}
              onChange={e => setTier(i, { badge: e.target.value || null })}
              placeholder="Custom badge text"
              maxLength={20}
              style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', marginTop: '0.25rem' }}
            />
          )}
        </div>
      ))}
      <button onClick={addTier} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add Tier</button>
    </>
  );
}

// ── faqAccordion ─────────────────────────────────────────────────────
function FaqAccordionPreview({ p }) {
  const faqs = Array.isArray(p.faqs) ? p.faqs : [];
  const cats = Array.isArray(p.categories) ? p.categories : [];
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.7rem', fontWeight: 400 }}>{p.title}</h3>
      {cats.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.6rem' }}>
          {cats.map(c => (
            <span key={c.id} style={{ fontSize: '0.6rem', letterSpacing: '0.15em', textTransform: 'uppercase', color: '#6f655c', border: '1px solid #e3d9c8', padding: '0.2rem 0.55rem', borderRadius: 2 }}>{c.icon || '·'} {c.label}</span>
          ))}
        </div>
      )}
      {faqs.slice(0, 4).map((f, i) => (
        <details key={i} style={{ background: '#f4efe6', border: '1px solid #e3d9c8', borderRadius: 4, padding: '0.4rem 0.6rem', marginBottom: '0.25rem' }}>
          <summary style={{ fontFamily: 'Georgia, serif', fontSize: '0.85rem', cursor: 'pointer', listStyle: 'none' }}>{f.q || '(empty question)'}</summary>
          <div style={{ fontSize: '0.75rem', color: '#6f655c', marginTop: '0.35rem' }}>{f.a || '(empty answer)'}</div>
        </details>
      ))}
      {faqs.length > 4 && <div style={{ fontSize: '0.7rem', color: '#6f655c', marginTop: '0.4rem', textAlign: 'center' }}>+ {faqs.length - 4} more</div>}
    </TravelPreviewBox>
  );
}

function FaqAccordionEditor({ p, updateProp, field }) {
  const faqs = Array.isArray(p.faqs) ? p.faqs : [];
  const cats = Array.isArray(p.categories) ? p.categories : [];
  const setFaq = (i, patch) => updateProp('faqs', faqs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const setCat = (i, patch) => updateProp('categories', cats.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Categories</p>
      {cats.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.35rem' }}>
          <input className="input-field" value={c.icon || ''} onChange={e => setCat(i, { icon: e.target.value })} placeholder="◇" style={{ width: 40, padding: '0.3rem', fontSize: '0.85rem', textAlign: 'center' }} />
          <input className="input-field" value={c.id || ''} onChange={e => setCat(i, { id: e.target.value })} placeholder="id" style={{ width: 70, padding: '0.3rem', fontSize: '0.75rem' }} />
          <input className="input-field" value={c.label || ''} onChange={e => setCat(i, { label: e.target.value })} placeholder="Label" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
          <button onClick={() => updateProp('categories', cats.filter((_, j) => j !== i))} title="Remove category" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
        </div>
      ))}
      <button onClick={() => updateProp('categories', [...cats, { id: 'cat_' + Date.now(), label: 'New', icon: '·' }])} style={{ fontSize: '0.72rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '0.6rem' }}>+ Add Category</button>
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.4rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>FAQs</p>
      {faqs.map((f, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.5rem', marginBottom: '0.45rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', marginBottom: '0.3rem' }}>
            <select className="input-field" value={f.cat || ''} onChange={e => setFaq(i, { cat: e.target.value })} style={{ width: 100, padding: '0.3rem', fontSize: '0.75rem' }}>
              <option value="">(no cat)</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <button onClick={() => updateProp('faqs', faqs.filter((_, j) => j !== i))} title="Remove FAQ" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          <textarea className="input-field" value={f.q || ''} onChange={e => setFaq(i, { q: e.target.value })} placeholder="Question" rows={1} style={{ width: '100%', padding: '0.3rem', fontSize: '0.8rem', resize: 'vertical', marginBottom: '0.3rem' }} />
          <textarea className="input-field" value={f.a || ''} onChange={e => setFaq(i, { a: e.target.value })} placeholder="Answer" rows={3} style={{ width: '100%', padding: '0.3rem', fontSize: '0.78rem', resize: 'vertical' }} />
        </div>
      ))}
      <button onClick={() => updateProp('faqs', [...faqs, { cat: '', q: '', a: '' }])} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add FAQ</button>
    </>
  );
}

// ── reviewCarousel (manual-only) ─────────────────────────────────────
function ReviewCarouselPreview({ p }) {
  const reviews = Array.isArray(p.reviews) ? p.reviews : [];
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.9rem', fontWeight: 400 }}>{p.title}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.6rem' }}>
        {reviews.map((r, i) => (
          <div key={i} style={{ background: '#fffdf8', border: '1px solid #e3d9c8', padding: '0.9rem', textAlign: 'center', borderRadius: 4 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#b8893b', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Georgia, serif', fontWeight: 600, marginBottom: '0.4rem' }}>{(r.initial || (r.name || '?')[0] || '?').toUpperCase()}</div>
            <div style={{ fontSize: '0.78rem', fontStyle: 'italic', color: '#1f1a17' }}>&ldquo;{r.text || '(empty)'}&rdquo;</div>
            <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6f655c', marginTop: '0.4rem' }}>{r.name || '—'}</div>
          </div>
        ))}
      </div>
    </TravelPreviewBox>
  );
}

function ReviewCarouselEditor({ p, updateProp, field }) {
  const reviews = Array.isArray(p.reviews) ? p.reviews : [];
  const setRev = (i, patch) => updateProp('reviews', reviews.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <div style={{ padding: '0.55rem 0.65rem', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 6, marginBottom: '0.75rem', fontSize: '0.72rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'flex-start', gap: '0.4rem' }}>
        <MessageSquare size={14} style={{ color: '#3b82f6', flexShrink: 0, marginTop: 1 }} />
        <span>Reviews are manual-only. The AI generator never emits this block — type each review verbatim from a real source.</span>
      </div>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reviews</p>
      {reviews.map((r, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.55rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', marginBottom: '0.3rem' }}>
            <input className="input-field" value={r.initial || ''} onChange={e => setRev(i, { initial: e.target.value })} placeholder="Initial" style={{ width: 50, padding: '0.3rem', fontSize: '0.8rem', textAlign: 'center' }} maxLength={2} />
            <input className="input-field" value={r.name || ''} onChange={e => setRev(i, { name: e.target.value })} placeholder="Reviewer name" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
            <button onClick={() => updateProp('reviews', reviews.filter((_, j) => j !== i))} title="Remove review" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          <textarea className="input-field" value={r.text || ''} onChange={e => setRev(i, { text: e.target.value })} placeholder="Review text — verbatim, from a real source" rows={3} style={{ width: '100%', padding: '0.3rem', fontSize: '0.78rem', resize: 'vertical' }} />
        </div>
      ))}
      <button onClick={() => updateProp('reviews', [...reviews, { name: '', initial: '', text: '' }])} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add Review</button>
    </>
  );
}

// ── PR-C: travelVideo ────────────────────────────────────────────────
//
// Frontend mirror of backend/lib/videoUrl.js — same patterns, kept tiny
// so the preview reflects what the public renderer will actually show
// (YouTube Shorts / watch / youtu.be → /embed; Vimeo → player.vimeo).
// Mismatch between this and the backend would cause "preview works,
// public render shows 'refused to connect'" — keep them in sync.
const LOCAL_VIDEO_UPLOAD_PREFIX = '/uploads/landing-page-videos/';
function isLocalVideoUpload(url) {
  if (!url || typeof url !== 'string') return false;
  return url.trim().startsWith(LOCAL_VIDEO_UPLOAD_PREFIX);
}
function normalizeVideoEmbedUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (isLocalVideoUpload(trimmed)) return trimmed;
  let m = trimmed.match(/^https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{6,})/i);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = trimmed.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = trimmed.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?.*?\bv=([A-Za-z0-9_-]{6,})/i);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = trimmed.match(/^https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = trimmed.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:\/([A-Za-z0-9]+))?/i);
  if (m) return m[2] ? `https://player.vimeo.com/video/${m[1]}?h=${m[2]}` : `https://player.vimeo.com/video/${m[1]}`;
  return trimmed;
}

// Generic (non-travel) video block — same normalisation + upload story
// as the travel variant, but without the travel chrome. Used by the
// vanilla "Video" component-palette entry.
function GenericVideoPreview({ p }) {
  const rawUrl = (p.url || '').trim();
  const normalized = normalizeVideoEmbedUrl(rawUrl);
  const local = isLocalVideoUpload(normalized);
  if (!normalized) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem 1rem', border: '1px dashed var(--border-color)', borderRadius: 6, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
        Paste a YouTube / Vimeo URL or upload a video in the right panel
      </div>
    );
  }
  return (
    <div style={{ textAlign: 'center' }}>
      {local ? (
        <video src={normalized} controls preload="metadata" style={{ width: p.width || '100%', maxWidth: '100%', borderRadius: '6px' }} />
      ) : (
        <iframe src={normalized} style={{ width: p.width || '100%', maxWidth: '100%', height: '360px', border: 'none', borderRadius: '6px' }} allowFullScreen title="Video preview" />
      )}
    </div>
  );
}

function GenericVideoEditor({ p, updateProp, field }) {
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
      fd.append('video', file);
      const token = getAuthToken();
      const r = await fetch('/api/landing-pages/upload-video', {
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
      updateProp('url', j.url);
    } catch (err) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const rawUrl = (p.url || '').trim();
  const normalized = normalizeVideoEmbedUrl(rawUrl);
  const showNormalizedHint = rawUrl && normalized !== rawUrl && !isLocalVideoUpload(normalized);
  return (
    <>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Video URL</label>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          <input
            className="input-field"
            type="url"
            value={p.url || ''}
            onChange={(e) => updateProp('url', e.target.value)}
            placeholder="https://youtube.com/… or upload"
            style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}
          />
          <button
            type="button"
            onClick={onPick}
            disabled={uploading}
            title="Upload a video from your device (MP4 / WebM / MOV, max 50 MB)"
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.65rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--subtle-bg)', color: 'var(--text-primary)', cursor: uploading ? 'wait' : 'pointer', fontSize: '0.78rem' }}
          >
            <Upload size={12} /> {uploading ? '...' : 'Upload'}
          </button>
          <input ref={fileRef} type="file" accept="video/mp4,video/webm,video/quicktime,video/ogg" onChange={onFile} style={{ display: 'none' }} />
        </div>
        {uploadError && (
          <div style={{ marginTop: '0.3rem', fontSize: '0.7rem', color: '#ef4444' }}>{uploadError}</div>
        )}
        {showNormalizedHint && (
          <div style={{ marginTop: '0.3rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
            ✓ Will render as <code style={{ color: 'var(--text-primary)' }}>{normalized}</code>
          </div>
        )}
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.85 }}>
          Watch / Shorts / youtu.be URLs auto-convert. Upload caps at 50 MB.
        </div>
      </div>
      {field('Width', 'width')}
    </>
  );
}

function TravelVideoPreview({ p }) {
  const rawUrl = (p.url || '').trim();
  const normalized = normalizeVideoEmbedUrl(rawUrl);
  const local = isLocalVideoUpload(normalized);
  const aspectRatio = p.aspectRatio === '9:16' ? '9 / 16' : p.aspectRatio === '4:3' ? '4 / 3' : '16 / 9';
  return (
    <TravelPreviewBox>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.7rem', fontWeight: 400 }}>{p.title}</h3>
      {normalized ? (
        <div style={{ width: '100%', aspectRatio, border: '1px solid #e3d9c8', borderRadius: 4, overflow: 'hidden', background: '#000' }}>
          {local ? (
            <video src={normalized} controls preload="metadata" style={{ width: '100%', height: '100%' }} title="Uploaded video preview" />
          ) : (
            <iframe src={normalized} style={{ width: '100%', height: '100%', border: 'none' }} allowFullScreen title="Video preview" />
          )}
        </div>
      ) : (
        <div style={{ width: '100%', aspectRatio, background: 'repeating-linear-gradient(45deg, #ece2cd, #ece2cd 10px, #e3d9c8 10px, #e3d9c8 20px)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6f655c', fontSize: '0.78rem', textAlign: 'center', padding: '0.5rem' }}>
          Paste a YouTube / Vimeo / Wistia URL<br />or upload a video in the right panel
        </div>
      )}
    </TravelPreviewBox>
  );
}

function TravelVideoEditor({ p, updateProp, field }) {
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
      fd.append('video', file);
      // Raw fetch — fetchApi forces application/json which breaks
      // multipart bodies. Mirrors ImagePropertyEditor's pattern above.
      const token = getAuthToken();
      const r = await fetch('/api/landing-pages/upload-video', {
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
      updateProp('url', j.url);
    } catch (err) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const rawUrl = (p.url || '').trim();
  const normalized = normalizeVideoEmbedUrl(rawUrl);
  // Surface the auto-normalisation so the operator can see we converted
  // their pasted Shorts / watch URL to an embed URL (and the iframe
  // will actually load instead of "refused to connect").
  const showNormalizedHint = rawUrl && normalized !== rawUrl && !isLocalVideoUpload(normalized);
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Video URL (YouTube / Vimeo / Wistia)</label>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          <input
            className="input-field"
            type="url"
            value={p.url || ''}
            onChange={(e) => updateProp('url', e.target.value)}
            placeholder="https://youtube.com/watch?v=…  or  https://youtu.be/…"
            style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}
          />
          <button
            type="button"
            onClick={onPick}
            disabled={uploading}
            title="Upload a video from your device (MP4 / WebM / MOV, max 50 MB)"
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.65rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--subtle-bg)', color: 'var(--text-primary)', cursor: uploading ? 'wait' : 'pointer', fontSize: '0.78rem' }}
          >
            <Upload size={12} /> {uploading ? '...' : 'Upload'}
          </button>
          <input ref={fileRef} type="file" accept="video/mp4,video/webm,video/quicktime,video/ogg" onChange={onFile} style={{ display: 'none' }} />
        </div>
        {uploadError && (
          <div style={{ marginTop: '0.3rem', fontSize: '0.7rem', color: '#ef4444' }}>{uploadError}</div>
        )}
        {showNormalizedHint && (
          <div style={{ marginTop: '0.3rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
            ✓ Will render as <code style={{ color: 'var(--text-primary)' }}>{normalized}</code>
          </div>
        )}
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.85 }}>
          Paste any YouTube (watch / Shorts / youtu.be) or Vimeo URL — we auto-convert to the embed form. Or upload MP4/WebM/MOV (max 50 MB).
        </div>
      </div>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Aspect ratio</label>
        <select className="input-field" value={p.aspectRatio || '16:9'} onChange={(e) => updateProp('aspectRatio', e.target.value)} style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }}>
          <option value="16:9">16:9 (default — most YouTube videos)</option>
          <option value="9:16">9:16 (vertical / reels)</option>
          <option value="4:3">4:3 (legacy)</option>
        </select>
      </div>
    </>
  );
}

// ── PR-C: safetyFeatures ─────────────────────────────────────────────
function SafetyFeaturesPreview({ p }) {
  const items = Array.isArray(p.items) ? p.items : [];
  return (
    <TravelPreviewBox dark>
      <h3 style={{ fontFamily: 'Georgia, serif', textAlign: 'center', margin: '0 0 0.9rem', fontWeight: 400, color: '#f4efe6' }}>{p.title || 'Engineered for Safety'}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.8rem' }}>
        {items.map((it, i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.4rem', color: '#b8893b', marginBottom: '0.25rem' }}>{it.icon || '◈'}</div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: '0.85rem', color: '#f4efe6' }}>{it.title || '—'}</div>
            {it.body && <div style={{ fontSize: '0.7rem', color: '#d6cdb6', marginTop: '0.15rem' }}>{it.body}</div>}
          </div>
        ))}
      </div>
    </TravelPreviewBox>
  );
}

function SafetyFeaturesEditor({ p, updateProp, field }) {
  const items = Array.isArray(p.items) ? p.items : [];
  const setItem = (i, patch) => updateProp('items', items.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const addItem = () => updateProp('items', [...items, { icon: '◈', title: '', body: '' }]);
  const removeItem = (i) => updateProp('items', items.filter((_, j) => j !== i));
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Safety items</p>
      {items.map((it, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.5rem', marginBottom: '0.45rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
            <input className="input-field" value={it.icon || ''} onChange={(e) => setItem(i, { icon: e.target.value })} placeholder="◈" style={{ width: 42, padding: '0.3rem', fontSize: '1rem', textAlign: 'center' }} />
            <input className="input-field" value={it.title || ''} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="Safety feature title" style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
            <button onClick={() => removeItem(i)} title="Remove" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          <textarea className="input-field" value={it.body || ''} onChange={(e) => setItem(i, { body: e.target.value })} placeholder="Describe the safety protocol or guarantee" rows={3} style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', resize: 'vertical' }} />
        </div>
      ))}
      <button onClick={addItem} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add Safety Item</button>
    </>
  );
}

// ── PR-C: brochureDownload ───────────────────────────────────────────
function BrochureDownloadPreview({ p }) {
  return (
    <TravelPreviewBox>
      <div style={{ textAlign: 'center' }}>
        <h3 style={{ fontFamily: 'Georgia, serif', margin: '0 0 0.4rem', fontWeight: 400 }}>{p.title || 'Download the Brochure'}</h3>
        {p.subtitle && <div style={{ fontSize: '0.75rem', color: '#6f655c', marginBottom: '0.7rem' }}>{p.subtitle}</div>}
        <button style={{ background: '#b8893b', color: '#fff', padding: '0.55rem 1.2rem', border: 'none', borderRadius: 2, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: '0.7rem', cursor: 'default' }}>
          {p.ctaText || 'Get the Brochure'}
        </button>
        <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', color: p.fileUrl ? '#10b981' : '#f59e0b' }}>
          {p.fileUrl ? '✓ Brochure uploaded — direct download' : 'No brochure uploaded — visitors fill the lead-capture form'}
        </div>
      </div>
    </TravelPreviewBox>
  );
}

function BrochureDownloadEditor({ p, updateProp, field }) {
  const fileRef = React.useRef(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadErr, setUploadErr] = React.useState(null);
  const onPick = () => { setUploadErr(null); fileRef.current?.click(); };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadErr(null);
    try {
      const fd = new FormData();
      fd.append('image', file); // The existing /upload endpoint stores any binary; we re-purpose it for PDFs too.
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
      updateProp('fileUrl', j.url);
    } catch (err) {
      setUploadErr(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  return (
    <>
      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}
      {field('CTA button text', 'ctaText')}
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Brochure file URL</label>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          <input className="input-field" type="text" value={p.fileUrl || ''} onChange={(e) => updateProp('fileUrl', e.target.value || null)} placeholder="https://… or /uploads/…" style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }} />
          <button type="button" onClick={onPick} disabled={uploading} title="Upload a PDF brochure" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.6rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--subtle-bg)', color: 'var(--text-primary)', cursor: uploading ? 'wait' : 'pointer', fontSize: '0.75rem' }}>
            <Upload size={11} /> {uploading ? '…' : 'Upload'}
          </button>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={onFile} style={{ display: 'none' }} />
        </div>
        {uploadErr && <div style={{ marginTop: '0.25rem', fontSize: '0.7rem', color: '#ef4444' }}>{uploadErr}</div>}
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
          If empty, visitors fill the lead-capture form to receive the brochure.
        </div>
      </div>
    </>
  );
}

// ── Travel: registrationForm ─────────────────────────────────────────
// Audience-aware registration form block. Right-rail editor lets the
// admin pick an audience preset (TMC / RFU / Travel Stall / Visa Sure /
// Inquiry / Custom); selecting a preset replaces the current field set
// + submit/thank-you text with that preset's defaults. After that the
// admin can edit individual fields freely. The hidden `audience` field
// is always submitted so lead-routing rules can branch on it.
function RegistrationFormPreview({ p }) {
  const presetLabel = REG_FORM_PRESETS[p.audience]?.label || 'Custom';
  return (
    <TravelPreviewBox>
      <div style={{ maxWidth: 460, margin: '0 auto', textAlign: 'center' }}>
        <h3 style={{ fontFamily: 'Georgia, serif', margin: '0 0 0.3rem', fontWeight: 400 }}>{p.title || 'Register your interest'}</h3>
        {p.subtitle && <div style={{ fontSize: '0.78rem', color: '#6f655c', marginBottom: '0.8rem' }}>{p.subtitle}</div>}
        <div style={{ background: '#fff', borderLeft: '3px solid #b8893b', borderRadius: 3, padding: '1rem', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          {(p.fields || []).map((f, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <label style={{ fontSize: '0.7rem', color: '#6f655c', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                {f.label}{f.required ? ' *' : ''}
              </label>
              <input type={f.type} disabled style={{ padding: '0.5rem 0.6rem', border: '1px solid #d6cebf', borderRadius: 3, background: '#fafaf6', fontSize: '0.8rem' }} />
            </div>
          ))}
          <button style={{ background: '#b8893b', color: '#fff', padding: '0.55rem 1.2rem', border: 'none', borderRadius: 2, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: '0.7rem', cursor: 'default', marginTop: '0.4rem' }}>
            {p.submitText || 'Submit'}
          </button>
        </div>
        <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', color: '#6f655c' }}>
          Audience preset: <strong>{presetLabel}</strong>
        </div>
      </div>
    </TravelPreviewBox>
  );
}

function RegistrationFormEditor({ p, updateProp, field, routingRules }) {
  const presets = listRegFormPresets();
  const onPresetChange = (newAudience) => {
    if (newAudience === p.audience) return;
    if (!window.confirm('Switch audience preset? This will overwrite the current fields, submit text, and thank-you message with the new preset.\n\nClick "Cancel" to keep your custom edits.')) {
      return;
    }
    const next = regFormDefaultPropsFor(newAudience);
    updateProp('audience', next.audience);
    updateProp('subBrand', next.subBrand);
    updateProp('fields', next.fields);
    updateProp('submitText', next.submitText);
    updateProp('thankYouMessage', next.thankYouMessage);
    // Title stays only if currently equal to a preset label — otherwise
    // we don't clobber the operator's custom title.
    const presetTitles = Object.values(REG_FORM_PRESETS).map((v) => v.label.replace(/ —.*/, ''));
    if (!p.title || presetTitles.includes(p.title)) {
      updateProp('title', next.title);
    }
  };
  const redirectValid = !p.successRedirectUrl || /^https?:\/\//i.test(p.successRedirectUrl);

  return (
    <>
      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Audience preset</p>
      <div style={{ marginBottom: '0.75rem' }}>
        <select
          className="input-field"
          value={p.audience || 'inquiry'}
          onChange={(e) => onPresetChange(e.target.value)}
          style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }}
        >
          {presets.map((preset) => (
            <option key={preset.audience} value={preset.audience}>{preset.label}</option>
          ))}
        </select>
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
          {REG_FORM_PRESETS[p.audience]?.description || 'Custom form.'}
        </div>
      </div>

      {field('Section title', 'title')}
      {field('Subtitle', 'subtitle', 'textarea')}

      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.75rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Form fields</p>
      {(p.fields || []).map((f, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.5rem', padding: '0.4rem', background: 'rgba(255,255,255,0.04)', borderRadius: 6 }}>
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <input
              className="input-field"
              placeholder="Field label"
              value={f.label || ''}
              onChange={(e) => { const flds = [...p.fields]; flds[i] = { ...flds[i], label: e.target.value }; updateProp('fields', flds); }}
              style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }}
            />
            <button
              onClick={() => { const flds = p.fields.filter((_, j) => j !== i); updateProp('fields', flds); }}
              title="Remove field"
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}
            ><Trash2 size={12} /></button>
          </div>
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
            <input
              className="input-field"
              placeholder="field_name"
              value={f.name || ''}
              onChange={(e) => { const flds = [...p.fields]; flds[i] = { ...flds[i], name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') }; updateProp('fields', flds); }}
              style={{ flex: 1, padding: '0.25rem', fontSize: '0.75rem' }}
            />
            <select
              className="input-field"
              value={f.type || 'text'}
              onChange={(e) => { const flds = [...p.fields]; flds[i] = { ...flds[i], type: e.target.value }; updateProp('fields', flds); }}
              style={{ width: 90, padding: '0.25rem', fontSize: '0.75rem' }}
            >
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="tel">Phone</option>
              <option value="number">Number</option>
              <option value="url">URL</option>
              <option value="date">Date</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', color: '#94a3b8', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!f.required}
                onChange={(e) => { const flds = [...p.fields]; flds[i] = { ...flds[i], required: e.target.checked }; updateProp('fields', flds); }}
              />
              Req
            </label>
          </div>
        </div>
      ))}
      <button
        onClick={() => updateProp('fields', [...(p.fields || []), { label: 'New field', name: 'field_' + Date.now(), type: 'text', required: false }])}
        style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '0.75rem' }}
      >
        + Add field
      </button>

      {field('Submit button text', 'submitText')}
      {field('Thank-you message', 'thankYouMessage', 'textarea')}

      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.75rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lead routing</p>
      <div style={{ marginBottom: '0.75rem' }}>
        <select
          className="input-field"
          value={p.leadRoutingRuleId || ''}
          onChange={(e) => updateProp('leadRoutingRuleId', e.target.value)}
          style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }}
        >
          <option value="">— Use tenant-level routing —</option>
          {routingRules && routingRules.map((r) => (
            <option key={r.id} value={r.id}>{r.name} (priority {r.priority || 0})</option>
          ))}
        </select>
        <div style={{ marginTop: '0.25rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
          The audience key is also submitted; rules can branch on it.
        </div>
      </div>

      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.5rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Spam protection</p>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!p.enableCaptcha}
            onChange={(e) => updateProp('enableCaptcha', e.target.checked)}
          />
          Enable Cloudflare Turnstile CAPTCHA
        </label>
      </div>

      <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.5rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>After submit</p>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Success redirect URL (optional)</label>
        <input
          className="input-field"
          type="url"
          value={p.successRedirectUrl || ''}
          onChange={(e) => updateProp('successRedirectUrl', e.target.value)}
          placeholder="https://example.com/thanks"
          style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem', borderColor: redirectValid ? undefined : '#ef4444' }}
        />
      </div>
    </>
  );
}

// ── PR-C: contactFooter ──────────────────────────────────────────────
function ContactFooterPreview({ p }) {
  return (
    <TravelPreviewBox dark>
      <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
        {p.brandName && <div style={{ fontFamily: 'Georgia, serif', fontSize: '1rem', color: '#f4efe6', marginBottom: '0.4rem' }}>{p.brandName}</div>}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.78rem' }}>
          <span style={{ color: p.phone ? '#b8893b' : '#6f655c', fontStyle: p.phone ? 'normal' : 'italic' }}>
            {p.phone || '[Add phone]'}
          </span>
          <span style={{ color: '#6f655c' }}>·</span>
          <span style={{ color: p.email ? '#b8893b' : '#6f655c', fontStyle: p.email ? 'normal' : 'italic' }}>
            {p.email || '[Add email]'}
          </span>
        </div>
        {p.ctaText && p.ctaUrl && (
          <button style={{ marginTop: '0.7rem', background: '#b8893b', color: '#fff', padding: '0.45rem 1rem', border: 'none', borderRadius: 2, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: '0.65rem', cursor: 'default' }}>
            {p.ctaText}
          </button>
        )}
      </div>
    </TravelPreviewBox>
  );
}

function ContactFooterEditor({ p, updateProp, field }) {
  return (
    <>
      {field('Brand name', 'brandName')}
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Contact phone</label>
        <input className="input-field" type="tel" value={p.phone || ''} onChange={(e) => updateProp('phone', e.target.value || null)} placeholder="+91 99 12345 67890" style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }} />
        <div style={{ marginTop: '0.2rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>The public page renders this as a tel: link visitors can tap to call.</div>
      </div>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>Contact email</label>
        <input className="input-field" type="email" value={p.email || ''} onChange={(e) => updateProp('email', e.target.value || null)} placeholder="hello@brand.com" style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }} />
      </div>
      {field('CTA button text (optional)', 'ctaText')}
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>CTA URL (optional)</label>
        <input className="input-field" type="url" value={p.ctaUrl || ''} onChange={(e) => updateProp('ctaUrl', e.target.value)} placeholder="https://…" style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem' }} />
      </div>
    </>
  );
}
