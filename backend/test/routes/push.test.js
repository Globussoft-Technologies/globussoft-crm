// @ts-check
/**
 * Unit + integration tests for backend/routes/push.js — pins the Web Push
 * subscription + send + send-test + send-campaign + templates + VAPID key
 * contracts.
 *
 * Why this file exists
 * ────────────────────
 *   routes/push.js is a 212-LOC multi-tier module:
 *     1. PUBLIC endpoints — POST /subscribe/visitor (website visitor opt-in)
 *        + GET /vapid-key have NO auth. The visitor subscribe path defaults
 *        to tenantId=1 unless a contactId is supplied that resolves to a
 *        different tenant. The vapid-key endpoint exposes only the PUBLIC
 *        half of the VAPID keypair (never the private key).
 *     2. AUTHED CRM endpoints — POST /subscribe, DELETE /unsubscribe,
 *        POST /send, POST /send-test, POST /send-campaign, /templates CRUD,
 *        GET /stats. All tenant-scoped via req.user.tenantId.
 *     3. CROSS-TENANT GUARD — POST /send only targets users with
 *        `tenantId === req.user.tenantId` (filters out cross-tenant
 *        attempts silently rather than 403-ing — same shape as
 *        sequenceEnrollment's same-tenant findFirst guard).
 *
 * What this file pins
 * ───────────────────
 *   SUBSCRIBE (CRM user, authed)
 *   1. POST /subscribe with missing fields → 400 "Missing subscription fields".
 *   2. POST /subscribe persists a PushSubscription row via upsert with
 *      type='CRM_USER', tenantId from req.user (not body), userId from
 *      req.user.userId.
 *
 *   SUBSCRIBE (visitor, PUBLIC — pin no-auth contract)
 *   3. POST /subscribe/visitor with missing fields → 400.
 *   4. POST /subscribe/visitor with no contactId defaults to tenantId=1.
 *   5. POST /subscribe/visitor with a contactId resolves the contact's
 *      tenantId and uses that for the subscription row (regression pin —
 *      if anyone "simplifies" this back to body.tenantId, the cross-tenant
 *      drift is silent until users see push notifications from a tenant
 *      they don't belong to).
 *
 *   UNSUBSCRIBE
 *   6. DELETE /unsubscribe flips isActive=false via updateMany scoped to
 *      req.user.tenantId (cross-tenant guard pin).
 *
 *   SEND (#515 + cross-tenant guard)
 *   7. POST /send without title OR body → 400 "Title and body required".
 *   8. POST /send creates a PushNotification row with type='INTERNAL',
 *      tenantId from req.user.
 *   9. POST /send silently filters out cross-tenant userIds — the user
 *      lookup is `findFirst({ id, tenantId })`, so a userId from another
 *      tenant returns null and skips the push (no error, no rejection).
 *
 *   SEND-TEST (#515)
 *  10. POST /send-test with no body fields uses default title/body strings
 *      and creates a PushNotification with type='TEST', targeting
 *      req.user.userId.
 *
 *   SEND-CAMPAIGN (marketing)
 *  11. POST /send-campaign without title/body → 400.
 *  12. POST /send-campaign creates a PushNotification with type='MARKETING'
 *      and fans out to all WEBSITE_VISITOR subscriptions for the tenant.
 *
 *   TEMPLATES
 *  13. GET /templates filters by tenantId.
 *  14. PUT /templates/:id 404s when the template lives in another tenant
 *      (cross-tenant guard pin — same shape as the SMS template guard).
 *  15. DELETE /templates/:id 404s on cross-tenant template id.
 *
 *   PUBLIC ENDPOINTS
 *  16. GET /vapid-key returns publicKey only (no privateKey exposure)
 *      with NO auth required — pins the public-endpoint contract.
 *  17. GET /stats scopes both the notifications findMany AND the
 *      subscribers count by tenantId.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/sms.test.js — prisma singleton monkey-
 *   patch BEFORE the router is required, monkey-patch verifyToken to a
 *   pass-through so the route handlers see the test-injected req.user.
 *   Mock the pushService so no outbound HTTP fires; mock the web-push SDK
 *   defensively via the service mock (pushService is the only caller).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Auth middleware bypass — pass through verifyToken so we exercise the
// route handlers without minting JWTs. The route doesn't use verifyRole.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Direct monkey-patch of the pushService singleton — same pattern as the
// verifyToken bypass above. This is more reliable than vi.mock for CJS
// modules required by inlined routes: vi.mock's resolver indirection
// hands back the REAL module on createRequire-based re-imports (as
// confirmed by an earlier iteration of this file). Direct patching of
// the require-cache singleton means both the SUT's
// `require('../services/pushService')` and the test's
// `requireCJS('../../services/pushService')` see the SAME object whose
// methods we've replaced with vi.fn() spies.
const pushService = requireCJS('../../services/pushService');
pushService.getVapidKeys = vi.fn(() => ({ publicKey: 'BPublicKeyStub', privateKey: 'BPrivateKeyStub' }));
pushService.sendPush = vi.fn().mockResolvedValue({ success: true });
pushService.sendToUser = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });

// Prisma singleton patching — must happen BEFORE the router is required.
prisma.pushSubscription = {
  upsert: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
};
prisma.pushNotification = {
  create: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
};
prisma.pushTemplate = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';

const pushRouter = requireCJS('../../routes/push');
// pushService is already monkey-patched at the top of this file — the
// SUT's `require('../services/pushService')` hits the same singleton.

// Two app variants — one with auth-injection middleware for the authed
// routes, one without for the public endpoints. The public-endpoint app
// is the regression pin for the no-auth contract.
function makeAuthedApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/push', pushRouter);
  return app;
}

function makePublicApp() {
  // No req.user injection — pins that /subscribe/visitor + /vapid-key
  // are reachable WITHOUT auth. If anyone moves verifyToken to the
  // router-level mount, these tests will red.
  const app = express();
  app.use(express.json());
  app.use('/api/push', pushRouter);
  return app;
}

beforeEach(() => {
  prisma.pushSubscription.upsert.mockReset();
  prisma.pushSubscription.updateMany.mockReset();
  prisma.pushSubscription.findMany.mockReset();
  prisma.pushSubscription.count.mockReset();
  prisma.pushNotification.create.mockReset();
  prisma.pushNotification.update.mockReset();
  prisma.pushNotification.findMany.mockReset();
  prisma.pushTemplate.findFirst.mockReset();
  prisma.pushTemplate.findMany.mockReset();
  prisma.pushTemplate.create.mockReset();
  prisma.pushTemplate.update.mockReset();
  prisma.pushTemplate.delete.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.user.findFirst.mockReset();

  pushService.sendToUser.mockClear();
  pushService.sendPush.mockClear();
  pushService.getVapidKeys.mockClear();

  // Sensible defaults
  prisma.pushSubscription.upsert.mockResolvedValue({ id: 42 });
  prisma.pushSubscription.updateMany.mockResolvedValue({ count: 1 });
  prisma.pushSubscription.findMany.mockResolvedValue([]);
  prisma.pushSubscription.count.mockResolvedValue(0);
  prisma.pushNotification.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 1001, ...data })
  );
  prisma.pushNotification.update.mockResolvedValue({ id: 1001 });
  prisma.pushNotification.findMany.mockResolvedValue([]);
  prisma.pushTemplate.findMany.mockResolvedValue([]);
  // Default pushService stubbed result.
  pushService.sendToUser.mockResolvedValue({ sent: 1, failed: 0 });
  pushService.sendPush.mockResolvedValue({ success: true });
  pushService.getVapidKeys.mockReturnValue({ publicKey: 'BPublicKeyStub', privateKey: 'BPrivateKeyStub' });
});

// ─── POST /subscribe (CRM user, authed) ─────────────────────────────

describe('POST /subscribe — CRM user subscription', () => {
  test('400 when any subscription field is missing', async () => {
    const app = makeAuthedApp();
    const r1 = await request(app).post('/api/push/subscribe').send({ p256dh: 'x', auth: 'y' });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/Missing/i);

    const r2 = await request(app).post('/api/push/subscribe').send({ endpoint: 'https://e', auth: 'y' });
    expect(r2.status).toBe(400);

    const r3 = await request(app).post('/api/push/subscribe').send({ endpoint: 'https://e', p256dh: 'x' });
    expect(r3.status).toBe(400);
  });

  test('upserts with type=CRM_USER + tenantId from req.user (not body)', async () => {
    const app = makeAuthedApp({ tenantId: 9, userId: 42 });
    const res = await request(app)
      .post('/api/push/subscribe')
      .send({
        endpoint: 'https://fcm.example/abc',
        p256dh: 'p256dh-stub',
        auth: 'auth-stub',
        // Body-supplied tenantId/userId MUST be ignored — global stripDangerous
        // strips id/tenantId/userId from req.body before this handler runs,
        // and the handler itself uses req.user.tenantId/req.user.userId. Pin
        // the source-of-truth here.
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.pushSubscription.upsert.mock.calls[0][0];
    expect(args.where.endpoint).toBe('https://fcm.example/abc');
    expect(args.create.type).toBe('CRM_USER');
    expect(args.create.tenantId).toBe(9);
    expect(args.create.userId).toBe(42);
    expect(args.update.userId).toBe(42);
    expect(args.update.tenantId).toBe(9);
  });
});

// ─── POST /subscribe/visitor (PUBLIC — no auth) ─────────────────────

describe('POST /subscribe/visitor — public, no auth', () => {
  test('reachable WITHOUT req.user (no-auth contract)', async () => {
    // Regression pin: if anyone moves verifyToken to the router-level
    // mount, this 200 will become 401 and the website-visitor opt-in
    // breaks for every public site that uses the embed widget.
    const app = makePublicApp();
    const res = await request(app)
      .post('/api/push/subscribe/visitor')
      .send({
        endpoint: 'https://fcm.example/visitor-abc',
        p256dh: 'p',
        auth: 'a',
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Default tenantId=1 (Default Org) when no contactId is supplied.
    const args = prisma.pushSubscription.upsert.mock.calls[0][0];
    expect(args.create.type).toBe('WEBSITE_VISITOR');
    expect(args.create.tenantId).toBe(1);
  });

  test('400 when subscription fields are missing', async () => {
    const app = makePublicApp();
    const res = await request(app)
      .post('/api/push/subscribe/visitor')
      .send({ endpoint: 'https://e' });
    expect(res.status).toBe(400);
  });

  test('contactId resolves the subscription to the contact\'s tenantId', async () => {
    // Regression pin: previously the visitor subscribe route may have
    // accepted body.tenantId. After tightening, the ONLY way to land a
    // visitor sub in a non-default tenant is via a known contactId
    // whose tenantId resolves at the DB layer. Pin this so a future
    // "simplification" back to body.tenantId can't silently regress.
    const app = makePublicApp();
    prisma.contact.findUnique.mockResolvedValue({ id: 77, tenantId: 5 });
    const res = await request(app)
      .post('/api/push/subscribe/visitor')
      .send({
        endpoint: 'https://fcm.example/visitor-with-contact',
        p256dh: 'p',
        auth: 'a',
        contactId: 77,
      });
    expect(res.status).toBe(200);
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({ where: { id: 77 } });
    const args = prisma.pushSubscription.upsert.mock.calls[0][0];
    expect(args.create.tenantId).toBe(5);
    expect(args.create.contactId).toBe(77);
  });
});

// ─── DELETE /unsubscribe ────────────────────────────────────────────

describe('DELETE /unsubscribe — tenant-scoped flip-to-inactive', () => {
  test('updateMany is scoped by tenantId (cross-tenant guard pin)', async () => {
    const app = makeAuthedApp({ tenantId: 9 });
    const res = await request(app)
      .delete('/api/push/unsubscribe')
      .send({ endpoint: 'https://fcm.example/abc' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const args = prisma.pushSubscription.updateMany.mock.calls[0][0];
    expect(args.where.endpoint).toBe('https://fcm.example/abc');
    // CRITICAL: tenantId in the where clause is the cross-tenant guard.
    // If someone "simplifies" this to where:{endpoint} only, a user in
    // tenant A can deactivate any other tenant's subscription by guessing
    // the endpoint URL.
    expect(args.where.tenantId).toBe(9);
    expect(args.data.isActive).toBe(false);
  });
});

// ─── POST /send — validation + cross-tenant guard ───────────────────

describe('POST /send — internal push to specific users', () => {
  test('400 when title or body is missing', async () => {
    const app = makeAuthedApp();
    const r1 = await request(app).post('/api/push/send').send({ body: 'hi', userIds: [1] });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/push/send').send({ title: 'hi', userIds: [1] });
    expect(r2.status).toBe(400);
  });

  test('creates PushNotification row with type=INTERNAL + tenantId from req.user', async () => {
    const app = makeAuthedApp({ tenantId: 9 });
    prisma.user.findFirst.mockResolvedValue({ id: 100, tenantId: 9 });
    const res = await request(app)
      .post('/api/push/send')
      .send({ title: 'Hello', body: 'World', userIds: [100] });
    expect(res.status).toBe(200);
    const createArgs = prisma.pushNotification.create.mock.calls[0][0];
    expect(createArgs.data.type).toBe('INTERNAL');
    expect(createArgs.data.tenantId).toBe(9);
    expect(createArgs.data.title).toBe('Hello');
    expect(createArgs.data.body).toBe('World');
  });

  test('silently filters cross-tenant userIds (findFirst returns null → skip)', async () => {
    // Regression pin: the user lookup is `findFirst({ id, tenantId })`.
    // A userId belonging to another tenant returns null → the loop
    // iteration is skipped → sent counter stays at 0. Pin this so any
    // refactor to `findUnique({ id })` (which would bypass the tenant
    // guard) immediately reds this test.
    const app = makeAuthedApp({ tenantId: 9 });
    prisma.user.findFirst.mockResolvedValue(null); // cross-tenant user
    const res = await request(app)
      .post('/api/push/send')
      .send({ title: 'Hello', body: 'World', userIds: [555] });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.failed).toBe(0);
    // Critical: findFirst MUST include tenantId in the where clause.
    const userFindArgs = prisma.user.findFirst.mock.calls[0][0];
    expect(userFindArgs.where.tenantId).toBe(9);
    // pushService.sendToUser must NOT have been called for the cross-tenant user.
    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });
});

// ─── POST /send-test (#515) ─────────────────────────────────────────

describe('POST /send-test — single test push to caller', () => {
  test('uses default title/body when body fields omitted + type=TEST', async () => {
    const app = makeAuthedApp({ userId: 42, tenantId: 9 });
    const res = await request(app).post('/api/push/send-test').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const createArgs = prisma.pushNotification.create.mock.calls[0][0];
    // #515 — type='TEST' so test sends don't conflate with INTERNAL /
    // MARKETING in the audit-trail PushNotification table.
    expect(createArgs.data.type).toBe('TEST');
    expect(createArgs.data.tenantId).toBe(9);
    expect(createArgs.data.title).toBe('Test notification');
    expect(createArgs.data.body).toMatch(/test push/i);
    // Recipient is inferred from req.user.userId, not from any body field.
    expect(pushService.sendToUser).toHaveBeenCalledWith(
      42,
      expect.any(Object),
      expect.any(Object),
    );
  });
});

// ─── POST /send-campaign — marketing fan-out ────────────────────────

describe('POST /send-campaign — visitor marketing fan-out', () => {
  test('400 when title/body missing', async () => {
    const app = makeAuthedApp();
    const res = await request(app).post('/api/push/send-campaign').send({ title: 'only' });
    expect(res.status).toBe(400);
  });

  test('creates PushNotification with type=MARKETING + fans out to visitor subs', async () => {
    const app = makeAuthedApp({ tenantId: 9 });
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 1, endpoint: 'https://e1', p256dh: 'p1', auth: 'a1' },
      { id: 2, endpoint: 'https://e2', p256dh: 'p2', auth: 'a2' },
    ]);
    const res = await request(app)
      .post('/api/push/send-campaign')
      .send({ title: 'Sale', body: '50% off' });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(2);
    expect(res.body.failed).toBe(0);
    const createArgs = prisma.pushNotification.create.mock.calls[0][0];
    expect(createArgs.data.type).toBe('MARKETING');
    expect(createArgs.data.tenantId).toBe(9);
    // findMany must be scoped to tenant + visitor + active.
    const findArgs = prisma.pushSubscription.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(9);
    expect(findArgs.where.type).toBe('WEBSITE_VISITOR');
    expect(findArgs.where.isActive).toBe(true);
  });
});

// ─── Templates — CRUD with cross-tenant guard ───────────────────────

describe('Templates — cross-tenant guard', () => {
  test('GET /templates filters by tenantId', async () => {
    const app = makeAuthedApp({ tenantId: 9 });
    const res = await request(app).get('/api/push/templates');
    expect(res.status).toBe(200);
    const args = prisma.pushTemplate.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(9);
  });

  test('PUT /templates/:id 404s when template belongs to a different tenant', async () => {
    const app = makeAuthedApp({ tenantId: 9 });
    // findFirst with {id, tenantId:9} returns null → template doesn't exist
    // in caller's tenant → 404. If the route uses findUnique({id}) instead,
    // a tenant-A admin could mutate a tenant-B template.
    prisma.pushTemplate.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .put('/api/push/templates/123')
      .send({ name: 'updated' });
    expect(res.status).toBe(404);
    const findArgs = prisma.pushTemplate.findFirst.mock.calls[0][0];
    expect(findArgs.where.id).toBe(123);
    expect(findArgs.where.tenantId).toBe(9);
    // No mutation should have fired.
    expect(prisma.pushTemplate.update).not.toHaveBeenCalled();
  });

  test('DELETE /templates/:id 404s when template belongs to a different tenant', async () => {
    const app = makeAuthedApp({ tenantId: 9 });
    prisma.pushTemplate.findFirst.mockResolvedValue(null);
    const res = await request(app).delete('/api/push/templates/123');
    expect(res.status).toBe(404);
    expect(prisma.pushTemplate.delete).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC endpoints — no-auth contract ────────────────────────────

describe('GET /vapid-key — public + no privateKey leak', () => {
  test('reachable WITHOUT req.user and returns publicKey only', async () => {
    // Regression pin: the privateKey must NEVER appear in the response
    // — the whole point of VAPID is the browser only ever sees the public
    // half. The route literally constructs `{ publicKey: ... }`, so
    // pinning the response shape catches any "convenience" refactor that
    // returns the raw getVapidKeys() result.
    const app = makePublicApp();
    const res = await request(app).get('/api/push/vapid-key');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe('BPublicKeyStub');
    expect(res.body.privateKey).toBeUndefined();
    expect(res.body).not.toHaveProperty('privateKey');
  });
});

// ─── GET /stats — tenant-scoped aggregates ──────────────────────────

describe('GET /stats — tenant-scoped notifications + subscribers', () => {
  test('scopes both findMany and count by tenantId', async () => {
    const app = makeAuthedApp({ tenantId: 9 });
    prisma.pushSubscription.count.mockResolvedValue(42);
    prisma.pushNotification.findMany.mockResolvedValue([
      { id: 1, title: 'x', body: 'y', tenantId: 9 },
    ]);
    const res = await request(app).get('/api/push/stats');
    expect(res.status).toBe(200);
    expect(res.body.subscribers).toBe(42);
    expect(Array.isArray(res.body.notifications)).toBe(true);
    const notifArgs = prisma.pushNotification.findMany.mock.calls[0][0];
    expect(notifArgs.where.tenantId).toBe(9);
    const countArgs = prisma.pushSubscription.count.mock.calls[0][0];
    expect(countArgs.where.tenantId).toBe(9);
    expect(countArgs.where.isActive).toBe(true);
  });
});
