// @ts-check
/**
 * Smoke spec for backend/routes/deals_documents.js (3 handlers).
 * Mounted at /api/deals_documents.
 *
 *   POST /:dealId/upload         — multipart upload (multer)
 *   POST /:dealId/generate-quote — server-side PDF generation
 *   GET  /:dealId/attachments    — list attachments
 *
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. We seed a deal, exercise the endpoints, and clean up attachments.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
let dealId = null;
let contactId = null;

test.describe.configure({ mode: 'serial' });

test.describe('deals_documents routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();

    // Seed a contact and a deal we can attach docs to.
    const cRes = await request.post(`${API}/contacts`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: 'Vikram Mehta',
        email: `vikram.mehta+${Date.now()}@globussoft.com`,
        phone: '+919812345678',
      },
    });
    expect(cRes.ok(), `seed contact: ${await cRes.text()}`).toBeTruthy();
    const c = await cRes.json();
    contactId = c.id;

    const dRes = await request.post(`${API}/deals`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        title: `E2E_AUDIT_${Date.now()}_vikram_renewal`,
        amount: 25000,
        stage: 'lead',
        contactId,
        company: 'Mehta & Sons',
      },
    });
    expect(dRes.ok(), `seed deal: ${await dRes.text()}`).toBeTruthy();
    const d = await dRes.json();
    dealId = d.id;
  });

  test.afterAll(async ({ request }) => {
    const headers = { Authorization: `Bearer ${adminToken}` };
    if (dealId) await request.delete(`${API}/deals/${dealId}`, { headers }).catch(() => {});
    if (contactId) await request.delete(`${API}/contacts/${contactId}`, { headers }).catch(() => {});
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/deals_documents/:dealId/attachments requires auth', async ({ request }) => {
    test.skip(!dealId, 'no deal available');
    const res = await request.get(`${API}/deals_documents/${dealId}/attachments`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/deals_documents/:dealId/attachments returns array', async ({ request }) => {
    test.skip(!dealId, 'no deal available');
    const res = await request.get(`${API}/deals_documents/${dealId}/attachments`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/deals_documents/9999999/attachments returns 404', async ({ request }) => {
    const res = await request.get(`${API}/deals_documents/9999999/attachments`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /api/deals_documents/:dealId/upload without file returns 400', async ({ request }) => {
    test.skip(!dealId, 'no deal available');
    // Send a multipart form with no file field — multer's upload.single("file")
    // resolves req.file = undefined and the route returns 400.
    const res = await request.post(`${API}/deals_documents/${dealId}/upload`, {
      headers: auth(),
      multipart: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/file/i);
  });

  test('POST /api/deals_documents/9999999/upload returns 404', async ({ request }) => {
    const res = await request.post(`${API}/deals_documents/9999999/upload`, {
      headers: auth(),
      multipart: {
        file: {
          name: 'note.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello from E2E'),
        },
      },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /api/deals_documents/:dealId/upload accepts a small text file', async ({ request }) => {
    test.skip(!dealId, 'no deal available');
    const res = await request.post(`${API}/deals_documents/${dealId}/upload`, {
      headers: auth(),
      multipart: {
        file: {
          name: 'e2e-audit-note.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('E2E_AUDIT_attachment'),
        },
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.filename).toBe('e2e-audit-note.txt');
    expect(body.fileUrl).toMatch(/\/uploads\//);
    expect(body.dealId).toBe(dealId);
  });

  // #585: the route returns binary PDF bytes inline so the customer-facing
  // download is a real PDF, not an HTML page renamed to *.pdf. We pin the
  // three acceptance points from the issue: Content-Type starts with
  // application/pdf, the response body's first 4 bytes are "%PDF" (the PDF
  // magic header), and Content-Disposition's filename ends in .pdf.
  test('POST /api/deals_documents/:dealId/generate-quote returns binary PDF bytes (#585)', async ({ request }) => {
    test.skip(!dealId, 'no deal available');
    const res = await request.post(`${API}/deals_documents/${dealId}/generate-quote`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(200);

    const contentType = res.headers()['content-type'] || '';
    expect(contentType.startsWith('application/pdf')).toBe(true);

    const disposition = res.headers()['content-disposition'] || '';
    expect(disposition).toMatch(/filename="?[^"]*\.pdf"?/i);

    const body = await res.body();
    // PDF magic header — every valid PDF starts with the ASCII bytes "%PDF".
    expect(body.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(body.length).toBeGreaterThan(100);
  });

  test('POST /api/deals_documents/:dealId/generate-quote also persists an attachment row (#585)', async ({ request }) => {
    test.skip(!dealId, 'no deal available');
    // Side-effect contract: even though the inline response is binary,
    // the route still persists the same PDF bytes to disk + creates an
    // Attachment row so the existing "see it later in attachments" UX
    // keeps working after a refresh.
    const list = await request.get(`${API}/deals_documents/${dealId}/attachments`, { headers: auth() });
    expect(list.status()).toBe(200);
    const items = await list.json();
    const hasQuote = items.some((a) => /quote.*\.pdf$/i.test(a.filename) || /quote.*\.pdf$/i.test(a.fileUrl || ''));
    expect(hasQuote).toBe(true);
  });

  test('POST /api/deals_documents/9999999/generate-quote returns 404', async ({ request }) => {
    const res = await request.post(`${API}/deals_documents/9999999/generate-quote`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  test('GET /api/deals_documents/:dealId/attachments shows uploaded items', async ({ request }) => {
    test.skip(!dealId, 'no deal available');
    const res = await request.get(`${API}/deals_documents/${dealId}/attachments`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(2);
  });
});
