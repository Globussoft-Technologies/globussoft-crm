/**
 * Invoices.test.jsx — vitest + RTL coverage for the Invoices ledger page.
 *
 * Scope: pins the page-surface invariants for the daily-driver invoice
 * ledger — currency-aware money rendering, status badges + their hide/show
 * logic on row actions, Mark Paid + Void destructive flows, and the
 * inline create-invoice form POST shape.
 *
 * Drift note (vs. earlier #894 draft): the SUT does NOT use a drawer for
 * the Create Invoice form — the form is always-visible in the left column
 * of a 2-column grid. Tests pin the actual inline-form behavior.
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
const notifyInfo = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
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
    notifyInfo.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('renders the heading + Create Invoice card + Invoice Ledger', async () => {
    renderInvoices();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Invoices$/i })).toBeInTheDocument();
    });
    // Create Invoice card title (h3, with the Plus icon).
    expect(screen.getByRole('heading', { name: /Create Invoice/i })).toBeInTheDocument();
    expect(screen.getByText(/Invoice Ledger/i)).toBeInTheDocument();
    // "Issue Invoice" submit button renders inline (no drawer).
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
    // Status badges (Paid/Unpaid/Voided). Multiple elements may match — Unpaid
    // and Paid also appear as <option>s in the create-form Status dropdown,
    // and Voided in the ledger's status-filter dropdown.
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Paid').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Voided').length).toBeGreaterThanOrEqual(1);
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

    // Select the contact via the labeled Contact select (aria-label="Contact").
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

  it('Invoice # field is read-only and seeded from nextInvoiceNum', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    // Seed has INV-001, INV-002, INV-003 → next should be INV-004.
    const invInput = screen.getByLabelText(/Invoice number/i);
    expect(invInput.value).toMatch(/INV-004/);
    // Field is marked readOnly so the user can't pre-set it.
    expect(invInput).toHaveAttribute('readOnly');
  });

  it('renders the optional Deal dropdown with seeded deals', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    const dealSelect = screen.getByLabelText(/Associated deal/i);
    expect(dealSelect).toBeInTheDocument();
    // Includes the placeholder "-- No Deal --" + the one seeded deal.
    expect(dealSelect.querySelectorAll('option').length).toBeGreaterThanOrEqual(2);
    expect(dealSelect.textContent).toMatch(/Acme Renewal/);
  });

  it('create-form POST includes dealId when a deal is selected', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.change(screen.getByLabelText(/^Contact$/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/Associated deal/i), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250.00' } });
    fireEvent.change(screen.getByLabelText(/^Due date$/i), { target: { value: '2026-08-15' } });

    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.dealId).toBe('1');
    });
  });

  it('create-form: failed POST surfaces a notify.error', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && opts?.method === 'POST') {
        return Promise.reject(new Error('boom'));
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.change(screen.getByLabelText(/^Contact$/i), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '10.00' } });
    fireEvent.change(screen.getByLabelText(/^Due date$/i), { target: { value: '2026-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to create invoice/i);
  });

  it('Mark Paid failure surfaces a notify.error', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/pay' && opts?.method === 'PUT') {
        return Promise.reject(new Error('server-blew-up'));
      }
      return defaultFetchMock(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /Mark invoice INV-001 as paid/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to mark invoice as paid/i);
  });

  it('every row renders a PDF download button with the invoice number in its aria-label', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    // 3 rows -> 3 PDF buttons (PDF action available on every row including
    // VOIDED, since the audit trail PDF is preserved).
    const pdfBtns = screen.getAllByRole('button', { name: /Download PDF for invoice/i });
    expect(pdfBtns.length).toBe(3);
    expect(pdfBtns[0].getAttribute('aria-label')).toMatch(/INV-001/);
    expect(pdfBtns[2].getAttribute('aria-label')).toMatch(/INV-003/);
  });

  it('status filter narrows the ledger to a single status', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    // All three rows visible initially.
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.getByText('INV-003')).toBeInTheDocument();

    // Filter -> PAID: only INV-002 remains.
    const filter = screen.getByLabelText(/Filter invoices by status/i);
    fireEvent.change(filter, { target: { value: 'PAID' } });
    expect(screen.queryByText('INV-001')).toBeNull();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.queryByText('INV-003')).toBeNull();

    // Filter -> ALL: all three rows back.
    fireEvent.change(filter, { target: { value: 'ALL' } });
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.getByText('INV-003')).toBeInTheDocument();
  });

  it('filter "no matches" state renders the dashed-card message', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve([sampleInvoices[0]]);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    const filter = screen.getByLabelText(/Filter invoices by status/i);
    fireEvent.change(filter, { target: { value: 'PAID' } });

    expect(screen.queryByText('INV-001')).toBeNull();
    expect(screen.getByText(/No invoices match the/i)).toBeInTheDocument();
  });

  it('renders the KPI pills: Outstanding, Paid This Month, and total count', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.getByText(/Outstanding:\s*\$1234\.56/i)).toBeInTheDocument();
    expect(screen.getByText(/Paid This Month:/i)).toBeInTheDocument();
    expect(screen.getByText(/3 total invoices/i)).toBeInTheDocument();
  });

  it('OVERDUE invoices surface an overdue-count pill', async () => {
    const withOverdue = [
      { ...sampleInvoices[0], id: 10, invoiceNum: 'INV-010', status: 'OVERDUE' },
      { ...sampleInvoices[0], id: 11, invoiceNum: 'INV-011', status: 'OVERDUE' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(withOverdue);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-010')).toBeInTheDocument());
    expect(screen.getByText(/2 Overdue/i)).toBeInTheDocument();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThanOrEqual(2);
  });

  it('clicking "Pay Now" opens the payment modal scoped to that invoice', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    const payNow = screen.getByRole('button', { name: /Pay invoice INV-001/i });
    fireEvent.click(payNow);

    expect(screen.getByText(/Pay Invoice/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close payment dialog/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Close payment dialog/i }));
    expect(screen.queryByRole('button', { name: /Close payment dialog/i })).toBeNull();
  });

  it('payment modal disables both gateway buttons when neither is configured', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Pay invoice INV-001/i }));

    // Gateway buttons match by text content ("💳 Stripe (Coming)" / "💰 Razorpay (Setup)").
    const buttons = screen.getAllByRole('button');
    const stripeBtn = buttons.find(b => /Stripe/.test(b.textContent || ''));
    const razorpayBtn = buttons.find(b => /Razorpay/.test(b.textContent || ''));
    expect(stripeBtn).toBeTruthy();
    expect(razorpayBtn).toBeTruthy();
    expect(stripeBtn).toBeDisabled();
    expect(razorpayBtn).toBeDisabled();
  });

  it('clicking "Recur" opens the recur modal with frequency options', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    // The Recur button on the UNPAID row — labeled "Recur" since
    // isRecurring is false. Match by trimmed-text equality.
    const recurBtns = screen
      .getAllByRole('button')
      .filter(b => (b.textContent || '').trim() === 'Recur');
    expect(recurBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(recurBtns[0]);

    expect(screen.getByText(/Set up recurring billing/i)).toBeInTheDocument();
    // The activate button reads "Activate monthly" by default.
    expect(screen.getByRole('button', { name: /Activate monthly/i })).toBeInTheDocument();
  });

  it('activating recurring PUTs /api/billing/<id>/recurring with isRecurring=true', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/recurring' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, isRecurring: true });
      }
      return defaultFetchMock(url, opts);
    });

    const recurBtns = screen
      .getAllByRole('button')
      .filter(b => (b.textContent || '').trim() === 'Recur');
    fireEvent.click(recurBtns[0]);

    fireEvent.click(screen.getByRole('button', { name: /Activate monthly/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1/recurring' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.isRecurring).toBe(true);
      expect(body.recurFrequency).toBe('monthly');
    });
  });

  it('a recurring invoice shows its frequency label on the Recur button, not "Recur"', async () => {
    const withRecurring = [
      { ...sampleInvoices[0], id: 50, invoiceNum: 'INV-050', isRecurring: true, recurFrequency: 'quarterly' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(withRecurring);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-050')).toBeInTheDocument());

    const bareRecur = screen.getAllByRole('button').filter(b => (b.textContent || '').trim() === 'Recur');
    expect(bareRecur.length).toBe(0);

    const freqBtns = screen.getAllByRole('button').filter(b => (b.textContent || '').trim() === 'quarterly');
    expect(freqBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('opening Recur on an already-recurring invoice offers "Stop recurring" (not Activate)', async () => {
    const withRecurring = [
      { ...sampleInvoices[0], id: 51, invoiceNum: 'INV-051', isRecurring: true, recurFrequency: 'monthly' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(withRecurring);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-051')).toBeInTheDocument());

    const freqBtn = screen.getAllByRole('button').filter(b => (b.textContent || '').trim() === 'monthly')[0];
    fireEvent.click(freqBtn);

    expect(screen.getByText(/Stop recurring billing/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop recurring/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activate monthly/i })).toBeNull();
  });

  it('row with null contact falls back to "Unknown" in the Contact column', async () => {
    const noContact = [
      { ...sampleInvoices[0], id: 70, invoiceNum: 'INV-070', contact: null },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(noContact);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-070')).toBeInTheDocument());
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('nextInvoiceNum defaults to INV-001 when the invoice list is empty', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText(/No invoices yet/i)).toBeInTheDocument());
    const invInput = screen.getByLabelText(/Invoice number/i);
    expect(invInput.value).toBe('INV-001');
  });

  it('OVERDUE rows still expose Mark Paid + Pay Now + Void (status branches as not-paid not-voided)', async () => {
    const overdue = [
      { ...sampleInvoices[0], id: 80, invoiceNum: 'INV-080', status: 'OVERDUE' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(overdue);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-080')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /Pay invoice INV-080/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark invoice INV-080 as paid/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Void invoice INV-080/i })).toBeInTheDocument();
  });

  it('Pay Now is hidden on PAID rows AND on VOIDED rows', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Pay invoice INV-002/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pay invoice INV-003/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Pay invoice INV-001/i })).toBeInTheDocument();
  });

  it('clicking PDF on a row fires fetch against /api/billing/<id>/pdf with Bearer token', async () => {
    const blobSpy = vi.fn(() => Promise.resolve(new Blob(['%PDF-stub'], { type: 'application/pdf' })));
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, blob: blobSpy }));
    const origFetch = global.fetch;
    global.fetch = fetchSpy;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:stub');
    URL.revokeObjectURL = vi.fn();

    try {
      renderInvoices();
      await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

      const pdfBtns = screen.getAllByRole('button', { name: /Download PDF for invoice INV-001/i });
      fireEvent.click(pdfBtns[0]);

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toMatch(/\/api\/billing\/1\/pdf$/);
      expect(opts.headers.Authorization).toMatch(/^Bearer test-token$/);
    } finally {
      global.fetch = origFetch;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('PDF fetch failure surfaces a notify.error', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: false, blob: () => Promise.resolve(new Blob()) }));
    const origFetch = global.fetch;
    global.fetch = fetchSpy;

    try {
      renderInvoices();
      await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

      const pdfBtns = screen.getAllByRole('button', { name: /Download PDF for invoice INV-001/i });
      fireEvent.click(pdfBtns[0]);

      await waitFor(() => expect(notifyError).toHaveBeenCalled());
      expect(notifyError.mock.calls.some(c => /Failed to download PDF/i.test(String(c[0])))).toBe(true);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('Recur modal Cancel closes the modal without firing a PUT', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    const recurBtns = screen.getAllByRole('button').filter(b => (b.textContent || '').trim() === 'Recur');
    fireEvent.click(recurBtns[0]);
    expect(screen.getByText(/Set up recurring billing/i)).toBeInTheDocument();

    fetchApiMock.mockClear();
    const cancels = screen.getAllByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancels[cancels.length - 1]);

    expect(screen.queryByText(/Set up recurring billing/i)).toBeNull();
    const recurCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => /\/recurring$/.test(url) && opts?.method === 'PUT'
    );
    expect(recurCall).toBeFalsy();
  });

  it('payment modal: Stripe button is enabled when stripe.configured=true', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(sampleInvoices);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') {
        return Promise.resolve({
          stripe: { configured: true, keyId: 'pk_test_stripe' },
          razorpay: { configured: false },
        });
      }
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Pay invoice INV-001/i }));

    const buttons = screen.getAllByRole('button');
    const stripeBtn = buttons.find(b => /Stripe/.test(b.textContent || ''));
    const razorpayBtn = buttons.find(b => /Razorpay/.test(b.textContent || ''));
    expect(stripeBtn).not.toBeDisabled();
    expect(razorpayBtn).toBeDisabled();
  });

  it('payment modal closes when the dark overlay is clicked (outside the dialog body)', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Pay invoice INV-001/i }));
    expect(screen.getByRole('button', { name: /Close payment dialog/i })).toBeInTheDocument();

    // Walk up to the overlay (first ancestor with position:fixed).
    const heading = screen.getByText(/Pay Invoice/i);
    let node = heading;
    while (node && node.style?.position !== 'fixed') node = node.parentElement;
    expect(node).toBeTruthy();
    fireEvent.click(node);

    expect(screen.queryByRole('button', { name: /Close payment dialog/i })).toBeNull();
  });
});
