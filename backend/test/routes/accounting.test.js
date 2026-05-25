// @ts-check
/**
 * Unit tests for backend/routes/accounting.js — pin the QuickBooks / Xero /
 * Tally accounting-integration scaffolding contract.
 *
 * Why this file exists
 * ────────────────────
 * accounting.js is a STUB-LEVEL integration surface (no real external SDK
 * calls yet — see top-of-file JSDoc in the route). The contract that still
 * matters for downstream consumers (Settings → Integrations UI, the
 * AccountingSync ledger, future webhook replay) is:
 *
 *   1. Three providers supported (quickbooks / xero / tally); every other
 *      provider string MUST 400 with a deterministic error envelope.
 *   2. GET /providers returns the per-tenant connection status keyed by
 *      provider, with provider-specific extras (QBO realmId, Xero tenantId).
 *   3. POST /:provider/connect upserts an Integration row keyed on
 *      (tenantId, provider) — token + JSON settings shape varies per
 *      provider, with REQUIRED-field validation enforced server-side
 *      (no client-side trust). QBO needs accessToken+refreshToken+realmId;
 *      Xero needs accessToken+refreshToken+xeroTenantId; Tally needs
 *      url+port+companyName (LAN-only, no token).
 *   4. POST /:provider/disconnect 404s when no integration row exists;
 *      otherwise flips isActive=false and clears the token (keeps the
 *      settings JSON intact so a re-connect can audit the prior state).
 *   5. POST /:provider/sync/invoice/:id and /sync/expense/:id resolve the
 *      entity by (id, tenantId) — tenant-isolation enforced at the
 *      findFirst boundary. Missing entity → 404. Non-numeric id → 400.
 *      Success → upsert an AccountingSync row with the STUB externalId
 *      shape `STUB_<entityId>_<timestamp>`.
 *   6. POST /:provider/sync/all batch-syncs unsynced invoices for the
 *      tenant — the dedup is via the existing AccountingSync set scoped
 *      to (provider, entityType='Invoice', tenantId). Already-synced
 *      invoices roll into skippedCount, not results.
 *   7. GET /:provider/synced is paginated (page ≥ 1; pageSize clamped to
 *      [1, 200]) with the standard {page, pageSize, total, items} envelope.
 *   8. POST /webhook/:provider is the ONLY public endpoint (no verifyToken)
 *      — it 400s on unsupported provider, 200s with {success, received}
 *      otherwise. Real signature verification is deferred until the SDK
 *      lands; the test pins the current no-op shape so a future "we added
 *      signature verification, please fail-by-default" change reds here.
 *
 * Pattern: prisma-singleton monkey-patch + auth-middleware bypass mirrors
 * backend/test/routes/approvals-notifications.test.js — the route's CJS
 * `require('../middleware/auth')` + destructured `verifyToken` is replaced
 * at module-load with a pass-through so we exercise the route logic
 * without minting JWTs.
 *
 * What this file does NOT cover (intentional):
 *   - No real QBO/Xero/Tally HTTP — the route doesn't make any yet.
 *   - No webhook signature verification — the route doesn't check yet.
 *   - No retry / backoff — the route is synchronous-stub for now.
 *   When the real integrations land, this file's "stub shape" assertions
 *   must be updated to the new contract (e.g. externalId becomes the real
 *   QBO Doc Id, success envelope gains a `provider` field, etc.).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch the auth middleware module BEFORE the accounting router is
// required — the router does `const { verifyToken } = require(...)` at
// module-load, so the destructured reference captures whatever
// `authMw.verifyToken` points at THE MOMENT the route is required.
// Same pattern as approvals-notifications.test.js + audit-chain.test.js.
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — replace the lazy $extends-proxy delegates
// with bare vi.fn() surfaces. The route only touches Integration,
// AccountingSync, Invoice and Expense.
prisma.integration = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
};
prisma.accountingSync = {
  upsert: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
};
prisma.invoice = prisma.invoice || {};
prisma.invoice.findFirst = vi.fn();
prisma.invoice.findMany = vi.fn();
prisma.expense = prisma.expense || {};
prisma.expense.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';
const accountingRouter = requireCJS('../../routes/accounting');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/accounting', accountingRouter);
  return app;
}

beforeEach(() => {
  prisma.integration.findMany.mockReset();
  prisma.integration.findUnique.mockReset();
  prisma.integration.upsert.mockReset();
  prisma.integration.update.mockReset();
  prisma.accountingSync.upsert.mockReset();
  prisma.accountingSync.findMany.mockReset();
  prisma.accountingSync.count.mockReset();
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.expense.findFirst.mockReset();

  // Sensible defaults — happy-path resolves.
  prisma.integration.findMany.mockResolvedValue([]);
  prisma.accountingSync.upsert.mockImplementation(({ create, update }) =>
    Promise.resolve({ id: 99, ...(create || {}), externalId: (update && update.externalId) || (create && create.externalId) })
  );
});

// ─── GET /providers — connection-status envelope ────────────────────────

describe('GET /api/accounting/providers — connection status', () => {
  test('empty integrations → all three providers reported disconnected', async () => {
    prisma.integration.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/accounting/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      quickbooks: { connected: false },
      xero: { connected: false },
      tally: { connected: false },
    });
  });

  test('active QBO + Xero rows surface their per-provider settings extras', async () => {
    prisma.integration.findMany.mockResolvedValue([
      {
        provider: 'quickbooks',
        isActive: true,
        settings: JSON.stringify({ realmId: 'qbo-realm-123', refreshToken: 'rt-q' }),
      },
      {
        provider: 'xero',
        isActive: true,
        settings: JSON.stringify({ xeroTenantId: 'xero-tenant-abc', refreshToken: 'rt-x' }),
      },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/accounting/providers');
    expect(res.status).toBe(200);
    expect(res.body.quickbooks).toEqual({ connected: true, accountId: 'qbo-realm-123' });
    expect(res.body.xero).toEqual({ connected: true, tenantId: 'xero-tenant-abc' });
    expect(res.body.tally).toEqual({ connected: false });
  });

  test('inactive integration row → connected:false even though row exists', async () => {
    prisma.integration.findMany.mockResolvedValue([
      {
        provider: 'tally',
        isActive: false,
        settings: JSON.stringify({ url: '127.0.0.1', port: 9000, companyName: 'Demo Co' }),
      },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/accounting/providers');
    expect(res.status).toBe(200);
    expect(res.body.tally).toEqual({ connected: false });
  });

  test('scopes findMany to the requesting tenantId (tenant isolation)', async () => {
    prisma.integration.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 42 });
    await request(app).get('/api/accounting/providers');
    expect(prisma.integration.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.integration.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.where.provider.in).toEqual(['quickbooks', 'xero', 'tally']);
  });

  test('malformed settings JSON does not crash — falls back to empty settings', async () => {
    prisma.integration.findMany.mockResolvedValue([
      { provider: 'quickbooks', isActive: true, settings: 'not-json{{{' },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/accounting/providers');
    expect(res.status).toBe(200);
    // Connected stays true (driven by isActive), but accountId is null since
    // settings.realmId couldn't be parsed.
    expect(res.body.quickbooks).toEqual({ connected: true, accountId: null });
  });

  test('prisma failure → 500 with error envelope', async () => {
    prisma.integration.findMany.mockRejectedValue(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).get('/api/accounting/providers');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to load providers');
    consoleSpy.mockRestore();
  });
});

// ─── POST /:provider/connect — credential persistence ───────────────────

describe('POST /api/accounting/:provider/connect — credential upsert', () => {
  test('unsupported provider → 400 with explicit error message', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/accounting/sage/connect')
      .send({ accessToken: 'a', refreshToken: 'b', realmId: 'c' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported provider 'sage'/);
    expect(res.body.error).toMatch(/quickbooks, xero, tally/);
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });

  test('quickbooks requires accessToken + refreshToken + realmId (400 on missing)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/accounting/quickbooks/connect')
      .send({ accessToken: 'a', refreshToken: 'b' }); // missing realmId
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('quickbooks requires accessToken, refreshToken, realmId');
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });

  test('xero requires accessToken + refreshToken + xeroTenantId (400 on missing)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/accounting/xero/connect')
      .send({ accessToken: 'a', refreshToken: 'b' }); // missing xeroTenantId
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('xero requires accessToken, refreshToken, xeroTenantId');
  });

  test('tally requires url + port + companyName (400 on missing)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/accounting/tally/connect')
      .send({ url: '127.0.0.1', port: 9000 }); // missing companyName
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('tally requires url, port, companyName');
  });

  test('quickbooks happy path persists token + settings to Integration upsert', async () => {
    prisma.integration.upsert.mockResolvedValue({ id: 501 });
    const app = makeApp({ tenantId: 7 });
    const res = await request(app)
      .post('/api/accounting/quickbooks/connect')
      .send({ accessToken: 'qbo-access', refreshToken: 'qbo-refresh', realmId: 'realm-99' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, provider: 'quickbooks', id: 501 });

    expect(prisma.integration.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.integration.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ tenantId_provider: { tenantId: 7, provider: 'quickbooks' } });
    expect(upsertArgs.create.provider).toBe('quickbooks');
    expect(upsertArgs.create.token).toBe('qbo-access');
    expect(upsertArgs.create.isActive).toBe(true);
    expect(upsertArgs.create.tenantId).toBe(7);
    const settings = JSON.parse(upsertArgs.create.settings);
    expect(settings.refreshToken).toBe('qbo-refresh');
    expect(settings.realmId).toBe('realm-99');
  });

  test('tally happy path leaves token=null and stores LAN config in settings', async () => {
    prisma.integration.upsert.mockResolvedValue({ id: 777 });
    const app = makeApp({ tenantId: 3 });
    const res = await request(app)
      .post('/api/accounting/tally/connect')
      .send({ url: '192.168.1.10', port: 9000, companyName: 'Acme Pvt Ltd' });
    expect(res.status).toBe(200);
    const upsertArgs = prisma.integration.upsert.mock.calls[0][0];
    // Tally has no OAuth surface — token MUST be null (LAN-only).
    expect(upsertArgs.create.token).toBeNull();
    const settings = JSON.parse(upsertArgs.create.settings);
    expect(settings).toEqual({ url: '192.168.1.10', port: 9000, companyName: 'Acme Pvt Ltd' });
  });

  test('provider param is case-insensitive (QuickBooks → quickbooks)', async () => {
    prisma.integration.upsert.mockResolvedValue({ id: 1 });
    const app = makeApp();
    const res = await request(app)
      .post('/api/accounting/QuickBooks/connect')
      .send({ accessToken: 'a', refreshToken: 'b', realmId: 'c' });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('quickbooks');
  });
});

// ─── POST /:provider/disconnect ─────────────────────────────────────────

describe('POST /api/accounting/:provider/disconnect', () => {
  test('404 when no integration row exists', async () => {
    prisma.integration.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/accounting/xero/disconnect');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Integration not found');
    expect(prisma.integration.update).not.toHaveBeenCalled();
  });

  test('happy path flips isActive=false and nulls the token (settings preserved)', async () => {
    prisma.integration.findUnique.mockResolvedValue({ id: 88, isActive: true, token: 'old' });
    prisma.integration.update.mockResolvedValue({ id: 88 });
    const app = makeApp({ tenantId: 5 });
    const res = await request(app).post('/api/accounting/xero/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.integration.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 88 });
    expect(updateArgs.data).toEqual({ isActive: false, token: null });
    // Critically — `settings` is NOT cleared (so a re-connect can audit it).
    expect(updateArgs.data.settings).toBeUndefined();
  });

  test('unsupported provider → 400 before any DB call', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/accounting/freshbooks/disconnect');
    expect(res.status).toBe(400);
    expect(prisma.integration.findUnique).not.toHaveBeenCalled();
  });
});

// ─── POST /:provider/sync/invoice/:id ───────────────────────────────────

describe('POST /api/accounting/:provider/sync/invoice/:id', () => {
  test('non-numeric id → 400 before any DB call', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/accounting/quickbooks/sync/invoice/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid invoice id');
    expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
  });

  test('invoice not in tenant scope → 404 (tenant isolation enforced)', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 42 });
    const res = await request(app).post('/api/accounting/quickbooks/sync/invoice/777');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invoice not found');

    // Verify the WHERE clause scoped by both id AND tenantId — no cross-
    // tenant leakage even if the caller knows another tenant's invoice id.
    const findArgs = prisma.invoice.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 777, tenantId: 42 });
    expect(prisma.accountingSync.upsert).not.toHaveBeenCalled();
  });

  test('happy path upserts AccountingSync with stub externalId shape', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 12,
      invoiceNum: 'INV-0012',
      amount: 5000,
      status: 'unpaid',
      dueDate: new Date('2026-06-01'),
      tenantId: 3,
    });
    prisma.accountingSync.upsert.mockImplementation(({ create }) =>
      Promise.resolve({ id: 200, ...create })
    );
    const app = makeApp({ tenantId: 3 });
    const res = await request(app).post('/api/accounting/quickbooks/sync/invoice/12');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Stub externalId shape: `STUB_<entityId>_<timestamp>`
    expect(res.body.externalId).toMatch(/^STUB_12_\d+$/);

    const upsertArgs = prisma.accountingSync.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({
      provider_entityType_entityId_tenantId: {
        provider: 'quickbooks',
        entityType: 'Invoice',
        entityId: 12,
        tenantId: 3,
      },
    });
    expect(upsertArgs.create.provider).toBe('quickbooks');
    expect(upsertArgs.create.entityType).toBe('Invoice');
    expect(upsertArgs.create.entityId).toBe(12);
    expect(upsertArgs.create.tenantId).toBe(3);
  });

  test('unsupported provider on sync route → 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/accounting/wave/sync/invoice/1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported provider 'wave'/);
  });
});

// ─── POST /:provider/sync/expense/:id ───────────────────────────────────

describe('POST /api/accounting/:provider/sync/expense/:id', () => {
  test('non-numeric id → 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/accounting/xero/sync/expense/oops');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid expense id');
  });

  test('expense not in tenant scope → 404', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 9 });
    const res = await request(app).post('/api/accounting/xero/sync/expense/55');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Expense not found');
    const findArgs = prisma.expense.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 55, tenantId: 9 });
  });

  test('happy path persists an Expense-typed AccountingSync row', async () => {
    prisma.expense.findFirst.mockResolvedValue({
      id: 33,
      title: 'AWS bill',
      amount: 450,
      category: 'infra',
      status: 'approved',
      expenseDate: new Date('2026-05-01'),
      tenantId: 1,
    });
    prisma.accountingSync.upsert.mockImplementation(({ create }) =>
      Promise.resolve({ id: 600, ...create })
    );
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).post('/api/accounting/xero/sync/expense/33');
    expect(res.status).toBe(200);
    expect(res.body.externalId).toMatch(/^STUB_33_\d+$/);
    const upsertArgs = prisma.accountingSync.upsert.mock.calls[0][0];
    expect(upsertArgs.create.entityType).toBe('Expense');
    expect(upsertArgs.create.provider).toBe('xero');
  });
});

// ─── POST /:provider/sync/all — bulk invoice sync with dedup ────────────

describe('POST /api/accounting/:provider/sync/all', () => {
  test('zero invoices → syncedCount=0, skippedCount=0, empty results', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.accountingSync.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).post('/api/accounting/quickbooks/sync/all');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 0, skippedCount: 0, results: [] });
  });

  test('dedups against existing AccountingSync rows — already-synced count up the skippedCount', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 1, invoiceNum: 'INV-1', amount: 100, status: 'unpaid' },
      { id: 2, invoiceNum: 'INV-2', amount: 200, status: 'unpaid' },
      { id: 3, invoiceNum: 'INV-3', amount: 300, status: 'paid' },
    ]);
    // Invoices 1 and 3 already synced — should be skipped.
    prisma.accountingSync.findMany.mockResolvedValue([
      { entityId: 1 },
      { entityId: 3 },
    ]);
    prisma.accountingSync.upsert.mockImplementation(({ create }) =>
      Promise.resolve({ id: 999, ...create, externalId: `STUB_${create.entityId}_t` })
    );
    const app = makeApp({ tenantId: 2 });
    const res = await request(app).post('/api/accounting/quickbooks/sync/all');
    expect(res.status).toBe(200);
    expect(res.body.syncedCount).toBe(1);
    expect(res.body.skippedCount).toBe(2);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].invoiceId).toBe(2);

    // Only invoice 2's sync row gets upserted.
    expect(prisma.accountingSync.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.accountingSync.upsert.mock.calls[0][0];
    expect(args.create.entityId).toBe(2);
  });

  test('dedup query scoped to (provider, entityType=Invoice, tenantId)', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.accountingSync.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 11 });
    await request(app).post('/api/accounting/tally/sync/all');
    const dedupArgs = prisma.accountingSync.findMany.mock.calls[0][0];
    expect(dedupArgs.where).toEqual({
      provider: 'tally',
      entityType: 'Invoice',
      tenantId: 11,
    });
  });
});

// ─── GET /:provider/synced — paginated history ──────────────────────────

describe('GET /api/accounting/:provider/synced — pagination envelope', () => {
  test('default page=1, pageSize=50, ordered by syncedAt desc', async () => {
    prisma.accountingSync.count.mockResolvedValue(0);
    prisma.accountingSync.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 4 });
    const res = await request(app).get('/api/accounting/quickbooks/synced');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ page: 1, pageSize: 50, total: 0, items: [] });

    const args = prisma.accountingSync.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ provider: 'quickbooks', tenantId: 4 });
    expect(args.orderBy).toEqual({ syncedAt: 'desc' });
    expect(args.skip).toBe(0);
    expect(args.take).toBe(50);
  });

  test('pageSize is clamped to 200 (defense-in-depth against scrapes)', async () => {
    prisma.accountingSync.count.mockResolvedValue(0);
    prisma.accountingSync.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/accounting/xero/synced?page=1&pageSize=99999');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(200);
    expect(prisma.accountingSync.findMany.mock.calls[0][0].take).toBe(200);
  });

  test('page=2 with pageSize=25 → skip=25', async () => {
    prisma.accountingSync.count.mockResolvedValue(100);
    prisma.accountingSync.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/accounting/quickbooks/synced?page=2&pageSize=25');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 2, pageSize: 25, total: 100 });
    expect(prisma.accountingSync.findMany.mock.calls[0][0].skip).toBe(25);
  });

  test('negative page coerces to 1 (no negative skip leaks)', async () => {
    prisma.accountingSync.count.mockResolvedValue(0);
    prisma.accountingSync.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/accounting/quickbooks/synced?page=-5');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(prisma.accountingSync.findMany.mock.calls[0][0].skip).toBe(0);
  });
});

// ─── POST /webhook/:provider — PUBLIC endpoint ─────────────────────────

describe('POST /api/accounting/webhook/:provider — public receiver', () => {
  test('unsupported provider → 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/accounting/webhook/stripe')
      .send({ event: 'invoice.paid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unsupported provider');
  });

  test('happy path returns {success, received} — no signature check yet (STUB)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/accounting/webhook/quickbooks')
      .send({ event: 'invoice.synced', payload: { id: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, received: true });
  });

  test('webhook accepts each supported provider name (xero/tally/quickbooks)', async () => {
    const app = makeApp();
    for (const provider of ['quickbooks', 'xero', 'tally']) {
      const res = await request(app)
        .post(`/api/accounting/webhook/${provider}`)
        .send({ event: 'test' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });
});
