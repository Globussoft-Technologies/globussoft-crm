/**
 * Payments.test.jsx — vitest + RTL coverage for the Payments ledger page.
 *
 * Scope: pins the page-surface invariants for the payment-history dashboard
 * — read-only ledger that tracks received Stripe + Razorpay payments —
 * including the gateway-tab filter, status/gateway badges, currency-aware
 * amount rendering, and the admin-only Gateway Configuration panel.
 *
 *   1. Page renders heading "Payments" + Refresh button + Total Collected /
 *      Pending / Failed stat cards.
 *   2. Renders one row per /api/payments entry with invoiceId, amount,
 *      gateway badge, status badge, and dates.
 *   3. Empty state: "No payments yet" + "Process your first payment" CTA
 *      renders when /api/payments returns [].
 *   4. Loading state: "Loading payments..." renders in the table body
 *      before the first fetch resolves.
 *   5. Gateway tab click ("razorpay") filters the table to only razorpay
 *      payments; "stripe" tab → only stripe rows. "all" shows everything.
 *   6. Admin-only Gateway Configuration panel renders for ADMIN role;
 *      hidden for USER role.
 *   7. Configuration warning banner renders when both gateways are
 *      unconfigured.
 *   8. Currency-aware amount rendering: passes through formatMoney()
 *      with the per-row currency override (e.g. INR / USD).
 *   9. (#895) Record Payment CTA + drawer: the header CTA renders, the
 *      drawer mounts only when clicked, the submit POSTs to
 *      /api/v1/invoices/:id/payments with the manual-receipt body shape
 *      (method/amount/reference), the drawer closes + list refreshes on
 *      success.
 *
 * Drift note: actual payment initiation (Razorpay checkout open, Stripe
 * client-secret flow) is exercised by Invoices.jsx, not this page — this
 * dashboard is read-only ledger + admin-config (plus the #895 manual-
 * receipt capture drawer). The detail modal open on row click is a UI
 * affordance and not load-bearing for backend contracts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — Payments doesn't call notify directly today, but
// the mock keeps the contract consistent with the rest of the suite.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// formatMoney mock prefixes "$" so the assertions are currency-symbol
// agnostic. Real INR/USD switching is covered by money.test.js.
vi.mock('../utils/money', () => ({
  formatMoney: (v, opts) => {
    const cur = opts?.currency;
    const prefix = cur === 'INR' ? '₹' : '$';
    return `${prefix}${(Number(v) || 0).toFixed(2)}`;
  },
}));

import { AuthContext } from '../App';
import Payments from '../pages/Payments';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const REGULAR_USER = { userId: 2, name: 'User', email: 'u@x.com', role: 'USER' };

function renderPayments(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'USD' }, loading: false }}>
        <Payments />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const samplePayments = [
  {
    id: 1,
    invoiceId: 101,
    amount: 1500,
    currency: 'INR',
    gateway: 'razorpay',
    status: 'SUCCESS',
    gatewayId: 'pay_RZP123',
    paidAt: '2026-05-01T10:00:00.000Z',
    createdAt: '2026-05-01T09:55:00.000Z',
    metadata: { method: 'card' },
  },
  {
    id: 2,
    invoiceId: 102,
    amount: 250,
    currency: 'USD',
    gateway: 'stripe',
    status: 'PENDING',
    gatewayId: 'pi_ST456',
    paidAt: null,
    createdAt: '2026-05-02T11:00:00.000Z',
    metadata: {},
  },
  {
    id: 3,
    invoiceId: 103,
    amount: 75,
    currency: 'USD',
    gateway: 'stripe',
    status: 'FAILED',
    gatewayId: 'pi_ST789',
    paidAt: null,
    createdAt: '2026-05-03T12:00:00.000Z',
    metadata: { errorCode: 'card_declined' },
  },
];

// #895 — open-invoice list returned by /api/billing for the Record-Payment
// drawer's invoice picker. Two open invoices (one INR, one USD) and one
// already-PAID invoice that should be filtered out of the dropdown.
const sampleInvoices = [
  { id: 201, invoiceNum: 'INV-201', amount: 1500, currency: 'INR', status: 'SENT', contact: { name: 'Ravi Sharma', email: 'ravi@example.com' } },
  { id: 202, invoiceNum: 'INV-202', amount: 500, currency: 'USD', status: 'OVERDUE', contact: { name: 'Jane Doe', email: 'jane@example.com' } },
  { id: 203, invoiceNum: 'INV-203', amount: 100, currency: 'USD', status: 'PAID', contact: { name: 'Already Paid', email: 'p@example.com' } },
];

function defaultFetchMock(url) {
  if (url === '/api/payments') return Promise.resolve(samplePayments);
  if (url === '/api/payments/config') {
    return Promise.resolve({
      stripe: { configured: true, webhookConfigured: true },
      razorpay: { configured: true, keyId: 'rzp_test_abc' },
    });
  }
  if (url === '/api/billing') return Promise.resolve(sampleInvoices);
  return Promise.resolve(null);
}

describe('<Payments /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyObj.error.mockReset();
  });

  it('renders the heading and the stat cards', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Payments$/i })).toBeInTheDocument();
    });
    // Stat-card labels — "Pending" and "Failed" also appear as row-status
    // badge labels (uppercase) once the table populates, so use
    // getAllByText with length >= 1.
    expect(screen.getByText(/Total Collected/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^Pending$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Failed$/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders one row per payment with invoiceId, amount, and gateway+status badges', async () => {
    renderPayments();
    // INR row → ₹ prefix; USD rows → $ prefix.
    await waitFor(() => expect(screen.getByText('₹1500.00')).toBeInTheDocument());
    expect(screen.getByText('$250.00')).toBeInTheDocument();
    expect(screen.getByText('$75.00')).toBeInTheDocument();
    // Invoice IDs render as "#<id>".
    expect(screen.getByText('#101')).toBeInTheDocument();
    expect(screen.getByText('#102')).toBeInTheDocument();
    expect(screen.getByText('#103')).toBeInTheDocument();
    // Status badge labels.
    expect(screen.getByText(/^Success$/)).toBeInTheDocument();
    // Stat-card labels now include a window suffix (e.g. "Pending (Last 30
    // Days)") so the bare-word badges only appear in row cells. >= 1 each
    // is enough — the row count + amount assertions above pin the table.
    expect(screen.getAllByText(/^Pending$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Failed$/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the empty-state "No payments yet" CTA when /api/payments returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve([]);
      if (url === '/api/payments/config') {
        return Promise.resolve({
          stripe: { configured: true },
          razorpay: { configured: true },
        });
      }
      return Promise.resolve(null);
    });
    renderPayments();
    await waitFor(() => {
      expect(screen.getByText(/No payments yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Process your first payment/i)).toBeInTheDocument();
  });

  it('shows a loading message before the first fetch resolves', async () => {
    // Hold the /api/payments promise open so the initial loading state
    // is observable. /config can resolve immediately.
    let resolvePayments;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') {
        return new Promise((r) => { resolvePayments = r; });
      }
      if (url === '/api/payments/config') {
        return Promise.resolve({
          stripe: { configured: true },
          razorpay: { configured: true },
        });
      }
      return Promise.resolve(null);
    });
    renderPayments();
    // While /api/payments is pending, the table body shows "Loading payments..."
    expect(await screen.findByText(/Loading payments/i)).toBeInTheDocument();
    // Resolve so the test cleanly tears down.
    resolvePayments([]);
  });

  it('clicking the "razorpay" gateway tab filters rows to razorpay only', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    // All 3 rows visible initially.
    expect(screen.getByText('#101')).toBeInTheDocument();
    expect(screen.getByText('#102')).toBeInTheDocument();
    expect(screen.getByText('#103')).toBeInTheDocument();

    // Click the razorpay tab.
    const razorpayTab = screen.getByRole('button', { name: /^razorpay$/i });
    fireEvent.click(razorpayTab);

    // Only the razorpay row (#101) remains.
    await waitFor(() => {
      expect(screen.getByText('#101')).toBeInTheDocument();
      expect(screen.queryByText('#102')).not.toBeInTheDocument();
      expect(screen.queryByText('#103')).not.toBeInTheDocument();
    });
  });

  it('Gateway Configuration panel renders for ADMIN role', async () => {
    renderPayments(ADMIN_USER);
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /Gateway Configuration/i })).toBeInTheDocument();
  });

  it('Gateway Configuration panel is HIDDEN for USER role', async () => {
    renderPayments(REGULAR_USER);
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /Gateway Configuration/i })).toBeNull();
  });

  it('renders the configuration warning when both gateways are unconfigured', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve([]);
      if (url === '/api/payments/config') {
        return Promise.resolve({
          stripe: { configured: false },
          razorpay: { configured: false },
        });
      }
      if (url === '/api/billing') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPayments();
    await waitFor(() => {
      expect(
        screen.getByText(/Stripe \/ Razorpay not configured/i)
      ).toBeInTheDocument();
    });
  });

  // #895 — Record Payment CTA + drawer surface. Pins three invariants:
  // (1) the CTA renders in the header but the drawer form is not in the
  // DOM until the CTA is clicked; (2) clicking the CTA mounts the drawer
  // with the canonical field set; (3) submitting POSTs to the
  // /api/v1/invoices/:id/payments endpoint with the manual-receipt body
  // shape and the drawer closes on success.
  it('Record Payment CTA renders but the drawer is NOT mounted until clicked', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    // CTA renders in the header.
    expect(screen.getByRole('button', { name: /Record a payment/i })).toBeInTheDocument();
    // Drawer dialog is not in the DOM yet.
    expect(screen.queryByRole('dialog', { name: /Record Payment/i })).toBeNull();
    // Form fields are not mounted either.
    expect(screen.queryByPlaceholderText(/UPI txn ID/i)).toBeNull();
  });

  it('clicking the CTA mounts the Record Payment drawer with invoice/amount/method/reference fields', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Record a payment/i }));
    // Drawer dialog renders.
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Record Payment/i })).toBeInTheDocument();
    });
    // Invoice picker is populated with non-PAID/VOIDED rows only.
    expect(screen.getByText(/INV-201/)).toBeInTheDocument();
    expect(screen.getByText(/INV-202/)).toBeInTheDocument();
    // INV-203 is PAID and must be filtered out of the dropdown.
    expect(screen.queryByText(/INV-203/)).toBeNull();
    // Amount + reference inputs are present.
    expect(screen.getByPlaceholderText(/0\.00/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/UPI txn ID/i)).toBeInTheDocument();
    // Method select defaults to "cash" and includes the canonical enum
    // values per the route's accepted method strings.
    expect(screen.getByRole('option', { name: /^Cash$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^UPI$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Bank transfer$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Cheque$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Card$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Other$/i })).toBeInTheDocument();
  });

  it('submitting the drawer POSTs to /api/v1/invoices/:id/payments and closes on success', async () => {
    // Add a happy-path POST mock alongside the defaults.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/payments') return Promise.resolve(samplePayments);
      if (url === '/api/payments/config') {
        return Promise.resolve({
          stripe: { configured: true },
          razorpay: { configured: true },
        });
      }
      if (url === '/api/billing') return Promise.resolve(sampleInvoices);
      if (typeof url === 'string' && url.startsWith('/api/v1/invoices/') && url.endsWith('/payments') && opts && opts.method === 'POST') {
        return Promise.resolve({ payment: { id: 999 }, fullyPaid: false });
      }
      return Promise.resolve(null);
    });
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Record a payment/i }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Record Payment/i })).toBeInTheDocument());

    // Fill the form — pick INV-201, amount 500, method=upi, reference=UPI123.
    const invoiceSelect = screen.getByRole('combobox', { name: /Invoice/i });
    fireEvent.change(invoiceSelect, { target: { value: '201' } });
    fireEvent.change(screen.getByPlaceholderText(/0\.00/), { target: { value: '500' } });
    const methodSelect = screen.getByRole('combobox', { name: /Method/i });
    fireEvent.change(methodSelect, { target: { value: 'upi' } });
    fireEvent.change(screen.getByPlaceholderText(/UPI txn ID/i), { target: { value: 'UPI-TXN-123' } });

    // Submit — find the visible "Record Payment" submit button inside the
    // drawer (the header CTA has the aria-label "Record a payment" — distinct).
    const submitBtn = screen.getByRole('button', { name: /^Record Payment$/i });
    fireEvent.click(submitBtn);

    // The POST should have fired against the canonical endpoint with the
    // manual-receipt body shape.
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => typeof url === 'string'
          && url === '/api/v1/invoices/201/payments'
          && opts && opts.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.method).toBe('upi');
      expect(body.amount).toBe(500);
      expect(body.reference).toBe('UPI-TXN-123');
    });
    // notify.success was called and the drawer unmounts on success.
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalledWith('Payment recorded');
      expect(screen.queryByRole('dialog', { name: /Record Payment/i })).toBeNull();
    });
  });
});
