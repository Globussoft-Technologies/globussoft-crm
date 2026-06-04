// @ts-check
/**
 * Travel CRM — sub-brand session scope contract tests (WS-1).
 *
 * Pins backend/routes/travel_session.js:
 *
 *   POST /api/travel/session/switch-brand  { subBrand }
 *   GET  /api/travel/session/active-brand
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401 (verifyToken in the chain, no bypass).
 *   - POST happy path: valid + allowed sub-brand → 200 with
 *     { activeSubBrand, allowed }.
 *   - POST 400 INVALID_SUB_BRAND: a subBrand outside the canonical 4 ids is
 *     rejected BEFORE any access lookup (assertValidSubBrand throws first).
 *   - POST 403 SUB_BRAND_FORBIDDEN: a valid id the caller has no grant for
 *     (non-admin, subBrandAccess excludes it) → 403, selection refused.
 *   - GET active-brand: ADMIN (subBrandAccess null) → fullAccess:true + all 4
 *     ids; granted non-admin → only the granted ids.
 *
 * Mocking pattern mirrors travel-visa-stats.test.js — monkey-patch the prisma
 * singleton BEFORE requiring the router so verifyToken + requireTravelTenant +
 * getSubBrandAccessSet stay in the chain (no bypass). No MySQL, no server boot.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// ─── Patch prisma singleton BEFORE requiring the router ──────────────
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const router = requireCJS('../../routes/travel_session');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', router);
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

// ─── Auth gate ───────────────────────────────────────────────────────

describe('POST /session/switch-brand — auth gate', () => {
  test('missing Bearer → 401 (no access lookup)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/session/switch-brand')
      .send({ subBrand: 'tmc' });
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Happy path (200) ────────────────────────────────────────────────

describe('POST /session/switch-brand — valid + allowed → 200', () => {
  test('granted non-admin switching to a brand they hold → 200 echo', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc', 'rfu']),
    });
    const res = await request(makeApp())
      .post('/api/travel/session/switch-brand')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ subBrand: 'tmc' });
    expect(res.status).toBe(200);
    expect(res.body.activeSubBrand).toBe('tmc');
    expect(res.body.allowed).toEqual(expect.arrayContaining(['tmc', 'rfu']));
  });

  test('admin (subBrandAccess null) → 200 with all four ids allowed', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/session/switch-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'visasure' });
    expect(res.status).toBe(200);
    expect(res.body.activeSubBrand).toBe('visasure');
    expect(res.body.allowed).toEqual(
      expect.arrayContaining(['tmc', 'rfu', 'travelstall', 'visasure']),
    );
  });
});

// ─── Invalid sub-brand (400) ─────────────────────────────────────────

describe('POST /session/switch-brand — invalid sub-brand → 400', () => {
  test('unknown id → 400 INVALID_SUB_BRAND before any access lookup', async () => {
    const res = await request(makeApp())
      .post('/api/travel/session/switch-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'banana' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
    // assertValidSubBrand throws first — no access lookup happens.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('missing subBrand → 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/session/switch-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
  });
});

// ─── Valid but forbidden (403) ───────────────────────────────────────

describe('POST /session/switch-brand — valid but forbidden → 403', () => {
  test('non-admin requesting a brand outside their grant → 403 SUB_BRAND_FORBIDDEN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'SALES', subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/session/switch-brand')
      .set('Authorization', `Bearer ${tokenFor('SALES')}`)
      .send({ subBrand: 'rfu' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_FORBIDDEN');
  });
});

// ─── GET active-brand ────────────────────────────────────────────────

describe('GET /session/active-brand', () => {
  test('missing Bearer → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/session/active-brand');
    expect(res.status).toBe(401);
  });

  test('admin → fullAccess:true + all four ids', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
    const res = await request(makeApp())
      .get('/api/travel/session/active-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.fullAccess).toBe(true);
    expect(res.body.allowed).toEqual(
      expect.arrayContaining(['tmc', 'rfu', 'travelstall', 'visasure']),
    );
  });

  test('granted non-admin → only granted ids, fullAccess:false', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'OPERATIONS', subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .get('/api/travel/session/active-brand')
      .set('Authorization', `Bearer ${tokenFor('OPERATIONS')}`);
    expect(res.status).toBe(200);
    expect(res.body.fullAccess).toBe(false);
    expect(res.body.allowed).toEqual(['rfu']);
  });
});
