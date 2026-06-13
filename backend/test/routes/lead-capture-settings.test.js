// @ts-check
/**
 * Unit tests for /api/settings/lead-capture (G009).
 *
 * Pins the contract for the multi-channel lead-capture admin surface:
 *
 *   1. GET happy path — returns { channels, cooldowns, formRoutingMappings,
 *      allowedChannels, cooldownRange } with the stored JSON parsed.
 *   2. GET with null columns → channels/cooldowns/mappings all empty.
 *   3. GET filters out non-canonical channel keys from stored blobs (forward-
 *      compatible: future channels added on the backend won't poison the UI
 *      until they're whitelisted here too).
 *   4. PUT happy path — partial merge of channels + cooldowns; only the
 *      passed-in keys are overwritten, others stay as previously stored.
 *   5. PUT clamps cooldowns to [0, 86400] and floors fractional inputs.
 *   6. PUT drops unknown channels from both blobs.
 *   7. PUT rejects non-object channels/cooldowns body shape → 400 INVALID_BODY.
 *   8. POST mapping happy path — returns 201 with the projection envelope.
 *   9. POST mapping unique violation → 409 DUPLICATE_MAPPING.
 *  10. POST mapping rejects unknown channel → 400 INVALID_CHANNEL.
 *  11. POST mapping rejects malformed externalFormId → 400
 *      INVALID_EXTERNAL_FORM_ID.
 *  12. POST mapping sanitises notes (strips dangerous HTML).
 *  13. PUT mapping happy path — partial fields update; back-shape preserved.
 *  14. PUT mapping cross-tenant (id not owned by req.user.tenantId) → 404
 *      NOT_FOUND, prisma.update never called.
 *  15. DELETE mapping happy path → 204.
 *  16. DELETE mapping cross-tenant → 404 NOT_FOUND.
 *  17. DELETE mapping invalid id → 400 INVALID_ID.
 *
 * Pattern mirrors backend/test/routes/admin-embed-allowlist.test.js — patch
 * the prisma module-exports surface BEFORE requiring the router so the
 * router's `require('../lib/prisma')` captures the spies. Auth middleware
 * is bypassed via the same monkey-patch.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const prismaMod = requireCJS('../../lib/prisma');
prismaMod.tenant = prismaMod.tenant || {};
prismaMod.tenant.findUnique = vi.fn();
prismaMod.tenant.update = vi.fn();
prismaMod.formRoutingMapping = prismaMod.formRoutingMapping || {};
prismaMod.formRoutingMapping.findMany = vi.fn();
prismaMod.formRoutingMapping.findFirst = vi.fn();
prismaMod.formRoutingMapping.create = vi.fn();
prismaMod.formRoutingMapping.update = vi.fn();
prismaMod.formRoutingMapping.delete = vi.fn();

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

import express from 'express';
import request from 'supertest';

const router = requireCJS('../../routes/lead_capture_settings');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/settings/lead-capture', router);
  return app;
}

beforeEach(() => {
  prismaMod.tenant.findUnique.mockReset();
  prismaMod.tenant.update.mockReset();
  prismaMod.formRoutingMapping.findMany.mockReset();
  prismaMod.formRoutingMapping.findFirst.mockReset();
  prismaMod.formRoutingMapping.create.mockReset();
  prismaMod.formRoutingMapping.update.mockReset();
  prismaMod.formRoutingMapping.delete.mockReset();
});

describe('GET /api/settings/lead-capture', () => {
  test('1. happy path: returns parsed envelope', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      leadCaptureChannelsJson: JSON.stringify({ web_form: true, whatsapp: false }),
      leadCaptureCooldownsJson: JSON.stringify({ web_form: 3600 }),
    });
    prismaMod.formRoutingMapping.findMany.mockResolvedValue([
      {
        id: 1,
        channel: 'meta_ad',
        externalFormId: '12345',
        subBrand: 'tmc',
        assignedTeamId: null,
        isActive: true,
        notes: null,
        createdAt: new Date('2026-06-13T00:00:00Z'),
        updatedAt: new Date('2026-06-13T00:00:00Z'),
      },
    ]);
    const res = await request(makeApp({ tenantId: 5 })).get('/api/settings/lead-capture');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual({ web_form: true, whatsapp: false });
    expect(res.body.cooldowns).toEqual({ web_form: 3600 });
    expect(res.body.formRoutingMappings).toHaveLength(1);
    expect(res.body.formRoutingMappings[0]).toMatchObject({
      channel: 'meta_ad', externalFormId: '12345', subBrand: 'tmc', isActive: true,
    });
    expect(res.body.allowedChannels).toContain('web_form');
    expect(res.body.cooldownRange).toEqual({ min: 0, max: 86400 });
  });

  test('2. null columns → empty objects', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      leadCaptureChannelsJson: null,
      leadCaptureCooldownsJson: null,
    });
    prismaMod.formRoutingMapping.findMany.mockResolvedValue([]);
    const res = await request(makeApp({ tenantId: 5 })).get('/api/settings/lead-capture');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual({});
    expect(res.body.cooldowns).toEqual({});
    expect(res.body.formRoutingMappings).toEqual([]);
  });

  test('3. drops unknown channel keys from stored blobs', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      leadCaptureChannelsJson: JSON.stringify({
        web_form: true, gibberish_channel: true, faked_channel: false,
      }),
      leadCaptureCooldownsJson: JSON.stringify({
        web_form: 60, gibberish_channel: 999,
      }),
    });
    prismaMod.formRoutingMapping.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/settings/lead-capture');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual({ web_form: true });
    expect(res.body.cooldowns).toEqual({ web_form: 60 });
  });
});

describe('PUT /api/settings/lead-capture', () => {
  test('4. partial merge: missing keys retain stored value', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      leadCaptureChannelsJson: JSON.stringify({ web_form: true, whatsapp: false }),
      leadCaptureCooldownsJson: JSON.stringify({ web_form: 60 }),
    });
    prismaMod.tenant.update.mockResolvedValue({});
    const res = await request(makeApp({ tenantId: 42 }))
      .put('/api/settings/lead-capture')
      .send({ channels: { whatsapp: true } });
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual({ web_form: true, whatsapp: true });
    expect(res.body.cooldowns).toEqual({ web_form: 60 });
    const updArgs = prismaMod.tenant.update.mock.calls[0][0];
    expect(JSON.parse(updArgs.data.leadCaptureChannelsJson)).toEqual({
      web_form: true, whatsapp: true,
    });
  });

  test('5. clamps cooldowns + floors fractional inputs', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      leadCaptureChannelsJson: null, leadCaptureCooldownsJson: null,
    });
    prismaMod.tenant.update.mockResolvedValue({});
    const res = await request(makeApp())
      .put('/api/settings/lead-capture')
      .send({ cooldowns: { web_form: -50, whatsapp: 999999, email: 60.7 } });
    expect(res.status).toBe(200);
    expect(res.body.cooldowns).toEqual({
      web_form: 0, whatsapp: 86400, email: 60,
    });
  });

  test('6. drops unknown channels from incoming blobs', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      leadCaptureChannelsJson: null, leadCaptureCooldownsJson: null,
    });
    prismaMod.tenant.update.mockResolvedValue({});
    const res = await request(makeApp())
      .put('/api/settings/lead-capture')
      .send({
        channels: { web_form: true, made_up_channel: true },
        cooldowns: { web_form: 60, faked_channel: 30 },
      });
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual({ web_form: true });
    expect(res.body.cooldowns).toEqual({ web_form: 60 });
  });

  test('7. non-object channels body → 400 INVALID_BODY', async () => {
    const res = await request(makeApp())
      .put('/api/settings/lead-capture')
      .send({ channels: 'not-an-object' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(prismaMod.tenant.findUnique).not.toHaveBeenCalled();
    expect(prismaMod.tenant.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/lead-capture/form-routing-mappings', () => {
  test('8. happy path: 201 + projection envelope', async () => {
    prismaMod.formRoutingMapping.create.mockResolvedValue({
      id: 100, channel: 'meta_ad', externalFormId: '12345', subBrand: 'tmc',
      assignedTeamId: 5, isActive: true, notes: 'ad-camp-1',
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/settings/lead-capture/form-routing-mappings')
      .send({
        channel: 'meta_ad', externalFormId: '12345',
        subBrand: 'tmc', assignedTeamId: 5, notes: 'ad-camp-1',
      });
    expect(res.status).toBe(201);
    expect(res.body.mapping).toMatchObject({
      channel: 'meta_ad', externalFormId: '12345', subBrand: 'tmc',
      assignedTeamId: 5, isActive: true, notes: 'ad-camp-1',
    });
    const createArgs = prismaMod.formRoutingMapping.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(42);
  });

  test('9. duplicate (P2002) → 409 DUPLICATE_MAPPING', async () => {
    const e = new Error('Unique constraint failed');
    e.code = 'P2002';
    prismaMod.formRoutingMapping.create.mockRejectedValue(e);
    const res = await request(makeApp())
      .post('/api/settings/lead-capture/form-routing-mappings')
      .send({ channel: 'meta_ad', externalFormId: '12345' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_MAPPING');
  });

  test('10. unknown channel → 400 INVALID_CHANNEL', async () => {
    const res = await request(makeApp())
      .post('/api/settings/lead-capture/form-routing-mappings')
      .send({ channel: 'martian_ad', externalFormId: '12345' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CHANNEL');
    expect(prismaMod.formRoutingMapping.create).not.toHaveBeenCalled();
  });

  test('11. malformed externalFormId → 400 INVALID_EXTERNAL_FORM_ID', async () => {
    const res = await request(makeApp())
      .post('/api/settings/lead-capture/form-routing-mappings')
      .send({ channel: 'meta_ad', externalFormId: 'has spaces & symbols!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EXTERNAL_FORM_ID');
    expect(prismaMod.formRoutingMapping.create).not.toHaveBeenCalled();
  });

  test('12. sanitises notes (strips HTML)', async () => {
    prismaMod.formRoutingMapping.create.mockResolvedValue({
      id: 1, channel: 'meta_ad', externalFormId: '12345', subBrand: null,
      assignedTeamId: null, isActive: true,
      notes: 'plain text only',
      createdAt: new Date(), updatedAt: new Date(),
    });
    await request(makeApp())
      .post('/api/settings/lead-capture/form-routing-mappings')
      .send({
        channel: 'meta_ad', externalFormId: '12345',
        notes: '<script>alert(1)</script>plain text only',
      });
    const createArgs = prismaMod.formRoutingMapping.create.mock.calls[0][0];
    // sanitizeText strips dangerous tags; the inner text "alert(1)" remains
    // but the script tag itself is gone. Critically: the raw `<script>`
    // string must NOT survive verbatim.
    expect(createArgs.data.notes).not.toMatch(/<script/);
  });
});

describe('PUT /api/settings/lead-capture/form-routing-mappings/:id', () => {
  test('13. happy path: partial update returns envelope', async () => {
    prismaMod.formRoutingMapping.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, channel: 'meta_ad', externalFormId: '999',
    });
    prismaMod.formRoutingMapping.update.mockResolvedValue({
      id: 7, channel: 'meta_ad', externalFormId: '999', subBrand: 'rfu',
      assignedTeamId: null, isActive: false, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/settings/lead-capture/form-routing-mappings/7')
      .send({ subBrand: 'rfu', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.mapping).toMatchObject({
      id: 7, channel: 'meta_ad', subBrand: 'rfu', isActive: false,
    });
  });

  test('14. cross-tenant (findFirst returns null) → 404 NOT_FOUND', async () => {
    prismaMod.formRoutingMapping.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/settings/lead-capture/form-routing-mappings/9999')
      .send({ isActive: false });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(prismaMod.formRoutingMapping.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/settings/lead-capture/form-routing-mappings/:id', () => {
  test('15. happy path: 204', async () => {
    prismaMod.formRoutingMapping.findFirst.mockResolvedValue({
      id: 7, tenantId: 1,
    });
    prismaMod.formRoutingMapping.delete.mockResolvedValue({ id: 7 });
    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/settings/lead-capture/form-routing-mappings/7');
    expect(res.status).toBe(204);
    expect(prismaMod.formRoutingMapping.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('16. cross-tenant → 404 NOT_FOUND, delete never called', async () => {
    prismaMod.formRoutingMapping.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/settings/lead-capture/form-routing-mappings/9999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(prismaMod.formRoutingMapping.delete).not.toHaveBeenCalled();
  });

  test('17. invalid id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .delete('/api/settings/lead-capture/form-routing-mappings/abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prismaMod.formRoutingMapping.findFirst).not.toHaveBeenCalled();
  });
});
