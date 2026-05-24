/**
 * MarketingFlyerStudio.test.jsx — vitest + RTL coverage for the
 * Phase 2 SHELL page (frontend/src/pages/travel/MarketingFlyerStudio.jsx,
 * tick #186 — GH #908; PRD docs/PRD_TRAVEL_MARKETING_FLYER.md).
 *
 * Scope: pins SHELL-page surface invariants — heading + subtitle,
 * 4 sub-brand placeholder cards (tmc / rfu / travelstall / visasure
 * matching the canonical id set from utils/travelSubBrand.js +
 * subBrand.jsx's VALID_SUB_BRANDS), per-card "Coming soon" overlay
 * affordance, active-sub-brand visual highlight via data-active +
 * aria-current attributes, null-sub-brand graceful render, and the
 * outer RoleGuard RBAC gate (ADMIN + MANAGER allowed; USER denied).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - useActiveSubBrand mocked at `../utils/subBrand` with a STABLE
 *     module-level object reference (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap dep identity and
 *     infinite-re-render-hang the test). The mock value is mutated
 *     via .mockReturnValue() per-test, not by replacing the object.
 *   - AuthContext is provided via the real `../App` AuthContext export
 *     so RoleGuard's session-ready check passes; loading=false + a
 *     populated user object.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "RoleGuard typically renders 'permission
 *     denied' or Navigate". REALITY (per frontend/src/components/
 *     RoleGuard.jsx since #768 commit): RoleGuard renders the
 *     <LockedPanel/> with data-testid="role-guard-locked-panel" —
 *     NO redirect, NO toast, just a full-page lock panel in place.
 *     The protected page chrome (heading, cards) must NOT mount. Test
 *     asserts on the testid + absence of the studio heading.
 *   - Prompt anticipated "Coming soon" overlay strings; pinned to the
 *     per-card testid `flyer-card-<id>-coming-soon` so the assertions
 *     don't double-count the header pill (which also says "Coming
 *     soon").
 *   - Prompt anticipated "active sub-brand visually highlighted via
 *     data-active OR aria-current attribute that's testable" —
 *     implemented BOTH (data-active='true' + aria-current='true' on
 *     the matching card; data-active='false' + aria-current absent
 *     elsewhere). Test asserts on data-active for stable selection +
 *     aria-current presence on the active card only.
 *   - Prompt anticipated "useActiveSubBrand mock pattern" — used a
 *     stable wrapped function that delegates to a mocked impl, so
 *     per-test setup just calls activeSubBrandMockImpl.mockReturnValue
 *     instead of re-mocking the module (which would break the stable-
 *     reference rule).
 *
 * Test cases (6):
 *   1. Page renders with "Marketing Flyer Studio" heading + subtitle.
 *   2. Renders 4 sub-brand placeholder cards (tmc / rfu / travelstall /
 *      visasure) — one per canonical id.
 *   3. "Coming soon" overlay testid is present on every card (4×).
 *   4. Active sub-brand (mocked to 'rfu') gets data-active='true' +
 *      aria-current='true'; the other 3 cards stay data-active='false'.
 *   5. RoleGuard RBAC: USER role mounts the lock-panel testid + does
 *      NOT mount the studio heading. ADMIN / MANAGER both mount the
 *      heading + cards normally.
 *   6. activeSubBrand null does NOT throw — heading + all 4 cards
 *      render; every card stays data-active='false' (no highlight).
 *
 * Path: flat frontend/src/__tests__/MarketingFlyerStudio.test.jsx —
 * matches sibling subBrand.test.jsx + RoleGuard.test.jsx + Drugs.test.jsx
 * flat-path convention.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable mock impl for useActiveSubBrand — per-test setup uses
// `activeSubBrandMockImpl.mockReturnValue(...)` so the returned object
// reference stays controlled but the value can vary. The module mock
// always returns the SAME function reference, satisfying the RTL
// stable-mock-object standing rule.
const activeSubBrandMockImpl = vi.fn(() => ({ activeSubBrand: null, setActiveSubBrand: () => {} }));
vi.mock('../utils/subBrand', () => ({
  useActiveSubBrand: () => activeSubBrandMockImpl(),
}));

// notify mock kept stable — RoleGuard imports useNotify transitively
// in some test paths; the stable shape prevents the dep-identity
// flap that would surface as an infinite re-render hang.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => React.createElement(React.Fragment, null, children),
}));

import { AuthContext } from '../App';
import RoleGuard from '../components/RoleGuard';
import MarketingFlyerStudio from '../pages/travel/MarketingFlyerStudio';

function renderStudio({ role = 'MANAGER', wrapInRoleGuard = false } = {}) {
  const user = { userId: 1, name: 'Asha Marketer', email: 'a@x.test', role };
  const studio = wrapInRoleGuard ? (
    <RoleGuard allow={['ADMIN', 'MANAGER']} feature="Marketing Flyer Studio">
      <MarketingFlyerStudio />
    </RoleGuard>
  ) : (
    <MarketingFlyerStudio />
  );
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical: 'travel' }, loading: false }}>
      <MemoryRouter>{studio}</MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  // Reset to "no active sub-brand" between tests so per-test setup is explicit.
  activeSubBrandMockImpl.mockReset();
  activeSubBrandMockImpl.mockReturnValue({ activeSubBrand: null, setActiveSubBrand: () => {} });
});

describe('MarketingFlyerStudio — SHELL surface', () => {
  it('renders the "Marketing Flyer Studio" heading + subtitle', () => {
    renderStudio();
    expect(screen.getByRole('heading', { level: 1, name: /marketing flyer studio/i })).toBeTruthy();
    // Subtitle mentions all 4 sub-brand labels — pin one of them as a
    // representative anchor for the subtitle's presence.
    expect(screen.getByText(/TMC \/ RFU \/ Travel Stall \/ Visa Sure/i)).toBeTruthy();
  });

  it('renders 4 sub-brand placeholder cards (tmc / rfu / travelstall / visasure)', () => {
    renderStudio();
    const ids = ['tmc', 'rfu', 'travelstall', 'visasure'];
    for (const id of ids) {
      const card = screen.getByTestId(`flyer-card-${id}`);
      expect(card).toBeTruthy();
      expect(card.getAttribute('data-sub-brand')).toBe(id);
    }
    // Container has exactly 4 cards — exact count guards against
    // accidental drift if a 5th sub-brand is added without updating the
    // canonical VALID_SUB_BRANDS set.
    const cards = screen.getByTestId('marketing-flyer-studio-cards').querySelectorAll('[data-sub-brand]');
    expect(cards.length).toBe(4);
  });

  it('shows a "Coming soon" overlay affordance on every sub-brand card', () => {
    renderStudio();
    const ids = ['tmc', 'rfu', 'travelstall', 'visasure'];
    for (const id of ids) {
      const overlay = screen.getByTestId(`flyer-card-${id}-coming-soon`);
      expect(overlay).toBeTruthy();
      // Overlay carries the literal "Coming soon" copy.
      expect(overlay.textContent || '').toMatch(/coming soon/i);
    }
  });

  it('visually highlights the active sub-brand card (data-active + aria-current)', () => {
    activeSubBrandMockImpl.mockReturnValue({ activeSubBrand: 'rfu', setActiveSubBrand: () => {} });
    renderStudio();
    const rfuCard = screen.getByTestId('flyer-card-rfu');
    expect(rfuCard.getAttribute('data-active')).toBe('true');
    expect(rfuCard.getAttribute('aria-current')).toBe('true');

    // Non-active cards remain data-active='false' with no aria-current.
    for (const id of ['tmc', 'travelstall', 'visasure']) {
      const card = screen.getByTestId(`flyer-card-${id}`);
      expect(card.getAttribute('data-active')).toBe('false');
      expect(card.getAttribute('aria-current')).toBeNull();
    }
  });

  it('RoleGuard gate — USER role renders the lock panel; ADMIN/MANAGER render the studio', () => {
    // USER role: lock panel renders, studio chrome absent.
    const { unmount } = renderStudio({ role: 'USER', wrapInRoleGuard: true });
    expect(screen.getByTestId('role-guard-locked-panel')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: /marketing flyer studio/i })).toBeNull();
    expect(screen.queryByTestId('marketing-flyer-studio')).toBeNull();
    unmount();

    // MANAGER role: studio mounts, lock panel absent.
    const managerRender = renderStudio({ role: 'MANAGER', wrapInRoleGuard: true });
    expect(screen.getByTestId('marketing-flyer-studio')).toBeTruthy();
    expect(screen.queryByTestId('role-guard-locked-panel')).toBeNull();
    managerRender.unmount();

    // ADMIN role: studio mounts, lock panel absent.
    renderStudio({ role: 'ADMIN', wrapInRoleGuard: true });
    expect(screen.getByTestId('marketing-flyer-studio')).toBeTruthy();
    expect(screen.queryByTestId('role-guard-locked-panel')).toBeNull();
  });

  it('renders without throwing when activeSubBrand is null (no card highlighted)', () => {
    activeSubBrandMockImpl.mockReturnValue({ activeSubBrand: null, setActiveSubBrand: () => {} });
    expect(() => renderStudio()).not.toThrow();
    // Heading mounts.
    expect(screen.getByRole('heading', { level: 1, name: /marketing flyer studio/i })).toBeTruthy();
    // All 4 cards mount with data-active='false' (no highlight).
    for (const id of ['tmc', 'rfu', 'travelstall', 'visasure']) {
      const card = screen.getByTestId(`flyer-card-${id}`);
      expect(card.getAttribute('data-active')).toBe('false');
      expect(card.getAttribute('aria-current')).toBeNull();
    }
    // Defensive — within() resolves the cards container so the test
    // double-checks the scope is what we expect.
    const container = screen.getByTestId('marketing-flyer-studio-cards');
    expect(within(container).getAllByText(/coming soon/i).length).toBeGreaterThanOrEqual(4);
  });
});
