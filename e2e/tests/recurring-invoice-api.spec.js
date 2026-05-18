// @ts-check
/**
 * Recurring Invoice Engine — gate spec for cron/recurringInvoiceEngine.js (G-9).
 *
 * Engine under test: backend/cron/recurringInvoiceEngine.js
 *   - cron `0 6 * * *` (daily 06:00 server time, disabled in CI by DISABLE_CRONS=1)
 *   - For every Invoice row with `isRecurring=true` AND `status != 'VOID'`
 *     AND `nextRecurDate <= now`, the engine:
 *       1. Generates a NEW Invoice (UNPAID) with the same amount, contactId,
 *          dealId, and `parentInvoiceId` pointing back at the source. The
 *          new dueDate is `now + recurFrequency` (monthly|quarterly|yearly).
 *       2. Advances the source's `nextRecurDate` by `recurFrequency` —
 *          OFF the existing nextRecurDate, not off `now`. So a missed-tick
 *          recovery still lands on the correct schedule.
 *       3. Writes an AuditLog row { action:'CREATE', entity:'Invoice',
 *          details:{source:'Recurring', parentInvoice, newInvoice, ...} }.
 *
 * Trigger endpoint (NEW — added in this PR alongside the spec):
 *   POST /api/billing/recurring/run
 *     middleware: verifyToken (global) → verifyRole(["ADMIN"])
 *     - 401/403 without token (verifyToken returns 403 "Access Denied")
 *     - 403 with token but role !== ADMIN
 *     - 200 with ADMIN — returns { success, tenantId, processed, generated, errors }
 *   The route inlines the engine's per-tenant body (the cron version is
 *   all-tenant; this is one-tenant) so the cron + manual paths agree on
 *   field semantics. Mirrors POST /api/forecasting/snapshot/run +
 *   /api/wellness/ops/run + /api/wellness/inventory/low-stock/run.
 *
 *   Tweak vs. engine: the route excludes status ∈ {'VOID','VOIDED'} (engine
 *   excludes only 'VOID'). The /void route writes 'VOIDED' (different
 *   spelling), so the route catches both — closing a real divergence
 *   between the cron and the void path. Filed as a contract-drift note in
 *   the agent's final report; not fixing the engine in this PR.
 *
 * Acceptance criteria covered (G-9 from docs/E2E_GAPS.md):
 *   1. nextRecurDate <= now → new Invoice row created (status=UNPAID,
 *      parentInvoiceId points at source).
 *   2. nextRecurDate > now (e.g. now+30d) → no new invoice on this run.
 *   3. After generating, source's nextRecurDate advances by the interval
 *      (monthly → +~30d, quarterly → +~90d). Verified via /api/billing/:id.
 *   4. Idempotency within interval — running /run twice in succession only
 *      generates ONE new invoice for the source (the second run sees
 *      nextRecurDate moved into the future, so the where-clause skips it).
 *   5. Voided source skipped — status='VOIDED' (or 'VOID') → engine skips.
 *   6. Tenant isolation — generic admin's /run does NOT process wellness
 *      tenant's recurring invoices. Critical: a leak here = generating
 *      invoices on the wrong tenant's behalf.
 *   7. RBAC: ADMIN → 200. MANAGER → 403. USER → 403.
 *   8. Auth: no token → 401/403; bogus bearer → 401/403.
 *   9. Self-clean — RUN_TAG-prefixed Contact rows are soft-deleted in
 *      afterAll (DELETE /api/contacts/:id sets deletedAt; cascades to
 *      child Invoice via onDelete:Cascade in schema). Generated children
 *      cascade with the contact, so RUN_TAG matches by parent prefix.
 *
 * Why direct DB for back-dating?
 *   The engine's where-clause is `nextRecurDate: { lte: now }`. The only
 *   API path to set isRecurring is `PUT /api/billing/:id/recurring`, which
 *   writes `nextRecurDate = now + interval` — i.e. ALWAYS in the future.
 *   We need it in the past to trigger generation. The global
 *   `stripDangerous` middleware deletes nothing on date columns, but
 *   neither billing.js nor any neighbour exposes a DELETE-then-back-date
 *   path. We shell a tiny Prisma snippet inside backend/ (mirrors the
 *   wellness-ops-api.spec.js + appointment-reminders-api.spec.js pattern).
 *
 * Test data hygiene:
 *   - RUN_TAG = `E2E_FLOW_RECINV_<ts>`. Contact.name carries the tag so
 *     global-teardown's NAME regex (`^E2E_FLOW_/`) matches.
 *   - Contact emails end in @example.test → also matches teardown EMAIL_REGEX.
 *   - DELETE /api/contacts/:id sets deletedAt (soft-delete), which keeps
 *     the row but breaks the active-data view; the teardown sweep then
 *     hard-removes by name regex on a later run. afterAll calls DELETE
 *     for defence in depth.
 *   - Generated child invoices have invoiceNum like 'INV-XXXXXX' (no
 *     tag), but they cascade-delete with their Contact (Invoice.contactId
 *     is a non-null FK with onDelete:Cascade), so cleanup is transitive.
 *
 * Test environment expectations:
 *   - BASE_URL defaults to http://127.0.0.1:5000 (local stack). CI sets
 *     BASE_URL=http://127.0.0.1:5000 (deploy.yml's matrix backend boot).
 *   - Login fixtures: admin@globussoft.com / manager@crm.com / user@crm.com
 *     (generic tenant) + admin@wellness.demo (wellness tenant).
 *   - Both tenants must be seeded (prisma/seed.js + prisma/seed-wellness.js).
 *
 * Pattern: clones e2e/tests/forecast-snapshot-api.spec.js (engine trigger
 * + tenant isolation + RBAC) and e2e/tests/wellness-ops-api.spec.js
 * (Prisma child-process for back-dating).
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const RUN_TAG = `E2E_FLOW_RECINV_${Date.now()}`;

// Force serial execution. Each /run aggregates ALL recurring invoices in
// the requesting tenant — if two tests race and both have a due fixture,
// the first's run consumes both. Serial keeps each test's expectations
// scoped to the fixture it just seeded.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  // Generic CRM ADMIN — drives /run 200 + invoice CRUD.
  admin: { email: 'admin@globussoft.com', password: 'password123' },
  // Generic CRM MANAGER — ADMIN-only route, must 403.
  manager: { email: 'manager@crm.com', password: 'password123' },
  // Generic CRM USER — must also 403.
  user: { email: 'user@crm.com', password: 'password123' },
  // Wellness ADMIN — different tenantId. Drives the tenant-isolation suite:
  // a generic /run must NEVER touch wellness Invoice rows (and vice-versa).
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
};

const tokens = {};
const tenantIds = {};
// Track every row we created so afterAll can clean up.
const createdContactIds = []; // (admin context)
const createdInvoiceIds = []; // source invoices we created
const createdWellnessContactIds = []; // (wellness context)
const createdWellnessInvoiceIds = []; // wellness source invoices

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

async function authPut(request, token, p, body) {
  return request.put(`${API}${p}`, {
    headers: authHeader(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

async function authDelete(request, token, p) {
  return request.delete(`${API}${p}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// ─── Direct DB helpers (back-date nextRecurDate) ────────────────────────
//
// /api/billing/:id/recurring writes nextRecurDate=now+interval — always
// future. We need it in the past to trigger the engine. Prisma has no
// stripDangerous-protected fields on Invoice for nextRecurDate, but no
// public route accepts a raw nextRecurDate either. Shell a tiny Prisma
// snippet inside backend/ where @prisma/client + DATABASE_URL are set up.

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
      try { await prisma.invoice.count(); process.stdout.write('OK'); }
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

function backdateNextRecur(invoiceId, isoDate) {
  return runPrismaScript(
    `await prisma.invoice.update({ where: { id: ${Number(invoiceId)} }, data: { nextRecurDate: new Date('${isoDate}') } }); return true;`
  );
}

function getInvoice(invoiceId) {
  return runPrismaScript(
    `const r = await prisma.invoice.findUnique({ where: { id: ${Number(invoiceId)} } }); return r;`
  );
}

function findChildInvoices(parentInvoiceId, tenantId) {
  return runPrismaScript(
    `const rows = await prisma.invoice.findMany({ where: { parentInvoiceId: ${Number(parentInvoiceId)}, tenantId: ${Number(tenantId)} } }); return rows;`
  );
}

function setInvoiceStatus(invoiceId, status) {
  return runPrismaScript(
    `await prisma.invoice.update({ where: { id: ${Number(invoiceId)} }, data: { status: ${JSON.stringify(status)} } }); return true;`
  );
}

// ─── Seed helpers ────────────────────────────────────────────────────────

function uniquePhone() {
  const tail = String(Math.floor(1000000000 + Math.random() * 9000000000)).slice(-10);
  return `9${tail.slice(0, 9)}`;
}

async function seedContact(request, token, label, bucket) {
  const stamp = Date.now() + Math.floor(Math.random() * 100000);
  const r = await authPost(request, token, '/contacts', {
    name: `${RUN_TAG} ${label}-${stamp}`,
    email: `e2e-recinv-${stamp}@example.test`,
    phone: uniquePhone(),
    status: 'Lead',
  });
  if (!r.ok()) {
    throw new Error(`seedContact (${label}): ${r.status()} ${await r.text()}`);
  }
  const c = await r.json();
  bucket.push(c.id);
  return c;
}

// Create an UNPAID invoice with isRecurring=true. We do it in two API calls:
//   1. POST /api/billing — creates the invoice (non-recurring).
//   2. PUT /:id/recurring — flips isRecurring + recurFrequency, writes
//      nextRecurDate=now+interval. We then back-date nextRecurDate via the
//      Prisma snippet for the test to take effect.
async function seedRecurringInvoice(request, token, contactId, opts = {}) {
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString();
  const cRes = await authPost(request, token, '/billing', {
    amount: opts.amount ?? 250,
    dueDate,
    contactId,
  });
  if (cRes.status() !== 201) {
    throw new Error(`seedRecurringInvoice POST: ${cRes.status()} ${await cRes.text()}`);
  }
  const inv = await cRes.json();
  const rRes = await authPut(request, token, `/billing/${inv.id}/recurring`, {
    isRecurring: true,
    recurFrequency: opts.recurFrequency || 'monthly',
  });
  if (!rRes.ok()) {
    throw new Error(`seedRecurringInvoice PUT: ${rRes.status()} ${await rRes.text()}`);
  }
  return await rRes.json();
}

async function runRecurring(request, token) {
  return authPost(request, token, '/billing/recurring/run', {});
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
  // Teardown order: void source invoices via /void (preserves audit trail);
  // soft-delete contacts (cascades on the demo; teardown regex hard-removes
  // residue on the next CI sweep). Generated child invoices share the
  // parent's contactId, so they cascade with the contact.
  if (tokens.admin) {
    for (const id of createdInvoiceIds) {
      await request.post(`${API}/billing/${id}/void`, {
        headers: authHeader(tokens.admin), data: {}, timeout: REQUEST_TIMEOUT,
      }).catch(() => { /* best-effort */ });
    }
    for (const id of createdContactIds) {
      await request.delete(`${API}/contacts/${id}`, {
        headers: authHeader(tokens.admin), timeout: REQUEST_TIMEOUT,
      }).catch(() => { /* best-effort */ });
    }
  }
  if (tokens.wellnessAdmin) {
    for (const id of createdWellnessInvoiceIds) {
      await request.post(`${API}/billing/${id}/void`, {
        headers: authHeader(tokens.wellnessAdmin), data: {}, timeout: REQUEST_TIMEOUT,
      }).catch(() => { /* best-effort */ });
    }
    for (const id of createdWellnessContactIds) {
      await request.delete(`${API}/contacts/${id}`, {
        headers: authHeader(tokens.wellnessAdmin), timeout: REQUEST_TIMEOUT,
      }).catch(() => { /* best-effort */ });
    }
  }
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('POST /api/billing/recurring/run — auth gate', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/billing/recurring/run`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('bogus bearer → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/billing/recurring/run`, {
      data: {},
      headers: { Authorization: 'Bearer not-a-real-jwt', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── RBAC gate ───────────────────────────────────────────────────────────

test.describe('POST /api/billing/recurring/run — RBAC gate', () => {
  test('MANAGER → 403', async ({ request }) => {
    test.skip(!tokens.manager, 'manager fixture (manager@crm.com) not seeded');
    const res = await runRecurring(request, tokens.manager);
    expect(res.status()).toBe(403);
  });

  test('USER → 403', async ({ request }) => {
    test.skip(!tokens.user, 'user fixture (user@crm.com) not seeded');
    const res = await runRecurring(request, tokens.user);
    expect(res.status()).toBe(403);
  });

  test('ADMIN → 200 with envelope { success, tenantId, processed, generated, errors }', async ({ request }) => {
    const res = await runRecurring(request, tokens.admin);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.tenantId).toBe('number');
    expect(typeof body.processed).toBe('number');
    expect(typeof body.generated).toBe('number');
    expect(Array.isArray(body.errors)).toBe(true);
  });
});

// ─── Engine semantics — windowing + advancement ──────────────────────────

test.describe('Recurring Invoice Engine — windowing', () => {
  test('nextRecurDate <= now → new Invoice generated, parentInvoiceId set', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await seedContact(request, tokens.admin, 'past-window', createdContactIds);
    const inv = await seedRecurringInvoice(request, tokens.admin, contact.id, { amount: 12345, recurFrequency: 'monthly' });
    createdInvoiceIds.push(inv.id);

    // Back-date nextRecurDate 1h ago → engine's `lte: now` matches.
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    expect(await backdateNextRecur(inv.id, past)).toBeTruthy();

    const before = await findChildInvoices(inv.id, inv.tenantId);
    const beforeCount = before.length;

    const res = await runRecurring(request, tokens.admin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.generated).toBeGreaterThanOrEqual(1);

    // Find the child generated by THIS run — query by parentInvoiceId.
    const after = await findChildInvoices(inv.id, inv.tenantId);
    expect(after.length, `child count grew by ≥1`).toBeGreaterThanOrEqual(beforeCount + 1);
    const child = after[after.length - 1];
    expect(child.amount).toBe(inv.amount);
    expect(child.contactId).toBe(inv.contactId);
    expect(child.parentInvoiceId).toBe(inv.id);
    expect(child.status).toBe('UNPAID');
    expect(child.tenantId).toBe(inv.tenantId);
    // Child invoice rows are not in createdInvoiceIds — they cascade-delete
    // with the contact (Invoice.contactId is non-null FK with onDelete:Cascade).
  });

  test('nextRecurDate > now (future) → no Invoice generated for that source', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await seedContact(request, tokens.admin, 'future-window', createdContactIds);
    const inv = await seedRecurringInvoice(request, tokens.admin, contact.id, { amount: 99, recurFrequency: 'monthly' });
    createdInvoiceIds.push(inv.id);

    // Push nextRecurDate 30d into the future. Engine's `lte: now` excludes it.
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    await backdateNextRecur(inv.id, future);

    const before = await findChildInvoices(inv.id, inv.tenantId);
    const beforeCount = before.length;

    await runRecurring(request, tokens.admin);

    const after = await findChildInvoices(inv.id, inv.tenantId);
    expect(after.length, 'future-window source must NOT generate child').toBe(beforeCount);
  });

  test('nextRecurDate advances by recurFrequency after generation', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await seedContact(request, tokens.admin, 'advancement', createdContactIds);
    const inv = await seedRecurringInvoice(request, tokens.admin, contact.id, { amount: 555, recurFrequency: 'monthly' });
    createdInvoiceIds.push(inv.id);

    // Set a known back-dated nextRecurDate so we can predict the advancement.
    // Pick exactly 2h ago. After /run, engine advances by addInterval(prev, 'monthly')
    // → exactly +1 month from the BACK-DATED value (i.e. ~2h ago + 1mo).
    const backDate = new Date(Date.now() - 2 * 3600 * 1000);
    await backdateNextRecur(inv.id, backDate.toISOString());

    await runRecurring(request, tokens.admin);

    const updated = await getInvoice(inv.id);
    expect(updated, 'source invoice must still exist').toBeTruthy();
    const newNext = new Date(updated.nextRecurDate);
    // Expect: newNext ≈ backDate + 1 month (engine uses Date.setMonth(+1)).
    const expected = new Date(backDate);
    expected.setMonth(expected.getMonth() + 1);
    // Allow a small wobble (the engine and the route use the same setMonth
    // semantics, so the result is exact — but JS month arithmetic snaps
    // around month-end edges; 5s of slack is plenty of noise tolerance).
    const driftMs = Math.abs(newNext.getTime() - expected.getTime());
    expect(driftMs, `nextRecurDate drift ${driftMs}ms (expected ~0 for monthly setMonth)`).toBeLessThan(5_000);
  });
});

// ─── Idempotency within interval ─────────────────────────────────────────

test.describe('Recurring Invoice Engine — idempotency', () => {
  test('two consecutive runs generate ONE invoice for a single past-window source', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await seedContact(request, tokens.admin, 'idempotent', createdContactIds);
    const inv = await seedRecurringInvoice(request, tokens.admin, contact.id, { amount: 1010, recurFrequency: 'monthly' });
    createdInvoiceIds.push(inv.id);

    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await backdateNextRecur(inv.id, past);

    const before = await findChildInvoices(inv.id, inv.tenantId);
    const beforeCount = before.length;

    // First tick — generates ONE child + advances nextRecurDate +1mo.
    await runRecurring(request, tokens.admin);
    const after1 = await findChildInvoices(inv.id, inv.tenantId);
    expect(after1.length).toBe(beforeCount + 1);

    // Second tick — nextRecurDate is now ~1 month in the future (since we
    // back-dated to 1h ago, advanced +1mo lands ~1 month from now).
    // Engine's `lte: now` excludes → NO new child.
    await runRecurring(request, tokens.admin);
    const after2 = await findChildInvoices(inv.id, inv.tenantId);
    expect(after2.length, 'second tick must NOT add another child for same source').toBe(after1.length);
  });
});

// ─── Voided / paused source skipped ──────────────────────────────────────

test.describe('Recurring Invoice Engine — voided source exemption', () => {
  test('VOIDED source with past nextRecurDate → NOT regenerated', async ({ request }) => {
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    const contact = await seedContact(request, tokens.admin, 'voided', createdContactIds);
    const inv = await seedRecurringInvoice(request, tokens.admin, contact.id, { amount: 800, recurFrequency: 'monthly' });
    createdInvoiceIds.push(inv.id);

    // Set due-window to past, then VOID the source.
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await backdateNextRecur(inv.id, past);
    // Use the public POST /:id/void endpoint — it writes status='VOIDED'.
    const voidRes = await authPost(request, tokens.admin, `/billing/${inv.id}/void`, {});
    expect(voidRes.status()).toBe(200);

    const before = await findChildInvoices(inv.id, inv.tenantId);
    const beforeCount = before.length;

    await runRecurring(request, tokens.admin);

    const after = await findChildInvoices(inv.id, inv.tenantId);
    expect(after.length, 'voided source must NOT generate child invoice').toBe(beforeCount);
  });
});

// ─── Tenant isolation ────────────────────────────────────────────────────

test.describe('Recurring Invoice Engine — tenant isolation', () => {
  test('generic admin /run does NOT process wellness-tenant recurring invoices', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!dbAvailable(), 'Prisma client unavailable in backend/ — back-dating impossible');

    // Seed a past-due recurring invoice on the WELLNESS tenant.
    const contact = await seedContact(request, tokens.wellnessAdmin, 'wellness-iso', createdWellnessContactIds);
    const inv = await seedRecurringInvoice(request, tokens.wellnessAdmin, contact.id, { amount: 7777, recurFrequency: 'monthly' });
    createdWellnessInvoiceIds.push(inv.id);

    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await backdateNextRecur(inv.id, past);

    const before = await findChildInvoices(inv.id, inv.tenantId);
    const beforeCount = before.length;

    // GENERIC admin runs the engine. Engine query is `where: { tenantId:
    // req.user.tenantId }` — wellness tenant must NOT be touched.
    const res = await runRecurring(request, tokens.admin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.admin);
    expect(body.tenantId).not.toBe(tenantIds.wellnessAdmin);

    // Wellness invoice must STILL be due (no child created for it).
    const after = await findChildInvoices(inv.id, inv.tenantId);
    expect(
      after.length,
      'wellness recurring invoice must NOT be processed by generic /run'
    ).toBe(beforeCount);

    // Sanity: the wellness source's nextRecurDate also still points at the
    // back-dated past — generic /run did not advance it.
    const wellnessSource = await getInvoice(inv.id);
    const wnxt = new Date(wellnessSource.nextRecurDate);
    expect(wnxt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('wellness admin /run scopes Invoice generation to wellness tenant only', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const res = await runRecurring(request, tokens.wellnessAdmin);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantIds.wellnessAdmin);
  });
});
