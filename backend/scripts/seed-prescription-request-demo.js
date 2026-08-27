#!/usr/bin/env node
/**
 * Demo/E2E seed for the prescription + renewal-request surfaces.
 *
 * Fills one customer account with enough clinical history to actually exercise
 * the features end to end:
 *   - N prescriptions (default 60) spread over the past ~2 years, each on its
 *     own completed Visit, with varied drug counts and prescribers. 60 rows
 *     beats every page size the Prescriptions list offers (25 / 50 / 100 /
 *     200), so pagination, the page counter and prev/next all have something
 *     to do.
 *   - A validity on most prescriptions (30 / 60 / 90 days, every fourth left
 *     blank) so both the "lapses on <date>" and the "no stated validity" paths
 *     are visible.
 *   - One renewal request in EACH status (PENDING / ACCEPTED / COMPLETED /
 *     REJECTED), so the staff queue's status tabs, badge counts and the
 *     closed-request "Outcome" panel all render with real rows.
 *   - The PENDING one is a partial (specific-medicine) request and the others
 *     vary, so `isFullPrescription` is exercised both ways.
 *   - Each request carries its status history, and the closed ones carry a
 *     reviewer + review note.
 *
 * The customer must be linked to a Patient row (Patient.userId). If they are
 * not, this script says so and stops rather than inventing a second clinical
 * record for them — that link is a real clinical decision, not seed data.
 *
 * Usage (from backend/):
 *   node scripts/seed-prescription-request-demo.js --email=mohit@getmule.com
 *   node scripts/seed-prescription-request-demo.js --patient=2965 --count=120
 *   node scripts/seed-prescription-request-demo.js --email=... --wipe
 *
 * Flags:
 *   --email=<addr>    customer User to seed for (resolved to their Patient)
 *   --patient=<id>    target the Patient row directly instead
 *   --tenant=<id>     tenant to seed in (default 1)
 *   --count=<n>       prescriptions to create (default 60, max 500)
 *   --wipe            delete THIS script's previous rows for that patient
 *                     first, so re-running doesn't stack duplicates
 *   --dry             report what would happen, write nothing
 *
 * Every row this script writes is tagged `[demo-seed]` in its notes /
 * instructions so `--wipe` can find them again and a human can tell seeded
 * data from real data at a glance. It never touches rows it did not create.
 */

const prisma = require("../lib/prisma");
const { computeValidUntil } = require("../lib/prescriptionHelpers");

const SEED_TAG = "[demo-seed]";

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
const FLAG = (name) => process.argv.includes(`--${name}`);

const TENANT_ID = Number(arg("tenant", 1));
const EMAIL = arg("email");
const PATIENT_ARG = arg("patient");
const COUNT = Math.min(Math.max(parseInt(arg("count", "60"), 10) || 60, 1), 500);
const WIPE = FLAG("wipe");
const DRY = FLAG("dry");

const DAY = 24 * 60 * 60 * 1000;

// A small catalogue so the list has visible variety — different drug counts,
// different names, so "Drugs" cells and the renewal picker aren't all identical.
const DRUG_POOL = [
  { name: "Minoxidil 5%", dosage: "1 ml", frequency: "twice daily", duration: "84 days" },
  { name: "Finasteride 1mg", dosage: "1 tablet", frequency: "once daily", duration: "90 days" },
  { name: "Biotin 10000mcg", dosage: "1 capsule", frequency: "once daily", duration: "60 days" },
  { name: "Ketoconazole Shampoo", dosage: "5 ml", frequency: "twice weekly", duration: "30 days" },
  { name: "Vitamin D3 60000IU", dosage: "1 sachet", frequency: "once weekly", duration: "56 days" },
  { name: "Amoxicillin 500mg", dosage: "1 capsule", frequency: "three times daily", duration: "5 days" },
  { name: "Crocin Advance", dosage: "1 tablet", frequency: "twice daily", duration: "3 days" },
  { name: "Azithromycin 500mg", dosage: "1 tablet", frequency: "once daily", duration: "7 days" },
];

// Deterministic pseudo-random so two runs with the same --count produce the
// same spread — makes a screenshot diff meaningful instead of noisy.
function seededPick(list, i, offset = 0) {
  return list[(i * 7 + offset * 3) % list.length];
}

async function resolveTarget() {
  if (PATIENT_ARG) {
    const id = Number(PATIENT_ARG);
    const patient = await prisma.patient.findFirst({
      where: { id, tenantId: TENANT_ID, deletedAt: null },
      select: { id: true, name: true, userId: true, tenantId: true },
    });
    if (!patient) throw new Error(`No active Patient #${id} on tenant ${TENANT_ID}`);
    return patient;
  }

  if (!EMAIL) {
    throw new Error("Pass --email=<customer email> or --patient=<id>");
  }

  const user = await prisma.user.findFirst({
    where: { email: EMAIL, tenantId: TENANT_ID },
    select: { id: true, name: true, email: true, userType: true, role: true },
  });
  if (!user) throw new Error(`No user ${EMAIL} on tenant ${TENANT_ID}`);

  const patient = await prisma.patient.findFirst({
    where: { userId: user.id, tenantId: TENANT_ID, deletedAt: null },
    select: { id: true, name: true, userId: true, tenantId: true },
  });
  if (!patient) {
    throw new Error(
      `User ${EMAIL} (#${user.id}) has no linked Patient row on tenant ${TENANT_ID}.\n` +
        `  The link is created on their first portal/app sign-in, or by staff on the\n` +
        `  Patients page. Sign in as them once, then re-run — or pass --patient=<id>\n` +
        `  to seed against an existing clinical record.`,
    );
  }
  return patient;
}

async function wipePrevious(patientId) {
  // Requests first: PrescriptionRequest cascades from Prescription, but being
  // explicit keeps the counts honest in the summary below.
  const rxIds = (
    await prisma.prescription.findMany({
      where: {
        patientId,
        tenantId: TENANT_ID,
        instructions: { contains: SEED_TAG },
      },
      select: { id: true },
    })
  ).map((r) => r.id);

  if (rxIds.length === 0) return { requests: 0, prescriptions: 0, visits: 0 };

  const requests = await prisma.prescriptionRequest.deleteMany({
    where: { prescriptionId: { in: rxIds } },
  });
  const visitIds = (
    await prisma.prescription.findMany({
      where: { id: { in: rxIds } },
      select: { visitId: true },
    })
  )
    .map((r) => r.visitId)
    .filter(Boolean);

  const prescriptions = await prisma.prescription.deleteMany({
    where: { id: { in: rxIds } },
  });
  const visits = await prisma.visit.deleteMany({
    where: { id: { in: visitIds }, tenantId: TENANT_ID, notes: { contains: SEED_TAG } },
  });

  return {
    requests: requests.count,
    prescriptions: prescriptions.count,
    visits: visits.count,
  };
}

async function main() {
  console.log(
    `[seed-rx-demo] tenant ${TENANT_ID} · ${DRY ? "DRY RUN (nothing will be written)" : "APPLY"}`,
  );

  const patient = await resolveTarget();
  console.log(
    `[seed-rx-demo] target: Patient #${patient.id} "${patient.name}" (userId ${patient.userId})`,
  );

  const doctors = await prisma.user.findMany({
    where: { tenantId: TENANT_ID, wellnessRole: "doctor", deactivatedAt: null },
    select: { id: true, name: true },
    take: 5,
  });
  if (doctors.length === 0) {
    throw new Error(
      `No doctor-role staff on tenant ${TENANT_ID} — a prescription needs a prescriber ` +
        `for the renewal notification to have anyone to reach.`,
    );
  }
  const services = await prisma.service.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true, name: true },
    take: 5,
  });
  const reviewer = await prisma.user.findFirst({
    where: { tenantId: TENANT_ID, role: "ADMIN", deactivatedAt: null },
    select: { id: true, name: true },
  });

  console.log(
    `[seed-rx-demo] prescribers: ${doctors.map((d) => d.name).join(", ")}`,
  );

  if (WIPE) {
    if (DRY) {
      const existing = await prisma.prescription.count({
        where: { patientId: patient.id, tenantId: TENANT_ID, instructions: { contains: SEED_TAG } },
      });
      console.log(`[seed-rx-demo] --wipe would remove ${existing} previously seeded prescription(s)`);
    } else {
      const removed = await wipePrevious(patient.id);
      console.log(
        `[seed-rx-demo] wiped ${removed.prescriptions} prescription(s), ${removed.requests} request(s), ${removed.visits} visit(s)`,
      );
    }
  }

  if (DRY) {
    console.log(
      `[seed-rx-demo] would create ${COUNT} visits + ${COUNT} prescriptions + 4 renewal requests`,
    );
    return;
  }

  // ── Prescriptions ────────────────────────────────────────────────────
  const created = [];
  for (let i = 0; i < COUNT; i++) {
    const doctor = doctors[i % doctors.length];
    const service = services.length ? services[i % services.length] : null;
    // Newest first when the list sorts by createdAt desc: index 0 = today.
    const visitDate = new Date(Date.now() - i * 11 * DAY);

    // 1–3 drugs, varying, so the "Drugs" column shows both the short form and
    // the "+N more" truncation.
    const drugCount = (i % 3) + 1;
    const drugs = [];
    for (let d = 0; d < drugCount; d++) drugs.push(seededPick(DRUG_POOL, i, d));

    const visit = await prisma.visit.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        serviceId: service ? service.id : undefined,
        visitDate,
        status: "completed",
        notes: `${SEED_TAG} follow-up consultation #${i + 1}`,
        amountCharged: 500 + (i % 7) * 250,
        tenantId: TENANT_ID,
      },
    });

    // Validity cycles 30 / 60 / 90 days, with every fourth prescription left
    // deliberately blank — "no stated validity" is a real state (and the state
    // every pre-feature row is in), so the UI has to be exercised against it
    // rather than only against the happy path.
    const validityDays = i % 4 === 3 ? null : [30, 60, 90][i % 3];
    const rx = await prisma.prescription.create({
      data: {
        visitId: visit.id,
        patientId: patient.id,
        doctorId: doctor.id,
        drugs: JSON.stringify(drugs),
        instructions: `${SEED_TAG} Course #${i + 1}. Take after food. Complete the full course.`,
        status: "issued",
        validityDays,
        validUntil: computeValidUntil(visitDate, validityDays),
        tenantId: TENANT_ID,
        createdAt: visitDate,
      },
      select: { id: true, drugs: true, doctorId: true, createdAt: true },
    });
    created.push(rx);
  }
  console.log(
    `[seed-rx-demo] created ${created.length} prescriptions (newest ${created[0].id}, oldest ${created[created.length - 1].id})`,
  );

  // ── Renewal requests — one per status ────────────────────────────────
  // Spread across DIFFERENT prescriptions because the API allows only one open
  // request per prescription; reusing one would 409 in real use and make the
  // seeded state unreachable by hand.
  //
  // A "partial" row needs a prescription with MORE THAN ONE drug — on a
  // single-drug Rx, picking the only medicine IS the whole prescription and
  // the service correctly normalises it back to null, so the partial branch
  // would never actually be exercised. Pick the pools explicitly rather than
  // taking created[0..3] and hoping.
  const multiDrug = created.filter((r) => JSON.parse(r.drugs).length > 1);
  const singleDrug = created.filter((r) => JSON.parse(r.drugs).length === 1);
  const takeFor = (partial, used) => {
    const pool = partial ? multiDrug : singleDrug.concat(multiDrug);
    return pool.find((r) => !used.has(r.id));
  };
  const used = new Set();

  const plan = [
    {
      status: "PENDING",
      partialWanted: true,
      // Partial ask — exercises the "specific medicines" branch and the
      // request-detail medicine list.
      durationDays: 60,
      notes: "Running low, please repeat just the tablets.",
      reviewNote: null,
    },
    {
      status: "ACCEPTED",
      partialWanted: false,
      durationDays: 90,
      notes: "Need the full course again before travelling.",
      reviewNote: "Approved for 90 days. Collect from the front desk.",
    },
    {
      status: "COMPLETED",
      partialWanted: false,
      durationDays: 30,
      notes: "Same as last time please.",
      reviewNote: "Dispensed on collection.",
    },
    {
      status: "REJECTED",
      partialWanted: true,
      durationDays: null,
      notes: "Can I get more of the same?",
      reviewNote: "Please book a review consultation first — it has been over a year.",
    },
  ]
    .map((row) => {
      const rx = takeFor(row.partialWanted, used);
      if (rx) used.add(rx.id);
      return { ...row, rx };
    })
    .filter((row) => row.rx);

  for (const row of plan) {
    const drugs = JSON.parse(row.rx.drugs);
    // A partial request only makes sense when the Rx has more than one drug;
    // otherwise "all of them" IS the whole prescription and the service would
    // normalise it back to null anyway.
    const requestedDrugs =
      row.partialWanted && drugs.length > 1 ? JSON.stringify([drugs[0]]) : null;

    const closed = row.status === "REJECTED" || row.status === "COMPLETED";
    const reviewed = row.status !== "PENDING";
    const raisedAt = new Date(Date.now() - (plan.indexOf(row) + 1) * 2 * DAY);

    const request = await prisma.prescriptionRequest.create({
      data: {
        prescriptionId: row.rx.id,
        patientId: patient.id,
        doctorId: row.rx.doctorId,
        requestedDrugs,
        requestedDurationDays: row.durationDays,
        notes: `${SEED_TAG} ${row.notes}`,
        status: row.status,
        reviewedById: reviewed && reviewer ? reviewer.id : null,
        reviewedAt: reviewed ? new Date(raisedAt.getTime() + 6 * 60 * 60 * 1000) : null,
        reviewNote: row.reviewNote,
        tenantId: TENANT_ID,
        createdAt: raisedAt,
        events: {
          create: [
            {
              action: "CREATED",
              toStatus: "PENDING",
              note: `${SEED_TAG} ${row.notes}`,
              actorType: "patient",
              tenantId: TENANT_ID,
              createdAt: raisedAt,
            },
            ...(reviewed
              ? [
                  {
                    action: row.status === "COMPLETED" ? "ACCEPTED" : row.status,
                    fromStatus: "PENDING",
                    toStatus: row.status === "COMPLETED" ? "ACCEPTED" : row.status,
                    note: row.reviewNote,
                    actorUserId: reviewer ? reviewer.id : null,
                    actorType: "user",
                    tenantId: TENANT_ID,
                    createdAt: new Date(raisedAt.getTime() + 6 * 60 * 60 * 1000),
                  },
                ]
              : []),
            ...(row.status === "COMPLETED"
              ? [
                  {
                    action: "COMPLETED",
                    fromStatus: "ACCEPTED",
                    toStatus: "COMPLETED",
                    note: row.reviewNote,
                    actorUserId: reviewer ? reviewer.id : null,
                    actorType: "user",
                    tenantId: TENANT_ID,
                    createdAt: new Date(raisedAt.getTime() + 30 * 60 * 60 * 1000),
                  },
                ]
              : []),
          ],
        },
      },
      select: { id: true, status: true, prescriptionId: true },
    });
    console.log(
      `[seed-rx-demo]   request #${request.id} ${request.status} on Rx #${request.prescriptionId}` +
        `${requestedDrugs ? " (specific medicines)" : " (complete prescription)"}` +
        `${closed ? " [closed]" : ""}`,
    );
  }

  console.log("");
  console.log("[seed-rx-demo] done. What to check:");
  console.log(`  Staff  → /wellness/prescriptions        ${COUNT} rows, page sizes 25/50/100/200`);
  console.log("  Staff  → /wellness/prescription-requests  4 rows, one per status tab");
  console.log(`  Customer (${patient.name}) → /wellness/my-prescriptions and`);
  console.log("           /wellness/my-prescription-requests  (Request renewal on any Rx)");
  console.log("");
  console.log("  Re-run with --wipe to clear and reseed; every row is tagged '[demo-seed]'.");
}

main()
  .catch((err) => {
    console.error("[seed-rx-demo] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
