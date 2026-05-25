// @ts-check
/**
 * Unit tests for backend/routes/lead_routing.js — pin the contract of the
 * LeadRoutingRule CRUD surface + the apply / apply-all dispatchers.
 *
 * Why this file exists
 * ────────────────────
 * routes/lead_routing.js (352 LOC) had ZERO vitest coverage prior to this
 * file. It owns the LeadRoutingRule CRUD that the admin "Lead Routing" UI
 * binds to (#245), the priority + status-enum validators (#299 / #301 /
 * #302 / #332), the per-tenant + tenant-isolation guarantees on every
 * read/write, AND the apply / apply-all dispatchers that assign incoming
 * contacts to users via round-robin, specific-user, or territory strategies.
 *
 * Silent contract drift here is high-blast-radius: it mis-routes inbound
 * leads to wrong owners (revenue impact) AND the route writes
 * LeadRoutingRule.conditions as a sanitized JSON STRING (the column is
 * `String? @db.Text`) — per the v3.4.11 #245 admin-XSS sanitization audit.
 * If sanitization stops happening, an admin storing `<script>` in a rule
 * name re-renders as XSS on every other admin's rule list view.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET  /                        — list rules (tenant-scoped, priority asc)
 *   2. POST /                        — create + #299/#301/#302/#332 validation
 *   3. PUT  /:id                     — update + 404 cross-tenant + partial
 *   4. DELETE /:id                   — 200 { success: true } + 404 cross-tenant
 *   5. POST /apply/:contactId        — assign one contact via first-match rule
 *   6. POST /apply-all               — bulk assign all unassigned contacts
 *
 * Cases (17 total)
 * ────────────────
 *   list: tenant-scoped findMany with priority-asc ordering + conditions
 *     parsed from JSON-string column for response (1)
 *   create: 400 missing name; 400 zero-conditions (#302); 400 unknown status
 *     (#299); 400 priority=0 (#301); 400 priority=1000 (#332); 201 happy with
 *     conditions stringified into the @db.Text column + sanitizeText/sanitizeJson
 *     strips <script> from name + nested conditions (#245); 201 defaults
 *     (priority=100, assignType=round_robin, isActive=true) (7)
 *   update: 400 invalid :id; 404 cross-tenant (findFirst null); 200 partial
 *     toggle isActive only (no conditions revalidation); 400 conditions
 *     revalidated when provided on update (3)
 *   delete: 400 invalid :id; 404 cross-tenant; 200 { success: true } (3)
 *   apply/:contactId: 404 when contact not found (cross-tenant via findFirst);
 *     200 stamps assignedToId when a rule's conditions match + assignType is
 *     specific_user (2)
 *   apply-all: 200 returns { processed, assigned } envelope, scoped to
 *     unassigned contacts only (assignedToId=null filter) (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — fake-auth middleware in makeApp
 * populates req.user, prisma singleton patched BEFORE requiring the router,
 * eventBus.safeEmitEvent/emitEvent stubbed to no-op so best-effort emits
 * don't blow up without a DATABASE_URL.
 *
 * What's NOT covered here (deferred)
 * ──────────────────────────────────
 *   - Territory + round-robin assignee selection paths in pickAssigneeForRule
 *     (would require fuller territory + user fixtures; future expansion).
 *   - The in-memory rrCounters round-robin state; covered by the e2e
 *     lead-routing-api.spec.js smoke.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching (BEFORE the router is required) ──────────
const prisma = requireCJS('../../lib/prisma');

prisma.leadRoutingRule = prisma.leadRoutingRule || {};
prisma.leadRoutingRule.findMany = vi.fn();
prisma.leadRoutingRule.findFirst = vi.fn();
prisma.leadRoutingRule.create = vi.fn();
prisma.leadRoutingRule.update = vi.fn();
prisma.leadRoutingRule.delete = vi.fn();

prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.contact.update = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();

prisma.territory = prisma.territory || {};
prisma.territory.findMany = vi.fn();

// eventBus best-effort emit walks automationRule.findMany — stub so it
// doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── eventBus stubs ─────────────────────────────────────────────────────
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const leadRoutingRouter = requireCJS('../../routes/lead_routing');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. The lead_routing router has no role gates; the
 * global verifyToken (mounted in server.js) is the only auth check, so
 * the fake-auth here mirrors what verifyToken would supply.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/lead-routing', leadRoutingRouter);
  return app;
}

beforeEach(() => {
  prisma.leadRoutingRule.findMany.mockReset();
  prisma.leadRoutingRule.findFirst.mockReset();
  prisma.leadRoutingRule.create.mockReset();
  prisma.leadRoutingRule.update.mockReset();
  prisma.leadRoutingRule.delete.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.update.mockReset();
  prisma.user.findMany.mockReset();
  prisma.territory.findMany.mockReset();

  // Defaults — individual tests override.
  prisma.leadRoutingRule.findMany.mockResolvedValue([]);
  prisma.leadRoutingRule.findFirst.mockResolvedValue(null);
  prisma.leadRoutingRule.create.mockResolvedValue({ id: 1 });
  prisma.leadRoutingRule.update.mockResolvedValue({ id: 1 });
  prisma.leadRoutingRule.delete.mockResolvedValue({ id: 1 });
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.contact.update.mockResolvedValue({ id: 1 });
  prisma.user.findMany.mockResolvedValue([]);
  prisma.territory.findMany.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list (tenant-scoped + priority-asc ordering + JSON parse-back)
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list routing rules', () => {
  test('200 tenant-scoped + ordered by [priority asc, id asc] + conditions parsed back to object', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 10, tenantId: 42, name: 'High-value', priority: 10, conditions: JSON.stringify({ status: 'Lead' }), assignType: 'round_robin', isActive: true },
      { id: 11, tenantId: 42, name: 'Catch-all', priority: 100, conditions: JSON.stringify({ country: 'IN' }), assignType: 'round_robin', isActive: true },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/lead-routing');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Tenant-scoped + correct ordering.
    expect(prisma.leadRoutingRule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    // conditions is parsed back to an object for the response (the column is
    // a JSON-string @db.Text but the wire shape is the parsed object).
    expect(res.body[0].conditions).toEqual({ status: 'Lead' });
    expect(res.body[1].conditions).toEqual({ country: 'IN' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create with #299 / #301 / #302 / #332 validators + #245 sanitization
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create routing rule', () => {
  test('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/lead-routing')
      .send({ conditions: { status: 'Lead' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
    expect(prisma.leadRoutingRule.create).not.toHaveBeenCalled();
  });

  test('400 when conditions empty (#302 — no "any" rules allowed)', async () => {
    const res = await request(makeApp())
      .post('/api/lead-routing')
      .send({ name: 'Empty rule', conditions: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one condition is required/i);
    expect(prisma.leadRoutingRule.create).not.toHaveBeenCalled();
  });

  test('400 when conditions.status is not in ALLOWED_STATUSES (#299)', async () => {
    const res = await request(makeApp())
      .post('/api/lead-routing')
      .send({ name: 'Bogus status rule', conditions: { status: 'Banana' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid status "Banana"/i);
    expect(res.body.error).toMatch(/Lead, Prospect, Customer, Churned, Junk/);
    expect(prisma.leadRoutingRule.create).not.toHaveBeenCalled();
  });

  test('400 when priority < 1 (#301 — min)', async () => {
    const res = await request(makeApp())
      .post('/api/lead-routing')
      .send({ name: 'too-low', conditions: { status: 'Lead' }, priority: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/integer between 1 and 999/i);
    expect(prisma.leadRoutingRule.create).not.toHaveBeenCalled();
  });

  test('400 when priority > 999 (#332 — max, overflows UI chip)', async () => {
    const res = await request(makeApp())
      .post('/api/lead-routing')
      .send({ name: 'too-high', conditions: { status: 'Lead' }, priority: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/integer between 1 and 999/i);
    expect(prisma.leadRoutingRule.create).not.toHaveBeenCalled();
  });

  test('201 happy: conditions stringified for @db.Text column + name+nested-conditions sanitized (#245)', async () => {
    prisma.leadRoutingRule.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 99, ...data })
    );

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/lead-routing')
      .send({
        name: '  Hot-leads<script>alert(1)</script>  ',
        conditions: {
          status: 'Lead',
          source: 'IndiaMART<script>x</script>',
        },
        assignType: 'specific_user',
        assignTo: '7',
        priority: 5,
      });

    expect(res.status).toBe(201);
    const args = prisma.leadRoutingRule.create.mock.calls[0][0];

    // sanitizeText trims + strips <script> from name.
    expect(args.data.name).toBe('Hot-leads');
    // conditions stored as a JSON STRING (column is `String? @db.Text`).
    expect(typeof args.data.conditions).toBe('string');
    const decoded = JSON.parse(args.data.conditions);
    // sanitizeJsonForStringColumn strips <script> from the nested string.
    expect(decoded.source).toBe('IndiaMART');
    expect(decoded.status).toBe('Lead');
    // assignTo coerced to Number; tenantId from JWT.
    expect(args.data.assignTo).toBe(7);
    expect(args.data.priority).toBe(5);
    expect(args.data.tenantId).toBe(42);
    expect(args.data.assignType).toBe('specific_user');

    // Response: conditions parsed back to an object.
    expect(res.body.conditions).toEqual({ status: 'Lead', source: 'IndiaMART' });
  });

  test('201 defaults: priority=100, assignType=round_robin, isActive=true when not supplied', async () => {
    prisma.leadRoutingRule.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 100, ...data })
    );

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/lead-routing')
      .send({ name: 'Default rule', conditions: { country: 'IN' } });

    expect(res.status).toBe(201);
    const args = prisma.leadRoutingRule.create.mock.calls[0][0];
    expect(args.data.priority).toBe(100);
    expect(args.data.assignType).toBe('round_robin');
    expect(args.data.isActive).toBe(true);
    expect(args.data.assignTo).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update with cross-tenant 404 + partial-update guard
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update routing rule', () => {
  test('400 when :id is not a number', async () => {
    const res = await request(makeApp())
      .put('/api/lead-routing/not-an-int')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.leadRoutingRule.update).not.toHaveBeenCalled();
  });

  test('404 when rule belongs to a different tenant (findFirst returns null)', async () => {
    prisma.leadRoutingRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/lead-routing/777')
      .send({ name: 'Hijack attempt' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // Tenant scoping enforced on the lookup.
    expect(prisma.leadRoutingRule.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.leadRoutingRule.update).not.toHaveBeenCalled();
  });

  test('200 partial-update: isActive-only toggle does NOT re-validate conditions (must succeed)', async () => {
    prisma.leadRoutingRule.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Existing', conditions: '{}', isActive: true,
    });
    prisma.leadRoutingRule.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 50, ...data, conditions: '{}' })
    );

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/lead-routing/50')
      .send({ isActive: false });

    expect(res.status).toBe(200);
    const args = prisma.leadRoutingRule.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 50 });
    // Only isActive is in the update payload — partial-update is real.
    expect(args.data).toEqual({ isActive: false });
    // conditions NOT touched → no revalidation attempted.
    expect(args.data.conditions).toBeUndefined();
  });

  test('400 when conditions provided on update fail #299 validation', async () => {
    prisma.leadRoutingRule.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Existing', conditions: '{}',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/lead-routing/50')
      .send({ conditions: { status: 'BogusStatus' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid status "BogusStatus"/i);
    expect(prisma.leadRoutingRule.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — { success: true } envelope (NOT 204 — predates #550 sweep)
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete routing rule', () => {
  test('400 when :id is not a number', async () => {
    const res = await request(makeApp()).delete('/api/lead-routing/abc');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.leadRoutingRule.delete).not.toHaveBeenCalled();
  });

  test('404 when rule belongs to a different tenant', async () => {
    prisma.leadRoutingRule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/lead-routing/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.leadRoutingRule.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.leadRoutingRule.delete).not.toHaveBeenCalled();
  });

  test('200 { success: true } on successful delete (lead_routing predates the #550 DELETE→204 sweep)', async () => {
    prisma.leadRoutingRule.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.leadRoutingRule.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/lead-routing/50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.leadRoutingRule.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /apply/:contactId — assign a single contact via first-match rule
// ─────────────────────────────────────────────────────────────────────────

describe('POST /apply/:contactId — assign one contact', () => {
  test('404 when contact lookup returns null (cross-tenant via findFirst)', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/lead-routing/apply/123')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/contact not found/i);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 123, tenantId: 1 },
    });
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('200 stamps assignedToId when a rule matches + assignType=specific_user', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 123, tenantId: 1, status: 'Lead', country: 'IN',
    });
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      {
        id: 50,
        tenantId: 1,
        name: 'India Leads',
        // conditions stored as a JSON STRING per the column type.
        conditions: JSON.stringify({ status: 'Lead', country: 'IN' }),
        assignType: 'specific_user',
        assignTo: 99,
        isActive: true,
        priority: 10,
      },
    ]);
    prisma.contact.update.mockResolvedValue({ id: 123, assignedToId: 99 });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/lead-routing/apply/123')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      contactId: 123,
      assignedUserId: 99,
      matchedRule: { id: 50, name: 'India Leads' },
    });
    // The handler only fetches ACTIVE rules ordered priority-then-id.
    expect(prisma.leadRoutingRule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, isActive: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 123 },
      data: { assignedToId: 99 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /apply-all — bulk assign unassigned contacts only
// ─────────────────────────────────────────────────────────────────────────

describe('POST /apply-all — bulk apply rules', () => {
  test('200 { processed, assigned } scoped to unassigned contacts only (assignedToId=null filter)', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, status: 'Lead', country: 'IN' },
      { id: 2, tenantId: 1, status: 'Lead', country: 'US' }, // no matching rule
    ]);
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      {
        id: 50,
        tenantId: 1,
        conditions: JSON.stringify({ status: 'Lead', country: 'IN' }),
        assignType: 'specific_user',
        assignTo: 99,
        isActive: true,
        priority: 10,
      },
    ]);
    prisma.contact.update.mockResolvedValue({ id: 1, assignedToId: 99 });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/lead-routing/apply-all')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 2, assigned: 1 });
    // Bulk apply ONLY targets unassigned contacts.
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, assignedToId: null },
    });
    // Only the matching contact is updated.
    expect(prisma.contact.update).toHaveBeenCalledTimes(1);
    expect(prisma.contact.update.mock.calls[0][0].where).toEqual({ id: 1 });
  });
});
