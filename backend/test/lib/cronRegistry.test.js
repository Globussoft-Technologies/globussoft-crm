/**
 * Unit tests for backend/lib/cronRegistry.js — Super Admin Portal / Cron
 * Maintenance central scheduler.
 *
 * MOCK STRATEGY: two dependencies to fake — prisma (model methods
 * monkey-patched on the shared singleton, same pattern as
 * test/lib/eventBus.test.js) and node-cron (the SUT's real `require('node-
 * cron')` is reached ONLY via the exported `_cron` reference — see the
 * "CJS self-mocking seam" note atop cronRegistry.js — so we
 * vi.spyOn(cronRegistry._cron, 'schedule'/'validate') instead of
 * vi.mock('node-cron', ...), which cannot intercept a top-level CJS
 * require (same constraint documented in
 * test/services/flyer-render-engine.test.js for `require('puppeteer')`).
 *
 * Coverage:
 *   - register(): validates inputs, upserts CronConfig only on first-ever
 *     registration (never overwrites an existing row's schedule/enabled),
 *     creates a live node-cron task by default.
 *   - applyConfig(): disabled row -> no task scheduled; re-enabling
 *     recreates one; schedule edits tear down + recreate with the new
 *     expression; invalid DB schedule falls back to defaultSchedule.
 *   - runTick(): writes a CronExecutionLog start+finish row bracketing
 *     the call; success vs thrown-error status; overlap guard (a tick
 *     already running skips a concurrent trigger rather than queuing);
 *     manual vs scheduled triggerType is recorded verbatim.
 *   - listRegistered() / isRegistered() introspection.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Patch the prisma singleton BEFORE the SUT (lazily) uses it.
prisma.cronConfig = {
  ...(prisma.cronConfig || {}),
  upsert: vi.fn(),
  findUnique: vi.fn(),
};
prisma.cronExecutionLog = {
  ...(prisma.cronExecutionLog || {}),
  create: vi.fn(),
  update: vi.fn(),
};

const cronRegistry = requireCJS('../../lib/cronRegistry');

// Fake node-cron ScheduledTask — records stop/destroy calls so tests can
// assert the registry actually tears down + recreates tasks.
const scheduledTasks = [];
function makeFakeTask() {
  return { stop: vi.fn(), destroy: vi.fn(), getStatus: vi.fn(() => 'scheduled') };
}

beforeEach(() => {
  scheduledTasks.length = 0;
  prisma.cronConfig.upsert.mockReset().mockResolvedValue({ id: 1, name: 'test' });
  prisma.cronConfig.findUnique.mockReset().mockResolvedValue(null);
  prisma.cronExecutionLog.create.mockReset().mockResolvedValue({ id: 101 });
  prisma.cronExecutionLog.update.mockReset().mockResolvedValue({ id: 101 });
  cronRegistry._resetForTests();

  // vi.restoreAllMocks() (via vitest.config's default restoreMocks, if set)
  // may or may not run between files — reset explicitly by re-assigning the
  // spy's implementation + call history every test rather than re-spying
  // (spying on an already-spied method twice with vi.spyOn returns the SAME
  // spy without clearing its recorded calls).
  if (cronRegistry._cron.schedule.mock) {
    cronRegistry._cron.schedule.mockClear();
    cronRegistry._cron.validate.mockClear();
  } else {
    vi.spyOn(cronRegistry._cron, 'schedule');
    vi.spyOn(cronRegistry._cron, 'validate');
  }
  cronRegistry._cron.schedule.mockImplementation((expr, fn, opts) => {
    const task = makeFakeTask();
    scheduledTasks.push({ expr, fn, opts, task });
    return task;
  });
  // Minimal real-ish validation: 5 space-separated fields, or the
  // explicit sentinel used by "invalid expression" test cases.
  cronRegistry._cron.validate.mockImplementation((expr) => {
    if (expr === 'not-a-cron-expr' || expr === 'garbage') return false;
    const parts = String(expr || '').trim().split(/\s+/);
    return parts.length === 5;
  });
});

describe('register()', () => {
  test('rejects missing name / non-function tickFn / invalid defaultSchedule', async () => {
    await expect(cronRegistry.register({ name: '', tickFn: () => {}, defaultSchedule: '* * * * *' }))
      .rejects.toThrow(/name is required/);
    await expect(cronRegistry.register({ name: 'x', tickFn: null, defaultSchedule: '* * * * *' }))
      .rejects.toThrow(/tickFn must be a function/);
    await expect(cronRegistry.register({ name: 'x', tickFn: () => {}, defaultSchedule: 'not-a-cron-expr' }))
      .rejects.toThrow(/not a valid cron expression/);
  });

  test('first-ever registration upserts a CronConfig row with the engine default + isSystem:true', async () => {
    await cronRegistry.register({
      name: 'quoteExpirySweep',
      defaultSchedule: '0 9 * * *',
      tickFn: vi.fn(),
      description: 'Daily quote expiry sweep',
    });
    expect(prisma.cronConfig.upsert).toHaveBeenCalledWith({
      where: { name: 'quoteExpirySweep' },
      update: { description: 'Daily quote expiry sweep' },
      create: {
        name: 'quoteExpirySweep',
        description: 'Daily quote expiry sweep',
        schedule: '0 9 * * *',
        enabled: true,
        isSystem: true,
        createdBy: 'system',
      },
    });
  });

  test('registration with no existing CronConfig row schedules using defaultSchedule', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    await cronRegistry.register({ name: 'engineA', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    expect(cronRegistry._cron.schedule).toHaveBeenCalledTimes(1);
    expect(cronRegistry._cron.schedule.mock.calls[0][0]).toBe('*/5 * * * *');
  });

  test('registration with an existing ENABLED CronConfig row uses the DB schedule, not the default', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 5, name: 'engineB', schedule: '0 */2 * * *', enabled: true });
    await cronRegistry.register({ name: 'engineB', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    expect(cronRegistry._cron.schedule.mock.calls[0][0]).toBe('0 */2 * * *');
  });

  test('registration with an existing DISABLED CronConfig row schedules NOTHING', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 6, name: 'engineC', schedule: '*/5 * * * *', enabled: false });
    await cronRegistry.register({ name: 'engineC', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    expect(cronRegistry._cron.schedule).not.toHaveBeenCalled();
  });

  test('an invalid schedule stored in the DB row falls back to defaultSchedule rather than crashing', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 7, name: 'engineD', schedule: 'garbage', enabled: true });
    await cronRegistry.register({ name: 'engineD', defaultSchedule: '0 0 * * *', tickFn: vi.fn() });
    expect(cronRegistry._cron.schedule.mock.calls[0][0]).toBe('0 0 * * *');
  });

  test('runImmediately fires one tick right after registration (fire-and-forget)', async () => {
    const tickFn = vi.fn().mockResolvedValue();
    await cronRegistry.register({ name: 'engineE', defaultSchedule: '*/10 * * * *', tickFn, runImmediately: true });
    // runTick is fire-and-forget (not awaited by register) — flush microtasks.
    await new Promise((r) => setTimeout(r, 10));
    expect(tickFn).toHaveBeenCalledTimes(1);
  });

  test('a CronConfig upsert failure is non-fatal — registration + scheduling still proceeds', async () => {
    prisma.cronConfig.upsert.mockRejectedValue(new Error('DB down'));
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    await expect(cronRegistry.register({ name: 'engineF', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() }))
      .resolves.toMatchObject({ name: 'engineF' });
    expect(cronRegistry._cron.schedule).toHaveBeenCalledTimes(1);
  });

  test('defaultEnabled:false seeds a disabled row on first-ever registration (visible in the UI, not running)', async () => {
    // Simulates real DB read-your-own-write continuity: register()'s upsert
    // persists enabled:false, and applyConfig()'s own findUnique (a separate
    // round-trip) sees that same row — unlike a real DB, this mock has no
    // memory of the upsert, so we model the post-upsert row explicitly.
    prisma.cronConfig.findUnique.mockResolvedValue({
      id: 40, name: 'marketplaceEngine', schedule: '*/5 * * * *', enabled: false,
    });
    await cronRegistry.register({
      name: 'marketplaceEngine',
      defaultSchedule: '*/5 * * * *',
      tickFn: vi.fn(),
      defaultEnabled: false,
    });
    expect(prisma.cronConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ enabled: false }) }),
    );
    expect(cronRegistry._cron.schedule).not.toHaveBeenCalled();
  });

  test('defaultEnabled defaults to true when omitted (matches every engine historical always-on behavior)', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    await cronRegistry.register({ name: 'engineQ', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    expect(prisma.cronConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ enabled: true }) }),
    );
  });
});

describe('applyConfig() — live reschedule', () => {
  test('stops + destroys the previous task before creating a new one', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 8, name: 'engineG', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.register({ name: 'engineG', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    const firstTask = scheduledTasks[0].task;

    prisma.cronConfig.findUnique.mockResolvedValue({ id: 8, name: 'engineG', schedule: '0 */3 * * *', enabled: true });
    await cronRegistry.applyConfig('engineG');

    expect(firstTask.stop).toHaveBeenCalledTimes(1);
    expect(firstTask.destroy).toHaveBeenCalledTimes(1);
    expect(scheduledTasks).toHaveLength(2);
    expect(scheduledTasks[1].expr).toBe('0 */3 * * *');
  });

  test('disabling via applyConfig stops the task and schedules nothing new', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 9, name: 'engineH', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.register({ name: 'engineH', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    const firstTask = scheduledTasks[0].task;

    prisma.cronConfig.findUnique.mockResolvedValue({ id: 9, name: 'engineH', schedule: '*/5 * * * *', enabled: false });
    const result = await cronRegistry.applyConfig('engineH');

    expect(firstTask.stop).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, enabled: false });
    expect(scheduledTasks).toHaveLength(1); // no NEW task created
  });

  test('re-enabling a previously-disabled engine creates a fresh task', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 10, name: 'engineI', schedule: '*/5 * * * *', enabled: false });
    await cronRegistry.register({ name: 'engineI', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    expect(scheduledTasks).toHaveLength(0);

    prisma.cronConfig.findUnique.mockResolvedValue({ id: 10, name: 'engineI', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.applyConfig('engineI');
    expect(scheduledTasks).toHaveLength(1);
  });

  test('applyConfig on an unregistered name is a safe no-op', async () => {
    const result = await cronRegistry.applyConfig('does-not-exist');
    expect(result).toEqual({ ok: false, reason: 'not-registered' });
  });

  test('a CronConfig read failure during applyConfig falls back to enabled+default rather than throwing', async () => {
    prisma.cronConfig.findUnique.mockResolvedValueOnce({ id: 11, name: 'engineJ', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.register({ name: 'engineJ', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });

    prisma.cronConfig.findUnique.mockRejectedValueOnce(new Error('DB blip'));
    await expect(cronRegistry.applyConfig('engineJ')).resolves.toMatchObject({ ok: true, enabled: true });
  });
});

describe('unregister()', () => {
  test('stops + destroys the live task and removes the engine from the registry', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 50, name: 'dynCronA', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.register({ name: 'dynCronA', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    const task = scheduledTasks[0].task;

    const result = cronRegistry.unregister('dynCronA');

    expect(result).toEqual({ ok: true });
    expect(task.stop).toHaveBeenCalledTimes(1);
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(cronRegistry.isRegistered('dynCronA')).toBe(false);
  });

  test('unregistering a disabled (never-scheduled) engine is a safe no-op on the task side', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 51, name: 'dynCronB', schedule: '*/5 * * * *', enabled: false });
    await cronRegistry.register({ name: 'dynCronB', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });

    const result = cronRegistry.unregister('dynCronB');
    expect(result).toEqual({ ok: true });
    expect(cronRegistry.isRegistered('dynCronB')).toBe(false);
  });

  test('unregistering an unknown name returns not-registered', () => {
    expect(cronRegistry.unregister('never-existed')).toEqual({ ok: false, reason: 'not-registered' });
  });

  test('a subsequent runTick against an unregistered name throws (matches pre-unregister behavior)', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 52, name: 'dynCronC', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.register({ name: 'dynCronC', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    cronRegistry.unregister('dynCronC');
    await expect(cronRegistry.runTick('dynCronC')).rejects.toThrow(/not registered/);
  });
});

describe('runTick()', () => {
  test('writes a CronExecutionLog start row then a finish row with status=success', async () => {
    const tickFn = vi.fn().mockResolvedValue();
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 20, name: 'engineK' });
    await cronRegistry.register({ name: 'engineK', defaultSchedule: '*/5 * * * *', tickFn });

    const result = await cronRegistry.runTick('engineK', 'manual');

    expect(prisma.cronExecutionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cronName: 'engineK', status: 'running', triggerType: 'manual' }),
      }),
    );
    expect(prisma.cronExecutionLog.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: expect.objectContaining({ status: 'success', errorMessage: null }),
    });
    expect(result.status).toBe('success');
    expect(tickFn).toHaveBeenCalledTimes(1);
  });

  test('a thrown tickFn error is caught, logged as failed with the error message, and does not propagate', async () => {
    const tickFn = vi.fn().mockRejectedValue(new Error('boom'));
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 21, name: 'engineL' });
    await cronRegistry.register({ name: 'engineL', defaultSchedule: '*/5 * * * *', tickFn });

    const result = await cronRegistry.runTick('engineL', 'scheduled');

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/boom/);
    expect(prisma.cronExecutionLog.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('boom') }),
    });
  });

  test('overlapping runs of the SAME engine are skipped, not queued', async () => {
    let resolveTick;
    const tickFn = vi.fn(() => new Promise((r) => { resolveTick = r; }));
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 22, name: 'engineM', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.register({ name: 'engineM', defaultSchedule: '*/5 * * * *', tickFn });

    const firstRun = cronRegistry.runTick('engineM', 'scheduled');
    // Let firstRun's pre-tickFn awaits (CronConfig lookup + log create) flush
    // before firing the concurrent trigger, so entry.running is definitely
    // true and tickFn has definitely been invoked (it's what's holding the
    // promise open) by the time we assert below.
    await new Promise((r) => setTimeout(r, 0));
    const secondRun = await cronRegistry.runTick('engineM', 'manual'); // fires while first is mid-flight
    expect(secondRun).toEqual({ skipped: true, reason: 'already-running' });
    expect(tickFn).toHaveBeenCalledTimes(1);

    resolveTick();
    await firstRun;
  });

  test('runTick on an unregistered name throws synchronously (caller/route bug, not a soft-fail case)', async () => {
    await expect(cronRegistry.runTick('nope')).rejects.toThrow(/not registered/);
  });

  test('a missing CronConfig row (race with delete) still runs the tick, just skips logging', async () => {
    const tickFn = vi.fn().mockResolvedValue();
    prisma.cronConfig.findUnique.mockResolvedValueOnce({ id: 23, name: 'engineN' }); // for register()
    await cronRegistry.register({ name: 'engineN', defaultSchedule: '*/5 * * * *', tickFn });

    prisma.cronConfig.findUnique.mockResolvedValueOnce(null); // for runTick's own lookup
    const result = await cronRegistry.runTick('engineN', 'scheduled');
    expect(result.status).toBe('success');
    expect(prisma.cronExecutionLog.create).not.toHaveBeenCalled();
  });
});

describe('introspection', () => {
  test('listRegistered reflects registered engines with live scheduled/running flags', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 30, name: 'engineO', schedule: '*/5 * * * *', enabled: true });
    await cronRegistry.register({ name: 'engineO', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    const list = cronRegistry.listRegistered();
    expect(list).toContainEqual(expect.objectContaining({ name: 'engineO', scheduled: true, running: false }));
  });

  test('isRegistered is true only for engines that called register()', async () => {
    expect(cronRegistry.isRegistered('engineP')).toBe(false);
    await cronRegistry.register({ name: 'engineP', defaultSchedule: '*/5 * * * *', tickFn: vi.fn() });
    expect(cronRegistry.isRegistered('engineP')).toBe(true);
  });
});

describe('loadDynamicCrons()', () => {
  test('re-registers every isSystem:false CronConfig row from the DB at boot', async () => {
    const dynamicRows = [
      { id: 40, name: 'dynBootA', schedule: '*/5 * * * *', enabled: true, isSystem: false, handlerKey: 'log_note', metadataJson: '{"message":"a"}' },
      { id: 41, name: 'dynBootB', schedule: '0 */3 * * *', enabled: false, isSystem: false, handlerKey: 'log_note', metadataJson: null },
    ];
    prisma.cronConfig.findMany = vi.fn().mockResolvedValue(dynamicRows);
    prisma.cronConfig.findUnique.mockImplementation(({ where: { name } }) => {
      return Promise.resolve(dynamicRows.find((r) => r.name === name) || null);
    });

    const result = await cronRegistry.loadDynamicCrons();

    expect(result.loaded).toBe(2);
    expect(cronRegistry.isRegistered('dynBootA')).toBe(true);
    expect(cronRegistry.isRegistered('dynBootB')).toBe(true);
    // Enabled one got a live task; disabled one did not.
    const tasks = cronRegistry.listRegistered();
    expect(tasks.find((t) => t.name === 'dynBootA').scheduled).toBe(true);
    expect(tasks.find((t) => t.name === 'dynBootB').scheduled).toBe(false);
  });

  test('logs and skips individual dynamic crons that fail to build, continuing with the rest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dynamicRows = [
      { id: 42, name: 'dynBad', schedule: '*/5 * * * *', enabled: true, isSystem: false, handlerKey: 'unknown_handler', metadataJson: null },
      { id: 43, name: 'dynGood', schedule: '*/10 * * * *', enabled: true, isSystem: false, handlerKey: 'log_note', metadataJson: null },
    ];
    prisma.cronConfig.findMany = vi.fn().mockResolvedValue(dynamicRows);
    prisma.cronConfig.findUnique.mockImplementation(({ where: { name } }) => {
      return Promise.resolve(dynamicRows.find((r) => r.name === name) || null);
    });

    const result = await cronRegistry.loadDynamicCrons();

    expect(result.loaded).toBe(2);
    expect(cronRegistry.isRegistered('dynBad')).toBe(false);
    expect(cronRegistry.isRegistered('dynGood')).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dynBad'));
    errorSpy.mockRestore();
  });

  test('returns 0 loaded when the DB query itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.cronConfig.findMany = vi.fn().mockRejectedValue(new Error('DB down'));

    const result = await cronRegistry.loadDynamicCrons();

    expect(result.loaded).toBe(0);
    expect(result.error).toMatch(/DB down/);
    errorSpy.mockRestore();
  });
});

describe('isValidExpression()', () => {
  test('delegates to node-cron validate', () => {
    expect(cronRegistry.isValidExpression('*/5 * * * *')).toBe(true);
    expect(cronRegistry.isValidExpression('not-a-cron-expr')).toBe(false);
  });
});
