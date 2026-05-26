// @ts-check
/**
 * Unit tests for backend/routes/wallet_rules.js — D16 Wallet Top-up Arc 1
 * slice 5b (admin bonus-rule CRUD).
 *
 * What this file pins
 * ───────────────────
 *   1. GET happy path — ADMIN lists active rules; envelope is {rules:[…]}.
 *   2. GET empty — fresh tenant returns {rules:[]} (not 404).
 *   3. GET ?includeInactive=1 — flips the WHERE so soft-deleted rows
 *      come along too.
 *   4. POST happy path — ADMIN creates a rule; 201 + {rule:…}; tenantId
 *      stamped from req.user (NOT readable from req.body — the
 *      stripDangerous middleware would strip it anyway, but the route
 *      explicitly stamps so the test pins the contract).
 *   5. POST validation — 4 failure cases (bad name / minAmountCents /
 *      bonusPercent / validityMonths). Each returns 400 + {field, error}.
 *   6. PUT happy path — ADMIN partial-update on an existing rule.
 *   7. PUT 404 — id that's not in caller's tenant returns 404 (tenant
 *      isolation; never reveals cross-tenant rule existence).
 *   8. DELETE soft-deletes — sets active=false; hard-delete is forbidden
 *      because downstream WalletCreditBatch references this row.
 *   9. RBAC — USER → 403 on GET; MANAGER → 403 on POST.
 *  10. Cross-tenant ADMIN — tenant A's admin gets {rules:[]} when their
 *      tenant has no rules even if tenant B has plenty (where-clause
 *      tenant scope verified).
 *  11. Audit emission — WALLET_RULE_CREATED on POST; the writeAudit
 *      side-effect is fire-and-forget so we flush microtasks before
 *      asserting.
 *
 * Test pattern mirrors backend/test/routes/travel_personalised_destinations.test.js
 * (canonical for routes that use verifyToken + verifyRole) — patch the
 * prisma singleton BEFORE requiring the router, mount under a tiny
 * Express app, drive end-to-end via a real JWT signed with the dev
 * fallback secret. This exercises the actual middleware/auth code path
 * (verifyToken + verifyRole) rather than mocking it — which is more
 * faithful to the production wire than the synthetic-req.user shortcut
 * used in some older tests.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wallet_rules.js + verifyToken's
//    revokedToken lookup. Defensive permissive stubs.
prisma.walletBonusRule = prisma.walletBonusRule || {};
prisma.walletBonusRule.findMany = vi.fn();
prisma.walletBonusRule.findFirst = vi.fn();
prisma.walletBonusRule.create = vi.fn();
prisma.walletBonusRule.update = vi.fn();

prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// auditLog.create is what writeAudit ultimately calls. Force-replace so
// the real client's delegate (if any) doesn't leak across tests.
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
  id: 1,
  tenantId: 1,
  name: 'Festive 2000+ Boost',
  minAmountCents: 200000,
  bonusPercent: 10,
  validityMonths: 12,
  active: true,
  validFrom: null,
  validTo: null,
  createdAt: new Date('2026-05-25T10:00:00Z'),
  updatedAt: new Date('2026-05-25T10:00:00Z'),
  ...overrides,
});

// ── 1. GET happy path ────────────────────────────────────────────────────
describe('GET /api/wallet/rules — (1) happy path', () => {
  test('ADMIN gets {rules:[…]} scoped to tenant; default excludes inactive', async () => {
    const rows = [ruleFixture(), ruleFixture({ id: 2, name: 'Off-peak 500 Boost', bonusPercent: 5 })];
    prisma.walletBonusRule.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(2);
    expect(res.body.rules[0].name).toBe('Festive 2000+ Boost');

    // Default WHERE: tenant-scoped AND active:true.
    expect(prisma.walletBonusRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, active: true }),
      }),
    );
  });
});

// ── 2. GET empty ────────────────────────────────────────────────────────
describe('GET /api/wallet/rules — (2) empty tenant', () => {
  test('no rules → 200 + {rules:[]} (NOT 404)', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rules: [] });
  });
});

// ── 3. GET ?includeInactive=1 ───────────────────────────────────────────
describe('GET /api/wallet/rules — (3) includeInactive=1', () => {
  test('drops active:true filter when ?includeInactive=1', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/wallet/rules?includeInactive=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);

    // The WHERE for this call must NOT include active:true.
    const where = prisma.walletBonusRule.findMany.mock.calls[0][0].where;
    expect(where).toEqual(expect.objectContaining({ tenantId: 1 }));
    expect(where).not.toHaveProperty('active');
  });
});

// ── 4. POST happy path ──────────────────────────────────────────────────
describe('POST /api/wallet/rules — (4) happy path', () => {
  test('ADMIN creates a rule; 201 + {rule:…}; tenantId stamped from req.user', async () => {
    const newRow = ruleFixture({ id: 42 });
    prisma.walletBonusRule.create.mockResolvedValue(newRow);

    const res = await request(makeApp())
      .post('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Festive 2000+ Boost',
        minAmountCents: 200000,
        bonusPercent: 10,
        validityMonths: 12,
        active: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.rule.id).toBe(42);

    // tenantId in data MUST come from req.user (1), not body.
    expect(prisma.walletBonusRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 1,
        name: 'Festive 2000+ Boost',
        minAmountCents: 200000,
        bonusPercent: 10,
        validityMonths: 12,
        active: true,
      }),
    });
  });
});

// ── 5. POST validation — 4 failure modes ────────────────────────────────
describe('POST /api/wallet/rules — (5) validation failures', () => {
  const baseBody = {
    name: 'Valid Rule',
    minAmountCents: 200000,
    bonusPercent: 10,
    validityMonths: 12,
  };

  test('name empty → 400 field=name', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...baseBody, name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('name');
    expect(prisma.walletBonusRule.create).not.toHaveBeenCalled();
  });

  test('minAmountCents=0 → 400 field=minAmountCents', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...baseBody, minAmountCents: 0 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('minAmountCents');
  });

  test('bonusPercent=150 → 400 field=bonusPercent', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...baseBody, bonusPercent: 150 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('bonusPercent');
  });

  test('validityMonths=120 → 400 field=validityMonths (hard cap 60)', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...baseBody, validityMonths: 120 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('validityMonths');
  });
});

// ── 6. PUT happy path ───────────────────────────────────────────────────
describe('PUT /api/wallet/rules/:id — (6) partial update', () => {
  test('ADMIN updates bonusPercent only; other fields untouched', async () => {
    prisma.walletBonusRule.findFirst.mockResolvedValue(ruleFixture());
    prisma.walletBonusRule.update.mockResolvedValue(ruleFixture({ bonusPercent: 15 }));

    const res = await request(makeApp())
      .put('/api/wallet/rules/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ bonusPercent: 15 });

    expect(res.status).toBe(200);
    expect(res.body.rule.bonusPercent).toBe(15);

    // Update data should only include the changed field.
    const updateArg = prisma.walletBonusRule.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 1 });
    expect(updateArg.data).toEqual({ bonusPercent: 15 });

    // Tenant-scoped existence check.
    expect(prisma.walletBonusRule.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: 1, id: 1 }),
    });
  });
});

// ── 7. PUT 404 for cross-tenant id ──────────────────────────────────────
describe('PUT /api/wallet/rules/:id — (7) 404 cross-tenant', () => {
  test('ADMIN of tenant 1 cannot update rule owned by tenant 2 → 404', async () => {
    prisma.walletBonusRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/wallet/rules/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send({ bonusPercent: 5 });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Wallet bonus rule not found' });
    expect(prisma.walletBonusRule.update).not.toHaveBeenCalled();
  });
});

// ── 8. DELETE soft-deletes ─────────────────────────────────────────────
describe('DELETE /api/wallet/rules/:id — (8) soft-delete', () => {
  test('ADMIN delete sets active=false (NOT a hard delete)', async () => {
    prisma.walletBonusRule.findFirst.mockResolvedValue(ruleFixture());
    prisma.walletBonusRule.update.mockResolvedValue(ruleFixture({ active: false }));

    const res = await request(makeApp())
      .delete('/api/wallet/rules/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rule.active).toBe(false);

    // Must use update, NOT delete — preserves the row for downstream
    // WalletCreditBatch.sourceRuleId references.
    expect(prisma.walletBonusRule.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { active: false },
    });
  });

  test('idempotent — deleting already-inactive returns 200 + alreadyInactive flag', async () => {
    prisma.walletBonusRule.findFirst.mockResolvedValue(ruleFixture({ active: false }));

    const res = await request(makeApp())
      .delete('/api/wallet/rules/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.alreadyInactive).toBe(true);
    // No update fired — short-circuit on already-inactive.
    expect(prisma.walletBonusRule.update).not.toHaveBeenCalled();
  });
});

// ── 9. RBAC ────────────────────────────────────────────────────────────
describe('RBAC — (9) role gates', () => {
  test('USER on GET → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.walletBonusRule.findMany).not.toHaveBeenCalled();
  });

  test('MANAGER on POST → 403 (POST is ADMIN-only)', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ name: 'X', minAmountCents: 100, bonusPercent: 5, validityMonths: 12 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.walletBonusRule.create).not.toHaveBeenCalled();
  });

  test('MANAGER on GET → 200 (GET is ADMIN+MANAGER)', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rules: [] });
  });

  test('unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/wallet/rules');
    expect(res.status).toBe(401);
    expect(prisma.walletBonusRule.findMany).not.toHaveBeenCalled();
  });
});

// ── 10. Cross-tenant scoping ──────────────────────────────────────────
describe('GET — (10) cross-tenant isolation', () => {
  test('tenant 1 admin gets empty list when their tenant has zero rules even if tenant 2 has plenty', async () => {
    // Mock simulates tenant-scoped findMany: only tenant 1 rows returned.
    // Since we mock the call, the load-bearing assertion is the WHERE
    // clause — it MUST include tenantId:1.
    prisma.walletBonusRule.findMany.mockImplementation(async ({ where }) => {
      if (where.tenantId === 1) return [];
      if (where.tenantId === 2) return [ruleFixture({ tenantId: 2 })];
      return [];
    });

    const res = await request(makeApp())
      .get('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual([]);

    expect(prisma.walletBonusRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });
});

// ── 11. Audit emission ────────────────────────────────────────────────
describe('Audit — (11) WALLET_RULE_CREATED fires on POST', () => {
  test('POST happy path writes a WALLET_RULE_CREATED audit row', async () => {
    const newRow = ruleFixture({ id: 99 });
    prisma.walletBonusRule.create.mockResolvedValue(newRow);

    const res = await request(makeApp())
      .post('/api/wallet/rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Festive 2000+ Boost',
        minAmountCents: 200000,
        bonusPercent: 10,
        validityMonths: 12,
      });
    expect(res.status).toBe(201);

    // writeAudit is fire-and-forget — flush microtasks.
    await new Promise((r) => setImmediate(r));

    const calls = prisma.auditLog.create.mock.calls.map((c) => c[0].data || c[0]);
    const auditRow = calls.find((d) => d.action === 'WALLET_RULE_CREATED');
    expect(auditRow).toBeDefined();
    expect(auditRow.entity).toBe('WalletBonusRule');
    expect(auditRow.entityId).toBe(99);
    expect(auditRow.userId).toBe(7);
    expect(auditRow.tenantId).toBe(1);
  });
});
