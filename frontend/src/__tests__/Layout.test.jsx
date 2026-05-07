import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

// #555: mock fetchApi so the TenantSwitcher's GET /api/auth/tenants
// resolves predictably. The two helpers (getActiveTenantId,
// setActiveTenantId) are pass-through no-ops in tests.
const fetchApiMock = vi.fn();
const setActiveTenantIdMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  setActiveTenantId: (...args) => setActiveTenantIdMock(...args),
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
    setActiveTenantIdMock.mockReset();
    // Default: single-tenant — switcher should NOT render.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/tenants') return Promise.resolve({ tenants: [{ id: 1, name: 'Default Org', vertical: 'generic' }], activeTenantId: 1 });
      return Promise.resolve({});
    });
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

  // #555 (HI-06): explicit tenant switcher — silent no-op when only one
  // tenant is accessible (today's data model is single-tenant per user
  // so this is the default branch).
  it('does NOT render the tenant switcher when only 1 tenant is accessible', async () => {
    renderLayout();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/auth/tenants', expect.any(Object)));
    expect(screen.queryByTestId('tenant-switcher')).not.toBeInTheDocument();
  });

  it('renders the tenant switcher dropdown when 2+ tenants are accessible', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/tenants') return Promise.resolve({
        tenants: [
          { id: 1, name: 'Default Org', vertical: 'generic' },
          { id: 2, name: 'Enhanced Wellness', vertical: 'wellness' },
        ],
        activeTenantId: 1,
      });
      return Promise.resolve({});
    });
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    await waitFor(() => expect(screen.getByTestId('tenant-switcher')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /switch tenant/i }));
    expect(screen.getByRole('listbox', { name: /available tenants/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Enhanced Wellness/i })).toBeInTheDocument();
  });

  it('switching dispatches POST /api/auth/tenant-switch and updates active tenant id', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/tenants') return Promise.resolve({
        tenants: [
          { id: 1, name: 'Default Org', vertical: 'generic' },
          { id: 2, name: 'Enhanced Wellness', vertical: 'wellness' },
        ],
        activeTenantId: 1,
      });
      if (url === '/api/auth/tenant-switch' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, token: 'new-token-xyz', tenant: { id: 2, name: 'Enhanced Wellness', vertical: 'wellness' } });
      }
      if (url === '/api/auth/me') return Promise.resolve({ id: 1, name: 'Alice', role: 'ADMIN' });
      return Promise.resolve({});
    });
    renderLayout({ tenant: { id: 1, name: 'Default Org', vertical: 'generic' } });
    await waitFor(() => expect(screen.getByTestId('tenant-switcher')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /switch tenant/i }));
    // Find the inner <button> for the wellness option (the listbox <li>
    // wraps a button that dispatches the switch).
    const wellnessButton = screen.getAllByRole('button').find((b) => /Enhanced Wellness/i.test(b.textContent || ''));
    expect(wellnessButton).toBeTruthy();
    await act(async () => { fireEvent.click(wellnessButton); });
    await waitFor(() => expect(setActiveTenantIdMock).toHaveBeenCalledWith(2));
    const calls = fetchApiMock.mock.calls;
    const switchCall = calls.find((c) => c[0] === '/api/auth/tenant-switch');
    expect(switchCall).toBeTruthy();
    expect(switchCall[1].method).toBe('POST');
    expect(JSON.parse(switchCall[1].body)).toEqual({ toTenantId: 2 });
  });
});
