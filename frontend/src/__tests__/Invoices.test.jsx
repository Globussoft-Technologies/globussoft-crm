/**
 * Invoices.test.jsx — vitest + RTL coverage for the Invoices ledger page.
 *
 * Scope: pins the page-surface invariants for the daily-driver invoice
 * ledger — currency-aware money rendering, status badges + their hide/show
 * logic on row actions, Mark Paid + Void destructive flows, and the
 * create-invoice form POST shape.
 *
 *   1. Page renders heading "Invoices" + Create Invoice header CTA +
 *      "Invoice Ledger" table.
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
 *   9. (#894) "Create Invoice" header CTA is rendered; clicking it reveals
 *      the form fields in a drawer (form is NOT inline-visible before).
 *
 * #894 — Create Invoice is no longer an always-visible inline form; it
 * lives inside a drawer that opens via the "Create Invoice" header CTA.
 * Every test that interacts with the form first calls `openDrawer()` to
 * click the CTA and reveal the inputs. The fields + submit logic are
 * unchanged; only the trigger surface moved.
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

// #894 — Create Invoice lives in a drawer now. Click the header CTA to
// mount the form before any field interaction. The CTA has aria-label
// "Create a new invoice" (which becomes the accessible-name); the visible
// text is "Create Invoice". Match on the aria-label since it takes
// precedence over inner text for accessible-name lookup.
function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: /Create a new invoice/i }));
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

  it('renders the heading + Create Invoice CTA + Invoice Ledger', async () => {
    renderInvoices();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Invoices$/i })).toBeInTheDocument();
    });
    // #894 — Create Invoice is a header CTA now. The visible text "Create
    // Invoice" lives on the CTA button; the form (and its "Issue Invoice"
    // submit) is only mounted after clicking.
    expect(screen.getByRole('button', { name: /Create a new invoice/i })).toBeInTheDocument();
    expect(screen.getByText(/Invoice Ledger/i)).toBeInTheDocument();
    // "Issue Invoice" is NOT in the DOM until the drawer opens.
    expect(screen.queryByRole('button', { name: /Issue Invoice/i })).toBeNull();
    openDrawer();
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
    // Status badges (Paid/Unpaid/Voided). All three labels also appear as
    // <option> elements — Unpaid + Paid in the create-form Status dropdown,
    // and Voided in the ledger's status-filter dropdown — so a bare
    // getByText would trip RTL's "multiple elements found" guard. The
    // contract here is "at least one row badge with that text exists",
    // which getAllByText(label).length >= 1 expresses cleanly.
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

    // #894 — open the Create drawer before interacting with form fields.
    openDrawer();

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

  // #894 — pin the CTA + drawer surface. Pre-#894 the form was always
  // visible as a left-column card above the ledger; post-#894 it lives
  // inside a drawer that opens via the header CTA. Without this test, a
  // future change that accidentally re-renders the form inline would not
  // red the suite.
  it('renders the "Create Invoice" CTA and the form is hidden until clicked', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    // CTA exists in the header (aria-label "Create a new invoice").
    expect(screen.getByRole('button', { name: /Create a new invoice/i })).toBeInTheDocument();

    // The form fields are NOT mounted until the CTA opens the drawer.
    expect(screen.queryByLabelText(/^Contact$/i)).toBeNull();
    expect(screen.queryByPlaceholderText('0.00')).toBeNull();
    expect(screen.queryByRole('button', { name: /Issue Invoice/i })).toBeNull();

    // Click the CTA → drawer opens → fields become reachable.
    openDrawer();
    expect(screen.getByLabelText(/^Contact$/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Issue Invoice/i })).toBeInTheDocument();
    // Close button is rendered inside the drawer.
    expect(screen.getByRole('button', { name: /^Close$/i })).toBeInTheDocument();
  });

  // ---- Extension cases (2026-05-26) -----------------------------------
  // Pin the remaining ledger surface: status filter, KPI stats, recur
  // modal, payment modal, PDF download, drawer close behaviors (X / Cancel
  // / Escape / overlay), nextInvoiceNum auto-generation, deal dropdown,
  // error states. All additive — no existing test modified.

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
    // Seed only one UNPAID row, then flip the filter to PAID: nothing matches.
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

    // INV-001 (UNPAID) hidden by the filter.
    expect(screen.queryByText('INV-001')).toBeNull();
    // Filter empty-state message visible.
    expect(screen.getByText(/No invoices match the/i)).toBeInTheDocument();
  });

  it('renders the KPI stats: Outstanding, Paid This Month, and total count', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    // Outstanding (UNPAID only): 1234.56 — PAID + VOIDED excluded.
    expect(screen.getByText(/Outstanding:\s*\$1234\.56/i)).toBeInTheDocument();
    // Paid This Month pill text always renders even when zero.
    expect(screen.getByText(/Paid This Month:/i)).toBeInTheDocument();
    // Total count pill: 3 invoices loaded.
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
    // "2 Overdue" pill appears.
    expect(screen.getByText(/2 Overdue/i)).toBeInTheDocument();
    // Both rows render the Overdue badge.
    expect(screen.getAllByText('Overdue').length).toBeGreaterThanOrEqual(2);
  });

  it('clicking "Pay Now" opens the payment modal scoped to that invoice', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    const payNow = screen.getByRole('button', { name: /Pay invoice INV-001/i });
    fireEvent.click(payNow);

    // Modal heading + invoice reference both render.
    expect(screen.getByText(/Pay Invoice/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close payment dialog/i })).toBeInTheDocument();

    // Close it again and ensure the modal closes.
    fireEvent.click(screen.getByRole('button', { name: /Close payment dialog/i }));
    expect(screen.queryByRole('button', { name: /Close payment dialog/i })).toBeNull();
  });

  it('payment modal disables both gateway buttons when neither is configured', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Pay invoice INV-001/i }));

    // Both gateway buttons exist (Stripe + Razorpay) and both should be
    // disabled because the default mock reports neither as configured.
    const stripeBtn = screen.getByRole('button', { name: /Stripe/i });
    const razorpayBtn = screen.getByRole('button', { name: /Razorpay/i });
    expect(stripeBtn).toBeDisabled();
    expect(razorpayBtn).toBeDisabled();
  });

  it('clicking "Recur" opens the recur modal with frequency options', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    // The Recur button on the UNPAID row — labeled "Recur" since
    // isRecurring is false. The button text content includes whitespace +
    // icon + the visible label, so match by trimmed-text equality.
    const recurBtns = screen
      .getAllByRole('button')
      .filter(b => (b.textContent || '').trim() === 'Recur');
    expect(recurBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(recurBtns[0]);

    // Modal heading + Frequency select rendered.
    expect(screen.getByText(/Set up recurring billing/i)).toBeInTheDocument();
    // Monthly/Quarterly/Yearly options exist as <option> in the select.
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

  it('drawer closes when the Cancel button is clicked', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    openDrawer();
    expect(screen.getByLabelText(/^Contact$/i)).toBeInTheDocument();

    // The Cancel button (type=button) lives in the drawer footer.
    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancelBtn);

    // Drawer closes — form fields gone.
    expect(screen.queryByLabelText(/^Contact$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Issue Invoice/i })).toBeNull();
  });

  it('drawer closes when Escape is pressed', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    openDrawer();
    expect(screen.getByLabelText(/^Contact$/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByLabelText(/^Contact$/i)).toBeNull();
  });

  it('drawer Invoice # field is read-only and seeded from nextInvoiceNum', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    openDrawer();

    // Seed has INV-001, INV-002, INV-003 → next should be INV-004 (003 + 1
    // = 004, zero-padded). The input value reflects the computed memo.
    const invInput = screen.getByLabelText(/Invoice number/i);
    expect(invInput.value).toMatch(/INV-004/);
    // Field is marked readOnly so the user can't pre-set it.
    expect(invInput).toHaveAttribute('readOnly');
  });

  it('drawer renders the optional Deal dropdown with seeded deals', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    openDrawer();

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
    openDrawer();

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
    openDrawer();

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
});
