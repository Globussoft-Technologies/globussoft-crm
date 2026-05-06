/**
 * Demo Hygiene Engine — periodic cleanup of QA / pen-test residue on the
 * shared demo at crm.globusdemos.com.
 *
 * #541 (OPS-1) reported leftover `_QA_PROBE_*` patient rows from prior QA
 * sweeps surfacing in the demo's /wellness/patients list — bad first
 * impression for prospects, polluted screenshots, broken dedupe testing.
 * Scrub script in `e2e/scripts/scrub-demo.js` already runs after the
 * release-validation `e2e-full.yml` workflow, but that's tag-driven —
 * doesn't catch QA work between releases.
 *
 * Hourly cron sweep that hard-deletes any of the following whose name /
 * marker prefix matches the QA convention (`_QA_PROBE_`, `E2E_FLOW_`,
 * `_E2E_`, `E2E_WC_`) AND whose createdAt is older than the safety window
 * (default 24h — long enough that an in-flight QA session isn't disrupted,
 * short enough that residue clears the same calendar day).
 *
 * Models swept:
 *   - Patient (the #541 specific complaint)
 *   - Pipeline / Currency / Territory / Chatbot (admin-config rows the
 *     pen-test created and self-deleted, but a future probe might leave
 *     residue if the cleanup is interrupted)
 *
 * Patient is the tricky one because of FK Restrict on Visit / Prescription
 * / ConsentForm / TreatmentPlan. We try the delete; if Prisma rejects with
 * P2003, we log + skip — leaving the row for manual operator cleanup
 * rather than cascading. A QA probe that left visits/Rx behind is
 * interesting and we want a human to look at it.
 *
 * Env vars:
 *   DEMO_HYGIENE_DISABLED        — set to truthy to skip cron init.
 *                                   Local dev / CI doesn't want this firing.
 *   DEMO_HYGIENE_AGE_HOURS       — optional; minimum row age before purge.
 *                                   Default 24.
 *
 * Exports:
 *   initDemoHygieneCron()  — wires hourly cron (called from server.js)
 *   runDemoHygiene(opts)   — async; returns counts per model. Used by the
 *                            cron tick + can be invoked by an ops route
 *                            for one-shot cleanup without waiting for
 *                            the next tick.
 */
const cron = require("node-cron");
const prisma = require("../lib/prisma");

const QA_NAME_PREFIXES = ["_QA_PROBE_", "E2E_FLOW_", "_E2E_", "E2E_WC_"];

function ageCutoff(hours) {
  const h = Number.isFinite(hours) ? hours : 24;
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

// Build a Prisma OR list for `name startsWith P` across the prefix set,
// + createdAt < cutoff. The schema-level @@index([tenantId, name]) on
// Patient (and equivalent on the others) means this is index-friendly.
function nameFilter(field, cutoff) {
  return {
    AND: [
      { [field]: { lt: cutoff } },
      { OR: QA_NAME_PREFIXES.map((p) => ({ name: { startsWith: p } })) },
    ],
  };
}

async function purgePatients(cutoff) {
  let deleted = 0;
  let skipped = 0;
  const candidates = await prisma.patient.findMany({
    where: nameFilter("createdAt", cutoff),
    select: { id: true, name: true, tenantId: true },
  });
  for (const p of candidates) {
    try {
      await prisma.patient.delete({ where: { id: p.id } });
      deleted += 1;
    } catch (err) {
      // P2003 = FK restrict (clinical children present). Don't cascade —
      // a probe that left Visits/Rx behind needs human eyeballs.
      skipped += 1;
      console.warn(
        `[demoHygiene] skip patient id=${p.id} name="${p.name}": ${err.code || err.message}`,
      );
    }
  }
  return { deleted, skipped, candidates: candidates.length };
}

async function purgeNamedModel(modelName, cutoff) {
  // Generic helper for the simple admin-config models (Pipeline, Currency,
  // Territory, Chatbot) — all of which carry a `name` String + createdAt.
  // No FK constraints worth special-casing on these (Pipeline.stages
  // cascade-delete, the others have no children).
  const delegate = prisma[modelName];
  if (!delegate) return { deleted: 0, candidates: 0 };
  let deleted = 0;
  const candidates = await delegate.findMany({
    where: nameFilter("createdAt", cutoff),
    select: { id: true },
  });
  for (const row of candidates) {
    try {
      await delegate.delete({ where: { id: row.id } });
      deleted += 1;
    } catch (err) {
      console.warn(
        `[demoHygiene] skip ${modelName} id=${row.id}: ${err.code || err.message}`,
      );
    }
  }
  return { deleted, candidates: candidates.length };
}

async function runDemoHygiene({ ageHours } = {}) {
  const cutoff = ageCutoff(
    ageHours ?? Number(process.env.DEMO_HYGIENE_AGE_HOURS),
  );
  const startedAt = Date.now();
  const summary = {
    cutoff: cutoff.toISOString(),
    patient: { deleted: 0, skipped: 0, candidates: 0 },
    pipeline: { deleted: 0, candidates: 0 },
    currency: { deleted: 0, candidates: 0 },
    territory: { deleted: 0, candidates: 0 },
    chatbot: { deleted: 0, candidates: 0 },
    durationMs: 0,
  };
  try {
    summary.patient = await purgePatients(cutoff);
    summary.pipeline = await purgeNamedModel("pipeline", cutoff);
    summary.currency = await purgeNamedModel("currency", cutoff);
    summary.territory = await purgeNamedModel("territory", cutoff);
    summary.chatbot = await purgeNamedModel("chatbot", cutoff);
  } catch (err) {
    console.error("[demoHygiene] tick failed:", err && err.message ? err.message : err);
    summary.error = String(err && err.message ? err.message : err).slice(0, 200);
  }
  summary.durationMs = Date.now() - startedAt;
  const totalDeleted =
    summary.patient.deleted +
    summary.pipeline.deleted +
    summary.currency.deleted +
    summary.territory.deleted +
    summary.chatbot.deleted;
  if (totalDeleted > 0) {
    console.log(
      `[demoHygiene] purged ${totalDeleted} QA-tagged rows (${summary.durationMs}ms): ${JSON.stringify(summary)}`,
    );
  }
  return summary;
}

function initDemoHygieneCron() {
  if (process.env.DEMO_HYGIENE_DISABLED) {
    console.log("[demoHygiene] DEMO_HYGIENE_DISABLED set — cron init skipped");
    return;
  }
  // Hourly at :17. Off-the-hour timing keeps it out of the default
  // top-of-hour cron storm (backup, retention, etc. all schedule on :00).
  cron.schedule("17 * * * *", () => {
    runDemoHygiene().catch((err) => {
      console.error("[demoHygiene] cron tick crashed:", err && err.message ? err.message : err);
    });
  });
  console.log("[demoHygiene] Cron scheduled: hourly at :17");
}

module.exports = {
  initDemoHygieneCron,
  runDemoHygiene,
  QA_NAME_PREFIXES,
};
