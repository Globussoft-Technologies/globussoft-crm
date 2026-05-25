// @ts-check
/**
 * /api/tenant-settings — admin override surface for the per-tenant cap pattern.
 *
 * Pins the contract for backend/routes/tenant_settings.js, the 5th part of
 * the per-tenant cap pattern resolved 2026-05-24 (DECISIONS_TRACKER commit
 * a8f24ca). The helper (backend/lib/tenantSettings.js) + 4 consumers
 * (llmRouter live, adsGptClient/ratehawkClient/callifiedClient stub) all
 * read caps via getBudgetCap(tenantId, integration); this route is the
 * operator-writable surface so the cap isn't permanently env-var-only.
 *
 * What's pinned
 * -------------
 *   - GET   /                      list + defaults envelope
 *   - GET   /:key                  override row OR env-var default fallback
 *   - GET   /:key unset            isOverride=false, value reflects default
 *   - PUT   /:key happy path       upserts + writes audit + 200 envelope
 *   - PUT   /:key unknown key      400 INVALID_SETTING_KEY + lists allowed
 *   - PUT   /:key as USER          403 RBAC_DENIED
 *   - DELETE /:key happy path      204 + audit
 *   - DELETE /:key not found       404
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the same fallback
 * secret the middleware uses in dev. verifyToken + verifyRole stay live in
 * the chain so the auth + role gates are exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tenantSetting = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
};
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const tenantSettingsRouter = requireCJS('../../routes/tenant_settings');
const { KEYS, DEFAULTS } = requireCJS('../../lib/tenantSettings');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tenant-settings', tenantSettingsRouter);
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
  prisma.tenantSetting.findMany.mockReset();
  prisma.tenantSetting.findUnique.mockReset();
  prisma.tenantSetting.upsert.mockReset();
  prisma.tenantSetting.delete.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/tenant-settings/', () => {
  test('returns settings list + defaults envelope', async () => {
    prisma.tenantSetting.findMany.mockResolvedValue([
      {
        key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS,
        value: '7500',
        category: 'budget',
      },
    ]);
    const res = await request(makeApp())
      .get('/api/tenant-settings/')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual([
      { key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS, value: '7500', category: 'budget' },
    ]);
    // defaults map MUST include every canonical key so the UI can render
    // the "currently overridden" badge without a second round trip.
    expect(res.body.defaults).toEqual(DEFAULTS);
    expect(res.body.allowedKeys).toEqual(expect.arrayContaining(Object.values(KEYS)));
    // tenant scope MUST come from req.user.tenantId, not body.
    expect(prisma.tenantSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1 },
      }),
    );
  });
});

describe('GET /api/tenant-settings/:key', () => {
  test('returns active value + defaultValue + isOverride=true when row exists', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      key: KEYS.LLM_MONTHLY_CAP_USD_CENTS,
      value: '12345',
      category: 'budget',
    });
    const res = await request(makeApp())
      .get(`/api/tenant-settings/${KEYS.LLM_MONTHLY_CAP_USD_CENTS}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: KEYS.LLM_MONTHLY_CAP_USD_CENTS,
      value: '12345',
      defaultValue: DEFAULTS[KEYS.LLM_MONTHLY_CAP_USD_CENTS],
      isOverride: true,
      category: 'budget',
    });
  });

  test('returns default + isOverride=false when no row exists', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get(`/api/tenant-settings/${KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS,
      defaultValue: DEFAULTS[KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS],
      isOverride: false,
      category: 'budget',
    });
    // value mirrors the env-var default so the UI can show one consistent
    // string regardless of whether an override row exists.
    expect(res.body.value).toBe(String(DEFAULTS[KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS]));
  });
});

describe('PUT /api/tenant-settings/:key', () => {
  test('happy path upserts + writes audit + returns 200 envelope', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null); // no prior row
    prisma.tenantSetting.upsert.mockResolvedValue({
      id: 99,
      key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS,
      value: '8000',
      category: 'budget',
    });
    const res = await request(makeApp())
      .put(`/api/tenant-settings/${KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ value: 8000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS,
      value: '8000',
      defaultValue: DEFAULTS[KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS],
      isOverride: true,
      category: 'budget',
    });
    // Upsert call MUST scope by (tenantId, key) and stringify the value.
    expect(prisma.tenantSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_key: { tenantId: 1, key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS } },
        create: expect.objectContaining({
          tenantId: 1,
          key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS,
          value: '8000',
          category: 'budget',
        }),
      }),
    );
    // Audit row written with CREATE action (no prior row).
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity: 'TenantSetting',
          action: 'CREATE',
          entityId: 99,
          userId: 7,
          tenantId: 1,
        }),
      }),
    );
  });

  test('rejects unknown key with 400 INVALID_SETTING_KEY + allowed list', async () => {
    const res = await request(makeApp())
      .put('/api/tenant-settings/not_a_real_key')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ value: '123' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SETTING_KEY' });
    expect(res.body.allowedKeys).toEqual(expect.arrayContaining(Object.values(KEYS)));
    // Each canonical key name MUST appear in the human-readable error string
    // so an operator copy-pasting the message into the UI sees the right options.
    expect(res.body.error).toMatch(/budgetCap_adsgpt_monthly_usd_cents/);
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test('rejects missing value body with 400 MISSING_VALUE', async () => {
    const res = await request(makeApp())
      .put(`/api/tenant-settings/${KEYS.LLM_MONTHLY_CAP_USD_CENTS}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_VALUE' });
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test('USER role cannot PUT (403 RBAC_DENIED)', async () => {
    const res = await request(makeApp())
      .put(`/api/tenant-settings/${KEYS.LLM_MONTHLY_CAP_USD_CENTS}`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ value: '5000' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/tenant-settings/:key', () => {
  test('happy path returns 204 + writes DELETE audit', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      id: 42,
      value: '9000',
    });
    prisma.tenantSetting.delete.mockResolvedValue({ id: 42 });
    const res = await request(makeApp())
      .delete(`/api/tenant-settings/${KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.tenantSetting.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_key: { tenantId: 1, key: KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS } },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity: 'TenantSetting',
          action: 'DELETE',
          entityId: 42,
          userId: 7,
          tenantId: 1,
        }),
      }),
    );
  });

  test('returns 404 when no row exists', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete(`/api/tenant-settings/${KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tenantSetting.delete).not.toHaveBeenCalled();
  });
});
