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
 *   - shape stability under empty-state (no rows yet)
 *   - sub-brand scoping signal (subBrand keys appear in byStatus / bySubBrand)
 *
 * NOT pinned (out of scope, owned by the underlying tables' own specs):
 *   - That the count values match a specific seed state — demo seed
 *     drift would red-line this routinely. We only assert shape +
 *     numericness.
 */

const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

let travelAdminToken = null;
let genericAdminToken = null;

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
    expect(body).toHaveProperty("microsites");
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

    // Microsites shape
    expect(typeof body.microsites.published).toBe("number");
    expect(typeof body.microsites.expired).toBe("number");

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
      body.microsites.published,
      body.microsites.expired,
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
