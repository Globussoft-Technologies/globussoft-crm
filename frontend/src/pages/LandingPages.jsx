import React, { useState, useEffect } from 'react';
import { PanelTop, Plus, Copy, Trash2, Globe, FileEdit, BarChart3, Star, Sparkles, AlertCircle } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { formatPercent } from '../utils/percent';
import { useNotify } from '../utils/notify';
import { Link, useNavigate } from 'react-router-dom';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../components/wellness/DateRangeFilter';

const STATUS_COLORS = { DRAFT: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6' }, PUBLISHED: { bg: 'rgba(16,185,129,0.1)', color: '#10b981' }, ARCHIVED: { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' } };

export default function LandingPages() {
  const notify = useNotify();
  const [pages, setPages] = useState([]);
  const [templates, setTemplates] = useState([]);
  // Phase D1 — premium template catalogue (educational-trip-v1 etc.).
  // Surfaced in the "Choose a Template" picker alongside the legacy
  // block-based templates. Entries with status="ready" create through
  // the template renderer; status="stub" entries delegate to
  // educational-trip-v1 today (D3 will fork them).
  const [premiumTemplates, setPremiumTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  // PR-B — AI Generate modal state.
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [genForm, setGenForm] = useState({
    destination: '',
    durationDays: 7,
    audience: '',
    subBrand: 'tmc',
    // Phase D1 bridge — premium routes the LLM-generated blocks
    // through the educational-trip-v1 template mapper so the page
    // renders at the premium-microsite parity (~98%). Legacy keeps
    // the existing PR-B block-based behaviour for operators who want
    // per-section composition freedom.
    style: 'premium',
  });
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const navigate = useNavigate();
  const [dateFilter, setDateFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(dateFilter);
  // Filter by createdAt so users can scope to "pages created this month" etc.
  // The analytics (visits/leads/conv) shown on each card are still all-time;
  // a per-page analytics-window filter belongs on the page-detail screen.
  const visiblePages = (rangeStart && rangeEnd)
    ? pages.filter((p) => {
        const ts = new Date(p.createdAt).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : pages;

  const loadPages = () => {
    setLoading(true);
    fetchApi('/api/landing-pages').then(data => { setPages(Array.isArray(data) ? data : []); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => {
    loadPages();
    fetchApi('/api/landing-pages/templates/list').then(data => setTemplates(data || [])).catch(() => {});
    // Phase D1 — premium template catalogue (educational-trip-v1 etc.).
    fetchApi('/api/landing-pages/template-catalogue')
      .then(data => setPremiumTemplates(Array.isArray(data?.templates) ? data.templates : []))
      .catch(() => setPremiumTemplates([]));
  }, []);

  // Map a premium template's `family` to a sensible default audience +
  // sub-brand so the destination-input modal arrives pre-configured for the
  // operator. The user fills destination + duration; the rest is inferred.
  const familyToAudience = {
    educational: 'School students (Grades 6-12)',
    religious: 'Pilgrims and families',
    family: 'Families and leisure travellers',
    luxury: 'Premium and boutique travellers',
  };
  const familyToSubBrand = {
    educational: 'tmc',
    religious: 'rfu',
    family: 'travelstall',
    luxury: 'travelstall',
  };

  const handleCreate = async (templateType) => {
    // Premium templates ALWAYS route through AI generation (2026-06-23).
    // Pre-2026-06-23 the picker seeded a static [REVIEW] stub via
    // premium.defaultContent; that left every slot showing literal
    // "[REVIEW] …" strings and the operator had to manually replace
    // every line. The new flow opens the destination-input modal with
    // the template's family + audience pre-filled, then runs the
    // /generate-from-destination LLM path so the operator lands on a
    // populated draft.
    const premium = premiumTemplates.find(t => t.id === templateType);
    if (premium) {
      const family = (premium.family || '').toLowerCase();
      setGenForm({
        destination: '',
        durationDays: 7,
        audience: familyToAudience[family] || 'Travellers',
        subBrand: familyToSubBrand[family] || 'travelstall',
        style: 'premium',
      });
      setGenError(null);
      setShowTemplatePicker(false);
      setShowGenerateModal(true);
      return;
    }
    try {
      const tmpl = templates.find(t => t.id === templateType);
      // #377: Blank template was rendering an empty canvas with no editable
      // region, leaving users with no way to add sections. Seed a single
      // empty heading + text placeholder so the editor surfaces a section
      // the user can immediately edit or replace.
      const blankSeed = [
        { id: `seed-${Date.now()}`, type: 'heading', props: { text: 'Your Headline Here', level: 'h1', align: 'center', color: '#1e293b' } },
        { id: `seed-${Date.now() + 1}`, type: 'text', props: { text: 'Click any block to edit, or pick a component from the left panel to add more.', align: 'center', color: '#64748b', fontSize: '1rem' } },
      ];
      const seedContent = tmpl ? JSON.stringify(tmpl.content) : JSON.stringify(blankSeed);
      const page = await fetchApi('/api/landing-pages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: tmpl?.name || 'Untitled Page', templateType, content: seedContent }),
        silent: true,
      });
      setShowTemplatePicker(false);
      navigate(`/landing-pages/builder/${page.id}`);
    } catch (err) {
      // 409 with existingId → server says a Draft with this title already
      // exists. Offer to open it instead of dead-ending in a generic error.
      // (Pre-fix: the auto-toast showed the server msg AND the catch
      // showed "Failed to create page" → two stacked error toasts with no
      // recovery affordance — the screenshot the user reported.)
      if (err?.status === 409 && err?.data?.existingId) {
        const ok = await notify.confirm(
          `${err.message}\n\nOpen the existing draft?`,
        );
        if (ok) navigate(`/landing-pages/builder/${err.data.existingId}`);
        return;
      }
      notify.error(err?.message || 'Failed to create page');
    }
  };

  const handlePublish = async (id, action) => {
    // Single-page-live workflow (post-merge): publishing also features
    // the page so /trips resolves to it. If another page in the same
    // (tenant, subBrand) scope is currently featured, confirm with the
    // operator first — that page will be silently demoted by the
    // backend's transactional swap. Skip the confirm on unpublish.
    if (action === 'publish') {
      const target = pages.find((p) => p.id === id);
      const currentLive = pages.find(
        (p) => p.isFeatured && p.id !== id && (p.subBrand ?? null) === (target?.subBrand ?? null),
      );
      if (currentLive) {
        const ok = await notify.confirm(
          `"${currentLive.title}" is currently live at /trips. Publishing "${target?.title || 'this page'}" will replace it.\n\nProceed?`,
        );
        if (!ok) return;
      }
    }
    try {
      await fetchApi(`/api/landing-pages/${id}/${action}`, { method: 'POST' });
      if (action === 'publish') notify.success('Published — page is live at /trips.');
      else notify.success('Unpublished — page is no longer live.');
      loadPages();
    } catch (err) {
      // Publish gate (travel pages with missing content) returns 409 +
      // a structured issues array. Route the operator into the builder
      // where the same gate UI surfaces each issue with a click-to-jump
      // affordance. Other errors (auth / 500) surface as toasts.
      if (err?.status === 409 && err?.code === 'PUBLISH_GATE_FAILED') {
        const issueCount = Array.isArray(err.data?.issues) ? err.data.issues.length : 0;
        const ok = await notify.confirm(
          `Publish blocked — page is not ready (${issueCount} issue${issueCount === 1 ? '' : 's'} to fix).\n\nOpen the builder to see what's missing?`
        );
        if (ok) navigate(`/landing-pages/builder/${id}`);
      } else {
        notify.error(err?.message || 'Publish failed.');
      }
    }
  };

  const handleDuplicate = async (id) => {
    await fetchApi(`/api/landing-pages/${id}/duplicate`, { method: 'POST' });
    loadPages();
  };

  // handleFeature / handleUnfeature removed. The /publish endpoint now
  // also features the page (and the /unpublish endpoint already
  // un-features), so the Feature/Unfeature buttons collapsed into the
  // single Publish/Unpublish button. See handlePublish above for the
  // sibling-swap confirm.

  // PR-B — AI Generate flow. Posts to /generate-from-destination with
  // autoCreate=true so the backend creates the DRAFT row + returns its
  // id, then navigate straight to /landing-pages/builder/<id>?ai=1.
  // The ?ai=1 query lets the builder show a one-time "AI draft — review
  // before publishing" banner.
  const handleGenerate = async () => {
    const dest = genForm.destination.trim();
    const days = parseInt(genForm.durationDays, 10);
    const aud = genForm.audience.trim();
    const sb = genForm.subBrand || null;
    if (!dest) {
      setGenError('Destination is required.');
      return;
    }
    if (!Number.isFinite(days) || days < 1 || days > 60) {
      setGenError('Duration must be between 1 and 60 days.');
      return;
    }
    if (!aud) {
      setGenError('Audience is required (e.g. "Pilgrims", "Honeymooners", "School students").');
      return;
    }
    setGenError(null);
    setGenerating(true);
    try {
      const res = await fetchApi('/api/landing-pages/generate-from-destination', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: dest,
          durationDays: days,
          audience: aud,
          subBrand: sb,
          autoCreate: true,
          style: genForm.style || 'premium',
        }),
      });
      if (!res?.page?.id) {
        throw new Error('Generation succeeded but no page was returned.');
      }
      // Surface stub-mode + scrubbed verdicts to the operator so they
      // know whether the page is real-mode AI or a placeholder.
      if (res.generation?.stub) {
        notify.info('AI generation is in stub mode (Gemini key not set on this tenant). Draft contains [REVIEW] placeholders.');
      } else if (res.generation?.verdict === 'fallback') {
        notify.info('AI content failed validation; a deterministic placeholder draft was used. Edit before publishing.');
      } else if (res.generation?.verdict === 'scrubbed') {
        notify.info('AI content was generated but some fields were scrubbed by the safety guard. Review carefully.');
      } else {
        notify.success('AI draft created. Review every section before publishing.');
      }
      setShowGenerateModal(false);
      setGenForm({ destination: '', durationDays: 7, audience: '', subBrand: 'tmc', style: 'premium' });
      navigate(`/landing-pages/builder/${res.page.id}?ai=1`);
    } catch (err) {
      if (err?.status === 429 && err?.code === 'LLM_BUDGET_EXCEEDED') {
        setGenError("This tenant has reached its monthly LLM spend cap. Try again next month or raise the cap in tenant settings.");
      } else {
        setGenError(err?.message || 'Generation failed. Please try again.');
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (id) => {
    // #452: name + status-aware confirm dialog so the user can tell
    // *which* draft they're deleting from a list of similar names, and
    // sees a stronger warning when deleting a published page (public URL
    // goes down + analytics/submissions are no longer reachable).
    const page = pages.find(p => p.id === id) || {};
    const name = page.title || `page ${id}`;
    const isPublished = page.status === 'PUBLISHED';
    const submissionsLine = page.submissions > 0
      ? `\n\nThis page has ${page.submissions} submission${page.submissions === 1 ? '' : 's'} (kept in the contacts/deals tables; only the page record is removed).`
      : '';
    const publishedLine = isPublished
      ? `\n\n⚠ This page is currently PUBLISHED. Deleting takes the public URL /p/${page.slug} offline.`
      : '';
    const msg = `Delete "${name}"?${publishedLine}${submissionsLine}\n\nThis cannot be undone.`;
    if (!await notify.confirm(msg)) return;
    await fetchApi(`/api/landing-pages/${id}`, { method: 'DELETE' });
    loadPages();
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <PanelTop size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Landing Pages</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Build no-code landing pages to capture leads</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          {/* PR-B — AI generator. Operator picks destination + duration +
              audience + sub-brand; backend generates a DRAFT block array
              and we navigate straight to the builder. Pricing,
              testimonials, images stay manual. */}
          <button
            onClick={() => { setShowGenerateModal(true); setGenError(null); }}
            title="Generate a destination landing-page draft with AI"
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.55rem 1rem', borderRadius: 8,
              border: '1px solid #b8893b', background: 'rgba(184,137,59,0.08)',
              color: '#b8893b', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
            }}
          >
            <Sparkles size={16} /> Generate Destination Page
          </button>
          <button className="btn-primary" onClick={() => setShowTemplatePicker(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Create Page
          </button>
        </div>
      </header>

      {loading ? <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading...</p> : pages.length === 0 ? (
        <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
          <PanelTop size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ marginBottom: '0.5rem' }}>No landing pages yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>Create your first landing page from a template to start capturing leads.</p>
          <button className="btn-primary" onClick={() => setShowTemplatePicker(true)}><Plus size={16} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Create Page</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <DateRangeFilter value={dateFilter} onChange={setDateFilter} label="Filter by created date" />
            {visiblePages.length !== pages.length && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {visiblePages.length} of {pages.length}
              </span>
            )}
          </div>
          {visiblePages.length === 0 ? (
            <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              No pages in the selected range.
            </div>
          ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
          {visiblePages.map(page => {
            const sc = STATUS_COLORS[page.status] || STATUS_COLORS.DRAFT;
            // #639 — keep the raw numeric so formatPercent renders consistently
            // (1-decimal "0.0%") on list, detail, and CSV. Pre-fix the list used
            // an integer 0 fallback that rendered as bare "0%".
            const convRate = page.visits > 0 ? (page.submissions / page.visits) * 100 : 0;
            return (
              <div key={page.id} className="card" style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', gap: '0.5rem' }}>
                  <h3 style={{ fontWeight: '600', fontSize: '1.1rem', flex: 1 }}>{page.title}</h3>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {page.isFeatured && (
                      <span
                        title="This page is currently shown on /trips"
                        style={{
                          padding: '0.2rem 0.55rem',
                          borderRadius: '4px',
                          fontSize: '0.7rem',
                          fontWeight: '600',
                          background: 'rgba(184, 137, 59, 0.15)',
                          color: '#b8893b',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                      >
                        <Star size={11} fill="currentColor" /> Featured
                      </span>
                    )}
                    <span style={{ padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: '600', background: sc.bg, color: sc.color }}>{page.status}</span>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600' }}>{page.visits}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Visits</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600' }}>{page.submissions}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Leads</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600', color: '#10b981' }}>{formatPercent(convRate)}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Conv.</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Link to={`/landing-pages/builder/${page.id}`} className="btn-primary" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', textDecoration: 'none' }}>
                    <FileEdit size={13} /> Edit
                  </Link>
                  {/* View button removed — the hardcoded :5173→:5000 host
                      swap only worked on the default Vite dev port, so the
                      button opened a blank SPA route in production and on
                      any non-default dev port. The Preview action inside
                      the Edit builder already serves the same need
                      (renders the live page via /:id/preview without
                      leaving the admin shell), and the public URL is
                      always reachable directly at <host>/p/<slug>. */}
                  {/* Single Publish/Unpublish button. The backend's
                      /publish endpoint also features the page on /trips
                      (auto-demoting any sibling currently featured in
                      the same tenant + subBrand scope), so one button
                      covers both make-it-live and put-it-on-/trips in
                      lockstep — matching the operator's actual
                      single-page-live workflow. */}
                  <button
                    onClick={() => handlePublish(page.id, page.status === 'PUBLISHED' ? 'unpublish' : 'publish')}
                    title={page.status === 'PUBLISHED' ? 'Take this page down — /trips will no longer serve it' : 'Publish this page and make it live at /trips'}
                    style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: page.status === 'PUBLISHED' ? '#f59e0b' : '#10b981', cursor: 'pointer' }}
                  >
                    <Globe size={13} /> {page.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                  </button>
                  <button onClick={() => handleDuplicate(page.id)} style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <Copy size={13} />
                  </button>
                  <button onClick={() => handleDelete(page.id)} style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: '#ef4444', cursor: 'pointer' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
          )}
        </>
      )}

      {/* PR-B — Generate Destination Landing Page modal. Posts the
          inputs to /api/landing-pages/generate-from-destination with
          autoCreate=true; navigates to the builder on success. */}
      {showGenerateModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="generate-modal-title"
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.5))', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
          onClick={(e) => { if (e.target === e.currentTarget && !generating) setShowGenerateModal(false); }}
        >
          <div className="card" style={{ padding: '1.75rem', width: 'min(540px, 92vw)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 id="generate-modal-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, marginBottom: '0.4rem', fontSize: '1.2rem' }}>
              <Sparkles size={20} style={{ color: '#b8893b' }} /> Generate Destination Landing Page
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.1rem' }}>
              AI will draft hero copy, highlights, city descriptions, inclusions, itinerary, FAQs, and SEO meta. You review and edit every section before publishing.
            </p>

            {/* Strict rules — operator needs to see what AI WILL and WILL
                NOT do BEFORE the generation runs, so expectations are set
                upfront. The backend guardrail enforces these rules but
                the warning is part of the UX contract. */}
            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, padding: '0.6rem 0.8rem', marginBottom: '1.25rem', fontSize: '0.78rem', color: 'var(--text-primary)', display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
              <AlertCircle size={14} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>AI never generates:</strong> pricing values, testimonials, ratings, discounts, vendor names, or image URLs. You add those manually in the builder.
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginBottom: '1rem' }}>
              <div>
                <label htmlFor="gen-destination" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Destination *</label>
                <input
                  id="gen-destination"
                  type="text"
                  value={genForm.destination}
                  onChange={(e) => setGenForm((f) => ({ ...f, destination: e.target.value }))}
                  placeholder="e.g. Umrah, Bali, Japan, Switzerland"
                  maxLength={80}
                  disabled={generating}
                  className="input-field"
                  style={{ width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.9rem' }}
                />
              </div>
              <div>
                <label htmlFor="gen-duration" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Duration (days) *</label>
                <input
                  id="gen-duration"
                  type="number"
                  min={1}
                  max={60}
                  value={genForm.durationDays}
                  onChange={(e) => setGenForm((f) => ({ ...f, durationDays: e.target.value }))}
                  disabled={generating}
                  className="input-field"
                  style={{ width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.9rem' }}
                />
              </div>
              <div>
                <label htmlFor="gen-audience" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Audience *</label>
                <input
                  id="gen-audience"
                  type="text"
                  value={genForm.audience}
                  onChange={(e) => setGenForm((f) => ({ ...f, audience: e.target.value }))}
                  placeholder='e.g. "Pilgrims", "Honeymooners", "School students Grades 6-12"'
                  maxLength={200}
                  disabled={generating}
                  className="input-field"
                  style={{ width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.9rem' }}
                />
              </div>
              <div>
                <label htmlFor="gen-subbrand" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Sub-brand</label>
                <select
                  id="gen-subbrand"
                  value={genForm.subBrand}
                  onChange={(e) => setGenForm((f) => ({ ...f, subBrand: e.target.value }))}
                  disabled={generating}
                  className="input-field"
                  style={{ width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.9rem' }}
                >
                  <option value="tmc">TMC (school trips)</option>
                  <option value="rfu">RFU (Umrah)</option>
                  <option value="travelstall">Travel Stall (family / holidays)</option>
                  <option value="visasure">Visa Sure</option>
                </select>
              </div>
            </div>

            {/* Phase D1 — Style picker. Premium routes the LLM output
                through the educational-trip-v1 bridge so the page
                opens in template-editor mode at premium parity (~98%).
                Legacy keeps the existing block-based behaviour (~85%
                parity) for operators who want per-section composition. */}
            <fieldset style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.7rem 0.9rem', margin: '0.5rem 0 1rem' }}>
              <legend style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', padding: '0 0.4rem', fontWeight: 600 }}>Style</legend>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.35rem 0', cursor: generating ? 'not-allowed' : 'pointer' }}>
                <input
                  type="radio"
                  name="genStyle"
                  value="premium"
                  checked={genForm.style === 'premium'}
                  onChange={() => setGenForm((f) => ({ ...f, style: 'premium' }))}
                  disabled={generating}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.88rem', fontWeight: 600 }}>
                    <Sparkles size={13} style={{ color: '#b8893b' }} /> Premium template <span style={{ fontSize: '0.7rem', color: '#b8893b', background: 'rgba(184,137,59,0.1)', padding: '0.1rem 0.4rem', borderRadius: 3, marginLeft: '0.25rem', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 700 }}>Recommended</span>
                  </span>
                  <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.2rem', lineHeight: 1.45 }}>
                    AI fills hero copy, benefit cards, cultural flip cards, safety features, inclusions, and FAQ
                    into the <code style={{ background: 'var(--subtle-bg)', padding: '0 0.25rem', borderRadius: 3 }}>educational-trip-v1</code> template.
                    Premium microsite layout with kanji watermarks, photo marquee, dark safety section.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.35rem 0', cursor: generating ? 'not-allowed' : 'pointer' }}>
                <input
                  type="radio"
                  name="genStyle"
                  value="legacy"
                  checked={genForm.style === 'legacy'}
                  onChange={() => setGenForm((f) => ({ ...f, style: 'legacy' }))}
                  disabled={generating}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                    Block-based (legacy)
                  </span>
                  <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.2rem', lineHeight: 1.45 }}>
                    AI emits the 9-block array (<code style={{ background: 'var(--subtle-bg)', padding: '0 0.25rem', borderRadius: 3 }}>travel_destination</code>). Builder opens
                    with the Components palette for per-section freedom. Pick this if you want to add or
                    reorder sections manually.
                  </span>
                </span>
              </label>
            </fieldset>

            {genError && (
              <div role="alert" style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', padding: '0.55rem 0.75rem', borderRadius: 6, marginBottom: '0.9rem', fontSize: '0.82rem', display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{genError}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={() => { if (!generating) setShowGenerateModal(false); }}
                disabled={generating}
                style={{ padding: '0.55rem 1rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', cursor: generating ? 'not-allowed' : 'pointer', fontSize: '0.85rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                style={{ padding: '0.55rem 1.1rem', borderRadius: 6, border: 'none', background: '#b8893b', color: '#fff', cursor: generating ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
              >
                <Sparkles size={14} /> {generating ? 'Generating…' : 'Generate Draft'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template Picker Modal */}
      {showTemplatePicker && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div className="card" style={{ padding: '2rem', width: '780px', maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }}>
            <h3 style={{ fontWeight: 'bold', marginBottom: '0.4rem', fontSize: '1.25rem' }}>Choose a Template</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
              Premium travel templates ship a curated layout — you only edit content slots.
              Block templates give per-section composition freedom.
            </p>

            {/* Phase D1 — premium travel templates */}
            {premiumTemplates.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.65rem' }}>
                  <Sparkles size={14} style={{ color: '#b8893b' }} />
                  <h4 style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>
                    Premium Travel Templates
                  </h4>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                  {premiumTemplates.map(t => {
                    const isStub = t.status === 'stub';
                    return (
                      <div
                        key={t.id}
                        onClick={() => handleCreate(t.id)}
                        className="card"
                        style={{
                          padding: '1.1rem',
                          cursor: 'pointer',
                          border: '2px solid transparent',
                          background: 'linear-gradient(135deg, rgba(184,137,59,0.08), rgba(192,57,43,0.04))',
                          transition: 'all 0.2s',
                          position: 'relative',
                        }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = '#b8893b'}
                        onMouseLeave={e => e.currentTarget.style.borderColor = 'transparent'}
                      >
                        <div style={{ width: '100%', height: '70px', background: 'linear-gradient(135deg, #b8893b, #c0392b)', borderRadius: '6px', marginBottom: '0.7rem', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                          <PanelTop size={28} style={{ color: '#fff', opacity: 0.85 }} />
                          {isStub && (
                            <span style={{ position: 'absolute', top: '0.35rem', right: '0.35rem', fontSize: '0.55rem', letterSpacing: '0.1em', textTransform: 'uppercase', background: 'rgba(0,0,0,0.4)', color: '#fff', padding: '0.15rem 0.4rem', borderRadius: 3, fontWeight: 700 }}>
                              Coming soon
                            </span>
                          )}
                        </div>
                        <h4 style={{ fontWeight: 600, marginBottom: '0.25rem', fontSize: '0.95rem' }}>{t.title}</h4>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: 0, lineHeight: 1.45 }}>{t.description}</p>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Legacy block-based templates */}
            <h4 style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.65rem' }}>
              Block Templates
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              {templates.map(t => (
                <div key={t.id} onClick={() => handleCreate(t.id)} className="card" style={{ padding: '1.25rem', cursor: 'pointer', border: '2px solid transparent', transition: 'all 0.2s' }} onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-color)'} onMouseLeave={e => e.currentTarget.style.borderColor = 'transparent'}>
                  <div style={{ width: '100%', height: '80px', background: 'var(--subtle-bg)', borderRadius: '6px', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <PanelTop size={32} style={{ color: 'var(--text-secondary)', opacity: 0.3 }} />
                  </div>
                  <h4 style={{ fontWeight: '600', marginBottom: '0.25rem' }}>{t.name}</h4>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t.description}</p>
                </div>
              ))}
              <div onClick={() => handleCreate('blank')} className="card" style={{ padding: '1.25rem', cursor: 'pointer', border: '2px dashed var(--border-color)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '150px' }}>
                <Plus size={32} style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }} />
                <h4 style={{ fontWeight: '600' }}>Blank Page</h4>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Start from scratch</p>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
              <button onClick={() => setShowTemplatePicker(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
