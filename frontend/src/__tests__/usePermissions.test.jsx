import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../appContexts';

const fetchApiMock = vi.fn();

vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

let usePermissions;
let invalidatePermissionCache;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function PermissionProbe() {
  const state = usePermissions();
  return (
    <div>
      <span data-testid="ready">{String(state.isReady)}</span>
      <span data-testid="contacts">{String(state.hasPermission('contacts', 'read'))}</span>
      <span data-testid="trips">{String(state.hasPermission('trips', 'read'))}</span>
    </div>
  );
}

function renderProbe(token) {
  return render(
    <AuthContext.Provider value={{ token, user: { role: 'USER', userType: 'STAFF' } }}>
      <PermissionProbe />
    </AuthContext.Provider>,
  );
}

beforeAll(async () => {
  // usePermissions normally uses synchronous role fixtures in MODE=test.
  // Import it under production mode so this suite exercises its real async
  // cache, invalidation and stale-response behavior.
  vi.stubEnv('MODE', 'production');
  const module = await import('../hooks/usePermissions');
  usePermissions = module.usePermissions;
  invalidatePermissionCache = module.invalidatePermissionCache;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  fetchApiMock.mockReset();
  invalidatePermissionCache();
});

describe('usePermissions session switching', () => {
  it('ignores an older permission response after the authenticated token changes', async () => {
    const first = deferred();
    const second = deferred();
    fetchApiMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const rendered = renderProbe('token-a');
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1));

    // App.setToken invalidates the shared permission cache before publishing
    // the new token. Mirror that ordering here.
    invalidatePermissionCache();
    rendered.rerender(
      <AuthContext.Provider value={{ token: 'token-b', user: { role: 'USER', userType: 'STAFF' } }}>
        <PermissionProbe />
      </AuthContext.Provider>,
    );
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({
        isOwner: false,
        roles: ['TRAVEL_STAFF'],
        permissions: ['trips.read'],
      });
      await second.promise;
    });
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    expect(screen.getByTestId('trips').textContent).toBe('true');
    expect(screen.getByTestId('contacts').textContent).toBe('false');

    await act(async () => {
      first.resolve({
        isOwner: false,
        roles: ['OLD_SESSION'],
        permissions: ['contacts.read'],
      });
      await first.promise;
    });

    expect(screen.getByTestId('trips').textContent).toBe('true');
    expect(screen.getByTestId('contacts').textContent).toBe('false');
  });
});
