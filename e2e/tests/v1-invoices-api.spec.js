// @ts-check
/**
 * /api/v1/invoices — Wave 7C alias surface (PRD Gap §2 items 7a-d + 8).
 *
 * Target: backend/routes/v1_invoices.js (mounted at /api/v1/invoices). Pins
 * the alias-equals-billing contract for the four mapped paths plus the new
 * POST /:id/payments + POST /:id/complete endpoints.
 *
 * Contracts pinned:
 *   • GET    /api/v1/invoices/:id    behaves identically to /api/billing/:id
 *   • POST   /api/v1/invoices         creates an invoice (delegates to billing.js)
 *   • PATCH  /api/v1/invoices/:id     updates dueDate (delegates)
 *   • POST   /api/v1/invoices/:id/complete is a /mark-paid alias (200 +
 *       invoice.status=PAID)
 *   • POST   /api/v1/invoices/:id/payments
 *       - 400 INVALID_AMOUNT when amount<=0
 *       - 400 METHOD_REQUIRED when method missing
 *       - 404 when invoice id unknown
 *       - 409 INVOICE_VOIDED when invoice already voided
 *       - 201 with { payment, invoice, totalPaid, fullyPaid:false } on partial
 *       - 201 with fullyPaid:true + invoice.status=PAID on a tender that
 *         reaches grand_total ±0.01 (auto-flip)
 *
 * Why: PRD Gap §2 items 7a-d want the `/api/v1/invoices` namespace as the
 * stable public-API surface; item 8 wants `sum(payments) == grand_total ±0.01`
 * to auto-flip status. Both need pinning so future shape changes don't
 * silently regress.
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/v1-invoices-api.spec.js
 *   - Login: admin@globussoft.com (ADMIN, generic tenant — invoices live in
 *     both verticals; using generic to keep this spec orthogonal to the
 *     wellness-specific coupon/wallet surfaces).
 *
 * Cleanup: invoices + payments are financial records-of-record (Restrict on
 * tenant cascade); rows are tagged via `RUN_TAG`-prefixed contact emails so
 * the broader teardown sweep can pick them up.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_V1INV_${Date.now()}`;

let adminToken = null;
let createdContactId = null;
let createdInvoiceId = null;
let voidedInvoiceId = null;
let secondInvoiceId = null;

async function login(request) {
  if (adminToken) return adminToken;
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  const body = await r.json();
  adminToken = body.token;
  return adminToken;
}

const authHdr = async (request) => ({
  Authorization: `Bearer ${await login(request)}`,
  'Content-Type': 'application/json',
});

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: await authHdr(request),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPatch(request, path, body) {
  return request.patch(`${BASE_URL}${path}`, {
    headers: await authHdr(request),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

test.beforeAll(async ({ request }) => {
  const token = await login(request);
  test.skip(!token, 'admin login failed — skipping v1-invoices spec.');

  // Need a contact to attach the invoice to.
  const contactRes = await authPost(request, '/api/contacts', {
    name: `${RUN_TAG} Patron`,
    email: `${RUN_TAG.toLowerCase()}@example.com`,
    phone: '+15555550100',
  });
  if (contactRes.status() === 201) {
    const c = await contactRes.json();
    createdContactId = c.id;
  } else {
    // Some seed paths return 200 — accept both.
    const c = await contactRes.json();
    createdContactId = c?.id || null;
  }
  test.skip(!createdContactId, 'failed to seed contact — cannot exercise v1 invoices.');
});

// ── Alias contract: /api/v1/invoices ↔ /api/billing parity ────────────

test.describe('v1 invoices — alias parity', () => {
  test('POST /api/v1/invoices creates an invoice (delegates to billing)', async ({ request }) => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await authPost(request, '/api/v1/invoices', {
      amount: 500,
      dueDate: tomorrow,
      contactId: createdContactId,
    });
    expect(res.status(), `create v1 invoice: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.amount).toBe(500);
    expect(body.contactId).toBe(createdContactId);
    expect(body.invoiceNum).toMatch(/^INV-/);
    createdInvoiceId = body.id;
  });

  test('GET /api/v1/invoices/:id returns the same shape as /api/billing/:id', async ({ request }) => {
    const v1Res = await authGet(request, `/api/v1/invoices/${createdInvoiceId}`);
    expect(v1Res.status()).toBe(200);
    const billingRes = await authGet(request, `/api/billing/${createdInvoiceId}`);
    expect(billingRes.status()).toBe(200);
    const v1 = await v1Res.json();
    const billing = await billingRes.json();
    expect(v1.id).toBe(billing.id);
    expect(v1.amount).toBe(billing.amount);
    expect(v1.status).toBe(billing.status);
  });

  test('PATCH /api/v1/invoices/:id updates dueDate', async ({ request }) => {
    const newDue = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const res = await authPatch(request, `/api/v1/invoices/${createdInvoiceId}`, {
      dueDate: newDue,
    });
    expect(res.status(), `patch dueDate: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(new Date(body.dueDate).toISOString().slice(0, 10)).toBe(newDue);
  });

  test('GET /api/v1/invoices returns array including the created invoice', async ({ request }) => {
    const res = await authGet(request, '/api/v1/invoices');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((inv) => inv.id === createdInvoiceId)).toBe(true);
  });
});

// ── POST /:id/payments — new endpoint (PRD §2 item 7c) ────────────────

test.describe('v1 invoices — POST /:id/payments', () => {
  test('400 INVALID_AMOUNT when amount <= 0', async ({ request }) => {
    const res = await authPost(request, `/api/v1/invoices/${createdInvoiceId}/payments`, {
      method: 'cash',
      amount: 0,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_AMOUNT');
  });

  test('400 METHOD_REQUIRED when method missing', async ({ request }) => {
    const res = await authPost(request, `/api/v1/invoices/${createdInvoiceId}/payments`, {
      amount: 100,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('METHOD_REQUIRED');
  });

  test('404 on unknown invoice id', async ({ request }) => {
    const res = await authPost(request, '/api/v1/invoices/99999999/payments', {
      method: 'cash',
      amount: 100,
    });
    expect(res.status()).toBe(404);
  });

  test('201 partial payment — fullyPaid:false, invoice stays UNPAID', async ({ request }) => {
    const res = await authPost(request, `/api/v1/invoices/${createdInvoiceId}/payments`, {
      method: 'cash',
      amount: 200, // invoice total = 500
      currency: 'USD',
    });
    expect(res.status(), `partial payment: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.payment.amount).toBe(200);
    expect(body.payment.status).toBe('SUCCESS');
    expect(body.totalPaid).toBe(200);
    expect(body.fullyPaid).toBe(false);
    expect(body.invoice.status).not.toBe('PAID');
  });

  test('201 second partial — totalPaid accumulates', async ({ request }) => {
    const res = await authPost(request, `/api/v1/invoices/${createdInvoiceId}/payments`, {
      method: 'card',
      amount: 200,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.totalPaid).toBe(400);
    expect(body.fullyPaid).toBe(false);
  });

  test('201 final tender reaches grand_total ±0.01 → auto-flip to PAID', async ({ request }) => {
    const res = await authPost(request, `/api/v1/invoices/${createdInvoiceId}/payments`, {
      method: 'upi',
      amount: 100, // 200 + 200 + 100 = 500 (exact match)
      reference: `${RUN_TAG}-final`,
    });
    expect(res.status(), `final payment: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.totalPaid).toBe(500);
    expect(body.fullyPaid).toBe(true);
    expect(body.invoice.status).toBe('PAID');
    expect(body.invoice.paidAt).toBeTruthy();
  });

  test('FP tolerance: total within 0.01 of grand_total still flips PAID', async ({ request }) => {
    // Create a fresh invoice for this isolation case.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const inv = await authPost(request, '/api/v1/invoices', {
      amount: 100.01,
      dueDate: tomorrow,
      contactId: createdContactId,
    });
    expect(inv.status()).toBe(201);
    secondInvoiceId = (await inv.json()).id;

    // Pay 100.00 — within ±0.01 of 100.01 → should auto-flip.
    const res = await authPost(request, `/api/v1/invoices/${secondInvoiceId}/payments`, {
      method: 'cash',
      amount: 100.00,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.fullyPaid).toBe(true);
    expect(body.invoice.status).toBe('PAID');
  });

  test('409 INVOICE_VOIDED when invoice is voided', async ({ request }) => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const inv = await authPost(request, '/api/v1/invoices', {
      amount: 250,
      dueDate: tomorrow,
      contactId: createdContactId,
    });
    expect(inv.status()).toBe(201);
    voidedInvoiceId = (await inv.json()).id;

    const voidRes = await authPost(request, `/api/billing/${voidedInvoiceId}/void`, {
      reason: 'spec teardown',
    });
    expect([200, 204]).toContain(voidRes.status());

    const res = await authPost(request, `/api/v1/invoices/${voidedInvoiceId}/payments`, {
      method: 'cash',
      amount: 50,
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('INVOICE_VOIDED');
  });
});

// ── POST /:id/complete — alias for /mark-paid (PRD §2 item 7d) ───────

test.describe('v1 invoices — POST /:id/complete alias', () => {
  test('200 flips status to PAID via /complete alias', async ({ request }) => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const inv = await authPost(request, '/api/v1/invoices', {
      amount: 750,
      dueDate: tomorrow,
      contactId: createdContactId,
    });
    expect(inv.status()).toBe(201);
    const invoiceId = (await inv.json()).id;

    const res = await authPost(request, `/api/v1/invoices/${invoiceId}/complete`, {
      paymentMethod: 'cash',
    });
    expect(res.status(), `complete: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // mark-paid handler returns the invoice (with embedded payment object) at
    // top level — the alias preserves that shape.
    const inv2 = body.invoice ? body.invoice : body;
    expect(inv2.status).toBe('PAID');
    expect(inv2.paidAt).toBeTruthy();
  });
});

// ── Auth gate ────────────────────────────────────────────────────────

test.describe('v1 invoices — auth gate', () => {
  test('GET /api/v1/invoices without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/v1/invoices`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/v1/invoices/:id/payments without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/v1/invoices/1/payments`, {
      data: { method: 'cash', amount: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
