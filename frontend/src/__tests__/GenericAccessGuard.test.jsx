import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  }),
}));

import { AuthContext } from '../appContexts';
import GenericAccessGuard from '../components/GenericAccessGuard';

function renderDashboard(permissions) {
  const user = {
    userId: 7,
    role: 'USER',
    permissions,
  };

  return render(
    <AuthContext.Provider
      value={{
        user,
        token: 'dashboard-guard-token',
        tenant: { vertical: 'generic' },
        loading: false,
      }}
    >
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={(
              <GenericAccessGuard>
                <div data-testid="dashboard-page">Dashboard</div>
              </GenericAccessGuard>
            )}
          />
          <Route path="/home" element={<div data-testid="home-page">Home</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('<GenericAccessGuard /> dashboard fallback', () => {
  it('redirects a user without reports.read from /dashboard to /home', () => {
    renderDashboard([]);

    expect(screen.getByTestId('home-page')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-page')).not.toBeInTheDocument();
  });

  it('renders /dashboard when the user has reports.read', () => {
    renderDashboard(['reports.read']);

    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });
});
