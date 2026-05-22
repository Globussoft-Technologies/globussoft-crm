/**
 * Wave 7 Agent A — Service Categories admin page (PRD Gap §10 #1).
 *
 * Hierarchical taxonomy CRUD for the new ServiceCategory model. Manager+
 * gated via App.jsx's RoleGuard wrapper. Pattern mirrors Locations.jsx —
 * inline form + list + edit-in-place + soft-toggle isActive.
 */
import { useEffect, useRef, useState } from 'react';
import { Stethoscope, Plus, Pencil, Upload, X } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY_FORM = { name: '', parentId: '', displayOrder: 0, isActive: true, imageUrl: '' };

// Helper — POST a file to /api/wellness/upload/service-category-image and
// return the URL. Mirrors the multipart pattern used by ProductCategories
// (`file` field, `{ url }` response, same uploadImage helper on the server).
async function uploadImageFile(file) {
  const token = getAuthToken();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/wellness/upload/service-category-image', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  return data.url;
}

export default function ServiceCategories() {
  const notify = useNotify();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const onPickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadImageFile(file);
      setForm((f) => ({ ...f, imageUrl: url }));
      notify.success('Image uploaded');
    } catch (err) {
      notify.error(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/service-categories')
      .then((rows) => setCategories(Array.isArray(rows) ? rows : []))
      .catch(() => setCategories([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(false);
  };

  const startEdit = (cat) => {
    setEditingId(cat.id);
    setForm({
      name: cat.name || '',
      parentId: cat.parentId || '',
      displayOrder: cat.displayOrder || 0,
      isActive: cat.isActive !== false,
      imageUrl: cat.imageUrl || '',
    });
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        parentId: form.parentId ? parseInt(form.parentId) : null,
        displayOrder: form.displayOrder ? parseInt(form.displayOrder) : 0,
        isActive: form.isActive,
        imageUrl: form.imageUrl || null,
      };
      if (editingId) {
        await fetchApi(`/api/wellness/service-categories/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/service-categories', { method: 'POST', body: JSON.stringify(payload) });
        notify.success(`Created "${form.name}"`);
      }
      resetForm();
      load();
    } catch (_err) { /* fetchApi toasts the server message */ }
    setSaving(false);
  };

  const remove = async (cat) => {
    if (!confirm(`Delete "${cat.name}"? Services in this category will keep working but lose the link.`)) return;
    try {
      await fetchApi(`/api/wellness/service-categories/${cat.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${cat.name}"`);
      load();
    } catch (_err) { /* fetchApi toasts */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Stethoscope size={24} /> Service categories
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {categories.length} categor{categories.length === 1 ? 'y' : 'ies'} — hierarchical taxonomy for the service catalogue.
          </p>
        </div>
        <button onClick={() => (showAdd ? resetForm() : setShowAdd(true))} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New category'}
        </button>
      </header>

      {showAdd && (
        <form onSubmit={submit} style={{ background: 'var(--bg-elev)', padding: '1rem', borderRadius: 8, marginBottom: '1.5rem', display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
          <input required placeholder="Name (e.g. Hair Restoration)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.parentId || ''} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
            <option value="">— No parent (root)</option>
            {categories.filter((c) => c.id !== editingId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="number" placeholder="Display order" value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: e.target.value })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={onPickImage}
              style={{ display: 'none' }}
            />
            {form.imageUrl ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <img src={form.imageUrl} alt="" style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border-soft, rgba(255,255,255,0.1))' }} />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid var(--border-soft, rgba(255,255,255,0.15))', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem' }}>
                  <Upload size={13} /> {uploading ? 'Uploading…' : 'Replace'}
                </button>
                <button type="button" onClick={() => setForm({ ...form, imageUrl: '' })} title="Remove image" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid var(--border-soft, rgba(255,255,255,0.15))', borderRadius: 6, color: 'var(--danger-color, #ef4444)', cursor: 'pointer', fontSize: '0.8rem' }}>
                  <X size={13} /> Remove
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.8rem', background: 'transparent', border: '1px dashed var(--border-soft, rgba(255,255,255,0.2))', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}>
                <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload image'}
              </button>
            )}
          </div>
          <button type="submit" disabled={saving || uploading} style={{ gridColumn: '1 / -1', padding: '0.6rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 6 }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create category'}
          </button>
        </form>
      )}

      {loading ? (
        <p>Loading categories…</p>
      ) : categories.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>No categories yet — create one to start grouping services.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th>Image</th>
              <th>Name</th>
              <th>Parent</th>
              <th>Order</th>
              <th>Services</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => {
              const parent = categories.find((p) => p.id === c.parentId);
              return (
                <tr key={c.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '0.5rem 0' }}>
                    {c.imageUrl
                      ? <img src={c.imageUrl} alt="" style={{ width: 40, height: 40, borderRadius: 4, objectFit: 'cover' }} />
                      : <div style={{ width: 40, height: 40, borderRadius: 4, background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>—</div>}
                  </td>
                  <td>{c.name}</td>
                  <td>{parent ? parent.name : '—'}</td>
                  <td>{c.displayOrder}</td>
                  <td>{c._count ? c._count.services : 0}</td>
                  <td>{c.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={() => startEdit(c)} title="Edit"><Pencil size={14} /></button>
                    <button onClick={() => remove(c)} title="Delete">×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
