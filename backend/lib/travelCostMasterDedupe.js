const prisma = require("./prisma");

function naturalKey(row) {
  return [
    row.tenantId,
    row.subBrand,
    row.category,
    row.routeOrSku,
  ].join("|");
}

async function collapseCostMasterDuplicates(where = {}) {
  const rows = await prisma.travelCostMaster.findMany({
    where,
    select: {
      id: true,
      tenantId: true,
      subBrand: true,
      category: true,
      routeOrSku: true,
      updatedAt: true,
    },
    orderBy: [{ id: "asc" }],
  });

  const keepByKey = new Map();
  const duplicateIds = [];

  for (const row of rows) {
    const key = naturalKey(row);
    const current = keepByKey.get(key);
    if (!current) {
      keepByKey.set(key, row);
      continue;
    }

    const rowTime = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    const currentTime = current.updatedAt ? new Date(current.updatedAt).getTime() : 0;
    if (rowTime > currentTime || (rowTime === currentTime && row.id > current.id)) {
      duplicateIds.push(current.id);
      keepByKey.set(key, row);
    } else {
      duplicateIds.push(row.id);
    }
  }

  if (duplicateIds.length === 0) {
    return { scanned: rows.length, removed: 0 };
  }

  const deleted = await prisma.travelCostMaster.deleteMany({
    where: { id: { in: duplicateIds } },
  });

  return { scanned: rows.length, removed: deleted.count || 0 };
}

async function collapseCostMasterDuplicatesOnBoot() {
  if (process.env.DISABLE_COST_MASTER_DEDUP_BOOT_SYNC === "1") return null;
  return collapseCostMasterDuplicates();
}

module.exports = {
  collapseCostMasterDuplicates,
  collapseCostMasterDuplicatesOnBoot,
};
