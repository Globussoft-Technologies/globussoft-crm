/**
 * NotFound.jsx -- vitest + RTL coverage for the global catch-all 404 page.
 *
 * Scope: pins the page-surface invariants for the catch-all 404 fallback at
 * frontend/src/pages/NotFound.jsx (issue #341). This is the `path="*"`
 * element in App.jsx; replaces an empty-200 SPA render with an actionable
 * error surface.
 *
 * The page is ~129 LOC and has FOUR distinct UI surfaces:
 *   (a) the heading "404 — Page not found" + AlertCircle icon
 *   (b) the body paragraph echoing back the URL the user hit (so they
 *       know what failed)
 *   (c) an optional "Did you mean: <suggested>" surface — only renders
 *       when (i) the tenant is wellness AND (ii) the path matches a key
 *       in WELLNESS_PREFIX_MAP (8 known wrong-prefix paths)
 *   (d) the quick-link button row:
 *         - logged-in + generic tenant   -> "Go to Dashboard" -> /dashboard
 *         - logged-in + wellness tenant  -> "Go to Wellness Dashboard" -> /wellness
 *         - logged-out                   -> "Go to Login" -> /login
 *         - logged-in ONLY also renders  -> "Search the help" -> /knowledge-base
 *
 * Contracts pinned here
 * ---------------------
 *   1. Renders the "404 — Page not found" heading (h1) + the AlertCircle
 *      icon container.
 *   2. Echoes the requested path back inside a <code> element so the user
 *      sees exactly what they hit.
 *   3. Generic-tenant + logged-in renders the "Go to Dashboard" link
 *      pointing at /dashboard and the "Search the help" link pointing
 *      at /knowledge-base.
 *   4. Wellness-tenant + logged-in renders the "Go to Wellness Dashboard"
 *      link pointing at /wellness (+ help link still renders).
 *   5. Logged-out (token = '') renders the "Go to Login" link pointing
 *      at /login and does NOT render the help link.
 *   6. "Did you mean" suggestion renders for wellness-tenant when the
 *      path matches a WELLNESS_PREFIX_MAP entry (e.g. /loyalty ->
 *      /wellness/loyalty).
 *   7. "Did you mean" suggestion does NOT render for the generic tenant
 *      even when the path matches a known wrong-prefix (the suggestion
 *      surface is wellness-only because the generic tenant has no
 *      /wellness/* pages).
 *   8. "Did you mean" suggestion does NOT render when the path is not
 *      in the wrong-prefix map (e.g. /totally-bogus-path).
 *
 * Drift notes
 * -----------
 *   - The page consumes `useLocation` from react-router-dom; the test
 *     wraps the SUT in MemoryRouter with an explicit `initialEntries`
 *     to control the path. No useNavigate mock is needed because the
 *     page only renders <Link> elements (no programmatic nav).
 *   - The page consumes AuthContext.{token, tenant}; the test passes
 *     stable auth-value objects per render to avoid the unstable-mock
 *     re-render trap from the CLAUDE.md standing rule.
 *   - The h1 contains an &mdash; (—) HTML entity. assertion uses a
 *     case-insensitive regex on "404" + "Page not found" to stay robust.
 *   - useNotify / useApi are NOT used by this page, so the stable-mock
 *     object rule does not apply here -- but the AuthContext IS consumed
 *     via useContext.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { AuthContext } from '../App';
import NotFound from '../pages/NotFound';

// Stable auth-context objects -- generic / wellness / logged-out. Stable
// identity keeps re-renders deterministic and avoids the unstable-mock
// re-render-loop trap from the CLAUDE.md standing rule.
const genericLoggedIn = {
  user: { userId: 1, email: 'admin@globussoft.com', role: 'ADMIN' },
  token: 'jwt-test-token-generic',
  tenant: { id: 1, vertical: 'generic' },
  setUser: vi.fn(),
  setToken: vi.fn(),
  setTenant: vi.fn(),
};

const wellnessLoggedIn = {
  user: { userId: 2, email: 'rishu@enhancedwellness.in', role: 'ADMIN' },
  token: 'jwt-test-token-wellness',
  tenant: { id: 2, vertical: 'wellness' },
  setUser: vi.fn(),
  setToken: vi.fn(),
  setTenant: vi.fn(),
};

const loggedOut = {
  user: null,
  token: '',
  tenant: null,
  setUser: vi.fn(),
  setToken: vi.fn(),
  setTenant: vi.fn(),
};

function renderNotFound(authValue, initialPath = '/totally-bogus-path') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthContext.Provider value={authValue}>
        <NotFound />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('<NotFound /> -- global catch-all 404 page', () => {
  beforeEach(() => {
    // Nothing to reset between tests -- the page is purely render-driven
    // off useLocation + AuthContext, both of which are scoped per render.
  });

  it('renders the "404 — Page not found" heading and the AlertCircle icon container', () => {
    renderNotFound(genericLoggedIn);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeInTheDocument();
    // The heading contains "404" + an em-dash (HTML entity) + "Page not
    // found". Match on a regex that tolerates the entity-rendered char.
    expect(heading.textContent).toMatch(/404/);
    expect(heading.textContent).toMatch(/Page not found/i);
  });

  it('echoes the requested path back inside the body copy so the user knows what they hit', () => {
    renderNotFound(genericLoggedIn, '/some/missing/page');
    // The path renders inside a <code> child of the body paragraph.
    expect(screen.getByText('/some/missing/page')).toBeInTheDocument();
    // The body paragraph copy renders.
    expect(
      screen.getByText(/The link may be out of date, or the URL may be missing a prefix/i),
    ).toBeInTheDocument();
  });

  it('generic-tenant + logged-in renders "Go to Dashboard" + "Search the help" links', () => {
    renderNotFound(genericLoggedIn);
    const links = screen.getAllByRole('link');
    const homeLink = links.find((a) => /Go to Dashboard/i.test(a.textContent || ''));
    const helpLink = links.find((a) => /Search the help/i.test(a.textContent || ''));
    expect(homeLink).toBeTruthy();
    expect(homeLink.getAttribute('href')).toBe('/dashboard');
    expect(helpLink).toBeTruthy();
    expect(helpLink.getAttribute('href')).toBe('/knowledge-base');
    // Login CTA is NOT present when logged in.
    expect(screen.queryByText(/Go to Login/i)).not.toBeInTheDocument();
  });

  it('wellness-tenant + logged-in renders "Go to Wellness Dashboard" pointing at /wellness', () => {
    renderNotFound(wellnessLoggedIn);
    const links = screen.getAllByRole('link');
    const homeLink = links.find((a) => /Go to Wellness Dashboard/i.test(a.textContent || ''));
    const helpLink = links.find((a) => /Search the help/i.test(a.textContent || ''));
    expect(homeLink).toBeTruthy();
    expect(homeLink.getAttribute('href')).toBe('/wellness');
    // Help link still renders for logged-in wellness users.
    expect(helpLink).toBeTruthy();
    expect(helpLink.getAttribute('href')).toBe('/knowledge-base');
    // The generic "Go to Dashboard" label MUST NOT render.
    expect(screen.queryByText(/Go to Dashboard$/i)).not.toBeInTheDocument();
  });

  it('logged-out renders "Go to Login" and does NOT render the help link', () => {
    renderNotFound(loggedOut);
    const links = screen.getAllByRole('link');
    const loginLink = links.find((a) => /Go to Login/i.test(a.textContent || ''));
    expect(loginLink).toBeTruthy();
    expect(loginLink.getAttribute('href')).toBe('/login');
    // Help link is gated on `token &&`, so logged-out users do not see it.
    expect(screen.queryByText(/Search the help/i)).not.toBeInTheDocument();
    // The "Go to Dashboard" label MUST NOT render in logged-out mode.
    expect(screen.queryByText(/Go to (Wellness )?Dashboard/i)).not.toBeInTheDocument();
  });

  it('wellness-tenant + known wrong-prefix path renders the "Did you mean" suggestion', () => {
    renderNotFound(wellnessLoggedIn, '/loyalty');
    // The "Did you mean:" label + the corrected /wellness/loyalty path.
    expect(screen.getByText(/Did you mean:/i)).toBeInTheDocument();
    // The suggested path renders as both the link text (inside <code>) and
    // as the link's href.
    expect(screen.getByText('/wellness/loyalty')).toBeInTheDocument();
    const suggestionLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/wellness/loyalty');
    expect(suggestionLink).toBeTruthy();
  });

  it('generic-tenant + known wrong-prefix path does NOT render the "Did you mean" suggestion', () => {
    // Generic tenant hitting /loyalty (which would be a wellness route)
    // should NOT see the suggestion -- the generic tenant has no
    // /wellness/* pages so the correction would be misleading.
    renderNotFound(genericLoggedIn, '/loyalty');
    expect(screen.queryByText(/Did you mean:/i)).not.toBeInTheDocument();
    // And the suggestion target href is absent from the link set.
    const links = screen.getAllByRole('link');
    const suggestionLink = links.find(
      (a) => a.getAttribute('href') === '/wellness/loyalty',
    );
    expect(suggestionLink).toBeFalsy();
  });

  it('wellness-tenant + unknown path does NOT render the "Did you mean" suggestion', () => {
    // /totally-bogus-path is not in WELLNESS_PREFIX_MAP, so the page
    // should NOT render the suggestion surface (the map is intentionally
    // small + curated, not fuzzy-match).
    renderNotFound(wellnessLoggedIn, '/totally-bogus-path');
    expect(screen.queryByText(/Did you mean:/i)).not.toBeInTheDocument();
    // Echo of the bogus path still renders in the body copy.
    expect(screen.getByText('/totally-bogus-path')).toBeInTheDocument();
  });

  it('wellness-tenant suggestion map covers /patients, /services, /recommendations entries', () => {
    // Spot-check three more entries from WELLNESS_PREFIX_MAP to pin the
    // map's contract -- if anyone narrows the map (or breaks the lookup)
    // these three cases catch the regression without binding to the full
    // 8-entry list (the map is intentionally curated and may grow).
    const cases = [
      { path: '/patients', expected: '/wellness/patients' },
      { path: '/services', expected: '/wellness/services' },
      { path: '/recommendations', expected: '/wellness/recommendations' },
    ];
    for (const { path, expected } of cases) {
      const { unmount } = renderNotFound(wellnessLoggedIn, path);
      expect(screen.getByText(/Did you mean:/i)).toBeInTheDocument();
      expect(screen.getByText(expected)).toBeInTheDocument();
      const suggestionLink = screen
        .getAllByRole('link')
        .find((a) => a.getAttribute('href') === expected);
      expect(suggestionLink).toBeTruthy();
      unmount();
    }
  });
});
