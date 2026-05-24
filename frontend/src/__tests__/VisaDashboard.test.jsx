/**
 * VisaDashboard.test.jsx — vitest + RTL coverage for the Phase 3 Visa Sure
 * landing surface (frontend/src/pages/travel/visa/Dashboard.jsx,
 * cluster B3 SHELL scaffolding from the visa-sure landing route batch).
 *
 * Scope — drift PINNED to reality, NOT to the dispatch prompt:
 *
 *   The dispatch prompt anticipated either a fully-built KPI dashboard (with
 *   fetch-on-mount, KPI tiles after data resolves, empty-state branches) OR
 *   a pure SHELL with sub-copy interpolation off AuthContext. The reality is
 *   the latter, MINUS the AuthContext interpolation — the Visa Sure landing
 *   page is even simpler than the Travel Stall dashboard (TS21 tick #115).
 *   The SUT renders a static glass card with: a Stamp icon, the "Visa Sure"
 *   <h1>, a "Phase 3 — Visa Sure scaffolding" status pill, two paragraphs
 *   of explanatory copy referencing docs/PRD_VISA_SURE_PHASE_3.md, and
 *   exactly TWO nav links (Applications + Checklists). It is a smaller,
 *   simpler shell than its sub-page Checklists or sibling TravelStallDashboard.
 *
 *   Test surface is therefore the static-shell + nav-link invariants:
 *     1. Page chrome — heading "Visa Sure" renders as <h1>.
 *     2. Phase 3 status pill — "Phase 3 — Visa Sure scaffolding" text
 *        renders verbatim (signals to operators this is a scaffold).
 *     3. Explanatory copy — the "visa-type pickers, document checklists,
 *        OCR-backed PDF consumer..." sentence renders so any future copy
 *        drift surfaces here.
 *     4. PRD pointer — the `docs/PRD_VISA_SURE_PHASE_3.md` reference
 *        renders inside a <code> element (load-bearing for future authors
 *        searching by PRD filename for follow-up work).
 *     5. Stamp icon — lucide-react renders a lucide-stamp SVG; pin its
 *        presence so a future icon swap is intentional.
 *     6. Applications nav link — <Link to="/travel/visa/applications">
 *        with the "Applications" label renders as an anchor with the right
 *        href and primary-CTA styling.
 *     7. Checklists nav link — <Link to="/travel/visa/checklists"> with
 *        the "Checklists" label renders as an anchor with the right href.
 *     8. Link count invariant — exactly 2 anchors on the page (matches
 *        the Applications + Checklists nav pair; no extra links sneaking
 *        in without test coverage).
 *     9. No mutation surface — zero <button> elements. The SUT is read-only
 *        until Phase 3 builds out. A future implementer adding action
 *        controls without test coverage trips this guard.
 *    10. No fetch on mount — the SUT does not import or call fetchApi.
 *        We mock the module defensively and assert ZERO calls. Locks the
 *        SHELL contract — a future move from shell → wired-up GET must
 *        update this spec deliberately.
 *    11. No AuthContext required to render — the SUT does not consume
 *        AuthContext (no useContext, no sub-copy interpolation, no role
 *        gating). Mounting without a Provider must NOT throw. Matches
 *        the VisaChecklists + VisaAdvisorDashboard visa-page sibling
 *        pattern (tick #117 + #121).
 *
 * Drift pinned (prompt vs. actual SUT — per tick #109-#121 prompt-drift
 * discipline):
 *   - Prompt mentioned "fetch endpoints (if any), KPI tiles, sub-brand
 *     context (likely visasure-hardcoded)". The SUT has NO fetch, NO KPI
 *     tiles, NO sub-brand context consumption — sub-brand isolation is
 *     implicit (this page IS the Visa Sure landing, all linked routes are
 *     visasure-scoped server-side). Tests omit fetch / KPI / palette
 *     assertions.
 *   - Prompt mentioned "AuthContext sub-copy interpolation IF SUT consumes
 *     user/tenant context". The SUT does NOT consume AuthContext at all
 *     (unlike TravelStallDashboard which DOES interpolate tenant.name +
 *     user.name). Tests OMIT AuthContext interpolation cases — case 11
 *     instead pins the no-provider-required invariant.
 *   - Prompt mentioned "nav cards to deeper visa pages (Applications,
 *     AdvisorDashboard, Checklists, Reports)". The SUT has only TWO nav
 *     links: Applications + Checklists. No AdvisorDashboard link (that
 *     page is reached from a row in Applications), no Reports link (no
 *     visa-reports page exists yet — PRD §5 / §9 covers it for Phase 3).
 *     Tests pin the actual 2-link count.
 *   - Prompt mentioned "Phase 3 status pill / advisory blurb (per
 *     TravelStallDashboard pattern)". TravelStallDashboard says "Phase 2
 *     — TS21 scaffold"; this SUT says "Phase 3 — Visa Sure scaffolding".
 *     Test asserts the actual text.
 *   - Prompt mentioned "visasure indigo rgba(99, 102, 241, ...) per tick
 *     #115". The SUT does NOT import travelSubBrand — its CTAs use the
 *     generic var(--primary-color, var(--accent-color)) primary token
 *     instead of the sub-brand-specific indigo. Tests OMIT palette
 *     assertions; that's a future enhancement opportunity, not a current
 *     invariant.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules + tick #109-#121
 * cron-learnings):
 *   - fetchApi (`../utils/api`) is mocked but the SUT never calls it; the
 *     mock exists so we can ASSERT zero calls (SHELL-contract guard).
 *   - useNotify is NOT mocked — SUT doesn't consume it. Skipping the mock
 *     keeps the placeholder bound: if someone wires notify, this surfaces.
 *   - travelSubBrand is NOT mocked / NOT imported — SUT doesn't use it.
 *   - AuthContext is NOT wrapped — SUT doesn't consume it, pinned in
 *     case 11.
 *   - MemoryRouter wraps the SUT so <Link> resolves (the only thing
 *     RouterContext provides for this page).
 *
 * If the SUT graduates beyond placeholder (real visa landing with KPI
 * tiles per PRD §5), this entire spec should be rewritten — the current
 * cases are intentional "scaffold stays scaffold" guards, not aspirational
 * coverage of the Phase 3 product.
 *
 * Path: flat __tests__/VisaDashboard.test.jsx — distinct from generic
 * Dashboard.test.jsx (sales dashboard), OwnerDashboard.test.jsx (wellness),
 * and TravelStallDashboard.test.jsx (Travel Stall vertical). Sibling Agent B
 * owns VisaReports.test.jsx in the same dir — no collision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import VisaDashboard from '../pages/travel/visa/Dashboard.jsx';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/travel/visa']}>
      <VisaDashboard />
    </MemoryRouter>,
  );

describe('VisaDashboard (Phase 3 Visa Sure landing SHELL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "Visa Sure" heading as an <h1>', () => {
    renderPage();
    const heading = screen.getByRole('heading', {
      level: 1,
      name: /Visa Sure/i,
    });
    expect(heading).toBeInTheDocument();
  });

  it('renders the "Phase 3 — Visa Sure scaffolding" status pill verbatim', () => {
    renderPage();
    expect(
      screen.getByText(/Phase 3 — Visa Sure scaffolding/),
    ).toBeInTheDocument();
  });

  it('renders the explanatory copy listing the Phase 3 module pieces', () => {
    renderPage();
    expect(
      screen.getByText(
        /visa-type pickers, document checklists,\s*OCR-backed PDF consumer, status timeline, embassy-appointment\s*scheduling/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/under active design/i)).toBeInTheDocument();
  });

  it('points at the PRD doc filename inside a <code> element', () => {
    const { container } = renderPage();
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code.textContent).toMatch(/docs\/PRD_VISA_SURE_PHASE_3\.md/);
  });

  it('renders the Stamp lucide icon', () => {
    const { container } = renderPage();
    const icon = container.querySelector('svg.lucide-stamp');
    expect(icon).not.toBeNull();
  });

  it('renders the Applications nav link pointing to /travel/visa/applications', () => {
    renderPage();
    const link = screen.getByRole('link', { name: /Applications/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/travel/visa/applications');
  });

  it('renders the Checklists nav link pointing to /travel/visa/checklists', () => {
    renderPage();
    const link = screen.getByRole('link', { name: /Checklists/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/travel/visa/checklists');
  });

  it('renders exactly 2 anchor links (Applications + Checklists nav pair)', () => {
    renderPage();
    // Pinning the link count surfaces any future link-additions to the same
    // shell that slip in without test coverage.
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('contains no action CTAs beyond the nav links (no buttons)', () => {
    renderPage();
    // No <button> elements should exist on the SHELL. The only interactive
    // elements are the two <Link> anchors. This guards against a future
    // implementer silently wiring mutation controls without test coverage.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('does not call fetchApi — pure SHELL contract', () => {
    renderPage();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('renders without an AuthContext Provider (SUT does not consume auth)', () => {
    // VisaChecklists + VisaAdvisorDashboard sibling pattern (ticks #117/#121).
    // Visa landing/placeholder pages are independent of AuthContext.
    // Mounting without a Provider must NOT throw; if a future revision adds
    // useAuth() / useContext(AuthContext), this test surfaces it.
    expect(() => renderPage()).not.toThrow();
    expect(
      screen.getByRole('heading', { level: 1, name: /Visa Sure/i }),
    ).toBeInTheDocument();
  });
});
