// Smoke-test the fixed GET /auto-consumption-rules query path against the live DB.
// This mirrors the logic in backend/routes/inventory.js without requiring auth.
const { PrismaClient } = require("@prisma/client");
const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
  override: false,
});
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: true,
});

const prisma = new PrismaClient();

async function main() {
  try {
    const rules = await prisma.autoConsumptionRule.findMany({
      orderBy: [{ serviceId: "asc" }, { productId: "asc" }],
      take: 200,
      include: {
        service: { select: { id: true, name: true } },
      },
    });

    const productIds = [...new Set(rules.map((r) => r.productId).filter(Boolean))];
    const products = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, sku: true, currentStock: true, unit: true },
        })
      : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    const items = rules.map((r) => ({ ...r, product: productMap.get(r.productId) || null }));

    console.log("Success — fetched", items.length, "auto-consumption rule(s)");
    for (const item of items) {
      console.log(
        `rule ${item.id}: service=${item.service?.name || item.serviceId}, product=${item.product?.name || "MISSING (id=" + item.productId + ")"}, qty=${item.quantityPerVisit}`
      );
    }
  } catch (e) {
    console.error("Smoke test failed:", e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
