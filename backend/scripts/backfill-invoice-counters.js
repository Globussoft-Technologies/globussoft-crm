/**
 * Backfill InvoiceCounter rows from existing Sale invoice numbers.
 *
 * Run BEFORE deploying the atomic-counter fix to routes/pos.js so that
 * generateInvoiceNumber() never starts from 1 for a tenant that already
 * has POS sales.
 *
 * Usage:
 *   node backend/scripts/backfill-invoice-counters.js
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function parseInvoiceNumber(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^POS-(\d{4})-(\d+)$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), seq: parseInt(m[2], 10) };
}

async function main() {
  console.log("[backfill] Scanning existing Sale rows...");

  const sales = await prisma.sale.findMany({
    where: { invoiceNumber: { startsWith: "POS-" } },
    select: { tenantId: true, invoiceNumber: true },
  });

  // Group by (tenantId, year) → max seq
  const maxByKey = new Map();
  for (const sale of sales) {
    const parsed = parseInvoiceNumber(sale.invoiceNumber);
    if (!parsed) continue;
    const key = `${sale.tenantId}:${parsed.year}`;
    const current = maxByKey.get(key);
    if (!current || parsed.seq > current.seq) {
      maxByKey.set(key, { tenantId: sale.tenantId, year: parsed.year, seq: parsed.seq });
    }
  }

  console.log(`[backfill] Found ${maxByKey.size} (tenant, year) groups.`);

  let created = 0;
  let skipped = 0;
  for (const { tenantId, year, seq } of maxByKey.values()) {
    const nextSeq = seq + 1; // counter stores "next value to allocate"
    try {
      await prisma.invoiceCounter.upsert({
        where: { tenantId_year: { tenantId, year } },
        update: { nextSeq },
        create: { tenantId, year, nextSeq },
      });
      created++;
    } catch (err) {
      console.error(`[backfill] Failed for tenant=${tenantId} year=${year}:`, err.message);
      skipped++;
    }
  }

  console.log(`[backfill] Done. Created/updated: ${created}, skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("[backfill] Fatal error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
