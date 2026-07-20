// @ts-check
/**
 * Gate spec — Travel CRM Owner Dashboard aggregate.
 *
 * Route: backend/routes/travel_dashboard.js (GET /api/travel/dashboard).
 *
 * Promotes the Day-1 placeholder Dashboard.jsx to a real KPI surface
 * backed by a single round-trip aggregate. This spec pins:
 *   - auth gate (401/403 without token)
 *   - vertical gate (403 WRONG_VERTICAL for non-travel tenants)
 *   - response shape (all 6 KPI sections + recentTrips array)
 *   - landingPages tile replaced the legacy microsites tile (PR #1224)
 *   - shape stability under empty-state (no rows yet)
 *   - sub-brand scoping signal (subBrand keys appear in byStatus / bySubBrand)
 *
 * NOT pinned (out of scope, owned by the underlying tables' own specs):
 *   - That the count values match a specific seed state — demo seed
 *     drift would red-line this routinely. We only assert shape +
 *     numericness.
 *
 * Also covers GET /api/travel/dashboard/workload (gap A9b — PRD §4.1
 * manager view: pending/delayed tasks + staff-wise workload across
 * brands). Pins:
 *   - auth gate (401/403 without token)
 *   - RBAC gate (travel USER role → 403 RBAC_DENIED; MANAGER + ADMIN pass)
 *   - vertical gate (generic ADMIN → 403 WRONG_VERTICAL)
 *   - envelope shape (perUser/unassigned/totals/staffCount/generatedAt)
 *   - per-row invariants (overdueTasks ⊆ openTasks; bySubBrand keys are
 *     valid sub-brands or "_none")
 *   - ?subBrand= narrowing + 400 INVALID_SUB_BRAND on garbage
 */

const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

let travelAdminToken = null;
let genericAdminToken = null;
let travelManagerToken = null;
let travelUserToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  }
  return travelAdminToken;
}
async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, "admin@globussoft.com", "password123");
  }
  return genericAdminToken;
}
// seed-travel.js: MANAGER scoped to ["tmc"] — exercises the workload
// endpoint's MANAGER acceptance + sub-brand-narrowed task query.
async function getTravelManager(request) {
  if (!travelManagerToken) {
    travelManagerToken = await loginAs(request, "tmc-ops@travelstall.demo", "password123");
  }
  return travelManagerToken;
}
// seed-travel.js: USER role (front-desk telecaller) — exercises the 403
// RBAC gate.
async function getTravelUser(request) {
  if (!travelUserToken) {
    travelUserToken = await loginAs(request, "telecaller@travelstall.demo", "password123");
  }
  return travelUserToken;
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

// ─── Guards ─────────────────────────────────────────────────────────

test.describe("Travel dashboard API — guards", () => {
  test("GET /dashboard without token → 401/403", async ({ request }) => {
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard`, { timeout: REQUEST_TIMEOUT }),
    );
    expect([401, 403]).toContain(r.status());
  });

  test("GET /dashboard rejects generic admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("WRONG_VERTICAL");
  });
});

// ─── Happy path shape ───────────────────────────────────────────────

test.describe("Travel dashboard API — aggregate shape", () => {
  test("200 returns all 6 KPI sections + recentTrips array", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status(), `dashboard: ${await r.text()}`).toBe(200);
    const body = await r.json();

    // Top-level keys
    expect(body).toHaveProperty("trips");
    expect(body).toHaveProperty("diagnostics");
    expect(body).toHaveProperty("itineraries");
    expect(body).toHaveProperty("landingPages");
    expect(body).toHaveProperty("costMaster");
    expect(body).toHaveProperty("pricingRules");
    expect(body).toHaveProperty("recentTrips");

    // Trips shape
    expect(typeof body.trips.total).toBe("number");
    expect(typeof body.trips.upcoming30d).toBe("number");
    expect(body.trips.byStatus).toBeTruthy();
    expect(typeof body.trips.byStatus).toBe("object");

    // Diagnostics shape
    expect(typeof body.diagnostics.totalLast30d).toBe("number");
    expect(body.diagnostics.byClassification).toBeTruthy();

    // Itineraries shape
    expect(typeof body.itineraries.total).toBe("number");
    expect(body.itineraries.byStatus).toBeTruthy();

    // Landing pages shape (replaced microsites in PR #1224)
    expect(typeof body.landingPages.total).toBe("number");
    expect(typeof body.landingPages.published).toBe("number");

    // Cost master shape
    expect(typeof body.costMaster.activeRows).toBe("number");
    expect(body.costMaster.bySubBrand).toBeTruthy();

    // Pricing rules shape
    expect(typeof body.pricingRules.seasons).toBe("number");
    expect(typeof body.pricingRules.markupRules).toBe("number");

    // Recent trips: array (may be empty on a fresh tenant), each entry has
    // the minimum metadata + no PII.
    expect(Array.isArray(body.recentTrips)).toBe(true);
    expect(body.recentTrips.length).toBeLessThanOrEqual(5);
    for (const t of body.recentTrips) {
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("tripCode");
      expect(t).toHaveProperty("destination");
      expect(t).toHaveProperty("status");
      // PII gate — recentTrips MUST NOT expose participant-level fields.
      expect(t).not.toHaveProperty("participants");
      expect(t).not.toHaveProperty("paymentPlan");
      expect(t).not.toHaveProperty("schoolContactId");
    }
  });

  test("counts are non-negative integers", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    const counts = [
      body.trips.total,
      body.trips.upcoming30d,
      body.diagnostics.totalLast30d,
      body.itineraries.total,
      body.landingPages.total,
      body.landingPages.published,
      body.costMaster.activeRows,
      body.pricingRules.seasons,
      body.pricingRules.markupRules,
    ];
    for (const c of counts) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });

  test("groupBy keys are valid sub-brand or status values", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();

    // costMaster.bySubBrand should only have keys from the valid sub-brand set.
    const VALID_SUBS = new Set(["tmc", "rfu", "travelstall", "visasure"]);
    for (const key of Object.keys(body.costMaster.bySubBrand)) {
      expect(VALID_SUBS.has(key)).toBe(true);
    }

    // trips.byStatus keys should be from the documented status enum.
    const VALID_TRIP_STATUSES = new Set(["confirmed", "in-trip", "completed", "cancelled"]);
    for (const key of Object.keys(body.trips.byStatus)) {
      expect(VALID_TRIP_STATUSES.has(key)).toBe(true);
    }
  });
});

// ─── ?subBrand= scoping (the sidebar switcher drives this) ──────────
//
// The dashboard accepts an optional ?subBrand= query that narrows every
// tile to a single sub-brand (intersected with the caller's access).
// These assertions are STRUCTURAL, not seed-count-dependent:
//   - An admin scoping to a non-TMC brand must see 0 trips,
//     because TmcTrip is TMC-only and gated on canTmc.
//   - costMaster.bySubBrand must only contain the requested brand's key.
//   - A garbage subBrand is a 400 INVALID_SUB_BRAND.
test.describe("Travel dashboard API — ?subBrand= scoping", () => {
  test("?subBrand=tmc narrows costMaster.bySubBrand to the tmc key only", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard?subBrand=tmc`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    for (const key of Object.keys(body.costMaster.bySubBrand)) {
      expect(key).toBe("tmc");
    }
  });

  test("?subBrand=rfu zeroes TMC-only tiles (trips + microsites) and scopes costMaster to rfu", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard?subBrand=rfu`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    // TmcTrip is TMC-only — an RFU scope must show zero, regardless of seed state.
    expect(body.trips.total).toBe(0);
    expect(body.trips.upcoming30d).toBe(0);
    expect(body.recentTrips.length).toBe(0);
    // landingPages are tenant-scoped and support sub-brand narrowing; assert shape.
    expect(body.landingPages).toBeTruthy();
    expect(typeof body.landingPages.total).toBe("number");
    expect(typeof body.landingPages.published).toBe("number");
    // costMaster, when present, is scoped to rfu only.
    for (const key of Object.keys(body.costMaster.bySubBrand)) {
      expect(key).toBe("rfu");
    }
  });

  test("invalid ?subBrand= → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard?subBrand=not-a-brand`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_SUB_BRAND");
  });
});

// ─── GET /dashboard/workload (gap A9b — PRD §4.1 manager view) ──────

const VALID_WORKLOAD_BRAND_KEYS = new Set(["tmc", "rfu", "travelstall", "visasure", "_none"]);

function assertWorkloadBucket(bucket) {
  expect(Number.isInteger(bucket.openTasks)).toBe(true);
  expect(Number.isInteger(bucket.overdueTasks)).toBe(true);
  expect(bucket.openTasks).toBeGreaterThanOrEqual(0);
  expect(bucket.overdueTasks).toBeGreaterThanOrEqual(0);
  expect(bucket.overdueTasks).toBeLessThanOrEqual(bucket.openTasks);
  expect(bucket.bySubBrand).toBeTruthy();
  expect(typeof bucket.bySubBrand).toBe("object");
  for (const [key, split] of Object.entries(bucket.bySubBrand)) {
    expect(VALID_WORKLOAD_BRAND_KEYS.has(key), `unexpected bySubBrand key ${key}`).toBe(true);
    expect(Number.isInteger(split.open)).toBe(true);
    expect(Number.isInteger(split.overdue)).toBe(true);
    expect(split.overdue).toBeLessThanOrEqual(split.open);
  }
}

test.describe("Travel dashboard API — workload (manager view)", () => {
  test("GET /dashboard/workload without token → 401/403", async ({ request }) => {
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard/workload`, { timeout: REQUEST_TIMEOUT }),
    );
    expect([401, 403]).toContain(r.status());
  });

  test("travel USER role → 403 RBAC_DENIED (MANAGER/ADMIN only)", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) test.skip(true, "telecaller@travelstall.demo not seeded");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard/workload`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("RBAC_DENIED");
  });

  test("generic-vertical ADMIN → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard/workload`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("WRONG_VERTICAL");
  });

  test("travel ADMIN → 200 with the full workload envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard/workload`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status(), `workload: ${await r.text()}`).toBe(200);
    const body = await r.json();

    expect(Array.isArray(body.perUser)).toBe(true);
    expect(Number.isInteger(body.staffCount)).toBe(true);
    expect(body.staffCount).toBe(body.perUser.length);
    expect(typeof body.generatedAt).toBe("string");
    expect(Number.isNaN(new Date(body.generatedAt).getTime())).toBe(false);

    assertWorkloadBucket(body.totals);
    assertWorkloadBucket(body.unassigned);

    let perUserOpen = 0;
    let perUserOverdue = 0;
    for (const row of body.perUser) {
      expect(Number.isInteger(row.userId)).toBe(true);
      assertWorkloadBucket(row);
      perUserOpen += row.openTasks;
      perUserOverdue += row.overdueTasks;
    }
    // totals = unassigned + Σ perUser (the lib invariant, end-to-end).
    expect(body.totals.openTasks).toBe(perUserOpen + body.unassigned.openTasks);
    expect(body.totals.overdueTasks).toBe(perUserOverdue + body.unassigned.overdueTasks);
  });

  test("travel MANAGER → 200 (RBAC accepts MANAGER)", async ({ request }) => {
    const token = await getTravelManager(request);
    if (!token) test.skip(true, "tmc-ops@travelstall.demo not seeded");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard/workload`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status(), `workload as MANAGER: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.perUser)).toBe(true);
    // tmc-ops is narrowed to ["tmc"] — every brand split key must be tmc.
    // (Tasks without a tmc-tagged contact are excluded from a narrowed
    // view, so "_none" must not appear either.)
    for (const row of [...body.perUser, body.unassigned, body.totals]) {
      for (const key of Object.keys(row.bySubBrand)) {
        expect(key).toBe("tmc");
      }
    }
  });

  test("?subBrand=tmc narrows the brand split to tmc keys only", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard/workload?subBrand=tmc`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    for (const key of Object.keys(body.totals.bySubBrand)) {
      expect(key).toBe("tmc");
    }
  });

  test("invalid ?subBrand= → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/dashboard/workload?subBrand=not-a-brand`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_SUB_BRAND");
  });
});
