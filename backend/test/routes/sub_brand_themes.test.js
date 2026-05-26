// @ts-check
/**
 * #876 + DD-5.3 — /api/tenant/sub-brand-themes contract test.
 *
 * Pins the GET/PUT contract for backend/routes/sub_brand_themes.js
 * (tick #183, agent A). The Tenant.subBrandThemes column shipped tick #182
 * (commit 9fef1c80) as String? @db.Text, storing the per-sub-brand theme
 * default map as JSON (e.g. {"tmc":"light","rfu":"dark"}).
 *
 * Test pattern mirrors backend/test/routes/embassy_rules.test.js — patch the
 * prisma singleton BEFORE requiring the router so the require()'d router
 * binds to the spy'd functions. JWT minted with the same dev fallback
 * secret the middleware uses; verifyToken runs in the chain (no bypass)
 * so auth-gates + RBAC are exercised end-to-end.
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The e2e-full / api_tests gates exercise the
 * round-trip against real MySQL via the e2e/tests/*-api.spec.js layer
 * if added in a follow-up tick.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.tenant.update = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const subBrandThemesRouter = requireCJS('../../routes/sub_brand_themes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tenant/sub-brand-themes', subBrandThemesRouter);
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
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.update.mockReset();
});

describe('GET /api/tenant/sub-brand-themes', () => {
  test('returns empty { themes: {} } for fresh tenant (column null)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ subBrandThemes: null });
    const res = await request(makeApp())
      .get('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ themes: {} });
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        select: { subBrandThemes: true },
      }),
    );
  });

  test('returns parsed themes for tenant with stored config', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandThemes: JSON.stringify({ tmc: 'light', rfu: 'dark' }),
    });
    const res = await request(makeApp())
      .get('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ themes: { tmc: 'light', rfu: 'dark' } });
  });

  test('tolerates legacy malformed JSON by returning empty {} (no 500)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandThemes: 'not-json-at-all{{',
    });
    const res = await request(makeApp())
      .get('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ themes: {} });
  });
});

describe('PUT /api/tenant/sub-brand-themes', () => {
  test('happy path: valid themes object → 200 with merged state', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ subBrandThemes: null });
    prisma.tenant.update.mockResolvedValue({ id: 1 });
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send({ themes: { tmc: 'light', rfu: 'dark' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ themes: { tmc: 'light', rfu: 'dark' } });
    // Stored value is the stringified merged map.
    const updateCall = prisma.tenant.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 1 });
    expect(typeof updateCall.data.subBrandThemes).toBe('string');
    expect(JSON.parse(updateCall.data.subBrandThemes)).toEqual({
      tmc: 'light',
      rfu: 'dark',
    });
  });

  test('partial merge: PUT {rfu:dark} keeps existing {tmc:light}', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandThemes: JSON.stringify({ tmc: 'light' }),
    });
    prisma.tenant.update.mockResolvedValue({ id: 1 });
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send({ themes: { rfu: 'dark' } });
    expect(res.status).toBe(200);
    expect(res.body.themes).toEqual({ tmc: 'light', rfu: 'dark' });
    const updateCall = prisma.tenant.update.mock.calls[0][0];
    expect(JSON.parse(updateCall.data.subBrandThemes)).toEqual({
      tmc: 'light',
      rfu: 'dark',
    });
  });

  test('rejects unknown sub-brand key with 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ themes: { badkey: 'light' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('rejects invalid theme value with 400 INVALID_THEME_VALUE', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ themes: { tmc: 'pink' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_THEME_VALUE' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('rejects malformed body shape with 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ themes: 'not-an-object' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('rejects array as themes shape with 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ themes: ['tmc', 'rfu'] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('rejects missing themes field with 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ tmc: 'light' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('PUT as USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ themes: { tmc: 'light' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('PUT as MANAGER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ themes: { tmc: 'light' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('stored value round-trips through JSON.parse cleanly', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ subBrandThemes: null });
    prisma.tenant.update.mockResolvedValue({ id: 1 });
    await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        themes: {
          tmc: 'light',
          rfu: 'dark',
          travelstall: 'system',
          visasure: 'light',
        },
      });
    const stored = prisma.tenant.update.mock.calls[0][0].data.subBrandThemes;
    expect(() => JSON.parse(stored)).not.toThrow();
    expect(JSON.parse(stored)).toEqual({
      tmc: 'light',
      rfu: 'dark',
      travelstall: 'system',
      visasure: 'light',
    });
  });
});

describe('Cross-tenant isolation', () => {
  test('PUT under tenant 2 scopes update to tenant 2 only', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandThemes: JSON.stringify({ tmc: 'dark' }),
    });
    prisma.tenant.update.mockResolvedValue({ id: 2 });
    const res = await request(makeApp())
      .put('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`)
      .send({ themes: { rfu: 'light' } });
    expect(res.status).toBe(200);
    // Both reads + writes scope on tenantId from the JWT, never the body.
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2 } }),
    );
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2 } }),
    );
  });

  test('GET under tenant 2 returns tenant-2 stored data, not tenant-1', async () => {
    // Caller is tenant 2 → findUnique called with id:2; if backend honoured
    // any body-supplied tenant override, this test would fail.
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandThemes: JSON.stringify({ travelstall: 'system' }),
    });
    const res = await request(makeApp())
      .get('/api/tenant/sub-brand-themes')
      .set('Authorization', `Bearer ${tokenFor('USER', { tenantId: 2 })}`);
    expect(res.status).toBe(200);
    expect(res.body.themes).toEqual({ travelstall: 'system' });
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2 } }),
    );
  });
});
