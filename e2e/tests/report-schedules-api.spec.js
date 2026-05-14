// @ts-check
/**
 * Report Schedules API — sanitization + validation gate (#398/#447, #127, #171).
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
 *   as a documented carry-over. The original 8 tests in this spec closed
 *   that parity gap.
 *
 *   v3.4.14 extension (regression-coverage-backlog #20): adds enum +
 *   recipient-validation regression coverage for #127 + #171, the two
 *   issues that hardened report_schedules.js as an attack surface
 *   (PII exfil via "email arbitrary data anywhere" + silently saved
 *   bad recipients on save). The "enum + #171 tenant-bounded recipient"
 *   contracts had no per-push gate enforcement — only manual review of
 *   the route file. This extension pins them.
 *
 *   Drift note for #20: the gap card claims rejection emits code
 *   `PII_EXFIL_BLOCKED`. The route ACTUALLY emits `EXTERNAL_RECIPIENT_FORBIDDEN`
 *   (see backend/routes/report_schedules.js validateRecipientsAgainstTenant).
 *   The pen-test framing was the bug; this spec asserts the actual code.
 *
 *   Naming follows the project's `<area>-api.spec.js` gate convention.
 *   The existing `report_schedules.spec.js` (smoke + RBAC tests) stays as
 *   it was; this new spec adds focused sanitization + validation cases.
 *
 * Module under test: backend/routes/report_schedules.js
 * Mount point: /api/report-schedules (note: dash, not underscore — the
 *   route file uses underscore but server.js mounts it with a dash)
 *
 * Endpoints covered (sanitization + validation contract):
 *   POST  /api/report-schedules           — name + metrics + recipients
 *                                            sanitized via lib/sanitizeJson;
 *                                            reportType/format/frequency
 *                                            enum-checked; recipients
 *                                            tenant-bounded
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
 * Validation contract pinned (#127 + #171):
 *   - reportType ∈ {deals, contacts, tasks, calls, invoices, expenses}
 *     → 400 INVALID_REPORT_TYPE if outside set
 *   - format ∈ {PDF, CSV, XLSX} → 400 INVALID_REPORT_FORMAT if outside set
 *   - frequency ∈ {daily, weekly, monthly, quarterly} → 400 INVALID_FREQUENCY
 *     if outside set (NOT silently coerced to "weekly")
 *   - recipients[] every entry must be a User.email in this tenant →
 *     400 EXTERNAL_RECIPIENT_FORBIDDEN if any external domain present
 *   - recipients[] each entry must be syntactically valid email →
 *     400 INVALID_RECIPIENT if shape-bad (the row stays unsaved, not
 *     "silently saved as Active" per the original #127 framing)
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
const REQUEST_TIMEOUT = 60000;
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

// Retry-once helper for 5xx — demo's nginx upstream occasionally emits a
// transient 502 under e2e-full's 4-shard concurrent load. The route itself
// is healthy (solo PUT returns 200 cleanly); the blip is at the proxy
// layer. One re-fire after a brief settle is enough to clear it.
async function authPutWithRetry(request, path, body) {
  let res = await authPut(request, path, body);
  if (res.status() >= 500 && res.status() < 600) {
    await new Promise((r) => setTimeout(r, 500));
    res = await authPut(request, path, body);
  }
  return res;
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

    // v3.7.13 e2e-full hardening: this PUT occasionally hits a transient
    // 502 from demo's nginx upstream under 4-shard concurrent load. The
    // retry-once helper swallows the blip without bumping playwright's
    // 2-retry framework budget.
    const res = await authPutWithRetry(request, `/report-schedules/${id}`, {
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

// regression-coverage-backlog #20 — closes #127 (invalid email silently saved)
// + #171 (PII exfil via arbitrary external recipients + missing enum guards).
//
// DRIFT NOTE on the gap card:
//   The card says "→ 400 with PII_EXFIL_BLOCKED code". The route actually
//   emits `EXTERNAL_RECIPIENT_FORBIDDEN`. The contract — reject external
//   domains with a 400 + machine-readable code — is honoured; only the
//   string id of the code differs. Asserting the actual emitted code so
//   future renames break this spec rather than silently drift away from
//   the pen-test class. If the code ever DOES rename to PII_EXFIL_BLOCKED,
//   update this assertion and the route file in lockstep.
test.describe('Report Schedules API — recipient validation (#171, gap #20)', () => {
  test('POST rejects arbitrary external-domain recipient with 400 + EXTERNAL_RECIPIENT_FORBIDDEN', async ({ request }) => {
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} pii-exfil-attempt`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: ['attacker@unknown-evil-domain.com'],
      format: 'PDF',
    });
    expect(res.status(), `expected 400 for external recipient; got ${res.status()}: ${await res.text()}`).toBe(400);
    const body = await res.json();
    // Pin both the code AND the http status — defends against either drifting
    // (either an accidental 200, OR a code rename that loses the audit trail).
    expect(body.code).toBe('EXTERNAL_RECIPIENT_FORBIDDEN');
    expect(body.error).toMatch(/external/i);
  });

  test('POST rejects MIXED list (one valid tenant email + one external) — entire request 400s', async ({ request }) => {
    // Defensive — confirms the route doesn't silently filter out the bad
    // recipient and persist the row with just the valid one. All-or-nothing
    // is the correct contract; partial-persist would mask the exfil attempt.
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} mixed-recipients`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL, 'rogue@another-tenant.example'],
      format: 'PDF',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EXTERNAL_RECIPIENT_FORBIDDEN');
  });

  test('POST rejects shape-invalid email with 400 + INVALID_RECIPIENT (#127 — was silently saved as Active)', async ({ request }) => {
    // The original #127 finding: a recipient like "@@@" or "not-an-email"
    // would be persisted with enabled:true and the cron mailer would later
    // burn sender reputation trying to deliver. The fix: shape-check before
    // tenant-bounded check, and reject with a distinct code so the UI can
    // surface "fix the email format" vs "this recipient isn't in your tenant".
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} bad-shape-email`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: ['@@@'],
      format: 'PDF',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_RECIPIENT');
  });

  test('PUT rejects external-domain recipient on update (same gate as POST)', async ({ request }) => {
    // Seed a valid row first.
    const create = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} put-recipients-target`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(create.status()).toBe(201);
    const id = (await create.json()).id;
    createdIds.push(id);

    const res = await authPut(request, `/report-schedules/${id}`, {
      recipients: ['exfil@external-domain.example'],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EXTERNAL_RECIPIENT_FORBIDDEN');
  });
});

test.describe('Report Schedules API — enum validation (#171, gap #20)', () => {
  test('POST rejects unknown reportType with 400 + INVALID_REPORT_TYPE', async ({ request }) => {
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} bad-reportType`,
      reportType: 'NOT_A_TYPE',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_REPORT_TYPE');
    // Error message must enumerate the allowed set so the UI / partner-API
    // caller can surface a useful hint (vs a vague "bad request").
    expect(body.error).toMatch(/deals/i);
  });

  test('POST rejects unknown format (e.g. EXE) with 400 + INVALID_REPORT_FORMAT', async ({ request }) => {
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} bad-format`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'EXE',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_REPORT_FORMAT');
    expect(body.error).toMatch(/PDF/i);
  });

  test('POST accepts every documented reportType in the allowlist', async ({ request }) => {
    // Boundary-check — pins the allowlist as the source of truth so a future
    // rename in the route ALSO updates this list (or this test catches it).
    const allowed = ['deals', 'contacts', 'tasks', 'calls', 'invoices', 'expenses'];
    for (const rt of allowed) {
      const res = await authPost(request, '/report-schedules', {
        name: `${RUN_TAG} ok-reportType-${rt}`,
        reportType: rt,
        frequency: 'weekly',
        recipients: [ADMIN_EMAIL],
        format: 'PDF',
      });
      expect(res.status(), `reportType=${rt} should be accepted`).toBe(201);
      createdIds.push((await res.json()).id);
    }
  });

  test('PUT rejects unknown format on partial update', async ({ request }) => {
    const create = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} put-bad-format-target`,
      reportType: 'deals',
      frequency: 'weekly',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(create.status()).toBe(201);
    const id = (await create.json()).id;
    createdIds.push(id);

    const res = await authPut(request, `/report-schedules/${id}`, {
      format: 'DOCX',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_REPORT_FORMAT');
  });
});

test.describe('Report Schedules API — frequency contract (#171, gap #20)', () => {
  test('POST rejects unknown frequency (e.g. every-5-minutes) — NOT silently coerced to weekly', async ({ request }) => {
    // The headline #171 finding: the route used to take any frequency string
    // and either persist garbage or silently fall back to "weekly". Both
    // shapes fail the audit trail. Rejection with INVALID_FREQUENCY is the
    // correct contract: the API caller has to fix the input, not have it
    // silently rewritten.
    const res = await authPost(request, '/report-schedules', {
      name: `${RUN_TAG} bad-frequency`,
      reportType: 'deals',
      frequency: 'every-5-minutes',
      recipients: [ADMIN_EMAIL],
      format: 'PDF',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_FREQUENCY');
    expect(body.error).toMatch(/daily|weekly|monthly|quarterly/i);
  });

  test('POST accepts every documented frequency value', async ({ request }) => {
    const allowed = ['daily', 'weekly', 'monthly', 'quarterly'];
    for (const freq of allowed) {
      const res = await authPost(request, '/report-schedules', {
        name: `${RUN_TAG} ok-frequency-${freq}`,
        reportType: 'deals',
        frequency: freq,
        recipients: [ADMIN_EMAIL],
        format: 'PDF',
      });
      expect(res.status(), `frequency=${freq} should be accepted`).toBe(201);
      const body = await res.json();
      // Pin the no-coercion contract: what we sent is what got persisted,
      // not silently rewritten to "weekly".
      expect(body.frequency).toBe(freq);
      createdIds.push(body.id);
    }
  });
});
