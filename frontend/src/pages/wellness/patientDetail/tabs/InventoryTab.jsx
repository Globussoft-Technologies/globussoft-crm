import { useEffect, useState } from 'react';
import { Check, X, Pencil } from 'lucide-react';
import { fetchApi } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { formatDate } from '../../../../utils/date';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../../components/wellness/DateRangeFilter';
import { labelStyle, inputStyle } from '../shared/helpers';
import TopScrollSync from '../../../../components/TopScrollSync';

const tableHeaderStyle = { ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', verticalAlign: 'middle' };
const textCellStyle = { padding: '0.6rem 1rem', fontSize: '0.85rem', textAlign: 'left', verticalAlign: 'top' };
const numericCellStyle = { ...textCellStyle };
const actionCellStyle = { ...textCellStyle, whiteSpace: 'nowrap' };
const emptyCellStyle = { color: 'var(--text-secondary)', fontStyle: 'italic' };

function emptyCell(message) {
  return <span style={emptyCellStyle}>{message}</span>;
}

// ── Inventory consumption tab ─────────────────────────────────────
export default function InventoryTab({ patient, onSaved }) {
  const notify = useNotify();
  const [visitId, setVisitId] = useState(patient.visits[0]?.id || '');
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ productName: '', qty: 1, unitCost: 0 });
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ productName: '', qty: 1, unitCost: 0 });
  const [savingEdit, setSavingEdit] = useState(false);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const visits = patient.visits || [];
  const visibleVisits = (rangeStart && rangeEnd)
    ? visits.filter((v) => {
        const ts = new Date(v.visitDate).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : visits;

  useEffect(() => {
    if (!visitId) { setItems([]); return; }
    setLoading(true);
    fetchApi(`/api/wellness/visits/${visitId}/consumptions`)
      .then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, [visitId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!visitId || !form.productName) return;
    if (Number(form.qty) <= 0) {
      notify.error('Quantity must be at least 1.');
      return;
    }
    if (Number(form.unitCost) < 0) {
      notify.error('Unit cost cannot be negative.');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetchApi(`/api/wellness/visits/${visitId}/consumptions`, {
        method: 'POST', body: JSON.stringify(form),
      });
      notify.success(`Logged ${form.qty}× ${form.productName}`);
      setForm({ productName: '', qty: 1, unitCost: 0 });
      const next = await fetchApi(`/api/wellness/visits/${visitId}/consumptions`);
      setItems(next);
      if (onSaved) onSaved();
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (item) => {
    setEditingId(item.id);
    setEditForm({ productName: item.productName, qty: item.qty, unitCost: item.unitCost });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({ productName: '', qty: 1, unitCost: 0 });
  };
  const saveEdit = async (item) => {
    if (!editForm.productName || !editForm.productName.trim()) {
      notify.error('Product name is required.');
      return;
    }
    if (Number(editForm.qty) < 1) {
      notify.error('Quantity must be at least 1.');
      return;
    }
    if (Number(editForm.unitCost) < 0) {
      notify.error('Unit cost cannot be negative.');
      return;
    }
    if (savingEdit) return;
    setSavingEdit(true);
    try {
      await fetchApi(`/api/wellness/visits/${visitId}/consumptions/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          productName: editForm.productName.trim(),
          qty: parseInt(editForm.qty) || 1,
          unitCost: parseFloat(editForm.unitCost) || 0,
        }),
      });
      notify.success('Consumption item updated.');
      cancelEdit();
      const next = await fetchApi(`/api/wellness/visits/${visitId}/consumptions`);
      setItems(next);
      if (onSaved) onSaved();
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSavingEdit(false);
    }
  };

  const lineUsageValue = (item) => {
    if (Number(item.usageValue) > 0) return Number(item.usageValue);
    return (Number(item.qty) || 0) * (Number(item.unitCost) || 0);
  };
  const totalCost = items.reduce((s, i) => s + lineUsageValue(i), 0);

  return (
    <div className="glass" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0 }}>Inventory used</h3>
        {patient.visits.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <DateRangeFilter value={filter} onChange={setFilter} label={null} />
          </div>
        )}
      </div>
      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Visit</label>
        <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle}>
          <option value="">Select a visit</option>
          {visibleVisits.map((v) => (
            <option key={v.id} value={v.id}>
              {v.visitDate ? formatDate(v.visitDate) : 'No visit date'} — {v.service?.name || 'No service assigned'}
            </option>
          ))}
        </select>
      </div>

      {visitId && (
        <>
          {loading && <div>Loading…</div>}
          {!loading && (
            <div className="glass" style={{ padding: 0, marginBottom: '1rem', overflow: 'visible' }}>
              <TopScrollSync>
              <table style={{ width: '100%', minWidth: '1320px', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Transaction Date</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Booking ID</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Customer Name</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Staff</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Service Name</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Product Name</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Transaction Type</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Product Code</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Quantity</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Sale Price</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Usage Value</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    editingId === i.id ? (
                      <tr key={i.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.03)' }}>
                        <td style={{ ...textCellStyle, padding: '0.4rem 1rem' }} colSpan={6}>
                          <input value={editForm.productName} onChange={(e) => setEditForm({ ...editForm, productName: e.target.value })} style={inputStyle} />
                        </td>
                        <td style={{ ...numericCellStyle, padding: '0.4rem 1rem' }}>
                          <input type="number" min={1} value={editForm.qty} onChange={(e) => setEditForm({ ...editForm, qty: e.target.value === '' ? '' : (parseInt(e.target.value) || 1) })} style={{ ...inputStyle, textAlign: 'left' }} />
                        </td>
                        <td style={{ ...numericCellStyle, padding: '0.4rem 1rem' }}>
                          <input type="number" min={0} step={0.01} value={editForm.unitCost} onChange={(e) => setEditForm({ ...editForm, unitCost: e.target.value === '' ? '' : (parseFloat(e.target.value) || 0) })} style={{ ...inputStyle, textAlign: 'left' }} />
                        </td>
                        <td style={{ ...textCellStyle, padding: '0.4rem 1rem' }} colSpan={3}>{emptyCell('Catalog fields stay unchanged')}</td>
                        <td style={{ ...actionCellStyle, padding: '0.4rem 1rem' }}>
                          <button type="button" onClick={() => saveEdit(i)} disabled={savingEdit} title="Save changes" style={{ background: 'transparent', border: 'none', cursor: savingEdit ? 'not-allowed' : 'pointer', color: 'var(--success-color)', padding: '0.25rem', marginRight: '0.25rem' }}><Check size={16} /></button>
                          <button type="button" onClick={cancelEdit} disabled={savingEdit} title="Cancel" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0.25rem' }}><X size={16} /></button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={i.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={textCellStyle}>{i.transactionDate ? formatDate(i.transactionDate) : emptyCell('No transaction date')}</td>
                        <td style={textCellStyle}>{i.bookingId != null && i.bookingId !== '' ? `#${i.bookingId}` : emptyCell('No booking ID')}</td>
                        <td style={textCellStyle}>{i.customerName || emptyCell('No customer name')}</td>
                        <td style={textCellStyle}>{i.staff || emptyCell('No staff assigned')}</td>
                        <td style={textCellStyle}>{i.serviceName || emptyCell('No service assigned')}</td>
                        <td style={textCellStyle}>{i.productName || emptyCell('No product name')}</td>
                        <td style={textCellStyle}>{i.transactionType || emptyCell('No transaction type')}</td>
                        <td style={textCellStyle}>{i.productCode || emptyCell('No product code')}</td>
                        <td style={numericCellStyle}>{i.quantity || (Number(i.qty) > 0 ? `${i.qty} ${i.unit || ''}`.trim() : emptyCell('No quantity'))}</td>
                        <td style={numericCellStyle}>{Number(i.salePrice) > 0 ? `₹${Number(i.salePrice).toLocaleString('en-IN')}` : emptyCell('No sale price')}</td>
                        <td style={{ ...numericCellStyle, fontWeight: 500 }}>{lineUsageValue(i) > 0 ? `₹${lineUsageValue(i).toLocaleString('en-IN')}` : emptyCell('No usage value')}</td>
                        <td style={actionCellStyle}>
                          <button type="button" onClick={() => startEdit(i)} disabled={!!editingId} title="Edit (amend) this item" style={{ background: 'transparent', border: 'none', cursor: editingId ? 'not-allowed' : 'pointer', color: 'var(--accent-color)', padding: '0.25rem', opacity: editingId ? 0.4 : 1 }}><Pencil size={15} /></button>
                        </td>
                      </tr>
                    )
                  ))}
                  {items.length === 0 && <tr><td colSpan={12} style={{ ...textCellStyle, color: 'var(--text-secondary)' }}>No products logged for this visit.</td></tr>}
                  {items.length > 0 && (
                    <tr style={{ borderTop: '2px solid rgba(255,255,255,0.08)' }}>
                      <td colSpan={10} style={{ ...numericCellStyle, fontWeight: 600 }}>Total cost</td>
                      <td style={{ ...numericCellStyle, fontWeight: 600 }}>{totalCost > 0 ? `₹${totalCost.toLocaleString('en-IN')}` : emptyCell('No usage data')}</td>
                      <td style={actionCellStyle}>{emptyCell('No actions')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              </TopScrollSync>
            </div>
          )}

          {(() => {
            const productNameOk = !!form.productName && form.productName.trim().length > 0;
            const qtyNum = Number(form.qty);
            const qtyOk = Number.isFinite(qtyNum) && qtyNum >= 1;
            const canAdd = productNameOk && qtyOk && !submitting;
            const disabledReason = !productNameOk
              ? 'Enter a product name first'
              : !qtyOk
                ? 'Quantity must be at least 1'
                : '';
            return (
              <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '0.5rem', alignItems: 'end' }}>
                <input placeholder="Product name (e.g. Botox vial 100u)" required value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} style={inputStyle} />
                <input type="number" min={1} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value === '' ? '' : (parseInt(e.target.value) || 1) })} style={inputStyle} placeholder="Qty" />
                <input type="number" min={0} step={0.01} value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value === '' ? '' : (parseFloat(e.target.value) || 0) })} style={inputStyle} placeholder="Unit cost ₹ (auto)" />
                <button
                  type="submit"
                  disabled={!canAdd}
                  title={disabledReason}
                  style={{
                    padding: '0.55rem 1rem',
                    background: canAdd ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
                    color: '#fff', border: 'none', borderRadius: 8,
                    cursor: canAdd ? 'pointer' : 'not-allowed',
                    opacity: canAdd ? 1 : 0.6,
                  }}
                >
                  {submitting ? 'Adding…' : 'Add'}
                </button>
              </form>
            );
          })()}
        </>
      )}
    </div>
  );
}
