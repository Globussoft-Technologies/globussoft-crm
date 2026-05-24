/**
 * wellness/PointOfSale.test.jsx — vitest + RTL coverage for the wellness POS
 * surface (cash-and-carry checkout: shift status, new-sale builder, totals,
 * payment, wallet/gift card, manager override).
 *
 * D17 Arc 1 slice 1 scope (this file as authored): pins the new Booking |
 * Walk-in tab strip + URL-segment routing per PRD_POS_NEW_SALE.md §3 +
 * DD-5.1 (Q&A round 2). The tabs let the cashier pre-fill a sale from an
 * existing booking (Visit row — the canonical "booked appointment" in the
 * wellness model) without leaving the POS page. Walk-in is the default tab
 * (existing flow, unchanged). URL params: `?tab=booking` activates the
 * Booking tab on mount; default (no param) or `?tab=walkin` activates
 * Walk-in. Switching tabs preserves form state (basket, payment, patient).
 *
 * Pinned invariants:
 *   1. Both Booking + Walk-in tabs are reachable; Walk-in is the default.
 *   2. Clicking the Booking tab fires GET /api/wellness/visits?from=…&to=…
 *      to load today's bookings (today = local-midnight → tomorrow-midnight).
 *   3. ?tab=booking URL param activates the Booking tab on mount.
 *   4. Switching tabs does NOT reset basket / shift state — proven by
 *      opening a shift (so the basket-bearing form renders), switching to
 *      Booking + back to Walk-in, and asserting the shift card is still
 *      open.
 *
 * Slices 2-7 (items picker, payment splitter, atomic finalize, receipt,
 * void/refund, etc.) will extend this file as they land.
 *
 * Discipline (per CLAUDE.md standing rules):
 *   - Stable mock object refs for useNotify so useCallback-dep recomputes
 *     don't loop. notifyObj is module-scoped + reused across tests.
 *   - findByText / waitFor for async data-dependent text.
 *   - MemoryRouter with initialEntries to seed `?tab=…` URL state.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'fake-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// formatMoney is the page's INR formatter — stub to a stable string so
// snapshot-ish assertions against money cells stay deterministic across
// node ICU builds.
vi.mock('../../utils/money', () => ({
  formatMoney: (v) => `₹${Number(v || 0).toFixed(2)}`,
  currencySymbol: () => '₹',
}));

import PointOfSale from '../../pages/wellness/PointOfSale';
import { AuthContext } from '../../App';

// Today's bookings sample — shape mirrors /api/wellness/visits include
// (patient + service + doctor selected fields). visitDate is "today" so
// the booking-tab fetch window matches.
const todayIso = new Date().toISOString();
const sampleBookings = [
  {
    id: 101,
    visitDate: todayIso,
    status: 'BOOKED',
    patient: { id: 11, name: 'Anita Sharma', phone: '+919876543210' },
    service: { id: 21, name: 'Hydrafacial Deluxe', category: 'skin' },
    doctor: { id: 31, name: 'Dr Harsh' },
  },
  {
    id: 102,
    visitDate: todayIso,
    status: 'BOOKED',
    patient: { id: 12, name: 'Rohit Verma', phone: '+919812345678' },
    service: { id: 22, name: 'Laser Hair Removal', category: 'aesthetics' },
    doctor: { id: 31, name: 'Dr Harsh' },
  },
];

function defaultFetchMock(url) {
  if (typeof url === 'string') {
    if (url.startsWith('/api/pos/registers')) {
      return Promise.resolve([{ id: 1, name: 'Front Desk', location: { name: 'Main' } }]);
    }
    if (url.startsWith('/api/pos/shifts/current')) {
      // No open shift by default — render the open-shift card.
      return Promise.resolve(null);
    }
    if (url.startsWith('/api/wellness/visits')) {
      return Promise.resolve(sampleBookings);
    }
  }
  return Promise.resolve(null);
}

function renderPOS({ initialEntries = ['/wellness/pos'], user } = {}) {
  const authValue = {
    user: user || { id: 1, userId: 1, role: 'ADMIN', name: 'Test Admin' },
    setUser: vi.fn(),
  };
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthContext.Provider value={authValue}>
        <PointOfSale />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('<wellness/PointOfSale /> — D17 Arc 1 slice 1 Booking | Walk-in tabs', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  it('renders both Booking and Walk-in tabs; Walk-in is the default', async () => {
    renderPOS();
    // Page heading renders.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Point of Sale/i })).toBeInTheDocument();
    });
    // Both tabs reachable.
    const bookingTab = screen.getByTestId('pos-tab-booking');
    const walkinTab = screen.getByTestId('pos-tab-walkin');
    expect(bookingTab).toBeInTheDocument();
    expect(walkinTab).toBeInTheDocument();
    // Walk-in default (aria-selected=true).
    expect(walkinTab.getAttribute('aria-selected')).toBe('true');
    expect(bookingTab.getAttribute('aria-selected')).toBe('false');
    // Booking panel NOT rendered when Walk-in is active.
    expect(screen.queryByTestId('pos-booking-panel')).not.toBeInTheDocument();
    // The Walk-in's "No shift open" heading renders (shift fetch returned null).
    expect(await screen.findByText(/No shift open/i)).toBeInTheDocument();
  });

  it('clicking the Booking tab fires GET /api/wellness/visits with a today window', async () => {
    renderPOS();
    await waitFor(() => {
      expect(screen.getByText(/No shift open/i)).toBeInTheDocument();
    });
    // Clear out the initial mount calls so we can assert the booking fetch fired specifically.
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getByTestId('pos-tab-booking'));

    await waitFor(() => {
      const visitsCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/wellness/visits?'),
      );
      expect(visitsCall).toBeTruthy();
      // Today-window contract: ?from=<iso>&to=<iso> with the two ~24h apart.
      expect(visitsCall[0]).toMatch(/from=/);
      expect(visitsCall[0]).toMatch(/to=/);
    });
    // Booking panel becomes visible.
    expect(screen.getByTestId('pos-booking-panel')).toBeInTheDocument();
    // Bookings render.
    expect(await screen.findByText('Anita Sharma')).toBeInTheDocument();
    expect(screen.getByText('Hydrafacial Deluxe')).toBeInTheDocument();
  });

  it('?tab=booking URL param activates the Booking tab on mount', async () => {
    renderPOS({ initialEntries: ['/wellness/pos?tab=booking'] });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Point of Sale/i })).toBeInTheDocument();
    });
    // Booking tab is the active one on mount (aria-selected=true).
    const bookingTab = screen.getByTestId('pos-tab-booking');
    const walkinTab = screen.getByTestId('pos-tab-walkin');
    expect(bookingTab.getAttribute('aria-selected')).toBe('true');
    expect(walkinTab.getAttribute('aria-selected')).toBe('false');
    // Booking panel rendered; Walk-in's "No shift open" copy is NOT (tab gated).
    expect(screen.getByTestId('pos-booking-panel')).toBeInTheDocument();
    expect(screen.queryByText(/No shift open/i)).not.toBeInTheDocument();
    // The /visits fetch fired on mount via the booking tab.
    await waitFor(() => {
      const visitsCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/wellness/visits?'),
      );
      expect(visitsCall).toBeTruthy();
    });
  });

  it('switching tabs does not reset Walk-in form state (shift status preserved across tab flips)', async () => {
    // Seed an OPEN shift so the Walk-in tab renders the sale-builder
    // surface — the test then proves switching to Booking + back keeps
    // the shift card open (state preservation).
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/pos/shifts/current')) {
        return Promise.resolve({
          id: 99,
          registerId: 1,
          openingFloat: 500,
          register: { id: 1, name: 'Front Desk', location: { name: 'Main' } },
        });
      }
      return defaultFetchMock(url);
    });

    renderPOS();
    // Wait for the page chrome first, then for the open-shift effect to
    // settle. The shift fetch resolves async; without the second await
    // findByText may probe before the second effect tick has set
    // currentShift, which leaves only the "No shift open" copy in the
    // tree and fails this assertion.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Point of Sale/i })).toBeInTheDocument();
    });
    // The shift-open banner copy is "Shift open" inside a <strong> + the
    // register name + "opening float" sibling. "No shift open" is the
    // closed-state heading. Use the unique "opening float" sibling to
    // disambiguate.
    expect(await screen.findByText(/opening float/i)).toBeInTheDocument();

    // Switch to Booking, then back to Walk-in.
    fireEvent.click(screen.getByTestId('pos-tab-booking'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-booking-panel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('pos-tab-walkin'));

    // Shift card is still open — preservation invariant. Component did
    // NOT re-fetch / re-mount; state stayed live across the flip. Same
    // "opening float" sibling string disambiguates from the closed-state
    // heading.
    await waitFor(() => {
      expect(screen.getByText(/opening float/i)).toBeInTheDocument();
    });
    // The Booking panel is gone (tab gated).
    expect(screen.queryByTestId('pos-booking-panel')).not.toBeInTheDocument();
  });

  it('clicking "Pre-fill sale" on a booking row stages the line + switches to Walk-in', async () => {
    // Open shift so the basket-bearing flow is visible after the pre-fill.
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/pos/shifts/current')) {
        return Promise.resolve({
          id: 99,
          registerId: 1,
          openingFloat: 500,
          register: { id: 1, name: 'Front Desk', location: { name: 'Main' } },
        });
      }
      return defaultFetchMock(url);
    });

    renderPOS({ initialEntries: ['/wellness/pos?tab=booking'] });
    // Bookings render in the Booking tab.
    expect(await screen.findByText('Anita Sharma')).toBeInTheDocument();

    // Click the first "Pre-fill sale" button (Anita's row).
    const prefillBtns = screen.getAllByRole('button', { name: /Pre-fill sale from booking/i });
    expect(prefillBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(prefillBtns[0]);

    // Success toast fired naming the service.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Pre-filled Hydrafacial Deluxe from booking/i),
      );
    });
    // Auto-flipped to Walk-in — Booking panel gone, sale builder visible.
    expect(screen.queryByTestId('pos-booking-panel')).not.toBeInTheDocument();
    // The "Current sale" card now lists 1 line (the pre-filled service).
    expect(await screen.findByText(/Current sale \(1 line\)/i)).toBeInTheDocument();
    expect(screen.getByText('Hydrafacial Deluxe')).toBeInTheDocument();
  });
});
