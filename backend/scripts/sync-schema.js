#!/usr/bin/env node
/**
 * scripts/sync-schema.js
 *
 * Single-shot "is my local DB in sync with prisma/schema.prisma, and if not,
 * push it" tool.
 *
 * Why this exists: the deploy pipeline runs `prisma db push` blind on every
 * push, but local development often has a stale DB (you pulled new branches,
 * the schema added models, etc.). Without this, you find out about the
 * mismatch by reading a "Unknown field" 500 in the browser. This script
 * gives you `npm run db:sync` instead.
 *
 * Distinct from `scripts/check-migration-safety.js` — that one is a CI
 * risk detector (warns about NOT-NULL adds, column drops, type narrowing).
 * This script *applies* drift, with a couple of safety rails:
 *   - `prisma db push` refuses to drop columns/tables on a populated DB
 *     unless `--accept-data-loss` is passed; we don't pass it by default,
 *     so a destructive change halts the script and the operator must
 *     decide.
 *   - The previous DATABASE_URL value is printed (with the password masked)
 *     before any change is made.
 *
 * Flow:
 *   1. Load DATABASE_URL from backend/.env via dotenv.
 *   2. Run `prisma migrate diff --exit-code` to detect drift:
 *        exit 0 → DB matches schema; nothing to do.
 *        exit 2 → drift detected; the SQL preview is printed.
 *        exit 1 → unrecoverable error.
 *   3. If drifted and --check NOT passed: run `prisma db push --skip-generate`.
 *   4. Run `prisma generate` so the Prisma client matches the new schema.
 *      (Often blocked on Windows when the backend is running — see the
 *      EPERM rename hint in the failure output.)
 *
 * Flags:
 *   --check              Only report drift; do not push. Exit code 2 if
 *                        drift detected, 0 if not. Useful in CI as a gate.
 *   --force-data-loss    Pass `--accept-data-loss` to db push. Use only
 *                        when you know dropping columns/tables on this DB
 *                        is intentional (e.g. a throwaway dev DB).
 *   --silent             Suppress informational output. Errors still print.
 *
 * Exit codes:
 *   0 — In sync, OR successfully synced.
 *   1 — Error (missing env, schema file, or Prisma command failure).
 *   2 — Drift detected, --check mode only.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(BACKEND_ROOT, 'prisma', 'schema.prisma');
const ENV_PATH = path.join(BACKEND_ROOT, '.env');

// Load .env explicitly from the backend root so the script can be invoked
// from any working directory (e.g. `node backend/scripts/sync-schema.js`).
require('dotenv').config({ path: ENV_PATH });

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE_DATA_LOSS = args.includes('--force-data-loss');
const SILENT = args.includes('--silent');

function log(...m) {
  if (!SILENT) console.log(...m);
}
function fail(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}
function maskUrl(url) {
  // Replace the password in user:password@host with *** so we don't print
  // secrets to terminal scrollback / CI logs.
  return String(url || '').replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1***$2');
}
function runPrisma(args, opts = {}) {
  return spawnSync('npx', ['prisma', ...args], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    // Windows requires shell:true to resolve `npx` from PATH; the same flag
    // is a no-op on POSIX shells.
    shell: process.platform === 'win32',
    ...opts,
  });
}

// ── Preflight ─────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  fail(
    `DATABASE_URL is not set. Looked in ${path.relative(process.cwd(), ENV_PATH)}.`,
  );
}
if (!fs.existsSync(SCHEMA_PATH)) {
  fail(`prisma/schema.prisma not found at ${SCHEMA_PATH}.`);
}

log('━━━ Schema sync check ━━━');
log(`Schema:  ${path.relative(process.cwd(), SCHEMA_PATH)}`);
log(`Target:  ${maskUrl(process.env.DATABASE_URL)}`);
log(`Mode:    ${CHECK_ONLY ? 'check (read-only)' : 'apply'}${FORCE_DATA_LOSS ? ' + accept-data-loss' : ''}`);
log('');

// ── Step 1: detect drift ──────────────────────────────────────────────────

log('[1/3] Detecting drift via `prisma migrate diff`...');
const diff = runPrisma([
  'migrate',
  'diff',
  '--from-url', process.env.DATABASE_URL,
  '--to-schema-datamodel', SCHEMA_PATH,
  '--script',
  '--exit-code',
]);

// migrate diff --exit-code semantics (Prisma docs):
//   0 → no diff
//   1 → unrecoverable error (auth, connection, malformed schema, ...)
//   2 → diff detected; stdout contains the SQL preview
if (diff.status === 0) {
  log('');
  log('✓ Database is in sync with prisma/schema.prisma — nothing to do.');
  process.exit(0);
}

if (diff.status !== 2) {
  console.error('\n`prisma migrate diff` failed.');
  if (diff.stderr) console.error(diff.stderr);
  if (diff.stdout) console.error(diff.stdout);
  process.exit(1);
}

// Status 2 — drift detected.
log('');
log('⚠ Drift detected. Migration SQL preview:');
log('────────────────────────────────────────');
log((diff.stdout || '').trim() || '(no SQL emitted; check Prisma stderr)');
log('────────────────────────────────────────');

if (CHECK_ONLY) {
  log('');
  log('Run without --check to apply, or use `npm run db:sync` from backend/.');
  process.exit(2);
}

// ── Step 2: apply via db push ────────────────────────────────────────────

log('');
log('[2/3] Applying via `prisma db push --skip-generate`...');
const pushArgs = ['db', 'push', '--skip-generate'];
if (FORCE_DATA_LOSS) {
  pushArgs.push('--accept-data-loss');
}
const push = runPrisma(pushArgs, { stdio: 'inherit', encoding: undefined });
if (push.status !== 0) {
  console.error('');
  console.error('`prisma db push` failed.');
  console.error(
    'If Prisma refused due to data loss (column/table drop on a populated\n' +
    'table, type narrowing that would truncate values), back up the DB\n' +
    'first and then re-run with --force-data-loss.',
  );
  process.exit(1);
}

// ── Step 3: regenerate client ─────────────────────────────────────────────

log('');
log('[3/3] Regenerating Prisma client (`prisma generate`)...');
const gen = runPrisma(['generate'], { stdio: 'inherit', encoding: undefined });
if (gen.status !== 0) {
  console.error('');
  console.error('`prisma generate` failed — the DB is synced but the client is stale.');
  console.error(
    'On Windows, EPERM rename on query_engine-windows.dll.node usually means\n' +
    'the backend dev server is still running and is holding the DLL open.\n' +
    'Stop it (Ctrl+C the `npm run dev` terminal), then re-run `npm run db:sync`.',
  );
  process.exit(1);
}

log('');
log('✓ Schema synced and Prisma client regenerated.');
process.exit(0);
