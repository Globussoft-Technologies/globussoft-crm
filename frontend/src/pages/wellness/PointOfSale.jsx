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
// Wave 7C extras (PRD Gap §2 items 2 + 10):
//   - Guest Checkout toggle (item 2): a checkbox above the totals lets the
//     cashier mark this as an anonymous walk-in. When ticked, patientId is
//     forced to null on submit and the patient picker is hidden. Backend
//     accepts null patientId per Wave 2A; this surfaces it in the UI.
//   - Discount block (item 10): %, flat, OR coupon-code input. Coupon path
//     calls /api/wellness/coupons/preview (no role gate) to compute the
//     discount; flat/% paths set discountTotal directly.
//   - Manager-override (item 10): admin/manager-only block lets the operator
//     override the computed grand total with a custom amount + required
//     reason; reason is logged into Sale.notes and AuditLog (server-side
//     audit row written by routes/pos.js → writeAudit).

import { useEffect, useMemo, useState, useContext } from 'react';
import {
  Calculator,
  Plus,
  Trash2,
  Lock,
  Unlock,
  Receipt,
  CheckCircle2,
  UserX,
  Tag,
  ShieldAlert,
  Wallet as WalletIcon,
  Gift,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { AuthContext } from '../../App';

const LINE_TYPES = [
  { value: 'SERVICE', label: 'Service' },
  { value: 'PRODUCT', label: 'Product' },
  { value: 'MEMBERSHIP', label: 'Membership' },
  { value: 'GIFTCARD', label: 'Gift Card' },
  { value: 'PACKAGE', label: 'Package' },
];

// #789 / WAL-002 — payment methods exposed at POS. Backend
// (routes/pos.js → VALID_PAYMENT_METHODS) accepts CASH | CARD | UPI |
// WALLET | GIFTCARD | COMBINED — labels here are friendlier user-facing
// strings; the `value` is the enum the backend expects on /api/pos/sales.
// CASHBACK / PAYLATER / ONLINE / OTHER from the Zylu reference aren't on
// the backend enum yet — they're tracked separately and will need the
// backend route + schema migration before they can land here.
const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'UPI', label: 'UPI' },
  { value: 'WALLET', label: 'Wallet' },
  { value: 'GIFTCARD', label: 'Gift Card' },
  { value: 'COMBINED', label: 'Split / combined' },
];

export default function PointOfSale() {
  const { user } = useContext(AuthContext) || {};
  const isAdminOrManager = user && (user.role === 'ADMIN' || user.role === 'MANAGER');

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

  // Wave 7C extras (PRD Gap §2 items 2 + 10)
  const [guestCheckout, setGuestCheckout] = useState(false);
  const [patientId, setPatientId] = useState('');
  // Discount mode: 'percent' | 'flat' | 'coupon'.
  const [discountMode, setDiscountMode] = useState('flat');
  const [discountPercent, setDiscountPercent] = useState('');
  const [couponCode, setCouponCode] = useState('');
  const [couponPreview, setCouponPreview] = useState(null); // { code, discount, finalAmount } | null
  const [couponBusy, setCouponBusy] = useState(false);
  // Manager-override (admin/manager only): override the computed grand total
  // with a custom amount + required reason. Reason hits Sale.notes + AuditLog
  // when the sale lands.
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideAmount, setOverrideAmount] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  // #789 / WAL-002 — Wallet + Gift Card flow state.
  // When paymentMethod=WALLET we fetch the patient's wallet balance so the
  // cashier can see what's available before completing the sale. When
  // paymentMethod=GIFTCARD we surface a redeem mini-form — redeeming credits
  // the patient's wallet, and the cashier then switches to WALLET to charge.
  const [walletBalance, setWalletBalance] = useState(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [giftCardCode, setGiftCardCode] = useState('');
  const [giftCardBusy, setGiftCardBusy] = useState(false);

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
  // Wave 7C — resolve the order-level discount from the active discount mode.
  // Percent mode: subtotal * percent / 100; flat: discountTotal; coupon: the
  // server-computed couponPreview.discount (preview is computed against
  // (subtotal - lineDiscountTotal) so it doesn't double-apply line discounts).
  const resolvedOrderDiscount = useMemo(() => {
    if (discountMode === 'percent') {
      const pct = Math.max(0, Math.min(100, Number(discountPercent || 0)));
      return Math.max(0, ((subtotal - lineDiscountTotal) * pct) / 100);
    }
    if (discountMode === 'coupon' && couponPreview) {
      return Math.max(0, Number(couponPreview.discount || 0));
    }
    return Math.max(0, Number(discountTotal || 0));
  }, [discountMode, discountPercent, couponPreview, discountTotal, subtotal, lineDiscountTotal]);

  const computedGrandTotal = useMemo(
    () => Math.max(0, subtotal - lineDiscountTotal - resolvedOrderDiscount + Number(taxTotal || 0)),
    [subtotal, lineDiscountTotal, resolvedOrderDiscount, taxTotal],
  );

  // Manager-override: when admin/manager toggles override on, the grand total
  // becomes the manually-entered overrideAmount. The override path requires
  // a non-empty reason — completeSale enforces that.
  const grandTotal = useMemo(() => {
    if (overrideEnabled && isAdminOrManager) {
      const v = parseFloat(overrideAmount);
      return Number.isFinite(v) && v >= 0 ? v : computedGrandTotal;
    }
    return computedGrandTotal;
  }, [overrideEnabled, overrideAmount, computedGrandTotal, isAdminOrManager]);

  useEffect(() => {
    // Auto-fill paidAmount when grandTotal changes (cashier overrides if needed)
    setPaidAmount(grandTotal);
  }, [grandTotal]);

  // ── Coupon preview (Wave 7C / PRD §2 item 10) ──────────────────────
  // Calls /api/wellness/coupons/preview to compute the discount the backend
  // would actually apply. We DON'T call /apply here — application increments
  // the redemptionCount, which is a side-effect that should only happen on
  // sale completion. (Future enhancement: route the coupon through the Sale
  // create payload so the backend can apply atomically.)
  const previewCoupon = async () => {
    if (!couponCode.trim()) {
      notify.error('Enter a coupon code');
      return;
    }
    if (subtotal <= 0) {
      notify.error('Add at least one line item before applying a coupon');
      return;
    }
    setCouponBusy(true);
    try {
      const baseAmount = Math.max(0, subtotal - lineDiscountTotal);
      const result = await fetchApi('/api/wellness/coupons/preview', {
        method: 'POST',
        body: JSON.stringify({ code: couponCode.trim(), baseAmount }),
      });
      if (result && result.applied !== false && Number(result.discount) > 0) {
        setCouponPreview({
          code: result.code,
          discount: Number(result.discount),
          finalAmount: Number(result.finalAmount),
          discountType: result.discountType,
        });
        notify.success(`Coupon ${result.code} — discount ${formatMoney(result.discount, 'INR', 'en-IN')}`);
      } else {
        setCouponPreview(null);
        notify.error('Coupon does not apply to this purchase');
      }
    } catch (e) {
      setCouponPreview(null);
      notify.error(e.message || 'Failed to validate coupon');
    } finally {
      setCouponBusy(false);
    }
  };

  // ── Wallet balance fetch (#789 / WAL-002) ───────────────────────────
  // Auto-loads the patient's wallet balance whenever the cashier picks
  // Wallet OR Gift Card as the payment method AND a non-empty patientId is
  // resolvable (guest checkout has no wallet — explicitly skip). Re-runs
  // when patientId changes or guestCheckout toggles. The balance is shown
  // under the payment-method dropdown so the cashier sees what's available
  // before completing the sale.
  const loadWalletBalance = async () => {
    const pid = guestCheckout
      ? null
      : (patientId && Number.isFinite(parseInt(patientId)) ? parseInt(patientId) : null);
    if (!pid) {
      setWalletBalance(null);
      return;
    }
    setWalletBusy(true);
    try {
      const data = await fetchApi(`/api/wellness/patients/${pid}/wallet`);
      if (data && data.wallet) {
        setWalletBalance(Number(data.wallet.balance || 0));
      } else {
        setWalletBalance(0);
      }
    } catch (e) {
      // Patient may not have a wallet yet (404) — surface 0 rather than
      // an error toast; backend auto-creates on first credit/debit.
      setWalletBalance(0);
    } finally {
      setWalletBusy(false);
    }
  };

  useEffect(() => {
    if (paymentMethod === 'WALLET' || paymentMethod === 'GIFTCARD') {
      loadWalletBalance();
    } else {
      setWalletBalance(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadWalletBalance is stable enough; deps are the inputs that affect its result.
  }, [paymentMethod, patientId, guestCheckout]);

  // #789 / WAL-002 — Gift card redeem flow.
  // POST /api/wellness/giftcards/redeem with { code, patientId } credits the
  // patient's wallet by the gift card's value (server-side: gift card status
  // → redeemed, walletTransaction CREDIT_GIFTCARD). After a successful
  // redeem, refresh the wallet balance + switch the cashier to WALLET so
  // they can actually charge the sale against the now-funded wallet.
  const redeemGiftCard = async () => {
    if (!giftCardCode.trim()) {
      notify.error('Enter a gift card code');
      return;
    }
    const pid = guestCheckout
      ? null
      : (patientId && Number.isFinite(parseInt(patientId)) ? parseInt(patientId) : null);
    if (!pid) {
      notify.error('Gift card redemption requires a patient — disable guest checkout and enter a patient ID');
      return;
    }
    setGiftCardBusy(true);
    try {
      const result = await fetchApi('/api/wellness/giftcards/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: giftCardCode.trim(), patientId: pid }),
      });
      const amount = result?.giftCard?.amount;
      notify.success(
        amount
          ? `Gift card redeemed — ${formatMoney(amount, 'INR', 'en-IN')} credited to wallet`
          : 'Gift card redeemed',
      );
      setGiftCardCode('');
      // Switch to WALLET so the cashier charges against the now-credited
      // wallet. The wallet-balance fetch below picks up the new value.
      setPaymentMethod('WALLET');
      await loadWalletBalance();
    } catch (e) {
      notify.error(e.message || 'Failed to redeem gift card');
    } finally {
      setGiftCardBusy(false);
    }
  };

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
    // Wave 7C — manager-override requires a non-empty reason. Backend logs
    // the reason via writeAudit so we MUST send it.
    if (overrideEnabled && isAdminOrManager) {
      if (!overrideReason.trim()) {
        notify.error('Manager-override requires a reason');
        return;
      }
      const v = parseFloat(overrideAmount);
      if (!Number.isFinite(v) || v < 0) {
        notify.error('Manager-override amount must be a non-negative number');
        return;
      }
    }
    // Wave 7C — Guest checkout forces patientId=null. When NOT in guest mode
    // the cashier may optionally enter a patientId; empty == anonymous (same
    // as guest). The backend accepts null patientId per Wave 2A.
    const resolvedPatientId = guestCheckout
      ? null
      : (patientId && Number.isFinite(parseInt(patientId)) ? parseInt(patientId) : null);

    setBusy(true);
    try {
      const payload = {
        shiftId: currentShift.id,
        lineItems: basket,
        paymentMethod,
        discountTotal: Number(resolvedOrderDiscount || 0),
        taxTotal: Number(taxTotal || 0),
        paidAmount: Number(paidAmount || grandTotal),
        patientId: resolvedPatientId,
      };
      // When manager-override is active, surface the override + reason in the
      // request body so the backend can attach it to Sale.notes / AuditLog.
      // (Server-side audit row writes through routes/pos.js writeAudit; the
      // notes field is best-effort — schema may or may not include it on the
      // Sale model. Either way the AuditLog catches the action.)
      if (overrideEnabled && isAdminOrManager) {
        payload.managerOverride = {
          amount: Number(overrideAmount),
          reason: overrideReason.trim(),
        };
        payload.notes = `Manager override: ${overrideReason.trim()} (override total ${overrideAmount})`;
      }
      // When a coupon was previewed, include its code so backend audit captures
      // it. (Atomic coupon-apply routing is a future enhancement; today the
      // coupon's discount is already baked into discountTotal above.)
      if (discountMode === 'coupon' && couponPreview) {
        payload.couponCode = couponPreview.code;
      }
      const sale = await fetchApi('/api/pos/sales', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setLastReceipt(sale);
      setBasket([]);
      setDiscountTotal(0);
      setDiscountPercent('');
      setCouponCode('');
      setCouponPreview(null);
      setTaxTotal(0);
      setPaymentMethod('CASH');
      setGuestCheckout(false);
      setPatientId('');
      setOverrideEnabled(false);
      setOverrideAmount('');
      setOverrideReason('');
      // #789 — clear wallet/giftcard state so the next sale starts fresh.
      setWalletBalance(null);
      setGiftCardCode('');
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

          {/* Wave 7C — Guest Checkout + Patient picker (PRD §2 item 2) */}
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <UserX size={18} /> Customer
            </h2>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                checked={guestCheckout}
                onChange={(e) => {
                  setGuestCheckout(e.target.checked);
                  if (e.target.checked) setPatientId('');
                }}
                aria-label="Guest checkout (anonymous walk-in)"
              />
              <span>Guest checkout (anonymous walk-in — no patient record)</span>
            </label>
            {!guestCheckout && (
              <div>
                <label style={labelStyle}>Patient ID (optional — leave blank for anonymous)</label>
                <input
                  type="number"
                  min="1"
                  style={inputStyle}
                  value={patientId}
                  onChange={(e) => setPatientId(e.target.value)}
                  placeholder="e.g. 42"
                />
              </div>
            )}
          </div>

          {/* Wave 7C — Discount + Coupon-code (PRD §2 item 10) */}
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Tag size={18} /> Discount
            </h2>
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              {['flat', 'percent', 'coupon'].map((mode) => (
                <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="discount-mode"
                    value={mode}
                    checked={discountMode === mode}
                    onChange={() => {
                      setDiscountMode(mode);
                      // Clear the others when switching modes so the resolved
                      // discount comes from a single source of truth.
                      if (mode !== 'flat') setDiscountTotal(0);
                      if (mode !== 'percent') setDiscountPercent('');
                      if (mode !== 'coupon') {
                        setCouponCode('');
                        setCouponPreview(null);
                      }
                    }}
                  />
                  <span style={{ textTransform: 'capitalize' }}>{mode === 'flat' ? 'Flat amount' : mode === 'percent' ? 'Percent' : 'Coupon code'}</span>
                </label>
              ))}
            </div>
            {discountMode === 'flat' && (
              <div>
                <label style={labelStyle}>Flat discount</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  style={inputStyle}
                  value={discountTotal}
                  onChange={(e) => setDiscountTotal(e.target.value)}
                  placeholder="0"
                />
              </div>
            )}
            {discountMode === 'percent' && (
              <div>
                <label style={labelStyle}>Discount percentage (0–100)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="any"
                  style={inputStyle}
                  value={discountPercent}
                  onChange={(e) => setDiscountPercent(e.target.value)}
                  placeholder="e.g. 10"
                />
              </div>
            )}
            {discountMode === 'coupon' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0.5rem', alignItems: 'end' }}>
                <div>
                  <label style={labelStyle}>Coupon code</label>
                  <input
                    type="text"
                    style={inputStyle}
                    value={couponCode}
                    onChange={(e) => {
                      setCouponCode(e.target.value);
                      setCouponPreview(null);
                    }}
                    placeholder="WELCOME10"
                  />
                </div>
                <div>
                  <button onClick={previewCoupon} disabled={couponBusy || !couponCode.trim()} style={primaryBtnStyle}>
                    {couponBusy ? 'Validating…' : 'Apply coupon'}
                  </button>
                </div>
                {couponPreview && (
                  <div style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    Coupon <strong>{couponPreview.code}</strong> — discount {formatMoney(couponPreview.discount, 'INR', 'en-IN')} → final {formatMoney(couponPreview.finalAmount, 'INR', 'en-IN')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Wave 7C — Manager-override (PRD §2 item 10, admin/manager-only) */}
          {isAdminOrManager && (
            <div style={cardStyle}>
              <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ShieldAlert size={18} /> Manager override
              </h2>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={overrideEnabled}
                  onChange={(e) => setOverrideEnabled(e.target.checked)}
                  aria-label="Enable manager override for grand total"
                />
                <span>Override the computed grand total (logged to audit log)</span>
              </label>
              {overrideEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '0.5rem' }}>
                  <div>
                    <label style={labelStyle}>Override amount</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      style={inputStyle}
                      value={overrideAmount}
                      onChange={(e) => setOverrideAmount(e.target.value)}
                      placeholder="e.g. 1500"
                    />
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={labelStyle}>Reason (required)</label>
                    <input
                      type="text"
                      style={inputStyle}
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="e.g. Goodwill discount for repeat patient — approved by Dr Harsh"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Totals + payment */}
          <div style={cardStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0.75rem', alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>Resolved discount</label>
                <input
                  type="number"
                  step="any"
                  style={{ ...inputStyle, background: 'var(--surface-2, #f7f7f8)' }}
                  value={resolvedOrderDiscount}
                  readOnly
                  aria-label="Resolved order discount (read-only)"
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
                  aria-label="Payment method"
                >
                  {PAYMENT_METHODS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
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

            {/* #789 / WAL-002 — Wallet balance hint + Gift card redeem mini-form.
              * Rendered when the cashier picks WALLET (show balance) or
              * GIFTCARD (show redeem form). For COMBINED + other methods we
              * leave the grid alone. */}
            {(paymentMethod === 'WALLET' || paymentMethod === 'GIFTCARD') && (
              <div
                role="region"
                aria-label={paymentMethod === 'WALLET' ? 'Wallet balance' : 'Gift card redemption'}
                style={{
                  marginTop: '0.75rem',
                  padding: '0.75rem 0.9rem',
                  background: 'var(--surface-2, #f7f7f8)',
                  border: '1px dashed var(--border-color)',
                  borderRadius: 8,
                }}
              >
                {paymentMethod === 'WALLET' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <WalletIcon size={16} />
                    {guestCheckout ? (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                        Wallet payments need a registered patient — disable Guest checkout above.
                      </span>
                    ) : !patientId ? (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                        Enter a Patient ID in the Customer card above to load the wallet balance.
                      </span>
                    ) : walletBusy ? (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Loading wallet…</span>
                    ) : walletBalance === null ? (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Wallet balance unavailable.</span>
                    ) : (
                      <>
                        <span style={{ fontSize: '0.95rem' }}>
                          Wallet balance:{' '}
                          <strong data-testid="wallet-balance">{formatMoney(walletBalance, 'INR', 'en-IN')}</strong>
                        </span>
                        {walletBalance < grandTotal && (
                          <span style={{ color: 'var(--warning-color, #b16a00)', fontSize: '0.85rem' }}>
                            Insufficient wallet balance for this sale ({formatMoney(grandTotal, 'INR', 'en-IN')}). Top up first or use Split / combined.
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
                {paymentMethod === 'GIFTCARD' && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <Gift size={16} />
                      <strong style={{ fontSize: '0.95rem' }}>Redeem gift card</strong>
                    </div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 0.5rem 0' }}>
                      Redeeming credits the patient's wallet; we then charge this sale against Wallet automatically.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0.5rem', alignItems: 'end' }}>
                      <div>
                        <label style={labelStyle}>Gift card code</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={giftCardCode}
                          onChange={(e) => setGiftCardCode(e.target.value)}
                          placeholder="e.g. GIFT-XXXX-1234"
                          aria-label="Gift card code"
                        />
                      </div>
                      <div>
                        <button
                          onClick={redeemGiftCard}
                          disabled={giftCardBusy || !giftCardCode.trim()}
                          style={primaryBtnStyle}
                        >
                          <Gift size={14} /> {giftCardBusy ? 'Redeeming…' : 'Redeem'}
                        </button>
                      </div>
                      {walletBalance !== null && !guestCheckout && patientId && (
                        <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          Current wallet balance: <strong>{formatMoney(walletBalance, 'INR', 'en-IN')}</strong>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Subtotal {formatMoney(subtotal, 'INR', 'en-IN')} ·
                  Line discounts {formatMoney(lineDiscountTotal, 'INR', 'en-IN')} ·
                  Order discount {formatMoney(resolvedOrderDiscount, 'INR', 'en-IN')} ·
                  Tax {formatMoney(Number(taxTotal || 0), 'INR', 'en-IN')}
                </div>
                {overrideEnabled && isAdminOrManager && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--warning-color, #b16a00)', marginTop: '0.25rem' }}>
                    Manager override active — computed total {formatMoney(computedGrandTotal, 'INR', 'en-IN')}
                  </div>
                )}
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
