/**
 * One-time scrub of E2E / Playwright / manual-test pollution from the demo DB.
 *
 * Targets ONLY rows whose name/title/subject matches obvious test markers, never
 * real data. Patterns covered (caught from the QA pass in #120):
 *
 *   - "Test ..."             → "Test Patient 001 1777..."
 *   - "E2E ..."              → "E2E Branch 1776..."
 *   - "CRM Test ..."         → "CRM Test Branch 1777..."
 *   - "Race ..."             → "Race Patient A 1776..."
 *   - "Dedupe ..."           → "Dedupe Race"
 *   - "Playwright ..."       → "Playwright Test 1777..."
 *   - "Coverage ..."         → "Coverage Patient ..."
 *   - / 17[67]\d{10,11}$/    → 13-digit unix-ms timestamp suffix
 *
 * Email-shape markers:
 *   - @racecond.test
 *   - dup-…@... (race-condition dedupe tests)
 *   - valid-17……@example.com
 *   - @e2e.test
 *
 * Models swept: Location, Contact, Patient, Estimate, EmailMessage, CallLog.
 *
 * Defaults to DRY-RUN; pass --apply to mutate. Safe to re-run. Cross-tenant by
 * design (test pollution exists on both generic + wellness tenants).
 *
 * Usage:
 *   node backend/scripts/scrub-test-data-pollution.js          # report only
 *   node backend/scripts/scrub-test-data-pollution.js --apply  # actually scrub
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env"), override: true });

const prisma = require("../lib/prisma");

const APPLY = process.argv.includes("--apply");

const TEST_NAME_PATTERNS = [
  /^Test /,                  // "Test Lead 001 ..."
  /^E2E /,                   // "E2E Branch ..."
  / E2E /,                   // "Foo E2E Bar"
  /CRM Test/i,
  /^Race /,                  // "Race Patient A"
  /^Dedupe /i,
  /^Playwright/i,
  /^Coverage /,
  / 17[67]\d{10,11}$/,       // 13-digit unix-ms timestamp suffix
];

const TEST_EMAIL_PATTERNS = [
  /@racecond\.test$/i,
  /^dup-/i,
  /^valid-17[67]\d/,
  /@e2e\.test$/i,
];

const isTestName = (s) =>
  typeof s === "string" && s.length > 0 && TEST_NAME_PATTERNS.some((p) => p.test(s));
const isTestEmail = (s) =>
  typeof s === "string" && s.length > 0 && TEST_EMAIL_PATTERNS.some((p) => p.test(s));

function previewRows(rows, formatter, max = 5) {
  for (const r of rows.slice(0, max)) console.log(`     ${formatter(r)}`);
  if (rows.length > max) console.log(`     ... +${rows.length - max} more`);
}

async function scrubLocations() {
  const all = await prisma.location.findMany({ select: { id: true, name: true, tenantId: true } });
  const bad = all.filter((r) => isTestName(r.name));
  console.log(`Locations: ${bad.length} of ${all.length} are test rows`);
  if (bad.length) {
    previewRows(bad, (r) => `loc ${r.id} (tenant ${r.tenantId}): "${r.name}"`);
    if (APPLY) {
      const r = await prisma.location.deleteMany({ where: { id: { in: bad.map((x) => x.id) } } });
      console.log(`     → DELETED ${r.count} locations (Patient.locationId / Visit.locationId set to NULL by FK)`);
    }
  }
  return bad.length;
}

async function scrubContacts() {
  const all = await prisma.contact.findMany({ select: { id: true, name: true, email: true, tenantId: true } });
  const bad = all.filter((r) => isTestName(r.name) || isTestEmail(r.email));
  console.log(`Contacts: ${bad.length} of ${all.length} are test rows`);
  if (bad.length) {
    previewRows(bad, (r) => `contact ${r.id} (tenant ${r.tenantId}): "${r.name}" <${r.email}>`);
    if (APPLY) {
      // Cascades to Invoice (Cascade), Activity (Cascade), Task (SetNull), Deal (SetNull).
      // Test contacts shouldn't have real invoices, but acknowledging the cascade.
      const r = await prisma.contact.deleteMany({ where: { id: { in: bad.map((x) => x.id) } } });
      console.log(`     → DELETED ${r.count} contacts (cascaded to invoices/activities, set null on deals/tasks)`);
    }
  }
  return bad.length;
}

async function scrubPatients() {
  const all = await prisma.patient.findMany({ select: { id: true, name: true, phone: true, tenantId: true } });
  const bad = all.filter((r) => isTestName(r.name));
  console.log(`Patients: ${bad.length} of ${all.length} are test rows`);
  if (bad.length) {
    previewRows(bad, (r) => `patient ${r.id} (tenant ${r.tenantId}): "${r.name}" phone=${r.phone || "—"}`);
    if (APPLY) {
      // Cascades to Visit, Prescription, ConsentForm, TreatmentPlan, Waitlist,
      // LoyaltyTransaction, Referral. All test artifacts; safe.
      const r = await prisma.patient.deleteMany({ where: { id: { in: bad.map((x) => x.id) } } });
      console.log(`     → DELETED ${r.count} patients (cascaded visits/Rx/consents/plans)`);
    }
  }
  return bad.length;
}

async function scrubEstimates() {
  const all = await prisma.estimate.findMany({ select: { id: true, title: true, tenantId: true, totalAmount: true } });
  const bad = all.filter((r) => isTestName(r.title));
  console.log(`Estimates: ${bad.length} of ${all.length} are test rows`);
  if (bad.length) {
    previewRows(bad, (r) => `est ${r.id} (tenant ${r.tenantId}): "${r.title}" ₹${r.totalAmount || 0}`);
    if (APPLY) {
      const r = await prisma.estimate.deleteMany({ where: { id: { in: bad.map((x) => x.id) } } });
      console.log(`     → DELETED ${r.count} estimates (cascaded line items)`);
    }
  }
  return bad.length;
}

async function scrubEmails() {
  // EmailMessage may have hundreds; keep it lean by selecting only fields we need.
  const all = await prisma.emailMessage.findMany({
    select: { id: true, subject: true, body: true, tenantId: true },
    take: 5000,
  });
  const bad = all.filter((r) => isTestName(r.subject) || (r.body && /E2E test email|Playwright/i.test(r.body)));
  console.log(`EmailMessages (first 5000): ${bad.length} are test rows`);
  if (bad.length) {
    previewRows(bad, (r) => `email ${r.id} (tenant ${r.tenantId}): "${r.subject || "(no subject)"}"`);
    if (APPLY) {
      const r = await prisma.emailMessage.deleteMany({ where: { id: { in: bad.map((x) => x.id) } } });
      console.log(`     → DELETED ${r.count} emails`);
    }
  }
  return bad.length;
}

async function scrubCallLogs() {
  // CallLog has no `summary` field — notes is the closest free-text. Transcript
  // URL is stored under recordingUrl (the schema doesn't have transcriptUrl).
  const all = await prisma.callLog.findMany({
    select: { id: true, notes: true, recordingUrl: true, tenantId: true },
    take: 5000,
  });
  const bad = all.filter((r) =>
    isTestName(r.notes) ||
    (r.recordingUrl && /\/e2e\.txt$/i.test(r.recordingUrl)) ||
    (r.notes && /E2E smoke test|callified\.ai\/tx\/e2e\.txt/i.test(r.notes))
  );
  console.log(`CallLogs (first 5000): ${bad.length} are test rows`);
  if (bad.length) {
    previewRows(bad, (r) => `call ${r.id} (tenant ${r.tenantId}): "${(r.notes || "(no notes)").slice(0, 60)}"`);
    if (APPLY) {
      const r = await prisma.callLog.deleteMany({ where: { id: { in: bad.map((x) => x.id) } } });
      console.log(`     → DELETED ${r.count} call logs`);
    }
  }
  return bad.length;
}

async function main() {
  console.log(`Mode: ${APPLY ? "\x1b[31mAPPLY (mutating)\x1b[0m" : "\x1b[36mDRY-RUN (no changes)\x1b[0m"}`);
  console.log("Patterns matched: Test*, E2E*, CRM Test*, Race*, Dedupe*, Playwright*, Coverage*, *<13-digit-timestamp>, @racecond.test, dup-*, valid-17*@*, @e2e.test");
  console.log("");

  const counts = {
    locations: await scrubLocations(),
    contacts: await scrubContacts(),
    patients: await scrubPatients(),
    estimates: await scrubEstimates(),
    emails: await scrubEmails(),
    callLogs: await scrubCallLogs(),
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log("");
  console.log("───────────────────────────────────────────────────────────");
  console.log(`Total test rows ${APPLY ? "scrubbed" : "found"}: ${total}`);
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
