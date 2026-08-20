// Travel CRM — Sightseeing Master admin page.
//
// #907 slice 3/N. Consumes the TravelSightseeing CRUD shipped in slice 2
// (a8715895): GET /api/travel/sightseeing (paginated list) + POST + PATCH +
// DELETE (soft-delete via isActive=false).
//
// Slice 4 will wire the sidebar entry + App.jsx route at /travel/sightseeing.
// This slice ships ONLY the page + its test.
//
// Backend contract (per backend/routes/travel_sightseeing.js):
//   GET    /api/travel/sightseeing?destinationName=&category=&isActive=&subBrand=&limit=&offset=
//          → 200 { items: [...], total, limit, offset }
//   POST   /api/travel/sightseeing  body: { destinationName(req), name(req),
//                                            description?, imageUrl?, durationMinutes?,
//                                            priceReferenceMinor?, currency? (3-letter ISO),
//                                            category?, subBrand?, notes?, isActive? }
//          → 201 created row | 400 MISSING_DESTINATION | 400 MISSING_NAME | 400 INVALID_CURRENCY
//   PATCH  /api/travel/sightseeing/:id  body: partial of the same shape
//   DELETE /api/travel/sightseeing/:id  → soft-delete (returns row with isActive=false)
//
// Drift notes vs the slice-3 prompt:
//   - Prompt referenced `useNotify` at `../hooks/useNotify`; actual hook lives
//     at `../utils/notify` (CostMaster.jsx + every other Travel admin page
//     imports from there). Following code reality, not prompt language.
//   - Prompt referenced pagination; this page keeps the backend offset+limit
//     contract and drives page-based requests from the footer pager.

import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Download, Edit2, Filter, MapPin, Plus, Trash2, Upload, X } from 'lucide-react';
import { fetchApi, getActiveTenantId, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import CountBadge from '../../components/CountBadge';
import { AuthContext } from '../../App';
import PatientPager from '../wellness/patients/PatientPager';
import { useActiveSubBrand } from '../../utils/subBrand';
import { geocode } from '../../lib/geocoder';
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from '../../utils/travelSubBrand';

const CATEGORIES = [
  { value: '', label: 'All categories' },
  { value: 'monument', label: 'Monument' },
  { value: 'religious', label: 'Religious site' },
  { value: 'museum', label: 'Museum' },
  { value: 'nature', label: 'Nature / park' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'food', label: 'Food / dining' },
  { value: 'shopping', label: 'Shopping' },
];

const PAGE_SIZE = 20;

const EMPTY_FORM = {
  destinationName: '',
  name: '',
  description: '',
  imageUrl: '',
  latitude: '',
  longitude: '',
  locationSearch: '',
  durationMinutes: '',
  priceReferenceMinor: '',
  currency: 'INR',
  category: '',
  subBrand: '',
  notes: '',
};

function minorToDisplayAmount(value) {
  if (value == null || value === '') return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return String(amount / 100);
}

function displayAmountToMinor(value) {
  const amount = Number.parseFloat(String(value || '').trim());
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

export default function SightseeingMaster() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();

  // Sub-brand access resolution (mirrors Leads.jsx): ADMIN / unrestricted users
  // get a dropdown of all accessible brands; a user restricted to exactly one
  // brand gets that brand auto-selected + a read-only field; 2-3 brand users get
  // a dropdown limited to THEIR brands. See defaultSubBrandFor.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [destinationFilter, setDestinationFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [locating, setLocating] = useState(false);

  // Image upload
  const imgInputRef = useRef(null);
  const importInputRef = useRef(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState(null);

  const pickImageFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingImg(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await fetchApi('/api/travel/sightseeing/upload-image', { method: 'POST', body: fd });
      setForm((prev) => ({ ...prev, imageUrl: data.url }));
      notify.success('Image uploaded');
    } catch (err) {
      notify.error(err?.body?.error || 'Image upload failed');
    } finally {
      setUploadingImg(false);
    }
  };

  const fetchItems = useCallback((currentPage = page, currentPageSize = pageSize) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (destinationFilter.trim()) qs.set('destinationName', destinationFilter.trim());
    if (categoryFilter) qs.set('category', categoryFilter);
    if (activeOnly) qs.set('isActive', 'true');
    else qs.set('isActive', 'false');
    qs.set('limit', String(currentPageSize));
    qs.set('offset', String(Math.max(currentPage - 1, 0) * currentPageSize));
    fetchApi(`/api/travel/sightseeing?${qs.toString()}`)
      .then((res) => {
        const rows = Array.isArray(res?.items) ? res.items : [];
        const totalCount = Number(res?.total) || 0;
        setItems(rows);
        setTotal(totalCount);
      })
      .catch((e) => {
        notify.error(e?.body?.error || 'Failed to load sightseeing entries');
        setItems([]);
        setTotal(0);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [destinationFilter, categoryFilter, activeOnly, notify, page, pageSize]);

  useEffect(() => {
    fetchItems(page, pageSize);
  }, [fetchItems, page, pageSize, reloadTick]);

  const reloadFirstPage = useCallback(() => {
    setPage(1);
    setReloadTick((t) => t + 1);
  }, []);
  const downloadTemplate = async (format) => {
    try {
      const ext = format === 'xlsx' ? 'xlsx' : 'csv';
      const label = format === 'xlsx' ? 'Excel template' : 'CSV template';
      const res = await fetch(`/api/travel/sightseeing/import-template?format=${ext}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (!res.ok) throw new Error(`Failed to download ${label.toLowerCase()}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `travel-sightseeing-template.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(err?.message || `Failed to download ${format} template`);
    }
  };

  const importCsv = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/travel/sightseeing/import.csv', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: formData,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Import failed (${res.status})`);
      setImportSummary(body);
      const summary = `Imported ${body.imported || 0}, updated ${body.updated || 0}, skipped ${body.skipped || 0}`;
      if (body.errors?.length) {
        notify.error(`${summary}. First error row ${body.errors[0].rowNumber}: ${body.errors[0].reason}`);
      } else {
        notify.success(summary);
      }
      reloadFirstPage();
    } catch (err) {
      notify.error(err?.message || 'Import failed');
    } finally {
      setImporting(false);
      if (event.target) event.target.value = '';
    }
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const openCreate = () => {
    setForm({
      ...EMPTY_FORM,
      subBrand: defaultSubBrandFor(user, activeSubBrand),
    });
    setEditingId(null);
    setShowForm(true);
  };

  const handleEdit = (item) => {
    setForm({
      destinationName: item.destinationName || '',
      name: item.name || '',
      description: item.description || '',
      imageUrl: item.imageUrl || '',
      latitude: item.latitude != null ? String(item.latitude) : '',
      longitude: item.longitude != null ? String(item.longitude) : '',
      locationSearch: `${item.name || ''} ${item.destinationName || ''}`.trim(),
      durationMinutes: item.durationMinutes != null ? String(item.durationMinutes) : '',
      priceReferenceMinor:
        minorToDisplayAmount(item.priceReferenceMinor),
      currency: item.currency || 'INR',
      category: item.category || '',
      subBrand: item.subBrand || '',
      notes: item.notes || '',
    });
    setEditingId(item.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!form.destinationName.trim()) {
      notify.error('destinationName is required');
      return;
    }
    if (!form.name.trim()) {
      notify.error('name is required');
      return;
    }

    const payload = {
      destinationName: form.destinationName.trim(),
      name: form.name.trim(),
      description: form.description.trim() || null,
      imageUrl: form.imageUrl.trim() || null,
      latitude: form.latitude !== '' ? Number(form.latitude) : null,
      longitude: form.longitude !== '' ? Number(form.longitude) : null,
      durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null,
      priceReferenceMinor: form.priceReferenceMinor
        ? displayAmountToMinor(form.priceReferenceMinor)
        : null,
      currency: form.currency.trim() || null,
      category: form.category || null,
      subBrand: form.subBrand || null,
      notes: form.notes.trim() || null,
    };

    if (payload.latitude != null && (!Number.isFinite(payload.latitude) || payload.latitude < -90 || payload.latitude > 90)) {
      notify.error('Latitude must be between -90 and 90');
      return;
    }
    if (payload.longitude != null && (!Number.isFinite(payload.longitude) || payload.longitude < -180 || payload.longitude > 180)) {
      notify.error('Longitude must be between -180 and 180');
      return;
    }

    try {
      if (editingId) {
        await fetchApi(`/api/travel/sightseeing/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        notify.success('Sightseeing entry updated');
      } else {
        await fetchApi('/api/travel/sightseeing', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify.success('Sightseeing entry added');
      }
      resetForm();
      reloadFirstPage();
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to save entry');
    }
  };

  const handleLocate = async () => {
    const query = String(
      form.locationSearch?.trim() || `${form.name || ''} ${form.destinationName || ''}`.trim(),
    );
    if (!query) {
      notify.error('Enter a place name or destination first');
      return;
    }
    setLocating(true);
    try {
      let result = await geocode(query);
      if (!result && form.destinationName.trim()) {
        result = await geocode(`${form.name || ''} ${form.destinationName}`.trim());
      }
      if (!result) {
        notify.error('Could not auto-find coordinates. You can still type them manually.');
        return;
      }
      setForm((prev) => ({
        ...prev,
        latitude: result.lat.toFixed(6),
        longitude: result.lng.toFixed(6),
        locationSearch: result.display_name || query,
      }));
      notify.success('Location found');
    } finally {
      setLocating(false);
    }
  };

  const handleDelete = async (item) => {
    const ok = await notify.confirm(
      `Soft-delete "${item.name}" (${item.destinationName})? It will be hidden but recoverable.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/sightseeing/${item.id}`, { method: 'DELETE' });
      notify.success('Sightseeing entry removed');
      reloadFirstPage();
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to delete entry');
    }
  };

  const formatPrice = (item) => {
    if (item.priceReferenceMinor == null) return '—';
    const major = Number(item.priceReferenceMinor) / 100;
    const cur = item.currency || 'INR';
    const symbol = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : `${cur} `;
    return `${symbol}${major.toLocaleString()}`;
  };

  const formatDuration = (mins) => {
    if (mins == null) return '—';
    const m = Number(mins);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
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
            <MapPin size={28} aria-hidden /> Sightseeing Master
            <CountBadge count={total} title={`${total.toLocaleString()} sightseeing entries`} />
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
            Destination → POI catalog with description, image, duration, indicative price.{' '}
            <Link to="/travel/cost-master" style={{ color: 'var(--primary-color, var(--accent-color))' }}>
              Cost Master
            </Link>{' '}
            holds the supplier rate book that feeds itinerary pricing.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => downloadTemplate('csv')} style={secondaryBtn}>
            <Download size={14} /> CSV template
          </button>
          <button type="button" onClick={() => downloadTemplate('xlsx')} style={secondaryBtn}>
            <Download size={14} /> Excel template
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            style={secondaryBtn}
            disabled={importing}
            title="Bulk-import sightseeing rows from CSV or Excel using the shared template."
          >
            <Download size={14} /> {importing ? 'Importing...' : 'Import CSV/Excel'}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={importCsv}
            style={{ display: 'none' }}
            aria-label="Upload sightseeing CSV or Excel file"
          />
          {!showForm && (
            <button type="button" onClick={openCreate} style={primaryBtn}>
              <Plus size={14} /> Add sightseeing
            </button>
          )}
        </div>      </div>


      {importSummary && (
        <div
          style={{
            background: 'var(--surface-color)',
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            marginTop: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
            Last import
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
            Imported {importSummary.imported || 0}, updated {importSummary.updated || 0}, skipped {importSummary.skipped || 0} of {importSummary.total || 0} rows.
          </div>
          {Array.isArray(importSummary.errors) && importSummary.errors.length > 0 && (
            <div style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
              {importSummary.errors.slice(0, 3).map((err) => (
                <div key={`${err.rowNumber}-${err.reason}`}>Row {err.rowNumber}: {err.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}
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
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => {
              setActiveOnly(e.target.checked);
              setPage(1);
            }}
            aria-label="Active only"
          />
          Active only
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
              {editingId ? 'Edit sightseeing entry' : 'Add sightseeing entry'}
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
            <Field label="Destination *">
              <input
                value={form.destinationName}
                onChange={(e) => setForm({ ...form, destinationName: e.target.value })}
                placeholder="e.g. Makkah"
                aria-label="destinationName"
                style={inputStyle}
              />
            </Field>
            <Field label="POI name *">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Masjid al-Haram"
                aria-label="name"
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
                // Single-brand user: auto-selected, not editable. The value is
                // already pinned in form.subBrand via defaultSubBrandFor.
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
                  <option value="">Tenant-wide</option>
                  {myBrands.map((b) => (
                    <option key={b} value={b}>
                      {subBrandShortLabel(b)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Location search">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={form.locationSearch}
                  onChange={(e) => setForm({ ...form, locationSearch: e.target.value })}
                  placeholder="e.g. Adiyogi Shiva Statue Bangalore"
                  aria-label="locationSearch"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={handleLocate}
                  disabled={locating}
                  style={{ ...secondaryBtn, whiteSpace: 'nowrap' }}
                >
                  <MapPin size={13} /> {locating ? 'Finding…' : 'Find'}
                </button>
              </div>
            </Field>
            <Field label="Latitude">
              <input
                type="number"
                step="any"
                min={-90}
                max={90}
                value={form.latitude}
                onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                placeholder="Optional"
                aria-label="latitude"
                style={inputStyle}
              />
            </Field>
            <Field label="Longitude">
              <input
                type="number"
                step="any"
                min={-180}
                max={180}
                value={form.longitude}
                onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                placeholder="Optional"
                aria-label="longitude"
                style={inputStyle}
              />
            </Field>
            <Field label="Duration (minutes)">
              <input
                type="number"
                min={0}
                value={form.durationMinutes}
                onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
                placeholder="e.g. 90"
                aria-label="durationMinutes"
                style={inputStyle}
              />
            </Field>
            <Field label="Price reference">
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.priceReferenceMinor}
                onChange={(e) =>
                  setForm({ ...form, priceReferenceMinor: e.target.value })
                }
                placeholder="e.g. 120 for Rs 120"
                aria-label="priceReferenceMinor"
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
            <Field label="Image">
              <input
                ref={imgInputRef}
                type="file"
                accept="image/*"
                onChange={pickImageFile}
                style={{ display: 'none' }}
                aria-label="Upload POI image"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {form.imageUrl ? (
                  <>
                    <img
                      src={form.imageUrl}
                      alt="POI preview"
                      style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border-color)' }}
                    />
                    <button
                      type="button"
                      onClick={() => imgInputRef.current?.click()}
                      disabled={uploadingImg}
                      style={{ ...secondaryBtn, padding: '0.4rem 0.7rem', fontSize: '0.8rem' }}
                    >
                      <Upload size={13} /> {uploadingImg ? 'Uploading…' : 'Replace'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, imageUrl: '' }))}
                      title="Remove image"
                      style={{ ...secondaryBtn, padding: '0.4rem 0.7rem', fontSize: '0.8rem', color: 'var(--danger-color, #ef4444)' }}
                    >
                      <X size={13} /> Remove
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => imgInputRef.current?.click()}
                    disabled={uploadingImg}
                    style={{ ...secondaryBtn, border: '1px dashed var(--border-color)', color: 'var(--text-secondary)' }}
                  >
                    <Upload size={14} /> {uploadingImg ? 'Uploading…' : 'Upload image'}
                  </button>
                )}
              </div>
            </Field>
          </div>

          <div style={{ marginTop: 12 }}>
            <p style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              Location is optional, but adding it helps itineraries drop map pins automatically later.
            </p>
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
            <Field label="Internal notes">
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Operator-only notes (e.g. supplier contact, ticketing details)."
                aria-label="notes"
                rows={2}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
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
          overflow: 'visible',
        }}
      >
        {loading ? (
          <div style={emptyStyle}>Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div style={emptyStyle}>No sightseeing entries yet. Add one above.</div>
        ) : (
          <div
            data-testid="sightseeing-table-scroll"
            style={{
              overflow: 'auto',
              height: 'calc(100vh - 370px)',
              minHeight: 490,
              maxHeight: 730,
            }}
          >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Destination</th>
                <th style={th}>POI name</th>
                <th style={th}>Category</th>
                <th style={th}>Duration</th>
                <th style={th}>Price ref.</th>
                <th style={th}>Map</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Active</th>
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
                  <td style={td}>{item.destinationName}</td>
                  <td style={td}>
                    <strong>{item.name}</strong>
                    {item.description && (
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          marginTop: 2,
                          maxWidth: 360,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.description}
                      </div>
                    )}
                  </td>
                  <td style={td}>{item.category || '—'}</td>
                  <td style={td}>{formatDuration(item.durationMinutes)}</td>
                  <td style={td}>{formatPrice(item)}</td>
                  <td style={td}>
                    {item.latitude != null && item.longitude != null ? 'Mapped' : '—'}
                  </td>
                  <td style={td}>
                    {item.subBrand ? (
                      <span style={brandBadge}>{item.subBrand}</span>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)' }}>tenant</span>
                    )}
                  </td>
                  <td style={td}>{item.isActive ? 'Yes' : 'No'}</td>
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
          onPageChange={setPage}
          onPageSizeChange={(nextSize) => {
            setPageSize(nextSize);
            setPage(1);
          }}
          isCustomPageSize={isCustomPageSize}
          setIsCustomPageSize={setIsCustomPageSize}
          customPageSize={customPageSize}
          setCustomPageSize={setCustomPageSize}
          label="sightseeing entries"
        />
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
  background: 'var(--bg-color, #111318)',
  backgroundClip: 'padding-box',
  position: 'sticky',
  top: 0,
  zIndex: 2,
  boxShadow: '0 1px 0 var(--border-color)',
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
const iconBtn = {
  padding: 4,
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: 'none',
  cursor: 'pointer',
};
