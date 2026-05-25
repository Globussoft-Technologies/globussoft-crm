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
 * D17 Arc 1 slice 3 scope (this extension): pins the items picker
 * autocomplete (DD-5.2 → autocomplete, not modal, not sidebar drawer)
 * per PRD §3.4. The picker fans out parallel fetches to
 * /api/wellness/services + /api/wellness/products on a 300ms debounce,
 * surfaces a grouped dropdown (services + products), appends a basket
 * line on selection, and exposes row-level qty +/- buttons that
 * recompute lineTotal in place.
 *
 * Slice 3 pinned invariants:
 *   5. Typing in the items input fires parallel /services + /products
 *      fetches after the 300ms debounce (not before).
 *   6. Selecting an autocomplete result appends a line to the basket
 *      pre-filled from the catalogue (refId, name, unitPrice).
 *   7. qty +/- buttons update lineTotal correctly (qty × unitPrice).
 *   8. Empty input does not fire fetches; results are cleared.
 *
 * Slices 4-7 (payment splitter, atomic finalize, receipt, void/refund,
 * etc.) will extend this file as they land.
 *
 * Discipline (per CLAUDE.md standing rules):
 *   - Stable mock object refs for useNotify so useCallback-dep recomputes
 *     don't loop. notifyObj is module-scoped + reused across tests.
 *   - findByText / waitFor for async data-dependent text.
 *   - MemoryRouter with initialEntries to seed `?tab=…` URL state.
 *   - vi.useFakeTimers() for the 300ms-debounce assertions so we don't
 *     pay 300ms of real wall-clock per case.
 */
import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('<wellness/PointOfSale /> — D17 Arc 1 slice 3 items picker autocomplete', () => {
  // Slice 3 cases assume an OPEN shift so the basket-bearing builder
  // surface (incl. the items picker card) is rendered. The fetch mock
  // returns sampleServices + sampleProducts for the catalogue endpoints.
  const sampleServices = [
    { id: 21, name: 'Hydrafacial Deluxe', category: 'skin', basePrice: 3500, durationMin: 60 },
    { id: 22, name: 'Laser Hair Removal', category: 'aesthetics', basePrice: 8000, durationMin: 45 },
    { id: 23, name: 'Botox Touch-up', category: 'aesthetics', basePrice: 12000, durationMin: 30 },
  ];
  const sampleProducts = [
    { id: 41, name: 'Hyaluronic Acid Serum', sku: 'HAS-30ML', currentStock: 12, price: 1800 },
    { id: 42, name: 'Sunscreen SPF 50', sku: 'SUN-100', currentStock: 0, price: 950 },
  ];

  function slice3Fetch(url) {
    if (typeof url === 'string') {
      if (url.startsWith('/api/pos/registers')) {
        return Promise.resolve([{ id: 1, name: 'Front Desk', location: { name: 'Main' } }]);
      }
      if (url.startsWith('/api/pos/shifts/current')) {
        return Promise.resolve({
          id: 99,
          registerId: 1,
          openingFloat: 500,
          register: { id: 1, name: 'Front Desk', location: { name: 'Main' } },
        });
      }
      if (url.startsWith('/api/wellness/services')) {
        return Promise.resolve(sampleServices);
      }
      if (url.startsWith('/api/wellness/products')) {
        return Promise.resolve(sampleProducts);
      }
    }
    return Promise.resolve(null);
  }

  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(slice3Fetch);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('typing in the items input fires parallel /services + /products fetches after the 300ms debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPOS();
    // Wait for the open-shift surface to render (drives the items picker
    // card into the DOM).
    await waitFor(() => {
      expect(screen.getByTestId('pos-items-search-input')).toBeInTheDocument();
    });
    // Clear initial mount calls so we can assert only the debounced fans.
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(slice3Fetch);

    const input = screen.getByTestId('pos-items-search-input');
    fireEvent.change(input, { target: { value: 'hydra' } });

    // Pre-debounce: no fetches yet.
    expect(
      fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && (u.startsWith('/api/wellness/services?q=') || u.startsWith('/api/wellness/products?q=')),
      ),
    ).toBeFalsy();

    // Advance past the 300ms debounce window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    // Both parallel fetches fired.
    const servicesCall = fetchApiMock.mock.calls.find(([u]) =>
      typeof u === 'string' && u.startsWith('/api/wellness/services?q=hydra'),
    );
    const productsCall = fetchApiMock.mock.calls.find(([u]) =>
      typeof u === 'string' && u.startsWith('/api/wellness/products?q=hydra'),
    );
    expect(servicesCall).toBeTruthy();
    expect(productsCall).toBeTruthy();

    // Drop fake timers so findByText doesn't stall on promise microtasks.
    vi.useRealTimers();
    // Dropdown renders the filtered service (case-insensitive `includes`
    // catches "Hydrafacial Deluxe").
    expect(await screen.findByText('Hydrafacial Deluxe')).toBeInTheDocument();
    // Product matches "hydra" too — Hyaluronic Acid Serum does NOT,
    // but "hydra" only matches the service so the products group is
    // empty for this query.
    expect(screen.queryByText('Hyaluronic Acid Serum')).not.toBeInTheDocument();
  });

  it('selecting an autocomplete result appends a basket line pre-filled from the catalogue', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-items-search-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('pos-items-search-input'), { target: { value: 'serum' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    vi.useRealTimers();

    // "serum" matches the Hyaluronic Acid Serum product (case-insensitive).
    const productBtn = await screen.findByTestId('pos-items-result-product-41');
    expect(productBtn).toBeInTheDocument();
    fireEvent.click(productBtn);

    // Toast fired naming the catalogue item.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Added Hyaluronic Acid Serum/i),
      );
    });
    // Basket header reflects the new line count.
    expect(await screen.findByText(/Current sale \(1 line\)/i)).toBeInTheDocument();
    // Catalogue price (1800) flowed through into the line — formatMoney
    // mock renders "₹1800.00".
    expect(screen.getByTestId('pos-line-total-0')).toHaveTextContent('₹1800.00');
    // Dropdown collapsed + input cleared.
    expect(screen.queryByTestId('pos-items-dropdown')).not.toBeInTheDocument();
    expect(screen.getByTestId('pos-items-search-input')).toHaveValue('');
  });

  it('qty +/- buttons update lineTotal correctly (qty × unitPrice)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-items-search-input')).toBeInTheDocument();
    });

    // Stage a line via the picker — Hydrafacial Deluxe @ ₹3500.
    fireEvent.change(screen.getByTestId('pos-items-search-input'), { target: { value: 'hydrafacial' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    vi.useRealTimers();

    fireEvent.click(await screen.findByTestId('pos-items-result-service-21'));
    expect(await screen.findByTestId('pos-line-total-0')).toHaveTextContent('₹3500.00');

    // Increment qty — total becomes 3500 × 2 = 7000.
    const qtyCell = screen.getByTestId('pos-line-qty-0');
    const plusBtn = qtyCell.querySelector('button[aria-label^="Increase"]');
    fireEvent.click(plusBtn);
    expect(screen.getByTestId('pos-line-total-0')).toHaveTextContent('₹7000.00');

    // One more increment — total becomes 3500 × 3 = 10500.
    fireEvent.click(plusBtn);
    expect(screen.getByTestId('pos-line-total-0')).toHaveTextContent('₹10500.00');

    // Decrement once — back to 3500 × 2 = 7000.
    const minusBtn = qtyCell.querySelector('button[aria-label^="Decrease"]');
    fireEvent.click(minusBtn);
    expect(screen.getByTestId('pos-line-total-0')).toHaveTextContent('₹7000.00');

    // Floor at qty=1 — decrement twice should stop at 1, total stays 3500.
    fireEvent.click(minusBtn);
    expect(screen.getByTestId('pos-line-total-0')).toHaveTextContent('₹3500.00');
    expect(minusBtn).toBeDisabled();
  });

  it('empty input does not fire fetches and renders no dropdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-items-search-input')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(slice3Fetch);

    const input = screen.getByTestId('pos-items-search-input');
    // Type then erase — should NOT keep a dropdown open and should
    // NOT have fired any /services or /products call.
    fireEvent.change(input, { target: { value: 'hy' } });
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    // No catalogue fetches landed (empty input short-circuits the debounce).
    const catalogueCall = fetchApiMock.mock.calls.find(([u]) =>
      typeof u === 'string' && (u.startsWith('/api/wellness/services?q=') || u.startsWith('/api/wellness/products?q=')),
    );
    expect(catalogueCall).toBeFalsy();
    // Dropdown is absent when the input is empty.
    expect(screen.queryByTestId('pos-items-dropdown')).not.toBeInTheDocument();
  });
});
