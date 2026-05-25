// Zylu-Gap #933 — Products admin list page (precursor for #816 Products CSV
// slice). The Service catalog already has CSV export+import via Services.jsx
// (commit 41d15f8); Products needed its own admin surface before the same
// pattern could clone for the items themselves.
//
// What ships here (tick #195):
//   - Table list view (Name / SKU / Category / Price / Stock / Status).
//     GET /api/wellness/products (router.get in backend/routes/inventory.js).
//   - "+ New product" inline form. POST /api/cpq/products. That's the only
//     surfaced Product-create endpoint today; the Product model itself is
//     shared between the wellness inventory pages and the CPQ catalogue,
//     so creating via /api/cpq/products produces a row visible at
//     /api/wellness/products on the next refresh.
//   - CSV Export + Import — clones the Services.jsx flow verbatim against
//     /api/csv/products/{export,import}.csv (csv_io.js:187 + 202).
//
// What does NOT ship here (deliberate gap, documented for #816 follow-up):
//   - Edit (PUT /api/cpq/products/:id does not exist).
//   - Delete (DELETE /api/cpq/products/:id does not exist).
//   The wellness/products mount only exposes GET; CSV Import handles bulk
//   create + update; per-row edit + delete need a backend follow-up before
//   the front-end can wire them. Issue #933 acceptance is "list + add",
//   plus the CSV buttons that #816 needs.

import { useEffect, useState } from 'react';
import { Package, Plus, Download, Upload } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';

const EMPTY_FORM = {
  name: '',
  sku: '',
  categoryId: '',
  price: '',
  description: '',
  threshold: 0,
  currentStock: 0,
  isRecurring: false,
};

export default function Products() {
  const notify = useNotify();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // #816 — CSV import/export busy state. Same pattern as Services.jsx.
  const [csvBusy, setCsvBusy] = useState(false);

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/products')
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch(() => setProducts([]))
      .finally(() => setLoading(false));
  };

  const loadCategories = () => {
    fetchApi('/api/wellness/product-categories')
      .then((data) => setCategories(Array.isArray(data) ? data : []))
      .catch(() => setCategories([]));
  };

  useEffect(() => {
    load();
    loadCategories();
  }, []);

  const reset = () => {
    setForm(EMPTY_FORM);
    setShowForm(false);
  };

  // #933 — POST goes to /api/cpq/products (the only surfaced create endpoint
  // for the shared Product model). The wellness/products mount is GET-only
  // today; CSV import is the bulk-create path.
  const submit = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      notify.error('Product name is required.');
      return;
    }
    const priceNum = Number(form.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      notify.error('Price must be 0 or greater.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name,
        sku: form.sku.trim() || null,
        description: form.description.trim() || null,
        price: priceNum,
        isRecurring: !!form.isRecurring,
        threshold: parseInt(form.threshold, 10) || 0,
        currentStock: parseInt(form.currentStock, 10) || 0,
      };
      if (form.categoryId) {
        body.categoryId = parseInt(form.categoryId, 10);
      }
      await fetchApi('/api/cpq/products', { method: 'POST', body: JSON.stringify(body) });
      notify.success(`Created "${name}"`);
      reset();
      load();
    } catch (_err) { /* fetchApi already toasted */ }
    setSaving(false);
  };

  // #816 — CSV Export. Auth header is required so we cannot use a plain
  // <a href> download; mirrors Services.jsx + Patients.jsx pattern.
  const exportCsv = async () => {
    setCsvBusy(true);
    try {
      const token = getAuthToken();
      const res = await fetch('/api/csv/products/export.csv', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notify.success(`Exported ${products.length} product${products.length === 1 ? '' : 's'}.`);
    } catch (e) {
      notify.error(e.message || 'CSV export failed.');
    } finally {
      setCsvBusy(false);
    }
  };

  // #816 — CSV Import. Multipart upload to the same csv_io route. Backend
  // returns { imported, updated, skipped, errors: [...] }; toast a summary
  // and re-load on success.
  const importCsv = async (file) => {
    if (!file) return;
    setCsvBusy(true);
    try {
      const token = getAuthToken();
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/csv/products/import.csv', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
      const imported = data.imported || 0;
      const updated = data.updated || 0;
      const skipped = data.skipped || 0;
      const errCount = (data.errors || []).length;
      let msg = `Imported ${imported}`;
      if (updated) msg += `, updated ${updated}`;
      if (skipped) msg += `, skipped ${skipped}`;
      if (errCount) msg += ` (${errCount} row${errCount === 1 ? '' : 's'} with errors)`;
      notify.success(msg);
      load();
    } catch (e) {
      notify.error(e.message || 'CSV import failed.');
    } finally {
      setCsvBusy(false);
    }
  };

  const categoryName = (id) => {
    if (id == null) return '—';
    const cat = categories.find((c) => c.id === id);
    return cat ? cat.name : '—';
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Package size={24} /> Products
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {products.length} product{products.length === 1 ? '' : 's'} — inventory items consumed during visits or sold via POS.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* #816 — Export/Import CSV. Mirrors Zylu's catalog flow + the
              Services.jsx pattern landed at commit 41d15f8. */}
          <button
            type="button"
            onClick={exportCsv}
            disabled={csvBusy || products.length === 0}
            title="Download all products as CSV"
            style={{ ...secondaryBtnStyle, opacity: csvBusy || products.length === 0 ? 0.6 : 1, cursor: csvBusy || products.length === 0 ? 'not-allowed' : 'pointer' }}
          >
            <Download size={16} /> Export CSV
          </button>
          <label
            title="Upload products from CSV (same columns as Export)"
            style={{ ...secondaryBtnStyle, opacity: csvBusy ? 0.6 : 1, cursor: csvBusy ? 'not-allowed' : 'pointer' }}
          >
            <Upload size={16} /> Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={csvBusy}
              aria-label="Import products CSV file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importCsv(file);
                e.target.value = ''; // allow re-import of same filename
              }}
              style={{ display: 'none' }}
            />
          </label>
          <button
            type="button"
            onClick={() => (showForm ? reset() : setShowForm(true))}
            style={primaryBtnStyle}
          >
            <Plus size={16} /> {showForm ? 'Cancel' : 'New product'}
          </button>
        </div>
      </header>

      {showForm && (
        <form
          onSubmit={submit}
          /* #181 (CLAUDE.md standing rule) — disable native HTML5 validation
             so we can surface our own notify.error() inline instead of
             browser-native popovers, which are inconsistent across Chromium
             versions and break under jsdom testing. */
          noValidate
          className="glass"
          style={{
            padding: '1.25rem',
            marginBottom: '1rem',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            gap: '0.6rem',
          }}
        >
          <input
            placeholder="Name — e.g. PRP serum 10ml"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
            aria-label="Product name"
          />
          <input
            placeholder="SKU (optional, unique)"
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
            style={inputStyle}
            aria-label="Product SKU"
          />
          <select
            value={form.categoryId}
            onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            style={inputStyle}
            aria-label="Product category"
          >
            <option value="">— Uncategorised —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Price (e.g. 1500)"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            style={inputStyle}
            aria-label="Product price"
          />
          <input
            type="number"
            min="0"
            step="1"
            placeholder="Current stock"
            value={form.currentStock}
            onChange={(e) => setForm({ ...form, currentStock: e.target.value })}
            style={inputStyle}
            aria-label="Current stock"
          />
          <input
            type="number"
            min="0"
            step="1"
            placeholder="Reorder threshold (0 = disabled)"
            value={form.threshold}
            onChange={(e) => setForm({ ...form, threshold: e.target.value })}
            style={inputStyle}
            aria-label="Reorder threshold"
          />
          <input
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            style={{ ...inputStyle, gridColumn: 'span 2' }}
            aria-label="Product description"
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
            <input
              type="checkbox"
              checked={form.isRecurring}
              onChange={(e) => setForm({ ...form, isRecurring: e.target.checked })}
            />
            Recurring (MRR)
          </label>
          <button
            type="submit"
            disabled={saving}
            style={{ ...primaryBtnStyle, gridColumn: '1 / -1', justifyContent: 'center' }}
          >
            {saving ? 'Saving…' : 'Create product'}
          </button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.5rem 0', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : products.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
            No products yet. Click <strong>New product</strong> or <strong>Import CSV</strong> to add one.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '600px' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Name</th>
                <th style={cellStyle}>SKU</th>
                <th style={cellStyle}>Category</th>
                <th style={cellStyle}>Price</th>
                <th style={cellStyle}>Stock</th>
                <th style={cellStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const lowStock = p.threshold > 0 && p.currentStock <= p.threshold;
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={cellStyle}>{p.name}</td>
                    <td style={cellStyle}>{p.sku || '—'}</td>
                    <td style={cellStyle}>{categoryName(p.categoryId)}</td>
                    <td style={cellStyle}>
                      {p.price != null ? formatMoney(p.price, { maximumFractionDigits: 0 }) : '—'}
                    </td>
                    <td style={cellStyle}>
                      {p.currentStock ?? 0}
                      {p.threshold > 0 && (
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.3rem' }}>
                          / {p.threshold} min
                        </span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      <span
                        style={{
                          background: lowStock ? '#ef4444' : '#10b981',
                          color: '#fff',
                          padding: '0.15rem 0.5rem',
                          borderRadius: 4,
                          fontSize: '0.7rem',
                          textTransform: 'uppercase',
                          fontWeight: 600,
                        }}
                      >
                        {lowStock ? 'Low stock' : 'OK'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  fontSize: '0.9rem',
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--text-primary)',
  minWidth: 0,
  boxSizing: 'border-box',
};

const primaryBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.55rem 1rem',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
};

const secondaryBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.55rem 0.9rem',
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  cursor: 'pointer',
};

const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem' };
