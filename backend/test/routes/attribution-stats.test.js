// @ts-check
/**
 * Unit tests for backend/routes/attribution.js — GET /api/attribution/stats
 *
 * Marketing/Analytics polish — first tenant-wide aggregate endpoint for
 * the attribution route. Powers the marketing dashboard header KPI strip
 * (totalTouchpoints + byChannel + byCampaign + attributedContacts +
 * lastTouchAt) without N round-trips.
 *
 * What this file pins
 * ───────────────────
 *   1. Happy path: counts touchpoints, groups by channel + campaign,
 *      computes distinct attributedContacts via Touchpoint × won-Deal join,
 *      surfaces lastTouchAt as max(timestamp).
 *   2. byCampaign top-10 cap: returns at most 10 campaign buckets, ordered
 *      by count desc.
 *   3. Junk-source filter (#268): touchpoints whose source matches
 *      test-skip / e2e-* / qa-* / rbac-* drop from totals + byChannel +
 *      byCampaign + attributedContacts.
 *   4. Empty result: zero touchpoints → zeroed envelope with lastTouchAt=null.
 *   5. Date validation: ?from invalid ISO → 400 INVALID_DATE.
 *   6. Date validation: ?to invalid ISO → 400 INVALID_DATE.
 *   7. Valid ?from + ?to: pushed onto Prisma where.timestamp.gte/lte.
 *   8. Tenant isolation: scope where.tenantId from req.user.tenantId.
 *   9. attributedContacts only counts contacts with BOTH ≥1 touchpoint AND
 *      ≥1 won deal — a touchpoint contact with no won deal does NOT count.
 *  10. Null campaignId rows are excluded from byCampaign but still count
 *      in totalTouchpoints + byChannel.
 *  11. Null channel rows coalesce to 'unknown' in byChannel.
 *  12. 500 on Prisma blow-up (defensive try/catch).
 *  13. No audit row written (read-only meta surface — mirrors /report).
 *  14. Half-open window (?from only) is accepted — does NOT raise
 *      INVERTED_DATE_RANGE since this endpoint uses per-field ISO checks,
 *      not the shared validateDateRange helper.
 *
 * Pattern reference
 * ─────────────────
 *   Mirrors backend/test/routes/attribution.test.js (same prisma singleton
 *   monkey-patch + supertest + fake auth middleware pattern). The router
 *   uses the global verifyToken at the server level; here we mount the
 *   sub-router behind a tenant-injecting middleware exactly as the parent
 *   does.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router. /stats touches
// touchpoint + deal models.
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = prisma.contact.findFirst || vi.fn();
prisma.contact.findMany = prisma.contact.findMany || vi.fn();
prisma.contact.update = prisma.contact.update || vi.fn();
prisma.touchpoint = prisma.touchpoint || {};
prisma.touchpoint.create = prisma.touchpoint.create || vi.fn();
prisma.touchpoint.findMany = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const attributionRouter = requireCJS('../../routes/attribution');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  withUser = true,
} = {}) {
  const app = express();
  app.use(express.json());
  if (withUser) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/attribution', attributionRouter);
  return app;
}

beforeEach(() => {
  prisma.touchpoint.findMany.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.auditLog.create.mockReset();
});

// ── happy path + grouping ──────────────────────────────────────────────

describe('GET /api/attribution/stats — happy path', () => {
  test('aggregates totalTouchpoints + byChannel + byCampaign + attributedContacts + lastTouchAt', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      {
        contactId: 10,
        channel: 'web',
        source: 'google',
        campaignId: 100,
        timestamp: new Date('2026-03-01T10:00:00Z'),
      },
      {
        contactId: 10,
        channel: 'web',
        source: 'google',
        campaignId: 100,
        timestamp: new Date('2026-03-02T10:00:00Z'),
      },
      {
        contactId: 11,
        channel: 'whatsapp',
        source: 'partner-a',
        campaignId: 200,
        timestamp: new Date('2026-03-03T10:00:00Z'),
      },
      {
        contactId: 12,
        channel: 'email',
        source: 'newsletter',
        campaignId: null,
        timestamp: new Date('2026-03-04T10:00:00Z'),
      },
    ]);
    // 2 contacts have won deals: 10 + 11. Contact 12 has touchpoint but
    // no won deal — does NOT count as attributed.
    prisma.deal.findMany.mockResolvedValue([
      { contactId: 10 },
      { contactId: 11 },
    ]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalTouchpoints).toBe(4);

    // byChannel sorted by count desc.
    expect(res.body.byChannel).toEqual([
      { channel: 'web', count: 2 },
      { channel: 'whatsapp', count: 1 },
      { channel: 'email', count: 1 },
    ]);

    // byCampaign — campaign 100 (count=2) before 200 (count=1); null
    // campaignId excluded.
    expect(res.body.byCampaign).toEqual([
      { campaignId: 100, count: 2 },
      { campaignId: 200, count: 1 },
    ]);

    expect(res.body.attributedContacts).toBe(2);
    expect(res.body.lastTouchAt).toBe('2026-03-04T10:00:00.000Z');
  });

  test('byCampaign caps at top 10 ordered by count desc', async () => {
    // Generate 15 distinct campaigns with counts 15..1.
    const tps = [];
    for (let i = 1; i <= 15; i++) {
      for (let j = 0; j < i; j++) {
        tps.push({
          contactId: 1,
          channel: 'web',
          source: 'google',
          campaignId: i,
          timestamp: new Date('2026-03-01T10:00:00Z'),
        });
      }
    }
    prisma.touchpoint.findMany.mockResolvedValue(tps);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(res.body.byCampaign).toHaveLength(10);
    // First entry: campaign 15 (count 15). Last entry: campaign 6 (count 6).
    expect(res.body.byCampaign[0]).toEqual({ campaignId: 15, count: 15 });
    expect(res.body.byCampaign[9]).toEqual({ campaignId: 6, count: 6 });
  });

  test('null channel coalesces to "unknown" in byChannel', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 10, channel: null, source: 'google', campaignId: null, timestamp: new Date('2026-03-01T10:00:00Z') },
      { contactId: 11, channel: 'web', source: 'google', campaignId: null, timestamp: new Date('2026-03-01T10:00:00Z') },
    ]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    const unknown = res.body.byChannel.find((e) => e.channel === 'unknown');
    expect(unknown).toMatchObject({ count: 1 });
    const web = res.body.byChannel.find((e) => e.channel === 'web');
    expect(web).toMatchObject({ count: 1 });
  });

  test('null campaignId rows excluded from byCampaign but still in totals', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 10, channel: 'web', source: 'google', campaignId: null, timestamp: new Date('2026-03-01T10:00:00Z') },
      { contactId: 11, channel: 'web', source: 'google', campaignId: null, timestamp: new Date('2026-03-01T10:00:00Z') },
      { contactId: 12, channel: 'web', source: 'google', campaignId: 100, timestamp: new Date('2026-03-01T10:00:00Z') },
    ]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalTouchpoints).toBe(3);
    // byChannel still counts all 3.
    expect(res.body.byChannel[0]).toEqual({ channel: 'web', count: 3 });
    // byCampaign only the 1 row that has a campaignId.
    expect(res.body.byCampaign).toEqual([{ campaignId: 100, count: 1 }]);
  });
});

// ── junk-source filter ──────────────────────────────────────────────────

describe('GET /api/attribution/stats — junk-source filter (#268)', () => {
  test('drops test-skip / e2e-* / qa-* / rbac-* sources from totals + byChannel + byCampaign', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 10, channel: 'web', source: 'google', campaignId: 100, timestamp: new Date('2026-03-01T10:00:00Z') },   // keep
      { contactId: 11, channel: 'web', source: 'test-skip', campaignId: 100, timestamp: new Date('2026-03-01T10:00:00Z') }, // drop
      { contactId: 12, channel: 'web', source: 'e2e-flow-1', campaignId: 100, timestamp: new Date('2026-03-01T10:00:00Z') }, // drop
      { contactId: 13, channel: 'web', source: 'qa-bot', campaignId: 100, timestamp: new Date('2026-03-01T10:00:00Z') },     // drop
      { contactId: 14, channel: 'web', source: 'rbac-helper', campaignId: 100, timestamp: new Date('2026-03-01T10:00:00Z') }, // drop
    ]);
    // Simulate the contactId filter: contact 11's source is junk so it
    // drops from the surviving touchpoint set BEFORE the deal query, and
    // the implementation passes `contactId: { in: [10] }` to prisma. A
    // real DB would only return matching rows — mock the filter for parity.
    prisma.deal.findMany.mockImplementation(({ where }) => {
      const allowed = (where && where.contactId && where.contactId.in) || [];
      const rows = [{ contactId: 11 }, { contactId: 10 }];
      return Promise.resolve(rows.filter((r) => allowed.includes(r.contactId)));
    });

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalTouchpoints).toBe(1);
    expect(res.body.byChannel).toEqual([{ channel: 'web', count: 1 }]);
    expect(res.body.byCampaign).toEqual([{ campaignId: 100, count: 1 }]);
    // Only contact 10 remained in the surviving touchpoint set, and contact
    // 10 has a won deal → 1 attributed.
    expect(res.body.attributedContacts).toBe(1);
  });
});

// ── empty result ────────────────────────────────────────────────────────

describe('GET /api/attribution/stats — empty result', () => {
  test('zero touchpoints → zeroed envelope with lastTouchAt=null', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([]);
    // deal.findMany must NOT be invoked when contactIdSet is empty.
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalTouchpoints: 0,
      byChannel: [],
      byCampaign: [],
      attributedContacts: 0,
      lastTouchAt: null,
    });
    // Deal query skipped — no contactIds to join against.
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });
});

// ── date validation ─────────────────────────────────────────────────────

describe('GET /api/attribution/stats — date validation', () => {
  test('?from=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/attribution/stats?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.touchpoint.findMany).not.toHaveBeenCalled();
  });

  test('?to=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/attribution/stats?to=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.touchpoint.findMany).not.toHaveBeenCalled();
  });

  test('valid ?from + ?to applies a timestamp window to the prisma where clause', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/attribution/stats?from=2026-01-01&to=2026-02-01');

    expect(res.status).toBe(200);
    const callArgs = prisma.touchpoint.findMany.mock.calls[0][0];
    expect(callArgs.where.tenantId).toBe(1);
    expect(callArgs.where.timestamp).toBeDefined();
    expect(callArgs.where.timestamp.gte).toBeInstanceOf(Date);
    expect(callArgs.where.timestamp.lte).toBeInstanceOf(Date);
  });

  test('half-open window (?from only) accepted — no INVERTED_DATE_RANGE error', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/attribution/stats?from=2026-01-01');

    expect(res.status).toBe(200);
    // This endpoint deliberately does NOT use the shared validateDateRange
    // helper — half-open windows are a legitimate dashboard use case.
    const callArgs = prisma.touchpoint.findMany.mock.calls[0][0];
    expect(callArgs.where.timestamp.gte).toBeInstanceOf(Date);
    expect(callArgs.where.timestamp.lte).toBeUndefined();
  });
});

// ── tenant isolation ────────────────────────────────────────────────────

describe('GET /api/attribution/stats — tenant isolation', () => {
  test('scopes prisma queries by tenantId from req.user', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 9 })).get('/api/attribution/stats');

    expect(prisma.touchpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 9 }),
      })
    );
  });

  test('deal join is tenant-scoped + stage=won', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 42, channel: 'web', source: 'google', campaignId: null, timestamp: new Date('2026-03-01T10:00:00Z') },
    ]);
    prisma.deal.findMany.mockResolvedValue([{ contactId: 42 }]);

    await request(makeApp({ tenantId: 9 })).get('/api/attribution/stats');

    expect(prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 9,
          stage: 'won',
          contactId: { in: [42] },
        }),
      })
    );
  });
});

// ── attributedContacts join semantics ───────────────────────────────────

describe('GET /api/attribution/stats — attributedContacts semantics', () => {
  test('contact with touchpoint but NO won deal → NOT counted as attributed', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 50, channel: 'web', source: 'google', campaignId: null, timestamp: new Date('2026-03-01T10:00:00Z') },
    ]);
    // No won deal for contact 50.
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalTouchpoints).toBe(1);
    expect(res.body.attributedContacts).toBe(0);
  });

  test('multiple touchpoints + multiple won deals for same contact → deduped to 1 attributed', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 50, channel: 'web', source: 'google', campaignId: 1, timestamp: new Date('2026-03-01T10:00:00Z') },
      { contactId: 50, channel: 'web', source: 'google', campaignId: 1, timestamp: new Date('2026-03-02T10:00:00Z') },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { contactId: 50 },
      { contactId: 50 },
    ]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(res.body.attributedContacts).toBe(1);
  });
});

// ── no audit row written ────────────────────────────────────────────────

describe('GET /api/attribution/stats — no audit row written', () => {
  test('read-only meta surface does NOT write an AuditLog entry', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── 500 on Prisma blow-up ───────────────────────────────────────────────

describe('GET /api/attribution/stats — defensive try/catch', () => {
  test('500 on prisma.touchpoint.findMany blow-up', async () => {
    prisma.touchpoint.findMany.mockRejectedValue(new Error('boom'));

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });

  test('500 on prisma.deal.findMany blow-up', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 1, channel: 'web', source: 'google', campaignId: null, timestamp: new Date('2026-03-01T10:00:00Z') },
    ]);
    prisma.deal.findMany.mockRejectedValue(new Error('boom'));

    const res = await request(makeApp()).get('/api/attribution/stats');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});
