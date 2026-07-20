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
    const dbUrl = process.env.DATABASE_URL || "";
    console.log("DATABASE_URL db:", dbUrl.replace(/\/\/[^@]+@/, "//***@").replace(/:3306\//, ":3306/"));

    const tables = await prisma.$queryRaw`SHOW TABLES`;
    console.log("Tables in DB:", tables.map((t) => Object.values(t)[0]).slice(0, 50));

    const total = await prisma.$queryRaw`SELECT COUNT(*) as total FROM AutoConsumptionRule`;
    const nullProduct = await prisma.$queryRaw`SELECT COUNT(*) as cnt FROM AutoConsumptionRule WHERE productId IS NULL`;
    const orphan = await prisma.$queryRaw`
      SELECT COUNT(*) as cnt
      FROM AutoConsumptionRule acr
      LEFT JOIN Product p ON acr.productId = p.id
      WHERE acr.productId IS NOT NULL AND p.id IS NULL
    `;
    const orphanService = await prisma.$queryRaw`
      SELECT COUNT(*) as cnt
      FROM AutoConsumptionRule acr
      LEFT JOIN Service s ON acr.serviceId = s.id
      WHERE acr.serviceId IS NOT NULL AND s.id IS NULL
    `;
    const nullRows = await prisma.$queryRaw`
      SELECT id, tenantId, serviceId, productId, quantityPerVisit, unit, isActive, createdAt, updatedAt
      FROM AutoConsumptionRule
      WHERE productId IS NULL
      LIMIT 20
    `;

    console.log("Total auto_consumption_rules:", total[0].total);
    console.log("Rows with productId IS NULL:", nullProduct[0].cnt);
    console.log("Rows with orphan productId:", orphan[0].cnt);
    console.log("Rows with orphan serviceId:", orphanService[0].cnt);
    console.log("Sample rows with null productId:", JSON.stringify(nullRows, null, 2));
  } catch (e) {
    console.error("Diagnostic failed:", e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
