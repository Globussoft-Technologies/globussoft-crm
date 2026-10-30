// @ts-check
/**
 * Generic Finance Quotes API contract.
 *
 * Covers the quote builder's tenant-scoped CRUD, server-side GST math, status
 * transition, and CSV template/import/export surfaces. Rows are tagged so the
 * serial cleanup cannot touch demo data created by a human or another run.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_QUOTE_${Date.now()}_${process.pid}`;
let token = null;

async function authToken(request) {
  if (token) return token;
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  token = (await response.json()).token;
  return token;
}

function jsonHeaders(value) {
  return { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' };
}

async function cleanup(request) {
  if (!token) return;
  const response = await request.get(`${BASE_URL}/api/quotes?limit=100&search=${encodeURIComponent(RUN_TAG)}`, {
    headers: jsonHeaders(token),
    timeout: REQUEST_TIMEOUT,
  });
  if (!response.ok()) return;
  const body = await response.json();
  for (const quote of body.data || []) {
    await request.delete(`${BASE_URL}/api/quotes/${quote.id}`, { headers: jsonHeaders(token), timeout: REQUEST_TIMEOUT }).catch(() => {});
  }
}

test.afterAll(async ({ request }) => cleanup(request));

async function createQuote(request, overrides = {}) {
  const response = await request.post(`${BASE_URL}/api/quotes`, {
    headers: jsonHeaders(await authToken(request)),
    data: {
      quoteOwnerName: 'E2E Admin',
      customerName: 'Quote Test Customer',
      currency: 'USD',
      validUntil: '2030-12-31',
      lineItems: [{ productName: 'Implementation', quantity: 2, cost: 40, unitPrice: 100, discountPercent: 10, gstRate: 18 }],
      ...overrides,
      // Keep the run tag after applying overrides: search and cleanup both
      // depend on it, including callers that supply a subject suffix.
      subject: `${RUN_TAG} ${overrides.subject || 'builder'}`,
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status(), await response.text()).toBe(201);
  const quote = await response.json();
  expect(quote.title).toBe(`${RUN_TAG} ${overrides.subject || 'builder'}`);
  return quote;
}

test('POST /api/quotes validates required data and computes GST server-side', async ({ request }) => {
  const missing = await request.post(`${BASE_URL}/api/quotes`, {
    headers: jsonHeaders(await authToken(request)),
    data: { subject: `${RUN_TAG} missing-items` },
    timeout: REQUEST_TIMEOUT,
  });
  expect(missing.status()).toBe(400);
  expect((await missing.json()).code).toBe('LINE_ITEMS_REQUIRED');

  const pastDate = await request.post(`${BASE_URL}/api/quotes`, {
    headers: jsonHeaders(await authToken(request)),
    data: {
      subject: `${RUN_TAG} past-date`,
      validUntil: '2020-01-01',
      lineItems: [{ productName: 'Implementation', quantity: 1, unitPrice: 100, gstRate: 0 }],
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(pastDate.status()).toBe(400);
  expect((await pastDate.json()).code).toBe('VALID_UNTIL_IN_PAST');

  const quote = await createQuote(request);
  expect(quote.quoteNumber).toMatch(/^QUO-/);
  expect(quote.lineItems).toHaveLength(1);
  expect(quote.lineItems[0].discountAmount).toBe(20);
  expect(quote.lineItems[0].gstAmount).toBe(32.4);
  expect(quote.totalAmount).toBe(212.4);
});

test('GET /api/quotes lists tenant quotes and exposes stats', async ({ request }) => {
  const value = await createQuote(request, { subject: 'list' });
  const list = await request.get(`${BASE_URL}/api/quotes?search=${encodeURIComponent(RUN_TAG)}&limit=10`, {
    headers: jsonHeaders(await authToken(request)),
    timeout: REQUEST_TIMEOUT,
  });
  expect(list.status()).toBe(200);
  const body = await list.json();
  expect(body.data.some((row) => row.id === value.id)).toBeTruthy();
  expect(body.pagination.total).toBeGreaterThanOrEqual(1);

  const stats = await request.get(`${BASE_URL}/api/quotes/stats`, { headers: jsonHeaders(token), timeout: REQUEST_TIMEOUT });
  expect(stats.status()).toBe(200);
  expect((await stats.json()).byStatus.Draft).toBeGreaterThanOrEqual(1);

  const catalog = await request.get(`${BASE_URL}/api/quotes/catalog`, { headers: jsonHeaders(token), timeout: REQUEST_TIMEOUT });
  expect(catalog.status()).toBe(200);
  expect(Array.isArray(await catalog.json())).toBeTruthy();
});

test('status, edit, PDF, and CSV quote actions are available', async ({ request }) => {
  const quote = await createQuote(request, { subject: 'csv-and-status' });
  const status = await request.patch(`${BASE_URL}/api/quotes/${quote.id}/status`, {
    headers: jsonHeaders(await authToken(request)),
    data: { status: 'Sent' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(status.status()).toBe(200);
  expect((await status.json()).status).toBe('Sent');

  const updated = await request.patch(`${BASE_URL}/api/quotes/${quote.id}`, {
    headers: jsonHeaders(token),
    data: {
      subject: `${RUN_TAG} edited`,
      validUntil: '2031-01-15',
      lineItems: [{ productName: 'Implementation', quantity: 1, cost: 40, unitPrice: 200, discountPercent: 0, gstRate: 7.5 }],
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(updated.status()).toBe(200);
  const updatedBody = await updated.json();
  expect(updatedBody.title).toBe(`${RUN_TAG} edited`);
  expect(updatedBody.status).toBe('Sent');
  expect(updatedBody.lineItems[0].gstRate).toBe(7.5);

  const pdf = await request.get(`${BASE_URL}/api/quotes/${quote.id}/pdf`, {
    headers: jsonHeaders(token),
    timeout: REQUEST_TIMEOUT,
  });
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  const template = await request.get(`${BASE_URL}/api/quotes/template.csv`, { headers: jsonHeaders(token), timeout: REQUEST_TIMEOUT });
  expect(template.status()).toBe(200);
  expect(await template.text()).toContain('Quote Number,Subject');

  const xlsxTemplate = await request.get(`${BASE_URL}/api/quotes/template.xlsx`, { headers: jsonHeaders(token), timeout: REQUEST_TIMEOUT });
  expect(xlsxTemplate.status()).toBe(200);
  expect(xlsxTemplate.headers()['content-type']).toContain('spreadsheetml.sheet');
  expect((await xlsxTemplate.body()).subarray(0, 2).toString()).toBe('PK');

  const exported = await request.get(`${BASE_URL}/api/quotes/export.csv`, { headers: jsonHeaders(token), timeout: REQUEST_TIMEOUT });
  expect(exported.status()).toBe(200);
  expect(await exported.text()).toContain(RUN_TAG);

  const xlsxExport = await request.get(`${BASE_URL}/api/quotes/export.xlsx`, { headers: jsonHeaders(token), timeout: REQUEST_TIMEOUT });
  expect(xlsxExport.status()).toBe(200);
  expect(xlsxExport.headers()['content-type']).toContain('spreadsheetml.sheet');
  expect((await xlsxExport.body()).subarray(0, 2).toString()).toBe('PK');

  const imported = await request.post(`${BASE_URL}/api/quotes/import.csv`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: {
        name: 'quotes.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(`Quote Number,Subject,Status,Valid Until,Currency,Customer Name,Product Name,Description,Quantity,Cost,Unit Price,Discount %,GST %\n,${RUN_TAG} imported,Draft,2030-12-31,USD,Imported Customer,Support,Monthly support,1,10,50,0,5\n`),
      },
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(imported.status()).toBe(200);
  expect((await imported.json()).imported).toBe(1);
});
