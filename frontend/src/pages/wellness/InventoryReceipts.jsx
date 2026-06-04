// Wave 11 Agent HH — Inventory receipts admin page.
// Lists prior receipts and lets admins record, edit, or delete them. Stock is
// adjusted server-side as a transactional side effect of every mutation.

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine, Plus, Search, Eye, Pencil, Trash2,
  Copy, Check, Phone, X, FileText, AlertTriangle, Lock,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import { DateRangeFilter, resolveDateRangeYmd, EMPTY_DATE_FILTER } from '../../components/wellness/DateRangeFilter';
import PageHeader from '../../components/PageHeader';

const EMPTY = {
  productId: '', vendorId: '', quantity: '', unitCost: '',
  batchNumber: '', expiryDate: '', notes: '', supplierInvoiceNumber: '',
};

const EDIT_WINDOW_MS = 5 * 60 * 1000;

export default function InventoryReceipts() {
  const notify = useNotify();
  // Backend gates: POST→inventory.write, PUT→inventory.update,
  // DELETE / reverse →inventory.delete. Fail closed until perms resolve.
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canWriteInventory  = permsReady && hasPermission('inventory', 'write');
  const canUpdateInventory = permsReady && hasPermission('inventory', 'update');
  const canDeleteInventory = permsReady && hasPermission('inventory', 'delete');
  const canMutateInventory = canWriteInventory || canUpdateInventory || canDeleteInventory;
  const [receipts, setReceipts] = useState([]);
  const [products, setProducts] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [dateFilter, setDateFilter] = useState(EMPTY_DATE_FILTER);
  const [from, to] = resolveDateRangeYmd(dateFilter);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewing, setViewing] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
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
  // Refetch when the picker changes — "All time" returns [null, null] which
  // omits the qs params and lets the backend return its default window.
  useEffect(load, [from, to]);

  const resetForm = () => { setForm(EMPTY); setEditing(null); setShowForm(false); };

  const startCreate = () => {
    if (showForm && !editing) { resetForm(); return; }
    setEditing(null);
    setForm(EMPTY);
    setShowForm(true);
  };

  const startEdit = (r) => {
    setEditing(r);
    setForm({
      productId: String(r.productId || ''),
      vendorId: r.vendorId ? String(r.vendorId) : '',
      quantity: String(r.quantity ?? ''),
      unitCost: String(r.unitCost ?? ''),
      batchNumber: r.batchNumber || '',
      expiryDate: r.expiryDate ? new Date(r.expiryDate).toISOString().slice(0, 10) : '',
      notes: r.notes || '',
      supplierInvoiceNumber: r.supplierInvoiceNumber || '',
    });
    setShowForm(true);
    setViewing(null);
  };

  const unsafeLocked = useMemo(() => {
    if (!editing) return false;
    const ageMs = Date.now() - new Date(editing.createdAt).getTime();
    return ageMs > EDIT_WINDOW_MS;
  }, [editing]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        const payload = {
          supplierInvoiceNumber: form.supplierInvoiceNumber?.trim() || null,
          batchNumber: form.batchNumber || null,
          expiryDate: form.expiryDate || null,
          notes: form.notes || null,
        };
        if (!unsafeLocked) {
          payload.productId = parseInt(form.productId);
          payload.quantity = parseFloat(form.quantity);
          payload.unitCost = parseFloat(form.unitCost);
        }
        await fetchApi(`/api/wellness/inventory/receipts/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        notify.success(`Updated ${editing.receiptNumber}.`);
      } else {
        const payload = {
          productId: parseInt(form.productId),
          vendorId: form.vendorId ? parseInt(form.vendorId) : null,
          quantity: parseFloat(form.quantity),
          unitCost: parseFloat(form.unitCost),
          batchNumber: form.batchNumber || null,
          expiryDate: form.expiryDate || null,
          notes: form.notes || null,
          supplierInvoiceNumber: form.supplierInvoiceNumber?.trim() || null,
        };
        const created = await fetchApi('/api/wellness/inventory/receipts', { method: 'POST', body: JSON.stringify(payload) });
        notify.success(`Recorded ${created?.receiptNumber || 'receipt'}; stock updated.`);
      }
      resetForm();
      load();
    } catch (_err) { /* toasted */ }
    setSaving(false);
  };

  const remove = async (r) => {
    const ok = await notify.confirm({
      title: 'Delete receipt',
      message: `Delete receipt ${r.receiptNumber}?\n\nThis will subtract ${r.quantity} ${r.product?.name || 'units'} from stock and remove the row permanently.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/inventory/receipts/${r.id}`, { method: 'DELETE', silent: true });
      notify.success(`Deleted ${r.receiptNumber}.`);
      load();
    } catch (err) {
      if (err?.status === 409 && (err.code === 'RECEIPT_CONSUMED' || err.code === 'WOULD_OVERDRAW')) {
        const fallback = await notify.confirm({
          title: 'Reverse receipt instead?',
          message: `${err.message}\n\nReverse this receipt instead? That creates a stock-correcting Adjustment of -${r.quantity} ${r.product?.name || ''} and keeps the receipt for audit.`,
          confirmText: 'Reverse',
        });
        if (fallback) {
          try {
            await fetchApi(`/api/wellness/inventory/receipts/${r.id}/reverse`, { method: 'POST', body: JSON.stringify({}) });
            notify.success(`Reversed ${r.receiptNumber}.`);
            load();
          } catch (_e) { /* toasted */ }
        }
      } else {
        notify.error(err?.message || 'Delete failed.');
      }
    }
  };

  const copy = async (text, key) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(String(text));
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1200);
    } catch {
      notify.error('Copy failed');
    }
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return receipts;
    return receipts.filter((r) => {
      return [
        r.receiptNumber,
        r.supplierInvoiceNumber,
        r.batchNumber,
        r.notes,
        r.product?.name,
        r.product?.sku,
        r.vendor?.name,
        r.vendor?.gstin,
        r.vendor?.phone,
      ].some((f) => f && String(f).toLowerCase().includes(q));
    });
  }, [receipts, searchQuery]);

  const totalCost = filtered.reduce((s, r) => s + (r.totalCost || 0), 0);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={ArrowDownToLine}
        title="Inventory receipts"
        description={(
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px' }}>
            <span>Keep track of every product you buy — invoice number, supplier, batch, and what it cost.</span>
            <span style={{ fontSize: '0.78rem' }}>
              {filtered.length} of {receipts.length} receipt{receipts.length === 1 ? '' : 's'} in window — total cost ₹{Number(totalCost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
          </span>
        )}
        inlineBadge={permsReady && !canMutateInventory ? (
          <span
            title="You can view receipts but can't make changes."
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', borderRadius: 999, background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', fontWeight: 500 }}
          >
            View only
          </span>
        ) : null}
      >
        {canWriteInventory && (
          <button onClick={startCreate} style={primaryBtnStyle}>
            <Plus size={16} /> {showForm && !editing ? 'Cancel' : 'Record receipt'}
          </button>
        )}
      </PageHeader>

      <div
        className="glass"
        style={{
          padding: '0.85rem 1rem', marginBottom: '1rem',
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: 420 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
          <input
            type="search"
            placeholder="Search by invoice #, supplier, product, batch…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ ...inputStyle, width: '100%', paddingLeft: 30 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginLeft: 'auto' }}>
          <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
        </div>
      </div>

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          {editing && (
            <div style={{ marginBottom: '0.85rem', padding: '0.6rem 0.85rem', borderRadius: 8, background: unsafeLocked ? 'rgba(234,179,8,0.12)' : 'rgba(59,130,246,0.12)', border: `1px solid ${unsafeLocked ? 'rgba(234,179,8,0.35)' : 'rgba(59,130,246,0.35)'}`, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <span>
                Editing <strong>{editing.receiptNumber}</strong>
                {unsafeLocked
                  ? ' — Quantity, unit cost, and product are locked (over 5 minutes old). Other fields are still editable.'
                  : ' — Recently recorded: all fields editable for the next few minutes.'}
              </span>
              <button type="button" onClick={resetForm} style={{ ...secondaryBtnStyle, padding: '0.25rem 0.6rem' }}>Cancel edit</button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.5rem' }}>
            <LockableSelect required value={form.productId} onChange={(v) => setForm({ ...form, productId: v })} locked={unsafeLocked} placeholder="Select product…">
              {products.map((p) => (<option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>))}
            </LockableSelect>
            <select disabled={!!editing} value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })} style={editing ? lockedStyle : inputStyle} title={editing ? 'Vendor is set at creation' : ''}>
              <option value="">No vendor</option>
              {vendors.map((v) => (<option key={v.id} value={v.id}>{v.name}</option>))}
            </select>
            <input placeholder="Supplier invoice # (e.g. LE0155)" value={form.supplierInvoiceNumber} onChange={(e) => setForm({ ...form, supplierInvoiceNumber: e.target.value })} style={inputStyle} />
            <LockableInput type="number" min="0.01" step="0.01" required placeholder="Quantity" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} locked={unsafeLocked} />
            <LockableInput type="number" min="0" step="0.01" required placeholder="Unit cost" value={form.unitCost} onChange={(v) => setForm({ ...form, unitCost: v })} locked={unsafeLocked} />
            <input placeholder="Batch number" value={form.batchNumber} onChange={(e) => setForm({ ...form, batchNumber: e.target.value })} style={inputStyle} />
            <input type="date" placeholder="Expiry date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} style={inputStyle} />
            <input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, gridColumn: 'span 2' }} />
            <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Record receipt + update stock'}
            </button>
          </div>
        </form>
      )}

      <div className="glass" style={{ padding: '0.5rem 0', overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
            {receipts.length === 0 ? 'No receipts in window.' : `No receipts match "${searchQuery}".`}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Receipt #</th>
                <th style={cellStyle}>Invoice #</th>
                <th style={cellStyle}>Supplier</th>
                <th style={cellStyle}>Tax ID</th>
                <th style={cellStyle}>Product</th>
                <th style={cellStyle}>Qty</th>
                <th style={cellStyle}>Total</th>
                <th style={cellStyle}>Received</th>
                <th style={{ ...cellStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={cellStyle}>
                    <span style={monoStyle}>{r.receiptNumber}</span>
                    <button onClick={() => copy(r.receiptNumber, `rcp-${r.id}`)} style={inlineCopyBtnStyle} title="Copy receipt number" aria-label="Copy receipt number">
                      {copiedKey === `rcp-${r.id}` ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </td>
                  <td style={cellStyle}>
                    {r.supplierInvoiceNumber ? (
                      <>
                        <span style={monoStyle}>{r.supplierInvoiceNumber}</span>
                        <button onClick={() => copy(r.supplierInvoiceNumber, `inv-${r.id}`)} style={inlineCopyBtnStyle} title="Copy invoice number" aria-label="Copy invoice number">
                          {copiedKey === `inv-${r.id}` ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </>
                    ) : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                  </td>
                  <td style={cellStyle}>
                    {r.vendor ? (
                      <div>
                        <div>{r.vendor.name}</div>
                        {r.vendor.phone && (
                          <a href={`tel:${r.vendor.phone}`} style={phoneLinkStyle}>
                            <Phone size={11} /> {r.vendor.phone}
                          </a>
                        )}
                      </div>
                    ) : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                  </td>
                  <td style={cellStyle}>
                    {r.vendor?.gstin ? <span style={monoStyle}>{r.vendor.gstin}</span> : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                  </td>
                  <td style={cellStyle}>{r.product?.name || `#${r.productId}`}</td>
                  <td style={cellStyle}>{r.quantity}</td>
                  <td style={cellStyle}>₹{Number(r.totalCost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                  <td style={cellStyle}>{new Date(r.receivedAt).toLocaleDateString()}</td>
                  <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => setViewing(r)} style={iconBtnStyle} title="View details" aria-label={`View ${r.receiptNumber}`}><Eye size={14} /></button>
                    {canUpdateInventory && (
                      <button onClick={() => startEdit(r)} style={iconBtnStyle} title="Edit" aria-label={`Edit ${r.receiptNumber}`}><Pencil size={14} /></button>
                    )}
                    {canDeleteInventory && (
                      <button onClick={() => remove(r)} style={iconBtnStyle} title="Delete" aria-label={`Delete ${r.receiptNumber}`}><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewing && <DetailModal receipt={viewing} onClose={() => setViewing(null)} onCopy={copy} copiedKey={copiedKey} onEdit={canUpdateInventory ? () => startEdit(viewing) : null} />}
    </div>
  );
}

function LockableInput({ locked, onChange, ...rest }) {
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <input {...rest} disabled={locked} onChange={(e) => onChange(e.target.value)} style={locked ? lockedStyle : inputStyle} />
      {locked && <Lock size={12} style={lockBadgeStyle} />}
    </div>
  );
}

function LockableSelect({ locked, onChange, value, required, placeholder, children }) {
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <select required={required} disabled={locked} value={value} onChange={(e) => onChange(e.target.value)} style={locked ? lockedStyle : inputStyle}>
        <option value="">{placeholder}</option>
        {children}
      </select>
      {locked && <Lock size={12} style={lockBadgeStyle} />}
    </div>
  );
}

function DetailModal({ receipt: r, onClose, onCopy, copiedKey, onEdit }) {
  const expiringWarn = (() => {
    if (!r.expiryDate) return null;
    const days = Math.ceil((new Date(r.expiryDate) - new Date()) / 86400000);
    if (days < 0) return { tone: 'past', label: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago` };
    if (days <= 30) return { tone: 'soon', label: `Expires in ${days} day${days === 1 ? '' : 's'}` };
    return null;
  })();

  return (
    <div onClick={onClose} style={modalBackdropStyle}>
      <div onClick={(e) => e.stopPropagation()} className="glass" style={modalStyle}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <FileText size={18} />
              <h2 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0 }}>
                <span style={monoStyle}>{r.receiptNumber}</span>
                <button onClick={() => onCopy(r.receiptNumber, `m-rcp-${r.id}`)} style={inlineCopyBtnStyle} title="Copy">
                  {copiedKey === `m-rcp-${r.id}` ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </h2>
            </div>
            {r.supplierInvoiceNumber && (
              <div style={{ marginTop: '0.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Supplier invoice <span style={monoStyle}>{r.supplierInvoiceNumber}</span>
                <button onClick={() => onCopy(r.supplierInvoiceNumber, `m-inv-${r.id}`)} style={inlineCopyBtnStyle} title="Copy">
                  {copiedKey === `m-inv-${r.id}` ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {onEdit && (
              <button onClick={onEdit} style={iconBtnStyle} title="Edit" aria-label="Edit"><Pencil size={14} /></button>
            )}
            <button onClick={onClose} style={iconBtnStyle} aria-label="Close"><X size={16} /></button>
          </div>
        </header>

        {r.vendor && (
          <Section title="Supplier">
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{r.vendor.name}</div>
                {r.vendor.phone && (
                  <a href={`tel:${r.vendor.phone}`} style={{ ...phoneLinkStyle, marginTop: 2 }}>
                    <Phone size={11} /> {r.vendor.phone}
                  </a>
                )}
              </div>
              {r.vendor.gstin && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Tax ID</div>
                  <div style={monoStyle}>{r.vendor.gstin}</div>
                </div>
              )}
            </div>
          </Section>
        )}

        <Section title="Product & cost">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
            <Field label="Product" value={r.product?.name || `#${r.productId}`} hint={r.product?.sku} />
            <Field label="Quantity" value={r.quantity} />
            <Field label="Unit cost" value={`₹${Number(r.unitCost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`} />
            <Field label="Total" value={`₹${Number(r.totalCost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`} strong />
          </div>
        </Section>

        {(r.batchNumber || r.expiryDate) && (
          <Section title="Batch & expiry">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
              {r.batchNumber && <Field label="Batch" value={<span style={monoStyle}>{r.batchNumber}</span>} />}
              {r.expiryDate && <Field label="Expiry" value={new Date(r.expiryDate).toLocaleDateString()} />}
            </div>
            {expiringWarn && (
              <div style={{ marginTop: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.3rem 0.6rem', borderRadius: 999, fontSize: '0.78rem', background: expiringWarn.tone === 'past' ? 'rgba(220,38,38,0.15)' : 'rgba(234,179,8,0.15)', color: expiringWarn.tone === 'past' ? '#dc2626' : '#ca8a04', border: `1px solid ${expiringWarn.tone === 'past' ? 'rgba(220,38,38,0.4)' : 'rgba(234,179,8,0.4)'}` }}>
                <AlertTriangle size={12} /> {expiringWarn.label}
              </div>
            )}
          </Section>
        )}

        {r.notes && (
          <Section title="Notes">
            <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>{r.notes}</div>
          </Section>
        )}

        <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          Received on {new Date(r.receivedAt).toLocaleString()}
          {r.receivedByUser ? ` by ${r.receivedByUser.name || r.receivedByUser.email}` : ''}.
          <div style={{ marginTop: '0.3rem', fontStyle: 'italic' }}>
            Tip: quantity, unit cost, and product can be edited freely within 5 minutes of recording. After that, those fields are locked — delete the receipt (if nothing has been consumed) or reverse it.
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: '0.85rem' }}>
      <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{title}</div>
      {children}
    </section>
  );
}

function Field({ label, value, hint, strong }) {
  return (
    <div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '0.95rem', fontWeight: strong ? 700 : 500 }}>{value}</div>
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{hint}</div>}
    </div>
  );
}

const inputStyle = { padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.9rem', minWidth: 0, background: 'transparent', color: 'inherit', width: '100%' };
const lockedStyle = { ...inputStyle, opacity: 0.55, cursor: 'not-allowed', background: 'rgba(148,163,184,0.08)' };
const lockBadgeStyle = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' };
// Primary CTA — teal in wellness (var --primary-color), falls back to --accent
// in generic. Subtle shadow + fontWeight 600 give it more visual weight than
// the plain flat fill it had before.
const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
  padding: '0.55rem 1.1rem',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff', border: 'none', borderRadius: 8,
  fontSize: '0.875rem', fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
  transition: 'transform 0.12s ease, box-shadow 0.12s ease',
};
// Secondary — outline that picks up the teal primary on hover so it ties back
// to the active CTA without competing with it at rest.
const secondaryBtnStyle = {
  padding: '0.45rem 0.9rem',
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  fontSize: '0.85rem', fontWeight: 500,
  cursor: 'pointer',
  transition: 'border-color 0.12s ease, color 0.12s ease',
};
const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem', verticalAlign: 'top' };
const iconBtnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.25rem 0.4rem', color: 'var(--text-secondary)' };
const inlineCopyBtnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 0.25rem', color: 'var(--text-secondary)', verticalAlign: 'middle', marginLeft: 2 };
const monoStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.85rem' };
const phoneLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.78rem', color: 'var(--primary-color, var(--accent-color))', textDecoration: 'none', marginTop: 2 };
const modalBackdropStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' };
const modalStyle = { width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto', padding: '1.5rem', borderRadius: 12 };
