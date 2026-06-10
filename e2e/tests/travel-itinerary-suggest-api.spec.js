// @ts-check
/**
 * Gate spec — travel-vertical itinerary AI "Suggest" endpoint.
 *
 * Covers PRD_TRAVEL_ITINERARY_UPGRADES FR-3.4:
 *   POST /api/travel/itineraries/suggest
 *
 * The endpoint returns a STRUCTURED day-by-day draft for operator review
 * (no DB write per FR-3.4(e)). Until Q11 LLM keys land it runs in stub
 * mode (model gemini-flash, stub:true) and assembles a deterministic
 * skeleton — so this spec pins the stub contract.
 *
 * Verifies:
 *   - happy path returns { suggestion:{ summary, days[] }, model, stub }
 *   - days array length === requested days; each day has a valid item set
 *   - budget split lands on the per-night hotel estimatedCost
 *   - validation (missing destination, out-of-range days, bad sub-brand)
 *   - auth gate (no token → 401)
 *   - cross-vertical guard (generic tenant → 403 WRONG_VERTICAL)
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN, seed-travel.js) +
 * admin@globussoft.com (generic ADMIN, seed.js). No persisted rows → no
 * cleanup needed (the only side-effect is a tenant-scoped LlmCallLog row).
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

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
  if (!travelAdminToken) travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  return travelAdminToken;
}
async function getGenericAdmin(request) {
  if (!genericAdminToken) genericAdminToken = await loginAs(request, "admin@globussoft.com", "password123");
  return genericAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      headers: token ? headers(token) : { "Content-Type": "application/json" },
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

const SUGGEST = "/api/travel/itineraries/suggest";

test.describe("Travel itinerary suggest — POST /api/travel/itineraries/suggest", () => {
  test("happy path returns a structured day-by-day stub suggestion", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin login unavailable");

    const r = await post(request, token, SUGGEST, { destination: "Dubai", days: 3, subBrand: "rfu" });
    expect(r.status()).toBe(200);
    const body = await r.json();

    expect(body).toMatchObject({ model: "gemini-flash", stub: true });
    expect(body.suggestion).toBeTruthy();
    expect(typeof body.suggestion.summary).toBe("string");
    expect(Array.isArray(body.suggestion.days)).toBe(true);
    expect(body.suggestion.days).toHaveLength(3);

    // Day numbering is 1..N and each day carries at least a hotel + activity.
    body.suggestion.days.forEach((day, idx) => {
      expect(day.dayNumber).toBe(idx + 1);
      expect(Array.isArray(day.items)).toBe(true);
      const types = day.items.map((it) => it.itemType);
      expect(types).toContain("hotel");
      expect(types).toContain("activity");
    });
    // Day 1 has an arrival flight; last day has a departure flight.
    expect(body.suggestion.days[0].items.some((it) => it.itemType === "flight")).toBe(true);
    expect(body.suggestion.days[2].items.some((it) => it.itemType === "flight")).toBe(true);
  });

  test("budget-per-pax splits onto the per-night hotel estimatedCost", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin login unavailable");

    const r = await post(request, token, SUGGEST, { destination: "Bali", days: 4, budgetPerPax: 40000 });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const hotelDay1 = body.suggestion.days[0].items.find((it) => it.itemType === "hotel");
    // 40000 / 4 = 10000 per night.
    expect(hotelDay1.estimatedCost).toBe(10000);
  });

  test("rejects a missing destination with 400", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin login unavailable");
    const r = await post(request, token, SUGGEST, { days: 3 });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("MISSING_DESTINATION");
  });

  test("rejects out-of-range days with 400", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin login unavailable");
    const zero = await post(request, token, SUGGEST, { destination: "Goa", days: 0 });
    expect(zero.status()).toBe(400);
    expect((await zero.json()).code).toBe("INVALID_DAYS");
    const tooMany = await post(request, token, SUGGEST, { destination: "Goa", days: 99 });
    expect(tooMany.status()).toBe(400);
    expect((await tooMany.json()).code).toBe("INVALID_DAYS");
  });

  test("rejects an invalid sub-brand with 400", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin login unavailable");
    const r = await post(request, token, SUGGEST, { destination: "Dubai", days: 2, subBrand: "not-a-brand" });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_SUB_BRAND");
  });

  test("requires authentication (401 without token)", async ({ request }) => {
    const r = await post(request, null, SUGGEST, { destination: "Dubai", days: 2 });
    expect(r.status()).toBe(401);
  });

  test("rejects a generic (non-travel) tenant with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    test.skip(!token, "generic admin login unavailable");
    const r = await post(request, token, SUGGEST, { destination: "Dubai", days: 2 });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("WRONG_VERTICAL");
  });
});
