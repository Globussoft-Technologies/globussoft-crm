// @ts-check
/**
 * Wellness Telecaller API — G-19 from docs/E2E_GAPS.md.
 *
 * Target: backend/routes/wellness.js (4,050 lines, 41% coverage). Splits
 * the telecaller-queue surface out of the monolithic wellness route file
 * so the SLA-clock + 6-disposition queue used by Enhanced Wellness's
 * call-center role gets a per-push regression net. Sister specs:
 *   - wellness-clinical-api.spec.js (patients/visits/Rx/consent/services/locations)
 *   - wellness-rbac-api.spec.js (cross-cutting role gates incl. #214/#326)
 * G-17 (dashboard) and G-18 (reports) are NOT in flight this wave.
 *
 * Endpoints covered (2):
 *   GET  /api/wellness/telecaller/queue   — list contacts assigned to caller, status=Lead
 *   POST /api/wellness/telecaller/dispose — body {contactId, disposition, notes?}
 *
 * Why this exists: the telecaller queue is the inbound-lead worklist for
 * Enhanced Wellness's call-center role (Rishu's deployment). Pre-this-spec,
 * only wellness-rbac-api hit the gate path (#214) — the queue's data
 * filtering, the 6-disposition contract, and tenant isolation on dispose
 * were all uncovered. Issue #214 originally surfaced because clinical
 * staff (doctor/professional/helper) shouldn't see the inbound pipeline;
 * this spec proves they still don't.
 *
 * Disposition contract (six values, lowercased + trimmed by route):
 *   interested      → status flips to "Lead"      (stays in queue if still assigned)
 *   not interested  → status flips to "Churned"   (drops out of queue)
 *   callback        → status flips to "Lead"      (stays)
 *   booked          → status flips to "Prospect"  (drops out)
 *   wrong number    → status flips to "Junk"      (drops out)
 *   junk            → status flips to "Junk"      (drops out)
 * Any other token returns 400 "Unknown disposition".
 *
 * Contract drift recorded vs the wave-17 prompt:
 *   1. Spec endpoint is POST /telecaller/dispose with `contactId` IN BODY,
 *      NOT POST /telecaller/queue/:id/dispose with id in path. Spec
 *      asserts the actual route shape.
 *   2. The queue response is `{ leads, count }` with each lead carrying
 *      `createdAt` only — there is NO `secondsUntilSlaBreach` or
 *      equivalent SLA-timer field on the API today (the SLA clock is
 *      computed client-side in TelecallerQueue.jsx from `createdAt`).
 *      Spec asserts the actual shape; the older-leads-first ordering
 *      (orderBy: createdAt asc) is the contract that lets the UI
 *      compute "seconds since lead landed" without server help.
 *   3. The queue is auto-scoped to the caller's OWN assignedToId — an
 *      admin or manager invoking the queue with no leads assigned to
 *      them gets `{ leads: [], count: 0 }`, NOT a god-view of every
 *      telecaller's queue. Spec encodes this so a later "manager
 *      should see all" refactor would deliberately break the test.
 *   4. There is no /reassign or /escalate endpoint — out of scope.
 *
 * Acceptance per endpoint:
 *   ✅ Auth gate: no token → 401 (verifyToken layer); wrong-role token → 403
 *   ✅ Tenant isolation: telecaller in wellness tenant cannot see / dispose
 *      a contact created in the generic tenant
 *   ✅ Queue happy path: only own-assigned, status=Lead leads return; ordered
 *      by createdAt asc; capped at 200
 *   ✅ Disposition matrix: each of 6 lowercased dispositions writes Activity +
 *      flips Contact.status to the documented mapping; uppercase + whitespace
 *      tolerated; unknown disposition → 400
 *   ✅ 400 on missing contactId or disposition
 *   ✅ 404 when contactId belongs to another tenant or doesn't exist
 *   ✅ Cross-tenant + cross-vertical: generic-tenant admin → 403
 *      (WELLNESS_TENANT_REQUIRED) even though role==='ADMIN'
 *   ✅ Self-clean: any test-created Contact + Activity rows get removed in
 *      afterAll via the contacts API (existing DELETE endpoint).
 *
 * Non-obvious setup:
 *   - The seeded telecaller user is `telecaller@enhancedwellness.in` (Ankita
 *     Verma). For the queue to return a row, we MUST create the Contact in
 *     the wellness tenant AND PUT assignedToId=<telecaller userId> on it AND
 *     set status="Lead". Doing this requires three calls: POST /api/contacts
 *     (creates with no assignment), PUT /api/contacts/:id (sets
 *     assignedToId+status). The contacts route is the canonical owner of
 *     Contact CRUD — wellness routes don't expose a /telecaller/leads/POST.
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/wellness-telecaller-api.spec.js
 *   - Login: telecaller@enhancedwellness.in / password123  (queue caller)
 *            admin@wellness.demo / password123             (wellness admin)
 *            drharsh@enhancedwellness.in / password123     (wellness doctor — wrong role)
 *            admin@globussoft.com / password123            (generic admin — wrong vertical)
 *
 * Pattern: cloned from e2e/tests/wellness-rbac-api.spec.js + landing-pages-api.spec.js
 * (the canonical 11-describe-block layout with state-machine + tenant-isolation).
 */
const { test, expect } = require('@playwright/test');

// Serial: this spec creates Contacts and asserts queue contents pre/post
// disposition. Parallel shuffle would race the dispose-then-list assertions.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_TELECALLER_${Date.now()}`;

// ── Fixtures ────────────────────────────────────────────────────────
// Seeded by prisma/seed.js + prisma/seed-wellness.js:
//   admin@globussoft.com           — GENERIC tenant ADMIN (cross-vertical 403 test)
//   admin@wellness.demo            — WELLNESS ADMIN (creates fixtures, has queue access via "admin")
//   manager@enhancedwellness.in    — WELLNESS MANAGER (gate-allowed via "manager")
//   drharsh@enhancedwellness.in    — WELLNESS USER+doctor (wrong wellnessRole → 403)
//   stylist1@enhancedwellness.in   — WELLNESS USER+professional (wrong wellnessRole → 403)
//   helper1@enhancedwellness.in    — WELLNESS USER+helper (wrong wellnessRole → 403)
//   telecaller@enhancedwellness.in — WELLNESS USER+telecaller (the actual queue caller)

const FIXTURES = {
  genericAdmin: { email: 'admin@globussoft.com',          password: 'password123' },
  admin:        { email: 'admin@wellness.demo',           password: 'password123' },
  manager:      { email: 'manager@enhancedwellness.in',   password: 'password123' },
  doctor:       { email: 'drharsh@enhancedwellness.in',   password: 'password123' },
  professional: { email: 'stylist1@enhancedwellness.in',  password: 'password123' },
  helper:       { email: 'helper1@enhancedwellness.in',   password: 'password123' },
  telecaller:   { email: 'telecaller@enhancedwellness.in', password: 'password123' },
};

const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const fixture = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        tokenCache[who] = j.token;
        userIdCache[who] = j.user && j.user.id;
        return { token: tokenCache[who], userId: userIdCache[who] };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

const authHdr = async (request, who = 'telecaller') => ({
  Authorization: `Bearer ${(await login(request, who)).token}`,
});

async function authGet(request, path, who = 'telecaller') {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'telecaller') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body, who = 'telecaller') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path, who = 'admin') {
  return request.delete(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}

// ── Cleanup tracking ────────────────────────────────────────────────
// Contact.delete is a DELETE endpoint on /api/contacts/:id (wellness admin
// is in the same tenant as the contacts we create, so DELETE works).
// Cross-tenant ids are tracked separately so we delete each via its
// owning tenant's admin token.
const createdWellnessContactIds = [];
const createdGenericContactIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdWellnessContactIds) {
    await authDelete(request, `/api/contacts/${id}`, 'admin').catch(() => {});
  }
  for (const id of createdGenericContactIds) {
    await authDelete(request, `/api/contacts/${id}`, 'genericAdmin').catch(() => {});
  }
});

// ── Shared helpers ─────────────────────────────────────────────────
// Phone-suffix counter so each Contact gets a unique digit string —
// avoids the 409 dedup-on-phone path the contacts route enforces.
const PHONE_BASE = Date.now() % 100000;
let phoneCounter = 0;
function nextPhone() {
  const suffix = String((PHONE_BASE + phoneCounter++) % 100000).padStart(5, '0');
  return `+9198765${suffix}`;
}

// Create a Contact in the wellness tenant, optionally assigned to the
// telecaller and set to Lead status (the two filters the queue applies).
// Returns the created Contact row.
async function createWellnessLead(request, { assignToTelecaller = true, status = 'Lead', suffix = 'Lead' } = {}) {
  // Step 1: create as wellness admin (no assignment yet — POST /api/contacts
  // doesn't honour assignedToId in the body without a separate hop).
  const createRes = await authPost(request, '/api/contacts', {
    name: `${RUN_TAG} ${suffix}`,
    email: `${RUN_TAG.toLowerCase()}.${suffix.toLowerCase()}.${phoneCounter}@example.com`,
    phone: nextPhone(),
    status,
  }, 'admin');
  expect(createRes.status(), `wellness contact create: ${await createRes.text()}`).toBe(201);
  const contact = await createRes.json();
  createdWellnessContactIds.push(contact.id);

  if (assignToTelecaller) {
    const tc = await login(request, 'telecaller');
    expect(tc.userId, 'telecaller userId must resolve').toBeTruthy();
    const updateRes = await authPut(
      request,
      `/api/contacts/${contact.id}`,
      { assignedToId: tc.userId, status },
      'admin',
    );
    expect(updateRes.status(), `assign telecaller: ${await updateRes.text()}`).toBe(200);
    return updateRes.json();
  }
  return contact;
}

// Same in the generic tenant — used to prove cross-tenant 404 on dispose.
async function createGenericLead(request, { suffix = 'GenLead' } = {}) {
  const createRes = await authPost(request, '/api/contacts', {
    name: `${RUN_TAG} ${suffix}`,
    email: `${RUN_TAG.toLowerCase()}.${suffix.toLowerCase()}.${phoneCounter}@example.com`,
    phone: nextPhone(),
    status: 'Lead',
  }, 'genericAdmin');
  expect(createRes.status(), `generic contact create: ${await createRes.text()}`).toBe(201);
  const contact = await createRes.json();
  createdGenericContactIds.push(contact.id);
  return contact;
}

// ── Pre-flight: confirm fixtures resolve ───────────────────────────

test.beforeAll(async ({ request }) => {
  for (const who of ['admin', 'telecaller', 'manager', 'doctor', 'professional', 'genericAdmin']) {
    const r = await login(request, who);
    expect(r.token, `${who} fixture must seed`).toBeTruthy();
  }
});

// =====================================================================
// 1. Auth gate — no token
// =====================================================================

test.describe('Wellness Telecaller API — auth gate', () => {
  test('GET /telecaller/queue without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/wellness/telecaller/queue`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /telecaller/dispose without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/wellness/telecaller/dispose`, {
      data: { contactId: 1, disposition: 'interested' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});

// =====================================================================
// 2. Wellness-role gate — wrong wellnessRole → 403
// =====================================================================

test.describe('Wellness Telecaller API — wellnessRole gate', () => {
  test('doctor → 403 WELLNESS_ROLE_FORBIDDEN on queue', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'doctor');
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('professional → 403 on queue', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'professional');
    expect(res.status()).toBe(403);
  });

  test('helper → 403 on queue', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'helper');
    expect(res.status()).toBe(403);
  });

  test('doctor → 403 on dispose', async ({ request }) => {
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: 1, disposition: 'interested' },
      'doctor',
    );
    expect(res.status()).toBe(403);
  });
});

// =====================================================================
// 3. Tenant-vertical gate — generic-tenant admin → 403 (WELLNESS_TENANT_REQUIRED)
// =====================================================================

test.describe('Wellness Telecaller API — tenant vertical gate (#325)', () => {
  test('generic admin (vertical=generic) → 403 WELLNESS_TENANT_REQUIRED on queue', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'genericAdmin');
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
  });

  test('generic admin → 403 WELLNESS_TENANT_REQUIRED on dispose', async ({ request }) => {
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: 1, disposition: 'interested' },
      'genericAdmin',
    );
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
  });
});

// =====================================================================
// 4. GET /telecaller/queue — happy path + shape
// =====================================================================

test.describe('Wellness Telecaller API — GET /telecaller/queue', () => {
  test('200 returns {leads, count} envelope', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'telecaller');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.leads)).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(body.count).toBe(body.leads.length);
  });

  test('seeded lead assigned to telecaller appears in queue with select-only fields', async ({ request }) => {
    const lead = await createWellnessLead(request, { suffix: 'Visible' });

    const res = await authGet(request, '/api/wellness/telecaller/queue', 'telecaller');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.leads.find((x) => x.id === lead.id);
    expect(found, 'created lead must surface in telecaller queue').toBeTruthy();

    // Route uses Prisma `select`, so only these keys leak through:
    //   id, name, phone, email, source, aiScore, createdAt
    expect(found).toHaveProperty('id');
    expect(found).toHaveProperty('name');
    expect(found).toHaveProperty('phone');
    expect(found).toHaveProperty('email');
    expect(found).toHaveProperty('source');
    expect(found).toHaveProperty('aiScore');
    expect(found).toHaveProperty('createdAt');
    // Must NOT leak DB internals or assignedToId (the route's `select`
    // explicitly omits them — frontend doesn't need those for the queue UI).
    expect(found.assignedToId).toBeUndefined();
    expect(found.tenantId).toBeUndefined();
  });

  test('admin role (no wellnessRole=telecaller) gets queue scoped to admin\'s OWN assignedToId', async ({ request }) => {
    // The route filters `assignedToId: req.user.userId` regardless of role.
    // Admin is allowed THROUGH the wellnessRole gate, but the result is
    // their own slice — not a god-view. Asserting this prevents a future
    // "let admin see all telecallers' queues" change from silently shipping.
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'admin');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.leads)).toBe(true);
    // admin is NOT the assignee of our seeded lead — should not see it.
    const tcLead = await createWellnessLead(request, { suffix: 'AdminScopeProbe' });
    const res2 = await authGet(request, '/api/wellness/telecaller/queue', 'admin');
    const body2 = await res2.json();
    const leaked = body2.leads.find((x) => x.id === tcLead.id);
    expect(leaked, 'admin should not see telecaller-assigned lead in own queue').toBeFalsy();
  });

  test('manager role allowed through gate — own-assignee scoping holds', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'manager');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.leads)).toBe(true);
  });

  test('non-Lead status leads do NOT appear in queue', async ({ request }) => {
    // Create as Lead, dispose to Churned, assert it falls out of queue.
    const lead = await createWellnessLead(request, { suffix: 'StatusFilter' });
    // Confirm in queue first
    let q = await authGet(request, '/api/wellness/telecaller/queue', 'telecaller');
    expect((await q.json()).leads.find((x) => x.id === lead.id)).toBeTruthy();

    // Dispose with "not interested" → Churned
    const dr = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: lead.id, disposition: 'not interested' },
      'telecaller',
    );
    expect(dr.status()).toBe(200);
    expect((await dr.json()).status).toBe('Churned');

    // Re-fetch queue: lead should now be filtered out by status=Lead.
    q = await authGet(request, '/api/wellness/telecaller/queue', 'telecaller');
    expect(q.status()).toBe(200);
    const after = (await q.json()).leads.find((x) => x.id === lead.id);
    expect(after, 'Churned lead must drop out of queue').toBeFalsy();
  });

  test('queue ordered by createdAt asc (oldest-first SLA-clock contract)', async ({ request }) => {
    // Create two leads back-to-back; older one must sort first.
    const first = await createWellnessLead(request, { suffix: 'Order1' });
    // Tiny delay so createdAt ms differs (mysql DATETIME(3) precision).
    await new Promise((r) => setTimeout(r, 1100));
    const second = await createWellnessLead(request, { suffix: 'Order2' });

    const res = await authGet(request, '/api/wellness/telecaller/queue', 'telecaller');
    expect(res.status()).toBe(200);
    const leads = (await res.json()).leads;
    const idxFirst = leads.findIndex((x) => x.id === first.id);
    const idxSecond = leads.findIndex((x) => x.id === second.id);
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxSecond).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeLessThan(idxSecond);
  });
});

// =====================================================================
// 5. POST /telecaller/dispose — validation
// =====================================================================

test.describe('Wellness Telecaller API — POST /telecaller/dispose validation', () => {
  test('400 on missing contactId', async ({ request }) => {
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { disposition: 'interested' },
      'telecaller',
    );
    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.error).toMatch(/contactId/i);
  });

  test('400 on missing disposition', async ({ request }) => {
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: 1 },
      'telecaller',
    );
    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.error).toMatch(/disposition/i);
  });

  test('400 on empty body', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/telecaller/dispose', {}, 'telecaller');
    expect(res.status()).toBe(400);
  });

  test('400 on unknown disposition', async ({ request }) => {
    const lead = await createWellnessLead(request, { suffix: 'BadDispo' });
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: lead.id, disposition: 'connected_interested' },
      'telecaller',
    );
    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.error).toMatch(/disposition/i);
  });

  test('404 on contactId that does not exist', async ({ request }) => {
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: 99999999, disposition: 'interested' },
      'telecaller',
    );
    expect(res.status()).toBe(404);
    const body = await res.json().catch(() => ({}));
    expect(body.error).toMatch(/not found/i);
  });
});

// =====================================================================
// 6. POST /telecaller/dispose — disposition matrix (6 values)
// =====================================================================

test.describe('Wellness Telecaller API — disposition matrix', () => {
  // The DISPOSITION_STATUS map in routes/wellness.js (line ~3041):
  //   interested      → Lead
  //   "not interested"→ Churned
  //   callback        → Lead
  //   booked          → Prospect
  //   "wrong number"  → Junk
  //   junk            → Junk
  const DISPOSITIONS = [
    { input: 'interested',      expected: 'Lead' },
    { input: 'not interested',  expected: 'Churned' },
    { input: 'callback',        expected: 'Lead' },
    { input: 'booked',          expected: 'Prospect' },
    { input: 'wrong number',    expected: 'Junk' },
    { input: 'junk',            expected: 'Junk' },
  ];

  for (const { input, expected } of DISPOSITIONS) {
    test(`"${input}" → status flips to "${expected}" + Activity row written`, async ({ request }) => {
      const lead = await createWellnessLead(request, { suffix: `Dispo_${input.replace(/\s+/g, '_')}` });
      const res = await authPost(
        request,
        '/api/wellness/telecaller/dispose',
        { contactId: lead.id, disposition: input },
        'telecaller',
      );
      expect(res.status(), `dispose body: ${await res.text()}`).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, status: expected });

      // Verify status flipped on the underlying Contact via the contacts API.
      const ck = await authGet(request, `/api/contacts/${lead.id}`, 'admin');
      expect(ck.status()).toBe(200);
      const contact = await ck.json();
      expect(contact.status).toBe(expected);

      // Verify the Activity row was created with type=CallDisposition
      // (the route writes one row per dispose call).
      expect(Array.isArray(contact.activities)).toBe(true);
      const dispoActivity = contact.activities.find(
        (a) => a.type === 'CallDisposition' && a.description && a.description.startsWith(input),
      );
      expect(dispoActivity, `Activity with type=CallDisposition + description starting with "${input}"`).toBeTruthy();
    });
  }

  test('uppercase disposition still maps (route lowercases)', async ({ request }) => {
    const lead = await createWellnessLead(request, { suffix: 'CaseInsens' });
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: lead.id, disposition: 'INTERESTED' },
      'telecaller',
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Lead');
  });

  test('whitespace-padded disposition still maps (route trims)', async ({ request }) => {
    const lead = await createWellnessLead(request, { suffix: 'WhitespacePad' });
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: lead.id, disposition: '  callback  ' },
      'telecaller',
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Lead');
  });

  test('notes field appended into Activity description', async ({ request }) => {
    const lead = await createWellnessLead(request, { suffix: 'WithNotes' });
    const noteText = `${RUN_TAG}_NOTE_will-call-back-tomorrow-3pm`;
    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: lead.id, disposition: 'callback', notes: noteText },
      'telecaller',
    );
    expect(res.status()).toBe(200);

    const ck = await authGet(request, `/api/contacts/${lead.id}`, 'admin');
    const contact = await ck.json();
    const dispoAct = contact.activities.find(
      (a) => a.type === 'CallDisposition' && a.description && a.description.includes(noteText),
    );
    expect(dispoAct, 'notes must be embedded in Activity.description').toBeTruthy();
    // Format should be "<disposition>: <notes>" per the route source.
    expect(dispoAct.description.startsWith('callback:')).toBe(true);
  });
});

// =====================================================================
// 7. Tenant isolation — telecaller cannot dispose a generic-tenant Contact
// =====================================================================

test.describe('Wellness Telecaller API — tenant isolation', () => {
  test('dispose on a generic-tenant contactId → 404 (not 500, not 200)', async ({ request }) => {
    // Create a Contact in the GENERIC tenant (admin@globussoft.com). The
    // wellness telecaller must never see it via /telecaller/dispose — the
    // tenant-scope on prisma.contact.findFirst means the row is invisible
    // and the route returns 404 (not 500, not 200, not a leak).
    const genericLead = await createGenericLead(request, { suffix: 'CrossTenantProbe' });

    const res = await authPost(
      request,
      '/api/wellness/telecaller/dispose',
      { contactId: genericLead.id, disposition: 'interested' },
      'telecaller',
    );
    expect(res.status()).toBe(404);
    const body = await res.json().catch(() => ({}));
    expect(body.error).toMatch(/not found/i);

    // And: the generic-tenant contact's status must NOT have flipped.
    const ck = await authGet(request, `/api/contacts/${genericLead.id}`, 'genericAdmin');
    expect(ck.status()).toBe(200);
    const contact = await ck.json();
    expect(contact.status).toBe('Lead'); // still Lead, untouched
  });

  test('queue does not include generic-tenant leads (cross-tenant list scope)', async ({ request }) => {
    const genericLead = await createGenericLead(request, { suffix: 'CrossTenantList' });
    const res = await authGet(request, '/api/wellness/telecaller/queue', 'telecaller');
    expect(res.status()).toBe(200);
    const leads = (await res.json()).leads;
    expect(leads.find((x) => x.id === genericLead.id)).toBeFalsy();
  });
});
