// Unit tests for backend/middleware/cspNonceStaticMiddleware.js — #917 slice S35.
//
// Module under test: cspNonceStaticMiddleware(req, res, next).
//
// What this pins
// --------------
// Behavioural contract (see middleware's module docstring for the full picture):
//   1. POST request → calls next() (only GETs are SPA-shell candidates).
//   2. /api/foo → calls next() (API routes own those paths).
//   3. /favicon.svg (path has a dot) → calls next() (express.static owns it).
//   4. /dashboard (SPA route) → reads file + substitutes + sends 200 HTML.
//   5. res.locals.cspNonce undefined → substitutes with empty string (page
//      still renders; CSP header rejects inline scripts but the response
//      itself is not 500ed).
//   6. res.locals.cspNonce set → exact value spliced into output.
//   7. Multiple `__CSP_NONCE__` occurrences → ALL replaced (global regex).
//   8. Template cached on first call — second call does NOT re-read disk.
//   9. clearCache() forces a re-read on the next call (test seam).
//  10. File-read failure → calls next() (does NOT throw / does NOT 500).
//  11. Content-Type header set to text/html; charset=utf-8.
//  12. Path with a query string still routes correctly (req.path strips qs).
//
// Mocks
// -----
// fs.readFileSync + fs.existsSync are stubbed via vi.spyOn so we can control
// the template content per test. The middleware caches the template at module
// scope, so each test calls `clearCache()` in beforeEach to start clean.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const fs = requireCJS('fs');
const cspNonceStaticMiddleware = requireCJS('../../middleware/cspNonceStaticMiddleware');
const { clearCache } = cspNonceStaticMiddleware;

// Minimal req/res factories. We deliberately keep these as plain objects —
// the middleware only reads req.method / req.path and writes via res.set /
// res.send / res.locals, so a fuller Express-shaped harness is overkill.
function makeReq({ method = 'GET', path = '/', body } = {}) {
  return { method, path, body };
}

function makeRes({ locals } = {}) {
  const headers = {};
  let sentBody = null;
  let statusCode = 200;
  const res = {
    locals: locals || {},
    headers,
    statusCode,
    set: vi.fn(function (name, value) {
      headers[name] = value;
      return this;
    }),
    status: vi.fn(function (code) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function (body) {
      sentBody = body;
      return this;
    }),
    getSentBody: () => sentBody,
  };
  return res;
}

const TEMPLATE = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '<meta name="csp-nonce" content="__CSP_NONCE__" />',
  '</head>',
  '<body>',
  '<script nonce="__CSP_NONCE__">init();</script>',
  '<div id="root"></div>',
  '</body>',
  '</html>',
].join('\n');

beforeEach(() => {
  clearCache();
  // Default the disk-read mocks to the canonical template so individual
  // tests can override only when they need a different shape.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'readFileSync').mockReturnValue(TEMPLATE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cspNonceStaticMiddleware — fall-through cases', () => {
  test('POST request → calls next() (does not handle, does not send)', () => {
    const req = makeReq({ method: 'POST', path: '/dashboard' });
    const res = makeRes();
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
  });

  test('GET /api/foo → calls next() (API routes own /api/*)', () => {
    const req = makeReq({ path: '/api/foo' });
    const res = makeRes();
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
  });

  test('GET /api/v1/external/leads → calls next() (subpaths of /api/* too)', () => {
    const req = makeReq({ path: '/api/v1/external/leads' });
    const res = makeRes();
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('GET /favicon.svg → calls next() (path with a dot → static asset)', () => {
    const req = makeReq({ path: '/favicon.svg' });
    const res = makeRes();
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
  });

  test('GET /assets/index-abc123.js → calls next() (vite-built JS bundle)', () => {
    const req = makeReq({ path: '/assets/index-abc123.js' });
    const res = makeRes();
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('GET /p/e2e-lp-123 → calls next() (server-rendered landing page)', () => {
    const req = makeReq({ path: '/p/e2e-lp-123' });
    const res = makeRes();
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
  });

  test('GET /embed/lead-form → calls next() (dedicated embed route)', () => {
    const req = makeReq({ path: '/embed/lead-form' });
    const res = makeRes();
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
  });
});

describe('cspNonceStaticMiddleware — SPA-route handling', () => {
  test('GET /dashboard → reads file, substitutes, sends HTML with Content-Type', () => {
    const req = makeReq({ path: '/dashboard' });
    const res = makeRes({ locals: { cspNonce: 'abc123==' } });
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
    expect(res.send).toHaveBeenCalledTimes(1);
    const body = res.getSentBody();
    expect(body).toContain('content="abc123=="');
    expect(body).toContain('nonce="abc123=="');
    expect(body).not.toContain('__CSP_NONCE__');
  });

  test('res.locals.cspNonce undefined → substitutes with empty string (still renders)', () => {
    const req = makeReq({ path: '/dashboard' });
    const res = makeRes({ locals: {} });
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledTimes(1);
    const body = res.getSentBody();
    // Substitution still happened; the value is just empty.
    expect(body).not.toContain('__CSP_NONCE__');
    expect(body).toContain('content=""');
    expect(body).toContain('nonce=""');
  });

  test('res.locals missing entirely → substitutes with empty string (defensive)', () => {
    const req = makeReq({ path: '/leads' });
    const res = makeRes();
    res.locals = undefined;
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.getSentBody()).not.toContain('__CSP_NONCE__');
  });

  test('multiple __CSP_NONCE__ occurrences ALL replaced (global regex)', () => {
    const req = makeReq({ path: '/' });
    const res = makeRes({ locals: { cspNonce: 'XYZ' } });
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    const body = res.getSentBody();
    // The fixture template has TWO __CSP_NONCE__ placeholders (meta + script).
    // Both must be replaced — if the regex were missing the /g flag only the
    // first would flip.
    const matchesXYZ = (body.match(/XYZ/g) || []).length;
    expect(matchesXYZ).toBe(2);
    expect(body).not.toContain('__CSP_NONCE__');
  });

  test('GET / (root path, SPA index) → handled', () => {
    const req = makeReq({ path: '/' });
    const res = makeRes({ locals: { cspNonce: 'nonceA' } });
    const next = vi.fn();
    cspNonceStaticMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledTimes(1);
  });
});

describe('cspNonceStaticMiddleware — template caching', () => {
  test('template read from disk on first call; second call does NOT re-read', () => {
    const req1 = makeReq({ path: '/dashboard' });
    const res1 = makeRes({ locals: { cspNonce: 'n1' } });
    cspNonceStaticMiddleware(req1, res1, vi.fn());

    const readCountAfterFirst = fs.readFileSync.mock.calls.length;
    expect(readCountAfterFirst).toBe(1);

    const req2 = makeReq({ path: '/leads' });
    const res2 = makeRes({ locals: { cspNonce: 'n2' } });
    cspNonceStaticMiddleware(req2, res2, vi.fn());

    // Second call hit the cache — no additional disk read.
    expect(fs.readFileSync.mock.calls.length).toBe(readCountAfterFirst);
    // But the NEW nonce was spliced in for the second response.
    expect(res2.getSentBody()).toContain('content="n2"');
    expect(res2.getSentBody()).not.toContain('content="n1"');
  });

  test('clearCache() forces a re-read on the next call', () => {
    const req1 = makeReq({ path: '/dashboard' });
    const res1 = makeRes({ locals: { cspNonce: 'n1' } });
    cspNonceStaticMiddleware(req1, res1, vi.fn());
    expect(fs.readFileSync.mock.calls.length).toBe(1);

    clearCache();

    // Swap the template content to verify the re-read picks up the new
    // disk state (a real deploy would have an updated dist/index.html on
    // the next pm2 worker boot).
    fs.readFileSync.mockReturnValueOnce('<html>NEW __CSP_NONCE__</html>');

    const req2 = makeReq({ path: '/leads' });
    const res2 = makeRes({ locals: { cspNonce: 'n2' } });
    cspNonceStaticMiddleware(req2, res2, vi.fn());

    expect(fs.readFileSync.mock.calls.length).toBe(2);
    expect(res2.getSentBody()).toContain('NEW n2');
  });

  test('prefers frontend/dist/index.html when it exists (production path)', () => {
    // Default existsSync mock returns true → first-checked path (distPath)
    // wins. Verify the readFileSync was called with a path containing
    // 'frontend/dist'.
    const req = makeReq({ path: '/dashboard' });
    const res = makeRes({ locals: { cspNonce: 'x' } });
    cspNonceStaticMiddleware(req, res, vi.fn());
    const readPath = fs.readFileSync.mock.calls[0][0];
    // Normalize path separators for cross-platform check (Windows uses \).
    const normalized = readPath.replace(/\\/g, '/');
    expect(normalized).toMatch(/frontend\/dist\/index\.html$/);
  });

  test('falls back to frontend/index.html when dist/ is missing (dev path)', () => {
    // First existsSync call (for distPath) returns false → dev fallback.
    fs.existsSync.mockReturnValue(false);
    const req = makeReq({ path: '/dashboard' });
    const res = makeRes({ locals: { cspNonce: 'x' } });
    cspNonceStaticMiddleware(req, res, vi.fn());
    const readPath = fs.readFileSync.mock.calls[0][0];
    const normalized = readPath.replace(/\\/g, '/');
    // Must match frontend/index.html (not frontend/dist/index.html).
    expect(normalized).toMatch(/frontend\/index\.html$/);
    expect(normalized).not.toMatch(/frontend\/dist\//);
  });
});

describe('cspNonceStaticMiddleware — error handling', () => {
  test('file-read failure → calls next() (does NOT 500)', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT: missing dist/index.html');
    });
    const req = makeReq({ path: '/dashboard' });
    const res = makeRes({ locals: { cspNonce: 'x' } });
    const next = vi.fn();
    // Suppress the console.error so test output stays clean.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cspNonceStaticMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  test('file-read failure does NOT poison the cache (next call retries)', () => {
    fs.readFileSync.mockImplementationOnce(() => {
      throw new Error('transient ENOENT');
    });
    // Second call returns a real template.
    fs.readFileSync.mockReturnValueOnce(TEMPLATE);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req1 = makeReq({ path: '/dashboard' });
    const res1 = makeRes({ locals: { cspNonce: 'n1' } });
    const next1 = vi.fn();
    cspNonceStaticMiddleware(req1, res1, next1);
    expect(next1).toHaveBeenCalled();

    const req2 = makeReq({ path: '/leads' });
    const res2 = makeRes({ locals: { cspNonce: 'n2' } });
    const next2 = vi.fn();
    cspNonceStaticMiddleware(req2, res2, next2);
    // Second call succeeded — the failed first call did NOT cache a bad
    // template that would block all future requests.
    expect(next2).not.toHaveBeenCalled();
    expect(res2.send).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });
});
