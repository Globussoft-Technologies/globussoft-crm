// Unit tests for backend/middleware/originCheck.js
//
// What this module does (#657 — CSRF defense layer for state-changing
// browser flows):
//   The CRM uses JWT bearer auth (not cookies) so classic CSRF doesn't
//   apply, but a stolen-JWT-replay-from-evil.com class IS in scope. This
//   middleware checks Origin/Referer against the CORS allowlist on every
//   state-changing verb (POST/PUT/PATCH/DELETE). Non-browser callers
//   (server-to-server, curl, Postman, External Partner API) omit both
//   headers and pass through unchanged.
//
// Surface area covered:
//   - originCheck middleware
//       - GET/HEAD/OPTIONS unconditionally pass
//       - PUBLIC_PATH_PREFIXES (webhooks, public bookings, External API,
//         OAuth callbacks, etc.) unconditionally pass
//       - no Origin AND no Referer → pass (server-to-server / native)
//       - matching Origin → pass
//       - matching Referer (fallback when Origin absent) → pass
//       - mismatching Origin → 403 ORIGIN_NOT_ALLOWED
//       - unparseable Origin/Referer → 403 INVALID_ORIGIN
//       - env-driven allowlist extensions (FRONTEND_URL, CORS_ALLOWED_ORIGINS)
//   - setSecureCookie helper
//       - sets HttpOnly + SameSite=Lax + path=/ by default
//       - sets secure=true in production, false otherwise
//       - caller overrides win over defaults
//   - buildAllowlist helper
//       - includes the 6 hardcoded defaults
//       - extends with FRONTEND_URL env var
//       - extends with CORS_ALLOWED_ORIGINS (comma-separated)
//       - dedupes overlapping entries
//   - originOf helper
//       - extracts scheme+host
//       - returns null on malformed / non-string input
//
// stripDangerous reminder (per CLAUDE.md): not relevant — middleware reads
// req.method, req.path, req.headers only. Does NOT touch req.body.
//
// Pattern source: backend/test/middleware/security.test.js (fake req/res/
// next builder, no prisma, no fetch).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  originCheck,
  setSecureCookie,
  buildAllowlist,
  originOf,
} from '../../middleware/originCheck.js';

function makeReqRes({ method = 'POST', path = '/api/contacts', headers = {} } = {}) {
  const req = {
    method,
    path,
    originalUrl: path,
    headers,
  };
  let statusCode = 200;
  const res = {
    status: vi.fn(function (c) {
      statusCode = c;
      return this;
    }),
    json: vi.fn(function (body) {
      this.body = body;
      return this;
    }),
    cookie: vi.fn(function () {
      return this;
    }),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot env vars before each test so allowlist tests can mutate them
// freely; restore afterwards so cross-test state stays clean.
let savedFrontendUrl;
let savedCorsAllowed;
let savedNodeEnv;

beforeEach(() => {
  savedFrontendUrl = process.env.FRONTEND_URL;
  savedCorsAllowed = process.env.CORS_ALLOWED_ORIGINS;
  savedNodeEnv = process.env.NODE_ENV;
  delete process.env.FRONTEND_URL;
  delete process.env.CORS_ALLOWED_ORIGINS;
});

afterEach(() => {
  if (savedFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = savedFrontendUrl;
  if (savedCorsAllowed === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = savedCorsAllowed;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

describe('module shape', () => {
  test('exports the public surface', () => {
    expect(typeof originCheck).toBe('function');
    expect(typeof setSecureCookie).toBe('function');
    expect(typeof buildAllowlist).toBe('function');
    expect(typeof originOf).toBe('function');
  });

  test('originCheck arity is 3 (req, res, next)', () => {
    expect(originCheck.length).toBe(3);
  });
});

describe('originCheck — idempotent verbs unconditionally pass', () => {
  test('GET with no Origin passes', () => {
    const { req, res, next } = makeReqRes({ method: 'GET' });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('GET with mismatching Origin still passes (read-only)', () => {
    const { req, res, next } = makeReqRes({
      method: 'GET',
      headers: { origin: 'https://evil.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('HEAD passes', () => {
    const { req, res, next } = makeReqRes({ method: 'HEAD' });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('OPTIONS passes (CORS preflight)', () => {
    const { req, res, next } = makeReqRes({
      method: 'OPTIONS',
      headers: { origin: 'https://evil.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('lowercase verb names are normalized', () => {
    const { req, res, next } = makeReqRes({ method: 'get' });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('originCheck — PUBLIC_PATH_PREFIXES unconditionally pass', () => {
  // Webhooks, OAuth callbacks, public booking, External Partner API, etc.
  // These authenticate via signature/HMAC/API-key/OTP instead of an origin
  // check.
  test('POST /api/auth/login passes from evil.com', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: 'https://evil.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('POST /api/marketplace-leads/webhook passes (third-party webhook)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/marketplace-leads/webhook',
      headers: { origin: 'https://indiamart.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('POST /api/sms/webhook passes (Twilio)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/sms/webhook',
      headers: { origin: 'https://api.twilio.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('POST /api/payments/webhook passes (Razorpay/Stripe)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/payments/webhook',
      headers: { origin: 'https://api.razorpay.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('POST /p/itinerary/:token/payment-success passes (Razorpay redirect callback)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/p/itinerary/abc123/payment-success',
      headers: { origin: 'https://api.razorpay.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('POST /api/v1/external/leads passes (External Partner API)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/v1/external/leads',
      headers: { origin: 'https://callified.ai' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('POST /api/wellness/public/book passes (no-auth public booking)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/wellness/public/book',
      headers: { origin: 'https://embed.example.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('POST /api/portal/login passes (patient portal)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/portal/login',
      headers: { origin: 'https://patient-portal.example.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('non-public path is NOT covered by the prefix matcher', () => {
    // Sanity: ensure the prefix check is path-prefix-based, not just
    // "contains the string".
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/contacts/login-history', // contains "login" but isn't a public path
      headers: { origin: 'https://evil.com' },
    });
    originCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('originCheck — non-browser callers (no Origin, no Referer)', () => {
  test('POST with neither header → passes (curl / server-to-server)', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/contacts',
      headers: {},
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('PUT with neither header passes', () => {
    const { req, res, next } = makeReqRes({
      method: 'PUT',
      path: '/api/deals/1',
      headers: {},
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('DELETE with neither header passes', () => {
    const { req, res, next } = makeReqRes({
      method: 'DELETE',
      path: '/api/deals/1',
      headers: {},
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('PATCH with neither header passes', () => {
    const { req, res, next } = makeReqRes({
      method: 'PATCH',
      path: '/api/deals/1',
      headers: {},
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('originCheck — browser callers with allowed Origin', () => {
  test('Origin in allowlist → passes', () => {
    const { req, res, next } = makeReqRes({
      method: 'POST',
      path: '/api/contacts',
      headers: { origin: 'https://crm.globusdemos.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('localhost:5173 (Vite dev) passes', () => {
    const { req, res, next } = makeReqRes({
      headers: { origin: 'http://localhost:5173' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('127.0.0.1:5000 passes', () => {
    const { req, res, next } = makeReqRes({
      headers: { origin: 'http://127.0.0.1:5000' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('Origin is case-insensitive for match', () => {
    const { req, res, next } = makeReqRes({
      headers: { origin: 'HTTPS://CRM.GLOBUSDEMOS.COM' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('originCheck — Referer fallback when Origin absent', () => {
  test('matching Referer alone passes', () => {
    const { req, res, next } = makeReqRes({
      headers: { referer: 'https://crm.globusdemos.com/contacts' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('mis-spelled "referrer" header is also honored', () => {
    const { req, res, next } = makeReqRes({
      headers: { referrer: 'https://crm.globusdemos.com/contacts' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('disallowed Referer alone → 403 ORIGIN_NOT_ALLOWED', () => {
    const { req, res, next } = makeReqRes({
      headers: { referer: 'https://evil.com/redirect' },
    });
    originCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Request origin not in allowlist',
      code: 'ORIGIN_NOT_ALLOWED',
    });
  });

  test('Origin takes precedence over Referer when both present', () => {
    // Allowed Origin + disallowed Referer → passes (Origin wins).
    const { req, res, next } = makeReqRes({
      headers: {
        origin: 'https://crm.globusdemos.com',
        referer: 'https://evil.com/whatever',
      },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('disallowed Origin + allowed Referer → 403 (Origin wins)', () => {
    // The Referer fallback only fires when Origin is missing — not when
    // Origin is present but mismatching.
    const { req, res, next } = makeReqRes({
      headers: {
        origin: 'https://evil.com',
        referer: 'https://crm.globusdemos.com/page',
      },
    });
    originCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('originCheck — disallowed origins return 403', () => {
  test('mismatching Origin → 403 ORIGIN_NOT_ALLOWED', () => {
    const { req, res, next } = makeReqRes({
      headers: { origin: 'https://evil.com' },
    });
    originCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Request origin not in allowlist',
      code: 'ORIGIN_NOT_ALLOWED',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('unparseable Referer (no scheme+host) → 403 INVALID_ORIGIN', () => {
    const { req, res, next } = makeReqRes({
      headers: { referer: 'not-a-url-at-all' },
    });
    originCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Request origin could not be verified',
      code: 'INVALID_ORIGIN',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('rogue subdomain not in allowlist → 403', () => {
    const { req, res, next } = makeReqRes({
      headers: { origin: 'https://attacker.globusdemos.com' },
    });
    originCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('http scheme on a host that allowlists https only → 403', () => {
    const { req, res, next } = makeReqRes({
      headers: { origin: 'http://crm.globusdemos.com' },
    });
    originCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('buildAllowlist', () => {
  test('includes the 6 hardcoded defaults', () => {
    const list = buildAllowlist();
    expect(list).toContain('https://crm.globusdemos.com');
    expect(list).toContain('http://localhost:5173');
    expect(list).toContain('http://localhost:5000');
    expect(list).toContain('http://127.0.0.1:5173');
    expect(list).toContain('http://127.0.0.1:5000');
    expect(list).toContain('https://globuscrm.globussoft.com');
  });

  test('extends with FRONTEND_URL env var', () => {
    process.env.FRONTEND_URL = 'https://staging.example.com';
    const list = buildAllowlist();
    expect(list).toContain('https://staging.example.com');
  });

  test('extends with CORS_ALLOWED_ORIGINS (comma-separated)', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://a.example.com,https://b.example.com';
    const list = buildAllowlist();
    expect(list).toContain('https://a.example.com');
    expect(list).toContain('https://b.example.com');
  });

  test('trims whitespace in CORS_ALLOWED_ORIGINS entries', () => {
    process.env.CORS_ALLOWED_ORIGINS = '  https://a.example.com  ,  https://b.example.com  ';
    const list = buildAllowlist();
    expect(list).toContain('https://a.example.com');
    expect(list).toContain('https://b.example.com');
  });

  test('drops empty entries in CORS_ALLOWED_ORIGINS', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://a.example.com,,  ,https://b.example.com';
    const list = buildAllowlist();
    expect(list).toContain('https://a.example.com');
    expect(list).toContain('https://b.example.com');
    expect(list).not.toContain('');
  });

  test('dedupes overlap between defaults and env vars', () => {
    process.env.FRONTEND_URL = 'https://crm.globusdemos.com'; // already a default
    const list = buildAllowlist();
    const matches = list.filter((s) => s === 'https://crm.globusdemos.com');
    expect(matches).toHaveLength(1);
  });
});

describe('originOf', () => {
  test('extracts scheme+host from a full URL', () => {
    expect(originOf('https://example.com/path?q=1')).toBe('https://example.com');
  });

  test('lowercases the result', () => {
    expect(originOf('HTTPS://EXAMPLE.COM/x')).toBe('https://example.com');
  });

  test('preserves the port', () => {
    expect(originOf('http://localhost:5173/path')).toBe('http://localhost:5173');
  });

  test('returns null for null', () => {
    expect(originOf(null)).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(originOf(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(originOf('')).toBeNull();
  });

  test('returns null for non-string input', () => {
    expect(originOf(42)).toBeNull();
    expect(originOf({})).toBeNull();
    expect(originOf([])).toBeNull();
  });

  test('returns null for a malformed URL with no scheme', () => {
    expect(originOf('example.com/path')).toBeNull();
  });
});

describe('setSecureCookie', () => {
  test('sets HttpOnly + SameSite=Lax + path=/ by default', () => {
    const { res } = makeReqRes();
    delete process.env.NODE_ENV; // ensure non-production
    setSecureCookie(res, 'session', 'tok123');
    expect(res.cookie).toHaveBeenCalledWith('session', 'tok123', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
  });

  test('sets secure=true when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    const { res } = makeReqRes();
    setSecureCookie(res, 'session', 'tok123');
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.secure).toBe(true);
  });

  test('caller-supplied options override defaults', () => {
    const { res } = makeReqRes();
    setSecureCookie(res, 's', 'v', { sameSite: 'none', maxAge: 3600 });
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.sameSite).toBe('none');
    expect(opts.maxAge).toBe(3600);
    // Untouched defaults remain.
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe('/');
  });

  test('returns the res.cookie() return value (chainable)', () => {
    const { res } = makeReqRes();
    const out = setSecureCookie(res, 's', 'v');
    expect(out).toBe(res);
  });
});

describe('env-driven allowlist propagates into originCheck', () => {
  test('FRONTEND_URL is honoured by originCheck for a real request', () => {
    process.env.FRONTEND_URL = 'https://staging.example.com';
    const { req, res, next } = makeReqRes({
      headers: { origin: 'https://staging.example.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('CORS_ALLOWED_ORIGINS entries are honoured by originCheck', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://partner.example.com';
    const { req, res, next } = makeReqRes({
      headers: { origin: 'https://partner.example.com' },
    });
    originCheck(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
