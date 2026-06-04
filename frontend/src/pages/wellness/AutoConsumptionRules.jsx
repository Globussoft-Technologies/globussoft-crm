// Wave 11 Agent HH — Auto-consumption rules admin page.
// One rule per (service, product) — when a visit completes, server-side
// applier decrements stock + writes a ServiceConsumption row.

import { useEffect, useState } from 'react';
import { Recycle, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import PageHeader from '../../components/PageHeader';

const UNIT_OPTIONS = ['ml', 'gm', 'kg', 'piece', 'unit', 'bottle', 'tube', 'pack', 'ltr'];
const EMPTY = { serviceId: '', productId: '', quantityPerVisit: '', unit: '', isActive: true };

export default function AutoConsumptionRules() {
  const notify = useNotify();
  // Backend gates POST/PUT/DELETE /auto-consumption-rules on products.manage.
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canManage = permsReady && hasPermission('products', 'manage');
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
      unit: r.unit || '',
      isActive: r.isActive !== false,
    });
    setShowForm(true);
  };

  const productForId = (id) => products.find((p) => String(p.id) === String(id));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        serviceId: parseInt(form.serviceId),
        productId: parseInt(form.productId),
        quantityPerVisit: parseFloat(form.quantityPerVisit),
        unit: form.unit || null,
        isActive: form.isActive,
      };
      if (editingId) {
        // Only quantityPerVisit + unit + isActive are updatable; svc + product
        // changes require delete + recreate.
        await fetchApi(`/api/wellness/auto-consumption-rules/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({
            quantityPerVisit: payload.quantityPerVisit,
            unit: payload.unit,
            isActive: payload.isActive,
          }),
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
    const ok = await notify.confirm({
      title: 'Delete auto-consumption rule',
      message:
        'Delete this auto-consumption rule? Future visits will no longer auto-decrement stock for this service+product.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/auto-consumption-rules/${r.id}`, { method: 'DELETE' });
      notify.success('Rule deleted.');
      load();
    } catch (_err) { /* toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={Recycle}
        title="Auto-consumption rules"
        description="When a visit completes for the matching service, the listed product is automatically consumed in the configured quantity."
        inlineBadge={permsReady && !canManage ? (
          <span
            title="You can view rules but can't make changes."
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', borderRadius: 999, background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', fontWeight: 500 }}
          >
            View only
          </span>
        ) : null}
      >
        {canManage && (
          <button onClick={() => (showForm ? reset() : setShowForm(true))} style={primaryBtnStyle}>
            <Plus size={16} /> {showForm ? 'Cancel' : 'New rule'}
          </button>
        )}
      </PageHeader>

      {showForm && canManage && (
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
            <input type="number" min="0.01" step="0.01" required placeholder="e.g., 15" value={form.quantityPerVisit} onChange={(e) => setForm({ ...form, quantityPerVisit: e.target.value })} style={inputStyle} title="Quantity consumed per completed treatment" />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Consumed per completed treatment</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} style={inputStyle} title="Unit the quantity above is expressed in">
              <option value="">Unit (default: product&apos;s){productForId(form.productId)?.unit ? ` — ${productForId(form.productId).unit}` : ''}</option>
              {UNIT_OPTIONS.map((u) => (<option key={u} value={u}>{u}</option>))}
            </select>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {productForId(form.productId)?.unit
                ? `Product stocked in ${productForId(form.productId).unit}. ml↔ltr and gm↔kg auto-convert.`
                : 'ml, gm, kg, piece, bottle, etc.'}
            </span>
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
                <th style={cellStyle} title="Quantity consumed per completed visit">Qty / visit</th>
                <th style={cellStyle}>Unit</th>
                <th style={cellStyle}>Stock</th>
                <th style={cellStyle}>Status</th>
                {canManage && <th style={cellStyle}></th>}
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={cellStyle}>{r.service?.name || `#${r.serviceId}`}</td>
                  <td style={cellStyle}>{r.product?.name || `#${r.productId}`}</td>
                  <td style={cellStyle}>{r.quantityPerVisit}</td>
                  <td style={cellStyle}>{r.unit || r.product?.unit || '—'}</td>
                  <td style={cellStyle}>{r.product?.currentStock ?? '—'}</td>
                  <td style={cellStyle}>{r.isActive ? 'Active' : 'Inactive'}</td>
                  {canManage && (
                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                      <button onClick={() => startEdit(r)} style={iconBtnStyle} aria-label="Edit rule"><Pencil size={14} /></button>
                      <button onClick={() => remove(r)} style={iconBtnStyle} aria-label="Delete rule"><Trash2 size={14} /></button>
                    </td>
                  )}
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
