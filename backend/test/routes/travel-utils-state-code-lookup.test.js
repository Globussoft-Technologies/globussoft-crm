// @ts-check
/**
 * #902 slice 16 — GET /api/travel/utils/state-code-lookup operator endpoint.
 *
 * Wraps the slice-16 `backend/lib/gstinValidator.js` `lookupStateByName`
 * reverse-lookup in a read-only HTTP surface so the Contact billing /
 * Tenant settings forms can resolve operator-typed state names (e.g.
 * "tamil", "Maharashtra", "Pradesh") to canonical CBIC 2-digit state
 * codes (PRD §3.5 place-of-supply rules).  Complements slice 14's
 * validate-gstin (code → name) by providing the encode direction.
 * Operator-facing (ADMIN+MANAGER); no write side effects, no schema touches.
 *
 * What this pins
 * --------------
 *   - Happy path:       "tamil" → 200 { count:1, results:[{stateCode:"33",...}] }
 *   - Exact match:      "Maharashtra" → 200 EXACT match, only 1 hit
 *   - Prefix match:     "andhra" → 200 with PREFIX hits (28 + 37 pre/post bifurcation)
 *   - Substring tier:   "pradesh" → 200 with SUBSTRING hits when no PREFIX
 *   - Auth gate:        no token → 401.
 *   - RBAC gate:        USER role → 403 RBAC_DENIED.
 *   - Vertical gate:    non-travel tenant → 403 WRONG_VERTICAL.
 *   - Missing param:    no `q` query → 400 MISSING_QUERY.
 *   - Empty param:      `q=` → 400 MISSING_QUERY.
 *   - Whitespace-only:  `q=   ` → 400 MISSING_QUERY.
 *   - No-hit:           "xyzzy" → 200 { count:0, results:[] } (NOT 404).
 *   - Normalisation:    "  TAMIL  " → echoed back lowercase trimmed.
 *   - Result shape:     every row carries stateCode + stateName + matchType.
 *   - Sort order:       stateCode ascending across all matchTypes.
 *   - MANAGER role:     accepted (low-cost operator lookup).
 *
 * Pattern: mirror travel-utils-hsn-lookup.test.js — patch the prisma
 * singleton's tenant.findUnique + auth-related lookups BEFORE requiring
 * the router, then drive supertest with real HS256 JWTs signed with
 * the same fallback secret the middleware uses in dev.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

vi.mock('../../lib/eventBus', () => ({
  default: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

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

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/utils/state-code-lookup', () => {
  test('happy path: "tamil" prefix → 200 with stateCode "33" Tamil Nadu (PREFIX match)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=tamil')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('tamil');
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const hit = res.body.results.find((r) => r.stateCode === '33');
    expect(hit).toBeDefined();
    expect(hit.stateName).toBe('Tamil Nadu');
    expect(hit.matchType).toBe('PREFIX');
  });

  test('exact match: "Maharashtra" → 200 with EXACT, single hit short-circuits prefix/substring tiers', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=Maharashtra')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].stateCode).toBe('27');
    expect(res.body.results[0].stateName).toBe('Maharashtra');
    expect(res.body.results[0].matchType).toBe('EXACT');
  });

  test('prefix-tier promotion: "andhra" → all PREFIX hits (no SUBSTRING-tier rows for same query)', async () => {
    // STATE_NAMES has "Andhra Pradesh (pre-bifurcation)" (28) and "Andhra Pradesh" (37).
    // Both start with "andhra" → PREFIX tier; SUBSTRING tier should NOT surface.
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=andhra')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    for (const row of res.body.results) {
      expect(row.matchType).toBe('PREFIX');
    }
    const codes = res.body.results.map((r) => r.stateCode);
    expect(codes).toContain('28');
    expect(codes).toContain('37');
  });

  test('substring-tier fallback: "pradesh" → SUBSTRING-tier hits when no PREFIX matches', async () => {
    // No state-name starts with "pradesh", but several CONTAIN it → SUBSTRING tier.
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=pradesh')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(3);
    for (const row of res.body.results) {
      expect(row.matchType).toBe('SUBSTRING');
    }
    const codes = res.body.results.map((r) => r.stateCode);
    // Himachal (02), Arunachal (12), Madhya (23), Andhra (28+37), Uttar (09).
    expect(codes).toContain('09'); // Uttar Pradesh
    expect(codes).toContain('23'); // Madhya Pradesh
  });

  test('case-insensitive: "TAMIL NADU" exact → 200 EXACT match', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=TAMIL%20NADU')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].stateCode).toBe('33');
    expect(res.body.results[0].matchType).toBe('EXACT');
  });

  test('happy path: MANAGER role is accepted (low-cost operator lookup)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=tamil')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  test('auth gate: no Authorization header → 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=tamil');
    expect(res.status).toBe(401);
  });

  test('RBAC gate: USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=tamil')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('vertical gate: wellness tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'wellness', name: 'Wellness', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=tamil')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });

  test('validation: missing q query → 400 MISSING_QUERY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('validation: empty q query → 400 MISSING_QUERY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('validation: whitespace-only q → 400 MISSING_QUERY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=%20%20%20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('no-hit: "xyzzy" → 200 with count:0 + results:[] (NOT 404)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=xyzzy')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.results).toEqual([]);
    expect(res.body.query).toBe('xyzzy');
  });

  test('normalisation: padded uppercase "  TAMIL  " → echoed back lowercase trimmed', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=%20%20TAMIL%20%20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('tamil');
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  test('result shape: every row carries stateCode + stateName + matchType strings', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=tamil')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    for (const row of res.body.results) {
      expect(typeof row.stateCode).toBe('string');
      expect(row.stateCode).toMatch(/^\d{2}$/);
      expect(typeof row.stateName).toBe('string');
      expect(['EXACT', 'PREFIX', 'SUBSTRING']).toContain(row.matchType);
    }
  });

  test('sort order: stateCode ascending across all matchTypes', async () => {
    // "pradesh" → SUBSTRING tier hits across multiple states with codes 09/12/23/28/37.
    // Result list must come back sorted ascending by stateCode.
    const res = await request(makeApp())
      .get('/api/travel/utils/state-code-lookup?q=pradesh')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const codes = res.body.results.map((r) => r.stateCode);
    const sorted = [...codes].sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual(sorted);
  });
});
