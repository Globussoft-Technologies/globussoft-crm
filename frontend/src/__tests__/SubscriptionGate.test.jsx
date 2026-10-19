import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext } from '../appContexts';
import SubscriptionGate from '../components/SubscriptionGate';
import { fetchApi } from '../utils/api';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));

function renderGate(user = { role: 'ADMIN' }, vertical) {
  return render(
    <AuthContext.Provider value={{ user, token: 'test-token', tenant: { vertical }, setUser: vi.fn(), setToken: vi.fn() }}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<SubscriptionGate><div>Protected dashboard</div></SubscriptionGate>} />
          <Route path="/pricing" element={<div>Pricing page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('SubscriptionGate', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['generic', 'travel', 'wellness', undefined])('scopes the branded pending state to Generic (%s)', async (vertical) => {
    let resolveAccess;
    fetchApi.mockReturnValue(new Promise((resolve) => { resolveAccess = resolve; }));
    renderGate({ role: 'ADMIN' }, vertical);
    const status = screen.getByRole('status');
    expect(status.classList.contains('workspace-preloader')).toBe(vertical === 'generic');
    expect(screen.queryByText('Protected dashboard')).not.toBeInTheDocument();
    resolveAccess({ subscriptionStatus: 'ACTIVE' });
    expect(await screen.findByText('Protected dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('holds protected pages until access is checked and offers renewal when expired', async () => {
    let resolveAccess;
    fetchApi.mockReturnValue(new Promise((resolve) => { resolveAccess = resolve; }));
    renderGate();

    expect(screen.getByText('Checking subscription...')).toBeInTheDocument();
    expect(screen.queryByText('Protected dashboard')).not.toBeInTheDocument();
    resolveAccess({ subscriptionStatus: 'EXPIRED', daysRemaining: 0 });

    expect(await screen.findByRole('button', { name: /renew subscription/i })).toBeInTheDocument();
    expect(screen.queryByText('Protected dashboard')).not.toBeInTheDocument();
    expect(fetchApi).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /renew subscription/i }));
    expect(screen.getByText('Pricing page')).toBeInTheDocument();
  });

  it('lets a company with active coverage open its page', async () => {
    fetchApi.mockResolvedValue({ subscriptionStatus: 'ACTIVE', daysRemaining: 0 });
    renderGate();
    expect(await screen.findByText('Protected dashboard')).toBeInTheDocument();
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
  });
});
