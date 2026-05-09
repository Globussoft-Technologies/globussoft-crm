// @ts-check
/**
 * Wellness Ops Engine — full backend gate (G-7, docs/E2E_GAPS.md).
 *
 * Engine under test: backend/cron/wellnessOpsEngine.js
 *   - cron `17 * * * *` (disabled in CI by DISABLE_CRONS=1)
 *   - For tenants where `vertical='wellness' AND isActive=true`, runs:
 *       1. NPS dispatch — visits with status='completed' whose visitDate
 *          falls in `[now-14d, now-72h]`. Creates a Survey row tagged
 *          `nps-visit-<visitId>` (this is the dedup key) and queues an
 *          OUTBOUND SmsMessage with a survey link.
 *       2. Junk-lead retention — Contact rows with status='Junk' and
 *          createdAt older than 90 days are HARD-DELETED.
 *
 * Trigger endpoint: POST /api/wellness/ops/run
 *   - Defined at backend/routes/wellness.js:1715
 *   - Auth gate: verifyToken (global) + verifyWellnessRole(["admin","manager"])
 *   - Body: none (uses req.user.tenantId)
 *   - Returns: { npsSent, purged }
 *
 * Acceptance criteria covered (G-7 from docs/E2E_GAPS.md):
 *   1. NPS happy path     — visit completed 73h ago → SMS queued, Survey row created
 *   2. NPS too early      — visit completed 24h ago → no SMS (window not reached)
 *   3. NPS idempotency    — second run does NOT duplicate the SMS (Survey-tag dedup)
 *   4. NPS cancelled exempt — status='cancelled' inside the window → no SMS
 *   5. Junk purge old     — status='Junk', createdAt 91d ago → contact hard-deleted
 *   6. Junk preserve recent — status='Junk', createdAt 30d ago → preserved (CRITICAL)
 *   7. Junk preserve non-junk — status='Lead', createdAt 91d ago → preserved (CRITICAL)
 *   8. RBAC: USER → 403; MANAGER + ADMIN → 200
 *   9. Auth gate: no token → 401/403
 *  10. Tenant isolation: generic-tenant ADMIN → 403 (WELLNESS_TENANT_REQUIRED)
 *
 * Why direct SQL for back-dating?
 *   The engine queries on raw `visitDate` and `createdAt` columns. The
 *   global `stripDangerous` middleware deletes `createdAt`/`updatedAt`
 *   from every request body, and there is no API path to set Visit
 *   visitDate >72h in the past with status=completed (POST /visits
 *   accepts visitDate but ensureVisitDate just bounds it to ±5y/+1y).
 *   Visit accepts past visitDate via API; Contact does not accept
 *   createdAt at all. We use mysql2 directly (already a devDependency
 *   for global-teardown.js) to back-date precisely after the API
 *   creates the row. This mirrors how the real cron sees the data.
 *
 * Test data hygiene:
 *   - RUN_TAG = `E2E_FLOW_OPS_<ts>`. Patient.name + Contact.name are
 *     prefixed with the tag so global-teardown's NAME regex
 *     (matches `^E2E_FLOW_/`) cleans them up.
 *   - Visits cascade-delete with the Patient (Prisma onDelete: Cascade).
 *   - Survey rows created by the engine carry `name='nps-visit-<id>'`
 *     and DO NOT match the teardown regex — afterAll() hard-deletes
 *     each one we observed via mysql2 to keep the demo DB clean.
 *   - SmsMessage rows are not auto-cleaned (no name field on the
 *     teardown contract); they are inert noise on the ephemeral CI DB.
 *
 * Pattern: clones e2e/tests/appointment-reminders-api.spec.js (cron-engine
 * trigger + DB side-effect assertion + RBAC + tenant isolation).
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;

const RUN_TAG = `E2E_FLOW_OPS_${Date.now()}`;

// Force serial execution. Reason: every `runOps()` call processes ALL
// completed-window visits + ALL Junk contacts across the tenant. When two
// tests run in parallel and both have seeded a 73h-completed visit, the
// first tick queues SMS for both visits, and the second test's
// idempotency check sees +2 from the parallel queue. Serialising keeps
// each test's expectations scoped to the fixture it just seeded.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  // Wellness ADMIN — owner-equivalent. Lands the trigger 200.
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
  // Wellness MANAGER — also passes verifyWellnessRole(["admin","manager"]).
  wellnessManager: { email: 'manager@enhancedwellness.in', password: 'password123' },
  // USER role inside the wellness tenant — should 403 the gate.
  // user@wellness.demo is role=USER, wellnessRole=professional — exactly
  // the non-admin case the gate is designed to block.
  wellnessUser: { email: 'user@wellness.demo', password: 'password123' },
  // Generic CRM ADMIN — same role token but tenant.vertical='generic'.
  // Should 403 with WELLNESS_TENANT_REQUIRED.
  genericAdmin: { email: 'admin@globussoft.com', password: 'password123' },
};

const tokens = {};
const seedIds = {
  serviceId: null,    // wellness service (for visit FK)
  doctorId: null,     // wellness doctor user (for visit FK)
};
// Track every row we create so afterAll can clean up.
const createdPatientIds = [];
const createdContactIds = [];
const createdVisitIds = [];

// ─── HTTP helpers ────────────────────────────────────────────────────────

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function authPost(request, token, p, body) {
  return request.post(`${API}${p}`, {
    headers: authHeader(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

async function authGet(request, token, p) {
  return request.get(`${API}${p}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// ─── Direct DB helpers (for back-dating + cleanup) ───────────────────────
//
// We need to back-date Visit.visitDate and Contact.createdAt to test the
// engine's time-window queries. The global `stripDangerous` middleware
// strips `createdAt`/`updatedAt` from every API request body, and there
// is no API path to set Contact.createdAt directly.
//
// We can't connect to MySQL directly from the spec (the demo box's MySQL
// port isn't exposed to the internet — only the backend's host can reach
// it). Instead we shell out a tiny Prisma snippet inside backend/ where
// the Prisma client is installed and configured for the same DATABASE_URL
// the live backend talks to. This is the same access path the engine
// uses, so any back-date we make is precisely what the engine will see.

const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'backend');
// CI runs MySQL 8 in a service container at 127.0.0.1:3306 (deploy.yml/coverage.yml
// set DATABASE_URL=mysql://root:ci_root_pw@127.0.0.1:3306/gbscrm_ci). Locally,
// scripts/local-stack-up.ps1 boots Docker MySQL on port 3307 with a different
// password and overrides DATABASE_URL at backend startup time — so the .env
// on disk is stale. We honour process.env.DATABASE_URL first (CI), then probe
// the local-stack default. dbProbeCached caches the working URL.
let cachedDbUrl = undefined; // undefined = not probed; null = unavailable; string = working

function candidateDbUrls() {
  const list = [];
  if (process.env.DATABASE_URL) list.push(process.env.DATABASE_URL);
  // Local Docker stack default — see scripts/local-stack-up.ps1.
  list.push('mysql://root:local_dev_pw@127.0.0.1:3307/gbscrm_local');
  return list;
}

function probePrismaClient() {
  try {
    require.resolve('@prisma/client', { paths: [BACKEND_DIR] });
    return true;
  } catch (_e) {
    return false;
  }
}

function probeUrl(url) {
  // Quick connectivity smoke test against `url`. Returns true if Prisma can
  // count Contact rows (== DB reachable AND schema applied).
  const wrapped = `
    (async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(url)} } } });
      try {
        await prisma.contact.count();
        process.stdout.write('OK');
      } catch (e) {
        process.stdout.write('ERR:' + e.message.slice(0, 80));
        process.exitCode = 2;
      } finally { await prisma.$disconnect(); }
    })();
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', wrapped], {
      cwd: BACKEND_DIR, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out === 'OK';
  } catch (_e) {
    return false;
  }
}

function dbAvailable() {
  if (cachedDbUrl !== undefined) return cachedDbUrl !== null;
  if (!probePrismaClient()) { cachedDbUrl = null; return false; }
  for (const url of candidateDbUrls()) {
    if (probeUrl(url)) { cachedDbUrl = url; return true; }
  }
  cachedDbUrl = null;
  return false;
}

function runPrismaScript(jsBody) {
  // Run a tiny Prisma snippet in a child node process, with cwd=backend/ so
  // it can resolve @prisma/client. We always pass an explicit datasource URL
  // (cachedDbUrl was set by dbAvailable()) so the working DB is hit even
  // when backend/.env points at the unreachable demo box.
  if (!dbAvailable()) throw new Error('Prisma DB not reachable from this environment');
  const wrapped = `
    (async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(cachedDbUrl)} } } });
      try {
        const result = await (async () => { ${jsBody} })();
        process.stdout.write(JSON.stringify({ ok: true, result }));
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
        process.exitCode = 2;
      } finally {
        await prisma.$disconnect();
      }
    })();
  `;
  const out = execFileSync(process.execPath, ['-e', wrapped], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`Prisma script failed: ${parsed.error}`);
  return parsed.result;
}

function backdateVisit(visitId, isoDate) {
  return runPrismaScript(
    `await prisma.visit.update({ where: { id: ${Number(visitId)} }, data: { visitDate: new Date('${isoDate}') } }); return true;`
  );
}

function backdateContact(contactId, isoDate) {
  return runPrismaScript(
    `await prisma.contact.update({ where: { id: ${Number(contactId)} }, data: { createdAt: new Date('${isoDate}') } }); return true;`
  );
}

function contactExists(contactId) {
  return runPrismaScript(
    `const r = await prisma.contact.findUnique({ where: { id: ${Number(contactId)} } }); return r !== null;`
  );
}

function deleteSurveysByName(names) {
  if (!names || names.length === 0) return 0;
  const arrLit = JSON.stringify(names);
  return runPrismaScript(
    `const r = await prisma.survey.deleteMany({ where: { name: { in: ${arrLit} } } }); return r.count;`
  );
}

// ─── Seed helpers ────────────────────────────────────────────────────────

function randomPhone() {
  const tail = String(Math.floor(1000000000 + Math.random() * 9000000000)).slice(-10);
  return `9${tail.slice(0, 9)}`;
}

// Resolve seeded service + doctor IDs from the wellness tenant. Visit
// POST validation requires both for status='completed' (#109). We grab
// the first available service and the first user with wellnessRole='doctor'.
async function resolveWellnessFixtureIds(request) {
  // Services
  const sRes = await authGet(request, tokens.wellnessAdmin, '/wellness/services');
  if (sRes.ok()) {
    const body = await sRes.json().catch(() => ({}));
    const list = Array.isArray(body) ? body : (body.services || body.data || []);
    if (list.length > 0) seedIds.serviceId = list[0].id;
  }
  // Doctor
  const stRes = await authGet(request, tokens.wellnessAdmin, '/staff');
  if (stRes.ok()) {
    const users = await stRes.json().catch(() => []);
    const doc = (Array.isArray(users) ? users : []).find((u) => u.wellnessRole === 'doctor');
    if (doc) seedIds.doctorId = doc.id;
  }
}

async function createPatient(request, label) {
  if (!tokens.wellnessAdmin) return null;
  const res = await authPost(request, tokens.wellnessAdmin, '/wellness/patients', {
    name: `${RUN_TAG} ${label}`,
    phone: randomPhone(),
    source: 'g7-ops-test',
  });
  if (!res.ok()) return null;
  const p = await res.json();
  createdPatientIds.push(p.id);
  return p;
}

// Create a completed visit. Service + doctor IDs are required for
// completed/in-treatment per #109. visitDate accepts past dates within
// 5y; we pass `now - 73h` so the engine's
// `[now-14d, now-72h]` window picks it up.
//
// Wave 11 GG booking-conflict gate: subtract a per-call hour offset from
// the requested visitDate so successive calls within the same spec
// (all using seedIds.doctorId) don't bucket-collide on (doctor, UTC-hour)
// at create time. The engine itself only filters by the post-backdate
// visitDate, so shifting the create-time date by a few hours is safe —
// we backdate immediately afterwards anyway.
//
// Round-7-followup: start the offset at 96h (4 days back) so the FIRST
// call doesn't land on the `new Date()` hour-bucket where sibling specs
// (wellness-clinical-api, wellness-rbac-regression) may have created
// active-status visits. All offsets stay safely within the engine
// window `[now-14d, now-72h]`.
let _opsCreateOffsetH = 96;
async function createCompletedVisit(request, patientId, visitDateIso) {
  const shifted = new Date(new Date(visitDateIso).getTime() - (_opsCreateOffsetH++ * 3600 * 1000)).toISOString();
  const res = await authPost(request, tokens.wellnessAdmin, '/wellness/visits', {
    patientId,
    serviceId: seedIds.serviceId,
    doctorId: seedIds.doctorId,
    visitDate: shifted,
    status: 'completed',
  });
  if (!res.ok()) {
    const txt = await res.text();
    throw new Error(`createCompletedVisit failed (${res.status()}): ${txt}`);
  }
  const v = await res.json();
  createdVisitIds.push(v.id);
  return v;
}

// Cancelled-status variant. Service + doctor are NOT required for
// non-completed statuses (#109).
async function createCancelledVisit(request, patientId, visitDateIso) {
  const res = await authPost(request, tokens.wellnessAdmin, '/wellness/visits', {
    patientId,
    visitDate: visitDateIso,
    status: 'cancelled',
  });
  if (!res.ok()) {
    const txt = await res.text();
    throw new Error(`createCancelledVisit failed (${res.status()}): ${txt}`);
  }
  const v = await res.json();
  createdVisitIds.push(v.id);
  return v;
}

async function createContact(request, label, status) {
  if (!tokens.wellnessAdmin) return null;
  const email = `e2e-ops-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const res = await authPost(request, tokens.wellnessAdmin, '/contacts', {
    name: `${RUN_TAG} ${label}`,
    email,
    phone: randomPhone(),
    status, // 'Junk' | 'Lead' | etc.
  });
  if (!res.ok()) {
    const txt = await res.text();
    throw new Error(`createContact failed (${res.status()}): ${txt}`);
  }
  const c = await res.json();
  createdContactIds.push(c.id);
  return c;
}

async function runOps(request, token) {
  return authPost(request, token, '/wellness/ops/run', {});
}

// Filter SMS by phone — the engine's NPS body is unique-per-visit so
// scoping by `to=phone` (or by patient name in the body) keeps each
// test's assertion local.
async function fetchSmsForPhone(request, token, phone) {
  const res = await authGet(request, token, '/sms/messages?direction=OUTBOUND&limit=200');
  if (!res.ok()) return [];
  const body = await res.json().catch(() => ({}));
  const list = Array.isArray(body) ? body : (body.messages || []);
  return list.filter((m) => m && m.to === phone);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

test.beforeAll(async ({ request }) => {
  for (const [k, f] of Object.entries(FIXTURES)) {
    const t = await login(request, f);
    if (t) tokens[k] = t;
  }
  if (tokens.wellnessAdmin) {
    await resolveWellnessFixtureIds(request);
  }
});

test.afterAll(async ({ request }) => {
  // Per-spec cleanup. The wellness route does not expose DELETE /patients
  // (#327 — clinical write-gate), so we PUT-rename each patient to a
  // non-residue name before global-teardown sees the row.
  if (tokens.wellnessAdmin) {
    for (const id of createdPatientIds) {
      await request.put(`${API}/wellness/patients/${id}`, {
        headers: authHeader(tokens.wellnessAdmin),
        data: { name: `_teardown_g7_${id}` },
        timeout: REQUEST_TIMEOUT,
      }).catch(() => { /* best-effort */ });
    }
  }
  // Survey rows emitted by the engine (name='nps-visit-<id>') do NOT
  // match the teardown NAME regex, so we drop them explicitly via the
  // backend-side Prisma helper. Contact-side residue is covered by the
  // global-teardown's name + email regex (the @example.test email matches).
  if (dbAvailable() && createdVisitIds.length > 0) {
    try {
      const tags = createdVisitIds.map((id) => `nps-visit-${id}`);
      deleteSurveysByName(tags);
    } catch (_e) {
      /* best-effort — don't fail the suite on a cleanup miss */
    }
  }
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('POST /api/wellness/ops/run — auth gate', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/wellness/ops/run`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // backend/middleware/auth.js: missing Authorization header → 403
    // ("Access Denied"); a present-but-invalid token → 401. Either is a
    // correct refusal — assert the unauth contract, not the specific code.
    expect([401, 403]).toContain(res.status());
  });

  test('bogus bearer → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/wellness/ops/run`, {
      data: {},
      headers: { Authorization: 'Bearer not-a-real-jwt', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── RBAC gate (verifyWellnessRole(["admin","manager"])) ─────────────────

test.describe('POST /api/wellness/ops/run — RBAC gate', () => {
  test('wellness USER (role=USER, wellnessRole=professional) → 403', async ({ request }) => {
    test.skip(!tokens.wellnessUser, 'wellness user fixture (user@wellness.demo) not seeded');
    const res = await runOps(request, tokens.wellnessUser);
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    // Either WELLNESS_ROLE_FORBIDDEN (allowed list mismatch) or
    // WELLNESS_TENANT_REQUIRED (vertical gate) — both prove the gate
    // refused. The middleware checks tenant FIRST, but a wellness USER
    // *is* on a wellness tenant so we expect the role code.
    expect(['WELLNESS_ROLE_FORBIDDEN', 'WELLNESS_TENANT_REQUIRED']).toContain(body.code);
  });

  test('wellness MANAGER → 200', async ({ request }) => {
    test.skip(!tokens.wellnessManager, 'wellness manager fixture not seeded');
    const res = await runOps(request, tokens.wellnessManager);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
  });

  test('wellness ADMIN → 200', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const res = await runOps(request, tokens.wellnessAdmin);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // Shape from POST /ops/run — every successful run carries these.
    expect(body).toHaveProperty('npsSent');
    expect(body).toHaveProperty('purged');
    expect(typeof body.npsSent).toBe('number');
    expect(typeof body.purged).toBe('number');
  });

  test('generic-tenant ADMIN → 403 (WELLNESS_TENANT_REQUIRED)', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin fixture not seeded');
    const res = await runOps(request, tokens.genericAdmin);
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    // Cross-tenant defence in depth — generic admin gets the vertical
    // gate. The engine itself only ever queries `tenantId=req.user.tenantId`,
    // so this 403 also proves a generic caller can never reach the
    // wellness tenant's Visit/Contact rows. Tenant isolation: locked.
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
  });
});

// ─── NPS dispatch — happy path + windowing ───────────────────────────────

test.describe('Wellness Ops Engine — NPS dispatch', () => {
  test('completed visit 73h ago → SMS queued for the patient', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!seedIds.serviceId || !seedIds.doctorId, 'wellness service/doctor seed missing');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const patient = await createPatient(request, 'NPS-happy');
    expect(patient, 'patient seed must succeed').toBeTruthy();

    // Create with `now` then back-date to 73h ago. Engine's window is
    // `visitDate ∈ [now-14d, now-72h]`. 73h sits cleanly inside.
    const visit = await createCompletedVisit(
      request,
      patient.id,
      new Date().toISOString()
    );
    const past = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
    expect(await backdateVisit(visit.id, past), 'back-date must succeed').toBeTruthy();

    const runRes = await runOps(request, tokens.wellnessAdmin);
    expect(runRes.status(), `body: ${await runRes.text()}`).toBe(200);
    const result = await runRes.json();
    // npsSent reflects ALL eligible visits across the tenant — assert
    // the tenant-level queue moved forward AT LEAST by 1.
    expect(result.npsSent).toBeGreaterThanOrEqual(1);

    const sms = await fetchSmsForPhone(request, tokens.wellnessAdmin, patient.phone);
    expect(sms.length, 'one OUTBOUND NPS SMS for the patient').toBeGreaterThanOrEqual(1);
    const ours = sms[0];
    expect(ours.direction).toBe('OUTBOUND');
    expect(ours.status).toBe('QUEUED');
    // The engine's body always contains the patient name + a
    // "/survey/<id>?p=<patientId>" link. Either is a strong marker.
    expect(ours.body).toContain(patient.name);
    expect(ours.body).toMatch(/\/survey\/\d+\?p=\d+/);
  });

  test('completed visit 24h ago (window not reached) → no NPS SMS', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!seedIds.serviceId || !seedIds.doctorId, 'wellness service/doctor seed missing');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const patient = await createPatient(request, 'NPS-tooEarly');
    expect(patient).toBeTruthy();

    const visit = await createCompletedVisit(
      request,
      patient.id,
      new Date().toISOString()
    );
    // 24h ago is BEFORE the cutoff (cutoff = now-72h, query is `lte: cutoff`).
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await backdateVisit(visit.id, past);

    await runOps(request, tokens.wellnessAdmin);

    const sms = await fetchSmsForPhone(request, tokens.wellnessAdmin, patient.phone);
    expect(
      sms.length,
      `no NPS SMS for too-recent visit; got bodies=${JSON.stringify(sms.map((s) => s.body))}`
    ).toBe(0);
  });

  test('cancelled visit at the 72h window → no NPS SMS (status=completed only)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const patient = await createPatient(request, 'NPS-cancelled');
    expect(patient).toBeTruthy();

    const visit = await createCancelledVisit(
      request,
      patient.id,
      new Date().toISOString()
    );
    // Inside the engine's window, but status='cancelled' → engine query
    // `status:'completed'` excludes it.
    const past = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
    await backdateVisit(visit.id, past);

    await runOps(request, tokens.wellnessAdmin);

    const sms = await fetchSmsForPhone(request, tokens.wellnessAdmin, patient.phone);
    expect(sms.length, 'cancelled visit must not trigger NPS').toBe(0);
  });

  test('idempotency: running twice does NOT duplicate the NPS SMS', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!seedIds.serviceId || !seedIds.doctorId, 'wellness service/doctor seed missing');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const patient = await createPatient(request, 'NPS-idempotent');
    expect(patient).toBeTruthy();

    const visit = await createCompletedVisit(
      request,
      patient.id,
      new Date().toISOString()
    );
    const past = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
    await backdateVisit(visit.id, past);

    // First tick — queues one NPS SMS for our patient.
    await runOps(request, tokens.wellnessAdmin);
    const after1 = await fetchSmsForPhone(request, tokens.wellnessAdmin, patient.phone);
    expect(after1.length, 'first tick must queue at least one NPS SMS').toBeGreaterThanOrEqual(1);
    const countAfterFirst = after1.length;

    // Second tick — engine's dedup is `prisma.survey.findFirst({ name: tag })`
    // where `tag = 'nps-visit-<visitId>'`. The Survey row from tick 1
    // matches → skip → no new SMS.
    await runOps(request, tokens.wellnessAdmin);
    const after2 = await fetchSmsForPhone(request, tokens.wellnessAdmin, patient.phone);
    expect(
      after2.length,
      `second tick must NOT add new NPS SMS for same patient (was ${countAfterFirst}, now ${after2.length})`
    ).toBe(countAfterFirst);
  });
});

// ─── Junk-lead retention purge ───────────────────────────────────────────

test.describe('Wellness Ops Engine — junk-lead retention', () => {
  test('purge: Junk contact created 91 days ago → hard-deleted', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await createContact(request, 'Junk-old', 'Junk');
    expect(contact, 'contact seed must succeed').toBeTruthy();

    // Back-date past the 90-day cutoff. Engine query is `createdAt: { lt: cutoff }`.
    const past = new Date(Date.now() - 91 * 86400000).toISOString();
    expect(await backdateContact(contact.id, past)).toBeTruthy();

    const runRes = await runOps(request, tokens.wellnessAdmin);
    expect(runRes.status()).toBe(200);
    const result = await runRes.json();
    expect(result.purged).toBeGreaterThanOrEqual(1);

    // Verify hard-delete: row is gone from the DB entirely.
    const stillExists = await contactExists(contact.id);
    expect(stillExists, `Junk contact ${contact.id} must be hard-deleted`).toBe(false);
  });

  test('preserve recent: Junk contact created 30 days ago → NOT deleted (CRITICAL)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await createContact(request, 'Junk-recent', 'Junk');
    expect(contact).toBeTruthy();

    // 30 days ago — well inside the 90-day retention window. Must survive.
    const past = new Date(Date.now() - 30 * 86400000).toISOString();
    await backdateContact(contact.id, past);

    await runOps(request, tokens.wellnessAdmin);

    const stillExists = await contactExists(contact.id);
    expect(
      stillExists,
      `recent Junk contact ${contact.id} must NOT be deleted (createdAt 30d ago)`
    ).toBe(true);
  });

  test('preserve non-junk: Lead contact created 91 days ago → NOT deleted (CRITICAL)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await createContact(request, 'Lead-old', 'Lead');
    expect(contact).toBeTruthy();

    // 91 days old BUT status='Lead' — engine query filters on
    // `status: "Junk"` so non-junk rows are immune at any age. Purging
    // an old real customer because they're old would be a disaster.
    const past = new Date(Date.now() - 91 * 86400000).toISOString();
    await backdateContact(contact.id, past);

    await runOps(request, tokens.wellnessAdmin);

    const stillExists = await contactExists(contact.id);
    expect(
      stillExists,
      `non-Junk contact ${contact.id} must NOT be deleted regardless of age`
    ).toBe(true);
  });
});
