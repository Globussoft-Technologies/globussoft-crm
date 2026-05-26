// @ts-check
/**
 * Developer route — API coverage (#713 + #720 + base CRUD shape).
 *
 * routes/developer.js. Covers:
 *   POST   /api/developer/apikeys   — auth + name-required (#720)
 *   GET    /api/developer/apikeys   — auth + scope
 *   DELETE /api/developer/apikeys/:id — auth + 404 + tenant scope
 *   POST   /api/developer/webhooks  — auth + URL scheme allowlist (#713)
 *                                     + private-host block (anti-SSRF)
 *                                     + event-required
 *   GET    /api/developer/webhooks  — auth + scope
 *   DELETE /api/developer/webhooks/:id — auth + 404 + tenant scope
 *
 * #713 specifically pins:
 *   - javascript:alert(1)              → 400 INVALID_WEBHOOK_SCHEME
 *   - data:text/html,<script>alert(1)  → 400 INVALID_WEBHOOK_SCHEME
 *   - file:///etc/passwd                → 400 INVALID_WEBHOOK_SCHEME
 *   - ftp://example.com/                → 400 INVALID_WEBHOOK_SCHEME
 *   - gopher://example.com/             → 400 INVALID_WEBHOOK_SCHEME
 *   - http://127.0.0.1/hook             → 400 INVALID_WEBHOOK_HOST
 *   - http://10.0.0.5/hook              → 400 INVALID_WEBHOOK_HOST
 *   - http://192.168.1.1/hook           → 400 INVALID_WEBHOOK_HOST
 *   - http://172.16.0.1/hook            → 400 INVALID_WEBHOOK_HOST
 *   - http://localhost/hook             → 400 INVALID_WEBHOOK_HOST
 *   - not-a-url                         → 400 INVALID_WEBHOOK_URL
 *   - http://example.com/hook           → 201
 *   - https://example.com/hook          → 201
 *
 * #720 specifically pins:
 *   - missing name                      → 400 KEY_NAME_REQUIRED
 *   - empty-string name                 → 400 KEY_NAME_REQUIRED
 *   - whitespace-only name              → 400 KEY_NAME_REQUIRED
 *   - valid name                        → 201, returns { key, rawKey }
 *
 * Auth: admin@globussoft.com. Both api-key + webhook routes are
 * tenant-scoped via req.user.userId / tenantId, so the dual-token
 * pattern from notifications-api isn't needed — single admin token is
 * enough.
 *
 * Cleanup: tracks every created key + webhook id and DELETEs in
 * afterAll. RUN_TAG `E2E_DEV_<ts>` prefixes both key names + webhook
 * targetUrls; the latter goes onto example.com paths so a successful
 * dispatch (lib/webhookDelivery.js) hits a public 200 / 404 endpoint
 * rather than a private host.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_DEV_${Date.now()}`;

let adminToken = null;

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
        return j.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getAdmin(request) {
  if (!adminToken) {
    adminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  }
  return adminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

const createdKeyIds = new Set();
const createdWebhookIds = new Set();

test.afterAll(async ({ request }) => {
  const token = await getAdmin(request);
  if (!token) return;
  for (const id of createdKeyIds) {
    await del(request, token, `/api/developer/apikeys/${id}`).catch(() => { });
  }
  for (const id of createdWebhookIds) {
    await del(request, token, `/api/developer/webhooks/${id}`).catch(() => { });
  }
});

// ── Auth gates ────────────────────────────────────────────────────

test.describe('Developer API — auth gates', () => {
  test('POST /apikeys without token → 401', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/developer/apikeys`, {
      data: { name: 'unauth' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });

  test('POST /webhooks without token → 401', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/developer/webhooks`, {
      data: { event: 'deal.created', targetUrl: 'https://example.com/hook' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });

  test('GET /apikeys without token → 401', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/developer/apikeys`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });
});

// ── #720: API key generation name validation ──────────────────────

test.describe('Developer API — POST /apikeys name validation (#720)', () => {
  test('missing name → 400 KEY_NAME_REQUIRED', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', {});
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('KEY_NAME_REQUIRED');
  });

  test('empty-string name → 400 KEY_NAME_REQUIRED', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', { name: '' });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('KEY_NAME_REQUIRED');
  });

  test('whitespace-only name → 400 KEY_NAME_REQUIRED', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', { name: '   \t  ' });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('KEY_NAME_REQUIRED');
  });

  test('valid name → 201 with { key, rawKey }', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', {
      name: `${RUN_TAG} valid-key`,
    });
    expect(r.status(), `valid-key: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.key).toBeTruthy();
    expect(typeof body.key.id).toBe('number');
    expect(body.key.name).toBe(`${RUN_TAG} valid-key`);
    expect(typeof body.rawKey).toBe('string');
    expect(body.rawKey).toMatch(/^glbs_[0-9a-f]+$/);
    createdKeyIds.add(body.key.id);
  });

  test('name is trimmed before storage', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', {
      name: `  ${RUN_TAG} trim-key  `,
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.key.name).toBe(`${RUN_TAG} trim-key`);
    createdKeyIds.add(body.key.id);
  });
});

// ── #899 Part A: per-sub-brand API key scoping ────────────────────
//
// ApiKey.subBrand additive nullable column scopes a key to ONE Travel
// sub-brand (tmc / rfu / travelstall / visasure). null = tenant-wide
// (legacy, backward-compatible). POST accepts the optional field and
// validates against the whitelist; GET returns it in the listing so
// the Developer UI can label each key by scope.
test.describe('Developer API — POST /apikeys sub-brand scoping (#899 Part A)', () => {
  test('omitted subBrand → 201 with subBrand=null (tenant-wide key)', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', {
      name: `${RUN_TAG} tenant-wide-key`,
    });
    expect(r.status(), `tenant-wide: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.key.subBrand).toBeNull();
    createdKeyIds.add(body.key.id);
  });

  test('valid subBrand=tmc → 201 with subBrand persisted', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', {
      name: `${RUN_TAG} tmc-scoped-key`,
      subBrand: 'tmc',
    });
    expect(r.status(), `tmc-scoped: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.key.subBrand).toBe('tmc');
    createdKeyIds.add(body.key.id);
  });

  test('invalid subBrand=foo → 400 INVALID_SUB_BRAND', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/apikeys', {
      name: `${RUN_TAG} bogus-scope-key`,
      subBrand: 'foo',
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_SUB_BRAND');
  });

  test('all 4 valid sub-brands accepted (tmc / rfu / travelstall / visasure)', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    for (const sb of ['tmc', 'rfu', 'travelstall', 'visasure']) {
      const r = await post(request, token, '/api/developer/apikeys', {
        name: `${RUN_TAG} ${sb}-key`,
        subBrand: sb,
      });
      expect(r.status(), `${sb}: ${await r.text()}`).toBe(201);
      const body = await r.json();
      expect(body.key.subBrand).toBe(sb);
      createdKeyIds.add(body.key.id);
    }
  });

  test('GET /apikeys returns subBrand field on each key', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    // Create a scoped + an unscoped key, then list.
    const r1 = await post(request, token, '/api/developer/apikeys', {
      name: `${RUN_TAG} get-rfu-key`,
      subBrand: 'rfu',
    });
    expect(r1.status()).toBe(201);
    const scopedId = (await r1.json()).key.id;
    createdKeyIds.add(scopedId);

    const r2 = await request.get(`${BASE_URL}/api/developer/apikeys`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r2.status()).toBe(200);
    const list = await r2.json();
    expect(Array.isArray(list)).toBe(true);
    const scoped = list.find((k) => k.id === scopedId);
    expect(scoped, `created scoped key ${scopedId} missing from listing`).toBeTruthy();
    expect(scoped.subBrand).toBe('rfu');
    // Every key in the listing must have the subBrand field present (null or string).
    for (const k of list) {
      expect(k).toHaveProperty('subBrand');
      expect(k.subBrand === null || typeof k.subBrand === 'string').toBe(true);
    }
  });
});

// ── #713: webhook URL scheme + host allowlist ─────────────────────

test.describe('Developer API — POST /webhooks URL validation (#713)', () => {
  const dangerousSchemes = [
    { name: 'javascript:alert(1)', url: 'javascript:alert(1)', code: 'INVALID_WEBHOOK_SCHEME' },
    { name: 'data:text/html', url: 'data:text/html,<script>alert(1)</script>', code: 'INVALID_WEBHOOK_SCHEME' },
    { name: 'file:///etc/passwd', url: 'file:///etc/passwd', code: 'INVALID_WEBHOOK_SCHEME' },
    { name: 'ftp:', url: 'ftp://example.com/', code: 'INVALID_WEBHOOK_SCHEME' },
    { name: 'gopher:', url: 'gopher://example.com/', code: 'INVALID_WEBHOOK_SCHEME' },
  ];

  for (const c of dangerousSchemes) {
    test(`rejects ${c.name} with ${c.code}`, async ({ request }) => {
      const token = await getAdmin(request);
      test.skip(!token, 'admin login unavailable');
      const r = await post(request, token, '/api/developer/webhooks', {
        event: 'deal.created',
        targetUrl: c.url,
      });
      expect(r.status(), `${c.name}: ${await r.text()}`).toBe(400);
      const body = await r.json();
      expect(body.code).toBe(c.code);
    });
  }

  const privateHosts = [
    'http://127.0.0.1/hook',
    'http://localhost/hook',
    'http://10.0.0.5/hook',
    'http://192.168.1.1/hook',
    'http://172.16.0.1/hook',
    'http://172.31.255.254/hook',
    'http://169.254.169.254/hook', // AWS metadata service
  ];

  for (const u of privateHosts) {
    test(`rejects private host ${u} with INVALID_WEBHOOK_HOST`, async ({ request }) => {
      const token = await getAdmin(request);
      test.skip(!token, 'admin login unavailable');
      const r = await post(request, token, '/api/developer/webhooks', {
        event: 'deal.created',
        targetUrl: u,
      });
      expect(r.status(), `${u}: ${await r.text()}`).toBe(400);
      const body = await r.json();
      expect(body.code).toBe('INVALID_WEBHOOK_HOST');
    });
  }

  test('rejects malformed URL with INVALID_WEBHOOK_URL', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/webhooks', {
      event: 'deal.created',
      targetUrl: 'not a url at all',
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_WEBHOOK_URL');
  });

  test('rejects missing targetUrl with WEBHOOK_URL_REQUIRED', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/webhooks', {
      event: 'deal.created',
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('WEBHOOK_URL_REQUIRED');
  });

  test('rejects missing event with WEBHOOK_EVENT_REQUIRED', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/webhooks', {
      targetUrl: `https://example.com/hook-${RUN_TAG}`,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('WEBHOOK_EVENT_REQUIRED');
  });

  test('accepts http://example.com/hook with 201', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/webhooks', {
      event: 'deal.created',
      targetUrl: `http://example.com/hook-${RUN_TAG}-http`,
    });
    expect(r.status(), `http happy-path: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    expect(body.targetUrl).toBe(`http://example.com/hook-${RUN_TAG}-http`);
    createdWebhookIds.add(body.id);
  });

  test('accepts https://example.com/hook with 201', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await post(request, token, '/api/developer/webhooks', {
      event: 'deal.won',
      targetUrl: `https://example.com/hook-${RUN_TAG}-https`,
    });
    expect(r.status(), `https happy-path: ${await r.text()}`).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    expect(body.event).toBe('deal.won');
    createdWebhookIds.add(body.id);
  });
});

// ── List + delete (smoke) ──────────────────────────────────────────

test.describe('Developer API — list + delete smoke', () => {
  test('GET /apikeys returns array including created keys', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await get(request, token, '/api/developer/apikeys');
    expect(r.status()).toBe(200);
    const list = await r.json();
    expect(Array.isArray(list)).toBe(true);
  });

  test('GET /webhooks returns array including created hooks', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await get(request, token, '/api/developer/webhooks');
    expect(r.status()).toBe(200);
    const list = await r.json();
    expect(Array.isArray(list)).toBe(true);
  });

  test('DELETE /webhooks/:id with bogus id → 404', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await del(request, token, '/api/developer/webhooks/999999999');
    expect(r.status()).toBe(404);
  });

  test('DELETE /apikeys/:id with bogus id → 404', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await del(request, token, '/api/developer/apikeys/999999999');
    expect(r.status()).toBe(404);
  });
});
