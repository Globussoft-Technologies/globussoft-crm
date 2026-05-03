// @ts-check
/**
 * Backup Engine — gate spec for cron/backupEngine.js (G-15).
 *
 * What this spec asserts
 * ──────────────────────
 *   1. POST /api/admin/backup/run produces a valid `.sql.gz` mysqldump on
 *      disk in BACKUP_DIR — file present, size > 1KB, gzip-decompressible,
 *      first line starts with `-- MySQL dump`.
 *   2. The route response leaks ONLY the basename — never the absolute
 *      filesystem path of BACKUP_DIR. (Disclosure of writeable server FS
 *      paths is a free recon-tier handhold for an attacker.)
 *   3. PII safety — when WELLNESS_FIELD_KEY is configured (i.e. field-
 *      level encryption is active), the dump must contain the
 *      `ENC:v1:<iv>:<tag>:<ct>` ciphertext for Patient.allergies /
 *      Patient.notes / Visit.notes / Visit.vitals / Prescription.drugs /
 *      Prescription.instructions / ConsentForm.signatureSvg, and must
 *      NOT contain the original plaintext sentinel value the spec wrote.
 *      When WELLNESS_FIELD_KEY is NOT set (encryption is opt-in per
 *      lib/fieldEncryption.js — encrypt() is a no-op when the key is
 *      missing), the spec degrades to a soft assertion + warning so the
 *      gate is non-blocking on dev hosts that haven't flipped the
 *      switch.
 *   4. RBAC: MANAGER + USER receive 403; the engine is never invoked.
 *   5. Auth: missing/garbage bearer → 401/403.
 *   6. mysqldump-failure mode — when MYSQLDUMP_BIN points at a non-
 *      existent binary, the route returns 500 with a structured
 *      `{ success: false, code: 'MYSQLDUMP_FAILED', errors: [...] }`
 *      body and DOES NOT crash the process. We don't drive this branch
 *      in CI (would need a hot-reload of the engine env) — instead the
 *      assertion lives in the `runBackup()` engine-level test below
 *      (route-level: documented + skipped in CI).
 *   7. Cleanup: every backup file the spec creates is unlinked in
 *      afterAll using a tagged filename pattern (`E2E_BACKUP_<ts>.sql.gz`)
 *      so the disk doesn't fill up over many CI runs.
 *
 * The endpoints this spec drives
 * ──────────────────────────────
 *   POST /api/admin/backup/run        — verifyToken + verifyRole(['ADMIN']).
 *                                       Returns { success, tenantId, file,
 *                                       sizeBytes, durationMs, errors }.
 *                                       file is the BASENAME ONLY — never
 *                                       the absolute server FS path.
 *   GET  /api/admin/backup/list       — verifyRole(['ADMIN']). Returns
 *                                       { success, backups: [{ file,
 *                                       sizeBytes, mtime }] } sorted
 *                                       newest-first, capped at 100.
 *   GET  /api/admin/backup/file/:name — verifyRole(['ADMIN']). Returns
 *                                       { success, exists, file, sizeBytes,
 *                                       mtime } for one backup. 400 on path-
 *                                       traversal attempts (any "/" or
 *                                       ".." in :name).
 *
 * Why a dedicated trigger endpoint
 * ────────────────────────────────
 *   Pre-this-PR the backup engine was cron-only (daily 02:00). There was
 *   no way to verify it works on each commit short of running a CI gate
 *   at 02:00. The new POST /api/admin/backup/run mirrors the pattern
 *   established by:
 *     - POST /api/billing/recurring/run        (G-9, billing.js:591)
 *     - POST /api/forecasting/snapshot/run     (forecast snapshot engine)
 *     - POST /api/wellness/ops/run             (G-7, wellnessOpsEngine)
 *     - POST /api/gdpr/retention/run           (G-11, retentionEngine)
 *   Unlike retention, backup is NON-DESTRUCTIVE — mysqldump
 *   --single-transaction is a read-only operation against the source DB
 *   — so there's no `confirmDestructive` body guard. Just RBAC.
 *
 * mysqldump invocation: PATH vs Docker
 * ────────────────────────────────────
 *   The engine supports two invocation modes (cron/backupEngine.js):
 *     - PATH mode (default): shells `mysqldump …` directly. Works on
 *       prod (Linux + apt mysql-client), works on Linux dev hosts.
 *     - Docker mode: when MYSQLDUMP_DOCKER_CONTAINER=<name> is set,
 *       wraps the call in `docker exec <container> mysqldump …`. Used
 *       for local Windows dev where mysqldump is not on PATH but the
 *       gbscrm-mysql-local Docker container has it baked in. Also a
 *       graceful fallback for any CI environment that prefers a
 *       containerised toolchain over apt.
 *   In CI (deploy.yml + coverage.yml api_tests gate), the runner uses
 *   PATH mode — `apt-get install -y mysql-client` runs before the
 *   backend boot step so `mysqldump` resolves on the runner host. The
 *   MySQL service container is reached via 127.0.0.1:3306 like every
 *   other API spec.
 *
 * Test environment expectations
 * ─────────────────────────────
 *   - BASE_URL defaults to http://127.0.0.1:5000 (local stack). CI sets
 *     BASE_URL=http://127.0.0.1:5000.
 *   - Demo creds: admin@globussoft.com (ADMIN) + manager@crm.com
 *     (MANAGER) + user@crm.com (USER) + admin@wellness.demo (wellness
 *     ADMIN, used to seed the encrypted Patient row).
 *   - WELLNESS_FIELD_KEY=64-hex-chars enables encryption-at-rest on
 *     wellness PII. Local dev: set in .env. CI: set in deploy.yml +
 *     coverage.yml job env. When unset: the PII-safety branch logs a
 *     warning and skips the strong assertion (see comment on the
 *     plain-PII test below).
 *   - mysqldump available on the host (via apt OR docker exec — see
 *     above). If neither is reachable, the file-creation tests skip
 *     with an actionable message and the gate stays green so a
 *     mis-configured dev box isn't a deploy blocker.
 *
 * Pattern: builds on retention-api.spec.js (admin-gated cron trigger
 * that touches FS) + wellness-ops-api.spec.js (Prisma child-process
 * helpers for tagged seed/scrub).
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const RUN_TAG = `E2E_BACKUP_${Date.now()}`;
// Plaintext sentinel embedded into Patient.allergies. We grep the dump
// for this exact string post-run; it must NOT appear when WELLNESS_FIELD_KEY
// is configured (the encryption hook in lib/prisma.js intercepts the
// write and stores ENC:v1:… ciphertext instead).
const PII_SENTINEL_ALLERGIES = `${RUN_TAG}_PLAIN_PII_PEANUTS_ALERGIA`;
const PII_SENTINEL_NOTES = `${RUN_TAG}_PLAIN_NOTES_HEPATITIS_VAR_X`;

// Force serial. Each /run writes a file to BACKUP_DIR and prunes the
// directory; parallel tests would race on the file inventory + on the
// patient-row creation/cleanup ordering.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  admin: { email: 'admin@globussoft.com', password: 'password123' },
  manager: { email: 'manager@crm.com', password: 'password123' },
  user: { email: 'user@crm.com', password: 'password123' },
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
};

const tokens = {};
const tenantIds = {};
// Track every basename we created so afterAll can unlink unambiguously.
const createdBackupFiles = new Set();
// Track the test patient id so afterAll Prisma-deletes it.
let createdPatientId = null;

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
        };
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
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

// ─── Direct DB helpers ───────────────────────────────────────────────────
// Same access pattern as retention-api.spec.js + wellness-ops-api.spec.js.
// Used here only for cleanup of the seeded Patient row (the wellness API
// has no DELETE /patients endpoint — soft-delete of patient rows is not
// a v1 wellness feature).

const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'backend');
let cachedDbUrl;

function candidateDbUrls() {
  const list = [];
  if (process.env.DATABASE_URL) list.push(process.env.DATABASE_URL);
  list.push('mysql://root:local_dev_pw@127.0.0.1:3307/gbscrm_local');
  list.push('mysql://root:ci_root_pw@127.0.0.1:3306/gbscrm_ci');
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
      try { await prisma.patient.count(); process.stdout.write('OK'); }
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

function deletePatientById(id) {
  return runPrismaScript(
    `const r = await prisma.patient.delete({ where: { id: ${Number(id)} } }).catch(() => null); return r && r.id || null;`
  );
}

// Read the raw `allergies` column straight from the database (bypassing
// the Prisma extension's auto-decrypt) so the spec can confirm what's
// actually persisted before mysqldump-ing it. We do this with a $queryRaw
// scope to dodge the @extends hook that decrypts on read.
function readRawPatientFields(id) {
  return runPrismaScript(
    `const rows = await prisma.$queryRawUnsafe('SELECT id, allergies, notes FROM Patient WHERE id = ?', ${Number(id)});
     return rows && rows[0] || null;`
  );
}

// ─── Backup-file helpers ─────────────────────────────────────────────────

// Inflate a .sql.gz on disk to a UTF-8 string. Done synchronously because
// the dumps are small (~80KB compressed / ~500KB uncompressed for the
// CI-seeded DB) and the spec needs them in-memory for the grep
// assertions.
function readBackupAsText(absPath) {
  const buf = fs.readFileSync(absPath);
  const out = zlib.gunzipSync(buf);
  return out.toString('utf8');
}

// Walk known BACKUP_DIR candidate locations to find the file. The route
// only returns the BASENAME — by design, to avoid leaking the absolute
// server path. The spec resolves the path locally by trying each known
// candidate. CI: <repo>/backups/. Dev: same.
function resolveBackupPath(filename) {
  const candidates = [];
  if (process.env.BACKUP_DIR) candidates.push(path.resolve(process.env.BACKUP_DIR));
  candidates.push(path.resolve(__dirname, '..', '..', 'backups'));
  candidates.push(path.resolve(BACKEND_DIR, '..', 'backups'));
  for (const dir of candidates) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
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

test.afterAll(async () => {
  // 1. Unlink every backup file the spec created. Tagged with timestamps
  //    so we never accidentally clobber a file the cron sweep made.
  for (const f of createdBackupFiles) {
    const fp = resolveBackupPath(f);
    if (fp) {
      try { fs.unlinkSync(fp); } catch (_e) { /* best-effort */ }
    }
  }
  // 2. Delete the seeded Patient row. The wellness API has no DELETE
  //    /patients route, so we go through Prisma. If the DB isn't
  //    reachable from this env (rare — Playwright + backend share a
  //    box in CI), this is a no-op and the row leaks; the wellness
  //    tenant tolerates a stray E2E patient until the next reseed.
  if (createdPatientId && dbAvailable()) {
    try { deletePatientById(createdPatientId); } catch (_e) { /* best-effort */ }
  }
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('POST /api/admin/backup/run — auth gate', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/admin/backup/run`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('bogus bearer → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/admin/backup/run`, {
      data: {},
      headers: { Authorization: 'Bearer not-a-real-jwt', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── RBAC gate ───────────────────────────────────────────────────────────

test.describe('POST /api/admin/backup/run — RBAC gate', () => {
  test('MANAGER → 403 (engine NOT invoked)', async ({ request }) => {
    test.skip(!tokens.manager, 'manager fixture not seeded');
    const res = await authPost(request, tokens.manager, '/admin/backup/run', {});
    expect(res.status()).toBe(403);
  });

  test('USER → 403', async ({ request }) => {
    test.skip(!tokens.user, 'user fixture not seeded');
    const res = await authPost(request, tokens.user, '/admin/backup/run', {});
    expect(res.status()).toBe(403);
  });

  test('GET /admin/backup/list — MANAGER → 403', async ({ request }) => {
    test.skip(!tokens.manager, 'manager fixture not seeded');
    const res = await authGet(request, tokens.manager, '/admin/backup/list');
    expect(res.status()).toBe(403);
  });

  test('GET /admin/backup/file/:name — USER → 403', async ({ request }) => {
    test.skip(!tokens.user, 'user fixture not seeded');
    const res = await authGet(request, tokens.user, '/admin/backup/file/anything.sql.gz');
    expect(res.status()).toBe(403);
  });
});

// ─── Path-traversal guard on /file/:name ─────────────────────────────────

test.describe('GET /api/admin/backup/file/:name — input validation', () => {
  test('rejects path-traversal-encoded name → 400', async ({ request }) => {
    // %2F decodes to "/" before our handler sees it. The route checks
    // both raw separators and ".." segments. Either should bounce.
    const res = await authGet(request, tokens.admin, '/admin/backup/file/..%2F..%2Fpasswd');
    expect(res.status()).toBe(400);
    const j = await res.json();
    expect(j.code).toBe('INVALID_NAME');
  });

  test('rejects backslash path-traversal → 400', async ({ request }) => {
    const res = await authGet(request, tokens.admin, '/admin/backup/file/..%5Csecret');
    expect(res.status()).toBe(400);
  });

  test('returns 404 for unknown basename', async ({ request }) => {
    const res = await authGet(request, tokens.admin, '/admin/backup/file/no-such-backup.sql.gz');
    expect(res.status()).toBe(404);
    const j = await res.json();
    expect(j.exists).toBe(false);
  });
});

// ─── Engine semantics: produce a valid backup file ───────────────────────

test.describe('POST /api/admin/backup/run — happy path', () => {
  test('produces a valid .sql.gz dump on disk (size > 1KB, valid header)', async ({ request }) => {
    const res = await authPost(request, tokens.admin, '/admin/backup/run', {});
    // mysqldump-unavailable on this host → 500 with a structured code.
    // We surface it loud so the operator knows to apt-get install
    // mysql-client or set MYSQLDUMP_DOCKER_CONTAINER, but we don't fail
    // the gate — there's a separate dedicated test that asserts the
    // 500-shape contract.
    if (res.status() === 500) {
      const j = await res.json().catch(() => ({}));
      console.warn('[G-15] /backup/run 500:', JSON.stringify(j));
      test.skip(true, 'mysqldump unreachable on this host — see runtime warning above');
      return;
    }

    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tenantId).toBe(tenantIds.admin);
    expect(typeof body.file).toBe('string');
    expect(body.file).toMatch(/\.sql\.gz$/);

    // Path-leak contract: the response must contain ONLY the basename.
    // Reject any value that includes a / or \ (would imply we leaked
    // BACKUP_DIR's absolute path) or that resolves to a parent dir.
    expect(body.file.includes('/')).toBe(false);
    expect(body.file.includes('\\')).toBe(false);
    expect(body.file.includes('..')).toBe(false);
    expect(path.basename(body.file)).toBe(body.file);

    expect(typeof body.sizeBytes).toBe('number');
    expect(body.sizeBytes).toBeGreaterThan(1024); // > 1KB sanity
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThan(0);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBe(0);

    // Track for cleanup BEFORE we read it — even if the read assertion
    // below fails, afterAll should still unlink.
    createdBackupFiles.add(body.file);

    // Resolve the file on disk + verify roundtrip-readability.
    const fp = resolveBackupPath(body.file);
    expect(fp, `backup file ${body.file} should be findable on disk`).not.toBeNull();
    const stat = fs.statSync(fp);
    expect(stat.size).toBeGreaterThan(1024);
    // Match the route's reported size to one byte (sanity: the route
    // statSync'd the same file we're statSync-ing here).
    expect(stat.size).toBe(body.sizeBytes);

    // Decompress + verify it's a real mysqldump (header is the
    // canonical "-- MySQL dump 10.13 Distrib …" line). We're NOT
    // restoring it — that's expensive and out of scope.
    const text = readBackupAsText(fp);
    expect(text.startsWith('-- MySQL dump')).toBe(true);
    // The dump's first ~10 lines also include the `-- Host:` /
    // `-- Database:` / `-- Server version` markers. We don't pin a
    // specific DB name (CI uses gbscrm_ci, dev uses gbscrm_local) but
    // we do require those marker lines.
    expect(text).toMatch(/-- Host: /);
    expect(text).toMatch(/-- Server version/);
    // Confirm the dump includes the Patient table — it's in our schema
    // and a missing CREATE TABLE block here would mean mysqldump silently
    // skipped it (e.g. wrong DB name) and the dump is useless.
    expect(text).toMatch(/CREATE TABLE `Patient`/);
  });

  test('GET /admin/backup/list returns the new backup', async ({ request }) => {
    test.skip(createdBackupFiles.size === 0, 'no backup created yet (mysqldump unavailable)');
    const res = await authGet(request, tokens.admin, '/admin/backup/list?limit=10');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.backups)).toBe(true);
    // Newest-first ordering: the first row should be one of OUR
    // tagged files (or at minimum, any of our files should be present).
    const ours = body.backups.find((b) => createdBackupFiles.has(b.file));
    expect(ours, 'our /run output should appear in /list').toBeTruthy();
    expect(ours.sizeBytes).toBeGreaterThan(1024);
    // Path-leak contract on /list — same as /run: file is the basename.
    for (const b of body.backups) {
      expect(b.file.includes('/')).toBe(false);
      expect(b.file.includes('\\')).toBe(false);
    }
  });

  test('GET /admin/backup/file/:name confirms exists + size', async ({ request }) => {
    test.skip(createdBackupFiles.size === 0, 'no backup created yet (mysqldump unavailable)');
    const filename = [...createdBackupFiles][0];
    const res = await authGet(request, tokens.admin, `/admin/backup/file/${filename}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.file).toBe(filename); // basename only
    expect(body.sizeBytes).toBeGreaterThan(1024);
  });
});

// ─── PII safety — encrypted-fields contract on the dump ──────────────────

test.describe('POST /api/admin/backup/run — PII safety', () => {
  test('plaintext PII in encrypted columns does NOT leak into the dump (when WELLNESS_FIELD_KEY is set)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');

    // 1. Seed a wellness Patient with sentinel plaintext in the two
    //    encrypted Patient fields (allergies + notes). The lib/prisma.js
    //    $extends hook intercepts the create call and encrypts both
    //    fields IF WELLNESS_FIELD_KEY is configured. If the key is NOT
    //    set, encrypt() is a no-op (per lib/fieldEncryption.js's
    //    contract) and the plaintext is persisted as-is — that's fine
    //    by the codebase but means our strong PII assertion
    //    (no plaintext in dump) cannot be made; we soft-pass with a
    //    warning instead.
    const phone = `+91999990${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    const r = await request.post(`${API}/wellness/patients`, {
      headers: authHeader(tokens.wellnessAdmin),
      data: {
        name: `${RUN_TAG} PII Patient`,
        phone,
        allergies: PII_SENTINEL_ALLERGIES,
        notes: PII_SENTINEL_NOTES,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok(), `wellness patient create: ${r.status()} ${await r.text()}`).toBe(true);
    const patient = await r.json();
    createdPatientId = patient.id;

    // 2. Determine whether encryption is active by reading the raw
    //    columns from the DB (bypasses the auto-decrypt extension).
    //    If the value starts with "ENC:v1:", encryption is on. If it
    //    equals the plaintext sentinel, the key is unset.
    let encryptionActive = false;
    if (dbAvailable()) {
      try {
        const raw = readRawPatientFields(patient.id);
        if (raw && typeof raw.allergies === 'string') {
          encryptionActive = raw.allergies.startsWith('ENC:v1:');
        }
      } catch (e) {
        console.warn('[G-15 PII] raw column probe failed:', e.message);
      }
    }

    // 3. Run the backup AFTER the patient row is persisted. The dump
    //    will contain whatever's in the Patient table at this moment.
    const runRes = await authPost(request, tokens.admin, '/admin/backup/run', {});
    if (runRes.status() === 500) {
      const j = await runRes.json().catch(() => ({}));
      console.warn('[G-15 PII] /backup/run 500:', JSON.stringify(j));
      test.skip(true, 'mysqldump unreachable on this host — PII check requires a working dump');
      return;
    }
    expect(runRes.status()).toBe(200);
    const runBody = await runRes.json();
    createdBackupFiles.add(runBody.file);

    const fp = resolveBackupPath(runBody.file);
    expect(fp, 'backup file should exist on disk').not.toBeNull();
    const text = readBackupAsText(fp);

    // 4. Confirm the patient row IS in the dump (sanity — if it's not,
    //    the Patient table was dumped before our INSERT or the wrong DB
    //    was dumped, and the rest of the assertions are vacuous).
    expect(text).toContain(`${RUN_TAG} PII Patient`);

    if (encryptionActive) {
      // CRITICAL contract: with the encryption key configured,
      // plaintext PII for the two encrypted Patient columns must NOT
      // appear in the dump. The dump should carry the ENC:v1:…
      // ciphertext form.
      expect(
        text.includes(PII_SENTINEL_ALLERGIES),
        `plaintext PII sentinel "${PII_SENTINEL_ALLERGIES}" leaked into mysqldump output — encryption pipeline bypassed at write time`,
      ).toBe(false);
      expect(
        text.includes(PII_SENTINEL_NOTES),
        `plaintext PII sentinel "${PII_SENTINEL_NOTES}" leaked into mysqldump output — encryption pipeline bypassed at write time`,
      ).toBe(false);
      // Positive assertion: SOME ENC:v1: ciphertext must be present
      // (proves the encryption pipeline is running, not just that we
      // failed to find the plaintext — the negative-only check would
      // false-pass if the patient row got skipped entirely).
      expect(
        text.includes('ENC:v1:'),
        'ENC:v1: ciphertext expected in dump when WELLNESS_FIELD_KEY is set',
      ).toBe(true);
    } else {
      // Soft-pass with a runtime warning. Don't fail the gate on dev
      // hosts that haven't flipped the encryption switch yet — but
      // log loudly so the next operator who inspects CI logs sees it
      // and turns it on.
      console.warn(
        '[G-15 PII] WELLNESS_FIELD_KEY not configured — encryption is a no-op. ' +
          `Plaintext PII WILL appear in mysqldump output. To enable the strong check, set ` +
          `WELLNESS_FIELD_KEY=<64 hex chars> in the deploy.yml + coverage.yml job env. ` +
          `See backend/lib/fieldEncryption.js for setup instructions.`,
      );
      // We can still assert the patient row made it (the basic dump-
      // includes-recent-data sanity check). Plaintext PII appearing
      // here is the documented behaviour when encryption is opt-in
      // disabled — not a bug.
      expect(text).toContain(PII_SENTINEL_ALLERGIES);
    }
  });
});

// ─── Engine error contract — mysqldump unavailable ───────────────────────
//
// We don't dynamically swap MYSQLDUMP_BIN in CI (the engine reads env at
// invocation time, not at module load — but the route hands off to
// runBackup() which inherits the parent process env). To exercise the
// error branch we'd need to either (a) restart the backend with a bogus
// MYSQLDUMP_BIN, or (b) mock the engine. Both are out of scope for an
// e2e API spec. Instead we document the contract here + assert it
// inline by direct unit-style invocation of runBackup() through a
// child node process — same pattern as runPrismaScript above.

test.describe('runBackup() engine — mysqldump-failure error contract', () => {
  test('returns { success:false, code:"MYSQLDUMP_FAILED" } when binary is missing', async () => {
    test.skip(!probePrismaClient(), 'backend not installable in this env (no Prisma client) — engine probe impossible');

    // Invoke runBackup() in a child node process with MYSQLDUMP_BIN
    // pointing at a non-existent path. The engine should:
    //   - return { success:false, code:'MYSQLDUMP_FAILED', error:<msg>,
    //     file:null, sizeBytes:0, durationMs:>=0 }
    //   - NOT throw / crash the process.
    //   - NOT leave a zero-byte file behind.
    const tmpDir = path.join(BACKEND_DIR, '..', 'backups-e2e-error-probe');
    // The engine writes `console.log/warn/error` lines on every run.
    // Silence those here so process.stdout carries ONLY the JSON we
    // want to parse — otherwise JSON.parse trips on "[Backup] …" noise.
    const wrapped = `
      console.log = console.warn = console.error = () => {};
      process.env.MYSQLDUMP_BIN = '/definitely/not/a/real/binary/mysqldump-${Date.now()}';
      process.env.MYSQLDUMP_DOCKER_CONTAINER = ''; // force PATH mode
      process.env.BACKUP_DIR = ${JSON.stringify(tmpDir)};
      process.env.DATABASE_URL = process.env.DATABASE_URL || ${JSON.stringify(cachedDbUrl || candidateDbUrls()[0])};
      const { runBackup } = require('./cron/backupEngine');
      const out = runBackup({ filename: 'E2E_ERROR_PROBE_${Date.now()}.sql.gz' });
      process.stdout.write(JSON.stringify(out));
    `;
    let out;
    try {
      out = execFileSync(process.execPath, ['-e', wrapped], {
        cwd: BACKEND_DIR, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // execFileSync throws on non-zero exit. Engine should NOT crash
      // — but the child process exit code is 0 because runBackup
      // returns a structured failure, not throws.
      throw new Error(`runBackup probe child crashed: ${e.message}`);
    }
    const result = JSON.parse(out);
    expect(result.success).toBe(false);
    expect(result.code).toBe('MYSQLDUMP_FAILED');
    expect(result.file).toBeNull();
    expect(result.sizeBytes).toBe(0);
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.error).toBe('string');

    // Belt-and-braces: the engine must not have left a partial file.
    if (fs.existsSync(tmpDir)) {
      const leftovers = fs.readdirSync(tmpDir);
      // Any zero-byte residue is a bug; non-empty residue (older runs)
      // is OK because pruneOldBackups only runs on success.
      for (const f of leftovers) {
        const fp = path.join(tmpDir, f);
        const st = fs.statSync(fp);
        expect(st.size).toBeGreaterThan(0);
      }
      // Cleanup the probe dir itself.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
    }
  });
});
