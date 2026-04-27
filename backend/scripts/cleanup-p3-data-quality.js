// One-shot data-quality cleanup for the wellness tenant (tenantId=2),
// fixing seven P3 GitHub issues in a single pass:
//
//   #272  /wellness/locations: 6 dupe "E2E Branch [id]" rows -> delete (only if no Visits)
//   #271  Telecaller queue contained UK +447700900000 -> delete clearly non-Indian Contacts
//   #268  Marketing Attribution exposed test-skip / test-junk sources -> remap to "other"
//   #267  Patient + Contact source mixed walk-in / walk_in -> normalize underscore -> hyphen
//   #266  Patient gender column had "—", "f", "MALE", … -> normalize to M / F / NULL
//   #265  Duplicate "Kavita Reddy" Patient rows -> DETECT only (print pairs, don't merge)
//   #250  Agent Task Queue task with dueDate 1/1/1999 -> delete pre-2020 dueDates
//
// Modeled on backend/scripts/cleanup-overflow-visit-amounts.js (the #277 fix).
// Default mode is dry-run; pass --commit to actually mutate. Each section is
// wrapped in try/catch so one failure doesn't abort the rest. Final summary
// table prints counts.
//
// Usage:
//   node scripts/cleanup-p3-data-quality.js              (dry run, default)
//   node scripts/cleanup-p3-data-quality.js --commit     (apply changes)

const prisma = require("../lib/prisma");

const TENANT_ID = 2; // wellness tenant
const COMMIT = process.argv.includes("--commit");
const MODE = COMMIT ? "COMMIT" : "DRY-RUN";

const summary = []; // { issue, label, found, applied, errored }

function record(issue, label, found, applied, errored = false, note = "") {
  summary.push({ issue, label, found, applied, errored, note });
}

function header(issue, desc) {
  console.log("");
  console.log(`=== Issue #${issue}: ${desc} ===`);
}

// ─── Issue #272: dupe E2E Branch locations ────────────────────────────────
async function cleanupLocationsE2E() {
  header(272, "Delete dupe 'E2E Branch%' Locations with no visits");
  try {
    const candidates = await prisma.location.findMany({
      where: {
        tenantId: TENANT_ID,
        name: { startsWith: "E2E Branch" },
      },
      select: {
        id: true,
        name: true,
        _count: { select: { visits: true, patients: true } },
      },
    });
    console.log(`Found ${candidates.length} 'E2E Branch%' locations in tenant ${TENANT_ID}`);
    const deletable = candidates.filter(
      (l) => l._count.visits === 0 && l._count.patients === 0
    );
    const skipped = candidates.filter(
      (l) => l._count.visits > 0 || l._count.patients > 0
    );
    for (const l of candidates) {
      console.log(
        `  id=${l.id} name="${l.name}" visits=${l._count.visits} patients=${l._count.patients}`
      );
    }
    for (const l of skipped) {
      console.log(`  SKIP id=${l.id} (has dependents)`);
    }
    let applied = 0;
    if (COMMIT && deletable.length > 0) {
      const result = await prisma.location.deleteMany({
        where: { id: { in: deletable.map((l) => l.id) } },
      });
      applied = result.count;
      console.log(`Deleted ${applied} location rows.`);
    } else {
      console.log(`Would delete ${deletable.length} location rows.`);
    }
    record(272, "Locations E2E", candidates.length, COMMIT ? applied : deletable.length);
  } catch (e) {
    console.error(`#272 failed:`, e.message);
    record(272, "Locations E2E", 0, 0, true, e.message);
  }
}

// ─── Issue #271: non-Indian Contact phones in wellness tenant ─────────────
function isClearlyNonIndian(rawPhone) {
  if (!rawPhone) return false; // null/empty → leave alone
  const digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length === 0) return false;
  // Strip leading 0 (domestic STD prefix)
  const trimmed = digits.replace(/^0+/, "");
  // Indian-format acceptable shapes:
  //   - 10 digits starting with 6/7/8/9 (mobile)
  //   - 12 digits starting with 91 + 6/7/8/9
  //   - 13 digits starting with 091 (handled by leading-0 strip)
  if (/^[6-9]\d{9}$/.test(trimmed)) return false;
  if (/^91[6-9]\d{9}$/.test(trimmed)) return false;
  // Anything else with a non-91 country code prefix or wrong length is suspect.
  // Conservative: only flag if it's longer than 10 digits AND doesn't start with 91.
  if (trimmed.length > 10 && !trimmed.startsWith("91")) return true;
  // Short stub numbers (< 10) are likely test garbage but could also be
  // legacy landlines; leave to a human.
  return false;
}

async function cleanupNonIndianPhones() {
  header(271, "Delete clearly non-Indian Contact phones in wellness tenant");
  try {
    const contacts = await prisma.contact.findMany({
      where: { tenantId: TENANT_ID, deletedAt: null, phone: { not: null } },
      select: { id: true, name: true, phone: true },
    });
    const offenders = contacts.filter((c) => isClearlyNonIndian(c.phone));
    console.log(
      `Scanned ${contacts.length} tenant-${TENANT_ID} contacts; ${offenders.length} clearly non-Indian`
    );
    for (const c of offenders) {
      console.log(`  id=${c.id} name="${c.name}" phone="${c.phone}"`);
    }
    let applied = 0;
    if (COMMIT && offenders.length > 0) {
      // Soft-delete via deletedAt to preserve the audit trail rather than
      // hard-deleting (Contact has soft-delete, see schema comment line 175).
      const result = await prisma.contact.updateMany({
        where: { id: { in: offenders.map((c) => c.id) } },
        data: { deletedAt: new Date() },
      });
      applied = result.count;
      console.log(`Soft-deleted ${applied} contact rows.`);
    } else {
      console.log(`Would soft-delete ${offenders.length} contact rows.`);
    }
    record(271, "Contacts non-Indian phone", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#271 failed:`, e.message);
    record(271, "Contacts non-Indian phone", 0, 0, true, e.message);
  }
}

// ─── Issue #268: collapse test sources to "other" ─────────────────────────
async function cleanupTestSources() {
  header(268, "Collapse test-* / qa-test contact sources to 'other'");
  try {
    const TEST_SOURCES = ["test-skip", "test-junk", "e2e-test", "qa-test"];
    const matches = await prisma.contact.findMany({
      where: { tenantId: TENANT_ID, source: { in: TEST_SOURCES } },
      select: { id: true, name: true, source: true },
    });
    console.log(`Found ${matches.length} contacts with junk source values`);
    for (const c of matches) {
      console.log(`  id=${c.id} name="${c.name}" source="${c.source}"`);
    }
    let applied = 0;
    if (COMMIT && matches.length > 0) {
      const result = await prisma.contact.updateMany({
        where: { tenantId: TENANT_ID, source: { in: TEST_SOURCES } },
        data: { source: "other" },
      });
      applied = result.count;
      console.log(`Updated ${applied} contact source values -> 'other'.`);
    } else {
      console.log(`Would update ${matches.length} contact source values -> 'other'.`);
    }
    record(268, "Contacts test sources", matches.length, COMMIT ? applied : matches.length);
  } catch (e) {
    console.error(`#268 failed:`, e.message);
    record(268, "Contacts test sources", 0, 0, true, e.message);
  }
}

// ─── Issue #267: normalize source kebab-case (underscore -> hyphen) ────────
async function cleanupSourceCasing() {
  header(267, "Normalize Patient.source / Contact.source underscores -> hyphens");
  try {
    // Patient
    const patientHits = await prisma.patient.findMany({
      where: { tenantId: TENANT_ID, source: { contains: "_" } },
      select: { id: true, name: true, source: true },
    });
    console.log(`Patient: found ${patientHits.length} rows with underscores in source`);
    for (const p of patientHits) {
      console.log(`  patient id=${p.id} name="${p.name}" source="${p.source}" -> "${p.source.replace(/_/g, "-")}"`);
    }
    let patientApplied = 0;
    if (COMMIT) {
      for (const p of patientHits) {
        await prisma.patient.update({
          where: { id: p.id },
          data: { source: p.source.replace(/_/g, "-") },
        });
        patientApplied++;
      }
      console.log(`Patient: updated ${patientApplied} rows.`);
    } else {
      console.log(`Patient: would update ${patientHits.length} rows.`);
    }

    // Contact
    const contactHits = await prisma.contact.findMany({
      where: { tenantId: TENANT_ID, source: { contains: "_" } },
      select: { id: true, name: true, source: true },
    });
    console.log(`Contact: found ${contactHits.length} rows with underscores in source`);
    for (const c of contactHits) {
      console.log(`  contact id=${c.id} name="${c.name}" source="${c.source}" -> "${c.source.replace(/_/g, "-")}"`);
    }
    let contactApplied = 0;
    if (COMMIT) {
      for (const c of contactHits) {
        await prisma.contact.update({
          where: { id: c.id },
          data: { source: c.source.replace(/_/g, "-") },
        });
        contactApplied++;
      }
      console.log(`Contact: updated ${contactApplied} rows.`);
    } else {
      console.log(`Contact: would update ${contactHits.length} rows.`);
    }
    record(
      267,
      "Source case normalize",
      patientHits.length + contactHits.length,
      COMMIT ? patientApplied + contactApplied : patientHits.length + contactHits.length
    );
  } catch (e) {
    console.error(`#267 failed:`, e.message);
    record(267, "Source case normalize", 0, 0, true, e.message);
  }
}

// ─── Issue #266: normalize Patient.gender to M / F / NULL ─────────────────
function normalizeGender(g) {
  if (g === null || g === undefined) return null;
  const trimmed = String(g).trim();
  if (trimmed === "" || trimmed === "—" || trimmed === "-" || trimmed === "?") return null;
  const upper = trimmed.toUpperCase();
  if (upper === "M" || upper === "MALE") return "M";
  if (upper === "F" || upper === "FEMALE") return "F";
  // Schema comment says "M, F, Other" — preserve "Other" if present
  if (upper === "OTHER" || upper === "O") return "Other";
  return null; // unknown garbage -> null
}

async function cleanupGender() {
  header(266, "Normalize Patient.gender -> M / F / Other / NULL");
  try {
    const patients = await prisma.patient.findMany({
      where: { tenantId: TENANT_ID },
      select: { id: true, name: true, gender: true },
    });
    const dirty = patients.filter((p) => {
      const norm = normalizeGender(p.gender);
      // null → null is a no-op; same-value is a no-op
      const current = p.gender === undefined ? null : p.gender;
      return current !== norm;
    });
    console.log(`Scanned ${patients.length} patients; ${dirty.length} need gender normalization`);
    for (const p of dirty) {
      console.log(`  id=${p.id} name="${p.name}" gender="${p.gender}" -> "${normalizeGender(p.gender)}"`);
    }
    let applied = 0;
    if (COMMIT) {
      for (const p of dirty) {
        await prisma.patient.update({
          where: { id: p.id },
          data: { gender: normalizeGender(p.gender) },
        });
        applied++;
      }
      console.log(`Updated gender on ${applied} patients.`);
    } else {
      console.log(`Would update gender on ${dirty.length} patients.`);
    }
    record(266, "Gender normalize", dirty.length, COMMIT ? applied : dirty.length);
  } catch (e) {
    console.error(`#266 failed:`, e.message);
    record(266, "Gender normalize", 0, 0, true, e.message);
  }
}

// ─── Issue #265: detect duplicate Patient rows (don't merge) ──────────────
async function detectDuplicatePatients() {
  header(265, "Detect duplicate patients by (tenantId, name) — print pairs only");
  try {
    const patients = await prisma.patient.findMany({
      where: { tenantId: TENANT_ID },
      select: { id: true, name: true, phone: true, email: true, createdAt: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const groups = new Map();
    for (const p of patients) {
      const key = (p.name || "").trim().toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1);
    console.log(
      `Scanned ${patients.length} patients; ${dupGroups.length} name-collision groups detected`
    );
    let pairCount = 0;
    for (const [name, list] of dupGroups) {
      console.log(`  GROUP "${name}" (${list.length} rows):`);
      for (const p of list) {
        console.log(
          `    id=${p.id} phone="${p.phone}" email="${p.email}" createdAt=${p.createdAt.toISOString()}`
        );
      }
      pairCount += list.length - 1; // n-1 merge candidates per group
    }
    console.log(`(detection only — no rows modified)`);
    record(265, "Duplicate patients (detect)", pairCount, 0, false, "manual merge required");
  } catch (e) {
    console.error(`#265 failed:`, e.message);
    record(265, "Duplicate patients (detect)", 0, 0, true, e.message);
  }
}

// ─── Issue #250: delete Tasks with absurdly old dueDate ───────────────────
async function cleanupAncientTasks() {
  header(250, "Delete Task rows with dueDate < 2020-01-01 in wellness tenant");
  try {
    const cutoff = new Date("2020-01-01T00:00:00.000Z");
    const tasks = await prisma.task.findMany({
      where: {
        tenantId: TENANT_ID,
        deletedAt: null,
        dueDate: { lt: cutoff, not: null },
      },
      select: { id: true, title: true, dueDate: true, status: true, userId: true },
    });
    console.log(`Found ${tasks.length} tasks with dueDate < ${cutoff.toISOString()}`);
    for (const t of tasks) {
      console.log(
        `  id=${t.id} title="${t.title}" dueDate=${t.dueDate.toISOString()} status=${t.status} userId=${t.userId}`
      );
    }
    let applied = 0;
    if (COMMIT && tasks.length > 0) {
      // Soft-delete (Task has deletedAt; see schema line 646)
      const result = await prisma.task.updateMany({
        where: { id: { in: tasks.map((t) => t.id) } },
        data: { deletedAt: new Date() },
      });
      applied = result.count;
      console.log(`Soft-deleted ${applied} task rows.`);
    } else {
      console.log(`Would soft-delete ${tasks.length} task rows.`);
    }
    record(250, "Ancient tasks", tasks.length, COMMIT ? applied : tasks.length);
  } catch (e) {
    console.error(`#250 failed:`, e.message);
    record(250, "Ancient tasks", 0, 0, true, e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`cleanup-p3-data-quality.js  mode=${MODE}  tenantId=${TENANT_ID}`);
  console.log(`(pass --commit to apply changes)`);

  await cleanupLocationsE2E();
  await cleanupNonIndianPhones();
  await cleanupTestSources();
  await cleanupSourceCasing();
  await cleanupGender();
  await detectDuplicatePatients();
  await cleanupAncientTasks();

  console.log("");
  console.log("=== Summary ===");
  console.log(`Mode: ${MODE}`);
  const col = (s, w) => String(s).padEnd(w);
  console.log(
    col("Issue", 8) + col("Section", 32) + col("Found", 8) + col("Applied", 10) + "Errored"
  );
  for (const r of summary) {
    console.log(
      col("#" + r.issue, 8) +
        col(r.label, 32) +
        col(r.found, 8) +
        col(r.applied, 10) +
        (r.errored ? "YES (" + r.note + ")" : "no")
    );
  }
  const totalFound = summary.reduce((a, r) => a + r.found, 0);
  const totalApplied = summary.reduce((a, r) => a + r.applied, 0);
  const totalErrored = summary.filter((r) => r.errored).length;
  console.log(
    `Totals: found=${totalFound} applied=${totalApplied} errored_sections=${totalErrored}`
  );
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
