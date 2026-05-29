/**
 * BuyGiftCards.test.jsx — page-surface coverage for the customer-facing
 * gift-card storefront (frontend/src/pages/wellness/BuyGiftCards.jsx).
 *
 * What this pins:
 *   - Calls GET /api/wellness/giftcards/storefront on mount.
 *   - Loading → empty → grid render branches.
 *   - Each storefront card shows name + wallet-credit amount + sale price
 *     + a "Buy" button.
 *   - Clicking "Buy" opens the purchase modal (patient picker + Pay CTA).
 *   - "Pay" stays disabled until a patient is selected from the typeahead.
 *   - Picking a patient → clicking Pay calls POST
 *     /api/wellness/giftcards/:id/purchase/order with { patientId }.
 *
 * Drift pinned vs source (frontend/src/pages/wellness/BuyGiftCards.jsx):
 *   - Storefront endpoint is /api/wellness/giftcards/storefront (single
 *     word "giftcards", not /gift-cards), shape { giftCards: [...] }.
 *   - Buy button testid is `buy-giftcard-buy-<id>`.
 *   - Pay button testid is `buy-giftcard-pay-now`.
 *   - Patient search debounce is ~250ms; tests use vi.useFakeTimers OR
 *     waitFor with a relaxed timeout to clear it.
 *   - Razorpay SDK is loaded by appending a <script>; we stub
 *     window.Razorpay before triggering Pay so the SDK fetch never fires.
 *
 * Notes:
 *   - Mocks formatMoney / fetchApi / useNotify (same shape as
 *     GiftCards.test.jsx — stable mock objects per the RTL standing
 *     rule on useCallback dependency stability).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock object — RTL standing rule. Fresh objects per render would
// flap useCallback identity and cause infinite re-render loops.
const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (v, opts = {}) => `${opts.currency || 'INR'} ${Number(v || 0).toFixed(2)}`,
  tenantCurrency: () => 'INR',
}));

// SUT imported AFTER the mocks above.
import BuyGiftCardsPage from '../pages/wellness/BuyGiftCards';

// ── Fixtures ──────────────────────────────────────────────────────────
const storefrontCards = [
  {
    id: 11,
    name: 'New Year Saver',
    amount: 2500,
    price: 2000,
    color: '#0ea5e9',
    validityDays: 90,
    currency: 'INR',
    expiresAt: null,
  },
  {
    id: 12,
    name: 'Birthday Bonus',
    amount: 1000,
    price: 900,
    color: '#10b981',
    validityDays: null,
    currency: 'INR',
    expiresAt: '2026-12-31T00:00:00.000Z',
  },
];

const patientRows = [
  { id: 501, name: 'Priya Iyer', phone: '9876543210', email: 'priya@example.com' },
  { id: 502, name: 'Priyanka Rao', phone: '9876500001', email: null },
];

function defaultMock() {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/wellness/giftcards/storefront' && method === 'GET') {
      return Promise.resolve({ giftCards: storefrontCards });
    }
    if (url.startsWith('/api/wellness/patients') && method === 'GET') {
      return Promise.resolve({ patients: patientRows });
    }
    if (url.endsWith('/purchase/order') && method === 'POST') {
      return Promise.resolve({
        orderId: 'order_ABC',
        paymentId: 9001,
        key: 'rzp_test_key',
        amount: 200000,
        currency: 'INR',
        giftCardId: 11,
        patientId: JSON.parse(opts.body || '{}').patientId,
      });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
});

afterEach(() => {
  // Clean up any Razorpay stub left on window between tests so a later
  // test that relies on the SDK loader path isn't short-circuited.
  if (typeof window !== 'undefined' && 'Razorpay' in window) {
    delete window.Razorpay;
  }
});

// ─────────────────────────────────────────────────────────────────────
// 1. Page chrome + initial fetch
// ─────────────────────────────────────────────────────────────────────
describe('BuyGiftCards — page chrome', () => {
  it('renders heading + intro copy', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    expect(screen.getByRole('heading', { name: /Buy Gift Cards/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Browse available gift cards and pay via Razorpay/i),
    ).toBeInTheDocument();
    // Initial fetch + grid render.
    await waitFor(() => expect(screen.getByTestId('buy-giftcard-grid')).toBeInTheDocument());
  });

  it('calls GET /api/wellness/giftcards/storefront on mount', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/wellness/giftcards/storefront',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the loading placeholder until the GET resolves', async () => {
    let resolveFn;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/giftcards/storefront') {
        return new Promise((r) => {
          resolveFn = r;
        });
      }
      return Promise.resolve({});
    });
    render(<BuyGiftCardsPage />);

    expect(screen.getByTestId('buy-giftcard-loading')).toBeInTheDocument();
    resolveFn({ giftCards: [] });
    await waitFor(() =>
      expect(screen.queryByTestId('buy-giftcard-loading')).not.toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Empty vs grid render
// ─────────────────────────────────────────────────────────────────────
describe('BuyGiftCards — empty + grid', () => {
  it('shows the empty state when the storefront returns no cards', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/giftcards/storefront') {
        return Promise.resolve({ giftCards: [] });
      }
      return Promise.resolve({});
    });
    render(<BuyGiftCardsPage />);

    await waitFor(() => expect(screen.getByTestId('buy-giftcard-empty')).toBeInTheDocument());
    // No grid rendered alongside the empty state.
    expect(screen.queryByTestId('buy-giftcard-grid')).toBeNull();
  });

  it('renders a tile per gift card with name, credit amount, sale price, and a Buy CTA', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    await waitFor(() => expect(screen.getByTestId('buy-giftcard-card-11')).toBeInTheDocument());
    expect(screen.getByTestId('buy-giftcard-card-12')).toBeInTheDocument();

    // Names render.
    expect(screen.getByText('New Year Saver')).toBeInTheDocument();
    expect(screen.getByText('Birthday Bonus')).toBeInTheDocument();

    // Wallet-credit amounts (the `amount` field — the gift VALUE) render.
    expect(screen.getByText('INR 2500.00')).toBeInTheDocument();
    expect(screen.getByText('INR 1000.00')).toBeInTheDocument();

    // Sale prices (the `price` field — what the buyer pays) render.
    expect(screen.getByText('INR 2000.00')).toBeInTheDocument();
    expect(screen.getByText('INR 900.00')).toBeInTheDocument();

    // Each card has its own Buy button.
    expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument();
    expect(screen.getByTestId('buy-giftcard-buy-12')).toBeInTheDocument();
  });

  it('does NOT expose code / codeHash / codeLast4 fields anywhere on the page', async () => {
    // The storefront projection deliberately omits the redemption code
    // — buyers don't need it (the confirm handler credits the wallet
    // directly). Pin so a future server-side regression that adds the
    // field to the projection doesn't silently leak through the UI.
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    await waitFor(() => expect(screen.getByTestId('buy-giftcard-card-11')).toBeInTheDocument());
    expect(screen.queryByText(/codeHash/i)).toBeNull();
    expect(screen.queryByText(/HEN5/)).toBeNull();
    // No <code> blocks render (the admin GiftCards page uses them; the
    // storefront does not).
    expect(document.querySelector('code')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Purchase modal opens
// ─────────────────────────────────────────────────────────────────────
describe('BuyGiftCards — purchase modal', () => {
  it('clicking Buy opens the purchase dialog with the patient picker', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    await waitFor(() => expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('buy-giftcard-buy-11'));

    expect(screen.getByTestId('buy-giftcard-modal')).toBeInTheDocument();
    expect(screen.getByTestId('buy-giftcard-patient-input')).toBeInTheDocument();
    expect(screen.getByTestId('buy-giftcard-pay-now')).toBeInTheDocument();
  });

  it('Pay button is disabled until a patient is selected', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    await waitFor(() => expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('buy-giftcard-buy-11'));

    const pay = screen.getByTestId('buy-giftcard-pay-now');
    expect(pay).toBeDisabled();
  });

  it('typing in the patient input triggers a patient lookup and renders results', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    await waitFor(() => expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('buy-giftcard-buy-11'));

    fireEvent.change(screen.getByTestId('buy-giftcard-patient-input'), {
      target: { value: 'priya' },
    });

    await waitFor(
      () => {
        const patientCalls = fetchApiMock.mock.calls.filter(([url]) =>
          url.startsWith('/api/wellness/patients?search='),
        );
        expect(patientCalls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1500 },
    );
    await waitFor(() =>
      expect(screen.getByTestId('buy-giftcard-patient-option-501')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('buy-giftcard-patient-option-502')).toBeInTheDocument();
  });

  it('selecting a patient enables the Pay button and renders the recipient chip', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    render(<BuyGiftCardsPage />);

    await waitFor(() => expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('buy-giftcard-buy-11'));
    fireEvent.change(screen.getByTestId('buy-giftcard-patient-input'), {
      target: { value: 'priya' },
    });

    const optionLocator = await screen.findByTestId(
      'buy-giftcard-patient-option-501',
      {},
      { timeout: 1500 },
    );
    fireEvent.click(optionLocator);

    expect(screen.getByTestId('buy-giftcard-recipient-chip')).toBeInTheDocument();
    expect(screen.getByTestId('buy-giftcard-pay-now')).not.toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Pay flow — invokes /purchase/order + opens Razorpay
// ─────────────────────────────────────────────────────────────────────
describe('BuyGiftCards — Razorpay handshake', () => {
  it('clicking Pay calls POST /purchase/order with the selected patientId, then opens Razorpay', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    // Pre-stub the Razorpay SDK so the SUT short-circuits the script
    // loader and we can observe new Razorpay() being invoked.
    const rzpOpen = vi.fn();
    const rzpCtor = vi.fn(() => ({ open: rzpOpen }));
    window.Razorpay = rzpCtor;

    render(<BuyGiftCardsPage />);
    await waitFor(() => expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('buy-giftcard-buy-11'));
    fireEvent.change(screen.getByTestId('buy-giftcard-patient-input'), {
      target: { value: 'priya' },
    });

    const option = await screen.findByTestId(
      'buy-giftcard-patient-option-501',
      {},
      { timeout: 1500 },
    );
    fireEvent.click(option);

    fireEvent.click(screen.getByTestId('buy-giftcard-pay-now'));

    await waitFor(
      () => {
        const orderCalls = fetchApiMock.mock.calls.filter(
          ([url, opts]) =>
            url === '/api/wellness/giftcards/11/purchase/order' && opts?.method === 'POST',
        );
        expect(orderCalls.length).toBe(1);
        const body = JSON.parse(orderCalls[0][1].body);
        expect(body.patientId).toBe(501);
      },
      { timeout: 1500 },
    );

    // Razorpay constructor must have been invoked with the order_id +
    // key + handler from the server response.
    await waitFor(() => expect(rzpCtor).toHaveBeenCalledTimes(1));
    const opts = rzpCtor.mock.calls[0][0];
    expect(opts.order_id).toBe('order_ABC');
    expect(opts.key).toBe('rzp_test_key');
    expect(typeof opts.handler).toBe('function');
    expect(rzpOpen).toHaveBeenCalledTimes(1);
  });

  it('Razorpay handler success → POST /purchase/confirm + success toast', async () => {
    fetchApiMock.mockImplementation((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url === '/api/wellness/giftcards/storefront' && method === 'GET') {
        return Promise.resolve({ giftCards: storefrontCards });
      }
      if (url.startsWith('/api/wellness/patients') && method === 'GET') {
        return Promise.resolve({ patients: patientRows });
      }
      if (url === '/api/wellness/giftcards/11/purchase/order' && method === 'POST') {
        return Promise.resolve({
          orderId: 'order_ABC',
          paymentId: 9001,
          key: 'rzp_test_key',
          amount: 200000,
          currency: 'INR',
        });
      }
      if (url === '/api/wellness/giftcards/11/purchase/confirm' && method === 'POST') {
        return Promise.resolve({
          success: true,
          giftCard: { id: 11, status: 'redeemed' },
          transaction: { id: 7777, type: 'CREDIT_GIFTCARD', amount: 2500 },
        });
      }
      return Promise.resolve({});
    });

    // Capture the Razorpay handler the SUT installs so we can invoke
    // it directly with a fake gateway response — simulates a successful
    // checkout without spinning up the real Razorpay modal.
    let capturedHandler = null;
    const rzpOpen = vi.fn();
    window.Razorpay = vi.fn((opts) => {
      capturedHandler = opts.handler;
      return { open: rzpOpen };
    });

    render(<BuyGiftCardsPage />);
    await waitFor(() => expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('buy-giftcard-buy-11'));
    fireEvent.change(screen.getByTestId('buy-giftcard-patient-input'), {
      target: { value: 'priya' },
    });
    const option = await screen.findByTestId(
      'buy-giftcard-patient-option-501',
      {},
      { timeout: 1500 },
    );
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId('buy-giftcard-pay-now'));

    await waitFor(() => expect(capturedHandler).toBeTypeOf('function'), { timeout: 1500 });

    // Simulate Razorpay handing the verified payment back.
    await capturedHandler({
      razorpay_order_id: 'order_ABC',
      razorpay_payment_id: 'pay_xyz',
      razorpay_signature: 'sig_abc',
    });

    await waitFor(() => {
      const confirmCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/wellness/giftcards/11/purchase/confirm' && opts?.method === 'POST',
      );
      expect(confirmCalls.length).toBe(1);
      const body = JSON.parse(confirmCalls[0][1].body);
      expect(body.paymentId).toBe(9001);
      expect(body.razorpay_order_id).toBe('order_ABC');
      expect(body.razorpay_payment_id).toBe('pay_xyz');
      expect(body.razorpay_signature).toBe('sig_abc');
    });

    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith(
        expect.stringMatching(/credited to Priya Iyer's wallet/i),
      ),
    );
    // Storefront reloads on success so the bought card disappears.
    expect(
      fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/wellness/giftcards/storefront',
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('Razorpay modal dismissed (ondismiss) clears the paying state', async () => {
    fetchApiMock.mockImplementation(defaultMock());
    let capturedOnDismiss = null;
    window.Razorpay = vi.fn((opts) => {
      capturedOnDismiss = opts.modal && opts.modal.ondismiss;
      return { open: vi.fn() };
    });

    render(<BuyGiftCardsPage />);
    await waitFor(() => expect(screen.getByTestId('buy-giftcard-buy-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('buy-giftcard-buy-11'));
    fireEvent.change(screen.getByTestId('buy-giftcard-patient-input'), {
      target: { value: 'priya' },
    });
    const option = await screen.findByTestId(
      'buy-giftcard-patient-option-501',
      {},
      { timeout: 1500 },
    );
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId('buy-giftcard-pay-now'));

    await waitFor(() => expect(capturedOnDismiss).toBeTypeOf('function'), { timeout: 1500 });
    // After dismiss the Pay button must NOT be stuck in the "Opening
    // Razorpay…" loading state — the user can retry.
    capturedOnDismiss();
    await waitFor(() => {
      const pay = screen.getByTestId('buy-giftcard-pay-now');
      expect(pay).not.toHaveTextContent(/Opening Razorpay/i);
    });
  });
});
