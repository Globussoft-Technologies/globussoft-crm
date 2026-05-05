// @ts-check
/**
 * Communications module — backend coverage push.
 *
 * routes/communications.js was 32.05% covered. The file is a slim CRUD
 * router for the unified inbox (emails + calls) plus the email tracking
 * pixel + click redirect that get embedded in outbound mail:
 *
 *   GET    /api/communications/inbox            — auth + tenant-scoped
 *                                                 EmailMessage list (50 cap)
 *   POST   /api/communications/send-email       — auth + creates EmailMessage
 *                                                 + EmailTracking pixel row +
 *                                                 best-effort Activity for
 *                                                 contactId; returns
 *                                                 {success, delivered, email}
 *   GET    /api/communications/calls            — auth + tenant-scoped CallLog list
 *   POST   /api/communications/log-call         — auth + creates CallLog (201)
 *   GET    /api/communications/track/:id/open.gif  — PUBLIC, stamps openedAt
 *                                                    on EmailTracking + returns
 *                                                    1x1 image/gif
 *   GET    /api/communications/track/:id/click  — PUBLIC, stamps clickedAt
 *                                                 + redirects to ?url
 *   GET    /api/communications/tracking/:emailId — auth + returns
 *                                                  {emailId, opens, clicks, events}
 *
 * Heads-up on the openPath fix that ships in this commit. Before this run,
 * the global guard's openPath was `/communications/track` (no trailing
 * slash). Because the guard uses `req.path.startsWith(p)`, that prefix
 * also matched `/communications/tracking/:emailId` — so the auth-required
 * stats endpoint was bypassing `verifyToken`, then crashing 500 inside the
 * handler when it tried to read `req.user.tenantId`. The CHANGELOG v3.2.3
 * audit comment (`/communications/tracking … correctly require auth`) was
 * wrong for that reason. Trailing slash on the openPath fixes the
 * prefix collision; the spec verifies both halves of the contract:
 * pixel/click stay public, stats requires auth.
 *
 * SendGrid is not configured on CI (no SENDGRID_API_KEY env var) so the
 * route's `sendSendGrid()` falls into the `no_api_key` branch and returns
 * `{sent: false, reason: 'no_api_key'}`. The handler still creates the
 * EmailMessage + EmailTracking rows and responds 200 with
 * `{success: true, delivered: false, email}`. Demo box happens to have
 * SendGrid configured so its `delivered` field is `true`; spec accepts both.
 *
 * Pattern: cached-token / authXyz helpers identical to push-api.spec.js
 * and estimates-api.spec.js. Test data tagged `E2E_COMM_<ts>`. afterAll
 * is a no-op — the route doesn't expose DELETE for emails or calls and
 * test data is benign + tagged.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
const RUN_TAG = `E2E_COMM_${Date.now()}`;

async function getAuthToken(request) {
  if (authToken) return authToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: 'admin@globussoft.com', password: 'password123' },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        authToken = data.token;
        return authToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const auth = async (request) => ({ Authorization: `Bearer ${await getAuthToken(request)}` });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}
async function authPost(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// Helper: send an email through the route, return {emailId, trackingId}. The
// trackingId isn't returned by POST /send-email — we recover it from
// GET /tracking/:emailId, which is the canonical way to pair an email with
// its tracking row.
async function sendAndGetTracking(request, opts = {}) {
  const sendRes = await authPost(request, '/api/communications/send-email', {
    to: opts.to || `e2e-${Date.now()}@example.com`,
    subject: `${RUN_TAG} ${opts.subject || 'probe'}`,
    body: opts.body || 'spec-generated email body',
    ...(opts.contactId !== undefined ? { contactId: opts.contactId } : {}),
  });
  expect(sendRes.status(), `send-email: ${await sendRes.text()}`).toBe(200);
  const sendBody = await sendRes.json();
  const emailId = sendBody.email.id;

  const statsRes = await authGet(request, `/api/communications/tracking/${emailId}`);
  expect(statsRes.status(), `tracking lookup for emailId=${emailId}: ${await statsRes.text()}`).toBe(200);
  const stats = await statsRes.json();
  expect(stats.events.length).toBeGreaterThan(0);
  return { emailId, trackingId: stats.events[0].trackingId };
}

// ─── GET /api/communications/inbox ─────────────────────────────────

test.describe('Communications API — GET /inbox', () => {
  test('200 returns array (tenant-scoped)', async ({ request }) => {
    const res = await authGet(request, '/api/communications/inbox');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('newly-sent email appears in inbox', async ({ request }) => {
    const subject = `${RUN_TAG} inbox-roundtrip`;
    const send = await authPost(request, '/api/communications/send-email', {
      to: 'inbox-probe@example.com',
      subject,
      body: 'roundtrip',
    });
    expect(send.status()).toBe(200);
    const inbox = await authGet(request, '/api/communications/inbox');
    expect(inbox.status()).toBe(200);
    const list = await inbox.json();
    // The cap is 50 so the newly-sent row should still be in there.
    expect(list.some((e) => e.subject === subject)).toBe(true);
  });
});

// ─── POST /api/communications/send-email ───────────────────────────

test.describe('Communications API — POST /send-email', () => {
  test('400 when "to" is missing', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      subject: `${RUN_TAG} no-to`,
      body: 'x',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/recipient.*subject/i);
  });

  test('400 when "subject" is missing', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      to: 'no-subject@example.com',
      body: 'x',
    });
    expect(res.status()).toBe(400);
  });

  test('400 when both "to" and "subject" are missing', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      body: 'orphan',
    });
    expect(res.status()).toBe(400);
  });

  test('200 with {success, delivered, email} on valid send', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      to: 'happy-path@example.com',
      subject: `${RUN_TAG} happy`,
      body: 'happy body',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.delivered).toBe('boolean'); // true on demo (SendGrid configured), false on CI (no key)
    expect(body.email).toBeTruthy();
    expect(body.email.id).toEqual(expect.any(Number));
    expect(body.email.subject).toBe(`${RUN_TAG} happy`);
    expect(body.email.direction).toBe('OUTBOUND');
    expect(body.email.read).toBe(true);
  });

  test('persists EmailMessage row + EmailTracking pixel row', async ({ request }) => {
    const { emailId, trackingId } = await sendAndGetTracking(request, {
      subject: 'persist-rows',
    });
    expect(emailId).toEqual(expect.any(Number));
    expect(typeof trackingId).toBe('string');
    expect(trackingId.length).toBeGreaterThan(0);
  });

  test('contactId attaches the email to a contact (best-effort Activity)', async ({ request }) => {
    // Pull any contact id; if the tenant has none, skip.
    const cs = await authGet(request, '/api/contacts?limit=1');
    let contactId = null;
    if (cs.ok()) {
      const list = await cs.json();
      const rows = Array.isArray(list) ? list : (list.rows || list.data || []);
      contactId = rows[0]?.id ?? null;
    }
    test.skip(!contactId, 'tenant has no contacts to attach to');

    const res = await authPost(request, '/api/communications/send-email', {
      to: 'with-contact@example.com',
      subject: `${RUN_TAG} contact-attached`,
      body: 'attached',
      contactId,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.email.contactId).toBe(contactId);
  });
});

// ─── #435 multi-recipient (envelope shape) ─────────────────────────
//
// Pre-#435: POST /send-email validated `to` as a single email; comma-separated
// strings were treated as one recipient and rejected by isValidEmail with 400.
// Post-#435: parseRecipients() splits on comma + dedupes + per-recipient sends;
// response is the envelope shape `{ totalSent, totalFailed, results, failures }`
// on TOP of the back-compat top-level `email` + `messageId` keys.
//
// What this asserts:
//   - Single-recipient invocation keeps top-level `email` populated (back-compat
//     for the Inbox / DocumentTemplates / pre-existing 50+ specs that destructure
//     `body.email.id`).
//   - 2+ recipients fan out into N EmailMessage rows + N tracking pixels (one
//     SendGrid call per recipient — no BCC).
//   - `totalSent` / `totalFailed` reflect SendGrid-acceptance count (CI without
//     SENDGRID_API_KEY → totalSent=0, totalFailed=N; demo → matches valid count).
//   - Mixed valid + invalid: 200 with envelope, valid recipients delivered,
//     invalids surfaced in `failures` (NOT a 400 — partial success is success).
//   - All-invalid: 400 with `failures` enumerated.
//   - Whitespace + trailing-comma + duplicate handling per parseRecipients()
//     contract.
test.describe('Communications API — POST /send-email multi-recipient (#435)', () => {
  test('single recipient keeps top-level email populated (back-compat)', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      to: 'single@example.com',
      subject: `${RUN_TAG} single-back-compat`,
      body: 'single-recipient back-compat probe',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Pre-#435 contract preserved
    expect(body.success).toBe(true);
    expect(body.email).toBeTruthy();
    expect(body.email.id).toEqual(expect.any(Number));
    expect(body.email.to).toBe('single@example.com');
    // Post-#435 envelope additions
    expect(body.totalSent + body.totalFailed).toBe(1);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBe(1);
    expect(body.results[0].to).toBe('single@example.com');
    expect(Array.isArray(body.failures)).toBe(true);
    expect(body.failures.length).toBe(0);
  });

  test('comma-separated 3 recipients → 3 EmailMessage rows + envelope', async ({ request }) => {
    const subject = `${RUN_TAG} multi-3`;
    const res = await authPost(request, '/api/communications/send-email', {
      to: 'a@example.com, b@example.com,c@example.com',
      subject,
      body: '3-recipient fan-out probe',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.results.length).toBe(3);
    expect(body.results.map(r => r.to).sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    // Each result has its own EmailMessage id (no row reuse across recipients)
    const ids = body.results.map(r => r.email.id);
    expect(new Set(ids).size).toBe(3);
    // Each row has the canonical OUTBOUND/read fields set
    for (const r of body.results) {
      expect(r.email.direction).toBe('OUTBOUND');
      expect(r.email.read).toBe(true);
      expect(r.email.subject).toBe(subject);
    }
    // Top-level back-compat: `email` is the FIRST result (deterministic order)
    expect(body.email.id).toBe(body.results[0].email.id);
    // No invalid pre-flight failures
    expect(body.failures.length).toBe(0);
    // Inbox should now contain all 3 (subject is unique enough to find them)
    const inbox = await authGet(request, '/api/communications/inbox');
    expect(inbox.status()).toBe(200);
    const list = await inbox.json();
    const matching = list.filter(e => e.subject === subject);
    expect(matching.length).toBe(3);
  });

  test('whitespace + trailing comma + duplicate are normalized', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      to: '  alpha@example.com , beta@example.com,, alpha@example.com ,',
      subject: `${RUN_TAG} normalize`,
      body: 'normalize probe',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // alpha is deduped, beta kept, empties dropped → 2 unique recipients
    expect(body.results.length).toBe(2);
    expect(body.results.map(r => r.to).sort()).toEqual(['alpha@example.com', 'beta@example.com']);
  });

  test('mixed valid + invalid → 200 with valid sent + invalid in failures (partial success)', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      to: 'good@example.com, not-an-email, also-bad@',
      subject: `${RUN_TAG} mixed-validity`,
      body: 'mixed probe',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.results.length).toBe(1);
    expect(body.results[0].to).toBe('good@example.com');
    expect(body.failures.length).toBe(2);
    expect(body.failures.map(f => f.to).sort()).toEqual(['also-bad@', 'not-an-email']);
    for (const f of body.failures) {
      expect(f.reason).toBe('invalid_recipient_email');
    }
  });

  test('all-invalid → 400 with failures enumerated (no DB rows created)', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      to: 'not-an-email, also-bad@, ,',
      subject: `${RUN_TAG} all-invalid`,
      body: 'all-invalid probe',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no valid recipient/i);
    expect(Array.isArray(body.failures)).toBe(true);
    expect(body.failures.length).toBe(2);
  });

  test('comma-only / whitespace-only "to" → 400 (no parsable recipient)', async ({ request }) => {
    const res = await authPost(request, '/api/communications/send-email', {
      to: ' , , ',
      subject: `${RUN_TAG} empty-after-parse`,
      body: 'empty probe',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/no valid recipient/i);
  });
});

// ─── GET /api/communications/calls ─────────────────────────────────

test.describe('Communications API — GET /calls', () => {
  test('200 returns array (tenant-scoped)', async ({ request }) => {
    const res = await authGet(request, '/api/communications/calls');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

// ─── POST /api/communications/log-call ─────────────────────────────

test.describe('Communications API — POST /log-call', () => {
  test('201 with default direction=OUTBOUND when not specified', async ({ request }) => {
    const res = await authPost(request, '/api/communications/log-call', {
      duration: 42,
      notes: `${RUN_TAG} default-direction`,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.duration).toBe(42);
    expect(body.direction).toBe('OUTBOUND');
    expect(body.notes).toContain(RUN_TAG);
  });

  test('201 with explicit direction=INBOUND', async ({ request }) => {
    const res = await authPost(request, '/api/communications/log-call', {
      duration: 60,
      notes: `${RUN_TAG} inbound-direction`,
      direction: 'INBOUND',
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).direction).toBe('INBOUND');
  });

  test('201 without contactId (orphan call log)', async ({ request }) => {
    const res = await authPost(request, '/api/communications/log-call', {
      duration: 15,
      notes: `${RUN_TAG} no-contact`,
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).contactId).toBeNull();
  });

  test('201 stores recordingUrl when provided', async ({ request }) => {
    const url = 'https://recordings.example.com/abc.mp3';
    const res = await authPost(request, '/api/communications/log-call', {
      duration: 90,
      notes: `${RUN_TAG} with-recording`,
      recordingUrl: url,
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).recordingUrl).toBe(url);
  });

  test('duration is parseInt-coerced from string', async ({ request }) => {
    const res = await authPost(request, '/api/communications/log-call', {
      duration: '120',
      notes: `${RUN_TAG} parsed-duration`,
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).duration).toBe(120);
  });
});

// ─── GET /api/communications/track/:trackingId/open.gif (PUBLIC) ────

test.describe('Communications API — GET /track/:id/open.gif (public pixel)', () => {
  test('public: no auth required + responds with image/gif', async ({ request }) => {
    const { trackingId } = await sendAndGetTracking(request, { subject: 'pixel-content-type' });
    const res = await request.get(
      `${BASE_URL}/api/communications/track/${trackingId}/open.gif`,
      { timeout: REQUEST_TIMEOUT }
    );
    expect(res.status()).toBe(200);
    expect((res.headers()['content-type'] || '').toLowerCase()).toContain('image/gif');
    const buf = await res.body();
    // 1x1 transparent GIF is 43 bytes; allow a bit of wiggle for any framing.
    expect(buf.length).toBeGreaterThan(20);
    expect(buf.length).toBeLessThan(200);
  });

  test('hitting the pixel stamps openedAt — opens count goes up', async ({ request }) => {
    const { emailId, trackingId } = await sendAndGetTracking(request, { subject: 'pixel-stamps-open' });
    const before = await authGet(request, `/api/communications/tracking/${emailId}`);
    const opensBefore = (await before.json()).opens;
    expect(opensBefore).toBe(0);

    await request.get(
      `${BASE_URL}/api/communications/track/${trackingId}/open.gif`,
      { timeout: REQUEST_TIMEOUT }
    );

    const after = await authGet(request, `/api/communications/tracking/${emailId}`);
    expect((await after.json()).opens).toBe(1);
  });

  test('unknown trackingId still returns the GIF (silent — pixel must never break)', async ({ request }) => {
    const res = await request.get(
      `${BASE_URL}/api/communications/track/does-not-exist-${Date.now()}/open.gif`,
      { timeout: REQUEST_TIMEOUT }
    );
    expect(res.status()).toBe(200);
    expect((res.headers()['content-type'] || '').toLowerCase()).toContain('image/gif');
  });
});

// ─── GET /api/communications/track/:trackingId/click (PUBLIC) ───────

test.describe('Communications API — GET /track/:id/click (public redirect)', () => {
  test('public: redirects to ?url query param', async ({ request }) => {
    const { trackingId } = await sendAndGetTracking(request, { subject: 'click-redirect' });
    const target = 'https://example.com/landing';
    const res = await request.get(
      `${BASE_URL}/api/communications/track/${trackingId}/click?url=${encodeURIComponent(target)}`,
      { maxRedirects: 0, timeout: REQUEST_TIMEOUT }
    );
    // Express res.redirect() defaults to 302 Found.
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()['location']).toBe(target);
  });

  test('without ?url, redirects to "/"', async ({ request }) => {
    const { trackingId } = await sendAndGetTracking(request, { subject: 'click-no-url' });
    const res = await request.get(
      `${BASE_URL}/api/communications/track/${trackingId}/click`,
      { maxRedirects: 0, timeout: REQUEST_TIMEOUT }
    );
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()['location']).toBe('/');
  });

  test('hitting click stamps clickedAt — clicks count goes up', async ({ request }) => {
    const { emailId, trackingId } = await sendAndGetTracking(request, { subject: 'click-stamps' });
    const before = await authGet(request, `/api/communications/tracking/${emailId}`);
    expect((await before.json()).clicks).toBe(0);

    await request.get(
      `${BASE_URL}/api/communications/track/${trackingId}/click?url=https://example.com/x`,
      { maxRedirects: 0, timeout: REQUEST_TIMEOUT }
    );

    const after = await authGet(request, `/api/communications/tracking/${emailId}`);
    expect((await after.json()).clicks).toBe(1);
  });
});

// ─── GET /api/communications/tracking/:emailId (auth required) ──────

test.describe('Communications API — GET /tracking/:emailId (stats)', () => {
  test('200 with {emailId, opens, clicks, events} shape on a valid email', async ({ request }) => {
    const { emailId } = await sendAndGetTracking(request, { subject: 'stats-shape' });
    const res = await authGet(request, `/api/communications/tracking/${emailId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.emailId).toBe(emailId);
    expect(typeof body.opens).toBe('number');
    expect(typeof body.clicks).toBe('number');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(1); // at least the open-pixel row
  });

  test('events row carries trackingId + type + timestamps', async ({ request }) => {
    const { emailId } = await sendAndGetTracking(request, { subject: 'stats-event-shape' });
    const res = await authGet(request, `/api/communications/tracking/${emailId}`);
    const body = await res.json();
    const row = body.events[0];
    expect(typeof row.trackingId).toBe('string');
    expect(['open', 'click']).toContain(row.type);
    expect(row).toHaveProperty('createdAt');
  });

  test('returns shape with zero counts for an emailId that has no tracking rows', async ({ request }) => {
    // 99999999 is not a real email row; findMany returns []; counts are 0.
    const res = await authGet(request, '/api/communications/tracking/99999999');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.emailId).toBe(99999999);
    expect(body.opens).toBe(0);
    expect(body.clicks).toBe(0);
    expect(body.events).toEqual([]);
  });
});

// ─── Auth gate ──────────────────────────────────────────────────────

test.describe('Communications API — auth gate', () => {
  test('GET /inbox without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/communications/inbox`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /send-email without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/communications/send-email`, {
      data: { to: 'x@example.com', subject: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /calls without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/communications/calls`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /log-call without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/communications/log-call`, {
      data: { duration: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /tracking/:id without token → 401/403 (no longer leaks via /track openPath collision)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/communications/tracking/1`);
    // Pre-fix, this path slipped through openPath `/communications/track`.startsWith.
    // Post-fix, the global guard blocks it.
    expect([401, 403]).toContain(res.status());
  });

  test('GET /track/:id/open.gif WITHOUT token still works (public pixel)', async ({ request }) => {
    // Sanity: the openPath fix only narrowed it from `/track` to `/track/`.
    // The pixel path still matches and stays public.
    const res = await request.get(`${BASE_URL}/api/communications/track/no-such-id/open.gif`);
    expect(res.status()).toBe(200);
    expect((res.headers()['content-type'] || '').toLowerCase()).toContain('image/gif');
  });
});
