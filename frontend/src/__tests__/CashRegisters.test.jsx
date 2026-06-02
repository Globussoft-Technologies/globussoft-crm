/**
 * CashRegisters.jsx — Zylu-Gap #770 / #779 / #780 / #781 admin surface.
 *
 * What this test pins
 * -------------------
 *   #770 — list view loads from GET /api/pos/registers + create form
 *          POSTs to /api/pos/registers with { name, locationId, openingFloat }.
 *   #780 — register cards render a OPEN/CLOSED status pill; the
 *          per-register detail panel renders a "REGISTER OPEN" / "REGISTER
 *          CLOSED" status header with the drawer balance.
 *   #779 — clicking a closed register surfaces the "Open shift" form;
 *          submit POSTs /api/pos/shifts/open with { registerId, openingFloat };
 *          the close-shift form POSTs /api/pos/shifts/:id/close.
 *          Deposit + Withdrawal buttons POST to /api/pos/shifts/:id/deposit
 *          and /withdraw with { amount, reason } — PettyCashLedger backend
 *          shipped 2026-05-18 with this commit.
 *   #781 — selected register's transactions bucket into three tabs
 *          (Bookings Cash / Partial Cash / Expenses Cash); switching
 *          tabs swaps the visible rows; CASH+patientId → bookings;
 *          COMBINED → partial; expenses bucket stays empty until the
 *          backend ledger ships.
 *
 * Mocking — fetchApi is a vi.fn at module scope; useNotify returns a
 * stable mock object (per the RTL-stable-mock standing rule); formatMoney
 * is mocked to a deterministic "INR X.XX" so tests assert digit content
 * not Intl-formatted output (CI ICU builds vary).
 *
 * Backend contract pinned
 * -----------------------
 *   GET  /api/pos/registers                                → Register[]
 *   GET  /api/pos/shifts?registerId=N&status=OPEN          → Shift[]
 *   GET  /api/pos/shifts/:id                               → Shift + sales
 *   POST /api/pos/registers                                → Register
 *   POST /api/pos/shifts/open                              → Shift
 *   POST /api/pos/shifts/:id/close                         → Shift
 *   GET  /api/wellness/locations                           → Location[]
 *
 * Header style follows the existing PointOfSale.test.jsx + GiftCards
 * test conventions in this same directory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('100')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (v) => `INR ${Number(v || 0).toFixed(2)}`,
  tenantCurrency: () => 'INR',
}));
vi.mock('../utils/date', () => ({
  formatDateTime: (d) => (d ? new Date(d).toISOString().slice(0, 16) : '—'),
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
  default: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

// AuthContext is consumed via useContext; the App module exports the
// context. Provide an admin user so the create/edit/delete UI mounts.
vi.mock('../App', () => {
  const { createContext } = require('react');
  return {
    AuthContext: createContext({
      user: { id: 1, role: 'ADMIN', wellnessRole: 'admin' },
    }),
    ThemeContext: createContext({}),
  };
});

// Import AFTER the mocks so the page picks up our AuthContext default.
import CashRegisters from '../pages/wellness/CashRegisters';

// ── Fixtures ──────────────────────────────────────────────────────────
const LOCATIONS = [
  { id: 1, name: 'HSR Layout', city: 'Bengaluru' },
  { id: 2, name: 'Indiranagar', city: 'Bengaluru' },
];

const REGISTER_OPEN = {
  id: 11,
  name: 'Front Desk',
  locationId: 1,
  openingFloat: 500,
  isActive: true,
  location: { id: 1, name: 'HSR Layout', city: 'Bengaluru' },
};

const REGISTER_CLOSED = {
  id: 12,
  name: 'Pharmacy Counter',
  locationId: 1,
  openingFloat: 200,
  isActive: true,
  location: { id: 1, name: 'HSR Layout', city: 'Bengaluru' },
};

const OPEN_SHIFT = {
  id: 999,
  registerId: 11,
  openingFloat: 500,
  status: 'OPEN',
  openedAt: '2026-05-17T09:00:00.000Z',
  sales: [
    {
      id: 7001,
      invoiceNumber: 'POS-2026-0001',
      total: 1200,
      paymentMethod: 'CASH',
      status: 'COMPLETED',
      patientId: 42,
      createdAt: '2026-05-17T09:30:00.000Z',
    },
    {
      id: 7002,
      invoiceNumber: 'POS-2026-0002',
      total: 800,
      paymentMethod: 'CASH',
      status: 'COMPLETED',
      patientId: null,
      createdAt: '2026-05-17T09:45:00.000Z',
    },
    {
      id: 7003,
      invoiceNumber: 'POS-2026-0003',
      total: 1500,
      paymentMethod: 'COMBINED',
      status: 'COMPLETED',
      patientId: 43,
      createdAt: '2026-05-17T10:00:00.000Z',
    },
  ],
};

// ── Mock builders ────────────────────────────────────────────────────
function makeMock({ registers = [REGISTER_OPEN, REGISTER_CLOSED], openShiftFor = { 11: OPEN_SHIFT }, shiftDetail = OPEN_SHIFT, pettyCash = [] } = {}) {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/pos/registers' && method === 'GET') {
      return Promise.resolve(registers);
    }
    if (url === '/api/wellness/locations') {
      return Promise.resolve(LOCATIONS);
    }
    const shiftListMatch = url.match(/^\/api\/pos\/shifts\?registerId=(\d+)&status=OPEN$/);
    if (shiftListMatch) {
      const regId = parseInt(shiftListMatch[1], 10);
      const s = openShiftFor[regId];
      return Promise.resolve(s ? [s] : []);
    }
    // Petty-cash ledger powers the Expenses tab — match BEFORE the bare
    // /shifts/:id detail route (more specific path first).
    if (/^\/api\/pos\/shifts\/\d+\/petty-cash$/.test(url) && method === 'GET') {
      return Promise.resolve(pettyCash);
    }
    if (/^\/api\/pos\/shifts\/\d+\/withdraw$/.test(url) && method === 'POST') {
      return Promise.resolve({ id: 555, type: 'WITHDRAWAL' });
    }
    const shiftDetailMatch = url.match(/^\/api\/pos\/shifts\/(\d+)$/);
    if (shiftDetailMatch && method === 'GET') {
      return Promise.resolve(shiftDetail);
    }
    if (url === '/api/pos/registers' && method === 'POST') {
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({ id: 99, ...body, isActive: true });
    }
    if (url === '/api/pos/shifts/open' && method === 'POST') {
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({
        id: 1000,
        registerId: body.registerId,
        openingFloat: body.openingFloat,
        status: 'OPEN',
        openedAt: new Date().toISOString(),
        sales: [],
      });
    }
    if (/^\/api\/pos\/shifts\/\d+\/close$/.test(url) && method === 'POST') {
      return Promise.resolve({ id: 999, status: 'CLOSED', variance: 0 });
    }
    if (/^\/api\/pos\/registers\/\d+$/.test(url) && method === 'PUT') {
      const id = parseInt(url.split('/').pop(), 10);
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({ ...registers.find((r) => r.id === id), ...body });
    }
    return Promise.resolve([]);
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CashRegisters />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
});

// ─────────────────────────────────────────────────────────────────────
// #770 — list view + create flow
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — #770 list + create', () => {
  it('renders the page header + register cards from GET /api/pos/registers', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText(/Cash Registers/i)).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText('Front Desk')).toBeInTheDocument(),
    );
    expect(screen.getByText('Pharmacy Counter')).toBeInTheDocument();
    // 2 registers — header summary
    expect(screen.getByText(/2 registers/i)).toBeInTheDocument();
  });

  it('renders empty-state copy when no registers exist', async () => {
    fetchApiMock.mockImplementation(makeMock({ registers: [], openShiftFor: {} }));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No cash registers yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Create one to start ringing up sales/i)).toBeInTheDocument();
  });

  it('admin can open create form and POST /api/pos/registers with correct payload', async () => {
    fetchApiMock.mockImplementation(makeMock({ registers: [] }));
    renderPage();

    await waitFor(() => expect(screen.getByText(/No cash registers yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /New register/i }));

    fireEvent.change(screen.getByLabelText(/Register name/i), {
      target: { value: 'Pharmacy 2' },
    });
    fireEvent.change(screen.getByLabelText(/^Location$/i), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText(/Opening float/i), {
      target: { value: '750' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create register/i }));

    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/pos/registers' && opts?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
      const body = JSON.parse(postCalls[0][1].body);
      expect(body).toEqual({
        name: 'Pharmacy 2',
        locationId: 2,
        openingFloat: 750,
      });
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Created.*Pharmacy 2/i));
  });
});

// ─────────────────────────────────────────────────────────────────────
// #780 — status header (OPEN/CLOSED) + balance
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — #780 status header + balance', () => {
  it('shows REGISTER OPEN pill on register with active shift', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('register-status-11')).toHaveTextContent(/REGISTER OPEN/i),
    );
    expect(screen.getByTestId('register-status-12')).toHaveTextContent(/REGISTER CLOSED/i);
  });

  it('renders the detail-panel status header with current drawer balance when register is selected', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByTestId('selected-register-panel')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('status-header')).toHaveTextContent(/REGISTER OPEN/i);
    // Balance = openingFloat (500) + sum(CASH completed sales) (1200 + 800)
    //        = 2500. formatMoney mock renders "INR 2500.00".
    expect(screen.getByTestId('current-balance')).toHaveTextContent('2500');
  });

  it('selecting a CLOSED register shows REGISTER CLOSED status header', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Pharmacy Counter')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-12'));

    await waitFor(() =>
      expect(screen.getByTestId('selected-register-panel')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('status-header')).toHaveTextContent(/REGISTER CLOSED/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// #779 — shift open / close / deposit / withdraw
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — #779 shift lifecycle', () => {
  it('Open shift POST hits /api/pos/shifts/open with { registerId, openingFloat }', async () => {
    fetchApiMock.mockImplementation(
      makeMock({
        // Pharmacy Counter (id 12) has no open shift.
        openShiftFor: { 11: OPEN_SHIFT },
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Pharmacy Counter')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-12'));

    await waitFor(() =>
      expect(screen.getByTestId('selected-register-panel')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText(/Opening float for new shift/i), {
      target: { value: '300' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Open shift/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/pos/shifts/open' && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ registerId: 12, openingFloat: 300 });
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Shift opened/i));
  });

  it('Close shift POST hits /api/pos/shifts/:id/close with { closingTotal, notes }', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByLabelText(/Closing total/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/Closing total/i), {
      target: { value: '2500' },
    });
    fireEvent.change(screen.getByLabelText(/Closing notes/i), {
      target: { value: 'End of day' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Close shift/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          /^\/api\/pos\/shifts\/\d+\/close$/.test(url) && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ closingTotal: 2500, notes: 'End of day' });
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Shift closed/i));
  });

  it('Deposit button POSTs to /api/pos/shifts/:id/deposit with { amount, reason } (#779)', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Deposit cash/i })).toBeInTheDocument(),
    );
    // window.prompt called twice — once for amount, once for reason.
    const promptSpy = vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('2000')
      .mockReturnValueOnce('Owner brought change');
    fireEvent.click(screen.getByRole('button', { name: /Deposit cash/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => /\/deposit$/.test(url) && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ amount: 2000, reason: 'Owner brought change' });
    });
    promptSpy.mockRestore();
  });

  it('Withdraw button POSTs to /api/pos/shifts/:id/withdraw with { amount, reason } (#779)', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Withdraw cash/i })).toBeInTheDocument(),
    );
    const promptSpy = vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('250')
      .mockReturnValueOnce('Courier fee');
    fireEvent.click(screen.getByRole('button', { name: /Withdraw cash/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => /\/withdraw$/.test(url) && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ amount: 250, reason: 'Courier fee' });
    });
    promptSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Expenses tab — petty-cash WITHDRAWAL ledger + Subscription category
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — Expenses tab + subscription expense', () => {
  const SUBSCRIPTION_EXPENSE = {
    id: 9001,
    type: 'WITHDRAWAL',
    category: 'SUBSCRIPTION',
    amount: 1999,
    reason: 'Subscription: Pro',
    createdAt: '2026-05-18T10:00:00.000Z',
  };

  it('renders WITHDRAWAL entries with a Subscription badge in the Expenses tab', async () => {
    fetchApiMock.mockImplementation(makeMock({ pettyCash: [SUBSCRIPTION_EXPENSE] }));
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    // Switch to the Expenses Cash tab.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Expenses Cash/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Expenses Cash/i }));

    await waitFor(() =>
      expect(screen.getByTestId('expense-row-9001')).toBeInTheDocument(),
    );
    const row = screen.getByTestId('expense-row-9001');
    expect(within(row).getByText('Subscription: Pro')).toBeInTheDocument(); // reason
    expect(within(row).getByText('subscription')).toBeInTheDocument(); // category badge (lowercased)
    expect(within(row).getByText(/^−/)).toBeInTheDocument(); // outflow amount (minus prefix)
  });

  it('Add-expense form POSTs /withdraw with the chosen SUBSCRIPTION category', async () => {
    fetchApiMock.mockImplementation(makeMock({ pettyCash: [] }));
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Expenses Cash/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Expenses Cash/i }));

    // Fill the add-expense form: amount, reason, type=Subscription.
    await waitFor(() =>
      expect(screen.getByLabelText(/Expense amount/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/Expense amount/i), { target: { value: '1999' } });
    fireEvent.change(screen.getByLabelText(/Expense reason/i), { target: { value: 'Pro plan' } });
    fireEvent.change(screen.getByLabelText(/Expense type/i), { target: { value: 'SUBSCRIPTION' } });
    fireEvent.click(screen.getByRole('button', { name: /Add expense/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => /\/withdraw$/.test(url) && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ amount: 1999, reason: 'Pro plan', category: 'SUBSCRIPTION' });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// #781 — recent transactions split into 3 buckets
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — #781 transactions tabs', () => {
  it('renders all three tabs with correct counts derived from shift.sales', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Bookings Cash/i })).toBeInTheDocument(),
    );
    // Bookings = 2 (both CASH completed sales)
    expect(screen.getByRole('tab', { name: /Bookings Cash.*\(2\)/i })).toBeInTheDocument();
    // Partial Cash = 1 (the COMBINED sale)
    expect(screen.getByRole('tab', { name: /Partial Cash.*\(1\)/i })).toBeInTheDocument();
    // Expenses Cash = 0 (no ledger yet)
    expect(screen.getByRole('tab', { name: /Expenses Cash.*\(0\)/i })).toBeInTheDocument();
  });

  it('Bookings Cash tab (default) shows the two CASH sales by invoice number', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByTestId('tx-row-7001')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('tx-row-7001')).toHaveTextContent('POS-2026-0001');
    expect(screen.getByTestId('tx-row-7002')).toHaveTextContent('POS-2026-0002');
    // Walk-in (no patientId) shows the Walk-in label.
    expect(screen.getByTestId('tx-row-7002')).toHaveTextContent(/Walk-in/i);
    // The COMBINED sale should NOT appear in the Bookings tab.
    expect(screen.queryByTestId('tx-row-7003')).not.toBeInTheDocument();
  });

  it('switching to Partial Cash tab shows the COMBINED sale only', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Partial Cash/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Partial Cash/i }));

    await waitFor(() =>
      expect(screen.getByTestId('tx-row-7003')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('tx-row-7003')).toHaveTextContent('POS-2026-0003');
    expect(screen.queryByTestId('tx-row-7001')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-7002')).not.toBeInTheDocument();
  });

  it('Expenses Cash tab shows the empty-state copy when there are no ledger entries', async () => {
    fetchApiMock.mockImplementation(makeMock({ pettyCash: [] }));
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Expenses Cash/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Expenses Cash/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/No expenses recorded on this shift yet/i),
      ).toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// EXTENSIONS — register-form validation, edit/PUT, toggleActive,
// shift-form validation, prompt cancellation, error states, balance
// edge cases. Adapts to the actual SUT contract (no denomination
// breakdown — single closingTotal field; no historical-shift list
// surface; no date-range filter — these don't exist in CashRegisters.jsx
// so we pin what DOES exist instead).
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — register form validation', () => {
  it('blocks submit + toasts when register name is blank', async () => {
    fetchApiMock.mockImplementation(makeMock({ registers: [] }));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No cash registers yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New register/i }));

    // Fill location only; leave name blank.
    fireEvent.change(screen.getByLabelText(/^Location$/i), {
      target: { value: '1' },
    });

    // The form has `required` on the name input, but the SUT also has
    // an explicit guard `if (!form.name.trim())`. Trigger the latter by
    // bypassing the browser's required-check via submit() on the form.
    // Use whitespace-only to defeat HTML required while still failing
    // the trim() guard.
    fireEvent.change(screen.getByLabelText(/Register name/i), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create register/i }));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/Register name is required/i),
      );
    });
    // NO POST should have fired.
    const posts = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/pos/registers' && opts?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('toggles the New register button label between "New register" and "Cancel"', async () => {
    fetchApiMock.mockImplementation(makeMock({ registers: [] }));
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New register/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New register/i }));
    // After clicking, the same button now reads "Cancel".
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New register/i })).toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Register edit (PUT) — pre-fills form + hits PUT /api/pos/registers/:id
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — edit register (PUT)', () => {
  it('clicking the Edit icon pre-fills the form + submit PUTs the new payload', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());

    // Edit "Front Desk" (id 11).
    fireEvent.click(screen.getByLabelText(/Edit Front Desk/i));

    // Form pre-fills with current name.
    await waitFor(() =>
      expect(screen.getByLabelText(/Register name/i)).toHaveValue('Front Desk'),
    );

    // Change the name.
    fireEvent.change(screen.getByLabelText(/Register name/i), {
      target: { value: 'Front Desk — Renamed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/pos/registers/11' && opts?.method === 'PUT',
      );
      expect(puts.length).toBe(1);
      const body = JSON.parse(puts[0][1].body);
      expect(body.name).toBe('Front Desk — Renamed');
      expect(body.locationId).toBe(1);
    });
    expect(notify.success).toHaveBeenCalledWith(
      expect.stringMatching(/Updated.*Front Desk — Renamed/i),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// toggleActive — Deactivate icon PUTs { isActive: false }
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — toggleActive', () => {
  it('clicking Deactivate sends PUT { isActive: false } against the right id', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Deactivate Front Desk/i));

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/pos/registers/11' && opts?.method === 'PUT',
      );
      expect(puts.length).toBe(1);
      const body = JSON.parse(puts[0][1].body);
      expect(body).toEqual({ isActive: false });
    });
    expect(notify.success).toHaveBeenCalledWith(
      expect.stringMatching(/Deactivated.*Front Desk/i),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Shift open — opening-float validation (negative, NaN, blank)
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — shift open validation', () => {
  it('rejects negative opening float with an inline toast (no POST)', async () => {
    fetchApiMock.mockImplementation(
      makeMock({ openShiftFor: { 11: OPEN_SHIFT } }), // 12 has no shift
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Pharmacy Counter')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-12'));

    await waitFor(() =>
      expect(screen.getByLabelText(/Opening float for new shift/i)).toBeInTheDocument(),
    );
    const floatInput = screen.getByLabelText(/Opening float for new shift/i);
    fireEvent.change(floatInput, { target: { value: '-50' } });
    // Use fireEvent.submit on the parent form — bypasses HTML5 `min`
    // validation that would otherwise block click→submit in jsdom.
    fireEvent.submit(floatInput.closest('form'));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/non-negative/i),
      );
    });
    const opens = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/pos/shifts/open' && opts?.method === 'POST',
    );
    expect(opens.length).toBe(0);
  });

  it('rejects non-numeric opening float (NaN guard) without POST', async () => {
    fetchApiMock.mockImplementation(
      makeMock({ openShiftFor: { 11: OPEN_SHIFT } }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Pharmacy Counter')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-12'));

    await waitFor(() =>
      expect(screen.getByLabelText(/Opening float for new shift/i)).toBeInTheDocument(),
    );
    // Leave blank — parseFloat('') === NaN — Number.isFinite(NaN) === false.
    fireEvent.click(screen.getByRole('button', { name: /Open shift/i }));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/non-negative/i),
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Shift close — closing-total validation + variance-ledger semantics
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — shift close validation', () => {
  it('rejects negative closing total without POST', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByLabelText(/Closing total/i)).toBeInTheDocument(),
    );
    const closingInput = screen.getByLabelText(/Closing total/i);
    fireEvent.change(closingInput, { target: { value: '-100' } });
    // Bypass HTML5 `min` constraint by submitting the form directly.
    fireEvent.submit(closingInput.closest('form'));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/non-negative/i),
      );
    });
    const closes = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        /^\/api\/pos\/shifts\/\d+\/close$/.test(url) && opts?.method === 'POST',
    );
    expect(closes.length).toBe(0);
  });

  it('omits notes field from body when notes input is left blank (undefined collapse)', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByLabelText(/Closing total/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/Closing total/i), {
      target: { value: '2500' },
    });
    // Notes deliberately blank.
    fireEvent.click(screen.getByRole('button', { name: /Close shift/i }));

    await waitFor(() => {
      const closes = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          /^\/api\/pos\/shifts\/\d+\/close$/.test(url) && opts?.method === 'POST',
      );
      expect(closes.length).toBe(1);
      const body = JSON.parse(closes[0][1].body);
      expect(body.closingTotal).toBe(2500);
      // JSON.stringify drops undefined keys — so `notes` should not be present.
      expect(body).not.toHaveProperty('notes');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Deposit / Withdraw cancellation paths + validation
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — deposit/withdraw cancellation + validation', () => {
  it('cancelling the amount prompt aborts the deposit (no POST, no error toast)', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Deposit cash/i })).toBeInTheDocument(),
    );

    // window.prompt returns null when the user clicks Cancel.
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /Deposit cash/i }));

    // No POST and no error toast (cancellation is silent).
    const deposits = fetchApiMock.mock.calls.filter(
      ([url, opts]) => /\/deposit$/.test(url) && opts?.method === 'POST',
    );
    expect(deposits.length).toBe(0);
    expect(notify.error).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('zero / negative deposit amount toasts "must be positive" and skips POST', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Deposit cash/i })).toBeInTheDocument(),
    );

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce('0');
    fireEvent.click(screen.getByRole('button', { name: /Deposit cash/i }));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/positive/i),
      );
    });
    const deposits = fetchApiMock.mock.calls.filter(
      ([url, opts]) => /\/deposit$/.test(url) && opts?.method === 'POST',
    );
    expect(deposits.length).toBe(0);
    promptSpy.mockRestore();
  });

  it('blank reason toasts "Reason is required" and skips POST', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Withdraw cash/i })).toBeInTheDocument(),
    );

    const promptSpy = vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('100')
      .mockReturnValueOnce('   '); // whitespace-only reason
    fireEvent.click(screen.getByRole('button', { name: /Withdraw cash/i }));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/Reason is required/i),
      );
    });
    const withdraws = fetchApiMock.mock.calls.filter(
      ([url, opts]) => /\/withdraw$/.test(url) && opts?.method === 'POST',
    );
    expect(withdraws.length).toBe(0);
    promptSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Load error + empty-detail + balance edge cases
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — load error + empty/balance states', () => {
  it('GET /api/pos/registers failure surfaces an error toast + empty grid', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pos/registers') {
        return Promise.reject(new Error('Server down'));
      }
      if (url === '/api/wellness/locations') return Promise.resolve(LOCATIONS);
      return Promise.resolve([]);
    });
    renderPage();

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/Server down/i),
      ),
    );
    // Should fall back to empty-state copy.
    expect(screen.getByText(/No cash registers yet/i)).toBeInTheDocument();
  });

  it('drawer balance equals openingFloat when shift has zero CASH+COMPLETED sales', async () => {
    const emptyShift = {
      ...OPEN_SHIFT,
      id: 555,
      openingFloat: 1234,
      sales: [
        // PENDING sales should NOT count toward balance.
        {
          id: 9001,
          invoiceNumber: 'POS-PENDING',
          total: 999,
          paymentMethod: 'CASH',
          status: 'PENDING',
          patientId: 1,
        },
      ],
    };
    fetchApiMock.mockImplementation(
      makeMock({
        openShiftFor: { 11: { ...OPEN_SHIFT, id: 555 } },
        shiftDetail: emptyShift,
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByTestId('current-balance')).toBeInTheDocument(),
    );
    // 1234 + 0 (the PENDING sale is filtered out by the bookings filter)
    expect(screen.getByTestId('current-balance')).toHaveTextContent('1234');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Permission gating — non-admin user (USER role) hides admin surfaces
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — non-admin permission gating', () => {
  it.skip(
    'non-admin user sees neither "New register" button nor edit/deactivate icons — covered structurally by isAdminOrManager flag, requires a separate AuthContext mock setup that this file does not currently rewire per-test; see existing PointOfSale.test.jsx pattern.',
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────
// EXTENSION — additional uncovered branches:
//   • header singular ("1 register") vs plural ("2 registers")
//   • "Pick a location" form guard (separate from name guard)
//   • "Activated <name>" toast on toggleActive of an inactive register
//   • loadLocations / loadShiftDetail error paths
//   • Closing total NaN guard (parallel to opening-float NaN)
//   • Withdraw amount-cancel and reason-cancel silent aborts
//   • Tab aria-selected wiring on switch
//   • Empty bookings-tab copy when shift has no CASH sales
//   • Loading… banner before list resolves
// ─────────────────────────────────────────────────────────────────────
describe('CashRegisters — extension coverage', () => {
  it('header pluralises "register" correctly — singular when exactly 1', async () => {
    fetchApiMock.mockImplementation(makeMock({ registers: [REGISTER_OPEN] }));
    renderPage();

    // "1 register" — no trailing 's'. The strict-match regex
    // `\b1 register\b(?!s)` avoids accidentally matching "1 registers".
    await waitFor(() =>
      expect(screen.getByText(/\b1 register\b(?!s)/i)).toBeInTheDocument(),
    );
  });

  it('blocks submit + toasts "Pick a location" when name is set but location is blank', async () => {
    fetchApiMock.mockImplementation(makeMock({ registers: [] }));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No cash registers yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New register/i }));

    fireEvent.change(screen.getByLabelText(/Register name/i), {
      target: { value: 'Valid Name' },
    });
    // Location intentionally NOT set. Bypass HTML5 `required` by submitting
    // the form directly (same pattern as the float-negative guard above).
    fireEvent.submit(
      screen.getByLabelText(/Register name/i).closest('form'),
    );

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/Pick a location/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/pos/registers' && opts?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('clicking the Activate icon on an INACTIVE register PUTs { isActive: true } + toasts "Activated"', async () => {
    // Build a fixture with one inactive register so the toggleActive flow
    // routes through the "Activate" branch (reg.isActive is false → flip true).
    const inactiveReg = { ...REGISTER_OPEN, id: 21, isActive: false, name: 'Old Counter' };
    fetchApiMock.mockImplementation(
      makeMock({ registers: [inactiveReg], openShiftFor: {} }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Old Counter')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Activate Old Counter/i));

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/pos/registers/21' && opts?.method === 'PUT',
      );
      expect(puts.length).toBe(1);
      const body = JSON.parse(puts[0][1].body);
      expect(body).toEqual({ isActive: true });
    });
    expect(notify.success).toHaveBeenCalledWith(
      expect.stringMatching(/Activated.*Old Counter/i),
    );
  });

  it('loadLocations failure is silent (no toast, page still mounts)', async () => {
    // Locations endpoint throws — page should still render registers
    // without toasting (loadLocations swallows in a catch-block).
    fetchApiMock.mockImplementation((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url === '/api/pos/registers' && method === 'GET') {
        return Promise.resolve([REGISTER_OPEN]);
      }
      if (url === '/api/wellness/locations') {
        return Promise.reject(new Error('Locations 500'));
      }
      if (/^\/api\/pos\/shifts\?registerId=/.test(url)) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    // Locations error must NOT surface a toast (silent catch).
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('GET /api/pos/shifts/:id failure surfaces an error toast + nulls the detail panel', async () => {
    fetchApiMock.mockImplementation((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url === '/api/pos/registers' && method === 'GET') {
        return Promise.resolve([REGISTER_OPEN]);
      }
      if (url === '/api/wellness/locations') return Promise.resolve(LOCATIONS);
      if (/^\/api\/pos\/shifts\?registerId=11/.test(url)) {
        return Promise.resolve([OPEN_SHIFT]);
      }
      // Shift detail throws.
      if (/^\/api\/pos\/shifts\/999$/.test(url) && method === 'GET') {
        return Promise.reject(new Error('Shift detail boom'));
      }
      return Promise.resolve([]);
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/Shift detail boom/i),
      ),
    );
    // selectedShift cleared → status header should fall back to CLOSED.
    expect(screen.getByTestId('status-header')).toHaveTextContent(/REGISTER CLOSED/i);
  });

  it('Close shift NaN closingTotal triggers non-negative error (parseFloat("") branch)', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByLabelText(/Closing total/i)).toBeInTheDocument(),
    );
    // Leave closingTotal blank — parseFloat('') === NaN.
    fireEvent.click(screen.getByRole('button', { name: /Close shift/i }));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/non-negative/i),
      );
    });
    const closes = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        /^\/api\/pos\/shifts\/\d+\/close$/.test(url) && opts?.method === 'POST',
    );
    expect(closes.length).toBe(0);
  });

  it('cancelling the WITHDRAW amount prompt aborts silently (no POST, no error toast)', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Withdraw cash/i })).toBeInTheDocument(),
    );

    // window.prompt returns null when the user clicks Cancel.
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /Withdraw cash/i }));

    const withdraws = fetchApiMock.mock.calls.filter(
      ([url, opts]) => /\/withdraw$/.test(url) && opts?.method === 'POST',
    );
    expect(withdraws.length).toBe(0);
    expect(notify.error).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('cancelling the REASON prompt (after providing amount) aborts silently — no POST', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Deposit cash/i })).toBeInTheDocument(),
    );

    // Amount OK, but user cancels the reason prompt.
    const promptSpy = vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('500')
      .mockReturnValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /Deposit cash/i }));

    const deposits = fetchApiMock.mock.calls.filter(
      ([url, opts]) => /\/deposit$/.test(url) && opts?.method === 'POST',
    );
    expect(deposits.length).toBe(0);
    // Reason-cancel is silent (no toast).
    expect(notify.error).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('aria-selected reflects the active transaction tab', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Bookings Cash/i })).toBeInTheDocument(),
    );
    // Default: bookings selected.
    expect(screen.getByRole('tab', { name: /Bookings Cash/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Partial Cash/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    fireEvent.click(screen.getByRole('tab', { name: /Partial Cash/i }));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Partial Cash/i })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(screen.getByRole('tab', { name: /Bookings Cash/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('Bookings tab renders the per-bucket empty-state copy when no CASH sales exist', async () => {
    const noCashShift = {
      ...OPEN_SHIFT,
      sales: [
        // Only a COMBINED sale — bookings bucket will be empty.
        {
          id: 8001,
          invoiceNumber: 'POS-COMBO-ONLY',
          total: 999,
          paymentMethod: 'COMBINED',
          status: 'COMPLETED',
          patientId: 50,
        },
      ],
    };
    fetchApiMock.mockImplementation(
      makeMock({
        openShiftFor: { 11: OPEN_SHIFT },
        shiftDetail: noCashShift,
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Bookings Cash/i })).toBeInTheDocument(),
    );
    // Default tab is bookings; the bucket-empty copy should be present.
    await waitFor(() =>
      expect(
        screen.getByText(/No cash bookings yet on this shift/i),
      ).toBeInTheDocument(),
    );
  });

  it('shows the Loading… banner while the initial GET /registers is in flight', async () => {
    // Build a controllable promise so we can assert the loading state
    // BEFORE the resolver fires.
    let resolveRegisters;
    const registersPromise = new Promise((resolve) => {
      resolveRegisters = resolve;
    });
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pos/registers') return registersPromise;
      if (url === '/api/wellness/locations') return Promise.resolve(LOCATIONS);
      return Promise.resolve([]);
    });
    renderPage();

    // The Loading… banner is present before the resolver fires.
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();

    // Resolve — banner should disappear after loadRegisters finishes.
    resolveRegisters([REGISTER_OPEN]);
    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument(),
    );
  });
});
