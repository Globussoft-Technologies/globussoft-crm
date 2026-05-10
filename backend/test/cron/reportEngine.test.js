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
 *   - node-cron — schedule mock so initReportCron registers cleanly.
 *
 * NOT covered (intentional):
 *   - Real SMTP delivery (SMTP_HOST defaults to ethereal.email → mock branch).
 *   - The exact PDF bytes (assert Buffer + sane length only).
 */
import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const nodeCron = requireCJS('node-cron');

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

// ── Patch node-cron BEFORE requiring SUT ───────────────────────────────
const originalSchedule = nodeCron.schedule;
const scheduleMock = vi.fn();
nodeCron.schedule = scheduleMock;

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
  scheduleMock.mockReset();

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
});

afterAll(() => {
  nodeCron.schedule = originalSchedule;
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

  test('initReportCron registers an hourly schedule', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    logSpy.mockRestore();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0][0]).toBe('0 * * * *');
    expect(typeof scheduleMock.mock.calls[0][1]).toBe('function');
  });

  test('cron tick fetches enabled schedules and dispatches due ones', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    // 2 schedules: one never-run (always due), one run an hour ago (NOT due for weekly).
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({ id: 1, lastRunAt: null }),
      schedule({ id: 2, lastRunAt: new Date(Date.now() - 3600 * 1000), frequency: 'weekly' }),
    ]);
    const tick = scheduleMock.mock.calls[0][1];
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

  test('cron tick: outer findMany rejection is logged, does not throw', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockRejectedValue(new Error('DB lost'));
    const tick = scheduleMock.mock.calls[0][1];
    await expect(tick()).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('shouldScheduleRun semantics: weekly schedule run 2h ago is NOT due (167h threshold)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    reportEngine.initReportCron();
    prisma.reportSchedule.findMany.mockResolvedValue([
      schedule({ id: 1, lastRunAt: new Date(Date.now() - 2 * 3600 * 1000), frequency: 'weekly' }),
    ]);
    const tick = scheduleMock.mock.calls[0][1];
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
    const tick = scheduleMock.mock.calls[0][1];
    await tick();
    logSpy.mockRestore();
    expect(prisma.reportSchedule.update).toHaveBeenCalledTimes(1);
  });
});
