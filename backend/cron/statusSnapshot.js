/**
 * Status Snapshot Engine (PRD_STATUS_PAGE.md).
 *
 * Registers two cron behaviors:
 *   1. Every 5 minutes: probe all status components and update their live
 *      status in StatusComponent.
 *   2. Daily at 00:05 UTC: write a StatusDailySnapshot row per component for
 *      the previous day.
 */

const cronRegistry = require("../lib/cronRegistry");
const {
  runStatusProbes,
  writeDailySnapshots,
  seedStatusComponents,
  hideLegacyPublicComponents,
} = require("../lib/statusProbe");

async function tickStatusProbe() {
  try {
    const report = await runStatusProbes();
    const changed = report.results.filter((r) => r.status !== r.previousStatus);
    console.log(
      `[statusProbe] probed ${report.results.length} component(s) in ${report.durationMs}ms; ` +
        `${changed.length} status change(s)` +
        (changed.length
          ? ": " +
            changed
              .map((c) => `${c.name}=${c.status}`)
              .join(", ")
          : ""),
    );
    return report;
  } catch (err) {
    console.error("[statusProbe] tick failed (non-fatal):", err.message);
    return { ok: false, error: err.message };
  }
}

async function tickDailySnapshot() {
  try {
    const report = await writeDailySnapshots();
    console.log(`[statusSnapshot] wrote ${report.count} snapshot(s) for ${report.date}`);
    return report;
  } catch (err) {
    console.error("[statusSnapshot] daily snapshot failed (non-fatal):", err.message);
    return { ok: false, error: err.message };
  }
}

function initStatusSnapshotCron() {
  // Ensure the default component catalog exists once per boot. After this,
  // operators own the rows (isPublic, sortOrder, probeUrl, etc.).
  seedStatusComponents()
    .then(() => hideLegacyPublicComponents())
    .catch((e) =>
      console.error("[statusProbe] seed/hide legacy components failed (non-fatal):", e.message),
    );

  // Live component probe every 5 minutes.
  cronRegistry
    .register({
      name: "statusProbeEngine",
      description:
        "Status-page health probe — checks CRM API, Travel API, DB, WebSocket, WhatsApp every 5 min",
      defaultSchedule: "*/5 * * * *",
      tickFn: tickStatusProbe,
    })
    .catch((e) =>
      console.error("[statusProbeEngine] cronRegistry registration failed:", e.message),
    );

  // Daily snapshot at 00:05 UTC.
  cronRegistry
    .register({
      name: "statusSnapshotEngine",
      description:
        "Status-page daily uptime snapshot — writes one row per component for the previous day",
      defaultSchedule: "5 0 * * *",
      tickFn: tickDailySnapshot,
    })
    .catch((e) =>
      console.error("[statusSnapshotEngine] cronRegistry registration failed:", e.message),
    );

  // Run one probe shortly after boot so fresh deploys populate immediately.
  setTimeout(() => {
    cronRegistry
      .runTick("statusProbeEngine", "startup")
      .catch((err) => console.error("[statusProbeEngine] initial tick error:", err));
  }, 20_000);
}

module.exports = {
  initStatusSnapshotCron,
  tickStatusProbe,
  tickDailySnapshot,
};
