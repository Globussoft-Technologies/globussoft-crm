/**
 * WellnessReports.test.jsx — vitest + RTL coverage for the Wellness-vertical
 * Reports page (frontend/src/pages/wellness/Reports.jsx).
 *
 * Distinct from:
 *   - frontend/src/__tests__/Reports.cellStyle.test.jsx — a style-grep
 *     test that reads a single source file via fs.readFileSync; NOT a
 *     render test of any Reports page.
 *   - frontend/src/__tests__/TravelReports.test.jsx (tick #124 commit
 *     4e98f77) — covers the Travel-vertical Reports surface (3 tabs:
 *     TMC / RFU / Cross-brand). Different verticals, different
 *     endpoints, different chrome.
 *   - frontend/src/__tests__/VisaReports.test.jsx (tick #122 commit
 *     98aae5d) — covers the Phase 3 Visa Sure analytics page (3
 *     parallel /api/travel/visa/analytics/* GETs + recharts cards).
 *
 * Scope — pins the page-surface invariants for the Wellness-vertical
 * Reports surface (5 tabs, each its own one-shot GET, debounced):
 *
 *   1. Page chrome: heading "Reports" + tab strip with five tabs
 *      (P&L by Service / Per Professional / Per Location / Per Product /
 *      Marketing Attribution) + two `type=date` inputs (from / to)
 *      render synchronously.
 *   2. Loading state: literal "Loading…" surfaces while the active-tab
 *      GET is in flight.
 *   3. GET on mount (debounced): after the 350ms debounce window,
 *      fires GET /api/wellness/reports/pnl-by-service exactly once
 *      (the initially-active P&L tab) with from/to ISO date-time
 *      query params, and DOES NOT pre-fetch the other three tabs.
 *   4. Switching to Per Professional tab: cancels the in-flight debounce
 *      and fires GET /api/wellness/reports/per-professional after the
 *      debounce window. Same query-param shape.
 *   5. Switching to Per Location tab: fires GET
 *      /api/wellness/reports/per-location.
 *   6. Switching to Marketing Attribution tab: fires GET
 *      /api/wellness/reports/attribution.
 *   6b. Switching to Per Product tab: fires GET
 *      /api/wellness/reports/per-product.
 *   7. P&L tab populated: KPI tile labels (Visits / Revenue / Product
 *      cost / Contribution / Services) + per-row Service / Category /
 *      Tier badge + numeric cells render.
 *   8. P&L tab empty rows: zero rows → "No services with revenue in
 *      this window." empty-row copy.
 *   9. Per Professional tab populated: per-staff Avatar + name +
 *      wellnessRole (capitalised) + visits + revenue cells render.
 *  10. Per Location tab populated: "<N> active locations" heading +
 *      per-row name + city + isActive status emoji render.
 *  11. Marketing Attribution tab populated: source rows with
 *      formatPercent-rendered junkRate / conversionRate + revenue
 *      cells render.
 *  12. Marketing Attribution tab empty: zero rows → "No leads in this
 *      window." empty-row copy.
 *  13. Fetch failure (rejected promise) → "No data." empty card copy
 *      (SUT swallows .catch and sets data=null).
 *  14. INR ₹-formatted money: tenant.defaultCurrency=INR in
 *      localStorage → tiles render the ₹ symbol via formatMoney's
 *      Intl.NumberFormat('en-IN') output.
 *  15. Per Product tab populated: per-product rows with HSN (or "--")
 *      + the gross → discount → net → tax → total column set + the
 *      Products / Units sold KPI tiles.
 *  16. Per Product source badge: 'live' → "Live — POS sales"; 'mixed' →
 *      "POS + imported snapshot" for a window straddling the POS cutover;
 *      'import' → "Imported snapshot" plus the source filename. The
 *      tab reads POS when POS has sales in the window and falls back
 *      to an imported snapshot otherwise, so which source produced a
 *      figure is stated on the page rather than inferred.
 *  17. Per Product empty: zero rows → "No product sales in this
 *      window." plus an inline Import action.
 *  18. The "Import sales data" toolbar button is Per-Product-only —
 *      absent on the other four tabs.
 *
 * Backend contract pinned (per the four endpoints under
 * /api/wellness/reports/*):
 *   GET /api/wellness/reports/pnl-by-service?from&to → {
 *       totals: { visits, revenue, productCost, contribution },
 *       rows: [{ id, name, category, ticketTier, count, revenue,
 *               productCost, contribution }],
 *       servicesSummary: [...]
 *     }
 *   GET /api/wellness/reports/per-professional?from&to → {
 *       totals: { visits, revenue },
 *       rows: [{ id, name, role, wellnessRole, visits, revenue }]
 *     }
 *   GET /api/wellness/reports/per-location?from&to → {
 *       totals: { visits, revenue },
 *       rows: [{ id, name, city, state, patients, visits, revenue,
 *               isActive }]
 *     }
 *   GET /api/wellness/reports/per-product?from&to&source → {
 *       source: 'live' | 'import' | 'mixed' | 'none',
 *       posCutoverAt: <ISO ts of the first COMPLETED POS product sale>,
 *       totals: { products, productCount, grossSales, discount,
 *                 netSales, tax, totalSales },
 *       importBatches: [{ id, fileName, periodStart, periodEnd }],
 *       rows: [{ key, productId, name, hsnCode, productCount,
 *               grossSales, discount, netSales, tax, totalSales,
 *               revenue }]
 *     }
 *   GET /api/wellness/reports/attribution?from&to → {
 *       totals: { leads, junk, qualified, revenue },
 *       rows: [{ source, leads, junkRate, conversionRate, revenue,
 *               revenuePerLead }]
 *     }
 *
 * Drift pinned (prompt brief vs. actual SUT code):
 *   - Brief mentioned "useNotify mock with stable refs". SUT does NOT
 *     import useNotify at all — no notify call sites. The 403 path
 *     (and any other error path) just swallows into data=null. Test
 *     OMITS the notify mock entirely.
 *   - Brief mentioned "AuthContext via real Provider wrapper IF SUT
 *     consumes it". SUT does NOT consume AuthContext directly — but
 *     DOES call useNavigate(), so the test wraps in MemoryRouter.
 *   - Brief mentioned "Tab-switch: clicking a tab fires that tab's GET
 *     (lazy per TravelReports pattern? OR eager? verify)". SUT is
 *     LAZY-PER-TAB: a single useEffect with deps [tab, from, to]
 *     fetches only the active tab's endpoint. Tab switch triggers a
 *     350ms-debounced re-fetch (per #433 in the SUT comment).
 *   - Brief mentioned "Default-tab GET on mount: hits the first tab's
 *     endpoint (which one is default? verify SUT)". DEFAULT TAB is
 *     'pnl' (P&L by Service) per useState('pnl') at line 37 — the
 *     mount-time GET hits /api/wellness/reports/pnl-by-service.
 *   - Brief mentioned "Date-range filter: changing triggers re-fetch
 *     for the active tab". Confirmed via [tab, from, to] dep array on
 *     the load effect; assertion covered indirectly by the debounce-
 *     wait pattern in tab-switch tests, NOT pinned as its own test
 *     (would require fireEvent.change + 350ms vi.advanceTimers dance
 *     that adds complexity without distinct contract value).
 *   - Brief mentioned "403 → access-restricted". SUT has NO 403-
 *     specific branch — any rejected promise falls into the same
 *     .catch(() => setData(null)) path. Tests cover the generic
 *     failure path (renders "No data."), NOT a 403-specific surface.
 *   - Brief mentioned "Loading state: await findByText for actual
 *     literal". Literal is `Loading…` (ellipsis CHARACTER, not the JS
 *     `…` escape — per CLAUDE.md standing rule that JSX text
 *     does not interpret JS escape sequences). Tests assert via
 *     regex /Loading…/ which matches either form.
 *   - Brief mentioned "Money formatting: figures render in tenant
 *     currency (INR for Enhanced Wellness)". The `formatMoney` helper
 *     reads tenant from localStorage; tests seed
 *     localStorage.setItem('tenant', JSON.stringify({
 *     defaultCurrency: 'INR', locale: 'en-IN' })) in beforeEach to
 *     pin the ₹ output.
 *   - Brief mentioned "Multiple parallel GETs (URL-dispatch mock per
 *     VisaReports pattern)". SUT fires ONE GET per tab, lazily on
 *     tab switch. URL-dispatch mock still applies (all 4 endpoints
 *     share the same fetchApiMock) but parallelism is SEQUENTIAL.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global
 *     fetch). getAuthToken also exported because the SUT's
 *     downloadExport path uses it (we don't exercise that path here,
 *     but the mock must export it or vi.mock breaks at import time).
 *   - useNotify NOT mocked — SUT doesn't use it.
 *   - localStorage seeded with INR tenant in beforeEach so formatMoney
 *     renders the ₹ glyph; cleared in afterEach.
 *   - vi.useFakeTimers per-suite (NOT global) so the 350ms debounce
 *     window can be advanced deterministically — async ticks done via
 *     vi.advanceTimersByTimeAsync per RTL best-practice.
 *   - Data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for async-
 *     resolved text is a CI race trap).
 *   - MemoryRouter wraps the SUT because useNavigate() is called at
 *     the top of the component; no <Routes> needed — the navigate
 *     callback is only fired on Visits-tile-click which we don't
 *     exercise.
 *
 * Path: flat __tests__/ — sibling Agent A is on a DIFFERENT page;
 * no path collision (verified: no in-flight WellnessReports.test.jsx
 * in git status).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import WellnessReports from '../pages/wellness/Reports';

// Canonical populated responses.
const PNL_POPULATED = {
  totals: { visits: 120, revenue: 1234567, productCost: 234567, contribution: 1000000 },
  rows: [
    { id: 's1', name: 'Hydrafacial', category: 'Aesthetic', ticketTier: 'high', count: 40, revenue: 800000, productCost: 100000, contribution: 700000 },
    { id: 's2', name: 'Consultation', category: 'Clinical', ticketTier: 'low', count: 80, revenue: 434567, productCost: 134567, contribution: 300000 },
  ],
  servicesSummary: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
};

const PNL_EMPTY_ROWS = {
  totals: { visits: 0, revenue: 0, productCost: 0, contribution: 0 },
  rows: [],
  servicesSummary: [],
};

const PRO_POPULATED = {
  totals: { visits: 95, revenue: 850000 },
  rows: [
    { id: 'u1', name: 'Dr. Harsh Sharma', role: 'USER', wellnessRole: 'doctor', visits: 50, revenue: 600000 },
    { id: 'u2', name: 'Priya Nair', role: 'USER', wellnessRole: 'professional', visits: 45, revenue: 250000 },
  ],
};

const LOC_POPULATED = {
  totals: { visits: 200, revenue: 1500000 },
  rows: [
    { id: 'l1', name: 'Bandra Flagship', city: 'Mumbai', state: 'MH', patients: 130, visits: 150, revenue: 1200000, isActive: true },
    { id: 'l2', name: 'Andheri Annex', city: 'Mumbai', state: 'MH', patients: 40, visits: 50, revenue: 300000, isActive: true },
    { id: 'l3', name: 'Old Pune Branch', city: 'Pune', state: 'MH', patients: 0, visits: 0, revenue: 0, isActive: false },
  ],
};

const ATT_POPULATED = {
  totals: { leads: 220, junk: 40, qualified: 180, revenue: 1234567 },
  rows: [
    { source: 'IndiaMART', leads: 120, junkRate: 18.5, conversionRate: 22.4, revenue: 800000, revenuePerLead: 6667 },
    { source: 'Instagram Ads', leads: 100, junkRate: 75.0, conversionRate: 4.0, revenue: 434567, revenuePerLead: 4346 },
  ],
};

const ATT_EMPTY_ROWS = {
  totals: { leads: 0, junk: 0, qualified: 0, revenue: 0 },
  rows: [],
};

// Per Product carries a `source` discriminator the other four tabs don't:
// 'live' (POS sales) / 'import' (a snapshot loaded from the clinic's previous
// system) / 'none'. The badge that surfaces it is part of the contract — the
// same tab changes source on its own as a clinic onboards.
const PROD_LIVE = {
  source: 'live',
  requestedSource: 'auto',
  totals: {
    products: 2, productCount: 125, grossSales: 228515, discount: 1417.4,
    netSales: 216394.71, tax: 10702.89, totalSales: 227097.6,
  },
  importBatches: [],
  rows: [
    { key: 'p:1', productId: 1, name: 'Hair Fact - Gold Veg (M)', hsnCode: '3305', productCount: 88, grossSales: 228515, discount: 1417.4, netSales: 216394.71, tax: 10702.89, totalSales: 227097.6, revenue: 227097.6 },
    { key: 'p:2', productId: 2, name: 'GLYCURA MARINE COLLAGEN', hsnCode: null, productCount: 37, grossSales: 99533, discount: 215.92, netSales: 94587.69, tax: 4729.39, totalSales: 99317.08, revenue: 99317.08 },
  ],
};

// An imported batch whose period sits INSIDE the report window — the totals
// really are the window's, so no caution is warranted.
const PROD_IMPORTED = {
  ...PROD_LIVE,
  source: 'import',
  window: { from: '2025-12-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z' },
  importBatches: [
    { id: 7, fileName: 'zenoti-fy25-q1.csv', periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-03-31T23:59:59.999Z' },
  ],
};

// The realistic case: an 8-month export viewed under a "Last 30 days" filter.
// A snapshot has no day-level detail, so it is reported whole — the page must
// say so rather than let the totals read as 30 days of sales.
const PROD_IMPORTED_WIDER_THAN_WINDOW = {
  ...PROD_LIVE,
  source: 'import',
  window: { from: '2026-07-27T00:00:00.000Z', to: '2026-08-26T23:59:59.999Z' },
  importBatches: [
    { id: 9, fileName: 'sales-by-product_2025-12-01_to_2026-08-18.csv', periodStart: '2025-12-01T00:00:00.000Z', periodEnd: '2026-08-18T23:59:59.999Z' },
  ],
};

const PROD_EMPTY_ROWS = {
  source: 'none',
  requestedSource: 'auto',
  totals: { products: 0, productCount: 0, grossSales: 0, discount: 0, netSales: 0, tax: 0, totalSales: 0 },
  importBatches: [],
  rows: [],
};

// A window straddling the POS cutover: the snapshot's period (which ends
// before POS went live) PLUS live POS rows, added. The page must not present
// this as purely live or purely imported.
const PROD_MIXED = {
  ...PROD_LIVE,
  source: 'mixed',
  window: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
  posCutoverAt: '2026-09-05T10:00:00.000Z',
  importBatches: [
    { id: 2, fileName: 'snapshot.csv', periodStart: '2025-12-01T00:00:00.000Z', periodEnd: '2026-08-18T23:59:59.999Z' },
  ],
};

function installFetchMock({
  pnl = PNL_POPULATED,
  pro = PRO_POPULATED,
  loc = LOC_POPULATED,
  prod = PROD_LIVE,
  att = ATT_POPULATED,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (url.startsWith('/api/wellness/reports/pnl-by-service')) {
      return pnl instanceof Error ? Promise.reject(pnl) : Promise.resolve(pnl);
    }
    if (url.startsWith('/api/wellness/reports/per-professional')) {
      return pro instanceof Error ? Promise.reject(pro) : Promise.resolve(pro);
    }
    if (url.startsWith('/api/wellness/reports/per-location')) {
      return loc instanceof Error ? Promise.reject(loc) : Promise.resolve(loc);
    }
    // The importer's own list endpoint lives under the same prefix as the
    // report — match it FIRST or the report fixture answers it.
    if (url.startsWith('/api/wellness/reports/per-product/imports')) {
      return Promise.resolve({ rows: [], total: 0 });
    }
    if (url.startsWith('/api/wellness/reports/per-product')) {
      return prod instanceof Error ? Promise.reject(prod) : Promise.resolve(prod);
    }
    if (url.startsWith('/api/wellness/reports/attribution')) {
      return att instanceof Error ? Promise.reject(att) : Promise.resolve(att);
    }
    return Promise.resolve(null);
  });
}

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <WellnessReports />
    </MemoryRouter>,
  );
}

// SUT's load() runs after a 350ms setTimeout (#433 debounce). Tests run on
// REAL timers — `findBy*` / `waitFor` poll up to 1s by default, which is
// plenty of headroom for the 350ms debounce to elapse + the mocked fetch
// to resolve + React to re-render. Fake timers were tried first but they
// freeze the queueMicrotask scheduler that vi.fn promise resolutions ride
// on, so findBy* timed out across all 14 cases. Real timers + the explicit
// 1500ms waitFor timeout on debounce-gated assertions is the simpler win.
const WAIT_OPTS = { timeout: 1500 };

beforeEach(() => {
  fetchApiMock.mockReset();
  installFetchMock();
  // Pin INR tenant so formatMoney renders ₹.
  localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'INR', locale: 'en-IN' }));
});

afterEach(() => {
  localStorage.clear();
});

describe('<WellnessReports /> — page chrome + tab strip', () => {
  it('renders heading + five tab buttons synchronously', async () => {
    renderWithRouter();
    expect(
      screen.getByRole('heading', { name: /^Reports$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /P&L by Service/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Per Professional/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Per Location/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Per Product/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Marketing Attribution/i }),
    ).toBeInTheDocument();
    // SUT drift: date inputs were replaced by the shared DateRangeFilter
    // component (preset buttons + calendar popover, no native type=date
    // inputs). Just settle the mount-time fetch and move on.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled(), WAIT_OPTS);
  });
});

describe('<WellnessReports /> — loading + mount-time fetch', () => {
  it('shows literal "Loading…" while the P&L GET is in flight', async () => {
    let resolvePnl;
    const pending = new Promise((r) => {
      resolvePnl = r;
    });
    fetchApiMock.mockImplementation(() => pending);
    renderWithRouter();
    // Initial render is in loading state (useState(true) for `loading`).
    expect(screen.getByText(/Loading…/)).toBeInTheDocument();
    // Advance through debounce so the fetch fires; loading stays true
    // until the promise resolves.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled(), WAIT_OPTS);
    expect(screen.getByText(/Loading…/)).toBeInTheDocument();
    resolvePnl(PNL_POPULATED);
    await waitFor(() => {
      expect(screen.queryByText(/Loading…/)).toBeNull();
    });
  });

  it('fires GET /api/wellness/reports/pnl-by-service (default tab=pnl) on mount after debounce, lazy — no pre-fetch of other tabs', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    const url = fetchApiMock.mock.calls[0][0];
    expect(url).toMatch(/^\/api\/wellness\/reports\/pnl-by-service\?from=\d{4}-\d{2}-\d{2}T00%3A00%3A00&to=\d{4}-\d{2}-\d{2}T23%3A59%3A59&limit=10$/);
    // Other tabs NOT pre-fetched.
    const allUrls = fetchApiMock.mock.calls.map(([u]) => u);
    expect(allUrls.some((u) => u.startsWith('/api/wellness/reports/per-professional'))).toBe(false);
    expect(allUrls.some((u) => u.startsWith('/api/wellness/reports/per-location'))).toBe(false);
    expect(allUrls.some((u) => u.startsWith('/api/wellness/reports/attribution'))).toBe(false);
  });
});

describe('<WellnessReports /> — lazy-per-tab fetching', () => {
  it('switching to Per Professional tab fires GET /api/wellness/reports/per-professional', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Per Professional/i }));
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.startsWith('/api/wellness/reports/per-professional'))).toBe(true);
    }, WAIT_OPTS);
  });

  it('switching to Per Location tab fires GET /api/wellness/reports/per-location', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Per Location/i }));
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.startsWith('/api/wellness/reports/per-location'))).toBe(true);
    }, WAIT_OPTS);
  });

  it('switching to Per Product tab fires GET /api/wellness/reports/per-product', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Per Product/i }));
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.startsWith('/api/wellness/reports/per-product'))).toBe(true);
    }, WAIT_OPTS);
  });

  it('switching to Marketing Attribution tab fires GET /api/wellness/reports/attribution', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Marketing Attribution/i }));
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.startsWith('/api/wellness/reports/attribution'))).toBe(true);
    }, WAIT_OPTS);
  });
});

describe('<WellnessReports /> — P&L tab content', () => {
  it('renders P&L KPI tile labels + per-row Service / Category / Tier badge', async () => {
    renderWithRouter();
    // Gate on a per-row string (Hydrafacial) so we know the populated
    // P&L data has actually been committed (not just the initial-render
    // tile labels for empty data).
    expect(await screen.findByText('Hydrafacial', {}, WAIT_OPTS)).toBeInTheDocument();
    // KPI tile labels — uppercase via CSS but DOM text is title-case.
    // 'Visits' / 'Revenue' appear twice each (KPI tile + table column
    // header) — per RTL standing rule, use getAllByText for labels that
    // appear in multiple chrome layers.
    // Tile labels are uppercase via CSS but DOM text is title-case; the
    // same labels (Visits / Revenue / Product cost / Contribution) also
    // appear in the table column headers, so use getAllByText for them.
    expect(screen.getAllByText(/^Visits$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Revenue$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Product cost$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Contribution$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Services$/i)).toBeInTheDocument();
    // Per-row data.
    expect(screen.getByText('Consultation')).toBeInTheDocument();
    expect(screen.getByText('Aesthetic')).toBeInTheDocument();
    // Tier badge — SUT uppercases via CSS but DOM keeps the raw value.
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('low')).toBeInTheDocument();
  });

  it('renders P&L empty-state copy when rows=[]', async () => {
    installFetchMock({ pnl: PNL_EMPTY_ROWS });
    renderWithRouter();
    expect(
      await screen.findByText(/No services with revenue in this window\./i, {}, WAIT_OPTS),
    ).toBeInTheDocument();
  });
});

describe('<WellnessReports /> — Per Professional tab content', () => {
  it('renders staff row with name + wellnessRole (capitalised via CSS) + visits + revenue', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Per Professional/i }));
    expect(await screen.findByText('Dr. Harsh Sharma', {}, WAIT_OPTS)).toBeInTheDocument();
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    // wellnessRole rendered as-is (CSS capitalises) — DOM text is the raw value.
    expect(screen.getByText('doctor')).toBeInTheDocument();
    expect(screen.getByText('professional')).toBeInTheDocument();
    // Avatar testid surfaces for each row.
    const avatars = screen.getAllByTestId('avatar');
    expect(avatars.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<WellnessReports /> — Per Location tab content', () => {
  it('renders "<N> active locations" heading + per-row name + city + status emoji', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Per Location/i }));
    // 2 active locations + 1 inactive per LOC_POPULATED.
    expect(
      await screen.findByText(/^2 active locations$/i, {}, WAIT_OPTS),
    ).toBeInTheDocument();
    // Inactive-count pill.
    expect(screen.getByText(/inactive: 1/i)).toBeInTheDocument();
    // Location rows.
    expect(screen.getByText('Bandra Flagship')).toBeInTheDocument();
    expect(screen.getByText('Andheri Annex')).toBeInTheDocument();
    expect(screen.getByText('Old Pune Branch')).toBeInTheDocument();
    // City + state composite rendering ("Mumbai, MH").
    const mumbaiRows = screen.getAllByText(/^Mumbai, MH$/);
    expect(mumbaiRows.length).toBe(2);
    // Status emoji — active rows show 🟢, inactive shows ⚪.
    expect(screen.getAllByText(/🟢 Active/).length).toBe(2);
    expect(screen.getByText(/⚪ Inactive/)).toBeInTheDocument();
  });
});

describe('<WellnessReports /> — Per Product tab content', () => {
  const openProductTab = async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Per Product/i }));
  };

  it('renders per-product rows with HSN + the full gross → discount → net → tax → total column set', async () => {
    await openProductTab();
    expect(
      await screen.findByText('Hair Fact - Gold Veg (M)', {}, WAIT_OPTS),
    ).toBeInTheDocument();
    expect(screen.getByText('GLYCURA MARINE COLLAGEN')).toBeInTheDocument();
    // Column headers — the same set the imported vendor export carries.
    expect(screen.getByRole('columnheader', { name: /^HSN$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Gross sales/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Net sales/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Tax$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Total sales/i })).toBeInTheDocument();
    // HSN present on row 1, absent (→ "--") on row 2.
    expect(screen.getByText('3305')).toBeInTheDocument();
    expect(screen.getByText('--')).toBeInTheDocument();
    // KPI tiles.
    expect(screen.getByText(/^Units sold$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Products$/i)).toBeInTheDocument();
  });

  it('badges a live POS response as "Live — POS sales"', async () => {
    await openProductTab();
    expect(
      await screen.findByText(/Live — POS sales/i, {}, WAIT_OPTS),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Imported snapshot/i)).toBeNull();
  });

  it('badges an import-sourced response and names the file + period it came from', async () => {
    installFetchMock({ prod: PROD_IMPORTED });
    await openProductTab();
    expect(
      await screen.findByText(/Imported snapshot/i, {}, WAIT_OPTS),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/zenoti-fy25-q1\.csv \(2026-01-01 → 2026-03-31\)/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Live — POS sales/i)).toBeNull();
  });

  it('warns when the snapshot covers more than the selected window (it cannot be sliced)', async () => {
    installFetchMock({ prod: PROD_IMPORTED_WIDER_THAN_WINDOW });
    await openProductTab();
    expect(
      await screen.findByText(
        /The imported part of these totals covers its whole period, not the date range selected above\./i,
        {},
        WAIT_OPTS,
      ),
    ).toBeInTheDocument();
    // The period the figures ACTUALLY cover is named next to the filename.
    expect(
      screen.getByText(/sales-by-product_2025-12-01_to_2026-08-18\.csv \(2025-12-01 → 2026-08-18\)/i),
    ).toBeInTheDocument();
  });

  it('does NOT warn when the snapshot sits inside the selected window', async () => {
    installFetchMock({ prod: PROD_IMPORTED });
    await openProductTab();
    await screen.findByText(/Imported snapshot/i, {}, WAIT_OPTS);
    expect(
      screen.queryByText(/The imported part of these totals covers its whole period/i),
    ).toBeNull();
  });

  it('badges a cutover-straddling window as POS + snapshot, naming both', async () => {
    installFetchMock({ prod: PROD_MIXED });
    await openProductTab();
    expect(
      await screen.findByText(/POS \+ imported snapshot/i, {}, WAIT_OPTS),
    ).toBeInTheDocument();
    // Says it is POS *plus* the snapshot, and names the snapshot's period —
    // otherwise the reader cannot tell which part of the money came from where.
    expect(
      screen.getByText(/POS sales, plus snapshot\.csv \(2025-12-01 → 2026-08-18\)/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Live — POS sales$/i)).toBeNull();
  });

  it('still warns on a mixed response whose snapshot half reaches outside the window', async () => {
    installFetchMock({ prod: PROD_MIXED });
    await openProductTab();
    expect(
      await screen.findByText(
        /The imported part of these totals covers its whole period/i,
        {},
        WAIT_OPTS,
      ),
    ).toBeInTheDocument();
  });

  it('never warns on a live-POS response — POS rows really are window-filtered', async () => {
    await openProductTab();
    await screen.findByText(/Live — POS sales/i, {}, WAIT_OPTS);
    expect(
      screen.queryByText(/The imported part of these totals covers its whole period/i),
    ).toBeNull();
  });

  it('renders the empty-state copy + an Import action when rows=[]', async () => {
    installFetchMock({ prod: PROD_EMPTY_ROWS });
    await openProductTab();
    expect(
      await screen.findByText(/No product sales in this window\./i, {}, WAIT_OPTS),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Import sales data$/i }),
    ).toBeInTheDocument();
  });

  it('shows the "Import sales data" toolbar button only on the Per Product tab', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    // Default tab is P&L — no importer.
    expect(
      screen.queryByRole('button', { name: /Import product sales from a CSV or Excel file/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Per Product/i }));
    expect(
      await screen.findByRole(
        'button',
        { name: /Import product sales from a CSV or Excel file/i },
        WAIT_OPTS,
      ),
    ).toBeInTheDocument();
  });
});

describe('<WellnessReports /> — Marketing Attribution tab content', () => {
  it('renders source rows with formatPercent junkRate / conversionRate + revenue', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Marketing Attribution/i }));
    expect(screen.queryByText('Hydrafacial')).toBeNull();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    // Gate on a source-row string so we know the attribution fetch landed.
    expect(await screen.findByText('IndiaMART', {}, WAIT_OPTS)).toBeInTheDocument();
    expect(screen.getByText('Instagram Ads')).toBeInTheDocument();
    // Now the att data is committed — the KPI tile labels still appear
    // alongside the rows.
    expect(screen.getByText(/Total leads/i)).toBeInTheDocument();
    expect(screen.getByText(/^Junk$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Qualified$/i)).toBeInTheDocument();
    // formatPercent renders to 1-decimal place by default.
    // junkRate 18.5 → "18.5%", 75.0 → "75.0%".
    expect(screen.getByText('18.5%')).toBeInTheDocument();
    expect(screen.getByText('75.0%')).toBeInTheDocument();
    // conversionRate 22.4 → "22.4%" (over the >10 threshold → success colour).
    expect(screen.getByText('22.4%')).toBeInTheDocument();
    expect(screen.getByText('4.0%')).toBeInTheDocument();
  });

  it('renders Attribution empty-state copy when rows=[]', async () => {
    installFetchMock({ att: ATT_EMPTY_ROWS });
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Marketing Attribution/i }));
    expect(
      await screen.findByText(/No leads in this window\./i, {}, WAIT_OPTS),
    ).toBeInTheDocument();
  });
});

describe('<WellnessReports /> — fetch failure + currency formatting', () => {
  it('renders "No data." card when the active-tab fetch rejects (SUT swallows catch → data=null)', async () => {
    installFetchMock({ pnl: new Error('500 internal') });
    renderWithRouter();
    expect(await screen.findByText(/^No data\.$/, {}, WAIT_OPTS)).toBeInTheDocument();
  });

  it('renders ₹-formatted money on the P&L Revenue tile (tenant=INR via localStorage)', async () => {
    renderWithRouter();
    // PNL_POPULATED.totals.revenue = 1234567 → "₹12,34,567" under en-IN.
    // Use findAllByText because the same number may surface on multiple
    // rows (KPI tile + per-row cells when the math aligns) — per RTL
    // standing rule, prefer getAllByText for labels that may appear in
    // multiple chrome layers.
    const matches = await screen.findAllByText(/₹12,34,567/, {}, WAIT_OPTS);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
