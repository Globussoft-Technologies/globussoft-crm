// Unit tests for backend/cron/dealInsightsEngine.js — Wave 10 coverage extension.
//
// Why this file exists (Wave 10 inspection):
//   • Pre-Wave-10 the cron-engine module itself (tickDealInsightsEngine +
//     initDealInsightsCron) was 0% covered. The existing
//     backend/test/cron/dealInsightsEngine.test.js covers
//     routes/deal_insights.js (runHeuristicRules + attachDealContext) but
//     NOT the cron wrapper that walks all tenants and invokes them.
//   • The cron wraps two things this test pins:
//       1. tenant fan-out — distinct tenantIds from the open-deals query
//       2. per-deal error isolation — one deal failing doesn't crash the
//          whole tenant or the whole sweep
//
// Coverage targets (branch matrix at backend/cron/dealInsightsEngine.js):
//   • happy path — one tenant, 2 deals, ≥1 insight each → scanned=2, created>0
//   • multi-tenant — 2 tenants walked independently
//   • zero tenants — no calls made, summary {scanned:0, created:0}
//   • per-deal error isolation — runHeuristicRules / persistInsights errors caught
//   • per-tenant error isolation — openDeals findMany rejection caught
//   • top-level failure — distinct findMany rejects, returns error summary
//   • socket.io emit — fires `deal_insights_updated` when io is supplied
//   • socket.io absent — no emit when io is null (no crash)
//
// Mocking strategy: mirror backend/test/cron/leadSlaEngine.test.js comment block.
// vi.mock cannot intercept the SUT's CJS `require('../routes/deal_insights')`,
// so we don't try — we exercise the REAL runHeuristicRules + persistInsights
// path and mock the prisma layer underneath. runHeuristicRules is pure (no
// prisma) and persistInsights does prisma.dealInsight.findFirst +
// prisma.dealInsight.create which we can intercept on the singleton.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { tickDealInsightsEngine } from '../../cron/dealInsightsEngine.js';

beforeAll(() => {
  prisma.deal = {
    findMany: vi.fn(),
  };
  prisma.dealInsight = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
});

beforeEach(() => {
  prisma.deal.findMany.mockReset();
  prisma.dealInsight.findFirst.mockReset();
  prisma.dealInsight.create.mockReset();
  // Default — no existing insight, so create() will fire for every candidate.
  prisma.dealInsight.findFirst.mockResolvedValue(null);
  prisma.dealInsight.create.mockImplementation(({ data }) => Promise.resolve({ id: Math.floor(Math.random() * 1000), ...data }));
});

// A deal in past-expected-close ≥7d range → runHeuristicRules emits at minimum
// "past expected close" RISK + "No activity recorded" RISK + "Low engagement"
// RISK = 3 candidates per deal.
function overdueDealFixture(id, tenantId) {
  return {
    id,
    tenantId,
    stage: 'proposal',
    expectedClose: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    contact: {
      activities: [],
      emails: [],
      callLogs: [],
    },
  };
}

// ─── Happy path ────────────────────────────────────────────────────────────

describe('cron/dealInsightsEngine — tickDealInsightsEngine — happy path', () => {
  test('single tenant, 2 deals → scanned=2 and created > 0', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }]) // distinct tenants
      .mockResolvedValueOnce([overdueDealFixture(10, 1), overdueDealFixture(11, 1)]); // open deals

    const result = await tickDealInsightsEngine(null);
    expect(result.scanned).toBe(2);
    expect(result.created).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  test('open-deals query uses stage notIn ["won","lost"] filter and includes contact context', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }])
      .mockResolvedValueOnce([]);
    await tickDealInsightsEngine(null);
    const openCall = prisma.deal.findMany.mock.calls[1][0];
    expect(openCall.where.tenantId).toBe(1);
    expect(openCall.where.stage).toEqual({ notIn: ['won', 'lost'] });
    expect(openCall.include.contact).toBeDefined();
    expect(openCall.include.contact.include.activities).toBeDefined();
    expect(openCall.include.contact.include.emails).toBeDefined();
    expect(openCall.include.contact.include.callLogs).toBeDefined();
  });

  test('distinct-tenants query also filters won/lost', async () => {
    prisma.deal.findMany.mockResolvedValueOnce([]);
    await tickDealInsightsEngine(null);
    const distinctCall = prisma.deal.findMany.mock.calls[0][0];
    expect(distinctCall.distinct).toEqual(['tenantId']);
    expect(distinctCall.where.stage).toEqual({ notIn: ['won', 'lost'] });
  });

  test('multi-tenant — walks each tenant\'s deals independently', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }, { tenantId: 2 }])
      .mockResolvedValueOnce([overdueDealFixture(10, 1)])
      .mockResolvedValueOnce([overdueDealFixture(20, 2)]);

    const result = await tickDealInsightsEngine(null);
    expect(result.scanned).toBe(2);
    expect(result.created).toBeGreaterThan(0);
    // Each tenant's deals were scanned — 3 findMany calls total
    // (1 distinct + 2 per-tenant open-deals).
    expect(prisma.deal.findMany).toHaveBeenCalledTimes(3);
  });

  test('zero tenants — sweep returns {scanned:0, created:0}', async () => {
    prisma.deal.findMany.mockResolvedValueOnce([]); // no tenants
    const result = await tickDealInsightsEngine(null);
    expect(result.scanned).toBe(0);
    expect(result.created).toBe(0);
    // Only the distinct call fires.
    expect(prisma.deal.findMany).toHaveBeenCalledTimes(1);
  });

  test('tenant with zero open deals — counts 0 scanned for that tenant', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }])
      .mockResolvedValueOnce([]); // no open deals
    const result = await tickDealInsightsEngine(null);
    expect(result.scanned).toBe(0);
    expect(result.created).toBe(0);
  });

  test('insight dedup — when findFirst returns an existing row, create is skipped', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }])
      .mockResolvedValueOnce([overdueDealFixture(10, 1)]);
    // All candidates already exist → 0 created.
    prisma.dealInsight.findFirst.mockResolvedValue({ id: 1 });
    const result = await tickDealInsightsEngine(null);
    expect(result.scanned).toBe(1);
    expect(result.created).toBe(0);
    expect(prisma.dealInsight.create).not.toHaveBeenCalled();
  });
});

// ─── Failure isolation ────────────────────────────────────────────────────

describe('cron/dealInsightsEngine — per-deal failure isolation', () => {
  test('one deal\'s persistInsights fails → other deals in same tenant still scanned', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }])
      .mockResolvedValueOnce([overdueDealFixture(10, 1), overdueDealFixture(11, 1)]);
    // First deal's first create rejects, all others succeed.
    let callCount = 0;
    prisma.dealInsight.create.mockImplementation(({ data }) => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('save failed'));
      return Promise.resolve({ id: callCount, ...data });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await tickDealInsightsEngine(null);
    expect(result.scanned).toBe(2);
    // Created count is reduced but not zero.
    expect(result.created).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
    // Warning should mention "Deal 10 failed".
    const allWarns = warnSpy.mock.calls.map((a) => a.join(' ')).join(' ');
    expect(allWarns).toMatch(/Deal 10 failed/);
    warnSpy.mockRestore();
  });

  test('totalDealsScanned increments BEFORE runHeuristicRules — so even crashing deals count as scanned', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }])
      .mockResolvedValueOnce([overdueDealFixture(10, 1), overdueDealFixture(11, 1)]);
    // dealInsight.findFirst rejects on first call → caught at deal-level try/catch.
    let cn = 0;
    prisma.dealInsight.findFirst.mockImplementation(() => {
      cn++;
      if (cn <= 3) return Promise.reject(new Error('findFirst boom'));
      return Promise.resolve(null);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await tickDealInsightsEngine(null);
    // Both deals scanned even if first one's persistInsights blew up.
    expect(result.scanned).toBe(2);
    warnSpy.mockRestore();
  });
});

describe('cron/dealInsightsEngine — per-tenant failure isolation', () => {
  test('one tenant\'s openDeals findMany rejects → other tenants still walked', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }, { tenantId: 2 }])
      .mockRejectedValueOnce(new Error('tenant 1 DB lost'))
      .mockResolvedValueOnce([overdueDealFixture(20, 2)]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await tickDealInsightsEngine(null);
    // Tenant 1's open-deals query failed → 0 deals scanned for that tenant.
    // Tenant 2 still walks → 1 scanned.
    expect(result.scanned).toBe(1);
    expect(result.created).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.map((a) => a.join(' ')).join(' ');
    expect(msg).toMatch(/Tenant 1 failed/);
    warnSpy.mockRestore();
  });
});

describe('cron/dealInsightsEngine — top-level failure', () => {
  test('distinct-tenants findMany rejection → returns error in summary', async () => {
    prisma.deal.findMany.mockRejectedValueOnce(new Error('top-level DB down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await tickDealInsightsEngine(null);
    expect(result.scanned).toBe(0);
    expect(result.created).toBe(0);
    expect(result.error).toBe('top-level DB down');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── Socket.io emit contract ──────────────────────────────────────────────

describe('cron/dealInsightsEngine — socket.io emit', () => {
  test('emits deal_insights_updated with scanned + created counts when io is supplied', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }])
      .mockResolvedValueOnce([overdueDealFixture(10, 1)]);
    const io = { emit: vi.fn() };
    await tickDealInsightsEngine(io);
    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith('deal_insights_updated', expect.objectContaining({
      scanned: 1,
      created: expect.any(Number),
      ts: expect.any(Date),
    }));
  });

  test('does NOT emit when io is null (no crash)', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }])
      .mockResolvedValueOnce([overdueDealFixture(10, 1)]);
    await expect(tickDealInsightsEngine(null)).resolves.toBeDefined();
  });

  test('does NOT emit when io is undefined', async () => {
    prisma.deal.findMany.mockResolvedValueOnce([]);
    await expect(tickDealInsightsEngine(undefined)).resolves.toBeDefined();
  });

  test('emit happens AFTER all tenants have been processed (not per-tenant)', async () => {
    prisma.deal.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }, { tenantId: 2 }])
      .mockResolvedValueOnce([overdueDealFixture(10, 1)])
      .mockResolvedValueOnce([overdueDealFixture(20, 2)]);
    const io = { emit: vi.fn() };
    await tickDealInsightsEngine(io);
    expect(io.emit).toHaveBeenCalledTimes(1);
    const payload = io.emit.mock.calls[0][1];
    // Both tenants' scanned counts are aggregated into the single emit.
    expect(payload.scanned).toBe(2);
  });
});
