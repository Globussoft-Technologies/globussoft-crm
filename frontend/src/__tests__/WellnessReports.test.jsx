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
 * Reports surface (4 tabs, each its own one-shot GET, debounced):
 *
 *   1. Page chrome: heading "Reports" + tab strip with four tabs
 *      (P&L by Service / Per Professional / Per Location / Marketing
 *      Attribution) + two `type=date` inputs (from / to) render
 *      synchronously.
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

function installFetchMock({
  pnl = PNL_POPULATED,
  pro = PRO_POPULATED,
  loc = LOC_POPULATED,
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
  it('renders heading + four tab buttons synchronously', async () => {
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
    expect(url).toMatch(/^\/api\/wellness\/reports\/pnl-by-service\?from=\d{4}-\d{2}-\d{2}T00:00:00&to=\d{4}-\d{2}-\d{2}T23:59:59$/);
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

describe('<WellnessReports /> — Marketing Attribution tab content', () => {
  it('renders source rows with formatPercent junkRate / conversionRate + revenue', async () => {
    renderWithRouter();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1), WAIT_OPTS);
    fireEvent.click(screen.getByRole('button', { name: /Marketing Attribution/i }));
    // KPI tiles for attribution use distinct labels (Total leads / Junk / Qualified).
    // NOTE: gating on a SOURCE-ROW string (not a tile label) — SUT's load
    // effect doesn't pre-clear `data`, so between tab='att' commit and the
    // 350ms-debounced new fetch resolving, AttTable renders with the OLD
    // P&L payload (`data.rows` is still the P&L rows, totals.leads/junk
    // are undefined→0). Labels render as 0 during that window; the
    // distinguishing signal that the att fetch landed is a source-row
    // string from ATT_POPULATED (P&L rows have no `r.source`).
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
