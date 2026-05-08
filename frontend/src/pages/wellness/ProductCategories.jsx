// Wave 11 Agent HH — Inventory ProductCategory admin page.
//
// Lets admins/managers maintain the hierarchical taxonomy that Product rows
// can be filed under (parent + children). The DnD-to-nest from the spec is
// trimmed back here to a "select parent" dropdown — full DnD is a v3.5
// extension once the model is real and the data has shape.

import { useEffect, useState } from 'react';
import { Layers, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY_FORM = { name: '', parentId: '', isActive: true };

export default function ProductCategories() {
  const notify = useNotify();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

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
  };

  const startEdit = (cat) => {
    setEditingId(cat.id);
    setForm({
      name: cat.name || '',
      parentId: cat.parentId == null ? '' : String(cat.parentId),
      isActive: cat.isActive !== false,
    });
    setShowForm(true);
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
      if (editingId) {
        await fetchApi(`/api/wellness/product-categories/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        notify.success(`Updated "${payload.name}"`);
      } else {
        await fetchApi('/api/wellness/product-categories', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify.success(`Created "${payload.name}"`);
      }
      reset();
      load();
    } catch (_err) { /* fetchApi already toasted */ }
    setSaving(false);
  };

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
          <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create category'}
          </button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : categories.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No categories yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Name</th>
                <th style={cellStyle}>Parent</th>
                <th style={cellStyle}>Products</th>
                <th style={cellStyle}>Children</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
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
