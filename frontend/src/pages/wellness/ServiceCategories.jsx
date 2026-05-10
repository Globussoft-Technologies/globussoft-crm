/**
 * Wave 7 Agent A — Service Categories admin page (PRD Gap §10 #1).
 *
 * Hierarchical taxonomy CRUD for the new ServiceCategory model. Manager+
 * gated via App.jsx's RoleGuard wrapper. Pattern mirrors Locations.jsx —
 * inline form + list + edit-in-place + soft-toggle isActive.
 */
import { useEffect, useState } from 'react';
import { Stethoscope, Plus, Pencil } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY_FORM = { name: '', parentId: '', displayOrder: 0, isActive: true };

export default function ServiceCategories() {
  const notify = useNotify();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

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
          <button type="submit" disabled={saving} style={{ gridColumn: '1 / -1', padding: '0.6rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 6 }}>
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
                  <td style={{ padding: '0.5rem 0' }}>{c.name}</td>
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
