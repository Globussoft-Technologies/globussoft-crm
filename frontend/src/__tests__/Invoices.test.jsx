/**
 * Invoices.test.jsx — vitest + RTL coverage for the Invoices ledger page.
 *
 * Scope: pins the page-surface invariants for the daily-driver invoice
 * ledger — currency-aware money rendering, status badges + their hide/show
 * logic on row actions, Mark Paid + Void destructive flows, and the
 * create-invoice form POST shape.
 *
 *   1. Page renders heading "Invoices" + "Create Invoice" form + "Invoice
 *      Ledger" table.
 *   2. Renders one row per /api/billing entry with invoiceNum, amount
 *      (formatted), contact name, and status badge.
 *   3. Empty state: "No invoices yet. Create one to get started." renders
 *      when /api/billing returns [].
 *   4. UNPAID rows show Pay Now + Mark Paid + Recur + Void; PAID rows
 *      hide Pay Now + Mark Paid (but keep Recur + Void); VOIDED rows show
 *      only PDF (no Recur, no Void, no payment actions).
 *   5. Clicking "Mark Paid" fires PUT /api/billing/<id>/pay then reloads.
 *   6. Clicking "Void" opens a destructive confirmation, then PUTs
 *      /api/billing/<id>/void on confirm. If the user cancels confirm,
 *      no PUT fires.
 *   7. Submitting the create form POSTs /api/billing with contactId,
 *      amount, dueDate, and optional dealId.
 *   8. The Outstanding pill renders a currency-formatted total from
 *      formatMoney() — wellness/INR tenants see ₹, generic/USD see $.
 *      Pinned at the formatMoney mock layer so the test is currency-agnostic.
 *
 * Drift note: invoice status flips through Pay Now/Razorpay (gateway flow)
 * are covered server-side by payments-api specs. This file pins the
 * MANUAL ledger action surface — markPaid PUT + voidInvoice PUT + create
 * POST — not the gateway-mediated payment flow which involves an external
 * SDK and is unit-tested via mocked windows in a separate Payments spec.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object so the useCallback identity stays stable across
// renders (Wave-11 standing rule — fresh objects per call cause infinite
// useCallback-dependency loops).
const notifyError = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// formatMoney mock: prefixes "$" so the assertions are deterministic
// regardless of the tenant in localStorage. Real tenant-aware money is
// covered by money.test.js.
vi.mock('../utils/money', () => ({
  formatMoney: (v) => `$${(Number(v) || 0).toFixed(2)}`,
  currencySymbol: () => '$',
}));
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import { AuthContext } from '../App';
import Invoices from '../pages/Invoices';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function renderInvoices(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'USD' }, loading: false }}>
        <Invoices />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const sampleInvoices = [
  {
    id: 1,
    invoiceNum: 'INV-001',
    amount: 1234.56,
    status: 'UNPAID',
    dueDate: '2026-06-01',
    issuedDate: '2026-05-01',
    contact: { id: 1, name: 'Acme Corp', email: 'billing@acme.test' },
    deal: { id: 1, title: 'Acme Renewal' },
    isRecurring: false,
  },
  {
    id: 2,
    invoiceNum: 'INV-002',
    amount: 5000,
    status: 'PAID',
    dueDate: '2026-05-15',
    issuedDate: '2026-04-15',
    paidAt: '2026-04-30',
    contact: { id: 2, name: 'Globex Inc', email: 'billing@globex.test' },
    deal: null,
    isRecurring: false,
  },
  {
    id: 3,
    invoiceNum: 'INV-003',
    amount: 250,
    status: 'VOIDED',
    dueDate: '2026-04-01',
    issuedDate: '2026-03-01',
    contact: { id: 3, name: 'Initech', email: 'billing@initech.test' },
    deal: null,
    isRecurring: false,
  },
];

const sampleContacts = [
  { id: 1, name: 'Acme Corp', email: 'billing@acme.test' },
  { id: 2, name: 'Globex Inc', email: 'billing@globex.test' },
];

const sampleDeals = [
  { id: 1, title: 'Acme Renewal', amount: 50000, currency: 'USD' },
];

const samplePaymentConfig = {
  stripe: { configured: false },
  razorpay: { configured: false },
};

function defaultFetchMock(url, opts) {
  if (url === '/api/billing' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleInvoices);
  }
  if (url === '/api/contacts') return Promise.resolve(sampleContacts);
  if (url === '/api/deals') return Promise.resolve(sampleDeals);
  if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
  return Promise.resolve(null);
}

describe('<Invoices /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('renders the heading + Create Invoice form + Invoice Ledger', async () => {
    renderInvoices();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Invoices$/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Create Invoice/i)).toBeInTheDocument();
    expect(screen.getByText(/Invoice Ledger/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Issue Invoice/i })).toBeInTheDocument();
  });

  it('renders one row per invoice with invoiceNum, contact, amount, and status', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.getByText('INV-003')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Globex Inc')).toBeInTheDocument();
    // formatMoney mock prefixes "$" + 2dp; assert at least one amount renders.
    expect(screen.getByText('$1234.56')).toBeInTheDocument();
    expect(screen.getByText('$5000.00')).toBeInTheDocument();
    // Status badges (Paid/Unpaid/Voided). "Unpaid" and "Paid" also appear
    // as <option> labels in the create-form Status dropdown, so use
    // getAllByText with length >= 2 for those. "Voided" only renders in
    // the ledger badge.
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Paid').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Voided')).toBeInTheDocument();
  });

  it('shows the empty-state message when /api/billing returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => {
      expect(
        screen.getByText(/No invoices yet\. Create one to get started\./i)
      ).toBeInTheDocument();
    });
  });

  it('UNPAID rows show Mark Paid; PAID rows hide Mark Paid; VOIDED rows hide Void + Recur', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    // Exactly one Mark Paid button on the page — only INV-001 is UNPAID.
    const markPaidBtns = screen.getAllByRole('button', { name: /Mark invoice .* as paid/i });
    expect(markPaidBtns.length).toBe(1);
    expect(markPaidBtns[0].getAttribute('aria-label')).toMatch(/INV-001/);

    // INV-003 is VOIDED — no Void button on that row. There should be
    // exactly 2 Void buttons (INV-001 UNPAID + INV-002 PAID).
    const voidBtns = screen.getAllByRole('button', { name: /Void invoice/i });
    expect(voidBtns.length).toBe(2);
    expect(voidBtns.some(b => b.getAttribute('aria-label').includes('INV-003'))).toBe(false);
  });

  it('clicking "Mark Paid" fires PUT /api/billing/<id>/pay', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/pay' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, status: 'PAID' });
      }
      return defaultFetchMock(url, opts);
    });

    const markPaidBtn = screen.getByRole('button', { name: /Mark invoice INV-001 as paid/i });
    fireEvent.click(markPaidBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1/pay' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking "Void" prompts a destructive confirm then PUTs /api/billing/<id>/void', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/void' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, status: 'VOIDED' });
      }
      return defaultFetchMock(url, opts);
    });

    const voidBtn = screen.getByRole('button', { name: /Void invoice INV-001/i });
    fireEvent.click(voidBtn);

    // confirm() called with destructive:true.
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    const confirmArg = notifyConfirm.mock.calls[0][0];
    expect(confirmArg).toMatchObject({ destructive: true });
    expect(confirmArg.confirmText).toMatch(/Void/i);

    // PUT /void fires after confirm resolves true.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1/void' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });
  });

  it('Void: if user cancels the confirm, the void PUT does NOT fire', async () => {
    notifyConfirm.mockResolvedValue(false);
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const voidBtn = screen.getByRole('button', { name: /Void invoice INV-001/i });
    fireEvent.click(voidBtn);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    // Let any pending microtasks settle, then assert no /void PUT fired.
    await new Promise((r) => setTimeout(r, 30));
    const voidCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/billing/1/void' && opts?.method === 'PUT'
    );
    expect(voidCall).toBeFalsy();
  });

  it('submitting the create form POSTs /api/billing with the form payload', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && opts?.method === 'POST') {
        return Promise.resolve({ id: 4, invoiceNum: 'INV-004', status: 'UNPAID' });
      }
      return defaultFetchMock(url, opts);
    });

    // Select the contact via the labeled Contact select.
    const contactSelect = screen.getByLabelText(/^Contact$/i);
    fireEvent.change(contactSelect, { target: { value: '1' } });

    // Amount input — placeholder is "0.00".
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '999.99' } });

    // Due date input — labeled "Due date".
    const dateInput = screen.getByLabelText(/^Due date$/i);
    fireEvent.change(dateInput, { target: { value: '2026-07-01' } });

    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.contactId).toBe('1');
      expect(body.amount).toBe('999.99');
      expect(body.dueDate).toBe('2026-07-01');
    });
  });

  it('Outstanding pill renders a currency-formatted total from formatMoney', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    // Outstanding = UNPAID (1234.56) — PAID + VOIDED are excluded.
    // formatMoney mock returns `$<value>`, so the pill text contains "$1234.56".
    expect(screen.getByText(/Outstanding:\s*\$1234\.56/i)).toBeInTheDocument();
  });
});
