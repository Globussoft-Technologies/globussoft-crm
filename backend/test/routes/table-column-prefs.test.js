// @ts-check

import { beforeEach, describe, expect, test, vi } from 'vitest';

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

prisma.tenant = prisma.tenant || {};
prisma.leadCustomFieldDefinition =
  prisma.leadCustomFieldDefinition || {};
prisma.tableColumnPreference = prisma.tableColumnPreference || {};

prisma.tenant.findUnique = vi.fn();
prisma.leadCustomFieldDefinition.findMany = vi.fn();
prisma.tableColumnPreference.findUnique = vi.fn();
prisma.tableColumnPreference.upsert = vi.fn();

const prefsRouter = requireCJS('../../routes/table_column_preferences');

const TENANT_ID = 11;

const USER_ID = 22;

function makeApp() {
  const app = express();

  app.use(express.json());

  app.use((/** @type {any} */ req, /** @type {import('express').Response} */ _res, /** @type {import('express').NextFunction} */ next) => {
    req.user = { userId: USER_ID, tenantId: TENANT_ID, role: 'ADMIN' };

    next();
  });

  app.use('/api/table-column-prefs', prefsRouter);

  return app;
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'generic' });
  prisma.leadCustomFieldDefinition.findMany.mockReset().mockResolvedValue([]);
  prisma.tableColumnPreference.findUnique.mockReset().mockResolvedValue(null);
  prisma.tableColumnPreference.upsert.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/table-column-prefs/:tableKey — leads catalog', () => {
  test('leads availableColumns contains the Web Form column right after Source', async () => {
    const res = await request(makeApp()).get('/api/table-column-prefs/leads');

    expect(res.status).toBe(200);
    const keys = res.body.availableColumns.map((c) => c.key);
    expect(keys).toContain('webForm');
    expect(res.body.availableColumns.find((c) => c.key === 'webForm')).toMatchObject({
      label: 'Web Form',
    });
    // Sensible default adjacency: form attribution sits next to Source.
    expect(keys.indexOf('webForm')).toBe(keys.indexOf('source') + 1);
  });

  test('first-ever load defaults every builtin visible, including Web Form', async () => {
    const res = await request(makeApp()).get('/api/table-column-prefs/leads');

    expect(res.status).toBe(200);
    expect(res.body.visible).toContain('webForm');
  });

  test('contacts catalog is unchanged (no Web Form column there)', async () => {
    const res = await request(makeApp()).get('/api/table-column-prefs/contacts');

    expect(res.status).toBe(200);
    const keys = res.body.availableColumns.map((c) => c.key);
    expect(keys).not.toContain('webForm');
  });
});
