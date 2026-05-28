// @ts-check
/**
 * Unit + integration tests for backend/routes/whatsapp.js — pins the
 * WhatsApp Cloud API send + thread + opt-out + template + config + webhook
 * contracts that ship across #435, #651, #681, Wave-2-Agent-KK 2-way
 * completion (threads + opt-outs), and Wave-7D PRD-Gap §7-item-5 (the
 * Meta 24h re-engagement window).
 *
 * Why this file exists
 * ────────────────────
 *   routes/whatsapp.js is a 1205-LOC multi-tier module:
 *     1. ADMIN-ONLY config CRUD — GET /config + PUT /config/:provider are
 *        gated by verifyToken + verifyRole(['ADMIN']). Credentials are
 *        masked on read (#651 — `{configured, last4}` shape, never
 *        plaintext) via maskConfigRow().
 *     2. AUTHED send / list / threads / templates / opt-outs — tenant
 *        scoped via req.user.tenantId. Send enforces opt-out gate +
 *        24h re-engagement window (Wave-7D).
 *     3. PUBLIC webhook — GET /webhook (Meta verify challenge) + POST
 *        /webhook (Meta event ingress) have NO auth; tenant inferred from
 *        matched contact, defaults to 1.
 *
 * What this file pins
 * ───────────────────
 *   SEND
 *   1. POST /send 400s when `to` is missing.
 *   2. POST /send 400s when neither `body` nor `templateName` is given.
 *   3. POST /send 422 CONTACT_OPTED_OUT when the recipient has a
 *      WhatsAppOptOut row in the tenant (DPDP/TRAI compliance, Wave-2 KK).
 *   4. POST /send 422 OUTSIDE_24H_WINDOW when free-form (no templateName)
 *      and there's no prior INBOUND message in the 24h window (Wave-7D).
 *   5. POST /send 400 when no active WhatsAppConfig row exists for the
 *      tenant (after opt-out + window gates pass).
 *
 *   THREAD MANAGEMENT (Wave-2 KK)
 *   6. POST /threads/:id/assign — non-manager cannot cross-assign to
 *      another user (403). Self-assign + unassign open to all roles.
 *   7. POST /threads/:id/snooze — `until` in the past → 400.
 *   8. POST /threads/:id/snooze — invalid ISO string → 400.
 *
 *   OPT-OUTS (Wave-2 KK, DPDP §11)
 *   9. POST /opt-outs requires `contactPhone` → 400 otherwise.
 *  10. DELETE /opt-outs/:id 400 REASON_REQUIRED when reason < 10 chars
 *      (DPDP §11 audit requirement — pinned reason string ≥10).
 *
 *   TEMPLATES
 *  11. POST /templates 400 when name or body is missing.
 *  12. PUT /templates/:id 404 when template lives in another tenant
 *      (regression pin: tenantId filter on existence-check is the
 *      cross-tenant guard).
 *
 *   CONFIG + ROTATION (#651)
 *  13. GET /config requires ADMIN — verifyRole returns 403 RBAC_DENIED for
 *      role=USER.
 *  14. GET /config returns the masked `{configured, last4}` shape for
 *      accessToken + webhookVerifyToken — plaintext never round-trips.
 *
 *   WEBHOOK (NO AUTH)
 *  15. GET /webhook with a failing verify token → 403.
 *  16. POST /webhook responds 200 {received:true} immediately + drops
 *      payloads whose `object` is not 'whatsapp_business_account'.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/sms.test.js (commit 7c1ab1f3) — prisma
 *   singleton monkey-patch BEFORE the router is required, then monkey-
 *   patch verifyToken to a pass-through. verifyRole stays REAL so the
 *   role-denial path on /config is end-to-end exercised. Mock the
 *   services/whatsappProvider via the require-cache so no outbound HTTP
 *   fires (per the CJS-self-mocking-seam cron-learning, services/ mocks
 *   via vi.mock are unreliable — we monkey-patch the module-exports
 *   directly so the route's `require('../services/whatsappProvider')`
 *   sees the replacements).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── Auth middleware bypass ─────────────────────────────────────────────────
// Pass through verifyToken so we exercise the route + verifyRole flow without
// minting JWTs. verifyRole stays REAL so the role-gate assertions on /config
// + /opt-outs are end-to-end.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// ─── Monkey-patch the whatsappProvider service ──────────────────────────────
// Per the CJS-self-mocking-seam cron-learning, vi.mock can be flaky for
// services/ modules; monkey-patch the cached module's exports BEFORE the
// router is required so route's require('../services/whatsappProvider')
// sees these no-op replacements.
const providerMod = requireCJS('../../services/whatsappProvider');
providerMod.sendTemplate = vi.fn().mockResolvedValue({
  success: true,
  providerMsgId: 'wamid.mock-template',
});
providerMod.sendText = vi.fn().mockResolvedValue({
  success: true,
  providerMsgId: 'wamid.mock-text',
});
providerMod.verifyWebhook = vi.fn().mockImplementation((req) => {
  const mode = req?.query?.['hub.mode'];
  const token = req?.query?.['hub.verify_token'];
  const challenge = req?.query?.['hub.challenge'];
  if (mode === 'subscribe' && token === 'good-token') {
    return { verified: true, challenge };
  }
  return { verified: false };
});

// Mock audit so writeAudit() doesn't call any unmocked prisma surface.
const auditMod = requireCJS('../../lib/audit');
auditMod.writeAudit = vi.fn().mockResolvedValue({ id: 9999 });

// Mock credentialMasking decryptCredential to passthrough so the route doesn't
// hit the AES helper. encryptCredential too (route uses it on PUT /config).
const credMaskMod = requireCJS('../../lib/credentialMasking');
const origMaskConfigRow = credMaskMod.maskConfigRow;
// Keep maskConfigRow REAL — we want to assert it produces the masked shape.
// decryptCredential / encryptCredential become identity functions for the
// duration of these tests so credentials round-trip predictably.
credMaskMod.decryptCredential = (v) => v;
credMaskMod.encryptCredential = (v) => v;

// ─── Prisma singleton patching ──────────────────────────────────────────────
// Must happen BEFORE the router is required so the route's
// `require('../lib/prisma')` resolves to this patched singleton.
prisma.whatsAppConfig = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
};
prisma.whatsAppMessage = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
};
prisma.whatsAppTemplate = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.whatsAppThread = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
};
prisma.whatsAppOptOut = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';

const whatsappRouter = requireCJS('../../routes/whatsapp');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/whatsapp', whatsappRouter);
  return app;
}

beforeEach(() => {
  // Reset all the prisma mocks. (vi.fn() instances).
  for (const surface of [
    prisma.whatsAppConfig,
    prisma.whatsAppMessage,
    prisma.whatsAppTemplate,
    prisma.whatsAppThread,
    prisma.whatsAppOptOut,
  ]) {
    for (const fn of Object.values(surface)) {
      if (typeof fn?.mockReset === 'function') fn.mockReset();
    }
  }
  prisma.contact.findFirst.mockReset();
  prisma.user.findFirst.mockReset();
  providerMod.sendTemplate.mockClear();
  providerMod.sendText.mockClear();
  providerMod.verifyWebhook.mockClear();
  auditMod.writeAudit.mockClear();

  // Sensible defaults — most tests assert one specific behavior so the rest
  // of the prisma surface should default to "empty".
  prisma.whatsAppConfig.findMany.mockResolvedValue([]);
  prisma.whatsAppConfig.findFirst.mockResolvedValue(null);
  prisma.whatsAppConfig.updateMany.mockResolvedValue({ count: 0 });
  prisma.whatsAppMessage.findMany.mockResolvedValue([]);
  prisma.whatsAppMessage.findFirst.mockResolvedValue(null);
  prisma.whatsAppMessage.count.mockResolvedValue(0);
  prisma.whatsAppMessage.updateMany.mockResolvedValue({ count: 0 });
  prisma.whatsAppTemplate.findMany.mockResolvedValue([]);
  prisma.whatsAppThread.findMany.mockResolvedValue([]);
  prisma.whatsAppThread.count.mockResolvedValue(0);
  prisma.whatsAppThread.updateMany.mockResolvedValue({ count: 0 });
  prisma.whatsAppOptOut.findUnique.mockResolvedValue(null);
  prisma.whatsAppOptOut.findMany.mockResolvedValue([]);
});

// ─── POST /send — validation + opt-out + 24h-window gates ───────────────────

describe('POST /send — validation', () => {
  test('400 when `to` is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ body: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/to is required/i);
  });

  test('400 when neither body nor templateName is provided', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ to: '+919876543210' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/body or templateName is required/i);
  });

  test('422 CONTACT_OPTED_OUT when recipient has an opt-out row (Wave-2 KK)', async () => {
    // Stub: an opt-out exists for this (tenant, phone).
    prisma.whatsAppOptOut.findUnique.mockResolvedValue({
      id: 11,
      tenantId: 1,
      contactPhone: '+919876543210',
      reason: 'STOP_KEYWORD',
      capturedAt: new Date('2026-05-01T00:00:00Z'),
    });

    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ to: '+919876543210', body: 'hello' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONTACT_OPTED_OUT');
    expect(res.body.reason).toBe('STOP_KEYWORD');
    // Never reached the provider or message create.
    expect(providerMod.sendText).not.toHaveBeenCalled();
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('422 OUTSIDE_24H_WINDOW for free-form msg when no recent inbound (Wave-7D)', async () => {
    prisma.whatsAppOptOut.findUnique.mockResolvedValue(null);
    // No prior inbound → sinceMs is Infinity → outside the 24h window.
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ to: '+919876543210', body: 'hello' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OUTSIDE_24H_WINDOW');
    expect(res.body.hint).toMatch(/templateName/);
    // Never reached the config / provider / message-create.
    expect(prisma.whatsAppConfig.findFirst).not.toHaveBeenCalled();
    expect(providerMod.sendText).not.toHaveBeenCalled();
  });

  test('400 when no active WhatsAppConfig row exists for the tenant', async () => {
    prisma.whatsAppOptOut.findUnique.mockResolvedValue(null);
    // Template-bypass for 24h gate so we hit the config check.
    prisma.whatsAppConfig.findFirst.mockResolvedValueOnce(null);

    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        to: '+919876543210',
        templateName: 'welcome_v1', // bypasses 24h-window gate
        parameters: ['Sumit'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No active WhatsApp provider configured/i);
    expect(providerMod.sendTemplate).not.toHaveBeenCalled();
  });
});

// ─── Threads — assignment + snooze validation (Wave-2 KK) ──────────────────

describe('POST /threads/:id/assign — RBAC for cross-assign', () => {
  test('role=USER cannot cross-assign to a different user (403)', async () => {
    const app = makeApp({ role: 'USER', userId: 5, tenantId: 1 });
    const res = await request(app)
      .post('/api/whatsapp/threads/42/assign')
      .send({ targetUserId: 99 }); // not self → cross-assign attempt

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Only managers can assign threads/i);
    // Never reached the thread fetch — guard tripped first.
    expect(prisma.whatsAppThread.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /threads/:id/snooze — validation', () => {
  test('400 when `until` is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/threads/1/snooze')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/until is required/i);
  });

  test('400 when `until` is in the past', async () => {
    const app = makeApp();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/api/whatsapp/threads/1/snooze')
      .send({ until: past });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be in the future/i);
  });

  test('400 when `until` is an invalid ISO string', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/threads/1/snooze')
      .send({ until: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid ISO datetime/i);
  });
});

// ─── Opt-outs — validation + DPDP §11 (Wave-2 KK) ───────────────────────────

describe('POST /opt-outs — manager-only, validation', () => {
  test('400 when contactPhone is missing', async () => {
    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .post('/api/whatsapp/opt-outs')
      .send({ reason: 'USER_REQUESTED' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contactPhone is required/i);
  });
});

describe('DELETE /opt-outs/:id — DPDP §11 reason-required', () => {
  test('400 REASON_REQUIRED when reason < 10 chars', async () => {
    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .delete('/api/whatsapp/opt-outs/1')
      .send({ reason: 'too short' }); // 9 chars
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect(res.body.error).toMatch(/DPDP/);
    // Never reached the opt-out fetch.
    expect(prisma.whatsAppOptOut.findFirst).not.toHaveBeenCalled();
  });
});

// ─── Templates CRUD ─────────────────────────────────────────────────────────

describe('POST /templates — validation', () => {
  test('400 when name or body is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/templates')
      .send({ name: 'welcome' }); // missing body
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and body are required/i);
  });
});

describe('PUT /templates/:id — tenant isolation', () => {
  test('404 when template is in another tenant (tenantId filter pinned)', async () => {
    // findFirst returns null because the tenant filter excludes the template.
    prisma.whatsAppTemplate.findFirst.mockResolvedValue(null);

    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .put('/api/whatsapp/templates/999')
      .send({ name: 'cross-tenant-name' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Template not found/i);
    // The existence check WAS run with tenantId in the filter — pin it.
    const findArgs = prisma.whatsAppTemplate.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(1);
  });
});

// ─── GET /config — ADMIN gate + masking (#651) ─────────────────────────────

describe('GET /config — admin-only + masked credentials (#651)', () => {
  test('role=USER → 403 RBAC_DENIED', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app).get('/api/whatsapp/config');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    // Never reached prisma.
    expect(prisma.whatsAppConfig.findMany).not.toHaveBeenCalled();
  });

  test('returns masked {configured,last4} shape for accessToken + webhookVerifyToken', async () => {
    prisma.whatsAppConfig.findMany.mockResolvedValue([
      {
        id: 1,
        provider: 'meta_cloud',
        phoneNumberId: '1234567890',
        businessAccountId: 'BA9999',
        accessToken: 'super-secret-plaintext-access-token-a3f1',
        webhookVerifyToken: 'webhook-verify-secret-7890',
        isActive: true,
        tenantId: 1,
      },
    ]);

    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app).get('/api/whatsapp/config');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].provider).toBe('meta_cloud');
    // Plaintext NEVER round-trips — accessToken is the {configured,last4} shape.
    expect(typeof res.body[0].accessToken).toBe('object');
    expect(res.body[0].accessToken.configured).toBe(true);
    expect(res.body[0].accessToken.last4).toMatch(/^\*\*\*\*/);
    expect(res.body[0].webhookVerifyToken.configured).toBe(true);
    expect(res.body[0].webhookVerifyToken.last4).toMatch(/^\*\*\*\*/);
    // Non-secret fields pass through verbatim.
    expect(res.body[0].phoneNumberId).toBe('1234567890');
    expect(res.body[0].businessAccountId).toBe('BA9999');
  });
});

// ─── Webhook (NO AUTH) ──────────────────────────────────────────────────────

// ─── Webhook handlers on routes/whatsapp.js are TOMBSTONES (P1) ─────────────
//
// The real Meta webhook handlers were extracted to routes/whatsapp_webhook.js
// and are mounted in server.js BEFORE the global express.json() so the raw
// body survives X-Hub-Signature-256 verification. The handlers that remain
// in routes/whatsapp.js are deliberate tombstones that respond
// 503 WEBHOOK_MOUNT_ORDER if they ever execute — that response only happens
// when server.js's mount order is wrong.
//
// This test file mounts JUST routes/whatsapp.js, so requests to
// /api/whatsapp/webhook hit the tombstones. Pin that tombstone response
// shape so a regression that silently re-introduces a real-but-now-duplicate
// webhook implementation in routes/whatsapp.js gets caught here.

describe('GET /webhook — tombstone (real handler lives in routes/whatsapp_webhook.js)', () => {
  test('503 WEBHOOK_MOUNT_ORDER — tombstone fires when mount order is wrong', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'WRONG-TOKEN',
        'hub.challenge': 'abc123',
      });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WEBHOOK_MOUNT_ORDER');
    expect(res.body.error).toMatch(/Webhook routing misconfigured/i);
  });
});

describe('POST /webhook — tombstone (real handler lives in routes/whatsapp_webhook.js)', () => {
  test('503 WEBHOOK_MOUNT_ORDER + does not touch the message table', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/whatsapp/webhook')
      .send({
        object: 'instagram_business_account', // not whatsapp_business_account
        entry: [{ changes: [{ field: 'messages', value: { messages: [] } }] }],
      });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WEBHOOK_MOUNT_ORDER');
    // The tombstone returns before any DB work — no rows written.
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });
});
