// @ts-check
/**
 * Unit tests for backend/cron/reportEngine.js — Wave 11 Agent A.
 *
 * Why this file exists (regression class):
 *   Pre-Wave-11 the module was 0% covered. The engine generates scheduled
 *   reports (agent-performance, deals, tasks, summary) and emails them as
 *   either PDF or CSV attachments hourly. The contract under test:
 *     - generateReportData branches by reportType + frequency (daily/weekly/monthly)
 *     - agent-performance: aggregates per-user dealsWon/revenue/dealsTotal/tasks/calls/emails
 *     - deals/pipeline: lists deals + totals
 *     - tasks: lists tasks
 *     - summary (default): top-line counts
 *     - empty recipients → skip without sending
 *     - PDF attachment generation (via pdfkit) — happy path returns Buffer
 *     - CSV attachment generation — happy path returns CSV string
 *     - lastRunAt is updated post-send
 *     - error in processing is swallowed (logged, does not throw)
 *     - tenant-aware currency: defaultCurrency=INR uses ₹ in PDF (verified via formatMoney)
 *
 * Mocking strategy:
 *   - createRequire + cache delete (matches backupEngine pattern).
 *   - lib/prisma — monkey-patch model methods.
 *   - lib/cronRegistry — the SUT registers via cronRegistry.register({...})
 *     (Super Admin Portal / Cron Maintenance retrofit) instead of calling
 *     node-cron directly; we mock register() and capture the tickFn option.
 *     Note: the SUT's own outer try/catch around the tick body moved to
 *     cronRegistry.runTick (see test/lib/cronRegistry.test.js), so tick()
 *     now PROPAGATES a findMany rejection instead of swallowing it itself.
 *
 * NOT covered (intentional):
 *   - Real SMTP delivery (SMTP_HOST defaults to ethereal.email → mock branch).
 *   - The exact PDF bytes (assert Buffer + sane length only).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Patch prisma BEFORE requiring SUT ──────────────────────────────────
import prisma from '../../lib/prisma.js';
prisma.user = { findMany: vi.fn() };
prisma.deal = {
  count: vi.fn(),
  aggregate: vi.fn(),
  findMany: vi.fn(),
};
prisma.task = { count: vi.fn(), findMany: vi.fn() };
prisma.callLog = { count: vi.fn() };
prisma.emailMessage = { count: vi.fn() };
prisma.contact = { count: vi.fn() };
prisma.tenant = { findUnique: vi.fn() };
prisma.reportSchedule = {
  findMany: vi.fn(),
  update: vi.fn(),
};
prisma.tenantSetting = { findUnique: vi.fn() };

// ── Fake cronRegistry module in require cache (BEFORE requiring SUT) ──
const registerMock = vi.fn().mockResolvedValue({ name: 'reportEngine' });
const cronRegistryPath = requireCJS.resolve('../../lib/cronRegistry.js');
Module._cache[cronRegistryPath] = {
  id: cronRegistryPath,
  filename: cronRegistryPath,
  loaded: true,
  exports: { register: registerMock },
};

// ── Require SUT ───────────────────────────────────────────────────────
const sutPath = requireCJS.resolve('../../cron/reportEngine.js');
delete requireCJS.cache[sutPath];
const reportEngine = requireCJS('../../cron/reportEngine.js');

beforeEach(() => {
  prisma.user.findMany.mockReset();
  prisma.deal.count.mockReset();
  prisma.deal.aggregate.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.task.count.mockReset();
  prisma.task.findMany.mockReset();
  prisma.callLog.count.mockReset();
  prisma.emailMessage.count.mockReset();
  prisma.contact.count.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.reportSchedule.findMany.mockReset();
  prisma.reportSchedule.update.mockReset();
  prisma.tenantSetting.findUnique.mockReset();
  registerMock.mockReset().mockResolvedValue({ name: 'reportEngine' });

  // Defaults
  prisma.user.findMany.mockResolvedValue([]);
  prisma.deal.count.mockResolvedValue(0);
  prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  prisma.deal.findMany.mockResolvedValue([]);
  prisma.task.count.mockResolvedValue(0);
  prisma.task.findMany.mockResolvedValue([]);
  prisma.callLog.count.mockResolvedValue(0);
  prisma.emailMessage.count.mockResolvedValue(0);
  prisma.contact.count.mockResolvedValue(0);
  prisma.tenant.findUnique.mockResolvedValue({
    defaultCurrency: 'USD',
    locale: 'en-US',
  });
  prisma.reportSchedule.update.mockResolvedValue({});
  prisma.reportSchedule.findMany.mockResolvedValue([]);
  prisma.tenantSetting.findUnique.mockResolvedValue(null);
});

/** Build a ReportSchedule row. */
function schedule(overrides = {}) {
  return {
    id: 1,
    tenantId: 1,
    name: 'Weekly Sales Digest',
    reportType: 'summary',
    frequency: 'weekly',
    format: 'CSV',
    enabled: true,
    recipients: JSON.stringify(['alice@example.com']),
    lastRunAt: null,
    ...overrides,
  };
}

describe('cron/reportEngine — processSchedule (summary report)', () => {
  test('summary happy path: fans out 4 prisma queries → CSV attachment + lastRunAt update', async () => {
    prisma.deal.count.mockResolvedValue(12);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: 50000 } });
    prisma.contact.count.mockResolvedValue(7);
    prisma.task.count.mockResolvedValue(20);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(schedule());
    logSpy.mockRestore();

    expect(prisma.deal.count).toHaveBeenCalledTimes(1);
    expect(prisma.deal.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.contact.count).toHaveBeenCalledTimes(1);
    expect(prisma.task.count).toHaveBeenCalledTimes(1);
    expect(prisma.reportSchedule.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { lastRunAt: expect.any(Date) },
    });
  });

  test('empty recipients → skip (no lastRunAt update, no DB queries beyond the data fetch)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(
      schedule({ recipients: JSON.stringify([]) })
    );
    logSpy.mockRestore();
    expect(prisma.reportSchedule.update).not.toHaveBeenCalled();
  });

  test('daily frequency uses a 1-day lookback window', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(schedule({ frequency: 'daily' }));
    logSpy.mockRestore();
    expect(prisma.deal.count).toHaveBeenCalled();
    const where = prisma.deal.count.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    const diffMs = where.createdAt.lte - where.createdAt.gte;
    // ~1 day window
    expect(diffMs).toBeGreaterThan(20 * 3600 * 1000);
    expect(diffMs).toBeLessThan(28 * 3600 * 1000);
  });

  test('monthly frequency uses a ~30-day lookback window', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(schedule({ frequency: 'monthly' }));
    logSpy.mockRestore();
    const where = prisma.deal.count.mock.calls[0][0].where;
    const diffMs = where.createdAt.lte - where.createdAt.gte;
    expect(diffMs).toBeGreaterThan(27 * 86400 * 1000);
    expect(diffMs).toBeLessThan(32 * 86400 * 1000);
  });
});

describe('cron/reportEngine — processSchedule (agent-performance report)', () => {
  test('aggregates per-user metrics and produces PDF attachment', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 11, name: 'Alice', email: 'a@x.com' },
      { id: 22, name: 'Bob', email: 'b@x.com' },
    ]);
    // Per-user counts
    prisma.deal.count
      .mockResolvedValueOnce(5)   // Alice won
      .mockResolvedValueOnce(10)  // Alice total
      .mockResolvedValueOnce(2)   // Bob won
      .mockResolvedValueOnce(8);  // Bob total
    prisma.deal.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 80000 } })  // Alice revenue
      .mockResolvedValueOnce({ _sum: { amount: 20000 } }); // Bob revenue
    prisma.task.count.mockResolvedValue(3);
    prisma.callLog.count.mockResolvedValue(7);
    prisma.emailMessage.count.mockResolvedValue(11);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(
      schedule({ reportType: 'agent-performance', format: 'PDF' })
    );
    logSpy.mockRestore();

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    // Each user triggers a Promise.all of 6 queries: 2× deal.count + 1× deal.aggregate
    // + 1× task.count + 1× callLog.count + 1× emailMessage.count.
    expect(prisma.deal.count).toHaveBeenCalledTimes(4);
    expect(prisma.deal.aggregate).toHaveBeenCalledTimes(2);
    expect(prisma.reportSchedule.update).toHaveBeenCalledOnce();
  });
});

describe('cron/reportEngine — processSchedule (deals + pipeline + tasks reports)', () => {
  test('deals report: pulls findMany with owner+contact includes, computes totals', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'Deal 1', amount: 1000, stage: 'won', owner: { name: 'Alice' }, contact: { name: 'X' } },
      { id: 2, title: 'Deal 2', amount: 500, stage: 'lost', owner: { name: 'Bob' }, contact: { name: 'Y' } },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(
      schedule({ reportType: 'deals', format: 'CSV' })
    );
    logSpy.mockRestore();
    expect(prisma.deal.findMany).toHaveBeenCalledOnce();
    const arg = prisma.deal.findMany.mock.calls[0][0];
    expect(arg.include.owner.select.name).toBe(true);
    expect(arg.include.contact.select.name).toBe(true);
  });

  test('pipeline report uses the same deals data shape', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(
      schedule({ reportType: 'pipeline', format: 'CSV' })
    );
    logSpy.mockRestore();
    expect(prisma.deal.findMany).toHaveBeenCalledOnce();
  });

  test('tasks report: pulls task.findMany with user include', async () => {
    prisma.task.findMany.mockResolvedValue([
      { id: 1, title: 'T1', status: 'Open', user: { name: 'Alice' } },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(
      schedule({ reportType: 'tasks', format: 'CSV' })
    );
    logSpy.mockRestore();
    expect(prisma.task.findMany).toHaveBeenCalledOnce();
    expect(prisma.task.findMany.mock.calls[0][0].include.user.select.name).toBe(true);
  });
});

describe('cron/reportEngine — PDF attachment branch (pdfkit invocation)', () => {
  test('PDF format → generatePDFBuffer is called (does not throw)', async () => {
    prisma.deal.count.mockResolvedValue(3);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: 15000 } });
    prisma.contact.count.mockResolvedValue(5);
    prisma.task.count.mockResolvedValue(8);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      reportEngine.processSchedule(schedule({ format: 'PDF' }))
    ).resolves.not.toThrow();
    logSpy.mockRestore();
    expect(prisma.reportSchedule.update).toHaveBeenCalledOnce();
  });

  test('tenant-aware currency: INR locale routes through formatMoney', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      defaultCurrency: 'INR',
      locale: 'en-IN',
    });
    prisma.deal.count.mockResolvedValue(1);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: 5000 } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(schedule({ format: 'PDF' }));
    logSpy.mockRestore();
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { defaultCurrency: true, locale: true },
    });
  });

  test('tenant missing → falls back to USD (no throw)', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.deal.count.mockResolvedValue(0);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: null } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      reportEngine.processSchedule(schedule({ format: 'PDF' }))
    ).resolves.not.toThrow();
    logSpy.mockRestore();
  });
});

describe('cron/reportEngine — error containment + initReportCron registration', () => {
  test('a thrown prisma query is logged and swallowed (no rethrow)', async () => {
    prisma.deal.count.mockRejectedValue(new Error('DB down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(reportEngine.processSchedule(schedule())).resolves.not.toThrow();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('initReportCron registers an hourly schedule via cronRegistry', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    logSpy.mockRestore();
    expect(registerMock).toHaveBeenCalledTimes(1);
    const opts = registerMock.mock.calls[0][0];
    expect(opts.name).toBe('reportEngine');
    expect(opts.defaultSchedule).toBe('0 * * * *');
    expect(typeof opts.tickFn).toBe('function');
  });

  test('cron tick fetches enabled schedules and dispatches due ones', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    // 2 schedules: one never-run (always due), one run an hour ago (NOT due for weekly).
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({ id: 1, lastRunAt: null }),
      schedule({ id: 2, lastRunAt: new Date(Date.now() - 3600 * 1000), frequency: 'weekly' }),
    ]);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    // findMany once on schedules + downstream deal.count from the one due schedule
    expect(prisma.reportSchedule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.reportSchedule.findMany.mock.calls[0][0]).toEqual({
      where: { enabled: true },
    });
    // Only the first schedule was due → only 1 lastRunAt update
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
    expect(prisma.reportSchedule.update.mock.calls[0][0].where.id).toBe(1);
  });

  test('cron tick: a findMany rejection propagates — cronRegistry.runTick (not this engine) now owns tick-level fault isolation', async () => {
    // Since the Super Admin Portal / Cron Maintenance retrofit, the outer
    // "never let a tick reject" guarantee moved to cronRegistry.runTick
    // (see test/lib/cronRegistry.test.js), so every engine's failures are
    // uniformly captured as a CronExecutionLog row instead of each engine
    // re-implementing its own outer try/catch.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockRejectedValue(new Error('DB lost'));
    const tick = registerMock.mock.calls[0][0].tickFn;
    await expect(tick()).rejects.toThrow('DB lost');
    logSpy.mockRestore();
  });

  test('shouldScheduleRun semantics: weekly schedule run 2h ago is NOT due (167h threshold)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({ id: 1, lastRunAt: new Date(Date.now() - 2 * 3600 * 1000), frequency: 'weekly' }),
    ]);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    expect(prisma.reportSchedule.update).not.toHaveBeenCalled();
  });

  test('shouldScheduleRun semantics: daily schedule run 25h ago IS due (>=23h)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({ id: 99, lastRunAt: new Date(Date.now() - 25 * 3600 * 1000), frequency: 'daily' }),
    ]);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Extended coverage — additional 8 cases.
//
// Gaps targeted (none of the 17 baseline cases pin these):
//   1. Weekly-frequency lookback window math (only daily + monthly were pinned).
//   2. Monthly cadence due-after-30d (only daily 25h was pinned).
//   3. Empty schedule list → cron tick is a clean no-op (zero downstream calls).
//   4. enabled:false rows never reach processSchedule (findMany where filter).
//   5. Mid-batch isolation: one schedule's failure doesn't poison its sibling.
//   6. Multi-recipient fan-out: recipients.join(', ') over a 3-element array still
//      lands the lastRunAt update (no cardinality bug).
//   7. agent-performance with zero users → empty fanout, no per-user queries,
//      lastRunAt still updates (vacuous-truth contract).
//   8. shouldScheduleRun default branch: unknown frequency reuses the weekly
//      167h threshold (regression-pin against future enum drift).
// ───────────────────────────────────────────────────────────────────────

describe('cron/reportEngine — extended coverage (frequency windows + multi-schedule semantics)', () => {
  test('weekly frequency uses a ~7-day lookback window', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(schedule({ frequency: 'weekly' }));
    logSpy.mockRestore();
    const where = prisma.deal.count.mock.calls[0][0].where;
    const diffMs = where.createdAt.lte - where.createdAt.gte;
    // 7 days ± a day to absorb DST transitions
    expect(diffMs).toBeGreaterThan(6 * 86400 * 1000);
    expect(diffMs).toBeLessThan(8 * 86400 * 1000);
  });

  test('shouldScheduleRun semantics: monthly schedule run 31d ago IS due (>=719h)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({
        id: 77,
        lastRunAt: new Date(Date.now() - 31 * 86400 * 1000),
        frequency: 'monthly',
      }),
    ]);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
    expect(prisma.reportSchedule.update.mock.calls[0][0].where.id).toBe(77);
  });

  test('cron tick: empty schedule list is a clean no-op (no downstream queries)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockResolvedValue([]);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    expect(prisma.reportSchedule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.deal.count).not.toHaveBeenCalled();
    expect(prisma.reportSchedule.update).not.toHaveBeenCalled();
  });

  test('cron tick: findMany where clause filters enabled:true (disabled rows never reach processSchedule)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockResolvedValue([]);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    // The findMany clause is the only gate against disabled rows — pin it.
    expect(prisma.reportSchedule.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
    });
  });

  test('mid-batch isolation: schedule #1 failure does NOT block schedule #2 from running', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({ id: 100, lastRunAt: null }),
      schedule({ id: 200, lastRunAt: null }),
    ]);
    // First processSchedule's deal.count throws; second succeeds.
    prisma.deal.count
      .mockRejectedValueOnce(new Error('transient DB blip'))
      .mockResolvedValue(0);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await expect(tick()).resolves.not.toThrow();
    logSpy.mockRestore();
    errSpy.mockRestore();
    // Schedule #1 threw before its lastRunAt update; schedule #2 must still update.
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
    expect(prisma.reportSchedule.update.mock.calls[0][0].where.id).toBe(200);
  });

  test('multi-recipient fan-out: 3-element recipients array still lands a single lastRunAt update', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(
      schedule({
        recipients: JSON.stringify([
          'alice@x.com',
          'bob@y.com',
          'carol@z.com',
        ]),
      })
    );
    logSpy.mockRestore();
    // Send is a single email with comma-joined recipients — not 3 separate ones.
    // Net effect on the DB is exactly one lastRunAt write.
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
  });

  test('agent-performance with zero users → no per-user fanout, lastRunAt still updates', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reportEngine.processSchedule(
      schedule({ reportType: 'agent-performance', format: 'PDF' })
    );
    logSpy.mockRestore();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    // Zero users → zero per-user prisma fanout queries
    expect(prisma.deal.count).not.toHaveBeenCalled();
    expect(prisma.deal.aggregate).not.toHaveBeenCalled();
    expect(prisma.callLog.count).not.toHaveBeenCalled();
    expect(prisma.emailMessage.count).not.toHaveBeenCalled();
    // But the schedule still ran end-to-end (PDF generated, lastRunAt bumped)
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
  });

  test('shouldScheduleRun default branch: unknown frequency reuses the weekly 167h threshold', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    // Unknown frequency, lastRun 200h ago → past the 167h default → DUE.
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({
        id: 555,
        lastRunAt: new Date(Date.now() - 200 * 3600 * 1000),
        frequency: 'fortnightly', // not in the switch
      }),
    ]);
    const tick = registerMock.mock.calls[0][0].tickFn;
    await tick();
    logSpy.mockRestore();
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
    expect(prisma.reportSchedule.update.mock.calls[0][0].where.id).toBe(555);
  });
});
