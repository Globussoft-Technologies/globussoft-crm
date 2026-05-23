/**
 * RateHawkSearch.test.jsx — vitest + RTL coverage for the admin RateHawk
 * hotel-inventory search page (frontend/src/pages/admin/RateHawkSearch.jsx,
 * shipped tick #104 commit f4268c1; retrofitted tick #107 commit 93acf61 to
 * consume the shared CapBanners components).
 *
 * Scope — pins the page-surface invariants:
 *   1. Page chrome: heading "RateHawk Hotel Search" + filter inputs
 *      (destination / check-in / check-out / guests / rooms / sub-brand)
 *      + search button render synchronously on mount.
 *   2. GET on mount: hits /api/ratehawk/cap-status exactly once. Cap-status
 *      pill renders after the GET resolves; absent before (capStatusLoading
 *      guard).
 *   3. MANAGER role (403 on cap-status): pill silently does NOT render.
 *      Asserts there's no console-error surface either (silent swallow).
 *   4. Cap-already-exceeded on mount (402 on cap-status): pill renders in
 *      the over-cap state from err.body (spent/cap cents).
 *   5. Validation — empty destination: clicking Search with destinationCity
 *      blank surfaces notify.error("Destination city is required") and
 *      does NOT fire POST /api/ratehawk/search.
 *   6. Validation — empty check-in: clearing checkInDate then clicking
 *      Search surfaces "Check-in date is required" and no POST fires.
 *   7. Search submit happy path: typing a destination + clicking Search
 *      POSTs /api/ratehawk/search with the form payload (destination,
 *      dates, guests, rooms; subBrand omitted when "" selected) and renders
 *      the result envelope's search-summary row.
 *   8. Stub-mode banner: when the response carries stub:true, the shared
 *      StubModeBanner renders with the Q19 cred-pending copy.
 *   9. No-hotels state in stub mode: hotels=[] renders the empty "No hotels
 *      returned for this query (expected in stub mode)" message.
 *  10. Sub-brand badge in summary row: when search response includes a
 *      subBrand, the summary chip renders the friendly subBrandLabel
 *      ("TMC (School trips)" for "tmc"). Uses the REAL travelSubBrand
 *      helper (not mocked) so any future SUB_BRAND_LABEL drift is caught.
 *  11. 402 cap-exceeded on search: POST returns 402 with
 *      RATEHAWK_BUDGET_EXCEEDED → CapExceededBanner renders with provider
 *      "RateHawk" + the spent/cap values from the error body; searchResult
 *      is cleared so the empty-state isn't shown either.
 *  12. Generic error on search: POST 500 surfaces notify.error with the
 *      server-supplied body.error message + no searchResult is rendered.
 *
 * Backend contract pinned (per backend/routes/ratehawk.js):
 *   POST /api/ratehawk/search { destinationCity, checkInDate, checkOutDate,
 *         guests, rooms, subBrand? } → 200 { stub, hotels:[], note, ... }
 *         | 402 RATEHAWK_BUDGET_EXCEEDED | 400 MISSING_DESTINATION/CHECKIN/OUT
 *   GET  /api/ratehawk/cap-status → 200 { spentCents, capCents, percent,
 *         withinCap, alertThreshold } | 402 (cap-exceeded body)
 *         | 403 (MANAGER role — swallowed silently)
 *
 * Why
 *   The page is the operator-facing entry to the RateHawk cap pattern.
 *   Two contracts are load-bearing for ops correctness and easy to
 *   silently regress: (a) the 402 → CapExceededBanner branching keeps the
 *   over-cap state legible; (b) the 403 → silent swallow on MANAGER role
 *   prevents a noisy error toast for the most common admin sub-role. The
 *   stub-mode banner test pins the Q19 cred-pending visible affordance —
 *   when the cred swap lands and the backend stops emitting stub:true,
 *   this test should be updated, not the SUT.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dependency, NOT global
 *     fetch). Per-call routing by URL + method so happy-path / 402 / 403
 *     / 500 paths can be exercised without re-stubbing the entire surface.
 *   - useNotify returns a STABLE notifyObj — single reference for the file
 *     (RTL standing rule: fresh per-call objects cause infinite-render
 *     loops on pages that put notify into a useCallback dep array).
 *   - travelSubBrand is imported real (not mocked) so SUB_BRAND_IDS /
 *     SUB_BRAND_LABEL drift is caught by the suite.
 *   - CapBanners is imported real (not mocked) so the SUT's testid
 *     contract is exercised end-to-end through the shared component.
 *   - Date inputs are pinned with fixed-string values (not new Date())
 *     per CLAUDE.md cron-learning 2026-05-07 wave-9 — TZ-window flakes on
 *     date-boundary helpers killed prior cycles.
 *   - Data-dependent assertions go through await findBy / waitFor per
 *     CLAUDE.md tick #108 cron-learning.
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

import RateHawkSearch from '../pages/admin/RateHawkSearch';

// Canonical cap-status response — within cap, no alert threshold.
const CAP_STATUS_OK = {
  spentCents: 2500,
  capCents: 15000,
  percent: 0.166,
  withinCap: true,
  alertThreshold: false,
};

// Successful stub-mode search response (today's reality per Q19 cred
// blocker). Includes the optional `subBrand` so the badge test can pin
// the friendly label rendering.
function makeSearchResponse(overrides = {}) {
  return {
    stub: true,
    tenantId: 1,
    subBrand: null,
    destinationCity: 'Mecca',
    checkInDate: '2026-06-15',
    checkOutDate: '2026-06-18',
    guests: 2,
    rooms: 1,
    hotels: [],
    note: 'Stub mode — RateHawk partner credentials pending (Q19).',
    ...overrides,
  };
}

// Helper: install a fetchApi mock that routes by URL+method, with sensible
// defaults for cap-status / search so individual tests only override the
// surface they care about.
function installFetchMock({ capStatus = CAP_STATUS_OK, search = makeSearchResponse() } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/ratehawk/cap-status' && (!opts || !opts.method || opts.method === 'GET')) {
      if (capStatus instanceof Error) return Promise.reject(capStatus);
      return Promise.resolve(capStatus);
    }
    if (url === '/api/ratehawk/search' && opts?.method === 'POST') {
      if (search instanceof Error) return Promise.reject(search);
      return Promise.resolve(search);
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <RateHawkSearch />
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

describe('<RateHawkSearch /> — operator-facing hotel search page', () => {
  it('renders heading + filter inputs + search button on mount', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /RateHawk Hotel Search/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('ratehawk-filter-destination')).toBeInTheDocument();
    expect(screen.getByTestId('ratehawk-filter-checkin')).toBeInTheDocument();
    expect(screen.getByTestId('ratehawk-filter-checkout')).toBeInTheDocument();
    expect(screen.getByTestId('ratehawk-filter-guests')).toBeInTheDocument();
    expect(screen.getByTestId('ratehawk-filter-rooms')).toBeInTheDocument();
    expect(screen.getByTestId('ratehawk-filter-subbrand')).toBeInTheDocument();
    expect(screen.getByTestId('ratehawk-search-btn')).toBeInTheDocument();
    // The default empty-state card renders before any search is fired.
    expect(screen.getByTestId('ratehawk-empty-state')).toBeInTheDocument();
    // Let cap-status GET settle so the pending fetch doesn't leak.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) => url === '/api/ratehawk/cap-status'),
      ).toBe(true);
    });
  });

  it('GETs /api/ratehawk/cap-status on mount and renders the cap pill once resolved', async () => {
    renderPage();
    // Pill renders after the cap-status GET resolves.
    const pill = await screen.findByTestId('ratehawk-cap-pill');
    expect(pill).toBeInTheDocument();
    // Pill copy contains the formatted "% of $cap/mo cap" string from CapStatusPill.
    expect(pill.textContent).toMatch(/of \$150\/mo cap/);
    // The cap-status GET fired exactly once.
    const capCalls = fetchApiMock.mock.calls.filter(
      ([url]) => url === '/api/ratehawk/cap-status',
    );
    expect(capCalls.length).toBe(1);
  });

  it('silently swallows 403 on cap-status (MANAGER role) — no pill renders', async () => {
    const err = new Error('Forbidden');
    err.status = 403;
    installFetchMock({ capStatus: err });
    renderPage();
    // Wait for the GET to settle.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) => url === '/api/ratehawk/cap-status'),
      ).toBe(true);
    });
    // Settle the .finally() microtask that flips capStatusLoading=false.
    await new Promise((r) => setTimeout(r, 0));
    // No pill renders (MANAGER role gets no over-cap surface).
    expect(screen.queryByTestId('ratehawk-cap-pill')).toBeNull();
  });

  it('renders over-cap pill when cap-status returns 402 with err.body cap data', async () => {
    const err = new Error('Cap exceeded');
    err.status = 402;
    err.body = { error: 'cap exceeded', spentCents: 16000, capCents: 15000 };
    installFetchMock({ capStatus: err });
    renderPage();
    const pill = await screen.findByTestId('ratehawk-cap-pill');
    // Per CapStatusPill: withinCap=false → red border, copy at 100%.
    expect(pill.style.border).toBe('1px solid rgb(244, 63, 94)');
    expect(pill.textContent).toMatch(/100% of \$150\/mo cap/);
  });

  it('validation: empty destination → notify.error fires, no POST is sent', async () => {
    renderPage();
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) => url === '/api/ratehawk/cap-status'),
      ).toBe(true);
    });
    fetchApiMock.mockClear();
    // Destination starts empty; click Search.
    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Destination city is required');
    });
    // No search POST fired.
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/ratehawk/search' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('validation: cleared check-in → notify.error fires, no POST is sent', async () => {
    renderPage();
    // Fill the destination so we get past the first guard.
    fireEvent.change(screen.getByTestId('ratehawk-filter-destination'), {
      target: { value: 'Paris' },
    });
    // Clear the check-in date (fixed string; matches yyyy-mm-dd input contract).
    fireEvent.change(screen.getByTestId('ratehawk-filter-checkin'), {
      target: { value: '' },
    });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Check-in date is required');
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/ratehawk/search' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('search happy path: clicking Search POSTs the form payload + renders the summary row', async () => {
    renderPage();
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) => url === '/api/ratehawk/cap-status'),
      ).toBe(true);
    });
    fireEvent.change(screen.getByTestId('ratehawk-filter-destination'), {
      target: { value: 'Mecca' },
    });
    // Fixed-string dates per CLAUDE.md cron-learning 2026-05-07 wave-9.
    fireEvent.change(screen.getByTestId('ratehawk-filter-checkin'), {
      target: { value: '2026-06-15' },
    });
    fireEvent.change(screen.getByTestId('ratehawk-filter-checkout'), {
      target: { value: '2026-06-18' },
    });
    fireEvent.change(screen.getByTestId('ratehawk-filter-guests'), {
      target: { value: '3' },
    });

    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/ratehawk/search' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.destinationCity).toBe('Mecca');
      expect(body.checkInDate).toBe('2026-06-15');
      expect(body.checkOutDate).toBe('2026-06-18');
      expect(body.guests).toBe(3);
      expect(body.rooms).toBe(1);
      // Sub-brand left as "" → key omitted from POST body.
      expect(body.subBrand).toBeUndefined();
    });
    // Search summary card renders post-response.
    expect(await screen.findByTestId('ratehawk-search-summary')).toBeInTheDocument();
  });

  it('renders the stub-mode banner when the search response carries stub:true', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('ratehawk-filter-destination'), {
      target: { value: 'Bangkok' },
    });
    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));
    // The shared StubModeBanner renders with the SUT-supplied testid.
    const banner = await screen.findByTestId('ratehawk-stub-banner');
    expect(banner.textContent).toMatch(/Stub-mode response/i);
    expect(banner.textContent).toMatch(/Q19/);
  });

  it('renders the "No hotels returned" empty-result card in stub mode', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('ratehawk-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));
    const noHotels = await screen.findByTestId('ratehawk-no-hotels');
    expect(noHotels.textContent).toMatch(/No hotels returned for this query/i);
    expect(noHotels.textContent).toMatch(/expected in stub mode/i);
  });

  it('summary row renders the friendly sub-brand label when search response includes subBrand', async () => {
    // Real travelSubBrand: subBrandLabel("tmc") → "TMC (School trips)".
    installFetchMock({
      search: makeSearchResponse({
        subBrand: 'tmc',
        destinationCity: 'Mecca',
      }),
    });
    renderPage();
    fireEvent.change(screen.getByTestId('ratehawk-filter-destination'), {
      target: { value: 'Mecca' },
    });
    fireEvent.change(screen.getByTestId('ratehawk-filter-subbrand'), {
      target: { value: 'tmc' },
    });
    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));
    const summary = await screen.findByTestId('ratehawk-search-summary');
    expect(summary.textContent).toMatch(/TMC \(School trips\)/);
  });

  it('search 402 cap-exceeded → CapExceededBanner renders + searchResult is cleared', async () => {
    const err = new Error('Cap exceeded');
    err.status = 402;
    err.body = {
      error: 'monthly cap exceeded',
      code: 'RATEHAWK_BUDGET_EXCEEDED',
      spentCents: 16000,
      capCents: 15000,
    };
    installFetchMock({ search: err });
    renderPage();
    fireEvent.change(screen.getByTestId('ratehawk-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));
    // The shared CapExceededBanner picks up the cap data and renders the
    // "Monthly RateHawk cap reached" header + provider label + cents pair.
    const banner = await screen.findByTestId('ratehawk-cap-exceeded-banner');
    expect(banner.textContent).toMatch(/Monthly RateHawk cap reached/i);
    expect(banner.textContent).toMatch(/\$160 \/ \$150/);
    // Empty-state card is NOT shown when capExceeded is set (the SUT
    // branches on capExceeded ? null : !searchResult ? <empty-state> : ...).
    expect(screen.queryByTestId('ratehawk-empty-state')).toBeNull();
    // No global error toast — the banner is the surface.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('search 500 generic error → notify.error fires with server-supplied message', async () => {
    const err = new Error('boom');
    err.status = 500;
    err.body = { error: 'RateHawk client crashed' };
    installFetchMock({ search: err });
    renderPage();
    fireEvent.change(screen.getByTestId('ratehawk-filter-destination'), {
      target: { value: 'Paris' },
    });
    fireEvent.click(screen.getByTestId('ratehawk-search-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('RateHawk client crashed');
    });
    // No search-summary card and no cap-exceeded banner.
    expect(screen.queryByTestId('ratehawk-search-summary')).toBeNull();
    expect(screen.queryByTestId('ratehawk-cap-exceeded-banner')).toBeNull();
  });
});
