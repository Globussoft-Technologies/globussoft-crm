/**
 * TravelDashboard.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Owner Dashboard (frontend/src/pages/travel/Dashboard.jsx). DISTINCT from:
 *   - frontend/src/__tests__/Dashboard.test.jsx (generic sales dashboard at
 *     frontend/src/pages/Dashboard.jsx)
 *   - frontend/src/__tests__/OwnerDashboard.test.jsx (wellness owner dashboard)
 *   - frontend/src/__tests__/TravelStallDashboard.test.jsx (TS21 sub-brand SHELL)
 *   - frontend/src/__tests__/VisaDashboard.test.jsx (Phase 3 Visa Sure SHELL)
 *
 * Scope — the SUT is WIRED (not a pure SHELL like its 2 sibling sub-brand
 * dashboards). It uses useState/useEffect/fetchApi/useNotify and renders a
 * 6-tile KPI grid + Recent trips table after data resolves. One round-trip
 * to GET /api/travel/dashboard backs everything.
 *
 * Test cases (12 — sized to a wired SUT with loading/error/data/empty paths):
 *
 *   1. Page chrome — heading: <h1> "Travel CRM" renders (Compass icon is
 *      decorative aria-hidden).
 *   2. Page chrome — sub-copy interpolation: tenant.name + user.name appear
 *      ("Voyagr Travels · Alice Admin").
 *   3. Page chrome — sub-copy fallback: when user.name is empty, user.email
 *      renders ("Voyagr Travels · mgr@x.com").
 *   4. Loading state: before the first GET resolves, "Loading dashboard…"
 *      placeholder renders (per CLAUDE.md tick #108 cron-learning — use
 *      await findBy for data-dependent text).
 *   5. GET on mount: hits /api/travel/dashboard (exactly one call, no query
 *      args, no method override — default GET).
 *   6. KPI tiles — six tiles render with their labels: Active trips,
 *      Diagnostics (last 30 days), Itineraries, Microsites, Cost master
 *      (active rates), Pricing rules. Plus their headline numeric values.
 *   7. KPI tiles — accent + footer text: "12 departing in 30 days" accent
 *      under Active trips; "all current" microsites footer when expired=0;
 *      "3 expired" microsites footer when expired>0.
 *   8. KPI tiles — links: each linked tile wraps a <Link> with the expected
 *      href (/travel/trips, /travel/diagnostics, /travel/itineraries,
 *      /travel/cost-master, /travel/pricing-rules). Microsites tile is
 *      INTENTIONALLY unlinked (the SUT omits a `link` prop on it — there's
 *      no dedicated microsites surface).
 *   9. Recent trips table — happy path: renders 1 row per `recentTrips`
 *      entry, with tripCode as a <Link> to /travel/trips/:id, destination,
 *      depart + return dates, and the status badge text.
 *  10. Recent trips empty state: when recentTrips=[], renders the
 *      "No trips yet" copy with the inline <code>POST /api/travel/trips</code>
 *      hint.
 *  11. Error / unavailable state: when fetchApi rejects, notify.error is
 *      called, the data state is null, and the "Dashboard data is
 *      unavailable. Try refreshing." copy renders.
 *  12. Refresh button: clicking "Refresh" re-fires GET /api/travel/dashboard
 *      (initial + refresh click = 2 calls).
 *
 * Drift pinned (prompt vs. actual SUT — per ticks #109-#123 prompt-drift
 * discipline; the prompt anticipated either pure SHELL or unsure-which):
 *   - Prompt anticipated "IF pure SHELL (likely per the 2 sibling sub-brand
 *     dashboards)" — REALITY: the Travel-vertical landing Dashboard.jsx is
 *     FULLY WIRED, unlike the 2 sub-brand landing pages. It calls
 *     `fetchApi("/api/travel/dashboard")` on mount, holds state, renders 6
 *     KPI tiles + a Recent trips table conditionally on resolved data.
 *     SHELL-vs-wired finding: WIRED.
 *   - Prompt mentioned "sub-brand selector / breakdown (cross-brand or
 *     single-brand context?)" — REALITY: NO sub-brand selector chrome. The
 *     SUT relies on SERVER-SIDE sub-brand scoping via the caller's
 *     `subBrandAccess` — a TMC-ops user gets TMC-only counts, admins see
 *     everything. The frontend doesn't drive sub-brand. Tests omit
 *     sub-brand-filter assertions.
 *   - Prompt mentioned "nav cards to per-vertical surfaces (TMC / RFU /
 *     Travel Stall / Visa Sure)" — REALITY: NO per-sub-brand nav cards.
 *     The page links to per-RESOURCE surfaces (trips, diagnostics,
 *     itineraries, cost-master, pricing-rules) that themselves enforce
 *     server-side sub-brand isolation. Tests pin the actual hrefs.
 *   - Prompt mentioned "RBAC" — REALITY: NO RBAC gate in the SUT itself.
 *     Authz lives server-side on /api/travel/dashboard. Tests omit role
 *     assertions.
 *   - Prompt mentioned "AuthContext usage" — REALITY: YES, the SUT
 *     consumes AuthContext for the sub-copy line interpolation (tenant.name
 *     + user.name|user.email). Pinned in cases 2-3. Null-Provider robustness
 *     would be a nice-to-have but the SUT's `useContext(AuthContext) || {}`
 *     fallback covers it implicitly — case 2's render path implicitly relies
 *     on that branch when contextValue is wrapped normally.
 *   - Prompt referenced travelSubBrand.js — REALITY: SUT does NOT import
 *     travelSubBrand.js. The dashboard is cross-brand, so no per-sub-brand
 *     palette is applied. Tests omit palette assertions.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the SUT's dep).
 *   - notifyObj is STABLE module-level — Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule (fresh-per-call objects flap useCallback / useEffect
 *     dep identity).
 *   - AuthContext provided via the real Provider from App for sub-copy
 *     interpolation; MemoryRouter wraps for <Link> resolution.
 *   - For dates: fixed ISO strings; locale-tolerant substring assertions for
 *     the table fmtDate output (per CLAUDE.md cron-learning 2026-05-07).
 *   - Data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 — sync getBy for data-dependent text is a CI race trap).
 *
 * Path: flat __tests__/TravelDashboard.test.jsx — distinct file name from
 * the generic Dashboard.test.jsx to disambiguate by vertical. Sibling Agent B
 * owns TravelReports.test.jsx in the same dir — no collision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule. The SUT closes over notify
// inside `load`, so a fresh object per render would flap useEffect identity.
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
import TravelDashboard from '../pages/travel/Dashboard';

const ADMIN_USER = { userId: 1, name: 'Alice Admin', email: 'alice@x.com', role: 'ADMIN' };
const MANAGER_NO_NAME = { userId: 2, name: '', email: 'mgr@x.com', role: 'MANAGER' };
const TENANT_DEFAULT = { id: 1, name: 'Voyagr Travels', vertical: 'travel' };

// Canonical dashboard payload — the SUT consumes ALL of these fields.
const DASHBOARD_DEFAULT = {
  trips: {
    total: 47,
    byStatus: { confirmed: 12, 'in-trip': 8, completed: 25, cancelled: 2 },
    upcoming30d: 12,
  },
  diagnostics: {
    totalLast30d: 89,
    byClassification: { hot: 30, warm: 40, cold: 19 },
  },
  itineraries: {
    total: 23,
    byStatus: { draft: 5, published: 15, archived: 3 },
  },
  microsites: {
    published: 8,
    expired: 0,
  },
  costMaster: {
    activeRows: 134,
    bySubBrand: { tmc: 50, rfu: 40, travelstall: 30, visasure: 14 },
  },
  pricingRules: {
    seasons: 4,
    markupRules: 7,
  },
  recentTrips: [
    {
      id: 101,
      tripCode: 'TMC-AND-2026-MUMBAI-G7',
      destination: 'Andaman',
      departDate: '2026-12-01T00:00:00.000Z',
      returnDate: '2026-12-08T00:00:00.000Z',
      status: 'confirmed',
    },
    {
      id: 102,
      tripCode: 'RFU-UMRAH-2026-Q4',
      destination: 'Mecca',
      departDate: '2026-11-15T00:00:00.000Z',
      returnDate: '2026-11-25T00:00:00.000Z',
      status: 'in-trip',
    },
  ],
};

function installFetchMock({ data = DASHBOARD_DEFAULT } = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/travel/dashboard') {
      if (data instanceof Error) return Promise.reject(data);
      return Promise.resolve(data);
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

function renderPage({ user = ADMIN_USER, tenant = TENANT_DEFAULT } = {}) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant, loading: false }}>
        <TravelDashboard />
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
});

describe('<TravelDashboard /> — page chrome', () => {
  it('renders the "Travel CRM" heading', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Travel CRM/i }),
    ).toBeInTheDocument();
  });

  it('renders sub-copy with tenant.name + user.name interpolated', async () => {
    installFetchMock();
    renderPage();
    // SUT: `${tenant?.name || 'Travel Stall'} · ${user?.name || user?.email}`
    expect(
      screen.getByText(/Voyagr Travels.*Alice Admin/),
    ).toBeInTheDocument();
  });

  it('falls back to user.email when user.name is empty', async () => {
    installFetchMock();
    renderPage({ user: MANAGER_NO_NAME });
    expect(
      screen.getByText(/Voyagr Travels.*mgr@x\.com/),
    ).toBeInTheDocument();
  });
});

describe('<TravelDashboard /> — loading / fetch / error', () => {
  it('shows the loading placeholder before the first GET resolves', () => {
    // Block the fetch — never resolve — to keep the SUT in the loading branch.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading dashboard/i)).toBeInTheDocument();
  });

  it('hits GET /api/travel/dashboard exactly once on mount', async () => {
    installFetchMock();
    renderPage();
    // Await the data-dependent render so we know the GET completed.
    await screen.findByText('47'); // trips.total
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
    expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/dashboard');
  });

  it('renders the unavailable state and notifies on error', async () => {
    installFetchMock({ data: new Error('boom') });
    renderPage();
    await screen.findByText(/Dashboard data is unavailable\. Try refreshing\./i);
    await waitFor(() => expect(notifyError).toHaveBeenCalled());
  });
});

describe('<TravelDashboard /> — KPI tiles', () => {
  it('renders all six tile labels with their headline values', async () => {
    installFetchMock();
    renderPage();
    // Wait for data render via the trips.total headline.
    await screen.findByText('47');
    // Six tile labels.
    expect(screen.getByText('Active trips')).toBeInTheDocument();
    expect(screen.getByText('Diagnostics (last 30 days)')).toBeInTheDocument();
    expect(screen.getByText('Itineraries')).toBeInTheDocument();
    expect(screen.getByText('Microsites')).toBeInTheDocument();
    expect(screen.getByText('Cost master (active rates)')).toBeInTheDocument();
    expect(screen.getByText('Pricing rules')).toBeInTheDocument();
    // Headline values.
    expect(screen.getByText('47')).toBeInTheDocument(); // trips
    expect(screen.getByText('89')).toBeInTheDocument(); // diagnostics
    expect(screen.getByText('23')).toBeInTheDocument(); // itineraries
    expect(screen.getByText('8')).toBeInTheDocument();  // microsites published
    expect(screen.getByText('134')).toBeInTheDocument(); // costMaster activeRows
    expect(screen.getByText('11')).toBeInTheDocument();  // pricingRules: 4+7
  });

  it('renders the upcoming-30d accent and the microsites "all current" footer when expired=0', async () => {
    installFetchMock();
    renderPage();
    await screen.findByText(/12 departing in 30 days/);
    expect(screen.getByText('all current')).toBeInTheDocument();
  });

  it('renders microsites "expired" footer when expired > 0', async () => {
    installFetchMock({
      data: {
        ...DASHBOARD_DEFAULT,
        microsites: { published: 6, expired: 3 },
      },
    });
    renderPage();
    await screen.findByText(/3 expired/);
  });

  it('linked tiles wrap their content in an anchor with the expected href; microsites tile is unlinked', async () => {
    installFetchMock();
    const { container } = renderPage();
    await screen.findByText('47');

    // Active trips → /travel/trips
    const tripsAnchor = screen.getByText('Active trips').closest('a');
    expect(tripsAnchor).toHaveAttribute('href', '/travel/trips');

    // Diagnostics → /travel/diagnostics
    const diagAnchor = screen.getByText('Diagnostics (last 30 days)').closest('a');
    expect(diagAnchor).toHaveAttribute('href', '/travel/diagnostics');

    // Itineraries → /travel/itineraries
    const itinAnchor = screen.getByText('Itineraries').closest('a');
    expect(itinAnchor).toHaveAttribute('href', '/travel/itineraries');

    // Cost master → /travel/cost-master
    const costAnchor = screen.getByText('Cost master (active rates)').closest('a');
    expect(costAnchor).toHaveAttribute('href', '/travel/cost-master');

    // Pricing rules → /travel/pricing-rules
    const priceAnchor = screen.getByText('Pricing rules').closest('a');
    expect(priceAnchor).toHaveAttribute('href', '/travel/pricing-rules');

    // Microsites tile has NO link prop — its label should NOT be wrapped in an anchor.
    const micrositesLabel = screen.getByText('Microsites');
    expect(micrositesLabel.closest('a')).toBeNull();

    // Tile-link count = 5 KPI links + 2 recent-trip links = 7 anchors total.
    const anchors = container.querySelectorAll('a');
    expect(anchors.length).toBe(7);
  });
});

describe('<TravelDashboard /> — Recent trips table', () => {
  it('renders 1 row per trip with tripCode link + destination + status badge', async () => {
    installFetchMock();
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');

    // tripCode wraps a <Link> to /travel/trips/:id
    const code1 = screen.getByText('TMC-AND-2026-MUMBAI-G7');
    expect(code1.closest('a')).toHaveAttribute('href', '/travel/trips/101');

    const code2 = screen.getByText('RFU-UMRAH-2026-Q4');
    expect(code2.closest('a')).toHaveAttribute('href', '/travel/trips/102');

    // Destinations.
    expect(screen.getByText('Andaman')).toBeInTheDocument();
    expect(screen.getByText('Mecca')).toBeInTheDocument();

    // Status badge text — the badge cell shows the literal status string.
    expect(screen.getByText('confirmed')).toBeInTheDocument();
    expect(screen.getByText('in-trip')).toBeInTheDocument();
  });

  it('renders the empty state when recentTrips is empty', async () => {
    installFetchMock({
      data: { ...DASHBOARD_DEFAULT, recentTrips: [] },
    });
    renderPage();
    await screen.findByText(/No trips yet\./i);
    // The inline <code> hint should also render.
    const { container } = await waitFor(() => ({ container: document.body }));
    expect(container.querySelector('code')?.textContent).toMatch(/POST \/api\/travel\/trips/);
  });
});

describe('<TravelDashboard /> — Refresh control', () => {
  it('clicking Refresh re-fires the GET (initial + refresh = 2 calls)', async () => {
    installFetchMock();
    renderPage();
    await screen.findByText('47');
    expect(fetchApiMock).toHaveBeenCalledTimes(1);

    const refresh = screen.getByRole('button', { name: /Refresh/i });
    fireEvent.click(refresh);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(2));
    // Same endpoint on the second call.
    expect(fetchApiMock).toHaveBeenNthCalledWith(2, '/api/travel/dashboard');
  });
});
