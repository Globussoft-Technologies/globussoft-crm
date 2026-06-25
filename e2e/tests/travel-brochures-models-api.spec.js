// @ts-check
/**
 * Gate spec — Brochure Engine model catalog + auth gates.
 *
 * Pins the BROCHURE_HANDOFF Phase 2 work: the new GET /api/travel/brochures/models
 * route (model catalog for the picker + pre-run cost estimate) plus the shared
 * auth/vertical guards on the brochure surface.
 *
 * Engine boundary: the real agentic-orchcrm engine is NOT installed in CI, so
 * `listModels()` (which spawns the engine in CATALOG mode) rejects and the route
 * returns 503 ENGINE_UNAVAILABLE with empty arrays — by design, so the UI can
 * degrade to strategy presets. When the engine IS vendored (local dev), the same
 * route returns 200 with the populated catalog. This spec asserts the ROUTE
 * CONTRACT (auth + vertical gate + response shape) and accepts EITHER outcome —
 * it never depends on a real model catalog being present.
 *
 * Covers:
 *   GET /api/travel/brochures/models   — 401 (no auth), 403 (generic tenant),
 *                                        200|503 shape (travel admin)
 *   GET /api/travel/brochures/sectors  — 401 (no auth), 200 shape (travel admin)
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
    } catch (_e) { if (attempt === 0) continue; }
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
  // NOTE: 503 ENGINE_UNAVAILABLE from /models is a VALID terminal response (no
  // engine in CI), so it must NOT be retried as a transient 5xx. Only retry
  // 500/502/504.
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    const s = r.status();
    if (s < 500 || s === 503) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

test.describe("Brochure Engine — /models catalog + auth", () => {
  test("GET /brochures/models without a token → 401", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/travel/brochures/models`, {
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });

  test("GET /brochures/models as a generic (non-travel) tenant → 403", async ({ request }) => {
    const token = await getGenericAdmin(request);
    test.skip(!token, "generic admin login unavailable");
    const r = await get(request, token, "/api/travel/brochures/models");
    expect(r.status()).toBe(403);
  });

  test("GET /brochures/models as travel admin → 200 catalog OR 503 engine-unavailable, valid shape either way", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin login unavailable");
    const r = await get(request, token, "/api/travel/brochures/models");
    expect([200, 503]).toContain(r.status());
    const body = await r.json();

    // Both outcomes carry the same envelope keys so the UI renders uniformly.
    expect(Array.isArray(body.models)).toBe(true);
    expect(Array.isArray(body.tiers)).toBe(true);
    expect(Array.isArray(body.strategies)).toBe(true);

    if (r.status() === 503) {
      expect(body.code).toBe("ENGINE_UNAVAILABLE");
      expect(body.models.length).toBe(0);
    } else {
      // Engine present → at least one catalog entry with the picker's fields.
      expect(body.models.length).toBeGreaterThan(0);
      const m = body.models[0];
      expect(typeof m.id).toBe("string");
      expect(typeof m.label).toBe("string");
      expect(typeof m.provider).toBe("string");
      expect(typeof m.available).toBe("boolean");
      expect(typeof m.inputPer1M).toBe("number");
      expect(typeof m.outputPer1M).toBe("number");
      // Strategy presets are always present alongside the model list.
      expect(body.strategies).toEqual(expect.arrayContaining(["recommended", "cheapest", "smartest"]));
    }
  });

  test("GET /brochures/sectors without a token → 401", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/travel/brochures/sectors`, {
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });

  test("GET /brochures/sectors as travel admin → 200 with a non-empty sector list", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin login unavailable");
    const r = await get(request, token, "/api/travel/brochures/sectors");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.sectors)).toBe(true);
    expect(body.sectors.length).toBeGreaterThan(0);
    expect(body.sectors.some((s) => s.key === "travel")).toBe(true);
  });
});
