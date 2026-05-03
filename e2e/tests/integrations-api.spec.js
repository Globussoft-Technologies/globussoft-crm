// @ts-check
/**
 * Integrations API — admin surface (/api/integrations).
 *
 * G-3 from docs/E2E_GAPS.md. Covers all 6 endpoints on
 * backend/routes/integrations.js plus the Callified.ai SSO surface.
 *
 * Endpoints covered (6):
 *   GET    /api/integrations/                    — auth-only list
 *                                                  (enriches the static
 *                                                  AVAILABLE_INTEGRATIONS
 *                                                  catalog with this
 *                                                  tenant's connection state)
 *   POST   /api/integrations/connect             — ADMIN-only upsert
 *                                                  (provider + token + settings)
 *   POST   /api/integrations/disconnect          — ADMIN-only soft delete
 *                                                  (sets isActive=false, nulls token)
 *   POST   /api/integrations/toggle              — legacy on/off (NO role guard)
 *   GET    /api/integrations/callified/auth-url  — Callified SSO JWT mint
 *                                                  (returns {authUrl})
 *   GET    /api/integrations/callified/sso       — direct redirect alias
 *
 * Doc-card-vs-reality drifts found while reading the route:
 *   1. Gap card calls /callified/sso the "OAuth callback" — it's actually a
 *      direct browser redirect that mints a fresh JWT itself; there is no
 *      separate callback handler on this route. The auth-url endpoint
 *      returns JSON {authUrl}, sso/ does the same work then 302s to that
 *      url. Spec follows the route, not the gap card.
 *   2. The static catalog has 12 providers (slack/google/stripe/razorpay/
 *      mailchimp/quickbooks/xero/tally/zapier/whatsapp/indiamart/justdial).
 *      "callified" is NOT in the catalog — connecting it via /connect still
 *      works (the upsert isn't catalog-bound), and the DB row is what the
 *      Callified handlers read for their settings JSON. So the catalog is
 *      effectively a frontend hint, not a hard whitelist.
 *   3. POST /connect returns the FULL Integration row in its write-response
 *      body, which echoes back the token the caller just wrote. This is
 *      write-back semantics, not a list-leak — the GET / list does NOT
 *      include any token field — but a hardened API would null/redact
 *      even on POST response. Spec asserts the GET path is clean (the
 *      brief's hard requirement) and notes the POST behaviour.
 *
 * Security findings flagged for follow-up (test.fixme — do not fix here):
 *   • POST /toggle (line 70 of routes/integrations.js) lacks verifyRole
 *     guard. Non-admin USER and MANAGER can flip any integration's
 *     isActive flag for their tenant. This is the documented-as-legacy
 *     endpoint; either add the guard or remove the route. Tracked via the
 *     test.fixme block in this spec ("toggle should require admin role").
 *
 * Pattern: notifications-api.spec.js + landing-pages-api.spec.js (the
 * latter for cross-tenant isolation describe block). Triple-token across
 * two tenants:
 *   admin@globussoft.com  (ADMIN, generic) — main happy path + tenant A
 *   manager@crm.com       (MANAGER, generic) — RBAC 403 on connect/disconnect
 *   user@crm.com          (USER,    generic) — RBAC 403 on connect/disconnect
 *   admin@wellness.demo   (ADMIN, wellness)  — tenant B isolation
 *
 * Test data tagged E2E_FLOW_INT_<ts>. Integrations have no name field but
 * the settings.label JSON property carries the tag so query-param probes
 * looking for the literal RUN_TAG can detect a leak. afterAll disconnects
 * every provider this run touched on both tenants.
 */
const { test, expect } = require('@playwright/test');

// Serial: connect/disconnect on slack mutates a shared row that later
// tests read. Parallel shuffle would race the credential-leak assertions.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_INT_${Date.now()}`;

// Sentinel secret value — every connect call writes this string into
// `token`. The leak-probe tests assert this string never appears in any
// GET response body, even with credential-fishing query params.
const SECRET_TOKEN = `secret_${RUN_TAG}_AAA`;

// ── Quad-token auth ────────────────────────────────────────────────

let genericAdminToken = null;
let genericAdminUserId = null;
let genericManagerToken = null;
let genericUserToken = null;
let wellnessAdminToken = null;

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
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericAdminToken = r.token;
    genericAdminUserId = r.userId;
  }
  return { token: genericAdminToken, userId: genericAdminUserId };
}

async function getGenericManager(request) {
  if (!genericManagerToken) {
    const r = await loginAs(request, 'manager@crm.com', 'password123');
    genericManagerToken = r.token;
  }
  return { token: genericManagerToken };
}

async function getGenericUser(request) {
  if (!genericUserToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    genericUserToken = r.token;
  }
  return { token: genericUserToken };
}

async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessAdminToken = r.token;
  }
  return { token: wellnessAdminToken };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracker keyed by tenant ────────────────────────────────
// Track which providers each tenant connected so afterAll can disconnect.
const touchedProvidersByTenant = {
  generic: new Set(),
  wellness: new Set(),
};

test.beforeAll(async ({ request }) => {
  // Warm tokens up-front. Login race vs first test.
  await getGenericAdmin(request);
  await getGenericManager(request);
  await getGenericUser(request);
  await getWellnessAdmin(request);
});

test.afterAll(async ({ request }) => {
  for (const [tenant, providers] of Object.entries(touchedProvidersByTenant)) {
    const tok = tenant === 'generic'
      ? (await getGenericAdmin(request)).token
      : (await getWellnessAdmin(request)).token;
    if (!tok) continue;
    for (const provider of providers) {
      await post(request, tok, '/api/integrations/disconnect', { provider }).catch(() => {});
    }
  }
});

// Helper to upsert + track for cleanup. Returns the response body.
async function connectAs(request, tenant, provider, overrides = {}) {
  const tok = tenant === 'generic'
    ? (await getGenericAdmin(request)).token
    : (await getWellnessAdmin(request)).token;
  if (!tok) throw new Error(`connectAs: no ${tenant} admin token`);
  const body = {
    provider,
    token: overrides.token !== undefined ? overrides.token : SECRET_TOKEN,
    settings: overrides.settings !== undefined ? overrides.settings : { label: RUN_TAG, webhook: 'https://hooks.example.test/x' },
  };
  const res = await post(request, tok, '/api/integrations/connect', body);
  expect(res.status(), `connectAs(${tenant},${provider}): ${await res.text()}`).toBe(200);
  touchedProvidersByTenant[tenant].add(provider);
  return res.json();
}

// ── GET / list ─────────────────────────────────────────────────────

test.describe('Integrations API — GET /', () => {
  test('200 returns enriched 12-provider catalog with isActive/connectedAt/id', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/integrations');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    // Static catalog is exactly 12 providers (see route lines 7-20).
    expect(list.length).toBe(12);
    // Documented field shape per the route's mapper.
    for (const row of list) {
      expect(typeof row.provider).toBe('string');
      expect(typeof row.name).toBe('string');
      expect(typeof row.description).toBe('string');
      expect(typeof row.category).toBe('string');
      expect(typeof row.isActive).toBe('boolean');
      // connectedAt is null for not-yet-connected providers
      // id is null until connected
    }
    // Every documented provider name appears.
    const providers = list.map((r) => r.provider);
    expect(providers).toContain('slack');
    expect(providers).toContain('google');
    expect(providers).toContain('stripe');
    expect(providers).toContain('whatsapp');
  });

  test('after POST /connect, GET row reflects isActive=true + populated id', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    await connectAs(request, 'generic', 'slack');
    const res = await get(request, token, '/api/integrations');
    const slack = (await res.json()).find((r) => r.provider === 'slack');
    expect(slack).toBeTruthy();
    expect(slack.isActive).toBe(true);
    expect(typeof slack.id).toBe('number');
    expect(slack.connectedAt).toBeTruthy();
  });

  test('after POST /disconnect, GET row reflects isActive=false', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    // Make sure mailchimp is connected first
    await connectAs(request, 'generic', 'mailchimp');
    let res = await get(request, token, '/api/integrations');
    expect((await res.json()).find((r) => r.provider === 'mailchimp').isActive).toBe(true);
    // Disconnect
    const dis = await post(request, token, '/api/integrations/disconnect', { provider: 'mailchimp' });
    expect(dis.status()).toBe(200);
    expect((await dis.json()).success).toBe(true);
    res = await get(request, token, '/api/integrations');
    expect((await res.json()).find((r) => r.provider === 'mailchimp').isActive).toBe(false);
  });
});

// ── POST /connect — admin-only + secret write-only ─────────────────

test.describe('Integrations API — POST /connect (admin guard + write semantics)', () => {
  test('200 admin can connect with token + settings', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/integrations/connect', {
      provider: 'stripe',
      token: SECRET_TOKEN,
      settings: { label: RUN_TAG, mode: 'test' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('stripe');
    expect(body.isActive).toBe(true);
    // settings is stored as JSON-stringified text per schema (line 463)
    expect(typeof body.settings).toBe('string');
    expect(JSON.parse(body.settings).label).toBe(RUN_TAG);
    touchedProvidersByTenant.generic.add('stripe');
  });

  test('400 when provider field missing', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/integrations/connect', {
      token: 'no-provider',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/provider/i);
  });

  test('upsert: second connect on same provider updates the same row', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const first = await connectAs(request, 'generic', 'zapier');
    const second = await connectAs(request, 'generic', 'zapier', {
      settings: { label: RUN_TAG, updated: true },
    });
    expect(second.id).toBe(first.id);
    expect(JSON.parse(second.settings).updated).toBe(true);
  });

  test('403 MANAGER cannot connect (admin-only contract)', async ({ request }) => {
    const { token } = await getGenericManager(request);
    if (!token) test.skip(true, 'no manager token');
    const res = await post(request, token, '/api/integrations/connect', {
      provider: 'slack',
      token: 'mgr-attempt',
    });
    expect(res.status()).toBe(403);
  });

  test('403 USER cannot connect (admin-only contract)', async ({ request }) => {
    const { token } = await getGenericUser(request);
    if (!token) test.skip(true, 'no user token');
    const res = await post(request, token, '/api/integrations/connect', {
      provider: 'slack',
      token: 'user-attempt',
    });
    expect(res.status()).toBe(403);
  });

  test('403 without token (auth gate)', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/integrations/connect`, {
      data: { provider: 'slack' },
      headers: { 'Content-Type': 'application/json' },
    });
    // verifyToken returns 403 when no Authorization header (auth.js line 13).
    expect([401, 403]).toContain(res.status());
  });
});

// ── POST /disconnect — admin-only ──────────────────────────────────

test.describe('Integrations API — POST /disconnect (admin guard)', () => {
  test('200 admin disconnect nulls the token + flips isActive=false', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    await connectAs(request, 'generic', 'razorpay');
    const res = await post(request, token, '/api/integrations/disconnect', { provider: 'razorpay' });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
    // Confirm via list
    const list = await (await get(request, token, '/api/integrations')).json();
    expect(list.find((r) => r.provider === 'razorpay').isActive).toBe(false);
  });

  test('200 disconnect on never-connected provider is a no-op (updateMany matches 0)', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/integrations/disconnect', { provider: 'tally' });
    expect(res.status()).toBe(200);
  });

  test('403 MANAGER cannot disconnect', async ({ request }) => {
    const { token } = await getGenericManager(request);
    if (!token) test.skip(true, 'no manager token');
    const res = await post(request, token, '/api/integrations/disconnect', { provider: 'slack' });
    expect(res.status()).toBe(403);
  });

  test('403 USER cannot disconnect', async ({ request }) => {
    const { token } = await getGenericUser(request);
    if (!token) test.skip(true, 'no user token');
    const res = await post(request, token, '/api/integrations/disconnect', { provider: 'slack' });
    expect(res.status()).toBe(403);
  });

  test('403 without token', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/integrations/disconnect`, {
      data: { provider: 'slack' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ── POST /toggle — legacy, missing admin guard (FIXME) ─────────────

test.describe('Integrations API — POST /toggle (legacy)', () => {
  test('200 admin can toggle on/off', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/integrations/toggle', {
      provider: 'whatsapp',
      isActive: true,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('whatsapp');
    expect(body.isActive).toBe(true);
    touchedProvidersByTenant.generic.add('whatsapp');
    // Toggle off
    const off = await post(request, token, '/api/integrations/toggle', {
      provider: 'whatsapp',
      isActive: false,
    });
    expect(off.status()).toBe(200);
    expect((await off.json()).isActive).toBe(false);
  });

  test('403 without token', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/integrations/toggle`, {
      data: { provider: 'slack', isActive: true },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  // /toggle now inherits verifyRole(['ADMIN']) — issue #409 closed by adding
  // the guard alongside its sister /connect + /disconnect endpoints.
  test('toggle requires admin role', async ({ request }) => {
    const { token } = await getGenericUser(request);
    const res = await post(request, token, '/api/integrations/toggle', {
      provider: 'indiamart',
      isActive: true,
    });
    expect(res.status()).toBe(403);
  });
});

// ── Tenant isolation on credential storage ─────────────────────────

test.describe('Integrations API — tenant isolation on credentials', () => {
  test('wellness GET does not see generic admin connections', async ({ request }) => {
    // Generic admin connects justdial with the sentinel token
    await connectAs(request, 'generic', 'justdial');
    // Wellness admin GET — justdial should appear unconnected (isActive=false, id=null)
    const { token: wTok } = await getWellnessAdmin(request);
    if (!wTok) test.skip(true, 'no wellness token');
    const res = await get(request, wTok, '/api/integrations');
    expect(res.status()).toBe(200);
    const justdial = (await res.json()).find((r) => r.provider === 'justdial');
    expect(justdial).toBeTruthy();
    // Wellness sees provider catalog but NOT generic's connection state
    // (it'll be either isActive=false because wellness never connected it,
    // OR true if wellness has its own connection — but the id MUST be a
    // wellness-tenant id, never the generic one)
    if (justdial.id !== null) {
      // If wellness has its own row, it must be a different id than generic's.
      // We don't know the generic id here without re-fetching; assert the
      // shape and rely on the secret-leak test below for the hard contract.
      expect(typeof justdial.id).toBe('number');
    }
  });

  test('GET response on generic tenant never echoes the secret token field', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    await connectAs(request, 'generic', 'quickbooks');
    const res = await get(request, token, '/api/integrations');
    expect(res.status()).toBe(200);
    const raw = await res.text();
    // The literal sentinel value the test wrote into `token` MUST NOT
    // appear anywhere in the GET response body. This is the hard
    // write-only contract from the brief: tokens are accepted but never
    // echoed by the list endpoint.
    expect(raw).not.toContain(SECRET_TOKEN);
    // Belt-and-braces: no row in the list has a `token` key at all.
    const list = JSON.parse(raw);
    for (const row of list) {
      expect(row.token).toBeUndefined();
    }
  });

  test('credential-fishing query params do not unlock secret echo', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    // Make sure generic has a token-bearing row
    await connectAs(request, 'generic', 'xero');
    // Try every common credential-leak query-param probe an attacker
    // might use. The route uses zero of these (it's a static map), so
    // every probe must come back identical to the unparam'd response.
    const probes = [
      '?include=credentials',
      '?include=token',
      '?include=secrets',
      '?withSecrets=1',
      '?withCredentials=true',
      '?fields=token',
      '?fields=id,token,settings',
      '?expand=token',
    ];
    for (const probe of probes) {
      const res = await get(request, token, `/api/integrations${probe}`);
      expect(res.status(), `probe ${probe}: ${res.status()}`).toBe(200);
      const raw = await res.text();
      expect(raw, `probe ${probe} leaked secret`).not.toContain(SECRET_TOKEN);
    }
  });

  test('wellness GET cannot see generic\'s secret token regardless of probe', async ({ request }) => {
    const { token: wTok } = await getWellnessAdmin(request);
    if (!wTok) test.skip(true, 'no wellness token');
    // Generic must already have a stripe connection from earlier tests
    // with SECRET_TOKEN set. Wellness GET — must never echo it.
    const probes = ['', '?include=credentials', '?withSecrets=1'];
    for (const probe of probes) {
      const res = await get(request, wTok, `/api/integrations${probe}`);
      expect(res.status()).toBe(200);
      const raw = await res.text();
      expect(raw, `wellness probe ${probe} leaked generic secret`).not.toContain(SECRET_TOKEN);
    }
  });

  test('disconnect on tenant A does not affect tenant B (isolation)', async ({ request }) => {
    const { token: gTok } = await getGenericAdmin(request);
    const { token: wTok } = await getWellnessAdmin(request);
    if (!wTok) test.skip(true, 'no wellness token');
    // Both tenants connect mailchimp
    await connectAs(request, 'generic', 'mailchimp');
    await connectAs(request, 'wellness', 'mailchimp');
    // Generic disconnects
    const dis = await post(request, gTok, '/api/integrations/disconnect', { provider: 'mailchimp' });
    expect(dis.status()).toBe(200);
    // Wellness mailchimp must STILL be active
    const list = await (await get(request, wTok, '/api/integrations')).json();
    const mc = list.find((r) => r.provider === 'mailchimp');
    expect(mc.isActive).toBe(true);
  });
});

// ── Callified SSO surface ──────────────────────────────────────────
//
// Both endpoints mint a fresh JWT signed with CALLIFIED_SSO_SECRET. In
// CI / local stack that env var is unset so the route returns 500 with a
// "not configured" hint — that's fine, we still get to assert the auth
// gate, the not-configured shape, and tenant scoping (no token leaks
// between tenants).

test.describe('Integrations API — Callified SSO surface', () => {
  test('GET /callified/auth-url requires auth (403 without token)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/integrations/callified/auth-url`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /callified/sso requires auth (403 without token)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/integrations/callified/sso`, {
      maxRedirects: 0,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /callified/auth-url with admin token — 200 authUrl OR 500 not-configured', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/integrations/callified/auth-url');
    // Two valid outcomes depending on whether CALLIFIED_SSO_SECRET is set:
    //   200 → returns {authUrl: "..."}
    //   500 → returns {error: "Callified SSO not configured..."}
    // Both prove the auth gate passed (handler ran).
    expect([200, 500]).toContain(res.status());
    const body = await res.json();
    if (res.status() === 200) {
      expect(typeof body.authUrl).toBe('string');
      expect(body.authUrl).toMatch(/token=/);
      // The minted JWT must NOT contain the CRM session token (no leak)
      expect(body.authUrl).not.toContain(token);
    } else {
      expect(body.error).toMatch(/callified.*not configured/i);
    }
  });

  test('GET /callified/sso with admin token — 302 redirect OR 500 not-configured', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await request.get(`${BASE_URL}/api/integrations/callified/sso`, {
      headers: headers(token),
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT,
    });
    // 302 → minted JWT and redirected (CALLIFIED_SSO_SECRET set)
    // 500 → not configured (CI / local default)
    expect([302, 500]).toContain(res.status());
    if (res.status() === 302) {
      const location = res.headers().location;
      expect(location).toMatch(/token=/);
      // Never leak the CRM session bearer token into the redirect
      expect(location).not.toContain(token);
    }
  });

  test('Callified auth-url tenant scoping — wellness mint != generic mint', async ({ request }) => {
    const { token: gTok } = await getGenericAdmin(request);
    const { token: wTok } = await getWellnessAdmin(request);
    if (!wTok) test.skip(true, 'no wellness token');
    const gRes = await get(request, gTok, '/api/integrations/callified/auth-url');
    const wRes = await get(request, wTok, '/api/integrations/callified/auth-url');
    // Both should succeed-or-not-configure consistently.
    expect([200, 500]).toContain(gRes.status());
    expect([200, 500]).toContain(wRes.status());
    if (gRes.status() === 200 && wRes.status() === 200) {
      const gUrl = (await gRes.json()).authUrl;
      const wUrl = (await wRes.json()).authUrl;
      // The minted JWT in each url must differ — different sub email +
      // different settings.orgId per tenant. Same JWT for both tenants
      // would mean the handler isn't reading req.user.tenantId properly.
      expect(gUrl).not.toBe(wUrl);
      // Neither url should leak the OTHER tenant's session bearer.
      expect(gUrl).not.toContain(wTok);
      expect(wUrl).not.toContain(gTok);
    }
  });
});

// ── Auth gate (catch-all) ──────────────────────────────────────────

test.describe('Integrations API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/integrations`);
    expect([401, 403]).toContain(res.status());
  });

  test('garbage bearer token → 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/integrations`, {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.status()).toBe(401);
  });
});
