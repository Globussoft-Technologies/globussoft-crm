#!/usr/bin/env node
// #401 — backfill normalizedPhone on every Patient row before applying
// the @@unique([tenantId, normalizedPhone]) constraint.
//
// Order of operations (run in sequence on the target environment):
//
//   1. Apply schema bump WITHOUT @@unique:
//        Add `normalizedPhone String?` column ONLY (additive, safe).
//        Run: `npx prisma db push --accept-data-loss`
//
//   2. Run THIS script: backend/scripts/backfill-patient-normalized-phone.js
//        Walks every patient, computes normalizedPhone via
//        backend/utils/deduplication.js's normalizePhone(), persists.
//        Idempotent: re-running computes the same value.
//
//   3. Run the existing merge: backend/scripts/merge-duplicate-patients.js
//        Collapses Kavita Reddy × 10 → 1, reattaches all visits/Rx/
//        consents/treatment-plans + referrals (per #265's existing
//        proven merge logic). Without this, step 4 would throw P2002
//        on application of the @@unique constraint.
//
//   4. Apply schema bump WITH @@unique:
//        Run: `npx prisma db push --accept-data-loss`
//        Prisma adds the @@unique([tenantId, normalizedPhone]) index.
//
//   5. Restart pm2 process so backend loads the new client + the
//        DUPLICATE_PHONE error catch in routes/wellness.js POST /patients.
//
// Dry-run by default. Use --apply to actually persist.
//
// Local: node backend/scripts/backfill-patient-normalized-phone.js
// CI:    same; the script reads DATABASE_URL from the env.
const { PrismaClient } = require('@prisma/client');
const { normalizePhone } = require('../utils/deduplication');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

async function main() {
  console.log(`[backfill] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to persist)'}`);
  console.log('');

  const patients = await prisma.patient.findMany({
    select: { id: true, name: true, phone: true, normalizedPhone: true, tenantId: true },
  });

  console.log(`[backfill] scanning ${patients.length} patients`);

  let toUpdate = 0;
  let alreadyOk = 0;
  let nullPhone = 0;
  let noChange = 0;

  for (const p of patients) {
    if (!p.phone) {
      nullPhone++;
      continue;
    }
    const normalized = normalizePhone(p.phone);
    if (p.normalizedPhone === normalized) {
      noChange++;
      continue;
    }
    toUpdate++;
    if (APPLY) {
      try {
        await prisma.patient.update({
          where: { id: p.id },
          data: { normalizedPhone: normalized },
        });
      } catch (e) {
        console.error(`  [error] patient id=${p.id} (tenant=${p.tenantId}): ${e.message}`);
      }
    } else {
      console.log(`  would update id=${p.id} (tenant=${p.tenantId}): "${p.phone}" → normalizedPhone="${normalized}"`);
    }
  }

  console.log('');
  console.log(`[backfill] summary:`);
  console.log(`  toUpdate:    ${toUpdate}`);
  console.log(`  alreadyOk:   ${noChange}`);
  console.log(`  nullPhone:   ${nullPhone} (left as null — these can't enforce uniqueness)`);
  console.log(`  total:       ${patients.length}`);
  console.log('');

  // Pre-flight check: how many duplicate (tenantId, normalizedPhone) pairs
  // would the @@unique constraint reject? This count tells the operator
  // whether the merge step needs to run before applying the constraint.
  const dupes = await prisma.$queryRawUnsafe(`
    SELECT tenantId, normalizedPhone, COUNT(*) AS cnt
    FROM Patient
    WHERE normalizedPhone IS NOT NULL
    GROUP BY tenantId, normalizedPhone
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 50
  `);

  if (dupes.length > 0) {
    console.log('[backfill] WARNING: duplicate (tenantId, normalizedPhone) pairs detected:');
    for (const d of dupes) {
      console.log(`  tenant=${d.tenantId} phone=${d.normalizedPhone} count=${Number(d.cnt)}`);
    }
    console.log('');
    console.log('Run backend/scripts/merge-duplicate-patients.js BEFORE applying the @@unique constraint.');
    console.log('Otherwise `prisma db push` will fail with a unique-constraint-violation error.');
  } else {
    console.log('[backfill] no duplicate (tenantId, normalizedPhone) pairs — safe to apply @@unique.');
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[backfill] FATAL:', e.message);
  process.exit(2);
});
