// Unit tests for backend/cron/campaignEngine.js — verifies that schedule
// metadata persists in the DB (Campaign.scheduledAt + Campaign.scheduleStatus
// + Campaign.scheduleFilters) instead of the legacy in-memory
// `global._campaignSchedules` map.
//
// Why this matters (closes #412): the old engine read schedule metadata
// from a module-level global object. A backend restart or a process crash
// silently dropped every pending schedule, and a multi-instance deploy
// (PM2 cluster, k8s replicas) would each hold a divergent copy. Production-
// impacting silent data loss.
//
// Mocking strategy mirrors backend/test/cron/recurringInvoiceEngine.test.js:
// import the prisma singleton, monkey-patch model methods. The cron module
// is inlined via vitest.config.js → server.deps.inline so its
// require("../lib/prisma") resolves to the same singleton instance.

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { processDueCampaigns } from '../../cron/campaignEngine.js';

beforeAll(() => {
  prisma.campaign = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
});

beforeEach(() => {
  prisma.campaign.findMany.mockReset();
  prisma.campaign.update.mockReset();

  prisma.campaign.findMany.mockResolvedValue([]);
  prisma.campaign.update.mockResolvedValue({});
});

describe('cron/campaignEngine — DB-backed schedule persistence (closes #412)', () => {
  test('reads scheduledAt + scheduleStatus from DB, not from global._campaignSchedules', async () => {
    // Sanity guard — verify the legacy global is not consulted.
    delete global._campaignSchedules;

    await processDueCampaigns({ sendCampaignFn: vi.fn() });

    expect(prisma.campaign.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.campaign.findMany.mock.calls[0][0];
    // The where-clause must reference the new persistent columns.
    const whereJson = JSON.stringify(arg.where);
    expect(whereJson).toContain('scheduleStatus');
    expect(whereJson).toContain('PENDING');
    expect(whereJson).toContain('scheduledAt');
    // And must NOT touch the legacy global.
    expect(global._campaignSchedules).toBeUndefined();
  });

  test('Schedule persists across module reload — DB-backed read sees the row', async () => {
    // 1. Simulate the route having written scheduledAt + scheduleStatus=PENDING
    //    to campaign id=42 BEFORE the "restart". The DB row carries the
    //    schedule, not an in-memory map.
    const dueCampaign = {
      id: 42,
      name: 'Restart-survival campaign',
      channel: 'EMAIL',
      status: 'Scheduled',
      tenantId: 7,
      scheduledAt: new Date(Date.now() - 60 * 1000), // 1 min ago — past-due
      scheduleStatus: 'PENDING',
      scheduleFilters: JSON.stringify({ source: 'restart-test' }),
    };

    // 2. Simulate "restart": clear the legacy global, reset all in-process
    //    module state. The DB row remains.
    delete global._campaignSchedules;
    vi.resetModules();

    // 3. Re-import the engine after the simulated restart. Module-level
    //    state is fresh; only the DB-backed read can find the schedule.
    const { processDueCampaigns: freshProcessDue } = await import('../../cron/campaignEngine.js');

    // Re-wire the prisma mock against the fresh module's prisma reference.
    // (The vitest.config.js inlining keeps the singleton consistent across
    // resetModules, but we re-prime the mock to be safe.)
    prisma.campaign.findMany.mockResolvedValueOnce([dueCampaign]);

    const sendCampaignSpy = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });

    const result = await freshProcessDue({ sendCampaignFn: sendCampaignSpy });

    // Engine saw the row from the DB and dispatched it.
    expect(result.processed).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.errors).toEqual([]);

    // sendCampaign was called with the campaign. Audience filter was
    // hydrated from the persisted JSON column.
    expect(sendCampaignSpy).toHaveBeenCalledTimes(1);
    const [campaignArg] = sendCampaignSpy.mock.calls[0];
    expect(campaignArg.id).toBe(42);
    expect(campaignArg._audienceFilter).toEqual({ source: 'restart-test' });

    // Engine flipped scheduleStatus to SENT to prevent double-dispatch
    // on the next tick — this is the persistent idempotency guard that
    // replaces the old in-memory delete.
    const updateCalls = prisma.campaign.update.mock.calls;
    const sentUpdate = updateCalls.find(
      (call) => call[0].data && call[0].data.scheduleStatus === 'SENT',
    );
    expect(sentUpdate, 'engine must mark scheduleStatus=SENT after dispatch').toBeDefined();
    expect(sentUpdate[0].where).toEqual({ id: 42 });
  });

  test('failed dispatch flips status=Draft + clears scheduleStatus (no retry-loop)', async () => {
    const dueCampaign = {
      id: 99,
      name: 'Doomed campaign',
      channel: 'EMAIL',
      status: 'Scheduled',
      tenantId: 1,
      scheduledAt: new Date(Date.now() - 60 * 1000),
      scheduleStatus: 'PENDING',
      scheduleFilters: null,
    };
    prisma.campaign.findMany.mockResolvedValueOnce([dueCampaign]);

    const sendCampaignSpy = vi.fn().mockRejectedValue(new Error('Mailgun 503'));

    const result = await processDueCampaigns({ sendCampaignFn: sendCampaignSpy });

    expect(result.dispatched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({ id: 99, error: 'Mailgun 503' });

    // Failure path: status flipped back to Draft, scheduleStatus cleared.
    const draftUpdate = prisma.campaign.update.mock.calls.find(
      (call) => call[0].data && call[0].data.status === 'Draft',
    );
    expect(draftUpdate, 'engine must reset failed schedule to Draft').toBeDefined();
    expect(draftUpdate[0].data.scheduleStatus).toBeNull();
  });

  test('tenantId option scopes the findMany where-clause (mirrors /run trigger)', async () => {
    await processDueCampaigns({ tenantId: 42, sendCampaignFn: vi.fn() });
    const arg = prisma.campaign.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
  });

  test('cron mode (no tenantId) does NOT filter by tenant — processes ALL tenants', async () => {
    await processDueCampaigns({ sendCampaignFn: vi.fn() });
    const arg = prisma.campaign.findMany.mock.calls[0][0];
    // Engine in default mode is the every-minute cron — must walk all
    // tenants (mirrors recurringInvoiceEngine behaviour).
    expect(arg.where.tenantId).toBeUndefined();
  });

  test('legacy fallback: status=Scheduled with no schedule metadata still picked up', async () => {
    // Pre-#412 rows that were forced to status='Scheduled' via PUT but
    // never had scheduleStatus set must not be stranded after the migration.
    // The OR clause in the where catches them.
    await processDueCampaigns({ sendCampaignFn: vi.fn() });
    const arg = prisma.campaign.findMany.mock.calls[0][0];
    const orBranches = arg.where.OR;
    expect(Array.isArray(orBranches)).toBe(true);
    const legacyBranch = orBranches.find(
      (b) => b.status === 'Scheduled' && b.scheduleStatus === null,
    );
    expect(
      legacyBranch,
      'engine must keep a legacy fallback branch for pre-#412 Scheduled rows',
    ).toBeDefined();
  });
});
