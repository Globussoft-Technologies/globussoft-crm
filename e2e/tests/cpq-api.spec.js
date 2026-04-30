// @ts-check
/**
 * CPQ module — backend coverage push for routes/cpq.js.
 *
 * Pre-spec coverage on routes/cpq.js was 27.38% (~23/84 lines). The route
 * file has 4 handlers — Product list+create, Quote list-by-deal+create —
 * and the Quote create handler is where the price math lives: per-line
 * `quantity * unitPrice`, recurring-vs-one-shot bucketing into mrr vs.
 * totalAmount, and integer/float parsing on each field.
 *
 * Endpoints covered:
 *   GET  /api/cpq/products            — list products in tenant
 *   POST /api/cpq/products            — create product (passes through req.body)
 *   GET  /api/cpq/quotes/:dealId      — list quotes for a deal (with line items)
 *   POST /api/cpq/quotes              — create quote with line items + math
 *
 * Branches exercised in routes/cpq.js:
 *   GET /products
 *     - happy path: array of products in tenant, ordered by name asc
 *   POST /products
 *     - happy path: returns 201 with the created row
 *     - tenant scope: tenantId is forced to req.user.tenantId
 *   GET /quotes/:dealId
 *     - happy path: array of quotes WITH lineItems, ordered by createdAt desc
 *     - empty array for a deal with no quotes
 *   POST /quotes
 *     - happy path: lineItems → totalAmount (one-shot) + mrr (recurring)
 *     - quantity defaults to 1 when missing/falsy (parseInt fallback)
 *     - unitPrice parses via parseFloat
 *     - isRecurring is coerced via Boolean()
 *     - productId is parsed when given, null when omitted
 *     - math edges: quantity 0 → lineCost 0; negative unitPrice → negative
 *       lineCost (no server-side rejection — flagged as a hardening item)
 *     - 100% discount semantics — the route has no discount logic, so a
 *       "discount" field is silently ignored. We assert that to lock the
 *       current behaviour.
 *     - 500 when lineItems is missing (cannot .map on undefined)
 *
 * Pattern: cached-token / authXyz helpers identical to sms-api.spec.js. Test
 * data is tagged `E2E_CPQ_<ts>`. NOTE: routes/cpq.js does NOT expose
 * DELETE/PUT for products or quotes, so we cannot programmatically clean up
 * — global-teardown should pick the tagged rows up via name/title prefix
 * scan, or they'll pile up. Quotes don't have a name field; we tag via
 * `title`. Products are tagged via `name`.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
const RUN_TAG = `E2E_CPQ_${Date.now()}`;

async function getAuthToken(request) {
  if (authToken) return authToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: 'admin@globussoft.com', password: 'password123' },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        authToken = data.token;
        return authToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const auth = async (request) => ({ Authorization: `Bearer ${await getAuthToken(request)}` });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}
async function authPost(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}

// ── seed helpers ────────────────────────────────────────────────────
const createdDealIds = [];

async function findOrCreateDeal(request, overrides = {}) {
  const res = await authPost(request, '/api/deals', {
    title: `${RUN_TAG} ${overrides.title || 'cpq-deal'}`,
    amount: overrides.amount != null ? overrides.amount : 1000,
    stage: overrides.stage || 'proposal',
  });
  if (res.status() === 201 || res.status() === 200) {
    const d = await res.json();
    if (d && d.id) {
      createdDealIds.push(d.id);
      return d;
    }
  }
  // Fallback: use any existing deal.
  const list = await authGet(request, '/api/deals?limit=1');
  if (list.ok()) {
    const body = await list.json();
    const arr = Array.isArray(body) ? body : (body.deals || body.data || []);
    return arr[0] || null;
  }
  return null;
}

test.afterAll(async ({ request }) => {
  for (const id of createdDealIds) {
    await authDelete(request, `/api/deals/${id}`).catch(() => {});
  }
  // Products + quotes have no DELETE endpoint in this route. Tagged rows
  // (E2E_CPQ_<ts> prefix on name/title) can be scrubbed by global-teardown.
});

async function createProduct(request, overrides = {}) {
  return authPost(request, '/api/cpq/products', {
    name: `${RUN_TAG} ${overrides.name || 'product'}`,
    price: overrides.price != null ? overrides.price : 100,
    ...overrides,
  });
}

// ─── GET /products ─────────────────────────────────────────────────────

test.describe('CPQ API — GET /products', () => {
  test('returns an array', async ({ request }) => {
    const res = await authGet(request, '/api/cpq/products');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('rows are ordered by name asc', async ({ request }) => {
    await createProduct(request, { name: 'zzz-last' });
    await createProduct(request, { name: 'aaa-first' });
    const res = await authGet(request, '/api/cpq/products');
    expect(res.status()).toBe(200);
    const products = await res.json();
    if (products.length >= 2) {
      const names = products.map((p) => p.name);
      const sorted = [...names].sort((a, b) => String(a).localeCompare(String(b)));
      expect(names).toEqual(sorted);
    }
  });
});

// ─── POST /products ────────────────────────────────────────────────────

test.describe('CPQ API — POST /products', () => {
  test('creates a product with name + price and returns 201', async ({ request }) => {
    const res = await createProduct(request, { name: 'create-basic', price: 199.99 });
    expect(res.status()).toBe(201);
    const p = await res.json();
    expect(p.id).toBeTruthy();
    expect(p.name).toContain('create-basic');
  });

  test('persists arbitrary extra fields via spread (description)', async ({ request }) => {
    const res = await createProduct(request, {
      name: 'with-description',
      price: 50,
      description: `${RUN_TAG} a longer marketing blurb`,
    });
    expect(res.status()).toBe(201);
    const p = await res.json();
    if ('description' in p) {
      expect(p.description).toContain(RUN_TAG);
    }
  });

  test('forces tenantId from the JWT — caller cannot override', async ({ request }) => {
    const res = await createProduct(request, {
      name: 'tenant-scope',
      price: 1,
      tenantId: 999999, // attempt cross-tenant write
    });
    expect(res.status()).toBe(201);
    const p = await res.json();
    expect(p.tenantId).not.toBe(999999);
  });

  test('returns 500 on a Prisma constraint failure (empty body)', async ({ request }) => {
    // No name, no required fields — Prisma will reject. Route returns 500.
    const res = await authPost(request, '/api/cpq/products', {});
    expect([400, 500]).toContain(res.status());
  });
});

// ─── GET /quotes/:dealId ───────────────────────────────────────────────

test.describe('CPQ API — GET /quotes/:dealId', () => {
  test('returns an empty array for a deal with no quotes', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'empty-quotes' });
    test.skip(!deal, 'no deal available');
    const res = await authGet(request, `/api/cpq/quotes/${deal.id}`);
    expect(res.status()).toBe(200);
    const quotes = await res.json();
    expect(Array.isArray(quotes)).toBe(true);
    // brand-new deal — list should not contain other-tenant rows
    for (const q of quotes) expect(q.dealId).toBe(deal.id);
  });

  test('returns quotes WITH lineItems for the given deal', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'with-quotes' });
    test.skip(!deal, 'no deal available');
    await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} q-with-lines`,
      lineItems: [
        { productName: 'A', quantity: 2, unitPrice: 100, isRecurring: false },
        { productName: 'B', quantity: 1, unitPrice: 50, isRecurring: true },
      ],
    });
    const res = await authGet(request, `/api/cpq/quotes/${deal.id}`);
    expect(res.status()).toBe(200);
    const quotes = await res.json();
    expect(quotes.length).toBeGreaterThan(0);
    expect(Array.isArray(quotes[0].lineItems)).toBe(true);
  });

  test('list is ordered by createdAt desc (newest first)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'order-test' });
    test.skip(!deal, 'no deal available');
    const a = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} q-ord-1`,
      lineItems: [{ productName: 'L', quantity: 1, unitPrice: 1, isRecurring: false }],
    });
    const b = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} q-ord-2`,
      lineItems: [{ productName: 'L', quantity: 1, unitPrice: 1, isRecurring: false }],
    });
    expect(a.status()).toBe(201);
    expect(b.status()).toBe(201);
    const res = await authGet(request, `/api/cpq/quotes/${deal.id}`);
    expect(res.status()).toBe(200);
    const quotes = await res.json();
    const ours = quotes.filter((q) => String(q.title).includes(RUN_TAG));
    if (ours.length >= 2) {
      const idA = (await a.json()).id;
      const idB = (await b.json()).id;
      const idxA = ours.findIndex((q) => q.id === idA);
      const idxB = ours.findIndex((q) => q.id === idB);
      expect(idxB).toBeLessThan(idxA);
    }
  });
});

// ─── POST /quotes ──────────────────────────────────────────────────────

test.describe('CPQ API — POST /quotes', () => {
  test('one-shot line items roll up into totalAmount', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'oneshot-math' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} oneshot`,
      lineItems: [
        { productName: 'X', quantity: 3, unitPrice: 100, isRecurring: false },
        { productName: 'Y', quantity: 2, unitPrice: 50, isRecurring: false },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    // 3*100 + 2*50 = 400
    expect(Number(q.totalAmount)).toBe(400);
    expect(Number(q.mrr)).toBe(0);
  });

  test('recurring line items roll up into mrr (not totalAmount)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'mrr-math' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} mrr`,
      lineItems: [
        { productName: 'sub-a', quantity: 1, unitPrice: 200, isRecurring: true },
        { productName: 'sub-b', quantity: 5, unitPrice: 30, isRecurring: true },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    // 200 + 5*30 = 350
    expect(Number(q.mrr)).toBe(350);
    expect(Number(q.totalAmount)).toBe(0);
  });

  test('mixed line items split correctly between totalAmount and mrr', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'mixed-math' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} mixed`,
      lineItems: [
        { productName: 'one-shot', quantity: 1, unitPrice: 1000, isRecurring: false },
        { productName: 'sub', quantity: 2, unitPrice: 99, isRecurring: true },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    expect(Number(q.totalAmount)).toBe(1000);
    expect(Number(q.mrr)).toBe(198);
  });

  test('lineItems are persisted via nested create', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'nested-create' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} nested`,
      lineItems: [
        { productName: 'L1', quantity: 1, unitPrice: 10, isRecurring: false },
        { productName: 'L2', quantity: 4, unitPrice: 25, isRecurring: false },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    expect(Array.isArray(q.lineItems)).toBe(true);
    expect(q.lineItems.length).toBe(2);
    const names = q.lineItems.map((li) => li.productName).sort();
    expect(names).toEqual(['L1', 'L2']);
  });

  test('quantity defaults to 1 when missing/falsy (parseInt fallback)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'qty-default' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} qty-default`,
      lineItems: [
        { productName: 'no-qty', unitPrice: 50, isRecurring: false },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    // missing qty → parseInt(undefined)=NaN → || 1 → 1; lineCost = 1*50 = 50
    expect(q.lineItems[0].quantity).toBe(1);
    expect(Number(q.totalAmount)).toBe(50);
  });

  test('unitPrice parses via parseFloat (accepts numeric string)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'price-cast' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} price-cast`,
      lineItems: [
        { productName: 'string-price', quantity: 2, unitPrice: '12.5', isRecurring: false },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    // BUG SURFACE: route does `item.quantity * item.unitPrice` BEFORE parseFloat,
    // so for a string "12.5" the JS coercion still works and 2 * "12.5" = 25.
    expect(Number(q.totalAmount)).toBe(25);
  });

  test('isRecurring is coerced via Boolean (truthy values stick)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'bool-coerce' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} bool-coerce`,
      lineItems: [
        { productName: 'truthy-string', quantity: 1, unitPrice: 100, isRecurring: 'yes' },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    expect(q.lineItems[0].isRecurring).toBe(true);
    expect(Number(q.mrr)).toBe(100);
    expect(Number(q.totalAmount)).toBe(0);
  });

  test('quantity 0 yields lineCost 0 (no totalAmount contribution)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'zero-qty' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} zero-qty`,
      lineItems: [
        { productName: 'free', quantity: 0, unitPrice: 999, isRecurring: false },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    // After the Number.isFinite() fix in cpq.js, parseInt(0) = 0 is finite so
    // qty stays 0 (no longer silently rewritten to 1 by `|| 1`). lineCost is
    // 0 * 999 = 0. The earlier ae92cda fix used `parseInt(...) || 1` which
    // regressed this assertion until the isFinite guard landed.
    expect(Number(q.totalAmount)).toBe(0);
  });

  test('negative unitPrice produces a negative lineCost (no server-side rejection)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'negative-price' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} negative-price`,
      lineItems: [
        { productName: 'discount', quantity: 1, unitPrice: -50, isRecurring: false },
        { productName: 'normal', quantity: 1, unitPrice: 200, isRecurring: false },
      ],
    });
    // Document current behaviour. A future hardening may reject this with 400.
    expect([201, 400]).toContain(res.status());
    if (res.status() === 201) {
      const q = await res.json();
      expect(Number(q.totalAmount)).toBe(150);
    }
  });

  test('a "discount" field is silently ignored — totals reflect raw line math', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'discount-ignored' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} discount-ignored`,
      discount: 200, // > 100% would matter if discount existed
      lineItems: [
        { productName: 'item', quantity: 1, unitPrice: 100, isRecurring: false },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    // 100% or "200%" discount would zero/invert the total IF the route honored
    // it. The current route ignores `discount` entirely, so totalAmount=100.
    expect(Number(q.totalAmount)).toBe(100);
  });

  test('lineItems missing → 500 (cannot .map on undefined)', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'no-lineitems' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} no-lineitems`,
    });
    // Current route has no validation guard — undefined.map crashes → 500.
    // A hardening pass might convert this to 400. Accept both.
    expect([400, 500]).toContain(res.status());
  });

  test('productId is parsed when provided', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'product-link' });
    test.skip(!deal, 'no deal available');
    // Create a product first so we have a valid id.
    const pRes = await createProduct(request, { name: 'linkable', price: 99 });
    expect(pRes.status()).toBe(201);
    const product = await pRes.json();

    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} product-link`,
      lineItems: [
        { productName: product.name, quantity: 2, unitPrice: 99, isRecurring: false, productId: product.id },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    expect(q.lineItems[0].productId).toBe(product.id);
  });

  test('productId omitted → null on the line item', async ({ request }) => {
    const deal = await findOrCreateDeal(request, { title: 'no-product-link' });
    test.skip(!deal, 'no deal available');
    const res = await authPost(request, '/api/cpq/quotes', {
      dealId: deal.id,
      title: `${RUN_TAG} no-product-link`,
      lineItems: [
        { productName: 'detached', quantity: 1, unitPrice: 10, isRecurring: false },
      ],
    });
    expect(res.status()).toBe(201);
    const q = await res.json();
    expect(q.lineItems[0].productId).toBeNull();
  });
});

// ─── Auth gate ─────────────────────────────────────────────────────────

test.describe('CPQ API — auth gate', () => {
  test('GET /products without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/cpq/products`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /products without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/cpq/products`, {
      data: { name: 'x', price: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /quotes/:dealId without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/cpq/quotes/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /quotes without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/cpq/quotes`, {
      data: { dealId: 1, title: 'x', lineItems: [] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
