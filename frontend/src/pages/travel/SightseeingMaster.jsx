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
//   - Prompt referenced "pagination Prev/Next/page-size"; using a single
//     offset+limit pair (Prev/Next, limit=20) keeps the page lean and
//     mirrors the Phase-1 admin-table shape across travel/* siblings.

import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Edit2, Filter, MapPin, Plus, Trash2, Upload, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import { useActiveSubBrand } from '../../utils/subBrand';
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
  durationMinutes: '',
  priceReferenceMinor: '',
  currency: 'INR',
  category: '',
  subBrand: '',
  notes: '',
};

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
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [destinationFilter, setDestinationFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  // Image upload
  const imgInputRef = useRef(null);
  const [uploadingImg, setUploadingImg] = useState(false);

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

  const fetchItems = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (destinationFilter.trim()) qs.set('destinationName', destinationFilter.trim());
    if (categoryFilter) qs.set('category', categoryFilter);
    if (activeOnly) qs.set('isActive', 'true');
    else qs.set('isActive', 'false');
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));
    fetchApi(`/api/travel/sightseeing?${qs.toString()}`)
      .then((res) => {
        setItems(Array.isArray(res?.items) ? res.items : []);
        setTotal(Number(res?.total) || 0);
      })
      .catch((e) => {
        notify.error(e?.body?.error || 'Failed to load sightseeing entries');
        setItems([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [destinationFilter, categoryFilter, activeOnly, offset, notify]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setEditingId(null);
    setShowForm(true);
  };

  const handleEdit = (item) => {
    setForm({
      destinationName: item.destinationName || '',
      name: item.name || '',
      description: item.description || '',
      imageUrl: item.imageUrl || '',
      durationMinutes: item.durationMinutes != null ? String(item.durationMinutes) : '',
      priceReferenceMinor:
        item.priceReferenceMinor != null ? String(item.priceReferenceMinor) : '',
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
      durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null,
      priceReferenceMinor: form.priceReferenceMinor
        ? Number(form.priceReferenceMinor)
        : null,
      currency: form.currency.trim() || null,
      category: form.category || null,
      subBrand: form.subBrand || null,
      notes: form.notes.trim() || null,
    };

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
      fetchItems();
    } catch (err) {
      notify.error(err?.body?.error || 'Failed to save entry');
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
      fetchItems();
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
            <MapPin size={28} aria-hidden /> Sightseeing Master
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
          {!showForm && (
            <button type="button" onClick={openCreate} style={primaryBtn}>
              <Plus size={14} /> Add sightseeing
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
                  {myBrands.map((b) => (
                    <option key={b} value={b}>
                      {subBrandShortLabel(b)}
                    </option>
                  ))}
                </select>
              )}
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
            <Field label="Price reference (minor units)">
              <input
                type="number"
                min={0}
                value={form.priceReferenceMinor}
                onChange={(e) =>
                  setForm({ ...form, priceReferenceMinor: e.target.value })
                }
                placeholder="e.g. 50000 for ₹500"
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
          overflow: 'hidden',
        }}
      >
        {loading ? (
          <div style={emptyStyle}>Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div style={emptyStyle}>No sightseeing entries yet. Add one above.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Destination</th>
                <th style={th}>POI name</th>
                <th style={th}>Category</th>
                <th style={th}>Duration</th>
                <th style={th}>Price ref.</th>
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
