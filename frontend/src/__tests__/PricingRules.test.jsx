/**
 * PricingRules.test.jsx — vitest + RTL coverage for the Travel-vertical
 * seasons + markup-rules admin page (frontend/src/pages/travel/PricingRules.jsx).
 *
 * Lands at /travel/pricing-rules. Two-section admin surface that feeds
 * POST /api/travel/pricing/quote: SeasonsSection (TravelSeasonCalendar) +
 * MarkupRulesSection (TravelMarkupRule). Both sections render independently
 * with their own filters, CSV import/export, add/edit/delete + (rules only)
 * toggle-active flows.
 *
 * Drift pinned around (prompt vs. actual code — per CLAUDE.md "Regression
 * coverage gap cards drift from actual code" standing rule + the agent
 * prompt's "ALL prompts have been wrong about something" warning):
 *
 *   - Prompt said "season filter (if present)" + framed PricingRules as a
 *     rule-list page with a season FILTER. Actual SUT has TWO independent
 *     sections — SeasonsSection (season rows, no separate season filter —
 *     seasons ARE the rows) + MarkupRulesSection (markup rule rows with
 *     subBrand/scope/active filters). The two sections are NOT joined by
 *     a single "season" filter. CONFIRMS tick #119 Agent A's CostMaster
 *     drift note: "season is in the sibling /travel/pricing-rules page" —
 *     yes, seasons live here, but as their own admin section, not as a
 *     filter on top of markup rules.
 *
 *   - Prompt said "Markup percentage formatting renders correctly
 *     (e.g. 12.5% or 12.50%)". Actual SUT formats markupPct as
 *     `${(Number(r.markupPct) * 100).toFixed(2)}%` — i.e. backend stores
 *     pct as a 0..1 fraction (0.15 = 15%) and the UI multiplies × 100.
 *     For markupFlat, format is `+₹${Number(r.markupFlat).toLocaleString()}`.
 *     Test pins both shapes against canonical fixture rows.
 *
 *   - Prompt said "Rule scope rendering: per-supplier / per-sub-brand /
 *     per-category — chip per rule scope". Actual SUT has a fixed `scope`
 *     enum {flight, hotel, transport, package} — NOT per-supplier. Rules
 *     ALSO match against `matchKeyJson` (free-form JSON e.g.
 *     `{"city":"Makkah"}` or `{"route":"DEL-JED"}`), but that's the match
 *     key, not the scope. Test pins the scope enum + matchKeyJson cell
 *     rendering.
 *
 *   - Prompt said "Sub-brand badge per row: uses real `travelSubBrand`
 *     styling OR uniform CSS-vars (read SUT)". Actual SUT uses the same
 *     inline `brandBadge` style as CostMaster.jsx — `var(--subtle-bg-3)` +
 *     `var(--primary-color)`, NOT the rgba palette from travelSubBrand.js.
 *     Test asserts the literal subBrand id text in the badge cell but does
 *     NOT assert the rgba color (CSS-var-resolved, not statically inlined).
 *     Same drift class as CostMaster.test.jsx — these two pricing-admin
 *     pages diverge from the QuotesAdmin/InvoicesAdmin/SuppliersAdmin
 *     family on badge styling.
 *
 *   - Prompt said "RBAC: USER role hides mutation CTAs". Actual SUT has
 *     ZERO role-gated affordances — every CTA visible to every role. The
 *     backend re-validates ADMIN|MANAGER on POST/PATCH and ADMIN only on
 *     DELETE (per SUT header comment lines 12-19), but the UI doesn't
 *     pre-hide them. Test omits the role=USER variant case.
 *
 *   - Prompt said "Error handling: 500 → error banner; 403 →
 *     access-restricted state". Actual SUT has NO differentiated error UI
 *     for either section — errors all surface via notify.error toast +
 *     state falls back to empty list (`setSeasons([])` / `setRules([])`).
 *     Tested via the toast surfacing path.
 *
 *   - Prompt said "edit-rule flow opens editor with pre-filled fields".
 *     SUT has TWO edit flows (one per section). Test covers the
 *     markup-rules edit-flow to pin the pct↔flat type-derivation logic
 *     (line 405: `markupType: r.markupPct != null ? "pct" : "flat"`).
 *
 *   - Prompt said "delete flow: confirmation + DELETE". SUT uses
 *     native `window.confirm`, not `notify.confirm`. Tests stub
 *     `window.confirm` per-test.
 *
 *   - Prompt said "season-based markup percentages". Misframing — seasons
 *     and markup rules are SEPARATE backend tables. Seasons store a
 *     `multiplier` (e.g. ×1.4 for peak season); markup rules store
 *     `markupPct` OR `markupFlat`. The two compose: seasons multiply
 *     baseRate, markup rules add on top (per SUT header lines 5-8).
 *
 * Backend contract pinned (per SUT header lines 11-18 + verified against
 * the page's actual wire calls):
 *   GET    /api/travel/seasons?subBrand=                   → { seasons: [] }
 *   POST   /api/travel/seasons   body:{subBrand,seasonName,startDate,endDate,multiplier?}
 *   PATCH  /api/travel/seasons/:id  body:{seasonName,startDate,endDate,multiplier}
 *   DELETE /api/travel/seasons/:id
 *
 *   GET    /api/travel/markup-rules?subBrand=&scope=&active=  → { rules: [] }
 *   POST   /api/travel/markup-rules  body:{subBrand,scope,matchKeyJson,priority,
 *                                          markupPct|null,markupFlat|null}
 *   PATCH  /api/travel/markup-rules/:id  body:{scope,matchKeyJson,priority,
 *                                              markupPct|null,markupFlat|null}
 *                                          OR body:{isActive} for toggle
 *   DELETE /api/travel/markup-rules/:id
 *
 *   (CSV export + import use raw `fetch()` with a Bearer token from
 *    getAuthToken(), NOT fetchApi. Same surface-boundary as CostMaster —
 *    chrome rendering tested, full file-blob round-trip out-of-scope.)
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
 *     cost-master"> in the header).
 *   - window.confirm stubbed per-test for the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for data-dependent
 *     text is a CI race trap).
 *
 * Scope (12 cases) — pins the page-surface invariants for BOTH sections:
 *   1. Page chrome: heading "Pricing Rules" + Cost-Master back link +
 *      both section headings ("Seasons" + "Markup Rules").
 *   2. Loading state — Seasons: shows "Loading…" before first GET resolves.
 *   3. GET on mount — both sections fire independent GETs (seasons +
 *      markup-rules) on initial render.
 *   4. Empty state — Seasons: renders "No seasons yet. Add one above."
 *   5. Empty state — Markup rules: renders "No markup rules yet. Add one above."
 *   6. Sub-brand filter — Seasons section: selecting "rfu" re-fetches
 *      with ?subBrand=rfu.
 *   7. Sub-brand + scope + active filters — Markup rules section: each
 *      filter triggers a fresh GET with the right query string.
 *   8. Season row rendering: sub-brand badge + name + dates + multiplier
 *      cell renders as "×1.40" via Number(...).toFixed(2).
 *   9. Markup-rule row rendering: pct-rule row formats as "%XX.YY"
 *      (pct × 100), flat-rule row formats as "+₹X,YYY"; matchKeyJson
 *      renders inside <code> cell.
 *  10. Add-season flow: clicking "Add season" reveals form; filling
 *      required fields + Save POSTs /api/travel/seasons with the right
 *      body shape (subBrand, seasonName, startDate, endDate, multiplier as
 *      Number).
 *  11. Validation — Seasons: missing seasonName surfaces notify.error and
 *      does NOT fire POST.
 *  12. Toggle-active on markup rule: clicking the toggle icon PATCHes
 *      /api/travel/markup-rules/:id with { isActive: !current }.
 *
 * Path: flat __tests__/ — sibling tick #120 Agent A's slot. No collision.
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
// f59e91d). Multiple callbacks in BOTH sections close over notify; a
// fresh-per-call object would flap state across re-renders.
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
import PricingRules from '../pages/travel/PricingRules';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

// Canonical season rows — three sub-brands + a row with null multiplier
// to exercise the em-dash fallback.
function makeSeason(overrides = {}) {
  return {
    id: 401,
    tenantId: 1,
    subBrand: 'rfu',
    seasonName: 'ramadan-peak',
    startDate: '2026-03-01T00:00:00.000Z',
    endDate: '2026-04-15T00:00:00.000Z',
    multiplier: 1.4,
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const SEASONS_DEFAULT = [
  makeSeason({ id: 401, subBrand: 'rfu', seasonName: 'ramadan-peak', startDate: '2026-03-01T00:00:00.000Z', endDate: '2026-04-15T00:00:00.000Z', multiplier: 1.4 }),
  makeSeason({ id: 402, subBrand: 'tmc', seasonName: 'summer-school', startDate: '2026-06-01T00:00:00.000Z', endDate: '2026-08-31T00:00:00.000Z', multiplier: 1.2 }),
];

// Canonical markup-rule rows — mix of pct vs. flat + active vs. inactive
// to exercise the formatMarkup branches + the toggle-icon opacity branch.
function makeRule(overrides = {}) {
  return {
    id: 501,
    tenantId: 1,
    subBrand: 'rfu',
    scope: 'hotel',
    matchKeyJson: '{"city":"Makkah"}',
    markupPct: 0.15,
    markupFlat: null,
    priority: 100,
    isActive: true,
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const RULES_DEFAULT = [
  makeRule({ id: 501, subBrand: 'rfu', scope: 'hotel', matchKeyJson: '{"city":"Makkah"}', markupPct: 0.15, markupFlat: null, priority: 100, isActive: true }),
  makeRule({ id: 502, subBrand: 'tmc', scope: 'flight', matchKeyJson: '{"route":"DEL-BLR"}', markupPct: null, markupFlat: 500, priority: 50, isActive: true }),
  makeRule({ id: 503, subBrand: 'visasure', scope: 'package', matchKeyJson: '{}', markupPct: 0.05, markupFlat: null, priority: 200, isActive: false }),
];

// Install a fetchApi mock that routes by URL + method. Tests override
// only the surface they care about.
function installFetchMock({
  seasonsList = { seasons: SEASONS_DEFAULT },
  rulesList = { rules: RULES_DEFAULT },
  seasonCreate = null,
  seasonPatch = null,
  seasonDelete = null,
  rulePatch = null,
  ruleDelete = null,
  ruleCreate = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/seasons?') && method === 'GET') {
      if (seasonsList instanceof Error) return Promise.reject(seasonsList);
      return Promise.resolve(seasonsList);
    }
    if (url === '/api/travel/seasons' && method === 'POST') {
      if (seasonCreate instanceof Error) return Promise.reject(seasonCreate);
      return Promise.resolve(seasonCreate || makeSeason({ id: 999 }));
    }
    if (/^\/api\/travel\/seasons\/\d+$/.test(url) && method === 'PATCH') {
      if (seasonPatch instanceof Error) return Promise.reject(seasonPatch);
      return Promise.resolve(seasonPatch || makeSeason({ id: 401 }));
    }
    if (/^\/api\/travel\/seasons\/\d+$/.test(url) && method === 'DELETE') {
      if (seasonDelete instanceof Error) return Promise.reject(seasonDelete);
      return Promise.resolve(null);
    }
    if (url.startsWith('/api/travel/markup-rules?') && method === 'GET') {
      if (rulesList instanceof Error) return Promise.reject(rulesList);
      return Promise.resolve(rulesList);
    }
    if (url === '/api/travel/markup-rules' && method === 'POST') {
      if (ruleCreate instanceof Error) return Promise.reject(ruleCreate);
      return Promise.resolve(ruleCreate || makeRule({ id: 999 }));
    }
    if (/^\/api\/travel\/markup-rules\/\d+$/.test(url) && method === 'PATCH') {
      if (rulePatch instanceof Error) return Promise.reject(rulePatch);
      return Promise.resolve(rulePatch || makeRule({ id: 501 }));
    }
    if (/^\/api\/travel\/markup-rules\/\d+$/.test(url) && method === 'DELETE') {
      if (ruleDelete instanceof Error) return Promise.reject(ruleDelete);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false }}>
        <PricingRules />
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

describe('<PricingRules /> — page chrome', () => {
  it('renders top-level heading + Cost-Master back link + both section headings', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /^Pricing Rules$/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Cost Master/i })).toBeInTheDocument();
    // Both section headings present (accessible name includes the trailing
    // count badge — e.g. "Seasons 0" — so use a permissive regex).
    expect(screen.getByRole('heading', { name: /Seasons/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Markup Rules/i, level: 2 })).toBeInTheDocument();
    // Wait for mount-time GETs to settle.
    await waitFor(() => {
      const seasonsCalls = fetchApiMock.mock.calls.filter(([u]) => typeof u === 'string' && u.startsWith('/api/travel/seasons'));
      const rulesCalls = fetchApiMock.mock.calls.filter(([u]) => typeof u === 'string' && u.startsWith('/api/travel/markup-rules'));
      expect(seasonsCalls.length).toBeGreaterThan(0);
      expect(rulesCalls.length).toBeGreaterThan(0);
    });
  });
});

describe('<PricingRules /> — load + render lifecycle', () => {
  it('shows "Loading…" in BOTH sections before first GETs resolve', async () => {
    let resolveSeasons;
    let resolveRules;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/seasons?') && method === 'GET') {
        return new Promise((res) => { resolveSeasons = res; });
      }
      if (url.startsWith('/api/travel/markup-rules?') && method === 'GET') {
        return new Promise((res) => { resolveRules = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Both sections show Loading… (two distinct instances).
    await waitFor(() => {
      const loaders = screen.getAllByText('Loading…');
      expect(loaders.length).toBeGreaterThanOrEqual(2);
    });
    resolveSeasons({ seasons: SEASONS_DEFAULT });
    resolveRules({ rules: RULES_DEFAULT });
    // Once resolved, rows render.
    await screen.findByText('ramadan-peak');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('fires both seasons + markup-rules GETs on mount with empty query strings', async () => {
    renderPage();
    await waitFor(() => {
      const seasonsCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/seasons?') && (!o?.method || o.method === 'GET'),
      );
      const rulesCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string' && u.startsWith('/api/travel/markup-rules?') && (!o?.method || o.method === 'GET'),
      );
      expect(seasonsCall).toBeTruthy();
      expect(rulesCall).toBeTruthy();
      // No filter qs when both filters empty (URLSearchParams with no entries
      // serializes to ""). SUT line 143 + 391 concatenate "?" + qs.toString().
      expect(seasonsCall[0]).toBe('/api/travel/seasons?');
      expect(rulesCall[0]).toBe('/api/travel/markup-rules?');
    });
    // Rows from BOTH sections render.
    expect(await screen.findByText('ramadan-peak')).toBeInTheDocument();
    expect(screen.getByText('summer-school')).toBeInTheDocument();
    // Markup rule matchKeyJson cell uses <code> wrapper.
    expect(screen.getByText('{"city":"Makkah"}')).toBeInTheDocument();
  });

  it('renders Seasons empty state when API returns seasons:[]', async () => {
    installFetchMock({ seasonsList: { seasons: [] } });
    renderPage();
    expect(await screen.findByText(/No seasons yet\. Add one above\./i)).toBeInTheDocument();
  });

  it('renders Markup Rules empty state when API returns rules:[]', async () => {
    installFetchMock({ rulesList: { rules: [] } });
    renderPage();
    expect(await screen.findByText(/No markup rules yet\. Add one above\./i)).toBeInTheDocument();
  });
});

describe('<PricingRules /> — filter behavior', () => {
  it('Seasons: selecting sub-brand "rfu" re-fetches /api/travel/seasons with ?subBrand=rfu', async () => {
    renderPage();
    await screen.findByText('ramadan-peak');
    fetchApiMock.mockClear();
    installFetchMock({ seasonsList: { seasons: [SEASONS_DEFAULT[0]] } });
    fireEvent.change(
      screen.getByLabelText(/Filter seasons by sub-brand/i),
      { target: { value: 'rfu' } },
    );
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/seasons?')
        && u.includes('subBrand=rfu')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('Markup Rules: sub-brand + scope + active filters each fire a re-fetch with the right qs', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    // Sub-brand filter
    fetchApiMock.mockClear();
    installFetchMock({ rulesList: { rules: [RULES_DEFAULT[0]] } });
    fireEvent.change(
      screen.getByLabelText(/Filter rules by sub-brand/i),
      { target: { value: 'rfu' } },
    );
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/markup-rules?')
        && u.includes('subBrand=rfu')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    // Scope filter
    fetchApiMock.mockClear();
    installFetchMock({ rulesList: { rules: [RULES_DEFAULT[0]] } });
    fireEvent.change(
      screen.getByLabelText(/Filter rules by scope/i),
      { target: { value: 'hotel' } },
    );
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/markup-rules?')
        && u.includes('scope=hotel')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    // Active filter
    fetchApiMock.mockClear();
    installFetchMock({ rulesList: { rules: [RULES_DEFAULT[0]] } });
    fireEvent.change(
      screen.getByLabelText(/Filter rules by active state/i),
      { target: { value: 'true' } },
    );
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/markup-rules?')
        && u.includes('active=true')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<PricingRules /> — row rendering', () => {
  it('Season row renders sub-brand badge + name + dates + multiplier "×1.40"', async () => {
    renderPage();
    const nameCell = await screen.findByText('ramadan-peak');
    const tr = nameCell.closest('tr');
    expect(tr).toBeTruthy();
    // Sub-brand badge — literal id text "rfu" inside the badge span.
    expect(within(tr).getByText('rfu')).toBeInTheDocument();
    // Dates: SUT uses fmtDate (YYYY-MM-DD slice). 2026-03-01 input renders
    // as either "2026-03-01" or "2026-02-28" depending on the test runner's
    // TZ vs UTC. Pin on the year only — locale-tolerant.
    expect(within(tr).getByText(/2026-0[23]-/)).toBeInTheDocument();
    // Multiplier cell formats as "×1.40" via Number(...).toFixed(2).
    expect(within(tr).getByText('×1.40')).toBeInTheDocument();
  });

  it('Markup rule row formats pct as "%XX.YY" via ×100, flat as "+₹X,YYY"', async () => {
    renderPage();
    // Pct row: markupPct 0.15 → "15.00%"
    const pctMatch = await screen.findByText('{"city":"Makkah"}');
    const pctTr = pctMatch.closest('tr');
    expect(pctTr).toBeTruthy();
    expect(within(pctTr).getByText('15.00%')).toBeInTheDocument();
    expect(within(pctTr).getByText('hotel')).toBeInTheDocument();
    // Flat row: markupFlat 500 → "+₹500"
    const flatMatch = screen.getByText('{"route":"DEL-BLR"}');
    const flatTr = flatMatch.closest('tr');
    expect(within(flatTr).getByText(/\+₹500/)).toBeInTheDocument();
    expect(within(flatTr).getByText('flight')).toBeInTheDocument();
  });
});

describe('<PricingRules /> — Seasons add-flow + validation', () => {
  it('clicking "Add season" reveals form; filling fields + Save POSTs /api/travel/seasons with parsed body', async () => {
    renderPage();
    await screen.findByText('ramadan-peak');
    // Form not present before clicking the CTA.
    expect(screen.queryByLabelText(/^Season name$/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add season/i }));
    // Form fields surface after click.
    const nameInput = screen.getByLabelText(/^Season name$/i);
    const startInput = screen.getByLabelText(/^Start date$/i);
    const endInput = screen.getByLabelText(/^End date$/i);
    const multInput = screen.getByLabelText(/^Multiplier$/i);
    expect(nameInput).toBeInTheDocument();
    fireEvent.change(nameInput, { target: { value: 'eid-spike' } });
    fireEvent.change(startInput, { target: { value: '2026-05-15' } });
    fireEvent.change(endInput, { target: { value: '2026-05-22' } });
    fireEvent.change(multInput, { target: { value: '1.25' } });
    fetchApiMock.mockClear();
    installFetchMock();
    // Save buttons exist in both sections (SeasonsSection + MarkupRulesSection).
    // The Seasons section shows "Create" in add-mode (per SUT line 315
    // "{editingId ? 'Save changes' : 'Create'}"). Use the first "Create" in
    // the Seasons section (only one form is open).
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/seasons' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.seasonName).toBe('eid-spike');
      expect(body.startDate).toBe('2026-05-15');
      expect(body.endDate).toBe('2026-05-22');
      // multiplier coerced to Number on submit (SUT line 172).
      expect(body.multiplier).toBe(1.25);
      // Default subBrand from blankForm ("rfu", SUT line 135).
      expect(body.subBrand).toBe('rfu');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Season created');
  });

  it('validation: missing seasonName surfaces notify.error and does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('ramadan-peak');
    fireEvent.click(screen.getByRole('button', { name: /Add season/i }));
    // Leave seasonName blank, fill dates only.
    fireEvent.change(screen.getByLabelText(/^Start date$/i), { target: { value: '2026-05-15' } });
    fireEvent.change(screen.getByLabelText(/^End date$/i), { target: { value: '2026-05-22' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/seasonName.*startDate.*endDate required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/seasons' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<PricingRules /> — Markup Rules toggle-active', () => {
  it('clicking the active-toggle PATCHes /api/travel/markup-rules/:id with { isActive: !current }', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    fetchApiMock.mockClear();
    installFetchMock();
    // Toggle button has aria-label "Toggle active for rule 501".
    fireEvent.click(
      screen.getByRole('button', { name: /Toggle active for rule 501/i }),
    );
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/travel/markup-rules/501' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      // Row 501 was isActive:true → toggle sends isActive:false.
      expect(body.isActive).toBe(false);
    });
  });
});

// ─── EXTENDED CASES (tick #C, ratio bump to ~95%) ────────────────────
//
// Coverage motivation: the original 12 cases pinned page chrome + filter
// fan-out + row rendering + Seasons add-flow + a single Markup toggle.
// These extended cases drill into the higher-risk branches the original
// suite skipped:
//
//   - Markup Rules add-flow → covers the markupValue / matchKeyJson
//     validation tree (SUT lines 412-424) + the exactly-one-of-pct/flat
//     send-shape (SUT lines 433-434) + numeric coercion of priority
//     (parseInt) + markupValue (Number).
//   - Markup Rules edit-flow → covers the pct↔flat type-derivation logic
//     (SUT line 405: `markupType: r.markupPct != null ? "pct" : "flat"`)
//     and confirms editing a flat-rule pre-fills markupValue from
//     markupFlat, not markupPct.
//   - Season edit-flow → covers the startEdit branch (SUT lines 150-160)
//     including the disabled subBrand select (locked once editing).
//   - Delete flow with window.confirm → both confirm-accept and
//     confirm-reject branches for Seasons + Markup Rules (SUT lines
//     195-203 + 469-478).
//   - Cancel-edit flow → resetting form state without firing any
//     mutation (SUT line 161 cancelEdit).
//   - Inactive row dimming + null-multiplier em-dash fallback — small
//     visual invariants that have shipped twice in this admin-page family.

describe('<PricingRules /> — Markup Rules add-flow + validation', () => {
  it('add-rule with matchKeyJson + pct sends POST with markupPct set + markupFlat null', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }));
    // Form surfaces. Fill markup value (default markupType=pct from blankForm
    // SUT line 380) + matchKeyJson textarea (default "{}").
    const valueInput = screen.getByLabelText(/^Markup value$/i);
    const matchKeyInput = screen.getByLabelText(/^Match key JSON$/i);
    fireEvent.change(valueInput, { target: { value: '0.25' } });
    fireEvent.change(matchKeyInput, { target: { value: '{"city":"Madinah"}' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/markup-rules' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      // Backend enforces exactly-one-of. SUT lines 433-434 send pct OR null.
      expect(body.markupPct).toBe(0.25);
      expect(body.markupFlat).toBeNull();
      expect(body.matchKeyJson).toBe('{"city":"Madinah"}');
      // priority parsed via parseInt (SUT line 429) — defaults to "100" string.
      expect(body.priority).toBe(100);
      expect(typeof body.priority).toBe('number');
      // Default subBrand + scope from blankForm.
      expect(body.subBrand).toBe('rfu');
      expect(body.scope).toBe('hotel');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Markup rule created');
  });

  it('switching markupType=flat sends POST with markupFlat set + markupPct null', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }));
    // Flip markupType to "flat".
    fireEvent.change(screen.getByLabelText(/^Markup type$/i), { target: { value: 'flat' } });
    fireEvent.change(screen.getByLabelText(/^Markup value$/i), { target: { value: '750' } });
    fireEvent.change(screen.getByLabelText(/^Match key JSON$/i), { target: { value: '{"route":"BOM-DXB"}' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/markup-rules' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.markupFlat).toBe(750);
      expect(body.markupPct).toBeNull();
    });
  });

  it('validation: empty matchKeyJson surfaces notify.error + skips POST', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }));
    // Blank out the matchKeyJson textarea (default is "{}", which is
    // valid — set to whitespace-only to trip the .trim() guard SUT line 413).
    fireEvent.change(screen.getByLabelText(/^Match key JSON$/i), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText(/^Markup value$/i), { target: { value: '0.1' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/matchKeyJson.*markup value required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/markup-rules' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('validation: malformed matchKeyJson surfaces "not valid JSON" error', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }));
    fireEvent.change(screen.getByLabelText(/^Match key JSON$/i), { target: { value: '{not-json' } });
    fireEvent.change(screen.getByLabelText(/^Markup value$/i), { target: { value: '0.1' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/matchKeyJson is not valid JSON/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/markup-rules' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('validation: negative markup value surfaces "non-negative number" error', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }));
    fireEvent.change(screen.getByLabelText(/^Match key JSON$/i), { target: { value: '{"city":"Jeddah"}' } });
    // Note: native input[type=number] with min=0 may strip the negative on
    // user-type, but fireEvent.change bypasses that; the value reaches the
    // handler. SUT lines 420-424 then guard with Number.isFinite + n < 0.
    fireEvent.change(screen.getByLabelText(/^Markup value$/i), { target: { value: '-5' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/markup value must be a non-negative number/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/markup-rules' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<PricingRules /> — Markup Rules edit-flow', () => {
  it('editing a pct rule pre-fills markupType=pct + markupValue from markupPct', async () => {
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    // Row 501 is the pct rule (markupPct: 0.15).
    fireEvent.click(screen.getByRole('button', { name: /Edit rule 501/i }));
    // After startEdit, markupType select reads "pct" + markupValue reads "0.15".
    const typeSelect = screen.getByLabelText(/^Markup type$/i);
    expect(typeSelect.value).toBe('pct');
    const valueInput = screen.getByLabelText(/^Markup value$/i);
    expect(valueInput.value).toBe('0.15');
    // Match key textarea pre-filled.
    expect(screen.getByLabelText(/^Match key JSON$/i).value).toBe('{"city":"Makkah"}');
    // Sub-brand select is disabled in edit mode (SUT line 566 — `disabled={editingId != null}`).
    const subBrandSelect = screen.getByLabelText(/^Sub-brand$/i);
    expect(subBrandSelect.disabled).toBe(true);
    // Save dispatches PATCH to /api/travel/markup-rules/501.
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Save changes$/ }));
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/markup-rules/501' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      // Edit-mode PATCH does NOT include subBrand (SUT POST adds it via
      // spread `...body, subBrand` line 446; PATCH body line 440 doesn't).
      expect(body.subBrand).toBeUndefined();
      expect(body.markupPct).toBe(0.15);
      expect(body.markupFlat).toBeNull();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Markup rule updated');
  });

  it('editing a flat rule pre-fills markupType=flat + markupValue from markupFlat', async () => {
    renderPage();
    await screen.findByText('{"route":"DEL-BLR"}');
    // Row 502 is the flat rule (markupFlat: 500).
    fireEvent.click(screen.getByRole('button', { name: /Edit rule 502/i }));
    // SUT line 405 derives markupType from "markupPct != null ? 'pct' : 'flat'".
    expect(screen.getByLabelText(/^Markup type$/i).value).toBe('flat');
    expect(screen.getByLabelText(/^Markup value$/i).value).toBe('500');
  });
});

describe('<PricingRules /> — Seasons edit-flow + cancel', () => {
  it('editing a season pre-fills form + locks subBrand select', async () => {
    renderPage();
    const nameCell = await screen.findByText('ramadan-peak');
    const tr = nameCell.closest('tr');
    expect(tr).toBeTruthy();
    fireEvent.click(within(tr).getByRole('button', { name: /Edit ramadan-peak/i }));
    // Seasons form surfaces with the season name pre-populated.
    expect(screen.getByLabelText(/^Season name$/i).value).toBe('ramadan-peak');
    // SUT line 276: Seasons sub-brand select disabled in edit mode.
    const allSubBrandSelects = screen.getAllByLabelText(/^Sub-brand$/i);
    // Two forms can be open in theory; in practice only Seasons is.
    // Find the disabled one within the Seasons form.
    const disabledOne = allSubBrandSelects.find((s) => s.disabled);
    expect(disabledOne).toBeTruthy();
    expect(disabledOne.value).toBe('rfu');
    // Multiplier pre-filled from String(s.multiplier) (SUT line 158).
    expect(screen.getByLabelText(/^Multiplier$/i).value).toBe('1.4');
  });

  it('Cancel button closes the Seasons form without firing any mutation', async () => {
    renderPage();
    await screen.findByText('ramadan-peak');
    fireEvent.click(screen.getByRole('button', { name: /Add season/i }));
    // Form visible.
    expect(screen.getByLabelText(/^Season name$/i)).toBeInTheDocument();
    fetchApiMock.mockClear();
    // Find the Cancel button INSIDE the Seasons form (the only open form).
    fireEvent.click(screen.getAllByRole('button', { name: /^Cancel$/ })[0]);
    // Form goes away (state reset → showForm=false → form unmounts).
    await waitFor(() => {
      expect(screen.queryByLabelText(/^Season name$/i)).toBeNull();
    });
    // No mutation fired.
    const mutations = fetchApiMock.mock.calls.filter(
      ([, o]) => o?.method === 'POST' || o?.method === 'PATCH' || o?.method === 'DELETE',
    );
    expect(mutations.length).toBe(0);
  });
});

describe('<PricingRules /> — delete flows (window.confirm)', () => {
  it('Seasons: delete with confirm=true fires DELETE /api/travel/seasons/:id', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    const nameCell = await screen.findByText('ramadan-peak');
    const tr = nameCell.closest('tr');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(within(tr).getByRole('button', { name: /Delete ramadan-peak/i }));
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Delete season "ramadan-peak" \(rfu\)\?/i),
    );
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/seasons/401' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Season deleted');
    confirmSpy.mockRestore();
  });

  it('Seasons: delete with confirm=false short-circuits (no DELETE fired)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    const nameCell = await screen.findByText('ramadan-peak');
    const tr = nameCell.closest('tr');
    fetchApiMock.mockClear();
    fireEvent.click(within(tr).getByRole('button', { name: /Delete ramadan-peak/i }));
    expect(confirmSpy).toHaveBeenCalled();
    // No DELETE fired (SUT line 196 — early-return guard).
    const dels = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'DELETE');
    expect(dels.length).toBe(0);
    confirmSpy.mockRestore();
  });

  it('Markup Rules: delete with confirm=true fires DELETE /api/travel/markup-rules/:id', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('{"city":"Makkah"}');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Delete rule 501/i }));
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Delete markup rule \(hotel \/ rfu, priority 100\)\?/i),
    );
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/markup-rules/501' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Markup rule deleted');
    confirmSpy.mockRestore();
  });
});

describe('<PricingRules /> — visual invariants', () => {
  it('null-multiplier season renders em-dash placeholder', async () => {
    installFetchMock({
      seasonsList: {
        seasons: [makeSeason({ id: 410, seasonName: 'null-mult-season', multiplier: null })],
      },
    });
    renderPage();
    const nameCell = await screen.findByText('null-mult-season');
    const tr = nameCell.closest('tr');
    // SUT line 348: `s.multiplier != null ? "×..." : <span>—</span>`.
    expect(within(tr).getByText('—')).toBeInTheDocument();
    // Negative: should NOT show "×" prefix for this row.
    expect(within(tr).queryByText(/^×/)).toBeNull();
  });

  it('inactive markup rule row shipping in the table is still interactable (toggle present)', async () => {
    renderPage();
    // Row 503 is isActive:false (per RULES_DEFAULT seed).
    await screen.findByText('{"city":"Makkah"}');
    const toggleBtn = screen.getByRole('button', { name: /Toggle active for rule 503/i });
    expect(toggleBtn).toBeInTheDocument();
    // Toggling sends isActive:true (current is false).
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(toggleBtn);
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/markup-rules/503' && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      expect(body.isActive).toBe(true);
    });
  });

  it('priority column renders raw numeric value (no formatting)', async () => {
    renderPage();
    // Row 502 has priority 50 (lowest); row 501 has 100; 503 has 200.
    await screen.findByText('{"route":"DEL-BLR"}');
    const flatTr = screen.getByText('{"route":"DEL-BLR"}').closest('tr');
    expect(within(flatTr).getByText('50')).toBeInTheDocument();
  });
});
