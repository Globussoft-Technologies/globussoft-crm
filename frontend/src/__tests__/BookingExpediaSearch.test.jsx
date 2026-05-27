/**
 * BookingExpediaSearch.test.jsx — vitest + RTL coverage for the admin
 * Booking.com / Expedia hotel-search page (frontend/src/pages/admin/
 * BookingExpediaSearch.jsx, shipped tick #106 commit 7a95d74; retrofitted
 * tick #107 commit 93acf61 to consume the shared CapBanners components).
 *
 * Scope — pins the page-surface invariants:
 *   1. Page chrome — heading "Booking.com / Expedia" + cap pill in header.
 *      Pill renders on BOTH paths (Phase-2-pending AND live) because the
 *      shared cap helper is wired today even though the Expedia code paths
 *      403 / 503 on the backend.
 *   2. Phase-2-pending mount default (CRITICAL) — when GET /enabled rejects
 *      (404 = endpoint doesn't exist yet) OR resolves to { enabled: false },
 *      the page renders the Phase-2-pending full-page state with the
 *      pre-configuration CTA links to /admin/tenant-settings + /admin/
 *      brand-kits. The Phase-2-pending banner mentions Q11 + Booking.com /
 *      Expedia vendor handover.
 *   3. "Show search form anyway" toggle — clicking the ghost button reveals
 *      the search form despite Phase-2-pending state (so QA can exercise
 *      the 503 path against the real backend).
 *   4. Enabled branch — when GET /enabled returns { enabled: true }, the
 *      form renders as primary surface with no Phase-2-pending chrome.
 *   5. Cap-status pill — GETs /api/booking-expedia/cap-status on mount;
 *      pill renders after the GET resolves with the formatted "% of $cap/mo"
 *      copy.
 *   6. Validation — empty destination clicking Search surfaces notify.error
 *      ("Destination city is required") and does NOT fire POST /search.
 *      Uses the "Show form anyway" toggle to reach the form.
 *   7. Search happy path (Booking-direct provider) — POSTs /api/booking-
 *      expedia/search with the form payload + renders the stub-mode banner
 *      and search-summary row (Phase 1 reality per Q-cluster B6/C cred
 *      blocker).
 *   8. Expedia 503 graceful degradation — when provider=expedia, POST
 *      returns 503 EXPEDIA_NOT_YET_ENABLED; page swallows via notify.info
 *      (NOT notify.error) explaining DC-4 + Q11 + clears searchResult; no
 *      generic 503 error toast.
 *   9. Cap-exceeded on search — POST returns 402 BOOKING_EXPEDIA_BUDGET_
 *      EXCEEDED → CapExceededBanner renders with provider "Booking/Expedia"
 *      + spent/cap cents; empty-state card not shown.
 *  10. 500 generic error on search — notify.error fires with the server-
 *      supplied body.error; no search-summary card renders.
 *  11. Sub-brand badge in summary — uses the REAL travelSubBrand helper so
 *      SUB_BRAND_LABEL drift is caught by the suite (subBrandLabel("tmc")
 *      → "TMC (School trips)").
 *
 * Backend contract pinned (per backend/routes/booking_expedia.js):
 *   POST /api/booking-expedia/search { provider, destinationCity, checkIn,
 *         checkOut, guests, rooms, subBrand? } → 200 stub-mode | 402
 *         BOOKING_EXPEDIA_BUDGET_EXCEEDED | 503 EXPEDIA_NOT_YET_ENABLED
 *   GET  /api/booking-expedia/cap-status → 200 cap data | 402 over-cap body
 *         | 403 MANAGER (swallowed silently)
 *   GET  /api/booking-expedia/enabled → does NOT exist today (404). Page
 *         treats any non-{enabled:true} response as Phase-2-pending.
 *
 * Why
 *   The page is unique among the 4 cap-consumer admin surfaces because
 *   it defaults to a Phase-2-pending full-page state — most operators
 *   landing here will see the pre-config CTAs, NOT the search form. The
 *   "Show form anyway" toggle is the QA escape hatch that exercises the
 *   stub + 503 paths. Two contracts are uniquely load-bearing here:
 *   (a) the 503 EXPEDIA_NOT_YET_ENABLED → notify.info graceful path
 *   (versus an "Expedia is broken" red toast that would mislead ops);
 *   (b) the Phase-2-pending banner pointing operators at the cap +
 *   brand-kit readiness surfaces so when creds + Q11 land the page
 *   activates with zero further changes.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dependency, NOT global
 *     fetch). Per-call routing by URL + method so happy-path / 402 / 503
 *     / 500 paths can be exercised without re-stubbing the entire surface.
 *   - useNotify returns a STABLE notifyObj — single reference for the file
 *     (RTL standing rule: fresh per-call objects cause infinite-render
 *     loops on pages that put notify into a useCallback dep array).
 *   - travelSubBrand is imported real (not mocked) so SUB_BRAND_IDS /
 *     SUB_BRAND_LABEL drift is caught by the suite.
 *   - CapBanners is imported real (not mocked) so the SUT's testid
 *     contract is exercised end-to-end through the shared component.
 *   - Date inputs default to dynamic values from the SUT; happy-path
 *     tests do not pin checkIn/checkOut strings (the SUT default of
 *     +7d / +10d is itself dynamic — we let the page-default flow).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside runSearch, so a fresh
// object per render would flap state across re-renders.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import BookingExpediaSearch from '../pages/admin/BookingExpediaSearch';

// Canonical cap-status response — within cap, no alert threshold.
const CAP_STATUS_OK = {
  spentCents: 0,
  capCents: 15000,
  percent: 0,
  withinCap: true,
  alertThreshold: false,
};

// Stub-mode search response (Phase 1 reality per Q-cluster B6/C cred
// blocker on Booking-direct path).
function makeSearchResponse(overrides = {}) {
  return {
    stub: true,
    tenantId: 1,
    subBrand: null,
    provider: 'booking',
    destinationCity: 'Mecca',
    checkInDate: '2026-06-15',
    checkOutDate: '2026-06-18',
    guests: 2,
    rooms: 1,
    hotels: [],
    note: 'Stub mode — Booking.com partner credentials pending (Q-cluster B6/C).',
    ...overrides,
  };
}

// Helper: install a fetchApi mock that routes by URL+method. The /enabled
// endpoint defaults to a rejected 404 (matching today's backend reality —
// the route doesn't exist yet, so the SUT stays in Phase-2-pending). Tests
// that want the live path opt-in via { enabled: { enabled: true, phase: 1 } }.
function installFetchMock({
  enabled = '__404__',
  capStatus = CAP_STATUS_OK,
  search = makeSearchResponse(),
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/booking-expedia/enabled' && (!opts || !opts.method || opts.method === 'GET')) {
      if (enabled === '__404__') {
        const err = new Error('Not Found');
        err.status = 404;
        return Promise.reject(err);
      }
      if (enabled instanceof Error) return Promise.reject(enabled);
      return Promise.resolve(enabled);
    }
    if (url === '/api/booking-expedia/cap-status' && (!opts || !opts.method || opts.method === 'GET')) {
      if (capStatus instanceof Error) return Promise.reject(capStatus);
      return Promise.resolve(capStatus);
    }
    if (url === '/api/booking-expedia/search' && opts?.method === 'POST') {
      if (search instanceof Error) return Promise.reject(search);
      return Promise.resolve(search);
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <BookingExpediaSearch />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

describe('<BookingExpediaSearch /> — operator-facing Booking.com / Expedia search page', () => {
  it('renders heading + cap pill in header on mount', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Booking\.com \/ Expedia/i }),
    ).toBeInTheDocument();
    // Cap pill renders after the cap-status GET resolves.
    const pill = await screen.findByTestId('booking-expedia-cap-pill');
    expect(pill).toBeInTheDocument();
    expect(pill.textContent).toMatch(/of \$150\/mo cap/);
  });

  it('Phase-2-pending: when /enabled rejects (404), the pending full-page state renders with CTA links', async () => {
    renderPage();
    // Pending state renders after the /enabled GET settles into the
    // catch-branch (default-deny on rejection per the SUT contract).
    const pending = await screen.findByTestId('booking-expedia-phase2-pending-state');
    expect(pending.textContent).toMatch(/Booking\.com \/ Expedia integration — Phase 2/);
    expect(pending.textContent).toMatch(/Q11/);
    expect(pending.textContent).toMatch(/vendor handover/i);
    // CTA links route to the readiness surfaces.
    const tenantLink = screen.getByTestId('booking-expedia-tenant-settings-link');
    expect(tenantLink.getAttribute('href')).toBe('/admin/tenant-settings');
    const brandLink = screen.getByTestId('booking-expedia-brand-kits-link');
    expect(brandLink.getAttribute('href')).toBe('/admin/brand-kits');
    // "Show form anyway" ghost button is offered as the QA escape hatch.
    expect(screen.getByTestId('booking-expedia-show-form-btn')).toBeInTheDocument();
    // The search form is NOT rendered on the pending path (form is gated
    // by `!inPhase2Pending || showFormAnyway`).
    expect(screen.queryByTestId('booking-expedia-search-btn')).toBeNull();
  });

  it('Phase-2-pending: when /enabled resolves to { enabled: false }, the pending state still renders', async () => {
    installFetchMock({ enabled: { enabled: false, phase: 2 } });
    renderPage();
    const pending = await screen.findByTestId('booking-expedia-phase2-pending-state');
    expect(pending).toBeInTheDocument();
    expect(pending.textContent).toMatch(/Phase 2/);
  });

  it('"Show form anyway" toggle reveals the search form despite Phase-2-pending state', async () => {
    renderPage();
    // Wait for pending state to mount.
    const showBtn = await screen.findByTestId('booking-expedia-show-form-btn');
    fireEvent.click(showBtn);
    // Now the search form is exposed — search button + filter inputs are
    // findable (the pending state collapses on showFormAnyway=true).
    await waitFor(() => {
      expect(screen.queryByTestId('booking-expedia-phase2-pending-state')).toBeNull();
    });
    expect(screen.getByTestId('booking-expedia-search-btn')).toBeInTheDocument();
    expect(screen.getByTestId('booking-expedia-filter-destination')).toBeInTheDocument();
    expect(screen.getByTestId('booking-expedia-filter-provider')).toBeInTheDocument();
  });

  it('Enabled branch: when /enabled returns { enabled: true }, search form renders as primary surface (no Phase-2 chrome)', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    // Wait for the search form to render (form gates on !inPhase2Pending).
    const searchBtn = await screen.findByTestId('booking-expedia-search-btn');
    expect(searchBtn).toBeInTheDocument();
    // Phase-2-pending chrome is NOT present.
    expect(screen.queryByTestId('booking-expedia-phase2-pending-state')).toBeNull();
    // Cap pill still renders.
    expect(await screen.findByTestId('booking-expedia-cap-pill')).toBeInTheDocument();
  });

  it('validation: empty destination → notify.error fires, no POST is sent', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    // Wait for form to render.
    const searchBtn = await screen.findByTestId('booking-expedia-search-btn');
    fetchApiMock.mockClear();
    fireEvent.click(searchBtn);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Destination city is required');
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/booking-expedia/search' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('search happy path (Booking-direct): POSTs form payload + renders stub banner + summary row', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Mecca' },
    });
    // Pin fixed-string dates per CLAUDE.md cron-learning 2026-05-07 wave-9
    // (TZ-window flake-class avoidance on date-boundary helpers).
    fireEvent.change(screen.getByTestId('booking-expedia-filter-checkin'), {
      target: { value: '2026-06-15' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-checkout'), {
      target: { value: '2026-06-18' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/booking-expedia/search' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.provider).toBe('booking');
      expect(body.destinationCity).toBe('Mecca');
      expect(body.checkInDate).toBe('2026-06-15');
      expect(body.checkOutDate).toBe('2026-06-18');
      expect(body.guests).toBe(2);
      expect(body.rooms).toBe(1);
      // subBrand left as "" → key omitted from POST body.
      expect(body.subBrand).toBeUndefined();
    });
    // Stub banner + summary card both render post-response.
    expect(await screen.findByTestId('booking-expedia-stub-banner')).toBeInTheDocument();
    expect(await screen.findByTestId('booking-expedia-search-summary')).toBeInTheDocument();
  });

  it('Expedia 503 graceful: provider=expedia → notify.info fires (NOT notify.error), searchResult cleared', async () => {
    const err = new Error('Expedia disabled');
    err.status = 503;
    err.body = {
      error: 'Expedia integration not yet enabled — pending DC-4 demand threshold',
      code: 'EXPEDIA_NOT_YET_ENABLED',
    };
    installFetchMock({ enabled: { enabled: true, phase: 1 }, search: err });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    // Switch provider to expedia.
    fireEvent.change(screen.getByTestId('booking-expedia-filter-provider'), {
      target: { value: 'expedia' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalled();
    });
    const infoMsg = notifyInfo.mock.calls[0][0];
    expect(infoMsg).toMatch(/Expedia is Phase 2/i);
    expect(infoMsg).toMatch(/DC-4/);
    expect(infoMsg).toMatch(/Q11/);
    // CRITICAL: notify.error is NOT called — the 503 is a deferred-by-design
    // path, not a runtime error, so no red toast.
    expect(notifyError).not.toHaveBeenCalled();
    // No search-summary card — searchResult was cleared.
    expect(screen.queryByTestId('booking-expedia-search-summary')).toBeNull();
  });

  it('search 402 cap-exceeded → CapExceededBanner renders with provider "Booking/Expedia" + cents pair', async () => {
    const err = new Error('Cap exceeded');
    err.status = 402;
    err.body = {
      error: 'monthly cap exceeded',
      code: 'BOOKING_EXPEDIA_BUDGET_EXCEEDED',
      spentCents: 16000,
      capCents: 15000,
    };
    installFetchMock({ enabled: { enabled: true, phase: 1 }, search: err });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    const banner = await screen.findByTestId('booking-expedia-cap-exceeded-banner');
    expect(banner.textContent).toMatch(/Monthly Booking\/Expedia cap reached/i);
    expect(banner.textContent).toMatch(/\$160 \/ \$150/);
    // Empty-state card is NOT shown when capExceeded is set.
    expect(screen.queryByTestId('booking-expedia-empty-state')).toBeNull();
    // No global error toast — banner is the surface.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('search 500 generic error → notify.error fires with server-supplied message', async () => {
    const err = new Error('boom');
    err.status = 500;
    err.body = { error: 'Booking client crashed' };
    installFetchMock({ enabled: { enabled: true, phase: 1 }, search: err });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Booking client crashed');
    });
    expect(screen.queryByTestId('booking-expedia-search-summary')).toBeNull();
    expect(screen.queryByTestId('booking-expedia-cap-exceeded-banner')).toBeNull();
  });

  it('summary row renders friendly sub-brand label via real travelSubBrand helper', async () => {
    // Real travelSubBrand: subBrandLabel("tmc") → "TMC (School trips)".
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      search: makeSearchResponse({ subBrand: 'tmc', destinationCity: 'Mecca' }),
    });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Mecca' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-subbrand'), {
      target: { value: 'tmc' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    const summary = await screen.findByTestId('booking-expedia-search-summary');
    expect(summary.textContent).toMatch(/TMC \(School trips\)/);
  });

  // ════════════════════════════════════════════════════════════════════════
  // Extension batch — tick #N+1, +14 new cases. Targets unexplored surfaces:
  //   - filter input wiring (provider / subBrand / guests / rooms / dates)
  //   - hotel card render contract (name / price / star / address / hotelId)
  //   - "no hotels returned" empty card vs "no search yet" empty card
  //   - search summary chip wiring (guests/rooms/destination/dates fallbacks)
  //   - loading-state surface during in-flight POST (button label + card)
  //   - cap-status 402 → pill flips to over-cap red branch (100%)
  //   - cap-status 403 (MANAGER) → silent swallow, no pill, no error toast
  //   - empty checkin / checkout validation paths
  //   - search default-values fallback (guests='' → 2, rooms='' → 1)
  //   - capExceeded cleared on subsequent successful search
  //   - subBrand omitted from body when "" (the all-sub-brands sentinel)
  // ════════════════════════════════════════════════════════════════════════

  it('filter inputs are wired: typing destination/guests/rooms reflects in the POST body', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');

    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Bangkok' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-guests'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-rooms'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/booking-expedia/search' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.destinationCity).toBe('Bangkok');
      expect(body.guests).toBe(5);
      expect(body.rooms).toBe(3);
    });
  });

  it('search includes subBrand in body when filter is set (non-empty value)', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');

    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Mecca' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-subbrand'), {
      target: { value: 'rfu' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/booking-expedia/search' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.subBrand).toBe('rfu');
    });
  });

  it('empty checkin date → notify.error fires with checkin-specific message, no POST sent', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    // Set destination so we get past the first guard, then blank check-in.
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-checkin'), {
      target: { value: '' },
    });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Check-in date is required');
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/booking-expedia/search' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('empty checkout date → notify.error fires with checkout-specific message, no POST sent', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-checkout'), {
      target: { value: '' },
    });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Check-out date is required');
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/booking-expedia/search' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('guests and rooms default to 2 / 1 when fields are non-numeric (fallback via Number(...) || N)', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');

    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });
    // The number input bound to setGuests(e.target.value) can hold "" when
    // cleared. The SUT applies `Number(guests) || 2` so blank → 2.
    fireEvent.change(screen.getByTestId('booking-expedia-filter-guests'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByTestId('booking-expedia-filter-rooms'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/booking-expedia/search' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.guests).toBe(2);
      expect(body.rooms).toBe(1);
    });
  });

  it('hotel list renders one HotelCard per result with name + price + star + address + id', async () => {
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      search: makeSearchResponse({
        stub: false,
        destinationCity: 'Mecca',
        hotels: [
          {
            hotelId: 'BK-HOT-001',
            name: 'Makkah Royal Tower',
            address: 'King Abdul Aziz Rd, Mecca',
            starRating: 4.7,
            priceFromCents: 35000,
            currency: 'USD',
          },
          {
            hotelId: 'BK-HOT-002',
            name: 'Hilton Suites Mecca',
            address: 'Ajyad St, Mecca',
            starRating: 4.2,
            priceFromCents: 22500,
            currency: 'USD',
          },
        ],
      }),
    });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Mecca' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    // List wrapper + cards count.
    const list = await screen.findByTestId('booking-expedia-hotel-list');
    expect(list).toBeInTheDocument();
    const cards = screen.getAllByTestId('booking-expedia-hotel-card');
    expect(cards.length).toBe(2);

    // First card contents.
    expect(cards[0].textContent).toMatch(/Makkah Royal Tower/);
    expect(cards[0].textContent).toMatch(/King Abdul Aziz Rd, Mecca/);
    expect(cards[0].textContent).toMatch(/4\.7★/);
    expect(cards[0].textContent).toMatch(/BK-HOT-001/);
    // formatMoney("USD") output — we only pin the dollar sign + integer.
    expect(cards[0].textContent).toMatch(/\$350/);

    // Second card contents.
    expect(cards[1].textContent).toMatch(/Hilton Suites Mecca/);
    expect(cards[1].textContent).toMatch(/4\.2★/);
    expect(cards[1].textContent).toMatch(/\$225/);

    // Hotel list shown ⇒ "no hotels" card NOT rendered.
    expect(screen.queryByTestId('booking-expedia-no-hotels')).toBeNull();
  });

  it('zero-hotel search result shows "no hotels returned" card (NOT the pre-search empty-state card)', async () => {
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      search: makeSearchResponse({ stub: false, hotels: [] }),
    });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Mecca' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    const noHotels = await screen.findByTestId('booking-expedia-no-hotels');
    expect(noHotels.textContent).toMatch(/No hotels returned/i);
    // Pre-search empty-state card replaced by the post-search "no hotels" card.
    expect(screen.queryByTestId('booking-expedia-empty-state')).toBeNull();
    // 0 hotels in summary count.
    const summary = await screen.findByTestId('booking-expedia-search-summary');
    expect(summary.textContent).toMatch(/0 hotels returned/);
  });

  it('stub-mode no-hotels card includes "expected in stub mode" annotation', async () => {
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      search: makeSearchResponse({ stub: true, hotels: [] }),
    });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Mecca' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    const noHotels = await screen.findByTestId('booking-expedia-no-hotels');
    expect(noHotels.textContent).toMatch(/expected in stub mode/i);
  });

  it('search summary chips render destination + dates + guests + rooms from server echo', async () => {
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      search: makeSearchResponse({
        destinationCity: 'Bangkok',
        checkInDate: '2026-07-01',
        checkOutDate: '2026-07-05',
        guests: 4,
        rooms: 2,
      }),
    });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Bangkok' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    const summary = await screen.findByTestId('booking-expedia-search-summary');
    expect(summary.textContent).toMatch(/Bangkok/);
    expect(summary.textContent).toMatch(/2026-07-01/);
    expect(summary.textContent).toMatch(/2026-07-05/);
    expect(summary.textContent).toMatch(/4 guests/);
    expect(summary.textContent).toMatch(/2 rooms/);
  });

  it('search "note" string renders below results when backend provides it', async () => {
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      search: makeSearchResponse({
        note: 'Stub mode — Booking.com partner credentials pending (Q-cluster B6/C).',
        hotels: [],
      }),
    });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Mecca' },
    });
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));

    await screen.findByTestId('booking-expedia-search-summary');
    // The note paragraph is plain text (no testid) — assert via text query.
    expect(
      screen.getByText(/Stub mode — Booking\.com partner credentials pending/i),
    ).toBeInTheDocument();
  });

  it('search button shows "Searching…" label and is disabled while POST is in flight', async () => {
    // Hold the search response open so the "searching" state is observable.
    let resolveSearch;
    const searchPromise = new Promise((res) => {
      resolveSearch = res;
    });
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/booking-expedia/enabled') {
        return Promise.resolve({ enabled: true, phase: 1 });
      }
      if (url === '/api/booking-expedia/cap-status') {
        return Promise.resolve(CAP_STATUS_OK);
      }
      if (url === '/api/booking-expedia/search' && opts?.method === 'POST') {
        return searchPromise;
      }
      return Promise.resolve(null);
    });
    renderPage();
    const btn = await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.click(btn);

    // While in flight: disabled + "Searching…" label.
    await waitFor(() => {
      expect(btn).toBeDisabled();
      expect(btn.textContent).toMatch(/Searching/);
    });

    // Resolve to clean up the suspended promise.
    resolveSearch(makeSearchResponse({ hotels: [] }));
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
  });

  it('cap-status pill flips to red over-cap branch when GET resolves rejected with 402', async () => {
    const overCapErr = new Error('Over cap');
    overCapErr.status = 402;
    overCapErr.body = {
      error: 'cap exceeded',
      code: 'BOOKING_EXPEDIA_BUDGET_EXCEEDED',
      spentCents: 16500,
      capCents: 15000,
    };
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      capStatus: overCapErr,
    });
    renderPage();
    const pill = await screen.findByTestId('booking-expedia-cap-pill');
    // Over-cap branch: percent surfaced as 100% per the SUT (percent: 1).
    expect(pill.textContent).toMatch(/100% of \$150\/mo cap/);
    // No notify.error — over-cap on the GET is a known terminal state.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('cap-status 403 (MANAGER) is silently swallowed: no pill renders, no toast fires', async () => {
    const forbiddenErr = new Error('Forbidden');
    forbiddenErr.status = 403;
    forbiddenErr.body = { error: 'ADMIN_ONLY' };
    installFetchMock({
      enabled: { enabled: true, phase: 1 },
      capStatus: forbiddenErr,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderPage();
    // Wait for the page to settle (search form rendered = mount effects done).
    await screen.findByTestId('booking-expedia-search-btn');
    // Pill is NEVER rendered for MANAGER (403 is the silent path).
    expect(screen.queryByTestId('booking-expedia-cap-pill')).toBeNull();
    // No error toast; the SUT's silent-403 branch suppresses console.warn too.
    expect(notifyError).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('subsequent successful search clears prior 402 capExceeded banner', async () => {
    // First POST returns 402; second POST returns a stub success → banner clears.
    const capErr = new Error('Cap exceeded');
    capErr.status = 402;
    capErr.body = {
      error: 'monthly cap exceeded',
      code: 'BOOKING_EXPEDIA_BUDGET_EXCEEDED',
      spentCents: 16000,
      capCents: 15000,
    };
    let callCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/booking-expedia/enabled') {
        return Promise.resolve({ enabled: true, phase: 1 });
      }
      if (url === '/api/booking-expedia/cap-status') {
        return Promise.resolve(CAP_STATUS_OK);
      }
      if (url === '/api/booking-expedia/search' && opts?.method === 'POST') {
        callCount += 1;
        if (callCount === 1) return Promise.reject(capErr);
        return Promise.resolve(makeSearchResponse({ hotels: [] }));
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByTestId('booking-expedia-search-btn');
    fireEvent.change(screen.getByTestId('booking-expedia-filter-destination'), {
      target: { value: 'Paris' },
    });

    // Click 1 → 402 banner.
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    expect(
      await screen.findByTestId('booking-expedia-cap-exceeded-banner'),
    ).toBeInTheDocument();

    // Click 2 → success; banner gone, summary present.
    fireEvent.click(screen.getByTestId('booking-expedia-search-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('booking-expedia-cap-exceeded-banner')).toBeNull();
    });
    expect(await screen.findByTestId('booking-expedia-search-summary')).toBeInTheDocument();
  });

  it('provider select offers both Booking (Phase 1) and Expedia (Phase 2) options', async () => {
    installFetchMock({ enabled: { enabled: true, phase: 1 } });
    renderPage();
    const select = await screen.findByTestId('booking-expedia-filter-provider');
    const options = Array.from(select.querySelectorAll('option')).map((o) => ({
      value: o.value,
      label: o.textContent,
    }));
    expect(options).toEqual([
      { value: 'booking', label: 'Booking.com (Phase 1)' },
      { value: 'expedia', label: 'Expedia (Phase 2 — pending)' },
    ]);
  });
});
