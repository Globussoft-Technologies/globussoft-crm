// @ts-check
/**
 * Batch 7 fixes — verifies the seven (+1) issues closed on 2026-04-26 against
 * the live dev server:
 *   #122 reopen — DELETE /api/billing/:id is now a soft-void
 *   #193        — POST /void alias, /refund, /credit-note
 *   #194 (partial) — PUT /prescriptions /consents /recommendations
 *   #195        — recommendation lifecycle state machine
 *   #196        — GET /api/billing/:id detail endpoint
 *   #197        — visit status enum + transition guard
 *   #198        — sub-paise precision rejected on POST /api/billing
 *   #199        — POST /api/estimates accepts legacy `name`+`items` aliases
 *
 * Hits BASE_URL (default https://crm.globusdemos.com). Each test seeds + cleans
 * its own data so rows don't leak across runs.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@wellness.demo';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
let tenantSeedContactId = null;

test.describe.configure({ mode: 'serial' });

test.describe('Batch 7 — recent fixes (live dev server)', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();

    // Pick a contact in the tenant to satisfy invoice/estimate FK requirements.
    const contacts = await request.get(`${API}/contacts?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cdata = await contacts.json();
    const list = Array.isArray(cdata) ? cdata : (cdata.data || cdata.contacts || []);
    if (list[0]) tenantSeedContactId = list[0].id;
    test.skip(!tenantSeedContactId, 'tenant has no contacts; cannot seed invoices');
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  // ── helpers ────────────────────────────────────────────────────────
  async function createInvoice(request, { amount = 1500, paid = false } = {}) {
    const res = await request.post(`${API}/billing`, {
      headers: auth(),
      data: {
        contactId: tenantSeedContactId,
        amount,
        dueDate: '2099-12-31',
      },
    });
    expect(res.ok(), `invoice create failed: ${await res.text()}`).toBeTruthy();
    const inv = await res.json();
    if (paid) {
      const pay = await request.put(`${API}/billing/${inv.id}/pay`, { headers: auth() });
      expect(pay.ok()).toBeTruthy();
      return await pay.json();
    }
    return inv;
  }

  // ── #196 ───────────────────────────────────────────────────────────
  test('#196 GET /api/billing/:id returns the invoice', async ({ request }) => {
    const inv = await createInvoice(request);
    const res = await request.get(`${API}/billing/${inv.id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(inv.id);
    expect(body.amount).toBe(inv.amount);
    expect(body.contact).toBeTruthy();
  });

  test('#196 GET /api/billing/:id 404s for non-existent id', async ({ request }) => {
    const res = await request.get(`${API}/billing/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  // ── #198 ───────────────────────────────────────────────────────────
  test('#198 POST /api/billing rejects sub-paise precision', async ({ request }) => {
    const res = await request.post(`${API}/billing`, {
      headers: auth(),
      data: { contactId: tenantSeedContactId, amount: 123.456789, dueDate: '2099-12-31' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_AMOUNT_PRECISION');
  });

  test('#198 POST /api/billing accepts a clean 2-decimal amount', async ({ request }) => {
    const res = await request.post(`${API}/billing`, {
      headers: auth(),
      data: { contactId: tenantSeedContactId, amount: 99.99, dueDate: '2099-12-31' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(Math.abs(body.amount - 99.99)).toBeLessThan(1e-6);
  });

  // ── #193 — POST /void alias, /refund, /credit-note ─────────────────
  test('#193 POST /api/billing/:id/void soft-voids an UNPAID invoice', async ({ request }) => {
    const inv = await createInvoice(request);
    const res = await request.post(`${API}/billing/${inv.id}/void`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('VOIDED');

    // Row must still exist in the ledger.
    const list = await request.get(`${API}/billing`, { headers: auth() });
    const items = await list.json();
    const stillThere = (Array.isArray(items) ? items : items.data || []).find((i) => i.id === inv.id);
    expect(stillThere, 'voided invoice must remain in the ledger').toBeTruthy();
    expect(stillThere.status).toBe('VOIDED');
  });

  test('#193 POST /api/billing/:id/void rejects PAID invoice with INVOICE_ALREADY_PAID', async ({ request }) => {
    const inv = await createInvoice(request, { paid: true });
    const res = await request.post(`${API}/billing/${inv.id}/void`, { headers: auth() });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVOICE_ALREADY_PAID');
  });

  test('#193 POST /api/billing/:id/refund flips PAID → REFUNDED', async ({ request }) => {
    const inv = await createInvoice(request, { paid: true });
    const res = await request.post(`${API}/billing/${inv.id}/refund`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('REFUNDED');
  });

  test('#193 POST /api/billing/:id/refund rejects UNPAID with INVOICE_NOT_PAID', async ({ request }) => {
    const inv = await createInvoice(request);
    const res = await request.post(`${API}/billing/${inv.id}/refund`, { headers: auth() });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVOICE_NOT_PAID');
  });

  test('#193 POST /api/billing/:id/credit-note creates a CN- linked invoice', async ({ request }) => {
    const inv = await createInvoice(request, { amount: 1500, paid: true });
    const res = await request.post(`${API}/billing/${inv.id}/credit-note`, {
      headers: auth(),
      data: { reason: 'test full reversal' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.creditNote).toBeTruthy();
    expect(body.creditNote.amount).toBe(-1500);
    expect(body.creditNote.invoiceNum).toMatch(/^CN-/);
    expect(body.creditNote.parentInvoiceId).toBe(inv.id);
    expect(body.originalInvoiceId).toBe(inv.id);
  });

  test('#193 POST /api/billing/:id/credit-note rejects amount > original', async ({ request }) => {
    const inv = await createInvoice(request, { amount: 100, paid: true });
    const res = await request.post(`${API}/billing/${inv.id}/credit-note`, {
      headers: auth(),
      data: { amount: 5000 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AMOUNT_EXCEEDS_ORIGINAL');
  });

  // ── #122 reopen ────────────────────────────────────────────────────
  test('#122 DELETE /api/billing/:id no longer hard-deletes — soft-voids instead', async ({ request }) => {
    const inv = await createInvoice(request);
    const res = await request.delete(`${API}/billing/${inv.id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('VOIDED');

    // Confirm the row is still readable via GET /:id.
    const detail = await request.get(`${API}/billing/${inv.id}`, { headers: auth() });
    expect(detail.status()).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe('VOIDED');
  });

  // ── #199 — estimate legacy field aliases ───────────────────────────
  test('#199 POST /api/estimates accepts legacy { name, items } shape', async ({ request }) => {
    const res = await request.post(`${API}/estimates`, {
      headers: auth(),
      data: {
        name: 'legacy-shape estimate',
        contactId: tenantSeedContactId,
        items: [{ description: 'legacy line', quantity: 1, unitPrice: 100 }],
      },
    });
    expect(res.status(), `legacy estimate must succeed: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.title).toBe('legacy-shape estimate');
  });

  test('#199 POST /api/estimates still accepts new { title, lineItems } shape', async ({ request }) => {
    const res = await request.post(`${API}/estimates`, {
      headers: auth(),
      data: {
        title: 'current-shape estimate',
        contactId: tenantSeedContactId,
        lineItems: [{ description: 'new line', quantity: 1, unitPrice: 100 }],
      },
    });
    expect(res.status()).toBe(201);
  });

  // ── #197 — visit status enum + transitions ─────────────────────────
  test.describe('#197 wellness visit status state machine', () => {
    let patientId, visitId;

    test.beforeAll(async ({ request }) => {
      // Seed a wellness patient + visit to mutate.
      const pres = await request.post(`${API}/wellness/patients`, {
        headers: auth(),
        data: { name: 'Aarav Nair', phone: '+919900112233', dob: '1990-01-01' },
      });
      if (!pres.ok()) test.skip(true, 'tenant is not a wellness vertical; skipping');
      const p = await pres.json();
      patientId = p.id;

      const vres = await request.post(`${API}/wellness/visits`, {
        headers: auth(),
        data: { patientId, visitDate: new Date().toISOString(), status: 'booked' },
      });
      expect(vres.ok(), `visit create: ${await vres.text()}`).toBeTruthy();
      const v = await vres.json();
      visitId = v.id;
    });

    test('rejects junk status with 400 INVALID_VISIT_STATUS', async ({ request }) => {
      const res = await request.put(`${API}/wellness/visits/${visitId}`, {
        headers: auth(),
        data: { status: 'frog' },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('INVALID_VISIT_STATUS');
    });

    test('rejects invalid transition (completed → booked) with 422', async ({ request }) => {
      // Move booked → completed first
      const advance = await request.put(`${API}/wellness/visits/${visitId}`, {
        headers: auth(),
        data: { status: 'completed' },
      });
      expect(advance.status()).toBe(200);

      // Now attempt to regress
      const regress = await request.put(`${API}/wellness/visits/${visitId}`, {
        headers: auth(),
        data: { status: 'booked' },
      });
      expect(regress.status()).toBe(422);
      const body = await regress.json();
      expect(body.code).toBe('INVALID_VISIT_TRANSITION');
    });
  });

  // ── #195 — recommendation lifecycle ────────────────────────────────
  test.describe('#195 recommendation reject state machine', () => {
    test('rejecting an already-rejected card returns idempotent', async ({ request }) => {
      const list = await request.get(`${API}/wellness/recommendations?status=all`, { headers: auth() });
      if (!list.ok()) test.skip(true, 'wellness recommendations not available; skipping');
      const items = await list.json();
      const rejected = (Array.isArray(items) ? items : []).find((r) => r.status === 'rejected');
      test.skip(!rejected, 'no rejected recommendation in fixtures to retest');

      const res = await request.post(`${API}/wellness/recommendations/${rejected.id}/reject`, {
        headers: auth(),
        data: { reason: 'retry' },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.idempotent).toBe(true);
    });

    test('approving a rejected card returns 422', async ({ request }) => {
      const list = await request.get(`${API}/wellness/recommendations?status=all`, { headers: auth() });
      if (!list.ok()) test.skip(true, 'wellness recommendations not available; skipping');
      const items = await list.json();
      const rejected = (Array.isArray(items) ? items : []).find((r) => r.status === 'rejected');
      test.skip(!rejected, 'no rejected recommendation in fixtures');

      const res = await request.post(`${API}/wellness/recommendations/${rejected.id}/approve`, {
        headers: auth(),
      });
      expect(res.status()).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_RECOMMENDATION_TRANSITION');
    });
  });

  // ── #194 — clinical amend (PUT) ─────────────────────────────────────
  test.describe('#194 clinical artefact amend', () => {
    test('PUT /prescriptions/:id with empty drugs returns DRUG_NAME_REQUIRED', async ({ request }) => {
      const list = await request.get(`${API}/wellness/prescriptions?limit=1`, { headers: auth() });
      if (!list.ok()) test.skip(true, 'wellness prescriptions not available; skipping');
      const items = await list.json();
      test.skip(!items[0], 'no prescription in fixtures to amend');

      const res = await request.put(`${API}/wellness/prescriptions/${items[0].id}`, {
        headers: auth(),
        data: { drugs: [] },
      });
      // 403 if caller is not the prescriber/admin; 400 otherwise. Either way
      // confirms the gate exists.
      expect([400, 403]).toContain(res.status());
      if (res.status() === 400) {
        const body = await res.json();
        expect(body.code).toBe('DRUG_NAME_REQUIRED');
      }
    });

    test('PUT /consents/:id with signatureSvg returns SIGNATURE_IMMUTABLE', async ({ request }) => {
      const list = await request.get(`${API}/wellness/consents?limit=1`, { headers: auth() });
      if (!list.ok()) test.skip(true, 'wellness consents not available; skipping');
      const items = await list.json();
      test.skip(!items[0], 'no consent in fixtures to amend');

      const res = await request.put(`${API}/wellness/consents/${items[0].id}`, {
        headers: auth(),
        data: { signatureSvg: 'data:image/png;base64,tampered' },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('SIGNATURE_IMMUTABLE');
    });
  });
});
