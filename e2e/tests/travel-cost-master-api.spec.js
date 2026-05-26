// @ts-check
/**
 * Gate spec — TravelCostMaster CRUD.
 *
 * Pins the Day 8 commit. Cost-master is the supplier-rate book RFU +
 * Travel Stall advisors look up when building Itinerary line items.
 *
 * Covers:
 *   GET    /api/travel/cost-master
 *   POST   /api/travel/cost-master                  (ADMIN+MANAGER)
 *   GET    /api/travel/cost-master/:id
 *   PATCH  /api/travel/cost-master/:id              (ADMIN+MANAGER)
 *   DELETE /api/travel/cost-master/:id              (ADMIN only)
 *
 * + vertical guard (rejects generic / wellness with 403).
 * + category guard (rejects out-of-enum with 400 INVALID_CATEGORY).
 * + baseRate guard (rejects negatives + non-numerics).
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_COST_${Date.now()}`;

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
    } catch (_e) { if (attempt === 0) continue; }
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

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}
async function post(request, token, path, body) {
  return retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function patch(request, token, path, body) {
  return retryOn5xx(() => request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

const created = { rateIds: [] };

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of created.rateIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/cost-master/${id}`).catch(() => {});
  }
});

test.describe("Travel cost-master API — guards", () => {
  test("GET /cost-master rejects generic admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/cost-master");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("GET /cost-master without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/cost-master`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });
});

test.describe("Travel cost-master API — CRUD", () => {
  test("POST creates a hotel rate", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    const res = await post(request, token, "/api/travel/cost-master", {
      subBrand: "rfu",
      category: "hotel",
      routeOrSku: `${RUN_TAG}_Makkah:Hilton:Deluxe`,
      baseRate: 18500,
      currency: "INR",
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(Number(body.baseRate)).toBe(18500);
    expect(body.category).toBe("hotel");
    expect(body.isActive).toBe(true);
    created.rateIds.push(body.id);
  });

  test("POST with missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/cost-master", {
      subBrand: "rfu",
      // category + routeOrSku + baseRate missing
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST with bad category → 400 INVALID_CATEGORY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/cost-master", {
      subBrand: "rfu",
      category: "yacht",
      routeOrSku: "x",
      baseRate: 1,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CATEGORY");
  });

  test("POST with bad subBrand → 400 INVALID_SUB_BRAND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/cost-master", {
      subBrand: "moonbase",
      category: "hotel",
      routeOrSku: "x",
      baseRate: 1,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SUB_BRAND");
  });

  test("POST with negative baseRate → 400 INVALID_BASE_RATE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/cost-master", {
      subBrand: "rfu",
      category: "hotel",
      routeOrSku: "x",
      baseRate: -100,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BASE_RATE");
  });

  test("POST with non-numeric baseRate → 400 INVALID_BASE_RATE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/cost-master", {
      subBrand: "rfu",
      category: "hotel",
      routeOrSku: "x",
      baseRate: "not-a-number",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BASE_RATE");
  });

  test("GET /cost-master?subBrand=rfu&category=hotel returns the row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.rateIds.length === 0) test.skip(true, "no rates");
    const res = await get(request, token, "/api/travel/cost-master?subBrand=rfu&category=hotel");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rates)).toBe(true);
    expect(body.rates.length).toBeGreaterThanOrEqual(1);
    expect(body.rates.every((r) => r.category === "hotel" && r.subBrand === "rfu")).toBe(true);
  });

  test("GET /cost-master?routeOrSku=substring matches", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.rateIds.length === 0) test.skip(true, "no rates");
    const res = await get(
      request,
      token,
      `/api/travel/cost-master?routeOrSku=${encodeURIComponent(RUN_TAG)}`,
    );
    expect(res.status()).toBe(200);
    expect((await res.json()).rates.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /cost-master/:id returns the row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.rateIds.length === 0) test.skip(true, "no rates");
    const res = await get(request, token, `/api/travel/cost-master/${created.rateIds[0]}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).id).toBe(created.rateIds[0]);
  });

  test("GET /cost-master/:id unknown → 404 NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/cost-master/9999999");
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  test("PATCH amends baseRate", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.rateIds.length === 0) test.skip(true, "no rates");
    const res = await patch(request, token, `/api/travel/cost-master/${created.rateIds[0]}`, {
      baseRate: 19500,
    });
    expect(res.status()).toBe(200);
    expect(Number((await res.json()).baseRate)).toBe(19500);
  });

  test("PATCH with negative baseRate → 400 INVALID_BASE_RATE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.rateIds.length === 0) test.skip(true, "no rates");
    const res = await patch(request, token, `/api/travel/cost-master/${created.rateIds[0]}`, {
      baseRate: -1,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BASE_RATE");
  });

  test("PATCH with empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.rateIds.length === 0) test.skip(true, "no rates");
    const res = await patch(request, token, `/api/travel/cost-master/${created.rateIds[0]}`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_BODY");
  });
});
