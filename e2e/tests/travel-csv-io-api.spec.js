// @ts-check
/**
 * Gate spec — Travel CRM CSV import/export.
 *
 * Routes: backend/routes/travel_csv_io.js (mounted at /api/travel).
 * Closes the Phase 1.5 polish-list item: "CSV import for cost-master +
 * diagnostic banks. Mirrors the pattern in routes/csv_io.js."
 *
 * Endpoints covered:
 *   GET  /api/travel/cost-master/export.csv         — verifyToken + requireTravelTenant
 *   POST /api/travel/cost-master/import.csv         — ADMIN | MANAGER
 *   GET  /api/travel/diagnostic-banks/export.csv    — verifyToken + requireTravelTenant
 *   POST /api/travel/diagnostic-banks/import.csv    — ADMIN only
 *
 * Coverage targets:
 *   - Export: 200 + Content-Type text/csv + UTF-8 BOM byte + column header.
 *   - Import: per-row { rowNumber, reason } error reports; idempotent re-runs.
 *   - Vertical gate: generic-tenant admin → 403 NOT_TRAVEL_TENANT.
 *   - Role gate: MANAGER can import cost-master but is rejected on the
 *     diagnostic-banks import (ADMIN-only contract matches POST /diagnostic-banks).
 *
 * Cleanup: every test row carries RUN_TAG in routeOrSku / subBrand-derived
 * fields. Demo-hygiene cron sweeps tagged rows hourly; no explicit cleanup.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_CSV_${Date.now()}`;
const UTF8_BOM = "﻿";

let travelAdminToken = null;
let travelManagerToken = null;
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
    // Demo Admin (admin@travelstall.demo) is seeded as a MANAGER on the
    // travel tenant per seed-travel.js. If unavailable in this env we
    // skip the manager-only tests rather than fail.
    travelManagerToken = await loginAs(request, "admin@travelstall.demo", "password123");
  }
  return travelManagerToken;
}
async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, "admin@globussoft.com", "password123");
  }
  return genericAdminToken;
}

const jsonHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
const csvHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "text/csv",
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

// ── Auth + vertical gate ──────────────────────────────────────────

test.describe("Travel CSV — auth + vertical gate", () => {
  test("401 without token on cost-master export", async ({ request }) => {
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/cost-master/export.csv`, { timeout: REQUEST_TIMEOUT }),
    );
    expect([401, 403]).toContain(r.status());
  });

  test("401 without token on cost-master import", async ({ request }) => {
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/cost-master/import.csv`, {
        headers: { "Content-Type": "text/csv" },
        data: "subBrand,category,routeOrSku,baseRate\ntmc,hotel,X,100",
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect([401, 403]).toContain(r.status());
  });

  test("generic admin → 403 on cost-master export (not a travel tenant)", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/cost-master/export.csv`, {
        headers: jsonHeaders(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
  });

  test("generic admin → 403 on diagnostic-banks export", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "generic admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/diagnostic-banks/export.csv`, {
        headers: jsonHeaders(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
  });
});

// ── Export happy path ─────────────────────────────────────────────

test.describe("Travel CSV — export shape", () => {
  test("cost-master export returns BOM + column header + text/csv", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/cost-master/export.csv`, {
        headers: jsonHeaders(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toMatch(/text\/csv/);
    const text = await r.text();
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toContain("subBrand,category,routeOrSku");
  });

  test("diagnostic-banks export returns BOM + column header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/diagnostic-banks/export.csv`, {
        headers: jsonHeaders(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const text = await r.text();
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toContain("subBrand,version");
  });

  test("cost-master export rejects invalid ?category", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.get(`${BASE_URL}/api/travel/cost-master/export.csv?category=bogus`, {
        headers: jsonHeaders(token),
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("INVALID_CATEGORY");
  });
});

// ── Cost-master import ────────────────────────────────────────────

test.describe("Travel CSV — cost-master import", () => {
  test("400 NO_CSV when no body is provided", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/cost-master/import.csv`, {
        headers: csvHeaders(token),
        data: "",
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("NO_CSV");
  });

  test("400 EMPTY_CSV when only header line is present", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/cost-master/import.csv`, {
        headers: csvHeaders(token),
        data: "subBrand,category,routeOrSku,baseRate\n",
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("EMPTY_CSV");
  });

  test("imports new cost rows, reports per-row validation errors", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const csvBody = [
      "subBrand,category,routeOrSku,baseRate,currency",
      `tmc,hotel,${RUN_TAG}-tmc-A,5000,INR`,
      `rfu,flight,${RUN_TAG}-rfu-flight,18000,INR`,
      // missing routeOrSku
      `tmc,hotel,,3000,INR`,
      // invalid category
      `tmc,wormhole,${RUN_TAG}-bad-cat,500,INR`,
      // negative baseRate
      `tmc,hotel,${RUN_TAG}-neg,-1,INR`,
    ].join("\r\n");
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/cost-master/import.csv`, {
        headers: csvHeaders(token),
        data: csvBody,
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.imported).toBeGreaterThanOrEqual(2);
    expect(body.errors.length).toBeGreaterThanOrEqual(3);
    expect(body.errors.some((e) => /routeOrSku|subBrand|category/i.test(e.reason))).toBe(true);
    expect(body.errors.some((e) => /invalid category/i.test(e.reason))).toBe(true);
    expect(body.errors.some((e) => /baseRate/i.test(e.reason))).toBe(true);
  });

  test("re-running the same CSV updates instead of duplicating", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const csvBody = [
      "subBrand,category,routeOrSku,baseRate,currency",
      `tmc,hotel,${RUN_TAG}-idem,7777,INR`,
    ].join("\r\n");
    const first = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/cost-master/import.csv`, {
        headers: csvHeaders(token),
        data: csvBody,
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(first.status()).toBe(200);
    expect((await first.json()).imported).toBeGreaterThanOrEqual(1);

    const second = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/cost-master/import.csv`, {
        headers: csvHeaders(token),
        data: csvBody,
        timeout: REQUEST_TIMEOUT,
      }),
    );
    const secondBody = await second.json();
    expect(secondBody.updated).toBeGreaterThanOrEqual(1);
    expect(secondBody.imported).toBe(0);
  });

  test("?errorReport=csv returns a CSV body when errors exist", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const csvBody = [
      "subBrand,category,routeOrSku,baseRate",
      `tmc,hotel,,500`, // missing routeOrSku → triggers an error row
    ].join("\r\n");
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/cost-master/import.csv?errorReport=csv`, {
        headers: csvHeaders(token),
        data: csvBody,
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toMatch(/text\/csv/);
    const text = await r.text();
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toContain("rowNumber,reason");
  });
});

// ── Diagnostic-banks import ───────────────────────────────────────

test.describe("Travel CSV — diagnostic-banks import", () => {
  test("MANAGER role rejected on diagnostic-banks import (ADMIN-only)", async ({ request }) => {
    const token = await getTravelManager(request);
    if (!token) test.skip(true, "travel manager login unavailable");
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/diagnostic-banks/import.csv`, {
        headers: csvHeaders(token),
        data: "subBrand,version,questionsJson,scoringRulesJson\ntmc,1,{},{}",
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(403);
  });

  test("rejects rows with non-parseable JSON", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    const csvBody = [
      "subBrand,version,questionsJson,scoringRulesJson",
      `tmc,99,{not-json,{}`,
    ].join("\r\n");
    const r = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/diagnostic-banks/import.csv`, {
        headers: csvHeaders(token),
        data: csvBody,
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    expect(body.errors[0].reason).toMatch(/json/i);
  });

  test("happy path: import + idempotent re-run upserts by (subBrand, version)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "travel admin login unavailable");
    // Pick a high version slot unlikely to collide with seeded banks.
    const VERSION_SLOT = 9000 + Math.floor(Math.random() * 999);
    const questions = JSON.stringify({
      questions: [{ id: "q1", text: "How many trips per year?", type: "number", weight: 1 }],
    });
    const scoring = JSON.stringify({
      bands: [{ min: 0, max: 100, classification: "starter", label: "Starter" }],
    });
    const csvBody = [
      "subBrand,version,questionsJson,scoringRulesJson",
      `tmc,${VERSION_SLOT},"${questions.replace(/"/g, '""')}","${scoring.replace(/"/g, '""')}"`,
    ].join("\r\n");

    const first = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/diagnostic-banks/import.csv`, {
        headers: csvHeaders(token),
        data: csvBody,
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.imported + firstBody.updated).toBeGreaterThanOrEqual(1);

    // Re-import same body → must update, not duplicate.
    const second = await retryOn5xx(() =>
      request.post(`${BASE_URL}/api/travel/diagnostic-banks/import.csv`, {
        headers: csvHeaders(token),
        data: csvBody,
        timeout: REQUEST_TIMEOUT,
      }),
    );
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.updated).toBeGreaterThanOrEqual(1);
    expect(secondBody.imported).toBe(0);
  });
});
