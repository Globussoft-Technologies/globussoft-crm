/**
 * MyTransactions.test.jsx — page-surface coverage for the customer/user
 * transaction-history page (frontend/src/pages/wellness/MyTransactions.jsx).
 *
 * What this pins:
 *   - Calls GET /api/wellness/my-transactions on mount.
 *   - Loading → list / empty / error render branches.
 *   - Summary cards render the totalPaid / wallet / subscriptions / count
 *     values from the API summary block.
 *   - One row per transaction, with the POS line-item breakdown.
 *   - Credit rows show a '+' prefix, debit rows show a '−' prefix.
 *   - Category filter chips narrow the visible rows.
 *   - Error branch shows the message + a working "Try again" retry.
 *
 * Mocks fetchApi / useNotify / money (stable object refs per the RTL
 * standing rule on useCallback dependency stability).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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
};
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));

vi.mock('../utils/money', () => ({
  formatMoney: (v, opts = {}) => `${opts.currency || 'INR'} ${Number(v || 0).toFixed(2)}`,
  currencySymbol: () => '₹',
  tenantCurrency: () => 'INR',
}));

// SUT imported AFTER the mocks above.
import MyTransactions from '../pages/wellness/MyTransactions';

// ── Fixtures ──────────────────────────────────────────────────────────
const RESPONSE = {
  currency: 'INR',
  summary: {
    totalPaid: 5000,
    posTotal: 3000,
    onlineTotal: 2000,
    subscriptionsTotal: 0,
    walletBalance: 1500,
    walletTopUps: 2000,
    transactionCount: 3,
  },
  transactions: [
    {
      id: 'sale-1',
      type: 'POS_SALE',
      category: 'Purchase',
      title: 'Purchase · INV-1',
      description: 'Botox ×1',
      amount: 3000,
      direction: 'debit',
      status: 'COMPLETED',
      paymentMethod: 'CARD',
      reference: 'INV-1',
      date: '2026-05-01T10:00:00.000Z',
      items: [{ name: 'Botox', kind: 'SERVICE', quantity: 1, amount: 3000 }],
    },
    {
      id: 'wallet-1',
      type: 'WALLET',
      category: 'Wallet',
      title: 'Wallet top-up',
      description: 'Added funds',
      amount: 2000,
      direction: 'credit',
      status: 'COMPLETED',
      date: '2026-04-20T09:00:00.000Z',
      balanceAfter: 2000,
    },
    {
      id: 'payment-1',
      type: 'PAYMENT',
      category: 'Online Payment',
      title: 'Online payment · INV-2',
      description: 'razorpay',
      amount: 2000,
      direction: 'debit',
      status: 'SUCCESS',
      reference: 'pay_x',
      date: '2026-03-15T12:00:00.000Z',
    },
  ],
};

const EMPTY = {
  currency: 'INR',
  summary: {
    totalPaid: 0,
    posTotal: 0,
    onlineTotal: 0,
    subscriptionsTotal: 0,
    walletBalance: 0,
    walletTopUps: 0,
    transactionCount: 0,
  },
  transactions: [],
};

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.error.mockReset();
});

// ─────────────────────────────────────────────────────────────────────
// 1. Mount fetch + page chrome
// ─────────────────────────────────────────────────────────────────────
describe('MyTransactions — chrome + mount fetch', () => {
  it('renders the heading and calls GET /api/wellness/my-transactions on mount', async () => {
    fetchApiMock.mockResolvedValue(RESPONSE);
    render(<MyTransactions />);

    expect(screen.getByRole('heading', { name: /My Transactions/i })).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/wellness/my-transactions',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows the loading placeholder until the GET resolves', async () => {
    let resolveFn;
    fetchApiMock.mockImplementation(
      () => new Promise((r) => { resolveFn = r; }),
    );
    render(<MyTransactions />);

    expect(screen.getByTestId('my-transactions-loading')).toBeInTheDocument();
    resolveFn(EMPTY);
    await waitFor(() =>
      expect(screen.queryByTestId('my-transactions-loading')).not.toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Summary cards
// ─────────────────────────────────────────────────────────────────────
describe('MyTransactions — summary cards', () => {
  it('renders totalPaid / wallet balance / subscriptions / count from the summary block', async () => {
    fetchApiMock.mockResolvedValue(RESPONSE);
    render(<MyTransactions />);

    await waitFor(() => expect(screen.getByTestId('my-transactions-summary')).toBeInTheDocument());
    const summary = screen.getByTestId('my-transactions-summary');
    expect(within(summary).getByText('INR 5000.00')).toBeInTheDocument(); // totalPaid
    expect(within(summary).getByText('INR 1500.00')).toBeInTheDocument(); // walletBalance
    // Topped-up sub-line on the wallet card.
    expect(within(summary).getByText(/Topped up INR 2000\.00/)).toBeInTheDocument();
    // Transaction count.
    expect(within(summary).getByText('3')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Timeline rows + line items + direction
// ─────────────────────────────────────────────────────────────────────
describe('MyTransactions — timeline', () => {
  it('renders one row per transaction with title + POS line-item breakdown', async () => {
    fetchApiMock.mockResolvedValue(RESPONSE);
    render(<MyTransactions />);

    await waitFor(() => expect(screen.getByTestId('my-transactions-list')).toBeInTheDocument());
    expect(screen.getByTestId('my-transactions-row-sale-1')).toBeInTheDocument();
    expect(screen.getByTestId('my-transactions-row-wallet-1')).toBeInTheDocument();
    expect(screen.getByTestId('my-transactions-row-payment-1')).toBeInTheDocument();

    // Titles.
    expect(screen.getByText('Purchase · INV-1')).toBeInTheDocument();
    expect(screen.getByText('Wallet top-up')).toBeInTheDocument();

    // POS line-item breakdown renders the item name inside the sale row.
    const saleRow = screen.getByTestId('my-transactions-row-sale-1');
    expect(within(saleRow).getByText('Botox')).toBeInTheDocument();
    expect(saleRow.textContent).toContain('INR 3000.00');
  });

  it('credit rows show a + prefix and debit rows show a − prefix', async () => {
    fetchApiMock.mockResolvedValue(RESPONSE);
    render(<MyTransactions />);

    await waitFor(() => expect(screen.getByTestId('my-transactions-list')).toBeInTheDocument());
    // Wallet top-up is a credit → '+'. Balance-after line also renders.
    const walletRow = screen.getByTestId('my-transactions-row-wallet-1');
    expect(walletRow.textContent).toContain('+');
    expect(walletRow.textContent).toContain('INR 2000.00');
    expect(walletRow.textContent).toContain('Bal INR 2000.00');
    // POS sale is a debit → minus sign (U+2212).
    const saleRow = screen.getByTestId('my-transactions-row-sale-1');
    expect(saleRow.textContent).toContain('−');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Category filter chips
// ─────────────────────────────────────────────────────────────────────
describe('MyTransactions — category filter', () => {
  it('clicking a category chip narrows the visible rows', async () => {
    fetchApiMock.mockResolvedValue(RESPONSE);
    render(<MyTransactions />);

    await waitFor(() => expect(screen.getByTestId('my-transactions-list')).toBeInTheDocument());
    // All three rows visible under the default ALL filter.
    expect(screen.getByTestId('my-transactions-row-sale-1')).toBeInTheDocument();
    expect(screen.getByTestId('my-transactions-row-wallet-1')).toBeInTheDocument();

    // Filter to Wallet only.
    fireEvent.click(screen.getByTestId('my-transactions-filter-Wallet'));
    expect(screen.getByTestId('my-transactions-row-wallet-1')).toBeInTheDocument();
    expect(screen.queryByTestId('my-transactions-row-sale-1')).toBeNull();
    expect(screen.queryByTestId('my-transactions-row-payment-1')).toBeNull();

    // Back to ALL.
    fireEvent.click(screen.getByTestId('my-transactions-filter-ALL'));
    expect(screen.getByTestId('my-transactions-row-sale-1')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Empty + error branches
// ─────────────────────────────────────────────────────────────────────
describe('MyTransactions — empty + error', () => {
  it('shows the empty state when the API returns no transactions', async () => {
    fetchApiMock.mockResolvedValue(EMPTY);
    render(<MyTransactions />);

    await waitFor(() => expect(screen.getByTestId('my-transactions-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('my-transactions-list')).toBeNull();
    expect(screen.getByText(/No transactions yet/i)).toBeInTheDocument();
  });

  it('shows the error state on fetch failure, and "Try again" re-fetches', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error('network boom'));
    render(<MyTransactions />);

    await waitFor(() => expect(screen.getByTestId('my-transactions-error')).toBeInTheDocument());
    expect(screen.getByText(/network boom/i)).toBeInTheDocument();
    expect(notify.error).toHaveBeenCalled();

    // Retry now resolves with data.
    fetchApiMock.mockResolvedValueOnce(RESPONSE);
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => expect(screen.getByTestId('my-transactions-list')).toBeInTheDocument());
  });
});
