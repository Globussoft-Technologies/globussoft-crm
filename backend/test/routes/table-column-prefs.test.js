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

  test('leads catalog carries the data-backed Freshsales-parity set with labels', async () => {
    const res = await request(makeApp()).get('/api/table-column-prefs/leads');

    expect(res.status).toBe(200);
    const byKey = new Map(res.body.availableColumns.map((c) => [c.key, c.label]));
    expect(byKey.get('status')).toBe('Status');
    expect(byKey.get('title')).toBe('Job Title');
    expect(byKey.get('firstName')).toBe('First Name');
    expect(byKey.get('lastName')).toBe('Last Name');
    expect(byKey.get('website')).toBe('Website URL');
    expect(byKey.get('linkedin')).toBe('LinkedIn');
    expect(byKey.get('industry')).toBe('Service Type');
    expect(byKey.get('companySize')).toBe('No Of Employee');
    expect(byKey.get('subBrand')).toBe('Sub-brand');
    expect(byKey.get('description')).toBe('Note');
    expect(byKey.get('stateCode')).toBe('State');
    expect(byKey.get('firstTouchSource')).toBe('First Touch Source');
    expect(byKey.get('lastTouchSource')).toBe('Last Touch Source');
    expect(byKey.get('treatmentOfInterest')).toBe('Treatment Of Interest');
    expect(byKey.get('birthDate')).toBe('Birth Date');
    expect(byKey.get('anniversary')).toBe('Anniversary');
    expect(byKey.get('gst')).toBe('GSTIN');
    expect(byKey.get('billingStateCode')).toBe('Billing State Code');
    expect(res.body.availableColumns.find((c) => c.key === 'actions')).toMatchObject({
      label: 'Actions',
      lockedVisible: true,
    });
  });

  test('new leads-only keys do not leak into the contacts catalog', async () => {
    const res = await request(makeApp()).get('/api/table-column-prefs/contacts');

    expect(res.status).toBe(200);
    const keys = res.body.availableColumns.map((c) => c.key);
    for (const k of ['status', 'title', 'firstName', 'lastName', 'website', 'linkedin', 'industry', 'companySize', 'description', 'stateCode', 'firstTouchSource', 'lastTouchSource', 'treatmentOfInterest', 'birthDate', 'anniversary', 'gst', 'billingStateCode', 'actions']) {
      // NOTE: contacts already ships `status` — everything else must stay out.
      if (k === 'status') {
        expect(keys).toContain(k);
      } else {
        expect(keys).not.toContain(k);
      }
    }
  });

  test('PUT accepts visible lists containing the new keys (unknown keys still dropped)', async () => {
    const res = await request(makeApp())
      .put('/api/table-column-prefs/leads')
      .send({ visible: ['name', 'status', 'title', 'website', 'nope-not-a-column'] });

    expect(res.status).toBe(200);
    // Locked columns restored (name first, actions appended), known keys kept, unknown dropped.
    expect(res.body.visible).toEqual(['name', 'status', 'title', 'website', 'actions']);
    expect(prisma.tableColumnPreference.upsert).toHaveBeenCalled();
  });
});
