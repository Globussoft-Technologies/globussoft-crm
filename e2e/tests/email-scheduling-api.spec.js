// @ts-check
/**
 * email-scheduling — gate spec.
 *
 * Mounted route: backend/routes/email_scheduling.js → /api/email-scheduling
 *
 * This is the per-push gate's regression-coverage partner to the broader
 * smoke spec at tests/email_scheduling.spec.js (release-validation-only).
 * Focuses specifically on the /send-now contract — both the success/auth
 * surface and the regression case that motivated this spec's existence:
 *
 *   /send-now upstream-rejected paths return 200 with `{success: false}`
 *   body, NOT 502.
 *
 * Why: Cloudflare/Nginx swallow backend 5xx bodies and substitute their
 * own HTML 502 error page. Pre-fix, the route returned 502 with a JSON
 * envelope carrying `code: SENDGRID_REJECTED` + `detail` so the SPA could
 * surface a useful error to the user — but the client only ever saw the
 * proxy's HTML page (curl: `error code: 502`). The body never made it.
 * Flip status to 200 with `success: false` so the JSON envelope reaches
 * the client; status code is no longer the discriminator. Truly-internal
 * failures (DB write fail, code bugs) keep their 5xx — those are genuine
 * server-error signals that should fail loudly.
 *
 * The deterministic regression test exploits the fact that CI's api_tests
 * gate does NOT set SENDGRID_API_KEY (grep .github/workflows/deploy.yml
 * confirms — no SENDGRID_* env block in api_tests' env). With no key the
 * sendSendGrid helper returns `{ sent: false, reason: "no_api_key" }`,
 * which hits the upstream-rejected branch with code=SENDGRID_NOT_CONFIGURED.
 * Same code path as a real SendGrid 4xx/5xx rejection — same envelope —
 * same response status. So this spec deterministically pins the contract
 * in CI without needing a real SendGrid stub or fault injection.
 *
 * Endpoints covered:
 *   POST /api/email-scheduling                  — auth + happy create (seed)
 *   POST /api/email-scheduling/:id/send-now     — auth + 404 + ALREADY_SENT
 *                                                 + main regression contract
 *   GET  /api/email-scheduling/:id              — confirms FAILED status
 *                                                 + errorMessage persisted
 *   DELETE /api/email-scheduling/:id            — cleanup
 *
 * Standing rules pinned by this spec:
 *   - JWT body strips id|createdAt|updatedAt|tenantId|userId — schedule
 *     POST uses targetable fields only.
 *   - Cleanup tags every created row with RUN_TAG so afterAll's DELETE
 *     loop catches stragglers; subjects also use the E2E_AUDIT_ prefix
 *     covered by e2e/test-data-patterns.js TEST_NAME_PATTERNS.
 *   - Spec uses real-looking recipient names ("Priya Sharma", "Arjun
 *     Patel") per the realistic-test-data convention, not "E2E Test
 *     User" placeholders.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_AUDIT_SENDNOW_${Date.now()}`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdScheduledIds = [];

// Sequential — /send-now mutates row state (PENDING → SENT/FAILED) and
// later assertions inspect persisted errorMessage from the same row.
test.describe.configure({ mode: 'serial' });

async function loginAsAdmin(request) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.ok(), `admin login must succeed: ${await r.text()}`).toBeTruthy();
  const body = await r.json();
  expect(body.token).toBeTruthy();
  return body.token;
}

async function createScheduledEmail(request, recipientName, subjectSuffix) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const r = await request.post(`${API}/email-scheduling`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      to: `${recipientName}+${RUN_TAG}@globussoft.com`,
      subject: `${RUN_TAG}_${subjectSuffix}`,
      body: `${RUN_TAG} — gate spec exercising /send-now contract`,
      scheduledFor: tomorrow,
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.status()).toBe(201);
  const body = await r.json();
  expect(body.id).toBeTruthy();
  expect(body.status).toBe('PENDING');
  createdScheduledIds.push(body.id);
  return body;
}

test.describe('email-scheduling /send-now contract', () => {
  test.beforeAll(async ({ request }) => {
    adminToken = await loginAsAdmin(request);
  });

  test.afterAll(async ({ request }) => {
    const headers = { Authorization: `Bearer ${adminToken}` };
    for (const id of createdScheduledIds) {
      await request
        .delete(`${API}/email-scheduling/${id}`, { headers, timeout: REQUEST_TIMEOUT })
        .catch(() => {});
    }
  });

  test('POST /send-now requires auth', async ({ request }) => {
    const r = await request.post(`${API}/email-scheduling/1/send-now`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test('POST /send-now on missing id returns 404 with code', async ({ request }) => {
    const r = await request.post(`${API}/email-scheduling/9999999/send-now`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe('SCHEDULED_EMAIL_NOT_FOUND');
  });

  test('POST /send-now upstream-rejected returns 200 with {success:false, code, detail}', async ({
    request,
  }) => {
    // Regression case — the proxy-body-swallow fix.
    //
    // CI's api_tests gate does NOT set SENDGRID_API_KEY, so sendSendGrid
    // returns `{ sent: false, reason: "no_api_key" }` deterministically.
    // The route's upstream-rejected branch fires with
    // code=SENDGRID_NOT_CONFIGURED (same envelope shape as
    // SENDGRID_REJECTED — they share the response builder).
    //
    // On demo (e2e-full release-validation), SENDGRID_API_KEY IS set, so
    // this test exercises the real provider path. SendGrid will accept
    // (success: true) OR reject with `code: SENDGRID_REJECTED` + a real
    // detail string (e.g. "The from address does not match a verified
    // Sender Identity"). Both shapes are 200 + JSON, both carry
    // `body.success`, both leave the row's status reflecting the outcome.
    // Spec accepts either — what we PIN is the envelope shape, not the
    // success/failure outcome.
    const created = await createScheduledEmail(request, 'priya.sharma', 'send_now_regression');

    const r = await request.post(`${API}/email-scheduling/${created.id}/send-now`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });

    // Load-bearing: 200 — NOT 502. The whole point of this spec.
    expect(
      r.status(),
      `Expected 200; if 502 the proxy-body-swallow fix has regressed (Cloudflare/Nginx will eat the JSON body)`,
    ).toBe(200);

    const ctype = r.headers()['content-type'] || '';
    expect(ctype).toContain('application/json');

    const body = await r.json();
    expect(body).toHaveProperty('success');
    expect(typeof body.success).toBe('boolean');

    if (body.success === true) {
      // CI-only-when-key-set OR demo with verified sender: the send went
      // through. Row should be SENT.
      expect(body.delivered).toBe(true);
      expect(body.record).toBeTruthy();
      expect(body.record.status).toBe('SENT');
    } else {
      // The regression case. CI without SENDGRID_API_KEY hits this every
      // time → SENDGRID_NOT_CONFIGURED. Demo without verified sender
      // hits SENDGRID_REJECTED. Both are 200, both carry the same shape.
      expect(body.delivered).toBe(false);
      expect(body.record).toBeTruthy();
      expect(body.record.status).toBe('FAILED');
      expect(['SENDGRID_NOT_CONFIGURED', 'SENDGRID_REJECTED']).toContain(body.code);
      expect(typeof body.detail).toBe('string');
      expect(body.detail.length).toBeGreaterThan(0);
      // Detail is sanitised + length-capped at 200 chars in the route.
      expect(body.detail.length).toBeLessThanOrEqual(200);
    }
  });

  test('GET /:id reflects send-now outcome (errorMessage persisted on FAILED)', async ({
    request,
  }) => {
    // The previous test left a row at SENT or FAILED. Either way, GET
    // should reflect it. If FAILED, errorMessage MUST be populated — the
    // contract that lets `GET /api/email-scheduling/:id` recover the
    // diagnostic that the proxy used to swallow.
    const id = createdScheduledIds[createdScheduledIds.length - 1];
    test.skip(!id, 'previous test did not create a row');

    const r = await request.get(`${API}/email-scheduling/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(['SENT', 'FAILED']).toContain(body.status);
    if (body.status === 'FAILED') {
      expect(body.errorMessage).toBeTruthy();
      expect(typeof body.errorMessage).toBe('string');
      // errorMessage is widened to @db.Text + sliced to 4000 chars in the
      // route (#524 follow-up). Pin both: must exist, must respect cap.
      expect(body.errorMessage.length).toBeLessThanOrEqual(4000);
    }
  });

  test('POST /send-now adds Sender-Identity hint when SendGrid rejects on unverified sender', async ({
    request,
  }) => {
    // Operator-facing surface: when the SendGrid rejection's `reason`
    // matches an unverified-Sender-Identity fingerprint, the route adds
    // a `hint` field pointing the operator at the SendGrid dashboard
    // URL. This lets QA tell at a glance whether a 200+success:false
    // response is a code regression or an unfinished dashboard step
    // (B-03 SendGrid Sender Identity verification).
    //
    // CI without SENDGRID_API_KEY → reason="no_api_key" — does NOT match
    //                               the fingerprint → no hint expected.
    // CI/demo with key + unverified sender → reason contains "verified
    //                               Sender Identity" → hint MUST appear.
    // CI/demo with key + verified sender → success:true → no hint, no
    //                               failure path exercised.
    //
    // Spec asserts the contract IF the failure path fires AND its detail
    // matches the fingerprint; otherwise skips silently. The hint string
    // itself is pinned: must contain the dashboard URL so QA can click
    // through directly.
    const created = await createScheduledEmail(request, 'priya.sharma', 'sendgrid_hint_check');

    const r = await request.post(`${API}/email-scheduling/${created.id}/send-now`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();

    if (body.success === true) {
      test.skip(true, 'sender verified — hint failure path not exercised');
      return;
    }

    // Failure path. Inspect the detail string to decide whether the hint
    // SHOULD have been added. The fingerprint mirrors sendGridHintFor()
    // in routes/email_scheduling.js.
    const detail = String(body.detail || '');
    const looksLikeUnverified =
      /verified\s+sender\s+identity|sender\s+identity\s+verification|do(?:es)?\s+not\s+match\s+a\s+verified/i.test(
        detail,
      );

    if (looksLikeUnverified) {
      // The hint MUST appear and MUST point at the SendGrid sender_auth
      // page. QA reads this directly from the response.
      expect(body.hint, `hint missing on unverified-sender rejection: ${detail}`).toBeTruthy();
      expect(body.hint).toMatch(/sendgrid\.com\/settings\/sender_auth/);
    } else {
      // Other failure modes (no_api_key, transient 5xx, rate-limit) MUST
      // NOT add a misleading hint about Sender Identity.
      expect(body.hint).toBeFalsy();
    }
  });

  test('POST /send-now on already-SENT row returns 400 with ALREADY_SENT', async ({
    request,
  }) => {
    // Skip unless the previous test left the row at SENT (CI never gets
    // here unless SENDGRID_API_KEY is configured — currently no). Demo
    // with a verified sender exercises this.
    const id = createdScheduledIds[createdScheduledIds.length - 1];
    test.skip(!id, 'no previous row');

    const get = await request.get(`${API}/email-scheduling/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    const row = await get.json();
    test.skip(row.status !== 'SENT', 'row not in SENT state — provider rejected; ALREADY_SENT path not exercised');

    const r = await request.post(`${API}/email-scheduling/${id}/send-now`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('ALREADY_SENT');
  });
});
