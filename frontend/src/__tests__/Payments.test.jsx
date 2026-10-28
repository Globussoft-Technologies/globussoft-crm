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

// Keep the formatter deterministic while asserting the currency selected by
// the Payments page.
vi.mock('../utils/money', () => ({
  currencySymbol: (currency) => ({ INR: '₹', EUR: '€', GBP: '£' }[currency] || '$'),
  formatMoney: (v, opts) => {
    const cur = opts?.currency;
    const prefix = { INR: '₹', EUR: '€', GBP: '£' }[cur] || '$';
    return `${prefix}${(Number(v) || 0).toFixed(2)}`;
  },
}));

import { AuthContext } from '../App';
import Payments from '../pages/Payments';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const REGULAR_USER = { userId: 2, name: 'User', email: 'u@x.com', role: 'USER' };

function renderPayments(user = ADMIN_USER, tenant = { id: 1, vertical: 'generic', defaultCurrency: 'USD' }) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant, loading: false }}>
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
  if (url.startsWith('/api/payments?')) return Promise.resolve({ data: samplePayments, total: 3, totalPages: 1, stats: { collected: 1500, pending: 1, failed: 1 } });
  if (url === '/api/payments') return Promise.resolve(samplePayments);
  if (url === '/api/payments/config') {
    return Promise.resolve({
      stripe: { configured: true, webhookConfigured: true },
      razorpay: { configured: true, keyId: 'rzp_test_abc' },
    });
  }
  if (url === '/api/currencies?fields=summary') {
    return Promise.resolve([
      { code: 'USD', exchangeRate: 1, isBase: true },
      { code: 'INR', exchangeRate: 80, isBase: false },
      { code: 'EUR', exchangeRate: 0.9, isBase: false },
      { code: 'GBP', exchangeRate: 0.8, isBase: false },
    ]);
  }
  return Promise.resolve(null);
}

function generatePayments(count) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({
      id: i,
      invoiceId: 100 + i,
      amount: 100 + i,
      currency: 'USD',
      gateway: i % 2 === 0 ? 'stripe' : 'razorpay',
      status: i % 3 === 0 ? 'PENDING' : 'SUCCESS',
      gatewayId: i % 2 === 0 ? `pi_ST${i}` : `pay_RZP${i}`,
      paidAt: new Date(Date.now() - 86_400_000).toISOString(),
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      metadata: {},
    });
  }
  return out;
}

describe('<Payments /> — page surface', () => {
  it('uses server totals and requests the next customer page beyond 200 payments', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/payments?')) {
        const page = Number(new URL(url, 'http://localhost').searchParams.get('page'));
        return Promise.resolve({ data: [{ ...samplePayments[0], id: page }], page, total: 205, totalPages: 21,
          stats: { collected: 9999, pending: 30, failed: 20 } });
      }
      return defaultFetchMock(url);
    });
    renderPayments({ userId: 3, role: 'CUSTOMER', userType: 'CUSTOMER' });
    await waitFor(() => expect(screen.getByTestId('payment-pagination')).toHaveTextContent('205 payments'));
    expect(screen.getByText('$9999.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(fetchApiMock.mock.calls.some(([url]) => url.includes('/api/payments?page=2&limit=10'))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 2 of 21/));
    expect(screen.getByText('$9999.00')).toBeInTheDocument();
  });

  it('ignores an older customer response after changing gateway filters', async () => {
    let resolveOld;
    fetchApiMock.mockImplementation((url) => {
      if (!url.startsWith('/api/payments?')) return defaultFetchMock(url);
      if (!url.includes('gateway=stripe')) return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve({ data: [samplePayments[1]], page: 1, total: 1, totalPages: 1,
        stats: { collected: 222, pending: 1, failed: 0 } });
    });
    renderPayments({ userId: 3, role: 'CUSTOMER', userType: 'CUSTOMER' });
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: /^Stripe$/i }));
    await screen.findByText('$222.00');
    resolveOld({ data: [samplePayments[0]], total: 999, totalPages: 100, stats: { collected: 9999, pending: 0, failed: 0 } });
    await waitFor(() => expect(screen.getByTestId('payment-pagination')).toHaveTextContent('1 payments'));
    expect(screen.queryByText('$9999.00')).not.toBeInTheDocument();
  });
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyObj.error.mockReset();
  });

  it('renders the heading and the stat cards', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Payments Received$/i })).toBeInTheDocument();
    });
    // Stat-card labels include a window suffix like "(Last 30 Days)".
    expect(screen.getByText(/Total Collected/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Pending/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Failed/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('payment-summary-chips')).toBeInTheDocument();
  });

  it('filters the Generic CRM ledger when an invoice-style payment stat is clicked', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());

    const pendingChip = screen.getByRole('button', { name: /^Pending \(Last 30 Days\): 1$/i });
    fireEvent.click(pendingChip);
    expect(pendingChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Invoice #102')).toBeInTheDocument();
    expect(screen.queryByText('Invoice #101')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoice #103')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Filter Status' }));
    expect(screen.getByLabelText('Filter payments by status')).toHaveValue('PENDING');

    fireEvent.click(pendingChip);
    expect(screen.getByText('Invoice #101')).toBeInTheDocument();
    expect(screen.getByText('Invoice #103')).toBeInTheDocument();
  });

  it('shows plot name and plot number instead of the booking id only in Generic CRM', async () => {
    const plotPayment = {
      ...samplePayments[0],
      id: 77,
      invoiceId: null,
      description: 'Initial payment for plot booking BOOK-894D82A651',
      metadata: { kind: 'plot-booking-payment', plotBookingId: 73 },
      plotSite: { id: 91, name: 'Green Meadows', plotNumber: 'A-12' },
    };
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve([plotPayment]);
      return defaultFetchMock(url);
    });

    const { unmount } = renderPayments();
    expect(await screen.findByText('Green Meadows (Plot No. A-12)')).toBeInTheDocument();
    expect(screen.queryByText(/BOOK-894D82A651/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByRole('heading', { name: 'Payment #77' })).toBeInTheDocument();
    expect(screen.getAllByText('Green Meadows (Plot No. A-12)')).toHaveLength(2);
    expect(screen.queryByText(/BOOK-894D82A651/)).not.toBeInTheDocument();
    unmount();

    renderPayments(ADMIN_USER, { id: 2, vertical: 'travel', defaultCurrency: 'USD' });
    expect(await screen.findByText('Initial payment for plot booking BOOK-894D82A651')).toBeInTheDocument();
    expect(screen.queryByText('Green Meadows (Plot No. A-12)')).not.toBeInTheDocument();
  });

  it('shows a customer-facing payment ledger without loading gateway configuration', async () => {
    renderPayments({ userId: 3, role: 'CUSTOMER', userType: 'CUSTOMER' });
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Payments$/i })).toBeInTheDocument());
    expect(screen.getByText(/Total Paid/i)).toBeInTheDocument();
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('payment-summary-chips')).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/payments/config');
  });

  it('renders one row per payment with invoiceId, amount, and gateway+status badges', async () => {
    renderPayments();
    // Preserve each payment's currency; the tenant currency only formats
    // aggregate cards and records without an explicit currency.
    await waitFor(() => expect(screen.getAllByText('\u20B91500.00').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('$250.00')).toBeInTheDocument();
    expect(screen.getByText('$75.00')).toBeInTheDocument();
    // Invoice IDs render in the "For" column as "Invoice #<id>".
    expect(screen.getByText('Invoice #101')).toBeInTheDocument();
    expect(screen.getByText('Invoice #102')).toBeInTheDocument();
    expect(screen.getByText('Invoice #103')).toBeInTheDocument();
    // Status badge labels.
    expect(screen.getByText(/^Success$/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Pending$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Failed$/).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the existing tenant currency behavior outside Generic CRM', async () => {
    renderPayments(ADMIN_USER, { id: 2, vertical: 'travel', defaultCurrency: 'USD' });
    await waitFor(() => expect(screen.getAllByText('$1500.00').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('$250.00')).toBeInTheDocument();
  });

  it('uses the server aggregate for the dynamic Generic CRM total and active gateway filter', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/payments/stats?')) {
        const filteredToStripe = url.includes('gateway=stripe');
        return Promise.resolve({
          successfulAmount: filteredToStripe ? 250 : 54321,
          byStatus: { PENDING: filteredToStripe ? 1 : 4, FAILED: 2 },
        });
      }
      return defaultFetchMock(url);
    });

    renderPayments();
    expect(await screen.findByText('$54321.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter Gateway' }));
    fireEvent.change(screen.getByLabelText('Filter payments by gateway'), { target: { value: 'stripe' } });
    expect(await screen.findByText('$250.00')).toBeInTheDocument();
    expect(fetchApiMock.mock.calls.some(([url]) => (
      url.startsWith('/api/payments/stats?')
      && url.includes('dateBasis=payment')
      && url.includes('gateway=stripe')
      && url.includes('from=')
      && url.includes('to=')
    ))).toBe(true);
  });

  it('shows enriched service labels in the "For" column when description is absent', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') {
        return Promise.resolve([
          {
            id: 11,
            invoiceId: 201,
            amount: 308418,
            currency: 'INR',
            gateway: 'razorpay',
            status: 'SUCCESS',
            gatewayId: 'pay_RZP201',
            paidAt: new Date(Date.now() - 86_400_000).toISOString(),
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
            metadata: {},
            service: { id: 501, name: 'Advance Manicure female' },
          },
        ]);
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
    await waitFor(() => {
      expect(screen.getByText('Advance Manicure female')).toBeInTheDocument();
    });
    expect(screen.queryByText('Invoice #201')).not.toBeInTheDocument();
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

  it('selecting Razorpay from the Gateway header filters rows to razorpay only', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(screen.getByText('Invoice #101')).toBeInTheDocument();
    expect(screen.getByText('Invoice #102')).toBeInTheDocument();
    expect(screen.getByText('Invoice #103')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Filter Gateway' }));
    fireEvent.change(screen.getByLabelText('Filter payments by gateway'), { target: { value: 'razorpay' } });

    await waitFor(() => {
      expect(screen.getByText('Invoice #101')).toBeInTheDocument();
      expect(screen.queryByText('Invoice #102')).not.toBeInTheDocument();
      expect(screen.queryByText('Invoice #103')).not.toBeInTheDocument();
    });
  });

  it('adds invoice-style column filters to the Generic CRM payment ledger', async () => {
    const rows = [
      { ...samplePayments[0], description: 'Plot deposit' },
      { ...samplePayments[1], description: 'Annual renewal' },
      { ...samplePayments[2], description: 'Support package' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve(rows);
      return defaultFetchMock(url);
    });

    renderPayments();
    await waitFor(() => expect(screen.getByText('Plot deposit')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Filter Customer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filter For' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter Amount' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter Gateway' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter Status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter Paid Date' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^All$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Stripe$/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Filter by date')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Filter Gateway' }));
    fireEvent.change(screen.getByLabelText('Filter payments by gateway'), { target: { value: 'razorpay' } });
    expect(screen.getByLabelText('Filter payments by gateway')).toHaveValue('razorpay');
    expect(screen.getByText('Plot deposit')).toBeInTheDocument();
    expect(screen.queryByText('Annual renewal')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter payments by gateway'), { target: { value: 'ALL' } });
    expect(screen.getByLabelText('Filter payments by gateway')).toHaveValue('ALL');
    expect(screen.getByText('Annual renewal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Filter Status' }));
    fireEvent.change(screen.getByLabelText('Filter payments by status'), { target: { value: 'FAILED' } });
    expect(screen.getByText('Support package')).toBeInTheDocument();
    expect(screen.queryByText('Annual renewal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear payment filters' }));
    expect(screen.getByText('Plot deposit')).toBeInTheDocument();
    expect(screen.getByText('Annual renewal')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear payment filters' })).not.toBeInTheDocument();
  });

  it('opens the native calendar from the full custom paid-date fields', async () => {
    const originalShowPicker = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'showPicker');
    const showPicker = vi.fn();
    Object.defineProperty(HTMLInputElement.prototype, 'showPicker', {
      configurable: true,
      value: showPicker,
    });

    try {
      renderPayments();
      await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Filter Paid Date' }));
      fireEvent.change(screen.getByLabelText('Filter payments by paid date'), { target: { value: 'custom' } });

      fireEvent.click(screen.getByLabelText('Filter paid date from'));
      fireEvent.click(screen.getByLabelText('Filter paid date to'));
      expect(showPicker).toHaveBeenCalledTimes(2);
    } finally {
      if (originalShowPicker) {
        Object.defineProperty(HTMLInputElement.prototype, 'showPicker', originalShowPicker);
      } else {
        delete HTMLInputElement.prototype.showPicker;
      }
    }
  });

  it('converts payment rows and Total Collected together when Amount currency changes', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/payments/stats?')) {
        return Promise.resolve({
          successfulAmount: 1500,
          successfulAmountByCurrency: { INR: 1500 },
          byStatus: { SUCCESS: 1, PENDING: 1, FAILED: 1 },
        });
      }
      return defaultFetchMock(url);
    });

    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Filter Amount' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'EUR' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Filter payments by currency'), { target: { value: 'EUR' } });

    expect(screen.getAllByText('€16.88').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('€225.00')).toBeInTheDocument();
    expect(screen.getByText('€67.50')).toBeInTheDocument();
    expect(screen.getByText('Invoice #101')).toBeInTheDocument();
    expect(screen.getByText('Invoice #102')).toBeInTheDocument();
    expect(screen.getByText('Invoice #103')).toBeInTheDocument();
  });

  it('does not relabel unconverted amounts when exchange rates are unavailable', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/currencies?fields=summary') return Promise.resolve([]);
      if (url.startsWith('/api/payments/stats?')) return Promise.resolve({ successfulAmountByCurrency: { INR: 1500 }, byStatus: {} });
      return defaultFetchMock(url);
    });
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Filter Amount' }));
    fireEvent.change(await screen.findByLabelText('Filter payments by currency'), { target: { value: 'USD' } });
    await waitFor(() => expect(screen.getAllByText('Rate unavailable').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('$1500.00')).not.toBeInTheDocument();
  });

  it('does not add Generic CRM column filters to other verticals', async () => {
    renderPayments(ADMIN_USER, { id: 2, vertical: 'travel', defaultCurrency: 'USD' });
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Filter Customer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filter Status' })).not.toBeInTheDocument();
  });

  it('opens Gateway Configuration in a popup from the eye action for a Generic CRM admin', async () => {
    renderPayments(ADMIN_USER);
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /Gateway Configuration/i })).toBeNull();
    const gatewayAction = screen.getByRole('button', { name: /View gateway configuration/i });
    expect(gatewayAction.closest('.razorpay-gateway-card')).toBeInTheDocument();
    expect(gatewayAction.closest('th')).toBeNull();
    fireEvent.click(gatewayAction);
    const dialog = screen.getByRole('dialog', { name: /Gateway Configuration/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveStyle({ background: 'var(--modal-bg, #ffffff)' });
    expect(screen.getByRole('heading', { name: /Gateway Configuration/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close gateway configuration/i }));
    expect(screen.queryByRole('dialog', { name: /Gateway Configuration/i })).toBeNull();
  });

  it('Gateway Configuration panel is HIDDEN for USER role', async () => {
    renderPayments(REGULAR_USER);
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /Gateway Configuration/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /View gateway configuration/i })).toBeNull();
  });

  it('keeps Gateway Configuration inline and omits the eye action outside Generic CRM', async () => {
    renderPayments(ADMIN_USER, { id: 2, vertical: 'travel', defaultCurrency: 'USD' });
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /Gateway Configuration/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View gateway configuration/i })).toBeNull();
  });

  it('keeps one table layout so the sticky header stays aligned while payment rows scroll', async () => {
    const { container } = renderPayments(ADMIN_USER);
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(container.querySelector('.finance-page')).toHaveClass('finance-page--generic-ledger');
    expect(container.querySelector('thead')).toHaveClass('payment-ledger-head');
    expect(container.querySelector('tbody')).toHaveClass('payment-ledger-body');
    expect(screen.getByRole('columnheader', { name: /^Actions/ }).closest('table'))
      .toBe(screen.getAllByRole('button', { name: 'View' })[0].closest('table'));
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
    await waitFor(() => expect(screen.getByText('Invoice #104')).toBeInTheDocument());
    expect(screen.getByText(/^Success$/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Pending$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Failed$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Refunded$/).length).toBeGreaterThanOrEqual(1);
  });

  it('Gateway header filters Stripe rows and restores all rows', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Filter Gateway' }));
    fireEvent.change(screen.getByLabelText('Filter payments by gateway'), { target: { value: 'stripe' } });
    await waitFor(() => {
      expect(screen.queryByText('Invoice #101')).not.toBeInTheDocument();
      expect(screen.getByText('Invoice #102')).toBeInTheDocument();
      expect(screen.getByText('Invoice #103')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Filter payments by gateway'), { target: { value: 'ALL' } });
    await waitFor(() => {
      expect(screen.getByText('Invoice #101')).toBeInTheDocument();
      expect(screen.getByText('Invoice #102')).toBeInTheDocument();
      expect(screen.getByText('Invoice #103')).toBeInTheDocument();
    });
  });

  it('refund button is enabled for captured Razorpay SUCCESS payments and disabled otherwise', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    const refundButtons = screen.getAllByRole('button', { name: /^Refund$/i });
    expect(refundButtons.length).toBe(3);
    // Row 1: Razorpay SUCCESS with a pay_ gateway id → enabled.
    expect(refundButtons[0]).toBeEnabled();
    expect(refundButtons[0]).toHaveAttribute('title', expect.stringMatching(/Refund ₹1500\.00 via Razorpay/i));
    // Rows 2/3: pending / failed or non-Razorpay → disabled.
    expect(refundButtons[1]).toBeDisabled();
    expect(refundButtons[1]).toHaveAttribute('title', expect.stringMatching(/Only captured Razorpay payments can be refunded/i));
    expect(refundButtons[2]).toBeDisabled();
    expect(refundButtons[2]).toHaveAttribute('title', expect.stringMatching(/Only captured Razorpay payments can be refunded/i));
  });

  it('clicking a row View button opens the detail modal; clicking close hides it', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /^Payment #1$/i })).toBeNull();
    const viewButtons = screen.getAllByRole('button', { name: /^View$/i });
    fireEvent.click(viewButtons[0]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Payment #1$/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/₹1500\.00 INR/)).toBeInTheDocument();
    // Gateway-id renders in the modal.
    expect(screen.getByText('pay_RZP123')).toBeInTheDocument();
  });

  it('Refresh button click triggers a fresh /api/payments fetch', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText('Invoice #110')).toBeInTheDocument());
    expect(screen.getByText(/paypal/i)).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: /View gateway configuration/i }));
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
    await waitFor(() => expect(screen.getByText('Invoice #121')).toBeInTheDocument());
    // Total Collected should render $1000.00 (only SUCCESS amount counted —
    // mock formatMoney here uses .toFixed(2); real behavior covered by money.test.js).
    // Same amount also renders in the row's Amount cell (row #121).
    const matches = screen.getAllByText('$1000.00');
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<Payments /> — pagination', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/payments') return Promise.resolve(generatePayments(25));
      if (url === '/api/payments/config') return Promise.resolve({ stripe: { configured: true }, razorpay: { configured: true } });
      return Promise.resolve(null);
    });
  });

  it('shows only the first page of payments by default', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());
    expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 1 of 3/);
    expect(screen.getAllByText(/Invoice #/).length).toBe(10);
    expect(screen.queryByText('Invoice #111')).not.toBeInTheDocument();
  });

  it('navigates to the next and previous pages', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    await waitFor(() => {
      expect(screen.queryByText('Invoice #101')).not.toBeInTheDocument();
      expect(screen.getByText('Invoice #111')).toBeInTheDocument();
    });
    expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 2 of 3/);

    fireEvent.click(screen.getByRole('button', { name: /Previous page/i }));
    await waitFor(() => {
      expect(screen.getByText('Invoice #101')).toBeInTheDocument();
      expect(screen.queryByText('Invoice #111')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 1 of 3/);
  });

  it('disables previous on the first page and next on the last page', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());

    const prev = screen.getByRole('button', { name: /Previous page/i });
    const next = screen.getByRole('button', { name: /Next page/i });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();

    fireEvent.click(next);
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 3 of 3/));
    expect(prev).toBeEnabled();
    expect(next).toBeDisabled();
  });

  it('changing the per-page size updates the page count and resets to page 1', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    await waitFor(() => expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 2 of 3/));

    fireEvent.change(screen.getByLabelText(/Payments per page/i), { target: { value: '25' } });
    await waitFor(() => {
      expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 1 of 1/);
      expect(screen.getAllByText(/Invoice #/).length).toBe(25);
    });
  });

  it('resets to page 1 when a gateway header filter is selected', async () => {
    renderPayments();
    await waitFor(() => expect(screen.getByText('Invoice #101')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    await waitFor(() => expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 2 of 3/));

    fireEvent.click(screen.getByRole('button', { name: 'Filter Gateway' }));
    fireEvent.change(screen.getByLabelText('Filter payments by gateway'), { target: { value: 'stripe' } });
    await waitFor(() => expect(screen.getByTestId('payment-pagination')).toHaveTextContent(/Page 1 of/i));
  });
});
