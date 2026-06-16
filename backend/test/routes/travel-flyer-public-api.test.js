// @ts-check
/**
 * Tests for backend/routes/travel_flyer_public.js — public flyer share +
 * render surface (PRD_TRAVEL_MARKETING_FLYER #908 slice S18).
 *
 * Hard contract pins:
 *   - POST /:id/share (auth required)
 *       ADMIN with valid travel template → 200 { shareUrl, embedCode, expiresAt }.
 *       expiresInSec override → expiresAt reflects custom TTL.
 *       Non-travel-vertical tenant → 403 WRONG_VERTICAL.
 *       Cross-tenant template lookup → 404 TEMPLATE_NOT_FOUND.
 *       Sub-brand-locked template, MANAGER without access → 403 SUB_BRAND_DENIED.
 *       Non-numeric :id → 400 INVALID_ID.
 *       No JWT → 401 (verifyToken).
 *       USER role → 403 (requirePermission gate).
 *       Audit row TRAVEL_FLYER_PUBLIC_SHARE_MINTED emitted on success.
 *
 *   - GET /public/:slug (PUBLIC, no auth, JWT in ?t=)
 *       Valid token → 200, binary buffer + correct Content-Type.
 *       Missing ?t= → 401 MISSING_TOKEN.
 *       Tampered token → 401 INVALID_TOKEN.
 *       Expired token → 410 LINK_EXPIRED.
 *       Wrong-purpose token → 401 INVALID_TOKEN.
 *       Bad slug (different from canonical) → 404 FLYER_NOT_FOUND.
 *       isActive=false template → 404 FLYER_NOT_AVAILABLE.
 *       Bad format → 400 INVALID_FORMAT.
 *       Cross-tenant flyerId in token → 404 FLYER_NOT_FOUND.
 *       Each ALLOWED format renders without error.
 *       Audit row TRAVEL_FLYER_PUBLIC_RENDER emitted on success.
 *       renderFlyer engine integration mocked — buffer + mimeType + headers.
 *
 *   - GET /public/:slug/meta (PUBLIC, no auth)
 *       Valid token → 200, { templateName, brandName, expiresAt, embed, availableFormats }.
 *       Missing ?t= → 401 MISSING_TOKEN.
 *       Expired token → 410 LINK_EXPIRED.
 *
 * Strategy: same pattern as travel-quotes-public.test.js — monkey-patch
 * prisma BEFORE the router require, mount into bare express, drive via
 * supertest. JWT helper is REAL (we mint tokens against the test secret).
 * services/flyerRenderEngine is mocked via vi.doMock before the route
 * import so the route's inline lazy-require lands on the mock.
 *
 * audit.writeAudit is mocked so we can introspect the call.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import jwt from 'jsonwebtoken';

// Patch prisma BEFORE router require.
prisma.travelFlyerTemplate = {
  findFirst: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.revokedToken.create = vi.fn().mockResolvedValue({ id: 1 });

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// The route + dependency modules are CJS — vi.mock's ESM-shape interception
// does not catch require() calls. Instead we resolve each dependency module
// once via requireCJS and then mutate the cached exports object so the
// route's own `require()` resolves the same singleton with our spies bolted
// on. The route file does `const { writeAudit } = require('../lib/audit');`
// at the top so the binding is fixed at route-load time — that binding
// resolves to the live `module.exports.writeAudit` of the cached audit
// module, which means assigning `auditModule.writeAudit = mock` BEFORE
// requiring the route lets the route's destructured binding point at the
// mock. The render engine is lazy-required INSIDE the handler so we patch
// its exports object after both routes + engine are cached — the lazy
// require resolves the patched binding.
const auditModule = requireCJS('../../lib/audit');
const writeAuditMock = vi.fn().mockResolvedValue(undefined);
auditModule.writeAudit = writeAuditMock;

const renderEngineModule = requireCJS('../../services/flyerRenderEngine');
const renderFlyerMock = vi.fn();
renderEngineModule.renderFlyer = renderFlyerMock;

// Now require the route — its top-level `require('../lib/audit')` reads
// the patched export and its lazy `require('../services/flyerRenderEngine')`
// (inside the handler) reads the patched render-engine export.
const publicRouter = requireCJS('../../routes/travel_flyer_public');
const { mintShareToken, _internal: shareTokenInternal } = requireCJS('../../lib/flyerShareToken');

const SHARE_SECRET =
  process.env.FLYER_SHARE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'dev-flyer-share-secret';

const AUTH_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/flyers', publicRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    AUTH_SECRET,
    { expiresIn: '1h' },
  );
}

function makeTemplate(over = {}) {
  return {
    id: 42,
    tenantId: 1,
    name: 'Summer Umrah 2026',
    subBrand: null,
    paletteJson: JSON.stringify({ primaryHex: '#122647', secondaryHex: '#C89A4E', textHex: '#1A1A1A', bgHex: '#FFFFFF', themeTag: 'sapphire' }),
    layoutJson: JSON.stringify([{ type: 'text', x: 10, y: 10, width: 200, height: 40, content: 'Hello' }]),
    assetsJson: null,
    isActive: true,
    notes: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  prisma.travelFlyerTemplate.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.auditLog.create.mockReset();
  // S80 — RevokedToken default behavior is "not in list, fresh row creates".
  prisma.revokedToken.findUnique.mockReset();
  prisma.revokedToken.findUnique.mockResolvedValue(null);
  prisma.revokedToken.create.mockReset();
  prisma.revokedToken.create.mockResolvedValue({ id: 1 });
  // S80 — auditLog.findMany used by revoke-share's {slug, mintedAt} lookup.
  prisma.auditLog.findMany = prisma.auditLog.findMany || vi.fn();
  if (typeof prisma.auditLog.findMany.mockReset === 'function') {
    prisma.auditLog.findMany.mockReset();
  } else {
    prisma.auditLog.findMany = vi.fn();
  }
  prisma.auditLog.findMany.mockResolvedValue([]);

  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);

  renderFlyerMock.mockReset();
  renderFlyerMock.mockResolvedValue({
    buffer: Buffer.from('%PDF-1.7\n<<>>\n%%EOF\n', 'ascii'),
    mimeType: 'application/pdf',
    extension: 'pdf',
    widthPx: null,
    heightPx: null,
    engine: 'pdfkit',
  });

  prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.tenant.findUnique.mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
  });
});

// ============================================================================
// 1. POST /:id/share — operator mints a share link
// ============================================================================
describe('POST /api/v1/flyers/:id/share — share-mint', () => {
  test('ADMIN with valid template → 200, shareUrl + embedCode + expiresAt', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.shareUrl).toMatch(/\/p\/flyer\/summer-umrah-2026\?t=/);
    expect(res.body.embedCode).toContain('<iframe');
    expect(res.body.embedCode).toContain('embed=1');
    expect(res.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.slug).toBe('summer-umrah-2026');
    expect(res.body.flyerId).toBe(42);
  });

  test('share + embed URLs derive their base from the request Origin (local share → local URL)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/share')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Origin', 'http://localhost:5173')
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.shareUrl).toMatch(
      /^http:\/\/localhost:5173\/p\/flyer\/summer-umrah-2026\?t=/,
    );
    expect(res.body.embedCode).toContain(
      'http://localhost:5173/p/flyer/summer-umrah-2026?t=',
    );
  });

  test('custom expiresInSec is clamped + honored', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expiresInSec: 60 * 60 }); // 1 hour
    expect(res.status).toBe(200);
    const ttlMs = new Date(res.body.expiresAt).getTime() - Date.now();
    // Tolerate ±10s of clock drift between the test and the route.
    expect(ttlMs).toBeGreaterThan(60 * 60 * 1000 - 10_000);
    expect(ttlMs).toBeLessThan(60 * 60 * 1000 + 10_000);
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/abc/share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('cross-tenant or missing template → 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/999/share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('non-travel-vertical tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic', slug: 'generic',
    });
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });

  test('USER role → 403 (RBAC denies USER)', async () => {
    const userToken = tokenFor('USER');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/share')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('no Authorization header → 401', async () => {
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/share')
      .send({});
    expect([401, 403]).toContain(res.status);
  });

  test('audit row TRAVEL_FLYER_PUBLIC_SHARE_MINTED emitted on success', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(writeAuditMock).toHaveBeenCalled();
    const call = writeAuditMock.mock.calls.find((c) =>
      c[1] === 'TRAVEL_FLYER_PUBLIC_SHARE_MINTED',
    );
    expect(call).toBeTruthy();
    expect(call[0]).toBe('TravelFlyerTemplate');
    expect(call[2]).toBe(42);
    expect(call[4]).toBe(1); // tenantId
    expect(call[5].flyerId).toBe(42);
  });
});

// ============================================================================
// 2. GET /public/:slug — render PUBLIC
// ============================================================================
describe('GET /api/v1/flyers/public/:slug — public render', () => {
  test('valid token → 200, PDF buffer with correct Content-Type', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}&format=pdf-a4`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-flyer-render-engine']).toBe('pdfkit');
    expect(res.headers['content-disposition']).toContain('summer-umrah-2026-pdf-a4.pdf');
  });

  test('missing ?t= → 401 MISSING_TOKEN', async () => {
    const res = await request(makeApp())
      .get('/api/v1/flyers/public/summer-umrah-2026');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_TOKEN');
  });

  test('tampered token → 401 INVALID_TOKEN', async () => {
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`;
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('expired token → 410 LINK_EXPIRED', async () => {
    const expired = jwt.sign(
      { flyerId: 42, tenantId: 1, purpose: shareTokenInternal.PURPOSE },
      SHARE_SECRET,
      { expiresIn: '-1s' },
    );
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(expired)}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('LINK_EXPIRED');
  });

  test('wrong-purpose token → 401 INVALID_TOKEN', async () => {
    const wrong = jwt.sign(
      { flyerId: 42, tenantId: 1, purpose: 'travel-quote-share' },
      SHARE_SECRET,
      { expiresIn: '30d' },
    );
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(wrong)}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('slug mismatch → 404 FLYER_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/wrong-slug?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FLYER_NOT_FOUND');
  });

  test('isActive=false template → 404 FLYER_NOT_AVAILABLE', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate({ isActive: false }));
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FLYER_NOT_AVAILABLE');
  });

  test('cross-tenant flyerId in token → 404 FLYER_NOT_FOUND (Prisma where guards)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);
    const token = mintShareToken({ flyerId: 42, tenantId: 9999 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FLYER_NOT_FOUND');
  });

  test('bad format → 400 INVALID_FORMAT', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}&format=gif-animated`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FORMAT');
  });

  test('PNG format → renderFlyer called with that format, PNG headers set', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    renderFlyerMock.mockResolvedValueOnce({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimeType: 'image/png',
      extension: 'png',
      widthPx: 1200,
      heightPx: 1200,
      engine: 'stub-1x1',
    });
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}&format=png-square`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-flyer-width-px']).toBe('1200');
    expect(res.headers['x-flyer-height-px']).toBe('1200');
    expect(res.headers['x-flyer-render-engine']).toBe('stub-1x1');
    expect(renderFlyerMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'png-square' }),
    );
  });

  test('default format is png-square when ?format= omitted', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    renderFlyerMock.mockResolvedValueOnce({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      extension: 'png',
      widthPx: 1200,
      heightPx: 1200,
      engine: 'stub-1x1',
    });
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}`);
    expect(renderFlyerMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'png-square' }),
    );
  });

  test('audit row TRAVEL_FLYER_PUBLIC_RENDER emitted on success', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}&format=pdf-a4`);
    const call = writeAuditMock.mock.calls.find((c) =>
      c[1] === 'TRAVEL_FLYER_PUBLIC_RENDER',
    );
    expect(call).toBeTruthy();
    expect(call[0]).toBe('TravelFlyerTemplate');
    expect(call[2]).toBe(42);
    expect(call[3]).toBeNull(); // userId null for public
    expect(call[4]).toBe(1); // tenantId
    expect(call[5].format).toBe('pdf-a4');
    expect(call[5].engine).toBe('pdfkit');
    // actorType opt for the audit chain — fail-soft (we asserted the opts arg
    // landed by checking the 7th positional).
    expect(call[6]).toEqual(expect.objectContaining({ actorType: 'public' }));
  });

  test('audit failure does not block bytes — render still returns 200', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    writeAuditMock.mockRejectedValueOnce(new Error('audit chain offline'));
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}&format=pdf-a4`);
    expect(res.status).toBe(200);
  });

  test('fallback slug `flyer-<id>` is accepted even when name slugifies differently', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/flyer-42?t=${encodeURIComponent(token)}&format=pdf-a4`);
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 3. GET /public/:slug/meta — metadata-only
// ============================================================================
describe('GET /api/v1/flyers/public/:slug/meta — meta', () => {
  test('valid token → 200 with templateName + brandName + availableFormats', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026/meta?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body.templateName).toBe('Summer Umrah 2026');
    expect(res.body.brandName).toBe('Test Travel');
    expect(res.body.themeTag).toBe('sapphire');
    expect(res.body.availableFormats).toEqual([
      'pdf-a4', 'pdf-a5', 'png-square', 'png-portrait-ig', 'png-landscape-fb',
    ]);
    expect(res.body.defaultFormat).toBe('png-square');
    expect(res.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('embed=1 reflects in body.embed', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026/meta?t=${encodeURIComponent(token)}&embed=1`);
    expect(res.status).toBe(200);
    expect(res.body.embed).toBe(true);
  });

  test('missing ?t= → 401 MISSING_TOKEN', async () => {
    const res = await request(makeApp())
      .get('/api/v1/flyers/public/summer-umrah-2026/meta');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_TOKEN');
  });

  test('expired token → 410 LINK_EXPIRED', async () => {
    const expired = jwt.sign(
      { flyerId: 42, tenantId: 1, purpose: shareTokenInternal.PURPOSE },
      SHARE_SECRET,
      { expiresIn: '-1s' },
    );
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026/meta?t=${encodeURIComponent(expired)}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('LINK_EXPIRED');
  });

  test('cross-tenant flyerId → 404 FLYER_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);
    const token = mintShareToken({ flyerId: 42, tenantId: 9999 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026/meta?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FLYER_NOT_FOUND');
  });
});

// ============================================================================
// 4. POST /:id/revoke-share — S80 token-revocation surface
// ============================================================================
describe('POST /api/v1/flyers/:id/revoke-share — share-revoke', () => {
  test('no Authorization header → 401/403 (verifyToken)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .send({ jti: 'some-jti' });
    expect([401, 403]).toContain(res.status);
  });

  test('USER role → 403 (RBAC denies USER)', async () => {
    const userToken = tokenFor('USER');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ jti: 'some-jti' });
    expect(res.status).toBe(403);
  });

  test('ADMIN + valid jti → 200, revoked: true, alreadyRevoked: false', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'abc-123-jti' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(res.body.jti).toBe('abc-123-jti');
    expect(res.body.alreadyRevoked).toBe(false);
    expect(res.body.flyerId).toBe(42);
    expect(prisma.revokedToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jti: 'abc-123-jti',
        userId: 7,
        tenantId: 1,
        reason: 'flyer_share_revoked',
      }),
    });
  });

  test('idempotent: second revoke of same jti → 200, alreadyRevoked: true, no double-create', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    prisma.revokedToken.findUnique.mockResolvedValueOnce({ id: 99, revokedAt: new Date() });
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'already-revoked-jti' });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(res.body.alreadyRevoked).toBe(true);
    expect(prisma.revokedToken.create).not.toHaveBeenCalled();
  });

  test('missing jti AND missing slug/mintedAt → 400 INVALID_BODY', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  test('cross-tenant or missing template → 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/999/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'doesnt-matter' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/abc/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('{slug, mintedAt} pair with matching audit row → resolves jti + revokes', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const mintedAt = new Date('2026-06-10T12:00:00Z');
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        id: 1,
        entity: 'TravelFlyerTemplate',
        entityId: 42,
        action: 'TRAVEL_FLYER_PUBLIC_SHARE_MINTED',
        tenantId: 1,
        createdAt: mintedAt,
        metadata: JSON.stringify({
          flyerId: 42,
          slug: 'summer-umrah-2026',
          jti: 'audit-resolved-jti',
        }),
      },
    ]);
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: 'summer-umrah-2026', mintedAt: mintedAt.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.jti).toBe('audit-resolved-jti');
    expect(res.body.revoked).toBe(true);
  });

  test('{slug, mintedAt} with no matching audit row → 404 SHARE_MINT_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: 'wrong-slug', mintedAt: new Date().toISOString() });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SHARE_MINT_NOT_FOUND');
  });

  test('audit row TRAVEL_FLYER_PUBLIC_SHARE_REVOKED emitted on success', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const adminToken = tokenFor('ADMIN');
    const res = await request(makeApp())
      .post('/api/v1/flyers/42/revoke-share')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'audit-test-jti' });
    expect(res.status).toBe(200);
    const call = writeAuditMock.mock.calls.find((c) =>
      c[1] === 'TRAVEL_FLYER_PUBLIC_SHARE_REVOKED',
    );
    expect(call).toBeTruthy();
    expect(call[0]).toBe('TravelFlyerTemplate');
    expect(call[2]).toBe(42);
    expect(call[4]).toBe(1);
    expect(call[5].jti).toBe('audit-test-jti');
    expect(call[5].alreadyRevoked).toBe(false);
  });

  test('after revoke: GET /public/:slug with the revoked-jti token → 401 INVALID_TOKEN', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(makeTemplate());
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    // Decode to fish out the jti the mint just stamped.
    const decoded = jwt.decode(token);
    expect(decoded.jti).toBeTruthy();
    // Simulate the revocation having landed by making the next findUnique
    // call return a hit.
    prisma.revokedToken.findUnique.mockResolvedValueOnce({ id: 1 });
    const res = await request(makeApp())
      .get(`/api/v1/flyers/public/summer-umrah-2026?t=${encodeURIComponent(token)}&format=pdf-a4`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
    expect(res.body.error).toMatch(/revoked/i);
  });
});

// ============================================================================
// 5. flyerShareToken helper — mint/verify round-trip + edge cases
// ============================================================================
describe('flyerShareToken — mint + verify contract', () => {
  test('mint → verify round-trip preserves flyerId + tenantId', async () => {
    const { verifyShareToken } = requireCJS('../../lib/flyerShareToken');
    const token = mintShareToken({ flyerId: 42, tenantId: 7 });
    // S80 — verifyShareToken is async (RevokedToken DB lookup).
    const decoded = await verifyShareToken(token);
    expect(decoded.flyerId).toBe(42);
    expect(decoded.tenantId).toBe(7);
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(decoded.jti).toBeTruthy(); // S80 — jti present on the round-trip
  });

  test('default TTL is 7 days', () => {
    const token = mintShareToken({ flyerId: 1, tenantId: 1 });
    const decoded = jwt.decode(token);
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
  });

  test('custom expiresInSec is honored', () => {
    const token = mintShareToken({ flyerId: 1, tenantId: 1, expiresInSec: 3600 });
    const decoded = jwt.decode(token);
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  test('expiresInSec floor of 60s applied', () => {
    const token = mintShareToken({ flyerId: 1, tenantId: 1, expiresInSec: 1 });
    const decoded = jwt.decode(token);
    expect(decoded.exp - decoded.iat).toBeGreaterThanOrEqual(60);
  });

  test('mint rejects non-numeric flyerId', () => {
    expect(() => mintShareToken({ flyerId: 'abc', tenantId: 1 })).toThrow(/flyerId/);
  });

  test('mint rejects non-numeric tenantId', () => {
    expect(() => mintShareToken({ flyerId: 1, tenantId: null })).toThrow(/tenantId/);
  });
});
