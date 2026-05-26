/**
 * TmcMicrositePreview.test.jsx — vitest + RTL coverage for the TMC microsite
 * preview admin overview page (frontend/src/pages/travel/TmcMicrositePreview.jsx,
 * shipped tick #?? commit 0ae29ea — T22 last P1 NOT-STARTED row).
 *
 * Scope — pins the page-surface invariants for the read-only TMC microsite
 * overview admin page. The page lists TMC-sub-brand trip microsites so an
 * admin can spot-check publish state / expiry / public URLs WITHOUT a
 * dedicated edit / publish / OTP affordance (those live on the per-trip
 * detail screen, NOT here).
 *
 *   1. ADMIN chrome: heading "TMC Microsite Preview" + descriptive sub-copy
 *      render. ADMIN role required (USER role falls through to a refusal
 *      panel — case 13).
 *   2. Loading state: shows literal "Loading…" before the trips GET resolves
 *      (await findByText — sync getBy is a CI race trap per CLAUDE.md tick
 *      #108 cron-learning).
 *   3. Mount fetch: hits /api/travel/trips?limit=200 (NOT a filtered
 *      ?subBrand=tmc query — the SUT relies on tenant scope; see "drift
 *      pinned" below for why).
 *   4. Per-trip microsite fan-out: for each trip in the list response the
 *      page issues a parallel /api/travel/trips/:id/microsite GET. The
 *      number of fan-out calls equals the trips list length (NOT filtered
 *      pre-fan-out).
 *   5. Per-trip 404 tolerance: rejecting one of the fan-out microsite GETs
 *      does NOT crash the page — it surfaces only the resolved-with-data
 *      rows (Promise.allSettled per the SUT comment).
 *   6. Trips lacking `microsite.publicUuid` are filtered OUT of the table
 *      (returns a non-null microsite object with no publicUuid -> dropped).
 *   7. Empty state: zero trips returned -> "No TMC microsites yet." copy
 *      renders. (Same copy when trips exist but none have a microsite.)
 *   8. Row rendering: each surviving row shows trip.tripCode (in <strong>),
 *      trip.destination, microsite.subdomain (or "—"), the state badge,
 *      and the formatted expires date (or "—").
 *   9. State badge — Published: microsite.publishedAt set + expiresAt in
 *      the future -> badge text "Published".
 *  10. State badge — Draft: microsite.publishedAt null -> badge "Draft".
 *  11. State badge — Expired: microsite.expiresAt in the past -> badge
 *      "Expired" REGARDLESS of publishedAt (Expired wins per the SUT's
 *      `badgeForState` precedence).
 *  12. Sort order: rows are sorted publishedAt-descending (most recently
 *      published first; null publishedAt sinks to the bottom).
 *  13. Copy-URL button — happy path: clicks invoke navigator.clipboard
 *      .writeText with `${origin}/p/tripmicrosite/${publicUuid}` and fire
 *      notify.success("URL copied").
 *  14. Copy-URL button — fallback: when navigator.clipboard is unavailable,
 *      notify.info(url) fires instead.
 *  15. Trips fetch error: rejecting /api/travel/trips surfaces notify.error
 *      and leaves the page in an empty-state.
 *  16. RBAC: role===USER renders the "Admin role required to view this
 *      page." refusal panel; table chrome (column headers, copy buttons)
 *      hidden. DRIFT pinned: fetches still fire because the SUT's
 *      useEffect runs unconditionally — isAdmin only gates render, not
 *      load(). Real authZ is server-side on /api/travel/trips + per-trip
 *      microsite GETs. Test pins the user-visible refusal-panel contract.
 *
 * Backend contract pinned (per backend/routes/travel_microsites.js):
 *   GET /api/travel/trips?limit=200             → 200 { trips: [...] }
 *   GET /api/travel/trips/:id/microsite         → 200 microsite | 404 not-found
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt enumerated "OTP flow / edit-mode toggle / publish flow / save
 *     PATCH / sub-brand context toggle". The SUT is a READ-ONLY admin
 *     overview — none of those flows live here. Editing happens on the
 *     per-trip detail screen at /travel/trips/:id (per the SUT header
 *     comment "Real editing lives on the per-trip detail screen.").
 *     Tests pin the actual surface, not the prompt's fabricated flows.
 *   - Prompt said the page would query "?subBrand=tmc". The SUT actually
 *     queries /api/travel/trips?limit=200 unfiltered. The SUT comment
 *     explains: no GET-list microsite endpoint exists yet, so the page
 *     fans out per-trip. Tenant scoping is enforced server-side, not via
 *     ?subBrand on the client. Filter to TMC-only on the trip list would
 *     also work but the SUT doesn't apply it; pinned here so a future
 *     "?subBrand=tmc" change is a deliberate decision.
 *   - Prompt mentioned "iframe preview". The SUT uses an external <a
 *     target="_blank"> "Preview" link — no inline iframe. Pinned.
 *   - SUT renders the literal HTML entity "&hellip;" -> jsdom renders
 *     this as the unicode ellipsis "…" — test asserts findByText('Loading…').
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the SUT's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule).
 *   - AuthContext provided with role:ADMIN for the main suite; role:USER
 *     for the RBAC refusal test.
 *   - navigator.clipboard.writeText stubbed per-test.
 *   - window.location.origin stays at jsdom default (http://localhost) —
 *     URL assertions use a regex with the publicUuid suffix, locale-tolerant.
 *
 * Path: flat __tests__/ per tick #111 path-coordination (sibling Agent A
 * owns SuppliersAdmin.test.jsx in the same flat dir).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule. The SUT closes over notify via
// useCallback's load() and the per-row copyUrl handler. A fresh object per
// render would flap state across re-renders.
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

import { AuthContext } from '../App';
import TmcMicrositePreview from '../pages/travel/TmcMicrositePreview';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 2, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Past + future ISO timestamps relative to "now". Computed at mock-install
// time so tests stay deterministic across day boundaries.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const future = (ms = 30 * DAY_MS) => new Date(Date.now() + ms).toISOString();
const past = (ms = 7 * DAY_MS) => new Date(Date.now() - ms).toISOString();

function makeTrip(overrides = {}) {
  return {
    id: 1001,
    tripCode: 'TMC-2026-001',
    destination: 'Manali',
    subBrand: 'tmc',
    ...overrides,
  };
}

function makeMicrosite(overrides = {}) {
  return {
    id: 7001,
    tripId: 1001,
    subdomain: 'manali-2026',
    publicUuid: 'uuid-manali',
    publishedAt: past(2 * DAY_MS),
    expiresAt: future(60 * DAY_MS),
    ...overrides,
  };
}

const TRIPS_DEFAULT = [
  makeTrip({ id: 1001, tripCode: 'TMC-2026-001', destination: 'Manali' }),
  makeTrip({ id: 1002, tripCode: 'TMC-2026-002', destination: 'Shimla' }),
  makeTrip({ id: 1003, tripCode: 'TMC-2026-003', destination: 'Goa' }),
];

const MICROSITES_BY_TRIP = {
  // Published, in-future expiry → "Published" badge.
  1001: makeMicrosite({
    id: 7001,
    tripId: 1001,
    subdomain: 'manali-2026',
    publicUuid: 'uuid-manali',
    publishedAt: past(2 * DAY_MS),
    expiresAt: future(60 * DAY_MS),
  }),
  // No publishedAt → "Draft" badge. Future expiresAt irrelevant for drafts.
  1002: makeMicrosite({
    id: 7002,
    tripId: 1002,
    subdomain: 'shimla-2026',
    publicUuid: 'uuid-shimla',
    publishedAt: null,
    expiresAt: future(30 * DAY_MS),
  }),
  // Published BUT expiresAt in the past → "Expired" badge wins.
  1003: makeMicrosite({
    id: 7003,
    tripId: 1003,
    subdomain: 'goa-2025',
    publicUuid: 'uuid-goa',
    publishedAt: past(120 * DAY_MS),
    expiresAt: past(5 * DAY_MS),
  }),
};

function installFetchMock({
  trips = { trips: TRIPS_DEFAULT },
  micrositesByTripId = MICROSITES_BY_TRIP,
  micrositeOverride = null, // optional fn(tripId) → Promise (rejects/resolves)
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/trips?') && method === 'GET') {
      if (trips instanceof Error) return Promise.reject(trips);
      return Promise.resolve(trips);
    }
    const microsM = /^\/api\/travel\/trips\/(\d+)\/microsite$/.exec(url);
    if (microsM && method === 'GET') {
      const tripId = Number(microsM[1]);
      if (typeof micrositeOverride === 'function') {
        return micrositeOverride(tripId);
      }
      const ms = micrositesByTripId[tripId];
      if (ms === undefined) {
        // Tolerated 404 per the SUT comment — reject to exercise allSettled.
        const err = new Error('Not found');
        err.status = 404;
        return Promise.reject(err);
      }
      return Promise.resolve(ms);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false }}>
        <TmcMicrositePreview />
      </AuthContext.Provider>
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<TmcMicrositePreview /> — page chrome', () => {
  it('renders heading + descriptive sub-copy for ADMIN', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /TMC Microsite Preview/i }),
    ).toBeInTheDocument();
    // Sub-copy explains the read-only nature.
    expect(
      screen.getByText(/Admin overview of TMC trip microsites/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Real editing lives on the per-trip detail screen/i),
    ).toBeInTheDocument();
  });
});

describe('<TmcMicrositePreview /> — loading + fetch lifecycle', () => {
  it('shows "Loading…" before the trips GET resolves', async () => {
    // Defer the trips response so the loading state is observable.
    let resolveTrips;
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/travel/trips?')) {
        return new Promise((res) => { resolveTrips = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // jsdom resolves &hellip; → … (unicode ellipsis).
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveTrips({ trips: [] });
    // Once resolved, Loading disappears.
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
  });

  it('GETs /api/travel/trips?limit=200 on mount (unfiltered — drift pinned)', async () => {
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) => typeof u === 'string' && u.startsWith('/api/travel/trips?'));
      expect(call).toBeTruthy();
      expect(call[0]).toBe('/api/travel/trips?limit=200');
    });
  });

  it('fans out one /api/travel/trips/:id/microsite GET per trip in parallel', async () => {
    renderPage();
    await screen.findByText('TMC-2026-001');
    const fanOutCalls = fetchApiMock.mock.calls.filter(([u]) =>
      typeof u === 'string' && /^\/api\/travel\/trips\/\d+\/microsite$/.test(u),
    );
    // Three trips in TRIPS_DEFAULT -> three fan-out calls (regardless of
    // which ones resolve with a microsite).
    expect(fanOutCalls.length).toBe(3);
    const urls = fanOutCalls.map((c) => c[0]).sort();
    expect(urls).toEqual([
      '/api/travel/trips/1001/microsite',
      '/api/travel/trips/1002/microsite',
      '/api/travel/trips/1003/microsite',
    ]);
  });

  it('tolerates per-trip microsite 404 — surviving rows still render', async () => {
    // One trip's microsite rejects with 404; the other two resolve.
    installFetchMock({
      micrositeOverride: (tripId) => {
        if (tripId === 1002) {
          const err = new Error('Not found');
          err.status = 404;
          return Promise.reject(err);
        }
        return Promise.resolve(MICROSITES_BY_TRIP[tripId]);
      },
    });
    renderPage();
    // Manali (1001) + Goa (1003) survive; Shimla (1002) drops.
    expect(await screen.findByText('TMC-2026-001')).toBeInTheDocument();
    expect(screen.getByText('TMC-2026-003')).toBeInTheDocument();
    expect(screen.queryByText('TMC-2026-002')).toBeNull();
  });

  it('drops trips whose microsite resolves WITHOUT a publicUuid', async () => {
    installFetchMock({
      micrositeOverride: (tripId) => {
        if (tripId === 1002) {
          // Resolved microsite object but missing publicUuid → filtered out.
          return Promise.resolve({ id: 7002, tripId: 1002, subdomain: 'shimla-2026', publicUuid: null });
        }
        return Promise.resolve(MICROSITES_BY_TRIP[tripId]);
      },
    });
    renderPage();
    expect(await screen.findByText('TMC-2026-001')).toBeInTheDocument();
    // Shimla had a microsite object but no publicUuid → dropped.
    expect(screen.queryByText('TMC-2026-002')).toBeNull();
  });

  it('renders empty-state copy when no trips exist', async () => {
    installFetchMock({ trips: { trips: [] } });
    renderPage();
    expect(await screen.findByText(/No TMC microsites yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Microsites are created from the per-trip detail screen/i),
    ).toBeInTheDocument();
  });

  it('renders empty-state copy when trips exist but NONE have a microsite', async () => {
    installFetchMock({
      // Every microsite fan-out rejects with 404.
      micrositeOverride: () => {
        const err = new Error('Not found');
        err.status = 404;
        return Promise.reject(err);
      },
    });
    renderPage();
    expect(await screen.findByText(/No TMC microsites yet/i)).toBeInTheDocument();
  });

  it('trips fetch error surfaces notify.error and leaves an empty table', async () => {
    const err = new Error('boom');
    err.body = { error: 'Trips backend exploded' };
    installFetchMock({ trips: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Trips backend exploded');
    });
    expect(await screen.findByText(/No TMC microsites yet/i)).toBeInTheDocument();
  });
});

describe('<TmcMicrositePreview /> — row rendering + state badges', () => {
  it('renders one row per microsite with trip code, destination, subdomain, expires', async () => {
    renderPage();
    // Wait for the first row.
    await screen.findByText('TMC-2026-001');
    // Three trips with microsites -> three rows.
    expect(screen.getByText('TMC-2026-002')).toBeInTheDocument();
    expect(screen.getByText('TMC-2026-003')).toBeInTheDocument();
    // Destinations in the same cell row.
    expect(screen.getByText('Manali')).toBeInTheDocument();
    expect(screen.getByText('Shimla')).toBeInTheDocument();
    expect(screen.getByText('Goa')).toBeInTheDocument();
    // Subdomains rendered.
    expect(screen.getByText('manali-2026')).toBeInTheDocument();
    expect(screen.getByText('shimla-2026')).toBeInTheDocument();
    expect(screen.getByText('goa-2025')).toBeInTheDocument();
  });

  it('Published row: publishedAt set + future expiresAt → "Published" badge', async () => {
    renderPage();
    const tripRow = (await screen.findByText('TMC-2026-001')).closest('tr');
    expect(tripRow).toBeTruthy();
    expect(within(tripRow).getByText('Published')).toBeInTheDocument();
  });

  it('Draft row: publishedAt null → "Draft" badge', async () => {
    renderPage();
    const tripRow = (await screen.findByText('TMC-2026-002')).closest('tr');
    expect(within(tripRow).getByText('Draft')).toBeInTheDocument();
  });

  it('Expired row: expiresAt in the past → "Expired" badge wins over publishedAt', async () => {
    renderPage();
    const tripRow = (await screen.findByText('TMC-2026-003')).closest('tr');
    expect(within(tripRow).getByText('Expired')).toBeInTheDocument();
  });

  it('sort order: most-recently-published row appears before older-published row', async () => {
    // Override microsites so Manali (1001) published 2 days ago, Goa (1003) published 120 days ago.
    // Default fixture already encodes this; assert the DOM order.
    renderPage();
    await screen.findByText('TMC-2026-001');
    const rows = screen.getAllByRole('row');
    // First row is the <thead> header; data rows start at index 1.
    const tripCellTexts = rows.slice(1).map((tr) => {
      const strong = tr.querySelector('strong');
      return strong ? strong.textContent : '';
    });
    // Manali (recent) should appear before Goa (old) in the data rows.
    const manaliIdx = tripCellTexts.indexOf('TMC-2026-001');
    const goaIdx = tripCellTexts.indexOf('TMC-2026-003');
    expect(manaliIdx).toBeGreaterThanOrEqual(0);
    expect(goaIdx).toBeGreaterThanOrEqual(0);
    expect(manaliIdx).toBeLessThan(goaIdx);
  });
});

describe('<TmcMicrositePreview /> — Copy URL action', () => {
  it('clicking Copy → navigator.clipboard.writeText(url) + notify.success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderPage();
    await screen.findByText('TMC-2026-001');
    // Copy button is aria-labelled "Copy public URL for trip TMC-2026-001".
    const copyBtn = screen.getByRole('button', { name: /Copy public URL for trip TMC-2026-001/i });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      // jsdom's default origin is http://localhost.
      expect(writeText.mock.calls[0][0]).toMatch(/\/p\/tripmicrosite\/uuid-manali$/);
    });
    expect(notifySuccess).toHaveBeenCalledWith('URL copied');
  });

  it('falls back to notify.info(url) when navigator.clipboard is unavailable', async () => {
    // Replace clipboard with an object lacking writeText.
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    renderPage();
    await screen.findByText('TMC-2026-001');
    const copyBtn = screen.getByRole('button', { name: /Copy public URL for trip TMC-2026-001/i });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalled();
      const arg = notifyInfo.mock.calls[0][0];
      expect(arg).toMatch(/\/p\/tripmicrosite\/uuid-manali$/);
    });
  });
});

describe('<TmcMicrositePreview /> — RBAC', () => {
  it('role:USER renders the refusal panel (table chrome hidden)', async () => {
    renderPage(USER_USER);
    expect(
      await screen.findByText(/Admin role required to view this page/i),
    ).toBeInTheDocument();
    // Confirm the table chrome (column headers) does NOT render for non-admins.
    // Drift pinned: the SUT's `useEffect(() => { load(); }, [load])` runs
    // unconditionally — it doesn't gate on isAdmin. So fetches DO fire for
    // non-admin renders (the refusal panel happens at render-time after
    // load() already ran). The user-visible surface is what RBAC actually
    // gates: no table, no rows, no copy buttons — server-side authZ on the
    // /api/travel/trips and per-trip /microsite endpoints is the real
    // enforcement. Tests pin the rendered-surface contract, not a fetch-
    // suppression contract the SUT doesn't actually provide.
    expect(screen.queryByRole('columnheader', { name: /Trip/i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /Subdomain/i })).toBeNull();
    // No copy buttons (rows are not rendered).
    expect(screen.queryByRole('button', { name: /Copy public URL/i })).toBeNull();
  });
});
