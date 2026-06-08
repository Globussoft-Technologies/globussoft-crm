// @ts-check
/**
 * Unit tests for backend/routes/contacts.js — main-route contract pin.
 *
 * Why this file exists (regression class)
 * ───────────────────────────────────────
 *   routes/contacts.js is 1070 LOC and is one of the busiest central CRM
 *   surfaces — every Contacts page, the dashboard "Total Contacts" KPI, the
 *   #588 USER-scoped list, the #592 merge flow, the #167 soft-delete +
 *   restore lifecycle, and the dedup-preflight (PRD §4.5) all live here.
 *   The sister file backend/test/routes/contacts-source-filter.test.js
 *   already pins ONE slice (the #904 slice 8 ?source=<prefix> filter); this
 *   file pins the load-bearing main-route surface that has had NO direct
 *   unit-level pin — only an e2e Playwright spec.
 *
 * What this file pins (13 cases — main-route surface)
 * ───────────────────────────────────────────────────
 *   GET /api/contacts:
 *    1. List returns array + tenant-scoped where + sensible defaults
 *       (take=100, skip=0, orderBy id desc, deletedAt:null)
 *    2. ?limit=2&offset=4 honored (#172 pagination cap)
 *    3. USER role overrides assignedToId to req.user.userId (#588) — even
 *       when caller passes an explicit ?assignedToId for someone else
 *
 *   GET /api/contacts/:id:
 *    4. happy path → returns contact (with computed walletBalance:null
 *       when no linked Patient/Wallet) + tenant-scoped where
 *    5. unknown / cross-tenant id → 404
 *    6. non-numeric :id → 400 "Invalid contact ID"
 *
 *   POST /api/contacts:
 *    7. happy create → 201 + emitEvent + writeAudit; dedup preflight
 *       returns null then prisma.contact.create fires with tenantId injected
 *    8. missing required email → 400 EMAIL_REQUIRED (#160)
 *    9. dedup hit → 409 DUPLICATE_CONTACT with existingContactId +
 *       matchedBy + projection envelope (PRD §4.5)
 *
 *   PUT /api/contacts/:id:
 *   10. unknown id → 404 (existing-row check before validation/update)
 *   11. happy update → 200 + writeAudit invoked on changed fields
 *
 *   DELETE /api/contacts/:id (ADMIN-gated, soft-delete via #167):
 *   12. ADMIN delete → 200 with softDeleted:true; second DELETE on
 *       already-deleted row returns idempotent:true (#167 idempotency)
 *
 *   Auth gate (CLAUDE.md standing rule):
 *   13. no token → 401 (we exercise this via the REAL verifyToken — the
 *       other 12 tests pass-through-mock auth like the slice test does)
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/contacts-source-filter.test.js — patch
 *   verifyToken/verifyRole in the require cache as pass-through fns BEFORE
 *   the router is required, then `vi.fn()` every prisma model method the
 *   route touches. CJS self-mocking via require-cache injection for the
 *   shared lib/audit + lib/eventBus + utils/deduplication helpers so the
 *   route's `require('../lib/...')` lookups land on test doubles. JWT key
 *   is `userId` not `id` per CLAUDE.md standing rule. Pure pin — no source
 *   changes.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Patch lib/audit + lib/eventBus + utils/deduplication + middleware/fieldFilter
//    in require cache BEFORE the router is required ─────────────────────
const writeAuditMock = vi.fn().mockResolvedValue(undefined);
const diffFieldsMock = vi.fn().mockReturnValue({});
const auditPath = requireCJS.resolve('../../lib/audit.js');
Module._cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: {
    writeAudit: writeAuditMock,
    diffFields: diffFieldsMock,
  },
};

const emitEventMock = vi.fn();
const eventBusPath = requireCJS.resolve('../../lib/eventBus.js');
Module._cache[eventBusPath] = {
  id: eventBusPath,
  filename: eventBusPath,
  loaded: true,
  exports: {
    emitEvent: emitEventMock,
    onEvent: () => {},
  },
};

const findDuplicateMock = vi.fn();
const dedupPath = requireCJS.resolve('../../utils/deduplication.js');
Module._cache[dedupPath] = {
  id: dedupPath,
  filename: dedupPath,
  loaded: true,
  exports: {
    findDuplicateContactFull: findDuplicateMock,
    normalizePhone: (p) => (p ? String(p).replace(/[^0-9]/g, '') : null),
    computeDuplicateGroupKey: (a, rest) => `key:${[a, ...rest].sort().join(',')}`,
  },
};

// markFirstResponseIfNeeded is called in POST /:id/activities — out of
// our pin scope but still loaded at require-time via leadSla; stub it.
const leadSlaPath = requireCJS.resolve('../../lib/leadSla.js');
try {
  Module._cache[leadSlaPath] = {
    id: leadSlaPath,
    filename: leadSlaPath,
    loaded: true,
    exports: { markFirstResponseIfNeeded: vi.fn().mockResolvedValue(undefined) },
  };
} catch (_e) { /* module may not exist; ignore */ }

// fieldFilter: make filter*Fields a pass-through.
const fieldFilterPath = requireCJS.resolve('../../middleware/fieldFilter.js');
Module._cache[fieldFilterPath] = {
  id: fieldFilterPath,
  filename: fieldFilterPath,
  loaded: true,
  exports: {
    filterReadFields: async (rows) => rows,
    filterWriteFields: async (body) => body,
  },
};

// audienceController: GET /by-status is mounted at module load.
const audienceCtrlPath = requireCJS.resolve('../../controllers/audienceController.js');
try {
  Module._cache[audienceCtrlPath] = {
    id: audienceCtrlPath,
    filename: audienceCtrlPath,
    loaded: true,
    exports: {
      getContactsByStatus: (_req, res) => res.json([]),
    },
  };
} catch (_e) { /* ignore if missing */ }

// ── Patch auth middleware. We keep a switch so test 13 can opt back into
//    the REAL verifyToken to exercise the no-token 401 path. ────────────
const authMw = requireCJS('../../middleware/auth');
const realVerifyToken = authMw.verifyToken;
const realVerifyRole = authMw.verifyRole;
const authState = { useReal: false };
authMw.verifyToken = (req, res, next) => {
  if (authState.useReal) return realVerifyToken(req, res, next);
  return next();
};
authMw.verifyRole = (roles) => (req, res, next) => {
  if (authState.useReal) return realVerifyRole(roles)(req, res, next);
  return next();
};

// ── Prisma singleton patching — every model method touched by the
//    pinned endpoints. ──────────────────────────────────────────────────
prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.contact.findFirst = vi.fn();
prisma.contact.create = vi.fn();
prisma.contact.update = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn().mockResolvedValue(null);
prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn().mockResolvedValue(null);
// T31: webhook.findMany is invoked by lib/webhookDelivery.js when the route
// emits contact.created / contact.updated via eventBus. Empty array → the
// helper short-circuits (no subscribers) so happy create / update / delete
// tests don't hang trying to reach the real DB at 163.227.174.141:3306.
prisma.webhook = prisma.webhook || {};
prisma.webhook.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
const contactsRouter = requireCJS('../../routes/contacts');

const TENANT_ID = 1;
const USER_ID = 7;

const SAMPLE_CONTACT = {
  id: 9001,
  name: 'Amita Rao',
  email: 'amita@example.com',
  phone: '+919876543210',
  status: 'Lead',
  source: 'inbound:voyagr',
  tenantId: TENANT_ID,
  assignedToId: USER_ID,
  deletedAt: null,
  activities: [],
  tasks: [],
  deals: [],
  assignedTo: null,
};

/**
 * Mount the router behind a small middleware that stamps req.user. Used
 * for every test EXCEPT the auth-gate one (which toggles authState.useReal
 * and omits the stamp middleware so the real verifyToken sees no Authorization
 * header).
 */
function makeApp({ tenantId = TENANT_ID, userId = USER_ID, role = 'ADMIN', skipAuth = false } = {}) {
  const app = express();
  app.use(express.json());
  if (!skipAuth) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/contacts', contactsRouter);
  return app;
}

beforeEach(() => {
  prisma.contact.findMany.mockReset().mockResolvedValue([SAMPLE_CONTACT]);
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.create.mockReset();
  prisma.contact.update.mockReset();
  prisma.patient.findFirst.mockReset().mockResolvedValue(null);
  prisma.wallet.findFirst.mockReset().mockResolvedValue(null);
  prisma.webhook.findMany.mockReset().mockResolvedValue([]);
  writeAuditMock.mockReset().mockResolvedValue(undefined);
  diffFieldsMock.mockReset().mockReturnValue({});
  emitEventMock.mockReset();
  findDuplicateMock.mockReset().mockResolvedValue(null);
  authState.useReal = false;
});

// ─────────────────────────────────────────────────────────────────────
describe('GET /api/contacts — list', () => {
  test('returns array; where is tenant-scoped + deletedAt:null + defaults take=100 skip=0 orderBy id desc', async () => {
    const res = await request(makeApp()).get('/api/contacts');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(prisma.contact.findMany).toHaveBeenCalledOnce();
    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(TENANT_ID);
    expect(args.where.deletedAt).toBeNull();
    expect(args.take).toBe(100);
    expect(args.skip).toBe(0);
    expect(args.orderBy).toEqual({ id: 'desc' });
  });

  test('?limit=2&offset=4 honored (#172 pagination)', async () => {
    const res = await request(makeApp()).get('/api/contacts?limit=2&offset=4');

    expect(res.status).toBe(200);
    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args.take).toBe(2);
    expect(args.skip).toBe(4);
  });

  test('USER role overrides assignedToId to req.user.userId — sales rep cannot probe a colleague (#588)', async () => {
    const res = await request(makeApp({ role: 'USER', userId: 42 }))
      .get('/api/contacts?assignedToId=999');

    expect(res.status).toBe(200);
    const args = prisma.contact.findMany.mock.calls[0][0];
    // USER role MUST win even when caller passes ?assignedToId=999.
    expect(args.where.assignedToId).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('GET /api/contacts/:id — read', () => {
  test('happy path → returns contact + walletBalance:null (no linked Patient) + tenant-scoped where', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(SAMPLE_CONTACT);

    const res = await request(makeApp()).get('/api/contacts/9001');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 9001,
      name: 'Amita Rao',
      email: 'amita@example.com',
      walletBalance: null, // computed surface — no Patient row, null per PRD §1.1e
    });
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({ id: 9001, tenantId: TENANT_ID });
  });

  test('unknown / cross-tenant id → 404 Contact not found', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get('/api/contacts/424242');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Contact not found' });
  });

  test('non-numeric :id → 400 Invalid contact ID; findFirst NOT called', async () => {
    const res = await request(makeApp()).get('/api/contacts/not-a-number');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid contact ID' });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('POST /api/contacts — create', () => {
  test('happy create → 201 + tenantId injected + writeAudit + emitEvent(contact.created)', async () => {
    const created = {
      id: 12345,
      name: 'Rohan Kapoor',
      email: 'rohan@example.com',
      phone: '+919811000123',
      tenantId: TENANT_ID,
      assignedToId: USER_ID,
      status: 'Lead',
    };
    findDuplicateMock.mockResolvedValueOnce(null);
    prisma.contact.create.mockResolvedValueOnce(created);

    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Rohan Kapoor',
        email: 'rohan@example.com',
        phone: '+919811000123',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 12345, name: 'Rohan Kapoor' });

    // tenantId injected on Prisma create (caller didn't send it; stripDangerous
    // would strip it anyway — but the route ALSO injects from req.user).
    expect(prisma.contact.create).toHaveBeenCalledOnce();
    const data = prisma.contact.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(TENANT_ID);
    expect(data.email).toBe('rohan@example.com');
    // Default assignedToId = req.user.userId (#588).
    expect(data.assignedToId).toBe(USER_ID);

    // Audit + event side-effects.
    expect(writeAuditMock).toHaveBeenCalledOnce();
    const auditArgs = writeAuditMock.mock.calls[0];
    expect(auditArgs[0]).toBe('Contact');
    expect(auditArgs[1]).toBe('CREATE');
    expect(auditArgs[2]).toBe(12345);
    expect(emitEventMock).toHaveBeenCalledOnce();
    expect(emitEventMock.mock.calls[0][0]).toBe('contact.created');
  });

  test('missing required email → 400 EMAIL_REQUIRED (#160); prisma NOT called', async () => {
    const res = await request(makeApp())
      .post('/api/contacts')
      .send({ name: 'No Email Person' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMAIL_REQUIRED' });
    expect(findDuplicateMock).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('dedup hit → 409 DUPLICATE_CONTACT with existingContactId + matchedBy + contact projection (PRD §4.5)', async () => {
    findDuplicateMock.mockResolvedValueOnce({
      matchedBy: 'phone',
      contact: {
        id: 8888,
        name: 'Existing Customer',
        email: 'existing@example.com',
        phone: '+919811000123',
        company: 'Acme Corp',
        status: 'Customer',
        subBrand: null,
      },
    });

    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Rohan Kapoor',
        email: 'rohan@example.com',
        phone: '+919811000123',
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'DUPLICATE_CONTACT',
      matchedBy: 'phone',
      existingContactId: 8888,
      contact: {
        id: 8888,
        name: 'Existing Customer',
        email: 'existing@example.com',
      },
    });
    // CRUCIALLY: contact.create NEVER fires on a dedup hit (PRD §4.5).
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('PUT /api/contacts/:id — update', () => {
  test('unknown id → 404 Contact not found; update NOT called', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .put('/api/contacts/424242')
      .send({ name: 'New Name' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Contact not found' });
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('happy update → 200 + writeAudit invoked when fields changed', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(SAMPLE_CONTACT);
    const updated = { ...SAMPLE_CONTACT, name: 'Amita Rao (Updated)' };
    prisma.contact.update.mockResolvedValueOnce(updated);
    diffFieldsMock.mockReturnValueOnce({ name: { from: 'Amita Rao', to: 'Amita Rao (Updated)' } });

    const res = await request(makeApp())
      .put('/api/contacts/9001')
      .send({ name: 'Amita Rao (Updated)' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 9001, name: 'Amita Rao (Updated)' });
    expect(prisma.contact.update).toHaveBeenCalledOnce();
    expect(prisma.contact.update.mock.calls[0][0].where).toEqual({ id: 9001 });
    // writeAudit fires because diffFields returned a non-empty changeset.
    expect(writeAuditMock).toHaveBeenCalledOnce();
    expect(writeAuditMock.mock.calls[0][1]).toBe('UPDATE');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('DELETE /api/contacts/:id — soft-delete (ADMIN-gated, #167)', () => {
  test('ADMIN delete → 200 with softDeleted:true; second DELETE on already-deleted row returns idempotent:true', async () => {
    // First DELETE: row is live, gets soft-deleted.
    prisma.contact.findFirst.mockResolvedValueOnce(SAMPLE_CONTACT);
    prisma.contact.update.mockResolvedValueOnce({
      ...SAMPLE_CONTACT,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });
    // The #167 handler also writes an auditLog row directly (best-effort).
    prisma.auditLog = prisma.auditLog || {};
    prisma.auditLog.create = vi.fn().mockResolvedValue({});

    const res1 = await request(makeApp())
      .delete('/api/contacts/9001');

    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({
      id: SAMPLE_CONTACT.id,
      softDeleted: true,
    });
    expect(prisma.contact.update).toHaveBeenCalledOnce();
    expect(prisma.contact.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);

    // Second DELETE: row is already soft-deleted → idempotent envelope, NO update.
    prisma.contact.update.mockClear();
    prisma.contact.findFirst.mockResolvedValueOnce({
      ...SAMPLE_CONTACT,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const res2 = await request(makeApp())
      .delete('/api/contacts/9001');

    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({
      id: SAMPLE_CONTACT.id,
      idempotent: true,
      softDeleted: true,
    });
    // No second update — the first was a no-op skip.
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//
// #920 slice 1 — opt-in slim shape via ?fields=summary
//
// Pins the additive PII-reduction surface: when a caller passes
// ?fields=summary on GET /api/contacts, Prisma is called with an explicit
// `select` (no `include`) so the wire payload drops nested activities/
// tasks/assignedTo + sensitive flat fields (phone/walletBalance/gst/
// birthDate/anniversary/address). When ?fields is absent or any other
// value, the existing full-shape `include` is preserved so no existing
// consumer is impacted.
//
// ─────────────────────────────────────────────────────────────────────
describe('GET /api/contacts?fields=summary — opt-in slim shape (#920 slice 1)', () => {
  const SLIM_ROW = {
    id: 9001,
    name: 'Amita Rao',
    email: 'amita@example.com',
    status: 'Lead',
    assignedToId: USER_ID,
    tenantId: TENANT_ID,
    createdAt: new Date('2026-01-15T10:30:00Z'),
  };

  test('?fields=summary → response rows expose ONLY {id,name,email,status,assignedToId,tenantId,createdAt} (no phone/wallet/gst/birthDate/anniversary/activities/tasks/assignedTo)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([SLIM_ROW]);

    const res = await request(makeApp()).get('/api/contacts?fields=summary');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    // Allowed keys only.
    const allowed = ['id', 'name', 'email', 'status', 'assignedToId', 'tenantId', 'createdAt'];
    for (const k of allowed) expect(row).toHaveProperty(k);
    // Forbidden keys must be ABSENT (slim Prisma select would not return them).
    for (const k of ['phone', 'walletBalance', 'gst', 'birthDate', 'anniversary', 'address', 'activities', 'tasks', 'assignedTo']) {
      expect(row).not.toHaveProperty(k);
    }
  });

  test('?fields=summary → prisma.contact.findMany invoked with `select` (not `include`)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([SLIM_ROW]);

    await request(makeApp()).get('/api/contacts?fields=summary');

    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args).toHaveProperty('select');
    expect(args).not.toHaveProperty('include');
    expect(args.select).toEqual({
      id: true,
      name: true,
      email: true,
      status: true,
      assignedToId: true,
      tenantId: true,
      createdAt: true,
    });
  });

  test('?fields= (empty) → existing full shape (include, not select)', async () => {
    await request(makeApp()).get('/api/contacts?fields=');

    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args).toHaveProperty('include');
    expect(args).not.toHaveProperty('select');
    expect(args.include).toMatchObject({
      activities: true,
      tasks: true,
      assignedTo: { select: { id: true, name: true, email: true } },
    });
  });

  test('?fields=anything-else → existing full shape (opt-in only on exact "summary" value)', async () => {
    await request(makeApp()).get('/api/contacts?fields=basic');

    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args).toHaveProperty('include');
    expect(args).not.toHaveProperty('select');
  });

  test('?fields=summary preserves auth + tenant-isolation — where.tenantId mirrors req.user.tenantId', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([SLIM_ROW]);

    await request(makeApp({ tenantId: 4242 })).get('/api/contacts?fields=summary');

    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(4242);
    expect(args.where.deletedAt).toBeNull();
  });

  test('?fields=summary + ?limit=10 + ?offset=5 → slim shape honours pagination (take/skip still applied)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([SLIM_ROW]);

    const res = await request(makeApp()).get('/api/contacts?fields=summary&limit=10&offset=5');

    expect(res.status).toBe(200);
    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(5);
    // Slim select still in place under pagination.
    expect(args).toHaveProperty('select');
    expect(args).not.toHaveProperty('include');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('Auth gate — verifyToken (CLAUDE.md standing rule)', () => {
  test('no Authorization header → 401', async () => {
    authState.useReal = true; // engage the REAL verifyToken
    const app = makeApp({ skipAuth: true }); // omit the req.user-stamping middleware

    const res = await request(app).get('/api/contacts');

    expect(res.status).toBe(401);
    // Real verifyToken should also NOT have invoked Prisma — the auth gate
    // short-circuits before any route handler runs.
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    // Suppress unused-import lint if jsonwebtoken is unused at runtime:
    // we intentionally import it to keep the harness honest about the
    // verifyToken contract (HS256 JWT). The actual 401 path is hit via
    // header-absent, no token decode required.
    expect(jwt).toBeDefined();
  });
});
