#!/usr/bin/env node
// One-shot backfill — derives User.wellnessRole from each user's currently
// assigned RBAC role on every wellness tenant.
//
// Why this exists: before the wellnessRoleSync helper landed, two code paths
// assigned RBAC roles without touching User.wellnessRole:
//   - POST /api/roles/:id/assign/:userId         (Roles & Permissions UI)
//   - POST /api/roles/users/:userId/roles        (multi-role replace)
// Plus a silent failure mode on POST/PUT /api/staff/:id when the Staff
// Edit modal's wellnessRoleType catalog fetch raced the save — the frontend
// would derive wellnessRole=null and persist it.
//
// Net effect: staff promoted to DOCTOR (or NURSE / PROFESSIONAL / STYLIST /
// TELECALLER / HELPER — anything matching the per-tenant WellnessRoleType
// catalog) had primaryRole=DOCTOR but wellnessRole=null. They never appeared
// in /api/wellness/doctors/availability so the Book Appointment doctor
// dropdown couldn't see them.
//
// What it does:
//   - For each wellness tenant, walks every User row.
//   - If the user holds an RBAC role whose lowercased key matches an active
//     WellnessRoleType.key, sets User.wellnessRole to that catalog key.
//   - If the user holds NO matching RBAC role AND their current wellnessRole
//     IS a stale catalog key, clears it (matches the runtime sync helper).
//   - Otherwise leaves the user alone.
//
// Idempotent. Dry-run by default — use --apply to persist.
//
// Usage:
//   node backend/scripts/backfill-wellness-role-from-rbac.js
//   node backend/scripts/backfill-wellness-role-from-rbac.js --apply
//   node backend/scripts/backfill-wellness-role-from-rbac.js --apply --tenant=3

const { PrismaClient } = require("@prisma/client");
const {
  syncWellnessRoleFromRbacRoles,
} = require("../lib/wellnessRoleSync");

const APPLY = process.argv.includes("--apply");
const TENANT_FILTER = (() => {
  const flag = process.argv.find((a) => a.startsWith("--tenant="));
  if (!flag) return null;
  const n = parseInt(flag.split("=")[1], 10);
  return Number.isFinite(n) ? n : null;
})();

async function main() {
  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      where: {
        vertical: "wellness",
        ...(TENANT_FILTER ? { id: TENANT_FILTER } : {}),
      },
      select: { id: true, name: true, vertical: true },
      orderBy: { id: "asc" },
    });

    console.log(
      `[backfill-wellness-role-from-rbac] mode=${APPLY ? "APPLY" : "DRY-RUN"} ` +
        `tenants=${tenants.length}` +
        (TENANT_FILTER ? ` (filtered to id=${TENANT_FILTER})` : ""),
    );

    let totalUsers = 0;
    let changedCount = 0;
    let clearedCount = 0;
    let setCount = 0;
    const samples = [];

    for (const t of tenants) {
      const users = await prisma.user.findMany({
        where: { tenantId: t.id },
        select: { id: true, name: true, email: true, wellnessRole: true },
      });
      totalUsers += users.length;

      for (const u of users) {
        const before = u.wellnessRole;
        // Re-use the runtime sync helper so the script and live writes are
        // guaranteed to agree. In dry-run we wrap each call in an aborted
        // transaction so the helper sees real DB state but no row mutates.
        let after;
        if (APPLY) {
          after = await syncWellnessRoleFromRbacRoles(prisma, {
            userId: u.id,
            tenantId: t.id,
            onlyIfEmpty: false,
          });
        } else {
          try {
            await prisma.$transaction(async (tx) => {
              after = await syncWellnessRoleFromRbacRoles(tx, {
                userId: u.id,
                tenantId: t.id,
                onlyIfEmpty: false,
              });
              throw new Error("__dry_run_abort__");
            });
          } catch (e) {
            if (e.message !== "__dry_run_abort__") throw e;
          }
        }
        if (after !== before) {
          changedCount++;
          if (after && !before) setCount++;
          else if (!after && before) clearedCount++;
          if (samples.length < 25) {
            samples.push({
              tenantId: t.id,
              userId: u.id,
              name: u.name,
              email: u.email,
              from: before,
              to: after,
            });
          }
        }
      }
    }

    console.log("");
    console.log("Summary:");
    console.log(`  Tenants scanned      : ${tenants.length}`);
    console.log(`  Users scanned        : ${totalUsers}`);
    console.log(`  Rows requiring change: ${changedCount}`);
    console.log(`    - set (null → key) : ${setCount}`);
    console.log(`    - cleared (stale)  : ${clearedCount}`);
    console.log(
      `  Mode                 : ${APPLY ? "APPLIED ✔" : "DRY-RUN (no writes)"}`,
    );
    if (samples.length > 0) {
      console.log("");
      console.log(`Sample changes (first ${samples.length}):`);
      for (const s of samples) {
        console.log(
          `  tenant=${s.tenantId} user=${s.userId} (${s.email}) ` +
            `wellnessRole: ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}`,
        );
      }
    }
    if (!APPLY && changedCount > 0) {
      console.log("");
      console.log("Re-run with --apply to persist the above changes.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[backfill-wellness-role-from-rbac] FAILED:", err);
  process.exit(1);
});
