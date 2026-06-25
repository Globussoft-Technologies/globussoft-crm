// @ts-check
/**
 * Migration safety gate (G-23) — CLI / child-process regression suite.
 *
 * Ported from e2e/tests/migration-safety.spec.js (was Playwright-based,
 * downloaded 167 MB Chromium just to run pure-JS child-process assertions).
 * Now runs under vitest in the unit_tests gate — no browser, no Chromium.
 *
 * What this tests:
 *   check-migration-safety.js (the per-PR schema gate) correctly detects
 *   the five high-severity DDL risk classes against curated fixture pairs.
 *   If a future change weakens a detector, the corresponding test goes red.
 *
 * Companion: backend/test/scripts/check-migration-safety.test.js tests the
 * library surface (analyse / readBlessingsFromCommitMessage) without spawning
 * child processes. This file tests the CLI end-to-end via execFileSync.
 *
 * Environment: needs backend/node_modules/prisma installed so the script can
 * invoke `prisma migrate diff`. The unit_tests CI gate runs `npm ci` in
 * backend beforehand; locally, `cd backend && npm install` covers it.
 * No DB, no server, no network required.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// backend/test/scripts/ → backend/test/ → backend/ → repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'backend', 'scripts', 'check-migration-safety.js');
const FIXTURES = path.join(REPO_ROOT, 'backend', 'scripts', 'fixtures', 'migration-safety');

// Mirror the IS_LOCAL_STACK guard from the original e2e spec. These tests
// spawn `prisma migrate diff` which needs backend/node_modules. The unit_tests
// gate always sets BASE_URL to 127.0.0.1, so they run in CI. They're skipped
// when someone points BASE_URL at a remote demo box (e2e-full.yml).
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL);

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

// Each test spawns `prisma migrate diff` — allow 30 s, well above the default 5 s.
const T = 30_000;

describe.skipIf(!IS_LOCAL_STACK)('Migration safety gate (G-23) — detector regression suite', () => {
  beforeAll(() => {
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
  }, T);

  test('NOT_NULL_WITHOUT_DEFAULT detector — flags NULL→NOT NULL transition + new NOT-NULL no-default column', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-not-null.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings',
    ]);
    expect(exitCode, 'dangerous-not-null must FAIL the gate').toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixtureUser\.name/);
    expect(combined).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixturePost\.requiredField/);
  }, T);

  test('COLUMN_DROP detector — flags any DROP COLUMN', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-drop.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings',
    ]);
    expect(exitCode, 'dangerous-drop must FAIL the gate').toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] COLUMN_DROP: FixtureUser\.bio/);
  }, T);

  test('COLUMN_DROP detector — --allow-drop suppresses the risk and exits 0', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-drop.prisma'),
      '--against', fx('baseline.prisma'),
      '--allow-drop',
    ]);
    expect(exitCode, '--allow-drop must clear the gate').toBe(0);
    expect(stdout).toMatch(/\[OK\]/);
    expect(stdout).toMatch(/1 risks suppressed/);
  }, T);

  test('TYPE_NARROWING detector — flags VARCHAR(255) → VARCHAR(50)', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-narrowing.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings',
    ]);
    expect(exitCode, 'dangerous-narrowing must FAIL the gate').toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] TYPE_NARROWING: FixturePost\.title/);
    expect(combined).toMatch(/VARCHAR\(50\)/);
  }, T);

  test('UNIQUE_ADDITION detector — flags @unique added to existing column', () => {
    const { exitCode, stdout, stderr } = runScript([
      '--schema', fx('dangerous-unique.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings',
    ]);
    expect(exitCode, 'dangerous-unique must FAIL the gate').toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/\[RISK\] UNIQUE_ADDITION: FixtureUser\(name\)/);
  }, T);

  test('UNIQUE_ADDITION detector — --allow-unique suppresses the risk and exits 0', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-unique.prisma'),
      '--against', fx('baseline.prisma'),
      '--allow-unique',
    ]);
    expect(exitCode, '--allow-unique must clear the gate').toBe(0);
    expect(stdout).toMatch(/\[OK\]/);
    expect(stdout).toMatch(/1 risks suppressed/);
  }, T);

  test('--json output is parseable and reports the right shape', () => {
    const { exitCode, stdout } = runScript([
      '--schema', fx('dangerous-not-null.prisma'),
      '--against', fx('baseline.prisma'),
      '--json',
      '--no-commit-blessings',
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
    for (const r of report.risks) {
      expect(r).toMatchObject({
        class: expect.any(String),
        table: expect.any(String),
        column: expect.any(String),
        statement: expect.any(String),
        message: expect.any(String),
      });
    }
  }, T);

  test('production schema diffed against itself → 0 statements, exit 0 (idempotency sanity)', ({ skip }) => {
    const prodSchema = path.join(REPO_ROOT, 'backend', 'prisma', 'schema.prisma');
    if (!fs.existsSync(prodSchema)) {
      skip();
      return;
    }
    const { exitCode, stdout } = runScript([
      '--schema', prodSchema,
      '--against', prodSchema,
    ]);
    expect(exitCode, 'identity diff must produce 0 risks').toBe(0);
    expect(stdout).toMatch(/0 statements analyzed|No migration risks detected/);
  }, T);

  test('missing --schema path → exit 2 (engine error, distinct from risk)', () => {
    const { exitCode, stderr } = runScript([
      '--schema', path.join(FIXTURES, 'does-not-exist.prisma'),
      '--against', fx('baseline.prisma'),
    ]);
    expect(exitCode, 'missing schema must produce engine-error exit code 2').toBe(2);
    expect(stderr).toMatch(/schema not found/);
  }, T);

  test('blessing path: --no-commit-blessings preserves the unblessed exit 1 (regression-guard)', () => {
    const { exitCode, stderr } = runScript([
      '--schema', fx('dangerous-unique.prisma'),
      '--against', fx('baseline.prisma'),
      '--no-commit-blessings',
    ], {
      MIGRATION_SAFETY_COMMIT_MSG: 'feat: should be ignored [allow-unique]',
    });
    expect(exitCode, '--no-commit-blessings must keep the gate failing').toBe(1);
    expect(stderr).toMatch(/\[RISK\] UNIQUE_ADDITION/);
  }, T);

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
  }, T);

  test('blessing path: [allow-unique] does NOT bless an unrelated NOT_NULL_WITHOUT_DEFAULT risk', () => {
    const { exitCode, stderr } = runScript([
      '--schema', fx('dangerous-not-null.prisma'),
      '--against', fx('baseline.prisma'),
    ], {
      MIGRATION_SAFETY_COMMIT_MSG: 'feat: tighten name + add field [allow-unique]',
    });
    expect(exitCode, '[allow-unique] must NOT bless NOT_NULL risks').toBe(1);
    expect(stderr).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixtureUser\.name/);
    expect(stderr).toMatch(/\[RISK\] NOT_NULL_WITHOUT_DEFAULT: FixturePost\.requiredField/);
  }, T);

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
  }, T);
});
