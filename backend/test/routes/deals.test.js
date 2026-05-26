// @ts-check
/**
 * Unit tests for backend/routes/deals.js — pin the Deal CRUD + pipeline
 * stage-transitions + win/loss + /stats contract against accidental regression.
 *
 * Why this file exists
 * ────────────────────
 * deals.js is a 633-LOC route surface that backs the Pipeline page, Dashboard
 * KPIs, and forecasting. Several historical issues are encoded in its
 * contract:
 *   - #188      — `parseInt('foo') ⇒ NaN` short-circuit at the param level
 *                 (return 400 INVALID_ID instead of leaking 500 on bare
 *                 GET /api/deals/funnel until that literal route exists).
 *   - #162 #173 — Stage is a closed enum
 *                 {lead, contacted, proposal, negotiation, won, lost};
 *                 unknown stage → 400 INVALID_STAGE.
 *   - #162 #168 — amount + probability bounds validation; bad inputs return
 *                 400, not 500.
 *   - #167      — DELETE is a SOFT delete (sets deletedAt); list endpoint
 *                 excludes soft-deleted unless ?includeDeleted=true; restore
 *                 is admin-gated and idempotent.
 *   - #173      — Terminal-stage state machine: once a deal is `won` or
 *                 `lost`, PUT-flipping the stage to anything else returns 422
 *                 INVALID_DEAL_TRANSITION (forecast / win-loss history are
 *                 frozen at terminal).
 *   - #567      — /stats returns the additive aggregate envelope
 *                 (totalDeals, totalValue, avgDealSize, winRate, byStage,
 *                 closedThisMonth, wonCount, wonValue, lostCount, lostValue,
 *                 expectedValue) computed over the FULL tenant population,
 *                 not a paginated window.
 *   - #588      — USER role sees own-deals only (ownerId scoped to
 *                 req.user.userId); ADMIN/MANAGER see full tenant aggregates.
 *
 * What this file pins
 * ───────────────────
 *   1. GET /         — tenant-scoping in `where`, soft-delete exclusion by
 *                      default, USER-role own-deals override.
 *   2. GET /:id      — happy path, 404 on missing, INVALID_ID param guard.
 *   3. POST /        — happy path (defaults currency from tenant), 400 on
 *                      missing title, 400 on invalid stage, 400 on negative
 *                      amount.
 *   4. PUT /:id      — happy update; terminal-stage 422 from `won`; 404 on
 *                      missing.
 *   5. POST /:id/won — flips to won, probability → 100, emits deal.won.
 *   6. POST /:id/lost — flips to lost, probability → 0, persists lostReason.
 *   7. DELETE /:id   — soft delete (sets deletedAt); idempotent on re-delete.
 *   8. GET /stats    — aggregate envelope shape; USER role narrows ownerId.
 *
 * Pattern reference: backend/test/routes/billing.test.js (a218f556) — same
 * auth-middleware-bypass + prisma-singleton-monkey-patch + eventBus stub
 * pattern. The route's CJS `require('../middleware/auth')` + destructured
 * `verifyToken` / `verifyRole` is replaced at module-load with pass-through
 * fns so we exercise route logic without minting JWTs. `req.user` is
 * injected by the test's express middleware.
 *
 * What this file does NOT cover (intentional, out of scope for ≥12 cases):
 *   - POST /:id/restore   — admin-gated undo of the soft-delete; symmetric to
 *                           DELETE/idempotent and covered by API-spec smoke.
 *   - PUT /:id/stage      — legacy backwards-compat shape; not used by the
 *                           current Pipeline UI which goes through PUT /:id.
 *   - GET /:id/timeline   — merged activity/email/call/task timeline; covered
 *                           by dedicated timeline integration specs.
 *   - includeDeleted=true — flag is read by GET /:id and GET / but assertion
 *                           value is small relative to setup overhead.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch the auth middleware BEFORE the deals router is required — the
// router does `const { verifyToken, verifyRole } = require(...)` at
// module-load, so the destructured reference captures whatever
// `authMw.{verifyToken,verifyRole}` points at THE MOMENT the route is
// required. Pass-through both so handlers see whatever req.user we inject.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// Patch eventBus.emitEvent BEFORE the router is required so emit attempts
// from inside the route don't hit the real DB-backed workflow path. The
// route already wraps every emit in try/catch, but stubbing keeps the
// test output clean.
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);

// Prisma singleton patching — replace the lazy delegates with bare vi.fn()
// surfaces. The route touches deal, activity, tenant, auditLog, and
// (transitively, via filterReadFields/filterWriteFields) fieldPermission.
prisma.deal = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.activity = {
  create: vi.fn(),
  findMany: vi.fn(),
};
prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.findMany = vi.fn().mockResolvedValue([]);
prisma.callLog = prisma.callLog || {};
prisma.callLog.findMany = vi.fn().mockResolvedValue([]);
prisma.task = prisma.task || {};
prisma.task.findMany = vi.fn().mockResolvedValue([]);
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.auditLog = {
  findFirst: vi.fn(),
  create: vi.fn(),
};
// fieldFilter helpers query this — return empty perms so they no-op.
prisma.fieldPermission = {
  findMany: vi.fn().mockResolvedValue([]),
};

import express from 'express';
import request from 'supertest';
const dealsRouter = requireCJS('../../routes/deals');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/deals', dealsRouter);
  return app;
}

beforeEach(() => {
  prisma.deal.findMany.mockReset();
  prisma.deal.findFirst.mockReset();
  prisma.deal.create.mockReset();
  prisma.deal.update.mockReset();
  prisma.activity.create.mockReset();
  prisma.activity.findMany.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.fieldPermission.findMany.mockReset();
  prisma.fieldPermission.findMany.mockResolvedValue([]);
  // Sensible defaults — happy-path resolves.
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.activity.create.mockResolvedValue({ id: 100 });
  prisma.activity.findMany.mockResolvedValue([]);
  prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'USD' });
  eventBus.emitEvent.mockClear();
});

// ─── GET / — list with tenant + soft-delete + USER-role scoping ─────

describe('GET /api/deals — list with tenant + soft-delete + role scoping', () => {
  test('happy path: list returns rows scoped to tenant, soft-deletes excluded by default', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'Acme Q3', stage: 'lead', amount: 1000, tenantId: 1, contact: null, owner: null },
      { id: 2, title: 'Initech', stage: 'proposal', amount: 5000, tenantId: 1, contact: null, owner: null },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/deals');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(1);
    // Soft-deleted exclusion is the default
    expect(findArgs.where.deletedAt).toBeNull();
    // Default pagination (take=100, skip=0)
    expect(findArgs.take).toBe(100);
    expect(findArgs.skip).toBe(0);
  });

  test('USER role: ownerId is forced to req.user.userId (#588 own-deals scope)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const app = makeApp({ role: 'USER', userId: 42 });
    // User attempts to probe a colleague's pipeline via URL.
    const res = await request(app).get('/api/deals?ownerId=999');
    expect(res.status).toBe(200);
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    // Even though ?ownerId=999 was passed, USER scope overrides to 42.
    expect(findArgs.where.ownerId).toBe(42);
  });
});

// ─── GET /:id — fetch single deal (#188 param guard) ────────────────

describe('GET /api/deals/:id — fetch one (#188)', () => {
  test('happy path: returns deal scoped to tenant', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'lead', amount: 1000, tenantId: 1,
      contactId: null, contact: null, owner: null,
      attachments: [], invoices: [], quotes: [], contracts: [],
      estimates: [], projects: [], deletedAt: null,
    });
    const app = makeApp();
    const res = await request(app).get('/api/deals/7');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    const findArgs = prisma.deal.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 7, tenantId: 1 });
  });

  test('non-numeric id → 400 INVALID_ID (router.param parseInt-NaN guard, #188)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/deals/funnel');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    // Crucially, the parseInt-NaN guard must short-circuit BEFORE Prisma.
    expect(prisma.deal.findFirst).not.toHaveBeenCalled();
  });

  test('missing deal → 404', async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).get('/api/deals/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Deal not found');
  });
});

// ─── POST / — create deal (validation contract) ─────────────────────

describe('POST /api/deals — create (#162 #168 #173 validation)', () => {
  test('happy path: defaults currency from tenant, stage→lead, probability→50', async () => {
    prisma.deal.create.mockResolvedValue({
      id: 11, title: 'New Deal', amount: 250, probability: 50,
      stage: 'lead', currency: 'INR', tenantId: 1, ownerId: 7,
      contactId: null, contact: null, owner: null,
    });
    prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR' });
    const app = makeApp();
    const res = await request(app)
      .post('/api/deals')
      .send({ title: 'New Deal', amount: 250 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(11);
    const createArgs = prisma.deal.create.mock.calls[0][0];
    expect(createArgs.data.title).toBe('New Deal');
    expect(createArgs.data.amount).toBe(250);
    expect(createArgs.data.stage).toBe('lead');
    expect(createArgs.data.probability).toBe(50);
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.ownerId).toBe(7);
    expect(createArgs.data.currency).toBe('INR');
  });

  test('missing title → 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/deals')
      .send({ amount: 250 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  test('unknown stage → 400 INVALID_STAGE (#173 closed enum)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/deals')
      .send({ title: 'X', stage: 'parked' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STAGE');
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  test('negative amount → 400 INVALID_AMOUNT (#162)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/deals')
      .send({ title: 'X', amount: -50 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  test('probability > 100 → 400 INVALID_PROBABILITY', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/deals')
      .send({ title: 'X', amount: 100, probability: 150 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROBABILITY');
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });
});

// ─── PUT /:id — update + terminal-stage guard (#173) ─────────────────

describe('PUT /api/deals/:id — terminal-stage guard (#173)', () => {
  test('happy path: updates non-stage fields', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7, title: 'Old', stage: 'lead', amount: 100, tenantId: 1,
    });
    prisma.deal.update.mockResolvedValue({
      id: 7, title: 'New', stage: 'lead', amount: 200, tenantId: 1,
      contactId: null, contact: null, owner: null,
    });
    const app = makeApp();
    const res = await request(app)
      .put('/api/deals/7')
      .send({ title: 'New', amount: 200 });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New');
    expect(prisma.deal.update).toHaveBeenCalledTimes(1);
  });

  test('won → lost transition → 422 INVALID_DEAL_TRANSITION (terminal-stage frozen)', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7, title: 'Closed', stage: 'won', amount: 1000, tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app)
      .put('/api/deals/7')
      .send({ stage: 'lost' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_DEAL_TRANSITION');
    expect(res.body.currentStage).toBe('won');
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });

  test('missing deal → 404', async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .put('/api/deals/99999')
      .send({ title: 'X' });
    expect(res.status).toBe(404);
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/won — mark deal as won ───────────────────────────────

describe('POST /api/deals/:id/won — mark deal as won', () => {
  test('flips stage to won, probability → 100, emits deal.won', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'proposal', amount: 5000, tenantId: 1, contactId: 42,
    });
    prisma.deal.update.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'won', amount: 5000, probability: 100,
      currency: 'USD', tenantId: 1, contactId: 42, contact: null, owner: null,
    });
    const app = makeApp();
    const res = await request(app).post('/api/deals/7/won').send({});
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('won');
    const updateArgs = prisma.deal.update.mock.calls[0][0];
    expect(updateArgs.data.stage).toBe('won');
    expect(updateArgs.data.probability).toBe(100);
    // deal.won emitted on the event bus
    const eventNames = eventBus.emitEvent.mock.calls.map(([name]) => name);
    expect(eventNames).toContain('deal.won');
  });
});

// ─── POST /:id/lost — mark deal as lost ─────────────────────────────

describe('POST /api/deals/:id/lost — mark deal as lost', () => {
  test('flips stage to lost, probability → 0, persists lostReason', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'negotiation', amount: 5000, tenantId: 1, contactId: 42,
    });
    prisma.deal.update.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'lost', amount: 5000, probability: 0,
      lostReason: 'budget cuts', tenantId: 1, contactId: 42, contact: null, owner: null,
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/deals/7/lost')
      .send({ lostReason: 'budget cuts' });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('lost');
    const updateArgs = prisma.deal.update.mock.calls[0][0];
    expect(updateArgs.data.stage).toBe('lost');
    expect(updateArgs.data.probability).toBe(0);
    expect(updateArgs.data.lostReason).toBe('budget cuts');
    const eventNames = eventBus.emitEvent.mock.calls.map(([name]) => name);
    expect(eventNames).toContain('deal.lost');
  });
});

// ─── DELETE /:id — soft delete + idempotency (#167) ─────────────────

describe('DELETE /api/deals/:id — soft delete (#167)', () => {
  test('soft-deletes by setting deletedAt (NOT a hard delete)', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'lead', tenantId: 1, deletedAt: null,
    });
    prisma.deal.update.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'lead', tenantId: 1, deletedAt: new Date(),
    });
    const app = makeApp();
    const res = await request(app).delete('/api/deals/7');
    expect(res.status).toBe(200);
    expect(res.body.softDeleted).toBe(true);
    expect(res.body.success).toBe(true);
    const updateArgs = prisma.deal.update.mock.calls[0][0];
    // Confirm the update is a deletedAt-flip, NOT a prisma.delete().
    expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
  });

  test('already-soft-deleted → idempotent 200 (no double-write)', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7, title: 'Acme Q3', stage: 'lead', tenantId: 1, deletedAt: new Date('2026-01-01'),
    });
    const app = makeApp();
    const res = await request(app).delete('/api/deals/7');
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.softDeleted).toBe(true);
    // No second deletedAt-flip.
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });
});

// ─── GET /stats — pipeline aggregate envelope (#567 #588) ───────────

describe('GET /api/deals/stats — aggregate envelope (#567 #588)', () => {
  test('returns full additive envelope with byStage + closed counts', async () => {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'lead', amount: 1000, createdAt: new Date('2025-01-01') },
      { id: 2, stage: 'proposal', amount: 5000, createdAt: new Date('2025-01-01') },
      { id: 3, stage: 'won', amount: 10000, createdAt: monthStart },
      { id: 4, stage: 'lost', amount: 2000, createdAt: monthStart },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/deals/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalDeals).toBe(4);
    expect(res.body.totalValue).toBe(18000);
    expect(res.body.avgDealSize).toBe(4500);
    // 1 won + 1 lost → winRate = 50.
    expect(res.body.winRate).toBe(50);
    // #567 additive aggregates
    expect(res.body.wonCount).toBe(1);
    expect(res.body.wonValue).toBe(10000);
    expect(res.body.lostCount).toBe(1);
    expect(res.body.lostValue).toBe(2000);
    // expectedValue = 1000*0.1 + 5000*0.7 + 10000*1.0 + 2000*0 = 13600
    expect(res.body.expectedValue).toBe(13600);
    // closedThisMonth = won + lost rows with createdAt >= monthStart → 2
    expect(res.body.closedThisMonth).toBe(2);
    // byStage groups all four stages
    expect(res.body.byStage).toHaveLength(4);
    const wonGroup = res.body.byStage.find((s) => s.stage === 'won');
    expect(wonGroup.count).toBe(1);
    expect(wonGroup.value).toBe(10000);
  });

  test('USER role: stats are scoped to caller (#588 own-deals)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const app = makeApp({ role: 'USER', userId: 42 });
    const res = await request(app).get('/api/deals/stats');
    expect(res.status).toBe(200);
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(1);
    // USER role narrows to own ownerId — pre-fix this leaked the org-wide
    // aggregate to every sales rep.
    expect(findArgs.where.ownerId).toBe(42);
    // Soft-deleted always excluded from /stats
    expect(findArgs.where.deletedAt).toBeNull();
  });
});

// ─── GET /?fields=summary — slim-shape PII reduction (#920 slice 2) ─

/**
 * #920 slice 2 — opt-in slim Prisma `select` to drop heavy nested includes
 * (contact + owner) and sensitive flat columns from list responses. Mirrors
 * the contacts.js shape shipped in slice 1 (commit f7790241). ADDITIVE only;
 * any non-`summary` value (or absent param) leaves the existing full shape
 * untouched. Pins:
 *   1. response rows carry only the slim keys (no nested objects on the wire).
 *   2. findManyArgs.select used; findManyArgs.include absent.
 *   3. ?fields= empty → full-shape include path is taken.
 *   4. ?fields=anything-else → full-shape include path (exact-string match).
 *   5. tenant scoping is preserved on the slim path.
 *   6. pagination params honored alongside ?fields=summary.
 */
describe('GET /api/deals?fields=summary — slim-shape opt-in (#920 slice 2)', () => {
  test('?fields=summary: response rows carry only slim keys (no nested objects)', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'Acme Q3', amount: 1000, stage: 'lead', ownerId: 7, contactId: 42, tenantId: 1, createdAt: new Date('2026-01-01') },
      { id: 2, title: 'Initech',  amount: 5000, stage: 'proposal', ownerId: 8, contactId: 43, tenantId: 1, createdAt: new Date('2026-01-02') },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/deals?fields=summary');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // No nested includes leaked into the response.
    expect(res.body[0].contact).toBeUndefined();
    expect(res.body[0].owner).toBeUndefined();
    // Slim keys present.
    expect(res.body[0]).toHaveProperty('id');
    expect(res.body[0]).toHaveProperty('title');
    expect(res.body[0]).toHaveProperty('amount');
    expect(res.body[0]).toHaveProperty('stage');
    expect(res.body[0]).toHaveProperty('ownerId');
    expect(res.body[0]).toHaveProperty('contactId');
    expect(res.body[0]).toHaveProperty('tenantId');
    expect(res.body[0]).toHaveProperty('createdAt');
  });

  test('?fields=summary: prisma.deal.findMany called with select (not include)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/deals?fields=summary');
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    // Slim path: select is set, include is absent.
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
    // The slim select contains exactly the documented field set.
    expect(findArgs.select).toEqual({
      id: true,
      title: true,
      amount: true,
      stage: true,
      ownerId: true,
      contactId: true,
      tenantId: true,
      createdAt: true,
    });
  });

  test('?fields= (empty/absent): existing full-shape include path is preserved', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/deals');
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    // Full-shape path: include is set, select is absent.
    expect(findArgs.include).toEqual({ contact: true, owner: true });
    expect(findArgs.select).toBeUndefined();
  });

  test('?fields=anything-else: opt-in is exact-string only, NOT a prefix match', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/deals?fields=summaryfoo');
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    // Any non-exact 'summary' value falls through to the full-shape include.
    expect(findArgs.include).toEqual({ contact: true, owner: true });
    expect(findArgs.select).toBeUndefined();
  });

  test('?fields=summary: auth + tenant scoping preserved on slim path', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 42, userId: 7, role: 'ADMIN' });
    await request(app).get('/api/deals?fields=summary');
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    // Tenant isolation must survive the shape swap — slim path is still
    // scoped to the caller's tenantId.
    expect(findArgs.where.tenantId).toBe(42);
    // Soft-delete exclusion still applied.
    expect(findArgs.where.deletedAt).toBeNull();
    // Slim path was taken.
    expect(findArgs.select).toBeDefined();
  });

  test('?fields=summary: pagination params honored alongside slim shape', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/deals?fields=summary&limit=25&offset=50');
    const findArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(findArgs.take).toBe(25);
    expect(findArgs.skip).toBe(50);
    // Slim path still in effect — pagination doesn't override the shape.
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
  });
});
