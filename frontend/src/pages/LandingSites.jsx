import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PanelTop, Plus, Copy, Trash2, Globe, FileEdit, Sparkles, ExternalLink, LayoutGrid, Megaphone } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { formatPercent } from '../utils/percent';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';

const STATUS_COLORS = {
  DRAFT: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6' },
  PUBLISHED: { bg: 'rgba(16,185,129,0.1)', color: '#10b981' },
  ARCHIVED: { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' },
};

const SECTOR_OPTIONS = [
  { key: 'general', label: 'General', description: 'Generic service or brand landing page' },
  { key: 'travel', label: 'Travel', description: 'Trips, tours, destinations, packages' },
  { key: 'health', label: 'Health', description: 'Campaigns, camps, clinics, enquiries' },
  { key: 'hospital', label: 'Hospital', description: 'Appointments, camp pages, patient leads' },
  { key: 'real_estate', label: 'Real Estate', description: 'Projects, site visits, brochure requests' },
  { key: 'education', label: 'Education', description: 'Admissions, open houses, parent leads' },
  { key: 'law_firm', label: 'Law Firm', description: 'Consultations and case enquiries' },
  { key: 'nonprofit', label: 'Nonprofit', description: 'Donation drives and community campaigns' },
  { key: 'hospitality', label: 'Hospitality', description: 'Bookings, events, venue enquiries' },
  { key: 'retail', label: 'Retail', description: 'Offers, catalogue requests, store visits' },
  { key: 'technology', label: 'Technology', description: 'Demo requests and product trials' },
  { key: 'fitness', label: 'Fitness', description: 'Trials, memberships, assessments' },
  { key: 'finance', label: 'Finance', description: 'Consultations and product enquiries' },
];

function blankBlocks() {
  return [
    { id: `seed-${Date.now()}`, type: 'heading', props: { text: 'Your Headline Here', level: 'h1', align: 'center', color: '#111827' } },
    { id: `seed-${Date.now() + 1}`, type: 'text', props: { text: 'Use the builder to shape this landing site for your sector.', align: 'center', color: '#4b5563', fontSize: '1rem' } },
    { id: `seed-${Date.now() + 2}`, type: 'form', props: { fields: [{ label: 'Name', name: 'name', type: 'text', required: true }, { label: 'Email', name: 'email', type: 'email', required: true }], submitText: 'Submit', thankYouMessage: 'Thank you!', enableCaptcha: false, leadRoutingRuleId: '', successRedirectUrl: '' } },
  ];
}

function buildStarterBlocks({ sectorKey = 'general', campaignName = 'Untitled Landing Site', audience = 'qualified visitors', location = '', isWellness = false }) {
  if (!isWellness) return blankBlocks();
  const eventSummary = [
    'Date: Add the event date',
    'Time: Add the event time',
    location ? `Location: ${location}` : 'Location: Add the venue',
    `Audience: ${audience}`,
  ].join('\n');
  return [
    { id: `seed-${Date.now()}`, type: 'heading', props: { text: campaignName, level: 'h1', align: 'center', color: '#111827' } },
    { id: `seed-${Date.now() + 1}`, type: 'text', props: { text: 'Use this landing page for a camp, consultation day, or community event. Keep the details clear and the registration form easy to complete.', align: 'center', color: '#4b5563', fontSize: '1rem' } },
    { id: `seed-${Date.now() + 2}`, type: 'columns', props: { gap: '24px', columns: [
      { components: [
        { id: `seed-${Date.now() + 3}`, type: 'heading', props: { text: 'Event details', level: 'h3', align: 'left', color: '#111827' } },
        { id: `seed-${Date.now() + 4}`, type: 'text', props: { text: eventSummary, align: 'left', color: '#4b5563', fontSize: '0.98rem' } },
      ] },
      { components: [
        { id: `seed-${Date.now() + 5}`, type: 'form', props: { fields: [
          { label: 'Full name', name: 'name', type: 'text', required: true },
          { label: 'Email address', name: 'email', type: 'email', required: true },
          { label: 'Phone number', name: 'phone', type: 'tel', required: true },
          { label: 'Preferred time', name: 'preferred_time', type: 'text', required: false },
          { label: 'Notes', name: 'message', type: 'text', required: false },
        ], submitText: 'Register Now', thankYouMessage: `Thanks. We have received your registration for ${campaignName}.`, enableCaptcha: false, leadRoutingRuleId: '', successRedirectUrl: '' } },
      ] },
    ] } },
    { id: `seed-${Date.now() + 6}`, type: 'image', props: { src: '', alt: `${sectorKey} campaign image`, maxWidth: '100%' } },
    { id: `seed-${Date.now() + 7}`, type: 'divider', props: { color: '#e5e7eb', margin: '1.5rem' } },
  ];
}

function buildTemplateType(sectorKey) {
  return `generic-site-${sectorKey}-v1`;
}

export default function LandingSites() {
  const notify = useNotify();
  const navigate = useNavigate();
  const auth = useContext(AuthContext) || {};
  const tenantVertical = auth?.user?.tenant?.vertical || auth?.tenant?.vertical || 'generic';
  const isWellnessTenant = tenantVertical === 'wellness';
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const defaultFormState = (wellness = false) => ({
    sectorKey: wellness ? 'wellness' : 'general',
    campaignName: '',
    campaignGoal: '',
    businessName: '',
    audience: '',
    location: '',
    eventDate: '',
    eventTime: '',
    eventLocation: '',
    tone: '',
    ctaText: 'Get Started',
    imageMode: 'auto',
  });
  const [form, setForm] = useState(defaultFormState(isWellnessTenant));

  React.useEffect(() => {
    setForm((current) => ({ ...defaultFormState(isWellnessTenant), ...current }));
  }, [isWellnessTenant]);

  const loadPages = () => {
    setLoading(true);
    fetchApi('/api/landing-sites')
      .then((data) => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.pages) ? data.pages : [];
        setPages(list);
      })
      .catch(() => setPages([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadPages();
  }, []);

  const visiblePages = useMemo(() => {
    return [...pages].sort((a, b) => {
      const rank = (p) => (p.status === 'PUBLISHED' ? 0 : p.status === 'DRAFT' ? 1 : 2);
      return rank(a) - rank(b) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }, [pages]);

  const handleCreateBlank = async () => {
    try {
      const sectorKey = isWellnessTenant ? 'wellness' : 'general';
      const page = await fetchApi('/api/landing-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: isWellnessTenant ? 'Untitled Wellness Event Landing Site' : 'Untitled Landing Site',
          templateType: buildTemplateType(sectorKey),
          content: JSON.stringify(buildStarterBlocks({ sectorKey, campaignName: isWellnessTenant ? 'Untitled Wellness Event' : 'Untitled Landing Site', isWellness: isWellnessTenant, audience: 'qualified visitors' })),
          description: isWellnessTenant ? 'Wellness event landing site' : 'General landing site',
        }),
        silent: true,
      });
      navigate(`/landing-sites/builder/${page.id}`);
    } catch (err) {
      notify.error(err?.message || 'Failed to create landing site');
    }
  };

  const handleGenerate = async () => {
    const sectorKey = form.sectorKey || 'general';
    if (!form.campaignName.trim()) {
      setGenError('Campaign name is required.');
      return;
    }
    if (!form.campaignGoal.trim()) {
      setGenError('Campaign goal is required.');
      return;
    }
    if (!form.audience.trim()) {
      setGenError('Audience is required.');
      return;
    }

    setGenError(null);
    setGenerating(true);
    try {
      const res = await fetchApi('/api/landing-sites/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectorKey,
          campaignName: form.campaignName.trim(),
          campaignGoal: form.campaignGoal.trim(),
          businessName: form.businessName.trim(),
          audience: form.audience.trim(),
          location: form.location.trim(),
          eventDate: form.eventDate.trim(),
          eventTime: form.eventTime.trim(),
          eventLocation: form.eventLocation.trim() || form.location.trim(),
          tone: form.tone.trim(),
          ctaText: form.ctaText.trim(),
          imageMode: form.imageMode,
          autoCreate: true,
        }),
      });
      if (!res?.page?.id) throw new Error('Generation succeeded but no page was returned.');
      if (res.generation?.stub) {
        notify.info('AI generation is in stub mode, so the draft uses deterministic fallback copy.');
      } else if (res.generation?.verdict === 'fallback') {
        notify.info('The generator fell back to a safe draft. Review before publishing.');
      } else {
        notify.success('AI draft created. Review the page before publishing.');
      }
      setShowGenerateModal(false);
      setForm(defaultFormState(isWellnessTenant));
      navigate(`/landing-sites/builder/${res.page.id}?ai=1`);
    } catch (err) {
      if (err?.status === 429 && err?.code === 'LLM_BUDGET_EXCEEDED') {
        setGenError('This tenant has reached its monthly LLM spend cap.');
      } else {
        setGenError(err?.message || 'Generation failed.');
      }
    } finally {
      setGenerating(false);
    }
  };

  const handlePublish = async (page) => {
    try {
      await fetchApi(`/api/landing-pages/${page.id}/${page.status === 'PUBLISHED' ? 'unpublish' : 'publish'}`, { method: 'POST' });
      notify.success(page.status === 'PUBLISHED' ? 'Unpublished.' : 'Published. Public URL is live.');
      loadPages();
    } catch (err) {
      notify.error(err?.message || 'Publish failed.');
    }
  };

  const handleDuplicate = async (id) => {
    try {
      await fetchApi(`/api/landing-pages/${id}/duplicate`, { method: 'POST' });
      loadPages();
    } catch (err) {
      notify.error(err?.message || 'Duplicate failed.');
    }
  };

  const handleDelete = async (page) => {
    const ok = await notify.confirm(`Delete "${page.title}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await fetchApi(`/api/landing-pages/${page.id}`, { method: 'DELETE' });
      loadPages();
    } catch (err) {
      notify.error(err?.message || 'Delete failed.');
    }
  };

  const handleCopyUrl = (page) => {
    const url = `${window.location.origin}/landing-sites/${page.slug}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(page.id);
      setTimeout(() => setCopiedId(null), 1800);
    });
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <PanelTop size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 800 }}>Landing Sites</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Build no-code landing sites for any sector</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button onClick={() => { setShowGenerateModal(true); setGenError(null); }} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Sparkles size={16} /> Generate Landing Site
          </button>
          <button onClick={handleCreateBlank} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 600 }}>
            <Plus size={16} /> Create Blank
          </button>
        </div>
      </header>

      {loading ? (
        <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading...</p>
      ) : visiblePages.length === 0 ? (
        <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
          <LayoutGrid size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ marginBottom: '0.5rem' }}>No landing sites yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>Create a blank site or generate one from a sector brief.</p>
          <button className="btn-primary" onClick={() => setShowGenerateModal(true)}><Plus size={16} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Generate Landing Site</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
          {visiblePages.map((page) => {
            const sc = STATUS_COLORS[page.status] || STATUS_COLORS.DRAFT;
            const convRate = page.visits > 0 ? (page.submissions / page.visits) * 100 : 0;
            return (
              <div key={page.id} className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                      <span style={{ padding: '0.18rem 0.55rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, background: 'rgba(79,70,229,0.12)', color: '#4f46e5' }}>{page.sectorLabel || 'General'}</span>
                      <span style={{ padding: '0.18rem 0.55rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, background: sc.bg, color: sc.color }}>{page.status}</span>
                    </div>
                    <h3 style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: '0.25rem' }}>{page.title}</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.86rem' }}>{page.description || 'No description yet.'}</p>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>{page.visits || 0}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Visits</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>{page.submissions || 0}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Leads</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#10b981' }}>{formatPercent(convRate)}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Conv.</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Link to={`/landing-sites/builder/${page.id}`} className="btn-primary" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', textDecoration: 'none' }}>
                    <FileEdit size={13} /> Edit
                  </Link>
                  <button onClick={() => handlePublish(page)} style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: page.status === 'PUBLISHED' ? '#f59e0b' : '#10b981', cursor: 'pointer' }}>
                    <Globe size={13} /> {page.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                  </button>
                  <button onClick={() => handleDuplicate(page.id)} title="Duplicate" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <Copy size={13} />
                  </button>
                  <button onClick={() => handleDelete(page)} title="Delete" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: '#ef4444', cursor: 'pointer' }}>
                    <Trash2 size={13} />
                  </button>
                </div>

                {page.status === 'PUBLISHED' && (
                  <div style={{ marginTop: '0.25rem', paddingTop: '0.9rem', borderTop: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.45rem' }}>Public Link</div>
                    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
                      <input readOnly value={`${window.location.origin}/landing-sites/${page.slug}`} onClick={(e) => e.target.select()} style={{ flex: 1, fontSize: '0.72rem', padding: '5px 8px', borderRadius: '5px', border: '1px solid var(--border-color)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', minWidth: 0, cursor: 'text' }} />
                      <button onClick={() => handleCopyUrl(page)} title="Copy public URL" style={{ padding: '5px 10px', borderRadius: '5px', border: '1px solid var(--border-color)', background: copiedId === page.id ? '#10b981' : 'none', color: copiedId === page.id ? '#fff' : 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px', fontSize: '0.72rem', fontWeight: 600, flexShrink: 0, transition: 'background 0.2s, color 0.2s' }}>
                        <Copy size={11} /> {copiedId === page.id ? 'Copied!' : 'Copy'}
                      </button>
                      <a href={`${window.location.origin}/landing-sites/${page.slug}`} target="_blank" rel="noreferrer" title="Open public page in new tab" style={{ padding: '5px 8px', borderRadius: '5px', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', textDecoration: 'none', flexShrink: 0 }}>
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showGenerateModal && (
        <div role="dialog" aria-modal="true" aria-labelledby="landing-site-generate-title" style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.5))', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }} onClick={(e) => { if (e.target === e.currentTarget && !generating) setShowGenerateModal(false); }}>
          <div className="card" style={{ padding: '1.75rem', width: 'min(640px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 id="landing-site-generate-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 800, marginBottom: '0.4rem', fontSize: '1.2rem' }}>
              <Megaphone size={20} style={{ color: '#4f46e5' }} /> Generate Landing Site
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.1rem' }}>
              Pick a sector, describe the campaign, and weâ€™ll draft a public landing site you can edit in the builder.
            </p>
            {genError && <div style={{ marginBottom: '1rem', padding: '0.75rem', borderRadius: '8px', background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontSize: '0.85rem' }}>{genError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.9rem' }}>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Sector</span>
                {isWellnessTenant ? (
                  <input className="input-field" value="wellness" readOnly aria-readonly="true" />
                ) : (
                  <select value={form.sectorKey} onChange={(e) => setForm((s) => ({ ...s, sectorKey: e.target.value }))} className="input-field">
                    {SECTOR_OPTIONS.map((sector) => <option key={sector.key} value={sector.key}>{sector.label}</option>)}
                  </select>
                )}
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Campaign name</span>
                <input className="input-field" value={form.campaignName} onChange={(e) => setForm((s) => ({ ...s, campaignName: e.target.value }))} placeholder="Hair Treatment Consultation" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Business name</span>
                <input className="input-field" value={form.businessName} onChange={(e) => setForm((s) => ({ ...s, businessName: e.target.value }))} placeholder="Glow Hair Studio" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Campaign goal</span>
                <input className="input-field" value={form.campaignGoal} onChange={(e) => setForm((s) => ({ ...s, campaignGoal: e.target.value }))} placeholder="collect enquiries" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Audience</span>
                <input className="input-field" value={form.audience} onChange={(e) => setForm((s) => ({ ...s, audience: e.target.value }))} placeholder="people exploring hair treatment options" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Location</span>
                <input className="input-field" value={form.location} onChange={(e) => setForm((s) => ({ ...s, location: e.target.value }))} placeholder="Koramangala" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Event date</span>
                <input className="input-field" value={form.eventDate} onChange={(e) => setForm((s) => ({ ...s, eventDate: e.target.value }))} placeholder="12 August 2026" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Event time</span>
                <input className="input-field" value={form.eventTime} onChange={(e) => setForm((s) => ({ ...s, eventTime: e.target.value }))} placeholder="10:00 AM - 4:00 PM" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Event venue</span>
                <input className="input-field" value={form.eventLocation} onChange={(e) => setForm((s) => ({ ...s, eventLocation: e.target.value }))} placeholder="Main clinic branch" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Tone</span>
                <input className="input-field" value={form.tone} onChange={(e) => setForm((s) => ({ ...s, tone: e.target.value }))} placeholder="calm, professional, and reassuring" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>CTA label</span>
                <input className="input-field" value={form.ctaText} onChange={(e) => setForm((s) => ({ ...s, ctaText: e.target.value }))} placeholder="Get Started" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Image mode</span>
                <select value={form.imageMode} onChange={(e) => setForm((s) => ({ ...s, imageMode: e.target.value }))} className="input-field">
                  <option value="auto">Auto images when available</option>
                  <option value="manual">Manual images only</option>
                </select>
              </label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '1.2rem' }}>
              <button type="button" onClick={() => setShowGenerateModal(false)} style={{ padding: '0.55rem 1rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)', cursor: 'pointer' }} disabled={generating}>Cancel</button>
              <button type="button" onClick={handleGenerate} className="btn-primary" disabled={generating} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Sparkles size={16} /> {generating ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



