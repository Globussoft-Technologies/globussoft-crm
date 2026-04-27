/**
 * Issues #261 / #285 — clean up duplicate AgentRecommendation rows and
 * auto-generated Task rows produced by the orchestrator cron.
 *
 * Root cause (already fixed in cron/orchestratorEngine.js): the in-cron
 * dedup set only filtered status="pending" rows for today, so once a
 * card was approved or rejected the next cron run inserted a duplicate.
 * The "approved" tab on Recommendations therefore showed 5x identical
 * "Today's occupancy only 1%" cards, and /tasks showed 6x copies of
 * the matching auto-generated Task.
 *
 * This script removes the historical pollution.
 *
 * Strategy:
 *   AgentRecommendation
 *     1. Group by (tenantId, type, title, payload-hash, createdAt-day).
 *     2. Keeper = oldest row of the group, BUT prefer a non-"pending"
 *        keeper (approved/rejected) so user actions are preserved.
 *     3. Hard-delete the rest. AgentRecommendation has no children to
 *        reattach (resolvedById is a User FK, not a back-relation).
 *
 *   Task
 *     1. Group by (tenantId, title, dueDate-day) within tasks created
 *        by approved orchestrator recommendations. We narrow by title
 *        prefix "Marketer:" OR title matching an existing/historical
 *        AgentRecommendation.title for the tenant — to avoid touching
 *        manually-created tasks.
 *     2. Keeper = oldest. Soft-delete the rest (Task has deletedAt).
 *
 * Default = dry-run. --commit applies. Per-group try/catch.
 *
 * Usage:
 *     node scripts/cleanup-orchestrator-dupes.js                  # dry-run, all wellness tenants
 *     node scripts/cleanup-orchestrator-dupes.js --commit         # apply
 *     TENANT_ID=2 node scripts/cleanup-orchestrator-dupes.js      # scope to one tenant
 */
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const COMMIT = process.argv.includes("--commit");
const SCOPED_TENANT_ID = process.env.TENANT_ID ? parseInt(process.env.TENANT_ID, 10) : null;

const summary = {
  tenants: 0,
  recGroups: 0,
  recDupesRemoved: 0,
  taskGroups: 0,
  taskDupesRemoved: 0,
  errors: 0,
};

function log(...args) { console.log(...args); }

function startOfDay(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}

function payloadHash({ type, title, payload }) {
  const norm = JSON.stringify({
    type: type || "",
    title: (title || "").trim().toLowerCase(),
    payload: payload || null,
  });
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

async function getTargetTenants() {
  if (SCOPED_TENANT_ID) {
    const t = await prisma.tenant.findUnique({ where: { id: SCOPED_TENANT_ID }, select: { id: true, name: true, vertical: true } });
    return t ? [t] : [];
  }
  return prisma.tenant.findMany({
    where: { vertical: "wellness" },
    select: { id: true, name: true, vertical: true },
    orderBy: { id: "asc" },
  });
}

async function cleanupRecsForTenant(tenantId) {
  const recs = await prisma.agentRecommendation.findMany({
    where: { tenantId },
    select: { id: true, type: true, title: true, payload: true, createdAt: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  // Group by (type+payload-hash+createdAt-day). Day-level keying preserves
  // legitimate next-day cards (e.g. "Today's occupancy only 1%" generated
  // on Mon and again on Tue are NOT considered dupes).
  const groups = new Map();
  for (const r of recs) {
    let parsed = null;
    try { parsed = r.payload ? JSON.parse(r.payload) : null; } catch (_) {}
    const dayKey = startOfDay(r.createdAt).toISOString().slice(0, 10);
    const key = `${dayKey}|${payloadHash({ type: r.type, title: r.title, payload: parsed })}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let groupCount = 0, removed = 0;
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    groupCount++;
    // Keeper preference: any approved row first (preserves the action
    // dispatch record), else any rejected, else the oldest pending.
    const keeper =
      rows.find((r) => r.status === "approved") ||
      rows.find((r) => r.status === "rejected") ||
      rows[0];
    const dupes = rows.filter((r) => r.id !== keeper.id);
    log(`  rec-group [${key}] tenant=${tenantId} rows=${rows.length} keeper=${keeper.id}(${keeper.status}) drop=${dupes.map((d) => `${d.id}(${d.status})`).join(",")}`);
    if (!COMMIT) { removed += dupes.length; continue; }
    try {
      const del = await prisma.agentRecommendation.deleteMany({
        where: { id: { in: dupes.map((d) => d.id) } },
      });
      removed += del.count;
    } catch (e) {
      summary.errors++;
      log(`    [ERROR] delete recs: ${e.message}`);
    }
  }
  return { groupCount, removed };
}

async function cleanupTasksForTenant(tenantId) {
  // Build the set of titles that have ever been emitted as orchestrator
  // recommendations for this tenant. We only soft-delete tasks whose
  // title matches one of those (or starts with "Marketer:" — the
  // executeApproved campaign_boost prefix).
  const recTitles = await prisma.agentRecommendation.findMany({
    where: { tenantId },
    select: { title: true },
    distinct: ["title"],
  });
  const orchestratorTitleSet = new Set();
  for (const r of recTitles) {
    if (r.title) {
      orchestratorTitleSet.add(r.title);
      orchestratorTitleSet.add(`Marketer: ${r.title}`);
    }
  }

  const tasks = await prisma.task.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, title: true, dueDate: true, createdAt: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  // Group by (title + dueDate-day || createdAt-day). Only consider
  // tasks whose title matches the orchestrator title set.
  const groups = new Map();
  for (const t of tasks) {
    if (!orchestratorTitleSet.has(t.title) && !t.title.startsWith("Marketer:")) continue;
    const day = t.dueDate ? startOfDay(t.dueDate) : startOfDay(t.createdAt);
    const dayKey = day.toISOString().slice(0, 10);
    const key = `${t.title}|${dayKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  let groupCount = 0, removed = 0;
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    groupCount++;
    // Keeper = oldest non-Completed (so we keep the user's working copy);
    // if all are completed, keep the first one anyway.
    const keeper =
      rows.find((r) => r.status !== "Completed" && r.status !== "DONE") ||
      rows[0];
    const dupes = rows.filter((r) => r.id !== keeper.id);
    log(`  task-group [${key}] tenant=${tenantId} rows=${rows.length} keeper=${keeper.id} drop=${dupes.map((d) => d.id).join(",")}`);
    if (!COMMIT) { removed += dupes.length; continue; }
    try {
      const del = await prisma.task.updateMany({
        where: { id: { in: dupes.map((d) => d.id) } },
        data: { deletedAt: new Date() },
      });
      removed += del.count;
    } catch (e) {
      summary.errors++;
      log(`    [ERROR] soft-delete tasks: ${e.message}`);
    }
  }
  return { groupCount, removed };
}

async function main() {
  log(`#261 / #285 — cleanup orchestrator duplicate recommendations + tasks`);
  log(`Mode: ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
  log(`Scope: ${SCOPED_TENANT_ID ? `tenantId=${SCOPED_TENANT_ID}` : "all wellness tenants"}\n`);

  const tenants = await getTargetTenants();
  summary.tenants = tenants.length;

  for (const t of tenants) {
    log(`\n=== tenant ${t.id} (${t.name}, vertical=${t.vertical}) ===`);
    try {
      const r = await cleanupRecsForTenant(t.id);
      summary.recGroups += r.groupCount;
      summary.recDupesRemoved += r.removed;
      const k = await cleanupTasksForTenant(t.id);
      summary.taskGroups += k.groupCount;
      summary.taskDupesRemoved += k.removed;
    } catch (e) {
      summary.errors++;
      log(`[ERROR] tenant ${t.id}: ${e.message}`);
    }
  }

  log("\n=== Summary ===");
  log(`Mode:               ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
  log(`Tenants scanned:    ${summary.tenants}`);
  log(`Rec dupe groups:    ${summary.recGroups}`);
  log(`Rec rows removed:   ${summary.recDupesRemoved}${COMMIT ? "" : " (would remove)"}`);
  log(`Task dupe groups:   ${summary.taskGroups}`);
  log(`Task rows removed:  ${summary.taskDupesRemoved}${COMMIT ? "" : " (would soft-delete)"}`);
  log(`Errors:             ${summary.errors}`);
  log(`\n${COMMIT ? "Done." : "DRY RUN — re-run with --commit to apply."}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
