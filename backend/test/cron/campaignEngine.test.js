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
    // Atomic per-row lock added by the cron-race hardening (214017c1):
    // the engine flips scheduleStatus PENDING→PROCESSING via updateMany and
    // only proceeds when count===1, so a sibling worker can't double-dispatch.
    updateMany: vi.fn(),
  };
});

beforeEach(() => {
  prisma.campaign.findMany.mockReset();
  prisma.campaign.update.mockReset();
  prisma.campaign.updateMany.mockReset();

  prisma.campaign.findMany.mockResolvedValue([]);
  prisma.campaign.update.mockResolvedValue({});
  // Default: the atomic lock succeeds (this worker won the row).
  prisma.campaign.updateMany.mockResolvedValue({ count: 1 });
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

  // -------------------------------------------------------------------------
  // Extended coverage (tick #N of test-writing cron) — pinning eight further
  // contracts the original 6 cases didn't reach. Each guards a different
  // distinct behaviour rather than re-asserting the closes-#412 invariants.
  // -------------------------------------------------------------------------

  test('empty due list → result.processed=0 and no update calls', async () => {
    // The early-return on `due.length === 0` is the single most-hit code
    // path in production (most ticks have nothing to do). Pin the no-op
    // contract — zero updates, zero dispatches, zero errors.
    prisma.campaign.findMany.mockResolvedValueOnce([]);
    const sendCampaignSpy = vi.fn();

    const result = await processDueCampaigns({ sendCampaignFn: sendCampaignSpy });

    expect(result).toEqual({ processed: 0, dispatched: 0, skipped: 0, errors: [] });
    expect(sendCampaignSpy).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  test('multiple due campaigns all dispatched in a single tick', async () => {
    // Batch-tick contract: when several rows are past-due simultaneously,
    // the engine processes all of them. Verifies the for-loop reaches every
    // row and the final result.dispatched count is accurate.
    const campaigns = [
      { id: 1, channel: 'EMAIL', status: 'Scheduled', tenantId: 1, scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING', scheduleFilters: null },
      { id: 2, channel: 'EMAIL', status: 'Scheduled', tenantId: 1, scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING', scheduleFilters: null },
      { id: 3, channel: 'SMS',   status: 'Scheduled', tenantId: 2, scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING', scheduleFilters: null },
    ];
    prisma.campaign.findMany.mockResolvedValueOnce(campaigns);

    const sendCampaignSpy = vi.fn().mockResolvedValue({ sent: 5 });

    const result = await processDueCampaigns({ sendCampaignFn: sendCampaignSpy });

    expect(result.processed).toBe(3);
    expect(result.dispatched).toBe(3);
    expect(result.errors).toEqual([]);
    expect(sendCampaignSpy).toHaveBeenCalledTimes(3);
    // Each row got a SENT-flip update.
    const sentUpdates = prisma.campaign.update.mock.calls.filter(
      (call) => call[0].data && call[0].data.scheduleStatus === 'SENT',
    );
    expect(sentUpdates).toHaveLength(3);
    expect(sentUpdates.map((c) => c[0].where.id).sort()).toEqual([1, 2, 3]);
  });

  test('mid-batch failure does not poison sibling rows', async () => {
    // Per-row try/catch contract: a single sendCampaign rejection must NOT
    // abort the loop. Sibling rows still dispatch, and the result.errors
    // array captures the failed id verbatim.
    const campaigns = [
      { id: 10, channel: 'EMAIL', status: 'Scheduled', tenantId: 1, scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING', scheduleFilters: null },
      { id: 20, channel: 'EMAIL', status: 'Scheduled', tenantId: 1, scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING', scheduleFilters: null },
      { id: 30, channel: 'EMAIL', status: 'Scheduled', tenantId: 1, scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING', scheduleFilters: null },
    ];
    prisma.campaign.findMany.mockResolvedValueOnce(campaigns);

    const sendCampaignSpy = vi.fn()
      .mockResolvedValueOnce({ sent: 1 })           // id=10 OK
      .mockRejectedValueOnce(new Error('boom'))      // id=20 FAIL
      .mockResolvedValueOnce({ sent: 1 });           // id=30 OK (must still run)

    const result = await processDueCampaigns({ sendCampaignFn: sendCampaignSpy });

    expect(result.processed).toBe(3);
    expect(result.dispatched).toBe(2);
    expect(result.errors).toEqual([{ id: 20, error: 'boom' }]);
    // sendCampaign called for ALL three even though the middle one threw.
    expect(sendCampaignSpy).toHaveBeenCalledTimes(3);
    // id=10 + id=30 got SENT flips; id=20 got Draft-reset.
    const sentIds = prisma.campaign.update.mock.calls
      .filter((c) => c[0].data && c[0].data.scheduleStatus === 'SENT')
      .map((c) => c[0].where.id)
      .sort();
    expect(sentIds).toEqual([10, 30]);
    const draftReset = prisma.campaign.update.mock.calls.find(
      (c) => c[0].data && c[0].data.status === 'Draft',
    );
    expect(draftReset[0].where.id).toBe(20);
  });

  test('malformed scheduleFilters JSON does not abort dispatch — _audienceFilter=null', async () => {
    // The engine wraps JSON.parse in its own try/catch and falls through
    // with _audienceFilter=null rather than letting the SyntaxError escape
    // up to the outer try. Pin that the row still dispatches.
    const dueCampaign = {
      id: 77,
      channel: 'EMAIL',
      status: 'Scheduled',
      tenantId: 1,
      scheduledAt: new Date(Date.now() - 60_000),
      scheduleStatus: 'PENDING',
      scheduleFilters: '{this is not valid JSON',
    };
    prisma.campaign.findMany.mockResolvedValueOnce([dueCampaign]);

    const sendCampaignSpy = vi.fn().mockResolvedValue({ sent: 1 });

    const result = await processDueCampaigns({ sendCampaignFn: sendCampaignSpy });

    expect(result.dispatched).toBe(1);
    expect(result.errors).toEqual([]);
    expect(sendCampaignSpy).toHaveBeenCalledTimes(1);
    // Audience filter was nulled (not left as the bad raw string).
    const [campaignArg] = sendCampaignSpy.mock.calls[0];
    expect(campaignArg._audienceFilter).toBeNull();
  });

  test('null scheduleFilters leaves _audienceFilter undefined (no JSON.parse attempted)', async () => {
    // Distinct from the malformed-JSON case: when scheduleFilters is null
    // (the common case — no audience filter saved), the engine should not
    // touch _audienceFilter at all. This pins the truthiness guard on
    // `if (campaign.scheduleFilters)` so it skips the parse for null too.
    const dueCampaign = {
      id: 88,
      channel: 'EMAIL',
      status: 'Scheduled',
      tenantId: 1,
      scheduledAt: new Date(Date.now() - 60_000),
      scheduleStatus: 'PENDING',
      scheduleFilters: null,
    };
    prisma.campaign.findMany.mockResolvedValueOnce([dueCampaign]);

    const sendCampaignSpy = vi.fn().mockResolvedValue({ sent: 1 });

    await processDueCampaigns({ sendCampaignFn: sendCampaignSpy });

    expect(sendCampaignSpy).toHaveBeenCalledTimes(1);
    const [campaignArg] = sendCampaignSpy.mock.calls[0];
    // _audienceFilter was never assigned — strictly undefined, not null,
    // because the route's sendCampaign distinguishes "no filter" (undefined)
    // from "parse failed" (null).
    expect(campaignArg._audienceFilter).toBeUndefined();
  });

  test('injected `now` is used in the where-clause `lte` filter', async () => {
    // Clock injection contract — tests can pass a deterministic `now` and
    // the engine threads it into `scheduledAt: { lte: now }`. Without this,
    // any "campaign past-due at time T" test would race against wall-clock.
    const fixedNow = new Date('2026-01-15T12:00:00.000Z');

    await processDueCampaigns({ now: fixedNow, sendCampaignFn: vi.fn() });

    const arg = prisma.campaign.findMany.mock.calls[0][0];
    const dbBackedBranch = arg.where.OR.find(
      (b) => b.scheduleStatus === 'PENDING',
    );
    expect(dbBackedBranch).toBeDefined();
    expect(dbBackedBranch.scheduledAt.lte).toBe(fixedNow);
  });

  test('SENT-flip update failure is swallowed — does not propagate to caller', async () => {
    // The `.catch()` on the SENT-flip update is defence-in-depth. If the
    // DB update fails (e.g. connection blip), the dispatch is already
    // committed via sendCampaign — the engine logs and moves on rather
    // than throwing. Pin that result.dispatched still reflects success
    // and no error is surfaced.
    const dueCampaign = {
      id: 55,
      channel: 'EMAIL',
      status: 'Scheduled',
      tenantId: 1,
      scheduledAt: new Date(Date.now() - 60_000),
      scheduleStatus: 'PENDING',
      scheduleFilters: null,
    };
    prisma.campaign.findMany.mockResolvedValueOnce([dueCampaign]);

    // sendCampaign succeeds; the post-success update rejects.
    const sendCampaignSpy = vi.fn().mockResolvedValue({ sent: 1 });
    prisma.campaign.update.mockRejectedValueOnce(new Error('connection lost'));

    const result = await processDueCampaigns({ sendCampaignFn: sendCampaignSpy });

    // Dispatch counted as success despite the update failure — sendCampaign
    // already did the real work.
    expect(result.dispatched).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test('result envelope shape: { processed, dispatched, skipped, errors }', async () => {
    // Contract for the manual /api/marketing/campaigns/run trigger which
    // returns this envelope to the requesting admin. Pin all four fields
    // are present + typed correctly, even when nothing is due.
    prisma.campaign.findMany.mockResolvedValueOnce([]);

    const result = await processDueCampaigns({ sendCampaignFn: vi.fn() });

    expect(result).toHaveProperty('processed');
    expect(result).toHaveProperty('dispatched');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
    expect(typeof result.processed).toBe('number');
    expect(typeof result.dispatched).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
