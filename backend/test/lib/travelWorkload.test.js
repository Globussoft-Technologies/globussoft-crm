// Unit tests — lib/travelWorkload.js (PRD §4.1 gap A9b).
//
// Pure-math module: no prisma, no I/O — plain input/output assertions.
// The route-side contract (RBAC, tenant scope, sub-brand narrowing of the
// task query) is pinned by e2e/tests/travel-dashboard-api.spec.js; this
// file pins the aggregation semantics:
//   - open vs overdue counting (overdue ⊆ open; null/invalid dueDate never
//     overdue; dueDate < now is overdue)
//   - bySubBrand derivation via task.contact.subBrand with "_none" fallback
//   - staff pre-seeding (zero-task staff appear; CUSTOMER users don't,
//     unless a task is assigned to them)
//   - unassigned bucket (userId null)
//   - totals = unassigned + sum(perUser)
//   - deterministic ordering (openTasks desc, overdueTasks desc, userId asc)
//   - defensive input handling (non-array, null rows)

import { describe, it, expect } from "vitest";
import { computeTeamWorkload, NO_BRAND_KEY } from "../../lib/travelWorkload";

const NOW = new Date("2026-06-12T12:00:00.000Z");
const PAST = "2026-06-01T00:00:00.000Z";
const FUTURE = "2026-07-01T00:00:00.000Z";

const staff = (id, name, role = "USER") => ({
  id, name, email: `${name.toLowerCase()}@t.test`, role, userType: "STAFF",
});

describe("computeTeamWorkload", () => {
  it("returns a zeroed envelope for empty inputs", () => {
    const out = computeTeamWorkload([], [], NOW);
    expect(out.perUser).toEqual([]);
    expect(out.staffCount).toBe(0);
    expect(out.unassigned).toEqual({ openTasks: 0, overdueTasks: 0, bySubBrand: {} });
    expect(out.totals).toEqual({ openTasks: 0, overdueTasks: 0, bySubBrand: {} });
  });

  it("tolerates non-array / garbage inputs without throwing", () => {
    const out = computeTeamWorkload(null, undefined, NOW);
    expect(out.staffCount).toBe(0);
    expect(out.totals.openTasks).toBe(0);
    // null rows inside arrays are skipped
    const out2 = computeTeamWorkload([null, staff(1, "A")], [null], NOW);
    expect(out2.staffCount).toBe(1);
    expect(out2.totals.openTasks).toBe(0);
  });

  it("counts open vs overdue per user (overdue is a subset of open)", () => {
    const users = [staff(1, "Asha", "MANAGER")];
    const tasks = [
      { userId: 1, dueDate: PAST, contact: { subBrand: "tmc" } },   // overdue
      { userId: 1, dueDate: FUTURE, contact: { subBrand: "tmc" } }, // open only
      { userId: 1, dueDate: null, contact: null },                  // no due date → never overdue
    ];
    const out = computeTeamWorkload(users, tasks, NOW);
    expect(out.perUser).toHaveLength(1);
    const row = out.perUser[0];
    expect(row.userId).toBe(1);
    expect(row.name).toBe("Asha");
    expect(row.role).toBe("MANAGER");
    expect(row.openTasks).toBe(3);
    expect(row.overdueTasks).toBe(1);
  });

  it("never marks an invalid dueDate as overdue", () => {
    const out = computeTeamWorkload(
      [staff(1, "A")],
      [{ userId: 1, dueDate: "not-a-date", contact: null }],
      NOW,
    );
    expect(out.perUser[0].openTasks).toBe(1);
    expect(out.perUser[0].overdueTasks).toBe(0);
  });

  it("derives bySubBrand from contact.subBrand with _none fallback", () => {
    const tasks = [
      { userId: 1, dueDate: PAST, contact: { subBrand: "tmc" } },
      { userId: 1, dueDate: FUTURE, contact: { subBrand: "rfu" } },
      { userId: 1, dueDate: FUTURE, contact: { subBrand: null } },
      { userId: 1, dueDate: FUTURE, contact: null },
    ];
    const out = computeTeamWorkload([staff(1, "A")], tasks, NOW);
    const by = out.perUser[0].bySubBrand;
    expect(by.tmc).toEqual({ open: 1, overdue: 1 });
    expect(by.rfu).toEqual({ open: 1, overdue: 0 });
    expect(by[NO_BRAND_KEY]).toEqual({ open: 2, overdue: 0 });
    // tenant totals mirror the same split
    expect(out.totals.bySubBrand.tmc).toEqual({ open: 1, overdue: 1 });
    expect(out.totals.bySubBrand[NO_BRAND_KEY]).toEqual({ open: 2, overdue: 0 });
  });

  it("pre-seeds zero-task staff rows but skips CUSTOMER users", () => {
    const users = [
      staff(1, "Busy"),
      staff(2, "Idle"),
      { id: 3, name: "Portal Customer", email: "c@t.test", role: "USER", userType: "CUSTOMER" },
    ];
    const out = computeTeamWorkload(users, [{ userId: 1, dueDate: null, contact: null }], NOW);
    const ids = out.perUser.map((r) => r.userId);
    expect(ids).toContain(1);
    expect(ids).toContain(2); // idle staff still listed
    expect(ids).not.toContain(3); // customer with no tasks hidden
    expect(out.staffCount).toBe(2);
    const idle = out.perUser.find((r) => r.userId === 2);
    expect(idle.openTasks).toBe(0);
    expect(idle.overdueTasks).toBe(0);
  });

  it("still surfaces a CUSTOMER (or unknown) assignee when a task points at them", () => {
    const users = [
      { id: 3, name: "Portal Customer", email: "c@t.test", role: "USER", userType: "CUSTOMER" },
    ];
    const tasks = [
      { userId: 3, dueDate: PAST, contact: null },  // assigned to customer
      { userId: 99, dueDate: null, contact: null }, // assignee not in users list
    ];
    const out = computeTeamWorkload(users, tasks, NOW);
    const customer = out.perUser.find((r) => r.userId === 3);
    expect(customer).toBeTruthy();
    expect(customer.openTasks).toBe(1);
    const unknown = out.perUser.find((r) => r.userId === 99);
    expect(unknown).toBeTruthy();
    expect(unknown.name).toBeNull();
    expect(unknown.email).toBeNull();
  });

  it("buckets userId=null tasks under unassigned, included in totals", () => {
    const tasks = [
      { userId: null, dueDate: PAST, contact: { subBrand: "visasure" } },
      { userId: 1, dueDate: FUTURE, contact: { subBrand: "tmc" } },
    ];
    const out = computeTeamWorkload([staff(1, "A")], tasks, NOW);
    expect(out.unassigned.openTasks).toBe(1);
    expect(out.unassigned.overdueTasks).toBe(1);
    expect(out.unassigned.bySubBrand.visasure).toEqual({ open: 1, overdue: 1 });
    expect(out.totals.openTasks).toBe(2);
    expect(out.totals.overdueTasks).toBe(1);
  });

  it("totals equal unassigned plus the sum of perUser rows", () => {
    const tasks = [
      { userId: 1, dueDate: PAST, contact: { subBrand: "tmc" } },
      { userId: 2, dueDate: FUTURE, contact: { subBrand: "rfu" } },
      { userId: null, dueDate: PAST, contact: null },
    ];
    const out = computeTeamWorkload([staff(1, "A"), staff(2, "B")], tasks, NOW);
    const perUserOpen = out.perUser.reduce((acc, r) => acc + r.openTasks, 0);
    const perUserOverdue = out.perUser.reduce((acc, r) => acc + r.overdueTasks, 0);
    expect(out.totals.openTasks).toBe(perUserOpen + out.unassigned.openTasks);
    expect(out.totals.overdueTasks).toBe(perUserOverdue + out.unassigned.overdueTasks);
  });

  it("orders perUser by openTasks desc, overdueTasks desc, userId asc", () => {
    const users = [staff(1, "A"), staff(2, "B"), staff(3, "C"), staff(4, "D")];
    const tasks = [
      // user 2: 2 open, 0 overdue
      { userId: 2, dueDate: FUTURE, contact: null },
      { userId: 2, dueDate: FUTURE, contact: null },
      // user 3: 2 open, 1 overdue → ahead of user 2 on the tiebreak
      { userId: 3, dueDate: PAST, contact: null },
      { userId: 3, dueDate: FUTURE, contact: null },
      // user 1: 1 open
      { userId: 1, dueDate: FUTURE, contact: null },
      // user 4: 0 tasks
    ];
    const out = computeTeamWorkload(users, tasks, NOW);
    expect(out.perUser.map((r) => r.userId)).toEqual([3, 2, 1, 4]);
  });

  it("accepts Date objects as dueDate", () => {
    const out = computeTeamWorkload(
      [staff(1, "A")],
      [{ userId: 1, dueDate: new Date(PAST), contact: null }],
      NOW,
    );
    expect(out.perUser[0].overdueTasks).toBe(1);
  });
});
