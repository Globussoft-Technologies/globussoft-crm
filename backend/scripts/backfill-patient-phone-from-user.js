/**
 * Backfill Patient.phone from the linked User account.
 *
 * WHY
 *   A wellness customer who self-books gets a Patient row linked to their
 *   User via Patient.userId. The three self-booking code paths in
 *   routes/wellness.js synced `name` and `email` onto that row but never
 *   `phone`, so a self-booked patient showed a blank phone in the Patients
 *   list, had nowhere to send reminders, and could not be called from the
 *   Appointments page.
 *
 *   lib/selfBookingPatient.js fixes this going forward. This script repairs
 *   the rows that were created before the fix.
 *
 * SAFETY
 *   - Only fills a Patient whose phone is NULL or empty. An existing patient
 *     phone is NEVER overwritten — the clinic's own record wins over whatever
 *     the customer typed on their profile.
 *   - Only ever matches within a tenant (Patient.tenantId = User.tenantId).
 *   - Idempotent: a second run finds nothing left to do.
 *   - `--dry-run` prints the plan without writing.
 *
 * USAGE
 *   node scripts/backfill-patient-phone-from-user.js --dry-run
 *   node scripts/backfill-patient-phone-from-user.js
 */

const prisma = require('../lib/prisma');
const { normalizePhone } = require('../utils/deduplication');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`[backfill-patient-phone] ${DRY_RUN ? 'DRY RUN — no writes' : 'applying changes'}`);

  // Candidates: a linked user has a phone, the patient does not.
  const candidates = await prisma.$queryRawUnsafe(`
    SELECT u.id AS userId, u.tenantId, u.name AS userName, u.phone AS userPhone,
           p.id AS patientId, p.name AS patientName, p.phone AS patientPhone
    FROM User u
    JOIN Patient p ON p.userId = u.id AND p.tenantId = u.tenantId
    WHERE u.phone IS NOT NULL
      AND u.phone <> ''
      AND (p.phone IS NULL OR p.phone = '')
      AND p.deletedAt IS NULL
    ORDER BY u.tenantId, p.id
  `);

  if (candidates.length === 0) {
    console.log('[backfill-patient-phone] nothing to do — every linked patient already has a phone.');
    await prisma.$disconnect();
    return;
  }

  console.log(`[backfill-patient-phone] ${candidates.length} patient(s) to fill:`);
  for (const row of candidates) {
    console.log(
      `  tenant=${row.tenantId} patient=${row.patientId} "${row.patientName}" <- user=${row.userId} ${row.userPhone}`,
    );
  }

  if (DRY_RUN) {
    console.log('[backfill-patient-phone] dry run complete — re-run without --dry-run to apply.');
    await prisma.$disconnect();
    return;
  }

  let filled = 0;
  let failed = 0;
  for (const row of candidates) {
    try {
      await prisma.patient.update({
        where: { id: Number(row.patientId) },
        data: {
          phone: row.userPhone,
          normalizedPhone: normalizePhone(row.userPhone),
        },
      });
      filled += 1;
    } catch (e) {
      failed += 1;
      console.error(`[backfill-patient-phone] patient ${row.patientId} failed: ${e.message}`);
    }
  }

  console.log(`[backfill-patient-phone] done — filled ${filled}, failed ${failed}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[backfill-patient-phone] FATAL:', e.message);
  process.exit(2);
});
