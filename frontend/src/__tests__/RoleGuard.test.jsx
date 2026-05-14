/**
 * RoleGuard — route-level RBAC gate (#589).
 *
 * Pre-fix repro: USER role typed /audit-log into the URL bar → the page
 * rendered TOTAL EVENTS / CREATES / UPDATES / DELETES KPI cards + the full
 * filter UI (entity, action, user, date range), THEN surfaced an
 * "Insufficient Role Permissions. System Admin Required." toast. Information
 * disclosure: leaks the existence of the audit pipeline, tracked entities,
 * available filters, and the role-name "System Admin".
 *
 * Acceptance pinned here:
 *   1. USER role hitting an ADMIN-only route → redirected before the wrapped
 *      page mounts (none of the page's chrome appears in the DOM).
 *   2. ADMIN role → wrapped page renders normally.
 *   3. MANAGER role on an ADMIN-only route → also redirected (mirrors
 *      Sidebar's adminOnly visibility + the "System Admin Required" toast).
 *   4. A single denial toast emits via notify.error on the redirect — not the
 *      page's own chrome-then-toast.
 *
 * Drift findings vs issue body:
 *   - Issue suggests "/403 page" — none exists in this codebase. Redirecting
 *     to /dashboard with a notify.error is the closest existing convention
 *     (mirrors err.status === 403 handling at wellness/Recommendations.jsx).
 *   - Issue says MANAGER "sidebar hides it but URL-typing loads the page" —
 *     verified: Sidebar.jsx marks audit-log adminOnly, backend route at
 *     /api/audit-viewer actually allows MANAGER too. Frontend gate is
 *     deliberately more restrictive than backend (info-disclosure prevention).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const notifyError = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    info: vi.fn(),
    success: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
  NotifyProvider: ({ children }) => <>{children}</>,
}));

import { AuthContext } from '../App';
import RoleGuard from '../components/RoleGuard';

function ProtectedPage() {
  return (
    <div>
      <h1 data-testid="audit-heading">Audit Log</h1>
      <div data-testid="kpi-card-total">TOTAL EVENTS</div>
      <div data-testid="kpi-card-creates">CREATES</div>
      <div data-testid="filter-entity">Entity filter</div>
    </div>
  );
}

function DashboardStub() {
  return <div data-testid="dashboard-landing">Dashboard</div>;
}

function renderWithRole(role) {
  const user = { userId: 1, name: 'Test', email: 't@x.test', role };
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical: 'generic' }, loading: false }}>
      <MemoryRouter initialEntries={['/audit-log']}>
        <Routes>
          <Route
            path="/audit-log"
            element={
              <RoleGuard allow={['ADMIN']} message="Audit Log requires admin access.">
                <ProtectedPage />
              </RoleGuard>
            }
          />
          <Route path="/dashboard" element={<DashboardStub />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('<RoleGuard /> — /audit-log info-disclosure fix (#589)', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('USER role: does NOT render the protected page chrome (KPI cards, filters, heading)', () => {
    renderWithRole('USER');
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-card-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-card-creates')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-entity')).not.toBeInTheDocument();
  });

  it('USER role: redirects to /dashboard instead of mounting the page', () => {
    renderWithRole('USER');
    expect(screen.getByTestId('dashboard-landing')).toBeInTheDocument();
  });

  it('USER role: emits a single denial toast via notify.error on redirect', () => {
    renderWithRole('USER');
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith('Audit Log requires admin access.');
  });

  it('MANAGER role: also redirected (Sidebar adminOnly convention; frontend stricter than backend)', () => {
    renderWithRole('MANAGER');
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-landing')).toBeInTheDocument();
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('ADMIN role: renders the protected page normally with all chrome', () => {
    renderWithRole('ADMIN');
    expect(screen.getByTestId('audit-heading')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-card-total')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-card-creates')).toBeInTheDocument();
    expect(screen.getByTestId('filter-entity')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-landing')).not.toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('falls back to default message when no `message` prop is supplied', () => {
    const user = { userId: 1, name: 'Test', email: 't@x.test', role: 'USER' };
    render(
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical: 'generic' }, loading: false }}>
        <MemoryRouter initialEntries={['/audit-log']}>
          <Routes>
            <Route
              path="/audit-log"
              element={
                <RoleGuard allow={['ADMIN']}>
                  <ProtectedPage />
                </RoleGuard>
              }
            />
            <Route path="/dashboard" element={<DashboardStub />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(notifyError).toHaveBeenCalledWith("You don't have access to that page.");
  });
});

/**
 * Wave 11 sibling-route sweep — #589 follow-up + #574 frontend follow-up.
 *
 * Same render-and-toast pattern as /audit-log (#589) was repro'd against
 * /field-permissions (#574), /channels, /staff, /settings, /marketing.
 * Each route is now wrapped in App.jsx with <RoleGuard allow={...}>; these
 * tests pin the per-route redirect contract so a future un-wrap reds CI.
 *
 * Allowlists pinned against backend gates + Sidebar adminOnly/managerOnly:
 *   /field-permissions → ADMIN  (every route in routes/field_permissions.js
 *                                 is verifyRole(["ADMIN"]); Sidebar adminOnly)
 *   /channels          → ADMIN  (sms/whatsapp/telephony /config endpoints
 *                                 are verifyRole(["ADMIN"]); Sidebar adminOnly)
 *   /staff             → ADMIN  (mutating routes are verifyRole(["ADMIN"]);
 *                                 Sidebar adminOnly)
 *   /settings          → ADMIN  (Sidebar adminOnly; admin-only tenant config)
 *   /marketing         → ADMIN+MANAGER  (Sidebar managerOnly; campaigns are
 *                                         management-tier work)
 */
function renderRouteWithRole({ path, allow, role, message }) {
  const user = { userId: 1, name: 'Test', email: 't@x.test', role };
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical: 'generic' }, loading: false }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path={path}
            element={
              <RoleGuard allow={allow} message={message}>
                <ProtectedPage />
              </RoleGuard>
            }
          />
          <Route path="/dashboard" element={<DashboardStub />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('<RoleGuard /> — Wave 11 sibling-route sweep (#574 + #589 follow-up)', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('/field-permissions: USER redirected (ADMIN-only — #574)', () => {
    renderRouteWithRole({
      path: '/field-permissions',
      allow: ['ADMIN'],
      role: 'USER',
      message: 'Field Permissions requires admin access.',
    });
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-landing')).toBeInTheDocument();
    expect(notifyError).toHaveBeenCalledWith('Field Permissions requires admin access.');
  });

  it('/channels: USER redirected (ADMIN-only — sms/whatsapp/telephony config)', () => {
    renderRouteWithRole({
      path: '/channels',
      allow: ['ADMIN'],
      role: 'USER',
      message: 'Channels requires admin access.',
    });
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-landing')).toBeInTheDocument();
    expect(notifyError).toHaveBeenCalledWith('Channels requires admin access.');
  });

  it('/staff: USER redirected (ADMIN-only — staff CRUD is admin work)', () => {
    renderRouteWithRole({
      path: '/staff',
      allow: ['ADMIN'],
      role: 'USER',
      message: 'Staff requires admin access.',
    });
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-landing')).toBeInTheDocument();
    expect(notifyError).toHaveBeenCalledWith('Staff requires admin access.');
  });

  it('/settings: USER redirected (ADMIN-only — tenant config)', () => {
    renderRouteWithRole({
      path: '/settings',
      allow: ['ADMIN'],
      role: 'USER',
      message: 'Settings requires admin access.',
    });
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-landing')).toBeInTheDocument();
    expect(notifyError).toHaveBeenCalledWith('Settings requires admin access.');
  });

  it('/marketing: USER redirected (ADMIN+MANAGER allowed); MANAGER stays (campaigns are mgmt-tier)', () => {
    renderRouteWithRole({
      path: '/marketing',
      allow: ['ADMIN', 'MANAGER'],
      role: 'USER',
      message: 'Marketing requires manager access.',
    });
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-landing')).toBeInTheDocument();
    expect(notifyError).toHaveBeenCalledWith('Marketing requires manager access.');

    // MANAGER allowed — second render asserts mgmt-tier passes through
    notifyError.mockReset();
    renderRouteWithRole({
      path: '/marketing',
      allow: ['ADMIN', 'MANAGER'],
      role: 'MANAGER',
      message: 'Marketing requires manager access.',
    });
    expect(screen.getByTestId('audit-heading')).toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });
});

/**
 * #721 + #727 — Wellness pages + Marketing now use the in-place locked-panel
 * variant of RoleGuard instead of the strict-redirect variant. The 5 routes
 * (giftcards, wallet, coupons, cashback-rules, marketing) should:
 *  - Always pass for ADMIN role even when wellnessRole=null (the issue
 *    reporter's case).
 *  - Always pass for MANAGER role.
 *  - For genuinely-unauthorised roles (USER / telecaller / helper), keep the
 *    user on the same URL and render a friendly locked panel with the
 *    new shared copy pattern:
 *       "You don't have access to <feature>. Required role: <roles>.
 *        Contact your administrator to request access."
 *  - Never fire a denial toast while AuthContext is still loading (was the
 *    most likely repro path for the issue reporter's "ADMIN sees manager-
 *    access toast" report — a hydration race where user was briefly null).
 */
function renderLockedInPlace({ role, wellnessRole = null, loading = false, feature, roles, path = '/wellness/giftcards' }) {
  const user = role ? { userId: 1, name: 'Test', email: 't@x.test', role, wellnessRole } : null;
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical: 'wellness' }, loading }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path={path}
            element={
              <RoleGuard
                allow={['ADMIN', 'MANAGER']}
                feature={feature}
                roles={roles}
                lockedInPlace
              >
                <ProtectedPage />
              </RoleGuard>
            }
          />
          <Route path="/dashboard" element={<DashboardStub />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('<RoleGuard /> — #721 + #727 lockedInPlace variant (wellness manager-access family)', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('ADMIN with wellnessRole=null passes the gate on /wellness/giftcards (the #721 repro)', () => {
    renderLockedInPlace({ role: 'ADMIN', wellnessRole: null, feature: 'Gift Cards', roles: 'manager (or admin)' });
    expect(screen.getByTestId('audit-heading')).toBeInTheDocument();
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-landing')).not.toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('MANAGER passes the gate on /wellness/wallet without toast', () => {
    renderLockedInPlace({ role: 'MANAGER', feature: 'Wallet ledger', roles: 'manager (or admin)', path: '/wellness/wallet' });
    expect(screen.getByTestId('audit-heading')).toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('USER (telecaller-like, not in allowlist) sees locked panel ON THE PAGE, NOT a redirect', () => {
    renderLockedInPlace({ role: 'USER', wellnessRole: 'telecaller', feature: 'Gift Cards', roles: 'manager (or admin)' });
    // Locked panel rendered in-place
    expect(screen.getByTestId('role-guard-locked-panel')).toBeInTheDocument();
    // The protected page's chrome is NOT mounted (no info leakage)
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    // The user did NOT get punted to /dashboard — URL context preserved
    expect(screen.queryByTestId('dashboard-landing')).not.toBeInTheDocument();
  });

  it('USER sees the new shared toast copy: feature name + required roles + contact-admin guidance', () => {
    renderLockedInPlace({ role: 'USER', wellnessRole: 'helper', feature: 'Gift Cards', roles: 'manager (or admin)' });
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(
      "You don't have access to Gift Cards. Required role: manager (or admin). Contact your administrator to request access.",
    );
  });

  it('USER on /marketing sees Marketing-labelled copy (each page customises the feature name)', () => {
    renderLockedInPlace({ role: 'USER', feature: 'Marketing', roles: 'manager (or admin)', path: '/marketing' });
    expect(notifyError).toHaveBeenCalledWith(
      "You don't have access to Marketing. Required role: manager (or admin). Contact your administrator to request access.",
    );
    // The locked panel renders the Marketing feature label in its heading
    const panel = screen.getByTestId('role-guard-locked-panel');
    expect(panel.textContent).toMatch(/Marketing is restricted/);
    expect(panel.textContent).toMatch(/manager \(or admin\) access/);
  });

  it('Wallet ledger feature label is reflected in the locked panel heading', () => {
    renderLockedInPlace({ role: 'USER', feature: 'Wallet ledger', roles: 'manager (or admin)', path: '/wellness/wallet' });
    const panel = screen.getByTestId('role-guard-locked-panel');
    expect(panel.textContent).toMatch(/Wallet ledger is restricted/);
  });

  it('Auth-loading safety: while loading is true, NO denial toast fires (the #721 hydration-race repro)', () => {
    renderLockedInPlace({ role: null, loading: true, feature: 'Gift Cards', roles: 'manager (or admin)' });
    expect(notifyError).not.toHaveBeenCalled();
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
  });

  it('Auth-loading safety: user=null with token but loading=false renders nothing (NOT a misleading denial)', () => {
    // Repro of the corrupted-session edge case: token survived sessionStorage
    // but the user object never landed in localStorage. We render nothing and
    // let the upstream Layout wrapper redirect to /login on its own pass.
    renderLockedInPlace({ role: null, loading: false, feature: 'Gift Cards', roles: 'manager (or admin)' });
    expect(notifyError).not.toHaveBeenCalled();
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
  });

  it('Toast does NOT repeat on re-render — toastedRef guards a single emit per mount', () => {
    const { rerender } = renderLockedInPlace({ role: 'USER', feature: 'Gift Cards', roles: 'manager (or admin)' });
    expect(notifyError).toHaveBeenCalledTimes(1);
    // Force a re-render of the SAME RoleGuard component tree (rerender keeps
    // the React instance, just re-runs the effect-dep array). The toastedRef
    // guard inside RoleGuard must prevent a second toast.
    rerender(
      <AuthContext.Provider value={{ user: { userId: 1, role: 'USER', wellnessRole: null }, token: 'tk', tenant: { vertical: 'wellness' }, loading: false }}>
        <MemoryRouter initialEntries={['/wellness/giftcards']}>
          <Routes>
            <Route
              path="/wellness/giftcards"
              element={
                <RoleGuard allow={['ADMIN', 'MANAGER']} feature="Gift Cards" roles="manager (or admin)" lockedInPlace>
                  <ProtectedPage />
                </RoleGuard>
              }
            />
            <Route path="/dashboard" element={<DashboardStub />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    // Still exactly 1 — the toastedRef survived the re-render
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});

describe('<RoleGuard /> — humaniseRoles fallback when no `roles` prop supplied', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('falls back to a humanised form of the allow array when `roles` is not provided', () => {
    const user = { userId: 1, name: 'Test', email: 't@x.test', role: 'USER' };
    render(
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical: 'wellness' }, loading: false }}>
        <MemoryRouter initialEntries={['/wellness/coupons']}>
          <Routes>
            <Route
              path="/wellness/coupons"
              element={
                <RoleGuard allow={['ADMIN', 'MANAGER']} feature="Coupons" lockedInPlace>
                  <ProtectedPage />
                </RoleGuard>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    // No `roles` prop → falls back to humaniseRoles(['ADMIN','MANAGER'])
    // → "admin or manager"
    expect(notifyError).toHaveBeenCalledWith(
      "You don't have access to Coupons. Required role: admin or manager. Contact your administrator to request access.",
    );
  });
});
