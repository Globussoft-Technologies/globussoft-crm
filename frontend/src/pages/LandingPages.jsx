import { useState, useEffect, useMemo } from 'react';
import { PanelTop, Plus, Copy, Trash2, Globe, FileEdit, Star, Sparkles, AlertCircle, ExternalLink, Search, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { formatPercent } from '../utils/percent';
import { getLandingPageSharePath, getLandingPageShareUrl, isTravelLandingPage } from '../utils/landingPageUtils';
import { listWanderluxThemePresets, resolveWanderluxThemePreset } from '../utils/wanderluxThemePresets';
import ThemePaletteEditor, { createThemeDraft } from '../components/landing-pages/ThemePaletteEditor';
import { useNotify } from '../utils/notify';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../components/wellness/DateRangeFilter';

const STATUS_COLORS = { DRAFT: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6' }, PUBLISHED: { bg: 'rgba(16,185,129,0.1)', color: '#10b981' }, ARCHIVED: { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' } };
const LANDING_PAGES_PUBLIC_EXPERIENCE_LABEL = 'Public experience';
function isDarkDocumentTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function useDocumentTheme() {
  const [theme, setTheme] = useState(() => (isDarkDocumentTheme() ? 'dark' : 'light'));

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      return undefined;
    }

    const root = document.documentElement;
    const syncTheme = () => {
      setTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    };

    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    return () => observer.disconnect();
  }, []);

  return theme;
}

function getLandingPageCardStyle(isDarkTheme) {
  return {
    background: isDarkTheme
      ? 'linear-gradient(180deg, rgba(17, 20, 27, 0.98), rgba(10, 12, 16, 0.95))'
      : 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(247, 250, 255, 0.96))',
    border: isDarkTheme
      ? '1px solid rgba(255, 255, 255, 0.08)'
      : '1px solid rgba(148, 163, 184, 0.22)',
    boxShadow: isDarkTheme
      ? '0 20px 50px rgba(0, 0, 0, 0.42)'
      : '0 18px 42px rgba(15, 23, 42, 0.08)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: '18px',
  };
}

function getLandingPageMetricTileStyle(isDarkTheme) {
  return {
    textAlign: 'center',
    padding: '0.75rem 0.5rem',
    background: isDarkTheme
      ? 'linear-gradient(180deg, rgba(26, 31, 40, 0.98), rgba(18, 22, 29, 0.96))'
      : 'linear-gradient(180deg, rgba(246, 249, 252, 0.98), rgba(239, 244, 249, 0.94))',
    border: isDarkTheme
      ? '1px solid rgba(255, 255, 255, 0.05)'
      : '1px solid rgba(148, 163, 184, 0.14)',
    borderRadius: '8px',
    boxShadow: isDarkTheme
      ? 'inset 0 1px 0 rgba(255, 255, 255, 0.03)'
      : 'inset 0 1px 0 rgba(255, 255, 255, 0.72)',
  };
}

function getLandingPagesFilterButtonStyle(isDarkTheme, active) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.45rem 0.8rem',
    borderRadius: 999,
    border: active ? '1px solid transparent' : '1px solid var(--border-color)',
    background: active
      ? 'linear-gradient(135deg, var(--primary-color, var(--accent-color)), var(--accent-hover))'
      : isDarkTheme
        ? 'rgba(255,255,255,0.03)'
        : 'rgba(255,255,255,0.8)',
    color: active ? '#fff' : 'var(--text-primary)',
    boxShadow: active ? '0 10px 18px rgba(37, 99, 235, 0.18)' : 'none',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

function friendlyAiError(rawError) {
  if (!rawError) return null;
  const m = String(rawError).toLowerCase();
  if (/(?:gemini).*limit has been exhausted|quota exceeded|exceeded.*quota|rate limit|too many requests|resource[_ -]?exhausted/.test(m)) {
    return "Gemini limit has been exhausted. Please try again later.";
  }
  return null;
}

function createGenFormDefaults(tripContext = null, overrides = {}) {
  const defaultTheme = resolveWanderluxThemePreset({
    destination: tripContext?.destination || '',
    subBrand: tripContext?.subBrand || 'tmc',
  });
  return {
    destination: tripContext?.destination || '',
    durationDays: tripContext?.durationDays || 7,
    audience: tripContext?.audience || '',
    tripType: tripContext?.tripType || 'international',
    subBrand: tripContext?.subBrand || 'tmc',
    themeId: defaultTheme.id,
    style: 'premium',
    ...overrides,
  };
}

function createBlockId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildMarketingPageContent(tripContext = null) {
  const destinationLabel = tripContext?.destination || 'your next trip';

  return [
    {
      id: createBlockId('marketing-heading'),
      type: 'heading',
      props: {
        text: 'Before the trip is confirmed',
        level: 'h1',
        align: 'center',
        color: '#1e293b',
      },
    },
    {
      id: createBlockId('marketing-copy'),
      type: 'text',
      props: {
        text: `Use this page to show a glimpse of ${destinationLabel}, highlight ongoing and completed trips, and point visitors to the diagnostic form and catalogue PDFs.`,
        align: 'center',
        color: '#64748b',
        fontSize: '1.02rem',
      },
    },
    {
      id: createBlockId('marketing-highlights'),
      type: 'highlightsGrid',
      props: {
        title: 'Trip overview',
        subtitle: 'Give travellers a quick snapshot before they decide.',
        items: [
          {
            icon: '1',
            title: 'Latest ongoing trips',
            body: 'Share the departures that are currently open for booking.',
          },
          {
            icon: '2',
            title: 'Completed trips',
            body: 'Show recent journeys and build trust with social proof.',
          },
          {
            icon: '3',
            title: 'Ready for diagnostics',
            body: 'Invite visitors to qualify themselves before the trip is confirmed.',
          },
        ],
      },
    },
    {
      id: createBlockId('marketing-widgets'),
      type: 'columns',
      props: {
        gap: '1.5rem',
        columns: [
          {
            components: [
              {
                id: createBlockId('marketing-diagnostic-title'),
                type: 'heading',
                props: {
                  text: 'Diagnostic form',
                  level: 'h2',
                  align: 'left',
                  color: '#1f2f2c',
                },
              },
              {
                id: createBlockId('marketing-diagnostic-copy'),
                type: 'text',
                props: {
                  text: 'Send visitors to the public diagnostic form so your team can qualify interest before the trip is confirmed.',
                  align: 'left',
                  color: '#5f6c67',
                  fontSize: '0.96rem',
                },
              },
              {
                id: createBlockId('marketing-diagnostic-cta'),
                type: 'button',
                props: {
                  text: 'Open diagnostic form',
                  url: '/p/tmc/readiness',
                  bgColor: '#b8893b',
                  color: '#ffffff',
                  align: 'left',
                  size: 'medium',
                },
              },
            ],
          },
          {
            components: [
              {
                id: createBlockId('marketing-catalogue'),
                type: 'brochureDownload',
                props: {
                  title: 'TMC catalogue PDFs',
                  subtitle: 'Attach brochures and downloadable PDFs here so visitors can browse the latest material.',
                  ctaText: 'Open catalogue PDFs',
                  fileUrl: null,
                  formFields: [
                    { label: 'Full name', name: 'name', type: 'text', required: true },
                    { label: 'Email', name: 'email', type: 'email', required: true },
                    { label: 'Phone', name: 'phone', type: 'tel', required: false },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: createBlockId('marketing-footer'),
      type: 'text',
      props: {
        text: 'Use the confirmed-trip page for locked departures and the marketing page for pre-trip discovery.',
        align: 'center',
        color: '#64748b',
        fontSize: '0.93rem',
      },
    },
  ];
}

function isExploreMarketingPage(page) {
  if (!page || page.tripId) return false;
  // The explore page is a singleton. Newer records identify it by their
  // canonical slug/template, while older records used the title/content
  // markers below. Keep all shapes recognised so its manage actions remain
  // available without introducing an explore-specific create action.
  const slug = String(page.slug || '').trim().toLowerCase();
  if (slug === 'explore' || slug.endsWith('/explore') || slug.endsWith('-explore')) return true;
  if (String(page.templateType || '').toLowerCase() === 'explore') return true;
  if (/\bexplore\b|pre-trip marketing page|before the trip is confirmed/i.test(String(page.title || ''))) return true;
  const content = typeof page.content === 'string' ? page.content : JSON.stringify(page.content || '');
  return content.includes('marketing-heading') || content.includes('Before the trip is confirmed');
}

export default function LandingPages() {
  const notify = useNotify();
  const location = useLocation();
  const themeName = useDocumentTheme();
  const isDarkTheme = themeName === 'dark';
  const pageReturnState = location.state?.returnTo ? location.state : null;
  const tripLandingPageContext = pageReturnState?.tripContext || null;
  const [pages, setPages] = useState([]);
  const [explorePageId, setExplorePageId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  // PR-B — AI Generate modal state.
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [genForm, setGenForm] = useState({
    destination: '',
    durationDays: 7,
    audience: '',
    tripType: 'international',
    subBrand: 'tmc',
    themeId: resolveWanderluxThemePreset({ subBrand: 'tmc' }).id,
    // AI flow only. Confirmed-trip drafts always open the AI generator
    // path first; the builder is where the operator edits the page.
    style: 'premium',
  });
  const [themeSelectionManual, setThemeSelectionManual] = useState(false);
  const [customColorsEnabled, setCustomColorsEnabled] = useState(false);
  const [customTheme, setCustomTheme] = useState(() => createThemeDraft(resolveWanderluxThemePreset({ subBrand: 'tmc' }).theme));
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [dateFilter, setDateFilter] = useState(EMPTY_DATE_FILTER);
  const [copiedId, setCopiedId] = useState(null);
  const [featuringId, setFeaturingId] = useState(null);
  const cardSurfaceStyle = getLandingPageCardStyle(isDarkTheme);
  const metricTileStyle = getLandingPageMetricTileStyle(isDarkTheme);
  const themeChoices = useMemo(() => listWanderluxThemePresets(genForm.subBrand), [genForm.subBrand]);
  const activeThemeChoice = useMemo(() => resolveWanderluxThemePreset({
    themeId: genForm.themeId,
    destination: genForm.destination,
    subBrand: genForm.subBrand,
  }), [genForm.themeId, genForm.destination, genForm.subBrand]);
  const suggestedTheme = useMemo(() => resolveWanderluxThemePreset({
    destination: genForm.destination,
    subBrand: genForm.subBrand,
  }), [genForm.destination, genForm.subBrand]);
  useEffect(() => {
    if (tripLandingPageContext) {
      const nextForm = createGenFormDefaults(tripLandingPageContext);
      setGenForm(nextForm);
      setThemeSelectionManual(false);
      setCustomColorsEnabled(false);
      setCustomTheme(createThemeDraft(resolveWanderluxThemePreset({
        themeId: nextForm.themeId,
        destination: nextForm.destination,
        subBrand: nextForm.subBrand,
      }).theme));
      setGenError(null);
      setShowGenerateModal(true);
    }
  }, [tripLandingPageContext]);
  const openGenerateModal = () => {
    const nextForm = tripLandingPageContext ? createGenFormDefaults(tripLandingPageContext) : createGenFormDefaults();
    setGenForm(nextForm);
    setThemeSelectionManual(false);
    const baseTheme = resolveWanderluxThemePreset({
      themeId: nextForm.themeId,
      destination: nextForm.destination,
      subBrand: nextForm.subBrand,
    });
    setCustomColorsEnabled(false);
    setCustomTheme(createThemeDraft(baseTheme.theme));
    setGenError(null);
    setShowGenerateModal(true);
  };
  const openGenerateModalFromConfirmedTrip = () => {
    setShowTemplatePicker(false);
    openGenerateModal();
  };
  const updateGenField = (field, value) => {
    setGenForm((current) => {
      const next = { ...current, [field]: value };
      if ((field === 'destination' || field === 'subBrand') && !themeSelectionManual) {
        const suggested = resolveWanderluxThemePreset({
          destination: field === 'destination' ? value : next.destination,
          subBrand: field === 'subBrand' ? value : next.subBrand,
        });
        next.themeId = suggested.id;
        if (!customColorsEnabled) {
          setCustomTheme(createThemeDraft(suggested.theme));
        }
      }
      return next;
    });
  };
  const handleThemeChoice = (themeId) => {
    const selected = resolveWanderluxThemePreset({
      themeId,
      destination: genForm.destination,
      subBrand: genForm.subBrand,
    });
    setThemeSelectionManual(selected.id !== suggestedTheme.id || customColorsEnabled);
    setGenForm((current) => ({ ...current, themeId: selected.id }));
    if (!customColorsEnabled) {
      setCustomTheme(createThemeDraft(selected.theme));
    }
  };
  const handleCustomColorsToggle = (enabled) => {
    const nextEnabled = Boolean(enabled);
    setCustomColorsEnabled(nextEnabled);
    if (nextEnabled) {
      const currentTheme = resolveWanderluxThemePreset({
        themeId: genForm.themeId,
        destination: genForm.destination,
        subBrand: genForm.subBrand,
      });
      setCustomTheme(createThemeDraft(currentTheme.theme));
      setThemeSelectionManual(true);
    } else {
      setThemeSelectionManual(genForm.themeId !== suggestedTheme.id);
    }
  };
  const summaryAndVisiblePages = useMemo(() => {
    const [rangeStart, rangeEnd] = resolveDateRange(dateFilter);
    const counts = pages.reduce((acc, page) => {
      acc.total += 1;
      if (page.status === 'PUBLISHED') acc.published += 1;
      else if (page.status === 'DRAFT') acc.draft += 1;
      else if (page.status === 'ARCHIVED') acc.archived += 1;
      return acc;
    }, { total: 0, published: 0, draft: 0, archived: 0 });

    const term = searchQuery.trim().toLowerCase();
    const filtered = pages.filter((page) => {
      if (rangeStart && rangeEnd) {
        const ts = new Date(page.createdAt).getTime();
        if (ts < rangeStart.getTime() || ts > rangeEnd.getTime()) return false;
      }
      if (statusFilter !== 'ALL' && page.status !== statusFilter) return false;
      if (term) {
        const haystack = [page.title, page.slug, page.status].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    }).slice().sort((a, b) => {
      // Pin: featured+published always first, then published, then drafts.
      const rank = (p) => (p.isFeatured && p.status === 'PUBLISHED') ? 0 : p.status === 'PUBLISHED' ? 1 : 2;
      return rank(a) - rank(b);
    });

    return {
      counts,
      visiblePages: filtered,
    };
  }, [dateFilter, pages, searchQuery, statusFilter]);
  const { counts, visiblePages: filteredPages } = summaryAndVisiblePages;
  const visiblePages = filteredPages;
  const explorePage = pages.find((page) => isExploreMarketingPage(page) && page.status !== 'ARCHIVED')
    || pages.find((page) => !page.tripId && page.templateType === 'wanderlux-v1' && page.status !== 'ARCHIVED');
  const resolvedExplorePageId = explorePage?.id || explorePageId;
  const builderNavigationState = pageReturnState || undefined;
  const statusFilterOptions = [
    { value: 'ALL', label: 'All', count: counts.total },
    { value: 'PUBLISHED', label: 'Published', count: counts.published },
    { value: 'DRAFT', label: 'Drafts', count: counts.draft },
  ];

  const loadPages = () => {
    setLoading(true);
    fetchApi('/api/landing-pages')
      .then((data) => {
        setPages(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    fetchApi('/api/explore')
      .then((exploreData) => setExplorePageId(exploreData?.explorePageId || null))
      .catch(() => setExplorePageId(null));
  };

  useEffect(() => {
    loadPages();
  }, []);

  const handleCreate = async (pageKind) => {
    const isMarketingPage = pageKind === 'marketing';
    const destination = tripLandingPageContext?.destination || '';
    const title = isMarketingPage
      ? (destination ? `${destination} Pre-Trip Marketing Page` : 'Pre-Trip Marketing Page')
      : (destination ? `${destination} Confirmed Trip Landing Page` : 'Confirmed Trip Landing Page');

    const payload = {
      title,
      templateType: 'travel_destination',
    };

    if (destination) {
      payload.destination = destination;
    }

    if (tripLandingPageContext?.subBrand) {
      payload.subBrand = tripLandingPageContext.subBrand;
    }

    if (isMarketingPage) {
      payload.content = JSON.stringify(buildMarketingPageContent(tripLandingPageContext));
    }

    try {
      const page = await fetchApi('/api/landing-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        silent: true,
      });
      setShowTemplatePicker(false);
      if (builderNavigationState) navigate(`/landing-pages/builder/${page.id}`, { state: builderNavigationState });
      else navigate(`/landing-pages/builder/${page.id}`);
    } catch (err) {
      if (err?.status === 409 && err?.data?.existingId) {
        const ok = await notify.confirm(
          `${err.message}\n\nOpen the existing draft?`,
        );
        if (ok) {
          if (builderNavigationState) navigate(`/landing-pages/builder/${err.data.existingId}`, { state: builderNavigationState });
          else navigate(`/landing-pages/builder/${err.data.existingId}`);
        }
        return;
      }
      notify.error(err?.message || 'Failed to create page');
    }
  };

  const handlePublish = async (id, action) => {
    try {
      await fetchApi(`/api/landing-pages/${id}/${action}`, { method: 'POST' });
      const currentPage = pages.find((p) => p.id === id) || {};
      const publishPath = getLandingPageSharePath({
        ...currentPage,
        status: 'PUBLISHED',
        isFeatured: Boolean(currentPage.isFeatured),
      });
      if (action === 'publish') notify.success(`Published — page is live at ${publishPath}.`);
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
        if (ok) {
          if (builderNavigationState) navigate(`/landing-pages/builder/${id}`, { state: builderNavigationState });
          else navigate(`/landing-pages/builder/${id}`);
        }
      } else {
        notify.error(err?.message || 'Publish failed.');
      }
    }
  };

  const handleDuplicate = async (id) => {
    await fetchApi(`/api/landing-pages/${id}/duplicate`, { method: 'POST' });
    loadPages();
  };

  const handleCopyUrl = (page) => {
    const url = getLandingPageShareUrl(page);
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(page.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const handleFeature = async (page) => {
    if (!page?.id || featuringId) return;
    setFeaturingId(page.id);
    try {
      if (page.isFeatured) {
        await fetchApi(`/api/landing-pages/${page.id}/unfeature`, { method: 'POST' });
      } else {
        await fetchApi(`/api/landing-pages/${page.id}/feature`, { method: 'POST' });
      }
      loadPages();
    } catch (err) {
      notify.error(err?.message || 'Failed to update featured status.');
    } finally {
      setFeaturingId(null);
    }
  };

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
          tripType: genForm.tripType,
          subBrand: sb,
          themeId: genForm.themeId || suggestedTheme.id,
          themeOverrides: customColorsEnabled ? customTheme : null,
          autoCreate: true,
          style: genForm.style || 'premium',
        }),
      });
      if (!res?.page?.id) {
        throw new Error('Generation succeeded but no page was returned.');
      }
      // Surface stub-mode + scrubbed verdicts to the operator so they
      // know whether the page is real-mode AI or a placeholder.
      if (res.generation?.realModeError) {
        const friendly = friendlyAiError(res.generation.realModeError);
        if (friendly) notify.error(friendly);
      }
      if (res.generation?.verdict === 'fallback') {
        notify.info('AI content failed validation; a deterministic placeholder draft was used. Edit before publishing.');
      } else if (res.generation?.verdict === 'scrubbed') {
        notify.info('AI content was generated but some fields were scrubbed by the safety guard. Review carefully.');
      } else {
        notify.success('AI draft created. Review every section before publishing.');
      }
      setShowGenerateModal(false);
      if (builderNavigationState) navigate(`/landing-pages/builder/${res.page.id}?ai=1`, { state: builderNavigationState });
      else navigate(`/landing-pages/builder/${res.page.id}?ai=1`);
    } catch (err) {
      if (err?.status === 429 && err?.code === 'LLM_BUDGET_EXCEEDED') {
        setGenError("This tenant has reached its monthly LLM spend cap. Try again next month or raise the cap in tenant settings.");
      } else if (err?.code === 'AI_NOT_CONFIGURED') {
        setGenError("AI provider is not configured. Configure an AI provider to generate this landing page.");
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
    const publicPath = getLandingPageSharePath(page);
    const submissionsLine = page.submissions > 0
      ? `\n\nThis page has ${page.submissions} submission${page.submissions === 1 ? '' : 's'} (kept in the contacts/deals tables; only the page record is removed).`
      : '';
    const publishedLine = isPublished
      ? `\n\n⚠ This page is currently PUBLISHED. Deleting takes the public URL ${publicPath} offline.`
      : '';
    const msg = `Delete "${name}"?${publishedLine}${submissionsLine}\n\nThis cannot be undone.`;
    if (!await notify.confirm(msg)) return;
    await fetchApi(`/api/landing-pages/${id}`, { method: 'DELETE' });
    loadPages();
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      {pageReturnState && (
        <nav
          aria-label="Breadcrumb"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.45rem',
            flexWrap: 'wrap',
            marginBottom: '0.85rem',
            fontSize: '0.82rem',
            color: 'var(--text-secondary)',
          }}
        >
          <Link
            to={pageReturnState.returnTo.path}
            state={pageReturnState}
            style={{
              color: 'var(--primary-color, var(--accent-color))',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {pageReturnState.returnTo.label}
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            to={pageReturnState.currentPath || pageReturnState.returnTo.path}
            state={pageReturnState}
            style={{
              color: 'var(--text-primary)',
              textDecoration: 'none',
            }}
          >
            {pageReturnState.currentLabel || LANDING_PAGES_PUBLIC_EXPERIENCE_LABEL}
          </Link>
        </nav>
      )}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <PanelTop size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Landing Pages</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Manage pre-trip marketing and confirmed-trip landing pages</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button className="btn-primary" onClick={openGenerateModal} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Create Page
          </button>
        </div>
      </header>

      <section aria-labelledby="explore-page-bar-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', padding: '0.85rem 1rem', marginBottom: '1.25rem', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--card-bg, rgba(255,255,255,0.45))' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexWrap: 'wrap' }}>
            <strong id="explore-page-bar-title">Explore marketing page</strong>
          </div>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>One editable page for pre-trip discovery. Published content is live at <strong>/explore</strong>.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => navigator.clipboard.writeText(`${window.location.origin}/explore`).then(() => { setCopiedId('explore'); setTimeout(() => setCopiedId(null), 2000); })} style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem' }}><Copy size={13} /> {copiedId === 'explore' ? 'Copied!' : 'Copy URL'}</button>
          <a href="/explore" target="_blank" rel="noreferrer" style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', textDecoration: 'none' }}><ExternalLink size={13} /> Open live</a>
          {resolvedExplorePageId && <Link to={`/landing-pages/explore-builder/${resolvedExplorePageId}`} className="btn-primary" style={{ padding: '0.5rem 0.8rem', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', textDecoration: 'none' }}><FileEdit size={13} /> Edit</Link>}
        </div>
      </section>


      {pages.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', flex: '1 1 560px', minWidth: 0 }}>
              <div style={{ position: 'relative', flex: '1 1 320px', maxWidth: '420px', minWidth: '240px' }}>
                <Search size={15} aria-hidden style={{ position: 'absolute', left: '0.8rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search landing pages"
                  aria-label="Search landing pages"
                  className="input-field"
                  style={{ width: '100%', paddingLeft: '2.1rem', paddingRight: searchQuery ? '2.2rem' : '0.9rem' }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    style={{
                      position: 'absolute',
                      right: '0.45rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-secondary)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                  >
                    <X size={14} aria-hidden />
                  </button>
                )}
              </div>
              <DateRangeFilter value={dateFilter} onChange={setDateFilter} label="Filter by created date" />
            </div>
            <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', alignSelf: 'center' }}>
              {statusFilterOptions.map((option) => {
                const active = statusFilter === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setStatusFilter(option.value)}
                    aria-pressed={active}
                    style={getLandingPagesFilterButtonStyle(isDarkTheme, active)}
                  >
                    <span>{option.label}</span>
                    <span style={{
                      minWidth: '1.75rem',
                      padding: '0.1rem 0.45rem',
                      borderRadius: 999,
                      background: active ? 'rgba(255,255,255,0.18)' : 'var(--subtle-bg)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      textAlign: 'center',
                    }}>
                      {option.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {visiblePages.length !== counts.total && (
            <div style={{ marginBottom: '0.9rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
              Showing {visiblePages.length.toLocaleString()} of {counts.total.toLocaleString()} landing pages
            </div>
          )}
        </>
      )}

      {loading ? <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading...</p> : pages.length === 0 ? (
        <div className="card" style={{ ...cardSurfaceStyle, padding: '4rem', textAlign: 'center' }}>
          <PanelTop size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ marginBottom: '0.5rem' }}>No landing pages yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>Create a confirmed-trip landing page to start publishing the trip experience.</p>
          <button className="btn-primary" onClick={openGenerateModal}><Plus size={16} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Create Page</button>
        </div>
      ) : (
        <>
          {visiblePages.length === 0 ? (
            <div className="card" style={{ ...cardSurfaceStyle, padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              No landing pages match the current search or filters.
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
              <div key={page.id} className="card" style={{
                ...cardSurfaceStyle,
                padding: '1.5rem',
                ...(page.isFeatured && page.status === 'PUBLISHED' ? {
                  border: '1.5px solid rgba(200,154,78,0.45)',
                  boxShadow: isDarkTheme
                    ? '0 0 0 3px rgba(200,154,78,0.08), 0 20px 50px rgba(0, 0, 0, 0.42)'
                    : '0 0 0 3px rgba(200,154,78,0.08), 0 18px 42px rgba(15, 23, 42, 0.08)',
                } : {}),
              }}>
                {/* Pinned banner */}
                {page.isFeatured && page.status === 'PUBLISHED' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 700, color: '#b8893b', marginBottom: '0.6rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3a1 1 0 0 1 .7 1.7l-1.4 1.4 1 5-4.3 2.5V20l-1 1-1-1v-6.4L5.7 11.1l1-5L5.3 4.7A1 1 0 0 1 7 3.3L8.4 4.7A3 3 0 0 1 12 4a3 3 0 0 1 3.6.7L17 3.3A1 1 0 0 1 16 3z"/></svg>
                    Pinned · Active Trip
                  </div>
                )}
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
                  <div style={metricTileStyle}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600' }}>{page.visits}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Visits</div>
                  </div>
                  <div style={metricTileStyle}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600' }}>{page.submissions}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Leads</div>
                  </div>
                  <div style={metricTileStyle}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600', color: '#10b981' }}>{formatPercent(convRate)}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Conv.</div>
                  </div>
                </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Link to={`/landing-pages/builder/${page.id}`} state={builderNavigationState} className="btn-primary" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', textDecoration: 'none' }}>
                    <FileEdit size={13} /> Edit
                  </Link>
                  {/* View button removed — the hardcoded :5173→:5000 host
                      swap only worked on the default Vite dev port, so the
                      button opened a blank SPA route in production and on
                      any non-default dev port. The Preview action inside
                      the Edit builder already serves the same need
                      (renders the live page via /:id/preview without
                      leaving the admin shell), and the public URL is
                      always reachable directly at <host>/trips or
                      <host>/trips/<id> for published travel pages. */}
                  <button
                    onClick={() => handlePublish(page.id, page.status === 'PUBLISHED' ? 'unpublish' : 'publish')}
                    title={
                      page.status === 'PUBLISHED'
                        ? 'Take this page down — its public URL will no longer serve it'
                        : `Publish this page and make it live at ${getLandingPageSharePath({ ...page, status: 'PUBLISHED', isFeatured: Boolean(page.isFeatured) })}`
                    }
                    style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: page.status === 'PUBLISHED' ? '#f59e0b' : '#10b981', cursor: 'pointer' }}
                  >
                    <Globe size={13} /> {page.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                  </button>
                  {page.status === 'PUBLISHED' && isTravelLandingPage(page) && (
                    <button
                      onClick={() => handleFeature(page)}
                      disabled={featuringId === page.id}
                      title={page.isFeatured ? 'Remove this trip from /trips' : 'Make this trip the featured /trips page'}
                      style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: page.isFeatured ? 'rgba(245, 158, 11, 0.08)' : 'none', color: page.isFeatured ? '#f59e0b' : '#10b981', cursor: featuringId === page.id ? 'wait' : 'pointer' }}
                    >
                      <Star size={13} /> {page.isFeatured ? 'Unfeature' : 'Feature'}
                    </button>
                  )}
                  <button onClick={() => handleDuplicate(page.id)} title="Duplicate" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <Copy size={13} />
                  </button>
                  <button onClick={() => handleDelete(page.id)} title="Delete" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: '#ef4444', cursor: 'pointer' }}>
                    <Trash2 size={13} />
                  </button>
                </div>

                {/* Public link share panel — only for published pages */}
                {page.status === 'PUBLISHED' && (
                  <div style={{ marginTop: '1rem', paddingTop: '0.9rem', borderTop: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.45rem' }}>
                      Public Link
                    </div>
                    {/* URL + copy + open */}
                    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
                      <input
                        readOnly
                        value={getLandingPageShareUrl(page)}
                        onClick={e => e.target.select()}
                        style={{ flex: 1, fontSize: '0.72rem', padding: '5px 8px', borderRadius: '5px', border: '1px solid var(--border-color)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', minWidth: 0, cursor: 'text' }}
                      />
                      <button
                        onClick={() => handleCopyUrl(page)}
                        title="Copy public URL"
                        style={{ padding: '5px 10px', borderRadius: '5px', border: '1px solid var(--border-color)', background: copiedId === page.id ? '#10b981' : 'none', color: copiedId === page.id ? '#fff' : 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px', fontSize: '0.72rem', fontWeight: 600, flexShrink: 0, transition: 'background 0.2s, color 0.2s' }}
                      >
                        <Copy size={11} /> {copiedId === page.id ? 'Copied!' : 'Copy'}
                      </button>
                      <a
                        href={getLandingPageShareUrl(page)}
                        onClick={() => {
                          // Open live starts a new visitor session. Do not
                          // carry an abandoned or completed draft into it.
                          try {
                            Object.keys(window.localStorage)
                              .filter((key) => key.startsWith('landing-registration-draft:'))
                              .forEach((key) => window.localStorage.removeItem(key));
                            Object.keys(window.sessionStorage)
                              .filter((key) => key.startsWith('landing-registration-draft:'))
                              .forEach((key) => window.sessionStorage.removeItem(key));
                          } catch (_err) { /* storage may be unavailable */ }
                        }}
                        target="_blank"
                        rel="noreferrer"
                        title="Open public page in new tab"
                        style={{ padding: '5px 8px', borderRadius: '5px', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', textDecoration: 'none', flexShrink: 0 }}
                      >
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
          <div className="card" style={{ ...cardSurfaceStyle, padding: '1.75rem', width: 'min(1020px, 96vw)', maxHeight: '90vh', overflowY: 'auto' }}>
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1rem' }}>
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.85rem 0.95rem', background: 'rgba(255,255,255,0.38)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.85rem' }}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor="gen-destination" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Destination *</label>
                    <input
                      id="gen-destination"
                      type="text"
                      value={genForm.destination}
                      onChange={(e) => updateGenField('destination', e.target.value)}
                      placeholder="e.g. Umrah, Bali, Japan, Switzerland"
                      maxLength={80}
                      disabled={generating}
                      className="input-field"
                      style={{ width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.9rem' }}
                    />
                  </div>
                  <div>
                    <label htmlFor="gen-trip-type" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Trip type *</label>
                    <select id="gen-trip-type" value={genForm.tripType} onChange={(e) => updateGenField('tripType', e.target.value)} disabled={generating} className="input-field" style={{ width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.9rem' }}>
                      <option value="international">International trip</option>
                      <option value="domestic">Domestic trip</option>
                      <option value="day_trip">Day trip</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="gen-duration" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Duration (days) *</label>
                    <input
                      id="gen-duration"
                      type="number"
                      min={1}
                      max={60}
                      value={genForm.durationDays}
                      onChange={(e) => updateGenField('durationDays', e.target.value)}
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
                      onChange={(e) => updateGenField('subBrand', e.target.value)}
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
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor="gen-audience" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontWeight: 600 }}>Audience *</label>
                    <input
                      id="gen-audience"
                      type="text"
                      value={genForm.audience}
                      onChange={(e) => updateGenField('audience', e.target.value)}
                      placeholder='e.g. "Pilgrims", "Honeymooners", "School students Grades 6-12"'
                      maxLength={200}
                      disabled={generating}
                      className="input-field"
                      style={{ width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.9rem' }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.85rem 0.95rem', background: 'rgba(184, 137, 59, 0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.72rem', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700, color: '#b8893b', marginBottom: '0.45rem' }}>
                  <Sparkles size={13} style={{ color: '#b8893b' }} />
                  AI-generated template
                </div>
                <div style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: '0.75rem' }}>
                  AI fills hero copy, highlights, safety, inclusions, itinerary, and FAQs. Pick a palette below, or switch on custom colors to tailor the look yourself.
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.65rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.08rem' }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      Suggested palette: {suggestedTheme.label}
                    </div>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                      The recommendation follows the destination until you choose a different palette.
                    </div>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#b8893b', background: 'rgba(184,137,59,0.1)', padding: '0.18rem 0.45rem', borderRadius: 999, letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 700 }}>
                    {themeSelectionManual || customColorsEnabled ? 'Chosen by you' : 'AI suggestion'}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: '0.6rem' }}>
                  {themeChoices.map((choice) => {
                    const selected = genForm.themeId === choice.id;
                    const theme = choice.theme || {};
                    const swatches = [theme.brandColor, theme.accentColor, theme.softBg, theme.lightBg].filter(Boolean);
                    const borderColor = selected ? 'rgba(184,137,59,0.9)' : 'var(--border-color)';
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        onClick={() => handleThemeChoice(choice.id)}
                        disabled={generating}
                        aria-pressed={selected}
                        style={{
                          border: `1px solid ${borderColor}`,
                          borderRadius: 12,
                          background: selected ? 'rgba(184, 137, 59, 0.08)' : 'rgba(255,255,255,0.6)',
                          cursor: generating ? 'wait' : 'pointer',
                          padding: '0.7rem',
                          textAlign: 'left',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.55rem',
                          boxShadow: selected ? '0 0 0 1px rgba(184, 137, 59, 0.24), 0 12px 24px rgba(15, 23, 42, 0.08)' : 'none',
                          transition: 'all 0.18s ease',
                        }}
                        onMouseEnter={(e) => {
                          if (generating) return;
                          e.currentTarget.style.transform = 'translateY(-1px)';
                          if (!selected) e.currentTarget.style.borderColor = 'rgba(184, 137, 59, 0.35)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.borderColor = borderColor;
                        }}
                      >
                        <div style={{ height: '52px', borderRadius: 10, background: `linear-gradient(135deg, ${theme.brandColor || '#123B63'}, ${theme.accentColor || '#D9A441'})`, border: `1px solid ${theme.borderColor || 'rgba(255,255,255,0.08)'}` }} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                          <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text-primary)' }}>{choice.label}</div>
                          {choice.id === suggestedTheme.id && (
                            <span style={{ fontSize: '0.62rem', color: '#b8893b', background: 'rgba(184,137,59,0.1)', padding: '0.14rem 0.35rem', borderRadius: 999, letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 700 }}>
                              AI suggestion
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                          {choice.description}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${swatches.length || 1}, minmax(0, 1fr))`, gap: '0.25rem' }}>
                          {swatches.map((swatch) => (
                            <span
                              key={swatch}
                              aria-hidden="true"
                              style={{
                                height: '10px',
                                borderRadius: 999,
                                background: swatch,
                                border: '1px solid rgba(15, 23, 42, 0.06)',
                              }}
                            />
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: 'block', fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.7rem', lineHeight: 1.45 }}>
                  The selected palette is saved with the draft so the builder opens in the same theme.
                </div>

                <div style={{ marginTop: '0.9rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.85rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.5rem', fontSize: '0.84rem', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={customColorsEnabled}
                    onChange={(e) => handleCustomColorsToggle(e.target.checked)}
                    disabled={generating}
                  />
                  Use custom colors
                </label>
                {customColorsEnabled ? (
                  <ThemePaletteEditor
                    title="Custom colors"
                    description="Fine-tune the selected palette before we generate the draft."
                    note="These colors are saved with the draft and the builder opens with the same look."
                    baseThemeLabel={activeThemeChoice.label}
                    theme={customTheme}
                    onChange={(nextTheme) => {
                      setCustomColorsEnabled(true);
                      setThemeSelectionManual(true);
                      setCustomTheme(createThemeDraft(nextTheme));
                    }}
                    onReset={() => {
                      const baseTheme = resolveWanderluxThemePreset({
                        themeId: genForm.themeId,
                        destination: genForm.destination,
                        subBrand: genForm.subBrand,
                      });
                      setCustomTheme(createThemeDraft(baseTheme.theme));
                    }}
                    resetLabel="Reset colors"
                    disabled={!customColorsEnabled || generating}
                  />
                ) : (
                  <div style={{ border: '1px dashed var(--border-color)', borderRadius: 8, padding: '0.7rem 0.85rem', background: 'rgba(255,255,255,0.45)', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    Turn this on if you want to tweak the AI palette by hand. The selected theme stays as the default until you edit it.
                  </div>
                )}
              </div>
            </div>
            </div>

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

      {/* Create Page Modal */}
      {showTemplatePicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-page-modal-title"
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}
          onClick={(e) => { if (e.target === e.currentTarget && !generating) setShowTemplatePicker(false); }}
        >
          <div className="card" style={{ ...cardSurfaceStyle, padding: '2rem', width: '840px', maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }}>
            <h3 id="create-page-modal-title" style={{ fontWeight: 'bold', marginBottom: '0.4rem', fontSize: '1.25rem' }}>Choose a page type</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
              Pick a pre-trip marketing page to showcase live trips, diagnostics, and PDFs, or create a confirmed-trip page for a locked departure.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1rem' }}>
              <button
                type="button"
                onClick={() => handleCreate('marketing')}
                className="card"
                style={{ display: 'none' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.45)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.18)'; e.currentTarget.style.transform = 'translateY(0)'; }}
                aria-label="Create marketing page"
              >
                <div style={{ width: '100%', height: '88px', borderRadius: '14px', background: 'linear-gradient(135deg, rgba(59,130,246,0.18), rgba(13,148,136,0.16))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Globe size={30} style={{ color: 'var(--accent-color)' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                  <h4 style={{ fontWeight: 700, margin: 0, fontSize: '1rem' }}>Marketing Page</h4>
                  <span style={{ fontSize: '0.68rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#2563eb', background: 'rgba(37, 99, 235, 0.12)', padding: '0.18rem 0.45rem', borderRadius: 999, fontWeight: 700 }}>Before trip confirmed</span>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>
                  Overview of ongoing and completed trips, plus quick access to the diagnostic form and TMC catalogue PDFs.
                </p>
              </button>

              <div
                className="card"
                style={{ padding: '1.2rem', border: '1px solid rgba(184, 137, 59, 0.2)', background: 'linear-gradient(180deg, rgba(184,137,59,0.12), rgba(15, 23, 42, 0.02))', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '0.9rem', transition: 'all 0.2s' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(184, 137, 59, 0.48)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(184, 137, 59, 0.2)'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                <button
                  type="button"
                  onClick={openGenerateModalFromConfirmedTrip}
                  style={{ width: '100%', border: 'none', background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}
                  aria-label="Open confirmed trip AI flow"
                >
                  <div style={{ width: '100%', height: '88px', borderRadius: '14px', background: 'linear-gradient(135deg, rgba(184,137,59,0.2), rgba(192,57,43,0.14))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Sparkles size={30} style={{ color: '#b8893b' }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <h4 style={{ fontWeight: 700, margin: 0, fontSize: '1rem' }}>Confirmed Trip Landing Page</h4>
                    <span style={{ fontSize: '0.68rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#b8893b', background: 'rgba(184, 137, 59, 0.12)', padding: '0.18rem 0.45rem', borderRadius: 999, fontWeight: 700 }}>Trip linked</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>
                    Open the AI draft flow for a confirmed trip.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={openGenerateModalFromConfirmedTrip}
                  aria-label="Open AI-generated template"
                  style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.46rem 0.72rem', borderRadius: 999, border: '1px solid rgba(184, 137, 59, 0.32)', background: 'rgba(184, 137, 59, 0.08)', color: '#b8893b', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.02em', cursor: 'pointer' }}
                >
                  <Sparkles size={13} /> AI-generated template
                </button>
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
