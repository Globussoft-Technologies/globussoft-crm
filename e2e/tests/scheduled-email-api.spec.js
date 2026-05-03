// @ts-check
/**
 * Scheduled Email Engine — gate spec for cron/scheduledEmailEngine.js (G-10).
 *
 * Engine under test: backend/cron/scheduledEmailEngine.js
 *   - cron `* * * * *` (every minute, disabled in CI by DISABLE_CRONS=1)
 *   - For every ScheduledEmail row with status='PENDING' AND
 *     scheduledFor <= now, the engine:
 *       1. Creates an EmailMessage row (direction=OUTBOUND, read=true,
 *          tenantId inherited from the source row).
 *       2. Creates an EmailTracking row (type='open') with a UUID
 *          trackingId that's embedded in the body as a 1×1 pixel <img>.
 *       3. Calls Mailgun (POST /v3/<domain>/messages). When MAILGUN_API_KEY
 *          is unset (CI default) the helper returns
 *          { sent:false, reason:'no_api_key' }.
 *       4. On send success → ScheduledEmail.status flips to 'SENT' (sentAt
 *          stamped, errorMessage cleared).
 *          On send failure → status flips to 'FAILED' (errorMessage set
 *          to result.reason).
 *   - take:50 batch limit per tick.
 *
 * Trigger endpoint (NEW — added in this PR alongside the spec):
 *   POST /api/email/scheduled/run
 *     middleware: verifyToken (global) → verifyRole(["ADMIN"])
 *     - 401/403 without token (verifyToken returns 403 "Access Denied")
 *     - 403 with token but role !== ADMIN
 *     - 200 with ADMIN — returns { success, tenantId, processed, sent, failed, errors }
 *   The route lives on routes/email.js (mounted at /api/email/) — placed
 *   there rather than routes/email_scheduling.js (mounted at
 *   /api/email-scheduling) because the requested URL is /api/email/scheduled/run.
 *   Route inlines the engine's per-tenant body (engine sweeps all tenants).
 *   Mirrors POST /api/billing/recurring/run + /api/forecasting/snapshot/run +
 *   /api/wellness/ops/run + /api/wellness/inventory/low-stock/run.
 *
 * Acceptance criteria covered (G-10 from docs/E2E_GAPS.md):
 *   1. PENDING + scheduledFor<=now → status flips, EmailMessage row created.
 *      In CI (no MAILGUN_API_KEY) the dispatch returns no_api_key, so the
 *      row flips to FAILED — but that's still proof the state machine
 *      moved. The EmailMessage row IS created BEFORE the Mailgun call,
 *      so it persists regardless of send outcome.
 *   2. Future-scheduled rows untouched (scheduledFor > now → engine skips).
 *   3. Already-SENT rows not re-processed (PENDING-only filter).
 *   4. Already-FAILED rows not re-processed (PENDING-only filter — the
 *      engine doesn't auto-retry; reschedule is a separate concern).
 *   5. Tenant isolation — generic admin's /run does NOT process wellness
 *      tenant's scheduled emails.
 *   6. RBAC: ADMIN → 200. MANAGER → 403. USER → 403.
 *   7. Auth: no token → 401/403; bogus bearer → 401/403.
 *   8. Self-clean: RUN_TAG-prefixed ScheduledEmail rows + their EmailMessage
 *      children. afterAll hard-deletes by id (DELETE /api/email-scheduling/:id
 *      removes ScheduledEmail; EmailMessage rows have no DELETE route, so
 *      the spec deletes them via Prisma child-process).
 *
 * Why direct DB for back-dating?
 *   The POST /api/email-scheduling endpoint validates `scheduledFor must
 *   be in the future` (rejects with 400). The engine's where-clause
 *   requires `scheduledFor <= now`. To trigger the engine we POST with a
 *   tiny future delta (e.g. now+5s) and then back-date via a Prisma
 *   child-process snippet. Mirrors wellness-ops-api.spec.js +
 *   recurring-invoice-api.spec.js.
 *
 * Test data hygiene:
 *   - RUN_TAG = `E2E_FLOW_SCHEDEMAIL_<ts>`. Subject and body carry the
 *     tag. ScheduledEmail rows have NO `name` field that the global
 *     teardown's NAME regex matches, so afterAll hard-deletes by id via
 *     DELETE /api/email-scheduling/:id (which preserves Prisma cascades
 *     on EmailTracking but does NOT cascade EmailMessage). EmailMessage
 *     rows are scrubbed via the Prisma child-process by `to=` filter on
 *     the unique e2e@example.test recipient.
 *   - In CI on the ephemeral DB this leaves zero residue. On the demo
 *     box's persistent DB a stale EmailMessage with subject="E2E_FLOW_..."
 *     is inert noise — surfaces only on the inbox view, never affects
 *     other tests.
 *
 * Test environment expectations:
 *   - BASE_URL defaults to http://127.0.0.1:5000 (local stack). CI sets
 *     BASE_URL=http://127.0.0.1:5000 (deploy.yml's matrix backend boot).
 *   - MAILGUN_API_KEY may or may not be set; both branches of the engine
 *     are tested. If KEY is set, the row flips to SENT; if not, FAILED.
 *     We assert the post-state of the row matches one of those two
 *     statuses, not which one specifically.
 *   - Login fixtures: admin@globussoft.com / manager@crm.com / user@crm.com
 *     (generic) + admin@wellness.demo (wellness).
 *   - Both tenants must be seeded (prisma/seed.js + prisma/seed-wellness.js).
 *
 * Pattern: clones e2e/tests/recurring-invoice-api.spec.js (just landed)
 * with engine + back-dated DB column + tenant isolation + RBAC.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;

const RUN_TAG = `E2E_FLOW_SCHEDEMAIL_${Date.now()}`;

// Force serial. The engine /run sweeps ALL PENDING rows in a tenant —
// parallel tests would consume each other's fixtures.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  admin: { email: 'admin@globussoft.com', password: 'password123' },
  manager: { email: 'manager@crm.com', password: 'password123' },
  user: { email: 'user@crm.com', password: 'password123' },
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
};

const tokens = {};
const tenantIds = {};
const createdScheduledIds = []; // generic admin context
const createdWellnessScheduledIds = []; // wellness context
// Track unique recipient emails so afterAll can scrub EmailMessage children.
const createdRecipients = new Set();

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
        return { token: j.token, tenantId: j.tenant && j.tenant.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, tenantId: null };
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

// ─── Direct DB helpers (back-date scheduledFor) ─────────────────────────
//
// Same access pattern as recurring-invoice-api.spec.js — shell a tiny
// Prisma snippet against the working DATABASE_URL.

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
      try { await prisma.scheduledEmail.count(); process.stdout.write('OK'); }
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

function backdateScheduledEmail(id, isoDate) {
  return runPrismaScript(
    `await prisma.scheduledEmail.update({ where: { id: ${Number(id)} }, data: { scheduledFor: new Date('${isoDate}') } }); return true;`
  );
}

function getScheduledEmail(id) {
  return runPrismaScript(
    `const r = await prisma.scheduledEmail.findUnique({ where: { id: ${Number(id)} } }); return r;`
  );
}

function setScheduledEmailStatus(id, status) {
  return runPrismaScript(
    `await prisma.scheduledEmail.update({ where: { id: ${Number(id)} }, data: { status: ${JSON.stringify(status)} } }); return true;`
  );
}

function findEmailMessagesByRecipient(to, tenantId) {
  return runPrismaScript(
    `const rows = await prisma.emailMessage.findMany({ where: { to: ${JSON.stringify(to)}, tenantId: ${Number(tenantId)} } }); return rows;`
  );
}

function deleteEmailMessagesByRecipients(emails) {
  if (!emails || emails.length === 0) return 0;
  return runPrismaScript(
    `const r = await prisma.emailMessage.deleteMany({ where: { to: { in: ${JSON.stringify(emails)} } } }); return r.count;`
  );
}

// ─── Seed helpers ────────────────────────────────────────────────────────

// Create a PENDING ScheduledEmail. The /api/email-scheduling POST
// validator rejects scheduledFor<=now ("must be in the future"), so we
// pass a tiny future delta and (optionally) back-date via Prisma after.
async function seedScheduledEmail(request, token, label, opts = {}) {
  const stamp = Date.now() + Math.floor(Math.random() * 100000);
  const recipient = `e2e-schedemail-${stamp}@example.test`;
  createdRecipients.add(recipient);
  const futureMs = Date.now() + 60_000; // +60s — well clear of the validator's tripwire
  const r = await request.post(`${API}/email-scheduling`, {
    headers: authHeader(token),
    data: {
      to: recipient,
      subject: `${RUN_TAG} ${label}`,
      body: `${RUN_TAG} body — ${label}`,
      scheduledFor: new Date(futureMs).toISOString(),
    },
    timeout: REQUEST_TIMEOUT,
  });
  if (r.status() !== 201) {
    throw new Error(`seedScheduledEmail: ${r.status()} ${await r.text()}`);
  }
  const row = await r.json();
  return row;
}

async function runScheduled(request, token) {
  return authPost(request, token, '/email/scheduled/run', {});
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

test.beforeAll(async ({ request }) => {
  for (const [k, f] of Object.entries(FIXTURES)) {
    const r = await login(request, f);
    if (r.token) {
      tokens[k] = r.token;
      tenantIds[k] = r.tenantId;
    }
  }
  expect(tokens.admin, 'generic admin token must be available').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  // ScheduledEmail cleanup via DELETE /api/email-scheduling/:id (only
  // works on rows still in the original tenant).
  if (tokens.admin) {
    for (const id of createdScheduledIds) {
      await request.delete(`${API}/email-scheduling/${id}`, {
        headers: authHeader(tokens.admin), timeout: REQUEST_TIMEOUT,
      }).catch(() => { /* best-effort */ });
    }
  }
  if (tokens.wellnessAdmin) {
    for (const id of createdWellnessScheduledIds) {
      await request.delete(`${API}/email-scheduling/${id}`, {
        headers: authHeader(tokens.wellnessAdmin), timeout: REQUEST_TIMEOUT,
      }).catch(() => { /* best-effort */ });
    }
  }
  // EmailMessage rows have no DELETE API surface; scrub by recipient via
  // Prisma. Best-effort — non-fatal if unavailable.
  if (dbAvailable() && createdRecipients.size > 0) {
    try {
      deleteEmailMessagesByRecipients([...createdRecipients]);
    } catch (_e) { /* best-effort */ }
  }
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('POST /api/email/scheduled/run — auth gate', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/email/scheduled/run`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('bogus bearer → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/email/scheduled/run`, {
      data: {},
      headers: { Authorization: 'Bearer not-a-real-jwt', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── RBAC gate ───────────────────────────────────────────────────────────

test.describe('POST /api/email/scheduled/run — RBAC gate', () => {
  test('MANAGER → 403', async ({ request }) => {
    test.skip(!tokens.manager, 'manager fixture (manager@crm.com) not seeded');
    const res = await runScheduled(request, tokens.manager);
    expect(res.status()).toBe(403);
  });

  test('USER → 403', async ({ request }) => {
    test.skip(!tokens.user, 'user fixture (user@crm.com) not seeded');
    const res = await runScheduled(request, tokens.user);
    expect(res.status()).toBe(403);
  });

  test('ADMIN → 200 with envelope { success, tenantId, processed, sent, failed, errors }', async ({ request }) => {
    const res = await runScheduled(request, tokens.admin);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.tenantId).toBe('number');
    expect(typeof body.processed).toBe('number');
    expect(typeof body.sent).toBe('number');
    expect(typeof body.failed).toBe('number');
    expect(Array.isArray(body.errors)).toBe(true);
  });
});

// ─── Engine semantics — windowing + state machine ────────────────────────

test.describe('Scheduled Email Engine — windowing + status transitions', () => {
  test('PENDING + scheduledFor<=now → status flips, EmailMessage created', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const row = await seedScheduledEmail(request, tokens.admin, 'happy-past');
    createdScheduledIds.push(row.id);

    // Back-date scheduledFor 1m ago → engine's `lte: now` matches.
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(await backdateScheduledEmail(row.id, past)).toBeTruthy();

    const res = await runScheduled(request, tokens.admin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // At least one transition (sent OR failed depending on Mailgun key).
    expect(body.processed).toBeGreaterThanOrEqual(1);
    expect(body.sent + body.failed).toBeGreaterThanOrEqual(1);

    const after = await getScheduledEmail(row.id);
    expect(after, 'row still exists').toBeTruthy();
    // Either branch of the engine is acceptable; the spec asserts the
    // STATE MACHINE moved, not which specific outcome.
    expect(['SENT', 'FAILED']).toContain(after.status);
    if (after.status === 'SENT') {
      expect(after.sentAt, 'sentAt stamped on success').toBeTruthy();
    } else {
      expect(after.errorMessage, 'errorMessage populated on failure').toBeTruthy();
    }

    // Sanity: an EmailMessage row was created for the recipient
    // BEFORE the Mailgun call, so it persists either way.
    const msgs = await findEmailMessagesByRecipient(row.to, body.tenantId);
    expect(msgs.length, 'EmailMessage row persisted').toBeGreaterThanOrEqual(1);
    expect(msgs[0].direction).toBe('OUTBOUND');
    expect(msgs[0].subject).toContain(RUN_TAG);
  });

  test('PENDING + scheduledFor>now → unchanged (engine skips)', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const row = await seedScheduledEmail(request, tokens.admin, 'future');
    createdScheduledIds.push(row.id);

    // Push scheduledFor far into the future. (No backdate needed; the
    // seed itself created with +60s. Push it further so the test isn't
    // racy with /run's wall clock.)
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await backdateScheduledEmail(row.id, future);

    await runScheduled(request, tokens.admin);

    const after = await getScheduledEmail(row.id);
    expect(after.status, 'future PENDING must stay PENDING').toBe('PENDING');
    expect(after.sentAt, 'no sentAt on a skipped row').toBeNull();
  });

  test('Already-SENT → not re-processed on next tick', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const row = await seedScheduledEmail(request, tokens.admin, 'already-sent');
    createdScheduledIds.push(row.id);

    // Force status to SENT directly + back-date scheduledFor (so even if
    // we look at the where clause, the only thing that excludes this is
    // the status filter, NOT the date — proving the status filter holds).
    await setScheduledEmailStatus(row.id, 'SENT');
    await backdateScheduledEmail(row.id, new Date(Date.now() - 60_000).toISOString());

    const before = await getScheduledEmail(row.id);
    expect(before.status).toBe('SENT');
    const beforeSentAt = before.sentAt;

    await runScheduled(request, tokens.admin);

    const after = await getScheduledEmail(row.id);
    expect(after.status, 'SENT row must stay SENT').toBe('SENT');
    // sentAt must NOT be re-stamped — the engine's WHERE filter must
    // exclude SENT before reaching the update branch.
    expect(after.sentAt).toEqual(beforeSentAt);
  });

  test('Already-FAILED → not re-processed (no auto-retry)', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const row = await seedScheduledEmail(request, tokens.admin, 'already-failed');
    createdScheduledIds.push(row.id);

    await setScheduledEmailStatus(row.id, 'FAILED');
    await backdateScheduledEmail(row.id, new Date(Date.now() - 60_000).toISOString());
    // Stamp a known errorMessage so we can prove the run did not
    // touch this row (errorMessage would be overwritten on a retry).
    runPrismaScript(
      `await prisma.scheduledEmail.update({ where: { id: ${Number(row.id)} }, data: { errorMessage: 'sentinel-not-touched' } }); return true;`
    );

    await runScheduled(request, tokens.admin);

    const after = await getScheduledEmail(row.id);
    expect(after.status, 'FAILED row stays FAILED (no auto-retry)').toBe('FAILED');
    expect(after.errorMessage).toBe('sentinel-not-touched');
  });
});

// ─── Tenant isolation ────────────────────────────────────────────────────

test.describe('Scheduled Email Engine — tenant isolation', () => {
  test('generic admin /run does NOT process wellness-tenant scheduled emails', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    // Seed a past-due PENDING email on the WELLNESS tenant.
    const wRow = await seedScheduledEmail(request, tokens.wellnessAdmin, 'wellness-iso');
    createdWellnessScheduledIds.push(wRow.id);
    const past = new Date(Date.now() - 60_000).toISOString();
    await backdateScheduledEmail(wRow.id, past);

    // Verify it's in PENDING and dated in past pre-run.
    const before = await getScheduledEmail(wRow.id);
    expect(before.status).toBe('PENDING');

    // GENERIC admin runs the engine. Engine query is `where: { tenantId:
    // req.user.tenantId }` — wellness tenant must NOT be touched.
    const res = await runScheduled(request, tokens.admin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.admin);
    expect(body.tenantId).not.toBe(tenantIds.wellnessAdmin);

    // Wellness email must STILL be PENDING (not processed by generic).
    const after = await getScheduledEmail(wRow.id);
    expect(
      after.status,
      'wellness PENDING email must NOT be processed by generic admin'
    ).toBe('PENDING');
  });

  test('wellness admin /run scopes processing to wellness tenant only', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const res = await runScheduled(request, tokens.wellnessAdmin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.wellnessAdmin);
  });
});
