// Read-only forensic diagnostic for the 2026-06-05 audit-chain genesis-mismatch
// incident. Walks EVERY row of every affected tenant's audit chain WITHOUT
// stopping at the first failure (unlike GET /api/audit/verify and
// POST /api/audit/backfill, which both `break` on the first broken row — see
// backend/routes/audit.js and backend/lib/audit.js). This gives the complete,
// exact set of rows that actually need a hash reset, instead of guessing
// between "just the head row" and "every row for the tenant."
//
// ZERO WRITES. This script only reads and reports. It reuses the exact
// canonicalize/computeHash/genesisFor functions from lib/audit.js so the
// diagnosis is byte-for-byte consistent with the real app logic — no
// reimplementation drift.
//
// Usage (point at whichever database you want to inspect — defaults to
// whatever DATABASE_URL is already set to, e.g. via backend/.env):
//   DATABASE_URL="mysql://root@127.0.0.1:3306/gbscrm_prod_backup" \
//     node backend/scripts/diagnose-audit-genesis-mismatch.js

const path = require("path");
// NOTE: no { override: true } here on purpose — if the caller has already
// set DATABASE_URL on the command line (the intended usage), that value
// must win over whatever's in .env. dotenv's default behavior only fills in
// variables that aren't already set, which is exactly what we want.
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { PrismaClient } = require("@prisma/client");
const { computeHash, genesisFor } = require("../lib/audit");

const prisma = new PrismaClient();

async function main() {
  console.log(`[diagnose] Connected to: ${(process.env.DATABASE_URL || "").replace(/:[^:@]*@/, ":****@")}`);

  // Which tenants have at least one row referencing the wrong genesis?
  const flagged = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT tenantId FROM AuditLog
    WHERE prevHash LIKE 'GENESIS\\_%' ESCAPE '\\\\'
      AND prevHash != CONCAT('GENESIS_', tenantId)
  `);
  const tenantIds = flagged.map((r) => Number(r.tenantId)).sort((a, b) => a - b);

  console.log(`[diagnose] ${tenantIds.length} tenant(s) have at least one genesis-mismatch row.\n`);

  const summary = {
    tenantsWalked: 0,
    cleanRows: 0,
    forkOnlyRows: 0, // safe: content intact, just mis-linked — auto-repairable
    contentMismatchRows: 0, // needs a manual hash/prevHash reset before repair
    nullHashRows: 0, // already unhashed — repair handles these natively
  };
  const contentMismatchDetail = [];
  const forkOnlyDetail = [];

  for (const tenantId of tenantIds) {
    summary.tenantsWalked += 1;

    const rows = await prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, action: true, entity: true, entityId: true,
        userId: true, details: true, createdAt: true,
        prevHash: true, hash: true,
      },
    });

    let lastHash = null; // simulated — carries forward the "would-be-correct" hash

    for (const row of rows) {
      const expectedPrev = lastHash == null ? genesisFor(tenantId) : lastHash;
      const payload = {
        tenantId, entity: row.entity, action: row.action, entityId: row.entityId,
        userId: row.userId, details: row.details, createdAt: row.createdAt.toISOString(),
      };
      const recomputed = computeHash(expectedPrev, payload);

      if (row.hash == null) {
        summary.nullHashRows += 1;
        lastHash = recomputed; // simulate: backfill would stamp this fresh
        continue;
      }

      const recomputedWithStoredPrev = computeHash(row.prevHash, payload);
      if (recomputedWithStoredPrev !== row.hash) {
        // This row's OWN stored hash disagrees with its own stored prevHash +
        // its own current content — this is exactly what the real backfill
        // throws a 409 on. Report it, but KEEP WALKING (simulate as if it had
        // been reset + freshly recomputed) so we can see the full cascade.
        summary.contentMismatchRows += 1;
        contentMismatchDetail.push({
          tenantId, id: row.id, action: row.action, entity: row.entity,
          createdAt: row.createdAt.toISOString(), storedPrevHash: row.prevHash,
        });
        lastHash = recomputed; // simulate a reset+recompute so the walk can continue
        continue;
      }

      if (row.prevHash !== expectedPrev) {
        // Content is intact, just mis-linked (the "fork" case) — the existing
        // backfill already auto-repairs this safely, no manual reset needed.
        summary.forkOnlyRows += 1;
        forkOnlyDetail.push({ tenantId, id: row.id, createdAt: row.createdAt.toISOString() });
        lastHash = recomputed;
        continue;
      }

      // Already correctly chained.
      summary.cleanRows += 1;
      lastHash = row.hash;
    }
  }

  console.log("=== SUMMARY ===");
  console.log(`Tenants walked:            ${summary.tenantsWalked}`);
  console.log(`Clean rows:                ${summary.cleanRows}`);
  console.log(`Null-hash rows (legacy):   ${summary.nullHashRows}  (repair handles natively)`);
  console.log(`Fork-only rows:            ${summary.forkOnlyRows}  (repair auto-fixes safely)`);
  console.log(`Content-mismatch rows:     ${summary.contentMismatchRows}  (NEED a manual hash reset first)`);
  console.log("");

  if (contentMismatchDetail.length) {
    console.log("=== Rows needing a manual hash/prevHash reset (content-mismatch) ===");
    console.table(contentMismatchDetail);
    console.log("\nExact IDs (paste into a targeted UPDATE if you don't want to touch fork-only rows):");
    console.log(contentMismatchDetail.map((r) => r.id).join(", "));
  } else {
    console.log("No content-mismatch rows found — every broken row is a safe fork-only case.");
  }
}

main()
  .catch((e) => {
    console.error("[diagnose] error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
