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
// readinessLevel, complexCase, rejectionHistoryJson, advisorRiskFlag).
// The real rule-set — including the high-rejection-rate-embassy catalogue,
// the family/dependents detection, and the LLM-augmented narrative summary —
// lands once PC-1..PC-5 are resolved (see docs/PRD_VISA_SURE_PHASE_3.md §5).
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

// SHELL evaluation — returns { flag, reasons[] } for a VisaApplication
// row. Real engine replaces this with a rule-engine + LLM narrative once
// PC-1..PC-5 resolve.
function evaluateRiskShell(app) {
  const reasons = [];

  // FR-3.1(a) — complex applicationType class
  const complexTypes = new Set(["work", "student", "business", "hajj"]);
  if (complexTypes.has(app.applicationType)) {
    reasons.push(`complex-type:${app.applicationType}`);
  }

  // FR-3.1 — explicit complexCase column
  if (app.complexCase === true) {
    reasons.push("complex-case");
  }

  // FR-3.2 — non-empty rejection history (defensive parse per §4 reliability)
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

  // FR-3.3 — readinessLevel 4 (Supported Journey Recommended)
  if (app.readinessLevel === 4) {
    reasons.push("readiness-level-4");
  }

  // FR-3.3 — existing advisorRiskFlag already in {high, priority}
  if (app.advisorRiskFlag === "high" || app.advisorRiskFlag === "priority") {
    reasons.push(`flag:${app.advisorRiskFlag}`);
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
    },
    take: 500,
  });

  let evaluated = 0;
  let flagged = 0;

  for (const app of applications) {
    evaluated++;
    const { flag, reasons } = evaluateRiskShell(app);
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
