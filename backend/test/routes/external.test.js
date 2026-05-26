// @ts-check
/**
 * Unit tests for backend/routes/external.js — the External Partner API
 * mounted at /api/v1/external/* and consumed by sister Globussoft products
 * (Callified.ai voice + WhatsApp, Globus Phone softphone) via an
 * X-API-Key header.
 *
 * Why this file exists
 * ────────────────────
 *   The route is 558 LOC and had ZERO direct vitest coverage at the ROUTE
 *   level. The middleware (externalAuth) has its own unit pin at
 *   backend/test/middleware/externalAuth.test.js, and there is e2e
 *   Playwright coverage at e2e/tests/external-*-api.spec.js for cross-
 *   machine release validation, but the route's own contract — public
 *   /health reachability, INVALID_ID guard via router.param, body
 *   validation surfaces (INSUFFICIENT_IDENTITY / MISSING_QUERY / phone-
 *   or-contactId-required), the lead-create pipeline that wires
 *   classifyLead + pickAssignee + computeFirstResponseDueAt, the
 *   dedup-on-email upsert, the calls/messages activity-log creates, and
 *   the catalog reads — had no unit-level pin.
 *
 * Auth model
 * ──────────
 *   externalAuth = API-key middleware. For these tests, externalAuth is
 *   REPLACED via the require-cache with a configurable pass-through that
 *   wires the same req.* surface the route expects (req.tenantId,
 *   req.tenant, req.apiKey, req.user) so the route logic is exercised
 *   in isolation from middleware (which has its own dedicated unit test).
 *   When `unauthorize` is set on the shim's state, the shim emits a 401
 *   to exercise the "no auth → 401" path against /me.
 *
 * What this file pins (16 cases)
 * ──────────────────────────────
 *   Public reachability:
 *    1. GET /health → 200 { status:'ok', apiVersion:'v1' }, no auth needed
 *
 *   Auth gating:
 *    2. GET /me with auth shim disabled → 401 (auth gate fires)
 *    3. GET /me with shim enabled → returns tenant + apiKey + capabilities
 *
 *   INVALID_ID guard (router.param):
 *    4. GET /contacts/abc → 400 INVALID_ID (non-numeric)
 *    5. GET /contacts/0   → 400 INVALID_ID (n < 1)
 *    6. PATCH /calls/-5   → 400 INVALID_ID (negative)
 *
 *   Contacts:
 *    7. GET /contacts/lookup (no phone, no email) → 400 MISSING_QUERY
 *    8. GET /contacts/lookup?phone=... happy path → returns contact
 *    9. GET /contacts/:id not-in-tenant → 404 NOT_FOUND-ish
 *
 *   Leads list + create:
 *   10. GET /leads → returns { data, total, since } shape
 *   11. POST /leads with NONE of name/phone/email → 400 INSUFFICIENT_IDENTITY
 *   12. POST /leads happy path — invokes classifyLead + pickAssignee +
 *       computeFirstResponseDueAt, creates Contact + Activity, returns
 *       201 with { ...contact, _verdict, _routing, _sla }
 *   13. POST /leads junk verdict → status='Junk', skip pickAssignee,
 *       Activity.type='JunkFilter'
 *
 *   Calls:
 *   14. POST /calls without phone/contactId → 400
 *   15. POST /calls happy path → 201 + CallLog row created
 *
 *   Catalog + appointments:
 *   16. GET /services + GET /appointments — both return { data, total }
 *       and apply tenantWhere + isActive filters
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/voyagr.test.js — prisma singleton
 *   monkey-patch BEFORE the router is required, replace externalAuth via
 *   require-cache injection with a pass-through that wires the same req.*
 *   surface, mock leadJunkFilter + leadAutoRouter + leadSla via require-
 *   cache so we can control verdict + assignee + SLA without invoking the
 *   real Gemini/keyword logic. Drive via supertest. No real DB.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Patch lib/leadJunkFilter in require cache BEFORE router require ────
const classifyLeadMock = vi.fn();
const leadJunkFilterPath = requireCJS.resolve('../../lib/leadJunkFilter.js');
Module._cache[leadJunkFilterPath] = {
  id: leadJunkFilterPath,
  filename: leadJunkFilterPath,
  loaded: true,
  exports: {
    classifyLead: classifyLeadMock,
    isIndianMobile: () => true,
    looksLikeGibberish: () => false,
    suspiciousEmail: () => false,
  },
};

// ── Patch lib/leadAutoRouter in require cache BEFORE router require ────
const pickAssigneeMock = vi.fn();
const leadAutoRouterPath = requireCJS.resolve('../../lib/leadAutoRouter.js');
Module._cache[leadAutoRouterPath] = {
  id: leadAutoRouterPath,
  filename: leadAutoRouterPath,
  loaded: true,
  exports: {
    pickAssignee: pickAssigneeMock,
    detectCategory: () => null,
  },
};

// ── Patch lib/leadSla in require cache BEFORE router require ───────────
const computeFirstResponseDueAtMock = vi.fn();
const leadSlaPath = requireCJS.resolve('../../lib/leadSla.js');
Module._cache[leadSlaPath] = {
  id: leadSlaPath,
  filename: leadSlaPath,
  loaded: true,
  exports: {
    TIER_SLA_MINUTES: { high: 5, medium: 30, low: 120 },
    DEFAULT_SLA_MINUTES: 30,
    detectCategory: () => null,
    findMatchedService: async () => null,
    computeFirstResponseDueAt: computeFirstResponseDueAtMock,
    markFirstResponseIfNeeded: async () => undefined,
  },
};

// ── Patch middleware/externalAuth as a configurable pass-through ───────
//
// The tests need to control req.tenantId / req.tenant / req.apiKey
// per-test (and to exercise the 401 unauth path) so we inject a shim
// whose behaviour is steered via a mutable shared object.
const externalAuthState = {
  unauthorize: false,
  tenantId: 7,
  tenant: {
    id: 7,
    name: 'Acme Wellness',
    slug: 'acme-wellness',
    vertical: 'wellness',
    plan: 'pro',
    country: 'IN',
    defaultCurrency: 'INR',
    locale: 'en-IN',
    logoUrl: null,
    brandColor: '#265855',
    isActive: true,
  },
  apiKey: {
    id: 42,
    name: 'callified-prod',
    lastUsed: null,
    userId: 4,
    tenantId: 7,
  },
};
const externalAuthPath = requireCJS.resolve('../../middleware/externalAuth.js');
Module._cache[externalAuthPath] = {
  id: externalAuthPath,
  filename: externalAuthPath,
  loaded: true,
  exports: function externalAuthShim(req, res, next) {
    if (externalAuthState.unauthorize) {
      return res.status(401).json({ error: 'Missing X-API-Key header' });
    }
    req.tenantId = externalAuthState.tenantId;
    req.tenant = externalAuthState.tenant;
    req.apiKey = externalAuthState.apiKey;
    req.user = {
      tenantId: externalAuthState.tenantId,
      id: externalAuthState.apiKey?.userId,
      apiKeyId: externalAuthState.apiKey?.id,
    };
    req.apiKeySubBrand = null;
    req.requireSubBrandMatch = () => true;
    req.requireSubBrandMatchOrSend = () => true;
    next();
  },
};

// ── Prisma singleton patching — BEFORE the router is required ──────────
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.contact.create = vi.fn();
prisma.contact.update = vi.fn();   // Task 9: PATCH /leads/:id/stage
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.activity = prisma.activity || {};
prisma.activity.create = vi.fn();
prisma.callLog = prisma.callLog || {};
prisma.callLog.findFirst = vi.fn();
prisma.callLog.create = vi.fn();
prisma.callLog.update = vi.fn();
prisma.whatsAppMessage = prisma.whatsAppMessage || {};
prisma.whatsAppMessage.create = vi.fn();
prisma.smsMessage = prisma.smsMessage || {};
prisma.smsMessage.create = vi.fn();
prisma.service = prisma.service || {};
prisma.service.findMany = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.location = prisma.location || {};
prisma.location.findMany = vi.fn();
prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();
prisma.visit.create = vi.fn();
// Task 11: webhook self-serve subscription
prisma.webhook = prisma.webhook || {};
prisma.webhook.create = vi.fn();
prisma.webhook.findMany = vi.fn();
prisma.webhook.findFirst = vi.fn();
prisma.webhook.update = vi.fn();

import express from 'express';
import request from 'supertest';

const externalRouter = requireCJS('../../routes/external');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/external', externalRouter);
  return app;
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.create.mockReset();
  prisma.patient.findFirst.mockReset();
  prisma.activity.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.callLog.findFirst.mockReset();
  prisma.callLog.create.mockReset();
  prisma.callLog.update.mockReset();
  prisma.whatsAppMessage.create.mockReset();
  prisma.smsMessage.create.mockReset();
  prisma.service.findMany.mockReset();
  prisma.user.findMany.mockReset();
  prisma.location.findMany.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.visit.create.mockReset();
  prisma.contact.update.mockReset();
  prisma.webhook.create.mockReset();
  prisma.webhook.findMany.mockReset().mockResolvedValue([]);
  prisma.webhook.findFirst.mockReset();
  prisma.webhook.update.mockReset();

  classifyLeadMock.mockReset().mockResolvedValue({
    isJunk: false,
    score: 60,
    reasons: [],
  });
  pickAssigneeMock.mockReset().mockResolvedValue({
    userId: 11,
    reason: 'matched cat=injectables',
  });
  computeFirstResponseDueAtMock.mockReset().mockResolvedValue({
    dueAt: new Date('2026-06-01T10:05:00Z'),
    tier: 'high',
    minutes: 5,
  });

  externalAuthState.unauthorize = false;
  externalAuthState.tenantId = 7;
  externalAuthState.tenant = {
    id: 7,
    name: 'Acme Wellness',
    slug: 'acme-wellness',
    vertical: 'wellness',
    plan: 'pro',
    country: 'IN',
    defaultCurrency: 'INR',
    locale: 'en-IN',
    logoUrl: null,
    brandColor: '#265855',
    isActive: true,
  };
  externalAuthState.apiKey = {
    id: 42,
    name: 'callified-prod',
    lastUsed: null,
    userId: 4,
    tenantId: 7,
  };
});

describe('GET /api/v1/external/health — public reachability', () => {
  test('200 + {status:"ok", apiVersion:"v1"}, no auth required', async () => {
    // Even with externalAuth shim set to deny, /health must succeed because
    // it's declared BEFORE router.use(externalAuth).
    externalAuthState.unauthorize = true;

    const app = makeApp();
    const res = await request(app).get('/api/v1/external/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', apiVersion: 'v1' });
  });
});

describe('GET /api/v1/external/me — auth gating', () => {
  test('shim unauthorized → 401', async () => {
    externalAuthState.unauthorize = true;
    const app = makeApp();

    const res = await request(app).get('/api/v1/external/me');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/X-API-Key/i);
  });

  test('shim authorized → returns tenant + apiKey + capabilities', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/external/me');

    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe(7);
    expect(res.body.tenant.name).toBe('Acme Wellness');
    expect(res.body.tenant.vertical).toBe('wellness');
    expect(res.body.tenant.defaultCurrency).toBe('INR');
    expect(res.body.apiKey.id).toBe(42);
    expect(res.body.apiKey.name).toBe('callified-prod');
    expect(res.body.capabilities.wellness).toBe(true);
  });
});

describe('router.param :id — INVALID_ID guard', () => {
  test('GET /contacts/abc → 400 INVALID_ID', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/external/contacts/abc');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'id must be a positive integer',
      code: 'INVALID_ID',
    });
    // Short-circuited before Prisma.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('GET /contacts/0 → 400 INVALID_ID (n < 1)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/external/contacts/0');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('PATCH /calls/-5 → 400 INVALID_ID (negative)', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/calls/-5')
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.callLog.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/external/contacts/lookup', () => {
  test('no phone, no email → 400 MISSING_QUERY', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/external/contacts/lookup');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'phone or email required',
      code: 'MISSING_QUERY',
    });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('?phone=... happy path → returns contact', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce({
      id: 101,
      name: 'Anjali Sharma',
      email: 'anjali@example.com',
      phone: '+919811234567',
      status: 'Lead',
      source: 'web',
      company: null,
      aiScore: 72,
      assignedToId: 4,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const app = makeApp();

    const res = await request(app)
      .get('/api/v1/external/contacts/lookup')
      .query({ phone: '+919811234567' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(101);
    expect(res.body.name).toBe('Anjali Sharma');

    // Where clause uses phoneMatches { contains: '9811234567' } + tenantId.
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(7);
    expect(args.where.phone).toEqual({ contains: '9811234567' });
  });
});

describe('GET /api/v1/external/contacts/:id', () => {
  test('not-in-tenant → 404', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();

    const res = await request(app).get('/api/v1/external/contacts/999');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);

    // Lookup is tenant-scoped.
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(7);
    expect(args.where.id).toBe(999);
  });
});

describe('GET /api/v1/external/leads — list shape', () => {
  test('returns { data, total, since } with tenantId + status:"Lead" filter', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { id: 1, name: 'A', email: 'a@x.test', phone: null, source: 'web', firstTouchSource: 'web', status: 'Lead', aiScore: 50, createdAt: new Date() },
      { id: 2, name: 'B', email: 'b@x.test', phone: null, source: 'web', firstTouchSource: 'web', status: 'Lead', aiScore: 70, createdAt: new Date() },
    ]);
    const app = makeApp();

    const res = await request(app)
      .get('/api/v1/external/leads')
      .query({ since: '2026-05-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.since).toBe('2026-05-01T00:00:00Z');

    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(7);
    expect(args.where.status).toBe('Lead');
    expect(args.where.createdAt).toEqual({ gte: new Date('2026-05-01T00:00:00Z') });
  });
});

describe('POST /api/v1/external/leads — create pipeline', () => {
  test('no name/phone/email → 400 INSUFFICIENT_IDENTITY', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/external/leads')
      .send({ source: 'callified' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'name, phone, or email required',
      code: 'INSUFFICIENT_IDENTITY',
    });
    expect(classifyLeadMock).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('happy path → classifyLead + pickAssignee + computeFirstResponseDueAt invoked, Contact + Activity created, 201 returned with envelope extras', async () => {
    classifyLeadMock.mockResolvedValueOnce({
      isJunk: false,
      score: 80,
      reasons: [],
    });
    pickAssigneeMock.mockResolvedValueOnce({
      userId: 11,
      reason: 'matched cat=injectables (drHarsh)',
    });
    const dueAt = new Date('2026-06-01T10:05:00Z');
    computeFirstResponseDueAtMock.mockResolvedValueOnce({
      dueAt,
      tier: 'high',
      minutes: 5,
    });
    prisma.contact.findFirst.mockResolvedValueOnce(null); // not deduped
    const createdContact = {
      id: 555,
      name: 'Priya Iyer',
      email: 'priya@example.com',
      phone: '+919900112233',
      status: 'Lead',
      source: 'callified',
      aiScore: 80,
      assignedToId: 11,
      firstResponseDueAt: dueAt,
      tenantId: 7,
      createdAt: new Date(),
    };
    prisma.contact.create.mockResolvedValueOnce(createdContact);

    const app = makeApp();
    const res = await request(app).post('/api/v1/external/leads').send({
      name: 'Priya Iyer',
      phone: '+919900112233',
      email: 'priya@example.com',
      source: 'callified',
      note: 'Asked about hydrafacial pricing',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(555);
    expect(res.body.name).toBe('Priya Iyer');
    // Envelope extras stamped onto the response
    expect(res.body._verdict).toEqual({ isJunk: false, score: 80, reasons: [] });
    expect(res.body._routing.userId).toBe(11);
    expect(res.body._sla.tier).toBe('high');

    // classifyLead invoked with the inbound payload + tenantId
    expect(classifyLeadMock).toHaveBeenCalledOnce();
    const verdictArgs = classifyLeadMock.mock.calls[0][0];
    expect(verdictArgs.tenantId).toBe(7);
    expect(verdictArgs.name).toBe('Priya Iyer');

    // pickAssignee invoked since verdict.isJunk=false
    expect(pickAssigneeMock).toHaveBeenCalledOnce();

    // SLA compute invoked with joined text
    expect(computeFirstResponseDueAtMock).toHaveBeenCalledOnce();

    // Contact.create called with expected mapping
    const cArgs = prisma.contact.create.mock.calls[0][0].data;
    expect(cArgs.tenantId).toBe(7);
    expect(cArgs.email).toBe('priya@example.com');
    expect(cArgs.phone).toBe('+919900112233');
    expect(cArgs.source).toBe('callified');
    expect(cArgs.firstTouchSource).toBe('callified');
    expect(cArgs.status).toBe('Lead');
    expect(cArgs.aiScore).toBe(80);
    expect(cArgs.assignedToId).toBe(11);
    expect(cArgs.firstResponseDueAt).toBe(dueAt);

    // Activity (system Note) written because note was provided
    expect(prisma.activity.create).toHaveBeenCalledOnce();
    const aArgs = prisma.activity.create.mock.calls[0][0].data;
    expect(aArgs.type).toBe('Note');
    expect(aArgs.contactId).toBe(555);
    expect(aArgs.tenantId).toBe(7);
    expect(aArgs.description).toContain('Asked about hydrafacial pricing');
  });

  test('junk verdict → status="Junk", pickAssignee SKIPPED, Activity.type="JunkFilter"', async () => {
    classifyLeadMock.mockResolvedValueOnce({
      isJunk: true,
      score: 5,
      reasons: ['gibberish-name', 'foreign-phone'],
    });
    computeFirstResponseDueAtMock.mockResolvedValueOnce({
      dueAt: new Date('2026-06-01T10:30:00Z'),
      tier: 'low',
      minutes: 120,
    });
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    prisma.contact.create.mockResolvedValueOnce({
      id: 777,
      name: 'xyzz qwerty',
      email: null,
      phone: '+10000000000',
      status: 'Junk',
      source: 'callified',
      aiScore: 5,
      assignedToId: null,
      tenantId: 7,
      createdAt: new Date(),
    });

    const app = makeApp();
    const res = await request(app).post('/api/v1/external/leads').send({
      name: 'xyzz qwerty',
      phone: '+10000000000',
      source: 'callified',
    });

    expect(res.status).toBe(201);
    expect(res.body._verdict.isJunk).toBe(true);
    expect(res.body._routing.userId).toBeNull();
    expect(res.body._routing.reason).toMatch(/junk/i);

    // pickAssignee MUST NOT have been called when junk
    expect(pickAssigneeMock).not.toHaveBeenCalled();

    // Contact created with status='Junk'
    const cArgs = prisma.contact.create.mock.calls[0][0].data;
    expect(cArgs.status).toBe('Junk');
    expect(cArgs.assignedToId).toBeNull();

    // Activity created with type='JunkFilter' since reasons[] is non-empty
    expect(prisma.activity.create).toHaveBeenCalledOnce();
    const aArgs = prisma.activity.create.mock.calls[0][0].data;
    expect(aArgs.type).toBe('JunkFilter');
    expect(aArgs.description).toContain('junk-filter');
  });
});

describe('POST /api/v1/external/calls', () => {
  test('no phone/contactId/callerNumber/calleeNumber → 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/v1/external/calls').send({
      direction: 'INBOUND',
      durationSec: 30,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone or contactId required/i);
    expect(prisma.callLog.create).not.toHaveBeenCalled();
  });

  test('happy path → 201 + CallLog row created with tenantId + direction', async () => {
    prisma.callLog.create.mockResolvedValueOnce({
      id: 333,
      direction: 'INBOUND',
      duration: 47,
      status: 'COMPLETED',
      tenantId: 7,
      callerNumber: '+919811000001',
      calleeNumber: null,
      provider: 'callified-prod',
      recordingUrl: 'https://callified.test/r/abc.mp3',
    });

    const app = makeApp();
    const res = await request(app).post('/api/v1/external/calls').send({
      phone: '+919811000001',
      direction: 'INBOUND',
      durationSec: '47',
      recordingUrl: 'https://callified.test/r/abc.mp3',
      status: 'completed',
      providerCallId: 'cf_xyz',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(333);

    const args = prisma.callLog.create.mock.calls[0][0].data;
    expect(args.tenantId).toBe(7);
    expect(args.direction).toBe('INBOUND');
    expect(args.duration).toBe(47);
    expect(args.status).toBe('COMPLETED'); // uppercased
    expect(args.callerNumber).toBe('+919811000001'); // INBOUND copies phone → callerNumber
    expect(args.calleeNumber).toBeNull();
    // provider falls back to apiKey.name when unspecified
    expect(args.provider).toBe('callified-prod');
  });
});

describe('GET /api/v1/external/services + appointments — catalog shape', () => {
  test('GET /services → { data, total } with tenantId + isActive filter', async () => {
    prisma.service.findMany.mockResolvedValueOnce([
      { id: 1, name: 'HydraFacial', isActive: true, ticketTier: 'high', basePrice: 5000 },
      { id: 2, name: 'Botox', isActive: true, ticketTier: 'high', basePrice: 12000 },
    ]);

    const app = makeApp();
    const res = await request(app).get('/api/v1/external/services');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);

    const args = prisma.service.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(7);
    expect(args.where.isActive).toBe(true);
  });

  test('GET /appointments?from=...&to=... → date-range filter applied, returns { data, total }', async () => {
    prisma.visit.findMany.mockResolvedValueOnce([
      { id: 50, visitDate: new Date('2026-06-02T10:00:00Z'), status: 'booked' },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/v1/external/appointments')
      .query({ from: '2026-06-01T00:00:00Z', to: '2026-06-30T23:59:59Z' });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);

    const args = prisma.visit.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(7);
    expect(args.where.visitDate.gte).toEqual(new Date('2026-06-01T00:00:00Z'));
    expect(args.where.visitDate.lte).toEqual(new Date('2026-06-30T23:59:59Z'));
  });
});

// ── Task 9 — PATCH /api/v1/external/leads/:id/stage ────────────────────────
//
// Accepts GP stage vocab (NEW/QUALIFIED/WON/LOST/DNC) or CRM status direct
// (Lead/Prospect/Customer/Churned/Junk). Returns updated contact row.

describe('PATCH /api/v1/external/leads/:id/stage (Task 9)', () => {
  const existingContact = {
    id: 200,
    name: 'Ritu Mehta',
    phone: '+919876543210',
    email: 'ritu@example.com',
    status: 'Lead',
    assignedToId: 4,
    tenantId: 7,
  };

  test('happy path: GP stage NEW → CRM status Lead (no-op) → 200', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(existingContact);
    prisma.contact.update.mockResolvedValueOnce({ ...existingContact, status: 'Lead' });

    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ stage: 'NEW' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.contact.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Lead');
  });

  test('GP stage QUALIFIED → CRM status Prospect', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(existingContact);
    prisma.contact.update.mockResolvedValueOnce({ ...existingContact, status: 'Prospect' });

    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ stage: 'QUALIFIED' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.contact.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Prospect');
  });

  test('GP stage WON → Customer, LOST → Churned, DNC → Junk', async () => {
    const app = makeApp();
    for (const [stage, expectedStatus] of [['WON', 'Customer'], ['LOST', 'Churned'], ['DNC', 'Junk']]) {
      prisma.contact.findFirst.mockResolvedValueOnce({ ...existingContact, status: 'Lead' });
      prisma.contact.update.mockResolvedValueOnce({ ...existingContact, status: expectedStatus });

      const res = await request(app)
        .patch('/api/v1/external/leads/200/stage')
        .send({ stage });

      expect(res.status).toBe(200);
      const lastUpdate = prisma.contact.update.mock.calls.slice(-1)[0][0];
      expect(lastUpdate.data.status).toBe(expectedStatus);
    }
  });

  test('stage is case-insensitive: "qualified" same as "QUALIFIED"', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(existingContact);
    prisma.contact.update.mockResolvedValueOnce({ ...existingContact, status: 'Prospect' });

    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ stage: 'qualified' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.contact.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Prospect');
  });

  test('direct CRM status "Customer" accepted when sent as status field', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(existingContact);
    prisma.contact.update.mockResolvedValueOnce({ ...existingContact, status: 'Customer' });

    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ status: 'Customer' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.contact.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Customer');
  });

  test('unknown stage → 400 INVALID_STAGE', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ stage: 'MAYBE' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STAGE');
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('invalid CRM status direct → 400 INVALID_STATUS', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ status: 'Unknown' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });

  test('missing stage AND status → 400 MISSING_STAGE', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ something: 'else' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_STAGE');
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('contact not found in tenant → 404', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null); // not in tenant

    const app = makeApp();
    const res = await request(app)
      .patch('/api/v1/external/leads/999/stage')
      .send({ stage: 'WON' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('update is scoped to tenantId (tenantWhere enforced)', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(existingContact);
    prisma.contact.update.mockResolvedValueOnce({ ...existingContact, status: 'Prospect' });

    const app = makeApp();
    await request(app)
      .patch('/api/v1/external/leads/200/stage')
      .send({ stage: 'QUALIFIED' });

    const findArgs = prisma.contact.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(7); // externalAuthState.tenantId
    expect(findArgs.where.id).toBe(200);
  });
});

// ── Task 11 — Webhook self-serve subscription ──────────────────────────────
//
// POST /webhooks: register callback URL + event pattern(s).
// GET  /webhooks: list active subscriptions for tenant.
// DELETE /webhooks/:id: deactivate (soft-delete via isActive=false).

describe('POST /api/v1/external/webhooks (Task 11)', () => {
  test('happy path: single event → 201 + { created: [webhook] }', async () => {
    prisma.webhook.create.mockResolvedValueOnce({
      id: 1, event: 'lead.*', targetUrl: 'https://gp.example/webhooks/crm',
      isActive: true, tenantId: 7, userId: 4, createdAt: new Date(),
    });

    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/external/webhooks')
      .send({ url: 'https://gp.example/webhooks/crm', event: 'lead.*' });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].event).toBe('lead.*');
    expect(res.body.created[0].targetUrl).toBe('https://gp.example/webhooks/crm');

    const createArgs = prisma.webhook.create.mock.calls[0][0].data;
    expect(createArgs.tenantId).toBe(7);
    expect(createArgs.userId).toBe(4); // req.user.id = apiKey.userId
    expect(createArgs.isActive).toBe(true);
  });

  test('events array → creates one row per pattern', async () => {
    // 3 event patterns → 3 webhook rows
    prisma.webhook.create
      .mockResolvedValueOnce({ id: 1, event: 'lead.new', targetUrl: 'https://x.test/wh', isActive: true })
      .mockResolvedValueOnce({ id: 2, event: 'lead.assigned', targetUrl: 'https://x.test/wh', isActive: true })
      .mockResolvedValueOnce({ id: 3, event: 'contact.updated', targetUrl: 'https://x.test/wh', isActive: true });

    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/external/webhooks')
      .send({ url: 'https://x.test/wh', events: ['lead.new', 'lead.assigned', 'contact.updated'] });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(3);
    expect(prisma.webhook.create).toHaveBeenCalledTimes(3);
  });

  test('missing url → 400 MISSING_URL', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/external/webhooks')
      .send({ event: 'lead.*' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_URL');
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  test('invalid URL → 400 INVALID_URL', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/external/webhooks')
      .send({ url: 'not-a-url', event: 'lead.*' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_URL');
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  test('missing event AND events → 400 MISSING_EVENT', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/external/webhooks')
      .send({ url: 'https://x.test/wh' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_EVENT');
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/external/webhooks (Task 11)', () => {
  test('returns active webhooks for tenant in { data, total } shape', async () => {
    prisma.webhook.findMany.mockResolvedValueOnce([
      { id: 1, event: 'lead.*', targetUrl: 'https://gp.test/wh', isActive: true, tenantId: 7 },
      { id: 2, event: 'contact.updated', targetUrl: 'https://gp.test/wh', isActive: true, tenantId: 7 },
    ]);

    const app = makeApp();
    const res = await request(app).get('/api/v1/external/webhooks');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);

    const findArgs = prisma.webhook.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(7);
    expect(findArgs.where.isActive).toBe(true);
  });

  test('empty tenant → { data: [], total: 0 }', async () => {
    // webhook.findMany default mock returns [] from beforeEach
    const app = makeApp();
    const res = await request(app).get('/api/v1/external/webhooks');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe('DELETE /api/v1/external/webhooks/:id (Task 11)', () => {
  test('happy path: soft-deactivates (isActive=false), returns { deactivated: true }', async () => {
    prisma.webhook.findFirst.mockResolvedValueOnce({
      id: 5, event: 'lead.*', targetUrl: 'https://gp.test/wh', isActive: true, tenantId: 7,
    });
    prisma.webhook.update.mockResolvedValueOnce({
      id: 5, isActive: false,
    });

    const app = makeApp();
    const res = await request(app).delete('/api/v1/external/webhooks/5');

    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(true);

    const updateArgs = prisma.webhook.update.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(5);
    expect(updateArgs.data.isActive).toBe(false);
  });

  test('not-found in tenant → 404', async () => {
    prisma.webhook.findFirst.mockResolvedValueOnce(null);

    const app = makeApp();
    const res = await request(app).delete('/api/v1/external/webhooks/999');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });
});
