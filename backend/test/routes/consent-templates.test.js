// @ts-check
/**
 * #612 — wellness consent template CRUD.
 *
 * Pre-fix the consent-capture dropdown had 5 hardcoded procedure options
 * (hair-transplant / botox-fillers / laser / chemical-peel / general)
 * baked into PatientDetail.jsx. Clinics with paediatric or
 * procedure-specific flows had no way to add their own legally-vetted
 * wording. This file pins the new CRUD surface added under
 * /api/wellness/consent-templates.
 *
 * What's pinned
 * -------------
 *   - GET   /api/wellness/consent-templates       lists per-tenant templates
 *           and auto-seeds the 5 starter rows if the tenant's catalogue is
 *           empty (isSeed=true so the UI can hint they're overridable).
 *   - POST  /api/wellness/consent-templates       admin-only; rejects empty
 *           key / label; rejects duplicate keys (per @@unique tenantId,key);
 *           normalises the key to kebab-lowercase.
 *   - PUT   /api/wellness/consent-templates/:id   admin-only; updates label,
 *           body, language, isActive. Key is immutable post-create
 *           (historical ConsentForm rows reference it by string).
 *   - DELETE /api/wellness/consent-templates/:id  admin-only; returns
 *           { success:true, deleted:true } envelope.
 *
 * Test pattern mirrors backend/test/routes/communications.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router so
 * the route's top-level prisma require resolves to the stub.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Stub every prisma surface the wellness router touches at require-time.
prisma.consentTemplate = {
  count: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.consentForm = prisma.consentForm || {};
prisma.patient = prisma.patient || {};
prisma.visit = prisma.visit || {};
prisma.prescription = prisma.prescription || {};
prisma.service = prisma.service || {};
prisma.tenant = prisma.tenant || {};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({ role = 'ADMIN', tenantId = 1, userId = 7, wellnessRole = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.consentTemplate.count.mockReset();
  prisma.consentTemplate.findMany.mockReset();
  prisma.consentTemplate.findFirst.mockReset();
  prisma.consentTemplate.create.mockReset();
  prisma.consentTemplate.update.mockReset();
  prisma.consentTemplate.delete.mockReset();
});

describe('GET /api/wellness/consent-templates', () => {
  test('auto-seeds 5 starter templates when tenant catalogue is empty', async () => {
    prisma.consentTemplate.count.mockResolvedValue(0);
    prisma.consentTemplate.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: Math.random(), ...data })
    );
    prisma.consentTemplate.findMany.mockResolvedValue([
      { id: 1, key: 'hair-transplant', label: 'Hair Transplant', isSeed: true, isActive: true, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/wellness/consent-templates');
    expect(res.status).toBe(200);
    // 5 seeded creates were attempted (auto-seed path).
    expect(prisma.consentTemplate.create).toHaveBeenCalledTimes(5);
    // The seeded rows are flagged isSeed=true.
    for (const call of prisma.consentTemplate.create.mock.calls) {
      expect(call[0].data.isSeed).toBe(true);
      expect(call[0].data.tenantId).toBe(1);
    }
  });

  test('skips auto-seed when the tenant already has rows', async () => {
    prisma.consentTemplate.count.mockResolvedValue(7);
    prisma.consentTemplate.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/wellness/consent-templates');
    expect(prisma.consentTemplate.create).not.toHaveBeenCalled();
  });

  test('lists rows scoped to req.user.tenantId', async () => {
    prisma.consentTemplate.count.mockResolvedValue(1);
    const rows = [{ id: 1, key: 'general', label: 'General', isActive: true, tenantId: 7 }];
    prisma.consentTemplate.findMany.mockResolvedValue(rows);
    const app = makeApp({ tenantId: 7 });
    const res = await request(app).get('/api/wellness/consent-templates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(prisma.consentTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 7 } })
    );
  });
});

describe('POST /api/wellness/consent-templates', () => {
  test('400 when key is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/wellness/consent-templates')
      .send({ label: 'Just a label' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('KEY_REQUIRED');
  });

  test('400 when label is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/wellness/consent-templates')
      .send({ key: 'paediatric' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LABEL_REQUIRED');
  });

  test('409 when key already exists for the tenant', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue({ id: 9, key: 'paediatric', tenantId: 1 });
    const app = makeApp();
    const res = await request(app)
      .post('/api/wellness/consent-templates')
      .send({ key: 'Paediatric', label: 'Paediatric Consent' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_KEY');
  });

  test('creates with normalised kebab-lowercase key', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(null);
    prisma.consentTemplate.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 42, ...data })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/wellness/consent-templates')
      .send({ key: 'Paediatric Consent!', label: 'Paediatric' });
    expect(res.status).toBe(201);
    expect(prisma.consentTemplate.create).toHaveBeenCalled();
    const data = prisma.consentTemplate.create.mock.calls[0][0].data;
    expect(data.key).toBe('paediatric-consent-');
    expect(data.label).toBe('Paediatric');
    expect(data.isSeed).toBe(false);
    expect(data.tenantId).toBe(1);
  });

  test('non-admin role gets 403', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app)
      .post('/api/wellness/consent-templates')
      .send({ key: 'x', label: 'X' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/wellness/consent-templates/:id', () => {
  test('updates label + isActive when row exists for this tenant', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue({ id: 5, key: 'general', label: 'General', tenantId: 1 });
    prisma.consentTemplate.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 5, key: 'general', ...data })
    );
    const app = makeApp();
    const res = await request(app)
      .put('/api/wellness/consent-templates/5')
      .send({ label: 'General Procedure (v2)', isActive: false });
    expect(res.status).toBe(200);
    expect(prisma.consentTemplate.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { label: 'General Procedure (v2)', isActive: false },
    });
  });

  test('404 when row not found in tenant scope', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .put('/api/wellness/consent-templates/9999')
      .send({ label: 'X' });
    expect(res.status).toBe(404);
  });

  test('non-admin role gets 403', async () => {
    const app = makeApp({ role: 'MANAGER' });
    const res = await request(app)
      .put('/api/wellness/consent-templates/5')
      .send({ label: 'X' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/wellness/consent-templates/:id', () => {
  test('deletes when row exists for this tenant', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.consentTemplate.delete.mockResolvedValue({ id: 5 });
    const app = makeApp();
    const res = await request(app).delete('/api/wellness/consent-templates/5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, deleted: true, id: 5 }));
    expect(prisma.consentTemplate.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  test('404 when row not in tenant scope', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).delete('/api/wellness/consent-templates/9999');
    expect(res.status).toBe(404);
  });

  test('non-admin role gets 403', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app).delete('/api/wellness/consent-templates/5');
    expect(res.status).toBe(403);
  });
});
