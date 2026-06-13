// Travel CRM — Itinerary Template Library admin page.
//
// #907 slice 7/N. Consumes the ItineraryTemplate CRUD shipped in slice 6
// (8972b8ca): GET /api/travel/itinerary-templates + POST + PATCH + DELETE.
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

import React, { useState, useEffect, useCallback, useContext } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Download, Edit2, Filter, FileText, Plus, Trash2, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import { useActiveSubBrand } from '../../utils/subBrand';
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from '../../utils/travelSubBrand';

const SUB_BRANDS = [
  { value: '', label: 'All sub-brands' },
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

const PAGE_SIZE = 20;

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
  llmGeneratedBy: '',
  isActive: true,
};

export default function ItineraryTemplates() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();

  // Sub-brand access: ADMIN / unrestricted users get a dropdown of all their
  // accessible brands; single-brand users get the field locked read-only; 2-3
  // brand users get a dropdown limited to THEIR brands. See defaultSubBrandFor.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [destinationFilter, setDestinationFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [subBrandFilter, setSubBrandFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  // G048 — show archived rows. When true, the list endpoint receives
  // ?includeArchived=true and surfaces archived rows alongside live ones.
  // Operator can then click Restore to bring a row back.
  const [includeArchived, setIncludeArchived] = useState(false);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  const fetchItems = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (destinationFilter.trim()) qs.set('destinationName', destinationFilter.trim());
    if (categoryFilter) qs.set('category', categoryFilter);
    if (subBrandFilter) qs.set('subBrand', subBrandFilter);
    if (activeOnly) qs.set('isActive', 'true');
    else qs.set('isActive', 'false');
    if (includeArchived) qs.set('includeArchived', 'true');
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));
    fetchApi(`/api/travel/itinerary-templates?${qs.toString()}`)
      .then((res) => {
        setItems(Array.isArray(res?.items) ? res.items : []);
        setTotal(Number(res?.total) || 0);
      })
      .catch((e) => {
        notify.error(e?.body?.error || 'Failed to load itinerary templates');
        setItems([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [destinationFilter, categoryFilter, subBrandFilter, activeOnly, includeArchived, offset, notify]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
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
      llmGeneratedBy: item.llmGeneratedBy || '',
      isActive: item.isActive !== false,
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
    if (!form.destinationName.trim()) {
      notify.error('destinationName is required');
      return;
    }
    if (!form.durationDays || Number(form.durationDays) < 1) {
      notify.error('durationDays is required (positive integer)');
      return;
    }

    const payload = {
      name: form.name.trim(),
      destinationName: form.destinationName.trim(),
      durationDays: Number(form.durationDays),
      description: form.description.trim() || null,
      thumbnailUrl: form.thumbnailUrl.trim() || null,
      category: form.category || null,
      subBrand: form.subBrand || null,
      defaultMarkupPercent: form.defaultMarkupPercent
        ? Number(form.defaultMarkupPercent)
        : null,
      basePriceMinor: form.basePriceMinor ? Number(form.basePriceMinor) : null,
      currency: form.currency.trim() || null,
      llmGeneratedBy: form.llmGeneratedBy.trim() || null,
      isActive: form.isActive !== false,
    };

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
      fetchItems();
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
      fetchItems();
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to delete template');
    }
  };

  // G048 — archive a row (stash it from the default library list). Confirms
  // first since this is a visible-state change.
  const handleArchive = async (item) => {
    const ok = await notify.confirm(
      `Archive "${item.name}"? It will be hidden from the default library list (toggle "Include archived" to find it again).`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/itinerary-templates/${item.id}/archive`, {
        method: 'POST',
      });
      notify.success(`Archived "${item.name}"`);
      fetchItems();
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
      fetchItems();
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

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;
  const fromIdx = total === 0 ? 0 : offset + 1;
  const toIdx = Math.min(offset + items.length, total);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
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
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
            <FileText size={28} aria-hidden /> Itinerary Template Library
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
            Pre-loaded itinerary templates — destination, duration, base price, sub-brand
            affinity. Operators clone these into new itineraries via the builder. The
            sightseeing catalogue lives in{' '}
            <Link
              to="/travel/sightseeing"
              style={{ color: 'var(--primary-color, var(--accent-color))' }}
            >
              Sightseeing Master
            </Link>
            .
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
            <Download size={14} /> Export CSV
          </button>
          {!showForm && (
            <button type="button" onClick={openCreateForm} style={primaryBtn}>
              <Plus size={14} /> Add template
            </button>
          )}
        </div>
      </div>

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
              setOffset(0);
              setDestinationFilter(e.target.value);
            }}
            placeholder="Filter by destination"
            aria-label="Destination filter"
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => {
            setOffset(0);
            setCategoryFilter(e.target.value);
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
            setOffset(0);
            setSubBrandFilter(e.target.value);
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
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => {
              setOffset(0);
              setActiveOnly(e.target.checked);
            }}
            aria-label="Active only"
          />
          Active only
        </label>
        {/* G048 — Include archived rows in the list. Off by default; when
            on, archived rows surface and the operator can click the
            Restore icon to bring them back. */}
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => {
              setOffset(0);
              setIncludeArchived(e.target.checked);
            }}
            aria-label="Include archived"
          />
          Include archived
        </label>
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
              {editingId ? 'Edit itinerary template' : 'Add itinerary template'}
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
            <Field label="Destination *">
              <input
                value={form.destinationName}
                onChange={(e) => setForm({ ...form, destinationName: e.target.value })}
                placeholder="e.g. Makkah + Madinah"
                aria-label="destinationName"
                style={inputStyle}
              />
            </Field>
            <Field label="Duration (days) *">
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
            <Field label="Thumbnail URL">
              <input
                value={form.thumbnailUrl}
                onChange={(e) => setForm({ ...form, thumbnailUrl: e.target.value })}
                placeholder="https://…"
                aria-label="thumbnailUrl"
                style={inputStyle}
              />
            </Field>
            <Field label="LLM source (if AI-drafted)">
              <input
                value={form.llmGeneratedBy}
                onChange={(e) => setForm({ ...form, llmGeneratedBy: e.target.value })}
                placeholder="e.g. gemini-2.5-flash"
                aria-label="llmGeneratedBy"
                style={inputStyle}
              />
            </Field>
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
          overflow: 'hidden',
        }}
      >
        {loading ? (
          <div style={emptyStyle}>Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div style={emptyStyle}>No itinerary templates yet. Add one above.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Destination</th>
                <th style={th}>Duration</th>
                <th style={th}>Category</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Markup</th>
                <th style={th}>Base price</th>
                <th style={th}>Usage</th>
                {/* G049 — library metrics (PRD FR-3.1.h). Engine-bumped by
                    routes/travel_itineraries.js on clone + accept; the
                    /:id response includes these fields by default. */}
                <th style={th}>Accepted</th>
                <th style={th}>Avg sale</th>
                <th style={th}>Last used</th>
                <th style={th}>Active</th>
                {/* G048 — version column. Editing a template bumps the
                    visible version while preserving the previous row's id
                    so existing Itinerary.clonedFromTemplateId FKs stay
                    valid. */}
                <th style={th}>Ver</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  style={{
                    borderTop: '1px solid var(--border-light)',
                    opacity: item.isActive ? 1 : 0.5,
                  }}
                >
                  <td style={td}>
                    <strong>{item.name}</strong>
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
                  <td style={td}>{item.isActive ? 'Yes' : 'No'}</td>
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
        )}
      </div>

      {/* Pagination */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 12,
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}
      >
        <div>
          {total === 0
            ? 'No results'
            : `Showing ${fromIdx}-${toIdx} of ${total}`}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => canPrev && setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={!canPrev}
            style={canPrev ? secondaryBtn : disabledBtn}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            type="button"
            onClick={() => canNext && setOffset(offset + PAGE_SIZE)}
            disabled={!canNext}
            style={canNext ? secondaryBtn : disabledBtn}
            aria-label="Next page"
          >
            Next <ChevronRight size={14} />
          </button>
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
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--subtle-bg)',
};
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
