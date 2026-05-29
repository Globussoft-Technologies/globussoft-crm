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
//      truthful) AND decrements Product.currentStock by the rule's quantity.
//      - quantityPerVisit is stored in the product's unit (e.g., 50ml).
//      - If product.volume is set (e.g., 150ml per unit), divide to get units:
//        50ml ÷ 150ml/unit = 0.33 units. Round up so partial bottles count.
//      - If product.volume is not set, treat quantityPerVisit as units directly.
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

/**
 * Apply all auto-consumption rules for a visit. Exposed for unit testing
 * + for the visit-create route to call directly (the eventBus path is the
 * primary trigger but the route can also call this synchronously when the
 * visit lands as completed in a single create — same outcome).
 *
 * @param {object} visit       — the Visit row (must have id, serviceId, tenantId)
 * @param {object} [_opts]     — reserved (skipAuditLog: bool); not yet used
 * @returns {Promise<{ rules: number, applied: Array, skipped: Array }>}
 */
async function applyAutoConsumptionForVisit(visit, _opts = {}) {
  const out = { rules: 0, applied: [], skipped: [] };
  if (!visit || !visit.id || !visit.serviceId) return out;
  if (visit.status && visit.status !== "completed") return out;

  const rules = await prisma.autoConsumptionRule.findMany({
    where: {
      tenantId: visit.tenantId,
      serviceId: visit.serviceId,
      isActive: true,
    },
    include: { product: { select: { id: true, name: true, currentStock: true, threshold: true, volume: true, unit: true, partialMlUsed: true } } },
  });
  out.rules = rules.length;
  console.log(`[autoConsumption] visit ${visit.id} serviceId=${visit.serviceId}: found ${rules.length} rules`);
  if (rules.length === 0) return out;

  for (const rule of rules) {
    try {
      const consumedMl = Number(rule.quantityPerVisit);
      const volume = rule.product.volume || 1;
      let newPartialMlUsed = (rule.product.partialMlUsed || 0) + consumedMl;
      let unitsToDeduct = 0;

      // If partial consumption >= volume, decrement a full unit
      if (newPartialMlUsed >= volume) {
        unitsToDeduct = Math.floor(newPartialMlUsed / volume);
        newPartialMlUsed = newPartialMlUsed % volume;
      }

      console.log(
        `[autoConsumption] rule ${rule.id}: consumed=${consumedMl}ml, product=${rule.product.name}, ` +
        `volume=${volume}ml/unit, units_before=${rule.product.currentStock}, ` +
        `partial_before=${rule.product.partialMlUsed}, units_to_deduct=${unitsToDeduct}, partial_after=${newPartialMlUsed}`
      );

      await prisma.$transaction(async (tx) => {
        await tx.serviceConsumption.create({
          data: {
            visitId: visit.id,
            productId: rule.productId,
            productName: rule.product.name,
            qty: consumedMl,
            unitCost: 0,
            tenantId: visit.tenantId,
          },
        });
        const updateData = { partialMlUsed: newPartialMlUsed };
        if (unitsToDeduct > 0) {
          updateData.currentStock = { decrement: unitsToDeduct };
        }
        await tx.product.update({ where: { id: rule.productId }, data: updateData });
      });

      out.applied.push({ ruleId: rule.id, productId: rule.productId, qty: consumedMl });

      const newStock = (rule.product.currentStock || 0) - unitsToDeduct;
      console.log(`[autoConsumption] ✓ stock: ${rule.product.currentStock} units → ${newStock} units, partial: ${newPartialMlUsed}ml`);
      if (newStock <= 0) {
        console.warn(
          `[autoConsumption] product '${rule.product.name}' (id=${rule.productId}) ` +
          `is now at ${newStock} units for tenant ${visit.tenantId} — low-stock engine will alert`
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

  // Skip audit log — auto-consumption is system-triggered without a userId,
  // and the audit schema requires valid userId (foreign key). The ServiceConsumption
  // records created above provide the consumption ledger instead.

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
