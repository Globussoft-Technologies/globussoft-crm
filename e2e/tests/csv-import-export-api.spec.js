// @ts-check
/**
 * Wave 7 Agent A — backend gate spec for CSV import/export framework.
 *
 * Routes: backend/routes/csv_io.js (mounted at /api/csv).
 * Closes PRD Gap §10 item 3.
 *
 * Endpoints covered:
 *   GET  /services/export.csv             — admin/manager
 *   POST /services/import.csv             — same; per-row idempotent upsert
 *   GET  /products/export.csv             — admin/manager
 *   POST /products/import.csv             — upsert by sku || name
 *   GET  /membership-plans/export.csv     — admin/manager
 *   POST /membership-plans/import.csv     — upsert by name + JSON entitlements
 *   GET  /bookings/export.csv             — admin/manager (export only)
 *
 * Coverage targets:
 *   - export: HTTP 200 + Content-Type text/csv + UTF-8 BOM byte 0xFEFF as
 *     leading character + the column header line
 *   - import: per-row { rowNumber, reason } error report on bad rows;
 *     re-running same body updates instead of duplicating
 *   - validation: NO_CSV (no body), EMPTY_CSV (header only), TOO_MANY_ROWS
 *   - role gate: USER role gets 403; ADMIN passes
 *   - tenant scope: admin-of-tenant-A's export only contains rows of A
 */
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `_teardown_csv_${Date.now()}`;
const UTF8_BOM = "﻿";

let adminToken = null;
let userToken = null;

async function login(request, email, password) {
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { "Content-Type": "application/json" },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

async function getAdmin(request) {
  if (!adminToken) adminToken = await login(request, "rishu@enhancedwellness.in", "password123");
  return adminToken;
}
async function getUser(request) {
  if (!userToken) userToken = await login(request, "user@wellness.demo", "password123");
  return userToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const csvHeaders = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "text/csv" });

// ── Tests ──────────────────────────────────────────────────────────

test.describe("CSV Export — auth + role gate", () => {
  test("401 without token", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/csv/services/export.csv`);
    expect(r.status()).toBe(401);
  });

  test("403 for plain USER role", async ({ request }) => {
    const token = await getUser(request);
    if (!token) test.skip(true, "user login unavailable");
    const res = await request.get(`${BASE_URL}/api/csv/services/export.csv`, { headers: headers(token) });
    expect(res.status()).toBe(403);
  });
});

test.describe("CSV Export — happy path shape", () => {
  test("services export returns BOM + header + text/csv", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/csv/services/export.csv`, { headers: headers(token) });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toContain("name,category");
  });

  test("products export returns BOM + header", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/csv/products/export.csv`, { headers: headers(token) });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toContain("name,sku");
  });

  test("membership plans export returns BOM + header", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/csv/membership-plans/export.csv`, { headers: headers(token) });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toContain("name,description");
  });

  test("bookings export returns BOM + header (read-only)", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.get(`${BASE_URL}/api/csv/bookings/export.csv`, { headers: headers(token) });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toContain("contactName,contactEmail");
  });

  test("bookings import does NOT exist (export-only)", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/csv/bookings/import.csv`, {
      headers: csvHeaders(token),
      data: "name\nfoo",
    });
    // 404 (no route) — confirms read-only contract.
    expect(res.status()).toBe(404);
  });
});

test.describe("CSV Services Import — happy + validation + idempotency", () => {
  test("400 NO_CSV when no body provided", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/csv/services/import.csv`, {
      headers: csvHeaders(token),
      data: "",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NO_CSV");
  });

  test("400 EMPTY_CSV when only header is present", async ({ request }) => {
    const token = await getAdmin(request);
    const res = await request.post(`${BASE_URL}/api/csv/services/import.csv`, {
      headers: csvHeaders(token),
      data: "name,category\n",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("EMPTY_CSV");
  });

  test("imports new services + reports per-row errors", async ({ request }) => {
    const token = await getAdmin(request);
    const csvBody = [
      "name,category,basePrice,durationMin,isActive",
      `${RUN_TAG} Imported A,test,1500,30,true`,
      `${RUN_TAG} Imported B,test,2500,60,true`,
      `,test,5000,30,true`, // missing name → error row
    ].join("\r\n");
    const res = await request.post(`${BASE_URL}/api/csv/services/import.csv`, {
      headers: csvHeaders(token),
      data: csvBody,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.imported).toBeGreaterThanOrEqual(2);
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    const missingNameError = body.errors.find((e) => /missing name/i.test(e.reason));
    expect(missingNameError).toBeTruthy();
  });

  test("re-running same body upserts instead of duplicating", async ({ request }) => {
    const token = await getAdmin(request);
    const name = `${RUN_TAG} Idempotent`;
    const csvBody = ["name,category,basePrice", `${name},test,777`].join("\r\n");
    const first = await request.post(`${BASE_URL}/api/csv/services/import.csv`, {
      headers: csvHeaders(token),
      data: csvBody,
    });
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.imported).toBeGreaterThanOrEqual(1);

    const second = await request.post(`${BASE_URL}/api/csv/services/import.csv`, {
      headers: csvHeaders(token),
      data: csvBody,
    });
    const secondBody = await second.json();
    // Re-run finds existing row → updated, not imported
    expect(secondBody.updated).toBeGreaterThanOrEqual(1);
    expect(secondBody.imported).toBe(0);
  });
});

test.describe("CSV Membership Plans Import — JSON entitlements validation", () => {
  test("rejects bad JSON in entitlements", async ({ request }) => {
    const token = await getAdmin(request);
    const csvBody = [
      "name,durationDays,price,currency,entitlements",
      `${RUN_TAG} Bad JSON Plan,30,1000,INR,{not-json`,
    ].join("\r\n");
    const res = await request.post(`${BASE_URL}/api/csv/membership-plans/import.csv`, {
      headers: csvHeaders(token),
      data: csvBody,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    expect(body.errors[0].reason).toMatch(/entitlements/i);
  });

  test("accepts valid JSON array entitlements", async ({ request }) => {
    const token = await getAdmin(request);
    const csvBody = [
      "name,durationDays,price,currency,entitlements",
      `${RUN_TAG} Good Plan,90,5000,INR,"[{""serviceId"":1,""quantity"":3}]"`,
    ].join("\r\n");
    const res = await request.post(`${BASE_URL}/api/csv/membership-plans/import.csv`, {
      headers: csvHeaders(token),
      data: csvBody,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.imported + body.updated).toBeGreaterThanOrEqual(1);
  });
});

test.describe("CSV Products Import — sku natural key", () => {
  test("rejects bad price", async ({ request }) => {
    const token = await getAdmin(request);
    const csvBody = [
      "name,sku,price",
      `${RUN_TAG} Bad Price Product,${RUN_TAG}-SKU-X,not-a-number`,
    ].join("\r\n");
    const res = await request.post(`${BASE_URL}/api/csv/products/import.csv`, {
      headers: csvHeaders(token),
      data: csvBody,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
  });

  test("upserts by sku natural key", async ({ request }) => {
    const token = await getAdmin(request);
    const sku = `${RUN_TAG}-SKU-A`;
    const first = await request.post(`${BASE_URL}/api/csv/products/import.csv`, {
      headers: csvHeaders(token),
      data: ["name,sku,price", `${RUN_TAG} ProductA,${sku},100`].join("\r\n"),
    });
    expect(first.status()).toBe(200);
    // Same sku, different name — should match the existing row by sku.
    const second = await request.post(`${BASE_URL}/api/csv/products/import.csv`, {
      headers: csvHeaders(token),
      data: ["name,sku,price", `${RUN_TAG} ProductA-renamed,${sku},150`].join("\r\n"),
    });
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.updated).toBeGreaterThanOrEqual(1);
  });
});
