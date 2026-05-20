// @ts-check
/**
 * Gate spec — Travel CRM Reports aggregates.
 *
 * Routes: backend/routes/travel_reports.js
 *   GET /api/travel/reports/tmc
 *   GET /api/travel/reports/rfu
 *   GET /api/travel/reports/cross-brand
 *
 * Pins:
 *   - Auth gate (401/403 without token)
 *   - Vertical gate (403 WRONG_VERTICAL for generic admin)
 *   - Shape of each endpoint (the keys the frontend reads)
 *   - Counts are non-negative numbers
 *   - No PII leakage in the payload (no participant names, no emails)
 *
 * Deliberately NOT pinned: specific count values. Demo seed drift would
 * red-line that routinely; shape + numericness are the load-bearing
 * invariants.
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

// Shared helper — assert response is a plain object with no obvious PII keys.
function expectNoPii(obj) {
  const PII_KEYS = ["email", "phone", "passport", "aadhaar", "fullName", "participants", "schoolContactId"];
  function check(val) {
    if (Array.isArray(val)) { val.forEach(check); return; }
    if (val && typeof val === "object") {
      for (const k of Object.keys(val)) {
        const lc = k.toLowerCase();
        for (const pii of PII_KEYS) {
          if (lc.includes(pii.toLowerCase())) {
            throw new Error(`PII leakage: object key "${k}" appeared in reports payload`);
          }
        }
        check(val[k]);
      }
    }
  }
  check(obj);
}

// ─── Guards ─────────────────────────────────────────────────────────

test.describe("Travel reports API — guards", () => {
  test("GET /reports/tmc without token → 401/403", async ({ request }) => {
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/reports/tmc`, { timeout: REQUEST_TIMEOUT }),
    );
    expect([401, 403]).toContain(r.status());
  });

  test("generic admin → 403 WRONG_VERTICAL on /reports/tmc", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/reports/tmc`, {
        headers: headers(token), timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("WRONG_VERTICAL");
  });

  test("generic admin → 403 WRONG_VERTICAL on /reports/cross-brand", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/reports/cross-brand`, {
        headers: headers(token), timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
  });
});

// ─── TMC shape ──────────────────────────────────────────────────────

test.describe("Travel reports API — TMC shape", () => {
  test("200 returns full TMC payload shape + no PII", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/reports/tmc`, {
        headers: headers(token), timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status(), `tmc: ${await r.text()}`).toBe(200);
    const body = await r.json();

    expect(body).toHaveProperty("trips");
    expect(body).toHaveProperty("revenue");
    expect(body).toHaveProperty("schools");
    expect(body).toHaveProperty("deals");
    expect(body).toHaveProperty("diagnostics");

    expect(typeof body.trips.total).toBe("number");
    expect(typeof body.trips.active).toBe("number");
    expect(typeof body.revenue.total).toBe("number");
    expect(Array.isArray(body.revenue.topDestinations)).toBe(true);
    expect(body.revenue.currency).toBe("INR");
    expect(typeof body.schools.unique).toBe("number");
    expect(typeof body.schools.repeat).toBe("number");
    expect(typeof body.schools.repeatRatePct).toBe("number");
    expect(body.deals.byStage).toBeTruthy();
    expect(body.deals.amountByStage).toBeTruthy();

    // topDestinations entries — each is { destination, revenue }, top 10 max.
    expect(body.revenue.topDestinations.length).toBeLessThanOrEqual(10);
    for (const row of body.revenue.topDestinations) {
      expect(row).toHaveProperty("destination");
      expect(typeof row.revenue).toBe("number");
      expect(row.revenue).toBeGreaterThanOrEqual(0);
    }

    expectNoPii(body);
  });

  test("TMC counts are non-negative integers", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/reports/tmc`, {
        headers: headers(token), timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    const counts = [
      body.trips.total, body.trips.active,
      body.schools.unique, body.schools.repeat,
    ];
    for (const c of counts) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
    expect(body.revenue.total).toBeGreaterThanOrEqual(0);
  });
});

// ─── RFU shape ──────────────────────────────────────────────────────

test.describe("Travel reports API — RFU shape", () => {
  test("200 returns full RFU payload shape + no PII", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/reports/rfu`, {
        headers: headers(token), timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status(), `rfu: ${await r.text()}`).toBe(200);
    const body = await r.json();

    expect(body).toHaveProperty("itineraries");
    expect(body).toHaveProperty("deals");
    expect(body).toHaveProperty("diagnostics");
    expect(body).toHaveProperty("customers");
    expect(body.currency).toBe("INR");

    expect(typeof body.itineraries.total).toBe("number");
    expect(body.itineraries.byStatus).toBeTruthy();
    expect(body.itineraries.amountByStatus).toBeTruthy();
    expect(body.diagnostics.byTier).toBeTruthy();
    expect(typeof body.customers.unique).toBe("number");
    expect(typeof body.customers.repeat).toBe("number");
    expect(typeof body.customers.repeatRatePct).toBe("number");

    expectNoPii(body);
  });
});

// ─── Cross-brand shape ──────────────────────────────────────────────

test.describe("Travel reports API — cross-brand shape", () => {
  test("200 returns subBrands map with won/lost/wonRevenue/conversionPct + no PII", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/reports/cross-brand`, {
        headers: headers(token), timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status(), `cross-brand: ${await r.text()}`).toBe(200);
    const body = await r.json();

    expect(body).toHaveProperty("subBrands");
    expect(body.currency).toBe("INR");
    expect(typeof body.subBrands).toBe("object");

    // Sub-brand keys (if any) must be from the documented enum.
    const VALID_SUBS = new Set(["tmc", "rfu", "travelstall", "visasure"]);
    for (const brand of Object.keys(body.subBrands)) {
      expect(VALID_SUBS.has(brand)).toBe(true);
      const m = body.subBrands[brand];
      expect(typeof m.won).toBe("number");
      expect(typeof m.lost).toBe("number");
      expect(typeof m.wonRevenue).toBe("number");
      expect(typeof m.conversionPct).toBe("number");
      expect(typeof m.diagnostics).toBe("number");
      expect(m.conversionPct).toBeGreaterThanOrEqual(0);
      expect(m.conversionPct).toBeLessThanOrEqual(100);
    }

    expectNoPii(body);
  });
});
