/**
 * Cash Register admin page — closes Zylu-Gap #770 / #779 / #780 / #781.
 *
 * Why this file exists
 * --------------------
 * Today, the wellness POS surface (`/wellness/pos`) is permanently gated:
 * `routes/pos.js → POST /sales` requires an OPEN shift, an OPEN shift
 * requires a Register, and there's no UI to create / list registers.
 * This page wires up the admin surface so an operator can:
 *
 *   #770 — list, create, edit, and deactivate cash registers
 *   #779 — open + close shifts on a chosen register; placeholder
 *          surface for cash deposit / withdrawal (backend route
 *          gap surfaced inline, see "Known gap" note below)
 *   #780 — REGISTER OPEN ⟶ ₹X balance / REGISTER CLOSED status header
 *          on each register card (top-of-page summary panel when one
 *          register is selected)
 *   #781 — recent transactions for the selected register's current
 *          shift, split into three buckets:
 *            • Bookings Cash — Sale rows with patientId set + CASH
 *              payment method (cash-paid sales linked to a patient)
 *            • Partial Cash  — Sale rows with paymentMethod=COMBINED
 *              (CASH + CARD / CASH + UPI mixed-tender sales)
 *            • Expenses Cash — cash outflows from the drawer; today
 *              this is rendered as an empty bucket because the
 *              `/shifts/:id/deposit` + `/withdraw` routes are not
 *              yet shipped (surfaced as a "Coming soon" note rather
 *              than mocked rows — see "Known gap" below).
 *
 * Layout
 * ------
 * The page is single-view rather than two-route (no nested
 * `/cash-registers/:id` page) — sibling pattern from Locations.jsx +
 * Services.jsx. A click on a register row sets `selectedRegisterId` and
 * scrolls the page so the shift/transactions panel becomes visible.
 *
 *   ┌─ Header ──────────────────────────────────────────────────┐
 *   │  Cash Registers + "New Register" button                  │
 *   ├─ Register grid (cards) ───────────────────────────────────┤
 *   │  [Front Desk — OPEN ₹2,500] [Pharmacy — CLOSED]          │
 *   ├─ Selected-register detail panel (when one is clicked) ───┤
 *   │  Status header — REGISTER OPEN / CLOSED + balance        │
 *   │  Action bar — Open Shift | Close Shift | Deposit | Withdraw │
 *   │  Transactions list (3 tabs: Bookings / Partial / Expenses) │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Backend endpoints consumed
 * --------------------------
 *   GET    /api/pos/registers              — list (cashier+)
 *   POST   /api/pos/registers              — create (admin/manager)
 *   PUT    /api/pos/registers/:id          — update (admin/manager)
 *   DELETE /api/pos/registers/:id          — deactivate (admin/manager)
 *   GET    /api/pos/shifts?registerId=N&status=OPEN
 *                                          — find the active shift for a register
 *   GET    /api/pos/shifts/:id             — shift detail + sales (cashier+)
 *   POST   /api/pos/shifts/open            — open shift (cashier+)
 *   POST   /api/pos/shifts/:id/close       — close shift (cashier+)
 *   POST   /api/pos/shifts/:id/deposit     — petty-cash deposit (#779)
 *   POST   /api/pos/shifts/:id/withdraw    — petty-cash withdrawal (#779)
 *   GET    /api/pos/shifts/:id/petty-cash  — ledger entries for Expenses tab
 */

import { useEffect, useMemo, useState, useContext } from 'react';
import {
  Banknote,
  Plus,
  Pencil,
  Power,
  PowerOff,
  ArrowDownToLine,
  ArrowUpFromLine,
  Lock,
  Unlock,
  Receipt,
  CheckCircle2,
  XCircle,
  MapPin,
  CircleDollarSign,
  UserCircle2,
  UserX,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { formatDateTime } from '../../utils/date';
import { AuthContext } from '../../App';
// Shared date-range filter (Today / Yesterday / This Week / This Month /
// Last 7 / Last 30 / Custom …) — reused from PatientDetail's Case
// History tab and the Wallet ledger so behaviour stays consistent
// across the wellness surface.
import {
  DateRangeFilter,
  resolveDateRange,
  EMPTY_DATE_FILTER,
} from '../../components/wellness/DateRangeFilter';

const EMPTY_REGISTER_FORM = { name: '', locationId: '', openingFloat: '0' };
const TX_TABS = [
  { key: 'bookings', label: 'Bookings Cash' },
  { key: 'partial', label: 'Partial Cash' },
  { key: 'expenses', label: 'Expenses Cash' },
];

/**
 * Props:
 *   embedded — when true, renders without the outer page padding +
 *              hides the "Cash Registers" page heading so the component
 *              can be slotted into another page (e.g. PointOfSale as a
 *              collapsible "Manage registers" section). The host page
 *              provides its own framing. Default false = standalone page.
 */
export default function CashRegisters({ embedded = false } = {}) {
  const { user } = useContext(AuthContext) || {};
  const isAdminOrManager =
    user && (user.role === 'ADMIN' || user.role === 'MANAGER');
  const notify = useNotify();

  const [registers, setRegisters] = useState([]);
  const [openShifts, setOpenShifts] = useState({}); // { [registerId]: shift }
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);

  // Register CRUD form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_REGISTER_FORM);
  const [saving, setSaving] = useState(false);

  // Selected register / shift detail
  const [selectedRegisterId, setSelectedRegisterId] = useState(null);
  const [selectedShift, setSelectedShift] = useState(null);
  const [shiftLoading, setShiftLoading] = useState(false);

  // Open-shift form
  const [openingFloat, setOpeningFloat] = useState('');
  const [openingShift, setOpeningShift] = useState(false);

  // Close-shift form
  const [closingTotal, setClosingTotal] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [closingShift, setClosingShift] = useState(false);

  // Transactions tab + date window. The window applies BEFORE the
  // payment-method bucketing so the tab counts (Bookings / Partial /
  // Expenses) reflect only rows in the active range.
  const [txTab, setTxTab] = useState('bookings');
  const [txDateFilter, setTxDateFilter] = useState(EMPTY_DATE_FILTER);

  // Petty-cash ledger (Expenses tab) + the add-expense form.
  const [pettyCash, setPettyCash] = useState([]);
  const [expenseForm, setExpenseForm] = useState({ amount: '', reason: '', category: 'GENERAL' });
  const [savingExpense, setSavingExpense] = useState(false);

  // ── Loaders ───────────────────────────────────────────────────────
  const loadRegisters = async () => {
    setLoading(true);
    try {
      const list = await fetchApi('/api/pos/registers');
      const regs = Array.isArray(list) ? list : [];
      setRegisters(regs);
      // Fetch open shifts per register so the status pill on each card
      // is up-to-date. The /shifts endpoint accepts ?registerId&status.
      const shiftsByReg = {};
      await Promise.all(
        regs.map(async (r) => {
          try {
            const shifts = await fetchApi(
              `/api/pos/shifts?registerId=${r.id}&status=OPEN`,
            );
            if (Array.isArray(shifts) && shifts.length > 0) {
              shiftsByReg[r.id] = shifts[0];
            }
          } catch {
            // listing /shifts is admin-only — cashier roles get 403; that's
            // fine, they see the register grid without the status pill.
          }
        }),
      );
      setOpenShifts(shiftsByReg);
    } catch (e) {
      notify.error(e.message || 'Failed to load registers');
      setRegisters([]);
    }
    setLoading(false);
  };

  const loadLocations = async () => {
    try {
      const list = await fetchApi('/api/wellness/locations');
      setLocations(Array.isArray(list) ? list : []);
    } catch {
      setLocations([]);
    }
  };

  const loadShiftDetail = async (shiftId) => {
    if (!shiftId) {
      setSelectedShift(null);
      setPettyCash([]);
      return;
    }
    setShiftLoading(true);
    try {
      const detail = await fetchApi(`/api/pos/shifts/${shiftId}`);
      setSelectedShift(detail);
      // Petty-cash ledger powers the Expenses tab (deposits/withdrawals +
      // auto-logged subscription expenses). Best-effort — a ledger fetch
      // failure shouldn't blank the whole shift view.
      try {
        const ledger = await fetchApi(`/api/pos/shifts/${shiftId}/petty-cash`);
        setPettyCash(Array.isArray(ledger) ? ledger : []);
      } catch {
        setPettyCash([]);
      }
    } catch (e) {
      notify.error(e.message || 'Failed to load shift');
      setSelectedShift(null);
      setPettyCash([]);
    }
    setShiftLoading(false);
  };

  useEffect(() => {
    loadRegisters();
    loadLocations();
  }, []);

  // When the user picks a register, fetch its open shift + transactions.
  useEffect(() => {
    if (!selectedRegisterId) {
      setSelectedShift(null);
      return;
    }
    const openShift = openShifts[selectedRegisterId];
    if (openShift) {
      loadShiftDetail(openShift.id);
    } else {
      setSelectedShift(null);
    }
    // Reset the form fields so prior values don't leak across selects.
    setOpeningFloat('');
    setClosingTotal('');
    setClosingNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRegisterId, openShifts[selectedRegisterId]?.id]);

  // ── Register CRUD ─────────────────────────────────────────────────
  const resetForm = () => {
    setForm(EMPTY_REGISTER_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const startCreate = () => {
    setForm(EMPTY_REGISTER_FORM);
    setEditingId(null);
    setShowForm(true);
  };

  const startEdit = (reg) => {
    setEditingId(reg.id);
    setForm({
      name: reg.name || '',
      locationId: String(reg.locationId || ''),
      openingFloat: String(reg.openingFloat ?? 0),
    });
    setShowForm(true);
  };

  const submitRegister = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      notify.error('Register name is required');
      return;
    }
    if (!form.locationId) {
      notify.error('Pick a location');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        locationId: parseInt(form.locationId, 10),
        openingFloat: parseFloat(form.openingFloat || '0'),
      };
      if (editingId) {
        await fetchApi(`/api/pos/registers/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        notify.success(`Updated "${payload.name}"`);
      } else {
        await fetchApi('/api/pos/registers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify.success(`Created "${payload.name}"`);
      }
      resetForm();
      await loadRegisters();
    } catch (_err) {
      /* fetchApi already toasted the server error */
    }
    setSaving(false);
  };

  const toggleActive = async (reg) => {
    try {
      await fetchApi(`/api/pos/registers/${reg.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !reg.isActive }),
      });
      notify.success(
        reg.isActive ? `Deactivated "${reg.name}"` : `Activated "${reg.name}"`,
      );
      await loadRegisters();
    } catch (_err) {
      /* fetchApi already toasted */
    }
  };

  // ── Shift open / close ────────────────────────────────────────────
  const submitOpenShift = async (e) => {
    e.preventDefault();
    if (!selectedRegisterId) return;
    const float = parseFloat(openingFloat);
    if (!Number.isFinite(float) || float < 0) {
      notify.error('Opening float must be a non-negative number');
      return;
    }
    setOpeningShift(true);
    try {
      const shift = await fetchApi('/api/pos/shifts/open', {
        method: 'POST',
        body: JSON.stringify({
          registerId: selectedRegisterId,
          openingFloat: float,
        }),
      });
      notify.success('Shift opened');
      setOpeningFloat('');
      setOpenShifts((prev) => ({ ...prev, [selectedRegisterId]: shift }));
      if (shift?.id) await loadShiftDetail(shift.id);
    } catch (_err) {
      /* fetchApi already toasted */
    }
    setOpeningShift(false);
  };

  const submitCloseShift = async (e) => {
    e.preventDefault();
    if (!selectedShift?.id) return;
    // closingTotal is OPTIONAL — blank means "auto-close at the system-computed
    // expected cash" (the common case). A counted amount is only needed when
    // the cashier wants to record a variance (physical count ≠ expected).
    const body = { notes: closingNotes || undefined };
    const trimmed = String(closingTotal).trim();
    if (trimmed !== '') {
      const total = parseFloat(trimmed);
      if (!Number.isFinite(total) || total < 0) {
        notify.error('Counted cash must be a non-negative number');
        return;
      }
      body.closingTotal = total;
    }
    setClosingShift(true);
    try {
      await fetchApi(`/api/pos/shifts/${selectedShift.id}/close`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify.success(
        trimmed !== '' ? 'Register closed' : `Register closed at ${formatMoney(currentBalance)}`,
      );
      setClosingTotal('');
      setClosingNotes('');
      // Refresh: the shift is no longer open.
      setOpenShifts((prev) => {
        const next = { ...prev };
        delete next[selectedRegisterId];
        return next;
      });
      setSelectedShift(null);
      await loadRegisters();
    } catch (_err) {
      /* fetchApi already toasted */
    }
    setClosingShift(false);
  };

  // #779 — Deposit / Withdrawal against the open shift's drawer. Each
  // movement is a PettyCashLedger row; close-shift expectedCash now
  // includes (DEPOSIT - WITHDRAWAL) so variance reflects only true
  // under/over-counts. Both routes are admin/manager only.
  const handlePettyCashEntry = async (action) => {
    if (!selectedShift?.id) return;
    const verb = action === 'deposit' ? 'Deposit' : 'Withdrawal';
    const amountStr = window.prompt(`${verb} amount?`);
    if (amountStr == null) return; // cancelled
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      notify.error('Amount must be a positive number');
      return;
    }
    const reason = window.prompt(`Reason for ${verb.toLowerCase()}?`);
    if (reason == null) return; // cancelled
    if (!reason.trim()) {
      notify.error('Reason is required');
      return;
    }
    try {
      await fetchApi(`/api/pos/shifts/${selectedShift.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ amount, reason: reason.trim() }),
      });
      notify.success(`${verb} of ${amount} recorded`);
      await loadShiftDetail(selectedShift.id);
      await loadRegisters();
    } catch (_err) {
      /* fetchApi already toasted */
    }
  };

  const handleDeposit = () => handlePettyCashEntry('deposit');
  const handleWithdrawal = () => handlePettyCashEntry('withdraw');

  // Add a categorised expense (e.g. a Subscription) straight into the Expenses
  // tab — a WITHDRAWAL petty-cash row tagged with the chosen category.
  const handleAddExpense = async (e) => {
    e.preventDefault();
    if (!selectedShift?.id) return;
    const amount = parseFloat(expenseForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      notify.error('Amount must be a positive number');
      return;
    }
    if (!expenseForm.reason.trim()) {
      notify.error('Reason is required');
      return;
    }
    setSavingExpense(true);
    try {
      await fetchApi(`/api/pos/shifts/${selectedShift.id}/withdraw`, {
        method: 'POST',
        body: JSON.stringify({
          amount,
          reason: expenseForm.reason.trim(),
          category: expenseForm.category,
        }),
      });
      notify.success('Expense recorded');
      setExpenseForm({ amount: '', reason: '', category: 'GENERAL' });
      await loadShiftDetail(selectedShift.id);
      await loadRegisters();
    } catch (_err) {
      /* fetchApi already toasted */
    }
    setSavingExpense(false);
  };

  // ── Computed views ────────────────────────────────────────────────
  const selectedRegister = useMemo(
    () => registers.find((r) => r.id === selectedRegisterId) || null,
    [registers, selectedRegisterId],
  );

  // Bucket the shift's sales into Bookings / Partial Cash / Expenses.
  // Bookings: patientId set + paymentMethod=CASH (cash paid for a tracked
  // patient — the canonical "clinic visit paid in cash" row).
  // Partial Cash: paymentMethod=COMBINED — split-tender sales where
  // CASH is one of the components.
  // Expenses: cash outflows from the drawer — empty until #779 backend
  // ships the deposit/withdraw ledger.
  const transactions = useMemo(() => {
    const allSales = Array.isArray(selectedShift?.sales) ? selectedShift.sales : [];
    // Apply the shared date-range filter first so the per-payment-method
    // tab counts below reflect only the active window. `[null, null]` ==
    // "All time" preset — short-circuit and keep every row.
    const [rangeStart, rangeEnd] = resolveDateRange(txDateFilter);
    const sales = (rangeStart && rangeEnd)
      ? allSales.filter((s) => {
          if (!s.createdAt) return false;
          const t = new Date(s.createdAt).getTime();
          if (Number.isNaN(t)) return false;
          return t >= rangeStart.getTime() && t <= rangeEnd.getTime();
        })
      : allSales;
    const bookings = sales.filter(
      (s) => s.paymentMethod === 'CASH' && s.status === 'COMPLETED',
    );
    const partial = sales.filter(
      (s) => s.paymentMethod === 'COMBINED' && s.status === 'COMPLETED',
    );
    // Expenses = cash OUTFLOWS from the drawer (WITHDRAWAL petty-cash rows),
    // including the auto-logged SUBSCRIPTION expenses. Newest first.
    const expenses = (Array.isArray(pettyCash) ? pettyCash : [])
      .filter((e) => e.type === 'WITHDRAWAL')
      .slice()
      .reverse();
    return { bookings, partial, expenses };
  }, [selectedShift, pettyCash, txDateFilter]);

  const visibleTransactions = transactions[txTab] || [];

  // Expected cash in the drawer — MUST mirror routes/pos.js close-shift exactly:
  //   openingFloat + sum(CASH sales paidAmount) + sum(DEPOSIT) − sum(WITHDRAWAL).
  // Uses the UNFILTERED shift sales + the full petty-cash ledger (NOT the
  // date-filtered transactions view) so the figure matches what the backend
  // computes at close. This is the amount the system auto-closes at.
  const currentBalance = useMemo(() => {
    if (!selectedShift) return 0;
    const sales = Array.isArray(selectedShift.sales) ? selectedShift.sales : [];
    const cashTaken = sales
      .filter((s) => s.paymentMethod === 'CASH' && s.status === 'COMPLETED')
      .reduce((acc, s) => acc + Number(s.paidAmount ?? s.total ?? 0), 0);
    const ledger = Array.isArray(pettyCash) ? pettyCash : [];
    const deposits = ledger
      .filter((e) => e.type === 'DEPOSIT')
      .reduce((acc, e) => acc + Number(e.amount || 0), 0);
    const withdrawals = ledger
      .filter((e) => e.type === 'WITHDRAWAL')
      .reduce((acc, e) => acc + Number(e.amount || 0), 0);
    return Number(selectedShift.openingFloat || 0) + cashTaken + deposits - withdrawals;
  }, [selectedShift, pettyCash]);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div
      style={
        embedded
          ? { animation: 'fadeIn 0.3s ease-out' }
          : { padding: '2rem', animation: 'fadeIn 0.5s ease-out' }
      }
    >
      <header
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: embedded ? 'center' : 'flex-start',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        {/* When embedded, the host page (e.g. POS) supplies the page
            title — render only the count + "New register" affordance so
            the panel doesn't duplicate the parent's H1. */}
        {!embedded ? (
          <div>
            <h1
              style={{
                fontSize: '1.75rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <Banknote size={24} /> Cash Registers
            </h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              {registers.length} register{registers.length !== 1 ? 's' : ''} —
              open a shift to start ringing up cash sales.
            </p>
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            {registers.length} register{registers.length !== 1 ? 's' : ''} configured
          </div>
        )}
        {isAdminOrManager && (
          <button
            onClick={() => (showForm ? resetForm() : startCreate())}
            style={primaryButtonStyle}
          >
            <Plus size={16} /> {showForm ? 'Cancel' : 'New register'}
          </button>
        )}
      </header>

      {showForm && isAdminOrManager && (
        <form onSubmit={submitRegister} className="glass" style={formStyle}>
          {editingId && (
            <div
              style={{
                gridColumn: '1 / -1',
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.25rem',
              }}
            >
              Editing <strong>{form.name}</strong>
            </div>
          )}
          <input
            placeholder="Register name — e.g. Front Desk"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
            aria-label="Register name"
          />
          <select
            required
            value={form.locationId}
            onChange={(e) => setForm({ ...form, locationId: e.target.value })}
            style={inputStyle}
            aria-label="Location"
          >
            <option value="">Pick a location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.city ? ` — ${l.city}` : ''}
              </option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Opening float — e.g. 500"
            value={form.openingFloat}
            onChange={(e) => setForm({ ...form, openingFloat: e.target.value })}
            style={inputStyle}
            aria-label="Opening float"
          />
          <button
            type="submit"
            disabled={saving}
            style={{
              ...primaryButtonStyle,
              gridColumn: '1 / -1',
              justifyContent: 'center',
            }}
          >
            {saving
              ? 'Saving…'
              : editingId
              ? 'Save changes'
              : 'Create register'}
          </button>
        </form>
      )}

      {loading && <div>Loading…</div>}

      {/* Register grid — each card is clickable to drill in */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        {registers.map((reg) => {
          const openShift = openShifts[reg.id];
          const isOpen = !!openShift;
          const isSelected = selectedRegisterId === reg.id;
          return (
            <div
              key={reg.id}
              className="glass"
              onClick={() => setSelectedRegisterId(reg.id)}
              style={{
                padding: '1.25rem',
                cursor: 'pointer',
                opacity: reg.isActive ? 1 : 0.55,
                // Unselected: visible 1px border so cards stay distinct
                // against the cream wellness light-mode background where
                // .glass alone provides almost no contrast. Selected:
                // 2px teal accent that visually overrides the 1px line.
                border: isSelected
                  ? '2px solid var(--primary-color, var(--accent-color))'
                  : '1px solid var(--border-color)',
              }}
              data-testid={`register-card-${reg.id}`}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: '0.5rem',
                }}
              >
                <div>
                  <h3
                    style={{
                      fontSize: '1.05rem',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                    }}
                  >
                    <Banknote
                      size={16}
                      color="var(--primary-color, var(--accent-color))"
                    />
                    {reg.name}
                  </h3>
                  {reg.location && (
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                        marginTop: '0.15rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                    >
                      <MapPin size={11} />
                      {reg.location.name}
                      {reg.location.city ? `, ${reg.location.city}` : ''}
                    </div>
                  )}
                </div>
                {isAdminOrManager && (
                  <div
                    style={{ display: 'flex', gap: '0.3rem' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => startEdit(reg)}
                      title="Edit register"
                      style={iconButtonStyle}
                      aria-label={`Edit ${reg.name}`}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => toggleActive(reg)}
                      title={reg.isActive ? 'Deactivate' : 'Activate'}
                      style={{
                        ...iconButtonStyle,
                        color: reg.isActive
                          ? 'var(--success-color)'
                          : 'var(--text-secondary)',
                      }}
                      aria-label={
                        reg.isActive
                          ? `Deactivate ${reg.name}`
                          : `Activate ${reg.name}`
                      }
                    >
                      {reg.isActive ? (
                        <Power size={12} />
                      ) : (
                        <PowerOff size={12} />
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* #780 — status pill on every card */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.25rem 0.6rem',
                  borderRadius: 999,
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  background: isOpen
                    ? 'rgba(16,185,129,0.12)'
                    : 'rgba(100,100,100,0.12)',
                  color: isOpen
                    ? 'var(--success-color)'
                    : 'var(--text-secondary)',
                }}
                data-testid={`register-status-${reg.id}`}
              >
                {isOpen ? <Unlock size={11} /> : <Lock size={11} />}
                {isOpen ? 'REGISTER OPEN' : 'REGISTER CLOSED'}
                {isOpen && (
                  <span style={{ marginLeft: '0.35rem', opacity: 0.85 }}>
                    · float {formatMoney(openShift.openingFloat)}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {!loading && registers.length === 0 && (
          <div
            className="glass"
            style={{
              padding: '2rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              gridColumn: '1 / -1',
            }}
          >
            No cash registers yet.{' '}
            {isAdminOrManager
              ? 'Create one to start ringing up sales at the POS.'
              : 'Ask an admin to create the first one.'}
          </div>
        )}
      </div>

      {/* Per-register detail panel */}
      {selectedRegister && (
        <section
          className="glass"
          style={{ padding: '1.5rem' }}
          data-testid="selected-register-panel"
        >
          {/* #780 — REGISTER OPEN / CLOSED status header with total balance */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '1rem',
              marginBottom: '1rem',
              paddingBottom: '0.75rem',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Selected register
              </div>
              <h2
                style={{
                  fontSize: '1.3rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginTop: '0.2rem',
                }}
              >
                <Banknote size={18} /> {selectedRegister.name}
              </h2>
            </div>
            <div style={{ textAlign: 'right' }}>
              {selectedShift ? (
                <>
                  <div
                    style={{
                      fontSize: '0.95rem',
                      fontWeight: 700,
                      color: 'var(--success-color)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      justifyContent: 'flex-end',
                    }}
                    data-testid="status-header"
                  >
                    <CheckCircle2 size={16} /> REGISTER OPEN
                  </div>
                  <div
                    style={{
                      fontSize: '1.5rem',
                      fontWeight: 700,
                      marginTop: '0.25rem',
                    }}
                    data-testid="current-balance"
                  >
                    {formatMoney(currentBalance)}
                  </div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    drawer balance · opened{' '}
                    {selectedShift.openedAt
                      ? formatDateTime(selectedShift.openedAt)
                      : '—'}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 700,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                  data-testid="status-header"
                >
                  <XCircle size={16} /> REGISTER CLOSED
                </div>
              )}
            </div>
          </div>

          {/* #779 — Action bar: Open / Close / Deposit / Withdraw */}
          {!selectedShift ? (
            <form
              onSubmit={submitOpenShift}
              style={{
                display: 'flex',
                gap: '0.5rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                marginBottom: '1rem',
              }}
            >
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Opening float — e.g. 500"
                value={openingFloat}
                onChange={(e) => setOpeningFloat(e.target.value)}
                style={{ ...inputStyle, flex: '1 1 220px' }}
                aria-label="Opening float for new shift"
              />
              <button
                type="submit"
                disabled={openingShift}
                style={{
                  ...primaryButtonStyle,
                  background: 'var(--success-color)',
                }}
              >
                <Unlock size={14} />
                {openingShift ? 'Opening…' : 'Open shift'}
              </button>
            </form>
          ) : (
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                flexWrap: 'wrap',
                marginBottom: '1rem',
              }}
            >
              <button
                onClick={handleDeposit}
                style={secondaryButtonStyle}
                aria-label="Deposit cash"
                title="Deposit cash into the drawer"
              >
                <ArrowDownToLine size={14} /> Deposit
              </button>
              <button
                onClick={handleWithdrawal}
                style={secondaryButtonStyle}
                aria-label="Withdraw cash"
                title="Withdraw cash from the drawer"
              >
                <ArrowUpFromLine size={14} /> Withdrawal
              </button>
              <form
                onSubmit={submitCloseShift}
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  flex: '1 1 100%',
                  marginTop: '0.5rem',
                  padding: '0.75rem',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: 8,
                  alignItems: 'center',
                }}
              >
                {/* Auto-calculated expected drawer cash. The cashier can close
                    straight away at this figure, or type a counted amount to
                    record a variance. */}
                <div style={{ flex: '1 1 100%', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Expected cash in drawer:{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>
                    {formatMoney(currentBalance)}
                  </strong>{' '}
                  — leave the count blank to close at this amount.
                </div>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Counted cash (optional)"
                  value={closingTotal}
                  onChange={(e) => setClosingTotal(e.target.value)}
                  style={{ ...inputStyle, flex: '1 1 180px' }}
                  aria-label="Counted cash"
                />
                <input
                  placeholder="Notes (optional)"
                  value={closingNotes}
                  onChange={(e) => setClosingNotes(e.target.value)}
                  style={{ ...inputStyle, flex: '2 1 220px' }}
                  aria-label="Closing notes"
                />
                <button
                  type="submit"
                  disabled={closingShift}
                  style={primaryButtonStyle}
                >
                  <Lock size={14} />
                  {closingShift ? 'Closing…' : 'Close register'}
                </button>
              </form>
            </div>
          )}

          {/* #781 — Recent Transactions split into 3 buckets */}
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
                flexWrap: 'wrap',
                marginBottom: '0.5rem',
              }}
            >
              <h3
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  margin: 0,
                }}
              >
                <Receipt size={16} /> Recent transactions
              </h3>
              {/* Shared DateRangeFilter — same control used on Case
                  History + Wallet ledger. Defaults to "All time"; selecting
                  a preset narrows the per-tab counts below + the visible
                  list. "Custom" opens the two-month range picker. */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  flexWrap: 'wrap',
                }}
              >
                <DateRangeFilter
                  value={txDateFilter}
                  onChange={setTxDateFilter}
                  label={null}
                />
              </div>
            </div>
            <div
              role="tablist"
              style={{
                display: 'flex',
                gap: '0.3rem',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                marginBottom: '0.75rem',
              }}
            >
              {TX_TABS.map((t) => {
                const active = txTab === t.key;
                const count = transactions[t.key]?.length ?? 0;
                return (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTxTab(t.key)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: '0.5rem 0.85rem',
                      cursor: 'pointer',
                      color: active
                        ? 'var(--primary-color, var(--accent-color))'
                        : 'var(--text-secondary)',
                      borderBottom: active
                        ? '2px solid var(--primary-color, var(--accent-color))'
                        : '2px solid transparent',
                      fontSize: '0.85rem',
                      fontWeight: active ? 600 : 500,
                    }}
                  >
                    {t.label}{' '}
                    <span
                      style={{
                        opacity: 0.7,
                        marginLeft: '0.25rem',
                      }}
                    >
                      ({count})
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Add-expense form — Expenses tab, open shift, admin/manager.
                Records a categorised WITHDRAWAL (e.g. a Subscription) into the
                drawer. Subscription purchases also auto-land here. */}
            {txTab === 'expenses' &&
              isAdminOrManager &&
              selectedShift &&
              selectedShift.status === 'OPEN' && (
                <form
                  onSubmit={handleAddExpense}
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                    marginBottom: '0.75rem',
                    alignItems: 'center',
                  }}
                >
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Amount"
                    value={expenseForm.amount}
                    onChange={(e) =>
                      setExpenseForm((f) => ({ ...f, amount: e.target.value }))
                    }
                    style={{ ...inputStyle, flex: '1 1 110px' }}
                    aria-label="Expense amount"
                  />
                  <input
                    placeholder="Reason — e.g. Pro plan"
                    value={expenseForm.reason}
                    onChange={(e) =>
                      setExpenseForm((f) => ({ ...f, reason: e.target.value }))
                    }
                    style={{ ...inputStyle, flex: '2 1 200px' }}
                    aria-label="Expense reason"
                  />
                  <select
                    value={expenseForm.category}
                    onChange={(e) =>
                      setExpenseForm((f) => ({ ...f, category: e.target.value }))
                    }
                    style={{ ...inputStyle, flex: '1 1 140px' }}
                    aria-label="Expense type"
                  >
                    <option value="GENERAL">General</option>
                    <option value="SUBSCRIPTION">Subscription</option>
                  </select>
                  <button
                    type="submit"
                    disabled={savingExpense}
                    style={primaryButtonStyle}
                  >
                    <Plus size={14} /> {savingExpense ? 'Adding…' : 'Add expense'}
                  </button>
                </form>
              )}

            {shiftLoading && <div>Loading transactions…</div>}

            {!shiftLoading && !selectedShift && (
              <div style={emptyStateStyle}>
                Open a shift to start recording transactions.
              </div>
            )}

            {!shiftLoading &&
              selectedShift &&
              visibleTransactions.length === 0 && (
                <div style={emptyStateStyle}>
                  {txTab === 'expenses' ? (
                    'No expenses recorded on this shift yet. Add one below, or a subscription purchase will appear here automatically.'
                  ) : (
                    <>
                      No {txTab === 'bookings' ? 'cash bookings' : 'partial-cash sales'}{' '}
                      {txDateFilter && txDateFilter.preset !== 'all'
                        ? 'in the selected date range.'
                        : 'yet on this shift.'}
                    </>
                  )}
                </div>
              )}

            {!shiftLoading && visibleTransactions.length > 0 && (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                }}
              >
                {txTab === 'expenses'
                  ? visibleTransactions.map((exp) => (
                      <li
                        key={exp.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '0.6rem 0.75rem',
                          background: 'rgba(255,255,255,0.03)',
                          borderRadius: 8,
                          fontSize: '0.85rem',
                        }}
                        data-testid={`expense-row-${exp.id}`}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                          }}
                        >
                          <ArrowUpFromLine size={14} color="var(--accent-color)" />
                          <div>
                            <div
                              style={{
                                fontWeight: 500,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                              }}
                            >
                              {exp.reason || 'Expense'}
                              {exp.category && exp.category !== 'GENERAL' && (
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    fontWeight: 600,
                                    textTransform: 'capitalize',
                                    padding: '0.1rem 0.45rem',
                                    borderRadius: 999,
                                    background: 'rgba(124,196,180,0.18)',
                                    color: 'var(--primary-color, var(--accent-color))',
                                  }}
                                >
                                  {exp.category.toLowerCase()}
                                </span>
                              )}
                            </div>
                            {exp.createdAt && (
                              <div
                                style={{
                                  fontSize: '0.7rem',
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                {formatDateTime(exp.createdAt)}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ fontWeight: 600, color: 'var(--accent-color)' }}>
                          −{formatMoney(exp.amount)}
                        </div>
                      </li>
                    ))
                  : visibleTransactions.map((sale) => (
                      <li
                        key={sale.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '0.6rem 0.75rem',
                          background: 'rgba(255,255,255,0.03)',
                          borderRadius: 8,
                          fontSize: '0.85rem',
                        }}
                        data-testid={`tx-row-${sale.id}`}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                          }}
                        >
                          <CircleDollarSign
                            size={14}
                            color="var(--success-color)"
                          />
                          <div>
                            <div style={{ fontWeight: 500 }}>
                              {sale.invoiceNumber || `Sale #${sale.id}`}
                            </div>
                            <div
                              style={{
                                fontSize: '0.7rem',
                                color: 'var(--text-secondary)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                              }}
                            >
                              {sale.patientId ? (
                                <>
                                  <UserCircle2 size={10} />
                                  Patient #{sale.patientId}
                                </>
                              ) : (
                                <>
                                  <UserX size={10} />
                                  Walk-in
                                </>
                              )}
                              {sale.createdAt && (
                                <span>· {formatDateTime(sale.createdAt)}</span>
                              )}
                              <span>· {sale.paymentMethod}</span>
                            </div>
                          </div>
                        </div>
                        <div style={{ fontWeight: 600 }}>
                          {formatMoney(sale.total)}
                        </div>
                      </li>
                    ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Shared inline styles ────────────────────────────────────────────
const inputStyle = {
  padding: '0.55rem 0.75rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
};

const primaryButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.5rem 1rem',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: '0.9rem',
  fontWeight: 500,
};

const secondaryButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.5rem 0.85rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '0.85rem',
};

const iconButtonStyle = {
  background: 'rgba(99,102,241,0.1)',
  border: '1px solid rgba(99,102,241,0.3)',
  color: 'var(--primary-color, var(--accent-color))',
  padding: '0.25rem 0.45rem',
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
};

const formStyle = {
  padding: '1.25rem',
  marginBottom: '1rem',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
  gap: '0.5rem',
};

const emptyStateStyle = {
  padding: '1.5rem',
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: '0.85rem',
};
