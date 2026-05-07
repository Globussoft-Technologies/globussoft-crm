// @ts-check
/**
 * Field-Level Permissions — ENFORCEMENT spec (#464).
 *
 * The CRUD side of /api/field-permissions is covered by
 * field-permissions.spec.js — it asserts that admins can save rules. This
 * spec asserts the rules are actually ENFORCED at the API layer:
 *   - filterReadFields strips read-restricted fields from GET responses
 *   - filterWriteFields strips write-restricted fields from POST/PUT bodies
 *
 * Pre-#464 the fieldFilter middleware existed (backend/middleware/fieldFilter.js)
 * but was never imported / called from any route. Rules saved via the
 * FieldPermissions UI had zero effect on real API traffic — a USER could still
 * read `Deal.amount` and `Contact.email` even after the admin denied them.
 * The fix wires `filterReadFields` + `filterWriteFields` into the read+write
 * paths of routes/deals.js + routes/contacts.js. This spec regression-guards
 * that wiring.
 *
 * Endpoints covered:
 *   GET  /api/deals                     — list strips Deal.amount when canRead=false
 *   GET  /api/deals/:id                 — single strips Deal.amount when canRead=false
 *   POST /api/deals                     — body strips Deal.amount when canWrite=false
 *   PUT  /api/deals/:id                 — body strips Deal.amount when canWrite=false
 *   GET  /api/contacts                  — list strips Contact.email when canRead=false
 *   GET  /api/contacts/:id              — single strips Contact.email when canRead=false
 *   PUT  /api/contacts/:id              — body strips Contact.email when canWrite=false
 *
 * Pattern: dual-token auth (ADMIN seeds the rule + creates fixtures, USER
 * exercises the enforcement path). ADMIN itself is never enforced against
 * because the rules apply per-role and admins typically have full access.
 *
 * Test data is tagged `E2E_FP_<ts>` so global-teardown can scrub. Each test
 * cleans up the rule it created so other parallel specs see a clean DB.
 */
const { test, expect } = require('@playwright/test');

// Tests in this file all upsert + delete the SAME composite key on
// FieldPermission (USER/Deal/amount/tenant=1, USER/Contact/email/tenant=1).
// Running them in parallel triggers unique-constraint races on Prisma's
// upsert (the row is created by worker A then worker B's `where` lookup
// misses, both attempt INSERT, one 500s). Pin the file to serial.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FP_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
// admin@globussoft.com (ADMIN, generic tenant) — seeds rules + creates fixtures
// user@crm.com         (USER,  same tenant)    — exercises read/write enforcement

let adminToken = null;
let userToken = null;

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

async function getAdminToken(request) {
  if (!adminToken) adminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  return adminToken;
}

async function getUserToken(request) {
  if (!userToken) userToken = await loginAs(request, 'user@crm.com', 'password123');
  return userToken;
}

const adminAuth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const userAuth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function adminPost(request, path, body) {
  const t = await getAdminToken(request);
  return request.post(`${BASE_URL}${path}`, { headers: adminAuth(t), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function adminPut(request, path, body) {
  const t = await getAdminToken(request);
  return request.put(`${BASE_URL}${path}`, { headers: adminAuth(t), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function adminDelete(request, path) {
  const t = await getAdminToken(request);
  return request.delete(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${t}` }, timeout: REQUEST_TIMEOUT });
}
async function adminGet(request, path) {
  const t = await getAdminToken(request);
  return request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${t}` }, timeout: REQUEST_TIMEOUT });
}
async function userGet(request, path) {
  const t = await getUserToken(request);
  return request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${t}` }, timeout: REQUEST_TIMEOUT });
}
async function userPost(request, path, body) {
  const t = await getUserToken(request);
  return request.post(`${BASE_URL}${path}`, { headers: userAuth(t), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function userPut(request, path, body) {
  const t = await getUserToken(request);
  return request.put(`${BASE_URL}${path}`, { headers: userAuth(t), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// ── Fixture creators ──────────────────────────────────────────────────────

async function createRule(request, { role, entity, field, canRead, canWrite }) {
  const r = await adminPost(request, '/api/field-permissions', {
    role, entity, field, canRead, canWrite,
  });
  expect(r.status(), `create rule: ${await r.text()}`).toBe(201);
  return r.json();
}

async function deleteRule(request, ruleId) {
  if (!ruleId) return;
  await adminDelete(request, `/api/field-permissions/${ruleId}`).catch(() => {});
}

// #588: USER role's GET /api/deals scopes to ownerId = req.user.userId. The
// field-permissions tests assert that USER sees the test deal in their list
// (with stripped fields), which requires the deal to be USER-OWNED. Routes
// set ownerId = req.user.userId on POST regardless of body, so creating the
// deal as USER ties ownership correctly. ADMIN tests still pass because ADMIN
// is unscoped and sees all tenant deals including USER-owned ones.
async function createDeal(request, overrides = {}) {
  const r = await userPost(request, '/api/deals', {
    title: `${RUN_TAG} ${overrides.title || 'enf-deal'}`,
    amount: overrides.amount ?? 12345,
    stage: overrides.stage || 'lead',
  });
  expect(r.status(), `create deal: ${await r.text()}`).toBe(201);
  return r.json();
}

async function createContact(request, overrides = {}) {
  const r = await adminPost(request, '/api/contacts', {
    name: `${RUN_TAG} ${overrides.name || 'Anjali Field'}`,
    email: overrides.email || `${RUN_TAG.toLowerCase()}.anjali.${Date.now()}@example.test`,
  });
  expect(r.status(), `create contact: ${await r.text()}`).toBe(201);
  return r.json();
}

// ── Tests ─────────────────────────────────────────────────────────────────

test.describe('Field-Level Permissions — read enforcement on /api/deals', () => {
  test('USER list call strips Deal.amount when canRead=false rule exists', async ({ request }) => {
    const deal = await createDeal(request, { title: 'read-list-strip' });
    const rule = await createRule(request, {
      role: 'USER', entity: 'Deal', field: 'amount', canRead: false, canWrite: false,
    });
    try {
      const r = await userGet(request, '/api/deals?limit=500');
      expect(r.status()).toBe(200);
      const list = await r.json();
      const me = list.find((d) => d.id === deal.id);
      expect(me, 'created deal must appear in USER list').toBeTruthy();
      expect(me).not.toHaveProperty('amount');
      // Other fields untouched.
      expect(me).toHaveProperty('title');
      expect(me.title).toContain('read-list-strip');
    } finally {
      await deleteRule(request, rule.id);
      await adminDelete(request, `/api/deals/${deal.id}`).catch(() => {});
    }
  });

  test('USER GET /:id strips Deal.amount when canRead=false rule exists', async ({ request }) => {
    const deal = await createDeal(request, { title: 'read-by-id-strip' });
    const rule = await createRule(request, {
      role: 'USER', entity: 'Deal', field: 'amount', canRead: false, canWrite: false,
    });
    try {
      const r = await userGet(request, `/api/deals/${deal.id}`);
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body).not.toHaveProperty('amount');
      expect(body.title).toContain('read-by-id-strip');
    } finally {
      await deleteRule(request, rule.id);
      await adminDelete(request, `/api/deals/${deal.id}`).catch(() => {});
    }
  });

  test('ADMIN read is unaffected by USER-scoped rule', async ({ request }) => {
    const deal = await createDeal(request, { title: 'admin-unaffected' });
    const rule = await createRule(request, {
      role: 'USER', entity: 'Deal', field: 'amount', canRead: false, canWrite: false,
    });
    try {
      const r = await adminGet(request, `/api/deals/${deal.id}`);
      expect(r.status()).toBe(200);
      const body = await r.json();
      // ADMIN role has no rule denying amount → field still present.
      expect(body).toHaveProperty('amount');
    } finally {
      await deleteRule(request, rule.id);
      await adminDelete(request, `/api/deals/${deal.id}`).catch(() => {});
    }
  });

  test('No rule in DB → all fields preserved (default open access)', async ({ request }) => {
    const deal = await createDeal(request, { title: 'no-rule-default' });
    try {
      const r = await userGet(request, `/api/deals/${deal.id}`);
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body).toHaveProperty('amount');
      expect(body.amount).toBe(12345);
    } finally {
      await adminDelete(request, `/api/deals/${deal.id}`).catch(() => {});
    }
  });
});

test.describe('Field-Level Permissions — write enforcement on /api/deals', () => {
  test('USER POST /api/deals silently drops amount when canWrite=false', async ({ request }) => {
    const rule = await createRule(request, {
      role: 'USER', entity: 'Deal', field: 'amount', canRead: true, canWrite: false,
    });
    let createdId;
    try {
      const r = await userPost(request, '/api/deals', {
        title: `${RUN_TAG} write-strip`,
        amount: 99999, // should be silently dropped
        stage: 'lead',
      });
      expect(r.status()).toBe(201);
      const body = await r.json();
      createdId = body.id;
      // amount was stripped before Prisma → defaults to 0 from
      // `parseFloat(amount) || 0` in the route.
      expect(body.amount).toBe(0);
      expect(body.title).toContain('write-strip');
    } finally {
      await deleteRule(request, rule.id);
      if (createdId) await adminDelete(request, `/api/deals/${createdId}`).catch(() => {});
    }
  });

  test('USER PUT /api/deals/:id silently drops amount when canWrite=false', async ({ request }) => {
    const deal = await createDeal(request, { title: 'put-strip', amount: 5000 });
    const rule = await createRule(request, {
      role: 'USER', entity: 'Deal', field: 'amount', canRead: true, canWrite: false,
    });
    try {
      const r = await userPut(request, `/api/deals/${deal.id}`, {
        amount: 999999,
        title: `${RUN_TAG} put-strip-edited`,
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      // amount must NOT have been updated (stripped pre-Prisma).
      expect(body.amount).toBe(5000);
      // Other fields DID change.
      expect(body.title).toContain('put-strip-edited');
    } finally {
      await deleteRule(request, rule.id);
      await adminDelete(request, `/api/deals/${deal.id}`).catch(() => {});
    }
  });
});

test.describe('Field-Level Permissions — read enforcement on /api/contacts', () => {
  test('USER list call strips Contact.email when canRead=false rule exists', async ({ request }) => {
    const contact = await createContact(request, { name: 'list-strip' });
    const rule = await createRule(request, {
      role: 'USER', entity: 'Contact', field: 'email', canRead: false, canWrite: false,
    });
    try {
      const r = await userGet(request, '/api/contacts?limit=500');
      expect(r.status()).toBe(200);
      const list = await r.json();
      const me = list.find((c) => c.id === contact.id);
      expect(me, 'created contact must appear in USER list').toBeTruthy();
      expect(me).not.toHaveProperty('email');
      expect(me).toHaveProperty('name');
    } finally {
      await deleteRule(request, rule.id);
      await adminDelete(request, `/api/contacts/${contact.id}`).catch(() => {});
    }
  });

  test('USER GET /:id strips Contact.email when canRead=false rule exists', async ({ request }) => {
    const contact = await createContact(request, { name: 'by-id-strip' });
    const rule = await createRule(request, {
      role: 'USER', entity: 'Contact', field: 'email', canRead: false, canWrite: false,
    });
    try {
      const r = await userGet(request, `/api/contacts/${contact.id}`);
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body).not.toHaveProperty('email');
      expect(body).toHaveProperty('name');
    } finally {
      await deleteRule(request, rule.id);
      await adminDelete(request, `/api/contacts/${contact.id}`).catch(() => {});
    }
  });
});

test.describe('Field-Level Permissions — write enforcement on /api/contacts', () => {
  test('USER PUT /api/contacts/:id silently drops email when canWrite=false', async ({ request }) => {
    const contact = await createContact(request, { name: 'put-write-strip' });
    const originalEmail = contact.email;
    const rule = await createRule(request, {
      role: 'USER', entity: 'Contact', field: 'email', canRead: true, canWrite: false,
    });
    try {
      const r = await userPut(request, `/api/contacts/${contact.id}`, {
        email: `${RUN_TAG.toLowerCase()}.changed@example.test`,
        name: `${RUN_TAG} edited`,
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      // email must NOT have been updated.
      expect(body.email).toBe(originalEmail);
      // name DID change.
      expect(body.name).toContain('edited');
    } finally {
      await deleteRule(request, rule.id);
      await adminDelete(request, `/api/contacts/${contact.id}`).catch(() => {});
    }
  });
});

// Belt-and-braces afterAll cleanup in case any rule above leaked due to a
// failed assertion. Best-effort — we don't assert these succeed.
test.afterAll(async ({ request }) => {
  // Nothing tracked at file scope right now (each test cleans up its own rule
  // in the finally block). Hook left for future expansion.
  void request;
});
