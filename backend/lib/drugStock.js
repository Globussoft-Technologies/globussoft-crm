/**
 * Drug stock — quantity on hand, held on the drug catalogue itself.
 *
 * The clinic dispenses from the same shelf the doctor prescribes off, so
 * `Drug.quantity` IS the stock ledger. There is no separate inventory row to
 * map to or reconcile against; one number per drug, managed in one place.
 *
 * WHAT LIVES HERE
 *   - the state machine (in_stock / low / out / not_tracked / not_in_catalogue)
 *   - resolving a prescribed drug line back to its catalogue row
 *   - deciding how many units a prescription consumes
 *   - the decrement itself, plus the low-stock notification it can trigger
 *
 * THE ONE RULE THAT MATTERS
 *   `not_in_catalogue` is NOT `out`. A medicine typed as free text that was
 *   never added to the catalogue has unknown stock — rendering it as zero
 *   would tell a doctor the clinic has none of something it may have plenty
 *   of. Every consumer keeps those two apart.
 */

const prisma = require("./prisma");
const { notifyMany } = require("./notificationService");

const STOCK_STATE = {
  IN_STOCK: "in_stock",
  LOW: "low",
  OUT: "out",
  NOT_TRACKED: "not_tracked",
  NOT_IN_CATALOGUE: "not_in_catalogue",
};

// A prescription line with no explicit quantity dispenses one unit. Measured on
// a live tenant, doctors leave dosage/frequency/duration blank on 99% of lines,
// so deriving a course total (dosage × frequency × duration) would decrement 0
// almost every time — and 150,500 on the one line that had them, because
// `dosage` holds the strength in mg rather than a count. One unit, with an
// explicit per-line override, is the only rule that behaves on real data.
const DEFAULT_DISPENSE_UNITS = 1;
const MAX_DISPENSE_UNITS = 1000;

/** Casefold + collapse punctuation/whitespace so "Azelac  M." ≍ "azelac m". */
function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A prescribed drug's `name` may carry the strength, because
 * `prescriptionHelpers.buildDisplayName` appends it for display while the
 * catalogue keeps `strengthValue`/`strengthUnit` separate. Strip a trailing
 * strength token so "Minoxidil 5%" still finds the "Minoxidil" row.
 */
function stripStrength(normalized) {
  return normalized.replace(/\s+\d+(\.\d+)?\s*(mg|ml|mcg|g|iu|%)$/i, "").trim();
}

/**
 * Stock state for one catalogue row.
 *
 * `lowStockThreshold === 0` means "don't track this one", the same convention
 * Product.threshold already uses in cron/lowStockEngine.js.
 */
function stockStateForDrug(drug) {
  if (!drug) {
    return { state: STOCK_STATE.NOT_IN_CATALOGUE, quantity: null, lowStockThreshold: null };
  }
  const quantity = Number(drug.quantity ?? 0);
  const lowStockThreshold = Number(drug.lowStockThreshold ?? 0);

  // Out beats not-tracked: an untracked drug visibly at zero is still worth
  // telling the prescriber about.
  if (quantity <= 0) return { state: STOCK_STATE.OUT, quantity, lowStockThreshold };
  if (lowStockThreshold <= 0) {
    return { state: STOCK_STATE.NOT_TRACKED, quantity, lowStockThreshold };
  }
  if (quantity <= lowStockThreshold) {
    return { state: STOCK_STATE.LOW, quantity, lowStockThreshold };
  }
  return { state: STOCK_STATE.IN_STOCK, quantity, lowStockThreshold };
}

/** Build the lookup index once per request rather than per drug line. */
function buildDrugIndex(drugRows) {
  const byId = new Map();
  const byName = new Map();
  for (const d of drugRows || []) {
    byId.set(d.id, d);
    const n = normalizeName(d.name);
    // First writer wins — a duplicate catalogue name is a data problem, and
    // preferring the last would make the answer order-dependent.
    if (n && !byName.has(n)) byName.set(n, d);
  }
  return { byId, byName };
}

/**
 * Resolve a prescribed line to its catalogue row.
 *
 * Order, most trustworthy first:
 *   1. `drugId` stamped by the prescription writer's typeahead — exact.
 *   2. Exact (normalised) name match.
 *   3. Same, with a trailing strength token stripped.
 * Anything else is unresolved — free text the catalogue has never seen.
 */
function matchDrugRow(prescribedDrug, index) {
  if (!prescribedDrug) return null;

  const rawId = prescribedDrug.drugId;
  if (rawId !== undefined && rawId !== null && rawId !== "") {
    const id = Number(rawId);
    if (Number.isInteger(id) && id > 0 && index.byId.has(id)) return index.byId.get(id);
  }

  const name = normalizeName(prescribedDrug.name || prescribedDrug.drugName);
  if (!name) return null;
  if (index.byName.has(name)) return index.byName.get(name);

  const stripped = stripStrength(name);
  if (stripped && stripped !== name && index.byName.has(stripped)) {
    return index.byName.get(stripped);
  }
  return null;
}

/**
 * How many units this prescription line dispenses.
 *
 * The doctor may write it on the line ("Minoxidil … qty 2"). Blank, zero or
 * junk falls back to one unit rather than to zero — a line that silently
 * consumed nothing would make the whole feature look broken.
 */
function dispenseUnitsFor(prescribedDrug) {
  const raw = prescribedDrug?.qty ?? prescribedDrug?.quantity;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DISPENSE_UNITS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return DEFAULT_DISPENSE_UNITS;
  return Math.min(n, MAX_DISPENSE_UNITS);
}

/**
 * Availability for a list of prescribed drugs. One query.
 *
 * @returns {Promise<object[]>} one entry per input, same order.
 */
async function resolveStockForDrugs({ tenantId, drugs }) {
  const list = Array.isArray(drugs) ? drugs : [];
  if (!tenantId || list.length === 0) return [];

  const drugRows = await prisma.drug.findMany({
    where: { tenantId },
    select: { id: true, name: true, quantity: true, lowStockThreshold: true, isActive: true },
  });
  const index = buildDrugIndex(drugRows);

  return list.map((d) => {
    const row = matchDrugRow(d, index);
    return {
      name: d?.name || d?.drugName || null,
      drugId: row?.id ?? null,
      drugName: row?.name ?? null,
      // A drug an admin has deactivated still has a count, but the clinic
      // isn't offering it — surface that rather than a bare number.
      drugInactive: row ? row.isActive === false : false,
      ...stockStateForDrug(row),
    };
  });
}

/**
 * Roll a per-medicine list up into one headline.
 *
 * Conservative about the unknown: any unresolved medicine reports `partial`,
 * never `available`, so the summary can't imply a completeness the data
 * doesn't support.
 */
function summarizeStock(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { summary: "unknown", out: 0, low: 0, unknown: 0, total: 0 };

  let out = 0;
  let low = 0;
  let unknown = 0;
  for (const e of list) {
    if (e.state === STOCK_STATE.OUT) out++;
    else if (e.state === STOCK_STATE.LOW) low++;
    else if (e.state === STOCK_STATE.NOT_IN_CATALOGUE) unknown++;
  }

  let summary;
  if (out > 0) summary = "out";
  else if (low > 0) summary = "low";
  else if (unknown === list.length) summary = "unknown";
  else if (unknown > 0) summary = "partial";
  else summary = "available";

  return { summary, out, low, unknown, total: list.length };
}

/**
 * Tell the tenant's admins a drug has hit its reorder point.
 *
 * Best-effort: the prescription is already committed by the time this runs, so
 * a notification failure must never surface to the prescriber. Deduplicated by
 * notificationService's own 24h window on (entityType, entityId).
 */
async function notifyLowStock({ tenantId, drug, io }) {
  try {
    const admins = await prisma.user.findMany({
      where: { tenantId, role: { in: ["ADMIN", "MANAGER"] }, deactivatedAt: null },
      select: { id: true },
      take: 25,
    });
    if (admins.length === 0) return;

    const outOfStock = drug.quantity <= 0;
    await notifyMany({
      userIds: admins.map((a) => a.id),
      tenantId,
      title: outOfStock ? "Drug out of stock" : "Drug running low",
      message: outOfStock
        ? `${drug.name} is out of stock (0 left). Restock it in the drug catalogue.`
        : `${drug.name} is down to ${drug.quantity}, at or below its reorder point of ${drug.lowStockThreshold}.`,
      type: "warning",
      priority: outOfStock ? "high" : "normal",
      link: `/wellness/drugs?drugId=${drug.id}`,
      entityType: "drug-stock",
      entityId: drug.id,
      io,
    });
  } catch (err) {
    console.warn("[drugStock] low-stock notification failed:", err.message);
  }
}

/**
 * Tell the admins a drug was added mid-consultation and has no stock set.
 *
 * A quick-added drug lands at quantity 0 with no reorder point — deliberately,
 * because a prescriber guessing at counts is how a stock ledger becomes
 * fiction. This is the handoff: someone has to go and count the shelf.
 */
async function notifyDrugNeedsStock({ tenantId, drug, addedByUserId, io }) {
  const admins = await prisma.user.findMany({
    where: { tenantId, role: { in: ["ADMIN", "MANAGER"] }, deactivatedAt: null },
    select: { id: true },
    take: 25,
  });
  if (admins.length === 0) return;

  let addedBy = null;
  if (addedByUserId) {
    const u = await prisma.user
      .findUnique({ where: { id: addedByUserId }, select: { name: true } })
      .catch(() => null);
    addedBy = u?.name || null;
  }

  await notifyMany({
    userIds: admins.map((a) => a.id),
    tenantId,
    title: "New drug needs stock set",
    message:
      `${drug.name} was added to the catalogue` +
      (addedBy ? ` by ${addedBy}` : "") +
      ` while writing a prescription. Set its quantity and reorder point so stock tracking works.`,
    type: "warning",
    priority: "normal",
    link: `/wellness/drugs?drugId=${drug.id}`,
    entityType: "drug-stock-setup",
    entityId: drug.id,
    io,
  });
}

/**
 * Decrement stock for the drugs on a prescription, and alert on any that cross
 * their reorder point.
 *
 * Deliberately does NOT run inside the prescription's transaction: an
 * inventory count must never be the reason a clinical record fails to save.
 * The prescription is the medico-legal artefact; stock is bookkeeping that can
 * be corrected in the catalogue.
 *
 * Only lines that resolve to a catalogue row move. Free text the catalogue has
 * never seen is reported back untouched so the caller can tell the admin about
 * it — there is nothing to decrement.
 *
 * @returns {Promise<{ adjusted: object[], unmatched: string[] }>}
 */
async function applyPrescriptionStock({ tenantId, drugs, io }) {
  const list = Array.isArray(drugs) ? drugs : [];
  const result = { adjusted: [], unmatched: [] };
  if (!tenantId || list.length === 0) return result;

  const drugRows = await prisma.drug.findMany({
    where: { tenantId },
    select: { id: true, name: true, quantity: true, lowStockThreshold: true },
  });
  const index = buildDrugIndex(drugRows);

  // Collapse repeats first: the same drug listed twice on one prescription
  // should take its total off once, not race itself over two updates.
  const wanted = new Map();
  for (const line of list) {
    const row = matchDrugRow(line, index);
    if (!row) {
      const label = line?.name || line?.drugName;
      if (label) result.unmatched.push(label);
      continue;
    }
    wanted.set(row.id, (wanted.get(row.id) || 0) + dispenseUnitsFor(line));
  }

  for (const [drugId, units] of wanted) {
    const before = index.byId.get(drugId);
    try {
      const updated = await prisma.drug.update({
        where: { id: drugId },
        // `decrement` so two prescriptions saved at once both land, rather
        // than the second overwriting the first's read-modify-write.
        data: { quantity: { decrement: units } },
        select: { id: true, name: true, quantity: true, lowStockThreshold: true },
      });
      result.adjusted.push({
        drugId,
        name: updated.name,
        units,
        quantityBefore: before?.quantity ?? null,
        quantityAfter: updated.quantity,
      });

      // Alert on the CROSSING, not on the state — otherwise every subsequent
      // prescription for an already-low drug re-alerts. `notifyMany` dedupes
      // over 24h too, but crossing-only keeps the signal meaningful.
      const wasAbove = (before?.quantity ?? 0) > (updated.lowStockThreshold ?? 0);
      const nowAtOrBelow = updated.quantity <= (updated.lowStockThreshold ?? 0);
      const tracked = (updated.lowStockThreshold ?? 0) > 0;
      if ((tracked && wasAbove && nowAtOrBelow) || updated.quantity <= 0) {
        await notifyLowStock({ tenantId, drug: updated, io });
      }
    } catch (err) {
      // One drug failing must not abandon the rest.
      console.warn(
        `[drugStock] failed to decrement drug ${drugId}:`,
        err.message,
      );
    }
  }

  return result;
}

module.exports = {
  STOCK_STATE,
  DEFAULT_DISPENSE_UNITS,
  MAX_DISPENSE_UNITS,
  normalizeName,
  stripStrength,
  stockStateForDrug,
  buildDrugIndex,
  matchDrugRow,
  dispenseUnitsFor,
  resolveStockForDrugs,
  summarizeStock,
  applyPrescriptionStock,
  notifyLowStock,
  notifyDrugNeedsStock,
};
