#!/usr/bin/env node
//
// Pre-migration safety check for WhatsApp SaaS P1.
//
// ┌────────────────────────────────────────────────────────────────────┐
// │ READ-ONLY. THIS SCRIPT DOES NOT MODIFY, DELETE, OR INSERT ANY ROW. │
// │ Safe to run on production. Run before `prisma migrate deploy`.     │
// └────────────────────────────────────────────────────────────────────┘
//
// Why this exists:
//   The WhatsApp SaaS P1 migration adds `@unique` to
//   WhatsAppConfig.phoneNumberId. If any existing rows would violate the
//   constraint, the ALTER TABLE statement fails mid-migration and leaves
//   the table in a half-applied state. This script audits the current
//   data and reports any conflicts so they can be resolved BEFORE the
//   migration runs.
//
// What it does:
//   1. Counts WhatsAppConfig rows.
//   2. Finds rows where phoneNumberId = '' (these would collide once
//      @unique applies — MySQL treats empty string as a distinct value).
//   3. Finds rows where the same non-empty phoneNumberId appears on more
//      than one row (across any tenant/provider combination).
//
// What it does NOT do:
//   - It does not UPDATE, DELETE, or INSERT anything.
//   - It does not "fix" duplicates automatically. The repair is intentionally
//     left to a human because the correct resolution depends on which row
//     genuinely owns the phone number — only a human knows that.
//
// Usage:
//   node scripts/check-whatsapp-phone-uniqueness.js
//
// Exit codes:
//   0  — safe to migrate (no conflicts)
//   1  — conflicts found (printed to stdout for manual resolution)
//   2  — DB connection failure (no inspection performed)
//

const prisma = require("../lib/prisma");

async function main() {
  console.log("[wa-phone-uniqueness-check] starting (READ-ONLY)…");

  let totalConfigs;
  try {
    totalConfigs = await prisma.whatsAppConfig.count();
  } catch (err) {
    console.error("[wa-phone-uniqueness-check] DB connection failed:", err.message);
    process.exit(2);
  }

  console.log(`[wa-phone-uniqueness-check] inspecting ${totalConfigs} WhatsAppConfig row(s)`);

  const emptyStrings = await prisma.whatsAppConfig.findMany({
    where: { phoneNumberId: "" },
    select: { id: true, tenantId: true, provider: true, isActive: true },
  });

  const populated = await prisma.whatsAppConfig.findMany({
    where: {
      AND: [
        { phoneNumberId: { not: null } },
        { phoneNumberId: { not: "" } },
      ],
    },
    select: { id: true, tenantId: true, provider: true, phoneNumberId: true, isActive: true },
  });

  const byPhone = new Map();
  for (const row of populated) {
    const key = row.phoneNumberId;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(row);
  }

  const duplicates = [...byPhone.entries()].filter(([, rows]) => rows.length > 1);

  if (emptyStrings.length === 0 && duplicates.length === 0) {
    console.log("[wa-phone-uniqueness-check] ✅ safe to migrate (no duplicates)");
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log("");
  console.log("[wa-phone-uniqueness-check] ❌ migration would FAIL — duplicates present:");
  console.log("");

  if (emptyStrings.length > 0) {
    console.log(`  Empty-string phoneNumberId (${emptyStrings.length} row(s)) — will collide once @unique applies:`);
    for (const r of emptyStrings) {
      console.log(`    - id=${r.id}  tenantId=${r.tenantId}  provider=${r.provider}  isActive=${r.isActive}`);
    }
    console.log("");
    console.log("  Suggested manual fix (review before running):");
    console.log("    UPDATE WhatsAppConfig SET phoneNumberId = NULL WHERE phoneNumberId = '';");
    console.log("  This is non-destructive — NULLing an already-empty field loses no information.");
    console.log("");
  }

  if (duplicates.length > 0) {
    console.log(`  Duplicate phoneNumberId across rows (${duplicates.length} group(s)):`);
    for (const [phone, rows] of duplicates) {
      console.log(`    phoneNumberId="${phone}"`);
      for (const r of rows) {
        console.log(`      - id=${r.id}  tenantId=${r.tenantId}  provider=${r.provider}  isActive=${r.isActive}`);
      }
    }
    console.log("");
    console.log("  Resolution (manual — review each group):");
    console.log("    • Identify which row genuinely owns the phone number (usually the");
    console.log("      isActive=true row, or the most recently used tenant).");
    console.log("    • Clear or correct phoneNumberId on the OTHER rows.");
    console.log("    • Re-run this script until it exits 0.");
    console.log("    Meta itself does not allow a single phone_number_id to belong to");
    console.log("    multiple WABAs, so these duplicates are either test data or a");
    console.log("    misconfiguration — resolving them is a correctness improvement, not");
    console.log("    a destructive operation.");
    console.log("");
  }

  await prisma.$disconnect();
  process.exit(1);
}

main().catch(async (err) => {
  console.error("[wa-phone-uniqueness-check] unexpected error:", err);
  try { await prisma.$disconnect(); } catch (_) { /* ignore */ }
  process.exit(2);
});
