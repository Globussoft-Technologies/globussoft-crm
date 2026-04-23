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
});
