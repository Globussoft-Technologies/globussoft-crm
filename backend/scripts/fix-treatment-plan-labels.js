// One-shot data-quality fix for issue #287:
//
//   Patient 433 (Kavita Reddy) — and likely others — has TreatmentPlan rows
//   where `name` (the user-visible label) does not match the underlying
//   linked Service's name. Example: a plan labelled "Hair PRP Therapy —
//   6-session package" pointed at the Laser Hair Removal service, so the
//   PatientDetail UI shows the package label but the booking, pricing and
//   reports use a completely different service.
//
//   Root cause is data, not code: the PatientDetail "New treatment plan"
//   form (frontend/src/pages/wellness/PatientDetail.jsx PlansTab) lets the
//   admin type a free-text `name` AND independently pick a `serviceId`.
//   When a clinic admin clones a previous plan and only swaps the service
//   dropdown (or vice-versa), the two drift apart with no validation.
//   The seed-wellness.js script always emits matched pairs, so anything
//   that diverges in production is an after-the-fact edit.
//
// Fix policy:
//   - Where `serviceId` is set and `name` does NOT contain the service name
//     (case-insensitive substring), rewrite `name` to:
//         `${service.name} — ${totalSessions}-session package`
//     (this is the exact pattern used by prisma/seed-wellness.js, so the
//      result is indistinguishable from a freshly-seeded row).
//   - Plans with `serviceId = null` are left alone — no canonical service
//     to align against; a human has to pick one.
//   - Wellness tenant only (tenantId=2) per the issue scope. Pass
//     `--tenant=N` to override; pass `--all` to scan every tenant.
//
// Modeled on backend/scripts/cleanup-p3-data-quality.js. Default is dry run;
// pass --commit to actually mutate. Each row is updated individually so a
// single bad row doesn't abort the rest. Audit log NOT written here — this
// is an out-of-band cleanup, justification recorded in the script header
// per backend/routes/wellness.js's clinical-artefact retention policy
// (TreatmentPlan is operational, not strictly clinical, so a name correction
// is allowed; the prior name is captured in the console log for traceability).
//
// Usage:
//   node scripts/fix-treatment-plan-labels.js                 (dry run, tenant 2)
//   node scripts/fix-treatment-plan-labels.js --commit        (apply, tenant 2)
//   node scripts/fix-treatment-plan-labels.js --tenant=3      (dry run, tenant 3)
//   node scripts/fix-treatment-plan-labels.js --all --commit  (every tenant)

const prisma = require("../lib/prisma");

const COMMIT = process.argv.includes("--commit");
const ALL_TENANTS = process.argv.includes("--all");
const tenantFlag = process.argv.find((a) => a.startsWith("--tenant="));
const TENANT_ID = ALL_TENANTS
  ? null
  : tenantFlag
    ? parseInt(tenantFlag.split("=")[1], 10)
    : 2; // default = wellness tenant
const MODE = COMMIT ? "COMMIT" : "DRY-RUN";

function buildExpectedName(serviceName, totalSessions) {
  // Match seed-wellness.js exactly so the rewritten label is canonical.
  return `${serviceName} — ${totalSessions}-session package`;
}

function nameMatchesService(planName, serviceName) {
  if (!planName || !serviceName) return false;
  return planName.toLowerCase().includes(serviceName.toLowerCase());
}

(async () => {
  console.log(
    `fix-treatment-plan-labels.js  mode=${MODE}  tenant=${ALL_TENANTS ? "ALL" : TENANT_ID}`
  );
  console.log(`(pass --commit to apply changes)`);
  console.log("");

  const where = ALL_TENANTS ? {} : { tenantId: TENANT_ID };
  const plans = await prisma.treatmentPlan.findMany({
    where: { ...where, serviceId: { not: null } },
    include: {
      service: { select: { id: true, name: true } },
      patient: { select: { id: true, name: true } },
    },
    orderBy: [{ tenantId: "asc" }, { id: "asc" }],
  });

  console.log(
    `Scanned ${plans.length} treatment plans with a linked service${ALL_TENANTS ? "" : ` in tenant ${TENANT_ID}`}.`
  );

  const mismatched = plans.filter(
    (p) => !nameMatchesService(p.name, p.service?.name)
  );
  console.log(`Found ${mismatched.length} plans where name does not contain the service name.`);
  console.log("");

  let applied = 0;
  let errored = 0;
  for (const p of mismatched) {
    const expected = buildExpectedName(p.service.name, p.totalSessions);
    console.log(
      `  plan id=${p.id} tenant=${p.tenantId} patient=${p.patientId} (${p.patient?.name || "?"})`
    );
    console.log(`    service: id=${p.serviceId} name="${p.service.name}"`);
    console.log(`    name was: "${p.name}"`);
    console.log(`    name new: "${expected}"`);
    if (COMMIT) {
      try {
        await prisma.treatmentPlan.update({
          where: { id: p.id },
          data: { name: expected },
        });
        applied++;
      } catch (e) {
        errored++;
        console.error(`    UPDATE FAILED: ${e.message}`);
      }
    }
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Mode:       ${MODE}`);
  console.log(`Tenant:     ${ALL_TENANTS ? "ALL" : TENANT_ID}`);
  console.log(`Scanned:    ${plans.length}`);
  console.log(`Mismatched: ${mismatched.length}`);
  console.log(`Updated:    ${COMMIT ? applied : 0}`);
  console.log(`Errored:    ${errored}`);
  if (!COMMIT) {
    console.log("");
    console.log("DRY RUN — no rows changed. Re-run with --commit to apply.");
  }
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
