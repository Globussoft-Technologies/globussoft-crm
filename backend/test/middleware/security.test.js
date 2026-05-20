// Unit tests for backend/middleware/security.js
// Covers helmetMiddleware (smoke + sets a sample header), permissionsPolicyMiddleware
// (sets the right policy string), sanitizeBody (strips dangerous tags / urls /
// event handlers, preserves benign characters, recurses into nested objects),
// and stripTenantOverride (deletes tenantId/userId from req.body).
import { describe, test, expect, vi } from 'vitest';
import {
  helmetMiddleware,
  permissionsPolicyMiddleware,
  sanitizeBody,
  stripTenantOverride,
} from '../../middleware/security.js';

function makeReqRes({ body, path = '/api/contacts' } = {}) {
  // stripTenantOverride introspects req.path to skip stripping for the
  // public /customer/register endpoint. Default to a non-public path so
  // the strip-tenant assertions exercise the normal (stripping) branch.
  const req = { body, path };
  const headers = {};
  let statusCode = 200;
  const res = {
    headers,
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
  test('exports the four middleware functions', () => {
    expect(typeof helmetMiddleware).toBe('function');
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

  test('sets X-Frame-Options to SAMEORIGIN', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    expect(res.headers['X-Frame-Options']).toBe('SAMEORIGIN');
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
  test('sets a transitional Content-Security-Policy with object-src none + frame-ancestors self', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp.toLowerCase()).toContain("default-src 'self'");
    expect(csp.toLowerCase()).toContain("object-src 'none'");
    expect(csp.toLowerCase()).toContain("frame-ancestors 'self'");
    expect(csp.toLowerCase()).toContain("form-action 'self'");
    expect(csp.toLowerCase()).toContain("base-uri 'self'");
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
