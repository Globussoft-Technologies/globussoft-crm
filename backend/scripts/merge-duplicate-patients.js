/**
 * Issue #265 — merge duplicate Patient rows in the wellness tenant.
 *
 * Detection found 150 dupe-name groups (sneha iyer x21, reyansh kumar x15,
 * phi audit test patient x8, portal tester x8, photo tester x7, kavita reddy
 * x2, etc.). Most are e2e test pollution; a few are real-name dupes.
 *
 * Strategy per group:
 *   1. Keeper = row with the MOST clinical references (visits + prescriptions
 *      + consents + treatmentPlans + waitlists + loyaltyTransactions +
 *      referrals). Ties broken by OLDEST createdAt.
 *   2. For each non-keeper: reattach all 7 child relations to keeper.id via
 *      updateMany, then hard-delete the non-keeper Patient row.
 *   3. Zero-ref groups: keeper = oldest, others hard-deleted (no reattach).
 *
 * Default = dry-run. --commit applies. Per-group try/catch — one bad merge
 * doesn't bail the whole script.
 *
 * Usage:
 *     node scripts/merge-duplicate-patients.js              # dry-run
 *     node scripts/merge-duplicate-patients.js --commit     # apply
 */
const prisma = require("../lib/prisma");

const TENANT_ID = parseInt(process.env.TENANT_ID || "2", 10);
const COMMIT = process.argv.includes("--commit");

const summary = { groups: 0, keepers: 0, mergedAway: 0, hardDeleted: 0, reattached: 0, errors: 0 };

function log(...args) {
  console.log(...args);
}

async function getDupeGroups() {
  // All patients with names that appear more than once in the tenant.
  const all = await prisma.patient.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true, name: true, phone: true, email: true, createdAt: true },
    orderBy: { id: "asc" },
  });

  // Group by lowercased trimmed name.
  const byName = new Map();
  for (const p of all) {
    const key = (p.name || "").trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  }

  const dupeGroups = [];
  for (const [name, rows] of byName) {
    if (rows.length >= 2) dupeGroups.push({ name, rows });
  }
  return dupeGroups;
}

async function clinicalRefCount(patientId) {
  // Referral has TWO patient FKs: referrerPatientId (the patient making the
  // referral) and referredPatientId (the patient who was referred and signed
  // up). Both must be counted as clinical refs and both must be reattached.
  const [v, rx, cf, tp, wl, lt, rfOut, rfIn] = await Promise.all([
    prisma.visit.count({ where: { patientId } }),
    prisma.prescription.count({ where: { patientId } }),
    prisma.consentForm.count({ where: { patientId } }),
    prisma.treatmentPlan.count({ where: { patientId } }),
    prisma.waitlist.count({ where: { patientId } }),
    prisma.loyaltyTransaction.count({ where: { patientId } }),
    prisma.referral.count({ where: { referrerPatientId: patientId } }),
    prisma.referral.count({ where: { referredPatientId: patientId } }),
  ]);
  const rf = rfOut + rfIn;
  return { v, rx, cf, tp, wl, lt, rf, total: v + rx + cf + tp + wl + lt + rf };
}

async function reattachChildren(fromId, toId) {
  const r = await Promise.all([
    prisma.visit.updateMany({ where: { patientId: fromId }, data: { patientId: toId } }),
    prisma.prescription.updateMany({ where: { patientId: fromId }, data: { patientId: toId } }),
    prisma.consentForm.updateMany({ where: { patientId: fromId }, data: { patientId: toId } }),
    prisma.treatmentPlan.updateMany({ where: { patientId: fromId }, data: { patientId: toId } }),
    prisma.waitlist.updateMany({ where: { patientId: fromId }, data: { patientId: toId } }),
    prisma.loyaltyTransaction.updateMany({ where: { patientId: fromId }, data: { patientId: toId } }),
    prisma.referral.updateMany({ where: { referrerPatientId: fromId }, data: { referrerPatientId: toId } }),
    prisma.referral.updateMany({ where: { referredPatientId: fromId }, data: { referredPatientId: toId } }),
  ]);
  const total = r.reduce((s, x) => s + x.count, 0);
  return {
    v: r[0].count, rx: r[1].count, cf: r[2].count, tp: r[3].count,
    wl: r[4].count, lt: r[5].count, rf: r[6].count + r[7].count, total,
  };
}

async function processGroup(group) {
  const { name, rows } = group;
  // Annotate each row with its clinical ref count.
  const annotated = await Promise.all(
    rows.map(async (r) => ({ ...r, refs: await clinicalRefCount(r.id) }))
  );

  // Keeper = highest .refs.total, then oldest createdAt, then lowest id.
  annotated.sort(
    (a, b) =>
      b.refs.total - a.refs.total ||
      a.createdAt - b.createdAt ||
      a.id - b.id
  );
  const keeper = annotated[0];
  const dupes = annotated.slice(1);

  log(`\n--- "${name}" (${rows.length} rows) ---`);
  log(`  KEEPER  id=${keeper.id} createdAt=${keeper.createdAt.toISOString().slice(0,10)} refs=${keeper.refs.total} (v=${keeper.refs.v} rx=${keeper.refs.rx} cf=${keeper.refs.cf} tp=${keeper.refs.tp} wl=${keeper.refs.wl} lt=${keeper.refs.lt} rf=${keeper.refs.rf})`);
  for (const d of dupes) {
    log(`  DUPE    id=${d.id} createdAt=${d.createdAt.toISOString().slice(0,10)} refs=${d.refs.total} (v=${d.refs.v} rx=${d.refs.rx} cf=${d.refs.cf} tp=${d.refs.tp} wl=${d.refs.wl} lt=${d.refs.lt} rf=${d.refs.rf})`);
  }

  if (!COMMIT) return;

  for (const d of dupes) {
    try {
      let reCount = 0;
      if (d.refs.total > 0) {
        const re = await reattachChildren(d.id, keeper.id);
        reCount = re.total;
        summary.reattached += reCount;
        log(`    reattach id=${d.id} → ${keeper.id}: ${re.total} rows (v=${re.v} rx=${re.rx} cf=${re.cf} tp=${re.tp} wl=${re.wl} lt=${re.lt} rf=${re.rf})`);
      }
      await prisma.patient.delete({ where: { id: d.id } });
      summary.hardDeleted++;
      log(`    HARD-DELETE id=${d.id} ✓`);
    } catch (err) {
      summary.errors++;
      log(`    [ERROR] id=${d.id}: ${err.message}`);
    }
  }
  summary.keepers++;
  summary.mergedAway += dupes.length;
}

async function main() {
  log(`#265 — Merge duplicate Patient rows (tenantId=${TENANT_ID})`);
  log(`Mode: ${COMMIT ? "COMMIT" : "DRY-RUN"}`);

  const groups = await getDupeGroups();
  summary.groups = groups.length;
  log(`Found ${groups.length} duplicate-name groups.\n`);

  for (const g of groups) {
    try {
      await processGroup(g);
    } catch (err) {
      summary.errors++;
      log(`[ERROR] group "${g.name}": ${err.message}`);
    }
  }

  log("\n=== Summary ===");
  log(`Mode:        ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
  log(`Groups:      ${summary.groups}`);
  if (COMMIT) {
    log(`Keepers:     ${summary.keepers}`);
    log(`Merged away: ${summary.mergedAway}`);
    log(`Reattached:  ${summary.reattached} child rows`);
    log(`Deleted:     ${summary.hardDeleted}`);
    log(`Errors:      ${summary.errors}`);
  } else {
    let totalDupes = 0;
    for (const g of groups) totalDupes += g.rows.length - 1;
    log(`Would merge away: ${totalDupes} non-keeper rows`);
  }
  log(`\n${COMMIT ? "Done." : "DRY RUN — re-run with --commit to apply."}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
