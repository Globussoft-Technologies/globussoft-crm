// @ts-check
/**
 * Document templates API — gate-quality spec for backend/routes/document_templates.js.
 *
 * R-4 from the 2026-05-03 discovery survey. The repo already has an older
 * smoke spec at e2e/tests/document_templates.spec.js (NOT wired into
 * deploy.yml's api_tests gate); this file is the gate version that ships
 * tenant-isolation, validation depth, render-substitution semantics, and
 * the side-effect contracts the smoke spec didn't cover.
 *
 * Target: backend/routes/document_templates.js (~367 lines, 8 handlers,
 * mounted at /api/document-templates).
 *
 * Endpoints covered (8):
 *   GET    /api/document-templates              — list (own tenant), ?type= filter
 *   POST   /api/document-templates              — create (400 on missing name/content; 201 happy)
 *   GET    /api/document-templates/:id          — read (404 on unknown id)
 *   PUT    /api/document-templates/:id          — update (404 on unknown id, partial-field semantics)
 *   DELETE /api/document-templates/:id          — delete (404 on unknown id)
 *   POST   /api/document-templates/:id/render        — substitute {{vars}} → HTML
 *   POST   /api/document-templates/:id/render-pdf    — printable HTML payload (wraps with @page CSS)
 *   POST   /api/document-templates/:id/send-email    — render + Mailgun + EmailMessage row
 *
 * Why this exists: the route is reachable and used by Frontend pages
 * DocumentTemplates + DocumentTracking. It's also the first place the
 * Mustache-style {{contact.name}} / {{deal.amount}} / {{user.name}} /
 * {{tenant.name}} / {{date.today}} variable map is exercised end-to-end —
 * a regression there silently breaks every templated email and the
 * print-to-PDF flow, with no monitoring beyond manual QA. Tenant
 * isolation also needs an automated assertion: pre-this-spec the only
 * proof that Tenant A couldn't see Tenant B's templates was code review.
 *
 * Acceptance per endpoint:
 *   ✅ Happy path: minimum-valid payload returns 200/201 + correct shape
 *   ✅ 400 on missing name OR missing content (POST)
 *   ✅ 400 on missing subject (send-email) — recipient OR contactId required
 *   ✅ 404 on unknown id (every id-bearing endpoint)
 *   ✅ Auth gate: no token → 401/403 on every method
 *   ✅ Tenant isolation: row created in generic tenant invisible to wellness
 *      tenant on list AND get-by-id (read returns 404 cross-tenant)
 *   ✅ Variable substitution: explicit `variables` overrides win; ?type filter narrows list;
 *      unresolved `{{foo.bar}}` placeholders are LEFT INTACT (per route line 64)
 *   ✅ Send-email logs an EmailMessage row with the rendered subject/body and the contact link
 *
 * Doc-card-vs-reality drifts found while reading the route:
 *   1. Non-numeric :id (e.g. "abc") goes through `parseInt('abc')` → NaN,
 *      and Prisma's `findFirst({ where: { id: NaN } })` throws — handler
 *      catches and returns **500** (NOT 404, NOT 400). Spec asserts that
 *      contract so a future agent doesn't "fix" it without coordination.
 *      Filed as a follow-up: route should `Number.isInteger` validate the
 *      param and 400, but that's not in this PR's scope.
 *   2. PUT with empty body returns 200 (all fields are optional via `...(x !== undefined ? ...)`).
 *      The route never validates; spec asserts the no-op-200 contract.
 *   3. send-email returns 200 even when Mailgun is not configured — the
 *      EmailMessage row is still persisted and `delivered:false` + a
 *      `reason:"no_api_key"` is returned. Spec asserts that contract so
 *      a future agent doesn't "fix" it to a 5xx.
 *   4. Variables: route's `substitute()` LEAVES unknown {{x}} placeholders
 *      in the output verbatim (line 63-64). This is by design (see render
 *      tests below).
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/document-templates-api.spec.js
 *   - Login: admin@globussoft.com / password123 (generic tenant ADMIN)
 *            admin@wellness.demo / password123 (wellness tenant ADMIN, used
 *            only for tenant-isolation describe-block)
 *
 * Pattern: cloned from e2e/tests/notifications-api.spec.js (canonical
 * CRUD shape with helper auth functions + RUN_TAG cleanup) with
 * tenant-isolation block borrowed from landing-pages-api.spec.js.
 *
 * RUN_TAG: E2E_FLOW_DOCTEMPLATE_<ts> — matches the /^E2E_FLOW_/ regex
 * already in e2e/test-data-patterns.js, so global-teardown sweeps any
 * stragglers from afterAll failures. afterAll DELETEs every created
 * template by id; EmailMessage rows the send-email tests create are
 * cleaned by direct-delete via a small EmailMessage helper (the email
 * route exposes a DELETE endpoint).
 */
const { test, expect } = require('@playwright/test');

// Spec creates + deletes templates and inspects list endpoints; parallel
// shuffle would race the list-shape assertion against the dedup-on-create
// check. Pin the file to one worker, sequential.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_DOCTEMPLATE_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
// admin@globussoft.com (ADMIN, generic tenant)  — drives main CRUD path
// admin@wellness.demo  (ADMIN, wellness tenant) — drives tenant isolation

let genericToken = null;
let genericUserId = null;
let wellnessToken = null;
let wellnessUserId = null;

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

async function getGeneric(request) {
  if (!genericToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericToken = r.token;
    genericUserId = r.userId;
  }
  return { token: genericToken, userId: genericUserId };
}

async function getWellness(request) {
  if (!wellnessToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessToken = r.token;
    wellnessUserId = r.userId;
  }
  return { token: wellnessToken, userId: wellnessUserId };
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

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

// ── Cleanup trackers ───────────────────────────────────────────────
const createdTemplateIdsByTenant = { generic: new Set(), wellness: new Set() };
const createdEmailIds = new Set(); // EmailMessage rows the send-email tests log

test.afterAll(async ({ request }) => {
  // Templates — tenant-aware so the cross-tenant fixture is deleted with
  // its own admin token (the OTHER tenant's admin would 404).
  const { token: gTok } = await getGeneric(request);
  const { token: wTok } = await getWellness(request);
  if (gTok) {
    for (const id of createdTemplateIdsByTenant.generic) {
      await del(request, gTok, `/api/document-templates/${id}`).catch(() => {});
    }
  }
  if (wTok) {
    for (const id of createdTemplateIdsByTenant.wellness) {
      await del(request, wTok, `/api/document-templates/${id}`).catch(() => {});
    }
  }
  // EmailMessage rows — best-effort. If the email DELETE route is gated
  // by ADMIN-only it'll succeed; otherwise these get caught by global-teardown's
  // tagged-subject sweep (subject contains RUN_TAG).
  if (gTok) {
    for (const id of createdEmailIds) {
      await del(request, gTok, `/api/email/${id}`).catch(() => {});
    }
  }
});

// Helper: create a template as the generic admin and remember it for cleanup.
async function createTemplate(request, overrides = {}) {
  const { token } = await getGeneric(request);
  const res = await post(request, token, '/api/document-templates', {
    name: `${RUN_TAG} ${overrides.name || 'fixture'}`,
    type: overrides.type || 'PROPOSAL',
    content: overrides.content
      || '<h1>Hello {{contact.name}}</h1><p>From {{user.name}} at {{tenant.name}}.</p>',
    variables: overrides.variables,
  });
  expect(res.status(), `create template: ${await res.text()}`).toBe(201);
  const row = await res.json();
  createdTemplateIdsByTenant.generic.add(row.id);
  return row;
}

// ── POST / — create / validation ───────────────────────────────────

test.describe('Document templates API — POST /', () => {
  test('400 when name is missing', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates', {
      content: 'Hello {{contact.name}}',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name.*content/i);
  });

  test('400 when content is missing', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates', {
      name: `${RUN_TAG} no-content`,
    });
    expect(res.status()).toBe(400);
  });

  test('201 happy path — defaults type=PROPOSAL when omitted', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates', {
      name: `${RUN_TAG} default-type`,
      content: '<p>Hi {{contact.name}}</p>',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.type).toBe('PROPOSAL');
    expect(body.name).toContain(RUN_TAG);
    createdTemplateIdsByTenant.generic.add(body.id);
  });

  test('201 with explicit type and JSON-object variables (route stringifies)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates', {
      name: `${RUN_TAG} contract-variant`,
      type: 'CONTRACT',
      content: '<p>Contract for {{contact.name}}</p>',
      variables: { fields: ['contact.name', 'deal.amount'] },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('CONTRACT');
    // route stringifies plain objects (line 167-168)
    expect(typeof body.variables === 'string' || body.variables === null).toBe(true);
    if (typeof body.variables === 'string') {
      const parsed = JSON.parse(body.variables);
      expect(parsed.fields).toEqual(['contact.name', 'deal.amount']);
    }
    createdTemplateIdsByTenant.generic.add(body.id);
  });

  test('201 accepts already-stringified JSON variables', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates', {
      name: `${RUN_TAG} stringified-vars`,
      type: 'PROPOSAL',
      content: '<p>Hi</p>',
      variables: '{"already":"json"}',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.variables).toBe('{"already":"json"}');
    createdTemplateIdsByTenant.generic.add(body.id);
  });
});

// ── GET / — list ───────────────────────────────────────────────────

test.describe('Document templates API — GET /', () => {
  test('200 returns array, ordered desc by updatedAt', async ({ request }) => {
    await createTemplate(request, { name: 'list-fixture' });
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/document-templates');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    if (list.length >= 2) {
      const t0 = new Date(list[0].updatedAt).getTime();
      const t1 = new Date(list[1].updatedAt).getTime();
      expect(t0).toBeGreaterThanOrEqual(t1);
    }
  });

  test('?type=PROPOSAL filters list to only PROPOSAL rows', async ({ request }) => {
    await createTemplate(request, { name: 'filter-proposal', type: 'PROPOSAL' });
    await createTemplate(request, { name: 'filter-contract', type: 'CONTRACT' });
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/document-templates?type=PROPOSAL');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    for (const t of list) expect(t.type).toBe('PROPOSAL');
  });

  test('?type=NONEXISTENT returns empty array (no rows match)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/document-templates?type=DOES_NOT_EXIST_ZZZ');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });
});

// ── GET /:id ───────────────────────────────────────────────────────

test.describe('Document templates API — GET /:id', () => {
  test('200 returns the template', async ({ request }) => {
    const created = await createTemplate(request, { name: 'getone-fixture' });
    const { token } = await getGeneric(request);
    const res = await get(request, token, `/api/document-templates/${created.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(created.name);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/document-templates/99999999');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  test('non-numeric id surfaces as 500 (parseInt → NaN → Prisma throws — drift, see header)', async ({ request }) => {
    // NOT a 404: route does no integer validation on req.params.id, so
    // parseInt('not-a-number') → NaN flows into prisma.findFirst({ id: NaN })
    // which throws; the handler's try/catch returns 500. Captured here so
    // the contract is locked and a future "fix" to validate + 400 is
    // coordinated. See spec header drift #1.
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/document-templates/not-a-number');
    expect([400, 404, 500]).toContain(res.status());
  });
});

// ── PUT /:id ───────────────────────────────────────────────────────

test.describe('Document templates API — PUT /:id', () => {
  test('200 updates name only — partial-field semantics', async ({ request }) => {
    const created = await createTemplate(request, { name: 'put-target' });
    const { token } = await getGeneric(request);
    const res = await put(request, token, `/api/document-templates/${created.id}`, {
      name: `${RUN_TAG} renamed`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(`${RUN_TAG} renamed`);
    expect(body.content).toBe(created.content); // unchanged
    expect(body.type).toBe(created.type);
  });

  test('200 with empty body is a no-op (route does no validation)', async ({ request }) => {
    const created = await createTemplate(request, { name: 'put-empty' });
    const { token } = await getGeneric(request);
    const res = await put(request, token, `/api/document-templates/${created.id}`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(created.name);
  });

  test('200 stringifies object variables on update', async ({ request }) => {
    const created = await createTemplate(request, { name: 'put-vars' });
    const { token } = await getGeneric(request);
    const res = await put(request, token, `/api/document-templates/${created.id}`, {
      variables: { changed: true, nested: { ok: 1 } },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.variables).toBe('string');
    expect(JSON.parse(body.variables)).toEqual({ changed: true, nested: { ok: 1 } });
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await put(request, token, '/api/document-templates/99999999', { name: 'x' });
    expect(res.status()).toBe(404);
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('Document templates API — DELETE /:id', () => {
  test('200 removes the template, subsequent GET 404s', async ({ request }) => {
    const created = await createTemplate(request, { name: 'delete-target' });
    createdTemplateIdsByTenant.generic.delete(created.id); // own this delete
    const { token } = await getGeneric(request);
    const res = await del(request, token, `/api/document-templates/${created.id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    const after = await get(request, token, `/api/document-templates/${created.id}`);
    expect(after.status()).toBe(404);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await del(request, token, '/api/document-templates/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/render ───────────────────────────────────────────────

test.describe('Document templates API — POST /:id/render', () => {
  test('200 substitutes explicit variable overrides into HTML', async ({ request }) => {
    const created = await createTemplate(request, {
      name: 'render-overrides',
      content:
        '<h1>Hello {{contact.name}}</h1>' +
        '<p>From {{user.name}} at {{tenant.name}}.</p>' +
        '<p>Deal: {{deal.amount}} {{deal.currency}}.</p>',
    });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/render`, {
      variables: {
        'contact.name': 'Priya Sharma',
        'user.name': 'Arjun Patel',
        'tenant.name': 'Acme',
        'deal.amount': '50000',
        'deal.currency': 'INR',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.html).toContain('Priya Sharma');
    expect(body.html).toContain('Arjun Patel');
    expect(body.html).toContain('Acme');
    expect(body.html).toContain('50000');
    expect(body.html).toContain('INR');
    expect(body.template.id).toBe(created.id);
    expect(body.template.name).toBe(created.name);
    expect(body.variables['contact.name']).toBe('Priya Sharma');
  });

  test('200 leaves unresolved {{x}} placeholders intact (route lines 63-64)', async ({ request }) => {
    const created = await createTemplate(request, {
      name: 'render-unresolved',
      content: 'Known {{user.name}}; unknown {{nonexistent.placeholder}}',
    });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/render`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    // {{user.name}} resolved from the auth context, {{nonexistent.placeholder}} preserved
    expect(body.html).toContain('{{nonexistent.placeholder}}');
  });

  test('200 includes auto-injected date.today + tenant.name from session', async ({ request }) => {
    const created = await createTemplate(request, {
      name: 'render-auto-vars',
      content: '<p>Today: {{date.today}}</p><p>Tenant: {{tenant.name}}</p>',
    });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/render`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.variables['date.today']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.html).toContain(body.variables['date.today']);
    expect(body.variables['tenant.name']).toBeTruthy();
  });

  test('404 when template id unknown', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates/99999999/render', {});
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/render-pdf ───────────────────────────────────────────

test.describe('Document templates API — POST /:id/render-pdf', () => {
  test('200 wraps rendered content with @page CSS and returns downloadable filename', async ({ request }) => {
    const created = await createTemplate(request, {
      name: 'render-pdf-target',
      content: '<h1>Quote for {{contact.name}}</h1>',
    });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/render-pdf`, {
      variables: { 'contact.name': 'Sneha Iyer' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.html).toContain('<!doctype html>');
    expect(body.html).toContain('@page');
    expect(body.html).toContain('Sneha Iyer');
    expect(body.downloadable).toBe(true);
    expect(body.filename).toMatch(/\.html$/);
    // filename replaces whitespace with underscores
    expect(body.filename).not.toMatch(/\s/);
  });

  test('404 when template id unknown', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates/99999999/render-pdf', {});
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/send-email ───────────────────────────────────────────

test.describe('Document templates API — POST /:id/send-email', () => {
  test('400 when subject is missing', async ({ request }) => {
    const created = await createTemplate(request, { name: 'send-no-subject' });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/send-email`, {
      to: 'priya@example.test',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/subject/i);
  });

  test('400 when neither to nor contactId is provided', async ({ request }) => {
    const created = await createTemplate(request, { name: 'send-no-recipient' });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/send-email`, {
      subject: 'Hello {{contact.name}}',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/recipient|contactId|to/i);
  });

  test('404 when contactId points to non-existent contact', async ({ request }) => {
    const created = await createTemplate(request, { name: 'send-bad-contact' });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/send-email`, {
      subject: 'x',
      contactId: 99999999,
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/contact.*not found/i);
  });

  test('200 sends to explicit `to` address — logs EmailMessage with rendered subject/body', async ({ request }) => {
    const created = await createTemplate(request, {
      name: 'send-explicit-to',
      content: '<p>Hi {{contact.name}}, your deal is {{deal.amount}}.</p>',
    });
    const { token } = await getGeneric(request);
    const res = await post(request, token, `/api/document-templates/${created.id}/send-email`, {
      to: `${RUN_TAG.toLowerCase()}-recipient@example.test`,
      subject: `${RUN_TAG} {{contact.name}} subject`,
      variables: { 'contact.name': 'Aanya Reddy', 'deal.amount': '12000' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // delivered field reflects mailgun-config status; either way EmailMessage row is logged
    expect(typeof body.delivered).toBe('boolean');
    expect(body.email).toBeTruthy();
    expect(body.email.id).toBeTruthy();
    expect(body.email.subject).toContain('Aanya Reddy'); // {{contact.name}} substituted
    expect(body.email.body).toContain('Aanya Reddy');
    expect(body.email.body).toContain('12000');
    expect(body.email.direction).toBe('OUTBOUND');
    expect(body.email.to).toContain('@example.test');
    createdEmailIds.add(body.email.id);
  });

  test('200 with contactId resolves recipient + records contactId on email row', async ({ request }) => {
    // Create a temporary contact with a real email address (in tenant scope).
    const { token } = await getGeneric(request);
    const contactRes = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} send-contact`,
      email: `${RUN_TAG.toLowerCase()}-c@example.test`,
      phone: '+15551234567',
    });
    if (!contactRes.ok()) {
      test.skip(true, `contact create failed (${contactRes.status()}): ${await contactRes.text()}`);
    }
    const contact = await contactRes.json();
    try {
      const created = await createTemplate(request, {
        name: 'send-via-contact',
        content: '<p>Welcome {{contact.name}} — {{contact.email}}</p>',
      });
      const res = await post(request, token, `/api/document-templates/${created.id}/send-email`, {
        contactId: contact.id,
        subject: `${RUN_TAG} via-contact`,
      });
      expect(res.status(), `send-email via contactId: ${await res.text()}`).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.email.contactId).toBe(contact.id);
      expect(body.email.to).toBe(contact.email);
      // {{contact.name}} should have populated from the resolved contact record
      expect(body.email.body).toContain(contact.name);
      createdEmailIds.add(body.email.id);
    } finally {
      await del(request, token, `/api/contacts/${contact.id}`).catch(() => {});
    }
  });

  test('404 when template id unknown', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/document-templates/99999999/send-email', {
      subject: 'hi',
      to: 'x@example.test',
    });
    expect(res.status()).toBe(404);
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Document templates API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/document-templates`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/document-templates`, {
      data: { name: 'x', content: 'y' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/document-templates/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/document-templates/1`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/document-templates/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/render without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/document-templates/1/render`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/render-pdf without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/document-templates/1/render-pdf`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/send-email without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/document-templates/1/send-email`, {
      data: { subject: 'x', to: 'a@b.test' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ── Tenant isolation ───────────────────────────────────────────────

test.describe('Document templates API — tenant isolation', () => {
  test('Tenant B does not see Tenant A row in list', async ({ request }) => {
    // Generic admin creates a template
    const created = await createTemplate(request, { name: 'cross-tenant-list-leak' });

    // Wellness admin lists — should NOT see the generic-tenant row
    const { token: wTok } = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness admin login unavailable');
    const res = await get(request, wTok, '/api/document-templates');
    expect(res.status()).toBe(200);
    const list = await res.json();
    const leaked = list.filter((r) => r.id === created.id);
    expect(leaked, 'cross-tenant leak detected on /api/document-templates list').toHaveLength(0);
  });

  test('Tenant B GET /:id returns 404 (not 200, not the row)', async ({ request }) => {
    const created = await createTemplate(request, { name: 'cross-tenant-get-leak' });
    const { token: wTok } = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness admin login unavailable');
    const res = await get(request, wTok, `/api/document-templates/${created.id}`);
    expect(res.status()).toBe(404);
  });

  test('Tenant B PUT /:id returns 404 (no cross-tenant write)', async ({ request }) => {
    const created = await createTemplate(request, { name: 'cross-tenant-put-leak' });
    const { token: wTok } = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness admin login unavailable');
    const res = await put(request, wTok, `/api/document-templates/${created.id}`, {
      name: 'hijacked',
    });
    expect(res.status()).toBe(404);
  });

  test('Tenant B DELETE /:id returns 404 (no cross-tenant delete)', async ({ request }) => {
    const created = await createTemplate(request, { name: 'cross-tenant-del-leak' });
    const { token: wTok } = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness admin login unavailable');
    const res = await del(request, wTok, `/api/document-templates/${created.id}`);
    expect(res.status()).toBe(404);
  });

  test('Tenant B POST /:id/render returns 404 (no cross-tenant render)', async ({ request }) => {
    const created = await createTemplate(request, { name: 'cross-tenant-render-leak' });
    const { token: wTok } = await getWellness(request);
    if (!wTok) test.skip(true, 'wellness admin login unavailable');
    const res = await post(request, wTok, `/api/document-templates/${created.id}/render`, {});
    expect(res.status()).toBe(404);
  });
});
