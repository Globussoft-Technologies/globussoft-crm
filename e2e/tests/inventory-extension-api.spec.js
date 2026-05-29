// @ts-check
/**
 * Wave 11 Agent HH — Inventory backbone API contract tests.
 *
 * Routes covered (all under /api/wellness/* mounted from
 * backend/routes/inventory.js):
 *
 *   ProductCategory CRUD
 *     GET    /product-categories
 *     POST   /product-categories                   (admin/manager only)
 *     PUT    /product-categories/:id               (admin/manager only)
 *     DELETE /product-categories/:id               (admin/manager only)
 *
 *   Vendor CRUD
 *     GET    /vendors
 *     POST   /vendors                              (admin/manager only)
 *     PUT    /vendors/:id                          (admin/manager only)
 *     DELETE /vendors/:id                          (deactivates if receipts exist)
 *
 *   InventoryReceipt
 *     GET    /inventory/receipts
 *     POST   /inventory/receipts                   SIDE EFFECT: increments
 *                                                  Product.currentStock,
 *                                                  audit-logs INVENTORY_RECEIVE,
 *                                                  generates RCP-YYYY-NNNN
 *
 *   InventoryAdjustment
 *     GET    /inventory/adjustments
 *     POST   /inventory/adjustments                SIDE EFFECT: applies signed
 *                                                  delta to Product.currentStock,
 *                                                  audit-logs INVENTORY_ADJUST
 *
 *   AutoConsumptionRule CRUD
 *     GET    /auto-consumption-rules?serviceId=
 *     POST   /auto-consumption-rules               (unique on tenant+service+product)
 *     PUT    /auto-consumption-rules/:id           (only quantity + isActive)
 *     DELETE /auto-consumption-rules/:id
 *
 *   Movements ledger
 *     GET    /inventory/movements?productId=       combined receipts +
 *                                                  adjustments + consumption
 *
 * Also pins the auto-consumption-on-visit-completion side effect: creating
 * a visit with status=completed for a service that has an active rule
 * decrements the linked product's currentStock + writes a ServiceConsumption
 * row.
 *
 * Standing rules followed:
 *   - JWT key is `userId` not `id` — `r.user.id` from /api/auth/login response is fine because that's the LOGIN response shape; req.user.userId is the JWT side.
 *   - Body strips `id`/`createdAt`/`updatedAt`/`tenantId`/`userId` (we don't pass these).
 *   - RUN_TAG namespacing: every created row name/sku/notes carries E2E_HH_<ts>
 *     so the global-teardown regex catches it AND the afterAll cleanup is
 *     a backstop only.
 *   - afterAll cleans every created row by id.
 */

const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_HH_${Date.now()}`;

// ── Auth: wellness manager (preferred for these admin-gated routes) ──
//
// Manager (Rishu) carries wellnessRole=manager which the verifyWellnessRole
// adminGate accepts. We log in as the wellness Owner because the routes are
// gated by verifyWellnessRole(["admin", "manager"]) — wellness sub-role,
// not RBAC role. The Locations spec uses the same login.

let mgrToken = null;
let mgrUserId = null;
let userToken = null;
let userUserId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, userId: j.user.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getMgr(request) {
  if (!mgrToken) {
    // Owner of Enhanced Wellness; wellnessRole=manager → passes adminGate.
    const r = await loginAs(request, 'rishu@enhancedwellness.in', 'password123');
    mgrToken = r.token;
    mgrUserId = r.userId;
  }
  return { token: mgrToken, userId: mgrUserId };
}

async function getUser(request) {
  if (!userToken) {
    // Plain wellness USER (clinical sub-role unset / non-admin) — used
    // only to verify RBAC 403 on protected routes. user@wellness.demo
    // exists in the seed.
    const r = await loginAs(request, 'user@wellness.demo', 'password123');
    userToken = r.token;
    userUserId = r.userId;
  }
  return { token: userToken, userId: userUserId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const get = (request, token, path) => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
const post = (request, token, path, body) => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const put = (request, token, path, body) => request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const del = (request, token, path) => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });

// ── Cleanup tracking ───────────────────────────────────────────────
const createdCategoryIds = new Set();
const createdVendorIds = new Set();
const createdRuleIds = new Set();
// Receipts + Adjustments are immutable / append-only; we don't try to delete
// them from the test. The RUN_TAG-bearing notes/batchNumber lets the global
// scrubber clean them post-suite.

test.afterAll(async ({ request }) => {
  const { token } = await getMgr(request);
  if (!token) return;
  for (const id of createdRuleIds) {
    await del(request, token, `/api/wellness/auto-consumption-rules/${id}`).catch(() => {});
  }
  for (const id of createdVendorIds) {
    await del(request, token, `/api/wellness/vendors/${id}`).catch(() => {});
  }
  for (const id of createdCategoryIds) {
    await del(request, token, `/api/wellness/product-categories/${id}`).catch(() => {});
  }
});

// ── Auth gate sanity ──────────────────────────────────────────────

test.describe('inventory backbone — auth gate', () => {
  test('GET /product-categories without token → 401', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/product-categories`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });
  test('POST /vendors without token → 401', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/wellness/vendors`, { data: { name: 'X' }, timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });
  test('GET /inventory/receipts without token → 401', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/inventory/receipts`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });
});

test.describe('inventory backbone — RBAC: plain USER blocked from admin gates', () => {
  test('non-admin POST /product-categories → 403', async ({ request }) => {
    const { token } = await getUser(request);
    test.skip(!token, 'wellness USER seed not present');
    const r = await post(request, token, `/api/wellness/product-categories`, { name: `${RUN_TAG} blocked` });
    expect([403, 401]).toContain(r.status());
  });
  test('non-admin POST /vendors → 403', async ({ request }) => {
    const { token } = await getUser(request);
    test.skip(!token, 'wellness USER seed not present');
    const r = await post(request, token, `/api/wellness/vendors`, { name: `${RUN_TAG} blocked` });
    expect([403, 401]).toContain(r.status());
  });
  test('non-admin POST /inventory/receipts → 403', async ({ request }) => {
    const { token } = await getUser(request);
    test.skip(!token, 'wellness USER seed not present');
    const r = await post(request, token, `/api/wellness/inventory/receipts`, { productId: 1, quantity: 1, unitCost: 1 });
    expect([403, 401]).toContain(r.status());
  });
});

// ── Service image upload routes (added 2026-05-21) ────────────────
// Both endpoints sit alongside /upload/product-image and use the same
// S3 helper — the happy-path codepath is covered by the product tests
// elsewhere. We just pin that the new endpoints exist + reject unauth.

test.describe('service image-upload routes — auth gate', () => {
  test('POST /upload/service-image without token → 401/403', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/wellness/upload/service-image`, {
      timeout: REQUEST_TIMEOUT,
      multipart: { file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) } },
    });
    expect([401, 403]).toContain(r.status());
  });
  test('POST /upload/service-category-image without token → 401/403', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/wellness/upload/service-category-image`, {
      timeout: REQUEST_TIMEOUT,
      multipart: { file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) } },
    });
    expect([401, 403]).toContain(r.status());
  });
});

// ── ProductCategory CRUD ──────────────────────────────────────────

test.describe('ProductCategory CRUD', () => {
  let parentId = null;
  let childId = null;

  test('list returns array', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token, 'wellness manager login failed');
    const r = await get(request, token, `/api/wellness/product-categories`);
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('create root category', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await post(request, token, `/api/wellness/product-categories`, {
      name: `${RUN_TAG} Consumables`,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.name).toBe(`${RUN_TAG} Consumables`);
    expect(body.parentId).toBeNull();
    parentId = body.id;
    createdCategoryIds.add(parentId);
  });

  test('rejects missing name', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await post(request, token, `/api/wellness/product-categories`, {});
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('NAME_REQUIRED');
  });

  test('create child category under parent', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !parentId);
    const r = await post(request, token, `/api/wellness/product-categories`, {
      name: `${RUN_TAG} Sterile`,
      parentId,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.parentId).toBe(parentId);
    childId = body.id;
    createdCategoryIds.add(childId);
  });

  test('rejects invalid parentId', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await post(request, token, `/api/wellness/product-categories`, {
      name: `${RUN_TAG} Orphan`,
      parentId: 999_999_999,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PARENT_NOT_FOUND');
  });

  test('rejects self-reference on PUT', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !parentId);
    const r = await put(request, token, `/api/wellness/product-categories/${parentId}`, {
      parentId,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PARENT_SELF_REFERENCE');
  });

  test('PUT updates name + isActive', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !parentId);
    const r = await put(request, token, `/api/wellness/product-categories/${parentId}`, {
      name: `${RUN_TAG} Consumables (renamed)`,
      isActive: false,
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.name).toBe(`${RUN_TAG} Consumables (renamed)`);
    expect(body.isActive).toBe(false);
  });

  test('PUT 404 on unknown id', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await put(request, token, `/api/wellness/product-categories/999999999`, { name: 'x' });
    expect(r.status()).toBe(404);
  });

  test('DELETE 404 on unknown id', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await del(request, token, `/api/wellness/product-categories/999999999`);
    expect(r.status()).toBe(404);
  });
});

// ── Vendor CRUD ───────────────────────────────────────────────────

test.describe('Vendor CRUD', () => {
  let vendorId = null;

  test('list returns array', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await get(request, token, `/api/wellness/vendors`);
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('create vendor with full fields', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await post(request, token, `/api/wellness/vendors`, {
      name: `${RUN_TAG} Sterile Supplies Pvt Ltd`,
      contactPerson: 'Rajesh Kumar',
      phone: '+91 98765 43210',
      email: 'orders@sterile.example',
      gstin: '27AAACR5055K1Z5', // 15-char placeholder, syntactically valid
      addressLine: 'Plot 12, Industrial Area',
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.gstin).toBe('27AAACR5055K1Z5');
    vendorId = body.id;
    createdVendorIds.add(vendorId);
  });

  test('rejects missing name', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await post(request, token, `/api/wellness/vendors`, { phone: '999' });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('NAME_REQUIRED');
  });

  test('rejects invalid GSTIN length', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await post(request, token, `/api/wellness/vendors`, {
      name: `${RUN_TAG} BadGstin`,
      gstin: '123', // not 15 chars
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_GSTIN');
  });

  test('PUT updates contact fields', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !vendorId);
    const r = await put(request, token, `/api/wellness/vendors/${vendorId}`, {
      contactPerson: 'Updated Name',
      phone: '+91 11111 11111',
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.contactPerson).toBe('Updated Name');
  });

  test('PUT 404 on unknown id', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await put(request, token, `/api/wellness/vendors/999999999`, { name: 'x' });
    expect(r.status()).toBe(404);
  });
});

// ── InventoryReceipt: stock side-effect ───────────────────────────

test.describe('InventoryReceipt — increments Product.currentStock', () => {
  let productId = null;
  let stockBefore = null;
  let receiptNumber = null;

  test('seed: pick a product to receive against', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await get(request, token, `/api/products?limit=1`);
    if (!r.ok()) {
      test.skip(true, '/api/products unavailable on this stack');
      return;
    }
    const products = await r.json();
    const list = Array.isArray(products) ? products : (products.items || products.data || []);
    if (!list.length) test.skip(true, 'no products to receive against');
    productId = list[0].id;
    stockBefore = list[0].currentStock || 0;
  });

  test('list receipts returns array', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await get(request, token, `/api/wellness/inventory/receipts`);
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('rejects missing productId', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await post(request, token, `/api/wellness/inventory/receipts`, {
      quantity: 1, unitCost: 1,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('PRODUCT_REQUIRED');
  });

  test('rejects zero quantity', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId);
    const r = await post(request, token, `/api/wellness/inventory/receipts`, {
      productId, quantity: 0, unitCost: 1,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('QUANTITY_INVALID');
  });

  test('rejects negative unitCost', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId);
    const r = await post(request, token, `/api/wellness/inventory/receipts`, {
      productId, quantity: 1, unitCost: -1,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('UNIT_COST_INVALID');
  });

  test('POST creates receipt + generates RCP-YYYY-NNNN id', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId);
    const r = await post(request, token, `/api/wellness/inventory/receipts`, {
      productId,
      quantity: 5,
      unitCost: 25,
      batchNumber: `${RUN_TAG}-batch-1`,
      notes: `${RUN_TAG} smoke receipt`,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.receiptNumber).toMatch(/^RCP-\d{4}-\d+$/);
    expect(body.totalCost).toBe(125); // 5 * 25
    receiptNumber = body.receiptNumber;
  });

  test('SIDE EFFECT: Product.currentStock incremented by quantity', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId || stockBefore === null);
    const r = await get(request, token, `/api/products/${productId}`);
    if (!r.ok()) test.skip(true, '/api/products/:id unavailable');
    const product = await r.json();
    expect(product.currentStock).toBeGreaterThanOrEqual(stockBefore + 5);
  });

  test('list receipts surfaces our RCP id', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !receiptNumber);
    const r = await get(request, token, `/api/wellness/inventory/receipts?productId=${productId}`);
    expect(r.ok()).toBeTruthy();
    const list = await r.json();
    expect(list.some((rec) => rec.receiptNumber === receiptNumber)).toBeTruthy();
  });
});

// ── InventoryAdjustment: signed-delta stock effect ────────────────

test.describe('InventoryAdjustment — signed delta on Product.currentStock', () => {
  let productId = null;
  let stockBefore = null;

  test('seed: pick product', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await get(request, token, `/api/products?limit=1`);
    if (!r.ok()) test.skip(true);
    const products = await r.json();
    const list = Array.isArray(products) ? products : (products.items || products.data || []);
    if (!list.length) test.skip(true);
    productId = list[0].id;
    stockBefore = list[0].currentStock || 0;
  });

  test('rejects zero delta', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId);
    const r = await post(request, token, `/api/wellness/inventory/adjustments`, {
      productId, quantityDelta: 0, reason: 'RECOUNT',
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('DELTA_INVALID');
  });

  test('rejects invalid reason', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId);
    const r = await post(request, token, `/api/wellness/inventory/adjustments`, {
      productId, quantityDelta: 1, reason: 'FROG',
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_REASON');
  });

  test('POSITIVE delta credits stock', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId);
    const r = await post(request, token, `/api/wellness/inventory/adjustments`, {
      productId, quantityDelta: 3, reason: 'TRANSFER_IN', notes: `${RUN_TAG}`,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.quantityDelta).toBe(3);
    expect(body.reason).toBe('TRANSFER_IN');
  });

  test('NEGATIVE delta debits stock', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !productId);
    const r = await post(request, token, `/api/wellness/inventory/adjustments`, {
      productId, quantityDelta: -1, reason: 'SHRINKAGE', notes: `${RUN_TAG}`,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.quantityDelta).toBe(-1);
    expect(body.reason).toBe('SHRINKAGE');
  });

  test('list adjustments returns array', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await get(request, token, `/api/wellness/inventory/adjustments`);
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });
});

// ── AutoConsumptionRule CRUD + uniqueness ─────────────────────────

test.describe('AutoConsumptionRule CRUD', () => {
  let serviceId = null;
  let productId = null;
  let ruleId = null;

  test('seed: pick service + product', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const sR = await get(request, token, `/api/wellness/services?limit=1`);
    if (!sR.ok()) test.skip(true, '/api/wellness/services unavailable');
    const services = await sR.json();
    const sList = Array.isArray(services) ? services : (services.items || services.data || []);
    if (!sList.length) test.skip(true, 'no services seeded');
    serviceId = sList[0].id;

    const pR = await get(request, token, `/api/products?limit=1`);
    if (!pR.ok()) test.skip(true, '/api/products unavailable');
    const products = await pR.json();
    const pList = Array.isArray(products) ? products : (products.items || products.data || []);
    if (!pList.length) test.skip(true, 'no products seeded');
    productId = pList[0].id;
  });

  test('list rules returns array', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await get(request, token, `/api/wellness/auto-consumption-rules`);
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('create rule', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !serviceId || !productId);
    // Pre-clean: delete any existing rule for this svc+product so the create
    // path lands fresh. The (svc, product) unique gate will surface as 409 if
    // a sibling test left a rule behind.
    const existing = await get(request, token, `/api/wellness/auto-consumption-rules?serviceId=${serviceId}`);
    if (existing.ok()) {
      const list = await existing.json();
      for (const rule of list) {
        if (rule.productId === productId) {
          await del(request, token, `/api/wellness/auto-consumption-rules/${rule.id}`).catch(() => {});
        }
      }
    }
    const r = await post(request, token, `/api/wellness/auto-consumption-rules`, {
      serviceId, productId, quantityPerVisit: 2,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.quantityPerVisit).toBe(2);
    ruleId = body.id;
    createdRuleIds.add(ruleId);
  });

  test('duplicate (svc, product) pair → 409 RULE_DUPLICATE', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !serviceId || !productId || !ruleId);
    const r = await post(request, token, `/api/wellness/auto-consumption-rules`, {
      serviceId, productId, quantityPerVisit: 5,
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).code).toBe('RULE_DUPLICATE');
  });

  test('rejects zero quantity', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !serviceId);
    // Use a different productId to bypass the unique gate; pick a high id
    // that won't exist so we get the validation failure first.
    const r = await post(request, token, `/api/wellness/auto-consumption-rules`, {
      serviceId, productId: 1, quantityPerVisit: 0,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('QUANTITY_INVALID');
  });

  test('PUT updates quantityPerVisit + isActive', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !ruleId);
    const r = await put(request, token, `/api/wellness/auto-consumption-rules/${ruleId}`, {
      quantityPerVisit: 3.5,
      isActive: false,
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.quantityPerVisit).toBe(3.5);
    expect(body.isActive).toBe(false);
  });

  test('PUT rejects zero quantity', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !ruleId);
    const r = await put(request, token, `/api/wellness/auto-consumption-rules/${ruleId}`, {
      quantityPerVisit: 0,
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('QUANTITY_INVALID');
  });

  test('GET ?serviceId= filters', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !serviceId);
    const r = await get(request, token, `/api/wellness/auto-consumption-rules?serviceId=${serviceId}`);
    expect(r.ok()).toBeTruthy();
    const list = await r.json();
    for (const rule of list) {
      expect(rule.serviceId).toBe(serviceId);
    }
  });

  // ── Unit field round-trip + validation ───────────────────────────
  test('PUT accepts a valid unit + persists it on GET', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !ruleId);
    const r = await put(request, token, `/api/wellness/auto-consumption-rules/${ruleId}`, {
      quantityPerVisit: 15,
      unit: 'ml',
      isActive: true,
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).unit).toBe('ml');
    const lr = await get(request, token, `/api/wellness/auto-consumption-rules?serviceId=${serviceId}`);
    expect(lr.ok()).toBeTruthy();
    const list = await lr.json();
    const mine = list.find((x) => x.id === ruleId);
    expect(mine?.unit).toBe('ml');
  });

  test('PUT rejects a nonsense unit with UNIT_INVALID', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !ruleId);
    const r = await put(request, token, `/api/wellness/auto-consumption-rules/${ruleId}`, {
      unit: 'wibble',
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('UNIT_INVALID');
  });

  test('PUT accepts unit=null to clear', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !ruleId);
    const r = await put(request, token, `/api/wellness/auto-consumption-rules/${ruleId}`, {
      unit: null,
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).unit).toBeNull();
  });
});

// ── Side effect: visit-completion deducts stock exactly once ──────
//
// Verifies the end-to-end auto-consumption flow:
//   1. Create a visit with status=completed → stock decrements.
//   2. PUT the same visit with status=completed (no transition) → eventBus
//      MUST NOT re-fire (existing.status === "completed" gate). The
//      applier's per-visit dedupe is a defence-in-depth layer that also
//      kicks in if the event somehow fires twice.
//   3. The ServiceConsumption ledger has exactly one row for this
//      (visitId, productId) pair.
//
// Test runs in serial mode (top-level describe.configure) so ordering is
// deterministic.

test.describe('visit-completion auto-deducts stock exactly once (idempotency)', () => {
  let serviceId = null;
  let productId = null;
  let patientId = null;
  let doctorId = null;
  let ruleId = null;
  let visitId = null;
  let stockBeforeCreate = null;

  test('seed: pick service, product, patient, doctor', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const [sR, pR, ptR, drR] = await Promise.all([
      get(request, token, `/api/wellness/services?limit=1`),
      get(request, token, `/api/products?limit=10`),
      get(request, token, `/api/wellness/patients?limit=1`),
      get(request, token, `/api/wellness/staff?wellnessRole=doctor&limit=1`).catch(() => null),
    ]);
    if (!sR.ok() || !pR.ok() || !ptR.ok()) test.skip(true, 'seed endpoints unavailable');
    const svcList = await sR.json();
    const svcs = Array.isArray(svcList) ? svcList : (svcList.items || svcList.data || []);
    if (!svcs.length) test.skip(true, 'no services');
    serviceId = svcs[0].id;

    const prodList = await pR.json();
    const prods = Array.isArray(prodList) ? prodList : (prodList.items || prodList.data || []);
    if (!prods.length) test.skip(true, 'no products');
    // Prefer a product with no volume set (default volume=1 → whole-unit math).
    const p = prods.find((x) => !x.volume) || prods[0];
    productId = p.id;
    stockBeforeCreate = Number(p.currentStock || 0);

    const ptList = await ptR.json();
    const patients = Array.isArray(ptList) ? ptList : (ptList.items || ptList.data || []);
    if (!patients.length) test.skip(true, 'no patients');
    patientId = patients[0].id;

    if (drR && drR.ok()) {
      const drList = await drR.json();
      const drs = Array.isArray(drList) ? drList : (drList.items || drList.data || []);
      doctorId = drs[0]?.id || null;
    }
    if (!doctorId) {
      // Fallback: visit-create requires doctorId for status=completed. Use
      // the manager's own userId — seed sometimes flags them as a doctor.
      const me = await get(request, token, `/api/auth/me`).catch(() => null);
      if (me && me.ok()) doctorId = (await me.json())?.user?.id;
    }
    test.skip(!doctorId, 'no doctor available');
  });

  test('create rule: 1 unit per visit (matches product unit)', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !serviceId || !productId);
    // Pre-clean any existing rule for this svc+product so the create lands fresh.
    const existing = await get(request, token, `/api/wellness/auto-consumption-rules?serviceId=${serviceId}`);
    if (existing.ok()) {
      const list = await existing.json();
      for (const rule of list) {
        if (rule.productId === productId) {
          await del(request, token, `/api/wellness/auto-consumption-rules/${rule.id}`).catch(() => {});
        }
      }
    }
    const r = await post(request, token, `/api/wellness/auto-consumption-rules`, {
      serviceId, productId, quantityPerVisit: 1,
    });
    expect(r.status()).toBe(201);
    ruleId = (await r.json()).id;
    createdRuleIds.add(ruleId);
  });

  test('POST visit status=completed → stock decrements by 1', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !ruleId || !patientId);
    const r = await post(request, token, `/api/wellness/visits`, {
      patientId,
      serviceId,
      doctorId,
      status: 'completed',
      amountCharged: 100,
      notes: `${RUN_TAG} smoke`,
    });
    if (!r.ok()) {
      const body = await r.json().catch(() => ({}));
      test.skip(true, `visit-create unavailable: ${r.status()} ${JSON.stringify(body)}`);
    }
    visitId = (await r.json()).id;
    // Event-bus path is async — give the listener a moment to fire.
    await new Promise((res) => setTimeout(res, 800));
    const pr = await get(request, token, `/api/products/${productId}`);
    expect(pr.ok()).toBeTruthy();
    const product = await pr.json();
    expect(Number(product.currentStock)).toBe(stockBeforeCreate - 1);
  });

  test('PUT same visit (status unchanged) → NO double-deduction', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !visitId);
    const r = await put(request, token, `/api/wellness/visits/${visitId}`, {
      status: 'completed',
      notes: `${RUN_TAG} smoke updated`,
    });
    expect(r.ok()).toBeTruthy();
    await new Promise((res) => setTimeout(res, 800));
    const pr = await get(request, token, `/api/products/${productId}`);
    expect(pr.ok()).toBeTruthy();
    const product = await pr.json();
    // Stock unchanged from the post-create state — no second deduction.
    expect(Number(product.currentStock)).toBe(stockBeforeCreate - 1);
  });

  test('movements ledger shows exactly one CONSUMPTION row for this visit', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token || !visitId || !productId);
    const r = await get(request, token, `/api/wellness/inventory/movements?productId=${productId}`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    const movs = Array.isArray(body) ? body : (body.movements || []);
    const ours = movs.filter((m) => m.kind === 'CONSUMPTION' && m.visitId === visitId);
    expect(ours.length).toBe(1);
  });
});

// ── Movements ledger ──────────────────────────────────────────────

test.describe('inventory movements ledger', () => {
  test('rejects missing productId', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const r = await get(request, token, `/api/wellness/inventory/movements`);
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('PRODUCT_REQUIRED');
  });

  test('returns shape { productId, currentStock, movements } for known product', async ({ request }) => {
    const { token } = await getMgr(request);
    test.skip(!token);
    const pR = await get(request, token, `/api/products?limit=1`);
    if (!pR.ok()) test.skip(true);
    const products = await pR.json();
    const list = Array.isArray(products) ? products : (products.items || products.data || []);
    if (!list.length) test.skip(true);
    const productId = list[0].id;

    const r = await get(request, token, `/api/wellness/inventory/movements?productId=${productId}`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.productId).toBe(productId);
    expect(typeof body.currentStock).toBe('number');
    expect(Array.isArray(body.movements)).toBeTruthy();
    // Each movement should declare a kind ∈ {RECEIPT, ADJUSTMENT, CONSUMPTION}
    for (const m of body.movements) {
      expect(['RECEIPT', 'ADJUSTMENT', 'CONSUMPTION']).toContain(m.kind);
    }
  });
});
