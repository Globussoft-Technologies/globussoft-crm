/**
 * Demo Hygiene Engine — periodic cleanup of QA / pen-test residue on the
 * shared demo at crm.globusdemos.com.
 *
 * #541 (OPS-1) reported leftover `_QA_PROBE_*` patient rows from prior QA
 * sweeps surfacing in the demo's /wellness/patients list — bad first
 * impression for prospects, polluted screenshots, broken dedupe testing.
 * Scrub script in `backend/scripts/scrub-test-data-pollution.js` already
 * runs after the release-validation `e2e-full.yml` workflow, but that's
 * tag-driven — doesn't catch QA work between releases.
 *
 * #578 [REG-01] (regression of #405 / #318 / #403 / #272 / #120) widened
 * the scope from 5 admin-config models to 12 surfaces because the
 * pen-test on 2026-05-07 found QA fixtures still leaking into 7
 * customer-facing screens:
 *
 *   1. /wellness/patients              → Patient (was already swept)
 *   2. /inbox                           → EmailMessage (subject)
 *   3. /wellness/recommendations        → AgentRecommendation (title)
 *   4. /sla                             → SlaPolicy (name)
 *   5. /tickets                         → Ticket (subject)
 *   6. /marketplace-leads               → MarketplaceLead (name OR email)
 *   7. /wellness/reports/attribution    → LandingPage (title + slug)
 *
 * Plus Task (title) — observed leaking via /workflows + /approvals
 * fan-out from orchestrator and sequence engines.
 *
 * Hourly cron sweep that hard-deletes any of the above whose searchable
 * field matches the QA convention (`_QA_PROBE_`, `E2E_FLOW_`, `_E2E_`,
 * `E2E_WC_`, `E2E_SLA_`, `e2e_audit_`, `e2e_flow_`) AND whose createdAt
 * is older than the safety window (default 24h — long enough that an
 * in-flight QA session isn't disrupted, short enough that residue
 * clears the same calendar day).
 *
 * Models swept (12 total):
 *   - Admin-config (5): Pipeline, Currency, Territory, Chatbot, SlaPolicy
 *   - Wellness (2):     Patient, AgentRecommendation
 *   - Customer-facing (5): Ticket, MarketplaceLead, LandingPage, Task,
 *     EmailMessage
 *
 * Field-by-field map (the searchable text field is NOT always `name`):
 *   - name:    Pipeline, Currency, Territory, Chatbot, SlaPolicy,
 *              Patient, MarketplaceLead, Location (future)
 *   - title:   Task, AgentRecommendation, LandingPage
 *   - subject: Ticket, EmailMessage
 *
 * Patient is still the tricky one because of FK Restrict on Visit /
 * Prescription / ConsentForm / TreatmentPlan. We try the delete; if
 * Prisma rejects with P2003, we log + skip — leaving the row for manual
 * operator cleanup rather than cascading. A QA probe that left
 * visits/Rx behind is interesting and we want a human to look at it.
 *
 * MarketplaceLead also gets an email-prefix sweep (e.g.
 * `e2e_audit_…@example.com`) because the issue's repro names email as
 * the primary signal for that surface (138 fixture leads on the demo
 * at the time of #578).
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

// Canonical QA / pen-test markers. Anchor at start-of-string only — these
// prefixes are deliberately ugly enough that no real customer name /
// title / subject would start with them.
//
// Lowercase variants (`e2e_audit_`, `e2e_flow_`) are intentional: the
// MarketplaceLead and LandingPage probes use snake_case lowercase
// timestamps (e.g. `e2e_audit_1778075246907@example.com`,
// `e2e_flow_lp_1778…`), distinct from the SCREAMING_CASE Patient /
// Pipeline / etc. probes.
const QA_NAME_PREFIXES = [
  "_QA_PROBE_",
  "E2E_FLOW_",
  "_E2E_",
  "E2E_WC_",
  "E2E_SLA_",
  "e2e_audit_",
  "e2e_flow_",
];

function ageCutoff(hours) {
  const h = Number.isFinite(hours) ? hours : 24;
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

// Build a Prisma OR list for `<textField> startsWith P` across the prefix
// set, + dateField < cutoff. The schema-level @@index([tenantId, name])
// (and equivalents) means this is index-friendly.
//
// `textField` defaults to `name` for backwards compat; pass `title` /
// `subject` for models whose searchable field has a different label.
function nameFilter(dateField, cutoff, textField = "name") {
  return {
    AND: [
      { [dateField]: { lt: cutoff } },
      {
        OR: QA_NAME_PREFIXES.map((p) => ({ [textField]: { startsWith: p } })),
      },
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

async function purgeNamedModel(modelName, cutoff, textField = "name") {
  // Generic helper for models keyed on a single searchable text field
  // (Pipeline, Currency, Territory, Chatbot, SlaPolicy on `name`;
  // Task / AgentRecommendation / LandingPage on `title`; Ticket /
  // EmailMessage on `subject`). Models with FK restrict that might block
  // the delete (e.g. unexpected children) get logged + skipped — same
  // shape as Patient — rather than crashing the whole tick.
  const delegate = prisma[modelName];
  if (!delegate) return { deleted: 0, skipped: 0, candidates: 0 };
  let deleted = 0;
  let skipped = 0;
  const candidates = await delegate.findMany({
    where: nameFilter("createdAt", cutoff, textField),
    select: { id: true },
  });
  for (const row of candidates) {
    try {
      await delegate.delete({ where: { id: row.id } });
      deleted += 1;
    } catch (err) {
      skipped += 1;
      console.warn(
        `[demoHygiene] skip ${modelName} id=${row.id}: ${err.code || err.message}`,
      );
    }
  }
  return { deleted, skipped, candidates: candidates.length };
}

async function purgeMarketplaceLeads(cutoff) {
  // MarketplaceLead has BOTH a name field AND an email field carrying QA
  // markers. The pen-test specifically reported `e2e_audit_…@example.com`
  // on this surface, so widen the filter to include email-prefix matches.
  // Schema: name String?, email String? — both nullable, so OR-join.
  let deleted = 0;
  let skipped = 0;
  const candidates = await prisma.marketplaceLead.findMany({
    where: {
      AND: [
        { createdAt: { lt: cutoff } },
        {
          OR: [
            ...QA_NAME_PREFIXES.map((p) => ({ name: { startsWith: p } })),
            ...QA_NAME_PREFIXES.map((p) => ({ email: { startsWith: p } })),
          ],
        },
      ],
    },
    select: { id: true },
  });
  for (const row of candidates) {
    try {
      await prisma.marketplaceLead.delete({ where: { id: row.id } });
      deleted += 1;
    } catch (err) {
      skipped += 1;
      console.warn(
        `[demoHygiene] skip marketplaceLead id=${row.id}: ${err.code || err.message}`,
      );
    }
  }
  return { deleted, skipped, candidates: candidates.length };
}

async function runDemoHygiene({ ageHours } = {}) {
  const cutoff = ageCutoff(
    ageHours ?? Number(process.env.DEMO_HYGIENE_AGE_HOURS),
  );
  const startedAt = Date.now();
  const summary = {
    cutoff: cutoff.toISOString(),
    // Original 5 surfaces (#541 + #405)
    patient: { deleted: 0, skipped: 0, candidates: 0 },
    pipeline: { deleted: 0, skipped: 0, candidates: 0 },
    currency: { deleted: 0, skipped: 0, candidates: 0 },
    territory: { deleted: 0, skipped: 0, candidates: 0 },
    chatbot: { deleted: 0, skipped: 0, candidates: 0 },
    // #578 widening — 7 customer-facing surfaces from the pen-test repro
    slaPolicy: { deleted: 0, skipped: 0, candidates: 0 },
    ticket: { deleted: 0, skipped: 0, candidates: 0 },
    marketplaceLead: { deleted: 0, skipped: 0, candidates: 0 },
    landingPage: { deleted: 0, skipped: 0, candidates: 0 },
    task: { deleted: 0, skipped: 0, candidates: 0 },
    agentRecommendation: { deleted: 0, skipped: 0, candidates: 0 },
    emailMessage: { deleted: 0, skipped: 0, candidates: 0 },
    durationMs: 0,
  };
  try {
    // #541 — patients sweep stays first; FK-restrict failures must not
    // block the rest of the tick.
    summary.patient = await purgePatients(cutoff);

    // Admin-config models (name field)
    summary.pipeline = await purgeNamedModel("pipeline", cutoff, "name");
    summary.currency = await purgeNamedModel("currency", cutoff, "name");
    summary.territory = await purgeNamedModel("territory", cutoff, "name");
    summary.chatbot = await purgeNamedModel("chatbot", cutoff, "name");
    summary.slaPolicy = await purgeNamedModel("slaPolicy", cutoff, "name");

    // Wellness + customer-facing surfaces with `title`
    summary.task = await purgeNamedModel("task", cutoff, "title");
    summary.agentRecommendation = await purgeNamedModel(
      "agentRecommendation",
      cutoff,
      "title",
    );
    summary.landingPage = await purgeNamedModel("landingPage", cutoff, "title");

    // Surfaces with `subject`
    summary.ticket = await purgeNamedModel("ticket", cutoff, "subject");
    summary.emailMessage = await purgeNamedModel(
      "emailMessage",
      cutoff,
      "subject",
    );

    // Special-case: MarketplaceLead — sweep on (name OR email).
    summary.marketplaceLead = await purgeMarketplaceLeads(cutoff);
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
    summary.chatbot.deleted +
    summary.slaPolicy.deleted +
    summary.ticket.deleted +
    summary.marketplaceLead.deleted +
    summary.landingPage.deleted +
    summary.task.deleted +
    summary.agentRecommendation.deleted +
    summary.emailMessage.deleted;
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
