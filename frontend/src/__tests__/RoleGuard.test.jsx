/**
 * RoleGuard — route-level RBAC gate.
 *
 * #768 CANONICAL permission-denial pattern (2026-05-15). Pre-#768 RoleGuard
 * had two modes (strict redirect+toast / lockedInPlace panel+toast) that
 * produced the three inconsistent denial behaviours the pen-test cluster
 * #756-#768 flagged. The refactor collapses both modes into ONE:
 *
 *   - role NOT in `allow`  → render the full-page lock panel IN PLACE.
 *   - NO toast.
 *   - NO redirect.
 *   - children (the protected page) never mount → no info-disclosure of the
 *     page chrome / KPI shapes / internal model names.
 *
 * Acceptance pinned here:
 *   1. Denied role → lock panel renders; protected page chrome absent.
 *   2. Denied role → NO redirect (no /dashboard landing in the DOM).
 *   3. Denied role → NO denial toast (notify.error never called).
 *   4. Allowed role → wrapped page renders normally, no panel.
 *   5. Auth-loading / corrupted-session → render nothing (no panel flash).
 *   6. feature/roles vs message vs neither → correct lock-panel copy.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// #768: RoleGuard no longer emits a toast. The mock stays so a regression
// that re-introduces notify.error is caught by the `not.toHaveBeenCalled`
// assertions below.
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

function renderGuard({ role, allow = ['ADMIN'], message, feature, roles, loading = false, path = '/audit-log', vertical = 'generic', wellnessRole = null }) {
  const user = role ? { userId: 1, name: 'Test', email: 't@x.test', role, wellnessRole } : null;
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { vertical }, loading }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path={path}
            element={
              <RoleGuard allow={allow} message={message} feature={feature} roles={roles}>
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

describe('<RoleGuard /> — #768 canonical denial: lock panel, no toast, no redirect', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('denied role: renders the lock panel in place', () => {
    renderGuard({ role: 'USER', message: 'Audit Log requires admin access.' });
    expect(screen.getByTestId('role-guard-locked-panel')).toBeInTheDocument();
  });

  it('denied role: does NOT render the protected page chrome (no info disclosure)', () => {
    renderGuard({ role: 'USER', message: 'Audit Log requires admin access.' });
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-card-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-card-creates')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-entity')).not.toBeInTheDocument();
  });

  it('denied role: does NOT redirect (no /dashboard landing — URL context preserved)', () => {
    renderGuard({ role: 'USER', message: 'Audit Log requires admin access.' });
    expect(screen.queryByTestId('dashboard-landing')).not.toBeInTheDocument();
  });

  it('denied role: does NOT fire a denial toast', () => {
    renderGuard({ role: 'USER', message: 'Audit Log requires admin access.' });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('MANAGER on an ADMIN-only route: also locked (frontend stricter than backend)', () => {
    renderGuard({ role: 'MANAGER', message: 'Audit Log requires admin access.' });
    expect(screen.getByTestId('role-guard-locked-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('allowed role: renders the protected page normally with all chrome', () => {
    renderGuard({ role: 'ADMIN', message: 'Audit Log requires admin access.' });
    expect(screen.getByTestId('audit-heading')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-card-total')).toBeInTheDocument();
    expect(screen.getByTestId('filter-entity')).toBeInTheDocument();
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe('<RoleGuard /> — lock-panel copy precedence', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('feature + roles: heading + role-guidance body', () => {
    renderGuard({ role: 'USER', allow: ['ADMIN', 'MANAGER'], feature: 'Marketing', roles: 'manager (or admin)' });
    const panel = screen.getByTestId('role-guard-locked-panel');
    expect(panel.textContent).toMatch(/Marketing is restricted/);
    expect(panel.textContent).toMatch(/manager \(or admin\) access/);
    expect(panel.textContent).toMatch(/Contact your administrator/);
  });

  it('feature only: roles falls back to a humanised form of `allow`', () => {
    renderGuard({ role: 'USER', allow: ['ADMIN', 'MANAGER'], feature: 'Coupons' });
    const panel = screen.getByTestId('role-guard-locked-panel');
    expect(panel.textContent).toMatch(/Coupons is restricted/);
    expect(panel.textContent).toMatch(/admin or manager access/);
  });

  it('message only (legacy escape hatch): generic heading + the custom sentence as body', () => {
    renderGuard({ role: 'USER', message: 'Audit Log requires admin access.' });
    const panel = screen.getByTestId('role-guard-locked-panel');
    expect(panel.textContent).toMatch(/This page is restricted/);
    expect(panel.textContent).toMatch(/Audit Log requires admin access\./);
  });

  it('neither feature nor message: fully generic copy', () => {
    renderGuard({ role: 'USER' });
    const panel = screen.getByTestId('role-guard-locked-panel');
    expect(panel.textContent).toMatch(/This page is restricted/);
    expect(panel.textContent).toMatch(/Contact your administrator to request access\./);
  });
});

describe('<RoleGuard /> — auth-loading safety (#721)', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('while loading is true: renders nothing (no lock-panel flash)', () => {
    renderGuard({ role: null, loading: true, feature: 'Gift Cards', roles: 'manager (or admin)', path: '/wellness/giftcards', vertical: 'wellness' });
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('user=null with token but loading=false: renders nothing (corrupted-session edge — Layout handles /login)', () => {
    renderGuard({ role: null, loading: false, feature: 'Gift Cards', roles: 'manager (or admin)', path: '/wellness/giftcards', vertical: 'wellness' });
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe('<RoleGuard /> — wellness manager-access family (#721 / #727 regression pins)', () => {
  beforeEach(() => {
    notifyError.mockReset();
  });

  it('ADMIN with wellnessRole=null passes the gate on /wellness/giftcards (the #721 repro)', () => {
    renderGuard({ role: 'ADMIN', wellnessRole: null, allow: ['ADMIN', 'MANAGER'], feature: 'Gift Cards', roles: 'manager (or admin)', path: '/wellness/giftcards', vertical: 'wellness' });
    expect(screen.getByTestId('audit-heading')).toBeInTheDocument();
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
  });

  it('MANAGER passes the gate on /wellness/wallet', () => {
    renderGuard({ role: 'MANAGER', allow: ['ADMIN', 'MANAGER'], feature: 'Wallet ledger', roles: 'manager (or admin)', path: '/wellness/wallet', vertical: 'wellness' });
    expect(screen.getByTestId('audit-heading')).toBeInTheDocument();
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
  });

  it('USER (telecaller wellnessRole, not in allowlist): lock panel ON THE PAGE, no redirect', () => {
    renderGuard({ role: 'USER', wellnessRole: 'telecaller', allow: ['ADMIN', 'MANAGER'], feature: 'Gift Cards', roles: 'manager (or admin)', path: '/wellness/giftcards', vertical: 'wellness' });
    expect(screen.getByTestId('role-guard-locked-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-heading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-landing')).not.toBeInTheDocument();
  });
});
