/**
 * TripBooking.jsx — public trip booking + 50%-advance flow (PRD §4.7).
 *
 * Consumes the public endpoints from commit 8abf6f3:
 *   GET  /api/travel/itineraries/public/:shareToken
 *   POST /api/travel/itineraries/public/:shareToken/record-advance-payment
 *
 * Both go through raw fetch() (page renders outside AuthContext shell),
 * so global.fetch is spied per-test. Mock objects are stable references
 * per CLAUDE.md feedback rule.
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
};

const FULLY_PAID_ITINERARY = {
  ...SENT_ITINERARY,
  status: 'fully_paid',
  advancePaid: 100000,
  advancePaidAt: '2026-05-21T10:00:00.000Z',
  balanceDue: 0,
};

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
});

const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const fail = (status, body) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });

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

  it('Pay-advance button POSTs the advanceDue amount + reload reflects new state', async () => {
    let getCalls = 0;
    fetchSpy.mockImplementation((url, opts) => {
      if (url.startsWith('/api/travel/itineraries/public/') && !opts) {
        getCalls += 1;
        // First load = sent; after pay → advance_paid.
        return ok(getCalls === 1 ? SENT_ITINERARY : ADVANCE_PAID_ITINERARY);
      }
      if (opts?.method === 'POST' && url.endsWith('/record-advance-payment')) {
        return ok({
          status: 'advance_paid',
          advancePaidAmount: 50000,
          advancePaidAt: '2026-05-21T10:00:00.000Z',
          paymentReference: 'demo_pay_x',
          balanceDue: 50000,
        });
      }
      return ok({});
    });
    renderTrip();
    const payBtn = await screen.findByRole('button', { name: /Pay 50% to confirm/i });
    fireEvent.click(payBtn);

    // Re-fetch happens → advance-paid state renders.
    await screen.findByText(/Advance received/i);
    expect(screen.getByText(/Your trip is confirmed/i)).toBeTruthy();

    // Verify POST body had advanceDue + a paymentReference.
    const postCall = fetchSpy.mock.calls.find((c) => c[1]?.method === 'POST');
    const body = JSON.parse(postCall[1].body);
    expect(body.amount).toBe(50000);
    expect(typeof body.paymentReference).toBe('string');
    expect(body.paymentReference).toMatch(/^demo_pay_/);
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

  it('surfaces a payment error and stays on the form', async () => {
    let getCalls = 0;
    fetchSpy.mockImplementation((url, opts) => {
      if (url.startsWith('/api/travel/itineraries/public/') && !opts) {
        getCalls += 1;
        return ok(SENT_ITINERARY);
      }
      if (opts?.method === 'POST' && url.endsWith('/record-advance-payment')) {
        return fail(500, { error: 'Gateway timeout. Please try again.' });
      }
      return ok({});
    });
    renderTrip();
    const payBtn = await screen.findByRole('button', { name: /Pay 50% to confirm/i });
    fireEvent.click(payBtn);
    await screen.findByRole('alert');
    expect(screen.getByText(/Gateway timeout/)).toBeTruthy();
    // Still on the form (Pay button visible, no advance-received success state).
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
