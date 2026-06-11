/**
 * Backfill Last-Visit-Date Engine (S94)
 *
 * One-shot backfill cron for `Patient.lastVisitDate`. S62 added the column
 * but population is a separate concern (this slice + the S94 POST /visits
 * denorm-hook). On any historical row created before S62 landed, the column
 * reads null — every list view consuming the S96 slim Select gets null until
 * this engine populates from the most-recent Visit per patient.
 *
 * Shape:
 *   - tick(opts = {}) → { success, processed, updated, errors }
 *     - processed: total patients examined across every tenant
 *     - updated: patients whose lastVisitDate was set (visit found + null cache)
 *     - errors: count of per-patient failures (logged, not thrown)
 *   - start(): no-op log. This engine is NOT scheduled by node-cron — it's
 *     intended to be invoked once via a manual admin trigger (or tick()
 *     directly from a CLI / one-shot script). Registering it as recurring
 *     would waste cycles after the historical sweep is done.
 *
 * Idempotency: only touches Patient rows where lastVisitDate IS NULL. After
 * a clean sweep, every subsequent tick() returns updated=0. The S94 denorm-
 * hook in POST /visits keeps new rows current, so this engine has nothing
 * to do on a healthy clean-cut deployment.
 *
 * Tenant-scoping: iterates wellness tenants and runs the backfill per tenant.
 * Cross-tenant patients are never touched in the same query — every findMany
 * / update is tenantId-scoped, mirroring the rest of the cron suite.
 *
 * Batching: pages through Patient rows in batches of 100 (`PATIENT_BATCH_SIZE`)
 * to bound memory + connection time. Per-patient errors are caught + counted,
 * never rethrown — one failing patient does NOT abort the rest of the batch
 * or the rest of the tenant.
 *
 * Engine envelope contract:
 *   {
 *     success: true,
 *     processed: <int>,    // patients examined this tick (lastVisitDate=null)
 *     updated:   <int>,    // patients whose lastVisitDate was written
 *     errors:    <int>,    // per-patient failures (already logged)
 *   }
 *
 * If the top-level tenant.findMany fails, returns
 *   { success: false, processed: 0, updated: 0, errors: 1 }
 * with the underlying error logged. Callers should treat this as "tenant list
 * unavailable" not "data corrupt."
 */

const prisma = require("../lib/prisma");

const PATIENT_BATCH_SIZE = 100;

/**
 * Process one tenant's backfill. Pages through Patient rows where
 * lastVisitDate IS NULL in batches of PATIENT_BATCH_SIZE. For each, looks up
 * the most-recent Visit (orderBy visitDate desc, take 1) and writes the
 * cache. If no visit exists, the patient is counted as "processed" but not
 * updated (legitimate empty state).
 *
 * @param {object} tenant - { id, slug } shape from prisma.tenant.findMany
 * @returns {Promise<{processed: number, updated: number, errors: number}>}
 */
async function processTenant(tenant) {
  let processed = 0;
  let updated = 0;
  let errors = 0;
  let cursor = null;

  // Loop until findMany returns less than a full batch — that means we've
  // hit the tail. Each loop iteration's findMany is bounded so memory stays
  // flat regardless of tenant size.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const findArgs = {
      where: { tenantId: tenant.id, lastVisitDate: null },
      select: { id: true },
      orderBy: { id: "asc" },
      take: PATIENT_BATCH_SIZE,
    };
    if (cursor !== null) {
      findArgs.cursor = { id: cursor };
      findArgs.skip = 1;
    }
    const batch = await prisma.patient.findMany(findArgs);
    if (batch.length === 0) break;

    for (const patient of batch) {
      processed++;
      try {
        const visit = await prisma.visit.findFirst({
          where: { patientId: patient.id, tenantId: tenant.id },
          orderBy: { visitDate: "desc" },
          select: { visitDate: true },
        });
        if (!visit) continue; // no visits → leave lastVisitDate null
        await prisma.patient.update({
          where: { id: patient.id },
          data: { lastVisitDate: visit.visitDate },
        });
        updated++;
      } catch (err) {
        errors++;
        console.error(
          `[backfillLastVisit] tenant=${tenant.id} patient=${patient.id} failed:`,
          err.message,
        );
      }
    }

    // If we got a full batch, the cursor advances to the last patient's id
    // and we loop. If we got a short batch, the next iteration's findMany
    // returns empty and we break.
    cursor = batch[batch.length - 1].id;
    if (batch.length < PATIENT_BATCH_SIZE) break;
  }

  console.log(
    `[backfillLastVisit] tenant=${tenant.id} processed=${processed} updated=${updated} errors=${errors}`,
  );
  return { processed, updated, errors };
}

/**
 * Top-level tick. Iterates every active tenant (not just wellness — a
 * patient-tagged generic tenant should still get the backfill if any
 * tenant.vertical filter is relaxed in the future). The envelope shape
 * matches the standing cron-engine contract.
 *
 * When `opts.tenantId` is set (number), the tenant.findMany WHERE clause is
 * narrowed to `{ id: opts.tenantId, isActive: true }` so only that tenant is
 * swept. This is the path used by the S107 admin endpoint where a single
 * ADMIN's manual trigger must NOT cross-tenant-sweep on a multi-tenant deploy.
 * null/undefined tenantId preserves the legacy all-tenants behavior.
 *
 * @param {object} opts - optional flags
 * @param {number} [opts.tenantId] - scope sweep to a single tenant id
 * @returns {Promise<{success: boolean, processed: number, updated: number, errors: number}>}
 */
async function tick(opts = {}) {
  const started = Date.now();
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  const scopedTenantId =
    opts && opts.tenantId !== null && opts.tenantId !== undefined
      ? opts.tenantId
      : null;

  let tenants;
  try {
    const tenantWhere = { isActive: true };
    if (scopedTenantId !== null) {
      tenantWhere.id = scopedTenantId;
    }
    tenants = await prisma.tenant.findMany({
      where: tenantWhere,
      select: { id: true, slug: true },
    });
  } catch (err) {
    console.error("[backfillLastVisit] tenant list failed:", err.message);
    return { success: false, processed: 0, updated: 0, errors: 1 };
  }

  for (const tenant of tenants) {
    try {
      const res = await processTenant(tenant);
      totalProcessed += res.processed;
      totalUpdated += res.updated;
      totalErrors += res.errors;
    } catch (err) {
      // Per-tenant error isolation — a broken tenant must not poison siblings.
      totalErrors++;
      console.error(
        `[backfillLastVisit] tenant ${tenant.slug || tenant.id} failed:`,
        err.message,
      );
    }
  }

  const ms = Date.now() - started;
  if (scopedTenantId !== null) {
    console.log(
      `[backfillLastVisit] scoped to tenantId=${scopedTenantId} tenants=${tenants.length} processed=${totalProcessed} updated=${totalUpdated} errors=${totalErrors} (${ms}ms)`,
    );
  } else {
    console.log(
      `[backfillLastVisit] tenants=${tenants.length} processed=${totalProcessed} updated=${totalUpdated} errors=${totalErrors} (${ms}ms)`,
    );
  }

  return {
    success: true,
    processed: totalProcessed,
    updated: totalUpdated,
    errors: totalErrors,
  };
}

/**
 * No-op registration. This engine is one-shot — see header.
 * Exported only to satisfy the standing engine-shape contract used by
 * server.js cron init paths; intentionally NOT scheduled here. Callers
 * wire-in via a manual admin trigger endpoint (TODO follow-up gap row).
 */
function start() {
  console.log(
    "[backfillLastVisit] S94 backfill engine ready — invoke tick() manually or via /admin/run-backfill endpoint",
  );
}

module.exports = {
  tick,
  start,
  processTenant,
  PATIENT_BATCH_SIZE,
};
