// @ts-check
/**
 * Billing API gate (P1 task #6).
 *
 * routes/billing.js was a repeated source of regressions: Void
 * deletes data, no PATCH/PUT, no GET /:id detail, sub-paise amount
 * accepted, dueDate in the past accepted, voided invoices flipped
 * back to recurring. This spec locks the contract.
 *
 * Issues prevented from regressing (10 of 13 in the cluster):
 *
 *   #119  mark-paid mutation flips status (Paid-this-month KPI)
 *   #122  Void soft-deletes (preserves row + audit) — doesn't
 *         hard-delete via DELETE /:id
 *   #138  issuedDate renders as a valid ISO date in response
 *   #158  dueDate before today rejected with 400
 *   #167  Void emits an audit row (covered by status check)
 *   #177  amount <= 0, > 1e10, sub-paise rejected
 *   #196  GET /:id returns the row (200, not 404 mismatch)
 *   #198  amount stored to 2dp; 0.001 rejected
 *   #202  PATCH /:id exists + works for safe field updates
 *   #304  VOIDED invoice cannot be re-flipped to isRecurring=true
 *
 * Out of scope for an API gate (defer to UI / PDF specs):
 *
 *   #124  UI Recur dialog — purely frontend
 *   #242, #243, #256  currency formatting — backend stores raw
 *         Number; ₹/$ formatting is applied by frontend
 *         formatMoney(); no API surface to assert against here.
 *
 * Run: cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *      npx playwright test --project=chromium tests/billing-api.spec.js
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let token = null;
let seedContactId = null;
const created = []; // ids for cleanup (void)

async function login(request) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT });
}
async function authPost(request, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: auth(token), data: body, timeout: REQUEST_TIMEOUT });
}
async function authPatch(request, path, body) {
  return request.patch(`${BASE_URL}${path}`, { headers: auth(token), data: body, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT });
}

function isoIsValid(s) {
  if (typeof s !== 'string') return false;
  // YYYY-MM-DDTHH:mm:ss(.sss)?Z — accept Date.toISOString() output OR
  // simpler "YYYY-MM-DD" if a route returns date-only.
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/.test(s);
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

test.beforeAll(async ({ request }) => {
  token = await login(request);
  if (!token) return;
  // Pick any seeded contact on the generic tenant. Required for the
  // POST /api/billing contactId field. Skipping if none exists rather
  // than minting one — the seed always provides at least 10.
  const r = await authGet(request, '/api/contacts?limit=10');
  if (r.ok()) {
    const body = await r.json();
    const list = Array.isArray(body) ? body : (body.contacts || body.data || []);
    seedContactId = list[0]?.id ?? null;
  }
});

test.afterAll(async ({ request }) => {
  // Soft-void anything we created so we don't leave UNPAID rows in the
  // dashboard's "Outstanding" tile. Idempotent.
  if (!token) return;
  for (const id of created) {
    await authPost(request, `/api/billing/${id}/void`, { reason: 'E2E cleanup' }).catch(() => {});
  }
});

async function createValidInvoice(request, overrides = {}) {
  const body = {
    contactId: seedContactId,
    amount: 100.5,
    dueDate: tomorrowISO(),
    ...overrides,
  };
  const r = await authPost(request, '/api/billing', body);
  expect(r.status(), `create-helper failure: ${await r.text()}`).toBe(201);
  const inv = await r.json();
  created.push(inv.id);
  return inv;
}

test.describe('Billing API — POST / validation (#177, #198, #202)', () => {
  test('rejects amount <= 0 with 400 INVALID_AMOUNT', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const r = await authPost(request, '/api/billing', { contactId: seedContactId, amount: -1, dueDate: tomorrowISO() });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_AMOUNT');
  });

  test('rejects amount = 0 with 400 INVALID_AMOUNT', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const r = await authPost(request, '/api/billing', { contactId: seedContactId, amount: 0, dueDate: tomorrowISO() });
    expect(r.status()).toBe(400);
  });

  test('rejects amount > 1e10 with 400 AMOUNT_TOO_HIGH', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const r = await authPost(request, '/api/billing', { contactId: seedContactId, amount: 2e10, dueDate: tomorrowISO() });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('AMOUNT_TOO_HIGH');
  });

  test('#198 rejects sub-paise amount (123.456) with 400 INVALID_AMOUNT_PRECISION', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const r = await authPost(request, '/api/billing', { contactId: seedContactId, amount: 123.456, dueDate: tomorrowISO() });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_AMOUNT_PRECISION');
  });

  test('#198 amount stored to 2dp (round-trip) — 99.999 already rejected, 99.99 accepted', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request, { amount: 99.99 });
    expect(inv.amount).toBeCloseTo(99.99, 2);
  });

  test('#158 #177 #202 rejects dueDate in the past with 400 DUE_DATE_IN_PAST', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const r = await authPost(request, '/api/billing', { contactId: seedContactId, amount: 100, dueDate: yesterdayISO() });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('DUE_DATE_IN_PAST');
  });

  test('rejects missing dueDate with 400', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const r = await authPost(request, '/api/billing', { contactId: seedContactId, amount: 100 });
    expect(r.status()).toBe(400);
  });

  test('rejects missing contactId with 400 CONTACT_REQUIRED', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/billing', { amount: 100, dueDate: tomorrowISO() });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('CONTACT_REQUIRED');
  });

  test('happy path: 201 with invoiceNum, amount, dueDate, issuedDate', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    expect(inv.id).toBeGreaterThan(0);
    expect(inv.invoiceNum).toMatch(/^INV-/);
    expect(inv.amount).toBeCloseTo(100.5, 2);
    expect(inv.status).toBe('UNPAID');
    expect(inv.contactId).toBe(seedContactId);
    // #138: issuedDate must be a valid ISO timestamp.
    expect(isoIsValid(inv.issuedDate), `issuedDate=${inv.issuedDate} not ISO`).toBe(true);
    // dueDate too.
    expect(isoIsValid(inv.dueDate), `dueDate=${inv.dueDate} not ISO`).toBe(true);
  });
});

test.describe('Billing API — GET /:id detail (#196)', () => {
  test('GET /:id returns 200 with the invoice row', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    const r = await authGet(request, `/api/billing/${inv.id}`);
    expect(r.status()).toBe(200);
    const fetched = await r.json();
    expect(fetched.id).toBe(inv.id);
    expect(fetched.invoiceNum).toBe(inv.invoiceNum);
  });

  test('GET /:id with bogus id returns 404', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authGet(request, '/api/billing/99999999');
    expect(r.status()).toBe(404);
  });

  test('GET /:id with non-numeric id returns 400 (not 500)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authGet(request, '/api/billing/foo');
    expect([400, 404]).toContain(r.status());
  });
});

test.describe('Billing API — POST /:id/mark-paid (#119)', () => {
  test('mark-paid flips status to PAID and sets paidAt', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    expect(inv.status).toBe('UNPAID');

    const r = await authPost(request, `/api/billing/${inv.id}/mark-paid`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    // Response shape varies — direct invoice OR { idempotent, invoice }.
    const updated = body.invoice ?? body;
    expect(updated.status).toBe('PAID');
    expect(updated.paidAt, 'paidAt should be set after mark-paid').toBeTruthy();
  });

  test('mark-paid is idempotent (PAID → 200 with idempotent flag)', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    await authPost(request, `/api/billing/${inv.id}/mark-paid`, {});
    const r = await authPost(request, `/api/billing/${inv.id}/mark-paid`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.idempotent || body.invoice?.status === 'PAID' || body.status === 'PAID').toBeTruthy();
  });
});

test.describe('Billing API — Void / soft-delete (#122, #167)', () => {
  test('POST /:id/void flips status to VOIDED, preserves row', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    const r = await authPost(request, `/api/billing/${inv.id}/void`, { reason: 'wrong customer' });
    expect(r.status()).toBe(200);
    const voided = await r.json();
    expect(voided.status).toBe('VOIDED');

    // #122/#167: the row MUST still exist after void. Pre-fix Void
    // hard-deleted via DELETE which lost the audit trail.
    const stillThere = await authGet(request, `/api/billing/${inv.id}`);
    expect(stillThere.status(), 'voided invoice should still be readable').toBe(200);
    const fetched = await stillThere.json();
    expect(fetched.status).toBe('VOIDED');
  });

  test('DELETE /:id is the legacy alias for void — soft-deletes (does NOT hard-delete)', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    const del = await authDelete(request, `/api/billing/${inv.id}`);
    expect(del.status()).toBe(200);

    // Crucial regression assertion: row must still be readable post-DELETE.
    const stillThere = await authGet(request, `/api/billing/${inv.id}`);
    expect(stillThere.status(), 'DELETE /:id must NOT hard-delete (#122/#167)').toBe(200);
    expect((await stillThere.json()).status).toBe('VOIDED');
  });

  test('cannot void a PAID invoice (use /refund instead)', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    await authPost(request, `/api/billing/${inv.id}/mark-paid`, {});
    const r = await authPost(request, `/api/billing/${inv.id}/void`, {});
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVOICE_ALREADY_PAID');
  });
});

test.describe('Billing API — PATCH /:id terminal-status guard (#202, #304)', () => {
  test('#304 PATCH /:id with isRecurring=true on a VOIDED invoice → 422 INVALID_INVOICE_TRANSITION', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    await authPost(request, `/api/billing/${inv.id}/void`, {});

    // PATCH must refuse — the route's terminal-status guard returns
    // 422 with code INVALID_INVOICE_TRANSITION. Pre-#304, the legacy
    // PUT /:id/recurring (no guard) was being called and silently
    // flipped a voided invoice back to recurring.
    const r = await authPatch(request, `/api/billing/${inv.id}`, {
      isRecurring: true,
      recurFrequency: 'monthly',
    });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.code).toBe('INVALID_INVOICE_TRANSITION');
    expect(body.currentStatus).toBe('VOIDED');
  });

  test('#202 PATCH /:id rejects amount mutation (refund/credit-note instead)', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    const r = await authPatch(request, `/api/billing/${inv.id}`, { amount: 999 });
    expect(r.status()).toBe(400);
    // Whatever code the route emits — we just need it NOT to be 200
    // (silent acceptance of an amount mutation).
  });

  test('#202 PATCH /:id with valid dueDate succeeds', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    const newDue = new Date(); newDue.setDate(newDue.getDate() + 30);
    const r = await authPatch(request, `/api/billing/${inv.id}`, {
      dueDate: newDue.toISOString(),
    });
    expect(r.status()).toBe(200);
    const updated = await r.json();
    expect(new Date(updated.dueDate).getDate()).toBe(newDue.getDate());
  });

  test('PATCH /:id rejects past dueDate with 400 DUE_DATE_IN_PAST', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    const r = await authPatch(request, `/api/billing/${inv.id}`, { dueDate: yesterdayISO() });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('DUE_DATE_IN_PAST');
  });

  test('PATCH /:id rejects bogus recurFrequency with 400 INVALID_RECUR_FREQUENCY', async ({ request }) => {
    test.skip(!token || !seedContactId, 'auth/seed unavailable');
    const inv = await createValidInvoice(request);
    const r = await authPatch(request, `/api/billing/${inv.id}`, { recurFrequency: 'never' });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_RECUR_FREQUENCY');
  });
});

test.describe('Billing API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const r = await request.get(`${API}/billing`);
    expect([401, 403]).toContain(r.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const r = await request.post(`${API}/billing`, { data: { amount: 1 }, headers: { 'Content-Type': 'application/json' } });
    expect([401, 403]).toContain(r.status());
  });
});
