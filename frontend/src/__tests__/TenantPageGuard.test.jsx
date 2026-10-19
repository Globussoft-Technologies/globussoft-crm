import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TenantPageGuard from '../components/TenantPageGuard';
import { AuthContext } from '../appContexts';

const { fetchApiMock } = vi.hoisted(() => ({ fetchApiMock: vi.fn() }));
vi.mock('../utils/api', () => ({ fetchApi: fetchApiMock }));

function renderGuard(path, response) {
  fetchApiMock.mockResolvedValue(response);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ tenant: { id: 1 } }}>
        <TenantPageGuard><div>Protected page</div></TenantPageGuard>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('TenantPageGuard', () => {
  beforeEach(() => fetchApiMock.mockReset());

  it.each(['generic', 'travel', 'wellness'])('only brands Generic organization checks (%s) without mounting a hidden page', async (vertical) => {
    let resolveAccess;
    fetchApiMock.mockReturnValue(new Promise((resolve) => { resolveAccess = resolve; }));
    render(
      <MemoryRouter initialEntries={['/contacts']}>
        <AuthContext.Provider value={{ tenant: { id: 1, vertical } }}>
          <TenantPageGuard><div>Protected page</div></TenantPageGuard>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('status').classList.contains('workspace-preloader')).toBe(vertical === 'generic');
    expect(screen.queryByText('Protected page')).not.toBeInTheDocument();
    resolveAccess({ hiddenPaths: ['/contacts'] });
    expect(await screen.findByTestId('tenant-page-disabled')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Protected page')).not.toBeInTheDocument();
  });

  it('replaces a page disabled for the current tenant', async () => {
    renderGuard('/marketing', { pages: [], hiddenPaths: ['/marketing'] });
    expect(await screen.findByTestId('tenant-page-disabled')).toBeInTheDocument();
    expect(screen.queryByText('Protected page')).not.toBeInTheDocument();
  });

  it('keeps enabled pages available', async () => {
    renderGuard('/contacts', { pages: [], hiddenPaths: ['/marketing'] });
    expect(await screen.findByText('Protected page')).toBeInTheDocument();
    expect(screen.queryByTestId('tenant-page-disabled')).not.toBeInTheDocument();
  });
});
