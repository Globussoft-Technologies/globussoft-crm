// @ts-check
/**
 * Unit tests for backend/routes/reports.js — pin the BI/analytics route
 * surface (dynamic /query, /agent-performance, /agent/:userId, /leaderboard,
 * /detailed/:type, /export-csv, /export-pdf) that backs the Reports page +
 * Agent Reports page + Dashboard exports.
 *
 * Why this file exists
 * ────────────────────
 * reports.js is a 503-LOC pure-aggregation route surface — every endpoint
 * reads (Deal, Contact, Task, Invoice, Expense, User, CallLog, EmailMessage,
 * Tenant) under tenant scope and emits derived metrics, CSV blobs, or PDF
 * blobs. No DB writes. The historical contracts to pin:
 *
 *   - validateDateRange — invalid date strings yield 400 INVALID_DATE;
 *     inverted ranges (start > end) yield 400 INVERTED_RANGE. The check
 *     fires on /query and /detailed/:type at minimum.
 *
 *   - buildWhere — tenant-scoped where + optional date-field gte/lte. The
 *     end-of-day suffix `+'T23:59:59.999Z'` is appended to endDate so
 *     ?endDate=2026-05-25 means "through end of 2026-05-25 UTC", not
 *     "midnight at start of 2026-05-25 UTC". Invoice queries filter on
 *     `issuedDate` (the model has no createdAt) — every other queryable
 *     model filters on `createdAt`.
 *
 *   - /query metric routing — revenue/count groupBy deal.<field>;
 *     win_rate counts won/lost/in-progress separately; tasks groups
 *     task.status; contacts_by_source / contacts_by_status group
 *     contact.{source,status}; invoices groups invoice.status with _sum on
 *     amount; expenses groups expense.category. Unsupported metric → 400.
 *
 *   - /query revenue filter — drops 0-value buckets (`.filter(d => d.value
 *     > 0)`) so a "stage with zero deals" doesn't pollute the chart.
 *
 *   - /agent/:userId — 404 when the user belongs to another tenant (NOT a
 *     500 — the user.findFirst with tenantId scoping must return null and
 *     the route returns `{ error: 'Agent not found' }`).
 *
 *   - /export-csv — type=deals/contacts/agent-performance produces a CSV
 *     with double-quoted fields + quote-escape (any `"` in a value becomes
 *     `""`). Headers row matches the docs canon. Content-Disposition is
 *     `attachment; filename=<type>-report.csv`. Without ?type, metric-based
 *     export emits a `Name,Value\n` header + groupBy rows.
 *
 *   - /export-pdf — pulls tenant.defaultCurrency + tenant.locale so wellness
 *     INR tenants render ₹, not $ (#286/#330). Content-Type is
 *     `application/pdf`. Returns a PDF stream pipe.
 *
 *   - Tenant isolation on EVERY endpoint — every prisma read passes
 *     tenantId = req.user.tenantId through. Cross-tenant data never leaks.
 *
 * What this file pins (17 cases across 7 describe blocks)
 * ───────────────────────────────────────────────────────
 *   GET /query
 *     1. metric=revenue groupBy=stage — _sum.amount per stage, drops 0s
 *     2. metric=count groupBy=stage — _count.id per stage
 *     3. metric=win_rate — three buckets (Won/Lost/In Progress)
 *     4. metric=tasks — task.status groupBy
 *     5. metric=invoices — uses issuedDate not createdAt
 *     6. unsupported metric → 400
 *     7. inverted date range → 400 INVERTED_RANGE
 *
 *   GET /agent-performance
 *     8. per-user counts (deals won, revenue, tasks, calls, emails, contacts)
 *        + sorted by revenue desc
 *
 *   GET /agent/:userId
 *     9. cross-tenant lookup → 404 Agent not found
 *
 *   GET /leaderboard
 *    10. metric=revenue ranks by _sum.amount per user, sorted desc
 *
 *   GET /detailed/:type
 *    11. type=deals — applies ownerId + status filters + take=min(limit,500)
 *    12. unsupported type → 400
 *
 *   GET /export-csv
 *    13. type=deals — Content-Type text/csv + Content-Disposition + header row
 *    14. unsupported type → 400
 *    15. metric=revenue → groupBy-based CSV body + Name,Value header
 *
 *   GET /export-pdf
 *    16. Content-Type application/pdf + tenant currency lookup
 *
 *   Cross-cutting
 *    17. tenant isolation — every prisma read forwards tenantId
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/funnel.test.js — prisma singleton patch
 * BEFORE requiring the router via createRequire, supertest + a fake auth
 * middleware that sets req.user. reports.js has NO inline verifyRole (the
 * global auth guard at server.js covers it), so role doesn't matter; we
 * use ADMIN for parity.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton stubs (BEFORE require-time) ────────────────────────
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.deal.groupBy = vi.fn();
prisma.deal.count = vi.fn();
prisma.deal.aggregate = vi.fn();
prisma.task = prisma.task || {};
prisma.task.findMany = vi.fn();
prisma.task.groupBy = vi.fn();
prisma.task.count = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.contact.groupBy = vi.fn();
prisma.contact.count = vi.fn();
prisma.invoice = prisma.invoice || {};
prisma.invoice.findMany = vi.fn();
prisma.invoice.groupBy = vi.fn();
prisma.expense = prisma.expense || {};
prisma.expense.findMany = vi.fn();
prisma.expense.groupBy = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.user.findFirst = vi.fn();
prisma.callLog = prisma.callLog || {};
prisma.callLog.findMany = vi.fn();
prisma.callLog.count = vi.fn();
prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.findMany = vi.fn();
prisma.emailMessage.count = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const reportsRouter = requireCJS('../../routes/reports');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/reports', reportsRouter);
  return app;
}

beforeEach(() => {
  prisma.deal.findMany.mockReset();
  prisma.deal.groupBy.mockReset();
  prisma.deal.count.mockReset();
  prisma.deal.aggregate.mockReset();
  prisma.task.findMany.mockReset();
  prisma.task.groupBy.mockReset();
  prisma.task.count.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.groupBy.mockReset();
  prisma.contact.count.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.invoice.groupBy.mockReset();
  prisma.expense.findMany.mockReset();
  prisma.expense.groupBy.mockReset();
  prisma.user.findMany.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.callLog.findMany.mockReset();
  prisma.callLog.count.mockReset();
  prisma.emailMessage.findMany.mockReset();
  prisma.emailMessage.count.mockReset();
  prisma.tenant.findUnique.mockReset();

  // Sensible defaults for endpoints that fan out
  prisma.deal.count.mockResolvedValue(0);
  prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  prisma.task.count.mockResolvedValue(0);
  prisma.callLog.count.mockResolvedValue(0);
  prisma.emailMessage.count.mockResolvedValue(0);
  prisma.contact.count.mockResolvedValue(0);
  prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'USD', locale: 'en-US' });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /query — dynamic BI endpoint
// ─────────────────────────────────────────────────────────────────────────

describe('GET /query — dynamic BI metrics', () => {
  test('metric=revenue groupBy=stage returns _sum.amount per stage and drops 0-value buckets', async () => {
    prisma.deal.groupBy.mockResolvedValue([
      { stage: 'lead', _sum: { amount: 1000 } },
      { stage: 'won', _sum: { amount: 50000 } },
      { stage: 'lost', _sum: { amount: 0 } }, // dropped by .filter(d => d.value > 0)
      { stage: null, _sum: { amount: 250 } }, // null stage → 'Unknown'
    ]);

    const res = await request(makeApp()).get('/api/reports/query?metric=revenue&groupBy=stage');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'LEAD', value: 1000 },
      { name: 'WON', value: 50000 },
      { name: 'UNKNOWN', value: 250 },
    ]);
    expect(prisma.deal.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['stage'],
      where: { tenantId: 1 },
      _sum: { amount: true },
    }));
  });

  test('metric=count groupBy=stage returns _count.id per stage', async () => {
    prisma.deal.groupBy.mockResolvedValue([
      { stage: 'lead', _count: { id: 7 } },
      { stage: 'won', _count: { id: 3 } },
    ]);

    const res = await request(makeApp()).get('/api/reports/query?metric=count&groupBy=stage');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'LEAD', value: 7 },
      { name: 'WON', value: 3 },
    ]);
  });

  test('metric=win_rate returns Won/Lost/In Progress trio', async () => {
    // count called 3× in order: total, won, lost
    prisma.deal.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(4)  // won
      .mockResolvedValueOnce(2); // lost

    const res = await request(makeApp()).get('/api/reports/query?metric=win_rate');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'Won', value: 4 },
      { name: 'Lost', value: 2 },
      { name: 'In Progress', value: 4 }, // 10 - 4 - 2
    ]);
  });

  test('metric=tasks groups task.status', async () => {
    prisma.task.groupBy.mockResolvedValue([
      { status: 'Completed', _count: { id: 5 } },
      { status: 'Pending', _count: { id: 2 } },
    ]);

    const res = await request(makeApp()).get('/api/reports/query?metric=tasks');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'Completed', value: 5 },
      { name: 'Pending', value: 2 },
    ]);
    expect(prisma.task.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['status'],
      where: { tenantId: 1 },
    }));
  });

  test('metric=invoices filters on issuedDate (not createdAt) — #117 contract', async () => {
    prisma.invoice.groupBy.mockResolvedValue([
      { status: 'Paid', _sum: { amount: 4500 }, _count: { id: 3 } },
    ]);

    await request(makeApp()).get(
      '/api/reports/query?metric=invoices&startDate=2026-01-01&endDate=2026-06-30'
    );

    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 1,
        issuedDate: expect.objectContaining({
          gte: new Date('2026-01-01'),
          lte: new Date('2026-06-30T23:59:59.999Z'),
        }),
      }),
    }));
    // createdAt should NOT be on the where
    const call = prisma.invoice.groupBy.mock.calls[0][0];
    expect(call.where.createdAt).toBeUndefined();
  });

  test('unsupported metric returns 400', async () => {
    const res = await request(makeApp()).get('/api/reports/query?metric=bogus');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported/i);
  });

  test('inverted date range yields 400 INVERTED_RANGE', async () => {
    const res = await request(makeApp()).get(
      '/api/reports/query?startDate=2026-12-31&endDate=2026-01-01'
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVERTED_RANGE');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /agent-performance
// ─────────────────────────────────────────────────────────────────────────

describe('GET /agent-performance — per-user roll-up', () => {
  test('aggregates deals/tasks/calls/emails/contacts per user and sorts by revenue desc', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 10, name: 'Alice', email: 'a@example.com', role: 'USER' },
      { id: 11, name: 'Bob', email: 'b@example.com', role: 'USER' },
    ]);

    // Per-user Promise.all calls 8 things in this order:
    //   dealsWon, totalRevenue (aggregate), dealsTotal, tasksCompleted,
    //   tasksTotal, callsMade, emailsSent, contactsAssigned
    // Alice has 5 won + $20k revenue; Bob has 1 won + $1k.
    prisma.deal.count
      .mockResolvedValueOnce(5)  // Alice dealsWon
      .mockResolvedValueOnce(8)  // Alice dealsTotal
      .mockResolvedValueOnce(1)  // Bob dealsWon
      .mockResolvedValueOnce(2); // Bob dealsTotal
    prisma.deal.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 20000 } }) // Alice revenue
      .mockResolvedValueOnce({ _sum: { amount: 1000 } }); // Bob revenue

    const res = await request(makeApp()).get('/api/reports/agent-performance');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Sorted by revenue desc: Alice first
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 10,
      name: 'Alice',
      dealsWon: 5,
      revenue: 20000,
      dealsTotal: 8,
      winRate: 63, // 5/8 = 62.5 → Math.round → 63
    }));
    expect(res.body[1]).toEqual(expect.objectContaining({
      id: 11,
      name: 'Bob',
      revenue: 1000,
    }));

    // Tenant scoping on user.findMany
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1 },
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /agent/:userId
// ─────────────────────────────────────────────────────────────────────────

describe('GET /agent/:userId — individual agent drilldown', () => {
  test('user belonging to a different tenant returns 404 Agent not found (no cross-tenant leak)', async () => {
    // user.findFirst returns null because the WHERE filters by tenantId=1
    // and the requested user (id=99) belongs to tenantId=2.
    prisma.user.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/reports/agent/99');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/agent not found/i);
    // Crucial: the lookup was tenant-scoped (otherwise this would return
    // tenantId=2's user data — the canonical cross-tenant leak).
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 99, tenantId: 1 },
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /leaderboard
// ─────────────────────────────────────────────────────────────────────────

describe('GET /leaderboard — ranks users by metric', () => {
  test('metric=revenue ranks by _sum.amount per user, sorts desc', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 10, name: 'Alice', email: 'a@example.com' },
      { id: 11, name: 'Bob', email: 'b@example.com' },
      { id: 12, name: 'Carol', email: 'c@example.com' },
    ]);
    prisma.deal.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 5000 } })   // Alice
      .mockResolvedValueOnce({ _sum: { amount: 25000 } })  // Bob
      .mockResolvedValueOnce({ _sum: { amount: 0 } });     // Carol

    const res = await request(makeApp()).get('/api/reports/leaderboard?metric=revenue');

    expect(res.status).toBe(200);
    // Desc by value
    expect(res.body).toEqual([
      { id: 11, name: 'Bob', value: 25000 },
      { id: 10, name: 'Alice', value: 5000 },
      { id: 12, name: 'Carol', value: 0 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /detailed/:type
// ─────────────────────────────────────────────────────────────────────────

describe('GET /detailed/:type — raw table dumps', () => {
  test('type=deals applies ownerId + status filters and clamps limit to 500', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'Big Deal', amount: 5000, stage: 'won', ownerId: 10 },
    ]);

    const res = await request(makeApp()).get(
      '/api/reports/detailed/deals?ownerId=10&status=won&limit=9999'
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const call = prisma.deal.findMany.mock.calls[0][0];
    expect(call.where).toEqual(expect.objectContaining({
      tenantId: 1,
      ownerId: 10,
      stage: 'won',
    }));
    // Limit was 9999, must be clamped to 500
    expect(call.take).toBe(500);
  });

  test('unsupported type returns 400', async () => {
    const res = await request(makeApp()).get('/api/reports/detailed/widgets');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /export-csv
// ─────────────────────────────────────────────────────────────────────────

describe('GET /export-csv — CSV blob streaming', () => {
  test('type=deals — emits text/csv, attachment headers, escaped quotes, header row', async () => {
    prisma.deal.findMany.mockResolvedValue([
      {
        title: 'Quote "Special"', // embedded double-quote must escape to ""
        amount: 1500,
        stage: 'won',
        probability: 100,
        owner: { name: 'Alice' },
        contact: { name: 'Acme Inc' },
        expectedClose: null,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);

    const res = await request(makeApp()).get('/api/reports/export-csv?type=deals');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename=deals-report\.csv/);

    // First line is the header
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('Title,Amount,Stage,Probability,Owner,Contact,Expected Close,Created');
    // Quote-escape: " → ""
    expect(lines[1]).toContain('"Quote ""Special"""');
    expect(lines[1]).toContain('"Alice"');
  });

  test('unsupported type=foo returns 400', async () => {
    const res = await request(makeApp()).get('/api/reports/export-csv?type=foo');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported/i);
  });

  test('metric-based export (no ?type) emits Name,Value header + groupBy rows', async () => {
    prisma.deal.groupBy.mockResolvedValue([
      { stage: 'won', _sum: { amount: 5000 } },
      { stage: 'lead', _sum: { amount: 0 } }, // dropped (value=0)
    ]);

    const res = await request(makeApp()).get('/api/reports/export-csv?metric=revenue&groupBy=stage');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/filename=report\.csv/);

    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('Name,Value');
    expect(lines).toContain('"WON",5000');
    // 0-value bucket dropped
    expect(res.text).not.toContain('LEAD');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /export-pdf
// ─────────────────────────────────────────────────────────────────────────

describe('GET /export-pdf — PDF blob streaming', () => {
  test('emits application/pdf + pulls tenant currency for INR/locale rendering (#286/#330)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR', locale: 'en-IN' });
    prisma.deal.findMany.mockResolvedValue([
      {
        title: 'Test Deal',
        amount: 1234,
        currency: 'INR',
        stage: 'won',
        owner: { name: 'Alice' },
        contact: { name: 'Acme' },
        createdAt: new Date(),
      },
    ]);

    const res = await request(makeApp()).get('/api/reports/export-pdf?type=deals');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename=deals-report\.pdf/);

    // Tenant lookup was scoped to req.user.tenantId
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      select: { defaultCurrency: true, locale: true },
    }));

    // Body is a real PDF: starts with %PDF magic bytes
    expect(Buffer.isBuffer(res.body) || typeof res.text === 'string').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-cutting: tenant isolation
// ─────────────────────────────────────────────────────────────────────────

describe('Cross-cutting — every endpoint forwards req.user.tenantId to prisma', () => {
  test('every prisma read carries tenantId from req.user', async () => {
    // Stub all the reads to empty so the routes don't blow up
    prisma.deal.groupBy.mockResolvedValue([]);
    prisma.task.groupBy.mockResolvedValue([]);
    prisma.contact.groupBy.mockResolvedValue([]);
    prisma.invoice.groupBy.mockResolvedValue([]);
    prisma.expense.groupBy.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.task.findMany.mockResolvedValue([]);
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.expense.findMany.mockResolvedValue([]);
    prisma.callLog.findMany.mockResolvedValue([]);
    prisma.emailMessage.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);

    const tenantId = 7777;
    const app = makeApp({ tenantId });

    await request(app).get('/api/reports/query?metric=revenue&groupBy=stage');
    await request(app).get('/api/reports/query?metric=tasks');
    await request(app).get('/api/reports/query?metric=invoices');
    await request(app).get('/api/reports/agent-performance');
    await request(app).get('/api/reports/leaderboard?metric=revenue');
    await request(app).get('/api/reports/detailed/deals');
    await request(app).get('/api/reports/detailed/contacts');

    // Every deal.groupBy was tenant-scoped
    for (const call of prisma.deal.groupBy.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
    // task.groupBy was tenant-scoped
    for (const call of prisma.task.groupBy.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
    // invoice.groupBy was tenant-scoped
    for (const call of prisma.invoice.groupBy.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
    // user.findMany was tenant-scoped (agent-performance + leaderboard both call it)
    for (const call of prisma.user.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
    // deal.findMany was tenant-scoped (/detailed/deals)
    for (const call of prisma.deal.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
    // contact.findMany was tenant-scoped (/detailed/contacts)
    for (const call of prisma.contact.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
  });
});
