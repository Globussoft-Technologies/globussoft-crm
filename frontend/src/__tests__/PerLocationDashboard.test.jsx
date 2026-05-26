/**
 * PerLocationDashboard.test.jsx — vitest + RTL coverage for the wellness-vertical
 * side-by-side per-clinic comparison dashboard
 * (frontend/src/pages/wellness/PerLocationDashboard.jsx).
 *
 * Scope: pins the page-surface invariants for the multi-clinic comparison view —
 * loading state, GET sequence on mount (locations + per-loc dashboard + pnl +
 * week-visits), single-location prompt branch (<2 active locations renders an
 * "Add a second clinic" empty-state, not the comparison grid), two-or-more
 * branch (one column per active location with Today/This-week/People/Top-services
 * sections), money formatting via tenant currency (localStorage-backed
 * `formatMoney`), and graceful per-fetch failure handling (each per-location
 * fetch has its own `.catch` so a single bad endpoint doesn't blank the whole
 * comparison).
 *
 * Test cases (11):
 *   1. Loading state: renders "Loading per-location comparison…" while the
 *      initial GET /api/wellness/locations is in flight.
 *   2. Single-location empty-state: GET resolves to 1 active location → renders
 *      "Add a second clinic to compare" + "Admin → Locations" CTA copy.
 *   3. Zero-location empty-state: GET resolves to [] → renders the same "Add a
 *      second clinic" empty-state (locations.length < 2 branch).
 *   4. Inactive-location filter: isActive=false locations are excluded; a list
 *      of [Ranchi active, Patna inactive] renders the 1-location empty-state.
 *   5. Mount fetch sequence: with 2+ active locations, fires GET on
 *      /api/wellness/locations, then /api/wellness/dashboard?locationId=<id>,
 *      /api/wellness/reports/pnl-by-service?locationId=<id>, and
 *      /api/wellness/visits?from=...&limit=500 for each location.
 *   6. Per-location column render: each location's column shows name + city,state
 *      + Today/This week/People/Top services section headers.
 *   7. KPI tile values: Today.visits, Today.completed, Today.occupancyPct (with
 *      "%"), and totals.patients all surface in their respective rows.
 *   8. Week revenue: visits filtered by locationId, amountCharged summed, and
 *      formatted via formatMoney (tenant currency).
 *   9. Staff (this week) tile: unique doctorId set size across this week's
 *      visits at the location is rendered.
 *  10. Top services panel: pnl.rows is sliced to 3 + name/revenue rendered; an
 *      empty rows array renders "No completed visits yet." copy.
 *  11. Graceful per-fetch failure: a 500 on /dashboard for one location leaves
 *      the column rendered with `0` KPI fallbacks (today/totals default), so the
 *      comparison stays usable when one endpoint is briefly down.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - SUT consumes `formatMoney` from `../../utils/money` which reads tenant
 *     currency from localStorage — `beforeEach` seeds `localStorage.tenant` to
 *     {defaultCurrency:'INR', locale:'en-IN'} so money assertions read ₹ symbol
 *     + Indian grouping.
 *   - SUT does NOT consume AuthContext → no Provider wrapper required.
 *   - No notify mock needed (SUT has no toast surface — failures degrade
 *     silently via `.catch` per SUT lines 35-39).
 *   - vi.mock path is `../utils/api` (relative to flat __tests__/).
 *
 * Drift pinned (prompt anticipated vs. actual SUT):
 *   - Prompt anticipated "/api/wellness/dashboard/per-location" or
 *     "/api/wellness/reports/per-location" as the primary endpoint. REALITY:
 *     SUT does NOT call a single per-location aggregate endpoint. It fans out
 *     N parallel calls to /api/wellness/dashboard?locationId=, then
 *     /api/wellness/reports/pnl-by-service?locationId= for top services, plus
 *     /api/wellness/visits?from=…&limit=500 for week-revenue + staff-count
 *     calculations (SUT lines 34-40). Pinned the fan-out instead.
 *   - Prompt anticipated "date-range picker" + "location filter (chrome)".
 *     REALITY: SUT has NO date-range picker and NO location filter chrome. The
 *     date window for week-revenue is hardcoded (last 7 days, SUT
 *     weekStart() helper line 247-252). All active locations are always
 *     rendered side-by-side; there's no narrow-to-single-location chip.
 *     Omitted both interaction cases.
 *   - Prompt anticipated "loading state await findByText for actual literal".
 *     CONFIRMED — SUT line 81 renders "Loading per-location comparison…" with
 *     a real ellipsis character (U+2026), not three ASCII dots. Pinned in
 *     case 1 via regex on "Loading per-location comparison".
 *   - Prompt anticipated "empty-state UI" for zero data. REALITY: SUT has TWO
 *     low-data branches collapsed into one: 0 locations and 1 location BOTH
 *     render the "Add a second clinic" CTA (SUT line 84
 *     `if (locations.length < 2)`). The empty-copy reads "no locations" when 0
 *     and "one location" when 1. Pinned both as separate cases (cases 2 + 3).
 *   - Prompt anticipated "error handling: 500 → silent degrade or notify.error;
 *     403 → access-restricted". CONFIRMED silent degrade — SUT lines 35-39
 *     each per-location fetch has its own `.catch(() => null/[])` so a single
 *     bad endpoint just leaves that field undefined; the outer .catch (SUT
 *     line 70) only fires when the FIRST `/api/wellness/locations` GET
 *     rejects (renders the empty-state). No notify.error surface. Pinned the
 *     per-fetch graceful-degrade in case 11; outer reject by inference (no
 *     dedicated case since it would only re-prove case 3's empty-state).
 *   - Prompt anticipated "Top services per location panel: services with
 *     revenue". CONFIRMED — SUT lines 186-211 render `pnl.rows.slice(0, 3)`
 *     with name + formatted revenue. Empty rows renders "No completed visits
 *     yet." copy (SUT line 188).
 *   - Prompt anticipated "money formatting: revenue renders in tenant
 *     currency". CONFIRMED — SUT line 7 wraps `formatMoney` from utils/money.
 *     formatMoney reads localStorage `tenant` for `defaultCurrency` + `locale`
 *     → seeded INR locale in beforeEach so assertions read ₹ symbol +
 *     Indian-grouping (lakh-style: ₹1,23,400 not ₹123,400).
 *   - Prompt anticipated "AuthContext via real Provider wrapper IF SUT
 *     consumes it". CONFIRMED — SUT does NOT consume AuthContext. The
 *     formatMoney helper reads localStorage directly (utils/money.js
 *     readTenant). No wrapper needed.
 *
 * Path: flat __tests__/PerLocationDashboard.test.jsx — matches sibling
 * Locations / OwnerDashboard flat-path convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import PerLocationDashboard from '../pages/wellness/PerLocationDashboard';

const RANCHI = {
  id: 501,
  name: 'Ranchi',
  city: 'Ranchi',
  state: 'Jharkhand',
  isActive: true,
};
const PATNA = {
  id: 502,
  name: 'Patna',
  city: 'Patna',
  state: 'Bihar',
  isActive: true,
};
const DHANBAD_INACTIVE = {
  id: 503,
  name: 'Dhanbad',
  city: 'Dhanbad',
  state: 'Jharkhand',
  isActive: false,
};

const RANCHI_DASHBOARD = {
  today: { visits: 12, completed: 9, occupancyPct: 75 },
  totals: { patients: 320 },
};
const PATNA_DASHBOARD = {
  today: { visits: 7, completed: 4, occupancyPct: 48 },
  totals: { patients: 195 },
};

const RANCHI_PNL = {
  rows: [
    { id: 11, name: 'Hair Restoration Package', revenue: 285000 },
    { id: 12, name: 'PRP Therapy', revenue: 142000 },
    { id: 13, name: 'GFC Treatment', revenue: 98000 },
    { id: 14, name: 'Beard Transplant', revenue: 76000 }, // 4th — should be sliced off.
  ],
};
const PATNA_PNL = { rows: [] };

const RANCHI_VISITS_WEEK = [
  { id: 1001, locationId: 501, doctorId: 21, amountCharged: 12500 },
  { id: 1002, locationId: 501, doctorId: 21, amountCharged: 8000 },
  { id: 1003, locationId: 501, doctorId: 22, amountCharged: 15000 },
  // Visit at a different location — must be filtered out.
  { id: 1004, locationId: 502, doctorId: 31, amountCharged: 50000 },
];
const PATNA_VISITS_WEEK = [
  { id: 2001, locationId: 502, doctorId: 31, amountCharged: 4500 },
];

function installFetchMock({
  locations = [RANCHI, PATNA],
  locationsPromise = null,
  // Per-location overrides keyed by locationId.
  dashboards = { 501: RANCHI_DASHBOARD, 502: PATNA_DASHBOARD },
  pnls = { 501: RANCHI_PNL, 502: PATNA_PNL },
  visits = [...RANCHI_VISITS_WEEK, ...PATNA_VISITS_WEEK],
  // Optional reject map for granular failure tests.
  rejectDashboardFor = null,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/wellness/locations') {
      return locationsPromise || Promise.resolve(locations);
    }
    const dashMatch = url.match(/\/api\/wellness\/dashboard\?locationId=(\d+)/);
    if (dashMatch) {
      const locId = Number(dashMatch[1]);
      if (rejectDashboardFor === locId) return Promise.reject(new Error('boom'));
      return Promise.resolve(dashboards[locId] || null);
    }
    const pnlMatch = url.match(
      /\/api\/wellness\/reports\/pnl-by-service\?locationId=(\d+)/,
    );
    if (pnlMatch) {
      const locId = Number(pnlMatch[1]);
      return Promise.resolve(pnls[locId] || { rows: [] });
    }
    if (url.startsWith('/api/wellness/visits?from=')) {
      return Promise.resolve(visits);
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  // Seed tenant currency so formatMoney renders ₹ symbol + Indian grouping
  // — the wellness vertical's canonical tenant per CLAUDE.md.
  localStorage.setItem(
    'tenant',
    JSON.stringify({ defaultCurrency: 'INR', locale: 'en-IN' }),
  );
});

describe('<PerLocationDashboard /> — loading + empty branches', () => {
  it('renders the loading copy while the initial GET is in flight', async () => {
    installFetchMock({ locationsPromise: new Promise(() => {}) });
    render(<PerLocationDashboard />);
    expect(
      await screen.findByText(/Loading per-location comparison/),
    ).toBeInTheDocument();
  });

  it('renders the "Add a second clinic" empty-state when only 1 active location exists', async () => {
    installFetchMock({ locations: [RANCHI] });
    render(<PerLocationDashboard />);
    expect(
      await screen.findByText(/Add a second clinic to compare/i),
    ).toBeInTheDocument();
    // 1-location wording: "You currently have one location."
    // RTL note: matcher resolves on the wrapping <p> AND the descendant span
    // because text-content regex bubbles up. Use getAllByText with >=1 floor
    // per CLAUDE.md standing rule.
    expect(
      screen.getAllByText((_t, el) =>
        /You currently have one location/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // CTA path is Admin → Locations.
    expect(
      screen.getAllByText((_t, el) =>
        /Admin\s*→\s*Locations/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('renders the same empty-state when GET resolves to [] (no locations)', async () => {
    installFetchMock({ locations: [] });
    render(<PerLocationDashboard />);
    expect(
      await screen.findByText(/Add a second clinic to compare/i),
    ).toBeInTheDocument();
    // 0-location wording: "You currently have no locations."
    expect(
      screen.getAllByText((_t, el) =>
        /You currently have no locations/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('treats inactive locations as absent (isActive:false filtered out)', async () => {
    // Only Ranchi is active; Dhanbad is inactive → effective count 1 →
    // empty-state, NOT the comparison grid.
    installFetchMock({ locations: [RANCHI, DHANBAD_INACTIVE] });
    render(<PerLocationDashboard />);
    expect(
      await screen.findByText(/Add a second clinic to compare/i),
    ).toBeInTheDocument();
    // The heading "Per-Location Dashboard" still appears (header is shared
    // between empty-state and comparison branches).
    expect(
      screen.getAllByRole('heading', { level: 1, name: /Per-Location Dashboard/i })
        .length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('<PerLocationDashboard /> — fan-out fetch sequence (2+ locations)', () => {
  it('fires per-location dashboard + pnl-by-service + visits GETs for each active location', async () => {
    installFetchMock();
    render(<PerLocationDashboard />);
    // Wait for one of the column heads to render — that means the
    // Promise.all of fan-out fetches has resolved.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/ }),
      ).toBeInTheDocument();
    });
    // Initial locations GET fired.
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/locations');
    // Per-location dashboard GET for each id.
    const calls = fetchApiMock.mock.calls.map((c) => c[0]);
    expect(calls.some((u) => u === '/api/wellness/dashboard?locationId=501')).toBe(
      true,
    );
    expect(calls.some((u) => u === '/api/wellness/dashboard?locationId=502')).toBe(
      true,
    );
    // Per-location pnl-by-service GET for each id.
    expect(
      calls.some(
        (u) => u === '/api/wellness/reports/pnl-by-service?locationId=501',
      ),
    ).toBe(true);
    expect(
      calls.some(
        (u) => u === '/api/wellness/reports/pnl-by-service?locationId=502',
      ),
    ).toBe(true);
    // Week-visits GET (carries from= ISO + limit=500).
    expect(
      calls.some((u) =>
        /^\/api\/wellness\/visits\?from=.*&limit=500$/.test(u),
      ),
    ).toBe(true);
  });

  it('renders a column for each active location (name + city,state + section headers)', async () => {
    installFetchMock();
    render(<PerLocationDashboard />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/ }),
      ).toBeInTheDocument();
    });
    // Both location headings present.
    expect(
      screen.getByRole('heading', { level: 3, name: /Patna/ }),
    ).toBeInTheDocument();
    // City + state composite cell — Ranchi, Jharkhand / Patna, Bihar.
    // Use getAllByText >=1 because the parent <div> + inner text-node both
    // resolve the regex matcher.
    expect(
      screen.getAllByText((_t, el) =>
        /Ranchi,\s*Jharkhand/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) =>
        /Patna,\s*Bihar/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Per-column section headers (one set per location → use getAllByText).
    expect(screen.getAllByText(/^Today$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/^This week$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/^People$/).length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText(/Top services \(last 30 days\)/i).length,
    ).toBeGreaterThanOrEqual(2);
    // Header sub-copy includes the column count.
    expect(
      screen.getAllByText((_t, el) =>
        /Comparing 2 clinics/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('renders Today KPI tile values: visits + completed + occupancyPct (with %)', async () => {
    installFetchMock();
    render(<PerLocationDashboard />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/ }),
      ).toBeInTheDocument();
    });
    // Ranchi: visits=12, completed=9, occupancyPct=75 ("75%").
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    // Patna: visits=7, completed=4, occupancyPct=48 ("48%").
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('48%')).toBeInTheDocument();
    // totals.patients renders under People → "Active patients".
    expect(screen.getByText('320')).toBeInTheDocument();
    expect(screen.getByText('195')).toBeInTheDocument();
  });

  it('week revenue: sums amountCharged of visits filtered by locationId + renders formatMoney output', async () => {
    installFetchMock();
    render(<PerLocationDashboard />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/ }),
      ).toBeInTheDocument();
    });
    // Ranchi: 12500 + 8000 + 15000 = 35500. Locale en-IN with INR groups
    // as ₹35,500 (no fractional digits because integer). The cross-location
    // 50000 visit (locationId=502 in the Ranchi visit list) must NOT be
    // included — that's the load-bearing filter.
    expect(
      screen.getAllByText((_t, el) =>
        /₹35,500/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Patna: 4500 + 50000 (the locationId=502 row from RANCHI_VISITS_WEEK) =
    // 54500 → "₹54,500".
    expect(
      screen.getAllByText((_t, el) =>
        /₹54,500/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('Staff (this week) tile shows the unique doctorId count across the week', async () => {
    installFetchMock();
    render(<PerLocationDashboard />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/ }),
      ).toBeInTheDocument();
    });
    // Ranchi: distinct doctorIds across [21, 21, 22] → 2 unique.
    // Patna: distinct doctorIds across [31, 31] → 1 unique. (The Patna
    // visit list combines its own row + the cross-location row from the
    // Ranchi list since both belong to locationId=502.)
    const staffLabels = screen.getAllByText(/Staff \(this week\)/i);
    expect(staffLabels.length).toBeGreaterThanOrEqual(2);
    // Pin: at least one tile reads "2" (Ranchi distinct doctors).
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
  });

  it('Top services panel slices to 3 rows (name + revenue) and empty rows renders "No completed visits yet."', async () => {
    installFetchMock();
    render(<PerLocationDashboard />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/ }),
      ).toBeInTheDocument();
    });
    // Ranchi: top 3 of 4 should render — 4th (Beard Transplant) sliced off.
    expect(screen.getByText('Hair Restoration Package')).toBeInTheDocument();
    expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    expect(screen.getByText('GFC Treatment')).toBeInTheDocument();
    expect(screen.queryByText('Beard Transplant')).not.toBeInTheDocument();
    // Top-service revenues: 285000 → ₹2,85,000 (Indian grouping).
    expect(
      screen.getAllByText((_t, el) =>
        /₹2,85,000/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Patna's empty pnl rows → "No completed visits yet." copy.
    expect(screen.getByText(/No completed visits yet\./i)).toBeInTheDocument();
  });

  it('gracefully degrades when one location\'s /dashboard fetch rejects (column still renders with 0 fallbacks)', async () => {
    // Reject the Ranchi dashboard endpoint — the SUT's per-fetch
    // `.catch(() => null)` should leave dashboard=null and the column
    // falls back to the `?? 0` defaults inside LocationColumn.
    installFetchMock({ rejectDashboardFor: 501 });
    render(<PerLocationDashboard />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: /Ranchi/ }),
      ).toBeInTheDocument();
    });
    // Patna column unaffected → its 7/4/48% values still present.
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('48%')).toBeInTheDocument();
    // Ranchi column renders the `0` fallbacks for Today.visits + completed
    // (multiple zeros expected — at least 2 from Today + 1 from
    // totals.patients fallback).
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2);
    // "0%" occupancy fallback also present.
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
