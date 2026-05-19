// Wave 11 Agent HH — Auto-consumption rules admin page.
// One rule per (service, product) — when a visit completes, server-side
// applier decrements stock + writes a ServiceConsumption row.

import { useEffect, useState } from 'react';
import { Recycle, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY = { serviceId: '', productId: '', quantityPerVisit: '', isActive: true };

export default function AutoConsumptionRules() {
  const notify = useNotify();
  const [rules, setRules] = useState([]);
  const [services, setServices] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi('/api/wellness/auto-consumption-rules').catch(() => []),
      fetchApi('/api/wellness/services').catch(() => []),
      fetchApi('/api/wellness/products').catch(() => []),
    ]).then(([rs, ss, ps]) => {
      setRules(Array.isArray(rs) ? rs : []);
      setServices(Array.isArray(ss) ? ss : []);
      setProducts(Array.isArray(ps) ? ps : []);
    }).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const reset = () => { setForm(EMPTY); setEditingId(null); setShowForm(false); };
  const startEdit = (r) => {
    setEditingId(r.id);
    setForm({
      serviceId: String(r.serviceId),
      productId: String(r.productId),
      quantityPerVisit: String(r.quantityPerVisit),
      isActive: r.isActive !== false,
    });
    setShowForm(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        serviceId: parseInt(form.serviceId),
        productId: parseInt(form.productId),
        quantityPerVisit: parseFloat(form.quantityPerVisit),
        isActive: form.isActive,
      };
      if (editingId) {
        // Only quantityPerVisit + isActive are updatable; svc + product
        // changes require delete + recreate.
        await fetchApi(`/api/wellness/auto-consumption-rules/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ quantityPerVisit: payload.quantityPerVisit, isActive: payload.isActive }),
        });
        notify.success('Rule updated.');
      } else {
        await fetchApi('/api/wellness/auto-consumption-rules', { method: 'POST', body: JSON.stringify(payload) });
        notify.success('Rule created — will fire on next completed visit.');
      }
      reset();
      load();
    } catch (_err) { /* toasted */ }
    setSaving(false);
  };

  const remove = async (r) => {
    if (!window.confirm('Delete this auto-consumption rule? Future visits will no longer auto-decrement stock for this service+product.')) return;
    try {
      await fetchApi(`/api/wellness/auto-consumption-rules/${r.id}`, { method: 'DELETE' });
      notify.success('Rule deleted.');
      load();
    } catch (_err) { /* toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Recycle size={24} /> Auto-consumption rules
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            When a visit completes for the matching service, the listed product is automatically consumed in the configured quantity.
          </p>
        </div>
        <button onClick={() => (showForm ? reset() : setShowForm(true))} style={primaryBtnStyle}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'New rule'}
        </button>
      </header>

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.5rem' }}>
          <select required disabled={!!editingId} value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })} style={inputStyle}>
            <option value="">Service…</option>
            {services.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
          <select required disabled={!!editingId} value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} style={inputStyle}>
            <option value="">Product…</option>
            {products.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <input type="number" min="0.01" step="0.01" required placeholder="e.g., 50 (for 50ml)" value={form.quantityPerVisit} onChange={(e) => setForm({ ...form, quantityPerVisit: e.target.value })} style={inputStyle} title="Quantity consumed per treatment in the product's unit (usually ml)" />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Amount in product's unit (ml, units, etc.)</span>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create rule'}
          </button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : rules.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No rules configured. Add one to start auto-consumption on visits.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Service</th>
                <th style={cellStyle}>Product</th>
                <th style={cellStyle} title="Quantity in product's unit (ml, units, etc.)">Qty / visit</th>
                <th style={cellStyle}>Stock</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={cellStyle}>{r.service?.name || `#${r.serviceId}`}</td>
                  <td style={cellStyle}>{r.product?.name || `#${r.productId}`}</td>
                  <td style={cellStyle}>{r.quantityPerVisit}</td>
                  <td style={cellStyle}>{r.product?.currentStock ?? '—'}</td>
                  <td style={cellStyle}>{r.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>
                    <button onClick={() => startEdit(r)} style={iconBtnStyle} aria-label="Edit rule"><Pencil size={14} /></button>
                    <button onClick={() => remove(r)} style={iconBtnStyle} aria-label="Delete rule"><Trash2 size={14} /></button>
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

const inputStyle = { padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.9rem', minWidth: 0 };
const primaryBtnStyle = { display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.55rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' };
const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem' };
const iconBtnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.25rem 0.4rem', color: 'var(--text-secondary)' };
