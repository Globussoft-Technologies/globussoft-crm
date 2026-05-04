// @ts-check
/**
 * Report Schedules API — sanitization gate (#398/#447 class).
 *
 * Why this spec exists:
 *   The v3.4.10 audit (commit 68e6c5b) identified routes/report_schedules.js
 *   as one of 4 routes writing JSON-blob columns (`String? @db.Text` storing
 *   JSON) without HTML sanitization — same XSS class as #398 (Sequence.name)
 *   and #447 (LandingPage components). Three of the four were closed in the
 *   v3.4.11 sweep with regression-spec coverage:
 *     - lead_routing.js + lead-routing-api.spec.js   (097ef5a, 4 tests)
 *     - ab_tests.js     + ab-tests-api.spec.js       (6a9e450, 4 tests)
 *     - marketing.js    + marketing-api.spec.js      (a916f59, 4 tests)
 *   report_schedules.js's route fix landed in a916f59 too, but the existing
 *   `report_schedules.spec.js` is UI-shaped and not wired into the per-push
 *   gate — leaving the route's regression-coverage parity with the other 3
 *   as a documented carry-over. THIS spec closes that parity gap.
 *
 *   Naming follows the project's `<area>-api.spec.js` gate convention.
 *   The existing `report_schedules.spec.js` (smoke + RBAC tests) stays as
 *   it was; this new spec adds focused sanitization regression cases.
 *
 * Module under test: backend/routes/report_schedules.js
 * Mount point: /api/report-schedules (note: dash, not underscore — the
 *   route file uses underscore but server.js mounts it with a dash)
 *
 * Endpoints covered (sanitization contract):
 *   POST  /api/report-schedules           — name + metrics + recipients
 *                                            sanitized via lib/sanitizeJson
 *   PUT   /api/report-schedules/:id       — same fields on partial update
 *   DELETE /api/report-schedules/:id      — used by afterAll cleanup
 *
 * Sanitization contract pinned (v3.4.11 a916f59):
 *   - name → sanitizeText (HTML stripped, merge-tags preserved)
 *   - metrics → sanitizeJsonForStringColumn (JSON array; HTML stripped from
 *     each element, merge-tags preserved, stringified for `String? @db.Text`)
 *   - recipients → sanitizeJsonForStringColumn (already tenant-validated by
 *     #171's validateRecipientsAgainstTenant; sanitization is no-op for
 *     legitimate emails — defense-in-depth in case validation has a bypass)
 *
 * Test environment:
 *   - BASE_URL — defaults to https://crm.globusdemos.com
 *   - admin@globussoft.com / password123 (generic CRM tenant; tenantId=1).
 *     Used as both the requesting actor AND the recipient email so the
 *     #171 tenant-bounded recipient check passes.
 *
 * RUN_TAG: E2E_FLOW_RPT_SCHED_<ts>. Caught by the `^E2E_FLOW_` regex on
 * e2e/test-data-patterns.js so global-teardown sweeps any straggler.
 *
 * Cleanup: /api/report-schedules/:id DELETE exists; afterAll calls it on
 * every created id. Mirror of report_schedules.spec.js's pattern.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_RPT_SCHED_${Date.now()}`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
const createdIds = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

async function authPost(request, path, body) {
  return request.post(`${API}${path}`, {
    headers: { ...auth(), 'Content-Type': 'application/json' },
    data: body,
    timeout: REQUEST_TIMEOUT,
  });
}

async function authPut(request, path, body) {
  return request.put(`${API}${path}`, {
    headers: { ...auth(), 'Content-Type': 'application/json' },
    data: body,
    timeout: REQUEST_TIMEOUT,
  });
}

async function authDelete(request, path) {
  return request.delete(`${API}${path}`, {
    headers: auth(),
    timeout: REQUEST_TIMEOUT,
  });
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${API}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(login.ok(), 'admin login must succeed').toBeTruthy();
  token = (await login.json()).token;
  expect(token).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  if (!token) return;
  for (const id of createdIds) {
    try {
      await authDelete(request, `/report-schedules/${id}`);
    } catch (_e) { /* best-effort cleanup */ }
  }
});

test.describe('Report Schedules API — sanitization (#398/#447 class, v3.4.10 audit)', () => {
  test('POST strips HTML from schedule name', async ({ request }) => {
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} <img src=x onerror=alert(1)>safe-name`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    createdIds.push(body.id);
    expect(body.name).not.toMatch(/<img/i);
    expect(body.name).not.toMatch(/onerror/i);
    expect(body.name).toContain('safe-name');
  });

  test('POST sanitizes HTML inside metrics JSON array', async ({ request }) => {
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} metrics-xss-target`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
      metrics: [
        '<script>alert(1)</script>revenue',
        '<img onerror=alert(2)>count',
        'plain-metric',
      ],
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdIds.push(body.id);
    // metrics is stored as a JSON-encoded string; the route returns it
    // verbatim from the DB row. Stringified for assertion regardless of
    // shape (the route returns raw string from the column, which is
    // already JSON-stringified).
    const metricsStr = typeof body.metrics === 'string'
      ? body.metrics
      : JSON.stringify(body.metrics);
    expect(metricsStr).not.toMatch(/<script/i);
    expect(metricsStr).not.toMatch(/<img/i);
    expect(metricsStr).not.toMatch(/onerror/i);
    expect(metricsStr).toContain('revenue');
    expect(metricsStr).toContain('count');
    expect(metricsStr).toContain('plain-metric');
  });

  test('POST sanitizes recipients (defense-in-depth; #171 already gates against bypass)', async ({ request }) => {
    // Note: #171's validateRecipientsAgainstTenant rejects recipients that
    // aren't in the tenant's User.email allow-list — so a payload like
    // `["<script>...</script>@test.local"]` would 400 before reaching the
    // sanitizer. This test pins the no-op-for-valid-emails contract:
    // legitimate tenant emails pass through unchanged.
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} recipients-passthrough`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdIds.push(body.id);
    const recipStr = typeof body.recipients === 'string'
      ? body.recipients
      : JSON.stringify(body.recipients);
    // The legitimate email survives sanitization unchanged.
    expect(recipStr).toContain(ADMIN_EMAIL);
  });

  test('PUT strips HTML from name on partial update', async ({ request }) => {
    // Seed a row to update.
    const create = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} put-target`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(create.status()).toBe(201);
    const id = (await create.json()).id;
    createdIds.push(id);

    const res = await authPut(request, `/report-schedules/${id}`, {
      name: `<a href="javascript:alert(1)">Updated</a>name`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).not.toMatch(/<a /i);
    expect(body.name).not.toMatch(/javascript:/i);
    expect(body.name).toContain('Updated');
  });

  test('PUT sanitizes metrics on partial update', async ({ request }) => {
    const create = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} put-metrics-target`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(create.status()).toBe(201);
    const id = (await create.json()).id;
    createdIds.push(id);

    const res = await authPut(request, `/report-schedules/${id}`, {
      metrics: ['<style>x{}</style>updated-metric', 'plain'],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const metricsStr = typeof body.metrics === 'string'
      ? body.metrics
      : JSON.stringify(body.metrics);
    expect(metricsStr).not.toMatch(/<style/i);
    expect(metricsStr).toContain('updated-metric');
    expect(metricsStr).toContain('plain');
  });

  test('merge tags ({{firstName}}) survive sanitization in name + metrics', async ({ request }) => {
    // Defensive — pins that sanitize-html's allowedTags:[] config only
    // strips <…>-shaped tokens, not {{…}} merge tags. Same contract
    // verified across the other 3 routes in the v3.4.11 sweep.
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} Hello {{firstName}}`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
      metrics: ['Hi {{firstName}} from {{company}}', 'plain'],
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdIds.push(body.id);
    expect(body.name).toContain('{{firstName}}');
    const metricsStr = typeof body.metrics === 'string'
      ? body.metrics
      : JSON.stringify(body.metrics);
    expect(metricsStr).toContain('{{firstName}}');
    expect(metricsStr).toContain('{{company}}');
  });
});

test.describe('Report Schedules API — auth gate (sanity)', () => {
  test('POST without token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/report-schedules`, {
      data: { name: 'x', reportType: 'deals' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT without token → 401/403', async ({ request }) => {
    const res = await request.put(`${API}/report-schedules/1`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});
