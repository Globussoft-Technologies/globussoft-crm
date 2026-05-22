// Travel CRM — Visa Sure risk-flagging engine (PRD Phase 3 §3 FR-3,
// rows V5-V7, cluster B3).
//
// SHELL implementation. Runs every 6 hours per travel tenant.
//
// Scans VisaApplication rows in status ∈ {pending, intake, docs-pending,
// docs-collected} and computes a risk indicator. For each newly-flagged
// application, writes a high-priority Notification row scoped to the
// advisor dashboard (entityType='VisaApplication', entityId=app.id).
//
// PRD §3 FR-3 (and §5 PC-1..PC-5) names FOUR risk-flag rule classes that
// land in the real engine post product-call sign-off:
//
//   FR-3.1 — Complex-case flagging:
//     (a) applicationType ∈ {work, student, business, hajj}   → complex
//     (b) priorRejectionCount ≥ 1                              → complex
//     (c) family / dependents on the application               → complex
//     (d) destination is a high-rejection-rate embassy         → complex
//
//   FR-3.2 — Rejection-history tagging:
//     rejectionHistoryJson parsed; non-empty array → flag
//
//   FR-3.3 — Advisor priority alerts:
//     advisorRiskFlag transitions to 'high' or 'priority'      → alert
//     OR readinessLevel = 4                                    → alert
//     OR rejectionHistoryJson non-empty                        → alert
//
// SHELL stub rules below evaluate the SUBSET of the above signals that
// can be derived from VisaApplication's existing columns (applicationType,
// readinessLevel, complexCase, rejectionHistoryJson, advisorRiskFlag,
// outcome, decidedAt, createdAt, destinationCountry) plus operator-facing
// dwell signals. The real rule-set — including the high-rejection-rate-
// embassy catalogue (PC-3), the family/dependents detection, and the
// LLM-augmented narrative summary — lands once PC-1..PC-5 are resolved
// (see docs/PRD_VISA_SURE_PHASE_3.md §5).
//
// Active rules (PC-1-independent — uses only existing schema columns):
//   R1 FR-3.1(a) complex-type           — applicationType ∈ {work,student,business,hajj}
//   R2 FR-3.1   complex-case            — complexCase column = true
//   R3 FR-3.2   rejection-history       — rejectionHistoryJson non-empty
//   R4 FR-3.3   readiness-level-4       — readinessLevel = 4
//   R5 FR-3.3   flag-already            — advisorRiskFlag ∈ {high, priority}
//   R6 FR-3.1+6 docs-incomplete         — required-unverified + docs-pending/collected
//   R7 FR-3.3   stale-application       — updatedAt >14d + docs-pending/collected
//   R8 FR-3.3   stale-intake            — status=intake + createdAt >7d
//   R9 FR-3.2   rejected-reopen         — outcome=rejected + recent touch after decidedAt
//   R10 FR-3.1(d) new-destination       — tenant has no prior filed app for this country
//
// Cadence: every 6 hours per the parallel-wave dispatch contract. PRD
// §4 latency target is "< 15 min p95" which the production cron will hit
// at a tighter cadence post product-call sign-off; the 6h SHELL cadence
// is the safe placeholder while the rule-set is still in flux.
//
// Idempotency: dedupe by (entityType='VisaApplication', entityId,
// type='warning'). Each application gets at most ONE advisor-priority
// alert across its lifecycle in the SHELL pass. The real engine will
// re-fire on transitions (escalate / de-escalate) once PC-1 lands.
//
// Dispatch deferred: WhatsApp/email send waits on Wati BSP creds (Q9).
// The Notification row is the visible SHELL output; advisor dashboard
// surfaces them under the Visa Sure queue.

const cron = require("node-cron");
const prisma = require("../lib/prisma");

const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

// R7 threshold — applications updated more than this many days ago AND
// still in a pre-filed status are flagged as stale. 14d is a holding
// value pending PRD §5 PC-4 sign-off on SLA targets; the cron's real
// dwell-time threshold will be parameterised per-sub-brand by then.
const STALE_DWELL_DAYS = 14;
const STALE_DWELL_MS = STALE_DWELL_DAYS * 24 * 60 * 60 * 1000;
const STALE_STATUSES = new Set(["docs-collected", "docs-pending"]);

// R8 threshold — applications in 'intake' status that have aged more
// than this many days since creation. Catches the "received an inquiry,
// never moved it forward" failure mode. R7 covers later statuses
// (docs-pending/docs-collected); R8 covers the earlier intake stall
// with a tighter threshold (7d) because intake should resolve faster
// than docs-collection. Holding value pending PC-4 SLA sign-off.
const STALE_INTAKE_DAYS = 7;
const STALE_INTAKE_MS = STALE_INTAKE_DAYS * 24 * 60 * 60 * 1000;

// R9 thresholds — application that decided=rejected but got touched
// again within REOPEN_WINDOW_DAYS is likely a re-open / appeal / re-file
// the advisor is actively working. Surface them so the advisor queue
// shows the recovery work alongside in-flight applications. The grace
// window after decidedAt absorbs the natural status-write that records
// the rejection itself — only touches AFTER the grace count as evidence
// of an active re-open.
const REOPEN_WINDOW_DAYS = 30;
const REOPEN_WINDOW_MS = REOPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REOPEN_GRACE_MS = 60 * 1000; // 1 minute

// SHELL evaluation — returns { flag, reasons[] } for a VisaApplication
// row. Real engine replaces this with a rule-engine + LLM narrative once
// PC-1..PC-5 resolve.
//
// `now` is injectable for deterministic dwell-time tests; defaults to
// Date.now() in production.
//
// `context.knownDestinations` (optional Set<string>) — destinations the
// tenant has previously filed for. When provided AND the current app's
// destinationCountry is NOT in the set, R10 fires. When omitted (e.g.
// pure-function unit tests that don't set up context), R10 does NOT
// fire — keeps the existing test suite back-compat.
function evaluateRiskShell(app, now = Date.now(), context = {}) {
  const reasons = [];
  const knownDestinations =
    context && context.knownDestinations instanceof Set
      ? context.knownDestinations
      : null;

  // R1 — FR-3.1(a) complex applicationType class
  const complexTypes = new Set(["work", "student", "business", "hajj"]);
  if (complexTypes.has(app.applicationType)) {
    reasons.push(`complex-type:${app.applicationType}`);
  }

  // R2 — FR-3.1 explicit complexCase column
  if (app.complexCase === true) {
    reasons.push("complex-case");
  }

  // R3 — FR-3.2 non-empty rejection history (defensive parse per §4 reliability)
  if (app.rejectionHistoryJson) {
    try {
      const parsed = JSON.parse(app.rejectionHistoryJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        reasons.push(`rejection-history:${parsed.length}`);
      }
    } catch {
      // Malformed JSON — log non-fatally, treat as no history (per §4)
    }
  }

  // R4 — FR-3.3 readinessLevel 4 (Supported Journey Recommended)
  if (app.readinessLevel === 4) {
    reasons.push("readiness-level-4");
  }

  // R5 — FR-3.3 existing advisorRiskFlag already in {high, priority}
  if (app.advisorRiskFlag === "high" || app.advisorRiskFlag === "priority") {
    reasons.push(`flag:${app.advisorRiskFlag}`);
  }

  // R6 (FR-3.1 + FR-6) — required documents still pending close to
  // submission. We count required checklist items whose status is NOT
  // verified (i.e. still pending | uploaded | rejected). When the
  // application is already past intake (docs-pending / docs-collected)
  // and ≥1 required item is unverified, flag as docs-incomplete. The
  // FR-6 auto-status-advance only moves status forward when 100% of
  // required items are verified, so this rule surfaces applications
  // that have stalled in document collection.
  if (Array.isArray(app.documentChecklist) && app.documentChecklist.length > 0) {
    const requiredUnverified = app.documentChecklist.filter(
      (d) => d.required === true && d.status !== "verified",
    ).length;
    if (
      requiredUnverified > 0 &&
      (app.status === "docs-pending" || app.status === "docs-collected")
    ) {
      reasons.push(`docs-incomplete:${requiredUnverified}`);
    }
  }

  // R7 (FR-3.3 + PRD §4 latency) — stale application: row hasn't moved
  // forward in STALE_DWELL_DAYS days AND is still in a pre-filed
  // bucket. Catches the "advisor forgot about it" failure mode that
  // FR-3.3's transition-based alerts miss (no transition = no alert).
  if (
    app.updatedAt &&
    STALE_STATUSES.has(app.status) &&
    now - new Date(app.updatedAt).getTime() > STALE_DWELL_MS
  ) {
    reasons.push(`stale-application:${STALE_DWELL_DAYS}d`);
  }

  // R8 (FR-3.3 — earlier-funnel stall companion to R7) — application
  // is still in 'intake' status but was created >STALE_INTAKE_DAYS
  // days ago. R7's status gate excludes 'intake' deliberately (the
  // checklist isn't expected complete at intake), but a stalled
  // intake row IS a risk signal — the advisor never moved the inquiry
  // forward. Threshold is tighter than R7 (7d vs 14d) because intake
  // should resolve faster than docs-collection. Schema fields read:
  // status, createdAt (both present on VisaApplication).
  if (
    app.status === "intake" &&
    app.createdAt &&
    now - new Date(app.createdAt).getTime() > STALE_INTAKE_MS
  ) {
    reasons.push(`stale-intake:${STALE_INTAKE_DAYS}d`);
  }

  // R9 (FR-3.2 companion — active rejection-recovery) — application
  // was decided=rejected, but updatedAt is meaningfully after decidedAt
  // AND the touch happened within REOPEN_WINDOW_DAYS. This signals an
  // advisor actively working an appeal / re-file / recovery program.
  // Distinct from FR-3.2's static rejectionHistoryJson signal: that
  // surfaces lifetime risk; this surfaces current re-open activity.
  // Schema fields read: outcome, decidedAt, updatedAt (all present).
  if (
    app.outcome === "rejected" &&
    app.decidedAt &&
    app.updatedAt
  ) {
    const decidedAtMs = new Date(app.decidedAt).getTime();
    const updatedAtMs = new Date(app.updatedAt).getTime();
    if (
      updatedAtMs > decidedAtMs + REOPEN_GRACE_MS &&
      now - updatedAtMs < REOPEN_WINDOW_MS
    ) {
      reasons.push(`rejected-reopen:${REOPEN_WINDOW_DAYS}d`);
    }
  }

  // R10 (FR-3.1(d) precursor — fresh-jurisdiction risk) — the tenant
  // has never filed for this destinationCountry before. The operator
  // hasn't built tribal knowledge for that country's embassy quirks
  // yet, so the application carries higher procedural risk. PC-3
  // (high-rejection-rate embassy catalogue) will subsume this with a
  // proper rejection-rate score per (country, applicationType); R10
  // is the today-shippable proxy. Only fires when context.
  // knownDestinations is supplied (i.e. from runRiskFlaggingForTenant
  // — pure-function callers that omit context don't trigger R10).
  if (
    knownDestinations &&
    app.destinationCountry &&
    !knownDestinations.has(app.destinationCountry)
  ) {
    reasons.push(`new-destination:${app.destinationCountry}`);
  }

  return { flag: reasons.length > 0, reasons };
}

/**
 * @param {number} tenantId
 * @returns {Promise<{ evaluated: number, flagged: number }>}
 */
async function runRiskFlaggingForTenant(tenantId) {
  const applications = await prisma.visaApplication.findMany({
    where: {
      tenantId,
      status: { in: ["pending", "intake", "docs-pending", "docs-collected"] },
    },
    select: {
      id: true,
      applicationType: true,
      destinationCountry: true,
      status: true,
      readinessLevel: true,
      complexCase: true,
      rejectionHistoryJson: true,
      advisorRiskFlag: true,
      contactId: true,
      outcome: true,
      decidedAt: true,
      createdAt: true,
      updatedAt: true,
      documentChecklist: {
        select: { id: true, required: true, status: true },
      },
    },
    take: 500,
  });

  // R10 prep — build the set of destinations this tenant has previously
  // filed-or-beyond for. "Filed-or-later" rows are what teach the
  // operator tribal knowledge; an in-flight intake teaches nothing yet.
  const priorDestinations = await prisma.visaApplication.findMany({
    where: {
      tenantId,
      status: { in: ["filed", "approved", "rejected", "appeal"] },
    },
    select: { destinationCountry: true },
    distinct: ["destinationCountry"],
    take: 500,
  });
  const knownDestinations = new Set(
    priorDestinations
      .map((r) => r.destinationCountry)
      .filter((c) => typeof c === "string" && c.length > 0),
  );

  let evaluated = 0;
  let flagged = 0;

  for (const app of applications) {
    evaluated++;
    const { flag, reasons } = evaluateRiskShell(app, Date.now(), {
      knownDestinations,
    });
    if (!flag) continue;

    // Dedup: existing warning notification for this application?
    const existing = await prisma.notification.findFirst({
      where: {
        tenantId,
        entityType: "VisaApplication",
        entityId: app.id,
        type: "warning",
      },
      select: { id: true },
    });
    if (existing) continue;

    const title = `Visa risk flag: app #${app.id} (${app.applicationType} → ${app.destinationCountry})`;
    const message =
      `Risk signals: ${reasons.join(", ")}. ` +
      `Advisor priority review recommended. ` +
      `Open ${PORTAL_BASE}/travel/visa/applications/${app.id}`;

    try {
      await prisma.notification.create({
        data: {
          tenantId,
          title,
          message,
          type: "warning",
          priority: "high",
          entityType: "VisaApplication",
          entityId: app.id,
        },
      });
      flagged++;
    } catch (e) {
      console.error(
        `[VisaRiskFlag] tenant ${tenantId} app ${app.id} create error:`,
        e.message,
      );
    }
  }

  console.log(
    `[VisaRiskFlag] tenant ${tenantId} → ${evaluated} applications evaluated, ` +
      `${flagged} flagged (stub-mode pending PRD design calls PC-1..PC-5)`,
  );

  return { evaluated, flagged };
}

async function runRiskFlaggingForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalFlagged = 0;
  for (const t of tenants) {
    try {
      const { flagged } = await runRiskFlaggingForTenant(t.id);
      totalFlagged += flagged;
    } catch (e) {
      console.error("[VisaRiskFlag] tenant fail:", t.slug, e.message);
    }
  }
  return totalFlagged;
}

function initVisaRiskFlagCron() {
  // Every 6 hours per the SHELL dispatch contract. Real engine cadence
  // tightens to 15 min once PC-1..PC-5 resolve (PRD §4 latency target).
  cron.schedule("0 */6 * * *", () => {
    runRiskFlaggingForAllTravelTenants().catch((e) =>
      console.error("[VisaRiskFlag] cron fail:", e.message),
    );
  });
  console.log("[VisaRiskFlag] cron initialized (every 6 hours)");
}

module.exports = {
  initVisaRiskFlagCron,
  runRiskFlaggingForTenant,
  runRiskFlaggingForAllTravelTenants,
  // Exported for unit-test introspection only.
  evaluateRiskShell,
};
