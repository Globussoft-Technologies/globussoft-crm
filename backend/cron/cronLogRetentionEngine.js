/**
 * cronLogRetentionEngine.js — Super Admin Portal / Cron Maintenance.
 *
 * Deletes CronExecutionLog rows older than the configured retention window
 * (SystemSetting key "cron_log_retention_days", default 30 — same default
 * the Super Admin UI shows when no setting row exists yet, see
 * routes/super_admin_cron.js's GET /settings/log-retention).
 *
 * This is itself a registered cron engine (via cronRegistry, like the other
 * 46) — daily 03:15, off the :00/:03:00 cluster and 15 minutes after the
 * GDPR retention sweep so it doesn't contend with that sweep's DB load.
 */

'use strict';

const cronRegistry = require('../lib/cronRegistry');
const prisma = require('../lib/prisma');

const RETENTION_SETTING_KEY = 'cron_log_retention_days';
const DEFAULT_RETENTION_DAYS = 30;

async function runCronLogRetentionSweep() {
  const setting = await prisma.systemSetting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
  const retainDays = setting ? parseInt(setting.value, 10) : DEFAULT_RETENTION_DAYS;
  const days = Number.isFinite(retainDays) && retainDays > 0 ? retainDays : DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.cronExecutionLog.deleteMany({ where: { startedAt: { lt: cutoff } } });

  if (result.count > 0) {
    console.log(`[cronLogRetention] purged ${result.count} log row(s) older than ${days}d (cutoff ${cutoff.toISOString()})`);
  }
  return { deleted: result.count, retainDays: days, cutoff };
}

function initCronLogRetentionCron() {
  cronRegistry.register({
    name: 'cronLogRetentionEngine',
    description: 'Purges CronExecutionLog rows past the configured retention window (daily 03:15)',
    defaultSchedule: '15 3 * * *',
    tickFn: runCronLogRetentionSweep,
  }).catch((e) => console.error('[cronLogRetention] cronRegistry registration failed:', e.message));
}

module.exports = {
  runCronLogRetentionSweep,
  initCronLogRetentionCron,
  RETENTION_SETTING_KEY,
  DEFAULT_RETENTION_DAYS,
};
