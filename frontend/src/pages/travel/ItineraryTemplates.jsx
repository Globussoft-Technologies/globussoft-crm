// Travel CRM — Itinerary Template Library admin page.
//
// #907 slice 7/N. Consumes the ItineraryTemplate CRUD shipped in slice 6
// (8972b8ca): GET /api/travel/itinerary-templates + POST + PATCH + DELETE.
//
// G061 (PRD FR-3.1.c, FR-3.1.d) adds two surfaces:
//   - Budget-tier filter facet (4 buckets: Budget <₹50K / Mid ₹50K-₹1L /
//     Premium ₹1L-₹2L / Luxury >₹2L) threaded as ?budgetTier=… to the
//     existing list endpoint.
//   - Preview-before-clone modal: an Eye icon on each row opens a detail
//     modal showing the day-by-day item summary + a Leaflet map of all
//     POIs with lat/lng, with a "Clone this template" CTA that POSTs
//     /api/travel/itineraries with clonedFromTemplateId set.
//
// Slice 8 will wire the sidebar entry + App.jsx route at /travel/itinerary-templates.
// This slice ships ONLY the page + its test.
//
// Backend contract (per backend/routes/travel_itinerary_templates.js):
//   GET    /api/travel/itinerary-templates?destinationName=&category=&subBrand=&isActive=&limit=&offset=
//          → 200 { items: [...], total, limit, offset }
//   POST   /api/travel/itinerary-templates  body: { name(req), destinationName(req),
//                                                    durationDays(req, positive int),
//                                                    description?, thumbnailUrl?, category?,
//                                                    subBrand?, defaultMarkupPercent?,
//                                                    basePriceMinor?, currency? (3-letter ISO),
//                                                    templateJson?, llmGeneratedBy?, isActive? }
//          → 201 created row | 400 MISSING_NAME | 400 MISSING_DESTINATION |
//                              400 MISSING_DURATION | 400 INVALID_DURATION |
//                              400 INVALID_CURRENCY | 403 FORBIDDEN_SUB_BRAND
//   PATCH  /api/travel/itinerary-templates/:id  body: partial of the same shape
//   DELETE /api/travel/itinerary-templates/:id  → soft-delete (returns row with isActive=false)
//
// Mirrors SightseeingMaster.jsx (ca052d20) — same #907 arc, same admin-table
// pattern, same notify hook (`../utils/notify`, not `../hooks/useNotify`).

import { useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore, Copy, Upload, Edit2, Eye, Filter, FileText, Map as MapIcon, Plus, Trash2, Download, X, ChevronDown, ChevronUp, ArrowUpDown } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import CountBadge from '../../components/CountBadge';
import { AuthContext } from '../../App';
import { useActiveSubBrand } from '../../utils/subBrand';
import PatientPager from '../wellness/patients/PatientPager';
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from '../../utils/travelSubBrand';
import MapPreview from '../../components/MapPreview';
import Spinner from '../../components/ui/Spinner';

const SUB_BRANDS = [
  { value: 'all', label: 'All sub-brands' },
  { value: 'tmc', label: 'TMC' },
  { value: 'rfu', label: 'RFU' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

const CATEGORIES = [
  { value: '', label: 'All categories' },
  { value: 'leisure', label: 'Leisure' },
  { value: 'religious', label: 'Religious' },
  { value: 'school', label: 'School trip' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'honeymoon', label: 'Honeymoon' },
  { value: 'family', label: 'Family' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'cruise', label: 'Cruise' },
];

// G061 — Budget-tier facet (PRD FR-3.1.c). Brackets target Indian travel-
// market reality: sub ₹50K is single-couple weekend trips (Goa, nearby hill
// stations); ₹50K-₹1L covers most family domestic + short international;
// ₹1L-₹2L is the standard international + Umrah Standard zone; >₹2L is
// Umrah Premium / Maldives / Europe / luxury. The values map 1:1 with the
// backend BUDGET_TIER_RANGES enum keys in routes/travel_itinerary_templates.js.
const BUDGET_TIERS = [
  { value: '', label: 'All budgets' },
  { value: 'budget', label: 'Budget (<₹50K)' },
  { value: 'mid', label: 'Mid (₹50K-₹1L)' },
  { value: 'premium', label: 'Premium (₹1L-₹2L)' },
  { value: 'luxury', label: 'Luxury (>₹2L)' },
];

const PAGE_SIZE = 20;
const ITINERARY_TEMPLATES_LAST_LIST_URL_KEY = 'travel.itineraryTemplates.lastListUrl';
const TEMPLATE_SORT_KEYS = new Set(['name', 'destinationName', 'durationDays', 'category', 'subBrand', 'defaultMarkupPercent', 'basePriceMinor', 'usageCount', 'status']);
const ITINERARY_TABLE_WIDTH = 1800;

// G061 — Parse the template's `templateJson` (String? @db.LongText holding
// `{ items: [...] }`) into the array MapPreview consumes. Resilient to:
//   - templateJson = null / undefined  → []
//   - templateJson = malformed JSON    → []
//   - templateJson = { items: [...] }  → items
//   - templateJson = { branding: {...}, items: [...] } → items
// Items without finite lat/lng are passed through; MapPreview's own
// pinnableItems() filter drops them. This keeps the day-by-day list
// assertion (descriptions / dayNumber) visible even when no map pins
// are present.
function parseTemplateItems(tpl) {
  if (!tpl || !tpl.templateJson) return [];
  try {
    const parsed = typeof tpl.templateJson === 'string'
      ? JSON.parse(tpl.templateJson)
      : tpl.templateJson;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch (_e) {
    return [];
  }
}

function parseTemplateItemDetails(item) {
  if (!item?.detailsJson) return null;
  try {
    const parsed = typeof item.detailsJson === "string" ? JSON.parse(item.detailsJson) : item.detailsJson;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_e) {
    return null;
  }
}

function summarizeTemplateConnections(items) {
  const summary = { sightseeing: 0, costLinked: 0, pricingLinked: 0, supplierLinked: 0 };
  (items || []).forEach((item) => {
    if (!item) return;
    const details = parseTemplateItemDetails(item);
    const masterRefs = details?.masterRefs && typeof details.masterRefs === "object" ? details.masterRefs : null;
    if (String(item.itemType || "").toLowerCase() === "sightseeing") summary.sightseeing += 1;
    if (masterRefs?.costMasterId != null) summary.costLinked += 1;
    if (details?.pricingLink) summary.pricingLinked += 1;
    if ((masterRefs?.supplierId != null) || (item.supplierId != null && item.supplierId !== "")) summary.supplierLinked += 1;
  });
  return summary;
}

const EMPTY_FORM = {
  name: '',
  destinationName: '',
  durationDays: '',
  description: '',
  thumbnailUrl: '',
  category: '',
  subBrand: '',
  defaultMarkupPercent: '',
  basePriceMinor: '',
  currency: 'INR',
  isActive: true,
  // G115 — PDF underprint template upload.
  pdfTemplateUrl: '',
  pdfTemplateFileName: '',
};

export default function ItineraryTemplates() {
  const notify = useNotify();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();

  // Sub-brand access: ADMIN / unrestricted users get a dropdown of all their
  // accessible brands; single-brand users get the field locked read-only; 2-3
  // brand users get a dropdown limited to THEIR brands. See defaultSubBrandFor.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  // Two deliberately separate concepts used to live mixed in one table,
  // told apart only by a small "PDF" badge next to the name — confusing
  // enough that operators couldn't reliably tell which was which. A "Trip
  // template" is CONTENT (destination/duration/price/day-plan) applied to a
  // NEW itinerary at create time; a "PDF template" is a pure brand PDF
  // STYLE applied when rendering an EXISTING itinerary. Same underlying
  // ItineraryTemplate row shape (isPdfTemplate discriminates them — already
  // set correctly today, just never surfaced as a real split), so this tab
  // only changes what's fetched/shown/created, not the data model.
  const [templateTab, setTemplateTab] = useState(searchParams.get('kind') === 'pdf' ? 'pdf' : 'trip');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(Number(searchParams.get('page')) || 1);
  const [pageSize, setPageSize] = useState(Number(searchParams.get('pageSize')) || PAGE_SIZE);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  // Filter state
  const [destinationFilter, setDestinationFilter] = useState(searchParams.get('destination') || '');
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '');
  const [subBrandFilter, setSubBrandFilter] = useState(searchParams.get('subBrand') || activeSubBrand || '');
  // G061 — Budget-tier facet (PRD FR-3.1.c). One of '' | 'budget' | 'mid' |
  // 'premium' | 'luxury'. Threads to the backend as ?budgetTier=…
  const [budgetTierFilter, setBudgetTierFilter] = useState(searchParams.get('budgetTier') || '');
  const [activeOnly, setActiveOnly] = useState(searchParams.get('active') !== 'false');
  const [includeArchived, setIncludeArchived] = useState(searchParams.get('archived') === '1');
  const [sortKey, setSortKey] = useState(searchParams.get('sortKey') || null);
  const [sortDirection, setSortDirection] = useState(searchParams.get('sortDirection') || null);
  const updateParams = (patch) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([key, value]) => { if (value === null || value === undefined || value === '' || value === false) next.delete(key); else next.set(key, String(value)); });
    setSearchParams(next, { replace: true });
  };
  const switchTemplateTab = (tab) => {
    setTemplateTab(tab);
    setPage(1);
    updateParams({ kind: tab === 'pdf' ? 'pdf' : null, page: 1 });
    setShowForm(false);
  };
  // Form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  // Thumbnail upload
  const thumbInputRef = useRef(null);
  const [uploadingThumb, setUploadingThumb] = useState(false);

  const pickThumbFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingThumb(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await fetchApi('/api/travel/itinerary-templates/upload-image', { method: 'POST', body: fd });
      setForm((prev) => ({ ...prev, thumbnailUrl: data.url }));
      notify.success('Thumbnail uploaded');
    } catch (err) {
      notify.error(err?.body?.error || 'Image upload failed');
    } finally {
      setUploadingThumb(false);
    }
  };

  // G115 — PDF underprint upload.
  const pdfInputRef = useRef(null);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  // AI-assisted region detection + operator confirmation (extends G115).
  // regionConfirm holds the analyze-pdf response while the confirm dialog is
  // open; confirmedRegions holds the operator's final choice as a JSON
  // string, sent as pdfTemplateRegions on submit. Both null = fall back to
  // the server's own heuristic recompute, exactly like today's behavior.
  const [analyzingPdf, setAnalyzingPdf] = useState(false);
  const [regionConfirm, setRegionConfirm] = useState(null);
  const [confirmedRegions, setConfirmedRegions] = useState(null);
  // Per-page role review (cover/itinerary/details/static + accent colour).
  // Runs AFTER the region-confirm step closes (sequential, not parallel —
  // avoids juggling two loading states / two dialogs racing to appear).
  // structureConfirm holds the analyze-structure response while its dialog
  // is open; confirmedStructure holds the operator's final choice as a JSON
  // string, sent as pdfStyleSpecJson on submit. Both null = fall back to the
  // server's own auto-classification (AI if configured, else heuristic),
  // exactly like before this review step existed.
  const [analyzingStructure, setAnalyzingStructure] = useState(false);
  const [structureConfirm, setStructureConfirm] = useState(null);
  const [confirmedStructure, setConfirmedStructure] = useState(null);

  const runStructureAnalysis = async (pdfTemplateUrl) => {
    setAnalyzingStructure(true);
    try {
      const structure = await fetchApi('/api/travel/itinerary-templates/analyze-structure', {
        method: 'POST',
        body: JSON.stringify({ pdfTemplateUrl }),
      });
      setStructureConfirm(structure);
    } catch (structErr) {
      notify.error(structErr?.body?.error || 'Page-role detection failed — you can still save with default detection');
    } finally {
      setAnalyzingStructure(false);
    }
  };

  const pickPdfFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') {
      notify.error('Only PDF files are allowed');
      return;
    }
    setUploadingPdf(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await fetchApi('/api/travel/itinerary-templates/upload-pdf', { method: 'POST', body: fd });
      setForm((prev) => ({ ...prev, pdfTemplateUrl: data.url, pdfTemplateFileName: file.name }));
      setConfirmedRegions(null);
      setConfirmedStructure(null);
      notify.success('PDF template uploaded');
      setAnalyzingPdf(true);
      let regionShown = false;
      try {
        const analysis = await fetchApi('/api/travel/itinerary-templates/analyze-pdf', {
          method: 'POST',
          body: JSON.stringify({ pdfTemplateUrl: data.url }),
        });
        setRegionConfirm(analysis);
        regionShown = true;
      } catch (analyzeErr) {
        // Non-fatal — the operator can still save; the server's own
        // heuristic recompute runs regardless on create/update.
        notify.error(analyzeErr?.body?.error || 'Region auto-detect failed — you can still save with default detection');
      } finally {
        setAnalyzingPdf(false);
      }
      // Page-role review runs sequentially AFTER the region step — if the
      // region dialog didn't open (its analysis failed), go straight to it
      // instead of never showing it at all.
      if (!regionShown) {
        await runStructureAnalysis(data.url);
      }
    } catch (err) {
      notify.error(err?.body?.error || 'PDF upload failed');
    } finally {
      setUploadingPdf(false);
    }
  };

  const removePdfTemplate = () => {
    setForm((prev) => ({ ...prev, pdfTemplateUrl: '', pdfTemplateFileName: '' }));
    setConfirmedRegions(null);
    setConfirmedStructure(null);
    if (pdfInputRef.current) pdfInputRef.current.value = '';
  };

  // G061 — Detail / preview modal (PRD FR-3.1.d). Shows the template's
  // day-by-day item summary + a Leaflet map of all POIs with lat/lng before
  // the operator commits to cloning. State holds the template currently
  // being previewed; null when the modal is closed.
  const [previewTemplate, setPreviewTemplate] = useState(null);
  // Contact list + selected contact for the clone-to-customer step.
  const [contacts, setContacts] = useState([]);
  const [cloneContactId, setCloneContactId] = useState('');

  const fetchItems = useCallback((currentPage = page, currentPageSize = pageSize) => {
    setLoading(true);
    const qs = new URLSearchParams();
    qs.set('isPdfTemplate', templateTab === 'pdf' ? 'true' : 'false');
    if (destinationFilter.trim()) qs.set('destinationName', destinationFilter.trim());
    if (categoryFilter) qs.set('category', categoryFilter);
    if (subBrandFilter && subBrandFilter !== 'all') qs.set('subBrand', subBrandFilter);
    if (budgetTierFilter) qs.set('budgetTier', budgetTierFilter);
    if (activeOnly) qs.set('isActive', 'true');
    else qs.set('isActive', 'false');
    if (includeArchived) qs.set('includeArchived', 'true');
    qs.set('limit', String(currentPageSize));
    qs.set('offset', String(Math.max(currentPage - 1, 0) * currentPageSize));
    fetchApi(`/api/travel/itinerary-templates?${qs.toString()}`)
      .then((res) => {
        const rows = Array.isArray(res?.items) ? res.items : [];
        const totalCount = Number(res?.total) || 0;
        setItems(rows);
        setTotal(totalCount);
      })
      .catch((e) => {
        notify.error(e?.body?.error || 'Failed to load itinerary templates');
        setItems([]);
        setTotal(0);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [templateTab, destinationFilter, categoryFilter, subBrandFilter, budgetTierFilter, activeOnly, includeArchived, notify, page, pageSize]);

  useEffect(() => {
    if (!searchParams.get('subBrand')) {
      setSubBrandFilter(activeSubBrand || '');
      setPage(1);
    }
  }, [activeSubBrand]);

  useEffect(() => {
    fetchItems(page, pageSize);
  }, [fetchItems, page, pageSize, reloadTick]);

  useEffect(() => {
    if (location.pathname !== '/travel/itinerary-templates') return;
    try { window.sessionStorage.setItem(ITINERARY_TEMPLATES_LAST_LIST_URL_KEY, `${location.pathname}${location.search}`); } catch { /* URL remains authoritative. */ }
  }, [location.pathname, location.search]);

  const sortedItems = useMemo(() => {
    if (!sortKey || !sortDirection) return items;
    return [...items].sort((a, b) => {
      const numeric = ['durationDays', 'defaultMarkupPercent', 'basePriceMinor', 'usageCount'].includes(sortKey);
      const left = numeric ? Number(a[sortKey] || 0) : String(a[sortKey] || '').toLowerCase();
      const right = numeric ? Number(b[sortKey] || 0) : String(b[sortKey] || '').toLowerCase();
      return (left > right ? 1 : left < right ? -1 : 0) * (sortDirection === 'desc' ? -1 : 1);
    });
  }, [items, sortDirection, sortKey]);

  const resetFilters = () => {
    setDestinationFilter(''); setCategoryFilter(''); setSubBrandFilter(activeSubBrand || ''); setBudgetTierFilter(''); setActiveOnly(true); setIncludeArchived(false); setPage(1); setPageSize(PAGE_SIZE); setSortKey(null); setSortDirection(null);
    updateParams({ destination: null, category: null, subBrand: null, budgetTier: null, active: null, archived: null, page: 1, pageSize: null, sortKey: null, sortDirection: null });
  };

  const sortButton = (key, label) => {
    const active = sortKey === key;
    const Icon = active && sortDirection === 'asc' ? ChevronUp : active && sortDirection === 'desc' ? ChevronDown : ArrowUpDown;
    return <button type="button" onClick={() => { const next = !active ? 'asc' : sortDirection === 'asc' ? 'desc' : null; setSortKey(next ? key : null); setSortDirection(next); updateParams({ sortKey: next ? key : null, sortDirection: next }); }} aria-label={`Sort ${label}`} style={{ ...sortButtonStyle, ...(active ? sortButtonActiveStyle : null) }}><span>{label}</span><Icon size={14} /></button>;
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
    setRegionConfirm(null);
    setConfirmedRegions(null);
    setStructureConfirm(null);
    setConfirmedStructure(null);
  };

  // Open a fresh create form with the sub-brand pre-resolved to the user's
  // default (their single brand if locked, else the active sidebar brand).
  const openCreateForm = () => {
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setEditingId(null);
    setShowForm(true);
  };

  const handleEdit = (item) => {
    setForm({
      name: item.name || '',
      destinationName: item.destinationName || '',
      durationDays: item.durationDays != null ? String(item.durationDays) : '',
      description: item.description || '',
      thumbnailUrl: item.thumbnailUrl || '',
      category: item.category || '',
      subBrand: item.subBrand || '',
      defaultMarkupPercent:
        item.defaultMarkupPercent != null ? String(item.defaultMarkupPercent) : '',
      basePriceMinor:
        item.basePriceMinor != null ? String(item.basePriceMinor) : '',
      currency: item.currency || 'INR',
      isActive: item.isActive !== false,
      // G115 — PDF underprint template.
      pdfTemplateUrl: item.pdfTemplateUrl || '',
      pdfTemplateFileName: item.pdfTemplateUrl ? (item.pdfTemplateUrl.split('/').pop() || 'template.pdf') : '',
    });
    setEditingId(item.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!form.name.trim()) {
      notify.error('name is required');
      return;
    }
    if (templateTab === 'pdf' && !form.pdfTemplateUrl.trim()) {
      notify.error('Upload a reference PDF — a PDF template with no PDF has nothing to render');
      return;
    }
    // Destination/duration are optional browsing metadata now — a template
    // is primarily a PDF style asset (Reference PDF below), reusable across
    // any destination or trip length. Only validate SHAPE when provided.
    if (form.durationDays && Number(form.durationDays) < 1) {
      notify.error('durationDays must be a positive integer');
      return;
    }

    const payload = {
      name: form.name.trim(),
      destinationName: form.destinationName.trim() || null,
      durationDays: form.durationDays ? Number(form.durationDays) : null,
      description: form.description.trim() || null,
      thumbnailUrl: form.thumbnailUrl.trim() || null,
      category: form.category || null,
      subBrand: form.subBrand || null,
      defaultMarkupPercent: form.defaultMarkupPercent
        ? Number(form.defaultMarkupPercent)
        : null,
      basePriceMinor: form.basePriceMinor ? Number(form.basePriceMinor) : null,
      currency: form.currency.trim() || null,
      isActive: form.isActive !== false,
      // G115 — PDF underprint template. Empty string clears it on edit.
      pdfTemplateUrl: form.pdfTemplateUrl.trim() || null,
    };
    // Operator-confirmed content region (AI-assisted or manually adjusted).
    // Merges over the server's own heuristic recompute — omit entirely to
    // keep today's exact heuristic-only behavior (the "Skip" path).
    if (confirmedRegions) payload.pdfTemplateRegions = confirmedRegions;
    // Operator-confirmed page-role structure (cover/itinerary/details/static
    // per page + accent colour). Overrides the server's own auto-classified
    // spec entirely — omit to keep the auto-computed one (the "Skip" path).
    if (confirmedStructure) payload.pdfStyleSpecJson = confirmedStructure;

    try {
      if (editingId) {
        await fetchApi(`/api/travel/itinerary-templates/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        notify.success('Itinerary template updated');
      } else {
        await fetchApi('/api/travel/itinerary-templates', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify.success('Itinerary template added');
      }
      resetForm();
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to save template');
    }
  };

  const handleDelete = async (item) => {
    const ok = await notify.confirm(
      `Soft-delete "${item.name}" (${item.destinationName})? It will be hidden but recoverable.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/itinerary-templates/${item.id}`, { method: 'DELETE' });
      notify.success('Itinerary template removed');
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to delete template');
    }
  };

  // G048 — archive a row (stash it from the default library list). Confirms
  // first since this is a visible-state change.
  const handleArchive = async (item) => {
    const ok = await notify.confirm(
      `Archive "${item.name}"? It will be hidden from the default library list (toggle "Include archived" to see it again).`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/itinerary-templates/${item.id}/archive`, {
        method: 'POST',
      });
      notify.success(`Archived "${item.name}"`);
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to archive template');
    }
  };

  // G048 — restore an archived row.
  const handleRestore = async (item) => {
    try {
      await fetchApi(`/api/travel/itinerary-templates/${item.id}/restore`, {
        method: 'POST',
      });
      notify.success(`Restored "${item.name}"`);
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to restore template');
    }
  };

  // G058 — download analytics CSV. Uses fetch() directly (not fetchApi)
  // because the response is a text/csv blob, not JSON, and we want the
  // browser to trigger a save dialog. The Authorization header still
  // travels via the same localStorage('token') the fetchApi helper reads.
  const handleExportCsv = async () => {
    try {
      const token =
        typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
      const qs = new URLSearchParams();
      qs.set('isActive', activeOnly ? 'true' : 'false');
      if (includeArchived) qs.set('includeArchived', 'true');
      const url =
        `/api/travel/itinerary-templates/analytics.csv` +
        (qs.toString() ? `?${qs.toString()}` : '');
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const txt = await res.text();
        let msg = `Failed to export CSV (${res.status})`;
        try {
          const body = JSON.parse(txt);
          if (body?.error) msg = body.error;
        } catch (_e) {
          /* leave default msg */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'itinerary-template-analytics.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      notify.success('Analytics CSV downloaded');
    } catch (err) {
      notify.error(err?.message || 'Failed to export CSV');
    }
  };

  const formatPrice = (item) => {
    if (item.basePriceMinor == null) return '—';
    const major = Number(item.basePriceMinor) / 100;
    const cur = item.currency || 'INR';
    const symbol = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : `${cur} `;
    return `${symbol}${major.toLocaleString()}`;
  };

  const formatDuration = (days) => {
    if (days == null) return '—';
    const n = Number(days);
    return n === 1 ? '1 day' : `${n} days`;
  };

  const formatMarkup = (pct) => {
    if (pct == null) return '—';
    return `${Number(pct).toFixed(1)}%`;
  };

  // G061 — Preview-before-clone (PRD FR-3.1.d). Open the detail modal so
  // the operator can scan the day-by-day item summary + the map of POIs
  // before committing. The modal is dismissable; the actual clone fires
  // when the operator clicks "Clone this template" inside the modal.
  const openPreview = (item) => {
    setPreviewTemplate(item);
    setCloneContactId('');
    // Lazy-load contacts for the clone contact-picker (same feed as Itineraries.jsx).
    if (contacts.length === 0) {
      fetchApi('/api/contacts?limit=200')
        .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
        .catch(() => setContacts([]));
    }
  };
  const closePreview = () => {
    setPreviewTemplate(null);
    setCloneContactId('');
  };

  // G061 — Confirm-clone path. POSTs /api/travel/itineraries with the
  // template's id as `clonedFromTemplateId`; backend's POST /itineraries
  // handler resolves the template, copies its templateJson items into
  // ItineraryItem rows + bumps usageCount + lastUsedAt. Returns the new
  // itinerary's id so we can hand the operator off to the editor.
  const [cloning, setCloning] = useState(false);
  const handleClone = async () => {
    if (!previewTemplate) return;
    if (!cloneContactId) {
      notify.error('Pick a customer to assign this itinerary to');
      return;
    }
    setCloning(true);
    try {
      const tpl = previewTemplate;
      const created = await fetchApi('/api/travel/itineraries', {
        method: 'POST',
        body: JSON.stringify({
          title: tpl.name,
          destination: tpl.destinationName,
          durationDays: tpl.durationDays,
          subBrand: tpl.subBrand || defaultSubBrandFor(user, activeSubBrand),
          contactId: parseInt(cloneContactId, 10),
          clonedFromTemplateId: tpl.id,
        }),
      });
      notify.success(`Cloned "${tpl.name}" — opening in editor`);
      setPreviewTemplate(null);
      // Hand the operator off to the new itinerary's edit surface. We use
      // window.location rather than a useNavigate hook because this is the
      // simplest stable handoff that survives in tests (and the SUT
      // already uses window-level helpers for the CSV download path).
      if (created && created.id && typeof window !== 'undefined') {
        window.location.href = `/travel/itineraries/${created.id}/edit`;
      }
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to clone template');
    } finally {
      setCloning(false);
    }
  };

  // G061 — Memo-ize the modal's parsed items so MapPreview's items prop
  // identity is stable across re-renders (avoids unnecessary FitBounds
  // re-runs when the modal re-renders for unrelated state changes).
  const previewItems = useMemo(
    () => parseTemplateItems(previewTemplate),
    [previewTemplate],
  );

  // G049 — library metrics formatters (PRD FR-3.1.h). `avgFinalPrice` is
  // returned as a Decimal-string from Prisma; `lastUsedAt` is an ISO
  // datetime. Empty / null → em-dash so the column stays visually quiet
  // until the first clone+accept event lands.
  const formatAvgFinalPrice = (item) => {
    if (item.avgFinalPrice == null) return '—';
    const n = Number(item.avgFinalPrice);
    if (!Number.isFinite(n)) return '—';
    const cur = item.currency || 'INR';
    const symbol = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : `${cur} `;
    return `${symbol}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  };

  const formatLastUsedAt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    // Days-ago bucket: <1d → "today", <30d → "Nd ago", else short date.
    const ms = Date.now() - d.getTime();
    if (ms < 0) return d.toLocaleDateString();
    const days = Math.floor(ms / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <div style={{ padding: 24, width: '100%', maxWidth: 1480, margin: '0 auto', boxSizing: 'border-box' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, margin: 0, fontSize: '1.75rem', fontWeight: 600, lineHeight: 1.15, flexWrap: 'wrap' }}>
            <FileText size={28} aria-hidden /> Itinerary Template Library
            <CountBadge count={total} title={`${total.toLocaleString()} templates`} />
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
            Pre-loaded itinerary templates - destination, duration, base price, sub-brand
            affinity, with preserved sightseeing, supplier cost, and pricing-rule context.
            Operators clone these into new itineraries via the builder. Linked master
            data lives in{' '}
            <Link to="/travel/sightseeing" style={{ color: 'var(--primary-color, var(--accent-color))' }}>Sightseeing Master</Link>,{' '}
            <Link to="/travel/cost-master" style={{ color: 'var(--primary-color, var(--accent-color))' }}>Cost Master</Link>, and{' '}
            <Link to="/travel/pricing-rules" style={{ color: 'var(--primary-color, var(--accent-color))' }}>Pricing Rules</Link>.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* G058 — Export analytics CSV */}
          <button
            type="button"
            onClick={handleExportCsv}
            style={secondaryBtn}
            data-testid="export-csv-btn"
            title="Download a CSV with id, name, sub-brand, usage, accepted, avg sale, last used, version"
          >
            <Upload size={14} /> Export CSV
          </button>
          {!showForm && (
            <button type="button" onClick={openCreateForm} style={primaryBtn}>
              <Plus size={14} /> {templateTab === 'pdf' ? 'Add PDF template' : 'Add trip template'}
            </button>
          )}
        </div>
      </div>

      {/* Trip template (content, applied on itinerary create) vs PDF template
          (brand PDF style, applied when rendering an existing itinerary) —
          two separate lists, two separate create flows. */}
      <div role="tablist" aria-label="Template kind" style={{ display: 'flex', gap: 4, marginTop: 16, borderBottom: '1px solid var(--border-color)' }}>
        {[
          { value: 'trip', label: 'Trip templates', hint: 'Destination, price, day-plan — pre-fills a new itinerary' },
          { value: 'pdf', label: 'PDF templates', hint: 'Brand PDF style — used when generating a PDF from an itinerary' },
        ].map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={templateTab === t.value}
            title={t.hint}
            onClick={() => switchTemplateTab(t.value)}
            style={{
              padding: '0.6rem 1rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
              background: 'none', border: 'none', borderBottom: templateTab === t.value ? '2px solid var(--primary-color, var(--accent-color, #6366f1))' : '2px solid transparent',
              color: templateTab === t.value ? 'var(--text-primary)' : 'var(--text-secondary)',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
        {templateTab === 'trip'
          ? 'Content templates — destination, duration, price and a saved day-plan. Pick one when creating a new itinerary to start from it.'
          : "Brand PDF styles — an uploaded reference PDF only. Picked from inside an itinerary's Publish panel when generating its PDF; never applies content."}
      </p>

      {/* Filters */}
      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
          alignItems: 'center',
          background: 'var(--surface-color)',
          padding: 12,
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          marginBottom: 16,
          marginTop: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Filter size={16} aria-hidden style={{ color: 'var(--text-secondary)' }} />
          <input
            type="text"
            value={destinationFilter}
            onChange={(e) => {
              setDestinationFilter(e.target.value);
              setPage(1);
              updateParams({ destination: e.target.value, page: 1 });
            }}
            placeholder="Filter by destination"
            aria-label="Destination filter"
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>
        <select
          value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setPage(1);
              updateParams({ category: e.target.value, page: 1 });
          }}
          aria-label="Category filter"
          style={selectStyle}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={subBrandFilter}
            onChange={(e) => {
              setSubBrandFilter(e.target.value);
              setPage(1);
              updateParams({ subBrand: e.target.value, page: 1 });
          }}
          aria-label="Sub-brand filter"
          style={selectStyle}
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {/* G061 — Budget-tier filter (PRD FR-3.1.c). Threads through to the
            backend as ?budgetTier=…; backend BUDGET_TIER_RANGES maps each
            bucket to a basePriceMinor range. */}
        <select
          value={budgetTierFilter}
          onChange={(e) => {
            setBudgetTierFilter(e.target.value);
            setPage(1);
            updateParams({ budgetTier: e.target.value, page: 1 });
          }}
          aria-label="Budget tier filter"
          data-testid="budget-tier-filter"
          style={selectStyle}
        >
          {BUDGET_TIERS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => {
              setActiveOnly(e.target.checked);
              setPage(1);
              updateParams({ active: e.target.checked ? null : 'false', page: 1 });
            }}
            aria-label="Active only"
          />
          Active only
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => {
              setIncludeArchived(e.target.checked);
              setPage(1);
              updateParams({ archived: e.target.checked ? '1' : null, page: 1 });
            }}
            aria-label="Include archived"
          />
          Include archived
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setReloadTick((t) => t + 1)} style={secondaryBtn}>Refresh</button>
          <button type="button" onClick={resetFilters} style={secondaryBtn}>Reset filters</button>
        </div>
      </div>

      {/* Add / edit form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          style={{
            background: 'var(--surface-color)',
            padding: 16,
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 18 }}>
              {editingId
                ? (templateTab === 'pdf' ? 'Edit PDF template' : 'Edit trip template')
                : (templateTab === 'pdf' ? 'Add PDF template' : 'Add trip template')}
            </h2>
            <button
              type="button"
              onClick={resetForm}
              style={iconBtn}
              aria-label="Close form"
            >
              <X size={18} />
            </button>
          </div>

          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)' }}>
            {templateTab === 'pdf'
              ? <>A PDF template is a reusable brand <strong>style</strong> — upload a reference PDF below and any itinerary&apos;s
                  own content (destination, days, pricing) renders inside that look, regardless of trip length. It never carries
                  destination/price/day-plan content of its own.</>
              : <>A trip template is reusable <strong>content</strong> — destination, duration, price, and (once saved from a real
                  itinerary via &ldquo;Save as template&rdquo;) a full day-plan. Picking it when creating a new itinerary pre-fills
                  all of that; it has no PDF style of its own.</>}
          </p>

          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            }}
          >
            <Field label="Template name *">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Makkah-Madinah 10-day Umrah"
                aria-label="name"
                style={inputStyle}
              />
            </Field>
            {templateTab === 'trip' && (
              <>
                <Field label="Destination">
                  <input
                    value={form.destinationName}
                    onChange={(e) => setForm({ ...form, destinationName: e.target.value })}
                    placeholder="e.g. Makkah + Madinah"
                    aria-label="destinationName"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Duration in days">
                  <input
                    type="number"
                    min={1}
                    value={form.durationDays}
                    onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
                    placeholder="e.g. 10"
                    aria-label="durationDays"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Category">
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    aria-label="category"
                    style={selectStyle}
                  >
                    <option value="">— Uncategorized —</option>
                    {CATEGORIES.filter((c) => c.value).map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <Field label="Sub-brand">
              {lockedBrand ? (
                // Single-brand user: field is locked to their assigned brand.
                // The value is already pinned in form.subBrand via
                // defaultSubBrandFor (create) or the loaded row (edit).
                <input
                  type="text"
                  value={subBrandShortLabel(lockedBrand)}
                  readOnly
                  disabled
                  aria-label="Sub-brand (locked to your assigned brand)"
                  style={{ ...inputStyle, opacity: 0.7, cursor: 'not-allowed' }}
                />
              ) : (
                <select
                  value={form.subBrand}
                  onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                  aria-label="subBrand"
                  style={selectStyle}
                >
                  {myBrands.map((b) => (
                    <option key={b} value={b}>
                      {subBrandShortLabel(b)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {templateTab === 'trip' && (
              <>
                <Field label="Base price (minor units)">
                  <input
                    type="number"
                    min={0}
                    value={form.basePriceMinor}
                    onChange={(e) => setForm({ ...form, basePriceMinor: e.target.value })}
                    placeholder="e.g. 12500000 for ₹1,25,000"
                    aria-label="basePriceMinor"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Currency (ISO 3-letter)">
                  <input
                    value={form.currency}
                    onChange={(e) =>
                      setForm({ ...form, currency: e.target.value.toUpperCase() })
                    }
                    placeholder="INR"
                    maxLength={3}
                    aria-label="currency"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Default markup (%)">
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    value={form.defaultMarkupPercent}
                    onChange={(e) =>
                      setForm({ ...form, defaultMarkupPercent: e.target.value })
                    }
                    placeholder="e.g. 15"
                    aria-label="defaultMarkupPercent"
                    style={inputStyle}
                  />
                </Field>
              </>
            )}
            <Field label="Thumbnail">
              <input
                ref={thumbInputRef}
                type="file"
                accept="image/*"
                onChange={pickThumbFile}
                style={{ display: 'none' }}
                aria-label="Upload thumbnail image"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {form.thumbnailUrl ? (
                  <>
                    <img
                      src={form.thumbnailUrl}
                      alt="Template thumbnail"
                      style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border-color)' }}
                    />
                    <button
                      type="button"
                      onClick={() => thumbInputRef.current?.click()}
                      disabled={uploadingThumb}
                      style={{ ...secondaryBtn, padding: '0.4rem 0.7rem', fontSize: '0.8rem' }}
                    >
                      <Upload size={13} /> {uploadingThumb ? 'Uploading…' : 'Replace'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, thumbnailUrl: '' }))}
                      title="Remove thumbnail"
                      style={{ ...secondaryBtn, padding: '0.4rem 0.7rem', fontSize: '0.8rem', color: 'var(--danger-color, #ef4444)' }}
                    >
                      <X size={13} /> Remove
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => thumbInputRef.current?.click()}
                    disabled={uploadingThumb}
                    style={{ ...secondaryBtn, border: '1px dashed var(--border-color)', color: 'var(--text-secondary)' }}
                  >
                    <Upload size={14} /> {uploadingThumb ? 'Uploading…' : 'Upload thumbnail'}
                  </button>
                )}
              </div>
            </Field>

            {/* G115 — PDF underprint template upload */}
            {templateTab === 'pdf' && (
            <Field label="Reference PDF *">
              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                onChange={pickPdfFile}
                style={{ display: 'none' }}
                aria-label="Upload reference PDF template"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {form.pdfTemplateUrl ? (
                  <>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '0.35rem 0.7rem',
                        borderRadius: 6,
                        background: 'rgba(59,130,246,0.12)',
                        color: '#60a5fa',
                        fontSize: '0.8rem',
                        border: '1px solid rgba(59,130,246,0.25)',
                      }}
                    >
                      <FileText size={14} />
                      {form.pdfTemplateFileName || 'PDF template'}
                    </span>
                    <button
                      type="button"
                      onClick={() => pdfInputRef.current?.click()}
                      disabled={uploadingPdf}
                      style={{ ...secondaryBtn, padding: '0.4rem 0.7rem', fontSize: '0.8rem' }}
                    >
                      <Upload size={13} /> {uploadingPdf ? 'Uploading…' : 'Replace'}
                    </button>
                    <button
                      type="button"
                      onClick={removePdfTemplate}
                      title="Remove PDF template"
                      style={{ ...secondaryBtn, padding: '0.4rem 0.7rem', fontSize: '0.8rem', color: 'var(--danger-color, #ef4444)' }}
                    >
                      <X size={13} /> Remove
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => pdfInputRef.current?.click()}
                    disabled={uploadingPdf}
                    style={{ ...secondaryBtn, border: '1px dashed var(--border-color)', color: 'var(--text-secondary)' }}
                  >
                    <Upload size={14} /> {uploadingPdf ? 'Uploading…' : 'Upload reference PDF'}
                  </button>
                )}
              </div>
              {(analyzingPdf || analyzingStructure) ? (
                <div
                  role="status"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                    padding: '0.55rem 0.75rem', borderRadius: 6,
                    background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)',
                  }}
                >
                  <Spinner size="small" label="Analyzing PDF" />
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {analyzingPdf ? 'Reading your PDF with AI…' : 'Sorting out each page\'s role…'}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {analyzingPdf
                        ? 'Finding where your itinerary content should be placed on the page — usually takes a few seconds.'
                        : 'Deciding which pages are the cover, the day-by-day schedule, costing/terms, and fixed contact pages.'}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                  Upload a branded PDF. When this template is used, the itinerary data will be overlaid on top.
                </div>
              )}
            </Field>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <Field label="Description">
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Public-facing description (1-2 short paragraphs)."
                aria-label="description"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
          </div>

          <div style={{ marginTop: 12 }}>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                aria-label="isActive"
              />
              Active (visible to operators when cloning)
            </label>
          </div>

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button type="submit" style={primaryBtn}>
              {editingId ? 'Save changes' : 'Create'}
            </button>
            <button type="button" onClick={resetForm} style={secondaryBtn}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Items table */}
      <div
        style={{
          background: 'var(--surface-color)',
          borderRadius: 8,
          border: '1px solid var(--border-color)',
        }}
      >
        {loading && items.length === 0 ? (
          <div style={emptyStyle}>Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div style={emptyStyle}>No itinerary templates yet. Add one above.</div>
        ) : (
          <div
            data-testid="itinerary-templates-table-scroll"
            style={{
              overflow: 'auto',
              height: 'calc(100vh - 370px)',
              minHeight: 490,
              maxHeight: 730,
            }}
          >
            <table style={{ width: '100%', minWidth: ITINERARY_TABLE_WIDTH, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                <th style={th}>{sortButton('name', 'Name')}</th>
                <th style={th}>{sortButton('destinationName', 'Destination')}</th>
                <th style={th}>{sortButton('durationDays', 'Duration')}</th>
                <th style={th}>{sortButton('category', 'Category')}</th>
                <th style={th}>{sortButton('subBrand', 'Sub-brand')}</th>
                <th style={th}>{sortButton('defaultMarkupPercent', 'Markup')}</th>
                <th style={th}>{sortButton('basePriceMinor', 'Base price')}</th>
                <th style={th}>{sortButton('usageCount', 'Usage')}</th>
                {/* G049 — library metrics (PRD FR-3.1.h). Engine-bumped by
                    routes/travel_itineraries.js on clone + accept; the
                    /:id response includes these fields by default. */}
                <th style={th}>Accepted</th>
                <th style={th}>Avg sale</th>
                <th style={th}>Last used</th>
                <th style={th}>Status</th>
                {/* G048 — version column. Editing a template bumps the
                    visible version while preserving the previous row's id
                    so existing Itinerary.clonedFromTemplateId FKs stay
                    valid. */}
                <th style={th}>Ver</th>
                <th style={th}>Actions</th>
              </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <tr
                    key={item.id}
                    style={{
                      borderTop: '1px solid var(--border-light)',
                      opacity: item.archivedAt ? 0.9 : item.isActive ? 1 : 0.58,
                      background: item.archivedAt ? 'rgba(245, 158, 11, 0.08)' : undefined,
                      boxShadow: item.archivedAt ? 'inset 4px 0 0 rgba(245, 158, 11, 0.85)' : undefined,
                    }}
                  >
                  <td style={td}>
                    <strong>{item.name}</strong>
                    {item.archivedAt && (
                      <span
                        style={{
                          marginLeft: 8,
                          padding: '2px 6px',
                          borderRadius: 999,
                          background: 'rgba(245, 158, 11, 0.18)',
                          color: 'rgb(146, 64, 14)',
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 0.5,
                          textTransform: 'uppercase',
                        }}
                      >
                        archived
                      </span>
                    )}
                    {item.pdfTemplateUrl && (
                      <span
                        style={{
                          marginLeft: 8,
                          padding: '2px 6px',
                          borderRadius: 999,
                          background: 'rgba(59, 130, 246, 0.18)',
                          color: 'rgb(29, 78, 216)',
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 0.5,
                          textTransform: 'uppercase',
                        }}
                      >
                        PDF
                      </span>
                    )}
                    {item.description && (
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          marginTop: 2,
                          maxWidth: 320,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.description}
                      </div>
                    )}
                  </td>
                  <td style={td}>{item.destinationName}</td>
                  <td style={td}>{formatDuration(item.durationDays)}</td>
                  <td style={td}>{item.category || '—'}</td>
                  <td style={td}>
                    {item.subBrand ? (
                      <span style={brandBadge}>{item.subBrand}</span>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)' }}>tenant</span>
                    )}
                  </td>
                  <td style={td}>{formatMarkup(item.defaultMarkupPercent)}</td>
                  <td style={td}>{formatPrice(item)}</td>
                  <td style={td}>{item.usageCount != null ? item.usageCount : 0}</td>
                  <td style={td} data-testid={`tpl-acceptedCount-${item.id}`}>
                    {item.acceptedCount != null ? item.acceptedCount : 0}
                  </td>
                  <td style={td} data-testid={`tpl-avgFinalPrice-${item.id}`}>
                    {formatAvgFinalPrice(item)}
                  </td>
                  <td style={td} data-testid={`tpl-lastUsedAt-${item.id}`}>
                    {formatLastUsedAt(item.lastUsedAt)}
                  </td>
                  <td style={td}>
                    {item.archivedAt ? (
                      <span style={statusBadgeArchived}>Archived</span>
                    ) : item.isActive ? (
                      <span style={statusBadgeActive}>Active</span>
                    ) : (
                      <span style={statusBadgeInactive}>Inactive</span>
                    )}
                  </td>
                  <td style={td} data-testid={`tpl-version-${item.id}`}>
                    v{item.version != null ? item.version : 1}
                    {item.archivedAt && (
                      <span
                        style={{
                          fontSize: 11,
                          marginLeft: 4,
                          color: 'var(--text-secondary)',
                        }}
                        title={`Archived ${new Date(item.archivedAt).toLocaleString()}`}
                      >
                        archived
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* G061 — Preview-before-clone (PRD FR-3.1.d). Opens
                          a detail modal with the day-by-day item summary +
                          a map of all POIs with lat/lng. The modal exposes
                          a "Clone this template" CTA inside it; previously
                          the only path was a destructive in-place edit. */}
                      <button
                        type="button"
                        onClick={() => openPreview(item)}
                        style={iconBtn}
                        aria-label={`Preview ${item.name}`}
                        data-testid={`preview-tpl-${item.id}`}
                        title="Preview with map before cloning"
                      >
                        <Eye size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEdit(item)}
                        style={iconBtn}
                        aria-label={`Edit ${item.name}`}
                      >
                        <Edit2 size={16} />
                      </button>
                      {/* G048 — Archive / Restore button. When the row is
                          archived (item.archivedAt set), show Restore
                          instead so the operator can bring it back. */}
                      {item.archivedAt ? (
                        <button
                          type="button"
                          onClick={() => handleRestore(item)}
                          style={iconBtn}
                          aria-label={`Restore ${item.name}`}
                          data-testid={`restore-tpl-${item.id}`}
                          title="Restore from archive"
                        >
                          <ArchiveRestore size={16} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleArchive(item)}
                          style={iconBtn}
                          aria-label={`Archive ${item.name}`}
                          data-testid={`archive-tpl-${item.id}`}
                          title="Archive (hide from default list)"
                        >
                          <Archive size={16} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDelete(item)}
                        style={iconBtn}
                        aria-label={`Delete ${item.name}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PatientPager
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={(nextPage) => { setPage(nextPage); updateParams({ page: nextPage }); }}
          onPageSizeChange={(nextSize) => {
            setPageSize(nextSize);
            setPage(1);
            updateParams({ pageSize: nextSize, page: 1 });
          }}
          isCustomPageSize={isCustomPageSize}
          setIsCustomPageSize={setIsCustomPageSize}
          customPageSize={customPageSize}
          setCustomPageSize={setCustomPageSize}
          label="itinerary templates"
        />
      </div>

      {/* G061 — Detail / preview modal (PRD FR-3.1.d). Renders when the
          operator clicks the Preview eye-icon on any row. Shows the
          template's name + description + day-by-day item summary + a
          Leaflet map of all items with lat/lng. The "Clone this template"
          CTA inside the modal triggers the actual clone (POST /api/travel/
          itineraries with clonedFromTemplateId); the operator lands on the
          new itinerary's editor. */}
      {regionConfirm && (
        <PdfRegionConfirmModal
          analysis={regionConfirm}
          onConfirm={(regionsJson) => {
            setConfirmedRegions(regionsJson);
            setRegionConfirm(null);
            runStructureAnalysis(form.pdfTemplateUrl);
          }}
          onSkip={() => {
            setRegionConfirm(null);
            runStructureAnalysis(form.pdfTemplateUrl);
          }}
        />
      )}
      {structureConfirm && (
        <PdfStructureConfirmModal
          analysis={structureConfirm}
          onConfirm={(specJson) => {
            setConfirmedStructure(specJson);
            setStructureConfirm(null);
          }}
          onSkip={() => setStructureConfirm(null)}
        />
      )}
      {previewTemplate && (
        <TemplatePreviewModal
          template={previewTemplate}
          items={previewItems}
          cloning={cloning}
          onClone={handleClone}
          onClose={closePreview}
          formatPrice={formatPrice}
          formatDuration={formatDuration}
          contacts={contacts}
          cloneContactId={cloneContactId}
          onContactChange={setCloneContactId}
        />
      )}
    </div>
  );
}

// Drag-based region confirmation (extends G115). Shows a preview of page 1
// with the proposed content box drawn on top of it; the operator drags the
// box itself to reposition it, or any corner handle to resize it — directly
// on the image, the way a human actually thinks about "cover this area", not
// by typing four PDF-point numbers into disconnected fields. "Skip" leaves
// confirmedRegions null so the server's own heuristic recompute is used
// unchanged.
const HANDLES = [
  { mode: 'tl', top: 0, left: 0, cursor: 'nwse-resize' },
  { mode: 'tr', top: 0, left: 100, cursor: 'nesw-resize' },
  { mode: 'bl', top: 100, left: 0, cursor: 'nesw-resize' },
  { mode: 'br', top: 100, left: 100, cursor: 'nwse-resize' },
];
const MIN_BOX_PCT = 6;

function PdfRegionConfirmModal({ analysis, onConfirm, onSkip }) {
  const pageSize = analysis.pageSize || { width: 595.28, height: 841.89 };
  const suggestedBox = useMemo(() => ({
    x: analysis.contentBox?.x || 0,
    y: analysis.contentBox?.y || 0,
    width: analysis.contentBox?.width || pageSize.width,
    height: analysis.contentBox?.height || pageSize.height,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [analysis]);
  const [box, setBox] = useState(suggestedBox);
  const containerRef = useRef(null);
  const dragRef = useRef(null);

  const DIAGRAM_WIDTH = 420;
  const diagramHeight = Math.round(DIAGRAM_WIDTH * (pageSize.height / pageSize.width));

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // PDF points (bottom-left origin) -> CSS percentages (top-left origin) —
  // the box's on-screen position, recomputed whenever `box` changes.
  const pct = useMemo(() => {
    const top = clamp(((pageSize.height - box.y - box.height) / pageSize.height) * 100, 0, 100);
    const left = clamp((box.x / pageSize.width) * 100, 0, 100);
    const width = clamp((box.width / pageSize.width) * 100, MIN_BOX_PCT, 100 - left);
    const height = clamp((box.height / pageSize.height) * 100, MIN_BOX_PCT, 100 - top);
    return { top, left, width, height };
  }, [box, pageSize]);

  const pctToBox = (p) => {
    const width = (p.width / 100) * pageSize.width;
    const height = (p.height / 100) * pageSize.height;
    const x = (p.left / 100) * pageSize.width;
    const y = pageSize.height - (p.top / 100) * pageSize.height - height;
    return { x, y, width, height };
  };

  const handlePointerMove = (e) => {
    const st = dragRef.current;
    if (!st || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dxPct = ((e.clientX - st.startClientX) / rect.width) * 100;
    const dyPct = ((e.clientY - st.startClientY) / rect.height) * 100;
    let { left, top, width, height } = st.startPct;

    if (st.mode === 'move') {
      left = clamp(left + dxPct, 0, 100 - width);
      top = clamp(top + dyPct, 0, 100 - height);
    } else {
      if (st.mode.includes('l')) {
        const right = left + width;
        left = clamp(left + dxPct, 0, right - MIN_BOX_PCT);
        width = right - left;
      }
      if (st.mode.includes('r')) {
        width = clamp(width + dxPct, MIN_BOX_PCT, 100 - left);
      }
      if (st.mode.includes('t')) {
        const bottom = top + height;
        top = clamp(top + dyPct, 0, bottom - MIN_BOX_PCT);
        height = bottom - top;
      }
      if (st.mode.includes('b')) {
        height = clamp(height + dyPct, MIN_BOX_PCT, 100 - top);
      }
    }
    setBox(pctToBox({ left, top, width, height }));
  };

  const endDrag = () => {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', endDrag);
  };

  const startDrag = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, startClientX: e.clientX, startClientY: e.clientY, startPct: pct };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endDrag);
  };

  useEffect(() => () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', endDrag);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Confirm PDF template content region"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onSkip(); }}
    >
      <div
        style={{
          background: 'var(--surface-color)', borderRadius: 8, border: '1px solid var(--border-color)',
          maxWidth: 620, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 20,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.3)',
        }}
      >
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', color: 'var(--accent-color, #6366f1)', marginBottom: 4 }}>
          STEP 1 OF 2
        </div>
        <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>Mark where your trip content goes</h2>
        <p style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          The blue box below is what gets replaced with real itinerary content (dates, day plans,
          pricing) every time this template is used. Drag it to move it, or drag a corner to resize
          it — make sure it fully covers this sample&apos;s own text and photos, but stays clear of
          your logo, header and footer, which stay fixed on every page.
        </p>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
          {analysis.source === 'ai'
            ? `Starting position suggested by AI (${analysis.aiProvider || 'your configured provider'}).`
            : 'Starting position suggested by automatic layout detection.'}
        </p>

        <div
          ref={containerRef}
          style={{
            position: 'relative', width: DIAGRAM_WIDTH, height: diagramHeight,
            maxWidth: '100%', margin: '0 auto',
            border: '1px solid var(--border-color)', borderRadius: 4, overflow: 'hidden',
            backgroundImage: analysis.previewImageBase64 ? `url(data:image/png;base64,${analysis.previewImageBase64})` : undefined,
            backgroundSize: 'cover', backgroundColor: 'var(--bg-color, #1a1a1a)',
            touchAction: 'none', userSelect: 'none',
          }}
        >
          <div
            onPointerDown={startDrag('move')}
            title="Drag to move"
            style={{
              position: 'absolute',
              top: `${pct.top}%`, left: `${pct.left}%`, width: `${pct.width}%`, height: `${pct.height}%`,
              background: 'rgba(59,130,246,0.22)', border: '2px solid #3b82f6', cursor: 'move', boxSizing: 'border-box',
            }}
          >
            {HANDLES.map((h) => (
              <div
                key={h.mode}
                onPointerDown={startDrag(h.mode)}
                title="Drag to resize"
                style={{
                  position: 'absolute', top: `${h.top}%`, left: `${h.left}%`,
                  width: 14, height: 14, marginTop: -7, marginLeft: -7,
                  background: '#fff', border: '2px solid #3b82f6', borderRadius: '50%',
                  cursor: h.cursor,
                }}
              />
            ))}
          </div>
        </div>

        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
          <button type="button" onClick={() => setBox(suggestedBox)} style={{ ...secondaryBtn, padding: '0.3rem 0.65rem', fontSize: '0.76rem' }}>
            Reset to suggested position
          </button>
        </div>

        <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>
          <button
            type="button"
            // confirmedByOperator marks this box as reviewed, so the renderer
            // gives it precedence over every auto-detected per-page box —
            // without the flag the heuristic silently won and this dialog
            // had no real effect on the output.
            onClick={() => onConfirm(JSON.stringify({ pageSize, contentBox: box, confirmedByOperator: true }))}
            style={primaryBtn}
          >
            Confirm &amp; continue
          </button>
          <button type="button" onClick={onSkip} style={secondaryBtn}>
            Skip (use automatic detection)
          </button>
        </div>
      </div>
    </div>
  );
}

const PAGE_ROLE_OPTIONS = [
  { value: 'cover', label: 'Cover — title, hero photo, intro blurb' },
  { value: 'itinerary', label: 'Itinerary — day-by-day schedule (grows/shrinks with trip length)' },
  { value: 'details', label: 'Details — costing, inclusions, exclusions, terms' },
  { value: 'static', label: 'Static — never changes between trips (about us, contact)' },
];

// Page-role review (extends the structure classification added after G115).
// Shows a thumbnail strip — one small preview per page — each with a role
// dropdown pre-filled from the AI/heuristic classification, so the operator
// can catch and correct a misclassification BEFORE it's saved (previously
// this ran silently with no way to see or override the result). "Skip"
// leaves confirmedStructure null so the server's own auto-classification
// (same AI-then-heuristic fallback) is used unchanged.
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function PdfStructureConfirmModal({ analysis, onConfirm, onSkip }) {
  const [roles, setRoles] = useState(() =>
    Object.fromEntries((analysis.pages || []).map((p) => [p.index, p.role])),
  );
  // Detected automatically (AI or a heuristic sample of the template) — never
  // reliable enough to ship unchecked. It previously went straight from
  // detection into every generated PDF's day-bands/headings with no human
  // ever seeing the swatch, so a wrong guess (a secondary color picked up
  // instead of the actual brand color) silently rendered every trip in the
  // wrong hue until someone happened to notice.
  const [accentColor, setAccentColor] = useState(
    HEX_COLOR_RE.test(analysis.accentColor || '') ? analysis.accentColor : '#00A9CE',
  );

  const setRole = (index, role) => setRoles((prev) => ({ ...prev, [index]: role }));

  const confirm = () => {
    const pages = (analysis.pages || []).map((p) => ({ index: p.index, role: roles[p.index] || p.role }));
    onConfirm(JSON.stringify({ accentColor, pages }));
  };

  const beyondPreviewCap = analysis.pageCount > (analysis.pages || []).length;

  return (
    <div
      role="dialog"
      aria-label="Confirm page roles"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onSkip(); }}
    >
      <div
        style={{
          background: 'var(--surface-color)', borderRadius: 8, border: '1px solid var(--border-color)',
          maxWidth: 760, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 20,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.3)',
        }}
      >
        <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', color: 'var(--accent-color, #6366f1)', marginBottom: 4 }}>
          STEP 2 OF 2
        </div>
        <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>What&apos;s on each page?</h2>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          For each page below, tell us what kind of content it holds — that&apos;s how the
          system knows what to replace with real trip data and what to leave exactly as
          you designed it.{' '}
          {analysis.source === 'ai'
            ? `We took a first guess with AI (${analysis.aiProvider || 'your configured provider'}) — check it&apos;s right.`
            : 'We took a first guess using page layout — check it&apos;s right.'}
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 6 }}>
          <input
            type="color"
            value={HEX_COLOR_RE.test(accentColor) ? accentColor : '#00A9CE'}
            onChange={(e) => setAccentColor(e.target.value)}
            aria-label="Brand accent color"
            style={{ width: 34, height: 34, padding: 0, border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer', background: 'none' }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 600 }}>Brand accent color</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              Used for day bands, headings and accents on every generated PDF.{' '}
              {analysis.accentColor ? 'Detected from your template — check it against the logo/header before confirming.' : "Couldn't detect one automatically — pick the actual brand color here."}
            </div>
          </div>
          <input
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            aria-label="Brand accent color hex value"
            style={{ ...inputStyle, width: 90, fontFamily: 'monospace', fontSize: '0.78rem', padding: '0.3rem 0.4rem' }}
          />
        </div>

        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {(analysis.pages || []).map((p) => (
            <div key={p.index} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  border: '1px solid var(--border-color)', borderRadius: 6, overflow: 'hidden',
                  aspectRatio: '1 / 1.3', background: 'var(--bg-color, #1a1a1a)',
                  backgroundImage: p.previewImageBase64 ? `url(data:image/png;base64,${p.previewImageBase64})` : undefined,
                  backgroundSize: 'cover', backgroundPosition: 'top center',
                  display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-start',
                }}
              >
                <span
                  style={{
                    margin: 6, padding: '1px 6px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700,
                    background: 'rgba(0,0,0,0.6)', color: '#fff',
                  }}
                >
                  Page {p.index}
                </span>
              </div>
              <select
                value={roles[p.index] || p.role}
                onChange={(e) => setRole(p.index, e.target.value)}
                aria-label={`What's on page ${p.index}`}
                style={{ ...inputStyle, fontSize: '0.76rem', padding: '0.3rem 0.4rem' }}
              >
                {PAGE_ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label.split(' — ')[0]}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {beyondPreviewCap && (
          <p style={{ margin: '12px 0 0', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
            This template has {analysis.pageCount} pages — only the first {(analysis.pages || []).length} show a
            preview here; the rest keep their automatically detected role.
          </p>
        )}

        <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--subtle-bg)', borderRadius: 6, fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          {PAGE_ROLE_OPTIONS.map((o) => (
            <div key={o.value}>
              <strong style={{ color: 'var(--text-primary)' }}>{o.label.split(' — ')[0]}:</strong> {o.label.split(' — ')[1]}
            </div>
          ))}
          <div style={{ marginTop: 4 }}>
            Want to replace what&apos;s on a &quot;Static&quot; page for one specific trip? Do that in
            that itinerary&apos;s Details tab, not here — this only sets the template&apos;s default.
          </div>
        </div>

        <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>
          <button type="button" onClick={confirm} style={primaryBtn}>
            Confirm &amp; save template
          </button>
          <button type="button" onClick={onSkip} style={secondaryBtn}>
            Skip (use automatic detection)
          </button>
        </div>
      </div>
    </div>
  );
}

// G061 — Detail / preview modal (PRD FR-3.1.d). Decomposed into its own
// component so the parent SUT's render cycle stays lean. Renders:
//   - Header: template name + sub-brand badge + duration + base price
//   - Description block (template.description, optional)
//   - Day-by-day item summary grouped by dayNumber (per templateJson.items[])
//   - Leaflet map (MapPreview) with one marker per item with finite lat/lng
//   - Two CTAs: "Clone this template" (primary; fires onClone) + "Close"
function TemplatePreviewModal({
  template,
  items,
  cloning,
  onClone,
  onClose,
  formatPrice,
  formatDuration,
  contacts,
  cloneContactId,
  onContactChange,
}) {
  // Group items by dayNumber for the summary list. Items without a numeric
  // dayNumber go into a synthetic "Unscheduled" bucket so they're still
  // visible to the operator instead of silently dropped.
  const dayGroups = useMemo(() => {
    const map = new Map();
    (items || []).forEach((it) => {
      const day = Number.isFinite(Number(it.dayNumber)) ? Number(it.dayNumber) : 0;
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(it);
    });
    // Sort by dayNumber asc; the 0 (Unscheduled) bucket — when present —
    // lands at the top so the operator sees it before the day-by-day flow.
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [items]);

  // Reference-PDF pages + their stored roles. This is what a PDF style
  // template actually IS, so it leads the preview; the item/map/linked-master
  // panels below are hidden entirely when the template carries no items,
  // since for a style template they are always empty and pure noise.
  const [pdfPages, setPdfPages] = useState(null);
  const [pdfPagesLoading, setPdfPagesLoading] = useState(false);
  useEffect(() => {
    if (!template?.id || !template?.pdfTemplateUrl) { setPdfPages(null); return undefined; }
    let cancelled = false;
    setPdfPagesLoading(true);
    fetchApi(`/api/travel/itinerary-templates/${template.id}/pdf-pages`, { silent: true })
      .then((r) => { if (!cancelled) setPdfPages(r?.hasPdf ? r : null); })
      .catch(() => { if (!cancelled) setPdfPages(null); })
      .finally(() => { if (!cancelled) setPdfPagesLoading(false); });
    return () => { cancelled = true; };
  }, [template?.id, template?.pdfTemplateUrl]);

  const hasItems = (items || []).length > 0;
  // For a PDF STYLE template the item / map / linked-master panels are
  // structurally empty — it has no day-by-day content by design — so they are
  // pure noise and get hidden. A content template with no items is different:
  // there the emptiness is itself the signal (nothing added yet, or a
  // malformed templateJson), so its placeholders still render.
  const isStyleTemplate = Boolean(template?.pdfTemplateUrl);
  const showContentPanels = hasItems || !isStyleTemplate;

  const pinCount = (items || []).filter((it) => {
    if (!it) return false;
    if (it.latitude == null || it.longitude == null) return false;
    const lat = Number(it.latitude);
    const lng = Number(it.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng);
  }).length;

  return (
    <div
      data-testid="template-preview-modal"
      role="dialog"
      aria-label={`Preview ${template.name}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        // Click on backdrop closes; click inside the modal content doesn't.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--surface-color)',
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          maxWidth: 900,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.3)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            padding: 16,
            borderBottom: '1px solid var(--border-color)',
            gap: 12,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }} data-testid="preview-name">
              {template.name}
            </h2>
            <div
              style={{
                marginTop: 6,
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                fontSize: 13,
                color: 'var(--text-secondary)',
              }}
            >
              <span>{template.destinationName}</span>
              <span>•</span>
              <span>{formatDuration(template.durationDays)}</span>
              <span>•</span>
              <span data-testid="preview-base-price">{formatPrice(template)}</span>
              {template.subBrand && (
                <>
                  <span>•</span>
                  <span style={brandBadge}>{template.subBrand}</span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={iconBtn}
            aria-label="Close preview"
            data-testid="preview-close-btn"
          >
            <X size={20} />
          </button>
        </div>

        {/* Description */}
        {template.description && (
          <div
            style={{
              padding: 16,
              borderBottom: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              fontSize: 14,
              lineHeight: 1.5,
            }}
          >
            {template.description}
          </div>
        )}

        {/* Reference PDF pages — what a style template actually is. */}
        {(pdfPagesLoading || pdfPages) && (
          <div style={{ padding: 16, borderBottom: '1px solid var(--border-color)' }} data-testid="preview-pdf-pages-section">
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              Reference PDF — page roles
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
              Every itinerary using this template renders inside these pages. The
              itinerary page grows or shrinks to fit each trip&apos;s real length.
            </div>
            {pdfPagesLoading ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Loading pages…</div>
            ) : (
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
                {(pdfPages.pages || []).map((p) => (
                  <div key={p.index} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div
                      style={{
                        border: '1px solid var(--border-color)', borderRadius: 6, overflow: 'hidden',
                        aspectRatio: '1 / 1.3', background: 'var(--bg-color, #1a1a1a)',
                        backgroundImage: p.previewImageBase64 ? `url(data:image/png;base64,${p.previewImageBase64})` : undefined,
                        backgroundSize: 'cover', backgroundPosition: 'top center',
                      }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Page {p.index}</span>
                      <span
                        style={{
                          padding: '1px 6px', borderRadius: 10, fontSize: '0.66rem', fontWeight: 700,
                          background: 'rgba(59,130,246,0.14)', color: 'var(--primary-color, #2563eb)',
                          textTransform: 'capitalize',
                        }}
                      >
                        {p.role || 'auto'}
                      </span>
                      {p.hasCustomText && (
                        <span style={{ fontSize: '0.64rem', color: 'var(--text-secondary)' }}>· custom text</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Linked data summary — only meaningful for templates that carry
            pre-built day-by-day content; hidden for pure PDF style templates
            where every one of these counts is always zero. */}
        {showContentPanels && (
        <div
          style={{
            padding: 16,
            borderBottom: '1px solid var(--border-color)',
            display: "grid",
            gap: 8,
          }}
          data-testid="preview-linked-data-section"
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
            Linked data
          </div>
          {(() => {
            const summary = summarizeTemplateConnections(items);
            return (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: "var(--text-primary)" }}>
                <span style={metaPill}>Sightseeing: {summary.sightseeing}</span>
                <span style={metaPill}>Cost-linked: {summary.costLinked}</span>
                <span style={metaPill}>Pricing-linked: {summary.pricingLinked}</span>
                <span style={metaPill}>Supplier-linked: {summary.supplierLinked}</span>
              </div>
            );
          })()}
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Review the source masters in <Link to="/travel/sightseeing">Sightseeing Master</Link>, <Link to="/travel/cost-master">Cost Master</Link>, and <Link to="/travel/pricing-rules">Pricing Rules</Link>.
          </div>
        </div>
        )}
        {/* Map preview — same reasoning as above: a style template has no
            items, so it can never have map pins. */}
        {showContentPanels && (
        <div
          style={{
            padding: 16,
            borderBottom: '1px solid var(--border-color)',
          }}
          data-testid="preview-map-section"
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              color: 'var(--text-secondary)',
            }}
          >
            <MapIcon size={16} aria-hidden /> Map preview
            <span
              style={{ fontWeight: 400, marginLeft: 'auto' }}
              data-testid="preview-pin-count"
            >
              {pinCount} pin{pinCount === 1 ? '' : 's'}
            </span>
          </div>
          {pinCount > 0 ? (
            <MapPreview items={items} height={300} />
          ) : (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: 13,
                background: 'var(--subtle-bg)',
                borderRadius: 6,
              }}
              data-testid="preview-no-pins"
            >
              No mapped points of interest yet. The template&apos;s items don&apos;t
              carry latitude / longitude.
            </div>
          )}
        </div>
        )}

        {/* Day-by-day item summary — only for starter-package templates that
            actually carry pre-built content. */}
        {showContentPanels && (
        <div
          style={{
            padding: 16,
            borderBottom: '1px solid var(--border-color)',
          }}
          data-testid="preview-items-section"
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              color: 'var(--text-secondary)',
            }}
          >
            Day-by-day plan
          </div>
          {dayGroups.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: 13,
                background: 'var(--subtle-bg)',
                borderRadius: 6,
              }}
              data-testid="preview-no-items"
            >
              No day-by-day items have been added to this template yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {dayGroups.map(([day, dayItems]) => (
                <div
                  key={day}
                  data-testid={`preview-day-${day}`}
                  style={{
                    background: 'var(--subtle-bg)',
                    borderRadius: 6,
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      marginBottom: 6,
                      color: 'var(--primary-color, var(--accent-color))',
                    }}
                  >
                    {day === 0 ? 'Unscheduled' : `Day ${day}`}
                  </div>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: 18,
                      fontSize: 13,
                      color: 'var(--text-primary)',
                      lineHeight: 1.6,
                    }}
                  >
                    {dayItems.map((it, idx) => (
                      <li key={idx}>
                        {it.itemType && (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--text-secondary)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.4,
                              marginRight: 6,
                            }}
                          >
                            {it.itemType}
                          </span>
                        )}
                        {it.description || it.locationName || '(no description)'}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

        {/* Footer — contact picker + CTAs */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-color)' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, marginBottom: 12 }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
              Assign to customer <span style={{ color: 'var(--accent-color)' }}>*</span>
            </span>
            <select
              value={cloneContactId}
              onChange={(e) => onContactChange(e.target.value)}
              style={selectStyle}
              data-testid="clone-contact-select"
            >
              <option value="">— pick a customer —</option>
              {(contacts || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.email || `Contact #${c.id}`}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={secondaryBtn}
              data-testid="preview-close-footer-btn"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onClone}
              disabled={cloning || !cloneContactId}
              style={cloning || !cloneContactId ? disabledBtn : primaryBtn}
              data-testid="preview-clone-btn"
            >
              <Copy size={14} /> {cloning ? 'Cloning…' : 'Clone this template'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

const metaPill = {
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 10px",
  borderRadius: 999,
  background: "var(--subtle-bg)",
  border: "1px solid var(--border-color)",
};

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};
const selectStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};
const emptyStyle = {
  padding: 32,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 14,
};
const th = {
  position: 'sticky',
  top: 0,
  zIndex: 3,
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--modal-bg, var(--bg-color))',
  backgroundClip: 'padding-box',
  boxShadow: 'inset 0 -1px 0 var(--border-color)',
};
const sortButtonStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, width: '100%', padding: '4px 8px', border: 'none', borderRadius: 999, background: 'transparent', color: 'inherit', font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', cursor: 'pointer', textAlign: 'left', transition: 'background-color 0.15s ease, color 0.15s ease' };
const sortButtonActiveStyle = { color: 'var(--primary-color)' };
const td = { padding: '10px 12px', fontSize: 14, color: 'var(--text-primary)' };
const brandBadge = {
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: 'var(--subtle-bg-3)',
  color: 'var(--primary-color, var(--accent-color))',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};
const statusBadgeBase = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
};
const statusBadgeActive = {
  ...statusBadgeBase,
  background: 'rgba(34, 197, 94, 0.12)',
  color: 'rgb(22, 163, 74)',
};
const statusBadgeInactive = {
  ...statusBadgeBase,
  background: 'rgba(107, 114, 128, 0.14)',
  color: 'rgb(75, 85, 99)',
};
const statusBadgeArchived = {
  ...statusBadgeBase,
  background: 'rgba(245, 158, 11, 0.16)',
  color: 'rgb(180, 83, 9)',
};
const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
};
const secondaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  cursor: 'pointer',
};
const disabledBtn = { ...secondaryBtn, opacity: 0.5, cursor: 'not-allowed' };
const iconBtn = {
  padding: 4,
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: 'none',
  cursor: 'pointer',
};
