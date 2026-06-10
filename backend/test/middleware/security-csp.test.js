// Unit tests for #921 slice S4 (FR-3.6) — iframe-isolation defaults +
// per-route override + per-tenant allowlist reader.
//
// The global Helmet config in backend/middleware/security.js was flipped
// in this slice from `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`
// to `X-Frame-Options: DENY` + `frame-ancestors 'none'` to close the
// clickjacking-via-subdomain-takeover window. The embed widget at
// `/embed/lead-form.html` is the one legitimate iframe case; for it,
// route handlers mount `allowIframeEmbedding({ allowList: ['*'] })` (or
// a per-tenant origin list) AFTER the global helmet middleware to splice
// frame-ancestors and strip the legacy X-Frame-Options header.
//
// Per-tenant allowlist via `Tenant.embedAllowlistJson` is a follow-up
// (column doesn't exist yet — see slice S4 commit body). The reader
// `readTenantEmbedAllowlist()` ships now returning null, so the wiring
// point is in place; once the schema slice lands, the body of the reader
// flips to a Prisma findUnique.
//
// What's pinned here:
//   1. Defaults: DENY + 'none' on the global response.
//   2. allowIframeEmbedding({ allowList: ['*'] }) strips XFO + spliced
//      frame-ancestors *.
//   3. allowIframeEmbedding({ allowList: ['https://a.test', 'https://b.test'] })
//      splices a space-separated allow list.
//   4. allowIframeEmbedding doesn't clobber other CSP directives.
//   5. allowIframeEmbedding called with no allowList defaults to '*'.
//   6. readTenantEmbedAllowlist returns null today (column missing) —
//      pinned so the future schema-add slice knows to update this test
//      verbatim when it flips the implementation.
//   7. The S1 nonce wiring (script-src `'nonce-<base64>'` on the strict
//      Report-Only CSP) is preserved AFTER the S4 default flip.

import { describe, test, expect, vi } from 'vitest';
import {
  allowIframeEmbedding,
  attachNonce,
  helmetMiddleware,
  helmetStrictReportOnlyMiddleware,
  readTenantEmbedAllowlist,
} from '../../middleware/security.js';

function makeReqRes({ body, path = '/embed/lead-form.html', locals } = {}) {
  const req = { body, path };
  const headers = {};
  const res = {
    headers,
    locals: locals || {},
    setHeader: vi.fn(function (name, value) {
      headers[name] = value;
    }),
    getHeader: vi.fn(function (name) {
      // helmet uses res.setHeader(name) with mixed-case; getHeader is
      // case-insensitive in real Express but we mirror the exact key used
      // by allowIframeEmbedding (Content-Security-Policy).
      return headers[name];
    }),
    removeHeader: vi.fn(function (name) {
      delete headers[name];
    }),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('#921 slice S4 — global defaults', () => {
  test('X-Frame-Options defaults to DENY (clickjacking lockdown)', () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    expect(res.headers['X-Frame-Options']).toBe('DENY');
  });

  test("CSP frame-ancestors defaults to 'none' (modern clickjacking primary)", () => {
    const { req, res, next } = makeReqRes();
    helmetMiddleware(req, res, next);
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp.toLowerCase()).toContain("frame-ancestors 'none'");
  });

  test("strict Report-Only CSP (#917 slice 1) still ships frame-ancestors 'none'", () => {
    // The strict report-only header was already 'none' before slice S4;
    // pin to ensure the S4 flip on the enforce-mode CSP didn't accidentally
    // converge them (they happen to match, but they're maintained
    // independently).
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    helmetStrictReportOnlyMiddleware(req, res, vi.fn());
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'].toLowerCase();
    expect(reportOnly).toContain("frame-ancestors 'none'");
  });

  test("S1 nonce wiring on script-src is preserved after the S4 default flip", () => {
    // The slice S4 flip touches frame-ancestors + X-Frame-Options only;
    // the per-request nonce on script-src/style-src of the strict Report-
    // Only CSP must not regress. This is the cross-cutting interaction
    // pin per the writing-api-gate-spec standing rule.
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    const nonce = res.locals.cspNonce;
    helmetStrictReportOnlyMiddleware(req, res, vi.fn());
    const reportOnly = res.headers['Content-Security-Policy-Report-Only'];
    expect(reportOnly).toContain(`'nonce-${nonce}'`);
    const scriptMatch = reportOnly.match(/script-src([^;]*)/i);
    expect(scriptMatch[1]).toContain(`'nonce-${nonce}'`);
  });
});

describe('#921 slice S4 — allowIframeEmbedding factory', () => {
  test('returns a 3-arg middleware that calls next', () => {
    const mw = allowIframeEmbedding({ allowList: ['*'] });
    expect(typeof mw).toBe('function');
    expect(mw.length).toBe(3);
    const { req, res, next } = makeReqRes();
    // Simulate the helmet-mounted state first (CSP set, XFO present)
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('wildcard allowList strips X-Frame-Options and sets frame-ancestors *', () => {
    const { req, res, next } = makeReqRes();
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    const mw = allowIframeEmbedding({ allowList: ['*'] });
    mw(req, res, next);
    expect(res.headers['X-Frame-Options']).toBeUndefined();
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toContain('frame-ancestors *');
    // Other directives preserved.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // The OLD 'none' is replaced, not duplicated.
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  test('explicit allowList joins origins space-separated', () => {
    const { req, res, next } = makeReqRes();
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    const mw = allowIframeEmbedding({
      allowList: ['https://partner-a.test', 'https://partner-b.test'],
    });
    mw(req, res, next);
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toContain('frame-ancestors https://partner-a.test https://partner-b.test');
    expect(res.headers['X-Frame-Options']).toBeUndefined();
  });

  test('missing allowList defaults to wildcard', () => {
    const { req, res, next } = makeReqRes();
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    const mw = allowIframeEmbedding();
    mw(req, res, next);
    expect(res.headers['Content-Security-Policy']).toContain('frame-ancestors *');
  });

  test('empty allowList defaults to wildcard', () => {
    const { req, res, next } = makeReqRes();
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    const mw = allowIframeEmbedding({ allowList: [] });
    mw(req, res, next);
    expect(res.headers['Content-Security-Policy']).toContain('frame-ancestors *');
  });

  test('non-array allowList defaults to wildcard (defensive)', () => {
    const { req, res, next } = makeReqRes();
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    // @ts-expect-error — intentionally wrong shape
    const mw = allowIframeEmbedding({ allowList: 'not-an-array' });
    mw(req, res, next);
    expect(res.headers['Content-Security-Policy']).toContain('frame-ancestors *');
  });

  test('does not duplicate the frame-ancestors directive when CSP missing it', () => {
    // Defensive — if helmet hasn't run yet (or has been disabled), the
    // override middleware should still emit a valid CSP rather than no-op.
    const { req, res, next } = makeReqRes();
    // No CSP set yet
    const mw = allowIframeEmbedding({ allowList: ['*'] });
    mw(req, res, next);
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toBe('frame-ancestors *');
  });

  test('appends frame-ancestors when CSP exists without that directive (defensive)', () => {
    const { req, res, next } = makeReqRes();
    // CSP exists but lacks frame-ancestors (shouldn't happen in practice
    // because helmetMiddleware always sets it, but defensively cover the
    // bypass case).
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    const mw = allowIframeEmbedding({ allowList: ['*'] });
    mw(req, res, next);
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toContain('frame-ancestors *');
    expect(csp).toContain("default-src 'self'");
  });
});

describe('#921 slice S39 — readTenantEmbedAllowlist (real Prisma read)', () => {
  // Slice S39 (2026-06-10) added the `Tenant.embedAllowlistJson String? @db.Text`
  // column and flipped this reader from a stub-returning-null to a real
  // `prisma.tenant.findUnique({ select: { embedAllowlistJson: true } })` →
  // `JSON.parse` → `Array.isArray` chain. The reader returns null whenever
  // (a) the column is null, (b) the JSON is malformed, (c) the parsed value
  // is non-array, or (d) `prisma`/`tenantId` is missing — never throws.
  // S4's "returns null today" pin is intentionally rewritten here; the new
  // pins cover the real read paths.

  test('returns the parsed array when the column holds a valid JSON array', async () => {
    const fakePrisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          embedAllowlistJson: '["https://partner-a.test","https://partner-b.test"]',
        }),
      },
    };
    const result = await readTenantEmbedAllowlist(fakePrisma, 7);
    expect(result).toEqual(['https://partner-a.test', 'https://partner-b.test']);
    expect(fakePrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { embedAllowlistJson: true },
    });
  });

  test('returns null when tenant.embedAllowlistJson is null', async () => {
    const fakePrisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ embedAllowlistJson: null }) },
    };
    const result = await readTenantEmbedAllowlist(fakePrisma, 42);
    expect(result).toBeNull();
    expect(fakePrisma.tenant.findUnique).toHaveBeenCalledOnce();
  });

  test('returns null on malformed JSON (catch-and-warn, never throws)', async () => {
    const fakePrisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ embedAllowlistJson: 'not-json{[' }),
      },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await readTenantEmbedAllowlist(fakePrisma, 1);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('returns null when parsed JSON is not an array (defensive — object/string/number)', async () => {
    const fakePrisma = {
      tenant: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ embedAllowlistJson: '{"not":"array"}' })
          .mockResolvedValueOnce({ embedAllowlistJson: '"plain-string"' })
          .mockResolvedValueOnce({ embedAllowlistJson: '42' }),
      },
    };
    await expect(readTenantEmbedAllowlist(fakePrisma, 1)).resolves.toBeNull();
    await expect(readTenantEmbedAllowlist(fakePrisma, 1)).resolves.toBeNull();
    await expect(readTenantEmbedAllowlist(fakePrisma, 1)).resolves.toBeNull();
  });

  test('short-circuits to null when prisma or tenantId is missing', async () => {
    await expect(readTenantEmbedAllowlist(null, 1)).resolves.toBeNull();
    await expect(readTenantEmbedAllowlist({}, null)).resolves.toBeNull();
    await expect(readTenantEmbedAllowlist(undefined, undefined)).resolves.toBeNull();
  });

  test('is async (returns a Promise)', async () => {
    const ret = readTenantEmbedAllowlist(null, 1);
    expect(typeof ret.then).toBe('function');
    await expect(ret).resolves.toBeNull();
  });
});
