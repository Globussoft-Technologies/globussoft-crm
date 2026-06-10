import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchApi, setAuthToken, clearAuthToken } from '../utils/api';

/**
 * frontend/src/utils/api.js — fetchApi wrapper contract
 *
 * What's tested
 *   - JSON Content-Type is always set
 *   - Authorization: Bearer <token> is added when an in-memory token is present
 *     (post-#343 hardening — token MUST come from setAuthToken / sessionStorage,
 *     never localStorage)
 *   - DELETE / 204 short-circuit return true
 *   - 401 clears the token via clearAuthToken() + redirects to /login (foreground)
 *   - 401 with {silent:true} clears the token but does NOT redirect (#841 — keeps
 *     background polls from booting the user mid-flow on transient 401s)
 *   - 5xx with a parseable error body surfaces server-supplied message
 *   - 5xx with an unparseable body falls back to the generic "Server error" copy
 *
 * Why
 *   Every page in the SPA goes through fetchApi — a regression here breaks
 *   auth, error toasts, and the silent-401 redirect that keeps stale-session
 *   tabs from rendering blank pages.
 *
 * Contract pinned
 *   - getAuthToken() reads sessionStorage["token"] but NEVER localStorage["token"]
 *   - 401 path: clearAuthToken() + window.location.href = '/login'
 *   - 5xx with no parseable body → "Server error — please try again."
 */

// jsdom doesn't allow writing to window.location.href cleanly — stub navigation
let capturedLocation = null;
const originalLocation = window.location;

function stubLocation() {
  capturedLocation = null;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...originalLocation,
      href: originalLocation.href,
      get () { return originalLocation.href; },
      set (v) { capturedLocation = v; },
    },
  });
  // The above get/set won't work for direct assignment; use a proxy instead.
  const state = { href: originalLocation.href };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new Proxy(state, {
      get: (t, k) => (k === 'href' ? (capturedLocation ?? t.href) : originalLocation[k]),
      set: (t, k, v) => {
        if (k === 'href') { capturedLocation = v; t.href = v; return true; }
        t[k] = v; return true;
      },
    }),
  });
}

function restoreLocation() {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
}

function mockFetch({ status = 200, body = {}, method = 'GET' } = {}) {
  return vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('utils/api — fetchApi', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Reset module-level _inMemoryToken between tests (no direct setter — clear).
    clearAuthToken();
    stubLocation();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreLocation();
    clearAuthToken();
  });

  it('adds Content-Type: application/json header', async () => {
    const spy = mockFetch({ body: { ok: true } });
    await fetchApi('/api/test');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('adds Authorization: Bearer <token> when token is in memory (post-#343 hardening)', async () => {
    // Pre-#343 the token came from localStorage. Post-fix it lives in a module-
    // level holder mirrored to sessionStorage; setAuthToken() is the only way in.
    setAuthToken('abc123');
    const spy = mockFetch({ body: { ok: true } });
    await fetchApi('/api/deals');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer abc123');
  });

  it('rehydrates Bearer from sessionStorage on cold start', async () => {
    // Simulates a hard-refresh where the JS module re-evaluates with no
    // in-memory token. getAuthToken() falls through to sessionStorage.
    sessionStorage.setItem('token', 'rehydrated');
    const spy = mockFetch({ body: { ok: true } });
    await fetchApi('/api/deals');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer rehydrated');
  });

  it('falls back to localStorage["token"] when sessionStorage is empty (v3.7.17 cross-tab remember-me)', async () => {
    // v3.7.17 (Login "Keep me signed in"): localStorage holds the token
    // ONLY when the user opted in at sign-in, and getAuthToken treats it as
    // the cross-tab fallback after sessionStorage misses. The cold-tab
    // path that drives shared-deep-link behavior must surface the
    // localStorage value as the Bearer. sessionStorage is intentionally
    // unset here to simulate a brand-new tab.
    localStorage.setItem('token', 'persisted-remember-token');
    const spy = mockFetch({ body: { ok: true } });
    await fetchApi('/api/deals');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer persisted-remember-token');
  });

  it('sessionStorage wins over localStorage when both are populated (#343 layering)', async () => {
    // Defence in depth: if sessionStorage has a token (normal in-session
    // browsing), it must be used in preference to any leftover
    // localStorage entry. The fallback-to-localStorage path is ONLY for
    // tabs whose sessionStorage is empty.
    sessionStorage.setItem('token', 'session-wins');
    localStorage.setItem('token', 'should-not-win');
    const spy = mockFetch({ body: { ok: true } });
    await fetchApi('/api/deals');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer session-wins');
  });

  it('omits Authorization header when no token', async () => {
    const spy = mockFetch({ body: {} });
    await fetchApi('/api/public');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('merges caller-supplied headers', async () => {
    const spy = mockFetch({ body: {} });
    await fetchApi('/api/x', { headers: { 'X-Trace': 'abc' } });
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers['X-Trace']).toBe('abc');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('returns parsed JSON on success', async () => {
    mockFetch({ body: { hello: 'world' } });
    const out = await fetchApi('/api/anything');
    expect(out).toEqual({ hello: 'world' });
  });

  it('returns true for DELETE method', async () => {
    mockFetch({ status: 200, body: {}, method: 'DELETE' });
    const out = await fetchApi('/api/x/1', { method: 'DELETE' });
    expect(out).toBe(true);
  });

  it('returns true for 204 No Content response', async () => {
    mockFetch({ status: 204, body: {} });
    const out = await fetchApi('/api/noop');
    expect(out).toBe(true);
  });

  it('throws on 500 using server error message', async () => {
    mockFetch({ status: 500, body: { message: 'boom' } });
    await expect(fetchApi('/api/crash')).rejects.toThrow('boom');
  });

  it('throws status-bucketed default message when JSON parse fails (5xx path)', async () => {
    // Pre-#275 the helper said "API Request Failed". Post-fix the default copy
    // is bucketed by status: 5xx → "Server error — please try again.", 403 →
    // permission, 404 → not-found, otherwise → "Request failed (<status>)."
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('parse fail')),
    });
    await expect(fetchApi('/api/crash')).rejects.toThrow('Server error');
  });

  it('on 401: clears in-memory + sessionStorage token and redirects to /login', async () => {
    setAuthToken('expired');
    expect(sessionStorage.getItem('token')).toBe('expired');
    mockFetch({ status: 401, body: { message: 'nope' } });
    await expect(fetchApi('/api/private')).rejects.toThrow();
    // clearAuthToken nukes both the in-memory holder and sessionStorage.
    expect(sessionStorage.getItem('token')).toBeNull();
    expect(capturedLocation).toBe('/login');
  });

  it('#841: silent:true 401 does NOT redirect (background polls fail quietly)', async () => {
    // Pre-#841: ANY 401 — even from a background poll — force-redirected the
    // user to /login. Symptom: user clicks a link mid-flow, but a sibling
    // Sidebar/Dashboard poll 401s in the same tick → user ends up on /login
    // instead of the link target. Fix: silent:true 401s clear the token but
    // don't navigate. The next foreground (user-initiated) request will hit
    // the regular 401 path and redirect properly.
    setAuthToken('expired');
    mockFetch({ status: 401, body: { message: 'nope' } });
    await expect(
      fetchApi('/api/contacts?status=Lead', { silent: true })
    ).rejects.toMatchObject({ status: 401, silent: true });
    // Token is still cleared (it's expired/invalid).
    expect(sessionStorage.getItem('token')).toBeNull();
    // BUT no navigation happened — the user stays on their current page.
    expect(capturedLocation).toBeNull();
  });
});
