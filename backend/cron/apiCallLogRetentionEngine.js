/**
 * apiCallLogRetentionEngine.js — Super Admin Portal / API Analytics.
 *
 * Deletes LlmCallLog + ApiCallLog rows older than the configured retention
 * window (SystemSetting key "api_call_log_retention_days", default 30) —
 * same pattern as cron/cronLogRetentionEngine.js, applied to the API
 * Analytics tables instead of CronExecutionLog.
 *
 * Registered cron, daily 03:20 — 5 minutes after cronLogRetentionEngine
 * (03:15) so the two retention sweeps don't contend with each other.
 */

'use strict';

const cronRegistry = require('../lib/cronRegistry');
const prisma = require('../lib/prisma');

const RETENTION_SETTING_KEY = 'api_call_log_retention_days';
const DEFAULT_RETENTION_DAYS = 30;

async function runApiCallLogRetentionSweep() {
  const setting = await prisma.systemSetting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
  const retainDays = setting ? parseInt(setting.value, 10) : DEFAULT_RETENTION_DAYS;
  const days = Number.isFinite(retainDays) && retainDays > 0 ? retainDays : DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [llmResult, apiResult] = await Promise.all([
    prisma.llmCallLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.apiCallLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  const totalDeleted = llmResult.count + apiResult.count;
  if (totalDeleted > 0) {
    console.log(
      `[apiCallLogRetention] purged ${llmResult.count} LlmCallLog + ${apiResult.count} ApiCallLog row(s) older than ${days}d (cutoff ${cutoff.toISOString()})`,
    );
  }
  return { deletedLlmCallLog: llmResult.count, deletedApiCallLog: apiResult.count, retainDays: days, cutoff };
}

function initApiCallLogRetentionCron() {
  cronRegistry.register({
    name: 'apiCallLogRetentionEngine',
    description: 'Purges LlmCallLog + ApiCallLog rows past the configured retention window (daily 03:20)',
    defaultSchedule: '20 3 * * *',
    tickFn: runApiCallLogRetentionSweep,
  }).catch((e) => console.error('[apiCallLogRetention] cronRegistry registration failed:', e.message));
}

module.exports = {
  runApiCallLogRetentionSweep,
  initApiCallLogRetentionCron,
  RETENTION_SETTING_KEY,
  DEFAULT_RETENTION_DAYS,
};
