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
 * D17 Arc 1 slice 4 scope (this extension): pins the payment splitter UI
 * per PRD §3.5 + DD-5.x ("one button per payment method"). The splitter
 * lets the cashier ring up a multi-tender sale (e.g. ₹500 cash + ₹2500
 * UPI for a ₹3000 invoice). 5 method buttons (Cash | Card | UPI |
 * Wallet | Gift Card) — clicking adds a new payment line with amount=0;
 * the cashier types the amount in rupees. Live Paid / Balance label
 * updates as the cashier types. Wallet button is gated on the patient's
 * walletBalanceCents (via GET /api/pos/sale-context/:patientId, tick #4
 * 617b6e26). Finalize button is gated on (basket non-empty AND
 * payments non-empty AND |sum − grandTotal| ≤ 1¢ AND non-guest
 * patient). Successful finalize POSTs the cents-native body to
 * /api/pos/sales/finalize (tick #9 93bf816b), fires notify.success
 * "Sale #N finalized", resets the draft, and dispatches a
 * window-level 'sidebar:counts-changed' CustomEvent.
 *
 * Slice 4 pinned invariants:
 *   9. Each payment method button renders + adds a payment line on click.
 *  10. Total / Paid / Balance live-updates when payment amount changes.
 *  11. Wallet button is disabled when walletBalanceCents=0 (from sale-context).
 *  12. Finalize button is disabled until items + payments sum match
 *      grandTotal; enabled when match.
 *  13. Successful finalize fires POST + notify.success + resets the draft.
 *
 * Slices 5-7 (atomic finalize, receipt, void/refund) will extend this file as they land.
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

describe('<wellness/PointOfSale /> — D17 Arc 1 slice 4 payment splitter', () => {
  // Slice 4 cases assume an OPEN shift so the basket-bearing builder
  // surface is rendered (the splitter card sits inside the open-shift
  // gate). The fetch mock returns a default walletBalanceCents per the
  // sale-context contract (tick #4 617b6e26).
  const sampleServices = [
    { id: 21, name: 'Hydrafacial Deluxe', category: 'skin', basePrice: 3500, durationMin: 60 },
  ];

  function slice4Fetch(walletBalanceCents = 0) {
    return (url, opts) => {
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
          return Promise.resolve([]);
        }
        if (url.startsWith('/api/pos/sale-context/')) {
          return Promise.resolve({
            patientId: 11,
            walletBalanceCents,
            currency: 'INR',
            activeMemberships: [],
            pendingBookings: [],
          });
        }
        if (url === '/api/pos/sales/finalize' && opts?.method === 'POST') {
          return Promise.resolve({
            success: true,
            saleId: 7777,
            invoiceId: 8888,
            grandTotalCents: 350000,
            walletDebitedCents: 0,
            status: 'PAID',
          });
        }
      }
      return Promise.resolve(null);
    };
  }

  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(slice4Fetch(0));
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Stage a basket line via the catalogue picker. Returns once the line
  // is present in the DOM. Used by tests below so each test starts with
  // a non-empty basket without re-deriving the keystroke sequence.
  async function stageOneServiceLine() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(screen.getByTestId('pos-items-search-input'), { target: { value: 'hydra' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    vi.useRealTimers();
    const btn = await screen.findByTestId('pos-items-result-service-21');
    fireEvent.click(btn);
    await screen.findByTestId('pos-line-total-0');
  }

  it('renders all 5 payment method buttons (Cash | Card | UPI | Wallet | Gift Card) + appends a payment line per click', async () => {
    fetchApiMock.mockImplementation(slice4Fetch(50000)); // ₹500 wallet so Wallet is enabled
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-payment-splitter')).toBeInTheDocument();
    });
    // All 5 method buttons present, in order.
    const cash = screen.getByTestId('pos-split-method-cash');
    const card = screen.getByTestId('pos-split-method-card');
    const upi = screen.getByTestId('pos-split-method-upi');
    const wallet = screen.getByTestId('pos-split-method-wallet');
    const gift = screen.getByTestId('pos-split-method-giftcard');
    expect(cash).toBeInTheDocument();
    expect(card).toBeInTheDocument();
    expect(upi).toBeInTheDocument();
    expect(wallet).toBeInTheDocument();
    expect(gift).toBeInTheDocument();
    // Initially no lines.
    expect(screen.queryByTestId('pos-split-line-0')).not.toBeInTheDocument();
    expect(screen.getByText(/No payment lines yet/i)).toBeInTheDocument();
    // Click Cash — line 0 appears.
    fireEvent.click(cash);
    expect(await screen.findByTestId('pos-split-line-0')).toBeInTheDocument();
    // Click UPI — line 1 appears (multi-tender split).
    fireEvent.click(upi);
    expect(await screen.findByTestId('pos-split-line-1')).toBeInTheDocument();
    // Each line has its own amount input + remove button.
    expect(screen.getByTestId('pos-split-amount-0')).toBeInTheDocument();
    expect(screen.getByTestId('pos-split-remove-0')).toBeInTheDocument();
    expect(screen.getByTestId('pos-split-amount-1')).toBeInTheDocument();
    expect(screen.getByTestId('pos-split-remove-1')).toBeInTheDocument();
  });

  it('Total / Paid / Balance live-updates as the cashier types payment amounts', async () => {
    fetchApiMock.mockImplementation(slice4Fetch(0));
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-items-search-input')).toBeInTheDocument();
    });
    await stageOneServiceLine(); // basket has 1 line @ ₹3500

    // Add a cash payment line.
    fireEvent.click(screen.getByTestId('pos-split-method-cash'));
    const amountInput = await screen.findByTestId('pos-split-amount-0');
    // Initial paid = 0, balance = 3500.
    expect(screen.getByTestId('pos-split-balance')).toHaveTextContent('₹3500.00');

    // Type 1500 — paid 1500, balance 2000.
    fireEvent.change(amountInput, { target: { value: '1500' } });
    expect(screen.getByTestId('pos-split-balance')).toHaveTextContent('₹2000.00');
    expect(screen.getByTestId('pos-split-totals')).toHaveTextContent('₹1500.00');

    // Add a UPI line + type 2000 — paid 3500, balance 0.
    fireEvent.click(screen.getByTestId('pos-split-method-upi'));
    fireEvent.change(screen.getByTestId('pos-split-amount-1'), { target: { value: '2000' } });
    expect(screen.getByTestId('pos-split-balance')).toHaveTextContent('₹0.00');
  });

  it('Wallet button is disabled when walletBalanceCents=0; enabled when balance>0', async () => {
    // Patient must be set for sale-context to fire. Default render leaves
    // patientId empty (guest off, but no id) — so the saleContext effect
    // does NOT fire and walletBalanceCents falls back to 0 → wallet
    // disabled. Then we set a patientId and the mock returns >0 → wallet
    // becomes enabled.
    fetchApiMock.mockImplementation(slice4Fetch(0));
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-payment-splitter')).toBeInTheDocument();
    });
    // With no patientId set, sale-context never fires → walletBalanceCents
    // defaults to 0 → wallet button disabled.
    expect(screen.getByTestId('pos-split-method-wallet')).toBeDisabled();
    // Cash should NOT be disabled.
    expect(screen.getByTestId('pos-split-method-cash')).not.toBeDisabled();

    // Re-render with a patientId and a balance=50000 mock.
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(slice4Fetch(50000));
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();

    // Find the Patient ID input (rendered when guestCheckout is false,
    // which is the default).
    const patientInput = screen.getByPlaceholderText('e.g. 42');
    fireEvent.change(patientInput, { target: { value: '11' } });
    // sale-context fetch fires; once it resolves, wallet becomes enabled.
    await waitFor(() => {
      expect(screen.getByTestId('pos-split-method-wallet')).not.toBeDisabled();
    });
    // Wallet balance label reflects the new balance.
    expect(screen.getByTestId('pos-split-wallet-balance-hint')).toHaveTextContent('₹500.00');
  });

  it('Finalize button is disabled until items + payments sum match grandTotal; enabled when match', async () => {
    fetchApiMock.mockImplementation(slice4Fetch(0));
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-items-search-input')).toBeInTheDocument();
    });
    // 1) Empty basket → finalize disabled.
    expect(screen.getByTestId('pos-split-finalize')).toBeDisabled();

    // 2) Stage one basket line @ ₹3500. Still disabled (no payments, no patient).
    await stageOneServiceLine();
    expect(screen.getByTestId('pos-split-finalize')).toBeDisabled();

    // 3) Add a cash payment of 3500. Still disabled (no patient).
    fireEvent.click(screen.getByTestId('pos-split-method-cash'));
    fireEvent.change(screen.getByTestId('pos-split-amount-0'), { target: { value: '3500' } });
    expect(screen.getByTestId('pos-split-finalize')).toBeDisabled();

    // 4) Set a patientId — finalize becomes enabled (matched + patient set).
    fireEvent.change(screen.getByPlaceholderText('e.g. 42'), { target: { value: '11' } });
    await waitFor(() => {
      expect(screen.getByTestId('pos-split-finalize')).not.toBeDisabled();
    });

    // 5) Bump payment amount past the target → mismatch > 1¢ → disabled again.
    fireEvent.change(screen.getByTestId('pos-split-amount-0'), { target: { value: '4000' } });
    expect(screen.getByTestId('pos-split-finalize')).toBeDisabled();

    // 6) Bring it back into 1¢ tolerance.
    fireEvent.change(screen.getByTestId('pos-split-amount-0'), { target: { value: '3500' } });
    await waitFor(() => {
      expect(screen.getByTestId('pos-split-finalize')).not.toBeDisabled();
    });
  });

  it('successful finalize POSTs cents-native body, fires notify.success "Sale #N finalized", resets draft, dispatches sidebar:counts-changed', async () => {
    fetchApiMock.mockImplementation(slice4Fetch(0));
    renderPOS();
    await waitFor(() => {
      expect(screen.getByTestId('pos-items-search-input')).toBeInTheDocument();
    });
    await stageOneServiceLine(); // ₹3500
    fireEvent.click(screen.getByTestId('pos-split-method-cash'));
    fireEvent.change(screen.getByTestId('pos-split-amount-0'), { target: { value: '3500' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 42'), { target: { value: '11' } });
    await waitFor(() => {
      expect(screen.getByTestId('pos-split-finalize')).not.toBeDisabled();
    });

    // Listen for the sidebar event the finalize should dispatch.
    const sidebarListener = vi.fn();
    window.addEventListener('sidebar:counts-changed', sidebarListener);

    fireEvent.click(screen.getByTestId('pos-split-finalize'));

    // Assert the POST landed with the cents-native body.
    await waitFor(() => {
      const finalizeCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/pos/sales/finalize' && o?.method === 'POST',
      );
      expect(finalizeCall).toBeTruthy();
      const body = JSON.parse(finalizeCall[1].body);
      expect(body.patientId).toBe(11);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        type: 'service',
        refId: 21,
        qty: 1,
        unitPriceCents: 350000,
      });
      expect(body.payments).toHaveLength(1);
      expect(body.payments[0]).toMatchObject({
        method: 'cash',
        amountCents: 350000,
      });
    });

    // Success toast with the saleId from the mock.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Sale #7777 finalized/i));
    });

    // Draft reset — payment line gone, basket cleared, patient cleared.
    await waitFor(() => {
      expect(screen.queryByTestId('pos-split-line-0')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('pos-line-total-0')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. 42')).toHaveValue(null);

    // Sidebar event fired.
    expect(sidebarListener).toHaveBeenCalled();

    window.removeEventListener('sidebar:counts-changed', sidebarListener);
  });
});
