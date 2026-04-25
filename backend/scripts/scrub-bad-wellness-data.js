/**
 * One-time scrub of pre-validation bad data from wellness tenants.
 *
 * Cleans up the rows that batch 1 fixes (#108, #109, #114, #115, #118) now
 * prevent at the API layer but that were already in the DB:
 *
 *   1. Visit.amountCharged < 0       → set to NULL  (#109 negative charges)
 *   2. Service.basePrice <= 0        → set isActive = false  (#115 ₹0 services)
 *      (we don't delete because existing visits/treatment plans reference them)
 *   3. Patient.phone failing validator → set to NULL  (#108 garbage phones)
 *   4. ConsentForm with blank/short signatureSvg → DELETE  (#118 fake consents,
 *      legal/compliance — better deleted than left as fraudulent records)
 *   5. Prescription where drugs has 0 named entries → DELETE  (#114 phantom Rx)
 *
 * Defaults to DRY-RUN; pass --apply to actually mutate. Re-runnable / idempotent
 * (already-scrubbed rows match no filter on the second pass).
 *
 * Usage:
 *   node backend/scripts/scrub-bad-wellness-data.js          # report only
 *   node backend/scripts/scrub-bad-wellness-data.js --apply  # actually scrub
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env"), override: true });

// Use the wrapped client so encrypted PII fields decrypt transparently.
// We don't write back any encrypted field, so this is safe.
const prisma = require("../lib/prisma");

const APPLY = process.argv.includes("--apply");
const SIG_MIN_LEN = 500; // mirror backend validation in routes/wellness.js POST /consents

const isValidPhoneOrEmpty = (p) => {
  if (p == null || p === "") return true;
  if (typeof p !== "string") return false;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
};

function parseDrugs(raw) {
  if (raw == null) return [];
  if (typeof raw === "object") return Array.isArray(raw) ? raw : [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function hasNamedDrug(arr) {
  return arr.some((d) => d && typeof d.name === "string" && d.name.trim().length > 0);
}

async function getTenants() {
  return prisma.tenant.findMany({
    where: { vertical: "wellness" },
    select: { id: true, slug: true, name: true },
  });
}

async function scrubNegativeVisits(tenantIds) {
  const rows = await prisma.visit.findMany({
    where: { tenantId: { in: tenantIds }, amountCharged: { lt: 0 } },
    select: { id: true, amountCharged: true, patientId: true, visitDate: true },
  });
  console.log(`#109 Visits with negative amountCharged: ${rows.length}`);
  if (rows.length) {
    for (const r of rows.slice(0, 5)) {
      console.log(`     visit ${r.id} (patient ${r.patientId}, ${r.visitDate.toISOString().slice(0, 10)}): ₹${r.amountCharged}`);
    }
    if (rows.length > 5) console.log(`     ... +${rows.length - 5} more`);
    if (APPLY) {
      const r = await prisma.visit.updateMany({
        where: { id: { in: rows.map((v) => v.id) } },
        data: { amountCharged: null },
      });
      console.log(`     → set amountCharged = NULL on ${r.count} row(s)`);
    }
  }
  return rows.length;
}

async function scrubZeroPriceServices(tenantIds) {
  const rows = await prisma.service.findMany({
    where: {
      tenantId: { in: tenantIds },
      basePrice: { lte: 0 },
      isActive: true,
    },
    select: { id: true, name: true, basePrice: true, category: true },
  });
  console.log(`#115 Active services with basePrice <= 0: ${rows.length}`);
  if (rows.length) {
    for (const r of rows.slice(0, 5)) {
      console.log(`     service ${r.id} "${r.name}" (${r.category}): ₹${r.basePrice}`);
    }
    if (rows.length > 5) console.log(`     ... +${rows.length - 5} more`);
    if (APPLY) {
      const r = await prisma.service.updateMany({
        where: { id: { in: rows.map((s) => s.id) } },
        data: { isActive: false },
      });
      console.log(`     → deactivated ${r.count} row(s) (kept rows so historical visits/plans still resolve)`);
    }
  }
  return rows.length;
}

async function scrubBadPhones(tenantIds) {
  // Phone validation requires JS-side regex, so fetch and filter.
  const rows = await prisma.patient.findMany({
    where: { tenantId: { in: tenantIds }, phone: { not: null } },
    select: { id: true, name: true, phone: true },
  });
  const bad = rows.filter((p) => !isValidPhoneOrEmpty(p.phone));
  console.log(`#108 Patients with malformed phone: ${bad.length} (of ${rows.length} with phone set)`);
  if (bad.length) {
    for (const r of bad.slice(0, 5)) {
      console.log(`     patient ${r.id} "${r.name}": phone=${JSON.stringify(r.phone)}`);
    }
    if (bad.length > 5) console.log(`     ... +${bad.length - 5} more`);
    if (APPLY) {
      const r = await prisma.patient.updateMany({
        where: { id: { in: bad.map((p) => p.id) } },
        data: { phone: null },
      });
      console.log(`     → set phone = NULL on ${r.count} row(s) (patients kept; phone was optional anyway)`);
    }
  }
  return bad.length;
}

async function scrubBlankConsents(tenantIds) {
  // signatureSvg is auto-decrypted by the wrapped Prisma client, so length
  // here is on plaintext — same threshold the backend uses to reject creates.
  const rows = await prisma.consentForm.findMany({
    where: { tenantId: { in: tenantIds } },
    select: { id: true, templateName: true, patientId: true, signatureSvg: true, signedAt: true },
  });
  const bad = rows.filter((c) => {
    const s = c.signatureSvg;
    return !s || typeof s !== "string" || s.length < SIG_MIN_LEN;
  });
  console.log(`#118 Consents with blank/short signature (< ${SIG_MIN_LEN} chars): ${bad.length} (of ${rows.length} total)`);
  if (bad.length) {
    for (const r of bad.slice(0, 5)) {
      const len = r.signatureSvg ? r.signatureSvg.length : 0;
      console.log(`     consent ${r.id} (patient ${r.patientId}, ${r.templateName}, ${r.signedAt.toISOString().slice(0, 10)}): sig length = ${len}`);
    }
    if (bad.length > 5) console.log(`     ... +${bad.length - 5} more`);
    if (APPLY) {
      const r = await prisma.consentForm.deleteMany({
        where: { id: { in: bad.map((c) => c.id) } },
      });
      console.log(`     → DELETED ${r.count} row(s) (fake consents are worse than no consents)`);
    }
  }
  return bad.length;
}

async function scrubEmptyPrescriptions(tenantIds) {
  const rows = await prisma.prescription.findMany({
    where: { tenantId: { in: tenantIds } },
    select: { id: true, drugs: true, patientId: true, visitId: true, createdAt: true },
  });
  const bad = rows.filter((rx) => !hasNamedDrug(parseDrugs(rx.drugs)));
  console.log(`#114 Prescriptions with no named drug: ${bad.length} (of ${rows.length} total)`);
  if (bad.length) {
    for (const r of bad.slice(0, 5)) {
      console.log(`     rx ${r.id} (patient ${r.patientId}, visit ${r.visitId}, ${r.createdAt.toISOString().slice(0, 10)}): drugs=${r.drugs?.slice(0, 80)}`);
    }
    if (bad.length > 5) console.log(`     ... +${bad.length - 5} more`);
    if (APPLY) {
      const r = await prisma.prescription.deleteMany({
        where: { id: { in: bad.map((rx) => rx.id) } },
      });
      console.log(`     → DELETED ${r.count} row(s) (phantom Rx with no medication)`);
    }
  }
  return bad.length;
}

async function main() {
  const tenants = await getTenants();
  if (tenants.length === 0) {
    console.log("No wellness tenants found — nothing to scrub.");
    return;
  }
  const tenantIds = tenants.map((t) => t.id);
  console.log(`Mode: ${APPLY ? "\x1b[31mAPPLY (mutating)\x1b[0m" : "\x1b[36mDRY-RUN (no changes)\x1b[0m"}`);
  console.log(`Wellness tenants in scope: ${tenants.map((t) => `${t.slug} (id=${t.id})`).join(", ")}`);
  console.log("");

  const counts = {
    negativeVisits: await scrubNegativeVisits(tenantIds),
    zeroPriceServices: await scrubZeroPriceServices(tenantIds),
    badPhones: await scrubBadPhones(tenantIds),
    blankConsents: await scrubBlankConsents(tenantIds),
    emptyPrescriptions: await scrubEmptyPrescriptions(tenantIds),
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log("");
  console.log("───────────────────────────────────────────────────────────");
  console.log(`Total bad rows ${APPLY ? "scrubbed" : "found"}: ${total}`);
  if (!APPLY && total > 0) {
    console.log("Re-run with --apply to commit the changes.");
  }
}

main()
  .catch((e) => {
    console.error("[scrub] fatal:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
