// Wave 11 Agent HH — Inventory adjustments admin page.
// Signed deltas (positive=credit, negative=debit) with a reason enum dropdown.
//
// #842 (2026-05-23): the "Filter by product" dropdown was shipping with only
// "All" when /api/wellness/products returned [] (empty tenant) OR silently
// 4xx'd through the .catch(() => []). Now the dropdown options are a UNION
// of (a) the master products list and (b) products surfaced by the loaded
// adjustments via the GET /inventory/adjustments include. So a tenant with
// adjustments but no separate product master still gets a useful filter.

import { useEffect, useState } from 'react';
import { ScaleIcon, Plus } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const REASONS = ['SHRINKAGE', 'DAMAGE', 'EXPIRY', 'RECOUNT', 'TRANSFER_OUT', 'TRANSFER_IN', 'MANUAL'];
const EMPTY = { productId: '', quantityDelta: '', reason: 'RECOUNT', notes: '' };

export default function InventoryAdjustments() {
  const notify = useNotify();
  const [adjustments, setAdjustments] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [productFilter, setProductFilter] = useState('');

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (productFilter) qs.set('productId', productFilter);
    Promise.all([
      fetchApi(`/api/wellness/inventory/adjustments${qs.toString() ? `?${qs}` : ''}`).catch(() => []),
      fetchApi('/api/wellness/products').catch(() => []),
    ]).then(([adjs, prods]) => {
      setAdjustments(Array.isArray(adjs) ? adjs : []);
      setProducts(Array.isArray(prods) ? prods : []);
    }).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  // #842: the master /products fetch can return [] when no products are
  // seeded for the tenant OR when the fetch silently 4xx's (the .catch
  // above swallows errors). Fall back to deriving options from the
  // adjustments' joined `product` data so the filter dropdown stays
  // useful (the GET /inventory/adjustments include adds product.{id,name,sku}).
  // Union of both ensures a fresh seed shows the full master list AND a
  // partial 4xx still surfaces every product that has historical activity.
  const filterOptions = (() => {
    const seen = new Map();
    for (const p of products) {
      if (p && p.id != null) seen.set(p.id, { id: p.id, name: p.name });
    }
    for (const a of adjustments) {
      if (a?.product?.id != null && !seen.has(a.product.id)) {
        seen.set(a.product.id, { id: a.product.id, name: a.product.name });
      }
    }
    return [...seen.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  })();

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        productId: parseInt(form.productId),
        quantityDelta: parseFloat(form.quantityDelta),
        reason: form.reason,
        notes: form.notes || null,
      };
      await fetchApi('/api/wellness/inventory/adjustments', { method: 'POST', body: JSON.stringify(payload) });
      const direction = payload.quantityDelta > 0 ? 'credited' : 'debited';
      notify.success(`Stock ${direction} by ${Math.abs(payload.quantityDelta)} (${payload.reason})`);
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (_err) { /* toasted */ }
    setSaving(false);
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ScaleIcon size={24} /> Inventory adjustments
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Signed deltas — positive credits stock, negative debits. Use this for shrinkage, damage, recounts, transfers.
          </p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} style={primaryBtnStyle}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'New adjustment'}
        </button>
      </header>

      <div className="glass" style={{ padding: '0.85rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '0.85rem' }}>Filter by product:&nbsp;
          <select value={productFilter} onChange={(e) => setProductFilter(e.target.value)} style={inputStyle}>
            <option value="">All</option>
            {filterOptions.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
        </label>
        <button onClick={load} style={secondaryBtnStyle}>Apply</button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.5rem' }}>
          <select required value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} style={inputStyle}>
            <option value="">Select product…</option>
            {products.map((p) => (<option key={p.id} value={p.id}>{p.name} (stock: {p.currentStock})</option>))}
          </select>
          <input type="number" step="0.01" required placeholder="Quantity delta — e.g. -3 or +5" value={form.quantityDelta} onChange={(e) => setForm({ ...form, quantityDelta: e.target.value })} style={inputStyle} />
          <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} style={inputStyle}>
            {REASONS.map((r) => (<option key={r} value={r}>{r}</option>))}
          </select>
          <input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, gridColumn: 'span 2' }} />
          <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
            {saving ? 'Saving…' : 'Apply adjustment'}
          </button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : adjustments.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No adjustments recorded.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Date</th>
                <th style={cellStyle}>Product</th>
                <th style={cellStyle}>Δ</th>
                <th style={cellStyle}>Reason</th>
                <th style={cellStyle}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={cellStyle}>{new Date(a.createdAt).toLocaleString()}</td>
                  <td style={cellStyle}>{a.product?.name || `#${a.productId}`}</td>
                  <td style={{ ...cellStyle, color: a.quantityDelta < 0 ? '#c0392b' : '#27ae60', fontWeight: 600 }}>
                    {a.quantityDelta > 0 ? '+' : ''}{a.quantityDelta}
                  </td>
                  <td style={cellStyle}>{a.reason}</td>
                  <td style={cellStyle}>{a.notes || '—'}</td>
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
