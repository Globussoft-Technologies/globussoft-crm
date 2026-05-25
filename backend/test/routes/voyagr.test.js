// @ts-check
/**
 * Unit tests for backend/routes/voyagr.js — pins the voyagr (OJR) CMS
 * lead-capture webhook contract for the 4 Travel sub-brand sites
 * (TMC / RFU / Travel Stall / Visa Sure).
 *
 * Why this file exists (regression class)
 * ───────────────────────────────────────
 *   The route is 407 LOC and previously had ZERO direct vitest coverage at the
 *   ROUTE level. backend/test/middleware/voyagrAuth.test.js pins the auth
 *   middleware (12 cases) but the route's own logic (honeypot guard, body
 *   validation, dedup-by-(email,tenantId), Touchpoint + Deal create, per-key
 *   sub-brand isolation, audit-log writes, P2002 race fallback, 500 path) had
 *   no unit-level pin — only an e2e/tests/voyagr-api.spec.js Playwright spec
 *   exercising the happy + error paths against a live backend.
 *
 *   Cluster F1 (docs/MANUAL_CODING_BACKLOG.md) makes this route load-bearing
 *   for the entire OJR voyagr → CRM lead-capture pipeline. Any silent contract
 *   drift (response envelope reshape, validation-code rename, audit-payload
 *   field rename) would break the production voyagr Next.js API route that
 *   reads { contactId, dealId, isNew } off the 201 response.
 *
 * Auth model
 * ──────────
 *   voyagrAuth = API-key middleware (NOT HMAC — design decision LOCKED
 *   2026-05-23 in commit 5de05a7). For these tests, voyagrAuth is REPLACED by
 *   a pass-through middleware that sets the same req.* surface
 *   (req.tenantId, req.tenant, req.voyagrApiKey, plus the sub-brand helpers)
 *   so the route logic is exercised in isolation from the middleware (which
 *   has its own dedicated unit test).
 *
 * What this file pins (15 cases)
 * ──────────────────────────────
 *   Honeypot guard:
 *    1. _hp populated → 200 empty body + zero DB writes
 *    2. website populated → 200 empty body + zero DB writes
 *
 *   Body validation:
 *    3. missing subBrand → 400 MISSING_FIELDS
 *    4. subBrand not in whitelist → 400 INVALID_SUB_BRAND
 *    5. missing email → 400 MISSING_FIELDS
 *    6. email format invalid → 400 INVALID_EMAIL
 *    7. payload > 8 KiB cap → 400 PAYLOAD_TOO_LARGE
 *
 *   Lead capture happy path (per-sub-brand):
 *    8. tmc: new contact created → 201 { contactId, dealId, isNew:true } +
 *       Touchpoint + Deal + writeAudit invocations
 *    9. visasure: existing contact (same email + tenantId) reused →
 *       201 { ..., isNew:false } + name/phone NOT overwritten on existing
 *
 *   Per-sub-brand key isolation (#899 Part A):
 *   10. scoped key (tmc) posting against rfu → 403 SUB_BRAND_MISMATCH +
 *       zero DB writes (the helper short-circuits before contact lookup)
 *
 *   Tenant resolution + currency:
 *   11. Deal.currency defaults from req.tenant.defaultCurrency
 *
 *   Error paths:
 *   12. P2002 race fallback — concurrent create collides → reuses existing
 *       contact + returns 201 { ..., raceFallback:true }
 *   13. Unexpected prisma error → 500 INTERNAL_ERROR
 *
 *   Pipeline resolution:
 *   14. Deal.pipelineId resolved from the tenant's default pipeline
 *   15. No default pipeline → Deal.pipelineId is null (Deal still created)
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/marketplace-leads.test.js — prisma singleton
 *   monkey-patch BEFORE the router is required, replace voyagrAuth (loaded via
 *   require cache injection) with a pass-through that wires the same req.*
 *   surface the route expects, and patch lib/audit.writeAudit in the require
 *   cache so we can assert the action + details payload without a live audit
 *   chain. Drive via supertest. No real DB.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Patch lib/audit in require cache BEFORE router require ─────────────
const writeAuditMock = vi.fn().mockResolvedValue(undefined);
const auditPath = requireCJS.resolve('../../lib/audit.js');
Module._cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: {
    writeAudit: writeAuditMock,
    diffFields: () => ({}),
    canonicalize: (x) => x,
    computeHash: () => 'h',
    genesisFor: () => 'g',
    backfillTenantChain: async () => ({}),
  },
};

// ── Patch middleware/voyagrAuth as a configurable pass-through ─────────
//
// The tests need to control req.tenantId / req.tenant / req.voyagrApiKey
// per-test (e.g. to exercise the sub-brand-mismatch 403 path) so we
// inject a shim whose behaviour is steered via a mutable shared object.
const voyagrAuthState = {
  tenantId: 7,
  tenant: { id: 7, defaultCurrency: 'INR', isActive: true },
  apiKey: {
    id: 99,
    tenantId: 7,
    userId: 4,
    name: 'voyagr-tmc-prod',
    subBrand: null,
  },
  // When set to a sub-brand, the shim mimics requireSubBrandMatchOrSend
  // returning 403 SUB_BRAND_MISMATCH on a non-matching target.
  scopedSubBrand: null,
};
const voyagrAuthPath = requireCJS.resolve('../../middleware/voyagrAuth.js');
Module._cache[voyagrAuthPath] = {
  id: voyagrAuthPath,
  filename: voyagrAuthPath,
  loaded: true,
  exports: function voyagrAuthShim(req, _res, next) {
    req.tenantId = voyagrAuthState.tenantId;
    req.tenant = voyagrAuthState.tenant;
    req.apiKey = voyagrAuthState.apiKey;
    req.voyagrApiKey = voyagrAuthState.apiKey;
    req.user = {
      tenantId: voyagrAuthState.tenantId,
      userId: voyagrAuthState.apiKey?.userId,
      apiKeyId: voyagrAuthState.apiKey?.id,
    };
    req.apiKeySubBrand = voyagrAuthState.scopedSubBrand;
    req.requireSubBrandMatch = (target) => {
      if (
        voyagrAuthState.scopedSubBrand !== null &&
        voyagrAuthState.scopedSubBrand !== target
      ) {
        const err = new Error('API key sub-brand scope does not match');
        err.status = 403;
        err.code = 'SUB_BRAND_MISMATCH';
        err.expected = voyagrAuthState.scopedSubBrand;
        err.actual = target;
        throw err;
      }
      return true;
    };
    req.requireSubBrandMatchOrSend = (target, res) => {
      try {
        return req.requireSubBrandMatch(target);
      } catch (e) {
        if (e.code === 'SUB_BRAND_MISMATCH') {
          res.status(403).json({
            error: `API key scoped to '${e.expected}' cannot post for sub-brand '${e.actual}'`,
            code: 'SUB_BRAND_MISMATCH',
          });
          return false;
        }
        throw e;
      }
    };
    next();
  },
};

// ── Prisma singleton patching — BEFORE the router is required ──────────
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.create = vi.fn();
prisma.touchpoint = prisma.touchpoint || {};
prisma.touchpoint.create = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.create = vi.fn();
prisma.pipeline = prisma.pipeline || {};
prisma.pipeline.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';

const voyagrRouter = requireCJS('../../routes/voyagr');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/voyagr', voyagrRouter);
  return app;
}

const baseBody = {
  subBrand: 'tmc',
  name: 'Sahil Mehta',
  email: 'sahil@example.com',
  phone: '+919811000001',
  source: {
    siteSlug: 'tmc.in',
    pageUrl: 'https://tmc.in/contact',
    utm: {
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'winter-2026-school-trips',
    },
  },
};

beforeEach(() => {
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.create.mockReset();
  prisma.touchpoint.create.mockReset().mockResolvedValue({ id: 555 });
  prisma.deal.create.mockReset();
  prisma.pipeline.findFirst.mockReset().mockResolvedValue(null);
  writeAuditMock.mockReset().mockResolvedValue(undefined);

  voyagrAuthState.tenantId = 7;
  voyagrAuthState.tenant = { id: 7, defaultCurrency: 'INR', isActive: true };
  voyagrAuthState.apiKey = {
    id: 99,
    tenantId: 7,
    userId: 4,
    name: 'voyagr-tmc-prod',
    subBrand: null,
  };
  voyagrAuthState.scopedSubBrand = null;
});

describe('POST /api/v1/voyagr/leads — honeypot guard', () => {
  test('_hp populated → 200 empty body + zero DB writes', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({ ...baseBody, _hp: 'i-am-a-bot' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.deal.create).not.toHaveBeenCalled();
    expect(prisma.touchpoint.create).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  test('website populated → 200 empty body + zero DB writes', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({ ...baseBody, website: 'http://bot.example' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/voyagr/leads — body validation', () => {
  test('missing subBrand → 400 MISSING_FIELDS', async () => {
    const app = makeApp();
    const { subBrand: _drop, ...body } = baseBody;
    const res = await request(app).post('/api/v1/voyagr/leads').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'subBrand required',
      code: 'MISSING_FIELDS',
    });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('subBrand not in whitelist → 400 INVALID_SUB_BRAND', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({ ...baseBody, subBrand: 'rogue-brand' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
    expect(res.body.error).toMatch(/tmc.*rfu.*travelstall.*visasure/);
  });

  test('missing email → 400 MISSING_FIELDS', async () => {
    const app = makeApp();
    const { email: _drop, ...body } = baseBody;
    const res = await request(app).post('/api/v1/voyagr/leads').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'email required',
      code: 'MISSING_FIELDS',
    });
  });

  test('email format invalid → 400 INVALID_EMAIL', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({ ...baseBody, email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'email format invalid',
      code: 'INVALID_EMAIL',
    });
  });

  test('payload > 8 KiB cap → 400 PAYLOAD_TOO_LARGE', async () => {
    const app = makeApp();
    const big = { junk: 'a'.repeat(8200) };
    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({ ...baseBody, payload: big });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('POST /api/v1/voyagr/leads — happy path', () => {
  test('tmc: new contact → 201 { contactId, dealId, isNew:true } + Touchpoint + Deal + writeAudit', async () => {
    const app = makeApp();
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    prisma.contact.create.mockResolvedValueOnce({
      id: 4242,
      name: 'Sahil Mehta',
      phone: '+919811000001',
      subBrand: 'tmc',
    });
    prisma.deal.create.mockResolvedValueOnce({ id: 8888 });

    const res = await request(app).post('/api/v1/voyagr/leads').send(baseBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ contactId: 4242, dealId: 8888, isNew: true });

    // Contact created with tenantId + subBrand + voyagr source tag
    expect(prisma.contact.create).toHaveBeenCalledOnce();
    const cArgs = prisma.contact.create.mock.calls[0][0].data;
    expect(cArgs.tenantId).toBe(7);
    expect(cArgs.subBrand).toBe('tmc');
    expect(cArgs.source).toBe('voyagr');
    expect(cArgs.firstTouchSource).toBe('voyagr:tmc');
    expect(cArgs.email).toBe('sahil@example.com');
    expect(cArgs.status).toBe('Lead');

    // Touchpoint created with utm fields + tenantId
    expect(prisma.touchpoint.create).toHaveBeenCalledOnce();
    const tArgs = prisma.touchpoint.create.mock.calls[0][0].data;
    expect(tArgs.contactId).toBe(4242);
    expect(tArgs.tenantId).toBe(7);
    expect(tArgs.channel).toBe('web');
    expect(tArgs.source).toBe('google'); // utm.utm_source

    // Deal created — subBrand tagged, currency from tenant
    expect(prisma.deal.create).toHaveBeenCalledOnce();
    const dArgs = prisma.deal.create.mock.calls[0][0].data;
    expect(dArgs.subBrand).toBe('tmc');
    expect(dArgs.title).toBe('voyagr:tmc — Sahil Mehta');
    expect(dArgs.tenantId).toBe(7);
    expect(dArgs.contactId).toBe(4242);
    expect(dArgs.stage).toBe('lead');
    expect(dArgs.amount).toBe(0);

    // Audit log — action + details surface
    expect(writeAuditMock).toHaveBeenCalledOnce();
    const [entity, action, entityId, userId, tenantId, details] =
      writeAuditMock.mock.calls[0];
    expect(entity).toBe('Contact');
    expect(action).toBe('voyagr.lead.captured');
    expect(entityId).toBe(4242);
    expect(userId).toBeNull();
    expect(tenantId).toBe(7);
    expect(details.leadEmail).toBe('sahil@example.com');
    expect(details.subBrand).toBe('tmc');
    expect(details.siteSlug).toBe('tmc.in');
    expect(details.apiKeyName).toBe('voyagr-tmc-prod');
    expect(details.dealId).toBe(8888);
    expect(details.isNew).toBe(true);
  });

  test('visasure: existing contact reused → isNew:false + name/phone NOT overwritten', async () => {
    const app = makeApp();
    const existingContact = {
      id: 1234,
      name: 'Priya Iyer',         // human-vetted name; must NOT be overwritten
      phone: '+919900112233',     // human-vetted phone; must NOT be overwritten
      subBrand: 'visasure',
    };
    prisma.contact.findFirst.mockResolvedValueOnce(existingContact);
    prisma.deal.create.mockResolvedValueOnce({ id: 9001 });

    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({
        ...baseBody,
        subBrand: 'visasure',
        name: 'WRONG NAME From Form',
        phone: '+910000000000',
        email: 'priya@example.com',
        source: { siteSlug: 'visasure.in' },
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ contactId: 1234, dealId: 9001, isNew: false });

    // Crucially: contact.create NEVER invoked on dedup hit.
    expect(prisma.contact.create).not.toHaveBeenCalled();

    // Deal still always created (fresh attribution per submission).
    expect(prisma.deal.create).toHaveBeenCalledOnce();
    expect(prisma.deal.create.mock.calls[0][0].data.subBrand).toBe('visasure');

    // Touchpoint still always created.
    expect(prisma.touchpoint.create).toHaveBeenCalledOnce();
  });
});

describe('POST /api/v1/voyagr/leads — per-sub-brand key isolation (#899 Part A)', () => {
  test('scoped key (tmc) posting against rfu → 403 SUB_BRAND_MISMATCH + zero DB writes', async () => {
    voyagrAuthState.scopedSubBrand = 'tmc';
    const app = makeApp();

    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({ ...baseBody, subBrand: 'rfu', source: { siteSlug: 'rfu.in' } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_MISMATCH');
    expect(res.body.error).toMatch(/scoped to 'tmc'/);
    expect(res.body.error).toMatch(/sub-brand 'rfu'/);

    // Short-circuited BEFORE contact lookup.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.deal.create).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/voyagr/leads — tenant resolution', () => {
  test('Deal.currency defaults from req.tenant.defaultCurrency', async () => {
    voyagrAuthState.tenant = { id: 7, defaultCurrency: 'AED', isActive: true };
    const app = makeApp();
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    prisma.contact.create.mockResolvedValueOnce({
      id: 5555,
      name: 'X',
      phone: null,
      subBrand: 'rfu',
    });
    prisma.deal.create.mockResolvedValueOnce({ id: 7777 });

    const res = await request(app)
      .post('/api/v1/voyagr/leads')
      .send({ ...baseBody, subBrand: 'rfu', source: { siteSlug: 'rfu.in' } });

    expect(res.status).toBe(201);
    expect(prisma.deal.create.mock.calls[0][0].data.currency).toBe('AED');
  });
});

describe('POST /api/v1/voyagr/leads — pipeline resolution', () => {
  test('Deal.pipelineId resolved from the tenant default pipeline', async () => {
    const app = makeApp();
    prisma.pipeline.findFirst.mockResolvedValueOnce({ id: 42 });
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    prisma.contact.create.mockResolvedValueOnce({
      id: 6,
      name: 'A',
      phone: null,
      subBrand: 'tmc',
    });
    prisma.deal.create.mockResolvedValueOnce({ id: 7 });

    await request(app).post('/api/v1/voyagr/leads').send(baseBody);

    // Pipeline lookup scoped by tenantId + isDefault:true
    const pArgs = prisma.pipeline.findFirst.mock.calls[0][0];
    expect(pArgs.where).toEqual({ tenantId: 7, isDefault: true });
    expect(prisma.deal.create.mock.calls[0][0].data.pipelineId).toBe(42);
  });

  test('No default pipeline → Deal.pipelineId is null + Deal still created', async () => {
    const app = makeApp();
    prisma.pipeline.findFirst.mockResolvedValueOnce(null);
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    prisma.contact.create.mockResolvedValueOnce({
      id: 6,
      name: 'A',
      phone: null,
      subBrand: 'tmc',
    });
    prisma.deal.create.mockResolvedValueOnce({ id: 7 });

    const res = await request(app).post('/api/v1/voyagr/leads').send(baseBody);

    expect(res.status).toBe(201);
    expect(prisma.deal.create.mock.calls[0][0].data.pipelineId).toBeNull();
  });
});

describe('POST /api/v1/voyagr/leads — error paths', () => {
  test('P2002 race fallback → reuses existing contact + raceFallback:true', async () => {
    const app = makeApp();
    // First findFirst: returns null (contact not found yet).
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    // Create throws P2002 — concurrent insert won the race.
    const p2002 = new Error('Unique constraint failed');
    p2002.code = 'P2002';
    prisma.contact.create.mockRejectedValueOnce(p2002);
    // Race-fallback findFirst: returns the now-existing contact.
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 9999 });

    const res = await request(app).post('/api/v1/voyagr/leads').send(baseBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      contactId: 9999,
      dealId: null,
      isNew: false,
      raceFallback: true,
    });
  });

  test('Unexpected prisma error → 500 INTERNAL_ERROR', async () => {
    const app = makeApp();
    prisma.contact.findFirst.mockRejectedValueOnce(new Error('connection lost'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post('/api/v1/voyagr/leads').send(baseBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to capture lead',
      code: 'INTERNAL_ERROR',
    });
    errSpy.mockRestore();
  });
});
