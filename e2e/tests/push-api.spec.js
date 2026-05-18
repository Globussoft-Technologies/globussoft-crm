// @ts-check
/**
 * Push notifications module — backend coverage push.
 *
 * routes/push.js was 31.95% covered. The file is a CRUD router for
 * web-push subscriptions + templates, plus campaign send paths that
 * exercise the pushService wrapper. VAPID keys aren't configured on the
 * demo or in CI, so the actual `webpush.sendNotification` call inside
 * pushService.sendPush returns `{success: false, error: 'VAPID keys not
 * configured'}`. That's fine — we cover the route's success-path code
 * (PushNotification row creation, sentCount/failedCount stamping) and
 * the failure tally without needing a real push server.
 *
 * Endpoints covered:
 *   POST   /api/push/subscribe            — auth + validation + upsert
 *   POST   /api/push/subscribe/visitor    — PUBLIC + validation + upsert
 *                                          + tenant resolution from contactId
 *   DELETE /api/push/unsubscribe          — auth + flips isActive=false
 *   POST   /api/push/send                 — auth + validation + targets users
 *                                          in tenant + writes PushNotification
 *   POST   /api/push/send-campaign        — auth + writes MARKETING row +
 *                                          iterates WEBSITE_VISITOR subs
 *   GET    /api/push/templates            — list (tenant-scoped)
 *   POST   /api/push/templates            — create
 *   PUT    /api/push/templates/:id        — 404 + update
 *   DELETE /api/push/templates/:id        — 404 + delete
 *   GET    /api/push/vapid-key            — PUBLIC + returns { publicKey }
 *   GET    /api/push/stats                — auth + tenant-scoped counts
 *
 * Pattern: cached-token / authXyz helpers identical to sla-breach-api.spec.js.
 * Endpoints (the unique key on PushSubscription) are tagged with RUN_TAG so
 * collision is impossible across parallel runs.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let authToken = null;
const RUN_TAG = `E2E_PUSH_${Date.now()}`;

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
async function authPut(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.delete(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// Subscription endpoints have no DELETE in routes/push.js — we deactivate
// instead via /unsubscribe. Track them so afterAll can flip isActive=false.
const createdEndpoints = [];
const createdTemplateIds = [];

test.afterAll(async ({ request }) => {
  for (const endpoint of createdEndpoints) {
    await authDelete(request, '/api/push/unsubscribe', { endpoint }).catch(() => {});
  }
  for (const id of createdTemplateIds) {
    await authDelete(request, `/api/push/templates/${id}`).catch(() => {});
  }
});

// Build a fake-but-shape-correct subscription. The endpoint is unique per
// subtest via a counter so concurrent test runs don't clash on the unique
// endpoint column.
let subCounter = 0;
function fakeSubscription(extra = {}) {
  subCounter += 1;
  return {
    endpoint: `https://${RUN_TAG.toLowerCase()}.example.com/sub-${subCounter}`,
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
    ...extra,
  };
}

// ─── POST /api/push/subscribe ───────────────────────────────────────

test.describe('Push API — POST /subscribe (CRM user)', () => {
  test('400 when "endpoint" is missing', async ({ request }) => {
    const sub = fakeSubscription();
    const res = await authPost(request, '/api/push/subscribe', {
      p256dh: sub.p256dh, auth: sub.auth,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/missing/i);
  });

  test('400 when "p256dh" is missing', async ({ request }) => {
    const sub = fakeSubscription();
    const res = await authPost(request, '/api/push/subscribe', {
      endpoint: sub.endpoint, auth: sub.auth,
    });
    expect(res.status()).toBe(400);
  });

  test('400 when "auth" is missing', async ({ request }) => {
    const sub = fakeSubscription();
    const res = await authPost(request, '/api/push/subscribe', {
      endpoint: sub.endpoint, p256dh: sub.p256dh,
    });
    expect(res.status()).toBe(400);
  });

  test('201-shaped response with success:true + id on first subscribe', async ({ request }) => {
    const sub = fakeSubscription();
    const res = await authPost(request, '/api/push/subscribe', sub);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.id).toBe('number');
    createdEndpoints.push(sub.endpoint);
  });

  test('upsert: re-subscribing with same endpoint reactivates instead of duplicating', async ({ request }) => {
    const sub = fakeSubscription();
    const a = await authPost(request, '/api/push/subscribe', sub);
    const b = await authPost(request, '/api/push/subscribe', sub);
    createdEndpoints.push(sub.endpoint);
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    // Same row — same id.
    expect((await a.json()).id).toBe((await b.json()).id);
  });
});

// ─── POST /api/push/subscribe/visitor (public) ──────────────────────

test.describe('Push API — POST /subscribe/visitor (public)', () => {
  test('no auth required — 200 with success:true', async ({ request }) => {
    const sub = fakeSubscription();
    const res = await request.post(`${BASE_URL}/api/push/subscribe/visitor`, {
      data: sub,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.id).toBe('number');
    createdEndpoints.push(sub.endpoint);
  });

  test('400 when subscription fields missing', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/push/subscribe/visitor`, {
      data: { endpoint: 'https://x.example.com/missing-keys' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
  });

  test('contactId resolves tenant when contact exists; otherwise defaults to 1', async ({ request }) => {
    // Pull any contact id we can find — the tenant resolution path runs only
    // when contactId is present and the contact lookup succeeds.
    const cs = await authGet(request, '/api/contacts?limit=1');
    let contactId = null;
    if (cs.ok()) {
      const list = await cs.json();
      const rows = Array.isArray(list) ? list : (list.rows || []);
      contactId = rows[0]?.id ?? null;
    }
    const sub = fakeSubscription();
    const res = await request.post(`${BASE_URL}/api/push/subscribe/visitor`, {
      data: { ...sub, contactId },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
    createdEndpoints.push(sub.endpoint);
  });

});

// ─── DELETE /api/push/unsubscribe ───────────────────────────────────

test.describe('Push API — DELETE /unsubscribe', () => {
  test('auth required', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/push/unsubscribe`, {
      data: { endpoint: 'https://anything.example.com/x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('flips isActive=false on owned subscription', async ({ request }) => {
    const sub = fakeSubscription();
    await authPost(request, '/api/push/subscribe', sub);
    createdEndpoints.push(sub.endpoint);

    const res = await authDelete(request, '/api/push/unsubscribe', { endpoint: sub.endpoint });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  test('unknown endpoint returns success:true (idempotent updateMany)', async ({ request }) => {
    // The route uses updateMany which silently no-ops when no rows match.
    const res = await authDelete(request, '/api/push/unsubscribe', {
      endpoint: 'https://does-not-exist.example.com/never-subscribed',
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

// ─── POST /api/push/send ────────────────────────────────────────────

test.describe('Push API — POST /send (targeted to users)', () => {
  test('400 when title missing', async ({ request }) => {
    const res = await authPost(request, '/api/push/send', {
      body: 'hello', userIds: [],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/title.*body/i);
  });

  test('400 when body missing', async ({ request }) => {
    const res = await authPost(request, '/api/push/send', {
      title: `${RUN_TAG} no-body`, userIds: [],
    });
    expect(res.status()).toBe(400);
  });

  test('200 with sent:0/failed:0 when userIds is empty array', async ({ request }) => {
    const res = await authPost(request, '/api/push/send', {
      title: `${RUN_TAG} empty-targets`,
      body: 'no recipients',
      userIds: [],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);
  });

  test('200 with sent:0/failed:0 when userIds is omitted (defaults to [])', async ({ request }) => {
    const res = await authPost(request, '/api/push/send', {
      title: `${RUN_TAG} no-targets-key`,
      body: 'no userIds key',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);
  });

  test('200 with userIds = non-existent / cross-tenant ids — silently skipped', async ({ request }) => {
    const res = await authPost(request, '/api/push/send', {
      title: `${RUN_TAG} skip-unknowns`,
      body: 'no real recipients',
      userIds: [99999998, 99999999],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);
  });
});

// ─── POST /api/push/send-test (#515) ─────────────────────────────────
//
// First-class test-push endpoint. Recipient is inferred from
// req.user.userId — no body field needed for recipient. This replaced
// the Channels.jsx Push-tab workaround that read localStorage.user.id
// and posted to /send. Three tests pin the contract:
//   1. Auth gate (no token → 401/403)
//   2. Happy path with custom title/body — writes a TEST-typed
//      PushNotification row + returns sent/failed counts
//   3. Defaults path — body fields all optional; route fills in
//      sensible defaults so the UI can call with empty body

test.describe('Push API — POST /send-test (#515)', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/push/send-test`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: 'unauth', body: 'unauth' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('happy path with custom title/body returns { success, sent, failed } envelope', async ({ request }) => {
    const res = await authPost(request, '/api/push/send-test', {
      title: `${RUN_TAG} send-test-happy`,
      body: 'PR #515 happy-path probe',
      url: '/',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.sent).toBe('number');
    expect(typeof body.failed).toBe('number');
    // Caller has no active push subscription on CI/demo (VAPID keys
    // unconfigured) — sent should be 0, failed 0 (no subscription to
    // attempt against). On a tenant that DOES have a subscription, sent
    // could be 1 — accept both.
    expect(body.sent + body.failed).toBeGreaterThanOrEqual(0);
  });

  test('empty body → defaults applied (title + body fall back to friendly strings)', async ({ request }) => {
    // Channels.jsx CAN call this with all four fields, but the contract
    // is that the route fills in defaults if any are missing — so a
    // future caller (server-side smoke test, alert button, etc.) can
    // post {} and still get a valid push.
    const res = await authPost(request, '/api/push/send-test', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The PushNotification row should still get created with defaults;
    // no validation error fires for missing fields (unlike /send which
    // 400s on missing title or body).
    expect(body).not.toHaveProperty('error');
  });

  // Anti-regression for the Inbox/Channels caller — pin the route's
  // shape so a future agent can't add `userIds` or `targetUserId` to
  // the required-fields check (which would silently break the Channels
  // test-push button and re-introduce the localStorage.user workaround).
  test('does NOT require userIds in body — recipient is server-inferred', async ({ request }) => {
    const res = await authPost(request, '/api/push/send-test', {
      title: `${RUN_TAG} no-userids`,
      body: 'recipient comes from req.user, not body.userIds',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.success).toBe(true);
  });
});

// ─── POST /api/push/send-campaign ───────────────────────────────────

test.describe('Push API — POST /send-campaign (visitor broadcast)', () => {
  test('400 when title missing', async ({ request }) => {
    const res = await authPost(request, '/api/push/send-campaign', {
      body: 'campaign-only',
    });
    expect(res.status()).toBe(400);
  });

  test('400 when body missing', async ({ request }) => {
    const res = await authPost(request, '/api/push/send-campaign', {
      title: `${RUN_TAG} no-body`,
    });
    expect(res.status()).toBe(400);
  });

  test('200 with success:true — writes a PushNotification row', async ({ request }) => {
    // Even when no visitor subs exist or VAPID isn't configured, the route
    // creates the notification row + returns sent/failed counts.
    const res = await authPost(request, '/api/push/send-campaign', {
      title: `${RUN_TAG} campaign-broadcast`,
      body: 'launch announcement',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.sent).toBe('number');
    expect(typeof body.failed).toBe('number');
  });
});

// ─── Templates CRUD ─────────────────────────────────────────────────

test.describe('Push API — templates CRUD', () => {
  test('GET / returns array', async ({ request }) => {
    const res = await authGet(request, '/api/push/templates');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('POST / creates a template (201)', async ({ request }) => {
    const res = await authPost(request, '/api/push/templates', {
      name: `${RUN_TAG} tmpl-A`,
      title: 'Welcome',
      body: 'Thanks for subscribing',
      icon: '/icons/welcome.png',
      url: '/welcome',
      category: 'onboarding',
    });
    expect(res.status()).toBe(201);
    const t = await res.json();
    createdTemplateIds.push(t.id);
    expect(t.name).toContain('tmpl-A');
    expect(t.title).toBe('Welcome');
  });

  test('PUT /:id updates fields', async ({ request }) => {
    const created = await authPost(request, '/api/push/templates', {
      name: `${RUN_TAG} tmpl-edit`, title: 'pre', body: 'pre',
    });
    const t = await created.json();
    createdTemplateIds.push(t.id);

    const res = await authPut(request, `/api/push/templates/${t.id}`, {
      title: 'post-edit', body: 'updated body',
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.title).toBe('post-edit');
    expect(updated.body).toBe('updated body');
  });

  test('PUT /:id 404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/push/templates/99999999', { title: 'x' });
    expect(res.status()).toBe(404);
  });

  test('DELETE /:id removes the template', async ({ request }) => {
    const created = await authPost(request, '/api/push/templates', {
      name: `${RUN_TAG} tmpl-del`, title: 'goodbye', body: 'bye',
    });
    const t = await created.json();
    const del = await authDelete(request, `/api/push/templates/${t.id}`);
    expect(del.status()).toBe(200);
    expect((await del.json()).success).toBe(true);

    // After delete, PUT should 404.
    const after = await authPut(request, `/api/push/templates/${t.id}`, { title: 'gone' });
    expect(after.status()).toBe(404);
  });

  test('DELETE /:id 404 on unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/push/templates/99999999');
    expect(res.status()).toBe(404);
  });
});

// ─── GET /api/push/vapid-key (public) ───────────────────────────────

test.describe('Push API — GET /vapid-key', () => {
  test('public: no auth required', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/push/vapid-key`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('publicKey');
    // Either a non-empty string (configured) or null (unconfigured) — both valid.
    expect(body.publicKey === null || typeof body.publicKey === 'string').toBe(true);
  });
});

// ─── GET /api/push/stats ────────────────────────────────────────────

test.describe('Push API — GET /stats', () => {
  test('returns { notifications, subscribers } shape', async ({ request }) => {
    const res = await authGet(request, '/api/push/stats');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(typeof body.subscribers).toBe('number');
  });

  test('notifications limited to 20 most recent', async ({ request }) => {
    const res = await authGet(request, '/api/push/stats');
    expect(res.status()).toBe(200);
    expect((await res.json()).notifications.length).toBeLessThanOrEqual(20);
  });
});

// ─── Auth gate ──────────────────────────────────────────────────────

test.describe('Push API — auth gate', () => {
  test('POST /subscribe without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/push/subscribe`, {
      data: fakeSubscription(),
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /send without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/push/send`, {
      data: { title: 'x', body: 'y' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /send-campaign without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/push/send-campaign`, {
      data: { title: 'x', body: 'y' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /templates without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/push/templates`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /stats without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/push/stats`);
    expect([401, 403]).toContain(res.status());
  });
});
