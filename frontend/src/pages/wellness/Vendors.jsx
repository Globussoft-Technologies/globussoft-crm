// Wave 11 Agent HH — Inventory Vendor admin page.
// Lets admins/managers maintain the supplier master used by InventoryReceipt.

import { useEffect, useState } from 'react';
import { Truck, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY = { name: '', contactPerson: '', phone: '', email: '', gstin: '', addressLine: '', isActive: true };

export default function Vendors() {
  const notify = useNotify();
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/vendors')
      .then((data) => setVendors(Array.isArray(data) ? data : []))
      .catch(() => setVendors([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const reset = () => { setForm(EMPTY); setEditingId(null); setShowForm(false); };
  const startEdit = (v) => {
    setEditingId(v.id);
    setForm({
      name: v.name || '',
      contactPerson: v.contactPerson || '',
      phone: v.phone || '',
      email: v.email || '',
      gstin: v.gstin || '',
      addressLine: v.addressLine || '',
      isActive: v.isActive !== false,
    });
    setShowForm(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/wellness/vendors/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/vendors', { method: 'POST', body: JSON.stringify(form) });
        notify.success(`Created "${form.name}"`);
      }
      reset();
      load();
    } catch (_err) { /* toasted */ }
    setSaving(false);
  };

  const remove = async (v) => {
    if (!window.confirm(`Delete vendor "${v.name}"? Vendors with prior receipts will be deactivated instead.`)) return;
    try {
      await fetchApi(`/api/wellness/vendors/${v.id}`, { method: 'DELETE' });
      notify.success(`Removed "${v.name}"`);
      load();
    } catch (_err) { /* toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Truck size={24} /> Vendors
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {vendors.length} supplier{vendors.length === 1 ? '' : 's'} — used when recording inventory receipts.
          </p>
        </div>
        <button onClick={() => (showForm ? reset() : setShowForm(true))} style={primaryBtnStyle}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'New vendor'}
        </button>
      </header>

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.5rem' }}>
          <input placeholder="Name — e.g. Sterile Supplies Pvt Ltd" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <input placeholder="Contact person" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} style={inputStyle} />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={inputStyle} />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={inputStyle} />
          <input placeholder="GSTIN (15 chars)" maxLength={15} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} style={inputStyle} />
          <input placeholder="Address" value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} style={{ ...inputStyle, gridColumn: 'span 2' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create vendor'}
          </button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : vendors.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No vendors yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Name</th>
                <th style={cellStyle}>Contact</th>
                <th style={cellStyle}>Phone</th>
                <th style={cellStyle}>GSTIN</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={cellStyle}>{v.name}</td>
                  <td style={cellStyle}>{v.contactPerson || '—'}</td>
                  <td style={cellStyle}>{v.phone || '—'}</td>
                  <td style={cellStyle}>{v.gstin || '—'}</td>
                  <td style={cellStyle}>{v.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>
                    <button onClick={() => startEdit(v)} style={iconBtnStyle} aria-label={`Edit ${v.name}`}><Pencil size={14} /></button>
                    <button onClick={() => remove(v)} style={iconBtnStyle} aria-label={`Delete ${v.name}`}><Trash2 size={14} /></button>
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
