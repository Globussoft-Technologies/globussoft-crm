import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { fetchApiMock } = vi.hoisted(() => ({ fetchApiMock: vi.fn() }));
vi.mock('../utils/api', () => ({ fetchApi: fetchApiMock }));

import { AuthContext } from '../appContexts';
import PageAccessGuard, { invalidateAccessiblePageCache } from '../components/PageAccessGuard';

function renderPage(path, pages, catalog = pages) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/pages/me') return Promise.resolve({ pages });
    if (url === '/api/pages/catalog') return Promise.resolve({ catalog });
    return Promise.resolve({});
  });

  return render(
    <AuthContext.Provider
      value={{
        token: 'page-guard-token',
        user: { userId: 1, role: 'USER' },
        tenant: { vertical: 'generic' },
      }}
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={(
              <PageAccessGuard>
                <div data-testid="protected-page">Protected page</div>
              </PageAccessGuard>
            )}
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('<PageAccessGuard />', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    invalidateAccessiblePageCache('page-guard-token');
  });

  it('renders a catalogued page when the effective permission grants it', async () => {
    renderPage(
      '/leads',
      [{ path: '/leads', requiredPermissions: [{ module: 'leads', action: 'read' }] }],
    );

    await waitFor(() => expect(screen.getByTestId('protected-page')).toBeInTheDocument());
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });

  it('does not mount a catalogued page when the permission is absent', async () => {
    renderPage(
      '/leads',
      [],
      [{ path: '/leads', requiredPermissions: [{ module: 'leads', action: 'read' }] }],
    );

    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument());
    expect(screen.queryByTestId('protected-page')).not.toBeInTheDocument();
  });

  it('does not gate routes that are intentionally outside the page catalog', async () => {
    renderPage('/profile', [], []);

    await waitFor(() => expect(screen.getByTestId('protected-page')).toBeInTheDocument());
  });
});
