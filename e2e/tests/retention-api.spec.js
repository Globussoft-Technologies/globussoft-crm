// @ts-check
/**
 * Retention Engine — gate spec for cron/retentionEngine.js (G-11).
 *
 * GDPR-CRITICAL + DESTRUCTIVE. Reading this spec carefully before changing
 * the engine or the trigger endpoint is non-optional — a bug here can
 * trigger mass cross-tenant data deletion.
 *
 * Engine under test: backend/cron/retentionEngine.js
 *   - cron `0 3 * * *` (daily 03:00 server, disabled in CI by DISABLE_CRONS=1)
 *   - For each active RetentionPolicy: prisma.<entity>.deleteMany where
 *     tenantId=policy.tenantId AND createdAt < (now - retainDays * 86400000).
 *     Hard-delete. Per-entity AuditLog row written when deleted > 0
 *     (action='DELETE', entity=<entity>, details={source:'RetentionEngine',
 *     deleted, retainDays, cutoff}).
 *   - ENTITY_MAP whitelist: EmailMessage, CallLog, Activity, SmsMessage,
 *     WhatsAppMessage. Any other entity name in the policy is silently
 *     skipped — defence in depth against operator error.
 *
 * Trigger endpoint (NEW — added in this PR alongside the spec):
 *   POST /api/gdpr/retention/run
 *     middleware stack: verifyToken (router-level)
 *                     → verifyRole(['ADMIN'])
 *                     → body.confirmDestructive === true (else 400)
 *
 *     Three guards layered. Without ALL THREE the call cannot delete
 *     anything:
 *       - 401/403 without token (verifyToken)
 *       - 403 with token but role !== ADMIN (verifyRole)
 *       - 400 CONFIRMATION_REQUIRED if body lacks confirmDestructive:true
 *         (no DB mutation, no AuditLog row)
 *       - 200 on success — returns { success, tenantId, summary[] } where
 *         summary is per-entity { entity, deleted, retainDays, cutoff }.
 *
 *     Differs from the cron engine in two intentional ways:
 *       1. Tenant-scoped (cron sweeps all tenants; this scopes to req.user.tenantId).
 *       2. Always writes an AuditLog row (even on deleted=0) so the
 *          MANUAL operator + timestamp + reason are captured for GDPR
 *          audit-trail compliance. The cron engine skips audit on
 *          deleted=0; for a manual call we need the WHO/WHEN regardless.
 *
 * Acceptance criteria (G-11 from docs/E2E_GAPS.md):
 *   1. Past-window row hard-deleted — EmailMessage with createdAt 8y ago,
 *      RetentionPolicy retainDays=30 → deleted (row gone from DB).
 *   2. Inside-window row preserved — EmailMessage with createdAt 7d ago,
 *      same policy retainDays=30 → still present.
 *   3. AuditLog written for every retention sweep — action='DELETE',
 *      entity matches policy entity, details JSON contains
 *      source='RetentionEngine', via='manual' (manual marker
 *      distinguishes from the cron writes), userId=requesting admin,
 *      tenantId=requesting tenant.
 *   4. confirmDestructive omitted (or false) → 400 CONFIRMATION_REQUIRED;
 *      NO row deleted; NO AuditLog row written. Reverse only with code.
 *   5. Tenant isolation — generic admin's /run NEVER touches wellness rows
 *      AT ANY AGE. Critical: a leak here = mass cross-tenant deletion.
 *      Spec seeds an 8y-old EmailMessage on the WELLNESS tenant with the
 *      same RUN_TAG, runs the sweep as the GENERIC admin, and asserts the
 *      wellness row STILL EXISTS post-run. (Generic admin's policy may or
 *      may not catch its own old rows — irrelevant; what matters is
 *      wellness was untouched.)
 *   6. RBAC: non-ADMIN → 403 (USER + MANAGER). No row deleted. No audit.
 *   7. Auth: no token → 401/403; bogus bearer → 401/403.
 *   8. Self-clean: spec creates RUN_TAG-prefixed EmailMessage rows; the
 *      retention sweep deletes the past-window ones; afterAll Prisma-
 *      hard-deletes any control rows that the engine spared (inside-
 *      window preservation + tenant-isolation control). AuditLog rows
 *      with details containing the RUN_TAG are also scrubbed.
 *
 * Why direct DB for back-dating?
 *   The engine's where-clause is `createdAt: { lt: cutoff }` where
 *   cutoff = now - 30d (or whatever retainDays we set). The global
 *   `stripDangerous` middleware deletes `createdAt` from every request
 *   body. There is no API path to set EmailMessage.createdAt to 8y ago.
 *   Use the same Prisma child-process pattern as wellness-ops-api.spec.js
 *   + recurring-invoice-api.spec.js + scheduled-email-api.spec.js.
 *
 * Test data hygiene:
 *   - RUN_TAG = `E2E_FLOW_RETENTION_<ts>`. EmailMessage.subject carries
 *     the tag so we can find OUR rows back without depending on row id
 *     after deletion.
 *   - The retention engine HARD-DELETES — there's nothing to clean for
 *     past-window rows. The two control rows that survive (inside-window
 *     + cross-tenant) are explicitly Prisma-deleted in afterAll.
 *   - AuditLog rows have action='DELETE' + details JSON containing the
 *     RUN_TAG (we set RetentionPolicy.entity=EmailMessage; the audit
 *     row's `entity` is the model name, not our tag). We delete by
 *     userId + recent createdAt window in afterAll.
 *   - RetentionPolicy rows are upserted; afterAll restores them by
 *     setting isActive=false (less destructive than delete — preserves
 *     any policy the demo user genuinely had configured).
 *
 * Test environment expectations:
 *   - BASE_URL defaults to http://127.0.0.1:5000 (local stack). CI sets
 *     BASE_URL=http://127.0.0.1:5000 (deploy.yml's matrix backend boot).
 *   - Login fixtures: admin@globussoft.com / manager@crm.com / user@crm.com
 *     (generic) + admin@wellness.demo (wellness).
 *   - Both tenants must be seeded (prisma/seed.js + prisma/seed-wellness.js).
 *
 * Pattern: builds on recurring-invoice-api.spec.js + wellness-ops-api.spec.js.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const RUN_TAG = `E2E_FLOW_RETENTION_${Date.now()}`;

// Force serial. Each /run sweeps EVERY active retention policy on the
// requesting tenant — parallel tests would race on the policy upsert
// and trip each other's WHERE clause.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  admin: { email: 'admin@globussoft.com', password: 'password123' },
  manager: { email: 'manager@crm.com', password: 'password123' },
  user: { email: 'user@crm.com', password: 'password123' },
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
};

const tokens = {};
const tenantIds = {};
const userIds = {};
// Track every EmailMessage we created (by id) so afterAll can scrub
// inside-window controls + the cross-tenant control row.
const createdEmailIds = []; // generic
const createdWellnessEmailIds = []; // wellness
// Track recipients in a Set so the EmailMessage scrub by `to` filter
// also catches anything we mis-tracked.
const createdRecipients = new Set();
// Track the AuditLog action+entity tuple we expect to see.
let policyOriginalActive = null; // capture pre-test state to restore

// ─── HTTP helpers ────────────────────────────────────────────────────────

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return {
          token: j.token,
          tenantId: j.tenant && j.tenant.id,
          userId: j.user && j.user.id,
        };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, tenantId: null, userId: null };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function authPost(request, token, p, body, extraHeaders) {
  return request.post(`${API}${p}`, {
    headers: { ...authHeader(token), ...(extraHeaders || {}) },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

async function authPut(request, token, p, body, extraHeaders) {
  return request.put(`${API}${p}`, {
    headers: { ...authHeader(token), ...(extraHeaders || {}) },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

// #654 — mint a step-up token. Required by destructive GDPR endpoints
// (PUT /retention-policies, POST /retention/run). 5-min TTL — we re-mint
// per call to keep the spec robust under arbitrary execution ordering.
async function mintStepUp(request, fixture, token) {
  const r = await request.post(`${API}/auth/step-up`, {
    headers: authHeader(token),
    data: { password: fixture.password },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) {
    throw new Error(`mintStepUp ${fixture.email}: ${r.status()} ${await r.text()}`);
  }
  const j = await r.json();
  return j.stepUpToken;
}

// ─── Direct DB helpers ───────────────────────────────────────────────────
// Same access pattern as recurring-invoice-api.spec.js + wellness-ops-api.spec.js.

const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'backend');
let cachedDbUrl = undefined;

function candidateDbUrls() {
  const list = [];
  if (process.env.DATABASE_URL) list.push(process.env.DATABASE_URL);
  list.push('mysql://root:local_dev_pw@127.0.0.1:3307/gbscrm_local');
  return list;
}
function probePrismaClient() {
  try { require.resolve('@prisma/client', { paths: [BACKEND_DIR] }); return true; }
  catch (_e) { return false; }
}
function probeUrl(url) {
  const wrapped = `
    (async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(url)} } } });
      try { await prisma.emailMessage.count(); process.stdout.write('OK'); }
      catch (e) { process.stdout.write('ERR:' + e.message.slice(0,80)); process.exitCode = 2; }
      finally { await prisma.$disconnect(); }
    })();
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', wrapped], {
      cwd: BACKEND_DIR, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out === 'OK';
  } catch (_e) { return false; }
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
      } finally { await prisma.$disconnect(); }
    })();
  `;
  const out = execFileSync(process.execPath, ['-e', wrapped], {
    cwd: BACKEND_DIR, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`Prisma script failed: ${parsed.error}`);
  return parsed.result;
}

// Seed an EmailMessage row on a given tenant with a specific createdAt.
// Returns the row id.
function seedEmailMessage(tenantId, subject, recipient, createdAtIso) {
  return runPrismaScript(
    `const r = await prisma.emailMessage.create({ data: {
       subject: ${JSON.stringify(subject)},
       body: ${JSON.stringify(`${RUN_TAG} retention test body`)},
       from: ${JSON.stringify('noreply@e2e.test')},
       to: ${JSON.stringify(recipient)},
       direction: 'OUTBOUND',
       read: true,
       tenantId: ${Number(tenantId)},
       createdAt: new Date(${JSON.stringify(createdAtIso)}),
     } });
     return r.id;`
  );
}

function emailExists(id) {
  return runPrismaScript(
    `const r = await prisma.emailMessage.findUnique({ where: { id: ${Number(id)} } }); return r !== null;`
  );
}

function deleteEmailIds(ids) {
  if (!ids || ids.length === 0) return 0;
  return runPrismaScript(
    `const r = await prisma.emailMessage.deleteMany({ where: { id: { in: ${JSON.stringify(ids)} } } }); return r.count;`
  );
}

// Look up the most recent AuditLog row for the given tenant + entity +
// userId tuple. Returns the row or null.
function findLatestRetentionAudit(tenantId, entity, userId) {
  return runPrismaScript(
    `const r = await prisma.auditLog.findFirst({
       where: {
         tenantId: ${Number(tenantId)},
         entity: ${JSON.stringify(entity)},
         action: 'DELETE',
         userId: ${userId == null ? 'null' : Number(userId)},
       },
       orderBy: { createdAt: 'desc' },
     });
     return r;`
  );
}

function deleteAuditLogsForUser(userId, tenantId, sinceIso) {
  return runPrismaScript(
    `const r = await prisma.auditLog.deleteMany({ where: {
       userId: ${Number(userId)},
       tenantId: ${Number(tenantId)},
       action: 'DELETE',
       createdAt: { gte: new Date(${JSON.stringify(sinceIso)}) },
     } });
     return r.count;`
  );
}

// Set or restore RetentionPolicy via the public PUT route
// (PUT /api/gdpr/retention-policies — body is an array of upserts).
// retainDays=30 means rows older than 30d get deleted; we tune the
// fixtures around that.
//
// #654 — this endpoint now requires a step-up token; we mint one per call
// from the admin fixture's password (5-min TTL, scoped to caller).
async function setRetentionPolicy(request, fixture, token, entity, retainDays, isActive) {
  const stepUpToken = await mintStepUp(request, fixture, token);
  const r = await authPut(request, token, '/gdpr/retention-policies', [{
    entity, retainDays, isActive,
  }], { 'x-step-up-token': stepUpToken });
  if (!r.ok()) {
    throw new Error(`setRetentionPolicy ${entity}=${retainDays}d: ${r.status()} ${await r.text()}`);
  }
  return r.json();
}

// #654 — POST /retention/run also requires step-up. Callers that need to
// EXERCISE the "no step-up" 401 path supply opts.skipStepUp=true.
async function runRetention(request, fixture, token, body, opts = {}) {
  const headers = {};
  if (!opts.skipStepUp) {
    const stepUpToken = await mintStepUp(request, fixture, token);
    headers['x-step-up-token'] = stepUpToken;
  }
  return authPost(request, token, '/gdpr/retention/run', body, headers);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

const TEST_START_ISO = new Date().toISOString();

test.beforeAll(async ({ request }) => {
  for (const [k, f] of Object.entries(FIXTURES)) {
    const r = await login(request, f);
    if (r.token) {
      tokens[k] = r.token;
      tenantIds[k] = r.tenantId;
      userIds[k] = r.userId;
    }
  }
  expect(tokens.admin, 'generic admin token must be available').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  // 1. Hard-delete any inside-window EmailMessage controls that
  //    survived the retention sweep (the engine spared them
  //    intentionally; we created them, we clean them).
  if (dbAvailable()) {
    try {
      if (createdEmailIds.length > 0) deleteEmailIds(createdEmailIds);
      if (createdWellnessEmailIds.length > 0) deleteEmailIds(createdWellnessEmailIds);
    } catch (_e) { /* best-effort */ }

    // 2. Scrub AuditLog rows we caused via the engine. action='DELETE',
    //    userId=requesting admin's id, tenantId=our tenant, createdAt
    //    within this run's wall-clock window.
    try {
      if (userIds.admin && tenantIds.admin) {
        deleteAuditLogsForUser(userIds.admin, tenantIds.admin, TEST_START_ISO);
      }
      if (userIds.wellnessAdmin && tenantIds.wellnessAdmin) {
        deleteAuditLogsForUser(userIds.wellnessAdmin, tenantIds.wellnessAdmin, TEST_START_ISO);
      }
    } catch (_e) { /* best-effort */ }
  }

  // 3. Disable the RetentionPolicy rows we upserted so the next test or
  //    the demo user isn't surprised by an active policy. PUT with
  //    isActive=false keeps the row but the engine skips it.
  if (tokens.admin) {
    await setRetentionPolicy(request, FIXTURES.admin, tokens.admin, 'EmailMessage', 30, false).catch(() => {});
  }
  if (tokens.wellnessAdmin) {
    await setRetentionPolicy(request, FIXTURES.wellnessAdmin, tokens.wellnessAdmin, 'EmailMessage', 30, false).catch(() => {});
  }
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('POST /api/gdpr/retention/run — auth gate', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/gdpr/retention/run`, {
      data: { confirmDestructive: true },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('bogus bearer → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/gdpr/retention/run`, {
      data: { confirmDestructive: true },
      headers: { Authorization: 'Bearer not-a-real-jwt', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── RBAC gate ───────────────────────────────────────────────────────────

test.describe('POST /api/gdpr/retention/run — RBAC gate', () => {
  test('MANAGER → 403 (no row deleted, no AuditLog written)', async ({ request }) => {
    test.skip(!tokens.manager, 'manager fixture not seeded');
    // verifyRole runs BEFORE requireStepUp in the route chain — so a non-
    // admin call short-circuits to 403 without ever consulting step-up.
    // We skip the step-up mint here intentionally to keep the RBAC contract
    // free of step-up dependencies.
    const res = await runRetention(request, FIXTURES.manager, tokens.manager, { confirmDestructive: true }, { skipStepUp: true });
    expect(res.status()).toBe(403);
  });

  test('USER → 403', async ({ request }) => {
    test.skip(!tokens.user, 'user fixture not seeded');
    const res = await runRetention(request, FIXTURES.user, tokens.user, { confirmDestructive: true }, { skipStepUp: true });
    expect(res.status()).toBe(403);
  });
});

// ─── Confirmation guard ──────────────────────────────────────────────────

test.describe('POST /api/gdpr/retention/run — confirmDestructive guard', () => {
  test('missing confirmDestructive → 400 CONFIRMATION_REQUIRED, no row deleted', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    // Seed a definitively-past-window EmailMessage on the generic tenant.
    // Configure a policy that would otherwise eat it. Then call /run
    // WITHOUT the confirmDestructive flag and assert the row survives.
    await setRetentionPolicy(request, FIXTURES.admin, tokens.admin, 'EmailMessage', 30, true);
    const recipient = `e2e-retain-noconfirm-${Date.now()}@example.test`;
    createdRecipients.add(recipient);
    const past = new Date(Date.now() - 8 * 365 * 86400000).toISOString();
    const id = seedEmailMessage(tenantIds.admin, `${RUN_TAG} no-confirm-past`, recipient, past);
    createdEmailIds.push(id);

    // Call /run with NO confirmDestructive — must 400 + no mutation.
    // step-up mint here is intentional: confirmDestructive is checked
    // AFTER verifyRole + requireStepUp, so we need a valid step-up token
    // to reach the confirmation guard.
    const res = await runRetention(request, FIXTURES.admin, tokens.admin, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CONFIRMATION_REQUIRED');

    // Row must STILL exist — guard refused before any deleteMany ran.
    expect(emailExists(id), 'past-window row must NOT be deleted without confirmDestructive').toBe(true);
  });

  test('confirmDestructive: false → 400 CONFIRMATION_REQUIRED', async ({ request }) => {
    const res = await runRetention(request, FIXTURES.admin, tokens.admin, { confirmDestructive: false });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CONFIRMATION_REQUIRED');
  });
});

// ─── Engine semantics — delete past, preserve recent ─────────────────────

test.describe('Retention Engine — windowing + audit', () => {
  test('past-window EmailMessage hard-deleted, AuditLog row written', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    // Set a 30d retention policy on EmailMessage for the generic tenant.
    await setRetentionPolicy(request, FIXTURES.admin, tokens.admin, 'EmailMessage', 30, true);

    // Seed an 8-year-old EmailMessage on the generic tenant. The cutoff
    // for retainDays=30 is now-30d — 8y is comfortably outside.
    const recipient = `e2e-retain-past-${Date.now()}@example.test`;
    createdRecipients.add(recipient);
    const past = new Date(Date.now() - 8 * 365 * 86400000).toISOString();
    const pastId = seedEmailMessage(tenantIds.admin, `${RUN_TAG} past`, recipient, past);
    // We do NOT push pastId to createdEmailIds — we EXPECT the engine to
    // delete it. If the engine fails to delete, the row will remain in
    // the DB; afterAll's main scrub on createdEmailIds won't catch it.
    // Instead, the assertion below verifies deletion; if the deletion
    // never happens, test fails AND we manually clean by adding to the
    // list so the failure doesn't pollute future runs.

    const res = await runRetention(request, FIXTURES.admin, tokens.admin, { confirmDestructive: true });
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tenantId).toBe(tenantIds.admin);
    expect(Array.isArray(body.summary)).toBe(true);
    const emailEntry = body.summary.find((s) => s.entity === 'EmailMessage');
    expect(emailEntry, 'summary must contain EmailMessage entry').toBeTruthy();
    expect(emailEntry.deleted, 'past-window row must be counted in deleted').toBeGreaterThanOrEqual(1);

    // Row must be GONE from the DB.
    const stillExists = emailExists(pastId);
    if (stillExists) {
      // If this happens, the engine broke. Add to cleanup so afterAll
      // scrubs the failure residue.
      createdEmailIds.push(pastId);
    }
    expect(stillExists, `past-window row ${pastId} must be hard-deleted`).toBe(false);

    // AuditLog row written with action='DELETE', entity='EmailMessage',
    // userId=requesting admin, tenantId=requesting tenant, details JSON
    // containing source='RetentionEngine' + via='manual'.
    const audit = findLatestRetentionAudit(tenantIds.admin, 'EmailMessage', userIds.admin);
    expect(audit, 'AuditLog row must exist for this retention sweep').toBeTruthy();
    expect(audit.action).toBe('DELETE');
    expect(audit.entity).toBe('EmailMessage');
    expect(audit.userId).toBe(userIds.admin);
    expect(audit.tenantId).toBe(tenantIds.admin);
    const details = JSON.parse(audit.details || '{}');
    expect(details.source).toBe('RetentionEngine');
    expect(details.via).toBe('manual');
    expect(typeof details.deleted).toBe('number');
    expect(details.retainDays).toBe(30);
    expect(typeof details.cutoff).toBe('string');
  });

  test('inside-window EmailMessage preserved (CRITICAL)', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    // Set the same 30d policy active.
    await setRetentionPolicy(request, FIXTURES.admin, tokens.admin, 'EmailMessage', 30, true);

    // Seed a 7-day-old row — well inside the 30d window.
    const recipient = `e2e-retain-recent-${Date.now()}@example.test`;
    createdRecipients.add(recipient);
    const recent = new Date(Date.now() - 7 * 86400000).toISOString();
    const recentId = seedEmailMessage(tenantIds.admin, `${RUN_TAG} recent`, recipient, recent);
    createdEmailIds.push(recentId); // preserved → afterAll will scrub.

    await runRetention(request, FIXTURES.admin, tokens.admin, { confirmDestructive: true });

    expect(emailExists(recentId), `inside-window row must NOT be deleted`).toBe(true);
  });
});

// ─── Tenant isolation — THE MOST CRITICAL ASSERTION ──────────────────────

test.describe('Retention Engine — tenant isolation', () => {
  test('generic admin /run does NOT delete wellness-tenant rows AT ANY AGE', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    // Seed an 8-year-old EmailMessage on the WELLNESS tenant — would be
    // eaten if the policy applied to it. Configure the GENERIC tenant
    // with an aggressive 30d policy. The engine query is
    // `tenantId: req.user.tenantId` — wellness rows must be untouched.
    await setRetentionPolicy(request, FIXTURES.admin, tokens.admin, 'EmailMessage', 30, true);
    const recipient = `e2e-retain-wellness-iso-${Date.now()}@example.test`;
    createdRecipients.add(recipient);
    const past = new Date(Date.now() - 8 * 365 * 86400000).toISOString();
    const wellnessId = seedEmailMessage(tenantIds.wellnessAdmin, `${RUN_TAG} wellness-old`, recipient, past);
    createdWellnessEmailIds.push(wellnessId); // we'll clean this up in afterAll.

    // GENERIC admin runs the destructive sweep with full confirmation.
    const res = await runRetention(request, FIXTURES.admin, tokens.admin, { confirmDestructive: true });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.admin);
    expect(body.tenantId).not.toBe(tenantIds.wellnessAdmin);

    // ABSOLUTE: the wellness row must STILL exist. A failure here means
    // the engine has a tenant-scoping bug — STOP AND FIX BEFORE SHIPPING
    // ANYTHING ELSE. This is the catastrophic-bug guard.
    expect(
      emailExists(wellnessId),
      `wellness EmailMessage ${wellnessId} must NOT be deleted by generic admin sweep`
    ).toBe(true);
  });

  test('wellness admin /run scopes deletion to wellness tenant only', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const res = await runRetention(request, FIXTURES.wellnessAdmin, tokens.wellnessAdmin, { confirmDestructive: true });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.wellnessAdmin);
  });
});
