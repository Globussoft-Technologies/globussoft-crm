// Wave 11 Agent HH — Inventory ProductCategory admin page.
//
// Lets admins/managers maintain the hierarchical taxonomy that Product rows
// can be filed under (parent + children). The DnD-to-nest from the spec is
// trimmed back here to a "select parent" dropdown — full DnD is a v3.5
// extension once the model is real and the data has shape.
//
// #845 (May 2026) — category image upload. Mirrors the create-then-upload
// flow used by BookingPages: form persists the category first (POST /), then
// uploads the selected file to POST /:id/upload which sets imageUrl. Edit
// mode uploads directly against the existing id. Remove button calls DELETE
// /:id/upload to clear the image without deleting the category itself.

import { useEffect, useState } from 'react';
import { Layers, Plus, Pencil, Trash2, ImageIcon, X as XIcon } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY_FORM = { name: '', parentId: '', isActive: true, imageUrl: '' };
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB — matches backend multer limit
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

export default function ProductCategories() {
  const notify = useNotify();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // #845 — pending image File before submit (create mode uploads after the
  // POST returns an id; edit mode uploads against the existing id immediately).
  const [pendingImage, setPendingImage] = useState(null);
  const [imagePreview, setImagePreview] = useState('');

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/product-categories')
      .then((data) => setCategories(Array.isArray(data) ? data : []))
      .catch(() => setCategories([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const reset = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
    setPendingImage(null);
    setImagePreview('');
  };

  const startEdit = (cat) => {
    setEditingId(cat.id);
    setForm({
      name: cat.name || '',
      parentId: cat.parentId == null ? '' : String(cat.parentId),
      isActive: cat.isActive !== false,
      imageUrl: cat.imageUrl || '',
    });
    setPendingImage(null);
    setImagePreview(cat.imageUrl || '');
    setShowForm(true);
  };

  // #845 — validate + preview the selected file. Browser-side size + type
  // gating mirrors the backend multer config (2 MB, jpg/png/webp/svg).
  const onImagePick = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      notify.error('Image must be 2 MB or smaller');
      e.target.value = '';
      return;
    }
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/i.test(file.type)) {
      notify.error('Only PNG, JPG, WebP, or SVG images are supported');
      e.target.value = '';
      return;
    }
    setPendingImage(file);
    // FileReader gives us a synchronous-ish data: URL for the preview without
    // a network round-trip.
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  // #845 — clear the pending or saved image. In edit mode this hits the
  // server to actually drop the imageUrl + unlink the file; in create mode
  // it just discards the pending pick.
  const clearImage = async () => {
    if (editingId && form.imageUrl) {
      try {
        await fetchApi(`/api/wellness/product-categories/${editingId}/upload`, { method: 'DELETE' });
        notify.success('Image removed');
        setForm((prev) => ({ ...prev, imageUrl: '' }));
        load();
      } catch (_err) { /* toasted */ return; }
    }
    setPendingImage(null);
    setImagePreview('');
  };

  // #845 — upload the multipart file to the category-image endpoint. Used
  // by both create (after the POST returns an id) and edit (against the
  // existing id). Returns the server's normalised imageUrl on success.
  const uploadImageFor = async (categoryId) => {
    if (!pendingImage) return null;
    const fd = new FormData();
    fd.append('file', pendingImage);
    // fetchApi can't be used for FormData (it JSON-stringifies); hit the API
    // directly with the bearer token from localStorage.
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    const res = await fetch(`/api/wellness/product-categories/${categoryId}/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || 'Failed to upload image');
    }
    return res.json();
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        parentId: form.parentId ? parseInt(form.parentId) : null,
        isActive: form.isActive,
      };
      let savedId = editingId;
      if (editingId) {
        await fetchApi(`/api/wellness/product-categories/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        const created = await fetchApi('/api/wellness/product-categories', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        savedId = created?.id;
      }
      // #845 — upload the image AFTER the category exists. If the row save
      // succeeds but the upload fails, the category is still created/updated
      // and the user can re-upload; we surface the upload-specific error.
      if (pendingImage && savedId) {
        try {
          await uploadImageFor(savedId);
        } catch (upErr) {
          notify.error(upErr.message || 'Failed to upload image');
        }
      }
      notify.success(editingId ? `Updated "${payload.name}"` : `Created "${payload.name}"`);
      reset();
      load();
    } catch (_err) { /* fetchApi already toasted */ }
    setSaving(false);
  };

  const filteredCategories = categories.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.name?.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q)
    );
  });

  const remove = async (cat) => {
    if (!window.confirm(`Delete category "${cat.name}"? Products under it will become uncategorised.`)) return;
    try {
      await fetchApi(`/api/wellness/product-categories/${cat.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${cat.name}"`);
      load();
    } catch (_err) { /* toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={24} /> Product categories
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {categories.length} categor{categories.length === 1 ? 'y' : 'ies'} — hierarchical taxonomy for inventory products.
          </p>
        </div>
        <button onClick={() => (showForm ? reset() : setShowForm(true))} style={primaryBtnStyle}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'New category'}
        </button>
      </header>

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.5rem' }}>
          {editingId && (
            <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Editing <strong>{form.name}</strong>
            </div>
          )}
          <input placeholder="Name — e.g. Consumables" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} style={inputStyle}>
            <option value="">No parent (root)</option>
            {categories
              .filter((c) => c.id !== editingId)
              .map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          {/* #845 — image upload row spans the full grid width. Preview shows
              the staged File (create mode) or the existing imageUrl (edit
              mode). Remove button clears the pending pick or, in edit mode,
              hits the DELETE /upload endpoint. */}
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 8,
                border: '1px dashed var(--border-color)',
                background: 'var(--input-bg, rgba(255,255,255,0.04))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
              }}
              aria-label="Category image preview"
            >
              {imagePreview ? (
                <img src={imagePreview} alt="Category preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <ImageIcon size={22} color="var(--text-secondary)" aria-hidden="true" />
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Image (optional) — JPG / PNG / WebP / SVG, up to 2 MB
              </label>
              <input
                type="file"
                accept={IMAGE_ACCEPT}
                onChange={onImagePick}
                aria-label="Choose category image"
                style={{ fontSize: '0.85rem' }}
              />
            </div>
            {(imagePreview || pendingImage) && (
              <button
                type="button"
                onClick={clearImage}
                style={{ ...iconBtnStyle, color: 'var(--danger-color, #dc2626)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                aria-label="Remove image"
              >
                <XIcon size={14} /> Remove
              </button>
            )}
          </div>
          <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create category'}
          </button>
        </form>
      )}

      <div style={{ marginBottom: '0.75rem' }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="search via consumables"
          aria-label="Search categories"
          style={{
            width: '100%',
            maxWidth: '400px',
            padding: '0.6rem 0.9rem',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            background: 'var(--input-bg)',
            color: 'var(--text-primary)',
            fontSize: '0.9rem',
          }}
        />
      </div>

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : categories.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No categories yet.</div>
        ) : filteredCategories.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No categories match "{searchQuery}".</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Image</th>
                <th style={cellStyle}>Name</th>
                <th style={cellStyle}>Parent</th>
                <th style={cellStyle}>Products</th>
                <th style={cellStyle}>Children</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {filteredCategories.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={cellStyle}>
                    {c.imageUrl ? (
                      <img src={c.imageUrl} alt={`${c.name} icon`} style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }} />
                    ) : (
                      <span style={{ display: 'inline-flex', width: 32, height: 32, borderRadius: 4, border: '1px dashed var(--border-color)', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
                        <ImageIcon size={14} color="var(--text-secondary)" />
                      </span>
                    )}
                  </td>
                  <td style={cellStyle}>{c.name}</td>
                  <td style={cellStyle}>{c.parentId ? (categories.find((p) => p.id === c.parentId)?.name || `#${c.parentId}`) : '—'}</td>
                  <td style={cellStyle}>{c._count?.products ?? 0}</td>
                  <td style={cellStyle}>{c._count?.children ?? 0}</td>
                  <td style={cellStyle}>{c.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>
                    <button onClick={() => startEdit(c)} style={iconBtnStyle} aria-label={`Edit ${c.name}`}><Pencil size={14} /></button>
                    <button onClick={() => remove(c)} style={iconBtnStyle} aria-label={`Delete ${c.name}`}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const inputStyle = { padding: '0.55rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.9rem', minWidth: 0 };
const primaryBtnStyle = { display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.55rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' };
const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem' };
const iconBtnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.25rem 0.4rem', color: 'var(--text-secondary)' };
