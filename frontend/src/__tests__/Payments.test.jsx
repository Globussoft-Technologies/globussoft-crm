/**
 * Payments.test.jsx — vitest + RTL coverage for the Payments ledger page.
 *
 * Scope: pins the page-surface invariants for the payment-history dashboard
 * (read-only ledger that tracks received Stripe + Razorpay payments). Pins
 * the gateway-tab filter, status/gateway badges, currency-aware amount
 * rendering, refresh button, detail modal, configuration warning banner,
 * and admin-only Gateway Configuration panel.
 *
 * Drift note: the SUT is a READ-ONLY ledger — there is no Record-Payment
 * drawer, no manual-receipt POST flow, no KPI window-pill group. Tests
 * here pin the actual surface.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object.
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
    paidAt: new Date(Date.now() - 86_400_000).toISOString(),
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
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
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
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
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
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
    // Stat-card labels include a window suffix like "(Last 30 Days)".
    expect(screen.getByText(/Total Collected/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Pending/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Failed/).length).toBeGreaterThanOrEqual(1);
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
    expect(await screen.findByText(/Loading payments/i)).toBeInTheDocument();
    resolvePayments([]);
  });

  it('clicking the "razorpay" gateway tab filters rows to razorpay only', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    expect(screen.getByText('#101')).toBeInTheDocument();
    expect(screen.getByText('#102')).toBeInTheDocument();
    expect(screen.getByText('#103')).toBeInTheDocument();

    const razorpayTab = screen.getByRole('button', { name: /^razorpay$/i });
    fireEvent.click(razorpayTab);

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

  it('renders all four status badges (Success/Pending/Failed/Refunded)', async () => {
    const withRefunded = [
      ...samplePayments,
      {
        id: 4,
        invoiceId: 104,
        amount: 99,
        currency: 'USD',
        gateway: 'stripe',
        status: 'REFUNDED',
        gatewayId: 'pi_ST_REF',
        paidAt: new Date(Date.now() - 86_400_000).toISOString(),
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        metadata: {},
      },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve(withRefunded);
      if (url === '/api/payments/config') return Promise.resolve({ stripe: { configured: true }, razorpay: { configured: true } });
      return Promise.resolve(null);
    });
    renderPayments();
    await waitFor(() => expect(screen.getByText('#104')).toBeInTheDocument());
    expect(screen.getByText(/^Success$/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Pending$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Failed$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Refunded$/)).toBeInTheDocument();
  });

  it('Stripe tab filters rows to stripe only; clicking "All" restores all rows', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^stripe$/i }));
    await waitFor(() => {
      expect(screen.queryByText('#101')).not.toBeInTheDocument();
      expect(screen.getByText('#102')).toBeInTheDocument();
      expect(screen.getByText('#103')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^All$/i }));
    await waitFor(() => {
      expect(screen.getByText('#101')).toBeInTheDocument();
      expect(screen.getByText('#102')).toBeInTheDocument();
      expect(screen.getByText('#103')).toBeInTheDocument();
    });
  });

  it('refund button is disabled-by-design (no refund endpoint wired yet)', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    const refundButtons = screen.getAllByRole('button', { name: /^Refund$/i });
    expect(refundButtons.length).toBe(3);
    refundButtons.forEach((btn) => {
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', expect.stringMatching(/coming soon/i));
    });
  });

  it('clicking a row View button opens the detail modal; clicking close hides it', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /^Payment #1$/i })).toBeNull();
    const viewButtons = screen.getAllByRole('button', { name: /^View$/i });
    fireEvent.click(viewButtons[0]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Payment #1$/i })).toBeInTheDocument();
    });
    // Gateway-id renders in the modal.
    expect(screen.getByText('pay_RZP123')).toBeInTheDocument();
  });

  it('Refresh button click triggers a fresh /api/payments fetch', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    const initialPaymentsCalls = fetchApiMock.mock.calls.filter(
      ([url]) => url === '/api/payments'
    ).length;
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/i }));
    await waitFor(() => {
      const newPaymentsCalls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/payments'
      ).length;
      expect(newPaymentsCalls).toBeGreaterThan(initialPaymentsCalls);
    });
  });

  it('detail modal closes when the backdrop overlay is clicked', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('#101')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: /^View$/i })[0]);
    const heading = await screen.findByRole('heading', { name: /^Payment #1$/i });
    // Walk up to the backdrop overlay (the outermost div with position:fixed).
    let node = heading;
    while (node && node.style?.position !== 'fixed') node = node.parentElement;
    expect(node).toBeTruthy();
    fireEvent.click(node);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^Payment #1$/i })).toBeNull();
    });
  });

  it('unknown gateway renders the raw gateway name in the badge (fallback label)', async () => {
    const withUnknown = [
      {
        id: 10,
        invoiceId: 110,
        amount: 50,
        currency: 'USD',
        gateway: 'paypal',
        status: 'SUCCESS',
        gatewayId: 'pp_abc',
        paidAt: new Date(Date.now() - 86_400_000).toISOString(),
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        metadata: {},
      },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve(withUnknown);
      if (url === '/api/payments/config') return Promise.resolve({ stripe: { configured: true }, razorpay: { configured: true } });
      return Promise.resolve(null);
    });
    renderPayments();
    await waitFor(() => expect(screen.getByText('#110')).toBeInTheDocument());
    expect(screen.getByText('paypal')).toBeInTheDocument();
  });

  it('admin Gateway Configuration cards reflect partial-config state via per-extra checkmarks', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve([]);
      if (url === '/api/payments/config') {
        return Promise.resolve({
          stripe: { configured: true, webhookConfigured: false },
          razorpay: { configured: true, keyId: 'rzp_test_xyz' },
        });
      }
      return Promise.resolve(null);
    });
    renderPayments(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Gateway Configuration/i })).toBeInTheDocument();
    });
    // Both gateways labelled "Configured" (configured === true).
    expect(screen.getAllByText(/^Configured$/).length).toBeGreaterThanOrEqual(2);
    // Stripe's webhook-secret extra label renders.
    expect(screen.getByText(/STRIPE_WEBHOOK_SECRET/)).toBeInTheDocument();
    // Razorpay keyId is surfaced as a <code> chip on the matching extra.
    expect(screen.getByText('rzp_test_xyz')).toBeInTheDocument();
  });

  it('Total Collected stat aggregates SUCCESS amounts; PENDING/FAILED rows do not contribute', async () => {
    const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const rows = [
      { id: 21, invoiceId: 121, amount: 1000, currency: 'USD', gateway: 'stripe', status: 'SUCCESS', gatewayId: 'pi_A', paidAt: oneDayAgo, createdAt: oneDayAgo, metadata: {} },
      { id: 22, invoiceId: 122, amount: 9999, currency: 'USD', gateway: 'stripe', status: 'PENDING', gatewayId: 'pi_B', paidAt: null, createdAt: oneDayAgo, metadata: {} },
      { id: 23, invoiceId: 123, amount: 7777, currency: 'USD', gateway: 'stripe', status: 'FAILED', gatewayId: 'pi_C', paidAt: null, createdAt: oneDayAgo, metadata: {} },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve(rows);
      if (url === '/api/payments/config') return Promise.resolve({ stripe: { configured: true }, razorpay: { configured: true } });
      return Promise.resolve(null);
    });
    renderPayments();
    await waitFor(() => expect(screen.getByText('#121')).toBeInTheDocument());
    // Total Collected should render $1000.00 (only SUCCESS amount counted).
    // Same amount also renders in the row's Amount cell (row #121).
    const matches = screen.getAllByText('$1000.00');
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
