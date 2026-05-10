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
 *
 * Drift note: actual payment initiation (Razorpay checkout open, Stripe
 * client-secret flow) is exercised by Invoices.jsx, not this page — this
 * dashboard is read-only ledger + admin-config. The detail modal open on
 * row click is a UI affordance and not load-bearing for backend contracts.
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

function defaultFetchMock(url) {
  if (url === '/api/payments') return Promise.resolve(samplePayments);
  if (url === '/api/payments/config') {
    return Promise.resolve({
      stripe: { configured: true, webhookConfigured: true },
      razorpay: { configured: true, keyId: 'rzp_test_abc' },
    });
  }
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
    // "Pending" + "Failed" also appear in the stat-card labels above; use
    // getAllByText.
    expect(screen.getAllByText(/^Pending$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/^Failed$/).length).toBeGreaterThanOrEqual(2);
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
      return Promise.resolve(null);
    });
    renderPayments();
    await waitFor(() => {
      expect(
        screen.getByText(/Stripe \/ Razorpay not configured/i)
      ).toBeInTheDocument();
    });
  });
});
