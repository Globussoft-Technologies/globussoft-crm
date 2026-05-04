// @ts-check
/**
 * /api/email-threading — smoke spec covering the 7 handlers in
 * backend/routes/email_threading.js:
 *   POST   /auto-thread
 *   GET    /threads
 *   GET    /threads/:threadId
 *   POST   /threads/:threadId/mark-read
 *   POST   /threads/:threadId/archive
 *   POST   /reply
 *   GET    /stats
 *
 * Runs against BASE_URL (default https://crm.globusdemos.com). All endpoints
 * require auth — uses the generic CRM admin credentials.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

test.describe.configure({ mode: 'serial' });

test.describe('email-threading API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
    expect(token).toBeTruthy();
  });

  test('GET /threads requires auth', async ({ request }) => {
    const res = await request.get(`${API}/email-threading/threads`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /threads returns paginated thread list', async ({ request }) => {
    const res = await request.get(`${API}/email-threading/threads?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('threads');
    expect(Array.isArray(body.threads)).toBe(true);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  test('GET /threads honors contactId filter', async ({ request }) => {
    const res = await request.get(`${API}/email-threading/threads?contactId=999999&limit=5`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test('POST /auto-thread back-fills threadIds and reports processed count', async ({ request }) => {
    const res = await request.post(`${API}/email-threading/auto-thread`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('processed');
    expect(typeof body.processed).toBe('number');
  });

  test('GET /stats returns thread analytics shape', async ({ request }) => {
    const res = await request.get(`${API}/email-threading/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('threadCount');
    expect(body).toHaveProperty('unreadThreads');
    expect(body).toHaveProperty('avgResponseTimeMs');
    expect(body).toHaveProperty('avgResponseTimeMinutes');
    expect(body).toHaveProperty('sampleSize');
  });

  test('GET /threads/:threadId returns 404 for unknown thread', async ({ request }) => {
    const res = await request.get(`${API}/email-threading/threads/nonexistent_thread_xyz`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });

  test('POST /threads/:threadId/mark-read returns updated count for any threadId (idempotent)', async ({ request }) => {
    // Use any threadId — handler updates 0 if no match, never 404
    const res = await request.post(`${API}/email-threading/threads/nonexistent_thread_xyz/mark-read`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('updated');
    expect(typeof body.updated).toBe('number');
  });

  // Drift #1 fix (commit 097ef5a-era): archive now persists state by re-keying
  // messages with the `__ARCHIVED__:` sentinel prefix and returns 404 when no
  // messages exist for the thread in the caller's tenant. Pre-fix this was a
  // logged-only stub that 200-ed for any string. The smoke must cover the new
  // contract — a fresh, isolated 404 path that doesn't depend on accumulated
  // demo state. The detail (real-thread → 200) path is exercised in
  // tests/email-threading-api.spec.js:513 which bootstraps its own seed.
  test('POST /threads/:threadId/archive 404s for unknown thread (drift #1 contract)', async ({ request }) => {
    const res = await request.post(
      `${API}/email-threading/threads/no_such_thread_xyz_${Date.now()}/archive`,
      { headers: auth() },
    );
    expect(res.status()).toBe(404);
  });

  test('POST /reply rejects missing threadId+body with 400', async ({ request }) => {
    const res = await request.post(`${API}/email-threading/reply`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /reply 404s for non-existent thread', async ({ request }) => {
    const res = await request.post(`${API}/email-threading/reply`, {
      headers: auth(),
      data: { threadId: 'definitely_no_such_thread', body: 'hello' },
    });
    expect(res.status()).toBe(404);
  });
});
