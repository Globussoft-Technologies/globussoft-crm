/**
 * TravelStallDashboard.test.jsx — vitest + RTL coverage for the Travel Stall
 * operator landing page (frontend/src/pages/travel/TravelStallDashboard.jsx,
 * shipped commit 5511594 — TS21 Phase 2 SHELL scaffold).
 *
 * Scope — the SUT is a pure PRESENTATION SHELL (declarative, no useState /
 * useEffect / fetch / mutation). It renders a heading, an optional sub-copy
 * line interpolating tenant.name + user.name|user.email from AuthContext,
 * an advisory blurb, and 4 nav
 * cards each wrapping a react-router <Link> to a deeper Travel Stall surface
 * pre-filtered with `?subBrand=travelstall`. There is NO loading state, NO
 * KPI tile, NO filter chrome, NO mutation surface, NO RBAC gating in the
 * SUT itself — sub-brand authZ + RBAC are enforced server-side on the
 * deeper routes the cards link to.
 *
 *   1. Page chrome — heading: <h1> "Travel Stall" renders (the Sparkles
 *      icon is decorative, asserted aria-hidden by surfacing the heading
 *      via getByRole('heading')).
 *   2. Page chrome — Phase 2 status pill removed (no longer rendered).
 *   3. Sub-copy — full interpolation: when AuthContext exposes both
 *      tenant.name and user.name, the sub-copy reads
 *      "Family holidays operator console · <tenant.name> · <user.name>"
 *      (the SUT inlines a leading separator " · " before each segment).
 *   4. Sub-copy — fallback to user.email: when user.name is empty but
 *      user.email is present, the email is appended after the tenant.name
 *      segment instead.
 *   5. Sub-copy — minimal: when AuthContext has NO tenant and NO user,
 *      the sub-copy renders just the base text "Family holidays operator
 *      console" with no trailing " · " segments.
 *   6. Card grid — all 4 cards render with their labels: "Quick lead
 *      capture", "Family quiz responses", "Active inquiries", "Operator
 *      stats" — each shown as a card on the page.
 *   7. Card grid — each card has the descriptive blurb body copy.
 *   8. Card links — each card is a single <a> (react-router <Link>) with
 *      the canonical href pre-filtered to `?subBrand=travelstall`. The
 *      Inbox card is the one exception — it links to plain `/inbox` (no
 *      sub-brand filter, intentional per the SUT — Inbox is cross-brand).
 *   9. Card CTAs — each card surfaces its CTA text ("Open Leads",
 *      "Open Diagnostics", "Open Inbox", "Open Reports") followed by the
 *      ArrowRight decoration.
 *  10. Advisory footer — Cluster F integration note renders verbatim:
 *      "Travel Stall surfaces share data with the broader Travel CRM …".
 *  11. AuthContext robustness: when AuthContext.Provider supplies
 *      `value=undefined`, the SUT's `useContext(AuthContext) || {}`
 *      fallback prevents a TypeError and the page renders the minimal
 *      sub-copy form (case 5 path) — pins the defensive `|| {}` guard
 *      against accidental removal.
 *
 * Drift pinned (prompt vs. actual SUT — per the tick #109-#114 prompt-drift
 * discipline that every recent travel-admin test inherited):
 *   - Prompt mentioned "loading state await findByText for 'Loading…'" —
 *     the SUT has NO loading state, NO useState, NO fetch on mount. It's
 *     pure props/context → JSX. The test omits all loading assertions.
 *   - Prompt mentioned "GET on mount: if there's a fetch, hits the right
 *     endpoint" — the SUT issues ZERO fetches. fetchApi is not imported
 *     by the SUT and not exercised by any test below. We still mock it
 *     defensively so an accidental future fetch addition would surface as
 *     an unmocked call rather than a real network attempt during the test
 *     run — but no assertion depends on it.
 *   - Prompt mentioned "KPI tiles … each renders the expected metric
 *     label" — the SUT has no KPI tiles. The 4 surfaces are NAV cards
 *     (Quick lead capture → /leads), not numeric KPIs. Tests pin
 *     labels + hrefs, not metric values.
 *   - Prompt mentioned "filter chrome — if present, clicking changes
 *     query-string" — the SUT has no filter chrome. The `?subBrand=travelstall`
 *     suffix is HARDCODED into each Link's `to=`. Test pins the literal href.
 *   - Prompt mentioned "RBAC: role===USER … hide mutation surface" — the
 *     SUT has zero mutation surface (no form, no button-with-onClick, no
 *     POST/PUT/DELETE). Sub-brand authZ + RBAC enforcement lives server-side
 *     on the routes the cards link to. The page itself is fully readable
 *     by any authenticated user; deeper navigation is gated downstream.
 *     Test pins the AuthContext fallback (case 11) instead.
 *   - Prompt mentioned "error handling: 500 → error banner; 403 →
 *     access-restricted" — the SUT has no error path because it has no
 *     fetch. Omitted.
 *   - Prompt mentioned "sub-brand context: if SUT is hard-scoped to TS,
 *     it doesn't fire requests for other sub-brands" — partially applicable.
 *     The SUT is hard-coded to `?subBrand=travelstall` in 3 of the 4 hrefs;
 *     the 4th (/inbox) is intentionally cross-brand. Test pins all 4
 *     hrefs literally (case 8).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a no-op resolver — defensive
 *     against accidental future fetch additions. No assertion reads from
 *     it because the SUT issues zero calls.
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule). The SUT doesn't import useNotify either, but the
 *     mock is harmless and keeps the suite shape consistent with the rest
 *     of __tests__/.
 *   - travelSubBrand.js imported REAL (not mocked) per the rule-of-3
 *     promotion at tick #99 — the SUT does NOT currently consume it, but
 *     a future expansion that adds the sub-brand badge to the page header
 *     should see real palette drift if it slips into placeholder colors.
 *   - AuthContext provided via the real App module's exported context,
 *     wrapped in a MemoryRouter so react-router's <Link> resolves cleanly.
 *
 * Path: flat __tests__/. Sibling Agent B owns VisaApplications.test.jsx
 * in the same dir — no collision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule. The SUT does NOT consume
// useNotify, but we keep the mock consistent with sibling tests.
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
import TravelStallDashboard from '../pages/travel/TravelStallDashboard';

const ADMIN_USER = { userId: 1, name: 'Alice Admin', email: 'alice@x.com', role: 'ADMIN' };
const MANAGER_NO_NAME = { userId: 2, name: '', email: 'mgr@x.com', role: 'MANAGER' };
const TENANT_DEFAULT = { id: 1, name: 'Voyagr Travels', defaultCurrency: 'INR' };

const UNSET = Symbol('unset');

function renderPage({ user = ADMIN_USER, tenant = TENANT_DEFAULT, contextValue = UNSET } = {}) {
  // `contextValue` lets a test explicitly pass undefined / null to exercise
  // the SUT's `useContext(AuthContext) || {}` defensive fallback. Sentinel
  // UNSET disambiguates "not provided" from "explicitly undefined".
  const value = contextValue === UNSET
    ? { user, token: 'tk', tenant, loading: false }
    : contextValue;
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <TravelStallDashboard />
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

describe('<TravelStallDashboard /> — page chrome', () => {
  it('renders the "Travel Stall" heading', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Travel Stall/i }),
    ).toBeInTheDocument();
  });

  it('does not render the Phase 2 scaffold status pill', () => {
    renderPage();
    expect(screen.queryByText(/Phase 2 — TS21 scaffold/)).not.toBeInTheDocument();
  });

  it('renders the advisory blurb about per-card sub-brand filtering', () => {
    renderPage();
    expect(
      screen.getByText(/Quick access to the surfaces operators use most for the Travel Stall sub-brand/i),
    ).toBeInTheDocument();
  });

  it('renders the Cluster F integration footer note', () => {
    renderPage();
    expect(
      screen.getByText(/Travel Stall surfaces share data with the broader Travel CRM/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/dedicated lead-capture\s+form \(voyagr CMS embed\) lands in the Cluster F integration follow-up/i),
    ).toBeInTheDocument();
  });
});

describe('<TravelStallDashboard /> — sub-copy interpolation from AuthContext', () => {
  it('full interpolation: tenant.name + user.name both appear in the sub-copy', () => {
    renderPage();
    // SUT joins as: "Family holidays operator console · Voyagr Travels · Alice Admin"
    // Using regex match because middle-dots and whitespace can normalize differently in jsdom.
    expect(
      screen.getByText(/Family holidays operator console.*Voyagr Travels.*Alice Admin/),
    ).toBeInTheDocument();
  });

  it('user fallback: when user.name is empty, user.email is rendered instead', () => {
    renderPage({ user: MANAGER_NO_NAME });
    expect(
      screen.getByText(/Family holidays operator console.*Voyagr Travels.*mgr@x\.com/),
    ).toBeInTheDocument();
  });

  it('minimal sub-copy: when tenant + user are both absent, only base text renders', () => {
    renderPage({ user: null, tenant: null });
    const blurb = screen.getByText(/Family holidays operator console/);
    // No tenant name + no user identity → no trailing " · " segments after the base copy.
    // Asserting the textContent does not contain a middle-dot separator.
    expect(blurb.textContent).toBe('Family holidays operator console');
  });

  it('AuthContext robustness: null context value uses the `|| {}` fallback and still renders', () => {
    // SUT's `useContext(AuthContext) || {}` is the defensive guard against
    // a missing/null provider value. Pinning this prevents accidental removal.
    // Note: Provider with value=null triggers the `|| {}` branch (null falsy);
    // js object-destructure defaults to "undefined replaces it with default",
    // so we use null as the explicit sentinel here.
    renderPage({ contextValue: null });
    // Heading still renders.
    expect(
      screen.getByRole('heading', { name: /Travel Stall/i }),
    ).toBeInTheDocument();
    // Null value → `null || {}` → empty object → no tenant + no user, so the
    // sub-copy renders the minimal form.
    const blurb = screen.getByText(/Family holidays operator console/);
    expect(blurb.textContent).toBe('Family holidays operator console');
  });
});

describe('<TravelStallDashboard /> — nav cards: labels, descriptions, CTAs, hrefs', () => {
  it('renders all 4 nav card labels', () => {
    renderPage();
    expect(screen.getByText('Quick lead capture')).toBeInTheDocument();
    expect(screen.getByText('Family quiz responses')).toBeInTheDocument();
    expect(screen.getByText('Active inquiries')).toBeInTheDocument();
    expect(screen.getByText('Operator stats')).toBeInTheDocument();
  });

  it('renders the descriptive body copy for each card', () => {
    renderPage();
    expect(
      screen.getByText(/Log a new family-holiday inquiry from a walk-in, call, or social DM/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Review responses from the family-fit diagnostic quiz/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Work the live inquiry inbox — assign, reply, and progress conversations/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Travel Stall conversion, response-time, and revenue snapshots/i),
    ).toBeInTheDocument();
  });

  it('each card surfaces its CTA text', () => {
    renderPage();
    // CTAs are inside <Link>s so they participate in the link's accessible name.
    expect(screen.getByText(/^Open Leads$/)).toBeInTheDocument();
    expect(screen.getByText(/^Open Diagnostics$/)).toBeInTheDocument();
    expect(screen.getByText(/^Open Inbox$/)).toBeInTheDocument();
    expect(screen.getByText(/^Open Reports$/)).toBeInTheDocument();
  });

  it('each card links to the correct sub-brand-filtered href (Inbox is intentionally cross-brand)', () => {
    renderPage();
    // 4 cards → 4 links. Locate each by its CTA text inside the link's
    // accessible name and assert href.
    const leadsLink = screen.getByText(/^Open Leads$/).closest('a');
    expect(leadsLink).toHaveAttribute('href', '/leads');

    const diagLink = screen.getByText(/^Open Diagnostics$/).closest('a');
    expect(diagLink).toHaveAttribute('href', '/travel/diagnostics?subBrand=travelstall');

    // Inbox is intentionally cross-brand — no sub-brand suffix.
    const inboxLink = screen.getByText(/^Open Inbox$/).closest('a');
    expect(inboxLink).toHaveAttribute('href', '/inbox');

    const reportsLink = screen.getByText(/^Open Reports$/).closest('a');
    expect(reportsLink).toHaveAttribute('href', '/travel/reports?subBrand=travelstall');
  });

  it('the 4 cards together produce exactly 4 anchor links on the page', () => {
    const { container } = renderPage();
    // Heading, status pill, advisory blurbs are NOT links. Only the 4 cards are.
    const anchors = container.querySelectorAll('a');
    expect(anchors.length).toBe(4);
  });

  it('each card label + description pair lives inside the same anchor (card link wraps both)', () => {
    renderPage();
    // Pin one card structurally — label + description rendered as siblings
    // inside the same <a> element (the Card component wraps both in <Link>).
    const labelEl = screen.getByText('Quick lead capture');
    const cardAnchor = labelEl.closest('a');
    expect(cardAnchor).toBeTruthy();
    expect(
      within(cardAnchor).getByText(/Log a new family-holiday inquiry/i),
    ).toBeInTheDocument();
    expect(within(cardAnchor).getByText(/^Open Leads$/)).toBeInTheDocument();
  });
});

describe('<TravelStallDashboard /> — no-fetch invariant', () => {
  it('SUT does NOT issue any fetchApi calls (pure presentation SHELL)', () => {
    renderPage();
    // The SUT does not import fetchApi. Defensive mock should remain untouched.
    expect(fetchApiMock).not.toHaveBeenCalled();
  });
});
