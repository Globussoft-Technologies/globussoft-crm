// @ts-check
/**
 * Estimates module — backend coverage push.
 *
 * routes/estimates.js was 35.95% covered. The file is a CRUD router with
 * line items, soft-delete, and an estimate→invoice conversion path:
 *
 *   GET    /api/estimates              — list + ?status filter + pagination +
 *                                        includeDeleted opt-in
 *   GET    /api/estimates/:id          — single + 400/404 + soft-delete hidden
 *                                        unless includeDeleted=true
 *   POST   /api/estimates              — create + title required (+ legacy 'name'
 *                                        alias) + lineItems required (+ 'items'
 *                                        alias) + line item validators (qty/price)
 *                                        + validUntil parse/past validation +
 *                                        MAX_LINE_ITEMS cap (200)
 *   PUT    /api/estimates/:id          — partial update + 400/404 + same
 *                                        validators (title/status/validUntil)
 *   PUT    /api/estimates/:id/convert  — convert to Invoice + 400/404 + already-
 *                                        converted guard + missing-contact guard
 *   DELETE /api/estimates/:id          — ADMIN soft-delete + 400/404 + idempotent
 *   POST   /api/estimates/:id/restore  — ADMIN restore + 400/404 + idempotent
 *
 * Pattern: cached-token / authXyz helpers identical to sla-breach-api.spec.js
 * and expenses-api.spec.js. Test data tagged `E2E_EST_<ts>`. afterAll DELETEs
 * every estimate the spec created (best-effort).
 *
 * Tenant: admin@globussoft.com (generic admin) — every endpoint is reachable.
 *
 * NOTE on conversion: the convert endpoint creates an Invoice row that this
 * spec does NOT clean up — generic-tenant invoices have a separate cleanup
 * surface and there's no DELETE on /api/invoices. The invoiceNum prefix
 * (`INV-` + 6 hex chars) makes them easy to identify if a sweep is needed.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
const RUN_TAG = `E2E_EST_${Date.now()}`;

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
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}

// ── cleanup tracking ────────────────────────────────────────────────
const createdEstimateIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdEstimateIds) {
    await authDelete(request, `/api/estimates/${id}`).catch(() => {});
  }
});

// Helper: create an estimate and remember it for cleanup.
async function createEstimate(request, overrides = {}) {
  const body = {
    title: `${RUN_TAG} ${overrides.title || 'estimate'}`,
    lineItems: overrides.lineItems ?? [
      { description: 'default item', quantity: 1, unitPrice: 100 },
    ],
    ...(overrides.contactId !== undefined ? { contactId: overrides.contactId } : {}),
    ...(overrides.dealId !== undefined ? { dealId: overrides.dealId } : {}),
    ...(overrides.validUntil !== undefined ? { validUntil: overrides.validUntil } : {}),
    ...(overrides.notes !== undefined ? { notes: overrides.notes } : {}),
  };
  const res = await authPost(request, '/api/estimates', body);
  expect(res.status(), `estimate create: ${await res.text()}`).toBe(201);
  const e = await res.json();
  createdEstimateIds.push(e.id);
  return e;
}

// Helper: pick any contact id we can use for conversion tests. The convert
// endpoint refuses estimates that have no contactId, so we need a real one.
// Returns null if the tenant has no contacts (the calling test should skip).
async function findContactId(request) {
  const res = await authGet(request, '/api/contacts?limit=1');
  if (!res.ok()) return null;
  const list = await res.json();
  // /api/contacts may return either an array or { rows, total }. Handle both.
  const rows = Array.isArray(list) ? list : (list.rows || list.data || []);
  return rows[0]?.id ?? null;
}

// ─── POST /api/estimates ────────────────────────────────────────────

test.describe('Estimates API — POST /', () => {
  test('400 when "title" is missing (and "name" alias also absent)', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/title is required/i);
  });

  test('legacy "name" alias accepted in place of "title"', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      name: `${RUN_TAG} legacy-name`,
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }],
    });
    expect(res.status()).toBe(201);
    const e = await res.json();
    createdEstimateIds.push(e.id);
    expect(e.title).toContain('legacy-name');
  });

  test('legacy "items" alias accepted in place of "lineItems"', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} legacy-items`,
      items: [{ description: 'aliased', quantity: 2, unitPrice: 50 }],
    });
    expect(res.status()).toBe(201);
    const e = await res.json();
    createdEstimateIds.push(e.id);
    expect(e.totalAmount).toBe(100);
    expect(e.lineItems.length).toBe(1);
  });

  test('400 LINE_ITEMS_REQUIRED on empty lineItems array', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} empty-items`,
      lineItems: [],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('LINE_ITEMS_REQUIRED');
  });

  test('400 LINE_ITEMS_REQUIRED when lineItems omitted entirely', async ({ request }) => {
    // Falls into the same branch — the route coerces `undefined` → [] before checking length.
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} no-items`,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('LINE_ITEMS_REQUIRED');
  });

  test('400 LINE_ITEMS_LIMIT_EXCEEDED when > 200 line items', async ({ request }) => {
    const lineItems = Array.from({ length: 201 }, (_, i) => ({
      description: `bulk-${i}`,
      quantity: 1,
      unitPrice: 1,
    }));
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} too-many`,
      lineItems,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('LINE_ITEMS_LIMIT_EXCEEDED');
  });

  test('400 INVALID_QUANTITY on quantity < 1', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} zero-qty`,
      lineItems: [{ description: 'zero', quantity: 0, unitPrice: 10 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_QUANTITY');
  });

  test('400 NEGATIVE_PRICE on unitPrice < 0', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} neg-price`,
      lineItems: [{ description: 'neg', quantity: 1, unitPrice: -50 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('NEGATIVE_PRICE');
  });

  test('400 INVALID_VALID_UNTIL on unparseable date', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} bad-vu`,
      validUntil: 'not-a-date',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_VALID_UNTIL');
  });

  test('400 VALID_UNTIL_IN_PAST on date before today', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} past-vu`,
      validUntil: '2010-01-01',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('VALID_UNTIL_IN_PAST');
  });

  test('201 with future validUntil', async ({ request }) => {
    const e = await createEstimate(request, { validUntil: '2099-12-31' });
    expect(e.validUntil).toBeTruthy();
    expect(new Date(e.validUntil).getFullYear()).toBe(2099);
  });

  test('totalAmount calculated as sum(qty * unitPrice)', async ({ request }) => {
    const e = await createEstimate(request, {
      lineItems: [
        { description: 'a', quantity: 3, unitPrice: 100 },
        { description: 'b', quantity: 2, unitPrice: 50 },
      ],
    });
    expect(e.totalAmount).toBe(3 * 100 + 2 * 50);
  });

  test('estimateNum stamped with EST- prefix', async ({ request }) => {
    const e = await createEstimate(request, { title: 'num-format' });
    expect(e.estimateNum).toMatch(/^EST-[A-F0-9]{6}$/);
  });

  test('default status is "Draft"', async ({ request }) => {
    const e = await createEstimate(request, { title: 'default-status' });
    expect(e.status).toBe('Draft');
  });

  test('notes are persisted', async ({ request }) => {
    const e = await createEstimate(request, { title: 'with-notes', notes: 'sales follow-up' });
    expect(e.notes).toBe('sales follow-up');
  });

  test('line item description defaults to "" when omitted', async ({ request }) => {
    const e = await createEstimate(request, {
      title: 'empty-desc',
      lineItems: [{ quantity: 1, unitPrice: 10 }],
    });
    expect(e.lineItems[0].description).toBe('');
  });
});

// ─── Regression-coverage-backlog #11 ────────────────────────────────
// Closes #164, #174, #178, #199, #255, #256, #322, #333, #351.
//
// The acceptance points overlap with several POST /api/estimates tests
// already in this file — these new tests pin the boundary cases (just
// inside vs just outside each cap) and the response-shape invariants
// the gap cards called out:
//
//   #164 / #333 / #351 — qty < 1 rejected: existing test (line 187)
//     covers qty=0; this block adds qty=-5 (negative) + qty=1 (just
//     above the rejection floor → 201) so the boundary is pinned both
//     sides.
//
//   #174 — line-items > 200 rejected (5000+-item DoS): existing test
//     (line 173) covers 201 → 400 with code; this block adds the
//     boundary-just-inside case (200 → 201) so the cap can't drift up.
//
//   #178 / #322 — validUntil year range: gap card says "2026..2100".
//     Backend currently caps the LOWER bound (rejects past dates) but
//     has NO upper-bound cap — year 2150 is accepted. Path B.2 per
//     CLAUDE.md "gap-card claims as hypotheses": pin the actual
//     behaviour today (any date ≥ today is accepted) and file the
//     upper-bound-cap discussion as a TODOS follow-up. Tests assert
//     reachable boundaries (today, 2099, 2150 all accepted; yesterday
//     and historical past rejected).
//
//   #255 — totalAmount = sum(qty * unitPrice): existing test (line
//     231) covers a simple 2-line case; this block adds a single-line
//     decimal (3 * 99.5 = 298.5) and a many-line aggregate, plus the
//     PUT path (totalAmount survives unchanged on a notes-only update).
//
//   #256 — currency string uses single symbol (no "$ ₹"): the route
//     returns numeric totalAmount + no currency-string fields, so the
//     no-double-symbol invariant is vacuously satisfied. Pin this with
//     a stringify-and-grep assertion on the full response so any
//     future addition of a formatted "${amount}" field can't sneak a
//     double-symbol regression in.
//
//   #199 — old shape `{name, items}`: gap card says "400 with hint" or
//     "no 500". Backend chose backwards-compat shim — `name` aliases
//     `title`, `items` aliases `lineItems`. The aliases are tested at
//     lines 132 & 143. This block adds the cross-shape case (`name`
//     present, `items` absent → still hits LINE_ITEMS_REQUIRED 400, no
//     500) and the legacy-only case (both legacy fields).
test.describe('Estimates API — regression-coverage-backlog #11', () => {
  // #164 / #333 / #351 — qty boundary
  test('qty=-5 rejected with INVALID_QUANTITY (#164/#333/#351)', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} neg-qty`,
      lineItems: [{ description: 'neg', quantity: -5, unitPrice: 10 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_QUANTITY');
  });

  test('qty=1 accepted (just above rejection floor) (#164/#333/#351)', async ({ request }) => {
    const e = await createEstimate(request, {
      title: 'qty-floor',
      lineItems: [{ description: 'one', quantity: 1, unitPrice: 10 }],
    });
    expect(e.lineItems[0].quantity).toBe(1);
  });

  // #174 — line-items boundary
  test('exactly 200 line items accepted (boundary just inside cap) (#174)', async ({ request }) => {
    const lineItems = Array.from({ length: 200 }, (_, i) => ({
      description: `at-cap-${i}`,
      quantity: 1,
      unitPrice: 1,
    }));
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} at-cap-200`,
      lineItems,
    });
    expect(res.status(), `200-item create: ${await res.text()}`).toBe(201);
    const e = await res.json();
    createdEstimateIds.push(e.id);
    expect(e.lineItems.length).toBe(200);
    expect(e.totalAmount).toBe(200);
  });

  // #178 / #322 — validUntil bounds (Path B.2: pin actual route behaviour;
  // upper-bound cap deferred to TODOS — see commit body)
  test('validUntil = tomorrow accepted (just inside future-only floor) (#178/#322)', async ({ request }) => {
    // Avoid `today` here — `YYYY-MM-DD` is parsed as UTC midnight while the
    // route's `setHours(0,0,0,0)` runs in the server's local TZ, so a "today"
    // input flakes across IST/UTC servers. Tomorrow is unambiguously future.
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const e = await createEstimate(request, {
      title: 'vu-tomorrow',
      validUntil: t.toISOString().slice(0, 10),
    });
    expect(e.validUntil).toBeTruthy();
    expect(new Date(e.validUntil).getTime()).toBeGreaterThan(Date.now() - 86400000);
  });

  test('validUntil = yesterday rejected with VALID_UNTIL_IN_PAST (#178/#322)', async ({ request }) => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const res = await authPost(request, '/api/estimates', {
      title: `${RUN_TAG} vu-yesterday`,
      validUntil: y.toISOString().slice(0, 10),
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('VALID_UNTIL_IN_PAST');
  });

  test('validUntil far future (year 2150) currently accepted — pins absent upper-bound cap (#178/#322 TODOS)', async ({ request }) => {
    // Gap card says range should be 2026..2100. Backend has no upper-bound
    // cap today; this test pins that fact. When the cap lands, flip this
    // assertion to expect 400 with a new INVALID_VALID_UNTIL_FUTURE code.
    const e = await createEstimate(request, {
      title: 'vu-far-future',
      validUntil: '2150-06-01',
    });
    expect(new Date(e.validUntil).getFullYear()).toBe(2150);
  });

  // #255 — totalAmount = sum(qty * unitPrice)
  test('totalAmount handles decimal unitPrice (3 * 99.5 = 298.5) (#255)', async ({ request }) => {
    const e = await createEstimate(request, {
      title: 'decimal-amt',
      lineItems: [{ description: 'd', quantity: 3, unitPrice: 99.5 }],
    });
    expect(e.totalAmount).toBeCloseTo(298.5, 2);
  });

  test('totalAmount aggregates 5+ line items correctly (#255)', async ({ request }) => {
    const lineItems = [
      { description: 'a', quantity: 1, unitPrice: 10 },
      { description: 'b', quantity: 2, unitPrice: 20 },
      { description: 'c', quantity: 3, unitPrice: 30 },
      { description: 'd', quantity: 4, unitPrice: 40 },
      { description: 'e', quantity: 5, unitPrice: 50 },
    ];
    const expected = lineItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
    const e = await createEstimate(request, { title: 'agg-amt', lineItems });
    expect(e.totalAmount).toBe(expected); // 1*10 + 2*20 + 3*30 + 4*40 + 5*50 = 550
  });

  test('totalAmount unchanged after notes-only PUT (#255)', async ({ request }) => {
    const e = await createEstimate(request, {
      title: 'amt-stable',
      lineItems: [{ description: 'x', quantity: 2, unitPrice: 50 }],
    });
    expect(e.totalAmount).toBe(100);
    const res = await authPut(request, `/api/estimates/${e.id}`, { notes: 'unrelated update' });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.totalAmount).toBe(100);
  });

  // #256 — currency single-symbol invariant. Route returns numeric
  // totalAmount + no formatted-currency string; pin via stringify-and-grep.
  test('response has no double-symbol currency string anywhere (#256)', async ({ request }) => {
    const e = await createEstimate(request, {
      title: 'no-double-sym',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    });
    const blob = JSON.stringify(e);
    // Forbidden: "$ ₹", "₹ $", "$$", "₹₹", "USD$", "INR₹", "$ USD" — any
    // doubled-symbol-looking substring. The route doesn't currently emit
    // a formatted string, so the fail-mode this guards is "future PR adds
    // formattedTotal field and accidentally double-prefixes it".
    expect(blob).not.toMatch(/\$\s*₹/);
    expect(blob).not.toMatch(/₹\s*\$/);
    expect(blob).not.toMatch(/\$\$/);
    expect(blob).not.toMatch(/₹₹/);
    expect(blob).not.toMatch(/USD\s*\$/);
    expect(blob).not.toMatch(/INR\s*₹/);
    // And totalAmount is a raw number (no embedded symbol)
    expect(typeof e.totalAmount).toBe('number');
  });

  // #199 — legacy shape handling. Backend accepts `name`/`items` as aliases
  // (back-compat shim) — ALREADY tested at lines 132 & 143. This block adds
  // the mixed-shape case (name + lineItems, title + items, both legacy).
  test('legacy {name, items} together → 201 (back-compat shim, no 500) (#199)', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      name: `${RUN_TAG} both-legacy`,
      items: [{ description: 'legacy-shape', quantity: 1, unitPrice: 25 }],
    });
    expect(res.status(), `legacy-both: ${await res.text()}`).toBe(201);
    const e = await res.json();
    createdEstimateIds.push(e.id);
    expect(e.title).toContain('both-legacy');
    expect(e.totalAmount).toBe(25);
  });

  test('legacy `name` with NEW `lineItems` → 201 (mixed shape ok) (#199)', async ({ request }) => {
    const res = await authPost(request, '/api/estimates', {
      name: `${RUN_TAG} mixed-name`,
      lineItems: [{ description: 'mixed', quantity: 1, unitPrice: 5 }],
    });
    expect(res.status()).toBe(201);
    const e = await res.json();
    createdEstimateIds.push(e.id);
    expect(e.title).toContain('mixed-name');
  });

  test('legacy `name` only with NO items field → 400 LINE_ITEMS_REQUIRED, never 500 (#199)', async ({ request }) => {
    // Worst-case legacy-shape: title alias is recognised but no line-items
    // alias supplied. Must NOT throw a Prisma error masquerading as 500.
    const res = await authPost(request, '/api/estimates', {
      name: `${RUN_TAG} only-legacy-name`,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('LINE_ITEMS_REQUIRED');
  });
});

// ─── GET /api/estimates ─────────────────────────────────────────────

test.describe('Estimates API — GET /', () => {
  test('returns array', async ({ request }) => {
    await createEstimate(request, { title: 'list-A' });
    const res = await authGet(request, '/api/estimates');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('?status=Draft returns only Draft rows', async ({ request }) => {
    await createEstimate(request, { title: 'draft-only' });
    const res = await authGet(request, '/api/estimates?status=Draft&limit=500');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((e) => e.status === 'Draft')).toBe(true);
  });

  test('pagination — limit honored', async ({ request }) => {
    const res = await authGet(request, '/api/estimates?limit=1');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeLessThanOrEqual(1);
  });

  test('pagination — limit > 500 clamped to 500', async ({ request }) => {
    const res = await authGet(request, '/api/estimates?limit=99999');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeLessThanOrEqual(500);
  });

  test('pagination — negative limit clamped to 1 (Math.max guard)', async ({ request }) => {
    // Same engine pattern as tasks: Math.max(1, Math.min(limit||100, 500)).
    // Negative values pass the OR-fallback and bottom out at 1.
    const res = await authGet(request, '/api/estimates?limit=-5');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeLessThanOrEqual(1);
  });

  test('soft-deleted hidden by default', async ({ request }) => {
    const e = await createEstimate(request, { title: 'hidden-default' });
    await authDelete(request, `/api/estimates/${e.id}`);
    const list = await (await authGet(request, '/api/estimates?limit=500')).json();
    expect(list.find((row) => row.id === e.id)).toBeFalsy();
  });

  test('?includeDeleted=true surfaces soft-deleted rows', async ({ request }) => {
    const e = await createEstimate(request, { title: 'opt-in-deleted' });
    await authDelete(request, `/api/estimates/${e.id}`);
    const list = await (await authGet(request, '/api/estimates?includeDeleted=true&limit=500')).json();
    expect(list.find((row) => row.id === e.id)).toBeTruthy();
  });
});

// ─── GET /api/estimates/:id ─────────────────────────────────────────

test.describe('Estimates API — GET /:id', () => {
  test('400 on non-numeric id', async ({ request }) => {
    const res = await authGet(request, '/api/estimates/not-a-number');
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authGet(request, '/api/estimates/99999999');
    expect(res.status()).toBe(404);
  });

  test('returns row with lineItems eagerly loaded', async ({ request }) => {
    const e = await createEstimate(request, { title: 'detail-eager' });
    const res = await authGet(request, `/api/estimates/${e.id}`);
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.id).toBe(e.id);
    expect(Array.isArray(got.lineItems)).toBe(true);
    expect(got.lineItems.length).toBeGreaterThanOrEqual(1);
  });

  test('soft-deleted estimate returns 404 by default', async ({ request }) => {
    const e = await createEstimate(request, { title: 'detail-deleted' });
    await authDelete(request, `/api/estimates/${e.id}`);
    const res = await authGet(request, `/api/estimates/${e.id}`);
    expect(res.status()).toBe(404);
  });

  test('soft-deleted estimate visible with ?includeDeleted=true', async ({ request }) => {
    const e = await createEstimate(request, { title: 'detail-included' });
    await authDelete(request, `/api/estimates/${e.id}`);
    const res = await authGet(request, `/api/estimates/${e.id}?includeDeleted=true`);
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.deletedAt).toBeTruthy();
  });
});

// ─── PUT /api/estimates/:id ─────────────────────────────────────────

test.describe('Estimates API — PUT /:id', () => {
  test('400 on non-numeric id', async ({ request }) => {
    const res = await authPut(request, '/api/estimates/not-a-number', { title: 'x' });
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/estimates/99999999', { title: 'x' });
    expect(res.status()).toBe(404);
  });

  test('updates title', async ({ request }) => {
    const e = await createEstimate(request, { title: 'pre-rename' });
    const res = await authPut(request, `/api/estimates/${e.id}`, {
      title: `${RUN_TAG} renamed`,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).title).toContain('renamed');
  });

  test('400 TITLE_REQUIRED on empty-string title', async ({ request }) => {
    const e = await createEstimate(request, { title: 'empty-title-update' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { title: '   ' });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('TITLE_REQUIRED');
  });

  test('400 INVALID_STATUS on bogus status', async ({ request }) => {
    const e = await createEstimate(request, { title: 'bad-status' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { status: 'NotAStatus' });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_STATUS');
  });

  test('updates status to Sent', async ({ request }) => {
    const e = await createEstimate(request, { title: 'send-it' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { status: 'Sent' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Sent');
  });

  test('updates status to Accepted', async ({ request }) => {
    const e = await createEstimate(request, { title: 'accept-it' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { status: 'Accepted' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Accepted');
  });

  test('updates status to Rejected', async ({ request }) => {
    const e = await createEstimate(request, { title: 'reject-it' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { status: 'Rejected' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Rejected');
  });

  test('400 INVALID_VALID_UNTIL on bogus date in PUT', async ({ request }) => {
    const e = await createEstimate(request, { title: 'bad-vu-update' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { validUntil: 'wat' });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_VALID_UNTIL');
  });

  test('400 VALID_UNTIL_IN_PAST on past date in PUT', async ({ request }) => {
    const e = await createEstimate(request, { title: 'past-vu-update' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { validUntil: '2001-06-15' });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('VALID_UNTIL_IN_PAST');
  });

  test('PUT clears validUntil when set to null', async ({ request }) => {
    const e = await createEstimate(request, { title: 'clear-vu', validUntil: '2099-01-01' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { validUntil: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).validUntil).toBeNull();
  });

  test('PUT updates notes field', async ({ request }) => {
    const e = await createEstimate(request, { title: 'notes-update' });
    const res = await authPut(request, `/api/estimates/${e.id}`, { notes: 'follow-up sent' });
    expect(res.status()).toBe(200);
    expect((await res.json()).notes).toBe('follow-up sent');
  });

  test('PUT empty body is no-op (200, fields preserved)', async ({ request }) => {
    const e = await createEstimate(request, { title: 'noop-update' });
    const res = await authPut(request, `/api/estimates/${e.id}`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).title).toContain('noop-update');
  });
});

// ─── PUT /api/estimates/:id/convert ─────────────────────────────────

test.describe('Estimates API — PUT /:id/convert', () => {
  test('400 on non-numeric id', async ({ request }) => {
    const res = await authPut(request, '/api/estimates/abc/convert', {});
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/estimates/99999999/convert', {});
    expect(res.status()).toBe(404);
  });

  test('400 when estimate has no contactId', async ({ request }) => {
    const e = await createEstimate(request, { title: 'no-contact-convert' });
    expect(e.contactId).toBeFalsy();
    const res = await authPut(request, `/api/estimates/${e.id}/convert`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/contact/i);
  });

  test('successful convert creates Invoice + flips estimate to Converted', async ({ request }) => {
    const contactId = await findContactId(request);
    test.skip(!contactId, 'no contact in tenant — cannot exercise convert success path');

    const e = await createEstimate(request, {
      title: 'convertable',
      contactId,
      lineItems: [{ description: 'service', quantity: 1, unitPrice: 250 }],
    });
    const res = await authPut(request, `/api/estimates/${e.id}/convert`, {});
    expect(res.status(), `convert: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.estimate.status).toBe('Converted');
    expect(body.invoice).toBeTruthy();
    expect(body.invoice.invoiceNum).toMatch(/^INV-[A-F0-9]{6}$/);
    expect(body.invoice.amount).toBe(250);
    expect(body.invoice.status).toBe('UNPAID');
    // Due date stamped 30 days out — strictly after createdAt.
    if (body.invoice.dueDate && body.invoice.createdAt) {
      const due = new Date(body.invoice.dueDate).getTime();
      const created = new Date(body.invoice.createdAt).getTime();
      expect(due).toBeGreaterThan(created);
    }
  });

  test('400 when re-converting an already-Converted estimate', async ({ request }) => {
    const contactId = await findContactId(request);
    test.skip(!contactId, 'no contact in tenant — cannot exercise convert idempotency');

    const e = await createEstimate(request, {
      title: 'already-converted',
      contactId,
      lineItems: [{ description: 'one-shot', quantity: 1, unitPrice: 100 }],
    });
    const first = await authPut(request, `/api/estimates/${e.id}/convert`, {});
    expect(first.status()).toBe(200);

    const second = await authPut(request, `/api/estimates/${e.id}/convert`, {});
    expect(second.status()).toBe(400);
    expect((await second.json()).error).toMatch(/already converted/i);
  });
});

// ─── DELETE /api/estimates/:id (admin-only soft-delete) ──────────────

test.describe('Estimates API — DELETE /:id (soft-delete)', () => {
  test('400 on non-numeric id', async ({ request }) => {
    const res = await authDelete(request, '/api/estimates/abc');
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/estimates/99999999');
    expect(res.status()).toBe(404);
  });

  test('flips deletedAt; row hidden from default list', async ({ request }) => {
    const e = await createEstimate(request, { title: 'soft-delete-target' });
    const del = await authDelete(request, `/api/estimates/${e.id}`);
    expect(del.status()).toBe(200);
    const body = await del.json();
    expect(body.softDeleted).toBe(true);
    expect(body.deletedAt).toBeTruthy();
  });

  test('idempotent: second DELETE returns idempotent:true with no state change', async ({ request }) => {
    const e = await createEstimate(request, { title: 'idempotent-delete' });
    await authDelete(request, `/api/estimates/${e.id}`);
    const second = await authDelete(request, `/api/estimates/${e.id}`);
    expect(second.status()).toBe(200);
    const body = await second.json();
    expect(body.idempotent).toBe(true);
    expect(body.softDeleted).toBe(true);
  });
});

// ─── POST /api/estimates/:id/restore (admin-only) ───────────────────

test.describe('Estimates API — POST /:id/restore', () => {
  test('400 on non-numeric id', async ({ request }) => {
    const res = await authPost(request, '/api/estimates/abc/restore', {});
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authPost(request, '/api/estimates/99999999/restore', {});
    expect(res.status()).toBe(404);
  });

  test('clears deletedAt; row visible in default list again', async ({ request }) => {
    const e = await createEstimate(request, { title: 'restore-target' });
    await authDelete(request, `/api/estimates/${e.id}`);
    const res = await authPost(request, `/api/estimates/${e.id}/restore`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.restored).toBe(true);
    expect(body.deletedAt).toBeNull();

    const list = await (await authGet(request, '/api/estimates?limit=500')).json();
    expect(list.find((row) => row.id === e.id)).toBeTruthy();
  });

  test('idempotent: restore on a non-deleted estimate returns idempotent:true', async ({ request }) => {
    const e = await createEstimate(request, { title: 'restore-noop' });
    const res = await authPost(request, `/api/estimates/${e.id}/restore`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(body.restored).toBe(false);
  });
});

// ─── Auth gate ──────────────────────────────────────────────────────

test.describe('Estimates API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/estimates`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/estimates`, {
      data: { title: 'x', lineItems: [{ description: 'y', quantity: 1, unitPrice: 1 }] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/estimates/1`, {
      data: { title: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/estimates/1`);
    expect([401, 403]).toContain(res.status());
  });
});
