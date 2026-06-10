// Unit tests for backend/middleware/security.js
// Covers helmetMiddleware (smoke + sets a sample header), permissionsPolicyMiddleware
// (sets the right policy string), sanitizeBody (strips dangerous tags / urls /
// event handlers, preserves benign characters, recurses into nested objects),
// and stripTenantOverride (deletes tenantId/userId from req.body).
import { describe, test, expect, vi } from 'vitest';
import {
  attachNonce,
  helmetMiddleware,
  helmetStrictReportOnlyMiddleware,
  permissionsPolicyMiddleware,
  sanitizeBody,
  stripTenantOverride,
} from '../../middleware/security.js';

function makeReqRes({ body, path = '/api/contacts', locals } = {}) {
  // stripTenantOverride introspects req.path to skip stripping for the
  // public /customer/register endpoint. Default to a non-public path so
  // the strip-tenant assertions exercise the normal (stripping) branch.
  const req = { body, path };
  const headers = {};
  let statusCode = 200;
  const res = {
    headers,
    // #917 slice S1 — Express always populates res.locals; mirror that here
    // so helmet's CSP function-directives can read res.locals.cspNonce when
    // building the Report-Only header. Callers can override via `locals`.
    locals: locals || {},
    setHeader: vi.fn(function (name, value) {
      headers[name] = value;
    }),
    getHeader: vi.fn(function (name) {
      return headers[name];
    }),
    removeHeader: vi.fn(function (name) {
      delete headers[name];
    }),
    set: vi.fn(function (name, value) {
      headers[name] = value;
      return this;
    }),
    status: vi.fn(function (c) {
      statusCode = c;
      return this;
    }),
    end: vi.fn(),
    json: vi.fn(),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('module shape', () => {
  test('exports the six middleware functions', () => {
    expect(typeof attachNonce).toBe('function');
    expect(typeof helmetMiddleware).toBe('function');
    expect(typeof helmetStrictReportOnlyMiddleware).toBe('function');
    expect(typeof permissionsPolicyMiddleware).toBe('function');
    expect(typeof sanitizeBody).toBe('function');
    expect(typeof stripTenantOverride).toBe('function');
  });
});

describe('helmetMiddleware', () => {
  test('is invokable and calls next', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('sets HSTS header with 1-year maxAge', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    const hsts = res.headers['Strict-Transport-Security'];
    expect(hsts).toBeDefined();
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
  });

  // #921 slice S4 (FR-3.6) — X-Frame-Options flipped from SAMEORIGIN to
  // DENY as the global default. Per-route override for the embed widget
  // is provided by allowIframeEmbedding() (see dedicated test below).
  test('sets X-Frame-Options to DENY (FR-3.6 default)', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    expect(res.headers['X-Frame-Options']).toBe('DENY');
  });

  test('sets Referrer-Policy to strict-origin-when-cross-origin', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    expect(res.headers['Referrer-Policy']).toBe(
      'strict-origin-when-cross-origin'
    );
  });

  test('sets Cross-Origin-Resource-Policy to cross-origin (embed widget)', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });

  // #654 — Content-Security-Policy is now ENABLED as a transitional
  // configuration (still allows 'unsafe-inline' on script-src and style-src
  // because of Vite/React inline-style emission + legacy inline event
  // handlers). The directive list includes object-src 'none',
  // frame-ancestors 'self', form-action 'self', base-uri 'self' — strict
  // wins. Tightening to nonces is tracked as a follow-up.
  test("sets a transitional Content-Security-Policy with object-src none + frame-ancestors 'none' (#921 FR-3.6)", () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp.toLowerCase()).toContain("default-src 'self'");
    expect(csp.toLowerCase()).toContain("object-src 'none'");
    // #921 slice S4 — frame-ancestors flipped from 'self' to 'none' for
    // global clickjacking lockdown. Embed widget gets per-route override
    // via allowIframeEmbedding().
    expect(csp.toLowerCase()).toContain("frame-ancestors 'none'");
    expect(csp.toLowerCase()).toContain("form-action 'self'");
    expect(csp.toLowerCase()).toContain("base-uri 'self'");
  });
});

// #917 slice 1 — strict CSP in Report-Only mode is ADDITIVE on top of the
// transitional enforce-mode CSP above. It emits the
// `Content-Security-Policy-Report-Only` header WITHOUT 'unsafe-inline' so
// the SPA's existing inline scripts/styles surface as violations without
// breaking page rendering. Promotion to enforce-mode is a future slice.
describe('helmetStrictReportOnlyMiddleware (#917 slice 1)', () => {
  test('is invokable and calls next', () => {
    const { req, res, next } = makeReqRes();
    helmetStrictReportOnlyMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('sets the Content-Security-Policy-Report-Only header (not enforce mode)', () => {
    const { req, res, next } = makeReqRes();
    helmetStrictReportOnlyMiddleware(req, res, next);
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'];
    expect(reportOnly).toBeTruthy();
    expect(typeof reportOnly).toBe('string');
  });

  test('strict policy: NO unsafe-inline on script-src or style-src', () => {
    const { req, res, next } = makeReqRes();
    helmetStrictReportOnlyMiddleware(req, res, next);
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'];
    // Extract the script-src + style-src segments specifically.
    const scriptMatch = reportOnly.match(/script-src([^;]*)/i);
    const styleMatch = reportOnly.match(/style-src([^;]*)/i);
    expect(scriptMatch).toBeTruthy();
    expect(styleMatch).toBeTruthy();
    expect(scriptMatch[1]).not.toContain("'unsafe-inline'");
    expect(scriptMatch[1]).not.toContain("'unsafe-eval'");
    expect(styleMatch[1]).not.toContain("'unsafe-inline'");
  });

  test('contains the strict directive set: default-src, object-src none, base-uri self', () => {
    const { req, res, next } = makeReqRes();
    helmetStrictReportOnlyMiddleware(req, res, next);
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'].toLowerCase();
    expect(reportOnly).toContain("default-src 'self'");
    expect(reportOnly).toContain("object-src 'none'");
    expect(reportOnly).toContain("base-uri 'self'");
    expect(reportOnly).toContain("form-action 'self'");
  });

  test("frame-ancestors is 'none' (stricter than transitional 'self' — clickjacking lockdown)", () => {
    const { req, res, next } = makeReqRes();
    helmetStrictReportOnlyMiddleware(req, res, next);
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'].toLowerCase();
    expect(reportOnly).toContain("frame-ancestors 'none'");
  });

  test('does NOT set the enforce-mode CSP header (only Report-Only)', () => {
    // This middleware is layered ON TOP of helmetMiddleware. Its only
    // contribution must be the Report-Only header — it must not clobber or
    // duplicate the enforce-mode CSP that helmetMiddleware emits.
    const { req, res, next } = makeReqRes();
    helmetStrictReportOnlyMiddleware(req, res, next);
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
  });

  test('does NOT clobber other security headers (HSTS, X-Frame-Options, etc.)', () => {
    // The strict middleware disables every helmet-shipped header except CSP.
    // Layering it after helmetMiddleware must leave existing headers intact;
    // this verifies the middleware alone does not contribute them.
    const { req, res, next } = makeReqRes();
    helmetStrictReportOnlyMiddleware(req, res, next);
    expect(res.headers['Strict-Transport-Security']).toBeUndefined();
    expect(res.headers['X-Frame-Options']).toBeUndefined();
    expect(res.headers['Referrer-Policy']).toBeUndefined();
    expect(res.headers['Cross-Origin-Resource-Policy']).toBeUndefined();
  });
});

// #917 slice S1 (FR-3.2) — attachNonce middleware re-exported from security
// module mints res.locals.cspNonce per request; the strict Report-Only CSP
// then advertises `'nonce-<base64>'` on script-src + style-src via helmet
// function-directives. Together these unblock the eventual flip from
// Report-Only → enforce mode without re-introducing 'unsafe-inline'.
describe('attachNonce (#917 slice S1 FR-3.2)', () => {
  test('is a 3-arg middleware that calls next and populates res.locals.cspNonce', () => {
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(typeof res.locals.cspNonce).toBe('string');
    expect(res.locals.cspNonce).toHaveLength(24);
  });

  test('generates a distinct nonce per request (no memoization across calls)', () => {
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      const { req, res, next } = makeReqRes();
      attachNonce(req, res, next);
      seen.add(res.locals.cspNonce);
    }
    expect(seen.size).toBe(10);
  });
});

describe('helmetStrictReportOnlyMiddleware nonce wiring (#917 slice S1)', () => {
  test('script-src advertises `nonce-<base64>` when res.locals.cspNonce is set', () => {
    // Mirror the server.js order of operations: attachNonce then strict CSP.
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    const nonce = res.locals.cspNonce;
    const next2 = vi.fn();
    helmetStrictReportOnlyMiddleware(req, res, next2);
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'];
    expect(reportOnly).toContain(`'nonce-${nonce}'`);
    // Specifically inside script-src:
    const scriptMatch = reportOnly.match(/script-src([^;]*)/i);
    expect(scriptMatch[1]).toContain(`'nonce-${nonce}'`);
  });

  test('style-src advertises the same nonce as script-src', () => {
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    const nonce = res.locals.cspNonce;
    const next2 = vi.fn();
    helmetStrictReportOnlyMiddleware(req, res, next2);
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'];
    const styleMatch = reportOnly.match(/style-src([^;]*)/i);
    expect(styleMatch[1]).toContain(`'nonce-${nonce}'`);
  });

  test('two distinct requests produce two distinct advertised nonces', () => {
    const reqA = makeReqRes();
    attachNonce(reqA.req, reqA.res, reqA.next);
    helmetStrictReportOnlyMiddleware(reqA.req, reqA.res, vi.fn());
    const reqB = makeReqRes();
    attachNonce(reqB.req, reqB.res, reqB.next);
    helmetStrictReportOnlyMiddleware(reqB.req, reqB.res, vi.fn());
    const headerA = reqA.res.headers['Content-Security-Policy-Report-Only'];
    const headerB = reqB.res.headers['Content-Security-Policy-Report-Only'];
    const nonceA = headerA.match(/'nonce-([^']+)'/)[1];
    const nonceB = headerB.match(/'nonce-([^']+)'/)[1];
    expect(nonceA).not.toBe(nonceB);
  });

  test("'unsafe-inline' is STILL absent from script-src and style-src after nonce wiring", () => {
    // Nonce wiring must not accidentally re-introduce 'unsafe-inline'.
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    helmetStrictReportOnlyMiddleware(req, res, vi.fn());
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'];
    const scriptMatch = reportOnly.match(/script-src([^;]*)/i);
    const styleMatch = reportOnly.match(/style-src([^;]*)/i);
    expect(scriptMatch[1]).not.toContain("'unsafe-inline'");
    expect(styleMatch[1]).not.toContain("'unsafe-inline'");
  });
});

describe('permissionsPolicyMiddleware', () => {
  test('sets the canonical Permissions-Policy and calls next', () => {
    const { req, res, next } = makeReqRes();
    permissionsPolicyMiddleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(self), interest-cohort=()'
    );
    expect(next).toHaveBeenCalledOnce();
  });

  test('disables camera, microphone, FLoC; allows geolocation only on self', () => {
    const { req, res, next } = makeReqRes();
    permissionsPolicyMiddleware(req, res, next);
    const policy = res.headers['Permissions-Policy'];
    expect(policy).toContain('camera=()');
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('geolocation=(self)');
    expect(policy).toContain('interest-cohort=()');
  });
});

describe('sanitizeBody', () => {
  test('calls next with no body', () => {
    const { req, res, next } = makeReqRes({ body: undefined });
    sanitizeBody(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('strips <script> tags from string fields', () => {
    const { req, res, next } = makeReqRes({
      body: { title: 'Hello <script>alert(1)</script> world' },
    });
    sanitizeBody(req, res, next);
    expect(req.body.title).not.toContain('<script>');
    expect(req.body.title).not.toContain('</script>');
    expect(req.body.title).toContain('Hello');
    expect(req.body.title).toContain('world');
  });

  test('strips <iframe> / <object> / <embed>', () => {
    const { req, res, next } = makeReqRes({
      body: {
        a: '<iframe src=x></iframe>',
        b: '<object data=y></object>',
        c: '<embed src=z>',
      },
    });
    sanitizeBody(req, res, next);
    expect(req.body.a).not.toMatch(/<iframe/i);
    expect(req.body.b).not.toMatch(/<object/i);
    expect(req.body.c).not.toMatch(/<embed/i);
  });

  test('strips <img>/<video>/<audio>/<source>/<applet>/<base>/<input>/<textarea>', () => {
    const { req, res, next } = makeReqRes({
      body: {
        a: '<img src=x onerror=alert(1)>',
        b: '<video src=v>',
        c: '<audio src=a>',
        d: '<source src=s>',
        e: '<applet code=A>',
        f: '<base href=//evil>',
        g: '<input value=x>',
        h: '<textarea>x</textarea>',
      },
    });
    sanitizeBody(req, res, next);
    expect(req.body.a).not.toMatch(/<img/i);
    expect(req.body.b).not.toMatch(/<video/i);
    expect(req.body.c).not.toMatch(/<audio/i);
    expect(req.body.d).not.toMatch(/<source/i);
    expect(req.body.e).not.toMatch(/<applet/i);
    expect(req.body.f).not.toMatch(/<base/i);
    expect(req.body.g).not.toMatch(/<input/i);
    expect(req.body.h).not.toMatch(/<textarea/i);
  });

  test('strips javascript: URLs in href/src', () => {
    const { req, res, next } = makeReqRes({
      body: {
        a: '<a href="javascript:alert(1)">click</a>',
        b: 'src="javascript:bad"',
      },
    });
    sanitizeBody(req, res, next);
    expect(req.body.a).not.toContain('javascript:');
    expect(req.body.b).not.toContain('javascript:');
  });

  test('strips inline event handlers (onclick, onerror, onload)', () => {
    const { req, res, next } = makeReqRes({
      body: {
        a: '<div onclick="bad()">',
        b: '<span onerror="x">',
        c: '<p onload="y">',
      },
    });
    sanitizeBody(req, res, next);
    expect(req.body.a).not.toMatch(/onclick/i);
    expect(req.body.b).not.toMatch(/onerror/i);
    expect(req.body.c).not.toMatch(/onload/i);
  });

  test('preserves ampersands and benign angle brackets ("<budget>")', () => {
    const { req, res, next } = makeReqRes({
      body: { title: 'Q3 Plan: <budget> & forecast' },
    });
    sanitizeBody(req, res, next);
    // Ampersand must be preserved verbatim — that was the #187 regression.
    expect(req.body.title).toContain('&');
    expect(req.body.title).not.toContain('&amp;');
  });

  test('recurses into nested objects', () => {
    const { req, res, next } = makeReqRes({
      body: {
        outer: 'safe',
        nested: { evil: '<script>x</script>', ok: 'fine' },
      },
    });
    sanitizeBody(req, res, next);
    expect(req.body.nested.evil).not.toContain('<script>');
    expect(req.body.nested.ok).toBe('fine');
  });

  test('does not recurse into arrays (current behavior)', () => {
    // The current sanitizeObject() only recurses into non-array objects;
    // string entries inside arrays are not visited. Document that here.
    const { req, res, next } = makeReqRes({
      body: { tags: ['<script>x</script>', 'safe'] },
    });
    sanitizeBody(req, res, next);
    expect(Array.isArray(req.body.tags)).toBe(true);
    // Array entries are left untouched.
    expect(req.body.tags[0]).toBe('<script>x</script>');
  });

  test('leaves non-string scalar fields untouched', () => {
    const { req, res, next } = makeReqRes({
      body: { count: 42, active: true, tagId: null },
    });
    sanitizeBody(req, res, next);
    expect(req.body.count).toBe(42);
    expect(req.body.active).toBe(true);
    expect(req.body.tagId).toBeNull();
  });

  test('always calls next', () => {
    const { req, res, next } = makeReqRes({ body: { a: 'x' } });
    sanitizeBody(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('stripTenantOverride', () => {
  test('deletes tenantId from req.body', () => {
    const { req, res, next } = makeReqRes({
      body: { name: 'Acme', tenantId: 99 },
    });
    stripTenantOverride(req, res, next);
    expect(req.body).not.toHaveProperty('tenantId');
    expect(req.body.name).toBe('Acme');
    expect(next).toHaveBeenCalledOnce();
  });

  test('deletes userId from req.body', () => {
    const { req, res, next } = makeReqRes({
      body: { name: 'Acme', userId: 5 },
    });
    stripTenantOverride(req, res, next);
    expect(req.body).not.toHaveProperty('userId');
    expect(next).toHaveBeenCalledOnce();
  });

  test('no-ops on missing body', () => {
    const { req, res, next } = makeReqRes({ body: undefined });
    stripTenantOverride(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('preserves all other keys', () => {
    const { req, res, next } = makeReqRes({
      body: {
        name: 'Acme',
        tenantId: 99,
        userId: 5,
        role: 'USER',
        contactId: 7,
      },
    });
    stripTenantOverride(req, res, next);
    expect(req.body).toEqual({ name: 'Acme', role: 'USER', contactId: 7 });
  });
});
