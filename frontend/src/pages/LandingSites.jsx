import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';

import { Link, useNavigate } from 'react-router-dom';

import { PanelTop, Plus, Copy, Trash2, Globe, FileEdit, Sparkles, ExternalLink, LayoutGrid, Megaphone } from 'lucide-react';

import { fetchApi } from '../utils/api';

import { formatPercent } from '../utils/percent';

import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../components/wellness/DateRangeFilter';

import { useNotify } from '../utils/notify';

import { AuthContext } from '../App';



const STATUS_COLORS = {

  DRAFT: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6' },

  PUBLISHED: { bg: 'rgba(16,185,129,0.1)', color: '#10b981' },

  ARCHIVED: { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' },

};

function friendlyAiError(rawError) {

  if (!rawError) return null;

  const m = String(rawError).toLowerCase();

  if (/(?:gemini).*limit has been exhausted|quota exceeded|exceeded.*quota|rate limit|too many requests|resource[_ -]?exhausted/.test(m)) {

    return "Gemini limit has been exhausted. Please try again later.";

  }

  return null;

}



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



function buildTemplateType(sectorKey) {

  return `generic-site-${sectorKey}-v1`;

}

const EVENT_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function normalizeDateInputValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';

  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-');
}

function normalizeTimeInputValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{2}:\d{2}$/.test(text)) return text;

  const rangeMatch = text.match(/^(.+?)(?:\s*-\s*.+)?$/);
  const candidate = String(rangeMatch?.[1] || text).trim();
  const ampmMatch = candidate.match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (ampmMatch) {
    let hour = Number(ampmMatch[1]);
    const minute = Number(ampmMatch[2] || '0');
    const suffix = ampmMatch[3].toUpperCase();
    if (suffix === 'PM' && hour !== 12) hour += 12;
    if (suffix === 'AM' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  return '';
}

function formatDateForPrompt(value) {
  const normalized = normalizeDateInputValue(value);
  if (!normalized) return String(value || '').trim();

  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return EVENT_DATE_FORMATTER.format(date);
}

function formatTimeForPrompt(value) {
  const normalized = normalizeTimeInputValue(value);
  if (!normalized) return String(value || '').trim();

  const [hourText, minuteText] = normalized.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatLocalDateValue(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatLocalTimeValue(date) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':');
}

function parseLocalDateTime(dateValue, timeValue) {
  const normalizedDate = normalizeDateInputValue(dateValue);
  const normalizedTime = normalizeTimeInputValue(timeValue);
  if (!normalizedDate || !normalizedTime) return null;

  const [year, month, day] = normalizedDate.split('-').map(Number);
  const [hour, minute] = normalizedTime.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function isPastEventSlot(dateValue, timeValue, now = new Date()) {
  const selected = parseLocalDateTime(dateValue, timeValue);
  if (!selected) return false;
  return selected.getTime() < now.getTime();
}

function getEventSlotError(dateValue, timeValue, now = new Date()) {
  const normalizedDate = normalizeDateInputValue(dateValue);
  const normalizedTime = normalizeTimeInputValue(timeValue);

  if (normalizedDate && normalizedDate < formatLocalDateValue(now)) {
    return 'Event date cannot be in the past.';
  }

  if (normalizedDate && normalizedTime && isPastEventSlot(normalizedDate, normalizedTime, now)) {
    return normalizedDate === formatLocalDateValue(now)
      ? 'Event time cannot be earlier than the current time.'
      : 'Event date and time cannot be in the past.';
  }

  return null;
}

function useDocumentTheme() {
  const [theme, setTheme] = useState(() => (
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark'
      : 'light'
  ));

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const root = document.documentElement;
    const updateTheme = () => {
      setTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    };

    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    return () => observer.disconnect();
  }, []);

  return theme;
}



export default function LandingSites() {

  const notify = useNotify();

  const navigate = useNavigate();

  const auth = useContext(AuthContext) || {};

  const tenantVertical = auth?.user?.tenant?.vertical || auth?.tenant?.vertical || 'generic';

  const isWellnessTenant = tenantVertical === 'wellness';
  const themeName = useDocumentTheme();
  const isDarkTheme = themeName === 'dark';
  const [clockNow, setClockNow] = useState(() => Date.now());
  const now = new Date(clockNow);
  const todayDateValue = formatLocalDateValue(now);
  const todayTimeValue = formatLocalTimeValue(now);

  const [pages, setPages] = useState([]);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [pageIndex, setPageIndex] = useState(1);

  const [dateFilter, setDateFilter] = useState(EMPTY_DATE_FILTER);

  const [showGenerateModal, setShowGenerateModal] = useState(false);

  const [generating, setGenerating] = useState(false);

  const [genError, setGenError] = useState(null);

  const [copiedId, setCopiedId] = useState(null);
  const [pinnedPage, setPinnedPage] = useState(null);
  const scrollContainerRef = useRef(null);
  const sentinelRef = useRef(null);
  const requestSeqRef = useRef(0);
  const PAGE_SIZE = 12;
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
  const liveEventSlotError = getEventSlotError(form.eventDate, form.eventTime, now);
  const libraryShellStyle = useMemo(() => ({
    padding: '1.4rem',
    border: isDarkTheme ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(200,154,78,0.16)',
    background: isDarkTheme
      ? 'linear-gradient(180deg, rgba(16, 19, 25, 0.96), rgba(10, 12, 16, 0.92))'
      : 'linear-gradient(180deg, rgba(255,255,255,0.66), rgba(255,255,255,0.38))',
    boxShadow: isDarkTheme ? '0 22px 60px rgba(0, 0, 0, 0.46)' : '0 18px 48px rgba(25, 28, 33, 0.08)',
    borderRadius: '20px',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  }), [isDarkTheme]);
  const libraryBadgeStyle = useMemo(() => ({
    width: '38px',
    height: '38px',
    borderRadius: '12px',
    display: 'grid',
    placeItems: 'center',
    background: isDarkTheme ? 'rgba(200,154,78,0.14)' : 'rgba(200,154,78,0.12)',
    color: '#b8893b',
    border: isDarkTheme ? '1px solid rgba(200,154,78,0.14)' : 'none',
  }), [isDarkTheme]);
  const emptyStateStyle = useMemo(() => ({
    padding: '4rem',
    textAlign: 'center',
    background: isDarkTheme ? 'rgba(15, 18, 24, 0.88)' : 'rgba(255,255,255,0.55)',
    border: isDarkTheme ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(200,154,78,0.12)',
  }), [isDarkTheme]);



  React.useEffect(() => {

    setForm((current) => ({ ...defaultFormState(isWellnessTenant), ...current }));

  }, [isWellnessTenant]);

  React.useEffect(() => {
    if (!showGenerateModal) return undefined;

    const syncClock = () => setClockNow(Date.now());
    syncClock();

    const timerId = window.setInterval(syncClock, 1000);
    return () => window.clearInterval(timerId);
  }, [showGenerateModal]);

  const [rangeStart, rangeEnd] = resolveDateRange(dateFilter);

  const loadPages = async ({ reset = false, nextPage = 1 } = {}) => {
    const requestId = ++requestSeqRef.current;

    if (reset) {
      setLoading(true);
      setLoadingMore(false);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: String(PAGE_SIZE),
      });
      if (rangeStart) params.set('createdAfter', rangeStart.toISOString());
      if (rangeEnd) params.set('createdBefore', rangeEnd.toISOString());

      const data = await fetchApi(`/api/landing-sites?${params.toString()}`);
      if (requestId !== requestSeqRef.current) return;

      const list = Array.isArray(data) ? data : Array.isArray(data?.pages) ? data.pages : [];
      const pinned = !Array.isArray(data) && data?.pinnedPage ? data.pinnedPage : null;
      const dedupe = (items) => Array.from(new Map(items.map((item) => [item.id, item])).values());

      setPages((current) => (reset ? list : dedupe([...current, ...list])));
      setPinnedPage(pinned);
      setHasMore(typeof data?.hasMore === 'boolean' ? data.hasMore : list.length === PAGE_SIZE);
      setPageIndex(nextPage);
    } catch {
      if (requestId !== requestSeqRef.current) return;
      if (reset) {
        setPages([]);
        setPinnedPage(null);
      }
      setHasMore(false);
    } finally {
      if (requestId === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    setPages([]);
    setPinnedPage(null);
    setHasMore(true);
    setPageIndex(1);
    loadPages({ reset: true, nextPage: 1 });
    // `loadPages` intentionally depends on the current date filter and tenant
    // vertical so the infinite list resets when the wellness date range or
    // workspace scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFilter, isWellnessTenant]);

  const currentPublishedLandingSite = useMemo(
    () => pinnedPage || pages.find((p) => p.status === 'PUBLISHED') || null,
    [pages, pinnedPage],
  );

  const visiblePages = useMemo(() => {

    const mergedPages = pinnedPage
      ? [pinnedPage, ...pages.filter((p) => p.id !== pinnedPage.id)]
      : pages;

    const filteredPages = (rangeStart && rangeEnd)
      ? mergedPages.filter((p) => {
        const ts = new Date(p.createdAt).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
      : mergedPages;

    return [...filteredPages].sort((a, b) => {

      const rank = (p) => (p.status === 'PUBLISHED' ? 0 : p.status === 'DRAFT' ? 1 : 2);

      const sortStamp = (p) => new Date(p.publishedAt || p.updatedAt || p.createdAt || 0).getTime();

      return rank(a) - rank(b) || sortStamp(b) - sortStamp(a);

    });

  }, [pages, pinnedPage, rangeStart, rangeEnd]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const node = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setPageIndex((currentPage) => {
        const nextPage = currentPage + 1;
        loadPages({ reset: false, nextPage });
        return nextPage;
      });
    }, {
      root,
      rootMargin: '300px 0px',
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, dateFilter, isWellnessTenant]);

  const handleCreateBlank = async () => {

    try {

      const sectorKey = isWellnessTenant ? 'wellness' : 'general';

      const page = await fetchApi('/api/landing-pages', {

        method: 'POST',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({

          title: isWellnessTenant ? 'Untitled Wellness Event Landing Site' : 'Untitled Landing Site',

          templateType: buildTemplateType(sectorKey),

          content: JSON.stringify([]),

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
    const slotError = getEventSlotError(form.eventDate, form.eventTime, now);

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

    if (slotError) {
      setGenError(slotError);
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

          eventDate: formatDateForPrompt(form.eventDate),

          eventTime: formatTimeForPrompt(form.eventTime),

          eventLocation: form.eventLocation.trim() || form.location.trim(),

          tone: form.tone.trim(),

          ctaText: form.ctaText.trim(),

          imageMode: form.imageMode,

          autoCreate: true,

        }),

      });

      if (!res?.page?.id) throw new Error('Generation succeeded but no page was returned.');

      if (res.generation?.realModeError) {

        const friendly = friendlyAiError(res.generation.realModeError);

        if (friendly) notify.error(friendly);

      }

      if (res.generation?.verdict === 'fallback') {

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

      } else if (err?.status === 429 && err?.code === 'GEMINI_LIMIT_EXHAUSTED') {

        setGenError('Gemini limit has been exhausted. Please try again later.');

      } else {

        setGenError(err?.message || 'Generation failed.');

      }

    } finally {

      setGenerating(false);

    }

  };



  const handlePublish = async (page) => {
    const anotherLiveSite = page.status !== 'PUBLISHED' ? currentPublishedLandingSite && currentPublishedLandingSite.id !== page.id ? currentPublishedLandingSite : null : null;
    if (anotherLiveSite) {
      notify.error(`Only one published landing site is allowed at a time. Unpublish "${anotherLiveSite.title}" first.`);
      return;
    }
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

    <div style={{ padding: '2rem', height: '100%', minHeight: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'fadeIn 0.3s ease' }}>

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



      <section
        className="card"
        style={libraryShellStyle}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <div style={libraryBadgeStyle}>
              <LayoutGrid size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1rem', fontWeight: 800, marginBottom: '0.1rem' }}>Landing Site Library</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>Browse, publish, and manage your wellness landing sites.</p>
            </div>
          </div>

          {isWellnessTenant && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <DateRangeFilter value={dateFilter} onChange={setDateFilter} label="Filter by created date" />
              {visiblePages.length !== pages.length && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {visiblePages.length} of {pages.length}
                </span>
              )}
            </div>
          )}
        </div>

        <div
          ref={scrollContainerRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            paddingRight: '0.2rem',
          }}
        >
          {loading ? (

            <p style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-secondary)' }}>Loading...</p>

          ) : visiblePages.length === 0 ? (

            <div className="card" style={emptyStateStyle}>

              <LayoutGrid size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />

              <h3 style={{ marginBottom: '0.5rem' }}>No pages in the selected range.</h3>

              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>Create a blank site or generate one from a sector brief.</p>

              <button className="btn-primary" onClick={() => setShowGenerateModal(true)}><Plus size={16} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Generate Landing Site</button>

            </div>

          ) : (
            <>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>

          {visiblePages.map((page) => {

            const sc = STATUS_COLORS[page.status] || STATUS_COLORS.DRAFT;

            const convRate = page.visits > 0 ? (page.submissions / page.visits) * 100 : 0;
            const isPinned = page.status === 'PUBLISHED';

            return (

              <div key={page.id} className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.8rem', ...(isPinned ? { border: '1.5px solid rgba(200,154,78,0.45)', boxShadow: '0 0 0 3px rgba(200,154,78,0.08)' } : {}) }}>

                {isPinned && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 700, color: '#b8893b', marginBottom: '0.6rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3a1 1 0 0 1 .7 1.7l-1.4 1.4 1 5-4.3 2.5V20l-1 1-1-1v-6.4L5.7 11.1l1-5L5.3 4.7A1 1 0 0 1 7 3.3L8.4 4.7A3 3 0 0 1 12 4a3 3 0 0 1 3.6.7L17 3.3A1 1 0 0 1 16 3z"/></svg>
                    Pinned - Active Site
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>

                  <div style={{ minWidth: 0 }}>

                    <div style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>

                      <span style={{ padding: '0.18rem 0.55rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, background: 'rgba(79,70,229,0.12)', color: '#4f46e5' }}>{page.sectorLabel || 'General'}</span>

                      {isPinned && (
                        <span style={{ padding: '0.18rem 0.55rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, background: 'rgba(184,137,59,0.15)', color: '#b8893b' }}>Pinned</span>
                      )}

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

                  {(() => {
                    const anotherLive = page.status !== 'PUBLISHED' && currentPublishedLandingSite && currentPublishedLandingSite.id !== page.id;
                    const liveTitle = anotherLive ? currentPublishedLandingSite.title : null;
                    return (
                      <button
                        onClick={() => handlePublish(page)}
                        disabled={anotherLive}
                        title={
                          page.status === 'PUBLISHED'
                            ? 'Take this landing site offline'
                            : anotherLive
                              ? `Only one published landing site is allowed at a time. Unpublish "${liveTitle}" first.`
                              : 'Publish this landing site'
                        }
                        style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: page.status === 'PUBLISHED' ? '#f59e0b' : '#10b981', cursor: anotherLive ? 'not-allowed' : 'pointer', opacity: anotherLive ? 0.55 : 1 }}>
                        <Globe size={13} /> {page.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                      </button>
                    );
                  })()}

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
              <div ref={sentinelRef} aria-hidden="true" style={{ height: '1px' }} />
              {loadingMore && (
                <p style={{ marginTop: '1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  Loading more landing sites...
                </p>
              )}

            </>
          )}
        </div>
      </section>




      {showGenerateModal && (

        <div role="dialog" aria-modal="true" aria-labelledby="landing-site-generate-title" style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.5))', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }} onClick={(e) => { if (e.target === e.currentTarget && !generating) setShowGenerateModal(false); }}>

          <div className="card" style={{ padding: '1.75rem', width: 'min(640px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>

            <h3 id="landing-site-generate-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 800, marginBottom: '0.4rem', fontSize: '1.2rem' }}>

              <Megaphone size={20} style={{ color: '#4f46e5' }} /> Generate Landing Site

            </h3>

            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.1rem' }}>

              Pick a sector, describe the campaign, and we?ll draft a public landing site you can edit in the builder.

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

                <input type="date" min={todayDateValue} className="input-field" value={normalizeDateInputValue(form.eventDate)} onChange={(e) => setForm((s) => ({ ...s, eventDate: e.target.value }))} />

              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>

                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Event time</span>

                <input
                  type="time"
                  min={normalizeDateInputValue(form.eventDate) === todayDateValue ? todayTimeValue : undefined}
                  className="input-field"
                  value={normalizeTimeInputValue(form.eventTime)}
                  aria-invalid={Boolean(liveEventSlotError)}
                  onChange={(e) => setForm((s) => ({ ...s, eventTime: e.target.value }))}
                />
                {normalizeDateInputValue(form.eventDate) === todayDateValue && (
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                    Earliest allowed time today: {todayTimeValue}
                  </span>
                )}
                {liveEventSlotError && (
                  <span style={{ fontSize: '0.72rem', color: '#ef4444', marginTop: '0.15rem' }}>
                    Live check: {liveEventSlotError}
                  </span>
                )}

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











