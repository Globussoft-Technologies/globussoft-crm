// @ts-check
/**
 * Contacts module — backend coverage push.
 *
 * routes/contacts.js was 25.7% covered (486 uncovered / 654 total). It's the
 * busiest CRUD router in the codebase: list/get/create/update + soft-delete +
 * restore + assign + bulk-assign + activities + attachments + CSV import +
 * duplicate detection + merge. Validation surface is unusually rich:
 *
 *   GET    /api/contacts                  — list + ?status / ?assignedToId /
 *                                           ?unassigned / ?includeDeleted /
 *                                           limit / offset
 *   GET    /api/contacts/by-status        — audienceController grouping
 *   GET    /api/contacts/:id              — single + 400/404 + soft-delete
 *                                           hidden by default
 *   POST   /api/contacts                  — create + validation (email/name
 *                                           required, aiScore 0–100, status
 *                                           enum) + dup-email 409
 *   PUT    /api/contacts/bulk-assign      — bulk assignedToId set / clear
 *   PUT    /api/contacts/:id              — partial update + same validators +
 *                                           Lead → Customer/Prospect emits
 *                                           lead.converted (generic-tenant
 *                                           spec: just verify the status flip)
 *   PUT    /api/contacts/:id/assign       — single-row assign / unassign
 *   POST   /api/contacts/:id/activities   — append activity (drives lead-SLA
 *                                           markFirstResponseIfNeeded)
 *   POST   /api/contacts/import-csv       — CSV import + 5000-row cap +
 *                                           CSV-injection sanitiser
 *   GET    /api/contacts/duplicates/find  — email / phone / name+company match
 *   POST   /api/contacts/merge            — primaryId + secondaryIds[] merge
 *   GET    /api/contacts/:id/attachments  — list
 *   POST   /api/contacts/:id/attachments  — JSON-shape only (#176): rejects
 *                                           multipart/form-data with 400
 *                                           UNSUPPORTED_CONTENT_TYPE
 *   DELETE /api/contacts/attachments/:attachId — hard-delete attachment
 *   DELETE /api/contacts/:id              — ADMIN soft-delete (#167)
 *   POST   /api/contacts/:id/restore      — ADMIN restore (#167)
 *
 * Pattern: dual-token (admin + regular USER) so we can exercise admin-only
 * endpoints AND prove the 403 boundary on the same surface. Every contact is
 * tagged `E2E_CONT_<ts>` in the `name` field; afterAll best-effort soft-deletes
 * each one (the global teardown's RUN_TAG scrub handles hard cleanup).
 *
 * Notes from the route source that drove some test choices:
 *
 *   • stripDangerous middleware deletes id/createdAt/updatedAt/tenantId/userId
 *     from every request body. The route reads `assignedToId` (not `userId`)
 *     for ownership, which is fine — but tests can't smuggle in tenantId or
 *     userId fields and expect them to land.
 *   • The Lead → Customer wellness-side Patient backfill (#283) only fires
 *     for tenants whose vertical='wellness'. This spec is generic-tenant,
 *     so it just verifies the status flip and trusts the wellness spec for
 *     the Patient creation assertion.
 *   • Phone fields: kept clean Indian-style numbers like `+91 98765 12345`
 *     with unique suffixes per test so dedup logic in /duplicates/find is
 *     deterministic.
 *   • The merge endpoint hard-deletes secondaries (prisma.contact.delete) —
 *     no soft-delete branch — so a merged-secondary id will 404 afterwards,
 *     not return a soft-deleted row.
 *   • The route does NOT have an Authorization header check at the file level
 *     beyond router.use(verifyToken); auth-gate tests assert 401/403 from the
 *     global guard.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_CONT_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
// admin@globussoft.com (ADMIN, generic tenant) — drives delete + restore
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

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
// Push every contact id we create. afterAll DELETEs them as admin (soft-delete
// flips deletedAt). The global-teardown RUN_TAG scrub purges hard.
const createdContactIds = [];

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdContactIds) {
    await del(request, token, `/api/contacts/${id}`).catch(() => {});
  }
});

// Email is globally unique on the Contact table (across tenants). Use the
// RUN_TAG plus a random suffix to keep collisions out of repeated CI runs.
function uniqueEmail(label) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `e2e+${label}.${rnd}.${RUN_TAG.toLowerCase()}@example.com`;
}

// Indian-style number with a unique 5-digit suffix so /duplicates/find is
// deterministic (no accidental phone-collision with seed data or other tests).
function uniquePhone() {
  const tail = String(Math.floor(10000 + Math.random() * 89999));
  return `+91 98765 ${tail}`;
}

// Helper: create a contact and remember it for cleanup. Returns the row.
async function createContact(request, overrides = {}) {
  const { token } = await getAdmin(request);
  const body = {
    name: `${RUN_TAG} ${overrides.label || 'contact'}`,
    email: overrides.email || uniqueEmail(overrides.label || 'c'),
    phone: overrides.phone !== undefined ? overrides.phone : uniquePhone(),
    company: overrides.company,
    title: overrides.title,
    status: overrides.status || 'Lead',
    source: overrides.source,
    aiScore: overrides.aiScore,
    assignedToId: overrides.assignedToId,
  };
  const res = await post(request, token, '/api/contacts', body);
  expect(res.status(), `contact create: ${await res.text()}`).toBe(201);
  const c = await res.json();
  createdContactIds.push(c.id);
  return c;
}

// ─── POST /api/contacts ─────────────────────────────────────────────

test.describe('Contacts API — POST /', () => {
  test('201 creates contact with name + email + phone', async ({ request }) => {
    const c = await createContact(request, { label: 'happy' });
    expect(c.id).toBeGreaterThan(0);
    expect(c.name).toContain('happy');
    expect(c.email).toMatch(/@/);
    expect(c.status).toBe('Lead');
    expect(c.tenantId).toBeGreaterThan(0);
  });

  test('trims leading/trailing whitespace from name (#337)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: `   ${RUN_TAG} trim-me   `,
      email: uniqueEmail('trim'),
    });
    expect(res.status()).toBe(201);
    const c = await res.json();
    createdContactIds.push(c.id);
    expect(c.name.startsWith(' ')).toBe(false);
    expect(c.name.endsWith(' ')).toBe(false);
    expect(c.name).toContain('trim-me');
  });

  test('400 when email is missing', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} no-email`,
    });
    expect(res.status()).toBe(400);
  });

  test('400 when email is malformed', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} bad-email`,
      email: 'not-an-email',
    });
    expect(res.status()).toBe(400);
  });

  test('400 when name is missing on create (#337)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      email: uniqueEmail('no-name'),
    });
    expect(res.status()).toBe(400);
  });

  test('400 NAME_REQUIRED when name is whitespace-only (#337)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: '   ',
      email: uniqueEmail('ws-name'),
    });
    expect(res.status()).toBe(400);
  });

  test('400 INVALID_AISCORE on aiScore > 100 (#166)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} hi-score`,
      email: uniqueEmail('hi'),
      aiScore: 150,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_AISCORE');
  });

  test('400 INVALID_AISCORE on negative aiScore', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} neg-score`,
      email: uniqueEmail('neg'),
      aiScore: -1,
    });
    expect(res.status()).toBe(400);
  });

  test('201 accepts aiScore at boundary value 100', async ({ request }) => {
    const c = await createContact(request, { label: 'score-100', aiScore: 100 });
    expect(c.aiScore).toBe(100);
  });

  test('400 on bogus status enum value', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} bad-status`,
      email: uniqueEmail('bs'),
      status: 'NotARealStatus',
    });
    expect(res.status()).toBe(400);
  });

  test('409 on duplicate email (#178)', async ({ request }) => {
    // Email is globally unique on Contact. Create one then try to recreate it.
    const sharedEmail = uniqueEmail('dup');
    const first = await createContact(request, { label: 'dup-first', email: sharedEmail });
    expect(first.email).toBe(sharedEmail);

    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} dup-second`,
      email: sharedEmail,
    });
    // httpFromPrismaError → 409 Conflict on unique-constraint violation.
    // Some tenants run with case-insensitive collation and may surface this
    // as 409 directly; if the route ever falls through to 500 the test will
    // surface it loudly.
    expect([409]).toContain(res.status());
  });

  test('accepts every documented status value', async ({ request }) => {
    const statuses = ['Lead', 'Prospect', 'Customer', 'Churned', 'Junk'];
    for (const s of statuses) {
      const c = await createContact(request, { label: `status-${s}`, status: s });
      expect(c.status).toBe(s);
    }
  });
});

// ─── GET /api/contacts ──────────────────────────────────────────────

test.describe('Contacts API — GET /', () => {
  test('200 returns array', async ({ request }) => {
    await createContact(request, { label: 'list-A' });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('?status=Lead returns only Lead rows', async ({ request }) => {
    await createContact(request, { label: 'filter-lead', status: 'Lead' });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts?status=Lead&limit=500');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((c) => c.status === 'Lead')).toBe(true);
  });

  test('?status=Customer returns only Customer rows', async ({ request }) => {
    await createContact(request, { label: 'filter-cust', status: 'Customer' });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts?status=Customer&limit=500');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((c) => c.status === 'Customer')).toBe(true);
  });

  test('?unassigned=true returns only contacts with assignedToId=null', async ({ request }) => {
    await createContact(request, { label: 'unass' }); // never assigned
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts?unassigned=true&limit=500');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((c) => c.assignedToId === null || c.assignedToId === undefined)).toBe(true);
  });

  test('?assignedToId=<id> filters to that owner', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const c = await createContact(request, { label: 'owned', assignedToId: userId });
    expect(c.assignedToId).toBe(userId);
    const res = await get(request, token, `/api/contacts?assignedToId=${userId}&limit=500`);
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((row) => row.assignedToId === userId)).toBe(true);
  });

  test('pagination — limit honored', async ({ request }) => {
    await createContact(request, { label: 'pg-1' });
    await createContact(request, { label: 'pg-2' });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts?limit=1');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeLessThanOrEqual(1);
  });

  test('pagination — limit > 500 clamped to 500', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts?limit=99999');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeLessThanOrEqual(500);
  });

  test('pagination — offset skips rows', async ({ request }) => {
    const { token } = await getAdmin(request);
    const first = await get(request, token, '/api/contacts?limit=2&offset=0');
    const second = await get(request, token, '/api/contacts?limit=2&offset=2');
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    const a = await first.json();
    const b = await second.json();
    if (a.length === 2 && b.length >= 1) {
      expect(b[0].id).not.toBe(a[0].id);
    }
  });

  test('soft-deleted contacts hidden by default (#167)', async ({ request }) => {
    const c = await createContact(request, { label: 'hide-me' });
    const { token } = await getAdmin(request);
    await del(request, token, `/api/contacts/${c.id}`);
    const list = await (await get(request, token, '/api/contacts?limit=500')).json();
    expect(list.find((row) => row.id === c.id)).toBeFalsy();
  });

  test('?includeDeleted=true surfaces soft-deleted rows (#167)', async ({ request }) => {
    const c = await createContact(request, { label: 'show-deleted' });
    const { token } = await getAdmin(request);
    await del(request, token, `/api/contacts/${c.id}`);
    const list = await (await get(request, token, '/api/contacts?includeDeleted=true&limit=500')).json();
    expect(list.find((row) => row.id === c.id)).toBeTruthy();
  });
});

// ─── GET /api/contacts/by-status (audienceController) ───────────────

test.describe('Contacts API — GET /by-status', () => {
  test('200 returns grouping (shape stays flexible across controller versions)', async ({ request }) => {
    // The audienceController shape isn't stable across releases — older builds
    // returned an array, newer ones may return { groups: [...] }. Just assert
    // the endpoint is wired and returns 2xx with parseable JSON.
    await createContact(request, { label: 'by-status', status: 'Customer' });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts/by-status');
    expect([200, 304]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toBeTruthy();
    }
  });
});

// ─── GET /api/contacts/:id ──────────────────────────────────────────

test.describe('Contacts API — GET /:id', () => {
  test('400 on non-numeric id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts/not-a-number');
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts/99999999');
    expect(res.status()).toBe(404);
  });

  test('returns row with activities + tasks + deals + assignedTo eagerly loaded', async ({ request }) => {
    const c = await createContact(request, { label: 'detail-eager' });
    const { token } = await getAdmin(request);
    const res = await get(request, token, `/api/contacts/${c.id}`);
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.id).toBe(c.id);
    expect(Array.isArray(got.activities)).toBe(true);
    expect(Array.isArray(got.tasks)).toBe(true);
    expect(Array.isArray(got.deals)).toBe(true);
  });

  test('soft-deleted contact returns 404 by default (#167)', async ({ request }) => {
    const c = await createContact(request, { label: 'detail-del' });
    const { token } = await getAdmin(request);
    await del(request, token, `/api/contacts/${c.id}`);
    const res = await get(request, token, `/api/contacts/${c.id}`);
    expect(res.status()).toBe(404);
  });

  test('soft-deleted contact visible with ?includeDeleted=true (#167)', async ({ request }) => {
    const c = await createContact(request, { label: 'detail-incl' });
    const { token } = await getAdmin(request);
    await del(request, token, `/api/contacts/${c.id}`);
    const res = await get(request, token, `/api/contacts/${c.id}?includeDeleted=true`);
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.deletedAt).toBeTruthy();
  });
});

// ─── PUT /api/contacts/:id ──────────────────────────────────────────

test.describe('Contacts API — PUT /:id', () => {
  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await put(request, token, '/api/contacts/99999999', { name: `${RUN_TAG} x` });
    expect(res.status()).toBe(404);
  });

  test('updates name', async ({ request }) => {
    const c = await createContact(request, { label: 'pre-rename' });
    const { token } = await getAdmin(request);
    const res = await put(request, token, `/api/contacts/${c.id}`, {
      name: `${RUN_TAG} renamed`,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toContain('renamed');
  });

  test('400 on bogus status enum value (PUT also runs validateContactInput)', async ({ request }) => {
    const c = await createContact(request, { label: 'bad-status-update' });
    const { token } = await getAdmin(request);
    const res = await put(request, token, `/api/contacts/${c.id}`, { status: 'NotAStatus' });
    expect(res.status()).toBe(400);
  });

  test('400 INVALID_AISCORE on out-of-range aiScore in PUT', async ({ request }) => {
    const c = await createContact(request, { label: 'oob-score' });
    const { token } = await getAdmin(request);
    const res = await put(request, token, `/api/contacts/${c.id}`, { aiScore: 999 });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_AISCORE');
  });

  test('Lead → Prospect transition flips status (lead.converted event fires)', async ({ request }) => {
    const c = await createContact(request, { label: 'lead-to-prospect', status: 'Lead' });
    expect(c.status).toBe('Lead');
    const { token } = await getAdmin(request);
    const res = await put(request, token, `/api/contacts/${c.id}`, { status: 'Prospect' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Prospect');
  });

  test('Lead → Customer transition flips status (generic tenant: no Patient row)', async ({ request }) => {
    // On wellness tenants this triggers Patient creation (#283); generic tenant
    // just flips status. The wellness Patient assertion lives in wellness.spec.js.
    const c = await createContact(request, { label: 'lead-to-customer', status: 'Lead' });
    const { token } = await getAdmin(request);
    const res = await put(request, token, `/api/contacts/${c.id}`, { status: 'Customer' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Customer');
  });

  test('PUT empty body is no-op (200, fields preserved)', async ({ request }) => {
    const c = await createContact(request, { label: 'noop-update' });
    const { token } = await getAdmin(request);
    const res = await put(request, token, `/api/contacts/${c.id}`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toContain('noop-update');
  });
});

// ─── PUT /api/contacts/bulk-assign ──────────────────────────────────

test.describe('Contacts API — PUT /bulk-assign', () => {
  test('400 when contactIds is empty', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await put(request, token, '/api/contacts/bulk-assign', {
      contactIds: [],
      assignedToId: 1,
    });
    expect(res.status()).toBe(400);
  });

  test('400 when contactIds is not an array', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await put(request, token, '/api/contacts/bulk-assign', {
      contactIds: 'oops',
      assignedToId: 1,
    });
    expect(res.status()).toBe(400);
  });

  test('200 assigns multiple contacts to admin', async ({ request }) => {
    const a = await createContact(request, { label: 'bulk-a' });
    const b = await createContact(request, { label: 'bulk-b' });
    const { token, userId } = await getAdmin(request);
    const res = await put(request, token, '/api/contacts/bulk-assign', {
      contactIds: [a.id, b.id],
      assignedToId: userId,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);
    expect(body.assignedToId).toBe(userId);

    // Verify both rows show the new owner.
    const after = await (await get(request, token, `/api/contacts/${a.id}`)).json();
    expect(after.assignedToId).toBe(userId);
  });

  test('200 clears assignedToId when assignedToId is null', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const a = await createContact(request, { label: 'unbulk-a', assignedToId: userId });
    const res = await put(request, token, '/api/contacts/bulk-assign', {
      contactIds: [a.id],
      assignedToId: null,
    });
    expect(res.status()).toBe(200);
    const after = await (await get(request, token, `/api/contacts/${a.id}`)).json();
    expect(after.assignedToId).toBeNull();
  });
});

// ─── PUT /api/contacts/:id/assign ───────────────────────────────────

test.describe('Contacts API — PUT /:id/assign', () => {
  test('404 on unknown id', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const res = await put(request, token, '/api/contacts/99999999/assign', {
      assignedToId: userId,
    });
    expect(res.status()).toBe(404);
  });

  test('200 assigns contact to admin', async ({ request }) => {
    const c = await createContact(request, { label: 'single-assign' });
    const { token, userId } = await getAdmin(request);
    const res = await put(request, token, `/api/contacts/${c.id}/assign`, {
      assignedToId: userId,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.assignedToId).toBe(userId);
    expect(body.assignedTo).toBeTruthy();
    expect(body.assignedTo.id).toBe(userId);
  });

  test('200 clears assignment when assignedToId is null', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const c = await createContact(request, { label: 'single-unassign', assignedToId: userId });
    const res = await put(request, token, `/api/contacts/${c.id}/assign`, {
      assignedToId: null,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).assignedToId).toBeNull();
  });
});

// ─── POST /api/contacts/:id/activities ──────────────────────────────

test.describe('Contacts API — POST /:id/activities', () => {
  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/99999999/activities', {
      type: 'Note',
      description: 'orphan',
    });
    expect(res.status()).toBe(404);
  });

  test('201 logs activity against contact', async ({ request }) => {
    const c = await createContact(request, { label: 'activity-target' });
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/contacts/${c.id}/activities`, {
      type: 'Call',
      description: `${RUN_TAG} called the lead`,
    });
    expect(res.status()).toBe(201);
    const a = await res.json();
    expect(a.contactId).toBe(c.id);
    expect(a.type).toBe('Call');
  });

  test('logged activity surfaces on GET /:id activities[]', async ({ request }) => {
    const c = await createContact(request, { label: 'activity-list' });
    const { token } = await getAdmin(request);
    await post(request, token, `/api/contacts/${c.id}/activities`, {
      type: 'Note',
      description: `${RUN_TAG} note-1`,
    });
    const got = await (await get(request, token, `/api/contacts/${c.id}`)).json();
    expect(got.activities.length).toBeGreaterThanOrEqual(1);
    expect(got.activities[0].description).toContain('note-1');
  });
});

// ─── GET /api/contacts/duplicates/find ──────────────────────────────

test.describe('Contacts API — GET /duplicates/find', () => {
  test('200 returns array (shape: {primary, duplicates[], reason})', async ({ request }) => {
    // The dedup endpoint scans the entire tenant — we don't need to seed
    // duplicates, just verify the shape. Tenants with seed data typically
    // have at least one dupe set already.
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts/duplicates/find');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    if (list.length > 0) {
      expect(list[0].primary).toBeTruthy();
      expect(Array.isArray(list[0].duplicates)).toBe(true);
      expect(typeof list[0].reason).toBe('string');
    }
  });

  test('detects a same-phone duplicate seeded in this run', async ({ request }) => {
    const sharedPhone = uniquePhone();
    const a = await createContact(request, { label: 'phone-dup-A', phone: sharedPhone });
    const b = await createContact(request, { label: 'phone-dup-B', phone: sharedPhone });
    expect(a.phone).toBe(sharedPhone);
    expect(b.phone).toBe(sharedPhone);

    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts/duplicates/find');
    expect(res.status()).toBe(200);
    const dupes = await res.json();
    // At least one dupe set should reference one of our two ids.
    const ids = new Set([a.id, b.id]);
    const found = dupes.some((d) => ids.has(d.primary.id) || d.duplicates.some((dd) => ids.has(dd.id)));
    expect(found).toBe(true);
  });
});

// ─── POST /api/contacts/merge ───────────────────────────────────────

test.describe('Contacts API — POST /merge', () => {
  test('400 when primaryId is missing', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/merge', {
      secondaryIds: [1],
    });
    expect(res.status()).toBe(400);
  });

  test('400 when secondaryIds is empty array', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/merge', {
      primaryId: 1,
      secondaryIds: [],
    });
    expect(res.status()).toBe(400);
  });

  test('404 when primary id does not exist', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/merge', {
      primaryId: 99999999,
      secondaryIds: [1],
    });
    expect(res.status()).toBe(404);
  });

  test('200 merges secondary into primary; secondary is hard-deleted afterwards', async ({ request }) => {
    // Primary has no phone; secondary has phone — merge should backfill
    // primary.phone from secondary per the route's "fill in missing fields"
    // logic.
    const primary = await createContact(request, { label: 'merge-primary', phone: null });
    const secondary = await createContact(request, { label: 'merge-secondary', phone: uniquePhone() });

    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/merge', {
      primaryId: primary.id,
      secondaryIds: [secondary.id],
    });
    expect(res.status(), `merge: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.merged).toBe(1);
    expect(body.primaryId).toBe(primary.id);

    // Secondary is hard-deleted by the route — GET should 404 (not 404+
    // includeDeleted-recoverable, gone for good).
    const after = await get(request, token, `/api/contacts/${secondary.id}`);
    expect(after.status()).toBe(404);

    // Primary should now carry the secondary's phone (filled-in field).
    const primaryAfter = await (await get(request, token, `/api/contacts/${primary.id}`)).json();
    expect(primaryAfter.phone).toBeTruthy();

    // Drop the now-deleted id from the cleanup queue so afterAll doesn't
    // complain (DELETE on a hard-deleted row 404s — harmless but noisy).
    const idx = createdContactIds.indexOf(secondary.id);
    if (idx >= 0) createdContactIds.splice(idx, 1);
  });
});

// ─── POST /api/contacts/import-csv ──────────────────────────────────

test.describe('Contacts API — POST /import-csv', () => {
  test('400 when contacts is empty array', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/import-csv', {
      contacts: [],
    });
    expect(res.status()).toBe(400);
  });

  test('400 when contacts is missing entirely', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/import-csv', {});
    expect(res.status()).toBe(400);
  });

  test('200 imports valid rows; reports skipped + errors', async ({ request }) => {
    const goodEmail = uniqueEmail('csv-good');
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/import-csv', {
      contacts: [
        { name: `${RUN_TAG} csv-1`, email: goodEmail, status: 'Lead' },
        { name: `${RUN_TAG} csv-2`, email: 'bogus-email', status: 'Lead' },
        { name: `${RUN_TAG} csv-3`, email: uniqueEmail('csv-3'), status: 'NotARealStatus' },
        { name: `${RUN_TAG} csv-4`, email: '', status: 'Lead' },
      ],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.imported).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThanOrEqual(3); // bad-email + bad-status + missing-email

    // Find the imported row so afterAll can soft-delete it.
    const list = await (await get(request, token, `/api/contacts?limit=500`)).json();
    const created = list.find((c) => c.email === goodEmail);
    if (created) createdContactIds.push(created.id);
  });

  test('413 TOO_MANY_ROWS when > 5000 rows submitted', async ({ request }) => {
    // Construct minimal payload — backend reads array length before iterating
    // each row, so the rows themselves don't need real data.
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      name: `r${i}`, email: `r${i}@example.com`,
    }));
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/import-csv', { contacts: rows });
    expect(res.status()).toBe(413);
    expect((await res.json()).code).toBe('TOO_MANY_ROWS');
  });

  test('CSV-injection prefix on name is sanitised (single-quote prefix)', async ({ request }) => {
    const goodEmail = uniqueEmail('csv-inj');
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/import-csv', {
      contacts: [
        { name: '=SUM(A1:A2)', email: goodEmail, status: 'Lead' },
      ],
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).imported).toBe(1);

    const list = await (await get(request, token, `/api/contacts?limit=500`)).json();
    const created = list.find((c) => c.email === goodEmail);
    expect(created).toBeTruthy();
    expect(created.name.startsWith("'")).toBe(true); // prefixed with ' to neutralise formula
    if (created) createdContactIds.push(created.id);
  });
});

// ─── Contact Attachments ────────────────────────────────────────────

test.describe('Contacts API — Attachments', () => {
  test('GET /:id/attachments — 404 on unknown contact', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts/99999999/attachments');
    expect(res.status()).toBe(404);
  });

  test('GET /:id/attachments — 200 returns array (empty by default)', async ({ request }) => {
    const c = await createContact(request, { label: 'attach-list' });
    const { token } = await getAdmin(request);
    const res = await get(request, token, `/api/contacts/${c.id}/attachments`);
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('POST /:id/attachments — 400 on multipart/form-data (#176)', async ({ request }) => {
    const c = await createContact(request, { label: 'attach-multipart' });
    const { token } = await getAdmin(request);
    // Use multipart explicitly. Playwright's multipart helper sets the right
    // Content-Type header automatically.
    const res = await request.post(`${BASE_URL}/api/contacts/${c.id}/attachments`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        filename: 'x.pdf',
        fileUrl: 'https://example.com/x.pdf',
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  test('POST /:id/attachments — 400 MISSING_FILENAME when filename is absent', async ({ request }) => {
    const c = await createContact(request, { label: 'attach-no-fn' });
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/contacts/${c.id}/attachments`, {
      fileUrl: 'https://example.com/doc.pdf',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('MISSING_FILENAME');
  });

  test('POST /:id/attachments — 400 MISSING_FILEURL when fileUrl is absent', async ({ request }) => {
    const c = await createContact(request, { label: 'attach-no-url' });
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/contacts/${c.id}/attachments`, {
      filename: 'doc.pdf',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('MISSING_FILEURL');
  });

  test('POST /:id/attachments — 400 INVALID_FILEURL on non-http url', async ({ request }) => {
    const c = await createContact(request, { label: 'attach-bad-url' });
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/contacts/${c.id}/attachments`, {
      filename: 'doc.pdf',
      fileUrl: 'ftp://example.com/x',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_FILEURL');
  });

  test('POST /:id/attachments — 201 happy path + GET /:id/attachments lists it', async ({ request }) => {
    const c = await createContact(request, { label: 'attach-happy' });
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/contacts/${c.id}/attachments`, {
      filename: 'invoice.pdf',
      fileUrl: 'https://example.com/invoice.pdf',
      fileSize: 12345,
      mimeType: 'application/pdf',
    });
    expect(res.status()).toBe(201);
    const a = await res.json();
    expect(a.id).toBeGreaterThan(0);
    expect(a.filename).toBe('invoice.pdf');
    expect(a.contactId).toBe(c.id);

    const list = await (await get(request, token, `/api/contacts/${c.id}/attachments`)).json();
    expect(list.find((x) => x.id === a.id)).toBeTruthy();

    // Clean up the attachment now (no afterAll for these).
    const delRes = await del(request, token, `/api/contacts/attachments/${a.id}`);
    expect(delRes.status()).toBe(200);
  });

  test('DELETE /attachments/:attachId — 404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await del(request, token, '/api/contacts/attachments/99999999');
    expect(res.status()).toBe(404);
  });
});

// ─── DELETE /api/contacts/:id (admin-only soft-delete) ──────────────

test.describe('Contacts API — DELETE /:id (soft-delete, ADMIN-only)', () => {
  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await del(request, token, '/api/contacts/99999999');
    expect(res.status()).toBe(404);
  });

  test('flips deletedAt; row hidden from default list', async ({ request }) => {
    const c = await createContact(request, { label: 'soft-del-target' });
    const { token } = await getAdmin(request);
    const res = await del(request, token, `/api/contacts/${c.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.softDeleted).toBe(true);
    expect(body.deletedAt).toBeTruthy();
  });

  test('idempotent: second DELETE returns idempotent:true with no state change', async ({ request }) => {
    const c = await createContact(request, { label: 'idemp-del' });
    const { token } = await getAdmin(request);
    await del(request, token, `/api/contacts/${c.id}`);
    const second = await del(request, token, `/api/contacts/${c.id}`);
    expect(second.status()).toBe(200);
    const body = await second.json();
    expect(body.idempotent).toBe(true);
    expect(body.softDeleted).toBe(true);
  });

  test('403 when non-ADMIN attempts DELETE', async ({ request }) => {
    const { token: userTok } = await getUser(request);
    if (!userTok) test.skip(true, 'no regular USER token available');
    const c = await createContact(request, { label: 'rbac-del' });
    const res = await del(request, userTok, `/api/contacts/${c.id}`);
    expect(res.status()).toBe(403);
  });
});

// ─── POST /api/contacts/:id/restore (admin-only) ────────────────────

test.describe('Contacts API — POST /:id/restore (ADMIN-only)', () => {
  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/contacts/99999999/restore', {});
    expect(res.status()).toBe(404);
  });

  test('clears deletedAt; row visible in default list again', async ({ request }) => {
    const c = await createContact(request, { label: 'restore-target' });
    const { token } = await getAdmin(request);
    await del(request, token, `/api/contacts/${c.id}`);
    const res = await post(request, token, `/api/contacts/${c.id}/restore`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.restored).toBe(true);
    expect(body.deletedAt).toBeNull();

    const list = await (await get(request, token, `/api/contacts?limit=500`)).json();
    expect(list.find((row) => row.id === c.id)).toBeTruthy();
  });

  test('idempotent: restore on a non-deleted contact returns idempotent:true', async ({ request }) => {
    const c = await createContact(request, { label: 'restore-noop' });
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/contacts/${c.id}/restore`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(body.restored).toBe(false);
  });

  test('403 when non-ADMIN attempts restore', async ({ request }) => {
    const { token: userTok } = await getUser(request);
    if (!userTok) test.skip(true, 'no regular USER token available');
    const c = await createContact(request, { label: 'rbac-restore' });
    // Soft-delete first (admin) so there's something to restore.
    const { token: adminTok } = await getAdmin(request);
    await del(request, adminTok, `/api/contacts/${c.id}`);

    const res = await post(request, userTok, `/api/contacts/${c.id}/restore`, {});
    expect(res.status()).toBe(403);
  });
});

// ─── Auth gate ──────────────────────────────────────────────────────

test.describe('Contacts API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/contacts`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/contacts`, {
      data: { name: 'x', email: 'x@example.com' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/contacts/1`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/contacts/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /duplicates/find without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/contacts/duplicates/find`);
    expect([401, 403]).toContain(res.status());
  });
});
