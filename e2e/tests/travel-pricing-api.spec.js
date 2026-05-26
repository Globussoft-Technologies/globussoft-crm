// @ts-check
/**
 * Gate spec — TravelSeasonCalendar + TravelMarkupRule + /pricing/quote.
 *
 * Pins the Day 12 commit. The /quote endpoint is the central composition
 * point — it pulls cost-master + season + markup rows from the DB and
 * runs them through backend/lib/travelPricing.js. The lib itself has 21
 * vitest cases pinning the deterministic math; this spec pins the
 * route's Prisma-side wiring and validators.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_PR_${Date.now()}`;

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

const created = { seasonIds: [], ruleIds: [], costIds: [] };
const routeSku = `${RUN_TAG}_Makkah:Hilton:Deluxe`;

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Seed a cost-master row that /quote will look up
  const cRes = await post(request, token, "/api/travel/cost-master", {
    subBrand: "rfu",
    category: "hotel",
    routeOrSku: routeSku,
    baseRate: 10000,
    currency: "INR",
  });
  if (cRes.ok()) {
    created.costIds.push((await cRes.json()).id);
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of created.seasonIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/seasons/${id}`).catch(() => {});
  }
  for (const id of created.ruleIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/markup-rules/${id}`).catch(() => {});
  }
  for (const id of created.costIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/cost-master/${id}`).catch(() => {});
  }
});

// ─── Guards ──────────────────────────────────────────────────────────

test.describe("Travel pricing API — guards", () => {
  test("GET /seasons rejects generic admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/seasons");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("POST /pricing/quote without auth → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/pricing/quote`, {
      data: { subBrand: "rfu", category: "hotel", routeOrSku: "x", tripDate: "2026-06-01" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Seasons CRUD ────────────────────────────────────────────────────

test.describe("Travel pricing API — seasons CRUD", () => {
  test("POST /seasons creates ramadan-peak season", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await post(request, token, "/api/travel/seasons", {
      subBrand: "rfu",
      seasonName: `${RUN_TAG}_ramadan`,
      startDate: "2026-03-01",
      endDate: "2026-04-15",
      multiplier: 2.0,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(Number(body.multiplier)).toBe(2.0);
    created.seasonIds.push(body.id);
  });

  test("POST /seasons missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/seasons", { subBrand: "rfu" });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST /seasons with endDate < startDate → 400 INVERTED_DATES", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/seasons", {
      subBrand: "rfu",
      seasonName: "x",
      startDate: "2026-05-01",
      endDate: "2026-04-01",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVERTED_DATES");
  });

  test("POST /seasons with negative multiplier → 400 INVALID_MULTIPLIER", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/seasons", {
      subBrand: "rfu",
      seasonName: "x",
      startDate: "2026-01-01",
      endDate: "2026-02-01",
      multiplier: -0.5,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_MULTIPLIER");
  });

  test("GET /seasons lists them", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/seasons?subBrand=rfu");
    expect(res.status()).toBe(200);
    expect(Array.isArray((await res.json()).seasons)).toBe(true);
  });

  test("PATCH /seasons amends multiplier", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.seasonIds.length === 0) test.skip(true, "no seasons");
    const res = await patch(request, token, `/api/travel/seasons/${created.seasonIds[0]}`, {
      multiplier: 2.25,
    });
    expect(res.status()).toBe(200);
    expect(Number((await res.json()).multiplier)).toBe(2.25);
  });
});

// ─── Markup rules CRUD ───────────────────────────────────────────────

test.describe("Travel pricing API — markup rules CRUD", () => {
  test("POST /markup-rules creates a 10% hotel markup rule", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await post(request, token, "/api/travel/markup-rules", {
      subBrand: "rfu",
      scope: "hotel",
      matchKeyJson: "{}",
      markupPct: 10,
      priority: 100,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(Number(body.markupPct)).toBe(10);
    created.ruleIds.push(body.id);
  });

  test("POST /markup-rules with BOTH pct + flat → 400 EXACTLY_ONE_MARKUP_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/markup-rules", {
      subBrand: "rfu",
      scope: "hotel",
      matchKeyJson: "{}",
      markupPct: 10,
      markupFlat: 500,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EXACTLY_ONE_MARKUP_TYPE");
  });

  test("POST /markup-rules with NEITHER pct nor flat → 400 EXACTLY_ONE_MARKUP_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/markup-rules", {
      subBrand: "rfu",
      scope: "hotel",
      matchKeyJson: "{}",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EXACTLY_ONE_MARKUP_TYPE");
  });

  test("POST /markup-rules with bad scope → 400 INVALID_SCOPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/markup-rules", {
      subBrand: "rfu",
      scope: "yacht",
      matchKeyJson: "{}",
      markupPct: 10,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SCOPE");
  });

  test("GET /markup-rules lists them", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/markup-rules?subBrand=rfu&scope=hotel");
    expect(res.status()).toBe(200);
    expect(Array.isArray((await res.json()).rules)).toBe(true);
  });
});

// ─── /pricing/quote (the composition endpoint) ───────────────────────

test.describe("Travel pricing API — /quote composition", () => {
  test("POST /pricing/quote composes baseRate × season × markup", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.costIds.length === 0) test.skip(true, "no cost row");
    // Use the dates that match the ramadan-peak season created above
    const res = await post(request, token, "/api/travel/pricing/quote", {
      subBrand: "rfu",
      category: "hotel",
      routeOrSku: routeSku,
      tripDate: "2026-03-20",
    });
    expect(res.status(), `quote: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.baseRate).toBe(10000);
    // After the season PATCH above we have multiplier 2.25; subtotal = 22500
    expect(body.seasonMultiplier).toBeGreaterThan(1.9); // 2.0 or 2.25
    expect(body.subtotal).toBeGreaterThan(0);
    expect(body.grandTotal).toBeGreaterThan(body.subtotal);
    // 10% markup rule above → markupAmount = subtotal * 0.10
    expect(body.markupAmount).toBeCloseTo(body.subtotal * 0.10, 2);
  });

  test("POST /pricing/quote with missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/pricing/quote", { subBrand: "rfu" });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST /pricing/quote with unknown cost-master → 404 COST_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/pricing/quote", {
      subBrand: "rfu",
      category: "hotel",
      routeOrSku: "Nonexistent:Hotel:Suite",
      tripDate: "2026-03-20",
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("COST_NOT_FOUND");
  });

  test("POST /pricing/quote with off-season date returns multiplier=1.0 + warning", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.costIds.length === 0) test.skip(true, "no cost row");
    const res = await post(request, token, "/api/travel/pricing/quote", {
      subBrand: "rfu",
      category: "hotel",
      routeOrSku: routeSku,
      tripDate: "2026-12-25", // outside all configured seasons
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.seasonMultiplier).toBe(1);
    expect(body.warnings.some((w) => w.startsWith("no-season-matched"))).toBe(true);
  });
});
