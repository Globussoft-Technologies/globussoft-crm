// @ts-check
/**
 * Billing CA / Tally export API gate — PRD §4.4 W5 exit gate "CA
 * export validated."
 *
 * Routes pinned:
 *   GET /api/billing/export/tally.xml     — TallyPrime importable envelope
 *   GET /api/billing/export/ca-summary.csv — CA-friendly tabular summary
 *
 * Contract pinned:
 *   - Both routes require auth (401 without token)
 *   - Both routes are ADMIN / MANAGER (403 for USER role; canonical
 *     RBAC_DENIED envelope)
 *   - Tally XML emits Content-Type application/xml + attachment
 *     Content-Disposition with `tally-export-` filename prefix; body
 *     starts with the XML prolog + <ENVELOPE>
 *   - CA-CSV emits Content-Type text/csv + attachment
 *     Content-Disposition with `ca-summary-` filename prefix; first
 *     line is the pinned canonical header
 *   - ?from / ?to filter by issuedDate window
 *   - ?subBrand filters by Contact.subBrand (travel-vertical use case;
 *     non-matching value returns an envelope with zero <TALLYMESSAGE>)
 *
 * Pure-helper unit coverage:
 *   - backend/test/lib/tallyXmlExport.test.js (12 cases)
 *   - backend/test/lib/caCsvExport.test.js    (10 cases)
 *
 * Run: cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *      npx playwright test --project=chromium tests/billing-export-api.spec.js
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let adminToken = null;
let userToken = null;
let seedContactId = null;
const created = []; // ids for cleanup

async function login(request, email) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function authGet(request, t, path) {
  return request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${t}` }, timeout: REQUEST_TIMEOUT });
}
async function authPost(request, t, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: auth(t), data: body, timeout: REQUEST_TIMEOUT });
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, 'admin@globussoft.com');
  userToken = await login(request, 'user@crm.com');
  if (!adminToken) return;

  // Find any seeded contact on the generic tenant; we'll attach the
  // exporter test invoices to it. Same pattern as billing-api.spec.js.
  const r = await authGet(request, adminToken, '/api/contacts?limit=10');
  if (r.ok()) {
    const body = await r.json();
    const list = Array.isArray(body) ? body : (body.contacts || body.data || []);
    seedContactId = list[0]?.id ?? null;
  }

  // Best-effort: create 2 fresh invoices so the export has something
  // to emit. If creation fails (rate limit / shape mismatch in another
  // wave) we just skip the count assertions further down.
  if (seedContactId) {
    for (let i = 0; i < 2; i++) {
      const r2 = await authPost(request, adminToken, '/api/billing', {
        contactId: seedContactId,
        amount: 100 + i,
        dueDate: tomorrowISO(),
      });
      if (r2.ok()) {
        const inv = await r2.json();
        if (inv && inv.id) created.push(inv.id);
      }
    }
  }
});

test.afterAll(async ({ request }) => {
  if (!adminToken) return;
  for (const id of created) {
    await authPost(request, adminToken, `/api/billing/${id}/void`, { reason: '_teardown_ E2E export cleanup' }).catch(() => {});
  }
});

test.describe('Billing export — auth gates', () => {
  test('GET /export/tally.xml without token → 401/403', async ({ request }) => {
    const r = await request.get(`${API}/billing/export/tally.xml`);
    expect([401, 403]).toContain(r.status());
  });

  test('GET /export/ca-summary.csv without token → 401/403', async ({ request }) => {
    const r = await request.get(`${API}/billing/export/ca-summary.csv`);
    expect([401, 403]).toContain(r.status());
  });

  test('GET /export/tally.xml as USER role → 403 RBAC_DENIED', async ({ request }) => {
    test.skip(!userToken, 'USER login unavailable');
    const r = await authGet(request, userToken, '/api/billing/export/tally.xml');
    expect(r.status()).toBe(403);
    const body = await r.json().catch(() => ({}));
    // Canonical RBAC envelope (verifyRole). Code is stable; message is
    // human-facing and may vary.
    expect(body.code).toBe('RBAC_DENIED');
  });

  test('GET /export/ca-summary.csv as USER role → 403 RBAC_DENIED', async ({ request }) => {
    test.skip(!userToken, 'USER login unavailable');
    const r = await authGet(request, userToken, '/api/billing/export/ca-summary.csv');
    expect(r.status()).toBe(403);
    const body = await r.json().catch(() => ({}));
    expect(body.code).toBe('RBAC_DENIED');
  });
});

test.describe('Billing export — Tally XML happy path', () => {
  test('returns 200 application/xml with ENVELOPE body + attachment Content-Disposition', async ({ request }) => {
    test.skip(!adminToken, 'admin login unavailable');
    const r = await authGet(request, adminToken, '/api/billing/export/tally.xml');
    expect(r.status()).toBe(200);
    const ct = r.headers()['content-type'] || '';
    expect(ct).toMatch(/^application\/xml/);
    const cd = r.headers()['content-disposition'] || '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('tally-export-');
    expect(cd.endsWith('.xml"') || cd.endsWith('.xml')).toBe(true);
    const body = await r.text();
    // Either the XML prolog OR <ENVELOPE> as the first non-whitespace
    // construct is acceptable.
    expect(body.trimStart().startsWith('<?xml') || body.trimStart().startsWith('<ENVELOPE>')).toBe(true);
    expect(body).toContain('<ENVELOPE>');
    expect(body).toContain('</ENVELOPE>');
    expect(body).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
  });

  test('respects ?from / ?to window (zero matches still emits well-formed envelope)', async ({ request }) => {
    test.skip(!adminToken, 'admin login unavailable');
    // Pick a far-past window so we know NO seed invoices match.
    const r = await authGet(request, adminToken, '/api/billing/export/tally.xml?from=1990-01-01&to=1990-12-31');
    expect(r.status()).toBe(200);
    const body = await r.text();
    expect(body).toContain('<ENVELOPE>');
    expect(body).not.toContain('<TALLYMESSAGE>');
  });

  test('rejects invalid date range with 400 INVALID_DATE_RANGE', async ({ request }) => {
    test.skip(!adminToken, 'admin login unavailable');
    const r = await authGet(request, adminToken, '/api/billing/export/tally.xml?from=not-a-date');
    expect(r.status()).toBe(400);
    const body = await r.json().catch(() => ({}));
    expect(body.code).toBe('INVALID_DATE_RANGE');
  });

  test('?subBrand filter is honoured (unknown sub-brand → zero <TALLYMESSAGE>)', async ({ request }) => {
    test.skip(!adminToken, 'admin login unavailable');
    const r = await authGet(request, adminToken, '/api/billing/export/tally.xml?subBrand=__no_such_subbrand__');
    expect(r.status()).toBe(200);
    const body = await r.text();
    expect(body).toContain('<ENVELOPE>');
    expect(body).not.toContain('<TALLYMESSAGE>');
  });
});

test.describe('Billing export — CA-CSV happy path', () => {
  test('returns 200 text/csv with canonical header + attachment Content-Disposition', async ({ request }) => {
    test.skip(!adminToken, 'admin login unavailable');
    const r = await authGet(request, adminToken, '/api/billing/export/ca-summary.csv');
    expect(r.status()).toBe(200);
    const ct = r.headers()['content-type'] || '';
    expect(ct).toMatch(/^text\/csv/);
    const cd = r.headers()['content-disposition'] || '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('ca-summary-');
    const body = await r.text();
    // Canonical header row — changing this breaks accountant
    // spreadsheets, so it's gated.
    const firstLine = body.split('\n')[0];
    expect(firstLine).toBe(
      'Invoice Number,Issue Date,Contact Name,Billing State,Subtotal (Taxable),CGST,SGST,IGST,Total,Status,Sub-Brand,Notes'
    );
  });

  test('rejects invalid date range with 400 INVALID_DATE_RANGE', async ({ request }) => {
    test.skip(!adminToken, 'admin login unavailable');
    const r = await authGet(request, adminToken, '/api/billing/export/ca-summary.csv?to=not-a-date');
    expect(r.status()).toBe(400);
    const body = await r.json().catch(() => ({}));
    expect(body.code).toBe('INVALID_DATE_RANGE');
  });
});
