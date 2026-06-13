// @ts-check
/**
 * Gate spec — Travel Supplier Commission ledger (PRD_TRAVEL_SUPPLIER_MASTER G045).
 *
 * Pins:
 *   POST   /api/travel/suppliers/:id/commission-entries
 *   GET    /api/travel/suppliers/:id/commission-entries (?fiscalYear + ?status filters)
 *   GET    /api/travel/suppliers/:id/commission-entries/:entryId
 *   POST   /api/travel/suppliers/:id/commission-entries/:entryId/settle
 *   POST   /api/travel/suppliers/:id/commission-entries/:entryId/reverse
 *   GET    /api/travel/suppliers/:id/commission-statement
 *   GET    /api/travel/suppliers/:id/commission-statement.csv
 *   GET    /api/travel/commissions/stats
 *
 * Standing rules (CLAUDE.md):
 *   - JWT key is userId, not id
 *   - Request bodies strip id/createdAt/updatedAt/tenantId/userId
 *   - afterAll teardown via _teardown_ prefix
 *   - RUN_TAG with the timestamp suffix
 *
 * BASE_URL=http://127.0.0.1:5000 on per-push api_tests gate;
 * BASE_URL=https://crm.globusdemos.com on e2e-full release-validation.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_SUP_COMM_${Date.now()}`;

let travelAdminToken = null;

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
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

const created = { supplierIds: [], entryIds: [] };
const TEST_FY = "FY2026-27";

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 30_000;
  // Best-effort teardown — soft-delete created suppliers (cascades over
  // commission entries via Cascade FK). Commission entries themselves have
  // no DELETE endpoint by design (audit-trail preservation); they're
  // reversed if you want them gone from "totals."
  for (const id of created.supplierIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/suppliers/${id}`).catch(() => {});
  }
});

// ─── Guards ──────────────────────────────────────────────────────────

test.describe("Travel supplier commissions — guards", () => {
  test("GET /commissions/stats without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/commissions/stats`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Create a parent supplier with commissionPercent default ─────────

test.describe("Travel supplier commissions — accrue + list + detail", () => {
  test("seed: create parent supplier with default commissionPercent", async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, "yasin@travelstall.in must be seeded").toBeTruthy();
    const res = await post(request, token, "/api/travel/suppliers", {
      name: `_teardown_${RUN_TAG}_Air India`,
      subBrand: "tmc",
      supplierCategory: "flight",
      commissionPercent: 7.5,
    });
    expect(res.status(), `create supplier: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    created.supplierIds.push(body.id);
  });

  test("POST commission-entries with explicit baseAmount + commissionPercent — TDS default 5%", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries`, {
      baseAmount: 100000,
      commissionPercent: 10,
      fiscalYear: TEST_FY,
      currency: "INR",
      notes: `${RUN_TAG} explicit-rate accrual`,
    });
    expect(res.status(), `accrue: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.fiscalYear).toBe(TEST_FY);
    expect(body.status).toBe("accrued");
    expect(Number(body.commissionAmount)).toBe(10000);
    // Default 5% TDS of 10000 = 500
    expect(Number(body.tdsAmount)).toBe(500);
    expect(Number(body.netAmount)).toBe(9500);
    created.entryIds.push(body.id);
  });

  test("POST commission-entries with no commissionPercent — uses supplier default 7.5%", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries`, {
      baseAmount: 100000,
      fiscalYear: TEST_FY,
      notes: `${RUN_TAG} supplier-default accrual`,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(Number(body.commissionAmount)).toBe(7500);
    created.entryIds.push(body.id);
  });

  test("POST commission-entries with tdsPercent=0 honored", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries`, {
      baseAmount: 1000,
      commissionPercent: 10,
      tdsPercent: 0,
      fiscalYear: TEST_FY,
      notes: `${RUN_TAG} zero-TDS accrual`,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(Number(body.commissionAmount)).toBe(100);
    expect(Number(body.tdsAmount)).toBe(0);
    expect(Number(body.netAmount)).toBe(100);
    created.entryIds.push(body.id);
  });

  test("POST missing baseAmount → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries`, {
      commissionPercent: 10,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST negative baseAmount → 400 INVALID_BASE_AMOUNT", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries`, {
      baseAmount: -100,
      commissionPercent: 10,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BASE_AMOUNT");
  });

  test("POST invalid fiscalYear shape → 400 INVALID_FISCAL_YEAR", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries`, {
      baseAmount: 1000,
      commissionPercent: 10,
      fiscalYear: "2025-26",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FISCAL_YEAR");
  });

  test("GET list returns the accrued entries", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await get(request, token, `/api/travel/suppliers/${supplierId}/commission-entries?fiscalYear=${TEST_FY}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.entries.every((e) => e.fiscalYear === TEST_FY)).toBe(true);
  });

  test("GET detail returns the entry", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.entryIds.length === 0) test.skip(true, "no token / entry");
    const supplierId = created.supplierIds[0];
    const entryId = created.entryIds[0];
    const res = await get(request, token, `/api/travel/suppliers/${supplierId}/commission-entries/${entryId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(entryId);
  });

  test("GET detail missing → 404 ENTRY_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await get(request, token, `/api/travel/suppliers/${supplierId}/commission-entries/99999999`);
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("ENTRY_NOT_FOUND");
  });
});

// ─── Settle + reverse lifecycle ──────────────────────────────────────

test.describe("Travel supplier commissions — settle + reverse", () => {
  test("POST /settle flips accrued → settled + stamps settledAt", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.entryIds.length === 0) test.skip(true, "no token / entry");
    const supplierId = created.supplierIds[0];
    const entryId = created.entryIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries/${entryId}/settle`, {});
    expect(res.status(), `settle: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("settled");
    expect(body.settledAt).toBeTruthy();
  });

  test("POST /settle on already-settled → 409 ALREADY_SETTLED", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.entryIds.length === 0) test.skip(true, "no token / entry");
    const supplierId = created.supplierIds[0];
    const entryId = created.entryIds[0];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries/${entryId}/settle`, {});
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_SETTLED");
  });

  test("POST /reverse without reason → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.entryIds.length < 2) test.skip(true, "no token / entry");
    const supplierId = created.supplierIds[0];
    const entryId = created.entryIds[1];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries/${entryId}/reverse`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST /reverse with reason → 200 reversed", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.entryIds.length < 2) test.skip(true, "no token / entry");
    const supplierId = created.supplierIds[0];
    const entryId = created.entryIds[1];
    const res = await post(request, token, `/api/travel/suppliers/${supplierId}/commission-entries/${entryId}/reverse`, {
      reversalReason: `${RUN_TAG} test reversal`,
    });
    expect(res.status(), `reverse: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("reversed");
    expect(body.reversedAt).toBeTruthy();
    expect(body.reversalReason).toContain(RUN_TAG);
  });
});

// ─── Statement + CSV ──────────────────────────────────────────────────

test.describe("Travel supplier commissions — statement + CSV", () => {
  test("GET statement rolls up totals correctly", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await get(request, token, `/api/travel/suppliers/${supplierId}/commission-statement?fiscalYear=${TEST_FY}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.supplierId).toBe(supplierId);
    expect(body.fiscalYear).toBe(TEST_FY);
    expect(body.counts).toMatchObject({
      total: expect.any(Number),
      accrued: expect.any(Number),
      settled: expect.any(Number),
      reversed: expect.any(Number),
    });
    expect(body.totals).toMatchObject({
      accruedCommission: expect.any(Number),
      settledCommission: expect.any(Number),
      reversedCommission: expect.any(Number),
      tdsDeducted: expect.any(Number),
      netPayable: expect.any(Number),
      netSettled: expect.any(Number),
    });
    expect(body.counts.settled).toBeGreaterThanOrEqual(1);
    expect(body.counts.reversed).toBeGreaterThanOrEqual(1);
  });

  test("GET statement.csv returns CSV with header + rows", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.supplierIds.length === 0) test.skip(true, "no token / supplier");
    const supplierId = created.supplierIds[0];
    const res = await get(request, token, `/api/travel/suppliers/${supplierId}/commission-statement.csv?fiscalYear=${TEST_FY}`);
    expect(res.status()).toBe(200);
    expect((res.headers()["content-type"] || "")).toMatch(/text\/csv/);
    const csv = await res.text();
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/id,fiscalYear,status/);
    // ≥3 entries were created in this FY
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── Tenant-wide stats ────────────────────────────────────────────────

test.describe("Travel supplier commissions — tenant-wide stats", () => {
  test("GET /commissions/stats returns the rollup", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, `/api/travel/commissions/stats?fiscalYear=${TEST_FY}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.fiscalYear).toBe(TEST_FY);
    expect(body.distinctSuppliers).toBeGreaterThanOrEqual(1);
    expect(body.counts.total).toBeGreaterThanOrEqual(3);
    expect(body.totals).toMatchObject({
      accruedCommission: expect.any(Number),
      settledCommission: expect.any(Number),
      netPayable: expect.any(Number),
    });
  });

  test("GET /commissions/stats with bad fiscalYear → 400 INVALID_FISCAL_YEAR", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, `/api/travel/commissions/stats?fiscalYear=BAD`);
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FISCAL_YEAR");
  });
});
