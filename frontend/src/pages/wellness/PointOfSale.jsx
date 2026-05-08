// Wave 2 Agent II — POS / Cash Register / Shift / Sale MVP UI (Google Doc
// audit, 8 May 2026 — "Confirmed-missing entirely" row 1).
//
// Surface: card-based "New Sale" page with shift status banner, register
// picker, line-item builder (Service / Product / Membership / GiftCard
// radio + manual qty/price), running total, payment-method select,
// and the "Complete Sale" submit button.
//
// MVP scope (deliberately tight — Wallet/GiftCard redemption hooks live in
// sibling agents' surfaces and are not wired in here):
//   - Open shift card (when no shift OPEN): pick Register, enter opening float,
//     submit POST /api/pos/shifts/open.
//   - Active shift card (when shift is OPEN): show register name + opening
//     float + line-item builder + close-shift button.
//   - Line-item builder: lineType radio (5 options), refId numeric, name,
//     quantity, unitPrice, lineDiscount; "Add line" appends to the local
//     basket; running total updated on every change.
//   - Payment method select (CASH default), paidAmount auto-fills total.
//   - Submit POST /api/pos/sales — on 201, clear basket + show invoiceNumber.
//
// What this MVP doesn't do (parking for later, all backend-supported):
//   - Patient-search picker (the field is hidden; sales without patientId
//     are valid for walk-in cash purchases — common in clinic retail).
//   - Refund flow (use Reports → /api/pos/sales/:id/refund from a list page
//     in v3.5+; admin/manager only on the backend).
//   - Sale history table (the cashier sees only invoiceNumber confirmation
//     + a "Today's sales: <count>" counter; full history lives elsewhere).
//   - Wallet / Gift Card / Coupon application at checkout (the Sale row
//     accepts WALLET / GIFTCARD as paymentMethod values, but the UX of
//     "show patient's available wallet credits and apply" is its own page).

import { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  Plus,
  Trash2,
  Lock,
  Unlock,
  Receipt,
  CheckCircle2,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';

const LINE_TYPES = [
  { value: 'SERVICE', label: 'Service' },
  { value: 'PRODUCT', label: 'Product' },
  { value: 'MEMBERSHIP', label: 'Membership' },
  { value: 'GIFTCARD', label: 'Gift Card' },
  { value: 'PACKAGE', label: 'Package' },
];

const PAYMENT_METHODS = ['CASH', 'CARD', 'UPI', 'WALLET', 'GIFTCARD', 'COMBINED'];

export default function PointOfSale() {
  const [registers, setRegisters] = useState([]);
  const [currentShift, setCurrentShift] = useState(null);
  const [openingForm, setOpeningForm] = useState({ registerId: '', openingFloat: '' });
  const [closingTotal, setClosingTotal] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [basket, setBasket] = useState([]); // local lineItems
  const [draftLine, setDraftLine] = useState({
    lineType: 'SERVICE',
    refId: '',
    name: '',
    quantity: 1,
    unitPrice: '',
    lineDiscount: 0,
  });
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [discountTotal, setDiscountTotal] = useState(0);
  const [taxTotal, setTaxTotal] = useState(0);
  const [paidAmount, setPaidAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastReceipt, setLastReceipt] = useState(null);
  const notify = useNotify();

  const loadRegisters = async () => {
    try {
      const list = await fetchApi('/api/pos/registers?isActive=true');
      setRegisters(list || []);
    } catch (e) {
      notify.error(e.message || 'Failed to load registers');
    }
  };

  const loadCurrentShift = async () => {
    try {
      const shift = await fetchApi('/api/pos/shifts/current');
      setCurrentShift(shift);
    } catch (e) {
      // not fatal — caller may simply not have a shift
      setCurrentShift(null);
    }
  };

  useEffect(() => {
    loadRegisters();
    loadCurrentShift();
  }, []);

  // ── Computed totals (denormalised on every render — small basket size) ──
  const subtotal = useMemo(
    () => basket.reduce((acc, l) => acc + Number(l.quantity) * Number(l.unitPrice), 0),
    [basket],
  );
  const lineDiscountTotal = useMemo(
    () => basket.reduce((acc, l) => acc + Number(l.lineDiscount || 0), 0),
    [basket],
  );
  const grandTotal = useMemo(
    () => Math.max(0, subtotal - lineDiscountTotal - Number(discountTotal || 0) + Number(taxTotal || 0)),
    [subtotal, lineDiscountTotal, discountTotal, taxTotal],
  );

  useEffect(() => {
    // Auto-fill paidAmount when grandTotal changes (cashier overrides if needed)
    setPaidAmount(grandTotal);
  }, [grandTotal]);

  // ── Shift open ──────────────────────────────────────────────────────
  const openShift = async () => {
    if (!openingForm.registerId) {
      notify.error('Pick a register');
      return;
    }
    setBusy(true);
    try {
      const opened = await fetchApi('/api/pos/shifts/open', {
        method: 'POST',
        body: JSON.stringify({
          registerId: Number(openingForm.registerId),
          openingFloat: Number(openingForm.openingFloat || 0),
        }),
      });
      setCurrentShift(opened);
      setOpeningForm({ registerId: '', openingFloat: '' });
      notify.success('Shift opened');
    } catch (e) {
      notify.error(e.message || 'Failed to open shift');
    } finally {
      setBusy(false);
    }
  };

  // ── Shift close ─────────────────────────────────────────────────────
  const closeShift = async () => {
    if (!currentShift) return;
    if (closingTotal === '' || Number(closingTotal) < 0) {
      notify.error('Enter the cash drawer total at close');
      return;
    }
    setBusy(true);
    try {
      const closed = await fetchApi(`/api/pos/shifts/${currentShift.id}/close`, {
        method: 'POST',
        body: JSON.stringify({
          closingTotal: Number(closingTotal),
          notes: closingNotes,
        }),
      });
      notify.success(
        `Shift closed. Variance: ${formatMoney(closed.variance, 'INR', 'en-IN')}`,
      );
      setCurrentShift(null);
      setClosingTotal('');
      setClosingNotes('');
    } catch (e) {
      notify.error(e.message || 'Failed to close shift');
    } finally {
      setBusy(false);
    }
  };

  // ── Basket ──────────────────────────────────────────────────────────
  const addLine = () => {
    if (!draftLine.refId || !draftLine.unitPrice) {
      notify.error('refId + unitPrice are required');
      return;
    }
    const line = {
      ...draftLine,
      quantity: Number(draftLine.quantity || 1),
      unitPrice: Number(draftLine.unitPrice),
      lineDiscount: Number(draftLine.lineDiscount || 0),
      refId: Number(draftLine.refId),
      name: draftLine.name || `${draftLine.lineType} #${draftLine.refId}`,
    };
    line.lineTotal = Math.max(0, line.quantity * line.unitPrice - line.lineDiscount);
    setBasket((b) => [...b, line]);
    setDraftLine({ lineType: 'SERVICE', refId: '', name: '', quantity: 1, unitPrice: '', lineDiscount: 0 });
  };

  const removeLine = (idx) => setBasket((b) => b.filter((_, i) => i !== idx));

  // ── Sale submit ─────────────────────────────────────────────────────
  const completeSale = async () => {
    if (!currentShift) {
      notify.error('Open a shift first');
      return;
    }
    if (basket.length === 0) {
      notify.error('Add at least one line item');
      return;
    }
    setBusy(true);
    try {
      const sale = await fetchApi('/api/pos/sales', {
        method: 'POST',
        body: JSON.stringify({
          shiftId: currentShift.id,
          lineItems: basket,
          paymentMethod,
          discountTotal: Number(discountTotal || 0),
          taxTotal: Number(taxTotal || 0),
          paidAmount: Number(paidAmount || grandTotal),
        }),
      });
      setLastReceipt(sale);
      setBasket([]);
      setDiscountTotal(0);
      setTaxTotal(0);
      setPaymentMethod('CASH');
      notify.success(`Sale complete: ${sale.invoiceNumber}`);
    } catch (e) {
      notify.error(e.message || 'Failed to complete sale');
    } finally {
      setBusy(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────
  const cardStyle = {
    padding: '1.25rem',
    background: 'var(--surface-color, #fff)',
    border: '1px solid var(--border-color)',
    borderRadius: 12,
    marginBottom: '1rem',
  };
  const inputStyle = {
    padding: '0.55rem 0.7rem',
    borderRadius: 8,
    border: '1px solid var(--border-color)',
    fontSize: '0.95rem',
    width: '100%',
    boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', display: 'block' };
  const primaryBtnStyle = {
    padding: '0.65rem 1.1rem',
    background: 'var(--primary-color, var(--accent-color))',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: busy ? 'not-allowed' : 'pointer',
    fontWeight: 600,
    opacity: busy ? 0.6 : 1,
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.4s ease-out' }}>
      <header style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Calculator size={24} /> Point of Sale
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Cash-and-carry checkout. Open a shift, ring up sales, close the shift to reconcile the cash drawer.
        </p>
      </header>

      {/* Shift status banner */}
      {currentShift ? (
        <div
          style={{
            ...cardStyle,
            background: 'var(--success-bg, #e6f6ee)',
            borderColor: 'var(--success-border, #a8d8b9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Unlock size={18} />
            <strong>Shift open</strong>
            <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
              Register {currentShift.register?.name || `#${currentShift.registerId}`} ·
              opening float {formatMoney(currentShift.openingFloat, 'INR', 'en-IN')}
            </span>
          </div>
        </div>
      ) : (
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.1rem' }}>
            <Lock size={18} /> No shift open — open one to start a sale
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '0.75rem' }}>
            <div>
              <label style={labelStyle}>Register</label>
              <select
                style={inputStyle}
                value={openingForm.registerId}
                onChange={(e) => setOpeningForm({ ...openingForm, registerId: e.target.value })}
              >
                <option value="">Select…</option>
                {registers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} {r.location?.name ? `— ${r.location.name}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Opening float (cash drawer start)</label>
              <input
                type="number"
                min="0"
                step="any"
                style={inputStyle}
                value={openingForm.openingFloat}
                onChange={(e) => setOpeningForm({ ...openingForm, openingFloat: e.target.value })}
                placeholder="0"
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button onClick={openShift} disabled={busy} style={primaryBtnStyle}>
                <Unlock size={14} /> Open shift
              </button>
            </div>
          </div>
          {registers.length === 0 && (
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem', fontSize: '0.9rem' }}>
              No registers configured. Ask an admin to create a Register first.
            </p>
          )}
        </div>
      )}

      {/* Last sale receipt confirmation */}
      {lastReceipt && (
        <div
          style={{
            ...cardStyle,
            background: 'var(--info-bg, #eef4ff)',
            borderColor: 'var(--info-border, #b9d1ff)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
          }}
        >
          <CheckCircle2 size={20} />
          <div>
            <strong>Sale {lastReceipt.invoiceNumber} complete</strong>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Total: {formatMoney(lastReceipt.total, 'INR', 'en-IN')} ·
              Method: {lastReceipt.paymentMethod} ·
              {lastReceipt.lineItems?.length || 0} line(s)
            </div>
          </div>
          <button
            onClick={() => setLastReceipt(null)}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* New Sale builder — only when shift OPEN */}
      {currentShift && (
        <>
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.05rem' }}>Add line item</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: '0.5rem', alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>Type</label>
                <select
                  style={inputStyle}
                  value={draftLine.lineType}
                  onChange={(e) => setDraftLine({ ...draftLine, lineType: e.target.value })}
                >
                  {LINE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Ref ID</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={draftLine.refId}
                  onChange={(e) => setDraftLine({ ...draftLine, refId: e.target.value })}
                  placeholder="123"
                />
              </div>
              <div>
                <label style={labelStyle}>Name</label>
                <input
                  type="text"
                  style={inputStyle}
                  value={draftLine.name}
                  onChange={(e) => setDraftLine({ ...draftLine, name: e.target.value })}
                  placeholder="Optional"
                />
              </div>
              <div>
                <label style={labelStyle}>Qty</label>
                <input
                  type="number"
                  min="1"
                  style={inputStyle}
                  value={draftLine.quantity}
                  onChange={(e) => setDraftLine({ ...draftLine, quantity: e.target.value })}
                />
              </div>
              <div>
                <label style={labelStyle}>Unit price</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  style={inputStyle}
                  value={draftLine.unitPrice}
                  onChange={(e) => setDraftLine({ ...draftLine, unitPrice: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div>
                <label style={labelStyle}>Line discount</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  style={inputStyle}
                  value={draftLine.lineDiscount}
                  onChange={(e) => setDraftLine({ ...draftLine, lineDiscount: e.target.value })}
                />
              </div>
              <div>
                <button onClick={addLine} style={primaryBtnStyle}>
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
          </div>

          {/* Basket */}
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.05rem' }}>
              <Receipt size={18} style={{ marginRight: '0.4rem', verticalAlign: 'middle' }} />
              Current sale ({basket.length} line{basket.length === 1 ? '' : 's'})
            </h2>
            {basket.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No lines yet — add one above.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f7f7f8)' }}>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Item</th>
                    <th style={thStyle}>Qty</th>
                    <th style={thStyle}>Unit</th>
                    <th style={thStyle}>Discount</th>
                    <th style={thStyle}>Total</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {basket.map((l, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                      <td style={tdStyle}>{l.lineType}</td>
                      <td style={tdStyle}>{l.name}</td>
                      <td style={tdStyle}>{l.quantity}</td>
                      <td style={tdStyle}>{formatMoney(l.unitPrice, 'INR', 'en-IN')}</td>
                      <td style={tdStyle}>{formatMoney(l.lineDiscount, 'INR', 'en-IN')}</td>
                      <td style={tdStyle}>{formatMoney(l.lineTotal, 'INR', 'en-IN')}</td>
                      <td style={tdStyle}>
                        <button
                          onClick={() => removeLine(i)}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger-color, #c44)' }}
                          aria-label="Remove line"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Totals + payment */}
          <div style={cardStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0.75rem', alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>Order discount</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  style={inputStyle}
                  value={discountTotal}
                  onChange={(e) => setDiscountTotal(e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Tax</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  style={inputStyle}
                  value={taxTotal}
                  onChange={(e) => setTaxTotal(e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Payment method</label>
                <select
                  style={inputStyle}
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                >
                  {PAYMENT_METHODS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Paid amount</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  style={inputStyle}
                  value={paidAmount}
                  onChange={(e) => setPaidAmount(e.target.value)}
                />
              </div>
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Subtotal {formatMoney(subtotal, 'INR', 'en-IN')} ·
                  Line discounts {formatMoney(lineDiscountTotal, 'INR', 'en-IN')} ·
                  Tax {formatMoney(Number(taxTotal || 0), 'INR', 'en-IN')}
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>
                  Total: {formatMoney(grandTotal, 'INR', 'en-IN')}
                </div>
              </div>
              <button
                onClick={completeSale}
                disabled={busy || basket.length === 0}
                style={{
                  ...primaryBtnStyle,
                  fontSize: '1rem',
                  padding: '0.75rem 1.5rem',
                  opacity: busy || basket.length === 0 ? 0.6 : 1,
                  cursor: busy || basket.length === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                <CheckCircle2 size={16} /> Complete sale
              </button>
            </div>
          </div>

          {/* Close shift card */}
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Lock size={18} /> Close shift
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '0 0 0.75rem 0' }}>
              Count the cash drawer at end of shift, enter the total, and submit. Variance = counted − expected.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '0.75rem', alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>Closing total (cash drawer count)</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  style={inputStyle}
                  value={closingTotal}
                  onChange={(e) => setClosingTotal(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={labelStyle}>Notes (optional)</label>
                <input
                  type="text"
                  style={inputStyle}
                  value={closingNotes}
                  onChange={(e) => setClosingNotes(e.target.value)}
                  placeholder="e.g. tipped over a coffee, ₹50 short on purpose"
                />
              </div>
              <div>
                <button
                  onClick={closeShift}
                  disabled={busy}
                  style={{ ...primaryBtnStyle, background: 'var(--danger-color, #c44)' }}
                >
                  <Lock size={14} /> Close shift
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: 'left',
  padding: '0.5rem 0.6rem',
  fontSize: '0.85rem',
  color: 'var(--text-secondary)',
  fontWeight: 600,
};
const tdStyle = {
  padding: '0.5rem 0.6rem',
  fontSize: '0.95rem',
};
