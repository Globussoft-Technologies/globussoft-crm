import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchApi } from '../utils/api';

/**
 * fetchApi is a tiny wrapper over fetch that:
 *   - adds JSON Content-Type
 *   - adds Bearer token from localStorage (if present)
 *   - parses JSON response
 *   - on 401, clears token + redirects to /login
 *   - returns true for DELETE / 204 responses
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
    stubLocation();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreLocation();
  });

  it('adds Content-Type: application/json header', async () => {
    const spy = mockFetch({ body: { ok: true } });
    await fetchApi('/api/test');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('adds Authorization: Bearer <token> when token is in localStorage', async () => {
    localStorage.setItem('token', 'abc123');
    const spy = mockFetch({ body: { ok: true } });
    await fetchApi('/api/deals');
    const [, opts] = spy.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer abc123');
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

  it('throws default message when JSON parse fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('parse fail')),
    });
    await expect(fetchApi('/api/crash')).rejects.toThrow('API Request Failed');
  });

  it('on 401: clears token + redirects to /login', async () => {
    localStorage.setItem('token', 'expired');
    mockFetch({ status: 401, body: { message: 'nope' } });
    await expect(fetchApi('/api/private')).rejects.toThrow();
    expect(localStorage.getItem('token')).toBeNull();
    expect(capturedLocation).toBe('/login');
  });
});
