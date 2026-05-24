/**
 * CostMaster.test.jsx — vitest + RTL coverage for the Travel-vertical
 * supplier-rate-book admin page (frontend/src/pages/travel/CostMaster.jsx).
 *
 * Lands at /travel/cost-master. Operator + manager surface for the supplier
 * rate book RFU + Travel Stall advisors look up when building itinerary line
 * items. Phase-1 simple admin shape: NO edit, NO delete, NO RBAC gating —
 * just read + add + toggle-active + CSV import/export. The header sub-brand
 * pill is rendered via CSS-vars (NOT travelSubBrand.js — that page uses its
 * own inline brandBadge style) — so this test does NOT import the
 * travelSubBrand util and does NOT assert the rgba palette. That divergence
 * vs sibling SuppliersAdmin/QuotesAdmin is pinned in the drift block below.
 *
 * Scope (10 cases) — pins the page-surface invariants:
 *
 *   1. Page chrome: heading "Cost Master" + sub-brand filter + category
 *      filter + Pricing-rules link + Export CSV + Import CSV + "Add rate"
 *      CTA all render. (No RBAC gate — CTAs visible to every role.)
 *   2. Loading state: shows "Loading…" placeholder before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/cost-master?limit=200 (the SUT always
 *      appends limit=200 even with empty filters) and renders one row per rate.
 *   4. Empty state: renders "No rates yet. Add one above." when API returns
 *      empty `rates` array.
 *   5. Sub-brand filter: selecting "rfu" re-fetches with ?subBrand=rfu
 *      (camelCase, per SUT line 49).
 *   6. Category filter: selecting "hotel" re-fetches with ?category=hotel.
 *   7. Money formatting: row baseRate renders as "₹X,YYY" via
 *      Number(...).toLocaleString() — pinned against the "5,000" digit
 *      substring + the leading "₹" symbol (locale-tolerant).
 *   8. Add-rate form reveal + POST: clicking "Add rate" reveals the form;
 *      filling routeOrSku + baseRate + Save POSTs /api/travel/cost-master
 *      with numeric baseRate + form defaults (subBrand:"rfu", category:"hotel",
 *      currency:"INR") and surfaces notify.success("Rate added").
 *   9. Add-rate validation: missing routeOrSku surfaces notify.error and
 *      does NOT fire POST.
 *  10. Toggle-active: clicking the active-toggle icon PATCHes
 *      /api/travel/cost-master/:id with `{ isActive: !current }`.
 *
 * Backend contract pinned (per the SUT's wire calls — verified read-only,
 * no backend route file inspection needed since the SUT itself is the
 * source of truth for the request shapes the page emits):
 *   GET    /api/travel/cost-master?subBrand=&category=&limit=200
 *          → 200 { rates: [...] }
 *   POST   /api/travel/cost-master  body:{subBrand,category,routeOrSku,
 *                                         baseRate(number),currency}
 *   PATCH  /api/travel/cost-master/:id  body:{ isActive }
 *   GET    /api/travel/cost-master/export.csv?subBrand=&category=
 *   POST   /api/travel/cost-master/import.csv  body: csv text
 *
 *   (Export + Import use raw `fetch()` with a Bearer token from
 *    getAuthToken(); fetchApi is NOT used for those two paths. So the
 *    export/import-specific E2E paths intentionally fall outside the
 *    mocked-fetchApi surface and are NOT covered here — see the drift
 *    block below for the explicit rationale.)
 *
 * Drift pinned around (prompt vs. actual code — per CLAUDE.md "Regression
 * coverage gap cards drift from actual code" standing rule + the agent
 * prompt's "ALL prompts have been wrong about something" warning):
 *
 *   - Prompt mentioned "create / edit / delete flows" — actual SUT has
 *     ZERO edit + ZERO delete affordances. Edits aren't supported in Phase 1
 *     per schema-edit-discipline (SUT comment lines 4-7). Inactive rows get
 *     hidden via the active-toggle, not deleted.
 *   - Prompt mentioned "RBAC: USER role hides mutation CTAs" — actual SUT
 *     has ZERO role-gated affordances. Every CTA is visible to every role.
 *     Tests assert visibility with the default ADMIN user only.
 *   - Prompt mentioned "money formatting: compacted Indian-locale `₹X.YYL`
 *     or plain — read SUT first" — actual SUT uses plain
 *     `₹${Number(r.baseRate).toLocaleString()}` (no lakh/crore compaction,
 *     no formatMoney import). Test pins the "₹" + digits substring.
 *   - Prompt mentioned "Sub-brand badge per row: uses real `travelSubBrand`
 *     styling OR uniform CSS-vars (read SUT)" — actual SUT uses inline
 *     `brandBadge` style with `var(--subtle-bg-3)` + `var(--primary-color)`
 *     (NOT the rgba palette from travelSubBrand.js). Test asserts the
 *     literal subBrand id text is rendered in the badge cell but does NOT
 *     assert the rgba color (it's CSS-var resolved, not statically inlined).
 *   - Prompt mentioned "RBAC USER role hides mutation CTAs (only if SUT has
 *     them; check first)" — SUT has NONE, so test omits the role=USER case.
 *   - Prompt mentioned "Error handling: 500 → error banner; 403 →
 *     access-restricted state" — SUT has NO differentiated error UI;
 *     errors all surface via notify.error toast. The SUT path on list GET
 *     failure is: notify.error(e?.body?.error || "Failed to load rates")
 *     + setRates([]) → renders the SAME "No rates yet" empty-state copy as
 *     a benign empty list. No 403-specific copy. Test covers the toast
 *     surfacing in case 9 (validation error path); the empty-on-error
 *     branch is structurally identical to case 4 (benign empty).
 *   - Prompt mentioned "season / item-type filter" — SUT has NO season
 *     filter; filters are sub-brand + category only. The SUT's SEASON token
 *     is mentioned ONLY in the explanatory <p> copy ("/pricing/quote applies
 *     seasons + markup rules over these base rates") referring to the
 *     SEPARATE /travel/pricing-rules page. Not a CostMaster filter.
 *   - Prompt mentioned "Edit-cost flow" — none exists. Toggle-active is the
 *     only mutation on existing rows.
 *   - CSV import + export use raw `fetch()` + getAuthToken() directly, NOT
 *     fetchApi. They're outside the mocked-fetchApi surface. The CTAs are
 *     rendered + the file-input wiring is exercised via the chrome test,
 *     but the full file-blob round-trip is OUT-OF-SCOPE for a vitest+RTL
 *     unit test (covered at e2e layer via tests/travel-cost-master-api.spec.js
 *     if/when authored).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - getAuthToken stubbed inside the same vi.mock so the export CTA
 *     doesn't blow up if/when accidentally clicked.
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - AuthContext is consumed via real Provider wrapper. Default user role
 *     = ADMIN. (No role-variant tests — see RBAC drift item above.)
 *   - MemoryRouter wraps the SUT (the page renders a <Link to="/travel/
 *     pricing-rules"> in the chrome).
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for data-dependent
 *     text is a CI race trap).
 *
 * Path: flat __tests__/ — sibling Agent B owns DiagnosticBuilder.test.jsx
 * in the same flat dir; no path collision.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside add() / toggleActive(), so a
// fresh object per render would flap state across re-renders.
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
import CostMaster from '../pages/travel/CostMaster';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

// Canonical rate rows — three sub-brands + mix of categories + isActive
// states to exercise badge + toggle-icon render paths.
function makeRate(overrides = {}) {
  return {
    id: 301,
    tenantId: 1,
    subBrand: 'rfu',
    category: 'hotel',
    routeOrSku: 'Makkah:Hilton:Deluxe',
    baseRate: 5000,
    currency: 'INR',
    isActive: true,
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const RATES_DEFAULT = [
  makeRate({ id: 301, subBrand: 'rfu', category: 'hotel', routeOrSku: 'Makkah:Hilton:Deluxe', baseRate: 5000, isActive: true }),
  makeRate({ id: 302, subBrand: 'tmc', category: 'flight', routeOrSku: 'DEL-BLR:Indigo:Econ', baseRate: 4500, isActive: true }),
  makeRate({ id: 303, subBrand: 'visasure', category: 'visa', routeOrSku: 'UAE:Tourist:30d', baseRate: 8000, isActive: false }),
];

// Install a fetchApi mock that routes by URL + method. Tests override only
// the surface they care about.
function installFetchMock({
  list = { rates: RATES_DEFAULT },
  create = null,
  patch = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/cost-master?') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url === '/api/travel/cost-master' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeRate({ id: 999 }));
    }
    if (/^\/api\/travel\/cost-master\/\d+$/.test(url) && method === 'PATCH') {
      if (patch instanceof Error) return Promise.reject(patch);
      return Promise.resolve(patch || makeRate({ id: 301 }));
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false }}>
        <CostMaster />
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

describe('<CostMaster /> — page chrome', () => {
  it('renders heading + filter bar + Pricing-rules link + Export/Import + "Add rate" CTA', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Cost Master/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Sub-brand$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Category$/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pricing rules/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add rate/i })).toBeInTheDocument();
    // Wait for mount-time GET to settle so subsequent tests see a clean slate.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(([u]) => typeof u === 'string' && u.startsWith('/api/travel/cost-master'));
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('<CostMaster /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/cost-master?') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ rates: RATES_DEFAULT });
    // Once resolved, Loading disappears + rows render.
    await screen.findByText('Makkah:Hilton:Deluxe');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/cost-master?limit=200 on mount (no other query string when filters empty)', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/cost-master?') && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      // limit=200 always present per SUT line 51 (qs.set("limit","200"))
      expect(listCall[0]).toMatch(/limit=200/);
      // No subBrand / category in the URL when both filters are blank.
      expect(listCall[0]).not.toMatch(/subBrand=/);
      expect(listCall[0]).not.toMatch(/category=/);
    });
    // Renders one row per rate.
    expect(await screen.findByText('Makkah:Hilton:Deluxe')).toBeInTheDocument();
    expect(screen.getByText('DEL-BLR:Indigo:Econ')).toBeInTheDocument();
    expect(screen.getByText('UAE:Tourist:30d')).toBeInTheDocument();
  });

  it('renders empty state "No rates yet. Add one above." when API returns rates:[]', async () => {
    installFetchMock({ list: { rates: [] } });
    renderPage();
    expect(await screen.findByText(/No rates yet\. Add one above\./i)).toBeInTheDocument();
  });
});

describe('<CostMaster /> — filter behaviour', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu in the URL', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    installFetchMock({ list: { rates: [RATES_DEFAULT[0]] } });
    fireEvent.change(screen.getByLabelText(/^Sub-brand$/i), { target: { value: 'rfu' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('subBrand=rfu') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting category "hotel" re-fetches with ?category=hotel in the URL', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    installFetchMock({ list: { rates: [RATES_DEFAULT[0]] } });
    fireEvent.change(screen.getByLabelText(/^Category$/i), { target: { value: 'hotel' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.includes('category=hotel') && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<CostMaster /> — row rendering: money + sub-brand badge', () => {
  it('row baseRate renders as "₹X,YYY" via Number(...).toLocaleString() — INR row contains "5,000"', async () => {
    renderPage();
    const routeCell = await screen.findByText('Makkah:Hilton:Deluxe');
    const tr = routeCell.closest('tr');
    expect(tr).toBeTruthy();
    // Money cell renders "₹5,000" (en-IN thousands separator). Pin the digit
    // substring + the leading rupee glyph — locale-tolerant.
    expect(within(tr).getByText(/₹5,000/)).toBeInTheDocument();
    // Sub-brand badge cell contains the literal subBrand id "rfu".
    // The badge uses CSS-vars (--subtle-bg-3 / --primary-color), NOT the
    // travelSubBrand.js rgba palette — so we only assert the text content,
    // not the resolved color.
    expect(within(tr).getByText('rfu')).toBeInTheDocument();
  });
});

describe('<CostMaster /> — add-rate form: reveal + POST + validation', () => {
  it('clicking "Add rate" reveals the form; filling routeOrSku + baseRate + Save POSTs with numeric baseRate + form defaults', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    // Form not present before clicking the CTA.
    expect(screen.queryByPlaceholderText(/routeOrSku/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add rate/i }));
    // After click, form fields surface.
    const routeInput = screen.getByPlaceholderText(/routeOrSku/i);
    const baseInput = screen.getByPlaceholderText(/baseRate/i);
    expect(routeInput).toBeInTheDocument();
    expect(baseInput).toBeInTheDocument();
    fireEvent.change(routeInput, { target: { value: 'Madinah:Pullman:Suite' } });
    // baseRate is a number input; SUT submits Number(form.baseRate).
    fireEvent.change(baseInput, { target: { value: '12500.50' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/cost-master' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      // baseRate coerced to number on submit.
      expect(body.baseRate).toBe(12500.5);
      expect(body.routeOrSku).toBe('Madinah:Pullman:Suite');
      // Defaults from initial form state (SUT line 38-44).
      expect(body.subBrand).toBe('rfu');
      expect(body.category).toBe('hotel');
      expect(body.currency).toBe('INR');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Rate added');
  });

  it('validation: empty routeOrSku surfaces notify.error and does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fireEvent.click(screen.getByRole('button', { name: /Add rate/i }));
    // baseRate set but routeOrSku left blank.
    fireEvent.change(screen.getByPlaceholderText(/baseRate/i), { target: { value: '1000' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/routeOrSku and baseRate required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/cost-master' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<CostMaster /> — toggle-active', () => {
  it('clicking the active-toggle on a row PATCHes /api/travel/cost-master/:id with { isActive: !current }', async () => {
    renderPage();
    await screen.findByText('Makkah:Hilton:Deluxe');
    fetchApiMock.mockClear();
    installFetchMock();
    // Toggle button has aria-label "Toggle active for Makkah:Hilton:Deluxe".
    fireEvent.click(
      screen.getByRole('button', { name: /Toggle active for Makkah:Hilton:Deluxe/i }),
    );
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/cost-master/301' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      // Row 301 was isActive:true → toggle sends isActive:false.
      expect(body.isActive).toBe(false);
    });
  });
});
