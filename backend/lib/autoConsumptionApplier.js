// Wave 11 Agent HH — Auto-consumption applier (eventBus listener).
//
// When a Visit transitions to status='completed' (either via POST /visits or
// PUT /visits/:id with a status flip), wellness.js emits a `visit.completed`
// event on the in-process eventBus. This module subscribes to that event and:
//
//   1. Looks up all active AutoConsumptionRule rows for the visit's serviceId
//      within the same tenant.
//   2. For each rule: creates a ServiceConsumption row (so the per-visit
//      consumption ledger that powers the P&L-by-Service report stays
//      truthful) AND decrements Product.currentStock by quantityPerVisit
//      (rounded toward debit so 0.5 mL still consumes a full 1-unit Int).
//   3. If a product is out of stock (currentStock <= 0), logs a warning
//      visible in the lowStockEngine cron channel — does NOT block the
//      visit, since blocking visit completion on stock zero would corrupt
//      the clinical record (the procedure already happened; the inventory
//      side is a follow-up, not a gate).
//
// Why this lives in lib/ (not cron/): it's a synchronous-ish event handler,
// not a polled cron. Initialised at boot from server.js → start(). No SIGTERM
// handler needed — the EventEmitter is in-process and exits with the node
// process.
//
// Why we don't undo this on visit.cancellation: the auto-consumption fires
// on visit.completed only. If a visit is later cancelled (status=cancelled),
// the inventory was already consumed during the procedure — reversing it
// would require a manual InventoryAdjustment with reason=MANUAL.

const prisma = require("./prisma");
const { bus } = require("./eventBus");
const { writeAudit } = require("./audit");

/**
 * Apply all auto-consumption rules for a visit. Exposed for unit testing
 * + for the visit-create route to call directly (the eventBus path is the
 * primary trigger but the route can also call this synchronously when the
 * visit lands as completed in a single create — same outcome).
 *
 * @param {object} visit       — the Visit row (must have id, serviceId, tenantId)
 * @param {object} [opts]      — { skipAuditLog: bool }
 * @returns {Promise<{ rules: number, applied: Array, skipped: Array }>}
 */
async function applyAutoConsumptionForVisit(visit, opts = {}) {
  const out = { rules: 0, applied: [], skipped: [] };
  if (!visit || !visit.id || !visit.serviceId) return out;
  if (visit.status && visit.status !== "completed") return out;

  const rules = await prisma.autoConsumptionRule.findMany({
    where: {
      tenantId: visit.tenantId,
      serviceId: visit.serviceId,
      isActive: true,
    },
    include: { product: { select: { id: true, name: true, currentStock: true, threshold: true } } },
  });
  out.rules = rules.length;
  if (rules.length === 0) return out;

  for (const rule of rules) {
    try {
      const qty = Number(rule.quantityPerVisit);
      // ServiceConsumption.qty is Int; round to whole units toward consumption.
      const consumedUnits = Math.max(1, Math.ceil(qty));

      await prisma.$transaction(async (tx) => {
        await tx.serviceConsumption.create({
          data: {
            visitId: visit.id,
            productId: rule.productId,
            productName: rule.product.name,
            qty: consumedUnits,
            unitCost: 0, // unitCost is per-clinic and lives on receipts/adjustments; auto rows leave it 0
            tenantId: visit.tenantId,
          },
        });
        await tx.product.update({
          where: { id: rule.productId },
          data: { currentStock: { decrement: consumedUnits } },
        });
      });

      out.applied.push({ ruleId: rule.id, productId: rule.productId, qty: consumedUnits });

      // Out-of-stock: warn but don't fail. Surfaces in logs the lowStockEngine
      // cron already monitors.
      const newStock = (rule.product.currentStock || 0) - consumedUnits;
      if (newStock <= 0) {
        console.warn(
          `[autoConsumption] product '${rule.product.name}' (id=${rule.productId}) ` +
          `is now at stock=${newStock} for tenant ${visit.tenantId} — low-stock engine will alert`
        );
      }
    } catch (err) {
      console.error(
        `[autoConsumption] rule ${rule.id} failed for visit ${visit.id}:`,
        err.message
      );
      out.skipped.push({ ruleId: rule.id, reason: err.message });
    }
  }

  if (!opts.skipAuditLog && out.applied.length > 0) {
    try {
      await writeAudit("Visit", "AUTO_CONSUMPTION_APPLIED", visit.id, null, visit.tenantId, {
        serviceId: visit.serviceId,
        rulesApplied: out.applied.length,
        productsConsumed: out.applied.map((a) => a.productId),
      });
    } catch (auditErr) {
      console.warn("[autoConsumption] audit log failed:", auditErr.message);
    }
  }

  return out;
}

/**
 * Subscribe to visit.completed events. Called once at server boot from
 * server.js. Idempotent — safe to call repeatedly (we use a flag to avoid
 * duplicate listeners across hot reloads in dev).
 */
let _started = false;
function start() {
  if (_started) return;
  _started = true;
  bus.on("visit.completed", async (envelope) => {
    try {
      const payload = envelope?.payload || {};
      const visitId = payload.visitId;
      if (!visitId) return;
      // Re-fetch the visit to pick up tenantId + status (the event payload is
      // intentionally minimal so the bus doesn't carry stale data).
      const visit = await prisma.visit.findUnique({ where: { id: visitId } });
      if (!visit) return;
      await applyAutoConsumptionForVisit(visit);
    } catch (err) {
      console.error("[autoConsumption] visit.completed handler failed:", err.message);
    }
  });
  console.log("[autoConsumption] listener registered for visit.completed");
}

module.exports = {
  applyAutoConsumptionForVisit,
  start,
};
