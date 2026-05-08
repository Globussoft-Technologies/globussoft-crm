// Wave 11 Agent HH — Inventory receipts admin page.
// Lists prior receipts and lets admins record new ones (which increments
// Product.currentStock as a server-side side effect — no client-side stock
// math here).

import { useEffect, useState } from 'react';
import { ArrowDownToLine, Plus, Calendar } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY = {
  productId: '', vendorId: '', quantity: '', unitCost: '',
  batchNumber: '', expiryDate: '', notes: '',
};

export default function InventoryReceipts() {
  const notify = useNotify();
  const [receipts, setReceipts] = useState([]);
  const [products, setProducts] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState({ from: '', to: '' });

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter.from) qs.set('from', filter.from);
    if (filter.to) qs.set('to', filter.to);
    Promise.all([
      fetchApi(`/api/wellness/inventory/receipts${qs.toString() ? `?${qs}` : ''}`).catch(() => []),
      fetchApi('/api/products').catch(() => []),
      fetchApi('/api/wellness/vendors').catch(() => []),
    ]).then(([recs, prods, vens]) => {
      setReceipts(Array.isArray(recs) ? recs : []);
      setProducts(Array.isArray(prods) ? prods : []);
      setVendors(Array.isArray(vens) ? vens.filter((v) => v.isActive) : []);
    }).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        productId: parseInt(form.productId),
        vendorId: form.vendorId ? parseInt(form.vendorId) : null,
        quantity: parseFloat(form.quantity),
        unitCost: parseFloat(form.unitCost),
        batchNumber: form.batchNumber || null,
        expiryDate: form.expiryDate || null,
        notes: form.notes || null,
      };
      const created = await fetchApi('/api/wellness/inventory/receipts', { method: 'POST', body: JSON.stringify(payload) });
      notify.success(`Recorded ${created?.receiptNumber || 'receipt'}; stock updated.`);
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (_err) { /* toasted */ }
    setSaving(false);
  };

  const totalCost = receipts.reduce((s, r) => s + (r.totalCost || 0), 0);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ArrowDownToLine size={24} /> Inventory receipts
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {receipts.length} receipt{receipts.length === 1 ? '' : 's'} in window — total cost ₹{Number(totalCost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} style={primaryBtnStyle}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'Record receipt'}
        </button>
      </header>

      <div className="glass" style={{ padding: '0.85rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <Calendar size={16} />
        <label style={{ fontSize: '0.85rem' }}>From <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} style={inputStyle} /></label>
        <label style={{ fontSize: '0.85rem' }}>To <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} style={inputStyle} /></label>
        <button onClick={load} style={secondaryBtnStyle}>Apply</button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.5rem' }}>
          <select required value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} style={inputStyle}>
            <option value="">Select product…</option>
            {products.map((p) => (<option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>))}
          </select>
          <select value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })} style={inputStyle}>
            <option value="">No vendor</option>
            {vendors.map((v) => (<option key={v.id} value={v.id}>{v.name}</option>))}
          </select>
          <input type="number" min="0.01" step="0.01" required placeholder="Quantity" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} style={inputStyle} />
          <input type="number" min="0" step="0.01" required placeholder="Unit cost" value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} style={inputStyle} />
          <input placeholder="Batch number" value={form.batchNumber} onChange={(e) => setForm({ ...form, batchNumber: e.target.value })} style={inputStyle} />
          <input type="date" placeholder="Expiry date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} style={inputStyle} />
          <input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, gridColumn: 'span 2' }} />
          <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
            {saving ? 'Saving…' : 'Record receipt + update stock'}
          </button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : receipts.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No receipts in window.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Receipt #</th>
                <th style={cellStyle}>Product</th>
                <th style={cellStyle}>Vendor</th>
                <th style={cellStyle}>Qty</th>
                <th style={cellStyle}>Unit cost</th>
                <th style={cellStyle}>Total</th>
                <th style={cellStyle}>Received</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={cellStyle}>{r.receiptNumber}</td>
                  <td style={cellStyle}>{r.product?.name || `#${r.productId}`}</td>
                  <td style={cellStyle}>{r.vendor?.name || '—'}</td>
                  <td style={cellStyle}>{r.quantity}</td>
                  <td style={cellStyle}>₹{r.unitCost}</td>
                  <td style={cellStyle}>₹{r.totalCost}</td>
                  <td style={cellStyle}>{new Date(r.receivedAt).toLocaleDateString()}</td>
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
const secondaryBtnStyle = { padding: '0.4rem 0.75rem', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer' };
const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem' };
