/**
 * cronRegistry.js — Super Admin Portal / Cron Maintenance.
 *
 * Central owner of every real node-cron ScheduledTask in the process. The
 * 46 existing cron/*.js engines stop calling node-cron's cron.schedule()
 * themselves; instead each engine's init function calls
 * register({name, tickFn, defaultSchedule, ...}) once at boot. This module
 * is the ONLY place that ever calls node-cron's schedule/stop/destroy, so
 * it's the single seam the Super Admin UI's Enable/Disable and
 * Edit-Schedule actions need to hook into.
 *
 * Self-healing by design: on first registration for a given engine name,
 * if no CronConfig row exists yet, one is upserted using the engine's own
 * hardcoded defaultSchedule + enabled=true. This means:
 *   - A totally fresh DB (first boot ever) behaves EXACTLY like the old
 *     hardcoded cron.schedule() calls — same schedule, always enabled.
 *   - Adding a 47th engine later needs zero manual DB setup; it just
 *     shows up in the Super Admin table on next boot.
 *   - An admin's edits (schedule/enabled) in CronConfig are authoritative
 *     from then on; register() never overwrites an EXISTING row.
 *
 * Every tick (whether fired by node-cron on schedule or by the manual
 * "Run now" trigger) is wrapped so a CronExecutionLog row is written with
 * start/finish/duration/status/error — this is what powers the Cron Logs
 * screen's pass/fail history and rate.
 *
 * Live reschedule: applyConfig(name) tears down the current node-cron task
 * (if any) and recreates it from the CURRENT CronConfig row — called right
 * after any admin edit, so changes take effect immediately, no restart.
 *
 * CJS self-mocking seam (CLAUDE.md standing pattern): inter-function calls
 * go through module.exports.fn(...) so vitest vi.spyOn interception works,
 * and the real `node-cron` module is reached only via the exported `_cron`
 * reference (never a bare local closure over `require('node-cron')`) so
 * tests can vi.spyOn(module.exports._cron, 'schedule'/'validate') instead
 * of fighting vitest's ESM-import-only vi.mock() hoisting against a
 * top-level CJS require — the same constraint documented in
 * test/services/flyer-render-engine.test.js for `require('puppeteer')`.
 */

'use strict';

const _cron = require('node-cron');
const prisma = require('./prisma');
const { buildDynamicTickFn } = require('./cronDynamicHandlers');

// name -> { task, defaultSchedule, tickFn, options, running }
// `task` is null when the engine is currently disabled (no live node-cron
// ScheduledTask exists for it).
const registry = new Map();

function isValidExpression(expr) {
  try {
    return module.exports._cron.validate(String(expr || ''));
  } catch {
    return false;
  }
}

/**
 * Register a cron engine. Called once per engine, from that engine's own
 * init*Cron() function, in place of the engine's former direct
 * cron.schedule(...) call.
 *
 * @param {Object} opts
 * @param {string}   opts.name             Stable machine key, e.g. "leadScoringEngine". Must be unique.
 * @param {string}   opts.defaultSchedule  Cron expression this engine shipped with historically — the fallback
 *                                         used when no CronConfig row exists yet (fresh DB) or the row's
 *                                         schedule is somehow invalid.
 * @param {Function} opts.tickFn           The engine's existing tick callback — called with NO arguments,
 *                                         exactly as node-cron would have called it. May return a Promise.
 * @param {string}   [opts.description]    Human-readable description shown in the Super Admin table.
 * @param {Object}   [opts.cronOptions]    Extra node-cron schedule options (e.g. { timezone: 'Asia/Kolkata' }).
 * @param {boolean}  [opts.runImmediately] If true, calls tickFn once synchronously-fired (fire-and-forget)
 *                                         right after registration — mirrors engines that historically ran
 *                                         an immediate first tick at boot (e.g. leadScoringEngine).
 * @param {boolean}  [opts.defaultEnabled] Enabled state used ONLY on first-ever registration (fresh
 *                                         CronConfig row). Default true — matches every engine's historical
 *                                         always-on behavior. An engine that's currently disconnected from
 *                                         production traffic (e.g. no tenant has an active config for it
 *                                         yet) can register with defaultEnabled:false so it's VISIBLE in the
 *                                         Super Admin table for future one-click enable, without actually
 *                                         running until an admin flips it on.
 */
async function register({
  name,
  defaultSchedule,
  tickFn,
  description = null,
  cronOptions = {},
  runImmediately = false,
  defaultEnabled = true,
}) {
  if (!name || typeof name !== 'string') {
    throw new Error('cronRegistry.register: name is required');
  }
  if (typeof tickFn !== 'function') {
    throw new Error(`cronRegistry.register(${name}): tickFn must be a function`);
  }
  if (!module.exports.isValidExpression(defaultSchedule)) {
    throw new Error(`cronRegistry.register(${name}): defaultSchedule "${defaultSchedule}" is not a valid cron expression`);
  }

  // Self-healing upsert — NEVER overwrites an existing row's schedule/enabled
  // (those are admin-owned once created). Only creates the row if it's truly
  // the engine's first-ever boot against this DB.
  try {
    await prisma.cronConfig.upsert({
      where: { name },
      update: description != null ? { description } : {},
      create: {
        name,
        description,
        schedule: defaultSchedule,
        enabled: defaultEnabled,
        isSystem: true,
        createdBy: 'system',
      },
    });
  } catch (e) {
    console.error(`[cronRegistry] ${name}: failed to upsert CronConfig row (non-fatal, using in-memory default): ${e.message}`);
  }

  registry.set(name, {
    task: null,
    defaultSchedule,
    tickFn,
    cronOptions,
    running: false,
  });

  await module.exports.applyConfig(name);

  if (runImmediately) {
    module.exports.runTick(name, 'startup').catch((e) =>
      console.error(`[cronRegistry] ${name}: immediate startup tick failed: ${e.message}`));
  }

  return { name };
}

/**
 * (Re)apply the CURRENT CronConfig row for `name` to the live node-cron
 * task: stop/destroy whatever's running, then — if enabled — create a
 * fresh task on the configured schedule. Called by register() at boot and
 * by the Super Admin routes right after any Create/Update/Enable/Disable
 * edit, so changes are live immediately.
 */
async function applyConfig(name) {
  const entry = registry.get(name);
  if (!entry) return { ok: false, reason: 'not-registered' };

  // Tear down whatever's currently scheduled.
  if (entry.task) {
    try {
      entry.task.stop();
      entry.task.destroy();
    } catch (e) {
      console.warn(`[cronRegistry] ${name}: error stopping previous task (non-fatal): ${e.message}`);
    }
    entry.task = null;
  }

  let config = null;
  try {
    config = await prisma.cronConfig.findUnique({ where: { name } });
  } catch (e) {
    console.error(`[cronRegistry] ${name}: failed to read CronConfig (falling back to default schedule, enabled): ${e.message}`);
  }

  const enabled = config ? config.enabled : true;
  const scheduleExpr = config && module.exports.isValidExpression(config.schedule) ? config.schedule : entry.defaultSchedule;

  if (!enabled) {
    console.log(`[cronRegistry] ${name}: disabled — no task scheduled`);
    return { ok: true, enabled: false };
  }

  entry.task = module.exports._cron.schedule(
    scheduleExpr,
    () => {
      module.exports.runTick(name, 'scheduled').catch((e) =>
        console.error(`[cronRegistry] ${name}: tick error escaped runTick (this should not happen): ${e.message}`));
    },
    entry.cronOptions,
  );

  console.log(`[cronRegistry] ${name}: scheduled "${scheduleExpr}"${config ? '' : ' (default — no CronConfig row yet)'}`);
  return { ok: true, enabled: true, schedule: scheduleExpr };
}

/**
 * Execute one tick for `name` NOW, regardless of schedule — used by both
 * the real node-cron firing (triggerType: "scheduled") and the Super
 * Admin "Run now" manual-trigger button (triggerType: "manual"). Always
 * writes a CronExecutionLog row bracketing the run, so the Cron Logs
 * screen has a complete pass/fail history no matter how the tick fired.
 *
 * Guards against overlapping runs of the SAME engine (a slow tick + a
 * manual trigger firing concurrently) by skipping (not queuing) — matches
 * the historical behavior of the underlying engines, none of which were
 * reentrant-safe.
 */
async function runTick(name, triggerType = 'scheduled') {
  const entry = registry.get(name);
  if (!entry) throw new Error(`cronRegistry.runTick: "${name}" is not registered`);
  if (entry.running) {
    console.warn(`[cronRegistry] ${name}: tick already in progress — skipping this ${triggerType} trigger`);
    return { skipped: true, reason: 'already-running' };
  }

  entry.running = true;
  const startedAt = new Date();
  let logId = null;
  try {
    const config = await prisma.cronConfig.findUnique({ where: { name }, select: { id: true } });
    if (config) {
      const row = await prisma.cronExecutionLog.create({
        data: {
          cronConfigId: config.id,
          cronName: name,
          startedAt,
          status: 'running',
          triggerType,
          instance: process.env.HOSTNAME || process.env.COMPUTERNAME || null,
        },
      });
      logId = row.id;
    }
  } catch (e) {
    console.warn(`[cronRegistry] ${name}: failed to write start log (non-fatal): ${e.message}`);
  }

  let status = 'success';
  let errorMessage = null;
  try {
    await entry.tickFn();
  } catch (e) {
    status = 'failed';
    errorMessage = String(e && e.message || e).slice(0, 4000);
    console.error(`[cronRegistry] ${name}: tick threw: ${errorMessage}`);
  } finally {
    entry.running = false;
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  if (logId != null) {
    try {
      await prisma.cronExecutionLog.update({
        where: { id: logId },
        data: { finishedAt, durationMs, status, errorMessage },
      });
    } catch (e) {
      console.warn(`[cronRegistry] ${name}: failed to write finish log (non-fatal): ${e.message}`);
    }
  }

  return { status, durationMs, errorMessage };
}

/** List every registered engine's live in-memory state (for the API layer). */
function listRegistered() {
  return Array.from(registry.entries()).map(([name, entry]) => ({
    name,
    defaultSchedule: entry.defaultSchedule,
    running: entry.running,
    scheduled: !!entry.task,
  }));
}

function isRegistered(name) {
  return registry.has(name);
}

/**
 * Fully remove a cron from the live registry — stops/destroys its node-cron
 * task (if any) and drops it from the in-memory Map. Used when an admin
 * deletes a DYNAMIC (isSystem:false) cron; system engines are never
 * unregistered (they're recreated on the next boot from their init*Cron()
 * call regardless), so this is only meaningful for admin-created crons.
 * Does NOT touch the CronConfig DB row — the caller deletes that separately.
 */
function unregister(name) {
  const entry = registry.get(name);
  if (!entry) return { ok: false, reason: "not-registered" };
  if (entry.task) {
    try { entry.task.stop(); entry.task.destroy(); } catch { /* best-effort */ }
  }
  registry.delete(name);
  return { ok: true };
}

/** Test/shutdown helper — stop every live task without clearing the registry map. */
function stopAll() {
  for (const [, entry] of registry) {
    if (entry.task) {
      try { entry.task.stop(); entry.task.destroy(); } catch { /* best-effort */ }
      entry.task = null;
    }
  }
}

/** Test-only — fully reset registry state between test files. */
function _resetForTests() {
  stopAll();
  registry.clear();
}

/**
 * Load all admin-created dynamic crons (CronConfig rows with isSystem:false)
 * from the DB and register them in the live registry. Called once at boot
 * after every system engine has registered itself, so dynamic crons survive
 * server restarts without requiring an admin to re-save them.
 *
 * Disabled dynamic crons are still registered (so they appear in the Super
 * Admin table and can be enabled on demand), but applyConfig() will not
 * create a live node-cron task for them.
 */
async function loadDynamicCrons() {
  try {
    const dynamicCrons = await prisma.cronConfig.findMany({ where: { isSystem: false } });
    for (const config of dynamicCrons) {
      try {
        const tickFn = buildDynamicTickFn(config.handlerKey, config.metadataJson);
        await register({
          name: config.name,
          description: config.description,
          defaultSchedule: config.schedule,
          defaultEnabled: config.enabled,
          tickFn,
        });
        console.log(`[cronRegistry] loaded dynamic cron "${config.name}" (enabled=${config.enabled}, schedule="${config.schedule}")`);
      } catch (e) {
        console.error(`[cronRegistry] failed to load dynamic cron "${config.name}": ${e.message}`);
      }
    }
    return { loaded: dynamicCrons.length };
  } catch (e) {
    console.error('[cronRegistry] failed to load dynamic crons:', e.message);
    return { loaded: 0, error: e.message };
  }
}

module.exports = {
  register,
  applyConfig,
  runTick,
  loadDynamicCrons,
  listRegistered,
  isRegistered,
  unregister,
  isValidExpression,
  stopAll,
  _resetForTests,
  _cron,
};
