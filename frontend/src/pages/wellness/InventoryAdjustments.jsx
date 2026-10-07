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
import { ArrowUpDown, ClipboardList, Package, Plus, ScaleIcon } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import PageHeader from '../../components/PageHeader';
import ModalShell from '../../components/wellness/ModalShell';
import TopScrollSync from '../../components/TopScrollSync';

const REASONS = ['SHRINKAGE', 'DAMAGE', 'EXPIRY', 'RECOUNT', 'TRANSFER_OUT', 'TRANSFER_IN', 'MANUAL'];
const EMPTY = { productId: '', quantityDelta: '', reason: 'RECOUNT', notes: '' };
const PRODUCTS_URL = '/api/wellness/products';
const PRODUCT_PAGE_SIZE = 100;

const FORM_CONTROL_STYLE = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '0.72rem 0.8rem',
  borderRadius: 9,
  border: '1px solid var(--border-color, rgba(120, 110, 90, 0.28))',
  background: 'var(--surface-color, rgba(255, 255, 255, 0.72))',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
};

const FORM_LABEL_STYLE = {
  display: 'block',
  marginBottom: '0.42rem',
  color: 'var(--text-secondary)',
  fontSize: '0.75rem',
  fontWeight: 700,
  letterSpacing: '0.045em',
  textTransform: 'uppercase',
};

const FORM_SECTION_STYLE = {
  padding: '1rem',
  border: '1px solid var(--border-color, rgba(120, 110, 90, 0.18))',
  borderRadius: 12,
  background: 'rgba(255, 255, 255, 0.08)',
};

function extractProductItems(data) {
  return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
}

function dedupeProducts(items) {
  return Array.from(new Map(items.filter((item) => item?.id != null).map((item) => [item.id, item])).values());
}

/**
 * The staff product endpoint supports a paginated response. Load every page
 * so an inventory adjustment can target any product in the tenant, rather
 * than only the first 200 rows returned by the legacy unpaginated shape.
 */
async function fetchAllProducts() {
  const firstPage = await fetchApi(`${PRODUCTS_URL}?paginate=true&page=1&limit=${PRODUCT_PAGE_SIZE}`);
  const firstItems = extractProductItems(firstPage);
  const totalPages = Number(firstPage?.pagination?.pages);
  if (!Number.isInteger(totalPages) || totalPages <= 1) return dedupeProducts(firstItems);

  const remainingPages = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) =>
      fetchApi(`${PRODUCTS_URL}?paginate=true&page=${index + 2}&limit=${PRODUCT_PAGE_SIZE}`).catch(() => []),
    ),
  );
  return dedupeProducts([
    ...firstItems,
    ...remainingPages.flatMap(extractProductItems),
  ]);
}

function formatReason(reason) {
  return reason.replaceAll('_', ' ');
}

function AdjustmentField({ label, required = false, hint, children, fullWidth = false }) {
  return (
    <div style={{ minWidth: 0, gridColumn: fullWidth ? '1 / -1' : undefined }}>
      <label style={FORM_LABEL_STYLE}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--danger-color, #dc2626)' }}> *</span>}
      </label>
      {children}
      {hint && (
        <div style={{ marginTop: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.75rem', lineHeight: 1.35 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function AdjustmentFormModal({ form, products, saving, onClose, onSubmit, onChange }) {
  return (
    <ModalShell
      title="New inventory adjustment"
      onClose={onClose}
      width={720}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '0.65rem 1.15rem',
              border: '1px solid var(--border-color, rgba(120, 110, 90, 0.3))',
              borderRadius: 9,
              background: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="inventory-adjustment-form"
            disabled={saving || products.length === 0}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.45rem',
              minWidth: 160,
              padding: '0.65rem 1.2rem',
              border: 'none',
              borderRadius: 9,
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff',
              cursor: saving ? 'wait' : 'pointer',
              fontWeight: 700,
              opacity: saving || products.length === 0 ? 0.7 : 1,
            }}
          >
            <Plus size={16} />
            {saving ? 'Saving…' : 'Apply adjustment'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.8rem', marginBottom: '1.15rem' }}>
        <div
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 42,
            height: 42,
            flexShrink: 0,
            borderRadius: 12,
            background: 'rgba(38, 88, 85, 0.12)',
            color: 'var(--primary-color, var(--accent-color))',
          }}
        >
          <Package size={22} />
        </div>
        <div>
          <div style={{ color: 'var(--text-primary)', fontSize: '0.98rem', fontWeight: 700 }}>
            Record a stock movement
          </div>
          <div style={{ marginTop: '0.25rem', color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.45 }}>
            Choose a catalogue product and record the reason for the stock change.
          </div>
        </div>
      </div>

      <form id="inventory-adjustment-form" onSubmit={onSubmit} style={{ display: 'grid', gap: '0.9rem' }}>
        <section style={FORM_SECTION_STYLE} aria-labelledby="inventory-adjustment-details">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
            <ClipboardList size={17} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
            <h3 id="inventory-adjustment-details" style={{ margin: 0, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
              Adjustment details
            </h3>
          </div>
          <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 235px), 1fr))' }}>
            <AdjustmentField label="Product" required hint={products.length ? 'Products are loaded from the tenant catalogue.' : 'No products are available in the tenant catalogue.'}>
              <select
                required
                autoFocus
                value={form.productId}
                onChange={(event) => onChange('productId', event.target.value)}
                style={FORM_CONTROL_STYLE}
              >
                <option value="">{products.length ? 'Select product…' : 'No products available'}</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name || `Product #${product.id}`}{product.sku ? ` · ${product.sku}` : ''}
                  </option>
                ))}
              </select>
            </AdjustmentField>
            <AdjustmentField label="Quantity delta" required hint="Use a positive value to add stock or a negative value to remove it.">
              <input
                type="number"
                step="1"
                required
                placeholder="e.g. -3 or +5"
                value={form.quantityDelta}
                onChange={(event) => onChange('quantityDelta', event.target.value)}
                style={FORM_CONTROL_STYLE}
              />
            </AdjustmentField>
            <AdjustmentField label="Reason" required>
              <select value={form.reason} onChange={(event) => onChange('reason', event.target.value)} style={FORM_CONTROL_STYLE}>
                {REASONS.map((reason) => <option key={reason} value={reason}>{formatReason(reason)}</option>)}
              </select>
            </AdjustmentField>
            <AdjustmentField label="Notes" fullWidth hint="Optional context for the audit trail, such as a count reference or transfer destination.">
              <textarea
                placeholder="Add notes about this adjustment…"
                value={form.notes}
                onChange={(event) => onChange('notes', event.target.value)}
                style={{ ...FORM_CONTROL_STYLE, minHeight: 92, resize: 'vertical', lineHeight: 1.45 }}
              />
            </AdjustmentField>
          </div>
        </section>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55rem', padding: '0.75rem 0.85rem', borderRadius: 9, background: 'rgba(38, 88, 85, 0.08)', color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.4 }}>
          <ArrowUpDown size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, color: 'var(--primary-color, var(--accent-color))' }} />
          <span>Every adjustment is recorded in the inventory audit trail and updates the product stock balance.</span>
        </div>
      </form>
    </ModalShell>
  );
}

export default function InventoryAdjustments() {
  const notify = useNotify();
  // Backend gates POST /inventory/adjustments on inventory.write.
  // The page is otherwise read-only (no edit/delete affordances exist).
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canWriteInventory = permsReady && hasPermission('inventory', 'write');
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
      fetchAllProducts().catch(() => []),
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
    const productId = Number.parseInt(form.productId, 10);
    const quantityDelta = Number.parseFloat(form.quantityDelta);
    if (!Number.isInteger(productId) || !Number.isFinite(quantityDelta) || quantityDelta === 0) {
      notify.error('Select a product and enter a non-zero quantity delta.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        productId,
        quantityDelta,
        reason: form.reason,
        notes: form.notes.trim() || null,
      };
      await fetchApi('/api/wellness/inventory/adjustments', { method: 'POST', body: JSON.stringify(payload) });
      const direction = payload.quantityDelta > 0 ? 'credited' : 'debited';
      notify.success(`Stock ${direction} by ${Math.abs(payload.quantityDelta)} (${payload.reason})`);
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (_err) { /* toasted */ } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={ScaleIcon}
        title="Inventory adjustments"
        description="Signed deltas — positive credits stock, negative debits. Use this for shrinkage, damage, recounts, transfers."
        inlineBadge={permsReady && !canWriteInventory ? (
          <span
            title="You can view adjustments but can't make changes."
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', borderRadius: 999, background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', fontWeight: 500 }}
          >
            View only
          </span>
        ) : null}
      >
        {canWriteInventory && (
          <button onClick={() => setShowForm(true)} style={primaryBtnStyle}>
            <Plus size={16} /> New adjustment
          </button>
        )}
      </PageHeader>

      <div className="glass" style={{ padding: '0.85rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '0.85rem' }}>Filter by product:&nbsp;
          <select value={productFilter} onChange={(e) => setProductFilter(e.target.value)} style={inputStyle}>
            <option value="">All</option>
            {filterOptions.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
        </label>
        <button onClick={load} style={secondaryBtnStyle}>Apply</button>
      </div>

      {showForm && canWriteInventory && (
        <AdjustmentFormModal
          form={form}
          products={products}
          saving={saving}
          onClose={() => {
            setShowForm(false);
            setForm(EMPTY);
          }}
          onSubmit={submit}
          onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))}
        />
      )}

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : adjustments.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>No adjustments recorded.</div>
        ) : (
          <TopScrollSync>
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
          </TopScrollSync>
        )}
      </div>
    </div>
  );
}

const inputStyle = { padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.9rem', minWidth: 0 };
const primaryBtnStyle = { display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.55rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' };
const secondaryBtnStyle = { padding: '0.4rem 0.75rem', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer' };
const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem' };
