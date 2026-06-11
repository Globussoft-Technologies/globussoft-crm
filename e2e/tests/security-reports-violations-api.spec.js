// @ts-check
/**
 * Security violations gate — S121 ADMIN-only CSP-violation observability surface.
 *
 * Route pinned: GET /api/security/violations
 * Backed by backend/routes/security_reports.js (shipped slice S121).
 *
 * Purpose of the route
 * ────────────────────
 * Developer-page "Security" tab go/no-go signal for flipping the
 * CSP_ENFORCE env var from Report-Only → enforce. The route reads from
 * AuditLog rows where entity='CSPViolation' (written by the EXISTING
 * /api/csp/report public ingest in backend/routes/csp.js, slice 2 of
 * #917) and returns a `clean24h` boolean — the operator-facing badge.
 *
 *   clean24h = TRUE  → zero CSPViolation rows in the last 24h AND the
 *                       requested ?since= window covers ≥ 24h. Safe to flip.
 *   clean24h = FALSE → at least one CSPViolation row in window, OR the
 *                       ?since= window is narrower than 24h (operator
 *                       hasn't asked the right question yet).
 *
 * Contract pinned by this spec (see backend/test/routes/security_reports.test.js
 * for the matching vitest contract):
 *   - 401/403 without auth token
 *   - 403 with USER role
 *   - 403 with MANAGER role
 *   - 200 with ADMIN, envelope = { violations, total, sinceIso, clean24h }
 *   - Default ?since resolves to now-24h
 *   - Explicit ?since=<ISO> is honoured
 *   - ?limit=N is clamped at 500 (default 100)
 *   - clean24h=true when zero rows AND window covers ≥ 24h
 *   - clean24h=false when ≥ 1 row exists in the window
 *   - clean24h=false on a narrow window (e.g. ?since=1h-ago) even if zero
 *     rows — the route specifically does NOT signal "safe to enforce" on
 *     a too-narrow lookback
 *   - Tenant scoping: a CSPViolation row seeded against tenant B is NOT
 *     visible to tenant A's ADMIN
 *
 * Why a Prisma seed (not the public POST /api/csp/report)
 * ───────────────────────────────────────────────────────
 * The public ingest endpoint resolves tenantId from the Host header's
 * subdomain — `127.0.0.1` and `localhost` do NOT match either seeded
 * tenant slug, so a POST through it lands with tenantId=null. We need
 * deterministic tenant-attached rows to validate tenant isolation and the
 * clean24h matrix. Same Prisma child-process pattern as retention-api,
 * recurring-invoice-api, scheduled-email-api, wellness-ops-api.
 *
 * Local-stack-only Prisma-seeded tests
 * ────────────────────────────────────
 * The Prisma seed path requires:
 *   (a) BASE_URL points at a backend that shares the filesystem (we
 *       spawn a child node process under backend/), AND
 *   (b) Prisma client is installed in backend/node_modules
 * Both are true for the per-push api_tests gate (BASE_URL=127.0.0.1:5000,
 * a fresh local stack with seed). NEITHER is true for e2e-full's release-
 * validation run against crm.globusdemos.com — different machine. Those
 * tests gracefully skip via dbAvailable() probe. The auth-gate + envelope-
 * shape tests still pin contract cross-machine.
 *
 * Test data hygiene
 * ─────────────────
 *   - Each CSPViolation row's `details` JSON includes the RUN_TAG so
 *     afterAll can find + delete OUR seeded rows without disturbing
 *     anything the demo monitor / cron / hygiene engines wrote.
 *   - RUN_TAG format conforms to e2e/test-data-patterns.js's E2E_FLOW_
 *     prefix, with a `_teardown_` fallback marker so the global scrub
 *     catches any row we miss.
 *
 * Run: cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *      npx playwright test --project=chromium tests/security-reports-violations-api.spec.js
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const ROUTE = '/api/security/violations';

const RUN_TAG = `E2E_FLOW_SECVIO_${Date.now()}`;

// Serial — multiple Prisma-seeded rows on a small window; parallel
// per-test seeds would interleave their visibility windows in racey ways.
test.describe.configure({ mode: 'serial' });

// Login fixtures
const FIXTURES = {
  admin: { email: 'admin@globussoft.com', password: 'password123' },
  manager: { email: 'manager@crm.com', password: 'password123' },
  user: { email: 'user@crm.com', password: 'password123' },
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
};

const tokens = {};
const tenantIds = {};
const userIds = {};

// Track every AuditLog id we created so afterAll can remove exactly our rows.
const seededAuditIds = [];

// ─── HTTP helpers ─────────────────────────────────────────────────────────

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
          // JWT key is userId — keep both shapes in case the /login envelope
          // gains a different alias in future.
          userId: (j.user && (j.user.userId || j.user.id)) || null,
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

async function authGet(request, token, p) {
  return request.get(`${BASE_URL}${p}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// ─── Direct DB helpers (Prisma seed pattern, mirrors retention-api) ──────

const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'backend');
let cachedDbUrl = undefined;

function candidateDbUrls() {
  const list = [];
  if (process.env.DATABASE_URL) list.push(process.env.DATABASE_URL);
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
  const wrapped = `
    (async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(url)} } } });
      try { await prisma.auditLog.count(); process.stdout.write('OK'); }
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

// Seed an AuditLog row with entity='CSPViolation' on a given tenant.
// `details` carries the RUN_TAG so cleanup can find OUR rows back, and
// the `_teardown_` marker is embedded as defence-in-depth for the global
// scrub. createdAtIso lets us back-date or forward-date rows for the
// narrow-window / out-of-window tests.
function seedCspViolation(tenantId, marker, createdAtIso) {
  const details = JSON.stringify({
    runTag: RUN_TAG,
    marker,
    _teardown_: true,
    note: 'security-reports-violations-api spec seed',
  });
  return runPrismaScript(
    `const r = await prisma.auditLog.create({ data: {
       tenantId: ${Number(tenantId)},
       entity: 'CSPViolation',
       action: 'REPORT',
       details: ${JSON.stringify(details)},
       createdAt: new Date(${JSON.stringify(createdAtIso)}),
     } });
     return r.id;`
  );
}

function deleteAuditIds(ids) {
  if (!ids || ids.length === 0) return 0;
  return runPrismaScript(
    `const r = await prisma.auditLog.deleteMany({ where: { id: { in: ${JSON.stringify(ids)} } } }); return r.count;`
  );
}

// Best-effort scrub of any CSPViolation row whose details contains the
// RUN_TAG — catches anything we mis-tracked.
function scrubByRunTag() {
  return runPrismaScript(
    `const r = await prisma.auditLog.deleteMany({
       where: {
         entity: 'CSPViolation',
         details: { contains: ${JSON.stringify(RUN_TAG)} },
       },
     });
     return r.count;`
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────

test.beforeAll(async ({ request }) => {
  for (const [k, fix] of Object.entries(FIXTURES)) {
    const r = await login(request, fix);
    tokens[k] = r.token;
    tenantIds[k] = r.tenantId;
    userIds[k] = r.userId;
  }
});

test.afterAll(async () => {
  if (!dbAvailable()) return;
  try {
    if (seededAuditIds.length > 0) deleteAuditIds(seededAuditIds);
    // Defence-in-depth: anything tagged with our RUN_TAG that we mis-tracked.
    scrubByRunTag();
  } catch (_e) {
    // Cleanup is best-effort. The _teardown_ marker in `details` lets
    // demo-hygiene + the global scrub catch any leftover.
  }
});

// ─── Auth gates (run cross-machine — no Prisma seed needed) ──────────────

test.describe('GET /api/security/violations — auth + RBAC gates', () => {
  test('no token → 401 or 403', async ({ request }) => {
    const r = await request.get(`${BASE_URL}${ROUTE}`, {
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test('USER role → 403 RBAC_DENIED', async ({ request }) => {
    test.skip(!tokens.user, 'user@crm.com fixture not seeded');
    const r = await authGet(request, tokens.user, ROUTE);
    expect(r.status()).toBe(403);
    const body = await r.json().catch(() => ({}));
    if (body.code) expect(body.code).toBe('RBAC_DENIED');
  });

  test('MANAGER role → 403 RBAC_DENIED (admin-only endpoint)', async ({ request }) => {
    test.skip(!tokens.manager, 'manager@crm.com fixture not seeded');
    const r = await authGet(request, tokens.manager, ROUTE);
    expect(r.status()).toBe(403);
  });
});

// ─── Envelope shape (runs cross-machine — pure read against existing demo data) ──

test.describe('GET /api/security/violations — envelope shape', () => {
  test('ADMIN happy path returns { violations, total, sinceIso, clean24h }', async ({ request }) => {
    test.skip(!tokens.admin, 'admin@globussoft.com fixture not seeded');
    const r = await authGet(request, tokens.admin, ROUTE);
    expect(r.status(), `body: ${await r.text().catch(() => '<no body>')}`).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      violations: expect.any(Array),
      total: expect.any(Number),
      sinceIso: expect.any(String),
      clean24h: expect.any(Boolean),
    });
    // sinceIso must be a parseable ISO string
    expect(Number.isFinite(new Date(body.sinceIso).getTime())).toBe(true);
    // total mirrors violations.length (newest-first, capped by limit)
    expect(body.total).toBe(body.violations.length);
  });

  test('default ?since resolves to ~24h ago', async ({ request }) => {
    test.skip(!tokens.admin, 'admin not seeded');
    const before = Date.now();
    const r = await authGet(request, tokens.admin, ROUTE);
    expect(r.status()).toBe(200);
    const body = await r.json();
    const sinceMs = new Date(body.sinceIso).getTime();
    const ageMs = before - sinceMs;
    // The route uses now - 24h at handler-entry time. Allow ±10s slack
    // for network + clock skew between this test process and the backend.
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    expect(ageMs).toBeGreaterThanOrEqual(TWENTY_FOUR_HOURS - 10_000);
    expect(ageMs).toBeLessThanOrEqual(TWENTY_FOUR_HOURS + 10_000);
  });

  test('explicit ?since=<ISO> is honoured', async ({ request }) => {
    test.skip(!tokens.admin, 'admin not seeded');
    const customSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = await authGet(
      request,
      tokens.admin,
      `${ROUTE}?since=${encodeURIComponent(customSince)}`,
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.sinceIso).toBe(customSince);
  });

  test('?limit=N is honoured and clamped at 500', async ({ request }) => {
    test.skip(!tokens.admin, 'admin not seeded');
    // 9999 → clamped to 500 — response shape doesn't include the effective
    // limit, so we can only assert via total ≤ 500 (the route's findMany
    // take clause). Demo may have <500 rows, which is fine — the assertion
    // is "no row above 500 ever shows up regardless of input".
    const r = await authGet(request, tokens.admin, `${ROUTE}?limit=9999`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.violations.length).toBeLessThanOrEqual(500);
  });
});

// ─── clean24h flag matrix + tenant scope (Prisma seed required) ──────────

test.describe('GET /api/security/violations — clean24h matrix + tenant scope', () => {
  test('clean24h=true when zero CSPViolation rows in the 24h window', async ({ request }) => {
    test.skip(!tokens.admin, 'admin not seeded');
    test.skip(!dbAvailable(), 'Prisma DB not reachable — local-stack-only assertion');
    test.skip(!tenantIds.admin, 'admin tenantId not resolved');

    // Pre-clean: remove any of OUR seeded rows on the generic tenant first
    // so the count starts at 0 for this assertion. We can't promise zero
    // CSPViolation rows in general (background cron / other tests), so
    // this test asserts conditionally — see the matching false-case test
    // below which is the strict assertion.
    scrubByRunTag();

    const r = await authGet(request, tokens.admin, ROUTE);
    expect(r.status()).toBe(200);
    const body = await r.json();
    // If the tenant has zero rows in window, clean24h must be true.
    // If background activity wrote a row, we accept either — the strict
    // version of this assertion is the next test (seed then assert false).
    if (body.total === 0) {
      expect(body.clean24h).toBe(true);
    }
  });

  test('clean24h=false when ≥ 1 CSPViolation row exists in window', async ({ request }) => {
    test.skip(!tokens.admin, 'admin not seeded');
    test.skip(!dbAvailable(), 'Prisma DB not reachable');
    test.skip(!tenantIds.admin, 'admin tenantId not resolved');

    // Seed a row dated 1 hour ago on the generic tenant — well inside the
    // default 24h window.
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const seededId = seedCspViolation(
      tenantIds.admin,
      'in-window-recent',
      recentIso,
    );
    seededAuditIds.push(seededId);

    const r = await authGet(request, tokens.admin, ROUTE);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.clean24h).toBe(false);

    // Sanity: our seeded row should be reachable in the array.
    const ourRow = body.violations.find((v) => v.id === seededId);
    expect(ourRow, 'seeded row should appear in /violations response').toBeTruthy();
    expect(ourRow.entity).toBe('CSPViolation');
  });

  test('clean24h=false on narrow ?since= window (< 24h) even with zero rows', async ({ request }) => {
    test.skip(!tokens.admin, 'admin not seeded');

    // Ask only for the last 1 hour — even if zero rows show up, the
    // operator hasn't proven 24h-clean. clean24h must stay false to
    // prevent a premature CSP_ENFORCE flip.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = await authGet(
      request,
      tokens.admin,
      `${ROUTE}?since=${encodeURIComponent(oneHourAgo)}`,
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    // Regardless of row count, narrow window means clean24h is false.
    expect(body.clean24h).toBe(false);
  });

  test('tenant scoping: CSPViolation on tenant B not visible to tenant A admin', async ({ request }) => {
    test.skip(!tokens.admin, 'generic admin not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin not seeded');
    test.skip(!dbAvailable(), 'Prisma DB not reachable');
    test.skip(!tenantIds.admin || !tenantIds.wellnessAdmin, 'tenant ids not resolved');
    test.skip(
      tenantIds.admin === tenantIds.wellnessAdmin,
      'generic + wellness fixtures resolved to the same tenant — cannot test cross-tenant isolation',
    );

    // Seed a row on the WELLNESS tenant dated 1 hour ago.
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const wellnessRowId = seedCspViolation(
      tenantIds.wellnessAdmin,
      'cross-tenant-isolation-probe',
      recentIso,
    );
    seededAuditIds.push(wellnessRowId);

    // The GENERIC admin must NOT see it.
    const rGeneric = await authGet(request, tokens.admin, ROUTE);
    expect(rGeneric.status()).toBe(200);
    const bodyGeneric = await rGeneric.json();
    const leaked = bodyGeneric.violations.find((v) => v.id === wellnessRowId);
    expect(
      leaked,
      `generic admin saw wellness-tenant CSPViolation id=${wellnessRowId} — tenant isolation breach`,
    ).toBeUndefined();

    // Sanity: the WELLNESS admin DOES see it (proves the row landed).
    const rWellness = await authGet(request, tokens.wellnessAdmin, ROUTE);
    expect(rWellness.status()).toBe(200);
    const bodyWellness = await rWellness.json();
    const visible = bodyWellness.violations.find((v) => v.id === wellnessRowId);
    expect(visible, 'wellness admin should see its own tenant CSPViolation').toBeTruthy();
  });
});
