// @ts-check
/**
 * Unit tests for backend/routes/workflows.js — pin the contract of the
 * automation-rule CRUD surface + trigger/action enum gate + condition JSON
 * validator + test-fire endpoint.
 *
 * Why this file exists
 * ────────────────────
 * routes/workflows.js (363 LOC) had ZERO vitest coverage prior to this
 * file. It owns the AutomationRule CRUD that the entire workflow engine
 * runs against (every cron tick walks `automationRule.findMany` on every
 * tenant), the trigger/action enum whitelist gate (#18) that prevents the
 * engine from silently logging "Unknown actionType" at execute time, the
 * condition-JSON validator (#20) that catches malformed predicates before
 * persistence, the PUT-side isActive toggle (#19) shortcut, the dedicated
 * /toggle endpoint, the /test fire endpoint that emits a mock payload
 * through eventBus, and the /history audit-log feed. Silent contract drift
 * on any of these would either red existing workflow-engine specs OR
 * (worse) accept rules whose triggers/actions/conditions are unrecognized
 * and silently dropped at runtime. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET    /triggers         — list supported trigger whitelist
 *   2. GET    /actions          — list supported action whitelist
 *   3. GET    /history          — paged AuditLog feed (tenant-scoped)
 *   4. GET    /                 — list AutomationRule for tenant
 *   5. GET    /:id              — fetch single rule (cross-tenant 404)
 *   6. POST   /                 — create rule with enum + condition gates
 *   7. PUT    /:id              — update rule with enum + condition gates
 *   8. PUT    /:id/toggle       — flip isActive
 *   9. DELETE /:id              — delete rule
 *  10. POST   /:id/test         — manually fire via eventBus.emitEvent
 *
 * Cases (24 total)
 * ────────────────
 *   triggers/actions: each returns its full whitelist with {value,label} (2)
 *   history: paged + tenant-scoped findMany + count, default limit 50 (2)
 *   list: tenant-scoped findMany (1)
 *   get-one: 400 INVALID_ID on non-int / id<1; 404 cross-tenant; happy 200 (3)
 *   create: 400 missing fields; 400 INVALID_TRIGGER_TYPE on unknown;
 *     400 INVALID_ACTION_TYPE on unknown; 400 INVALID_CONDITION on bad JSON;
 *     400 INVALID_CONDITION when not an array; 400 INVALID_CONDITION on
 *     bad clause.op; happy 201 with targetState object stringified;
 *     happy 201 with valid condition array stringified (8)
 *   update: 404 cross-tenant; 400 INVALID_TRIGGER_TYPE on unknown;
 *     happy 200 partial-update; isActive coerced to bool (#19) (4)
 *   toggle: 404 cross-tenant; happy 200 flips isActive (2)
 *   delete: 404 cross-tenant; happy 200 { success: true } (2)
 *   test fire: 404 cross-tenant; happy 200 delegates to emitEvent with
 *     mock payload + req.user.tenantId (2)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js (auth-middleware bypass +
 * prisma singleton monkey-patch BEFORE requiring the router). The
 * workflows router doesn't require verifyToken itself (the global guard
 * does), so we install a fake-auth middleware in makeApp that populates
 * req.user with { userId, tenantId, role, email }.
 *
 * eventBus is patched the same way as sla.test.js patches slaBreachEngine
 * — both emitEvent and safeEmitEvent exports are swapped for vi.fn()s on
 * the module-exports object BEFORE the router is required. The route's
 * /:id/test handler does an inline `const { emitEvent } = require(...)`
 * at request time, so the patched export is captured at that call site.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn();
prisma.automationRule.findFirst = vi.fn();
prisma.automationRule.create = vi.fn();
prisma.automationRule.update = vi.fn();
prisma.automationRule.delete = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.findMany = vi.fn();
prisma.auditLog.count = vi.fn();
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── eventBus stubs (CJS self-mocking seam) ─────────────────────────────
// The /:id/test handler does `const { emitEvent } = require('../lib/eventBus')`
// at request time; we patch the exports BEFORE requiring the router so the
// destructure captures our mock.
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const workflowsRouter = requireCJS('../../routes/workflows');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Default role = ADMIN; the workflows router itself
 * does NOT verifyRole (relies on the global guard) — role is included for
 * shape parity with other route tests.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', email = 'admin@example.com' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, email };
    next();
  });
  app.use('/api/workflows', workflowsRouter);
  return app;
}

beforeEach(() => {
  prisma.automationRule.findMany.mockReset();
  prisma.automationRule.findFirst.mockReset();
  prisma.automationRule.create.mockReset();
  prisma.automationRule.update.mockReset();
  prisma.automationRule.delete.mockReset();
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.count.mockReset();
  eventBus.emitEvent.mockReset();

  // Sensible defaults — individual tests override.
  prisma.automationRule.findMany.mockResolvedValue([]);
  prisma.automationRule.findFirst.mockResolvedValue(null);
  prisma.automationRule.create.mockResolvedValue({ id: 1 });
  prisma.automationRule.update.mockResolvedValue({ id: 1 });
  prisma.automationRule.delete.mockResolvedValue({ id: 1 });
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.auditLog.count.mockResolvedValue(0);
  eventBus.emitEvent.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /triggers — static whitelist
// ─────────────────────────────────────────────────────────────────────────

describe('GET /triggers — list supported trigger types', () => {
  test('200 returns array of { value, label, description } entries with the core triggers present', async () => {
    const res = await request(makeApp()).get('/api/workflows/triggers');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Spot-check a representative subset rather than pinning the whole list
    // verbatim — the route owns the canonical list and ALWAYS-allows
    // additions; we just guarantee shape + presence of load-bearing values.
    const values = res.body.map((t) => t.value);
    expect(values).toContain('contact.created');
    expect(values).toContain('deal.won');
    expect(values).toContain('invoice.paid');
    expect(values).toContain('sla.breached');
    expect(values).toContain('membership.renewal_due');
    // Every entry must have the three documented fields.
    for (const t of res.body) {
      expect(typeof t.value).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /actions — static whitelist
// ─────────────────────────────────────────────────────────────────────────

describe('GET /actions — list supported action types', () => {
  test('200 returns array of { value, label, config } entries with the core actions present', async () => {
    const res = await request(makeApp()).get('/api/workflows/actions');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const values = res.body.map((a) => a.value);
    expect(values).toContain('send_email');
    expect(values).toContain('send_sms');
    expect(values).toContain('send_notification');
    expect(values).toContain('create_task');
    expect(values).toContain('send_webhook');
    expect(values).toContain('create_approval');
    for (const a of res.body) {
      expect(typeof a.value).toBe('string');
      expect(typeof a.label).toBe('string');
      expect(Array.isArray(a.config)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /history — paged AuditLog feed
// ─────────────────────────────────────────────────────────────────────────

describe('GET /history — workflow execution history', () => {
  test('200 default limit=50 offset=0 with tenant-scoped findMany + count', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 1, entity: 'AutomationRule', action: 'WORKFLOW', detail: 'fired', createdAt: new Date() },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/workflows/history');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.body.logs).toHaveLength(1);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, entity: 'AutomationRule', action: 'WORKFLOW' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip: 0,
    });
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: { tenantId: 42, entity: 'AutomationRule', action: 'WORKFLOW' },
    });
  });

  test('200 honors ?limit + ?offset and caps limit at 200', async () => {
    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/workflows/history?limit=999&offset=25');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200); // capped from 999
    expect(res.body.offset).toBe(25);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, skip: 25 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list automation rules
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list automation rules', () => {
  test('200 with tenant-scoped findMany', async () => {
    prisma.automationRule.findMany.mockResolvedValue([
      { id: 1, name: 'Welcome email', triggerType: 'contact.created', actionType: 'send_email', isActive: true },
    ]);

    const res = await request(makeApp({ tenantId: 99 })).get('/api/workflows');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 99 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — single rule with cross-tenant 404
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id — fetch single rule', () => {
  test('400 INVALID_ID when :id is not a positive integer', async () => {
    const res = await request(makeApp()).get('/api/workflows/abc');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.automationRule.findFirst).not.toHaveBeenCalled();
  });

  test('400 INVALID_ID when :id is 0', async () => {
    const res = await request(makeApp()).get('/api/workflows/0');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('404 when rule belongs to a different tenant (findFirst returns null)', async () => {
    prisma.automationRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/workflows/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.automationRule.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
  });

  test('200 returns rule when found in tenant', async () => {
    prisma.automationRule.findFirst.mockResolvedValue({
      id: 50,
      tenantId: 1,
      name: 'Notify on deal won',
      triggerType: 'deal.won',
      actionType: 'send_notification',
    });

    const res = await request(makeApp({ tenantId: 1 })).get('/api/workflows/50');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(50);
    expect(res.body.triggerType).toBe('deal.won');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create rule with enum + condition gates
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create automation rule', () => {
  test('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({ triggerType: 'contact.created', actionType: 'send_email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name.*triggerType.*actionType/i);
    expect(prisma.automationRule.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_TRIGGER_TYPE (#18) when triggerType is not in whitelist', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({ name: 'Bad rule', triggerType: 'bogus.event', actionType: 'send_email' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TRIGGER_TYPE');
    expect(Array.isArray(res.body.allowed)).toBe(true);
    expect(res.body.allowed).toContain('contact.created');
    expect(prisma.automationRule.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_ACTION_TYPE (#18) when actionType is not in whitelist', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({ name: 'Bad rule', triggerType: 'contact.created', actionType: 'bogus_action' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ACTION_TYPE');
    expect(Array.isArray(res.body.allowed)).toBe(true);
    expect(res.body.allowed).toContain('send_email');
  });

  test('400 INVALID_CONDITION (#20) when condition string is not valid JSON', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'Bad cond',
        triggerType: 'contact.created',
        actionType: 'send_email',
        condition: '{not-json',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONDITION');
    expect(res.body.error).toMatch(/valid json/i);
    expect(prisma.automationRule.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_CONDITION when condition parses but is not an array', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'Bad cond',
        triggerType: 'contact.created',
        actionType: 'send_email',
        condition: '{"field":"x","op":"eq","value":1}',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONDITION');
    expect(res.body.error).toMatch(/array of clauses/i);
  });

  test('400 INVALID_CONDITION when clause.op is not in allowed ops', async () => {
    const res = await request(makeApp())
      .post('/api/workflows')
      .send({
        name: 'Bad cond',
        triggerType: 'contact.created',
        actionType: 'send_email',
        condition: [{ field: 'email', op: 'BAD_OP', value: 'x' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONDITION');
    expect(res.body.error).toMatch(/clause\.op must be one of/i);
  });

  test('201 happy path with targetState object stringified + tenantId from JWT', async () => {
    prisma.automationRule.create.mockResolvedValue({
      id: 99,
      name: 'Welcome',
      triggerType: 'contact.created',
      actionType: 'send_email',
      targetState: '{"to":"{{contact.email}}","subject":"Welcome","body":"Hi"}',
      condition: null,
      tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/workflows')
      .send({
        name: 'Welcome',
        triggerType: 'contact.created',
        actionType: 'send_email',
        targetState: { to: '{{contact.email}}', subject: 'Welcome', body: 'Hi' },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    const createArg = prisma.automationRule.create.mock.calls[0][0].data;
    expect(createArg.tenantId).toBe(42);
    expect(createArg.name).toBe('Welcome');
    expect(createArg.triggerType).toBe('contact.created');
    expect(createArg.actionType).toBe('send_email');
    // Object targetState gets JSON.stringified at the route layer.
    expect(typeof createArg.targetState).toBe('string');
    expect(JSON.parse(createArg.targetState)).toEqual({
      to: '{{contact.email}}', subject: 'Welcome', body: 'Hi',
    });
    expect(createArg.condition).toBeNull();
  });

  test('201 happy path with valid condition array gets canonicalised to JSON string', async () => {
    prisma.automationRule.create.mockResolvedValue({ id: 100 });

    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/workflows')
      .send({
        name: 'High-value deals',
        triggerType: 'deal.won',
        actionType: 'send_notification',
        targetState: '{}',
        condition: [{ field: 'value', op: 'gte', value: 10000 }],
      });

    expect(res.status).toBe(201);
    const createArg = prisma.automationRule.create.mock.calls[0][0].data;
    expect(typeof createArg.condition).toBe('string');
    expect(JSON.parse(createArg.condition)).toEqual([
      { field: 'value', op: 'gte', value: 10000 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update rule
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update automation rule', () => {
  test('404 when rule belongs to a different tenant', async () => {
    prisma.automationRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/workflows/777')
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.automationRule.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.automationRule.update).not.toHaveBeenCalled();
  });

  test('400 INVALID_TRIGGER_TYPE (#18) on update too', async () => {
    prisma.automationRule.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });

    const res = await request(makeApp())
      .put('/api/workflows/50')
      .send({ triggerType: 'bogus.event' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TRIGGER_TYPE');
    expect(prisma.automationRule.update).not.toHaveBeenCalled();
  });

  test('200 partial-update: only supplied fields written, omitted fields untouched', async () => {
    prisma.automationRule.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.automationRule.update.mockResolvedValue({ id: 50, name: 'Renamed' });

    const res = await request(makeApp())
      .put('/api/workflows/50')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(prisma.automationRule.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { name: 'Renamed' },
    });
  });

  test('200 isActive coerced to bool (#19 — PUT-side toggle shortcut)', async () => {
    prisma.automationRule.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.automationRule.update.mockResolvedValue({ id: 50, isActive: false });

    const res = await request(makeApp())
      .put('/api/workflows/50')
      .send({ isActive: 0 /* falsy → coerced to false */ });

    expect(res.status).toBe(200);
    expect(prisma.automationRule.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { isActive: false },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id/toggle — flip isActive
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id/toggle — flip isActive', () => {
  test('404 when rule belongs to a different tenant', async () => {
    prisma.automationRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).put('/api/workflows/777/toggle');

    expect(res.status).toBe(404);
    expect(prisma.automationRule.update).not.toHaveBeenCalled();
  });

  test('200 inverts isActive (true → false)', async () => {
    prisma.automationRule.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, isActive: true,
    });
    prisma.automationRule.update.mockResolvedValue({
      id: 50, tenantId: 1, isActive: false,
    });

    const res = await request(makeApp()).put('/api/workflows/50/toggle');

    expect(res.status).toBe(200);
    expect(prisma.automationRule.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { isActive: false },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — delete rule
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete rule', () => {
  test('404 when rule belongs to a different tenant', async () => {
    prisma.automationRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/workflows/777');

    expect(res.status).toBe(404);
    expect(prisma.automationRule.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.automationRule.delete).not.toHaveBeenCalled();
  });

  test('200 { success: true } on successful delete', async () => {
    prisma.automationRule.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.automationRule.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp()).delete('/api/workflows/50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.automationRule.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/test — manually fire a rule via eventBus.emitEvent
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/test — manually fire rule', () => {
  test('404 when rule belongs to a different tenant', async () => {
    prisma.automationRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/workflows/777/test')
      .send({});

    expect(res.status).toBe(404);
    expect(eventBus.emitEvent).not.toHaveBeenCalled();
  });

  test('200 delegates to emitEvent with mock payload + req.user.tenantId', async () => {
    prisma.automationRule.findFirst.mockResolvedValue({
      id: 50,
      tenantId: 1,
      name: 'Welcome email',
      triggerType: 'contact.created',
    });

    const res = await request(makeApp({ tenantId: 1, userId: 7, email: 'admin@example.com' }))
      .post('/api/workflows/50/test')
      .send({ contactId: 999 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.message).toMatch(/Welcome email/);
    expect(res.body.message).toMatch(/contact\.created/);
    expect(eventBus.emitEvent).toHaveBeenCalledTimes(1);
    const [trigger, payload, tenantId] = eventBus.emitEvent.mock.calls[0];
    expect(trigger).toBe('contact.created');
    expect(tenantId).toBe(1);
    expect(payload).toMatchObject({
      userId: 7,
      tenantId: 1,
      contactId: 999,
      email: 'admin@example.com',
      _test: true,
    });
  });
});
