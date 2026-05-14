// @ts-check
/**
 * Email API — minimal coverage to lock down the routes the frontend
 * sidebar polls every 60s.
 *
 * Why this exists (#402): the sidebar at frontend/src/components/Sidebar.jsx
 * line 56 calls `fetchApi('/api/email?unread=1')` to populate the Inbox
 * counter. Pre-this-spec, that route was undefined on the backend, so
 * EVERY page load triggered a 404 → red "Not found." toast. The 60s
 * polling fallback meant the toast came back forever.
 *
 * The shape the sidebar expects (Sidebar.jsx:51):
 *   `Array.isArray(r) ? r.length : (r?.total ?? 0)`
 *
 * So a working response is EITHER an array OR an object with a
 * `total` field. Anything else (404, 500, plain string) silently
 * coerces to 0 in the sidebar but raises the global error toast.
 *
 * This spec asserts:
 *   1. GET /api/email                    — 200 with array or {total} shape
 *   2. GET /api/email?unread=1           — same (the actual sidebar call)
 *   3. GET /api/email?folder=inbox       — 200 (basic folder filter)
 *   4. Auth gate                         — 401/403 without a token
 *   5. Cross-tenant isolation            — wellness admin and generic
 *      admin do not see each other's emails
 *
 * Tenant: covers BOTH generic admin (admin@globussoft.com) and wellness
 * admin (admin@wellness.demo) so a missing tenantId filter on the route
 * fails this spec in addition to the cross-tenant test in tasks-api.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let genericToken = null;
let wellnessToken = null;

async function loginAs(request, email) {
  const res = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!res.ok()) return null;
  const j = await res.json();
  return j.token || null;
}

test.beforeAll(async ({ request }) => {
  genericToken = await loginAs(request, 'admin@globussoft.com');
  wellnessToken = await loginAs(request, 'admin@wellness.demo');
});

async function authGet(request, path, token) {
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

// Sidebar.jsx coerces with `Array.isArray(r) ? r.length : (r?.total ?? 0)`.
// Any of these shapes means the sidebar shows a count (good); anything
// else (404, plain string, undefined) trips the global error toast.
function looksLikeListOrCount(body) {
  if (Array.isArray(body)) return true;
  if (body && typeof body === 'object' && 'total' in body) return true;
  if (body && typeof body === 'object' && Array.isArray(body.threads)) return true;
  if (body && typeof body === 'object' && Array.isArray(body.messages)) return true;
  if (body && typeof body === 'object' && Array.isArray(body.data)) return true;
  return false;
}

test.describe('Email API — sidebar inbox counter (#402)', () => {
  test('GET /api/email returns 200 with a list-or-count shape', async ({ request }) => {
    test.skip(!genericToken, 'generic admin login failed — env not seeded');
    const res = await authGet(request, '/api/email', genericToken);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json().catch(() => null);
    expect(looksLikeListOrCount(body), `unexpected shape: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
  });

  test('GET /api/email?unread=1 returns 200 (the actual sidebar call)', async ({ request }) => {
    test.skip(!genericToken, 'generic admin login failed — env not seeded');
    // This is the EXACT call shape the sidebar makes every 60s. If it
    // ever 404s again, the red "Not found." toast returns to every page.
    const res = await authGet(request, '/api/email?unread=1', genericToken);
    expect(res.status()).toBe(200);
    const body = await res.json().catch(() => null);
    expect(looksLikeListOrCount(body)).toBe(true);
  });

  test('GET /api/email?folder=inbox returns 200', async ({ request }) => {
    test.skip(!genericToken, 'generic admin login failed — env not seeded');
    const res = await authGet(request, '/api/email?folder=inbox', genericToken);
    expect(res.status()).toBe(200);
  });

  test('GET /api/email without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/email?unread=1`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/email is tenant-scoped — wellness vs generic do not overlap', async ({ request }) => {
    test.skip(!genericToken || !wellnessToken, 'tenant logins not available');
    const [genericRes, wellnessRes] = await Promise.all([
      authGet(request, '/api/email?limit=200', genericToken),
      authGet(request, '/api/email?limit=200', wellnessToken),
    ]);
    expect(genericRes.status()).toBe(200);
    expect(wellnessRes.status()).toBe(200);

    const idsFrom = (body) => {
      const list = Array.isArray(body) ? body :
        (body?.threads || body?.messages || body?.data || []);
      return new Set(list.map((m) => m.id).filter((x) => x != null));
    };
    const genericIds = idsFrom(await genericRes.json().catch(() => null));
    const wellnessIds = idsFrom(await wellnessRes.json().catch(() => null));

    // The two sets must be disjoint — any overlap means tenantId
    // filtering on the email route is broken.
    const overlap = [...genericIds].filter((id) => wellnessIds.has(id));
    expect(overlap, 'cross-tenant email leak detected').toHaveLength(0);
  });
});
