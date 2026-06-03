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
import { Banknote, Plus } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { AuthContext } from '../../App';
import {
  resolveDateRange,
  EMPTY_DATE_FILTER,
} from '../../components/wellness/DateRangeFilter';

import RegisterForm from './cashRegisters/RegisterForm';
import { EMPTY_REGISTER_FORM } from './cashRegisters/constants';
import RegisterGrid from './cashRegisters/RegisterGrid';
import ShiftPanel from './cashRegisters/ShiftPanel';
import TransactionList from './cashRegisters/TransactionList';
import { primaryButtonStyle } from './cashRegisters/sharedStyles';

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <RegisterForm
        show={showForm}
        isAdminOrManager={isAdminOrManager}
        editingId={editingId}
        form={form}
        saving={saving}
        locations={locations}
        onSubmit={submitRegister}
        setForm={setForm}
      />

      <RegisterGrid
        registers={registers}
        openShifts={openShifts}
        loading={loading}
        selectedRegisterId={selectedRegisterId}
        isAdminOrManager={isAdminOrManager}
        onSelectRegister={setSelectedRegisterId}
        onEdit={startEdit}
        onToggleActive={toggleActive}
      />

      {selectedRegister && (
        <section
          className="glass"
          style={{ padding: '1.5rem' }}
          data-testid="selected-register-panel"
        >
          <ShiftPanel
            selectedRegister={selectedRegister}
            selectedShift={selectedShift}
            currentBalance={currentBalance}
            openingFloat={openingFloat}
            openingShift={openingShift}
            closingTotal={closingTotal}
            closingNotes={closingNotes}
            closingShift={closingShift}
            onOpeningFloatChange={setOpeningFloat}
            onOpenShift={submitOpenShift}
            onClosingTotalChange={setClosingTotal}
            onClosingNotesChange={setClosingNotes}
            onCloseShift={submitCloseShift}
            onDeposit={handleDeposit}
            onWithdrawal={handleWithdrawal}
          />
          <TransactionList
            txTab={txTab}
            txDateFilter={txDateFilter}
            transactions={transactions}
            visibleTransactions={visibleTransactions}
            shiftLoading={shiftLoading}
            selectedShift={selectedShift}
            isAdminOrManager={isAdminOrManager}
            expenseForm={expenseForm}
            savingExpense={savingExpense}
            onTabChange={setTxTab}
            onDateFilterChange={setTxDateFilter}
            onAddExpense={handleAddExpense}
            onExpenseFormChange={setExpenseForm}
          />
        </section>
      )}
    </div>
  );
}
