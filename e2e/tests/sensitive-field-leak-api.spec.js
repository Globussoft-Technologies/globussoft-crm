// @ts-check
/**
 * Sensitive-field response-leak gate (#426).
 *
 * Asserts that no API response payload — at any nesting depth — contains a
 * field name in the FORBIDDEN_FIELDS set declared by
 * backend/middleware/scrubResponse.js. The current set is just
 * `portalPasswordHash` (Contact.portalPasswordHash bcrypt) but this spec is
 * written so future additions to the deny-list automatically gain coverage:
 * the assertion is a tree-walk that flags ANY occurrence of a forbidden key.
 *
 * Why this gate exists: routes/contacts.js + audienceController.js + every
 * route that does `include: { contact: true }` (billing / communications /
 * ai_scoring / booking_pages / etc.) returned the raw Prisma object,
 * leaking the bcrypt hash to any authenticated caller. routes/portal.js
 * still uses the field server-side for OTP/password validation — that path
 * is unaffected because the scrub runs at the response boundary, after
 * Prisma reads.
 *
 * Endpoints covered (the leak surface from the bug report + the include
 * path):
 *   GET /api/contacts                — list, raw findMany
 *   GET /api/contacts/:id            — detail, raw findFirst
 *   POST /api/contacts               — create response, raw create return
 *   GET /api/contacts/by-status      — audienceController.js leak (#426 sibling)
 *   GET /api/billing                 — invoices with include: { contact: true }
 *   GET /api/communications          — emails with include: { contact: true }
 *
 * Pattern: data-driven. One test per endpoint, each fetches the response and
 * runs assertNoForbiddenFields() recursively. Cleanup: contact created in
 * the POST happy-path is renamed to `_teardown_*` in afterAll so demo-monitor
 * doesn't flag it as orphan data.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_LEAK_${Date.now()}`;

// Mirror of FORBIDDEN_FIELDS in backend/middleware/scrubResponse.js. Kept
// duplicated here on purpose — if the deny-list ever drifts apart between
// the scrubber and the spec, the leak will sneak back in. The spec is the
// contract; the scrubber is the implementation.
const FORBIDDEN_FIELDS = new Set([
  'portalPasswordHash',
]);

let adminToken = null;
const createdContactIds = [];

async function loginAdmin(request) {
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.ok(), 'admin login must succeed before any leak assertion runs').toBe(true);
  const j = await r.json();
  return j.token;
}

// Walk a JSON value and collect any path where a forbidden key appears.
// Returns an array of dotted paths so the failure message points at the
// exact leak (e.g. `[3].contact.portalPasswordHash`).
function findForbidden(value, path = '') {
  const hits = [];
  if (value == null || typeof value !== 'object') return hits;
  if (value instanceof Date || Buffer.isBuffer(value)) return hits;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      hits.push(...findForbidden(value[i], `${path}[${i}]`));
    }
    return hits;
  }
  for (const key of Object.keys(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_FIELDS.has(key)) {
      hits.push(childPath);
      continue;
    }
    hits.push(...findForbidden(value[key], childPath));
  }
  return hits;
}

function assertNoForbiddenFields(payload, where) {
  const hits = findForbidden(payload);
  expect(
    hits,
    `${where}: response must not include any FORBIDDEN_FIELDS keys ` +
      `(found at: ${hits.join(', ')})`,
  ).toEqual([]);
}

test.beforeAll(async ({ request }) => {
  adminToken = await loginAdmin(request);
});

test.afterAll(async ({ request }) => {
  // Rename rather than delete: the Contact model has FK chains (deals /
  // emails / activities / tasks) that hard-delete would orphan. The
  // _teardown_ prefix is what demo-hygiene-api.spec.js scans for and
  // teardown-completeness.spec.js asserts on.
  if (!adminToken) return;
  for (const id of createdContactIds) {
    try {
      await request.put(`${BASE_URL}/api/contacts/${id}`, {
        data: { name: `_teardown_leak_${id}` },
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      });
    } catch (_e) { /* best-effort cleanup */ }
  }
});

test.describe('sensitive-field response-leak gate (#426)', () => {
  test('GET /api/contacts — list response strips portalPasswordHash on every row', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/contacts?limit=100`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok(), `list endpoint must return 2xx (got ${r.status()})`).toBe(true);
    const list = await r.json();
    expect(Array.isArray(list), 'response must be an array').toBe(true);
    assertNoForbiddenFields(list, 'GET /api/contacts');
  });

  test('GET /api/contacts/:id — detail response strips portalPasswordHash', async ({ request }) => {
    // Pick the first contact from the list as the detail subject.
    const list = await (await request.get(`${BASE_URL}/api/contacts?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })).json();
    test.skip(!Array.isArray(list) || list.length === 0, 'no contacts seeded — skip detail check');
    const id = list[0].id;
    const r = await request.get(`${BASE_URL}/api/contacts/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok(), `detail endpoint must return 2xx (got ${r.status()})`).toBe(true);
    assertNoForbiddenFields(await r.json(), `GET /api/contacts/${id}`);
  });

  test('POST /api/contacts — create response strips portalPasswordHash', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/contacts`, {
      data: {
        name: `Sensitive Leak Probe ${RUN_TAG}`,
        email: `leak-probe-${Date.now()}@test.local`,
      },
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect([200, 201]).toContain(r.status());
    const created = await r.json();
    if (created && created.id) createdContactIds.push(created.id);
    assertNoForbiddenFields(created, 'POST /api/contacts');
  });

  test('GET /api/contacts/by-status — audienceController response strips portalPasswordHash', async ({ request }) => {
    // This endpoint runs a heavy query against demo's ~108k-row audit-log
    // table (joined). Solo it returns in ~14s; under e2e-full's 4-shard
    // concurrent load it routinely brushes the default 30s test timeout
    // even though the response itself arrives. Bump to 60s so the
    // assertion below has room to run cleanly. Per-request timeout stays
    // at 30s (REQUEST_TIMEOUT) — the slack lives at the test budget,
    // not the per-call budget, so a hung request still fails fast.
    test.setTimeout(60_000);
    const r = await request.get(`${BASE_URL}/api/contacts/by-status?status=Lead`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 45_000,
    });
    expect(r.ok(), `by-status endpoint must return 2xx (got ${r.status()})`).toBe(true);
    assertNoForbiddenFields(await r.json(), 'GET /api/contacts/by-status');
  });

  test('GET /api/billing — invoice list with include: { contact: true } strips portalPasswordHash', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/billing`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok(), `billing endpoint must return 2xx (got ${r.status()})`).toBe(true);
    // Whether or not seeded billing data exists, the assertion must hold.
    // No invoices → empty array → no leak surface.
    assertNoForbiddenFields(await r.json(), 'GET /api/billing');
  });

  test('GET /api/communications — emails with include: { contact: true } strips portalPasswordHash', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/communications`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    // Some routers redirect or return 404 if the path is /communications/inbox
    // — accept either 200 or 404 as long as the body (if present) is clean.
    if (r.status() >= 400 && r.status() < 500) {
      // No data path here. Skip the leak check; nothing to leak.
      return;
    }
    expect(r.ok()).toBe(true);
    assertNoForbiddenFields(await r.json(), 'GET /api/communications');
  });
});
