/**
 * TripBooking.jsx — public trip booking + 50%-advance flow (PRD §4.7).
 *
 * Consumes the public endpoints:
 *   GET  /api/travel/itineraries/public/:shareToken
 *   POST /api/travel/itineraries/public/:shareToken/create-payment-order
 *   POST /api/travel/itineraries/public/:shareToken/verify-payment
 *
 * Payment is a REAL Razorpay checkout: the page mints an order, opens the
 * Razorpay modal (window.Razorpay), then verifies the signed result. Tests
 * stub window.Razorpay so the modal auto-resolves a signed success payload.
 *
 * All requests go through raw fetch() (page renders outside AuthContext
 * shell), so global.fetch is spied per-test. Mock objects are stable
 * references per CLAUDE.md feedback rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TripBooking from '../pages/public/TripBooking';

const SENT_ITINERARY = {
  shareToken: 'tok-aaa-bbb-pad-1234567890',
  tenantName: 'Travel Stall Demo',
  subBrand: 'travelstall',
  destination: 'Bali, Indonesia',
  startDate: '2026-10-01',
  endDate: '2026-10-08',
  status: 'sent',
  totalAmount: 100000,
  currency: 'INR',
  advanceRatio: 0.5,
  advanceDue: 50000,
  advancePaid: 0,
  advancePaidAt: null,
  balanceDue: 100000,
  onlinePaymentEnabled: true,
  items: [
    { id: 1, itemType: 'hotel', position: 0, description: 'Bali Resort 7n', totalPrice: 70000 },
    { id: 2, itemType: 'flight', position: 1, description: 'BLR-DPS economy', totalPrice: 30000 },
  ],
  pdfUrl: '/uploads/itineraries/itin-1.pdf',
};

const ADVANCE_PAID_ITINERARY = {
  ...SENT_ITINERARY,
  status: 'advance_paid',
  advancePaid: 50000,
  advancePaidAt: '2026-05-21T10:00:00.000Z',
  balanceDue: 50000,
  onlinePaymentEnabled: true,
};

const FULLY_PAID_ITINERARY = {
  ...SENT_ITINERARY,
  status: 'fully_paid',
  advancePaid: 100000,
  advancePaidAt: '2026-05-21T10:00:00.000Z',
  balanceDue: 0,
  onlinePaymentEnabled: true,
};

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
  delete window.Razorpay;
});

const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const fail = (status, body) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });

// Stub the Razorpay checkout SDK. Because window.Razorpay is set, the page's
// loadRazorpayScript() resolves immediately (no <script> injection needed).
// open() auto-invokes the success handler with a signed result so the flow
// proceeds to verify-payment. SIGNED = { razorpay_order_id/payment_id/signature }.
function installRazorpaySuccess() {
  window.Razorpay = function Razorpay(opts) {
    this.opts = opts;
    this.on = () => {};
    this.open = () => {
      opts.handler({
        razorpay_order_id: 'order_test_1',
        razorpay_payment_id: 'pay_test_1',
        razorpay_signature: 'sig_test_1',
      });
    };
  };
}

function renderTrip(token = SENT_ITINERARY.shareToken) {
  return render(
    <MemoryRouter initialEntries={[`/trip/${token}`]}>
      <Routes>
        <Route path="/trip/:shareToken" element={<TripBooking />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TripBooking — public booking page (PRD §4.7)', () => {
  it('fetches and renders the itinerary on mount', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url.startsWith('/api/travel/itineraries/public/')) return ok(SENT_ITINERARY);
      return ok({});
    });
    renderTrip();
    await screen.findByText('Bali, Indonesia');
    expect(screen.getByText(/Travel Stall Demo/)).toBeTruthy();
    expect(screen.getByText(/Bali Resort 7n/)).toBeTruthy();
    expect(screen.getByText(/BLR-DPS economy/)).toBeTruthy();
  });

  it('shows a friendly error when the trip is not found', async () => {
    fetchSpy.mockImplementation(() =>
      fail(404, { error: 'Itinerary not found', code: 'NOT_FOUND' }),
    );
    renderTrip();
    await screen.findByText(/couldn't find a trip/i);
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy();
  });

  it('shows a draft-gating message when status=NOT_SHARED', async () => {
    fetchSpy.mockImplementation(() =>
      fail(404, { error: 'Itinerary not yet shared', code: 'NOT_SHARED' }),
    );
    renderTrip();
    await screen.findByText(/not yet ready to share/i);
  });

  it('renders advance CTA with computed amount on a sent itinerary', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url.startsWith('/api/travel/itineraries/public/')) return ok(SENT_ITINERARY);
      return ok({});
    });
    renderTrip();
    const cta = await screen.findByRole('button', { name: /Pay 50% to confirm/i });
    expect(cta).toBeTruthy();
    // INR formatting renders the rupee glyph; assert on the numeric portion.
    expect(cta.textContent).toMatch(/50,000/);
  });

  it('Pay-advance opens Razorpay checkout, verifies the signed result, and reload reflects new state', async () => {
    installRazorpaySuccess();
    let getCalls = 0;
    fetchSpy.mockImplementation((url, opts) => {
      if (url.startsWith('/api/travel/itineraries/public/') && !opts) {
        getCalls += 1;
        // First load = sent; after pay → advance_paid.
        return ok(getCalls === 1 ? SENT_ITINERARY : ADVANCE_PAID_ITINERARY);
      }
      if (opts?.method === 'POST' && url.endsWith('/create-payment-order')) {
        return ok({
          orderId: 'order_test_1',
          amount: 5000000, // paise
          amountMajor: 50000,
          currency: 'INR',
          keyId: 'rzp_test_x',
          kind: 'advance',
          destination: 'Bali, Indonesia',
        });
      }
      if (opts?.method === 'POST' && url.endsWith('/verify-payment')) {
        return ok({
          status: 'advance_paid',
          advancePaidAmount: 50000,
          advancePaidAt: '2026-05-21T10:00:00.000Z',
          paymentReference: 'pay_test_1',
          balanceDue: 50000,
        });
      }
      return ok({});
    });
    renderTrip();
    const payBtn = await screen.findByRole('button', { name: /Pay 50% to confirm/i });
    fireEvent.click(payBtn);

    // Re-fetch after a verified payment → advance-paid state renders.
    await screen.findByText(/Advance received/i);
    expect(screen.getByText(/Your trip is confirmed/i)).toBeTruthy();

    // create-payment-order was called with kind: advance.
    const orderCall = fetchSpy.mock.calls.find(
      (c) => c[1]?.method === 'POST' && c[0].endsWith('/create-payment-order'),
    );
    expect(JSON.parse(orderCall[1].body).kind).toBe('advance');

    // verify-payment was called with the signed Razorpay fields.
    const verifyCall = fetchSpy.mock.calls.find(
      (c) => c[1]?.method === 'POST' && c[0].endsWith('/verify-payment'),
    );
    const vbody = JSON.parse(verifyCall[1].body);
    expect(vbody.razorpay_order_id).toBe('order_test_1');
    expect(vbody.razorpay_payment_id).toBe('pay_test_1');
    expect(vbody.razorpay_signature).toBe('sig_test_1');

    // No demo record-advance-payment call — the dummy path is gone.
    const demoCall = fetchSpy.mock.calls.find((c) => c[0].endsWith('/record-advance-payment'));
    expect(demoCall).toBeUndefined();
  });

  it('shows balance-pay CTA after advance is recorded', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url.startsWith('/api/travel/itineraries/public/')) return ok(ADVANCE_PAID_ITINERARY);
      return ok({});
    });
    renderTrip();
    await screen.findByText(/Advance received/i);
    const balBtn = screen.getByRole('button', { name: /Pay balance/i });
    expect(balBtn.textContent).toMatch(/50,000/);
  });

  it('renders a fully-paid success state with no Pay buttons', async () => {
    fetchSpy.mockImplementation(() => ok(FULLY_PAID_ITINERARY));
    renderTrip();
    await screen.findByText(/Fully paid\./i);
    expect(screen.queryByRole('button', { name: /Pay /i })).toBeNull();
  });

  it('surfaces a payment error and stays on the form when order creation fails', async () => {
    installRazorpaySuccess();
    let getCalls = 0;
    fetchSpy.mockImplementation((url, opts) => {
      if (url.startsWith('/api/travel/itineraries/public/') && !opts) {
        getCalls += 1;
        return ok(SENT_ITINERARY);
      }
      if (opts?.method === 'POST' && url.endsWith('/create-payment-order')) {
        return fail(503, { error: 'Online payment is not configured', code: 'GATEWAY_NOT_CONFIGURED' });
      }
      return ok({});
    });
    renderTrip();
    const payBtn = await screen.findByRole('button', { name: /Pay 50% to confirm/i });
    fireEvent.click(payBtn);
    await screen.findByRole('alert');
    expect(screen.getByText(/not configured/i)).toBeTruthy();
    // Still on the form (no advance-received success state).
    expect(screen.queryByText(/Advance received/i)).toBeNull();
    // GET only called once (the initial load — no reload on pay-error).
    expect(getCalls).toBe(1);
  });

  it('PDF download link renders when pdfUrl is set', async () => {
    fetchSpy.mockImplementation(() => ok(SENT_ITINERARY));
    renderTrip();
    const link = await screen.findByRole('link', { name: /Download itinerary PDF/i });
    expect(link).toHaveAttribute('href', '/uploads/itineraries/itin-1.pdf');
  });
});
