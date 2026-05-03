// @ts-check
/**
 * Accounting Integrations API — R-1 from the 2026-05-03 gap-discovery survey.
 *
 * Target: backend/routes/accounting.js (337 lines, previously zero gated API
 * coverage — only a smoke spec at e2e/tests/accounting.spec.js that hits
 * crm.globusdemos.com and is NOT in the deploy-gate list).
 * Stub for QuickBooks / Xero / Tally sync flows: every sync handler
 * persists an AccountingSync row (provider + entityType + entityId +
 * tenantId) but does NOT make external HTTP calls. This spec asserts
 * the stub-shape contract every CRM caller depends on.
 *
 * Why this matters:
 *   - Real billing flows (invoices, expenses) are written by the wellness
 *     CRM and the legacy billing route. The /sync/all endpoint is the
 *     "one button to mirror to QBO/Xero/Tally" call from the Settings
 *     UI; if its skip-already-synced branch ever drifts, every accountant
 *     gets dupes on retry.
 *   - The webhook receiver is in the global-guard openPaths allowlist
 *     (server.js:261 lists "/accounting/webhook"), so this spec is also
 *     the regression for the public-route exclusion: a future PR that
 *     accidentally drops it from openPaths would surface here as the
 *     "no-token webhook works" assertion failing.
 *   - tenantId on AccountingSync is the multi-tenant data-isolation key.
 *     We assert that wellness tenant's AccountingSync rows do not
 *     surface in generic-admin's /synced list.
 *
 * Endpoints covered (all under /api/accounting):
 *   GET  /providers                          — auth, returns { quickbooks,
 *                                              xero, tally } each with
 *                                              { connected: bool, ... }
 *   POST /:provider/connect                  — auth, 400 unsupported provider,
 *                                              400 missing creds, 200 success
 *   POST /:provider/disconnect               — auth, 404 when no integration,
 *                                              200 marks isActive=false
 *   POST /:provider/sync/invoice/:id         — auth, 400 unsupported provider,
 *                                              400 invalid id, 404 missing,
 *                                              200 returns externalId
 *   POST /:provider/sync/expense/:id         — same shape
 *   POST /:provider/sync/all                 — bulk; success skips already-
 *                                              synced; returns { syncedCount,
 *                                              skippedCount, results[] }
 *   GET  /:provider/synced                   — paginated, returns
 *                                              { page, pageSize, total, items }
 *   POST /webhook/:provider                  — PUBLIC (no token), 400 on
 *                                              unsupported provider, 200 ok
 *
 * Contract pitfalls / non-obvious bits:
 *   - The Integration model uniqueness key is (tenantId, provider). connect
 *     is an upsert, NOT a strict create — calling connect twice in a row
 *     reuses the row. afterAll has to disconnect every (provider, tenantId)
 *     combo the spec ever connected, otherwise the next test run sees
 *     `connected: true` from leftover rows.
 *   - disconnect sets isActive=false but keeps the row. That's fine —
 *     subsequent /providers lists `connected: false`.
 *   - Provider names are case-insensitive on the way in (route lowercases
 *     via providerKey()). But the underlying Integration.provider is
 *     stored lowercase too, so a /sync/all?provider=QUICKBOOKS still
 *     matches existing rows.
 *   - sync/all has a NON-OBVIOUS edge: it loops over ALL invoices in the
 *     tenant and skips ones already in AccountingSync. If the seed
 *     contains 11 invoices and the spec has run before, syncedCount
 *     drops to 0 and skippedCount → 11. That's the documented behavior —
 *     spec asserts the IDEMPOTENT property (running it twice → second
 *     call has skippedCount === first call's syncedCount + skippedCount).
 *   - The webhook receiver does NOT verify HMAC signatures (intentional;
 *     real provider integrations are deferred). It's a no-op log + 200.
 *
 * Tenant isolation: cross-tenant /sync/invoice/:id and /sync/expense/:id
 * return 404 (since findFirst({tenantId}) miss). Wellness AccountingSync
 * rows do not surface in generic /synced list. Both asserted.
 *
 * Test-data tag: E2E_FLOW_ACCT_<ts>. afterAll disconnects every
 * (provider, tenant) connect that ran during the spec.
 *
 * Note on seed dependency: the generic seed has at least one invoice
 * (id=11 'INV-2026-011' in the dataset on 2026-05-03) and at least one
 * expense (id=10 'AWS credits...'). Spec discovers the actual
 * invoiceId/expenseId from /api/billing + /api/expenses at runtime
 * rather than hardcoding, so a future seed-id reshuffle won't break it.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_ACCT_${Date.now()}`;

// ── Dual-tenant auth ───────────────────────────────────────────────
//   admin@globussoft.com — generic ADMIN (primary)
//   admin@wellness.demo  — wellness ADMIN (cross-tenant probes)

let genericAdminToken = null;
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
        return j.token || null;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  }
  return genericAdminToken;
}
async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    wellnessAdminToken = await loginAs(request, 'admin@wellness.demo', 'password123');
  }
  return wellnessAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
// Each entry: { token, provider }. afterAll disconnects every combo.
const connectedDuringRun = [];

test.afterAll(async ({ request }) => {
  for (const { token, provider } of connectedDuringRun) {
    if (!token) continue;
    await post(request, token, `/api/accounting/${provider}/disconnect`, {}).catch(() => {});
  }
});

// Helper: connect with the right credential shape per provider
function connectBody(provider) {
  if (provider === 'quickbooks') {
    return { accessToken: `${RUN_TAG}-qbo-tok`, refreshToken: `${RUN_TAG}-qbo-refresh`, realmId: `${RUN_TAG}-realm` };
  }
  if (provider === 'xero') {
    return { accessToken: `${RUN_TAG}-xero-tok`, refreshToken: `${RUN_TAG}-xero-refresh`, xeroTenantId: `${RUN_TAG}-tenant` };
  }
  if (provider === 'tally') {
    return { url: 'http://127.0.0.1', port: 9000, companyName: `${RUN_TAG}-co` };
  }
  return {};
}

async function connect(request, token, provider) {
  const res = await post(request, token, `/api/accounting/${provider}/connect`, connectBody(provider));
  expect(res.status(), `connect ${provider}: ${await res.text()}`).toBe(200);
  connectedDuringRun.push({ token, provider });
  return res.json();
}

// Helper: discover a real invoice id from the generic billing route
async function firstInvoiceId(request, token) {
  const res = await get(request, token, '/api/billing?limit=1');
  expect(res.status()).toBe(200);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    test.skip(true, 'no seeded invoices on tenant — cannot exercise sync/invoice');
    return null;
  }
  return arr[0].id;
}

async function firstExpenseId(request, token) {
  const res = await get(request, token, '/api/expenses?limit=1');
  expect(res.status()).toBe(200);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    test.skip(true, 'no seeded expenses on tenant — cannot exercise sync/expense');
    return null;
  }
  return arr[0].id;
}

// ── GET /providers ─────────────────────────────────────────────────

test.describe('Accounting API — GET /providers', () => {
  test('200 returns three-provider status object', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await get(request, token, '/api/accounting/providers');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.quickbooks).toBeTruthy();
    expect(body.xero).toBeTruthy();
    expect(body.tally).toBeTruthy();
    expect(typeof body.quickbooks.connected).toBe('boolean');
    expect(typeof body.xero.connected).toBe('boolean');
    expect(typeof body.tally.connected).toBe('boolean');
  });

  test('reflects accountId / tenantId after a successful connect', async ({ request }) => {
    const token = await getGenericAdmin(request);
    await connect(request, token, 'quickbooks');
    const res = await get(request, token, '/api/accounting/providers');
    const body = await res.json();
    expect(body.quickbooks.connected).toBe(true);
    expect(body.quickbooks.accountId).toBe(`${RUN_TAG}-realm`);
  });
});

// ── POST /:provider/connect ────────────────────────────────────────

test.describe('Accounting API — POST /:provider/connect', () => {
  test('400 on unsupported provider', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/sage/connect', {
      accessToken: 'x', refreshToken: 'y', realmId: 'z',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/unsupported provider/i);
  });

  test('400 quickbooks missing realmId', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/quickbooks/connect', {
      accessToken: 'x', refreshToken: 'y',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/quickbooks/i);
  });

  test('400 xero missing xeroTenantId', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/xero/connect', {
      accessToken: 'x', refreshToken: 'y',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/xero/i);
  });

  test('400 tally missing companyName', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/tally/connect', {
      url: 'http://127.0.0.1', port: 9000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/tally/i);
  });

  test('200 xero happy path returns success+id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/xero/connect', connectBody('xero'));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.provider).toBe('xero');
    expect(typeof body.id).toBe('number');
    connectedDuringRun.push({ token, provider: 'xero' });
  });

  test('200 tally happy path (no token, all settings)', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/tally/connect', connectBody('tally'));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.provider).toBe('tally');
    connectedDuringRun.push({ token, provider: 'tally' });
  });
});

// ── POST /:provider/disconnect ─────────────────────────────────────

test.describe('Accounting API — POST /:provider/disconnect', () => {
  test('400 on unsupported provider', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/sage/disconnect', {});
    expect(res.status()).toBe(400);
  });

  test('404 when no integration row exists for tenant+provider', async ({ request }) => {
    // Wellness tenant: precondition — no quickbooks integration ever
    // connected for this tenant during this run. Sister specs probably
    // haven't touched it either; if they did, this test will see 200
    // instead. Defensive: try disconnect first to drain any leftover,
    // then assert the cold 404.
    const token = await getWellnessAdmin(request);
    if (!token) test.skip(true, 'no wellness admin token');
    await post(request, token, '/api/accounting/quickbooks/disconnect', {}).catch(() => {});
    const res = await post(request, token, '/api/accounting/quickbooks/disconnect', {});
    expect(res.status()).toBe(404);
  });

  test('200 happy path after a connect', async ({ request }) => {
    const token = await getGenericAdmin(request);
    // Ensure connected first
    await connect(request, token, 'tally');
    const res = await post(request, token, '/api/accounting/tally/disconnect', {});
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // /providers should now reflect tally as disconnected
    const status = await get(request, token, '/api/accounting/providers');
    expect((await status.json()).tally.connected).toBe(false);
  });
});

// ── POST /:provider/sync/invoice/:id ───────────────────────────────

test.describe('Accounting API — POST /:provider/sync/invoice/:id', () => {
  test('400 unsupported provider', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/sage/sync/invoice/1', {});
    expect(res.status()).toBe(400);
  });

  test('400 invalid invoice id (non-numeric)', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/quickbooks/sync/invoice/abc', {});
    expect(res.status()).toBe(400);
    // Post-#423: the global validateNumericId middleware short-circuits
    // before the route-specific handler, so the message is generic
    // ("Invalid id: ...") not the prior "invalid invoice id". Pin the
    // durable contract (status + code), let the message text be generic.
    const body = await res.json();
    expect(body.error).toMatch(/invalid id/i);
    expect(body.code).toBe('INVALID_ID');
  });

  test('404 unknown invoice id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/quickbooks/sync/invoice/99999999', {});
    expect(res.status()).toBe(404);
  });

  test('200 returns success + STUB externalId on a real seeded invoice', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const invoiceId = await firstInvoiceId(request, token);
    if (!invoiceId) return;
    const res = await post(request, token, `/api/accounting/quickbooks/sync/invoice/${invoiceId}`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.externalId).toBe('string');
    expect(body.externalId).toMatch(/^STUB_/);
  });
});

// ── POST /:provider/sync/expense/:id ───────────────────────────────

test.describe('Accounting API — POST /:provider/sync/expense/:id', () => {
  test('400 invalid expense id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/xero/sync/expense/abc', {});
    expect(res.status()).toBe(400);
  });

  test('404 unknown expense id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/xero/sync/expense/99999999', {});
    expect(res.status()).toBe(404);
  });

  test('200 returns success + STUB externalId on a real seeded expense', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const expenseId = await firstExpenseId(request, token);
    if (!expenseId) return;
    const res = await post(request, token, `/api/accounting/xero/sync/expense/${expenseId}`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.externalId).toMatch(/^STUB_/);
  });
});

// ── POST /:provider/sync/all ───────────────────────────────────────

test.describe('Accounting API — POST /:provider/sync/all', () => {
  test('200 returns { syncedCount, skippedCount, results[] }', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/tally/sync/all', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.syncedCount).toBe('number');
    expect(typeof body.skippedCount).toBe('number');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBe(body.syncedCount);
    for (const r of body.results) {
      expect(typeof r.invoiceId).toBe('number');
      expect(r.externalId).toMatch(/^STUB_/);
    }
  });

  test('idempotent — second call has skippedCount === first call total', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const first = await post(request, token, '/api/accounting/tally/sync/all', {});
    const firstBody = await first.json();
    const total = firstBody.syncedCount + firstBody.skippedCount;

    const second = await post(request, token, '/api/accounting/tally/sync/all', {});
    const secondBody = await second.json();
    expect(secondBody.syncedCount).toBe(0);
    expect(secondBody.skippedCount).toBe(total);
  });

  test('400 unsupported provider', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/accounting/sage/sync/all', {});
    expect(res.status()).toBe(400);
  });
});

// ── GET /:provider/synced (paginated) ──────────────────────────────

test.describe('Accounting API — GET /:provider/synced', () => {
  test('200 returns { page, pageSize, total, items }', async ({ request }) => {
    const token = await getGenericAdmin(request);
    // Make sure tally has at least one synced row from the sync/all run
    await post(request, token, '/api/accounting/tally/sync/all', {});
    const res = await get(request, token, '/api/accounting/tally/synced');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(typeof body.total).toBe('number');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBeGreaterThan(0);
  });

  test('respects page + pageSize, caps pageSize at 200', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await get(request, token, '/api/accounting/tally/synced?page=1&pageSize=999');
    expect(res.status()).toBe(200);
    expect((await res.json()).pageSize).toBe(200);
  });

  test('400 unsupported provider', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await get(request, token, '/api/accounting/sage/synced');
    expect(res.status()).toBe(400);
  });
});

// ── POST /webhook/:provider (PUBLIC) ───────────────────────────────

test.describe('Accounting API — POST /webhook/:provider (PUBLIC)', () => {
  test('200 without any auth token (server.js openPaths allowlist)', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/accounting/webhook/quickbooks`, {
      data: { event: 'invoice.created', stub: true },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.received).toBe(true);
  });

  test('200 also accepts xero + tally', async ({ request }) => {
    for (const provider of ['xero', 'tally']) {
      const res = await request.post(`${BASE_URL}/api/accounting/webhook/${provider}`, {
        data: { ping: 1 },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      expect(res.status(), `webhook ${provider}: ${await res.text()}`).toBe(200);
    }
  });

  test('400 on unsupported provider', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/accounting/webhook/sage`, {
      data: { ping: 1 },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────

test.describe('Accounting API — tenant isolation', () => {
  test('wellness admin cannot sync generic-tenant invoice (404 even if id exists)', async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token');
    const genericInvoiceId = await firstInvoiceId(request, adminTok);
    if (!genericInvoiceId) return;

    const res = await post(request, wellnessTok, `/api/accounting/quickbooks/sync/invoice/${genericInvoiceId}`, {});
    expect(res.status()).toBe(404);
  });

  test('wellness admin cannot sync generic-tenant expense (404)', async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token');
    const genericExpenseId = await firstExpenseId(request, adminTok);
    if (!genericExpenseId) return;

    const res = await post(request, wellnessTok, `/api/accounting/xero/sync/expense/${genericExpenseId}`, {});
    expect(res.status()).toBe(404);
  });

  test("/synced is tenant-scoped — wellness cannot see generic's synced rows", async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token');

    // Drive a generic-tenant sync/all so generic has tally rows, and a
    // wellness sync/all (separately) so wellness has its own rows.
    await post(request, adminTok, '/api/accounting/tally/sync/all', {});
    await post(request, wellnessTok, '/api/accounting/tally/sync/all', {});

    const generic = await get(request, adminTok, '/api/accounting/tally/synced?pageSize=200');
    const wellness = await get(request, wellnessTok, '/api/accounting/tally/synced?pageSize=200');

    const genericIds = new Set((await generic.json()).items.map((i) => i.id));
    const wellnessIds = new Set((await wellness.json()).items.map((i) => i.id));

    // Cross-intersection should be empty (each row carries exactly one tenant).
    for (const id of genericIds) {
      expect(wellnessIds.has(id)).toBe(false);
    }
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Accounting API — auth gate', () => {
  test('GET /providers without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/accounting/providers`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:provider/connect without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/accounting/quickbooks/connect`, {
      data: { accessToken: 'x', refreshToken: 'y', realmId: 'z' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:provider/sync/invoice/:id without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/accounting/quickbooks/sync/invoice/1`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:provider/sync/all without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/accounting/tally/sync/all`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:provider/synced without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/accounting/tally/synced`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:provider/disconnect without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/accounting/tally/disconnect`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:provider/connect with garbage token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/accounting/quickbooks/connect`, {
      data: { accessToken: 'x', refreshToken: 'y', realmId: 'z' },
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer garbage.garbage.garbage',
      },
    });
    expect([401, 403]).toContain(res.status());
  });
});
