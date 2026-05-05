import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { launchAdsGptAs, ADSGPT_API_BASE, ADSGPT_DASHBOARD, ADSGPT_DEMO_LOGIN } from '../utils/adsgpt';

/**
 * frontend/src/utils/adsgpt.js — AdsGPT impersonation SSO
 *
 * What's tested
 *   - Constants: API_BASE, DASHBOARD, DEMO_LOGIN have sane defaults when
 *     no VITE_ADSGPT_* env-vars are set (Vite injects empty string fallback).
 *   - Happy path: token fetch + Redis-stash + window.open with the forword key.
 *   - Empty login throws BEFORE any fetch fires (input-guard).
 *   - Token fetch failure (HTTP error OR { ok: false }) throws with server msg.
 *   - Save / Redis-stash failure throws with server msg, never opens a window.
 *
 * Why
 *   The AdsGPT SSO is a 3-leg impersonation flow. A regression in any leg
 *   silently lands the user on `about:blank` because the dashboard
 *   `?forword=undefined` redirect bounces back to the marketing page. Tests
 *   pin each leg separately so a partial regression surfaces immediately.
 *
 * Contract pinned
 *   - Step 1: GET ${API_BASE}/adsgpt/check-access/by-login/<login>
 *   - Step 2: POST ${API_BASE}/adsgpt/backup/save body { query: '?sso=1', token }
 *   - Step 3: window.open(${DASHBOARD}/?forword=<key>, '_blank', 'noopener,noreferrer')
 */

describe('utils/adsgpt — module constants', () => {
  it('exposes default API_BASE / DASHBOARD / DEMO_LOGIN', () => {
    expect(typeof ADSGPT_API_BASE).toBe('string');
    expect(ADSGPT_API_BASE).toMatch(/^https?:\/\//);
    expect(typeof ADSGPT_DASHBOARD).toBe('string');
    expect(ADSGPT_DASHBOARD).toMatch(/^https?:\/\//);
    expect(typeof ADSGPT_DEMO_LOGIN).toBe('string');
    expect(ADSGPT_DEMO_LOGIN.length).toBeGreaterThan(0);
  });
});

describe('utils/adsgpt — launchAdsGptAs (3-leg SSO)', () => {
  let fetchSpy;
  let openSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
    openSpy = vi.spyOn(window, 'open').mockReturnValue({ closed: false });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('throws when no login configured (and never calls fetch)', async () => {
    await expect(launchAdsGptAs('')).rejects.toThrow(/No AdsGPT login configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('happy path: token → save → open dashboard with forword key', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, token: 'TOKEN_XYZ' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, key: 'FORWORD_KEY_42' }),
      });

    const result = await launchAdsGptAs('demo_user');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Step 1
    expect(fetchSpy.mock.calls[0][0]).toContain('/adsgpt/check-access/by-login/demo_user');
    // Step 2
    expect(fetchSpy.mock.calls[1][0]).toContain('/adsgpt/backup/save');
    const saveOpts = fetchSpy.mock.calls[1][1];
    expect(saveOpts.method).toBe('POST');
    expect(saveOpts.headers['Content-Type']).toBe('application/json');
    const saveBody = JSON.parse(saveOpts.body);
    expect(saveBody.query).toBe('?sso=1');
    expect(saveBody.token).toBe('TOKEN_XYZ');
    // Step 3
    expect(openSpy).toHaveBeenCalledOnce();
    const [target, frame, features] = openSpy.mock.calls[0];
    expect(target).toContain('forword=FORWORD_KEY_42');
    expect(frame).toBe('_blank');
    expect(features).toBe('noopener,noreferrer');
    expect(result).toBe(target);
  });

  it('encodes login + key for URL-safe placement', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, token: 'T' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, key: 'a b/c?d&e' }),
      });

    await launchAdsGptAs('user with spaces');

    expect(fetchSpy.mock.calls[0][0]).toContain(encodeURIComponent('user with spaces'));
    const finalUrl = openSpy.mock.calls[0][0];
    expect(finalUrl).toContain(encodeURIComponent('a b/c?d&e'));
  });

  it('throws + no window.open when token endpoint returns { ok:false }', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: false, msg: 'no such login' }),
    });

    await expect(launchAdsGptAs('ghost')).rejects.toThrow(/no such login/);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('throws + no window.open when token endpoint returns HTTP 500', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    await expect(launchAdsGptAs('demo')).rejects.toThrow(/Token fetch failed.*500/);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('throws + no window.open when save/Redis-stash fails', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, token: 'T' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ message: 'redis down' }),
      });

    await expect(launchAdsGptAs('demo')).rejects.toThrow(/redis down/);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
