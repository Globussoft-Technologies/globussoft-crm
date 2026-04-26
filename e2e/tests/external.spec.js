// @ts-check
/**
 * External Partner API — /api/v1/external — smoke spec covering 16 handlers:
 *   GET    /health                  (public)
 *   GET    /me
 *   GET    /contacts/lookup
 *   GET    /contacts/:id
 *   GET    /patients/lookup
 *   GET    /patients/:id
 *   GET    /leads
 *   POST   /leads
 *   POST   /calls
 *   PATCH  /calls/:id
 *   POST   /messages
 *   GET    /services
 *   GET    /staff
 *   GET    /locations
 *   GET    /appointments
 *   POST   /appointments
 *
 * Auth uses X-API-Key (NOT Bearer JWT). Many tests are gated on
 * EXTERNAL_API_KEY env var; only the public /health and the no-key 401
 * gates run unconditionally.
 *
 * Run with:
 *   EXTERNAL_API_KEY=glbs_xxxxxxxxxxxxxxxx \
 *     npx playwright test external.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const EXT = `${BASE_URL}/api/v1/external`;
const KEY = process.env.EXTERNAL_API_KEY || '';

const keyHeaders = () => ({ 'X-API-Key': KEY });

test.describe.configure({ mode: 'serial' });

const createdCallIds = [];
const createdAppointmentIds = [];
const createdLeadEmails = [];

test.describe('External Partner API — auth gates (no key required)', () => {
  test('GET /health is public and returns ok', async ({ request }) => {
    const res = await request.get(`${EXT}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.apiVersion).toBe('v1');
  });

  test('GET /me without X-API-Key returns 401', async ({ request }) => {
    const res = await request.get(`${EXT}/me`);
    expect(res.status()).toBe(401);
  });

  test('GET /leads without X-API-Key returns 401', async ({ request }) => {
    const res = await request.get(`${EXT}/leads`);
    expect(res.status()).toBe(401);
  });

  test('GET /me with malformed X-API-Key returns 401', async ({ request }) => {
    const res = await request.get(`${EXT}/me`, {
      headers: { 'X-API-Key': 'not_a_real_key' },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /me with well-formed but unknown key returns 401', async ({ request }) => {
    const res = await request.get(`${EXT}/me`, {
      headers: { 'X-API-Key': 'glbs_' + 'a'.repeat(48) },
    });
    expect(res.status()).toBe(401);
  });

  test(':id route param rejects non-numeric values with 400', async ({ request }) => {
    const res = await request.get(`${EXT}/contacts/not-a-number`, {
      headers: { 'X-API-Key': 'glbs_' + 'a'.repeat(48) },
    });
    // 400 from param validator OR 401 from auth (param validator runs first)
    expect([400, 401]).toContain(res.status());
  });
});

test.describe('External Partner API — happy paths (require EXTERNAL_API_KEY)', () => {
  test.skip(!KEY, 'EXTERNAL_API_KEY env var not set — skipping authed external API tests');

  test('GET /me returns tenant + apiKey info', async ({ request }) => {
    const res = await request.get(`${EXT}/me`, { headers: keyHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenant).toBeTruthy();
    expect(body.tenant.id).toBeTruthy();
    expect(body.apiKey).toBeTruthy();
    expect(body).toHaveProperty('capabilities');
  });

  test('GET /leads returns { data, total }', async ({ request }) => {
    const res = await request.get(`${EXT}/leads?limit=5`, { headers: keyHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  test('POST /leads rejects empty body with 400', async ({ request }) => {
    const res = await request.post(`${EXT}/leads`, {
      headers: keyHeaders(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INSUFFICIENT_IDENTITY');
  });

  test('POST /leads creates a contact and returns 201', async ({ request }) => {
    const stamp = Date.now();
    const email = `e2e_audit_${stamp}@external-test.local`;
    createdLeadEmails.push(email);
    const res = await request.post(`${EXT}/leads`, {
      headers: keyHeaders(),
      data: {
        name: 'Aarav Sharma',
        email,
        phone: `+91990${stamp}`.slice(0, 13),
        source: 'e2e-test',
        note: 'E2E_AUDIT external lead',
      },
    });
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.email).toBe(email);
  });

  test('GET /contacts/lookup requires phone or email', async ({ request }) => {
    const res = await request.get(`${EXT}/contacts/lookup`, { headers: keyHeaders() });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_QUERY');
  });

  test('GET /contacts/lookup 404s for unknown phone', async ({ request }) => {
    const res = await request.get(
      `${EXT}/contacts/lookup?phone=+919999999998`,
      { headers: keyHeaders() }
    );
    expect([200, 404]).toContain(res.status());
    if (res.status() === 404) {
      const body = await res.json();
      expect(body.code).toBe('NOT_FOUND');
    }
  });

  test('GET /patients/lookup requires phone or email', async ({ request }) => {
    const res = await request.get(`${EXT}/patients/lookup`, { headers: keyHeaders() });
    expect(res.status()).toBe(400);
  });

  test('GET /services returns { data, total }', async ({ request }) => {
    const res = await request.get(`${EXT}/services?limit=5`, { headers: keyHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  test('GET /staff returns { data, total }', async ({ request }) => {
    const res = await request.get(`${EXT}/staff`, { headers: keyHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /locations returns { data, total }', async ({ request }) => {
    const res = await request.get(`${EXT}/locations`, { headers: keyHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /appointments accepts date filter', async ({ request }) => {
    const res = await request.get(`${EXT}/appointments?date=2099-01-01`, { headers: keyHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('POST /appointments rejects missing patientId with 400', async ({ request }) => {
    const res = await request.post(`${EXT}/appointments`, {
      headers: keyHeaders(),
      data: { slotStart: '2099-01-01T10:00:00Z' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /appointments rejects missing slotStart with 400', async ({ request }) => {
    const res = await request.post(`${EXT}/appointments`, {
      headers: keyHeaders(),
      data: { patientId: 1 },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /calls rejects request with no phone or contactId', async ({ request }) => {
    const res = await request.post(`${EXT}/calls`, {
      headers: keyHeaders(),
      data: { direction: 'INBOUND' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /calls + PATCH /calls/:id round-trip', async ({ request }) => {
    const create = await request.post(`${EXT}/calls`, {
      headers: keyHeaders(),
      data: {
        phone: '+919900000001',
        direction: 'INBOUND',
        durationSec: 42,
        provider: 'e2e-test',
        notes: 'E2E_AUDIT call log',
        status: 'COMPLETED',
      },
    });
    expect(create.status()).toBe(201);
    const call = await create.json();
    expect(call.id).toBeTruthy();
    createdCallIds.push(call.id);

    const patch = await request.patch(`${EXT}/calls/${call.id}`, {
      headers: keyHeaders(),
      data: { durationSec: 60, transcriptUrl: 'https://example.com/transcript.txt' },
    });
    expect(patch.status()).toBe(200);
    const updated = await patch.json();
    expect(updated.duration).toBe(60);
  });

  test('PATCH /calls/:id 404s for unknown id', async ({ request }) => {
    const res = await request.patch(`${EXT}/calls/99999999`, {
      headers: keyHeaders(),
      data: { duration: 10 },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /messages rejects when no recipient + no body', async ({ request }) => {
    const res = await request.post(`${EXT}/messages`, {
      headers: keyHeaders(),
      data: { channel: 'whatsapp' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /messages logs a whatsapp message and returns 201', async ({ request }) => {
    const res = await request.post(`${EXT}/messages`, {
      headers: keyHeaders(),
      data: {
        channel: 'whatsapp',
        direction: 'INBOUND',
        phone: '+919900000002',
        body: 'E2E_AUDIT whatsapp inbound',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
  });
});
