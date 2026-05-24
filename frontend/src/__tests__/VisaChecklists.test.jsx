/**
 * VisaChecklists.test.jsx — vitest + RTL coverage for the Phase 3 Visa Sure
 * checklists placeholder shell (frontend/src/pages/travel/visa/Checklists.jsx,
 * shipped commit 875c082 "Phase 3 Visa Sure scaffolding — landing route +
 * 3 shell pages").
 *
 * Scope — drift PINNED to reality, NOT to the dispatch prompt:
 *
 *   The prompt anticipated a fully-built checklist surface with route params
 *   (:applicationId), fetch-on-mount, document-upload slots, "mark as
 *   collected" mutation, progress indicators, status badges, and RBAC.
 *   NONE of that exists. The SUT is a PURE STATIC PLACEHOLDER — a `coming
 *   in Phase 3` shell modelled on QuotesComingSoon.jsx, identical to
 *   tick #115/#117's read-only visa-pages discovery. No useState, no
 *   useEffect, no fetch, no useParams, no AuthContext consumption, no
 *   mutation flows, no role gates — just a static glass card with an icon,
 *   heading, two paragraphs of explanatory copy, and a single Back link.
 *
 *   Test surface is therefore the static-shell invariants:
 *     1. Page chrome — heading "Visa Checklists — coming in Phase 3"
 *        renders as an <h1>.
 *     2. Phase-3 cluster explainer copy — the "country × visa-type document
 *        matrix" sentence renders so any future copy drift surfaces here.
 *     3. PRD pointer — the `docs/PRD_VISA_SURE_PHASE_3.md` reference renders
 *        inside a <code> element (load-bearing for future authors who'll
 *        search by PRD filename for follow-up work).
 *     4. ClipboardList icon — lucide-react renders a lucide-clipboard-list
 *        SVG; pin its presence so a future icon swap is intentional.
 *     5. Back link — <Link to="/travel/visa"> with the "Back to Visa Sure"
 *        label renders as an anchor with the right href (Router needed).
 *     6. No mutation CTAs — the SUT has zero action buttons; pin "no
 *        button/role=button beyond the back link" so a future implementer
 *        adding mutation controls without test coverage trips this guard.
 *     7. No fetch on mount — the SUT does not import or call fetchApi;
 *        we mock the module and assert ZERO calls. Locks the placeholder
 *        contract — a future move from shell → wired-up GET must update
 *        this spec deliberately.
 *     8. No AuthContext required to render — the SUT does not consume the
 *        AuthContext. Mounting without a Provider must NOT throw. This
 *        matches the VisaAdvisorDashboard pattern from tick #117.
 *
 * Mocking discipline (per CLAUDE.md standing rules + tick #109-#120
 * cron-learnings):
 *   - fetchApi (`../utils/api`) is mocked but the SUT never calls it; the
 *     mock exists so we can ASSERT zero calls (placeholder-contract guard).
 *   - useNotify is NOT mocked — SUT doesn't consume it. Skipping mock
 *     keeps the placeholder bound: if someone wires notify, this surfaces.
 *   - travelSubBrand is NOT mocked / NOT imported — SUT doesn't use it.
 *   - MemoryRouter wraps the SUT so <Link> resolves (the only thing
 *     RouterContext provides for this page).
 *
 * If the SUT graduates beyond placeholder (real checklist CRUD per PRD §5),
 * this entire spec should be rewritten — the current cases are intentional
 * "scaffold stays scaffold" guards, not aspirational coverage of the
 * Phase 3 product.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import VisaChecklists from '../pages/travel/visa/Checklists.jsx';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/travel/visa/checklists']}>
      <VisaChecklists />
    </MemoryRouter>,
  );

describe('VisaChecklists (Phase 3 placeholder shell)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "coming in Phase 3" heading as an <h1>', () => {
    renderPage();
    const heading = screen.getByRole('heading', {
      level: 1,
      name: /Visa Checklists\s*—\s*coming in Phase 3/i,
    });
    expect(heading).toBeInTheDocument();
  });

  it('renders the cluster-B3 explainer copy describing the document matrix', () => {
    renderPage();
    expect(
      screen.getByText(/country × visa-type document matrix/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/required-vs-optional flags/i)).toBeInTheDocument();
  });

  it('points at the PRD doc filename inside a <code> element', () => {
    const { container } = renderPage();
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code.textContent).toMatch(/docs\/PRD_VISA_SURE_PHASE_3\.md/);
  });

  it('renders the ClipboardList lucide icon', () => {
    const { container } = renderPage();
    const icon = container.querySelector('svg.lucide-clipboard-list');
    expect(icon).not.toBeNull();
  });

  it('renders a Back link pointing to /travel/visa', () => {
    renderPage();
    const back = screen.getByRole('link', { name: /Back to Visa Sure/i });
    expect(back).toBeInTheDocument();
    expect(back).toHaveAttribute('href', '/travel/visa');
  });

  it('contains no action CTAs beyond the single back-link (no buttons)', () => {
    renderPage();
    // No <button> elements should exist on the placeholder shell. The only
    // interactive element is the back-link <a>. This guards against a future
    // implementer silently wiring mutation controls without test coverage.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // Exactly one link (the back link). Pinning the count surfaces any
    // future link-additions to the same shell.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('does not call fetchApi — pure placeholder contract', () => {
    renderPage();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('renders without an AuthContext Provider (SUT does not consume auth)', () => {
    // VisaAdvisorDashboard pattern (tick #117) — visa placeholder pages are
    // independent of the AuthContext. Mounting without a Provider must NOT
    // throw; if a future revision adds useAuth(), this test surfaces it.
    expect(() => renderPage()).not.toThrow();
    expect(
      screen.getByRole('heading', { level: 1, name: /coming in Phase 3/i }),
    ).toBeInTheDocument();
  });
});
