// @ts-check
/**
 * Unit tests for backend/routes/zapier.js — pins the Zapier-integration
 * surface that exposes CRM triggers + actions + webhook subscriptions to
 * external automation platforms (Zapier, Make, n8n).
 *
 * Why this file exists
 * ────────────────────
 * zapier.js is a 379-LOC route surface with two distinct auth modes:
 *   (a) ApiKey-bearer auth   — /actions/:key/execute + /webhook (machine-to-machine)
 *   (b) staff JWT verifyToken — /subscriptions + /subscribe + /subscribe/:id (UI use)
 *   (c) no auth              — /triggers + /actions + /test/:trigger (metadata only)
 *
 * Historical contracts to pin:
 *   - TRIGGERS and ACTIONS catalogues are the public Zap-developer schema.
 *     The frontend Zap setup wizard reads field shape from /actions; the
 *     polling-trigger sample shape from /test/:trigger. Catalogue shape
 *     drift would silently break every customer's deployed Zap.
 *   - /actions/:key/execute REQUIRES a Bearer ApiKey (NOT a staff JWT) —
 *     the ApiKey row carries the {userId, tenantId} that the executeAction
 *     dispatch uses to scope the create. A stolen JWT must NOT work here.
 *   - /webhook is similarly ApiKey-gated but reads the key from req.body
 *     (Zapier's webhook-target convention), NOT the Authorization header.
 *   - validateRequiredFields enforces server-side validation of the action's
 *     declared required fields. The frontend wizard validates client-side
 *     but a Zap-runtime call may omit fields; the 400 must list them.
 *   - executeAction dispatches by switch on actionKey; an unknown key
 *     throws a 404-tagged error that bubbles to the outer catch.
 *   - Webhook subscriptions (Webhook model) are tenant-scoped + user-scoped:
 *     listing returns only the requesting user's own subscriptions (NOT
 *     every tenant member's). Cross-user DELETE returns 404.
 *   - source default — when /actions/create_contact omits source, it's set
 *     to "Zapier" so deal attribution reports can split Zap-originated
 *     leads from CRM-native leads.
 *
 * What this file pins (16 cases across 7 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET /triggers — returns the 5-entry catalogue with key/name/sample.
 *   2. GET /actions — returns the 4-entry catalogue with field declarations.
 *   3. GET /test/:trigger — returns [sample] (Zapier polling-trigger shape).
 *   4. GET /test/:trigger — unknown trigger key returns 404.
 *   5. POST /actions/:key/execute — happy path: ApiKey-auth + valid body →
 *      201 + executed record + tenantId scoping from the ApiKey.
 *   6. POST /actions/:key/execute — unknown action key → 404.
 *   7. POST /actions/:key/execute — missing Bearer header → 401.
 *   8. POST /actions/:key/execute — Bearer present but key not in DB → 401.
 *   9. POST /actions/:key/execute — missing required field → 400 with the
 *      missing-fields list.
 *  10. POST /actions/:key/execute — create_contact defaults source="Zapier"
 *      when body.source is omitted.
 *  11. POST /webhook — happy path: triggerKey=contact_created + valid
 *      payload + apiKey → 201 + record created via executeAction.
 *  12. POST /webhook — missing triggerKey or apiKey → 400.
 *  13. POST /webhook — invalid apiKey → 401.
 *  14. POST /webhook — unknown triggerKey → 400.
 *  15. POST /webhook — deal_won default stage='won' when payload omits stage.
 *  16. GET /subscriptions — verifyToken-gated; lists ONLY the calling
 *      user's active Webhook rows under their tenantId.
 *  17. POST /subscribe — happy path 201; cross-user list isolation pinned.
 *  18. DELETE /subscribe/:id — happy delete; cross-user id → 404.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/pipelines.test.js — prisma singleton patch
 * BEFORE requiring the router, real JWT bearer signed with
 * config/secrets.JWT_SECRET so the real verifyToken middleware passes
 * for the staff-JWT-gated endpoints. ApiKey is patched onto prisma so the
 * resolveApiKey helper can look it up.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching (BEFORE require-time) ──────────────────────
prisma.apiKey = {
  findUnique: vi.fn(),
  update: vi.fn().mockResolvedValue(undefined),
};
prisma.contact = prisma.contact || {};
prisma.contact.create = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.create = vi.fn();
prisma.activity = prisma.activity || {};
prisma.activity.create = vi.fn();
prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.create = vi.fn();
prisma.webhook = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};

// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// stub the surface so any incidental call returns "not revoked".
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

const zapierRouter = requireCJS('../../routes/zapier');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/zapier', zapierRouter);
  return app;
}

beforeEach(() => {
  prisma.apiKey.findUnique.mockReset();
  prisma.apiKey.update.mockReset();
  prisma.apiKey.update.mockResolvedValue(undefined);
  prisma.contact.create.mockReset();
  prisma.deal.create.mockReset();
  prisma.activity.create.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.webhook.findMany.mockReset();
  prisma.webhook.findFirst.mockReset();
  prisma.webhook.create.mockReset();
  prisma.webhook.delete.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────
// GET /triggers + /actions + /test/:trigger — metadata catalogue (no auth)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /triggers + /actions + /test/:trigger — public metadata', () => {
  test('GET /triggers returns the 5-entry catalogue with key+name+description+sample', async () => {
    const res = await request(makeApp()).get('/api/zapier/triggers');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
    const keys = res.body.map((t) => t.key);
    expect(keys).toEqual([
      'contact_created',
      'deal_won',
      'deal_stage_changed',
      'task_completed',
      'form_submitted',
    ]);
    for (const t of res.body) {
      expect(t).toEqual(expect.objectContaining({
        key: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        sample: expect.any(Object),
      }));
    }
  });

  test('GET /actions returns the 4-entry catalogue with field declarations', async () => {
    const res = await request(makeApp()).get('/api/zapier/actions');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body.map((a) => a.key)).toEqual([
      'create_contact', 'create_deal', 'add_note', 'send_email',
    ]);

    // create_contact has name + email as required fields
    const createContact = res.body.find((a) => a.key === 'create_contact');
    const requiredFields = createContact.fields.filter((f) => f.required).map((f) => f.key);
    expect(requiredFields).toEqual(['name', 'email']);

    // add_note requires contactId + description
    const addNote = res.body.find((a) => a.key === 'add_note');
    expect(addNote.fields.filter((f) => f.required).map((f) => f.key))
      .toEqual(['contactId', 'description']);
  });

  test('GET /test/:trigger returns [sample] (Zapier polling shape)', async () => {
    const res = await request(makeApp()).get('/api/zapier/test/contact_created');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      name: expect.any(String),
      email: expect.any(String),
    }));
  });

  test('GET /test/:trigger with unknown trigger key returns 404', async () => {
    const res = await request(makeApp()).get('/api/zapier/test/nonexistent_trigger');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/unknown trigger/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /actions/:key/execute — ApiKey-gated action dispatch
// ─────────────────────────────────────────────────────────────────────────

describe('POST /actions/:key/execute — ApiKey-gated action dispatch', () => {
  test('happy path: valid ApiKey + valid body → 201 with executed record + tenantId from ApiKey', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 999, keySecret: 'glbs_test_key', userId: 7, tenantId: 42,
    });
    prisma.contact.create.mockResolvedValue({
      id: 555, name: 'Jane Smith', email: 'jane@example.com', tenantId: 42,
    });

    const res = await request(makeApp())
      .post('/api/zapier/actions/create_contact/execute')
      .set('Authorization', 'Bearer glbs_test_key')
      .send({ name: 'Jane Smith', email: 'jane@example.com', source: 'Webinar' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      action: 'create_contact',
      record: expect.objectContaining({ id: 555 }),
    });
    // Tenant + user scoping from ApiKey
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Jane Smith',
        email: 'jane@example.com',
        source: 'Webinar',
        tenantId: 42,
        assignedToId: 7,
      }),
    });
  });

  test('unknown action key returns 404', async () => {
    const res = await request(makeApp())
      .post('/api/zapier/actions/teleport_user/execute')
      .set('Authorization', 'Bearer glbs_test_key')
      .send({ foo: 'bar' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/unknown action/i);
  });

  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp())
      .post('/api/zapier/actions/create_contact/execute')
      .send({ name: 'Jane', email: 'jane@example.com' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or missing api key/i);
    // contact.create must NOT have fired without a valid key
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('Bearer present but key not in DB returns 401', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/zapier/actions/create_contact/execute')
      .set('Authorization', 'Bearer glbs_nonexistent_key')
      .send({ name: 'Jane', email: 'jane@example.com' });

    expect(res.status).toBe(401);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('missing required field returns 400 with missing-fields list', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 999, keySecret: 'glbs_test_key', userId: 7, tenantId: 42,
    });

    const res = await request(makeApp())
      .post('/api/zapier/actions/create_contact/execute')
      .set('Authorization', 'Bearer glbs_test_key')
      .send({ name: 'Jane Only' }); // email omitted

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing required fields/i);
    expect(res.body.missing).toEqual(['email']);
    // contact.create blocked by the validator
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('create_contact defaults source="Zapier" when body.source is omitted', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 999, keySecret: 'glbs_test_key', userId: 7, tenantId: 42,
    });
    prisma.contact.create.mockResolvedValue({ id: 1, tenantId: 42 });

    await request(makeApp())
      .post('/api/zapier/actions/create_contact/execute')
      .set('Authorization', 'Bearer glbs_test_key')
      .send({ name: 'Jane Smith', email: 'jane@example.com' });

    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: 'Zapier', status: 'Lead' }),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /webhook — public webhook ingress (apiKey in body, not header)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /webhook — public ingress (apiKey in body)', () => {
  test('happy path: triggerKey=contact_created + valid payload → 201 + record created', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 999, keySecret: 'glbs_webhook_key', userId: 11, tenantId: 13,
    });
    prisma.contact.create.mockResolvedValue({
      id: 8888, name: 'Webhook User', tenantId: 13,
    });

    const res = await request(makeApp())
      .post('/api/zapier/webhook')
      .send({
        triggerKey: 'contact_created',
        apiKey: 'glbs_webhook_key',
        payload: { name: 'Webhook User', email: 'wh@example.com' },
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, recordId: 8888 });
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Webhook User',
        email: 'wh@example.com',
        tenantId: 13,
        assignedToId: 11,
      }),
    });
  });

  test('missing triggerKey or apiKey returns 400', async () => {
    const res1 = await request(makeApp())
      .post('/api/zapier/webhook')
      .send({ apiKey: 'glbs_key', payload: {} });
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/triggerkey and apikey are required/i);

    const res2 = await request(makeApp())
      .post('/api/zapier/webhook')
      .send({ triggerKey: 'contact_created', payload: {} });
    expect(res2.status).toBe(400);
  });

  test('invalid apiKey returns 401', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/zapier/webhook')
      .send({
        triggerKey: 'contact_created',
        apiKey: 'glbs_bogus',
        payload: { name: 'x', email: 'x@example.com' },
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid api key/i);
  });

  test('unknown triggerKey returns 400', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 999, keySecret: 'glbs_key', userId: 11, tenantId: 13,
    });

    const res = await request(makeApp())
      .post('/api/zapier/webhook')
      .send({
        triggerKey: 'lunch_delivered',
        apiKey: 'glbs_key',
        payload: {},
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown triggerkey/i);
  });

  test('deal_won defaults stage="won" when payload omits stage', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 999, keySecret: 'glbs_key', userId: 11, tenantId: 13,
    });
    prisma.deal.create.mockResolvedValue({ id: 200, tenantId: 13 });

    const res = await request(makeApp())
      .post('/api/zapier/webhook')
      .send({
        triggerKey: 'deal_won',
        apiKey: 'glbs_key',
        payload: { title: 'Closed Deal', amount: '5000' },
      });

    expect(res.status).toBe(201);
    expect(prisma.deal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: 'Closed Deal',
        stage: 'won',
        tenantId: 13,
        ownerId: 11,
      }),
    });
  });

  test('contact_created payload missing name OR email returns 400', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 999, keySecret: 'glbs_key', userId: 11, tenantId: 13,
    });

    const res = await request(makeApp())
      .post('/api/zapier/webhook')
      .send({
        triggerKey: 'contact_created',
        apiKey: 'glbs_key',
        payload: { name: 'no-email-here' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and email/i);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /subscriptions — staff-JWT-gated subscription list (tenant + user scoped)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /subscriptions — staff-JWT-gated, tenant + user scoped', () => {
  test('returns the calling user\'s active subscriptions under their tenantId', async () => {
    prisma.webhook.findMany.mockResolvedValue([
      { id: 1, event: 'contact_created', targetUrl: 'https://hooks.example/contacts',
        isActive: true, userId: 7, tenantId: 1, createdAt: new Date() },
      { id: 2, event: 'deal_won', targetUrl: 'https://hooks.example/wins',
        isActive: true, userId: 7, tenantId: 1, createdAt: new Date() },
    ]);

    const res = await request(makeApp())
      .get('/api/zapier/subscriptions')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.webhook.findMany).toHaveBeenCalledWith({
      where: { userId: 7, tenantId: 1, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('no Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/zapier/subscriptions');

    expect(res.status).toBe(401);
    expect(prisma.webhook.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /subscribe — create webhook subscription
// ─────────────────────────────────────────────────────────────────────────

describe('POST /subscribe — create webhook subscription', () => {
  test('happy path: returns 201 + persisted row with user + tenant scope', async () => {
    prisma.webhook.create.mockResolvedValue({
      id: 77, event: 'contact_created', targetUrl: 'https://hooks.example/x',
      isActive: true, userId: 7, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/zapier/subscribe')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }))
      .send({ event: 'contact_created', targetUrl: 'https://hooks.example/x' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ id: 77 }));
    expect(prisma.webhook.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'contact_created',
        targetUrl: 'https://hooks.example/x',
        isActive: true,
        userId: 7,
        tenantId: 1,
      }),
    });
  });

  test('missing event or targetUrl → 400', async () => {
    const app = makeApp();

    const res1 = await request(app)
      .post('/api/zapier/subscribe')
      .set('Authorization', makeBearer())
      .send({ targetUrl: 'https://hooks.example/x' });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post('/api/zapier/subscribe')
      .set('Authorization', makeBearer())
      .send({ event: 'contact_created' });
    expect(res2.status).toBe(400);

    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /subscribe/:id — remove webhook subscription (user-scoped)
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /subscribe/:id — remove webhook subscription', () => {
  test('happy delete returns { success: true } + calls prisma.webhook.delete', async () => {
    prisma.webhook.findFirst.mockResolvedValue({
      id: 77, event: 'contact_created', targetUrl: 'https://hooks.example/x',
      userId: 7, tenantId: 1, isActive: true,
    });
    prisma.webhook.delete.mockResolvedValue({ id: 77 });

    const res = await request(makeApp())
      .delete('/api/zapier/subscribe/77')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.webhook.findFirst).toHaveBeenCalledWith({
      where: { id: 77, userId: 7, tenantId: 1 },
    });
    expect(prisma.webhook.delete).toHaveBeenCalledWith({ where: { id: 77 } });
  });

  test('cross-user id (findFirst returns null) → 404', async () => {
    // Subscription belongs to a different user — findFirst (scoped to userId)
    // returns null, route emits 404 without touching delete.
    prisma.webhook.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/zapier/subscribe/99')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.webhook.delete).not.toHaveBeenCalled();
  });
});
