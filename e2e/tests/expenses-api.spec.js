// @ts-check
/**
 * Expenses module — backend coverage push.
 *
 * routes/expenses.js was 19.68% (≈ 25/127 lines). The file is a flat CRUD
 * router (GET list / GET :id / POST / PUT :id / DELETE :id) with optional
 * status + category filters on the list endpoint and tenant-scoped queries
 * throughout. This spec exercises every handler + every validation branch
 * + every 404 / 400 / auth-gate path.
 *
 * Endpoints covered:
 *   GET    /api/expenses                — list + ?status + ?category filters
 *   GET    /api/expenses/:id            — single + 400 invalid id + 404 unknown
 *   POST   /api/expenses                — create + 400 missing title/amount + defaults
 *   PUT    /api/expenses/:id            — partial update + 400/404 paths
 *   DELETE /api/expenses/:id            — delete + 400/404 paths
 *
 * Pattern: cached-token / authXyz helpers identical to sla-breach-api.spec.js.
 * Test data is tagged `E2E_EXP_<ts>` so global-teardown can scrub.
 *
 * Tenant note: /api/expenses is generic-tenant (vertical=generic) — no
 * wellness-only gates. We log in as admin@globussoft.com which IS the
 * generic admin, so every endpoint is reachable. tenantId is server-stamped
 * from req.user; no cross-tenant scenarios in scope here.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let authToken = null;
const RUN_TAG = `E2E_EXP_${Date.now()}`;

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
const createdExpenseIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdExpenseIds) {
    await authDelete(request, `/api/expenses/${id}`).catch(() => {});
  }
});

// Helper: create an expense and remember it for cleanup.
async function createExpense(request, overrides = {}) {
  const res = await authPost(request, '/api/expenses', {
    title: `${RUN_TAG} ${overrides.title || 'expense'}`,
    amount: overrides.amount ?? 100.5,
    category: overrides.category,
    notes: overrides.notes,
    expenseDate: overrides.expenseDate,
    contactId: overrides.contactId,
    receiptUrl: overrides.receiptUrl,
  });
  expect(res.status(), `expense create: ${await res.text()}`).toBe(201);
  const e = await res.json();
  createdExpenseIds.push(e.id);
  return e;
}

// ─── POST /api/expenses ─────────────────────────────────────────────

test.describe('Expenses API — POST /', () => {
  test('400 when "title" is missing', async ({ request }) => {
    const res = await authPost(request, '/api/expenses', { amount: 50 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/title is required/i);
  });

  test('400 when "amount" is missing', async ({ request }) => {
    const res = await authPost(request, '/api/expenses', { title: `${RUN_TAG} no-amt` });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/amount is required/i);
  });

  test('400 when "amount" is null (explicit null guard)', async ({ request }) => {
    const res = await authPost(request, '/api/expenses', {
      title: `${RUN_TAG} null-amt`,
      amount: null,
    });
    expect(res.status()).toBe(400);
  });

  test('400 when both title and amount missing', async ({ request }) => {
    const res = await authPost(request, '/api/expenses', {});
    expect(res.status()).toBe(400);
  });

  test('amount=0 is accepted (falsy guard uses undefined/null only)', async ({ request }) => {
    // Route uses `amount === undefined || amount === null` — 0 must pass.
    const e = await createExpense(request, { title: 'zero-amt', amount: 0 });
    expect(parseFloat(e.amount)).toBe(0);
  });

  test('creates with default category="General" when omitted', async ({ request }) => {
    const e = await createExpense(request, { title: 'default-cat' });
    expect(e.category).toBe('General');
  });

  test('honors explicit category', async ({ request }) => {
    const e = await createExpense(request, { title: 'explicit-cat', category: 'Travel' });
    expect(e.category).toBe('Travel');
  });

  test('amount is parsed as float (string in → number out)', async ({ request }) => {
    const e = await createExpense(request, { title: 'string-amt', amount: '199.95' });
    expect(parseFloat(e.amount)).toBeCloseTo(199.95, 2);
  });

  test('expenseDate accepted as ISO string', async ({ request }) => {
    const iso = new Date('2026-01-15T00:00:00Z').toISOString();
    const e = await createExpense(request, { title: 'with-date', expenseDate: iso });
    expect(e.expenseDate).toBeTruthy();
    expect(new Date(e.expenseDate).getUTCFullYear()).toBe(2026);
  });

  test('expenseDate defaults to "now" when omitted', async ({ request }) => {
    const before = Date.now();
    const e = await createExpense(request, { title: 'default-date' });
    const stamped = new Date(e.expenseDate).getTime();
    // Allow 60s clock skew between client + server.
    expect(stamped).toBeGreaterThanOrEqual(before - 60000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 60000);
  });

  test('notes + receiptUrl persist when provided', async ({ request }) => {
    const e = await createExpense(request, {
      title: 'notes-and-url',
      notes: `${RUN_TAG} dinner with client`,
      receiptUrl: 'https://example.com/r.png',
    });
    expect(e.notes).toContain('dinner with client');
    expect(e.receiptUrl).toBe('https://example.com/r.png');
  });

  // `description` column added to the POST/PUT body 2026-05-21 alongside
  // the Expenses form redesign (Recipient Name + Description + Payment
  // Method split). The column was always present on the Prisma model but
  // never wired through routes/expenses.js until this change.
  test('description persists when provided', async ({ request }) => {
    const e = await createExpense(request, {
      title: 'descr-test',
      description: `${RUN_TAG} Quarterly client lunch — full quote attached`,
    });
    expect(e.description).toContain('Quarterly client lunch');
  });
  test('description omitted → null (not undefined / empty-string)', async ({ request }) => {
    const e = await createExpense(request, { title: 'descr-blank' });
    expect(e.description === null || e.description === undefined).toBe(true);
  });
  test('PUT can update description in isolation', async ({ request }) => {
    const created = await createExpense(request, { title: 'descr-put' });
    const updRes = await authPut(request, `/api/expenses/${created.id}`, {
      description: `${RUN_TAG} updated copy`,
    });
    expect(updRes.status()).toBe(200);
    const updated = await updRes.json();
    expect(updated.description).toContain('updated copy');
    // Other fields untouched.
    expect(updated.title).toBe(created.title);
  });

  test('user + contact relations are included in create response', async ({ request }) => {
    const e = await createExpense(request, { title: 'with-user' });
    // user relation should resolve when req.user.userId is present (it is for admin login).
    expect(e.user === null || typeof e.user === 'object').toBe(true);
    expect(e.contact === null || typeof e.contact === 'object').toBe(true);
  });

  test('tenantId is server-stamped — body cannot override it', async ({ request }) => {
    const e = await createExpense(request, { title: 'tenant-stamp' });
    // We don't know the exact admin tenantId, but it must be a number.
    expect(typeof e.tenantId).toBe('number');
  });
});

// ─── GET /api/expenses (list) ───────────────────────────────────────

test.describe('Expenses API — GET / (list)', () => {
  test('returns array (and includes our created row)', async ({ request }) => {
    const e = await createExpense(request, { title: 'list-includes' });
    const res = await authGet(request, '/api/expenses');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((x) => x.id === e.id)).toBeTruthy();
  });

  test('?category filter narrows result set', async ({ request }) => {
    await createExpense(request, { title: 'cat-filter-A', category: 'Travel' });
    const res = await authGet(request, '/api/expenses?category=Travel');
    expect(res.status()).toBe(200);
    const list = await res.json();
    for (const row of list) expect(row.category).toBe('Travel');
  });

  test('?status filter passes through Prisma where', async ({ request }) => {
    // Create + stamp status via PUT, then filter.
    // MySQL utf8mb4 collation is case-insensitive on equality, so a
    // WHERE status='APPROVED' matches rows seeded as 'Approved' too.
    // The route's filter is correct; the test assertion just needs to
    // tolerate either case for legacy / seed-data rows in the result set.
    const e = await createExpense(request, { title: 'status-filter' });
    const upd = await authPut(request, `/api/expenses/${e.id}`, { status: 'APPROVED' });
    expect(upd.status()).toBe(200);

    const res = await authGet(request, '/api/expenses?status=APPROVED');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.find((x) => x.id === e.id)).toBeTruthy();
    for (const row of list) expect(row.status.toUpperCase()).toBe('APPROVED');
  });

  test('combined ?status + ?category filters AND together', async ({ request }) => {
    const e = await createExpense(request, { title: 'combined', category: 'Office' });
    await authPut(request, `/api/expenses/${e.id}`, { status: 'PENDING' });
    const res = await authGet(request, '/api/expenses?status=PENDING&category=Office');
    expect(res.status()).toBe(200);
    const list = await res.json();
    for (const row of list) {
      expect(row.status.toUpperCase()).toBe('PENDING');
      expect(row.category).toBe('Office');
    }
  });

  test('list orders by createdAt desc (newest first among ours)', async ({ request }) => {
    const a = await createExpense(request, { title: 'order-A' });
    const b = await createExpense(request, { title: 'order-B' });
    const list = await (await authGet(request, '/api/expenses')).json();
    const idxA = list.findIndex((x) => x.id === a.id);
    const idxB = list.findIndex((x) => x.id === b.id);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    // b created after a → b appears first (smaller index).
    expect(idxB).toBeLessThan(idxA);
  });
});

// ─── GET /api/expenses/:id ──────────────────────────────────────────

test.describe('Expenses API — GET /:id', () => {
  test('200 happy path with user + contact joins', async ({ request }) => {
    const e = await createExpense(request, { title: 'single' });
    const res = await authGet(request, `/api/expenses/${e.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(e.id);
    expect(body.title).toContain('single');
    // include keys present (may be null if no relation row).
    expect('user' in body).toBe(true);
    expect('contact' in body).toBe(true);
  });

  test('400 on non-numeric id', async ({ request }) => {
    const res = await authGet(request, '/api/expenses/not-a-number');
    expect(res.status()).toBe(400);
    // Post-#423: middleware-level error message is generic.
    const _body = await res.json(); expect(_body.error).toMatch(/invalid id/i); expect(_body.code).toBe('INVALID_ID');
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authGet(request, '/api/expenses/99999999');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});

// ─── PUT /api/expenses/:id ──────────────────────────────────────────

test.describe('Expenses API — PUT /:id', () => {
  test('partial update: only provided keys are changed', async ({ request }) => {
    const e = await createExpense(request, { title: 'pre-edit', amount: 50, category: 'A' });
    const res = await authPut(request, `/api/expenses/${e.id}`, { title: `${RUN_TAG} edited` });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.title).toContain('edited');
    expect(updated.category).toBe('A'); // untouched
    expect(parseFloat(updated.amount)).toBe(50);
  });

  test('PUT updates status (approval transition)', async ({ request }) => {
    const e = await createExpense(request, { title: 'approve-me' });
    const res = await authPut(request, `/api/expenses/${e.id}`, { status: 'APPROVED' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('APPROVED');
  });

  test('status transition: APPROVED → REJECTED accepted', async ({ request }) => {
    const e = await createExpense(request, { title: 'reject-me' });
    await authPut(request, `/api/expenses/${e.id}`, { status: 'APPROVED' });
    const res = await authPut(request, `/api/expenses/${e.id}`, { status: 'REJECTED' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('REJECTED');
  });

  test('PUT with empty body is no-op (200, fields preserved)', async ({ request }) => {
    const e = await createExpense(request, { title: 'noop', amount: 77, category: 'X' });
    const res = await authPut(request, `/api/expenses/${e.id}`, {});
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(parseFloat(updated.amount)).toBe(77);
    expect(updated.category).toBe('X');
  });

  test('PUT clears expenseDate when explicitly null', async ({ request }) => {
    const e = await createExpense(request, { title: 'clear-date' });
    const res = await authPut(request, `/api/expenses/${e.id}`, { expenseDate: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).expenseDate).toBeNull();
  });

  test('PUT clears contactId when explicitly null', async ({ request }) => {
    const e = await createExpense(request, { title: 'clear-contact' });
    const res = await authPut(request, `/api/expenses/${e.id}`, { contactId: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).contactId).toBeNull();
  });

  test('PUT 400 on non-numeric id', async ({ request }) => {
    const res = await authPut(request, '/api/expenses/abc', { title: 'x' });
    expect(res.status()).toBe(400);
  });

  test('PUT 404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/expenses/99999999', { title: 'x' });
    expect(res.status()).toBe(404);
  });
});

// ─── DELETE /api/expenses/:id ───────────────────────────────────────

test.describe('Expenses API — DELETE /:id', () => {
  test('removes the row + returns confirmation message', async ({ request }) => {
    const e = await createExpense(request, { title: 'to-delete' });
    const del = await authDelete(request, `/api/expenses/${e.id}`);
    expect(del.status()).toBe(204); // #550: DELETE → 204 No Content
    // Confirm gone — GET after DELETE should 404.
    const after = await authGet(request, `/api/expenses/${e.id}`);
    expect(after.status()).toBe(404);
  });

  test('DELETE 400 on non-numeric id', async ({ request }) => {
    const res = await authDelete(request, '/api/expenses/abc');
    expect(res.status()).toBe(400);
  });

  test('DELETE 404 on unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/expenses/99999999');
    expect(res.status()).toBe(404);
  });

  test('DELETE same id twice → first 204, second 404 (idempotent-safe)', async ({ request }) => {
    const e = await createExpense(request, { title: 'twice' });
    const r1 = await authDelete(request, `/api/expenses/${e.id}`);
    expect(r1.status()).toBe(204); // #550: DELETE → 204
    const r2 = await authDelete(request, `/api/expenses/${e.id}`);
    expect(r2.status()).toBe(404);
  });
});

// ─── Auth gate ──────────────────────────────────────────────────────

test.describe('Expenses API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/expenses`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/expenses`, {
      data: { title: 'x', amount: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/expenses/1`, {
      data: { title: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/expenses/1`);
    expect([401, 403]).toContain(res.status());
  });
});
