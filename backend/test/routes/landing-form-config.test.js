// @ts-check

/**
 * Landing-page hero form config — public resolve + allowlist-gated update.
 *
 * Trust boundary pins:
 *   - GET / is public and never leaks the admin allowlist.
 *   - PUT requires a logged-in user whose DB email is on
 *     LANDING_FORM_ADMIN_EMAILS (client-supplied email is never trusted).
 *   - Only active generic-scope forms of the PUBLIC_LEAD_TENANT_ID tenant
 *     are selectable.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRequire } from 'node:module';

import express from 'express';

import request from 'supertest';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');

/**
 * @param {import('express').Request} _req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
authMw.verifyToken = (_req, _res, next) => next();

prisma.user = prisma.user || {};
prisma.webForm = prisma.webForm || {};
prisma.tenantSetting = prisma.tenantSetting || {};

prisma.user.findUnique = vi.fn();
prisma.webForm.findFirst = vi.fn();
prisma.tenantSetting.findUnique = vi.fn();
prisma.tenantSetting.upsert = vi.fn();

const landingRouter = requireCJS('../../routes/landing_form_config');

const TENANT_ID = 4;
const ADMIN_USER_ID = 11;
const OTHER_USER_ID = 12;

function makeApp(userId) {
  const app = express();

  app.use(express.json());

  app.use((/** @type {any} */ req, /** @type {import('express').Response} */ _res, /** @type {import('express').NextFunction} */ next) => {
    req.user = { userId, tenantId: TENANT_ID, role: 'ADMIN' };

    next();
  });

  app.use('/api/landing-form-config', landingRouter);

  return app;
}

const ENV_KEYS = ['LANDING_FORM_ADMIN_EMAILS', 'PUBLIC_LEAD_TENANT_ID'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.PUBLIC_LEAD_TENANT_ID = String(TENANT_ID);
  process.env.LANDING_FORM_ADMIN_EMAILS = 'owner@example.com';
  prisma.user.findUnique.mockReset();
  prisma.webForm.findFirst.mockReset();
  prisma.tenantSetting.findUnique.mockReset();
  prisma.tenantSetting.upsert.mockReset().mockResolvedValue({ id: 1 });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const ACTIVE_GENERIC_FORM = { id: 9, name: 'Landing Page', tenantId: TENANT_ID, isActive: true, scope: 'generic' };

describe('GET /api/landing-form-config (public)', () => {
  test('resolves the stored setting when valid', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ webFormId: 9 }),
    });
    prisma.webForm.findFirst.mockImplementation(async (args) => {
      if (args.where && args.where.id !== undefined) return ACTIVE_GENERIC_FORM;
      return { id: 9, name: 'Landing Page' };
    });

    const res = await request(makeApp(OTHER_USER_ID)).get('/api/landing-form-config');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ webFormId: 9, webFormName: 'Landing Page' });
    expect(JSON.stringify(res.body)).not.toContain('owner@example.com');
  });

  test('missing PUBLIC_LEAD_TENANT_ID → 503 LANDING_FORM_NOT_CONFIGURED', async () => {
    delete process.env.PUBLIC_LEAD_TENANT_ID;

    const res = await request(makeApp(OTHER_USER_ID)).get('/api/landing-form-config');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'LANDING_FORM_NOT_CONFIGURED' });
  });

  test('no selectable form → 503 LANDING_FORM_UNAVAILABLE', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    prisma.webForm.findFirst.mockResolvedValue(null);

    const res = await request(makeApp(OTHER_USER_ID)).get('/api/landing-form-config');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'LANDING_FORM_UNAVAILABLE' });
  });
});

describe('GET /api/landing-form-config/access', () => {
  test('allowlisted DB email → canManage true', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'Owner@Example.com' });

    const res = await request(makeApp(ADMIN_USER_ID)).get('/api/landing-form-config/access');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ canManage: true });
  });

  test('other email → canManage false (no allowlist leak)', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'user@crm.com' });

    const res = await request(makeApp(OTHER_USER_ID)).get('/api/landing-form-config/access');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ canManage: false });
  });
});

describe('PUT /api/landing-form-config', () => {
  test('non-allowlisted caller → 403 LANDING_FORM_FORBIDDEN', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'user@crm.com' });

    const res = await request(makeApp(OTHER_USER_ID))
      .put('/api/landing-form-config')
      .send({ webFormId: 9 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'LANDING_FORM_FORBIDDEN' });
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test('bad webFormId → 400 INVALID_WEB_FORM_ID', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'owner@example.com' });

    const res = await request(makeApp(ADMIN_USER_ID))
      .put('/api/landing-form-config')
      .send({ webFormId: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_WEB_FORM_ID' });
  });

  test('foreign/inactive/travel form → 400 INVALID_WEB_FORM', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'owner@example.com' });
    for (const form of [
      { id: 9, tenantId: 999, isActive: true, scope: 'generic' },
      { id: 9, tenantId: TENANT_ID, isActive: false, scope: 'generic' },
      { id: 9, tenantId: TENANT_ID, isActive: true, scope: 'travel' },
      null,
    ]) {
      prisma.webForm.findFirst.mockResolvedValue(form);
      const res = await request(makeApp(ADMIN_USER_ID))
        .put('/api/landing-form-config')
        .send({ webFormId: 9 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_WEB_FORM' });
    }
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test('allowlisted caller + valid form → upsert + envelope', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'owner@example.com' });
    prisma.webForm.findFirst.mockResolvedValue(ACTIVE_GENERIC_FORM);

    const res = await request(makeApp(ADMIN_USER_ID))
      .put('/api/landing-form-config')
      .send({ webFormId: 9 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ webFormId: 9, webFormName: 'Landing Page' });
    expect(prisma.tenantSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_key: { tenantId: TENANT_ID, key: 'landing.form.webFormId' } },
      }),
    );
    const written = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(JSON.parse(written.create.value)).toMatchObject({ webFormId: 9, updatedByUserId: ADMIN_USER_ID });
  });
});
