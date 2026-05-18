// @ts-check
/**
 * Notifications module — backend coverage push.
 *
 * routes/notifications.js + lib/notificationService.js together. The lib was
 * 29.37% covered (143 lines, used everywhere via `notify` / `notifyMany` /
 * `notifyTenant`); the route is the cleanest way to drive both. Every POST /
 * call exercises one of the three lib entry points, and the channel-list
 * branches in `notify()` are exercised by passing different `channels`
 * arrays through the API.
 *
 * Endpoints covered:
 *   GET    /api/notifications              — auth + paginated envelope +
 *                                            ?unread=true filter
 *   GET    /api/notifications/unread-count — auth + {count} shape
 *   PUT    /api/notifications/read-all     — auth + bulk markRead
 *   PUT    /api/notifications/:id/read     — auth + 404 + tenant scope
 *   POST   /api/notifications/:id/read     — POST alias for the above
 *   PATCH  /api/notifications/:id          — PATCH alias for /:id/read (#185)
 *   POST   /api/notifications/mark-all-read — POST alias for read-all
 *   POST   /api/notifications/read-all      — POST alias for read-all
 *   DELETE /api/notifications/:id          — auth + 404 + audit log
 *   POST   /api/notifications              — auth + validation + RBAC:
 *      400 missing title/message
 *      400 INVALID_NOTIFICATION_TYPE on bad type
 *      403 BROADCAST_FORBIDDEN for non-admin without targetUserId
 *      403 CROSS_USER_FORBIDDEN for non-admin with another targetUserId
 *      201 self-notify (any role; targetUserId === own userId)
 *      201 admin targeted (other targetUserId)
 *      201 admin broadcast (no targetUserId) — drives notifyTenant + notifyMany
 *
 *   Note on the body field name: the route reads `targetUserId` (NOT
 *   `userId`). The global stripDangerous middleware deletes `req.body.userId`
 *   before any handler runs (anti-impersonation guardrail), so a body field
 *   named `userId` would silently never reach this route. `targetUserId` is
 *   not stripped. This was a real bug pre-2026-04-30: the targeted-notify
 *   path was unreachable from the API and every targeted call collapsed
 *   into the broadcast branch.
 *   GET    /api/notifications/preferences  — stub
 *   PUT    /api/notifications/preferences  — stub
 *
 * Pattern: dual-token (admin + regular USER) so we can exercise both the
 * happy path (ADMIN can broadcast / cross-user) and the negative path
 * (USER 403s on those). authXyz / authXyzAs helpers identical to
 * push-api.spec.js / estimates-api.spec.js. Test data tagged
 * `E2E_NOTIF_<ts>`; afterAll cleans up every created notification by id.
 *
 * Mailgun + VAPID aren't configured in CI, so when channels include
 * "email" or "push" the lib hits its no-key / try-catch best-effort
 * branches and the notification still gets created. Spec does NOT assert
 * delivery outcome on those channels — only that the create path returns
 * 201 with the DB row, which is what every caller depends on.
 */
const { test, expect } = require('@playwright/test');

// Tests in this file share state through admin@globussoft.com's notification
// list (e.g. mark-all-read affects unread count seen by later tests). With
// playwright.config's `fullyParallel: true` + `workers: 2 in CI`, parallel
// shuffle scrambles ordering and races on shared state. Pin the file to one
// worker, sequential.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_NOTIF_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
// admin@globussoft.com (ADMIN, generic tenant) — drives broadcast + cross-user
// user@crm.com         (USER,  same tenant)    — drives 403 RBAC checks

let adminToken = null;
let adminUserId = null;
let userToken = null;
let userUserId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
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
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    adminToken = r.token;
    adminUserId = r.userId;
  }
  return { token: adminToken, userId: adminUserId };
}

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    userToken = r.token;
    userUserId = r.userId;
  }
  return { token: userToken, userId: userUserId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// Cloudflare-fronted demo occasionally surfaces transient 5xx during origin
// restarts / health-flap windows (Ray-ID 9fd52d673a868e10 on 2026-05-17 ran
// 502 for a few seconds and red-balled the afterAll cleanup loop here,
// reporting as "afterAll hook timeout of 60000ms exceeded" against the test
// that was running at the time). Retry transient 5xx with a short backoff;
// 4xx bails immediately so genuine RBAC/validator regressions still surface.
async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}
async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function put(request, token, path, body) {
  return retryOn5xx(() =>
    request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

// ── Cleanup tracking ───────────────────────────────────────────────
const createdNotificationIds = new Set();

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  // Bound the cleanup loop to 40s so a partial demo outage during teardown
  // can never blow the 60s afterAll hook budget. Each DELETE inside del() now
  // retries on 5xx (up to ~7s/call under bad weather); ~5 retries-worth of
  // budget is the upper bound, after which we drop the rest on the floor —
  // demo-hygiene will sweep them on its next 30-min tick.
  const deadline = Date.now() + 40_000;
  for (const id of createdNotificationIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/notifications/${id}`).catch(() => { });
  }
});

function trackResponse(body) {
  // POST / responses: { delivered, notification } OR { delivered, notifications: [...] }
  if (body && body.notification && body.notification.id) {
    createdNotificationIds.add(body.notification.id);
  }
  if (body && Array.isArray(body.notifications)) {
    for (const n of body.notifications) {
      if (n && n.id) createdNotificationIds.add(n.id);
    }
  }
}

// Helper: create a single self-notify and return its id.
async function createSelfNotif(request, overrides = {}) {
  const { token, userId } = await getAdmin(request);
  const res = await post(request, token, '/api/notifications', {
    targetUserId: userId,
    title: `${RUN_TAG} ${overrides.title || 'self'}`,
    message: overrides.message || 'self message',
    type: overrides.type || 'info',
    link: overrides.link,
    channels: overrides.channels,
  });
  expect(res.status(), `self-notify create: ${await res.text()}`).toBe(201);
  const body = await res.json();
  trackResponse(body);
  return body.notification;
}

// ── GET / list ─────────────────────────────────────────────────────

test.describe('Notifications API — GET /', () => {
  test('200 returns paginated envelope', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/notifications');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.page).toBe(1);
    expect(typeof body.limit).toBe('number');
    expect(typeof body.pages).toBe('number');
  });

  test('respects page + limit query params', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/notifications?page=1&limit=5');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(5);
    expect(body.notifications.length).toBeLessThanOrEqual(5);
  });

  test('caps limit at 100', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/notifications?limit=999');
    expect(res.status()).toBe(200);
    expect((await res.json()).limit).toBe(100);
  });

  test('?unread=true filters to unread only', async ({ request }) => {
    const created = await createSelfNotif(request, { title: 'unread-filter' });
    expect(created.isRead).toBe(false);
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/notifications?unread=true&limit=100');
    expect(res.status()).toBe(200);
    const list = (await res.json()).notifications;
    expect(list.every((n) => n.isRead === false)).toBe(true);
    expect(list.some((n) => n.id === created.id)).toBe(true);
  });

  test('list is scoped to caller userId — does not leak other users notifications', async ({ request }) => {
    // Admin creates a targeted notification for user@crm.com.
    const { token: adminTok, userId: adminId } = await getAdmin(request);
    const { userId: regularId } = await getUser(request);
    if (!adminTok || !regularId || regularId === adminId) test.skip(true, 'need both admin + non-admin user with distinct ids');

    const created = await post(request, adminTok, '/api/notifications', {
      targetUserId: regularId,
      title: `${RUN_TAG} cross-user-leak-test`,
      message: 'should not appear in admin list',
    });
    expect(created.status()).toBe(201);
    trackResponse(await created.json());

    // Admin's own list should NOT include the row addressed to user@crm.com.
    const list = await get(request, adminTok, '/api/notifications?limit=100');
    expect(list.status()).toBe(200);
    const titles = (await list.json()).notifications.map((n) => n.title);
    expect(titles.every((t) => t !== `${RUN_TAG} cross-user-leak-test`)).toBe(true);
  });
});

// ── GET /unread-count ──────────────────────────────────────────────

test.describe('Notifications API — GET /unread-count', () => {
  test('200 returns {count: number}', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/notifications/unread-count');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.count).toBe('number');
    expect(body.count).toBeGreaterThanOrEqual(0);
  });

  test('count goes up after creating a self-notify', async ({ request }) => {
    const { token } = await getAdmin(request);
    const before = (await (await get(request, token, '/api/notifications/unread-count')).json()).count;
    await createSelfNotif(request, { title: 'count-up' });
    const after = (await (await get(request, token, '/api/notifications/unread-count')).json()).count;
    expect(after).toBe(before + 1);
  });
});

// ── PUT /:id/read + POST /:id/read alias ───────────────────────────

test.describe('Notifications API — mark single read', () => {
  test('PUT /:id/read flips isRead=true', async ({ request }) => {
    const { token } = await getAdmin(request);
    const n = await createSelfNotif(request, { title: 'put-read' });
    const res = await put(request, token, `/api/notifications/${n.id}/read`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).isRead).toBe(true);
  });

  test('POST /:id/read alias flips isRead=true (issue #185 alias)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const n = await createSelfNotif(request, { title: 'post-read-alias' });
    const res = await post(request, token, `/api/notifications/${n.id}/read`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).isRead).toBe(true);
  });

  test('PATCH /:id no longer 404s — flips isRead=true (#185)', async ({ request }) => {
    // #185 bug repro: clients tested all three of POST /:id/read, PATCH /:id,
    // POST /mark-all-read and got 404 from the second one because only PUT +
    // POST aliases were wired. Pinning PATCH /:id here blocks regression.
    const { token } = await getAdmin(request);
    const n = await createSelfNotif(request, { title: 'patch-id-alias' });
    const res = await request.patch(`${BASE_URL}/api/notifications/${n.id}`, {
      headers: headers(token),
      data: { isRead: true },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status(), `PATCH /:id should not 404: got ${res.status()} (${await res.text()})`).toBe(200);
    expect((await res.json()).isRead).toBe(true);
  });

  test('PATCH /:id 404 on unknown id (alias preserves not-found semantics)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await request.patch(`${BASE_URL}/api/notifications/99999999`, {
      headers: headers(token),
      data: { isRead: true },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(404);
  });

  test('PUT /:id/read 404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await put(request, token, '/api/notifications/99999999/read', {});
    expect(res.status()).toBe(404);
  });
});

// ── PUT /read-all + POST aliases ───────────────────────────────────

test.describe('Notifications API — mark all read', () => {
  test('PUT /read-all returns { updated: number }', async ({ request }) => {
    const { token } = await getAdmin(request);
    await createSelfNotif(request, { title: 'bulk-read-1' });
    await createSelfNotif(request, { title: 'bulk-read-2' });
    const res = await put(request, token, '/api/notifications/read-all', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.updated).toBe('number');
    expect(body.updated).toBeGreaterThanOrEqual(2);
  });

  test('POST /read-all alias works the same', async ({ request }) => {
    const { token } = await getAdmin(request);
    await createSelfNotif(request, { title: 'bulk-read-post-alias' });
    const res = await post(request, token, '/api/notifications/read-all', {});
    expect(res.status()).toBe(200);
    expect(typeof (await res.json()).updated).toBe('number');
  });

  test('POST /mark-all-read alias works the same (#185)', async ({ request }) => {
    const { token } = await getAdmin(request);
    await createSelfNotif(request, { title: 'mark-all-read-alias' });
    const res = await post(request, token, '/api/notifications/mark-all-read', {});
    expect(res.status()).toBe(200);
    expect(typeof (await res.json()).updated).toBe('number');
  });

  test('after read-all, unread count is 0 for caller', async ({ request }) => {
    const { token } = await getAdmin(request);
    await createSelfNotif(request, { title: 'count-zero-after-read-all' });
    await put(request, token, '/api/notifications/read-all', {});
    const res = await get(request, token, '/api/notifications/unread-count');
    expect((await res.json()).count).toBe(0);
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('Notifications API — DELETE /:id', () => {
  test('200 deletes own notification', async ({ request }) => {
    const { token } = await getAdmin(request);
    const n = await createSelfNotif(request, { title: 'delete-target' });
    createdNotificationIds.delete(n.id); // we'll assert deletion ourselves
    const res = await del(request, token, `/api/notifications/${n.id}`);
    expect(res.status()).toBe(204); // #550: DELETE → 204 No Content

    // Subsequent PUT /:id/read should now 404.
    const after = await put(request, token, `/api/notifications/${n.id}/read`, {});
    expect(after.status()).toBe(404);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await del(request, token, '/api/notifications/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── POST / — validation + RBAC ─────────────────────────────────────

test.describe('Notifications API — POST / (validation + RBAC)', () => {
  test('400 when title is missing', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const res = await post(request, token, '/api/notifications', {
      targetUserId: userId, message: 'no-title',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/title.*message/i);
  });

  test('400 when message is missing', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const res = await post(request, token, '/api/notifications', {
      targetUserId: userId, title: `${RUN_TAG} no-message`,
    });
    expect(res.status()).toBe(400);
  });

  test('400 INVALID_NOTIFICATION_TYPE on bad type', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const res = await post(request, token, '/api/notifications', {
      targetUserId: userId,
      title: `${RUN_TAG} bad-type`,
      message: 'm',
      type: 'INVALID_TYPE_ZZZ',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_NOTIFICATION_TYPE');
  });

  test('accepts every documented type value', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const types = ['info', 'success', 'warning', 'error', 'system', 'deal', 'task', 'ticket'];
    for (const t of types) {
      const res = await post(request, token, '/api/notifications', {
        targetUserId: userId,
        title: `${RUN_TAG} type-${t}`,
        message: 'm',
        type: t,
      });
      expect(res.status(), `type=${t}: ${await res.text()}`).toBe(201);
      trackResponse(await res.json());
    }
  });

  test('403 BROADCAST_FORBIDDEN for non-admin without userId', async ({ request }) => {
    const { token } = await getUser(request);
    if (!token) test.skip(true, 'no regular USER token available');
    const res = await post(request, token, '/api/notifications', {
      title: `${RUN_TAG} should-403-broadcast`,
      message: 'm',
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('BROADCAST_FORBIDDEN');
  });

  test('403 CROSS_USER_FORBIDDEN for non-admin targeting another user', async ({ request }) => {
    const { token } = await getUser(request);
    const { userId: adminId } = await getAdmin(request);
    if (!token || !adminId) test.skip(true, 'no regular USER token or admin id available');
    const res = await post(request, token, '/api/notifications', {
      targetUserId: adminId,
      title: `${RUN_TAG} should-403-cross-user`,
      message: 'm',
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('CROSS_USER_FORBIDDEN');
  });
});

// ── POST / — happy paths through notify / notifyMany / notifyTenant ─

test.describe('Notifications API — POST / (create paths)', () => {
  test('201 self-notify (regular USER, own userId)', async ({ request }) => {
    const { token, userId } = await getUser(request);
    if (!token) test.skip(true, 'no regular USER token available');
    const res = await post(request, token, '/api/notifications', {
      targetUserId: userId,
      title: `${RUN_TAG} user-self-notify`,
      message: 'self ok',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.delivered).toBe(1);
    expect(body.notification.title).toContain('user-self-notify');
    trackResponse(body);
  });

  test('201 admin targets another user', async ({ request }) => {
    const { token: adminTok } = await getAdmin(request);
    const { userId: regularId } = await getUser(request);
    if (!adminTok || !regularId) test.skip(true, 'need admin token + regular user id');
    const res = await post(request, adminTok, '/api/notifications', {
      targetUserId: regularId,
      title: `${RUN_TAG} admin-target-user`,
      message: 'm',
      type: 'success',
      link: '/somewhere',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.notification.userId).toBe(regularId);
    expect(body.notification.type).toBe('success');
    expect(body.notification.link).toBe('/somewhere');
    trackResponse(body);
  });

  test('201 admin broadcast (no userId) — drives notifyTenant + notifyMany', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/notifications', {
      title: `${RUN_TAG} broadcast`,
      message: 'tenant-wide',
      type: 'info',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(body.notifications.length).toBe(body.delivered);
    trackResponse(body);
  });

  test('channels=["db"] still creates the row (only DB persistence)', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const res = await post(request, token, '/api/notifications', {
      targetUserId: userId,
      title: `${RUN_TAG} db-only`,
      message: 'no socket no push no email',
      channels: ['db'],
    });
    expect(res.status()).toBe(201);
    trackResponse(await res.json());
  });

  test('channels including "push" + "email" still returns 201 (best-effort)', async ({ request }) => {
    // Without VAPID + Mailgun keys, lib falls into try/catch best-effort
    // branches. Spec only verifies the route still returns 201 + DB row
    // exists — delivery outcome on those channels is not asserted here.
    const { token, userId } = await getAdmin(request);
    const res = await post(request, token, '/api/notifications', {
      targetUserId: userId,
      title: `${RUN_TAG} all-channels`,
      message: 'broadcast across channels',
      channels: ['db', 'socket', 'push', 'email'],
    });
    expect(res.status()).toBe(201);
    trackResponse(await res.json());
  });
});

// ── GET/PUT /preferences ───────────────────────────────────────────

test.describe('Notifications API — preferences (stub)', () => {
  test('GET /preferences returns channels stub', async ({ request }) => {
    // v3.7.x: channels reshaped from flat booleans `{db, socket, push, email}`
    // to per-channel objects `{email: {enabled: bool}, ...}`. The route's
    // DEFAULT_PREFERENCES still uses the old flat shape, but any user whose
    // row was created/updated via PUT /preferences (which the next test in
    // this file does) will have the new shape persisted and read back here.
    // Demo admin's row is in the new shape post-PR#710. Assert structurally
    // that `channels` is a truthy object — accept either shape so the spec
    // doesn't churn on every channels reshape.
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/notifications/preferences');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.channels).toBeTruthy();
    expect(typeof body.channels).toBe('object');
    expect(Object.keys(body.channels).length).toBeGreaterThan(0);
  });

  test('PUT /preferences echoes payload back', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await put(request, token, '/api/notifications/preferences', {
      channels: { email: { enabled: true } },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("PREFERENCES_SAVED"); // #550
    expect(body.preferences).toBeTruthy();
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Notifications API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/notifications`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /unread-count without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/notifications/unread-count`);
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /read-all without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/notifications/read-all`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/notifications`, {
      data: { title: 'x', message: 'y' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/notifications/1`);
    expect([401, 403]).toContain(res.status());
  });
});

// ── Demo-hygiene defence-in-depth (#327) ───────────────────────────
//
// #327: Rishu's Owner Dashboard bell showed two pen-test residues —
// "Targeted / just user 8" and "INJECT TEST / x". Closing #169 (the
// broadcast-spam vulnerability) prevented new ones; closing #327 was a
// one-time scrub on demo. demo-hygiene-api.spec.js polices this on the
// release-validation gate against the live demo box, but per-push CI runs
// against a freshly-seeded local stack — so we pin the assertion here too
// as defence-in-depth: the seed should NEVER produce these markers, and
// neither should anything created during the spec's own POST tests.
//
// If this trips, either (a) the seed has regressed (something is writing
// "INJECT TEST" or "Targeted / just user N" into a notification body), or
// (b) the BROADCAST_FORBIDDEN guard from #169 has regressed and a non-admin
// hit through created the body. Both are real bugs — don't relax the
// pattern, find the writer.
test.describe('Notifications API — demo hygiene (#327)', () => {
  const FORBIDDEN_BODY_PATTERNS = [
    { re: /\bINJECT TEST\b/, why: '#327: INJECT TEST marker (pen-test residue)' },
    { re: /^Targeted \/ just user \d/i, why: '#327: broadcast-targeting test residue' },
  ];

  test('admin@globussoft.com feed contains no #327 pen-test residue', async ({ request }) => {
    const { token } = await getAdmin(request);
    if (!token) test.skip(true, 'no admin token available');
    // Pull a generous slice to scan — the bell only shows the latest few
    // but the regression could surface deeper in the list.
    const res = await get(request, token, '/api/notifications?limit=100');
    expect(res.status()).toBe(200);
    const list = (await res.json()).notifications;
    const offenders = [];
    for (const n of list) {
      for (const field of ['title', 'message']) {
        const v = n[field];
        if (typeof v !== 'string') continue;
        for (const { re, why } of FORBIDDEN_BODY_PATTERNS) {
          if (re.test(v)) offenders.push(`id=${n.id} ${field}=${JSON.stringify(v).slice(0, 80)} :: ${why}`);
        }
      }
    }
    expect(offenders, `#327 regression — found pen-test residue:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('regular user@crm.com feed contains no #327 pen-test residue', async ({ request }) => {
    const { token } = await getUser(request);
    if (!token) test.skip(true, 'no regular USER token available');
    const res = await get(request, token, '/api/notifications?limit=100');
    expect(res.status()).toBe(200);
    const list = (await res.json()).notifications;
    const offenders = [];
    for (const n of list) {
      for (const field of ['title', 'message']) {
        const v = n[field];
        if (typeof v !== 'string') continue;
        for (const { re, why } of FORBIDDEN_BODY_PATTERNS) {
          if (re.test(v)) offenders.push(`id=${n.id} ${field}=${JSON.stringify(v).slice(0, 80)} :: ${why}`);
        }
      }
    }
    expect(offenders, `#327 regression — found pen-test residue:\n${offenders.join('\n')}`).toEqual([]);
  });
});
