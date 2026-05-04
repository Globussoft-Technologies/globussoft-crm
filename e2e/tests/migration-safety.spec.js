// @ts-check
/**
 * Migration safety gate (G-23 from docs/E2E_GAPS.md)
 *
 * What this spec asserts:
 *   The `backend/scripts/check-migration-safety.js` script — invoked
 *   on every PR / push by `.github/workflows/migration-check.yml` —
 *   correctly classifies the five high-severity migration risk
 *   classes against fixture .prisma datamodels living next to the
 *   script:
 *
 *     1. NOT_NULL_WITHOUT_DEFAULT — adding NOT NULL to an existing
 *        nullable column without a DEFAULT, OR adding a new NOT NULL
 *        column without a DEFAULT.
 *     2. COLUMN_DROP — drops a column from a (potentially populated)
 *        table.
 *     3. TYPE_NARROWING — shrinks a varchar/char width to <= 50.
 *     4. UNIQUE_ADDITION — adds a UNIQUE constraint to an existing
 *        column.
 *     5. FK_WITHOUT_ON_DELETE — adds a foreign key without an
 *        explicit ON DELETE clause (FK behaviour falls back to
 *        MySQL's RESTRICT default, which is a silent semantic
 *        change).
 *
 * Why this exists:
 *   The deploy.yml flow runs `prisma db push --accept-data-loss`
 *   blind. NOT-NULL on a populated table without a default = prod
 *   outage. Column drop on a populated table = data loss. Type
 *   narrowing = silent data truncation. UNIQUE addition with
 *   pre-existing duplicates = migration failure. The script is the
 *   per-merge gate that catches these BEFORE the deploy job runs the
 *   real db push.
 *
 *   This spec is the test-of-the-test: it verifies the detector
 *   logic against curated fixture pairs, so a future change to
 *   `check-migration-safety.js` (or a prisma engine version bump
 *   that changes DDL output) doesn't silently break the gate.
 *
 * Test environment expectations:
 *   - The script needs `npx prisma migrate diff --script` to work,
 *     which means `backend/node_modules/prisma` must be installed.
 *     The CI workflow runs `npm ci` in backend before invoking this
 *     spec; locally, `scripts\local-stack-up.ps1` (or just `cd
 *     backend && npm install`) covers it.
 *   - No backend server boot, no DB, no auth, no fixture cleanup
 *     needed. Pure child-process assertions — fastest spec in the
 *     gate.
 *
 * Fixture pairs:
 *   All under `backend/scripts/fixtures/migration-safety/`:
 *     - baseline.prisma           — the FROM (current demo schema)
 *     - safe.prisma               — additive-only (nullable + NOT NULL with default)
 *     - dangerous-not-null.prisma — NOT NULL transition + new NOT NULL no-default
 *     - dangerous-drop.prisma     — drops baseline.bio
 *     - dangerous-narrowing.prisma— title VARCHAR(255) → VARCHAR(50)
 *     - dangerous-unique.prisma   — adds @unique on a non-unique column
 *
 * Revert-and-prove drill:
 *   Comment out one of the detector functions in
 *   `backend/scripts/check-migration-safety.js` (e.g.
 *   detectColumnDrop) → the corresponding test below fails. That's
 *   the regression-detection contract.
 */
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Resolve repo root from this spec's location. The spec lives at
// e2e/tests/migration-safety.spec.js → ../../ is the repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'backend', 'scripts', 'check-migration-safety.js');
const FIXTURES = path.join(REPO_ROOT, 'backend', 'scripts', 'fixtures', 'migration-safety');

// Run the script as a child node process. Returns the exit code +
// captured stdout / stderr. Doesn't throw on non-zero exit (we want
// to assert on it).
//
// The optional `env` arg lets a caller layer extra env vars on top of
// process.env. The blessing-path tests use this to feed
// MIGRATION_SAFETY_COMMIT_MSG without fabricating real commits.
function runScript(args = [], env = {}) {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
  } catch (e) {
    exitCode = e.status || 1;
    stdout = (e.stdout || '').toString();
    stderr = (e.stderr || '').toString();
  }
  return { exitCode, stdout, stderr };
}

const fx = (name) => path.join(FIXTURES, name);

test.describe('Migration safety gate (G-23) — detector regression suite', () => {
  test.beforeAll(() => {
    // Surface a clearer failure if the script or fixtures aren't
    // present — otherwise every test below fails with an opaque
    // ENOENT from execFileSync.
    expect(fs.existsSync(SCRIPT), `script missing: ${SCRIPT}`).toBe(true);
    for (const f of [
      'baseline.prisma',
      'safe.prisma',
      'dangerous-not-null.prisma',
      'dangerous-drop.prisma',
      'dangerous-narrowing.prisma',
      'dangerous-unique.prisma',
    ]) {
      expect(fs.existsSync(fx(f)), `fixture missing: ${f}`).toBe(true);
    }
  });

  test('safe schema (additive nullable + NOT NULL with DEFAULT) → exit 0, no risks', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('safe.prisma'),
      '--against', fx('baseline.prisma'),
    ]);
    expect(exitCode, 'safe schema must pass the gate').toBe(0);
    expect(stdout).toMatch(/\[OK\]/);
    expect(stdout).toMatch(/No migration risks detected/);
  });

  test('NOT_NULL_WITHOUT_DEFAULT detector — flags NULL→NOT NULL transition + new NOT-NULL no-default column', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-not-null.prisma'),
      '--against', fx('baseline.prisma'),
      // #425 follow-up: detector-fires tests must not inherit the host repo's
      // commit message, otherwise a real `[allow-not-null]` bless on HEAD
      // (used to ship a real schema change) would silently suppress this
      // fixture's risk and the regression suite would go green incorrectly.
      // The line-270 "regression-guard" test was supposed to catch this but
      // only covered the UNIQUE case — patched defensively across all four
      // detector-fires tests + the --json shape test.
      '--no-commit-blessings',
    ]);
    expect(exitCode, 'dangerous-not-null must FAIL the gate').toBe(1);
    // Both NOT-NULL risks should fire — one for FixtureUser.name
    // (existing nullable column tightened to NOT NULL) and one for
    // FixturePost.requiredField (new NOT NULL ADD COLUMN with no default).
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixtureUser\.name/);
    expect(combined).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixturePost\.requiredField/);
  });

  test('COLUMN_DROP detector — flags any DROP COLUMN', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-drop.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings', // see NOT_NULL test for rationale
    ]);
    expect(exitCode, 'dangerous-drop must FAIL the gate').toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] COLUMN_DROP: FixtureUser\.bio/);
  });

  test('COLUMN_DROP detector — --allow-drop suppresses the risk and exits 0', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-drop.prisma'),
      '--against', fx('baseline.prisma'),
      '--allow-drop',
    ]);
    expect(exitCode, '--allow-drop must clear the gate').toBe(0);
    expect(stdout).toMatch(/\[OK\]/);
    expect(stdout).toMatch(/1 risks suppressed/);
  });

  test('TYPE_NARROWING detector — flags VARCHAR(255) → VARCHAR(50)', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-narrowing.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings', // see NOT_NULL test for rationale
    ]);
    expect(exitCode, 'dangerous-narrowing must FAIL the gate').toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] TYPE_NARROWING: FixturePost\.title/);
    expect(combined).toMatch(/VARCHAR\(50\)/);
  });

  test('UNIQUE_ADDITION detector — flags @unique added to existing column', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-unique.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings', // see NOT_NULL test for rationale
    ]);
    expect(exitCode, 'dangerous-unique must FAIL the gate').toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] UNIQUE_ADDITION: FixtureUser\(name\)/);
  });

  test('UNIQUE_ADDITION detector — --allow-unique suppresses the risk and exits 0', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-unique.prisma'),
      '--against', fx('baseline.prisma'),
      '--allow-unique',
    ]);
    expect(exitCode, '--allow-unique must clear the gate').toBe(0);
    expect(stdout).toMatch(/\[OK\]/);
    expect(stdout).toMatch(/1 risks suppressed/);
  });

  test('--json output is parseable and reports the right shape', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-not-null.prisma'),
      '--against', fx('baseline.prisma'),
      '--json',
      '--no-commit-blessings', // see NOT_NULL test for rationale
    ]);
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      statementCount: expect.any(Number),
      riskCount: 2,
      suppressedCount: 0,
      risks: expect.arrayContaining([
        expect.objectContaining({ class: 'NOT_NULL_WITHOUT_DEFAULT' }),
      ]),
    });
    // Every risk has the load-bearing fields the workflow's summary
    // step consumes.
    for (const r of report.risks) {
      expect(r).toMatchObject({
        class: expect.any(String),
        table: expect.any(String),
        column: expect.any(String),
        statement: expect.any(String),
        message: expect.any(String),
      });
    }
  });

  test('production schema diffed against itself → 0 statements, exit 0 (idempotency sanity)', () => {
    const prodSchema = path.join(REPO_ROOT, 'backend', 'prisma', 'schema.prisma');
    if (!fs.existsSync(prodSchema)) {
      // In an external check-out where the path differs, skip rather
      // than fail. The CI runner always has the schema present.
      test.skip(true, 'backend/prisma/schema.prisma not present');
      return;
    }
    const { exitCode, stdout } = runScript([
      '--schema', prodSchema,
      '--against', prodSchema,
    ]);
    expect(exitCode, 'identity diff must produce 0 risks').toBe(0);
    expect(stdout).toMatch(/0 statements analyzed|No migration risks detected/);
  });

  test('missing --schema path → exit 2 (engine error, distinct from risk)', () => {
    const { exitCode, stderr } = runScript([
      '--schema', path.join(FIXTURES, 'does-not-exist.prisma'),
      '--against', fx('baseline.prisma'),
    ]);
    expect(exitCode, 'missing schema must produce engine-error exit code 2').toBe(2);
    expect(stderr).toMatch(/schema not found/);
  });

  // ── Commit-message blessings (issue #425) ─────────────────────────
  //
  // The wave-17 commit cfed31b — closing #424 — tightened
  // CalendarEvent's @@unique from [provider, externalId] to
  // [tenantId, provider, externalId]. That's strictly more permissive
  // (every row that satisfied the old key trivially satisfies the new
  // one), but the UNIQUE_ADDITION detector can't reason at the
  // semantic level and tripped the gate. The blessing markers below
  // are the documented opt-in: author types `[allow-unique]` in the
  // commit message → that detector class gets downgraded to BLESSED
  // for THIS commit only.
  //
  // We feed the commit message via MIGRATION_SAFETY_COMMIT_MSG instead
  // of fabricating a real commit (which would require a separate git
  // worktree on every test run). The script reads that env var first,
  // falling back to `git log -1 --format=%B` only when it's unset.

  test('blessing path: --no-commit-blessings preserves the unblessed exit 1 (regression-guard)', () => {
    // Even with a blessing in the env, --no-commit-blessings must
    // suppress the scan so the unblessed behaviour is preserved.
    // This is the safety hatch the test suite uses to assert the
    // detector still fires when it should.
    const { exitCode, stderr } = runScript([
      '--schema', fx('dangerous-unique.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings',
    ], {
      MIGRATION_SAFETY_COMMIT_MSG: 'feat: should be ignored [allow-unique]',
    });
    expect(exitCode, '--no-commit-blessings must keep the gate failing').toBe(1);
    expect(stderr).toMatch(/\[RISK\] UNIQUE_ADDITION/);
  });

  test('blessing path: [allow-unique] in commit message clears UNIQUE_ADDITION risk', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-unique.prisma'),
      '--against', fx('baseline.prisma'),
    ], {
      MIGRATION_SAFETY_COMMIT_MSG:
        'feat(schema): close #424 — tighten CalendarEvent unique key\n\n' +
        'New constraint [tenantId, provider, externalId] is strictly more\n' +
        'permissive than [provider, externalId]. [allow-unique]',
    });
    expect(exitCode, '[allow-unique] must clear the UNIQUE_ADDITION gate').toBe(0);
    expect(stdout).toMatch(/\[BLESSED\] UNIQUE_ADDITION/);
    expect(stdout).toMatch(/1 risk\(s\) suppressed by commit-message blessings/);
  });

  test('blessing path: [allow-unique] does NOT bless an unrelated NOT_NULL_WITHOUT_DEFAULT risk', () => {
    // Cross-class isolation. Saying "I verified the unique" must not
    // accidentally wave through a backfill bomb on a different column.
    const { exitCode, stderr } = runScript([
      '--schema', fx('dangerous-not-null.prisma'),
      '--against', fx('baseline.prisma'),
    ], {
      MIGRATION_SAFETY_COMMIT_MSG: 'feat: tighten name + add field [allow-unique]',
    });
    expect(exitCode, '[allow-unique] must NOT bless NOT_NULL risks').toBe(1);
    expect(stderr).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixtureUser\.name/);
    expect(stderr).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixturePost\.requiredField/);
  });

  test('blessing path: --json output includes blessings + blessedCount fields', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-drop.prisma'),
      '--against', fx('baseline.prisma'),
      '--json',
    ], {
      MIGRATION_SAFETY_COMMIT_MSG: 'chore(schema): prune [allow-drop]',
    });
    expect(exitCode, '[allow-drop] in JSON mode must still clear the gate').toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      riskCount: 0,
      suppressedCount: 1,
      blessedCount: 1,
      blessings: { allowDrop: true, allowUnique: false },
    });
    expect(report.risks[0]).toMatchObject({
      class: 'COLUMN_DROP',
      suppressed: true,
      suppressedBy: 'commit-blessing',
    });
  });
});
