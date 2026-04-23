/**
 * Backfill: encrypt PII fields on existing wellness rows.
 *
 * Reads all rows for wellness tenants and encrypts these fields if they're
 * not already encrypted (detected by the ENC:v1: prefix via isEncrypted):
 *   Patient.allergies, Patient.notes
 *   Visit.notes, Visit.vitals
 *   Prescription.drugs, Prescription.instructions
 *   ConsentForm.signatureSvg
 *
 * Idempotent — re-running is safe (already-encrypted rows are skipped).
 *
 * Requires WELLNESS_FIELD_KEY in env. If missing, this script aborts.
 *
 * Usage:
 *   node backend/scripts/encrypt-existing-pii.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

// IMPORTANT: bypass the wrapped client (which auto-decrypts on read) so we
// see the raw ciphertext/plaintext. Use the raw PrismaClient directly.
const { PrismaClient } = require('@prisma/client');
const { encrypt, isEncrypted } = require('../lib/fieldEncryption');

const prisma = new PrismaClient();

async function getWellnessTenantIds() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: 'wellness' },
    select: { id: true, slug: true },
  });
  return tenants;
}

function pickEncrypt(value) {
  if (value == null || value === '') return { changed: false, value };
  if (typeof value !== 'string') return { changed: false, value };
  if (isEncrypted(value)) return { changed: false, value };
  const enc = encrypt(value);
  // If encryption is disabled (no key), encrypt() returns the plaintext —
  // detect that case so we don't claim a backfill happened.
  if (enc === value) return { changed: false, value };
  return { changed: true, value: enc };
}

async function backfillPatients(tenantId) {
  let updated = 0;
  const rows = await prisma.patient.findMany({
    where: { tenantId },
    select: { id: true, allergies: true, notes: true },
  });
  for (const row of rows) {
    const a = pickEncrypt(row.allergies);
    const n = pickEncrypt(row.notes);
    if (a.changed || n.changed) {
      await prisma.patient.update({
        where: { id: row.id },
        data: {
          ...(a.changed ? { allergies: a.value } : {}),
          ...(n.changed ? { notes: n.value } : {}),
        },
      });
      updated++;
    }
  }
  return updated;
}

async function backfillVisits(tenantId) {
  let updated = 0;
  const rows = await prisma.visit.findMany({
    where: { tenantId },
    select: { id: true, notes: true, vitals: true },
  });
  for (const row of rows) {
    const n = pickEncrypt(row.notes);
    const v = pickEncrypt(row.vitals);
    if (n.changed || v.changed) {
      await prisma.visit.update({
        where: { id: row.id },
        data: {
          ...(n.changed ? { notes: n.value } : {}),
          ...(v.changed ? { vitals: v.value } : {}),
        },
      });
      updated++;
    }
  }
  return updated;
}

async function backfillPrescriptions(tenantId) {
  let updated = 0;
  const rows = await prisma.prescription.findMany({
    where: { tenantId },
    select: { id: true, drugs: true, instructions: true },
  });
  for (const row of rows) {
    const d = pickEncrypt(row.drugs);
    const i = pickEncrypt(row.instructions);
    if (d.changed || i.changed) {
      await prisma.prescription.update({
        where: { id: row.id },
        data: {
          ...(d.changed ? { drugs: d.value } : {}),
          ...(i.changed ? { instructions: i.value } : {}),
        },
      });
      updated++;
    }
  }
  return updated;
}

async function backfillConsents(tenantId) {
  let updated = 0;
  const rows = await prisma.consentForm.findMany({
    where: { tenantId },
    select: { id: true, signatureSvg: true },
  });
  for (const row of rows) {
    const s = pickEncrypt(row.signatureSvg);
    if (s.changed) {
      await prisma.consentForm.update({
        where: { id: row.id },
        data: { signatureSvg: s.value },
      });
      updated++;
    }
  }
  return updated;
}

async function main() {
  if (!process.env.WELLNESS_FIELD_KEY) {
    console.error('[encrypt] WELLNESS_FIELD_KEY is not set — aborting (would be a no-op).');
    process.exit(1);
  }

  const tenants = await getWellnessTenantIds();
  if (tenants.length === 0) {
    console.log('[encrypt] no wellness tenants found.');
    return;
  }

  let totalP = 0, totalV = 0, totalRx = 0, totalC = 0;
  for (const t of tenants) {
    const p = await backfillPatients(t.id);
    const v = await backfillVisits(t.id);
    const rx = await backfillPrescriptions(t.id);
    const c = await backfillConsents(t.id);
    totalP += p; totalV += v; totalRx += rx; totalC += c;
    if (p || v || rx || c) {
      console.log(`[encrypt] tenant ${t.slug}: ${p} patients, ${v} visits, ${rx} prescriptions, ${c} consents`);
    }
  }
  console.log(`[encrypt] backfilled ${totalP} patients, ${totalV} visits, ${totalRx} prescriptions, ${totalC} consents`);
}

main()
  .catch((e) => {
    console.error('[encrypt] fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
