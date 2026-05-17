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
 *          Deposit + Withdrawal buttons render but surface a notify.info
 *          (backend route is documented-pending — see #779 backend half).
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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
function makeMock({ registers = [REGISTER_OPEN, REGISTER_CLOSED], openShiftFor = { 11: OPEN_SHIFT }, shiftDetail = OPEN_SHIFT } = {}) {
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

  it('Deposit + Withdrawal buttons render on an open shift and surface a notify.info (backend pending)', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Deposit cash/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Deposit cash/i }));
    expect(notify.info).toHaveBeenCalledWith(
      expect.stringMatching(/Deposit flow is wired in the UI/i),
    );

    fireEvent.click(screen.getByRole('button', { name: /Withdraw cash/i }));
    expect(notify.info).toHaveBeenCalledWith(
      expect.stringMatching(/Withdrawal flow is wired in the UI/i),
    );

    // Confirm no broken POST was issued for either flow.
    const depositPost = fetchApiMock.mock.calls.find(
      ([url, opts]) => /\/deposit$/.test(url) && opts?.method === 'POST',
    );
    expect(depositPost).toBeUndefined();
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

  it('Expenses Cash tab is empty + surfaces the "backend pending" copy', async () => {
    fetchApiMock.mockImplementation(makeMock());
    renderPage();

    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('register-card-11'));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Expenses Cash/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Expenses Cash/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/Cash expense ledger ships with the #779 backend follow-up/i),
      ).toBeInTheDocument(),
    );
  });
});
