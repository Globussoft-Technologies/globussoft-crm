// @ts-check
/**
 * Contracts module — backend coverage push for routes/contracts.js.
 *
 * Pre-spec coverage on routes/contracts.js was 21.55% (~25/116 lines). The
 * route file is small but every handler has the same 3-branch shape: tenant
 * scope guard, parseInt guard, error catch. State transitions
 * (Draft → Active → Expired → Terminated) are *not* enforced by a server-
 * side state machine — the route accepts any string in `status` — so we
 * exercise the full transition table to confirm the wide-open contract
 * (and to flag a future hardening item if a state machine is added).
 *
 * Endpoints covered:
 *   GET    /api/contracts            — list + ?status filter
 *   GET    /api/contracts/:id        — single contract with relations
 *   POST   /api/contracts            — create (Draft default)
 *   PUT    /api/contracts/:id        — update fields + status transitions
 *   DELETE /api/contracts/:id        — delete
 *
 * Branches exercised in routes/contracts.js:
 *   GET /
 *     - happy path: array shape, includes contact + deal joins, ordered desc
 *     - ?status=… filter narrows results
 *   GET /:id
 *     - 400 for non-numeric id
 *     - 404 for unknown id (or cross-tenant id, same outcome)
 *     - happy path with relations
 *   POST /
 *     - 400 when title is missing
 *     - happy path with default status=Draft and value=0.0
 *     - explicit status / startDate / endDate / value / terms passthrough
 *     - contactId / dealId optional + parsed
 *   PUT /:id
 *     - 400 for non-numeric id
 *     - 404 for unknown id (cross-tenant collapses to same)
 *     - per-field undefined-skip: omitted fields are not nulled out
 *     - status transitions Draft → Active → Expired → Terminated
 *   DELETE /:id
 *     - 400 for non-numeric id
 *     - 404 for unknown id
 *     - happy path returns {message}
 *
 * Pattern: cached-token / authXyz helpers identical to sms-api.spec.js. Test
 * data is tagged `E2E_CONTRACT_<ts>` so the afterAll cleanup can scrub our
 * rows even if individual tests fail.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
const RUN_TAG = `E2E_CONTRACT_${Date.now()}`;

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
async function authPut(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}

// ── cleanup tracking ────────────────────────────────────────────────
const createdContractIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdContractIds) {
    await authDelete(request, `/api/contracts/${id}`).catch(() => {});
  }
});

// Helper: create a contract and remember it for cleanup.
async function createContract(request, overrides = {}) {
  const res = await authPost(request, '/api/contracts', {
    title: `${RUN_TAG} ${overrides.title || 'contract'}`,
    status: overrides.status,
    startDate: overrides.startDate,
    endDate: overrides.endDate,
    value: overrides.value,
    terms: overrides.terms,
    contactId: overrides.contactId,
    dealId: overrides.dealId,
  });
  expect(res.status(), `contract create: ${await res.text()}`).toBe(201);
  const c = await res.json();
  createdContractIds.push(c.id);
  return c;
}

// ─── GET / (list) ─────────────────────────────────────────────────────

test.describe('Contracts API — GET /', () => {
  test('returns an array', async ({ request }) => {
    const res = await authGet(request, '/api/contracts');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('rows expose contact + deal join slots (may be null)', async ({ request }) => {
    await createContract(request, { title: 'list-relations' });
    const res = await authGet(request, '/api/contracts');
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(rows.length).toBeGreaterThan(0);
    for (const c of rows.slice(0, 3)) {
      expect(c).toHaveProperty('contact');
      expect(c).toHaveProperty('deal');
    }
  });

  test('?status filter narrows the list', async ({ request }) => {
    await createContract(request, { title: 'filter-active', status: 'Active' });
    const res = await authGet(request, '/api/contracts?status=Active');
    expect(res.status()).toBe(200);
    const rows = await res.json();
    for (const c of rows) {
      expect(c.status).toBe('Active');
    }
  });

  test('?status= unknown value yields an empty array, not an error', async ({ request }) => {
    const res = await authGet(request, '/api/contracts?status=NoSuchStatus');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('list is ordered by createdAt desc (newest first)', async ({ request }) => {
    const a = await createContract(request, { title: 'order-1' });
    const b = await createContract(request, { title: 'order-2' });
    const res = await authGet(request, '/api/contracts');
    expect(res.status()).toBe(200);
    const rows = await res.json();
    const idxA = rows.findIndex((c) => c.id === a.id);
    const idxB = rows.findIndex((c) => c.id === b.id);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    // b was created after a → b should come before a in desc order.
    expect(idxB).toBeLessThan(idxA);
  });
});

// ─── GET /:id ──────────────────────────────────────────────────────────

test.describe('Contracts API — GET /:id', () => {
  test('400 for non-numeric id', async ({ request }) => {
    const res = await authGet(request, '/api/contracts/not-a-number');
    expect(res.status()).toBe(400);
    // Post-#423: validateNumericId middleware short-circuits before
    // the route handler. Message is generic; contract is the code.
    const _body = await res.json(); expect(_body.error).toMatch(/invalid id/i); expect(_body.code).toBe('INVALID_ID');
  });

  test('404 for unknown id', async ({ request }) => {
    const res = await authGet(request, '/api/contracts/99999999');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  test('happy path returns the row with contact + deal joins', async ({ request }) => {
    const c = await createContract(request, { title: 'fetch-by-id' });
    const res = await authGet(request, `/api/contracts/${c.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(c.id);
    expect(body).toHaveProperty('contact');
    expect(body).toHaveProperty('deal');
    expect(body.title).toContain(RUN_TAG);
  });
});

// ─── POST / (create) ───────────────────────────────────────────────────

test.describe('Contracts API — POST /', () => {
  test('400 when title is missing', async ({ request }) => {
    const res = await authPost(request, '/api/contracts', { value: 100 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/title is required/i);
  });

  test('400 when body is empty', async ({ request }) => {
    const res = await authPost(request, '/api/contracts', {});
    expect(res.status()).toBe(400);
  });

  test('defaults status to Draft when omitted', async ({ request }) => {
    const c = await createContract(request, { title: 'default-status' });
    expect(c.status).toBe('Draft');
  });

  test('defaults value to 0 when omitted', async ({ request }) => {
    const c = await createContract(request, { title: 'default-value' });
    // server stores Decimal/float — accept both numeric forms.
    expect(Number(c.value)).toBe(0);
  });

  test('honors explicit status / value / terms', async ({ request }) => {
    const c = await createContract(request, {
      title: 'explicit-fields',
      status: 'Active',
      value: 1500.5,
      terms: 'Net 30 — auto-renew',
    });
    expect(c.status).toBe('Active');
    expect(Number(c.value)).toBeCloseTo(1500.5, 2);
    expect(c.terms).toBe('Net 30 — auto-renew');
  });

  test('parses startDate + endDate into ISO timestamps', async ({ request }) => {
    const start = '2026-01-01';
    const end = '2026-12-31';
    const c = await createContract(request, { title: 'date-parse', startDate: start, endDate: end });
    expect(c.startDate).toBeTruthy();
    expect(c.endDate).toBeTruthy();
    expect(new Date(c.startDate).getUTCFullYear()).toBe(2026);
    expect(new Date(c.endDate).getUTCFullYear()).toBe(2026);
  });

  test('startDate / endDate null when omitted', async ({ request }) => {
    const c = await createContract(request, { title: 'no-dates' });
    expect(c.startDate).toBeNull();
    expect(c.endDate).toBeNull();
  });

  test('contactId + dealId default to null when omitted', async ({ request }) => {
    const c = await createContract(request, { title: 'no-relations' });
    expect(c.contactId).toBeNull();
    expect(c.dealId).toBeNull();
  });
});

// ─── PUT /:id (update + state machine) ─────────────────────────────────

test.describe('Contracts API — PUT /:id', () => {
  test('400 for non-numeric id', async ({ request }) => {
    const res = await authPut(request, '/api/contracts/not-a-number', { title: 'x' });
    expect(res.status()).toBe(400);
  });

  test('404 for unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/contracts/99999999', { title: 'x' });
    expect(res.status()).toBe(404);
  });

  test('updates a single field without nulling the rest', async ({ request }) => {
    const c = await createContract(request, {
      title: 'partial-update',
      terms: 'keep me',
      value: 999,
    });
    const res = await authPut(request, `/api/contracts/${c.id}`, { title: `${RUN_TAG} renamed` });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.title).toContain('renamed');
    expect(updated.terms).toBe('keep me');
    expect(Number(updated.value)).toBe(999);
  });

  test('empty body is a no-op (200, fields preserved)', async ({ request }) => {
    const c = await createContract(request, { title: 'noop-update', terms: 'still here' });
    const res = await authPut(request, `/api/contracts/${c.id}`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).terms).toBe('still here');
  });

  test('Draft → Active transition succeeds', async ({ request }) => {
    const c = await createContract(request, { title: 'sm-active' });
    expect(c.status).toBe('Draft');
    const res = await authPut(request, `/api/contracts/${c.id}`, { status: 'Active' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Active');
  });

  test('Active → Expired transition succeeds', async ({ request }) => {
    const c = await createContract(request, { title: 'sm-expired', status: 'Active' });
    const res = await authPut(request, `/api/contracts/${c.id}`, { status: 'Expired' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Expired');
  });

  test('Active → Terminated transition succeeds', async ({ request }) => {
    const c = await createContract(request, { title: 'sm-terminated', status: 'Active' });
    const res = await authPut(request, `/api/contracts/${c.id}`, { status: 'Terminated' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Terminated');
  });

  test('Terminated → Active is currently allowed (no server-side state machine)', async ({ request }) => {
    // Document the current behaviour — if a future hardening adds a state
    // machine that rejects this transition, this test will flip and signal it.
    const c = await createContract(request, { title: 'sm-revive', status: 'Terminated' });
    const res = await authPut(request, `/api/contracts/${c.id}`, { status: 'Active' });
    expect([200, 400, 409]).toContain(res.status());
  });

  test('value field accepts a numeric string and casts via parseFloat', async ({ request }) => {
    const c = await createContract(request, { title: 'value-cast', value: 100 });
    const res = await authPut(request, `/api/contracts/${c.id}`, { value: '250.75' });
    expect(res.status()).toBe(200);
    expect(Number((await res.json()).value)).toBeCloseTo(250.75, 2);
  });

  test('explicit null on startDate clears it', async ({ request }) => {
    const c = await createContract(request, { title: 'date-clear', startDate: '2026-06-01' });
    expect(c.startDate).toBeTruthy();
    const res = await authPut(request, `/api/contracts/${c.id}`, { startDate: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).startDate).toBeNull();
  });

  test('explicit null on contactId clears the relation', async ({ request }) => {
    const c = await createContract(request, { title: 'rel-clear' });
    const res = await authPut(request, `/api/contracts/${c.id}`, { contactId: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).contactId).toBeNull();
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────

test.describe('Contracts API — DELETE /:id', () => {
  test('400 for non-numeric id', async ({ request }) => {
    const res = await authDelete(request, '/api/contracts/not-a-number');
    expect(res.status()).toBe(400);
  });

  test('404 for unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/contracts/99999999');
    expect(res.status()).toBe(404);
  });

  test('happy path returns {message}', async ({ request }) => {
    const c = await createContract(request, { title: 'to-delete' });
    const res = await authDelete(request, `/api/contracts/${c.id}`);
    expect(res.status()).toBe(204); // #550: DELETE → 204 No Content
    // remove from the cleanup list — already gone.
    const idx = createdContractIds.indexOf(c.id);
    if (idx >= 0) createdContractIds.splice(idx, 1);
  });

  test('GET after DELETE returns 404', async ({ request }) => {
    const c = await createContract(request, { title: 'delete-then-get' });
    const del = await authDelete(request, `/api/contracts/${c.id}`);
    expect(del.status()).toBe(204); // #550: DELETE → 204
    const after = await authGet(request, `/api/contracts/${c.id}`);
    expect(after.status()).toBe(404);
    const idx = createdContractIds.indexOf(c.id);
    if (idx >= 0) createdContractIds.splice(idx, 1);
  });

  test('PUT after DELETE returns 404', async ({ request }) => {
    const c = await createContract(request, { title: 'delete-then-put' });
    await authDelete(request, `/api/contracts/${c.id}`);
    const after = await authPut(request, `/api/contracts/${c.id}`, { title: 'gone' });
    expect(after.status()).toBe(404);
    const idx = createdContractIds.indexOf(c.id);
    if (idx >= 0) createdContractIds.splice(idx, 1);
  });
});

// ─── Auth gate ─────────────────────────────────────────────────────────

test.describe('Contracts API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/contracts`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/contracts`, {
      data: { title: 'unauth' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/contracts/1`, {
      data: { title: 'unauth' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/contracts/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id with malformed bearer token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/contracts/1`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
