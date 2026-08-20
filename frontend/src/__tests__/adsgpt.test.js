import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import { launchAdsGptAs, ADSGPT_DASHBOARD, ADSGPT_DEMO_LOGIN } from '../utils/adsgpt';

describe('utils/adsgpt — module constants', () => {
  it('exposes default dashboard and demo login values', () => {
    expect(typeof ADSGPT_DASHBOARD).toBe('string');
    expect(ADSGPT_DASHBOARD).toMatch(/^https?:\/\//);
    expect(typeof ADSGPT_DEMO_LOGIN).toBe('string');
    expect(ADSGPT_DEMO_LOGIN.length).toBeGreaterThan(0);
  });
});

describe('utils/adsgpt — launchAdsGptAs (backend-proxied SSO)', () => {
  let openSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    openSpy = vi.spyOn(window, 'open').mockReturnValue({ closed: false });
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it('throws when no login configured', async () => {
    await expect(launchAdsGptAs('')).rejects.toThrow(/AdsGPT login not configured/);
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('requests backend SSO URL and opens it in a new tab', async () => {
    fetchApi.mockResolvedValueOnce({
      authUrl: 'https://dashboard.adsgpt.io/?forword=FORWORD_KEY_42',
    });

    const result = await launchAdsGptAs('demo_user');

    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/integrations/adsgpt/sso-url?login=demo_user',
    );
    expect(openSpy).toHaveBeenCalledOnce();
    const [target, frame, features] = openSpy.mock.calls[0];
    expect(target).toContain('forword=FORWORD_KEY_42');
    expect(frame).toBe('_blank');
    expect(features).toBe('noopener,noreferrer');
    expect(result).toBe(target);
  });

  it('encodes login in the backend request query string', async () => {
    fetchApi.mockResolvedValueOnce({
      authUrl: 'https://dashboard.adsgpt.io/?forword=a%20b',
    });

    await launchAdsGptAs('user with spaces');

    expect(fetchApi).toHaveBeenCalledWith(
      `/api/integrations/adsgpt/sso-url?${new URLSearchParams({ login: 'user with spaces' }).toString()}`,
    );
  });

  it('throws when backend does not return authUrl', async () => {
    fetchApi.mockResolvedValueOnce({});

    await expect(launchAdsGptAs('demo')).rejects.toThrow(/SSO URL was not returned/);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('surfaces backend error messages', async () => {
    fetchApi.mockRejectedValueOnce(new Error('Token fetch failed (HTTP 403)'));

    await expect(launchAdsGptAs('demo')).rejects.toThrow(/HTTP 403/);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
