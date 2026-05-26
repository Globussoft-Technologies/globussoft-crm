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

describe('setAuthCookie — maxAgeSec edge values', () => {
  test('maxAgeSec=0 produces maxAge=0 ms (browser treats as expired immediately)', () => {
    // The SUT multiplies maxAgeSec * 1000 with no clamping, so 0 passes
    // through verbatim. Pinned because a defensive future refactor that
    // "guards against 0" by falling back to the default would silently
    // change semantics — slice-2's refresh flow may legitimately want a
    // 0-TTL set to invalidate a session.
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig', { maxAgeSec: 0 });

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.maxAge).toBe(0);
  });

  test('maxAgeSec negative passes through verbatim (-60 → -60000 ms)', () => {
    // Browsers treat negative maxAge identically to 0 (expired). The SUT
    // does no validation; that's correct — input validation is the
    // route-layer's job, not the cookie-shape helper's.
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig', { maxAgeSec: -60 });

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.maxAge).toBe(-60_000);
  });

  test('maxAgeSec=1 year in seconds → 1 year in ms (multiplication boundary)', () => {
    // Verifies the *1000 multiplication does not overflow Number.MAX_SAFE_INTEGer
    // at year-scale. 31_536_000 sec * 1000 = 31_536_000_000 ms, well under
    // 2^53. Pin sized at "realistic upper bound for a remember-me cookie."
    const oneYearSec = 60 * 60 * 24 * 365;
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig', { maxAgeSec: oneYearSec });

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.maxAge).toBe(oneYearSec * 1000);
    expect(opts.maxAge).toBe(31_536_000_000);
  });
});

describe('setAuthCookie — secure flag is strict-equal to "production"', () => {
  test('NODE_ENV="PRODUCTION" (uppercase) → secure=false', () => {
    // The SUT uses `=== "production"` (case-sensitive). An uppercase env
    // value does NOT flip secure. This is the canonical pen-test
    // detection: if an ops mistake exports NODE_ENV=PRODUCTION, the
    // cookie would ship without the secure flag and ride plain-HTTP if
    // a downstream proxy ever terminates TLS early. Pinned so a future
    // "case-insensitive" refactor is a deliberate decision, not a drift.
    process.env.NODE_ENV = 'PRODUCTION';
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig');

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.secure).toBe(false);
  });

  test('NODE_ENV="staging" → secure=false (only literal "production" flips)', () => {
    process.env.NODE_ENV = 'staging';
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig');

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.secure).toBe(false);
  });
});

describe('setAuthCookie — opts edge shapes', () => {
  test('empty {} opts uses all defaults (maxAgeSec=900)', () => {
    // Confirms the destructure default `{ maxAgeSec = 60 * 15 } = {}`
    // fires when the caller explicitly passes an empty object.
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig', {});

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.maxAge).toBe(15 * 60 * 1000);
  });

  test('opts.maxAgeSec=undefined explicitly → falls back to default 900', () => {
    // Distinct from the empty-object case: this passes an opts object
    // that explicitly sets the key to undefined. The destructure default
    // syntax `{ maxAgeSec = 60 * 15 }` fires on undefined (but NOT on
    // null), which is the documented JS semantics. Pinned so a future
    // refactor to use `??` or `||` doesn't silently change the contract.
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig', { maxAgeSec: undefined });

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.maxAge).toBe(15 * 60 * 1000);
  });
});

describe('setAuthCookie — idempotent re-call', () => {
  test('two back-to-back calls produce two identical cookie writes (no state leak)', () => {
    // Pin: the helper holds NO module-level mutable state, so calling
    // setAuthCookie twice on the same res yields two identical option
    // objects. Guards against a future "memoize the options bag" micro-
    // optimisation that could accidentally share a reference across
    // calls (then a downstream mutation to one would corrupt the next).
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig');
    setAuthCookie(res, 'jwt.payload.sig');

    expect(res.cookie).toHaveBeenCalledTimes(2);
    const firstCall = res.cookie.mock.calls[0];
    const secondCall = res.cookie.mock.calls[1];
    expect(secondCall[0]).toBe(firstCall[0]); // same cookie name
    expect(secondCall[1]).toBe(firstCall[1]); // same token value
    expect(secondCall[2]).toEqual(firstCall[2]); // same options shape
  });
});

describe('clearAuthCookie — does not invoke res.cookie', () => {
  test('clearAuthCookie touches clearCookie only, never res.cookie', () => {
    // Defensive pin: if a future refactor tries to "blank out" the cookie
    // by calling res.cookie with an empty value (a common but wrong
    // pattern — the browser then has TWO Set-Cookie headers fighting),
    // this catches it. The SUT MUST use clearCookie exclusively.
    const res = makeRes();
    clearAuthCookie(res);

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.cookie.mock.calls.length).toBe(0);
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
  });
});

describe('setAuthCookie — combined custom maxAge + NODE_ENV=production', () => {
  test('both the prod-flag and the custom TTL compose without interfering', () => {
    // Combined-correctness pin: ensures the prod-branch logic and the
    // opts destructure are independent. A future refactor that conflates
    // the two (e.g. "in prod, force the default TTL") would break this.
    process.env.NODE_ENV = 'production';
    const res = makeRes();
    setAuthCookie(res, 'jwt.payload.sig', { maxAgeSec: 300 });

    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.secure).toBe(true);
    expect(opts.maxAge).toBe(300_000);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
    expect(opts.path).toBe('/api');
  });
});
