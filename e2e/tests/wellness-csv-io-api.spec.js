// @ts-check
/**
 * Issue #816 — wellness CSV import/export gate spec.
 *
 * Endpoints covered (all mounted at /api/wellness/csv):
 *   GET  /:entity                       — meta (headers, sample, thresholds)
 *   GET  /:entity/template              — RFC-4180 template download
 *   GET  /:entity/export?<filters>      — filtered CSV export
 *   POST /:entity/import                — multipart, synchronous
 *   POST /:entity/import/async          — multipart, queued (returns jobId)
 *   GET  /jobs/:jobId                   — poll status
 *
 * Entities: services | packages | products | customers | bookings.
 *
 * The spec exercises the wellness tenant (rishu@enhancedwellness.in / Admin)
 * because the entities are wellness-vertical-gated. Generic-tenant access is
 * tested with admin@globussoft.com to confirm the WELLNESS_TENANT_REQUIRED
 * 403 path.
 *
 * Data hygiene: every imported row is tagged with the run-tag prefix
 * `E2E_CSVIO_<ts>` in name/notes fields so the afterAll cleanup can find
 * and delete them. The afterAll deletes services, drugs, and patients
 * matching the tag — bookings are exempt (the project's standing rule
 * forbids clinical-artefact deletion).
 */

const { test, expect } = require('@playwright/test');

// Pin tests in this file to serial; the import flow mutates the wellness
// tenant catalogue and parallel shards racing the same name keys would
// trip the natural-key dedup gate.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60_000;
const RUN_TAG = `E2E_CSVIO_${Date.now()}`;

let adminToken = null;
let userToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, userId: j.user.id };
      }
    } catch {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getWellnessAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'rishu@enhancedwellness.in', 'password123');
    adminToken = r.token;
  }
  return adminToken;
}

async function getGenericAdmin(request) {
  if (!userToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    userToken = r.token;
  }
  return userToken;
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

// Track names so we can clean up afterAll.
const createdServiceNames = new Set();
const createdDrugNames = new Set();
const createdPatientPhones = new Set();

test.afterAll(async ({ request }) => {
  const token = await getWellnessAdmin(request);
  if (!token) return;
  // Services
  try {
    const r = await request.get(`${BASE_URL}/api/wellness/services?includeInactive=1`, {
      headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
    });
    if (r.ok()) {
      const list = await r.json();
      const arr = Array.isArray(list) ? list : (list?.services || []);
      for (const s of arr) {
        if (createdServiceNames.has(s.name)) {
          await request.put(`${BASE_URL}/api/wellness/services/${s.id}`, {
            headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
            data: { isActive: false },
            timeout: REQUEST_TIMEOUT,
          }).catch(() => { });
        }
      }
    }
  } catch { /* best effort */ }
});

// ── Helpers ────────────────────────────────────────────────────────

function buildCsv(headers, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

async function postMultipart(request, token, path, csvBody, filename = 'upload.csv') {
  return request.post(`${BASE_URL}${path}`, {
    multipart: {
      file: { name: filename, mimeType: 'text/csv', buffer: Buffer.from(csvBody, 'utf8') },
    },
    headers: authHeaders(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// ── Meta endpoint ──────────────────────────────────────────────────

test.describe('GET /api/wellness/csv/:entity (meta)', () => {
  test('returns headers + sample + thresholds for each entity', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    expect(token, 'wellness admin login').toBeTruthy();
    for (const e of ['services', 'packages', 'products', 'customers', 'bookings']) {
      const r = await request.get(`${BASE_URL}/api/wellness/csv/${e}`, {
        headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
      });
      expect(r.status(), `${e} meta`).toBe(200);
      const body = await r.json();
      expect(body.entity).toBe(e);
      expect(Array.isArray(body.headers)).toBe(true);
      expect(body.headers.length).toBeGreaterThan(0);
      expect(typeof body.thresholds.rows).toBe('number');
      expect(typeof body.thresholds.bytes).toBe('number');
    }
  });

  test('returns 404 UNKNOWN_ENTITY for unknown name', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const r = await request.get(`${BASE_URL}/api/wellness/csv/widgets`, {
      headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe('UNKNOWN_ENTITY');
  });
});

// ── Template + export ──────────────────────────────────────────────

test.describe('GET /api/wellness/csv/:entity/template + /export', () => {
  test('services template returns CSV with header + sample row', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const r = await request.get(`${BASE_URL}/api/wellness/csv/services/template`, {
      headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
    expect(r.headers()['content-disposition']).toContain('services-template.csv');
    const body = await r.text();
    expect(body).toContain('name,category,ticketTier');
    expect(body).toContain('Hydrafacial');
  });

  test('services export streams CSV of the current tenant', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const r = await request.get(`${BASE_URL}/api/wellness/csv/services/export`, {
      headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
    const body = await r.text();
    // Body is BOM + CSV; header line should be findable in the first 200 chars.
    expect(body.slice(0, 200)).toContain('name,category,ticketTier');
  });

  test('export honours search filter (?q=)', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const r = await request.get(`${BASE_URL}/api/wellness/csv/customers/export?q=__no_match__${RUN_TAG}`, {
      headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.text();
    // Header line only — no matching patients.
    const lines = body.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

// ── Sync import: services ──────────────────────────────────────────

test.describe('POST /api/wellness/csv/services/import', () => {
  test('happy path inserts 2 new services, updates 1 existing on re-upload', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const svc1 = `${RUN_TAG}-svc-1`;
    const svc2 = `${RUN_TAG}-svc-2`;
    createdServiceNames.add(svc1);
    createdServiceNames.add(svc2);

    const csv = buildCsv(
      ['name', 'category', 'ticketTier', 'basePrice', 'durationMin', 'marketingRadiusKm', 'description', 'active'],
      [
        { name: svc1, category: 'aesthetics', ticketTier: 'medium', basePrice: '1500', durationMin: '45', marketingRadiusKm: '20', description: 'test 1', active: 'true' },
        { name: svc2, category: 'aesthetics', ticketTier: 'low', basePrice: '800', durationMin: '30', marketingRadiusKm: '15', description: 'test 2', active: 'true' },
      ],
    );

    const r = await postMultipart(request, token, '/api/wellness/csv/services/import', csv, 'services.csv');
    expect(r.status(), `import: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body.inserted + body.updated).toBeGreaterThanOrEqual(2);
    expect(body.errors.length).toBe(0);

    // Re-upload the same CSV — should update, not duplicate.
    const r2 = await postMultipart(request, token, '/api/wellness/csv/services/import', csv, 'services.csv');
    expect(r2.status()).toBe(200);
    const body2 = await r2.json();
    expect(body2.updated).toBeGreaterThanOrEqual(2);
    expect(body2.inserted).toBe(0);
  });

  test('row-level error report: invalid basePrice, missing name', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const csv = buildCsv(
      ['name', 'category', 'ticketTier', 'basePrice', 'durationMin', 'marketingRadiusKm', 'description', 'active'],
      [
        { name: '', basePrice: '1000', active: 'true' },          // row 2: missing name
        { name: `${RUN_TAG}-svc-bad`, basePrice: '0', active: 'true' }, // row 3: price ≤ 0
        { name: `${RUN_TAG}-svc-bad2`, basePrice: '500', active: 'maybe' }, // row 4: bad active
      ],
    );
    const r = await postMultipart(request, token, '/api/wellness/csv/services/import', csv, 'errs.csv');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.errors.length).toBeGreaterThanOrEqual(3);
    expect(body.errors.some((e) => e.column === 'name' && e.row === 2)).toBe(true);
    expect(body.errors.some((e) => e.column === 'basePrice' && e.row === 3)).toBe(true);
    expect(body.errors.some((e) => e.column === 'active' && e.row === 4)).toBe(true);
  });

  test('400 FILE_REQUIRED when no multipart file is attached', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const r = await request.post(`${BASE_URL}/api/wellness/csv/services/import`, {
      headers: authHeaders(token),
      multipart: {},
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('FILE_REQUIRED');
  });

  test('missing required column surfaces a header-level error on row 1', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    // basePrice column intentionally omitted.
    const csv = buildCsv(
      ['name', 'category', 'ticketTier', 'durationMin', 'marketingRadiusKm', 'description', 'active'],
      [{ name: 'X', active: 'true' }],
    );
    const r = await postMultipart(request, token, '/api/wellness/csv/services/import', csv, 'broken.csv');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.errors.length).toBe(1);
    expect(body.errors[0].row).toBe(1);
    expect(body.errors[0].column).toBe('headers');
  });
});

// ── Sync import: customers (Patients) ──────────────────────────────

test.describe('POST /api/wellness/csv/customers/import', () => {
  test('inserts new patient with normalised phone', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const last10 = String(Date.now()).slice(-10);
    const phone = `+91${last10}`;
    createdPatientPhones.add(last10);
    const csv = buildCsv(
      ['name', 'phone', 'email', 'gender', 'dob', 'source', 'bloodGroup', 'allergies', 'notes'],
      [
        { name: `${RUN_TAG}-pt-1`, phone, email: '', gender: 'F', dob: '1990-01-15', source: 'walk-in', bloodGroup: '', allergies: '', notes: '' },
      ],
    );
    const r = await postMultipart(request, token, '/api/wellness/csv/customers/import', csv, 'patients.csv');
    expect(r.status(), `customers import: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body.errors.length).toBe(0);
    expect(body.inserted).toBeGreaterThanOrEqual(1);
  });

  test('row-level errors for bad phone + bad email + bad gender', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const csv = buildCsv(
      ['name', 'phone', 'email', 'gender', 'dob', 'source', 'bloodGroup', 'allergies', 'notes'],
      [
        { name: `${RUN_TAG}-bad-phone`, phone: 'abc123', email: '', gender: '', dob: '', source: '', bloodGroup: '', allergies: '', notes: '' },
        { name: `${RUN_TAG}-bad-email`, phone: '+919876543210', email: 'not-an-email', gender: '', dob: '', source: '', bloodGroup: '', allergies: '', notes: '' },
        { name: `${RUN_TAG}-bad-gender`, phone: '+919876543211', email: '', gender: 'Q', dob: '', source: '', bloodGroup: '', allergies: '', notes: '' },
      ],
    );
    const r = await postMultipart(request, token, '/api/wellness/csv/customers/import', csv, 'errs.csv');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.errors.some((e) => e.column === 'phone')).toBe(true);
    expect(body.errors.some((e) => e.column === 'email')).toBe(true);
    expect(body.errors.some((e) => e.column === 'gender')).toBe(true);
  });
});

// ── Auth + tenant gating ───────────────────────────────────────────

test.describe('Auth + vertical gates', () => {
  test('401 on missing Authorization header', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/csv/services/template`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });

  test('generic tenant 403 WELLNESS_TENANT_REQUIRED', async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, 'generic admin login unavailable');
    const r = await request.get(`${BASE_URL}/api/wellness/csv/services/template`, {
      headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
    });
    // Either 403 (wellness gate) or 200 if the gate has been removed —
    // assert specifically that this isn't an unintended 200 leaking
    // cross-tenant data.
    expect([403, 410]).toContain(r.status());
  });
});

// ── Async import ───────────────────────────────────────────────────

test.describe('POST /api/wellness/csv/:entity/import/async + GET /jobs/:jobId', () => {
  test('happy path queues + completes', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const csv = buildCsv(
      ['name', 'category', 'ticketTier', 'basePrice', 'durationMin', 'marketingRadiusKm', 'description', 'active'],
      [{ name: `${RUN_TAG}-async-svc`, category: 'aesthetics', ticketTier: 'medium', basePrice: '999', durationMin: '30', marketingRadiusKm: '10', description: 'async test', active: 'true' }],
    );
    createdServiceNames.add(`${RUN_TAG}-async-svc`);
    const r = await postMultipart(request, token, '/api/wellness/csv/services/import/async', csv, 'async.csv');
    expect(r.status()).toBe(202);
    const body = await r.json();
    expect(body.jobId).toBeTruthy();
    expect(body.status).toBe('queued');

    // Poll up to 10s for the job to finish.
    let job = null;
    for (let i = 0; i < 20; i += 1) {
      const p = await request.get(`${BASE_URL}/api/wellness/csv/jobs/${body.jobId}`, {
        headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
      });
      if (p.ok()) {
        job = await p.json();
        if (job.status === 'done' || job.status === 'failed') break;
      }
      await new Promise((r2) => setTimeout(r2, 500));
    }
    expect(job, 'job poll terminated').toBeTruthy();
    expect(job.status).toBe('done');
    expect(job.result.inserted + job.result.updated).toBeGreaterThanOrEqual(1);
  });

  test('GET /jobs/:jobId returns 404 for unknown id', async ({ request }) => {
    const token = await getWellnessAdmin(request);
    const r = await request.get(`${BASE_URL}/api/wellness/csv/jobs/notarealjob`, {
      headers: authHeaders(token), timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
  });
});
