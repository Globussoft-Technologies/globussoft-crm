// @ts-check
/**
 * Gate spec — travel-vertical Visa Sure analytics endpoint SHELL.
 *
 * Pins the Phase 3 cluster B3 commit. Covers the three V16-V18 read
 * endpoints introduced for the Reports.jsx SHELL data wiring:
 *
 *   GET /api/travel/visa/analytics/rejection-recovery     (V16)
 *   GET /api/travel/visa/analytics/conversion-by-readiness (V17)
 *   GET /api/travel/visa/analytics/lead-source-rate        (V18)
 *
 * Auth gates:
 *   - 401 without bearer token
 *   - 403 USER role (verifyRole(['ADMIN','MANAGER']))
 *   - 403 wrong-vertical tenant (requireTravelTenant)
 *
 * Empty-state path:
 *   - When no Visa-Sure contacts exist (likely on a freshly-seeded box),
 *     each endpoint returns 200 with rows:[] + a `note` field rather than
 *     500ing. The Reports.jsx SHELL relies on this graceful empty.
 *
 * Happy path:
 *   - Envelope shape for each endpoint (verifies the contract the
 *     frontend wires against in the follow-up commit).
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN, seed-travel.js) +
 *            tmc-ops@travelstall.demo (travel MANAGER) +
 *            telecaller@travelstall.demo (travel USER) +
 *            admin@globussoft.com (generic ADMIN — cross-vertical guard).
 *
 * NOTE on demo state. This spec is BACKEND-SHELL only — it does not
 * create VisaApplication rows. The route is contract-pinned via the
 * empty-state path AND the happy-path envelope; either is acceptable
 * for the gate.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;

let travelAdminToken = null;
let travelManagerToken = null;
let travelUserToken = null;
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
async function getTravelManager(request) {
  if (!travelManagerToken) {
    travelManagerToken = await loginAs(request, "tmc-ops@travelstall.demo", "password123");
  }
  return travelManagerToken;
}
async function getTravelUser(request) {
  if (!travelUserToken) {
    travelUserToken = await loginAs(request, "telecaller@travelstall.demo", "password123");
  }
  return travelUserToken;
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
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, {
      headers: token ? headers(token) : { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    }),
  );
}

const ENDPOINTS = [
  "/api/travel/visa/analytics/rejection-recovery",
  "/api/travel/visa/analytics/conversion-by-readiness",
  "/api/travel/visa/analytics/lead-source-rate",
];

// ─── Auth-gate tests ─────────────────────────────────────────────────

test.describe("Visa Sure analytics — auth gates", () => {
  for (const path of ENDPOINTS) {
    test(`GET ${path} without token → 401`, async ({ request }) => {
      const r = await request.get(`${BASE_URL}${path}`, {
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      // The global auth guard returns 401 (or 403 in some hardened modes)
      // for missing tokens; both are acceptable rejection codes per the
      // CLAUDE.md cross-cutting-shape standing rule.
      expect([401, 403]).toContain(r.status());
    });
  }

  test(`GET /rejection-recovery as USER role → 403`, async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC test");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/rejection-recovery");
    expect(r.status()).toBe(403);
  });

  test(`GET /conversion-by-readiness as USER role → 403`, async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC test");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/conversion-by-readiness");
    expect(r.status()).toBe(403);
  });

  test(`GET /lead-source-rate as USER role → 403`, async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) {
      test.skip(true, "telecaller@travelstall.demo not seeded — skipping USER-RBAC test");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/lead-source-rate");
    expect(r.status()).toBe(403);
  });

  test(`GET /rejection-recovery from generic-vertical ADMIN → 403 WRONG_VERTICAL`, async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) {
      test.skip(true, "admin@globussoft.com not seeded — skipping cross-vertical guard");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/rejection-recovery");
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe("WRONG_VERTICAL");
  });
});

// ─── Happy-path / envelope-shape tests ───────────────────────────────

test.describe("Visa Sure analytics — happy path envelope", () => {
  test("GET /rejection-recovery → 200 with V16 envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping happy path");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/rejection-recovery");
    expect(r.status()).toBe(200);
    const body = await r.json();

    // Envelope shape — these fields must exist on every response,
    // populated or empty.
    expect(body).toHaveProperty("totalRejected");
    expect(body).toHaveProperty("recoveryAttempts");
    expect(body).toHaveProperty("recoverySuccesses");
    expect(body).toHaveProperty("successRate");
    expect(typeof body.totalRejected).toBe("number");
    expect(typeof body.recoveryAttempts).toBe("number");
    expect(typeof body.recoverySuccesses).toBe("number");
    expect(typeof body.successRate).toBe("number");
    // successRate must be in [0, 1]
    expect(body.successRate).toBeGreaterThanOrEqual(0);
    expect(body.successRate).toBeLessThanOrEqual(1);
  });

  test("GET /conversion-by-readiness → 200 with V17 envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping happy path");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/conversion-by-readiness");
    expect(r.status()).toBe(200);
    const body = await r.json();

    expect(body).toHaveProperty("byReadinessLevel");
    expect(Array.isArray(body.byReadinessLevel)).toBe(true);

    // When data IS present, each level row carries { level, count,
    // converted, conversionRate }. When empty, we get either rows:[]
    // (no visa contacts at all) or the 4 zero-count rows (visa contacts
    // exist but no applications). Both shapes are valid.
    for (const row of body.byReadinessLevel) {
      expect(row).toHaveProperty("level");
      expect(row).toHaveProperty("count");
      expect(row).toHaveProperty("converted");
      expect(row).toHaveProperty("conversionRate");
      expect(typeof row.level).toBe("string");
      expect(typeof row.count).toBe("number");
      expect(typeof row.converted).toBe("number");
      expect(typeof row.conversionRate).toBe("number");
      expect(row.conversionRate).toBeGreaterThanOrEqual(0);
      expect(row.conversionRate).toBeLessThanOrEqual(1);
    }
  });

  test("GET /lead-source-rate → 200 with V18 envelope", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping happy path");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/lead-source-rate");
    expect(r.status()).toBe(200);
    const body = await r.json();

    expect(body).toHaveProperty("bySource");
    expect(Array.isArray(body.bySource)).toBe(true);

    for (const row of body.bySource) {
      expect(row).toHaveProperty("source");
      expect(row).toHaveProperty("leads");
      expect(row).toHaveProperty("applications");
      expect(row).toHaveProperty("rate");
      expect(typeof row.source).toBe("string");
      expect(typeof row.leads).toBe("number");
      expect(typeof row.applications).toBe("number");
      expect(typeof row.rate).toBe("number");
      expect(row.rate).toBeGreaterThanOrEqual(0);
      expect(row.rate).toBeLessThanOrEqual(1);
    }
  });

  test("GET /rejection-recovery as MANAGER role → 200 (RBAC accepts MANAGER)", async ({ request }) => {
    const token = await getTravelManager(request);
    if (!token) {
      test.skip(true, "tmc-ops@travelstall.demo not seeded — skipping MANAGER happy path");
      return;
    }
    const r = await get(request, token, "/api/travel/visa/analytics/rejection-recovery");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("successRate");
  });
});

// ─── Empty-state graceful return ─────────────────────────────────────

test.describe("Visa Sure analytics — empty state", () => {
  test("Empty-state envelopes include rows[] (never 500)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) {
      test.skip(true, "yasin@travelstall.in not seeded — skipping empty-state");
      return;
    }
    // All three endpoints must return 200 with an array-shape `rows`
    // field even when the backing tables are empty. The Reports.jsx
    // SHELL relies on this — a 500 here would break the chart render.
    for (const path of ENDPOINTS) {
      const r = await get(request, token, path);
      expect(r.status(), `${path} should not 500 on empty state`).toBe(200);
      const body = await r.json();
      // Either rows:[] (no visa contacts) OR rows:[...] (populated).
      // The conversion-by-readiness endpoint returns rows mirroring
      // byReadinessLevel; we tolerate both possible shapes here.
      expect(
        Array.isArray(body.rows)
          || Array.isArray(body.byReadinessLevel)
          || Array.isArray(body.bySource),
        `${path} must surface an array-shape result field`,
      ).toBe(true);
    }
  });
});
