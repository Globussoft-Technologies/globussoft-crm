import { useEffect, useState } from 'react';
import { Check, X, Pencil } from 'lucide-react';
import { fetchApi } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { formatDate } from '../../../../utils/date';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../../components/wellness/DateRangeFilter';
import { labelStyle, inputStyle } from '../shared/helpers';

// ── Inventory consumption tab ─────────────────────────────────────
export default function InventoryTab({ patient, onSaved: _onSaved }) {
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
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSavingEdit(false);
    }
  };

  const totalCost = items.reduce((s, i) => s + i.qty * i.unitCost, 0);

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
          <option value="">— select visit —</option>
          {visibleVisits.map((v) => (
            <option key={v.id} value={v.id}>
              {formatDate(v.visitDate)} — {v.service?.name || 'Consultation'}
            </option>
          ))}
        </select>
      </div>

      {visitId && (
        <>
          {loading && <div>Loading…</div>}
          {!loading && (
            <div className="glass" style={{ padding: 0, marginBottom: '1rem', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'left' }}>Product</th>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'right' }}>Qty</th>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'right' }}>Unit cost</th>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'right' }}>Total</th>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    editingId === i.id ? (
                      <tr key={i.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '0.4rem 1rem' }}>
                          <input value={editForm.productName} onChange={(e) => setEditForm({ ...editForm, productName: e.target.value })} style={inputStyle} />
                        </td>
                        <td style={{ padding: '0.4rem 1rem', textAlign: 'right' }}>
                          <input type="number" min={1} value={editForm.qty} onChange={(e) => setEditForm({ ...editForm, qty: e.target.value === '' ? '' : (parseInt(e.target.value) || 1) })} style={{ ...inputStyle, textAlign: 'right' }} />
                        </td>
                        <td style={{ padding: '0.4rem 1rem', textAlign: 'right' }}>
                          <input type="number" min={0} step={0.01} value={editForm.unitCost} onChange={(e) => setEditForm({ ...editForm, unitCost: e.target.value === '' ? '' : (parseFloat(e.target.value) || 0) })} style={{ ...inputStyle, textAlign: 'right' }} />
                        </td>
                        <td style={{ padding: '0.4rem 1rem', fontSize: '0.85rem', textAlign: 'right', fontWeight: 500 }}>₹{((parseInt(editForm.qty) || 0) * (parseFloat(editForm.unitCost) || 0)).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '0.4rem 1rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button type="button" onClick={() => saveEdit(i)} disabled={savingEdit} title="Save changes" style={{ background: 'transparent', border: 'none', cursor: savingEdit ? 'not-allowed' : 'pointer', color: 'var(--success-color)', padding: '0.25rem', marginRight: '0.25rem' }}><Check size={16} /></button>
                          <button type="button" onClick={cancelEdit} disabled={savingEdit} title="Cancel" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0.25rem' }}><X size={16} /></button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={i.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem' }}>{i.productName}</td>
                        <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem', textAlign: 'right' }}>{i.qty}</td>
                        <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem', textAlign: 'right' }}>₹{i.unitCost.toLocaleString('en-IN')}</td>
                        <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem', textAlign: 'right', fontWeight: 500 }}>₹{(i.qty * i.unitCost).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '0.6rem 1rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button type="button" onClick={() => startEdit(i)} disabled={!!editingId} title="Edit (amend) this item" style={{ background: 'transparent', border: 'none', cursor: editingId ? 'not-allowed' : 'pointer', color: 'var(--accent-color)', padding: '0.25rem', opacity: editingId ? 0.4 : 1 }}><Pencil size={15} /></button>
                        </td>
                      </tr>
                    )
                  ))}
                  {items.length === 0 && <tr><td colSpan={5} style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No products logged for this visit.</td></tr>}
                  {items.length > 0 && (
                    <tr style={{ borderTop: '2px solid rgba(255,255,255,0.08)' }}>
                      <td colSpan={3} style={{ padding: '0.6rem 1rem', fontWeight: 600, textAlign: 'right' }}>Total cost</td>
                      <td style={{ padding: '0.6rem 1rem', fontWeight: 600, textAlign: 'right' }}>₹{totalCost.toLocaleString('en-IN')}</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
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
                <input type="number" min={0} step={0.01} value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value === '' ? '' : (parseFloat(e.target.value) || 0) })} style={inputStyle} placeholder="Unit cost ₹" />
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
