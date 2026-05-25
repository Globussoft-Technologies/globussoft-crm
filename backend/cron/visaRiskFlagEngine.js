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
//   R11 FR-3.1+3 complex-stale          — complexCase=true + updatedAt >5d (neglect risk)
//   R12 FR-3.2   high-rejection-history — rejectionHistoryJson parsed length ≥2 (severity tier)
//   R13 FR-3.1(b)+PC-4 cooldown — priorApplicationId → prior app rejected →
//        EmbassyRule(cooldown_period) for destination → current time before
//        priorApp.decidedAt + cooldown.days → flag with countdown
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

// R11 threshold — complex-case applications that haven't moved forward
// in COMPLEX_STALE_DAYS days. Tighter than R7's 14d because complex
// cases (visa work/student/hajj — i.e. the ones FR-3.1 explicitly calls
// out as needing active advisor attention) shouldn't sit unattended.
// 5d is a holding value pending PC-4 SLA sign-off; the production cron
// will parameterise this per-applicationType once PC-4 lands.
const COMPLEX_STALE_DAYS = 5;
const COMPLEX_STALE_MS = COMPLEX_STALE_DAYS * 24 * 60 * 60 * 1000;

// R12 threshold — high rejection-history count that severity-escalates
// the basic R3 signal. R3 fires on ANY non-empty array (length ≥1);
// R12 adds a "this applicant has compounding risk" signal when the
// history has ≥2 entries. The exact tier-boundary (≥2 vs ≥3) and the
// downstream priority mapping is a PC-3 design call; this is the
// today-shippable proxy that surfaces the worst cases to advisors.
const HIGH_REJECTION_HISTORY_THRESHOLD = 2;

// R13 (FR-3.1(b) + PC-4 RESOLVED 2026-05-24) — rejection-recovery cooldown.
// When an application carries a `priorApplicationId` self-FK pointing at a
// previously-rejected app for the SAME destinationCountry, the embassy may
// enforce a mandatory cooldown window before a reapplication is even
// accepted. PC-4 resolved 2026-05-24: source the per-destination cooldown
// period from the EmbassyRule(ruleType='cooldown_period') row whose
// `conditionJson` carries `{days: N}`. If the current time is before
// (priorApp.decidedAt + N days), surface the countdown to the advisor so
// they don't waste an embassy slot filing prematurely. The check is silent
// on every edge case (no prior, prior not rejected, no rule, malformed
// conditionJson) — the engine never crashes on R13.

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
  //
  // R12 — FR-3.2 severity-tier escalation: parsed length ≥ HIGH_REJECTION_
  //   HISTORY_THRESHOLD adds a compounding-risk reason on TOP of R3's
  //   base signal. Both fire together when the threshold is crossed —
  //   advisors see both `rejection-history:N` (count) AND
  //   `high-rejection-history:N` (severity tier) in the reason list,
  //   which surfaces "worst cases first" in the Visa Sure queue.
  if (app.rejectionHistoryJson) {
    try {
      const parsed = JSON.parse(app.rejectionHistoryJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        reasons.push(`rejection-history:${parsed.length}`);
        if (parsed.length >= HIGH_REJECTION_HISTORY_THRESHOLD) {
          reasons.push(`high-rejection-history:${parsed.length}`);
        }
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

  // R11 (FR-3.1 + FR-3.3 — neglect escalation) — complex-case row that
  // hasn't been touched in COMPLEX_STALE_DAYS days. R2 fires on the
  // mere presence of complexCase=true; R11 fires when an advisor has
  // ALSO let the case go quiet for ≥5d, which is the neglect-risk
  // failure mode for the hardest-to-process applications. Both R2 and
  // R11 fire together when the threshold is crossed — the reason list
  // carries `complex-case` (R2) AND `complex-stale:5d` (R11), giving
  // the advisor queue a tier-1 sort signal.
  //
  // Schema fields read: complexCase, updatedAt (both present on
  // VisaApplication). No PC-1 dependency.
  if (
    app.complexCase === true &&
    app.updatedAt &&
    now - new Date(app.updatedAt).getTime() > COMPLEX_STALE_MS
  ) {
    reasons.push(`complex-stale:${COMPLEX_STALE_DAYS}d`);
  }

  return { flag: reasons.length > 0, reasons };
}

// R13 (FR-3.1(b) + PC-4 RESOLVED 2026-05-24) — rejection-recovery cooldown
// enforcement. Async because it needs two prisma lookups (prior app + the
// per-destination EmbassyRule). Silent skip on every edge case so the rule
// never crashes the engine; advisors only see R13 when ALL preconditions
// line up:
//
//   1. app.priorApplicationId is non-null (self-FK from tick #176 schema)
//   2. priorApp loads + has outcome='rejected' OR status='rejected'
//      (schema allows either as the rejection signal — outcome is the
//      definitive field per `VisaApplication.outcome` enum doc-comment,
//      but legacy rows may carry status='rejected' without outcome set)
//   3. priorApp.decidedAt is non-null (needed for cooldown anchor)
//   4. An active EmbassyRule(ruleType='cooldown_period') exists for the
//      tenant + the prior app's destinationCountry
//   5. conditionJson parses as `{days: number}` with days being a positive
//      finite number
//   6. now < priorApp.decidedAt + days * 86_400_000 (cooldown unsatisfied)
//
// On match, returns `cooldown:until-YYYY-MM-DD` so the advisor sees the
// concrete date in the notification message.
//
// Test injection: pass a `prismaClient` arg to override the module-level
// import. Defaults to `module.exports.__prisma` (resolved at call-time
// through the exports surface per CLAUDE.md's CJS self-mocking seam
// pattern — tests can `vi.spyOn(module.exports, '__prisma', 'get')` if
// they need finer-grained control, but the simpler pattern is to just
// pass a stub directly via the arg).
async function evaluateCooldownR13(app, now, prismaClient) {
  try {
    if (!app || !app.priorApplicationId) return { reason: null };

    const db = prismaClient || prisma;

    const priorApp = await db.visaApplication.findUnique({
      where: { id: app.priorApplicationId },
      select: {
        id: true,
        destinationCountry: true,
        outcome: true,
        status: true,
        decidedAt: true,
      },
    });

    if (!priorApp) return { reason: null };

    const isRejected =
      priorApp.outcome === "rejected" || priorApp.status === "rejected";
    if (!isRejected) return { reason: null };
    if (!priorApp.decidedAt) return { reason: null };
    if (!priorApp.destinationCountry) return { reason: null };

    const rule = await db.embassyRule.findFirst({
      where: {
        tenantId: app.tenantId,
        destinationCountry: priorApp.destinationCountry,
        ruleType: "cooldown_period",
        isActive: true,
      },
      select: { conditionJson: true, severity: true },
    });

    if (!rule || !rule.conditionJson) return { reason: null };

    let days;
    try {
      const parsed = JSON.parse(rule.conditionJson);
      if (!parsed || typeof parsed !== "object") return { reason: null };
      days = parsed.days;
    } catch {
      // Malformed JSON — silent skip per the engine's reliability contract
      return { reason: null };
    }

    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
      return { reason: null };
    }

    const decidedMs = new Date(priorApp.decidedAt).getTime();
    if (!Number.isFinite(decidedMs)) return { reason: null };

    const cooldownEndMs = decidedMs + days * 86_400_000;
    if (now >= cooldownEndMs) return { reason: null };

    const untilIso = new Date(cooldownEndMs).toISOString().split("T")[0];
    return { reason: `cooldown:until-${untilIso}` };
  } catch (e) {
    // Defensive: any prisma error or unexpected throw degrades to silent
    // skip. R13 never crashes the engine; the other 12 rules continue.
    console.warn(
      `[VisaRiskFlag] R13 cooldown check failed for app ${app && app.id}:`,
      e && e.message,
    );
    return { reason: null };
  }
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
      priorApplicationId: true,
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
    const now = Date.now();
    const { reasons } = evaluateRiskShell(app, now, {
      knownDestinations,
    });

    // R13 — async cooldown check. Tenant-scope is injected from the
    // outer tenantId arg (not in the select). Uses module.exports
    // indirection so vitest can spy on the helper if needed (CJS
    // self-mocking seam, CLAUDE.md cron-learning 2026-05-24).
    const r13 = await module.exports.evaluateCooldownR13(
      { ...app, tenantId },
      now,
      prisma,
    );
    if (r13 && r13.reason) {
      reasons.push(r13.reason);
    }

    if (reasons.length === 0) continue;

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
  evaluateCooldownR13,
};
