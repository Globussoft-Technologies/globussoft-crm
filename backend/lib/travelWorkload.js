// Travel CRM — manager workload aggregation (PRD §4.1, gap A9b).
//
// "Manager view — pending tasks, delayed tasks, staff-wise workload across
// brands." Pure in-process aggregation consumed by
// routes/travel_dashboard.js (GET /api/travel/dashboard/workload). No
// Prisma, no I/O — the route fetches the rows, this module does the math,
// vitest covers it in test/lib/travelWorkload.test.js.
//
// Inputs:
//   users — tenant User rows: [{ id, name, email, role, userType }].
//           Staff (userType !== "CUSTOMER") always get a per-user row,
//           even with zero tasks, so managers can see idle capacity.
//           CUSTOMER rows are skipped unless a task is assigned to them
//           (defensive — assignment UIs shouldn't allow it, but a row
//           assigned that way must not silently vanish from totals).
//   tasks — OPEN Task rows (caller pre-filters status != "Completed" and
//           deletedAt = null): [{ userId, dueDate, contact }] where
//           contact is { subBrand } | null. Tasks have no subBrand column
//           — brand attribution is derived from the linked contact;
//           taskless-of-contact / untagged-contact tasks bucket under
//           "_none".
//   now   — Date used for the overdue cut (dueDate < now). Injected for
//           deterministic tests; defaults to wall-clock.
//
// Output shape (all counts are integers; overdue ⊆ open):
//   {
//     perUser: [{ userId, name, email, role, openTasks, overdueTasks,
//                 bySubBrand: { tmc: { open, overdue }, ..., _none: {...} } }],
//     unassigned: { openTasks, overdueTasks, bySubBrand },   // userId null
//     totals:     { openTasks, overdueTasks, bySubBrand },   // tenant-wide
//     staffCount,                                            // perUser.length
//   }
//
// perUser ordering is deterministic: openTasks desc, then overdueTasks
// desc, then userId asc — busiest staff first.

const NO_BRAND_KEY = "_none";

function emptyBucket() {
  return { openTasks: 0, overdueTasks: 0, bySubBrand: {} };
}

function isOverdue(dueDate, now) {
  if (!dueDate) return false;
  const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < now.getTime();
}

function addTask(bucket, subBrandKey, overdue) {
  bucket.openTasks += 1;
  if (overdue) bucket.overdueTasks += 1;
  if (!bucket.bySubBrand[subBrandKey]) {
    bucket.bySubBrand[subBrandKey] = { open: 0, overdue: 0 };
  }
  bucket.bySubBrand[subBrandKey].open += 1;
  if (overdue) bucket.bySubBrand[subBrandKey].overdue += 1;
}

/**
 * @param {Array<{id:number,name?:string|null,email?:string|null,role?:string|null,userType?:string|null}>} users
 * @param {Array<{userId:number|null,dueDate:Date|string|null,contact?:{subBrand?:string|null}|null}>} tasks
 * @param {Date} [now]
 */
function computeTeamWorkload(users, tasks, now = new Date()) {
  const safeUsers = Array.isArray(users) ? users : [];
  const safeTasks = Array.isArray(tasks) ? tasks : [];

  const userById = new Map();
  for (const u of safeUsers) {
    if (u && Number.isFinite(u.id)) userById.set(u.id, u);
  }

  // Per-user buckets: pre-seed staff rows so zero-task staff still appear.
  const perUserById = new Map();
  function rowFor(userId) {
    let row = perUserById.get(userId);
    if (!row) {
      const u = userById.get(userId) || null;
      row = {
        userId,
        name: u ? (u.name ?? null) : null,
        email: u ? (u.email ?? null) : null,
        role: u ? (u.role ?? null) : null,
        ...emptyBucket(),
      };
      perUserById.set(userId, row);
    }
    return row;
  }
  for (const u of safeUsers) {
    if (!u || !Number.isFinite(u.id)) continue;
    if (u.userType === "CUSTOMER") continue; // portal logins aren't staff
    rowFor(u.id);
  }

  const unassigned = emptyBucket();
  const totals = emptyBucket();

  for (const t of safeTasks) {
    if (!t) continue;
    const overdue = isOverdue(t.dueDate, now);
    const subBrandKey = (t.contact && t.contact.subBrand) || NO_BRAND_KEY;

    addTask(totals, subBrandKey, overdue);
    if (t.userId == null) {
      addTask(unassigned, subBrandKey, overdue);
    } else {
      // rowFor() also covers assignees missing from the users list
      // (e.g. CUSTOMER rows or a stale assignment) — name/email null.
      addTask(rowFor(t.userId), subBrandKey, overdue);
    }
  }

  const perUser = [...perUserById.values()].sort((a, b) => {
    if (b.openTasks !== a.openTasks) return b.openTasks - a.openTasks;
    if (b.overdueTasks !== a.overdueTasks) return b.overdueTasks - a.overdueTasks;
    return a.userId - b.userId;
  });

  return { perUser, unassigned, totals, staffCount: perUser.length };
}

module.exports = { computeTeamWorkload, NO_BRAND_KEY };
