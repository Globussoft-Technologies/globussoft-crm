// @ts-check
/**
 * Unit tests for backend/lib/authCookies.js — pins the canonical option
 * shape for the additive auth-token cookie introduced by #914 slice 1.
 *
 * Surface pinned
 * ──────────────
 *   TOKEN_COOKIE       — string constant; the canonical cookie name.
 *   setAuthCookie(res, token, opts?) — writes the cookie with the
 *                        documented option shape.
 *   clearAuthCookie(res)            — drops the cookie with the matching
 *                        path so the browser actually removes it.
 *
 * Why every option matters (and is pinned in a separate test case)
 * ─────────────────────────────────────────────────────────────────
 *   httpOnly  → cookie is not reachable from JS (mitigates XSS exfil).
 *   secure    → only set on NODE_ENV=production so dev over plain HTTP
 *               still works; demo + prod are HTTPS via certbot + Nginx.
 *   sameSite  → 'strict' blocks the cookie on cross-site navigation,
 *               removing the CSRF surface this cookie would otherwise
 *               create. Slice 4 will additionally layer in a CSRF token
 *               for the (rare) cross-site-POST-with-cookie case once
 *               consumers actually read this cookie.
 *   path=/api → cookie only rides on /api/* requests, not the static
 *               frontend bundle from /. Matches the existing rate-limit
 *               + auth surface boundary.
 *   maxAge    → 15 min default. Short by design; slice 2 pairs this
 *               with a refresh-token endpoint so the SPA can rotate
 *               transparently.
 *
 * Test pattern: stub `res` with a vi.fn()-backed `cookie` + `clearCookie`
 * (Express's contract is "the framework supplies these"); inspect the
 * exact call arguments. No HTTP layer, no supertest — this is the unit
 * level for the cookie-option contract itself.
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  TOKEN_COOKIE,
  setAuthCookie,
  clearAuthCookie,
} from '../../lib/authCookies.js';

/** Build a minimal fake Response with cookie/clearCookie spies. */
function makeRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  // Default each test to non-production so the secure-flag assertion is
  // isolated to the test that explicitly sets NODE_ENV=production.
  delete process.env.NODE_ENV;
});

afterEach(() => {
  // Restore original NODE_ENV so we don't leak test state into sibling
  // suites that read process.env (e.g. config/secrets.js).
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe('TOKEN_COOKIE constant', () => {
  test('exports the canonical name "auth_token"', () => {
    // Pinned because middleware/auth.js (slice 2) and the SPA fetch helper
    // (slice 3) will both reach into this same constant. A rename here
    // without a coordinated rename downstream silently breaks both. The
    // hard-coded literal in this assertion is intentional.
    expect(TOKEN_COOKIE).toBe('auth_token');
  });
});

describe('setAuthCookie — default options', () => {
  test('writes the cookie with the canonical option shape (15-min TTL)', () => {
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig');

    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, opts] = res.cookie.mock.calls[0];
    expect(name).toBe('auth_token');
    expect(value).toBe('jwt.payload.sig');
    expect(opts).toEqual({
      httpOnly: true,
      secure: false, // NODE_ENV is not 'production' in this test
      sameSite: 'strict',
      path: '/api',
      maxAge: 15 * 60 * 1000, // 15 min in ms
    });
  });
});

describe('setAuthCookie — custom maxAge', () => {
  test('overrides the default lifetime when opts.maxAgeSec is supplied', () => {
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig', { maxAgeSec: 60 });

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.maxAge).toBe(60_000); // exactly 60s in ms — no off-by-1000 bug
    // Other options must NOT regress under a custom maxAge — that's the
    // class of bug the regression-pin guards against.
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
    expect(opts.path).toBe('/api');
  });
});

describe('setAuthCookie — NODE_ENV=production flips secure flag', () => {
  test('sets secure=true when running in production', () => {
    process.env.NODE_ENV = 'production';
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig');

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.secure).toBe(true);
    // Sanity-check the other options didn't drift under the prod branch.
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
  });
});

describe('setAuthCookie — NODE_ENV=development keeps secure flag off', () => {
  test('secure=false for any non-production NODE_ENV', () => {
    // Cover the explicit 'development' case (and confirm secure is NOT
    // gated by an "if defined" check — only the literal 'production'
    // string flips it).
    process.env.NODE_ENV = 'development';
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig');

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.secure).toBe(false);
  });
});

describe('clearAuthCookie — drops the cookie with matching path', () => {
  test('calls res.clearCookie with path=/api so the browser actually removes it', () => {
    const res = makeRes();
    clearAuthCookie(res);

    // RFC 6265 §4.1.2: a clearCookie call MUST use the same path as the
    // set call, or the browser keeps the cookie at the original path. If
    // this assertion ever loosens, slice 1's logout flow silently leaks
    // the cookie past logout.
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    expect(res.clearCookie).toHaveBeenCalledWith('auth_token', { path: '/api' });
  });
});
