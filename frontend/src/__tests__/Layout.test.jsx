import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';
import Layout from '../components/Layout';
import { AuthContext } from '../App';

// Stub the heavy children — we care about Layout's wiring
vi.mock('../components/Sidebar', () => ({ default: () => <div data-testid="sidebar-stub" /> }));
vi.mock('../components/Omnibar', () => ({ default: () => <div data-testid="omnibar-stub" /> }));
vi.mock('../components/Presence', () => ({ default: () => <div data-testid="presence-stub" /> }));
vi.mock('../components/Softphone', () => ({ default: () => <div data-testid="softphone-stub" /> }));
vi.mock('../components/NotificationBell', () => ({ default: () => <div data-testid="bell-stub" /> }));

// #555: mock fetchApi (Layout no longer pings /api/auth/tenants under
// lock-per-session — the chip reads from AuthContext.tenant — but
// fetchApi is still used by the subscription-status fetch elsewhere in
// Layout, so the mock stays.).
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  setActiveTenantId: () => {},
  getActiveTenantId: () => null,
}));

const setupPushMock = vi.fn(() => Promise.resolve(true));
vi.mock('../utils/pushSetup', () => ({ setupPush: (...args) => setupPushMock(...args) }));

function renderLayout({ user, tenant, initialRoute = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <AuthContext.Provider value={{
        user: user || { name: 'Alice', email: 'alice@x.test', role: 'USER' },
        setUser: vi.fn(),
        token: 't-abc',
        setToken: vi.fn(),
        tenant: tenant || { vertical: 'generic' },
        setTenant: vi.fn(),
      }}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<div data-testid="outlet">HOME</div>} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('Layout', () => {
  beforeEach(() => {
    setupPushMock.mockClear();
    fetchApiMock.mockReset();
    fetchApiMock.mockResolvedValue({});
  });

  it('renders Sidebar + Omnibar + Presence + NotificationBell + outlet', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar-stub')).toBeInTheDocument();
    expect(screen.getByTestId('omnibar-stub')).toBeInTheDocument();
    expect(screen.getByTestId('presence-stub')).toBeInTheDocument();
    expect(screen.getByTestId('bell-stub')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('renders Softphone for generic tenants', () => {
    renderLayout({ tenant: { vertical: 'generic' } });
    expect(screen.getByTestId('softphone-stub')).toBeInTheDocument();
  });

  it('hides Softphone for wellness tenants (Callified handles voice)', () => {
    renderLayout({ tenant: { vertical: 'wellness' } });
    expect(screen.queryByTestId('softphone-stub')).not.toBeInTheDocument();
  });

  it('shows user name + email initial', () => {
    renderLayout({ user: { name: 'Bob', email: 'bob@x.test', role: 'USER' } });
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('falls back to "User" label when user has no name/email', () => {
    renderLayout({ user: { role: 'USER' } });
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  it('registers push on mount when token present', () => {
    renderLayout();
    expect(setupPushMock).toHaveBeenCalledWith('t-abc');
  });

  it('logout button has aria-label + is clickable', () => {
    renderLayout();
    const btn = screen.getByLabelText(/Log out/i);
    expect(btn).toBeInTheDocument();
    // Clicking should not crash — side effects (navigate, token clear) happen
    fireEvent.click(btn);
    expect(localStorage.getItem('token')).toBeNull();
  });

  // #642: header avatar renders a role pip so the signed-in operator can
  // tell at a glance whether they're Owner / Admin / Manager / User.
  it('renders the role badge on the header avatar when authenticated', () => {
    renderLayout({ user: { name: 'Rishu', email: 'rishu@x.test', role: 'ADMIN' } });
    const pip = screen.getByTestId('avatar-role-badge');
    expect(pip).toBeInTheDocument();
    expect(pip).toHaveTextContent('A');
    expect(pip).toHaveAttribute('aria-label', 'Role: ADMIN');
  });

  it('renders OWNER role pip distinct from ADMIN', () => {
    renderLayout({ user: { name: 'Owner', email: 'o@x.test', role: 'OWNER' } });
    expect(screen.getByTestId('avatar-role-badge')).toHaveTextContent('O');
  });

  // #555 (HI-06) — lock-per-session policy. The earlier in-session
  // switcher widget is gone; in its place is a read-only chip that
  // shows the active tenant prominently. To switch tenants, users log
  // out and log back in.
  it('renders the read-only tenant chip with the tenant name', () => {
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    const chip = screen.getByTestId('tenant-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Default Org');
  });

  it('marks the chip as wellness when the tenant vertical is wellness', () => {
    renderLayout({ tenant: { id: 2, name: 'Enhanced Wellness', vertical: 'wellness' } });
    const chip = screen.getByTestId('tenant-chip');
    expect(chip).toHaveTextContent('Enhanced Wellness');
    expect(chip).toHaveTextContent(/wellness/i);
  });

  it('does NOT render an in-session switcher (lock-per-session policy)', () => {
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    expect(screen.queryByTestId('tenant-switcher')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch tenant/i })).not.toBeInTheDocument();
  });

  it('chip is non-interactive (no click handler dispatches a switch)', () => {
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    const chip = screen.getByTestId('tenant-chip');
    fireEvent.click(chip);
    // No /api/auth/tenant-switch call should ever fire from clicking the chip.
    const calls = fetchApiMock.mock.calls;
    expect(calls.find((c) => c[0] === '/api/auth/tenant-switch')).toBeFalsy();
  });

  it('renders nothing when tenant is missing', () => {
    renderLayout({ tenant: null });
    expect(screen.queryByTestId('tenant-chip')).not.toBeInTheDocument();
  });
});
