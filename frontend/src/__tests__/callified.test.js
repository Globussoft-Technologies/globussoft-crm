import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * frontend/src/utils/callified.js — Callified SSO launcher
 *
 * What's tested
 *   - Happy path: backend returns { authUrl }; helper opens it in a new tab
 *     with noopener,noreferrer and resolves to the URL string.
 *   - Backend returns no authUrl → throws a clear error and does NOT
 *     pop a window (defence against opening an undefined URL).
 *   - Backend rejection (network / 5xx surfaced via fetchApi) propagates.
 *
 * Why
 *   This is the single launch path used by Sidebar AND OwnerDashboard. A
 *   regression here breaks SSO for every Callified-enabled tenant. The
 *   "no authUrl → throw" guard is a real defence — without it the helper
 *   would call window.open(undefined) which jsdom + Chrome both render as
 *   `about:blank`, masking the broken backend response.
 *
 * Contract pinned
 *   - Calls fetchApi('/api/integrations/callified/auth-url', { silent: false })
 *   - window.open(url, '_blank', 'noopener,noreferrer')
 *   - Throws on missing data.authUrl with message containing 'auth URL'
 */

// Mock fetchApi BEFORE importing the unit under test so the import sees the mock.
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import { launchCallifiedSSO } from '../utils/callified';

describe('utils/callified — launchCallifiedSSO', () => {
  let openSpy;

  beforeEach(() => {
    fetchApi.mockReset();
    openSpy = vi.spyOn(window, 'open').mockReturnValue({ closed: false });
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it('opens the returned authUrl in a new tab and resolves to the URL', async () => {
    const url = 'https://callified.ai/sso?token=abc';
    fetchApi.mockResolvedValueOnce({ authUrl: url });

    const result = await launchCallifiedSSO();

    expect(result).toBe(url);
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/integrations/callified/auth-url',
      { silent: false },
    );
    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });

  it('throws when backend returns no authUrl and never opens a window', async () => {
    fetchApi.mockResolvedValueOnce({ ok: true }); // missing authUrl

    await expect(launchCallifiedSSO()).rejects.toThrow(/auth URL/i);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('propagates backend rejection (e.g. 401 / network) without opening a window', async () => {
    fetchApi.mockRejectedValueOnce(new Error('Session expired — please sign in again.'));

    await expect(launchCallifiedSSO()).rejects.toThrow(/Session expired/);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
