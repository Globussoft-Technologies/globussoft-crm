// @ts-check
/**
 * Route-level tests for the FOUR root handlers in backend/routes/travel.js.
 *
 * This is the FIRST route-level test file for the root travel.js — the
 * sibling tests at backend/test/cron/* + backend/test/routes/travel-*
 * cover DIFFERENT modules (sub-routes like /suppliers, /quotes, /invoices,
 * /diagnostics). Until this file landed, the root travel.js (247 LOC, 4
 * handlers) had ZERO direct route-level coverage — only indirectly exercised
 * via the e2e/tests/wellness.spec.js + travel.spec.js suites.
 *
 * Handlers under test:
 *   1. GET /api/travel/health                          (line 32)
 *   2. GET /api/travel/utils/validate-gstin            (line 73)
 *   3. GET /api/travel/utils/hsn-lookup                (line 169)
 *   4. GET /api/travel/utils/state-code-lookup         (line 224)
 *
 * Contracts asserted
 * ------------------
 *  1. GET /health authed + travel tenant → 200 with all 7 envelope keys
 *     (status, vertical, tenantId, tenantSlug, tenantName, phase, timestamp).
 *  2. GET /health non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant.
 *  3. GET /health unauthenticated → 401 (verifyToken).
 *  4. GET /utils/validate-gstin ADMIN + valid GSTIN → 200 { valid:true,
 *     stateName, stateCode, errors:[] }.
 *  5. GET /utils/validate-gstin ADMIN + invalid format → 200 { valid:false,
 *     errors:['INVALID_FORMAT'] }.
 *  6. GET /utils/validate-gstin ADMIN + invalid checksum → 200 with
 *     errors:['INVALID_CHECKSUM'] (and state name decoded — that's the
 *     route's "format passed, checksum tripped" branch on lines 124-126).
 *  7. GET /utils/validate-gstin missing ?gstin → 400 { code: 'MISSING_GSTIN' }.
 *  8. GET /utils/validate-gstin empty ?gstin (whitespace) → 400 MISSING_GSTIN.
 *  9. GET /utils/validate-gstin USER role → 403 RBAC_DENIED (only ADMIN+MANAGER).
 * 10. GET /utils/validate-gstin MANAGER role → 200 (positive case).
 * 11. GET /utils/validate-gstin non-travel tenant → 403 WRONG_VERTICAL.
 * 12. GET /utils/hsn-lookup ADMIN + ?q=hotel → 200 { query, count, results[] }.
 * 13. GET /utils/hsn-lookup missing ?q → 400 { code: 'MISSING_QUERY' }.
 * 14. GET /utils/state-code-lookup ADMIN + ?q=tamil → 200 with results
 *     containing Tamil Nadu (PREFIX match).
 * 15. GET /utils/state-code-lookup unauthenticated → 401.
 *
 * Mocking strategy
 * ----------------
 * Prisma-singleton-patch BEFORE requiring the router. Real verifyToken /
 * verifyRole / requireTravelTenant middleware fire — only prisma.tenant +
 * prisma.user + prisma.revokedToken are mocked so we exercise the actual
 * RBAC gate + travel-vertical gate logic. The pure libs (gstinValidator,
 * hsnSacMapper) run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. The travel root file itself
// doesn't touch prisma directly, but requireTravelTenant (middleware) does.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel Tenant',
  slug: 'test-travel-tenant',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelRouter = requireCJS('../../routes/travel');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Valid GSTIN for Maharashtra (state code 27).  Computed via the slice-13
// computeChecksumChar() algorithm — `27AAACR4849R1Z` + checksum `L`.  Pinned
// here so any future change to the checksum algorithm fails this test loudly.
const VALID_GSTIN = '27AAACR4849R1ZL';
// Same 14-char prefix with wrong checksum char (Z instead of L).  Format
// passes; state code passes; only the checksum stage fails.
const BAD_CHECKSUM_GSTIN = '27AAACR4849R1ZZ';
// Wrong shape entirely — lowercase letters, missing the `Z` at position 14.
const BAD_FORMAT_GSTIN = 'xx-not-a-gstin';

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel Tenant',
    slug: 'test-travel-tenant',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/health (root scaffolding)', () => {
  test('authed + travel tenant → 200 + all 7 envelope keys present', async () => {
    const res = await request(makeApp())
      .get('/api/travel/health')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'healthy',
      vertical: 'travel',
      tenantId: 1,
      tenantSlug: 'test-travel-tenant',
      tenantName: 'Test Travel Tenant',
      phase: '1-day-1-scaffolding',
    });
    // timestamp must be an ISO-8601 string (parseable back to a valid Date).
    expect(typeof res.body.timestamp).toBe('string');
    expect(Number.isFinite(new Date(res.body.timestamp).getTime())).toBe(true);
    // Exactly the 7 documented keys — no leak of extra internal state.
    expect(Object.keys(res.body).sort()).toEqual(
      ['phase', 'status', 'tenantId', 'tenantName', 'tenantSlug', 'timestamp', 'vertical'],
    );
  });

  test('non-travel tenant (generic / wellness) → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 2,
      vertical: 'generic',
      name: 'Generic Tenant',
      slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/health')
      .set('Authorization', `Bearer ${tokenFor('USER', { tenantId: 2 })}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });

  test('unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/health');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/utils/validate-gstin (slice 14)', () => {
  test('ADMIN + valid GSTIN → 200 valid:true with stateName + stateCode', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      gstin: VALID_GSTIN,
      valid: true,
      stateName: 'Maharashtra',
      stateCode: '27',
      errors: [],
    });
  });

  test('ADMIN + bad-format GSTIN → 200 valid:false errors:[INVALID_FORMAT]', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${encodeURIComponent(BAD_FORMAT_GSTIN)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(['INVALID_FORMAT']);
    // Per route lines 122-127: stateName / stateCode are null when the
    // failure stage is INVALID_FORMAT (we can't trust slice(0,2)).
    expect(res.body.stateName).toBeNull();
    expect(res.body.stateCode).toBeNull();
  });

  test('ADMIN + invalid-checksum GSTIN → 200 errors:[INVALID_CHECKSUM] with state info', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${BAD_CHECKSUM_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(['INVALID_CHECKSUM']);
    // INVALID_CHECKSUM branch (route lines 124-126): the state code IS
    // valid (otherwise the validator would have short-circuited on
    // INVALID_STATE_CODE first) — so surface the decoded state name.
    expect(res.body.stateCode).toBe('27');
    expect(res.body.stateName).toBe('Maharashtra');
  });

  test('missing ?gstin → 400 { code: MISSING_GSTIN }', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/validate-gstin')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_GSTIN');
  });

  test('empty / whitespace-only ?gstin → 400 MISSING_GSTIN', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/validate-gstin?gstin=%20%20%20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_GSTIN');
  });

  test('USER role → 403 RBAC_DENIED (only ADMIN+MANAGER permitted)', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('MANAGER role → 200 (positive RBAC case)', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 3,
      vertical: 'wellness',
      name: 'Wellness Tenant',
      slug: 'wellness',
    });
    const res = await request(makeApp())
      .get(`/api/travel/utils/validate-gstin?gstin=${VALID_GSTIN}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 3 })}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });
});

describe('GET /api/travel/utils/hsn-lookup (slice 15)', () => {
  test('ADMIN + ?q=hotel → 200 with 9963 in results', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('hotel');
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.results)).toBe(true);
    // SAC 9963 is Accommodation services — must be present for "hotel".
    const codes = res.body.results.map((r) => r.sacCode);
    expect(codes).toContain('9963');
  });

  test('missing ?q → 400 { code: MISSING_QUERY }', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});

describe('GET /api/travel/utils/state-code-lookup (slice 16)', () => {
  test('ADMIN + ?q=tamil → 200 with Tamil Nadu (33) in results', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=tamil')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('tamil');
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const codes = res.body.results.map((r) => r.stateCode);
    expect(codes).toContain('33');
    const tn = res.body.results.find((r) => r.stateCode === '33');
    expect(tn.stateName).toBe('Tamil Nadu');
    expect(tn.matchType).toBe('PREFIX');
  });

  test('missing ?q → 400 { code: MISSING_QUERY }', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/utils/state-code-lookup?q=tamil');
    expect(res.status).toBe(401);
  });
});
