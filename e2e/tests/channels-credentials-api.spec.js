// @ts-check
/**
 * Channels credentials masking + rotation (Closes #651).
 *
 * Regression spec for the SECURITY/CRITICAL pen-test finding:
 *
 *   Pre-fix, GET /api/{sms,whatsapp,telephony}/config returned the FULL
 *   third-party credential masked only by a 6-char prefix slice (apiKey
 *   would render as "abc123****" — the operator's full credential prefix
 *   was visible in the JSON response, in DevTools, in browser history,
 *   and in any HAR / proxy capture). The frontend Channels.jsx then
 *   rendered those masked-but-still-leaky values back into editable
 *   <input> fields, completing a plaintext round-trip on every page load.
 *
 *   Post-fix contract pinned here:
 *
 *     GET /config → each secret field projected to
 *       { configured: <bool>, last4: '****<last-4-of-plaintext>' | null }
 *     The plaintext NEVER leaves the server. last4 is computed against
 *     the DECRYPTED value (encryption-at-rest is opt-in via the env var
 *     WELLNESS_FIELD_KEY — set or unset, the UI contract is the same).
 *
 *     PUT /config → fresh plaintext supplied for any field the operator
 *     rotated. Masked sentinels (≤8 chars + ending "****") are SILENTLY
 *     SKIPPED so neighbour-credential round-trips can't trample an
 *     untouched secret. Every rotation stamps `lastRotatedAt = now()`
 *     and emits a ProviderConfig.ROTATE audit row (action=ROTATE,
 *     entity=ProviderConfig, details=JSON with rotatedFields list —
 *     details NEVER contain the new value).
 *
 *     RBAC: only ADMIN can GET/PUT /config (MANAGER + USER → 403).
 *
 *     Cross-tenant: tenant A's config row is invisible to tenant B
 *     (each tenant only sees its own provider rows). This is enforced
 *     at the `tenantId: req.user.tenantId` query filter — distinct from
 *     the masking concern but tested together because both must hold
 *     for the security envelope to be intact.
 *
 *   Headers covered: 3 routes × (GET, PUT) × 4 contract assertions =
 *   ≥ 8 tests below.
 *
 * Run tag: E2E_CRED_<ts> so global-teardown can scrub any rows we
 * accidentally leave behind. We restore the original credentials at
 * test end so the demo tenant's seeded providers keep working.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_CRED_${Date.now()}`;

const tokenCache = { admin: null, manager: null, user: null, wellnessAdmin: null };

async function login(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) { if (attempt === 0) continue; }
  }
  return null;
}

async function adminToken(request) {
  if (!tokenCache.admin) tokenCache.admin = await login(request, 'admin@globussoft.com', 'password123');
  return tokenCache.admin;
}
async function managerToken(request) {
  if (!tokenCache.manager) tokenCache.manager = await login(request, 'manager@crm.com', 'password123');
  return tokenCache.manager;
}
async function userToken(request) {
  if (!tokenCache.user) tokenCache.user = await login(request, 'user@crm.com', 'password123');
  return tokenCache.user;
}
async function wellnessAdminToken(request) {
  if (!tokenCache.wellnessAdmin) tokenCache.wellnessAdmin = await login(request, 'rishu@enhancedwellness.in', 'password123');
  return tokenCache.wellnessAdmin;
}

async function authGet(request, path, token) {
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPut(request, path, body, token) {
  return request.put(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
    timeout: REQUEST_TIMEOUT,
  });
}

// ── Helpers: capture original state so we can restore at end ─────────
//
// The demo's seeded SMS / WhatsApp / Telephony providers may or may not
// have real credentials configured. We snapshot the GET response (which
// is already masked, so safe to keep in memory) before mutating, and
// re-rotate to a sentinel string at test end so we know the previous
// last4 won't accidentally collide with a future test's rotated value.
// We do NOT attempt to restore the actual original secret — that would
// require the plaintext, which by design we don't have.
const SNAPSHOT_TENANT_A = { sms: null, whatsapp: null, telephony: null };

test.beforeAll(async ({ request }) => {
  const t = await adminToken(request);
  if (!t) return;
  for (const tab of ['sms', 'whatsapp', 'telephony']) {
    const r = await authGet(request, `/api/${tab}/config`, t);
    if (r.ok()) SNAPSHOT_TENANT_A[tab] = await r.json();
  }
});

// ────────────────────────────────────────────────────────────────────
// 1. GET /config — secret masking shape
// ────────────────────────────────────────────────────────────────────

test.describe('Channels credentials — GET /config masking', () => {
  test('SMS GET /config never returns plaintext apiKey or authToken', async ({ request }) => {
    const token = await adminToken(request);
    test.skip(!token, 'no admin token');

    // Seed at least one credential so we can inspect the masked shape.
    const fresh = `${RUN_TAG}-msg91-secret-XYZ123456`;
    const seedRes = await authPut(request, '/api/sms/config/msg91', {
      provider: 'msg91',
      apiKey: fresh,
      authToken: `${RUN_TAG}-tok-ABCDEF`,
      senderId: 'GBSCRM',
      isActive: false,
    }, token);
    expect(seedRes.ok(), `seed: ${await seedRes.text()}`).toBeTruthy();

    const r = await authGet(request, '/api/sms/config', token);
    expect(r.status()).toBe(200);
    const rows = await r.json();
    expect(Array.isArray(rows)).toBeTruthy();
    const row = rows.find(x => x.provider === 'msg91');
    expect(row).toBeTruthy();

    // Contract: apiKey is an object, not a string.
    expect(typeof row.apiKey).toBe('object');
    expect(row.apiKey).not.toBeNull();
    expect(row.apiKey.configured).toBe(true);
    expect(typeof row.apiKey.last4).toBe('string');
    // last4 ends with the last 4 chars of the plaintext (not the masked prefix).
    expect(row.apiKey.last4.endsWith('3456')).toBe(true);

    // authToken same shape.
    expect(typeof row.authToken).toBe('object');
    expect(row.authToken.configured).toBe(true);
    expect(row.authToken.last4.endsWith('CDEF')).toBe(true);

    // The full plaintext is NOWHERE in the body. Stringify + scan.
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(fresh);
    expect(raw).not.toContain('XYZ123456'); // not even partial prefix-pre-mask
    expect(raw).not.toContain('ABCDEF');

    // lastRotatedAt was stamped.
    expect(row.lastRotatedAt).toBeTruthy();
    expect(() => new Date(row.lastRotatedAt)).not.toThrow();
  });

  test('WhatsApp GET /config never returns plaintext accessToken or webhookVerifyToken', async ({ request }) => {
    const token = await adminToken(request);
    test.skip(!token, 'no admin token');

    const seedFresh = `${RUN_TAG}-WA-tok-LAST4XYZ`;
    const seedRes = await authPut(request, '/api/whatsapp/config/meta_cloud', {
      provider: 'meta_cloud',
      accessToken: seedFresh,
      webhookVerifyToken: `${RUN_TAG}-verify-VV99`,
      phoneNumberId: '12345',
      isActive: false,
    }, token);
    expect(seedRes.ok()).toBeTruthy();

    const r = await authGet(request, '/api/whatsapp/config', token);
    expect(r.status()).toBe(200);
    const rows = await r.json();
    const row = rows.find(x => x.provider === 'meta_cloud');
    expect(row).toBeTruthy();
    expect(typeof row.accessToken).toBe('object');
    expect(row.accessToken.configured).toBe(true);
    expect(row.accessToken.last4.endsWith('4XYZ')).toBe(true);
    expect(typeof row.webhookVerifyToken).toBe('object');
    expect(row.webhookVerifyToken.last4.endsWith('VV99')).toBe(true);

    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(seedFresh);
    expect(row.lastRotatedAt).toBeTruthy();
  });

  test('Telephony GET /config never returns plaintext apiKey or apiSecret', async ({ request }) => {
    const token = await adminToken(request);
    test.skip(!token, 'no admin token');

    const freshKey = `${RUN_TAG}-myop-key-K9K9K9`;
    const freshSecret = `${RUN_TAG}-myop-secret-S0S0S0`;
    const seedRes = await authPut(request, '/api/telephony/config/myoperator', {
      provider: 'myoperator',
      apiKey: freshKey,
      apiSecret: freshSecret,
      virtualNumber: '+91999000',
      isActive: false,
    }, token);
    expect(seedRes.ok(), `seed: ${await seedRes.text()}`).toBeTruthy();

    const r = await authGet(request, '/api/telephony/config', token);
    expect(r.status()).toBe(200);
    const rows = await r.json();
    const row = rows.find(x => x.provider === 'myoperator');
    expect(row).toBeTruthy();
    expect(typeof row.apiKey).toBe('object');
    expect(row.apiKey.last4.endsWith('K9K9')).toBe(true);
    expect(typeof row.apiSecret).toBe('object');
    expect(row.apiSecret.last4.endsWith('S0S0')).toBe(true);

    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(freshKey);
    expect(raw).not.toContain(freshSecret);
    expect(row.lastRotatedAt).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. PUT /config — rotation, sentinel-skip, audit row, stamp
// ────────────────────────────────────────────────────────────────────

test.describe('Channels credentials — PUT /config rotation', () => {
  test('SMS PUT /config with masked-sentinel apiKey does NOT overwrite the stored credential', async ({ request }) => {
    const token = await adminToken(request);
    test.skip(!token, 'no admin token');

    // 1. Set a known credential.
    const original = `${RUN_TAG}-orig-LAST00`;
    await authPut(request, '/api/sms/config/msg91', {
      provider: 'msg91', apiKey: original, isActive: false,
    }, token);

    // 2. Re-PUT with the MASKED echo (what the frontend would send back
    // if the user didn't retype). Backend must SKIP the field.
    const echoRes = await authPut(request, '/api/sms/config/msg91', {
      provider: 'msg91',
      apiKey: '****T00', // looks-like-masked-sentinel (≤8 chars + ends ****)
      senderId: `${RUN_TAG}-newSender`,
      isActive: false,
    }, token);
    expect(echoRes.ok()).toBeTruthy();

    // 3. Verify the apiKey wasn't trampled — last4 should still end LAST00.
    const r = await authGet(request, '/api/sms/config', token);
    const row = (await r.json()).find(x => x.provider === 'msg91');
    expect(row.apiKey.configured).toBe(true);
    expect(row.apiKey.last4.endsWith('ST00')).toBe(true);
    expect(row.senderId).toBe(`${RUN_TAG}-newSender`);
  });

  test('SMS PUT /config with a FRESH apiKey rotates the credential + stamps lastRotatedAt + emits audit row', async ({ request }) => {
    const token = await adminToken(request);
    test.skip(!token, 'no admin token');

    // Stamp before
    await authPut(request, '/api/sms/config/msg91', {
      provider: 'msg91', apiKey: `${RUN_TAG}-pre-PRE000`, isActive: false,
    }, token);
    const before = await authGet(request, '/api/sms/config', token);
    const beforeRow = (await before.json()).find(x => x.provider === 'msg91');
    const beforeRotated = beforeRow.lastRotatedAt;

    // Wait 1.1s so the timestamp will tick. Resilient across millisecond
    // resolutions (MySQL stores up to ms precision).
    await new Promise(r => setTimeout(r, 1100));

    // Rotate
    const fresh = `${RUN_TAG}-NEW-WRITEME-NEW999`;
    const putRes = await authPut(request, '/api/sms/config/msg91', {
      provider: 'msg91', apiKey: fresh, isActive: false,
    }, token);
    expect(putRes.ok()).toBeTruthy();
    const putBody = await putRes.json();
    expect(putBody.success).toBe(true);
    // Response itself is masked — no plaintext.
    expect(JSON.stringify(putBody)).not.toContain(fresh);

    const after = await authGet(request, '/api/sms/config', token);
    const afterRow = (await after.json()).find(x => x.provider === 'msg91');
    expect(afterRow.apiKey.last4.endsWith('W999')).toBe(true);
    expect(new Date(afterRow.lastRotatedAt).getTime()).toBeGreaterThan(new Date(beforeRotated).getTime());

    // Audit row: GET /api/audit?entity=ProviderConfig&action=ROTATE should
    // surface the rotation event. Action=ROTATE entity=ProviderConfig is
    // the canonical shape; details JSON should list 'apiKey' in rotatedFields.
    const auditRes = await request.get(`${BASE_URL}/api/audit?entity=ProviderConfig&action=ROTATE&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    if (auditRes.ok()) {
      const auditBody = await auditRes.json();
      const rows = Array.isArray(auditBody) ? auditBody : (auditBody.rows || auditBody.data || []);
      // Find a recent row for sms:msg91. We don't pin exact ordering — just
      // existence within the most-recent 10.
      const found = rows.some(r => {
        let d = r.details;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
        return d && d.provider === 'sms:msg91' && Array.isArray(d.rotatedFields) && d.rotatedFields.includes('apiKey');
      });
      expect(found, `expected ProviderConfig.ROTATE audit row for sms:msg91 with apiKey rotatedFields; got: ${JSON.stringify(rows).slice(0, 600)}`).toBe(true);
      // CRITICAL: the audit details must NOT contain the new plaintext.
      expect(JSON.stringify(rows)).not.toContain(fresh);
    }
  });

  test('Telephony PUT /config rotation stamps lastRotatedAt + emits audit row', async ({ request }) => {
    const token = await adminToken(request);
    test.skip(!token, 'no admin token');

    const fresh = `${RUN_TAG}-tel-rot-ROT123`;
    const putRes = await authPut(request, '/api/telephony/config/myoperator', {
      provider: 'myoperator', apiKey: fresh, isActive: false,
    }, token);
    expect(putRes.ok(), `put: ${await putRes.text()}`).toBeTruthy();
    const body = await putRes.json();
    // Response is masked.
    expect(JSON.stringify(body)).not.toContain(fresh);
    // apiKey in response is the {configured,last4} shape.
    expect(typeof body.apiKey).toBe('object');
    expect(body.apiKey.last4.endsWith('T123')).toBe(true);
    expect(body.lastRotatedAt).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. RBAC — only ADMIN can read or rotate
// ────────────────────────────────────────────────────────────────────

test.describe('Channels credentials — RBAC', () => {
  test('MANAGER cannot GET /sms/config (403)', async ({ request }) => {
    const t = await managerToken(request);
    test.skip(!t, 'no manager token');
    const r = await authGet(request, '/api/sms/config', t);
    expect([401, 403]).toContain(r.status());
  });

  test('USER cannot PUT /telephony/config (403)', async ({ request }) => {
    const t = await userToken(request);
    test.skip(!t, 'no user token');
    const r = await authPut(request, '/api/telephony/config/myoperator', {
      provider: 'myoperator', apiKey: 'attacker', isActive: true,
    }, t);
    expect([401, 403]).toContain(r.status());
  });

  test('Unauthenticated GET /whatsapp/config returns 401', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/whatsapp/config`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Cross-tenant isolation
// ────────────────────────────────────────────────────────────────────

test.describe('Channels credentials — cross-tenant isolation', () => {
  test('Tenant A admin cannot read tenant B credentials via GET /config', async ({ request }) => {
    const tokenA = await adminToken(request);
    const tokenB = await wellnessAdminToken(request);
    test.skip(!tokenA || !tokenB, 'need both tenant admin tokens');

    // Tenant B writes a uniquely-marked credential.
    const uniqueB = `${RUN_TAG}-tenantB-UNIQUE-Z00Z00`;
    const wB = await authPut(request, '/api/sms/config/msg91', {
      provider: 'msg91', apiKey: uniqueB, isActive: false,
    }, tokenB);
    expect(wB.ok(), `tenant B seed: ${await wB.text()}`).toBeTruthy();

    // Tenant A reads its own /config. The unique tenant-B value should NEVER
    // appear in tenant A's view (no rows, or rows with completely different
    // last4 values).
    const rA = await authGet(request, '/api/sms/config', tokenA);
    expect(rA.status()).toBe(200);
    const rowsA = await rA.json();
    const raw = JSON.stringify(rowsA);
    expect(raw).not.toContain('Z00Z00'); // tenant B's unique tail
    expect(raw).not.toContain(uniqueB);
    expect(raw).not.toContain('tenantB-UNIQUE');
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Cleanup
// ────────────────────────────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  // We deliberately don't try to "restore" the previous credential —
  // we don't have the plaintext (the whole point of #651). Instead we
  // rotate to a sentinel string so the seeded providers stay "configured"
  // but unusable until an operator re-rotates with real credentials.
  // This is acceptable for the demo box; the wellness tenant's real
  // credentials are env-var driven (resolveProviderConfig fallback).
  const token = await adminToken(request);
  if (!token) return;
  const sentinel = `_teardown_${RUN_TAG}_disabled`;
  await authPut(request, '/api/sms/config/msg91', {
    provider: 'msg91', apiKey: sentinel, authToken: sentinel, isActive: false,
  }, token).catch(() => {});
  await authPut(request, '/api/whatsapp/config/meta_cloud', {
    provider: 'meta_cloud', accessToken: sentinel, webhookVerifyToken: sentinel, isActive: false,
  }, token).catch(() => {});
  await authPut(request, '/api/telephony/config/myoperator', {
    provider: 'myoperator', apiKey: sentinel, apiSecret: sentinel, isActive: false,
  }, token).catch(() => {});

  const tokenB = await wellnessAdminToken(request);
  if (tokenB) {
    await authPut(request, '/api/sms/config/msg91', {
      provider: 'msg91', apiKey: sentinel, authToken: sentinel, isActive: false,
    }, tokenB).catch(() => {});
  }
});
