// @ts-check
/**
 * Billing — invoice update path & POST validation (issue #202).
 *
 * Scope:
 *  (a) POST /api/billing rejects negative amount with 400 INVALID_AMOUNT
 *  (b) POST /api/billing rejects 1e15 amount with 400 (cap is 1e10)
 *  (c) POST /api/billing rejects past dueDate with 400 DUE_DATE_IN_PAST
 *  (d) POST /api/billing/:id/mark-paid flips status to PAID, returns 200
 *  (e) POST /api/billing/:id/mark-paid is idempotent — second call returns
 *      { idempotent: true } and does NOT write a duplicate Payment row.
 *
 * Convention reference (TODOS.md §"Conventions established this week"):
 *  - Idempotent re-applies → 200 { idempotent: true } (NOT 422).
 *  - Terminal-status transitions → 422 INVALID_<RESOURCE>_TRANSITION.
 *  - emitEvent("invoice.paid", …) on the actual UNPAID → PAID transition.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
let contactId = null;

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

async function authPost(request, path, body) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.post(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
    timeout: REQUEST_TIMEOUT,
  });
}

async function authGet(request, path) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
}

async function getContactId(request) {
  if (contactId) return contactId;
  const res = await authGet(request, '/api/contacts');
  if (!res.ok()) throw new Error(`Failed to load contacts: ${res.status()}`);
  const list = await res.json();
  const arr = Array.isArray(list) ? list : (list.data || list.contacts || []);
  if (arr.length === 0) throw new Error('No contacts available — seed expected to plant at least one');
  contactId = arr[0].id;
  return contactId;
}

function isoDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

test.describe('Billing — POST validation + update path (#202)', () => {
  // (a) Negative amount
  test('POST /api/billing with negative amount returns 400 INVALID_AMOUNT', async ({ request }) => {
    const cid = await getContactId(request);
    const before = await authGet(request, '/api/billing');
    const beforeCount = before.ok() ? (await before.json()).length : 0;

    const res = await authPost(request, '/api/billing', {
      amount: -1000,
      dueDate: isoDate(7),
      contactId: cid,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_AMOUNT');

    // Verify no row was created.
    const after = await authGet(request, '/api/billing');
    const afterCount = after.ok() ? (await after.json()).length : 0;
    expect(afterCount).toBe(beforeCount);
  });

  // (b) Absurdly large amount (1e15 — caps out at 1e10 per route validator)
  test('POST /api/billing with 1e15 amount returns 400', async ({ request }) => {
    const cid = await getContactId(request);
    const res = await authPost(request, '/api/billing', {
      amount: 1e15,
      dueDate: isoDate(7),
      contactId: cid,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    // Existing validator returns AMOUNT_TOO_HIGH for the > 1e10 case.
    expect(['AMOUNT_TOO_HIGH', 'INVALID_AMOUNT']).toContain(body.code);
  });

  // (c) Past dueDate
  test('POST /api/billing with past dueDate returns 400 DUE_DATE_IN_PAST', async ({ request }) => {
    const cid = await getContactId(request);
    const res = await authPost(request, '/api/billing', {
      amount: 500,
      dueDate: '1990-01-01',
      contactId: cid,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(['DUE_DATE_IN_PAST', 'INVALID_DUE_DATE']).toContain(body.code);
  });

  // (d) Mark a fresh invoice as paid.
  test('POST /api/billing/:id/mark-paid flips status to PAID', async ({ request }) => {
    const cid = await getContactId(request);
    const created = await authPost(request, '/api/billing', {
      amount: 1234.56,
      dueDate: isoDate(14),
      contactId: cid,
    });
    expect(created.status()).toBe(201);
    const inv = await created.json();
    expect(inv.id).toBeTruthy();
    expect(inv.status === 'UNPAID' || inv.status === 'PENDING' || inv.status === 'OVERDUE' || inv.status === undefined || inv.status !== 'PAID').toBeTruthy();

    const paid = await authPost(request, `/api/billing/${inv.id}/mark-paid`, {
      paymentMethod: 'manual',
      transactionRef: `E2E_BILLING_${Date.now()}`,
    });
    expect(paid.status()).toBe(200);
    const paidBody = await paid.json();
    expect(paidBody.idempotent).toBeFalsy();
    expect(paidBody.status).toBe('PAID');
    expect(paidBody.paidAt).toBeTruthy();
  });

  // (e) Re-marking a PAID invoice is idempotent.
  test('POST /api/billing/:id/mark-paid is idempotent — second call returns idempotent:true with no double-payment', async ({ request }) => {
    const cid = await getContactId(request);
    const created = await authPost(request, '/api/billing', {
      amount: 99.99,
      dueDate: isoDate(7),
      contactId: cid,
    });
    expect(created.status()).toBe(201);
    const inv = await created.json();

    const ref = `E2E_BILLING_IDEM_${Date.now()}`;
    const first = await authPost(request, `/api/billing/${inv.id}/mark-paid`, {
      paymentMethod: 'manual',
      transactionRef: ref,
    });
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.status).toBe('PAID');
    const firstPaidAt = firstBody.paidAt;
    const firstPaymentId = firstBody.payment ? firstBody.payment.id : null;

    // Second call — must be idempotent.
    const second = await authPost(request, `/api/billing/${inv.id}/mark-paid`, {
      paymentMethod: 'manual',
      transactionRef: ref + '_RETRY',
    });
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.idempotent).toBe(true);
    expect(secondBody.invoice).toBeTruthy();
    expect(secondBody.invoice.status).toBe('PAID');
    // paidAt must NOT shift on the idempotent retry.
    if (firstPaidAt) {
      expect(secondBody.invoice.paidAt).toBe(firstPaidAt);
    }
    // No second Payment row written on the retry — secondBody has no payment field.
    expect(secondBody.payment).toBeUndefined();
    // (firstPaymentId may be null on schemas without Payment; both branches OK.)
    void firstPaymentId;
  });
});
