// @ts-check
/**
 * Sequences input sanitization — closes #398.
 *
 * Target: routes/sequences.js (POST /api/sequences, PATCH /api/sequences/:id).
 *
 * The gap (#398): the Drip Sequences create + update routes accepted
 * arbitrary HTML / `<script>` markup in the `name` field, which then
 * persisted to Sequence.name and rendered into the sequence list view,
 * email subject lines, and dashboard cards. Stored XSS surface — any
 * tenant-admin-with-write-access could plant a payload that fired in
 * other admins' browsers.
 *
 * The fix (in routes/sequences.js): a route-local `sanitizeText` helper
 * built on `sanitize-html` with `allowedTags: []` + `allowedAttributes: {}`
 * is invoked on `name` in BOTH the POST and PATCH handlers, BEFORE the
 * Prisma write. The helper also strips any HTML out of step content
 * embedded inside ReactFlow `nodes[].data.label` / `data.content` via
 * `sanitizeNodes`. If the post-strip name is empty (or whitespace-only)
 * the request is rejected 400 INVALID_SEQUENCE.
 *
 * NOTE on contract-vs-spec drift: the issue card mentioned a `description`
 * field. The Sequence Prisma model has no `description` column (only
 * `name`, `nodes`, `edges`, `isActive`). The actual stored-XSS surface is
 * `name` + node labels — that's what this spec pins. If `description` is
 * added to the model later, this spec is the canary that needs the new
 * assertions wired in.
 *
 * Tests pinned (8 total):
 *   1. POST: `<script>` in name → 200, response.name has script-tag stripped
 *   2. POST: `<img onerror=...>` payload in name → sanitized, row persists
 *   3. POST: `<a href="javascript:...">` inside a node label is sanitized
 *   4. POST: name that's PURELY HTML (`<script>x</script>`) → 400/422
 *      INVALID_SEQUENCE (post-strip empty)
 *   5. PATCH: rename existing sequence with HTML in name → sanitized
 *   6. Tenant isolation: a sanitized sequence in tenant A is not visible
 *      to tenant B's GET
 *   7. Auth gate: POST with no Authorization → 401/403
 *   8. Idempotent re-POST with the same sanitized name → still creates
 *      (no spurious dup-name 409 — sanitization is not a uniqueness sink)
 *
 * Pattern: cloned from e2e/tests/audit-api.spec.js (cached-token helpers
 * + dual-tenant pattern + RUN_TAG-prefixed cleanup). Tag is
 * `E2E_FLOW_SEQ_SANITIZE_<ts>` so the global-teardown E2E_FLOW_ regex
 * sweeps stragglers if afterAll DELETE fails.
 *
 * Environment expectations:
 *   - BASE_URL defaults to https://crm.globusdemos.com (override per-env).
 *   - Seed users: admin@globussoft.com / password123 (generic admin),
 *     admin@wellness.demo / password123 (wellness admin), both ADMIN role.
 *   - DELETE /api/sequences/:id exists (verified in routes/sequences.js)
 *     so afterAll hard-deletes everything we created.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_SEQ_SANITIZE_${Date.now()}`;

// ── Cached tokens ────────────────────────────────────────────────────
let genericAdminToken = null;
let genericAdminTenantId = null;
let wellnessAdminToken = null;
let wellnessAdminTenantId = null;

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
        return { token: j.token, tenantId: j.tenant && j.tenant.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, tenantId: null };
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericAdminToken = r.token;
    genericAdminTenantId = r.tenantId;
  }
  return { token: genericAdminToken, tenantId: genericAdminTenantId };
}

async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessAdminToken = r.token;
    wellnessAdminTenantId = r.tenantId;
  }
  return { token: wellnessAdminToken, tenantId: wellnessAdminTenantId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function patch(request, token, path, body) {
  return request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ─────────────────────────────────────────────────
// DELETE /api/sequences/:id exists (routes/sequences.js:175) and
// cascades enrollments first, so this is a hard delete. If a delete
// fails for some reason, the RUN_TAG prefix ensures global-teardown
// (e2e/test-data-patterns.js:E2E_FLOW_) catches the stragglers.
const createdByTenant = { generic: [], wellness: [] };

test.afterAll(async ({ request }) => {
  const ga = await getGenericAdmin(request);
  if (ga.token) {
    for (const id of createdByTenant.generic) {
      await del(request, ga.token, `/api/sequences/${id}`).catch(() => {});
    }
  }
  const wa = await getWellnessAdmin(request);
  if (wa.token) {
    for (const id of createdByTenant.wellness) {
      await del(request, wa.token, `/api/sequences/${id}`).catch(() => {});
    }
  }
});

// Helper: create a sequence with a payload-name and capture the id.
async function createSequence(request, tenantKey, name, extra) {
  const { token } = tenantKey === 'wellness'
    ? await getWellnessAdmin(request)
    : await getGenericAdmin(request);
  expect(token, `${tenantKey} admin token`).toBeTruthy();
  const body = { name, nodes: [], edges: [], ...(extra || {}) };
  const res = await post(request, token, '/api/sequences', body);
  return { res, token };
}

// ── 1. POST: <script> tag stripped from name ─────────────────────────

test.describe('Sequences sanitization — POST name', () => {
  test('POST with <script> in name → 200, script tag stripped', async ({ request }) => {
    const malicious = `<script>alert(1)</script>${RUN_TAG} hello`;
    const { res } = await createSequence(request, 'generic', malicious);
    expect(res.status(), `create response: ${await res.text()}`).toBe(201);
    const body = await res.json();
    createdByTenant.generic.push(body.id);
    // Persisted name must NOT contain the <script> tag, but the trailing
    // visible text "RUN_TAG hello" must survive.
    expect(body.name).not.toMatch(/<script/i);
    expect(body.name).not.toMatch(/<\/script>/i);
    expect(body.name).toContain(RUN_TAG);
    expect(body.name).toContain('hello');
  });

  // 2. POST with `<img onerror>` payload — same sanitization contract.
  test('POST with <img src=x onerror=...> in name → tag stripped, row persists', async ({ request }) => {
    const malicious = `<img src=x onerror=alert(1)>${RUN_TAG} payload-2`;
    const { res } = await createSequence(request, 'generic', malicious);
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdByTenant.generic.push(body.id);
    // No raw HTML markup — the on-handler attribute must be gone too.
    expect(body.name).not.toMatch(/<img/i);
    expect(body.name).not.toMatch(/onerror/i);
    expect(body.name).toContain('payload-2');
  });

  // 3. POST with javascript: URL inside a node label → sanitized.
  // Clicking a sequence name in the list view renders into the canvas,
  // so node.data.label is also a stored-XSS sink.
  test('POST with javascript: href inside node.data.label → href stripped', async ({ request }) => {
    const nodes = [
      {
        id: 'n1',
        type: 'email',
        position: { x: 0, y: 0 },
        data: { label: '<a href="javascript:alert(1)">click</a>' },
      },
    ];
    const { res } = await createSequence(request, 'generic', `${RUN_TAG} node-jsurl`, { nodes });
    expect(res.status(), `create response: ${await res.text()}`).toBe(201);
    const body = await res.json();
    createdByTenant.generic.push(body.id);
    // The route stores nodes as a JSON string. Parse and inspect.
    const storedNodes = typeof body.nodes === 'string' ? JSON.parse(body.nodes) : body.nodes;
    expect(Array.isArray(storedNodes)).toBe(true);
    const label = storedNodes[0].data.label;
    // Anchor-tag and javascript: scheme MUST be gone. The visible text
    // "click" should remain (sanitize-html keeps text content).
    expect(label).not.toMatch(/<a\b/i);
    expect(label).not.toMatch(/javascript:/i);
    expect(label).toContain('click');
  });

  // 4. POST with a name that's PURELY HTML — after strip the value is
  // empty, so the route returns 400 INVALID_SEQUENCE.
  test('POST with name that\'s only HTML → 400/422 INVALID_SEQUENCE', async ({ request }) => {
    const onlyHtml = '<script>x</script>';
    const { res } = await createSequence(request, 'generic', onlyHtml);
    // Route returns 400 today; accept 422 in case the contract gets
    // tightened to the conventional validation status.
    expect([400, 422]).toContain(res.status());
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('INVALID_SEQUENCE');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

// ── 5. PATCH: rename with HTML → sanitized ───────────────────────────

test.describe('Sequences sanitization — PATCH name', () => {
  test('PATCH /api/sequences/:id with HTML in name → sanitized', async ({ request }) => {
    // First create a clean row.
    const { res: createRes, token } = await createSequence(request, 'generic', `${RUN_TAG} pre-rename`);
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    createdByTenant.generic.push(created.id);

    // Now PATCH with a malicious name.
    const malicious = `<script>alert('xss')</script>${RUN_TAG} renamed`;
    const r = await patch(request, token, `/api/sequences/${created.id}`, { name: malicious });
    expect(r.status(), `patch response: ${await r.text()}`).toBe(200);
    const updated = await r.json();
    expect(updated.name).not.toMatch(/<script/i);
    expect(updated.name).toContain('renamed');
  });
});

// ── 6. Tenant isolation: sanitized rows stay tenant-scoped ───────────

test.describe('Sequences sanitization — tenant isolation', () => {
  test('sanitized sequence in generic tenant is not visible in wellness GET', async ({ request }) => {
    const malicious = `<script>x</script>${RUN_TAG} cross-tenant`;
    const { res } = await createSequence(request, 'generic', malicious);
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdByTenant.generic.push(body.id);

    // Wellness admin lists sequences — the generic-tenant row must NOT appear.
    const { token: wToken } = await getWellnessAdmin(request);
    expect(wToken, 'wellness admin token').toBeTruthy();
    const wRes = await get(request, wToken, '/api/sequences');
    expect(wRes.status()).toBe(200);
    const wBody = await wRes.json();
    expect(Array.isArray(wBody)).toBe(true);
    const leak = wBody.find((s) => s.id === body.id);
    expect(leak, `cross-tenant leak: wellness saw generic seq id=${body.id}`).toBeFalsy();
  });
});

// ── 7. Auth gate ─────────────────────────────────────────────────────

test.describe('Sequences sanitization — auth gate', () => {
  test('POST /api/sequences without Authorization → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/sequences`, {
      data: { name: `${RUN_TAG} no-auth`, nodes: [], edges: [] },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ── 8. Idempotent re-POST ────────────────────────────────────────────
// Defence against a regression where sanitization gets misimplemented as
// a uniqueness check: posting the same sanitized name twice should still
// create two distinct rows (sequences don't have a unique constraint on
// name).

test.describe('Sequences sanitization — idempotent re-POST', () => {
  test('two POSTs with the same post-sanitize name both succeed', async ({ request }) => {
    const sameName = `<b>${RUN_TAG}</b> dup-ok`;
    const a = await createSequence(request, 'generic', sameName);
    expect(a.res.status(), `first create: ${await a.res.text()}`).toBe(201);
    const aBody = await a.res.json();
    createdByTenant.generic.push(aBody.id);

    const b = await createSequence(request, 'generic', sameName);
    expect(b.res.status(), `second create: ${await b.res.text()}`).toBe(201);
    const bBody = await b.res.json();
    createdByTenant.generic.push(bBody.id);

    // Both rows persisted, both sanitized identically, distinct ids.
    expect(aBody.id).not.toBe(bBody.id);
    expect(aBody.name).toBe(bBody.name);
    expect(aBody.name).not.toMatch(/<b>/i);
    expect(aBody.name).toContain(RUN_TAG);
  });
});
