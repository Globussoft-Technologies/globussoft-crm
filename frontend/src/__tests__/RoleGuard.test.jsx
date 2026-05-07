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
