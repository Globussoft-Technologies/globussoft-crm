// @ts-check
/**
 * Unit tests for GET /api/wallet/rules/stats — D16 Wallet Top-up Arc 1
 * polish (first /stats endpoint for the wallet bonus-rule admin CRUD).
 *
 * Sibling to backend/test/routes/wallet-rules.test.js (which pins the CRUD
 * surface). This file ONLY pins the /stats aggregate contract.
 *
 * What this file pins
 * ───────────────────
 *   1. 401 when no Authorization header (verifyToken).
 *   2. 403 RBAC_DENIED for USER role (readRoleGate ADMIN/MANAGER only).
 *   3. 400 INVALID_DATE on malformed ?from.
 *   4. 400 INVALID_DATE on malformed ?to.
 *   5. Empty-tenant happy path: total=0, active=0, inactive=0,
 *      currentlyValid=0, expired=0, expiringSoon=0, lastCreatedAt=null.
 *   6. Happy path: 3 active + 2 inactive → counts correct.
 *   7. Tenant-scope: WHERE clause stamps tenantId from req.user.tenantId.
 *   8. ?from/?to narrows createdAt window (WHERE.createdAt has gte/lte).
 *   9. lastCreatedAt = max(createdAt) across the matching set.
 *  10. NO auditLog.create call (read-only meta surface).
 *  11. Defensive: rows with null createdAt are still counted in `total`
 *      but skipped when computing lastCreatedAt.
 *  12. validTo boundary: expired (validTo < now), currentlyValid (validTo
 *      future), expiringSoon (validTo within +30d AND active).
 *  13. MANAGER can read /stats (readRoleGate allows ADMIN + MANAGER).
 *
 * Test pattern mirrors backend/test/routes/wallet-rules.test.js — patch the
 * prisma singleton BEFORE requiring the router, drive through a real JWT
 * signed with the dev fallback secret so verifyToken + readRoleGate run.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wallet_rules.js + verifyToken's
//    revokedToken lookup. Permissive defensive stubs.
prisma.walletBonusRule = prisma.walletBonusRule || {};
prisma.walletBonusRule.findMany = vi.fn();
prisma.walletBonusRule.findFirst = vi.fn();
prisma.walletBonusRule.create = vi.fn();
prisma.walletBonusRule.update = vi.fn();

prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// auditLog.create — used by writeAudit; here we ASSERT it's NEVER called
// for /stats. Force-replace so the real client's delegate (if any) doesn't
// leak across tests.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const rulesRouter = requireCJS('../../routes/wallet_rules');

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wallet/rules', rulesRouter);
  return app;
}

beforeEach(() => {
  prisma.walletBonusRule.findMany.mockReset();
  prisma.walletBonusRule.findFirst.mockReset();
  prisma.walletBonusRule.create.mockReset();
  prisma.walletBonusRule.update.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockResolvedValue(null);
});

const ruleFixture = (overrides = {}) => ({
  active: true,
  validFrom: null,
  validTo: null,
  createdAt: new Date('2026-05-25T10:00:00Z'),
  ...overrides,
});

// ── 1. Unauthenticated → 401 ───────────────────────────────────────────
describe('GET /api/wallet/rules/stats — (1) 401 unauthenticated', () => {
  test('no Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/wallet/rules/stats');
    expect(res.status).toBe(401);
    expect(prisma.walletBonusRule.findMany).not.toHaveBeenCalled();
  });
});

// ── 2. USER role → 403 RBAC_DENIED ─────────────────────────────────────
describe('GET /api/wallet/rules/stats — (2) 403 USER role', () => {
  test('USER role gets 403 RBAC_DENIED (ADMIN/MANAGER gate)', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.walletBonusRule.findMany).not.toHaveBeenCalled();
  });
});

// ── 3. 400 INVALID_DATE on bad ?from ───────────────────────────────────
describe('GET /api/wallet/rules/stats — (3) 400 bad ?from', () => {
  test('malformed ?from → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/rules/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.walletBonusRule.findMany).not.toHaveBeenCalled();
  });
});

// ── 4. 400 INVALID_DATE on bad ?to ─────────────────────────────────────
describe('GET /api/wallet/rules/stats — (4) 400 bad ?to', () => {
  test('malformed ?to → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/rules/stats?to=ZZZ')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.walletBonusRule.findMany).not.toHaveBeenCalled();
  });
});

// ── 5. Empty-tenant happy path ─────────────────────────────────────────
describe('GET /api/wallet/rules/stats — (5) empty tenant', () => {
  test('no rules → all zeros + lastCreatedAt:null', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      active: 0,
      inactive: 0,
      currentlyValid: 0,
      expired: 0,
      expiringSoon: 0,
      lastCreatedAt: null,
    });
  });
});

// ── 6. Happy path: 3 active + 2 inactive ───────────────────────────────
describe('GET /api/wallet/rules/stats — (6) 5 rules (3 active + 2 inactive)', () => {
  test('counts active/inactive split correctly', async () => {
    const rows = [
      ruleFixture({ active: true }),
      ruleFixture({ active: true }),
      ruleFixture({ active: true }),
      ruleFixture({ active: false }),
      ruleFixture({ active: false }),
    ];
    prisma.walletBonusRule.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.active).toBe(3);
    expect(res.body.inactive).toBe(2);
  });
});

// ── 7. Tenant scoping — WHERE.tenantId stamped from req.user ───────────
describe('GET /api/wallet/rules/stats — (7) tenant isolation', () => {
  test('WHERE.tenantId is stamped from req.user.tenantId (not body)', async () => {
    prisma.walletBonusRule.findMany.mockImplementation(async ({ where }) => {
      // Simulate tenant-scoped DB: only return rows for the matching tenant.
      if (where.tenantId === 99) return [];
      if (where.tenantId === 7) return [ruleFixture()];
      return [];
    });

    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 99 })}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);

    expect(prisma.walletBonusRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 99 }),
      }),
    );
  });
});

// ── 8. ?from / ?to narrows the createdAt window ────────────────────────
describe('GET /api/wallet/rules/stats — (8) ?from / ?to bounds', () => {
  test('?from + ?to add gte/lte to WHERE.createdAt', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/wallet/rules/stats?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);

    const where = prisma.walletBonusRule.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(where.createdAt).toBeDefined();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    expect(where.createdAt.gte.toISOString().startsWith('2026-05-01')).toBe(true);
    expect(where.createdAt.lte.toISOString().startsWith('2026-05-31')).toBe(true);
  });
});

// ── 9. lastCreatedAt picks the most-recent createdAt ───────────────────
describe('GET /api/wallet/rules/stats — (9) lastCreatedAt = max(createdAt)', () => {
  test('returns ISO of newest createdAt across the set', async () => {
    const newest = new Date('2026-05-25T15:00:00Z');
    const middle = new Date('2026-05-20T10:00:00Z');
    const oldest = new Date('2026-01-01T00:00:00Z');
    prisma.walletBonusRule.findMany.mockResolvedValue([
      ruleFixture({ createdAt: middle }),
      ruleFixture({ createdAt: newest }),
      ruleFixture({ createdAt: oldest }),
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });
});

// ── 10. NO audit row written ───────────────────────────────────────────
describe('GET /api/wallet/rules/stats — (10) NO audit emission', () => {
  test('happy path does NOT call auditLog.create (read-only meta surface)', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([ruleFixture()]);
    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);

    // Flush microtasks — writeAudit is fire-and-forget elsewhere; pin that
    // it stays silent here.
    await new Promise((r) => setImmediate(r));

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── 11. Defensive: null createdAt counted in total but skipped by lastCreatedAt ──
describe('GET /api/wallet/rules/stats — (11) null createdAt defensiveness', () => {
  test('null createdAt rows still counted in total; lastCreatedAt picks non-null max', async () => {
    const realDate = new Date('2026-05-25T10:00:00Z');
    prisma.walletBonusRule.findMany.mockResolvedValue([
      ruleFixture({ createdAt: null }),
      ruleFixture({ createdAt: realDate }),
      ruleFixture({ createdAt: null }),
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.active).toBe(3);
    expect(res.body.lastCreatedAt).toBe(realDate.toISOString());
  });
});

// ── 12. validTo boundary: expired / currentlyValid / expiringSoon ──────
describe('GET /api/wallet/rules/stats — (12) validTo boundary classification', () => {
  test('expired (validTo<now), currentlyValid (open), expiringSoon (<30d) split correctly', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const inTwoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const inSixtyDays = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    prisma.walletBonusRule.findMany.mockResolvedValue([
      // Expired: validTo in the past, regardless of `active`.
      ruleFixture({ active: false, validTo: yesterday }),
      // Currently valid + expiring soon: active=true, validTo within 30d.
      ruleFixture({ active: true, validTo: inTwoWeeks }),
      // Currently valid (not expiring soon): active=true, validTo +60d.
      ruleFixture({ active: true, validTo: inSixtyDays }),
      // Currently valid: no validity bounds at all (open-ended rule).
      ruleFixture({ active: true, validFrom: null, validTo: null }),
      // Inactive but bounded forward — not currentlyValid (active gate),
      // not expired (validTo future), not expiringSoon (active gate).
      ruleFixture({ active: false, validTo: inTwoWeeks }),
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.active).toBe(3);
    expect(res.body.inactive).toBe(2);
    expect(res.body.expired).toBe(1);
    expect(res.body.currentlyValid).toBe(3); // 3 active with future-or-null validTo
    expect(res.body.expiringSoon).toBe(1); // 1 active with validTo within 30d
  });
});

// ── 13. MANAGER on /stats → 200 (readRoleGate allows ADMIN + MANAGER) ──
describe('GET /api/wallet/rules/stats — (13) MANAGER readable', () => {
  test('MANAGER role → 200 (readRoleGate accepts ADMIN + MANAGER)', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/wallet/rules/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});
