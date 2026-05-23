// Wave 11 Agent HH — Inventory receipts admin page.
// Lists prior receipts and lets admins record new ones (which increments
// Product.currentStock as a server-side side effect — no client-side stock
// math here).
//
// #843 (Cron tick #26 / Agent 2) — UI/UX polish:
//   1. Search bar — enlarged client-side filter across receipt #, supplier,
//      product name/SKU, batch, notes. Sits prominently above the date row.
//   2. Date filter — replaced bare From/To with the preset-dropdown pattern
//      from Payments.jsx (#846): Today / Yesterday / Last 7 days / This month
//      / Custom… — same shape used by the Case-history-style filter that the
//      issue cross-references. Custom mode reveals the two date inputs.
//   3. Default to today — initial datePreset is 'today' (not 'all'), so the
//      page lands on today's receipts instead of "No receipts in window."
// Backend GET /api/wellness/inventory/receipts already supports ?from&to with
// the validateDateRange (#665) guard, so no backend change was needed.

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, Plus, Calendar, Search } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY = {
  productId: '', vendorId: '', quantity: '', unitCost: '',
  batchNumber: '', expiryDate: '', notes: '',
};

// #843 — preset → {from, to} date-range resolver. Mirrors the pattern in
// frontend/src/pages/Payments.jsx so the UX is consistent across the app.
// Returns ISO date strings (YYYY-MM-DD) in the browser's local timezone,
// which is what the backend's validateDateRange + Prisma `gte/lte` expect.
function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rangeFromPreset(preset) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today':
      return { from: toIsoDate(today), to: toIsoDate(today) };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(today.getDate() - 1);
      return { from: toIsoDate(y), to: toIsoDate(y) };
    }
    case 'week7': {
      const f = new Date(today);
      f.setDate(today.getDate() - 6);
      return { from: toIsoDate(f), to: toIsoDate(today) };
    }
    case 'month': {
      const f = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: toIsoDate(f), to: toIsoDate(today) };
    }
    case 'all':
    default:
      return { from: null, to: null };
  }
}

const DATE_PRESETS = [
  { value: 'today',     label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week7',     label: 'Last 7 days' },
  { value: 'month',     label: 'This month' },
  { value: 'all',       label: 'All time' },
  { value: 'custom',    label: 'Custom…' },
];

export default function InventoryReceipts() {
  const notify = useNotify();
  const [receipts, setReceipts] = useState([]);
  const [products, setProducts] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  // #843 — default landing window is TODAY (not 'all'), so the page is useful
  // immediately on open. Operator can broaden via the preset dropdown.
  const [datePreset, setDatePreset] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // #843 — client-side free-text filter across receipt #, supplier name,
  // product name/SKU, batch, notes. Kept client-side because list size is
  // capped at 500 by the backend; a server-side search isn't justified yet.
  const [search, setSearch] = useState('');

  const effectiveRange = useMemo(() => {
    if (datePreset === 'custom') {
      return { from: customFrom || null, to: customTo || null };
    }
    return rangeFromPreset(datePreset);
  }, [datePreset, customFrom, customTo]);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (effectiveRange.from) qs.set('from', effectiveRange.from);
    if (effectiveRange.to) qs.set('to', effectiveRange.to);
    Promise.all([
      fetchApi(`/api/wellness/inventory/receipts${qs.toString() ? `?${qs}` : ''}`).catch(() => []),
      fetchApi('/api/wellness/products').catch(() => []),
      fetchApi('/api/wellness/vendors').catch(() => []),
    ]).then(([recs, prods, vens]) => {
      setReceipts(Array.isArray(recs) ? recs : []);
      setProducts(Array.isArray(prods) ? prods : []);
      setVendors(Array.isArray(vens) ? vens.filter((v) => v.isActive) : []);
    }).finally(() => setLoading(false));
  };
  // #843 — re-fetch when the effective date range changes. Same shape as
  // Payments.jsx (#846). Custom-mode with both inputs blank → no params →
  // backend returns unfiltered (preserves the broad-window option).
  useEffect(load, [effectiveRange.from, effectiveRange.to]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // #843 — apply free-text search client-side. Matches across the same fields
  // the issue's placeholder lists (receipt #, supplier, product, batch) plus
  // SKU + notes for completeness.
  const filteredReceipts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return receipts;
    return receipts.filter((r) => {
      const hay = [
        r.receiptNumber,
        r.vendor?.name,
        r.product?.name,
        r.product?.sku,
        r.batchNumber,
        r.notes,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [receipts, search]);

  const totalCost = filteredReceipts.reduce((s, r) => s + (r.totalCost || 0), 0);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ArrowDownToLine size={24} /> Inventory receipts
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {filteredReceipts.length} receipt{filteredReceipts.length === 1 ? '' : 's'} in window — total cost ₹{Number(totalCost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} style={primaryBtnStyle}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'Record receipt'}
        </button>
      </header>

      {/* #843 — Search bar (enlarged, full-width, prominent). Lives above the
          date-filter row so it reads as the primary entry-point for narrowing
          the list. Icon + larger padding + bigger font signal that it's a
          first-class control rather than a tucked-away filter field. */}
      <div className="glass" style={{ padding: '0.75rem 1rem', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <Search size={18} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by invoice #, supplier, product, batch…"
          aria-label="Search inventory receipts"
          style={{
            flex: 1,
            padding: '0.65rem 0.85rem',
            fontSize: '1rem',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--text)',
            minWidth: 0,
          }}
        />
      </div>

      {/* #843 — Date filter (preset dropdown, mirroring Payments.jsx #846).
          The Custom… option reveals two date inputs for arbitrary windows.
          Defaults to "Today" so the page lands on today's data. */}
      <div className="glass" style={{ padding: '0.85rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <Calendar size={16} />
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }} htmlFor="receipts-date-preset">
          Date:
        </label>
        <select
          id="receipts-date-preset"
          value={datePreset}
          onChange={(e) => setDatePreset(e.target.value)}
          aria-label="Filter receipts by date"
          style={inputStyle}
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        {datePreset === 'custom' && (
          <>
            <label style={{ fontSize: '0.85rem' }}>
              From{' '}
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="Custom from date"
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: '0.85rem' }}>
              To{' '}
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="Custom to date"
                style={inputStyle}
              />
            </label>
          </>
        )}
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
        ) : filteredReceipts.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
            {search.trim() ? 'No receipts match your search.' : 'No receipts in window.'}
          </div>
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
              {filteredReceipts.map((r) => (
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
const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem' };
