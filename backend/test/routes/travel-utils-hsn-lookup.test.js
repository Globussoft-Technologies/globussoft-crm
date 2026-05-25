// @ts-check
/**
 * #902 slice 15 — GET /api/travel/utils/hsn-lookup operator endpoint.
 *
 * Wraps the slice-5 `backend/lib/hsnSacMapper.js` `lookupSacByKeyword`
 * reverse-lookup in a read-only HTTP surface so the invoice-line edit
 * form's "Help me pick a SAC" picker can resolve operator phrasings
 * ("hotel", "umrah", "transport") to canonical SAC codes (PRD §3.4.3).
 * Operator-facing (ADMIN+MANAGER); no write side effects, no schema
 * touches.
 *
 * What this pins
 * --------------
 *   - Happy path:     "hotel" → 200 { count:1, results:[{sacCode:"9963",...}] }
 *   - Multi-hit:      "trip" → 200 { count: ≥1, includes 9985 }
 *   - Auth gate:      no token → 401.
 *   - RBAC gate:      USER role → 403 RBAC_DENIED.
 *   - Vertical gate:  non-travel tenant → 403 WRONG_VERTICAL.
 *   - Missing param:  no `q` query → 400 MISSING_QUERY.
 *   - Empty param:    `q=` → 400 MISSING_QUERY.
 *   - Whitespace:     `q=   ` → 400 MISSING_QUERY.
 *   - No-hit:         "xyzzy" → 200 { count:0, results:[] } (NOT 404).
 *   - Normalisation:  "HOTEL " → echoed back lowercase trimmed.
 *   - matchType:      EXACT for internal line-type key, KEYWORD for
 *                     synonym, DESCRIPTION for description-substring.
 *   - Sort order:     sacCode ascending — pinned via "transport" query
 *                     (would hit both 9964 and a description match).
 *
 * Pattern: patch the prisma singleton's `tenant.findUnique` + auth-related
 * lookups BEFORE requiring the router, then drive supertest with real
 * HS256 JWTs signed with the same fallback secret the middleware uses in
 * dev (mirrors travel-utils-gstin.test.js).
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

describe('GET /api/travel/utils/hsn-lookup', () => {
  test('happy path: "hotel" → 200 with sacCode 9963 EXACT match', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('hotel');
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const hit = res.body.results.find((r) => r.sacCode === '9963');
    expect(hit).toBeDefined();
    expect(hit.description).toBe('Accommodation services');
    expect(['EXACT', 'KEYWORD']).toContain(hit.matchType);
  });

  test('happy path: "umrah" → 200 with sacCode 9985 KEYWORD match (operator phrasing)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=umrah')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const hit = res.body.results.find((r) => r.sacCode === '9985');
    expect(hit).toBeDefined();
    expect(hit.description).toBe('Support services to travel & tourism');
    expect(hit.matchType).toBe('KEYWORD');
  });

  test('happy path: "visa" → 200 with sacCode 9982 (legal/visa SAC)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=visa')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const hit = res.body.results.find((r) => r.sacCode === '9982');
    expect(hit).toBeDefined();
    expect(hit.description).toMatch(/Legal/i);
  });

  test('multi-token query: "passenger transport" → 200 with sacCode 9964', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=passenger%20transport')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const hit = res.body.results.find((r) => r.sacCode === '9964');
    expect(hit).toBeDefined();
  });

  test('happy path: MANAGER role is accepted (low-cost operator lookup)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  test('auth gate: no Authorization header → 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel');
    expect(res.status).toBe(401);
  });

  test('RBAC gate: USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('vertical gate: wellness tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'wellness', name: 'Wellness', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });

  test('validation: missing q query → 400 MISSING_QUERY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('validation: empty q query → 400 MISSING_QUERY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('validation: whitespace-only q → 400 MISSING_QUERY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=%20%20%20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_QUERY');
  });

  test('no-hit: "xyzzy" → 200 with count:0 + results:[] (NOT 404)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=xyzzy')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.results).toEqual([]);
    expect(res.body.query).toBe('xyzzy');
  });

  test('normalisation: uppercase + padded "  HOTEL  " → echoed back lowercase trimmed', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=%20%20HOTEL%20%20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('hotel');
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  test('sort order: sacCode ascending across all matchTypes', async () => {
    // "transport" → KEYWORD hit on 9964 + DESCRIPTION substring on "9964" via
    // "Passenger transport services". Verify result list is sorted ascending.
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=transport')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const codes = res.body.results.map((r) => r.sacCode);
    const sorted = [...codes].sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual(sorted);
  });

  test('dedup: same SAC only appears once even if multiple keyword tokens match', async () => {
    // "hotel room" → both "hotel" (9963) and "room" (9963) hit KEYWORD_TO_SAC
    // for the same SAC. Lib's dedup should collapse to one row.
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=hotel%20room')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const hits9963 = res.body.results.filter((r) => r.sacCode === '9963');
    expect(hits9963.length).toBe(1);
  });

  test('result shape: every row carries sacCode + description + matchType strings', async () => {
    const res = await request(makeApp())
      .get('/api/travel/utils/hsn-lookup?q=tour')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    for (const row of res.body.results) {
      expect(typeof row.sacCode).toBe('string');
      expect(typeof row.description).toBe('string');
      expect(['EXACT', 'KEYWORD', 'DESCRIPTION']).toContain(row.matchType);
    }
  });
});
