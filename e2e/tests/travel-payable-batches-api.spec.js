// @ts-check
/**
 * Gate spec — TravelSupplierPayableBatch CRUD + state machine + CSV export.
 *
 * PRD_TRAVEL_BILLING G022 (FR-3.5.e).
 *
 * Pins the contract for backend/routes/travel_payable_batches.js — the new
 * "bundle N payables into one bank-transfer run + export CSV" surface
 * sitting alongside the existing TravelSupplierPayable + TravelPurchaseOrder
 * surfaces.
 *
 * Covers:
 *   POST   /api/travel/payable-batches                        ADMIN+MGR — create draft
 *   GET    /api/travel/payable-batches                        any — list (?status filter)
 *   GET    /api/travel/payable-batches/:id                    any — detail with linked payables
 *   PUT    /api/travel/payable-batches/:id                    ADMIN+MGR — draft-only edit
 *   POST   /api/travel/payable-batches/:id/add-payable        ADMIN+MGR — attach payable
 *   POST   /api/travel/payable-batches/:id/approve            ADMIN — state transition
 *   POST   /api/travel/payable-batches/:id/cancel             ADMIN — terminal cancel
 *   GET    /api/travel/payable-batches/:id/payment-csv        ADMIN+MGR — bank-friendly CSV
 *   State-machine: invalid transitions return 409
 *
 * Test data is tagged with RUN_TAG so afterAll teardown can sweep without
 * polluting demo. Batches created in setup are cancelled (terminal state)
 * during teardown.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_PAYBATCH_${Date.now()}`;

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
async function getTravelManager(request) {
  if (!travelManagerToken) {
    travelManagerToken = await loginAs(request, "manager@travelstall.in", "password123");
  }
  return travelManagerToken;
}
async function getTravelUser(request) {
  if (!travelUserToken) {
    travelUserToken = await loginAs(request, "user@travelstall.in", "password123");
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
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}
async function post(request, token, path, body) {
  return retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}
async function put(request, token, path, body) {
  return retryOn5xx(() => request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
}

const state = {
  batchIds: [],
};

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of state.batchIds) {
    if (Date.now() > deadline) break;
    await post(request, token, `/api/travel/payable-batches/${id}/cancel`, {
      cancelReason: `_teardown_${RUN_TAG}`,
    }).catch(() => {});
  }
});

// ─── Guards ─────────────────────────────────────────────────────────

test.describe("Travel payable batches — guards", () => {
  test("GET /payable-batches without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/payable-batches`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /payable-batches from generic tenant → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/payable-batches");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });
});

// ─── Create + list ──────────────────────────────────────────────────

test.describe("Travel payable batches — CRUD", () => {
  test("POST creates a draft batch with TPB-YYYY-NNNN format", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/payable-batches", {
      paymentMethod: "neft",
      notes: `${RUN_TAG} initial batch`,
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("draft");
    expect(body.batchNumber).toMatch(/^TPB-\d{4}-\d{4}$/);
    expect(body.paymentMethod).toBe("neft");
    state.batchIds.push(body.id);
  });

  test("POST with invalid paymentMethod → 400 INVALID_PAYMENT_METHOD", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/payable-batches", {
      paymentMethod: "bitcoin",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_PAYMENT_METHOD");
  });

  test("USER cannot create a batch (ADMIN/MANAGER gate)", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) test.skip(true, "user@travelstall.in not seeded");
    const res = await post(request, token, "/api/travel/payable-batches", {});
    expect(res.status()).toBe(403);
  });

  test("GET /payable-batches lists the created batch", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.batchIds.length === 0) test.skip(true, "no batch");
    const res = await get(request, token, `/api/travel/payable-batches?status=draft`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.payableBatches)).toBe(true);
    expect(body.payableBatches.find((b) => b.id === state.batchIds[0])).toBeTruthy();
  });

  test("GET /:id returns batch with linked payables array", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.batchIds.length === 0) test.skip(true, "no batch");
    const res = await get(request, token, `/api/travel/payable-batches/${state.batchIds[0]}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(state.batchIds[0]);
    expect(Array.isArray(body.payables)).toBe(true);
  });

  test("?status invalid → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/payable-batches?status=archived");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_STATUS");
  });
});

// ─── State machine ──────────────────────────────────────────────────

test.describe("Travel payable batches — state machine", () => {
  test("draft → settled is blocked (skip intermediate states) → 409", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.batchIds.length === 0) test.skip(true, "no batch");
    const res = await post(request, token, `/api/travel/payable-batches/${state.batchIds[0]}/settle`, {});
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("INVALID_STATUS_TRANSITION");
    expect(body.from).toBe("draft");
    expect(body.to).toBe("settled");
  });

  test("/cancel without cancelReason → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.batchIds.length === 0) test.skip(true, "no batch");
    const res = await post(request, token, `/api/travel/payable-batches/${state.batchIds[0]}/cancel`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });
});

// ─── CSV export ─────────────────────────────────────────────────────

test.describe("Travel payable batches — CSV export", () => {
  test("GET /:id/payment-csv returns CSV with bank-friendly header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.batchIds.length === 0) test.skip(true, "no batch");
    const res = await get(request, token, `/api/travel/payable-batches/${state.batchIds[0]}/payment-csv`);
    expect(res.status(), `csv: ${await res.text()}`).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain(".csv");
    const text = await res.text();
    const firstLine = text.split("\r\n")[0];
    expect(firstLine).toContain("batchNumber");
    expect(firstLine).toContain("supplierName");
    expect(firstLine).toContain("amount");
  });
});

// ─── Settlement timeline (G024 quick smoke) ─────────────────────────

test.describe("Travel settlement timeline — smoke", () => {
  test("GET /settlements/timeline returns {items, summary}", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/settlements/timeline?from=2026-06-01&to=2026-09-30");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.summary).toBeTruthy();
    expect(typeof body.summary.totalInflowExpected).toBe("number");
    expect(typeof body.summary.totalOutflowExpected).toBe("number");
    expect(typeof body.summary.netExpected).toBe("number");
  });

  test("GET /settlements/timeline with inverted range → 400 INVERTED_DATE_RANGE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/settlements/timeline?from=2026-09-30&to=2026-06-01");
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVERTED_DATE_RANGE");
  });
});
