// @ts-check
/**
 * Gate spec — TravelPurchaseOrder CRUD + state machine + PDF (G035/G036).
 *
 * Pins the contract for the new supplier PO ledger added in
 * backend/routes/travel_purchase_orders.js.
 *
 * Covers:
 *   POST   /api/travel/purchase-orders                     ADMIN+MGR — create draft
 *   GET    /api/travel/purchase-orders                     any — list (?supplierId, ?status filter)
 *   GET    /api/travel/purchase-orders/:id                 any — detail
 *   PUT    /api/travel/purchase-orders/:id                 ADMIN+MGR — draft-only edit
 *   POST   /api/travel/purchase-orders/:id/lines           ADMIN+MGR — add line + total recompute
 *   POST   /api/travel/purchase-orders/:id/send            ADMIN+MGR — state transition
 *   POST   /api/travel/purchase-orders/:id/acknowledge     ADMIN+MGR — state transition
 *   POST   /api/travel/purchase-orders/:id/fulfill         ADMIN+MGR — auto-payable creation
 *   POST   /api/travel/purchase-orders/:id/cancel          ADMIN — requires cancelReason
 *   GET    /api/travel/purchase-orders/:id/pdf             ADMIN+MGR — PDF render
 *   State-machine: invalid transitions return 409
 *
 * Test data is tagged with RUN_TAG so afterAll teardown can sweep without
 * polluting demo. Suppliers + POs created in setup are cancelled (state
 * machine doesn't allow deletes) but draft POs CAN be cleaned by going
 * draft → cancelled (terminal state).
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_PO_${Date.now()}`;

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
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}

// Test-state cache for IDs across tests in this serial run.
const state = {
  supplierId: null,
  poIds: [],
};

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Create a fresh test supplier tagged with RUN_TAG.
  const res = await post(request, token, "/api/travel/suppliers", {
    subBrand: "tmc",
    name: `${RUN_TAG} Air India Test`,
    supplierCategory: "flight",
    paymentTermsDays: 30,
    creditCurrency: "INR",
  });
  if (res.ok()) {
    const body = await res.json();
    state.supplierId = body.id;
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  // Cancel any draft POs we created (state machine doesn't allow deletes).
  for (const id of state.poIds) {
    if (Date.now() > deadline) break;
    await post(request, token, `/api/travel/purchase-orders/${id}/cancel`, {
      cancelReason: `_teardown_${RUN_TAG}`,
    }).catch(() => {});
  }
  // Soft-delete the supplier — most existing supplier teardown patterns
  // mark isActive=false via PATCH instead of DELETE.
  if (state.supplierId) {
    await del(request, token, `/api/travel/suppliers/${state.supplierId}`).catch(() => {});
  }
});

// ─── Guards ─────────────────────────────────────────────────────────

test.describe("Travel purchase orders — guards", () => {
  test("GET /purchase-orders without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/purchase-orders`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /purchase-orders from generic tenant → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/purchase-orders");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });
});

// ─── Create + list ──────────────────────────────────────────────────

test.describe("Travel purchase orders — CRUD", () => {
  test("POST creates a draft PO with TPO-YYYY-NNNN format", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    if (!state.supplierId) test.skip(true, "supplier seed failed");
    const res = await post(request, token, "/api/travel/purchase-orders", {
      supplierId: state.supplierId,
      currency: "INR",
      notes: `${RUN_TAG} initial draft`,
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("draft");
    expect(body.poNumber).toMatch(/^TPO-\d{4}-\d{4}$/);
    expect(body.supplierId).toBe(state.supplierId);
    state.poIds.push(body.id);
  });

  test("POST without supplierId returns 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/purchase-orders", { currency: "INR" });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST with bogus supplierId returns 404 SUPPLIER_NOT_FOUND", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/purchase-orders", {
      supplierId: 999999999,
      currency: "INR",
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("SUPPLIER_NOT_FOUND");
  });

  test("USER cannot create a PO (ADMIN/MANAGER gate)", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token) test.skip(true, "user@travelstall.in not seeded");
    const res = await post(request, token, "/api/travel/purchase-orders", {
      supplierId: state.supplierId,
    });
    expect(res.status()).toBe(403);
  });

  test("GET /purchase-orders lists the created PO", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO created");
    const res = await get(request, token, `/api/travel/purchase-orders?supplierId=${state.supplierId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.purchaseOrders)).toBe(true);
    const found = body.purchaseOrders.find((p) => p.id === state.poIds[0]);
    expect(found).toBeTruthy();
  });

  test("GET /:id returns PO with lines + supplier", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await get(request, token, `/api/travel/purchase-orders/${state.poIds[0]}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(state.poIds[0]);
    expect(body.supplier).toBeTruthy();
    expect(body.supplier.name).toContain("Air India Test");
    expect(Array.isArray(body.lines)).toBe(true);
  });
});

// ─── Lines + totals ──────────────────────────────────────────────────

test.describe("Travel purchase orders — line items", () => {
  test("POST /:id/lines adds a service line + recomputes totals", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const poId = state.poIds[0];
    const res = await post(request, token, `/api/travel/purchase-orders/${poId}/lines`, {
      lineType: "service",
      description: `${RUN_TAG} BLR-DEL economy ticket`,
      quantity: 5,
      unitPrice: 6000,
      pnr: "ABC123",
    });
    expect(res.status(), `lines POST: ${await res.text()}`).toBe(201);
    const line = await res.json();
    expect(Number(line.lineTotal)).toBe(30000);
    // Detail PO total should reflect.
    const detail = await get(request, token, `/api/travel/purchase-orders/${poId}`);
    expect(Number((await detail.json()).totalAmount)).toBe(30000);
  });

  test("POST /:id/lines with invalid lineType → 400 INVALID_LINE_TYPE", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/lines`, {
      lineType: "bogus",
      description: "x",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_LINE_TYPE");
  });
});

// ─── State machine ──────────────────────────────────────────────────

test.describe("Travel purchase orders — state machine", () => {
  test("draft → send (status='sent')", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/send`);
    expect(res.status(), `send: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("sent");
    expect(body.sentAt).toBeTruthy();
  });

  test("sent → sent returns 409 INVALID_STATUS_TRANSITION", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/send`);
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("INVALID_STATUS_TRANSITION");
    expect(body.from).toBe("sent");
  });

  test("sent → acknowledge", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/acknowledge`);
    expect(res.status(), `ack: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("acknowledged");
    expect(body.acknowledgedAt).toBeTruthy();
  });

  test("acknowledged → fulfill auto-creates payables", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/fulfill`);
    expect(res.status(), `fulfill: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.purchaseOrder.status).toBe("fulfilled");
    expect(body.purchaseOrder.fulfilledAt).toBeTruthy();
    expect(body.payablesCreated).toBeGreaterThanOrEqual(1);

    // Verify the payable carries the back-link.
    const payRes = await get(request, token, `/api/travel/suppliers/${state.supplierId}/payables`);
    if (payRes.status() === 200) {
      const payables = (await payRes.json()).payables || [];
      const linked = payables.find((p) => p.purchaseOrderId === state.poIds[0]);
      expect(linked).toBeTruthy();
    }
  });

  test("fulfilled PO cannot be edited (PUT /:id 409)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await put(request, token, `/api/travel/purchase-orders/${state.poIds[0]}`, {
      notes: "Late edit attempt",
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("INVALID_STATUS_TRANSITION");
  });

  test("fulfilled PO cannot be cancelled (terminal state)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/cancel`, {
      cancelReason: "Late cancel",
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("INVALID_STATUS_TRANSITION");
  });
});

// ─── Cancellation flow (separate PO) ────────────────────────────────

test.describe("Travel purchase orders — cancellation", () => {
  let cancelPoId = null;

  test("create a fresh draft PO for cancellation", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !state.supplierId) test.skip(true, "no supplier");
    const res = await post(request, token, "/api/travel/purchase-orders", {
      supplierId: state.supplierId,
      notes: `${RUN_TAG} to-cancel`,
    });
    expect(res.status()).toBe(201);
    cancelPoId = (await res.json()).id;
    state.poIds.push(cancelPoId);
  });

  test("cancel without reason returns 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !cancelPoId) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${cancelPoId}/cancel`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("MANAGER cannot cancel (ADMIN-only)", async ({ request }) => {
    const token = await getTravelManager(request);
    if (!token || !cancelPoId) test.skip(true, "manager not seeded");
    const res = await post(request, token, `/api/travel/purchase-orders/${cancelPoId}/cancel`, {
      cancelReason: "Manager attempt",
    });
    expect(res.status()).toBe(403);
  });

  test("ADMIN cancel with reason returns 200 + cancelledAt set", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !cancelPoId) test.skip(true, "no PO");
    const res = await post(request, token, `/api/travel/purchase-orders/${cancelPoId}/cancel`, {
      cancelReason: `_teardown_${RUN_TAG}`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("cancelled");
    expect(body.cancelReason).toContain("_teardown_");
    expect(body.cancelledAt).toBeTruthy();
  });
});

// ─── PDF render ─────────────────────────────────────────────────────

test.describe("Travel purchase orders — PDF", () => {
  test("GET /:id/pdf returns application/pdf", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await get(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/pdf`);
    expect(res.status(), `pdf: ${await res.text()}`).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const buf = await res.body();
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });

  test("USER cannot download PDF (403)", async ({ request }) => {
    const token = await getTravelUser(request);
    if (!token || state.poIds.length === 0) test.skip(true, "no PO");
    const res = await get(request, token, `/api/travel/purchase-orders/${state.poIds[0]}/pdf`);
    expect(res.status()).toBe(403);
  });
});
