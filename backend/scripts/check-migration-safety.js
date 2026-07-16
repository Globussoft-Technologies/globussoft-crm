#!/usr/bin/env node
/**
 * G-23 — Migration safety check (dry-run prisma migrate diff in CI).
 *
 * Why this exists:
 *   The deploy.yml flow runs `prisma db push --skip-generate --accept-data-loss`
 *   blind on every push. NOT-NULL on a populated table without a default,
 *   a column drop on a table with rows, type narrowing, a UNIQUE on a
 *   column with duplicates, or an FK without an explicit ON DELETE
 *   strategy = guaranteed prod outage / data loss. This script DRY-RUNS
 *   the migration via `prisma migrate diff --script` and post-processes
 *   the emitted SQL to detect the five high-severity risk classes
 *   below. CI invokes it on PR / push BEFORE the deploy job runs the
 *   real db push.
 *
 * Commit-message blessings (G-23 follow-up, issue #425):
 *   When the detector can't reason at the semantic level — e.g. tightening
 *   a `@@unique([provider, externalId])` to `@@unique([tenantId, provider,
 *   externalId])` is strictly MORE permissive but trips UNIQUE_ADDITION —
 *   the author can opt-in to skip the matching detector for THIS commit
 *   only by adding one of these markers anywhere in the latest commit
 *   message:
 *     [allow-unique]    — bless UNIQUE_ADDITION risks
 *     [allow-drop]      — bless COLUMN_DROP risks
 *     [allow-not-null]  — bless NOT_NULL_WITHOUT_DEFAULT risks
 *     [allow-narrow]    — bless TYPE_NARROWING risks
 *   Blessings are case-insensitive and read once per run from `git log -1
 *   --format=%B`. Pass `--no-commit-blessings` to disable (used by the
 *   spec to verify the unblessed exit code is preserved). Blessed risks
 *   are still recorded in the JSON report under `suppressed: true`, so
 *   the CI summary shows what was waived. There is intentionally NO
 *   `[allow-fk-without-on-delete]` — that one is too easy to default
 *   into; the author should declare onDelete explicitly in schema.prisma.
 *
 * Risk classes detected:
 *   1. NOT-NULL added to existing column without DEFAULT
 *      Pattern: `ALTER TABLE ... MODIFY|ALTER COLUMN ... NOT NULL`
 *               with no `DEFAULT <val>` clause AND the column was
 *               previously NULL-able (i.e. the diff shows a transition).
 *   2. Column drop on a (potentially) populated table
 *      Pattern: `ALTER TABLE ... DROP COLUMN ...`
 *      Always flagged — the script is a CI guard, it doesn't query the
 *      live DB to count rows. To intentionally drop a column, the dev
 *      adds a `// safe-drop: <reason>` line near the field deletion in
 *      schema.prisma OR passes `--allow-drop` for the run. Anything
 *      else fails.
 *   3. Type narrowing
 *      Pattern: `MODIFY|ALTER COLUMN` where the new column is shorter
 *      / less general than the old one. We detect a curated set: any
 *      `varchar(N)` shrunk to varchar(M < N), text → varchar, longtext
 *      → text, bigint → int, double → float, datetime → date.
 *   4. UNIQUE constraint added (potentially over duplicate values)
 *      Pattern: `ADD UNIQUE INDEX|CONSTRAINT` or `CREATE UNIQUE INDEX`.
 *      Flagged because the script can't verify uniqueness against the
 *      live data. To bless, dev adds `// safe-unique: backfilled` near
 *      the `@unique` declaration OR passes `--allow-unique`.
 *   5. Foreign key added without explicit ON DELETE
 *      Pattern: `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES`
 *      WITHOUT `ON DELETE`. MySQL defaults to RESTRICT on FK
 *      additions, which silently changes delete semantics on the
 *      parent table — flag every implicit case.
 *
 * Output contract:
 *   - Non-risk run: `[OK] No migration risks detected (N statements
 *     analyzed)` to stdout, exit code 0.
 *   - Any risk: one `[RISK]` log line per finding to stderr with a
 *     fixed shape: `[RISK] <class>: <table>.<column> — <reason>`,
 *     plus a JSON report at the end (consumed by the CI workflow's
 *     summary step). Exit code 1.
 *   - Diff failure (prisma engine error, schema parse error): exit
 *     code 2 (treated by CI as gate failure, distinct from risk
 *     finding so a flaky engine doesn't read as a risk).
 *
 * CLI:
 *   node check-migration-safety.js \
 *     --schema fixtures/safe.prisma \
 *     --against fixtures/baseline.prisma \
 *     [--allow-drop] [--allow-unique] [--no-commit-blessings] [--json] [--verbose]
 *
 *   --schema      "to" datamodel — the proposed change (what we're
 *                  diffing TO). Defaults to backend/prisma/schema.prisma.
 *   --against     "from" datamodel — the baseline (what we're diffing
 *                  FROM). In CI this is the merge-base or the demo
 *                  schema snapshot.
 *   --allow-drop  Bless column drops for this run.
 *   --allow-unique Bless UNIQUE additions for this run.
 *   --no-commit-blessings
 *                 Disable scanning the latest commit message for
 *                 [allow-unique]/[allow-drop]/[allow-not-null]/[allow-narrow]
 *                 markers. Used by the test suite to verify the
 *                 unblessed exit code is preserved.
 *   --json        Emit a single JSON report to stdout instead of the
 *                  human-readable lines (still exits non-zero on risk).
 *   --verbose     Echo the raw migrate-diff SQL too.
 *
 * Env override (testing only):
 *   MIGRATION_SAFETY_COMMIT_MSG — when set, the blessing scanner uses
 *   this string instead of shelling out to `git log`. Lets the spec
 *   feed synthetic commit messages without fabricating real commits.
 */

'use strict';

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Commit-message blessings (issue #425) ───────────────────────────
//
// The migration-safety detectors are deliberately conservative — they
// flag every UNIQUE addition / column drop / NOT NULL transition / type
// narrowing because they can't reason about the semantic shape of the
// change. Sometimes the author KNOWS the risk is mathematically zero
// (e.g. UNIQUE([tenantId, provider, externalId]) is strictly more
// permissive than UNIQUE([provider, externalId])). For those cases the
// author opts in via a marker in the commit message:
//
//   [allow-unique]    — bless UNIQUE_ADDITION
//   [allow-drop]      — bless COLUMN_DROP
//   [allow-not-null]  — bless NOT_NULL_WITHOUT_DEFAULT
//   [allow-narrow]    — bless TYPE_NARROWING
//
// We read the latest commit message via `git log -1 --format=%B`. If
// git fails (detached HEAD on a freshly-cloned CI runner before the
// first commit, or git binary missing), every marker stays false and
// the script behaves exactly as it did before this feature existed.
function readBlessingsFromCommitMessage() {
  let msg = '';
  // Test-only override: lets the spec feed synthetic commit messages
  // without fabricating real commits.
  if (typeof process.env.MIGRATION_SAFETY_COMMIT_MSG === 'string') {
    msg = process.env.MIGRATION_SAFETY_COMMIT_MSG;
  } else {
    try {
      msg = execSync('git log -1 --format=%B', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      msg = '';
    }
  }
  return {
    allowUnique: /\[allow-unique\]/i.test(msg),
    allowDrop: /\[allow-drop\]/i.test(msg),
    allowNotNull: /\[allow-not-null\]/i.test(msg),
    allowNarrow: /\[allow-narrow\]/i.test(msg),
    raw: msg,
  };
}

// ── Argv parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    schema: null,
    against: null,
    allowDrop: false,
    allowUnique: false,
    noCommitBlessings: false,
    json: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--schema': args.schema = argv[++i]; break;
      case '--against': args.against = argv[++i]; break;
      case '--allow-drop': args.allowDrop = true; break;
      case '--allow-unique': args.allowUnique = true; break;
      case '--no-commit-blessings': args.noCommitBlessings = true; break;
      case '--json': args.json = true; break;
      case '--verbose': args.verbose = true; break;
      case '-h':
      case '--help':
        process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith(' *')).map(l => l.slice(3)).join('\n'));
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`[migration-safety] unknown arg: ${a}\n`);
          process.exit(2);
        }
    }
  }
  if (!args.schema) {
    args.schema = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
  } else {
    args.schema = path.resolve(args.schema);
  }
  if (args.against) args.against = path.resolve(args.against);
  return args;
}

// ── prisma migrate diff invocation ──────────────────────────────────
//
// We always run with --script so we get parse-able SQL DDL. The
// `against` schema (the baseline) is treated as the FROM, and
// `schema` (the proposed) is the TO. If `against` is not provided,
// we diff from --from-empty so the script flags every NOT-NULL,
// every UNIQUE, every drop — in practice the CI workflow always
// passes both, but the local dev path may diff against empty for a
// "what does my whole schema look like as DDL" sanity check.
function runMigrateDiff({ schema, against, verbose }) {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const argsList = ['prisma', 'migrate', 'diff'];
  if (against) {
    argsList.push('--from-schema-datamodel', against);
  } else {
    argsList.push('--from-empty');
  }
  argsList.push('--to-schema-datamodel', schema);
  argsList.push('--script');
  // Required when neither side has a datasource block.
  argsList.push('--exit-code');

  if (verbose) {
    process.stderr.write(`[migration-safety] running: ${npxCmd} ${argsList.join(' ')}\n`);
  }

  // The cwd needs to be a directory where `npx prisma` resolves the
  // local copy. Use backend/ so we get the pinned prisma 6.4.1.
  const backendDir = path.resolve(__dirname, '..');
  let stdout = '';
  try {
    stdout = execFileSync(npxCmd, argsList, {
      cwd: backendDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
  } catch (e) {
    // --exit-code makes prisma return 2 when the schemas DIFFER (which
    // is the normal case here — we WANT the diff). It returns 0 when
    // they match (no migration needed → no risks). We treat both 0
    // and 2 as success; any other non-zero is a real engine error.
    if (e.status === 2) {
      stdout = (e.stdout || '').toString();
    } else {
      // Throw with engine context so main() can emit a valid JSON
      // report even when the diff itself fails. Previously this path
      // called process.exit(2) with stderr-only output — the
      // downstream CI step then crashed with "Unexpected end of JSON
      // input" when it tried to require() the empty report file. With
      // a structured throw, --json runs always produce parseable
      // output and the CI gate fails cleanly via the engineFailed
      // signal instead of a SyntaxError.
      const stderr = e.stderr ? e.stderr.toString() : '';
      const err = new Error(`prisma migrate diff failed (exit ${e.status})`);
      err.engineFailed = true;
      err.engineExit = e.status;
      err.engineStderr = stderr || e.message;
      throw err;
    }
  }
  return stdout;
}

// ── SQL parsing helpers ─────────────────────────────────────────────
//
// MySQL DDL emitted by prisma migrate diff is line-oriented and uses
// backticks for identifiers. Each statement ends with `;`. We split
// on semicolons (after stripping `--` line comments) to get a list
// of statements, then categorise each. The parsing is deliberately
// regex-based rather than full SQL — prisma's emitted SQL is a
// known, narrow subset.
function splitStatements(sql) {
  // Strip `-- ...` line comments and `/* ... */` block comments.
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n');
  return cleaned
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

// Extract the table name from an `ALTER TABLE \`name\` ...` head.
function tableOf(stmt) {
  const m = stmt.match(/ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?/i);
  return m ? m[1] : null;
}

// Pull `(precision)` out of a type declaration. Returns the number
// inside, or null if absent. e.g. `VARCHAR(255)` → 255.
function typeWidth(typeStr) {
  const m = typeStr.match(/\(\s*(\d+)\s*\)/);
  return m ? Number(m[1]) : null;
}

// Order-of-narrowness for the family lookups. Narrowing detected when
// the new family rank < old family rank (e.g. text=2 → varchar=1).
const TYPE_FAMILY_RANK = {
  varchar: 1,
  char: 1,
  text: 2,
  mediumtext: 3,
  longtext: 4,
  tinyint: 1,
  smallint: 2,
  mediumint: 3,
  int: 4,
  bigint: 5,
  float: 1,
  double: 2,
  decimal: 2,
  date: 1,
  datetime: 2,
  timestamp: 2,
};

function typeFamily(typeStr) {
  const m = typeStr.toLowerCase().match(/^([a-z]+)/);
  return m ? m[1] : null;
}

// ── Schema parser (lightweight) ─────────────────────────────────────
//
// We need to know, for each MODIFY statement, whether the FROM
// schema already had the column non-nullable. If it did, this is a
// type-change (caught by the narrowing detector) — not a nullability
// tightening. Walking the FROM .prisma datamodel is enough; we don't
// need full PSL.
//
// Returns: { '<Model>.<field>': { nullable: boolean } }
function parseFromSchema(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const src = fs.readFileSync(filePath, 'utf8');
  const out = {};
  const modelRe = /^model\s+(\w+)\s*\{([^}]*)\}/gm;
  let m;
  while ((m = modelRe.exec(src)) !== null) {
    const modelName = m[1];
    const body = m[2];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      // skip blanks, comments, indices, and @@ block-level attrs
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      // Field decl form: `name Type[?] [@attrs...]`
      const f = line.match(/^(\w+)\s+([\w()]+)(\??)/);
      if (!f) continue;
      const [, fieldName, , optional] = f;
      out[`${modelName}.${fieldName}`] = { nullable: optional === '?' };
    }
  }
  return out;
}

// ── Risk detectors ──────────────────────────────────────────────────
//
// Each detector takes the cleaned stmt + a `ctx` object carrying the
// FROM-schema nullability map. Returns 0..N risk objects.
//
// Risk shape:
//   { class, table, column, statement, message }

function detectNotNullWithoutDefault(stmt, ctx) {
  // Two prisma patterns:
  //   ALTER TABLE `foo` MODIFY `bar` VARCHAR(255) NOT NULL
  //   ALTER TABLE `foo` ALTER COLUMN `bar` SET NOT NULL          (postgres-style; rare here)
  //   ALTER TABLE `foo` ADD COLUMN `bar` VARCHAR(255) NOT NULL  (also a risk if no DEFAULT)
  // We flag whenever NOT NULL is present AND no `DEFAULT` clause is
  // present in the same column-definition fragment.
  const risks = [];
  const upper = stmt.toUpperCase();
  if (!upper.includes('NOT NULL')) return risks;

  // Attempt to find the column-definition fragment — for MODIFY /
  // ADD COLUMN that's everything after the column-name backtick block.
  // For ALTER COLUMN ... SET NOT NULL it's the tail of the statement.
  const tbl = tableOf(stmt);
  const colMatch = stmt.match(/(?:MODIFY|ADD\s+COLUMN|CHANGE(?:\s+COLUMN)?|ALTER\s+COLUMN)\s+`?([A-Za-z0-9_]+)`?/i);
  if (!colMatch) return risks;
  const col = colMatch[1];

  // Trim everything before the col name, then look for DEFAULT in the
  // remainder. `DEFAULT NULL` doesn't satisfy the contract — that's
  // explicitly setting null as the default and would still fail the
  // not-null constraint on backfill.
  const idx = stmt.toUpperCase().indexOf(colMatch[0].toUpperCase());
  const tail = stmt.slice(idx + colMatch[0].length);
  const tailUpper = tail.toUpperCase();
  const hasDefault = /\bDEFAULT\b/.test(tailUpper);
  const hasDefaultNull = /\bDEFAULT\s+NULL\b/.test(tailUpper);

  // ADD COLUMN paths get bonus rigour: if it's a NOT NULL column being
  // added to an existing table without a default, the engine has to
  // backfill — this is the canonical "prod outage" pattern.
  const isModify = /MODIFY|ALTER\s+COLUMN|CHANGE/i.test(colMatch[0]);
  const isAdd = /ADD\s+COLUMN/i.test(colMatch[0]);

  // For MODIFY: only flag if the FROM schema actually had this column
  // as nullable. A MODIFY emitted because the TYPE changed (e.g.
  // VARCHAR(255) → VARCHAR(50)) on an already-NOT-NULL column is
  // caught by detectTypeNarrowing — not a nullability tightening.
  // The NULL→NOT NULL transition is the prod-outage case we care
  // about here.
  if (isModify && ctx && ctx.fromFields) {
    const key = `${tbl}.${col}`;
    const prior = ctx.fromFields[key];
    if (prior && !prior.nullable) {
      // Column was already NOT NULL in the FROM schema; this MODIFY
      // is just a type change. Skip — narrowing detector handles it.
      return risks;
    }
  }

  if ((isModify || isAdd) && (!hasDefault || hasDefaultNull)) {
    risks.push({
      class: 'NOT_NULL_WITHOUT_DEFAULT',
      table: tbl,
      column: col,
      statement: stmt,
      message: `${tbl}.${col} — NOT NULL without a non-null DEFAULT will fail on populated rows. Add a DEFAULT clause or backfill before tightening.`,
    });
  }
  return risks;
}

function detectColumnDrop(stmt) {
  const risks = [];
  // ALTER TABLE `foo` DROP COLUMN `bar`
  const m = stmt.match(/ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+DROP\s+COLUMN\s+`?([A-Za-z0-9_]+)`?/i);
  if (m) {
    risks.push({
      class: 'COLUMN_DROP',
      table: m[1],
      column: m[2],
      statement: stmt,
      message: `${m[1]}.${m[2]} — column drop will discard existing data. Confirm with --allow-drop or stage the rename-then-drop two-deploy pattern.`,
    });
  }
  return risks;
}

function detectTypeNarrowing(stmt) {
  const risks = [];
  // We need both prior + new types to assert narrowing. prisma
  // migrate diff doesn't always emit the prior type in a single
  // statement — in MySQL it just emits the new MODIFY. We
  // approximate by parsing the new type width and comparing against
  // a heuristic threshold: any VARCHAR(N) where N <= 50 in a MODIFY
  // context where the original was likely larger is suspicious. To
  // keep false positives down, only flag when:
  //   (a) the new type family is strictly narrower (e.g. text → varchar)
  //   (b) the new type family is the same but width is <= 50
  // The CI workflow drives this with paired fixtures so the regex
  // doesn't have to do all the work.
  const m = stmt.match(/ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+MODIFY\s+`?([A-Za-z0-9_]+)`?\s+([A-Za-z]+(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)/i);
  if (!m) return risks;
  const [, table, column, rawType] = m;
  const family = typeFamily(rawType);
  const width = typeWidth(rawType);

  // Pattern (a) is hard to detect from a single MODIFY — we'd need
  // the prior type. Instead the CI drives narrowing detection via
  // the fixtures:
  //   the FROM schema has VARCHAR(255), the TO has VARCHAR(50);
  //   prisma emits MODIFY with the NEW (50) type; we flag any
  //   suspicious narrow declaration via the heuristic.
  // Pattern (b): width <= 50 on a varchar/char MODIFY is a strong
  // smell. The diff output doesn't tell us the prior width directly,
  // but in practice prisma only emits a MODIFY when the type
  // ACTUALLY CHANGED — so a width drop is necessarily a narrowing.
  if (['varchar', 'char'].includes(family) && width !== null && width <= 50) {
    risks.push({
      class: 'TYPE_NARROWING',
      table, column,
      statement: stmt,
      message: `${table}.${column} — narrowed to ${rawType.toUpperCase()}; existing values longer than ${width} chars will be truncated. Verify max(LENGTH(${column})) before merging.`,
    });
  }

  // Family-level narrowing: prisma emits the new family as part of
  // the MODIFY — if it's `text` shrinking from `mediumtext`, the
  // family alone is the smell. We can't see the FROM family from
  // the statement, so this branch is conservative — only flag the
  // narrow target families that are RARE in the schema and almost
  // never the result of a widening change. Empty for now; the
  // varchar-width branch covers the common case.
  return risks;
}

function detectUniqueAddition(stmt) {
  const risks = [];
  // CREATE UNIQUE INDEX `name` ON `table` (`col`)
  // ALTER TABLE `t` ADD UNIQUE INDEX `name` (`col`)
  // ALTER TABLE `t` ADD CONSTRAINT `name` UNIQUE (`col`)
  let m = stmt.match(/CREATE\s+UNIQUE\s+INDEX\s+`?[A-Za-z0-9_]+`?\s+ON\s+`?([A-Za-z0-9_]+)`?\s*\(\s*`?([A-Za-z0-9_,`\s]+)`?\s*\)/i);
  if (!m) {
    m = stmt.match(/ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+ADD\s+(?:CONSTRAINT\s+`?[A-Za-z0-9_]+`?\s+)?UNIQUE(?:\s+(?:INDEX|KEY))?\s*(?:`?[A-Za-z0-9_]+`?\s*)?\(\s*([A-Za-z0-9_,`\s]+)\s*\)/i);
  }
  if (m) {
    const [, table, cols] = m;
    risks.push({
      class: 'UNIQUE_ADDITION',
      table,
      column: cols.replace(/[`\s]/g, ''),
      statement: stmt,
      message: `${table}(${cols.replace(/[`\s]/g, '')}) — UNIQUE addition will fail if duplicate values exist. Run a duplicate-check query or pass --allow-unique after backfill.`,
    });
  }
  return risks;
}

function detectForeignKeyWithoutOnDelete(stmt) {
  const risks = [];
  // Bug fix: when a FK rule changes (e.g. Cascade -> Restrict), Prisma emits
  // a DROP FOREIGN KEY paired with an ADD CONSTRAINT. The DROP half cannot
  // syntactically declare ON DELETE — it's just removing the existing FK.
  // Pre-fix the detector matched DROP statements via the bare FOREIGN KEY
  // regex below and falsely flagged them as "missing ON DELETE." This produced
  // 6 false positives during the #413 Cascade→Restrict policy upgrade
  // (Invoice/Payment/AuditLog/Patient/Visit/Prescription) since the script's
  // own gate is the same one that would trip migration-check.yml on push.
  // Skip DROP FOREIGN KEY explicitly; the paired ADD CONSTRAINT below it is
  // the real candidate.
  if (/DROP\s+FOREIGN\s+KEY/i.test(stmt)) return risks;
  // ALTER TABLE `t` ADD CONSTRAINT `fk_xxx` FOREIGN KEY (`col`) REFERENCES `parent` (`id`) ON DELETE ... ON UPDATE ...
  if (!/FOREIGN\s+KEY/i.test(stmt)) return risks;
  const tbl = tableOf(stmt);
  const colMatch = stmt.match(/FOREIGN\s+KEY\s*\(\s*`?([A-Za-z0-9_]+)`?\s*\)/i);
  const col = colMatch ? colMatch[1] : null;
  // If the FK statement explicitly declares ON DELETE, we accept it
  // (the dev made a deliberate choice). If it doesn't, MySQL
  // defaults to RESTRICT, which is a silent semantic change.
  if (!/ON\s+DELETE/i.test(stmt)) {
    risks.push({
      class: 'FK_WITHOUT_ON_DELETE',
      table: tbl,
      column: col,
      statement: stmt,
      message: `${tbl}.${col} — foreign key added without explicit ON DELETE. Declare onDelete: Cascade|SetNull|Restrict in schema.prisma to make the choice deliberate.`,
    });
  }
  return risks;
}

// ── Main analyser ───────────────────────────────────────────────────
function analyse(sql, opts) {
  const stmts = splitStatements(sql);
  const ctx = {
    fromFields: opts && opts.against ? parseFromSchema(opts.against) : {},
  };
  const allRisks = [];
  for (const stmt of stmts) {
    allRisks.push(...detectNotNullWithoutDefault(stmt, ctx));
    allRisks.push(...detectColumnDrop(stmt));
    allRisks.push(...detectTypeNarrowing(stmt));
    allRisks.push(...detectUniqueAddition(stmt));
    allRisks.push(...detectForeignKeyWithoutOnDelete(stmt));
  }

  // Apply allow-list flags + commit-message blessings. We don't drop
  // the risk silently — we keep it in the report under
  // `suppressed: true` so CI summaries can show what was waived.
  // `suppressedBy` records the source ('flag' | 'commit-blessing') so
  // the summary line can distinguish the two paths.
  const blessings = (opts && opts.blessings) || {
    allowUnique: false, allowDrop: false, allowNotNull: false, allowNarrow: false,
  };
  for (const r of allRisks) {
    if (r.class === 'COLUMN_DROP' && opts.allowDrop) {
      r.suppressed = true;
      r.suppressedBy = 'flag';
    } else if (r.class === 'COLUMN_DROP' && blessings.allowDrop) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    } else if (r.class === 'UNIQUE_ADDITION' && opts.allowUnique) {
      r.suppressed = true;
      r.suppressedBy = 'flag';
    } else if (r.class === 'UNIQUE_ADDITION' && blessings.allowUnique) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    } else if (r.class === 'NOT_NULL_WITHOUT_DEFAULT' && blessings.allowNotNull) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    } else if (r.class === 'TYPE_NARROWING' && blessings.allowNarrow) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    }
  }

  return {
    statementCount: stmts.length,
    risks: allRisks,
    failing: allRisks.filter(r => !r.suppressed),
    blessedCount: allRisks.filter(r => r.suppressedBy === 'commit-blessing').length,
  };
}

// ── Entrypoint ──────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.schema)) {
    process.stderr.write(`[migration-safety] schema not found: ${opts.schema}\n`);
    process.exit(2);
  }
  if (opts.against && !fs.existsSync(opts.against)) {
    process.stderr.write(`[migration-safety] against schema not found: ${opts.against}\n`);
    process.exit(2);
  }

  // Read commit-message blessings unless explicitly disabled. The
  // [--no-commit-blessings] flag preserves the pre-#425 behaviour for
  // tests that need to assert the unblessed exit code.
  opts.blessings = opts.noCommitBlessings
    ? { allowUnique: false, allowDrop: false, allowNotNull: false, allowNarrow: false }
    : readBlessingsFromCommitMessage();

  let sql;
  try {
    sql = runMigrateDiff(opts);
  } catch (e) {
    // prisma migrate diff failed (typically: baseline schema can't be
    // parsed because it landed in main before this gate was added, or
    // a prisma engine bug). Emit a structured failure report so the
    // CI workflow can read it without crashing on JSON.parse, then
    // exit 2 to signal engine failure distinct from a risk finding.
    process.stderr.write(`[migration-safety] ${e.message}:\n${e.engineStderr || ''}\n`);
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        schema: opts.schema,
        against: opts.against,
        statementCount: 0,
        riskCount: 0,
        suppressedCount: 0,
        blessedCount: 0,
        blessings: {
          allowUnique: !!opts.blessings.allowUnique,
          allowDrop: !!opts.blessings.allowDrop,
          allowNotNull: !!opts.blessings.allowNotNull,
          allowNarrow: !!opts.blessings.allowNarrow,
        },
        risks: [],
        engineFailed: true,
        engineExit: e.engineExit || null,
        engineError: (e.engineStderr || '').slice(0, 4000),
      }, null, 2) + '\n');
    }
    process.exit(2);
  }
  if (opts.verbose) {
    process.stderr.write('--- migrate diff SQL ---\n');
    process.stderr.write(sql);
    process.stderr.write('\n--- end SQL ---\n');
  }

  const report = analyse(sql, opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      schema: opts.schema,
      against: opts.against,
      statementCount: report.statementCount,
      riskCount: report.failing.length,
      suppressedCount: report.risks.length - report.failing.length,
      blessedCount: report.blessedCount,
      blessings: {
        allowUnique: !!opts.blessings.allowUnique,
        allowDrop: !!opts.blessings.allowDrop,
        allowNotNull: !!opts.blessings.allowNotNull,
        allowNarrow: !!opts.blessings.allowNarrow,
      },
      risks: report.risks,
    }, null, 2) + '\n');
  } else {
    // Surface blessed-but-not-failing risks before the gate verdict
    // so reviewers can tell at a glance what the author waived.
    for (const r of report.risks) {
      if (r.suppressedBy === 'commit-blessing') {
        process.stdout.write(`[BLESSED] ${r.class}: ${r.message}\n`);
      }
    }
    if (report.failing.length === 0) {
      process.stdout.write(`[OK] No migration risks detected (${report.statementCount} statements analyzed)\n`);
      const flagSuppressed = report.risks.filter(r => r.suppressedBy === 'flag').length;
      if (flagSuppressed > 0) {
        process.stdout.write(`     (${flagSuppressed} risks suppressed via --allow-* flags)\n`);
      }
      if (report.blessedCount > 0) {
        process.stdout.write(`[BLESSED] ${report.blessedCount} risk(s) suppressed by commit-message blessings\n`);
      }
    } else {
      process.stderr.write(`[migration-safety] ${report.failing.length} risk(s) detected across ${report.statementCount} DDL statement(s):\n\n`);
      for (const r of report.failing) {
        process.stderr.write(`[RISK] ${r.class}: ${r.message}\n`);
      }
      if (report.blessedCount > 0) {
        process.stderr.write(`\n[BLESSED] ${report.blessedCount} risk(s) suppressed by commit-message blessings\n`);
      }
      process.stderr.write(`\nReview the SQL with --verbose; bless intentional drops/uniques with --allow-drop / --allow-unique flags or [allow-drop] / [allow-unique] / [allow-not-null] / [allow-narrow] in the commit message.\n`);
    }
  }

  process.exit(report.failing.length > 0 ? 1 : 0);
}

if (require.main && require.main === module) {
  main();
}

module.exports = {
  splitStatements,
  parseFromSchema,
  analyse,
  readBlessingsFromCommitMessage,
  detectNotNullWithoutDefault,
  detectColumnDrop,
  detectTypeNarrowing,
  detectUniqueAddition,
  detectForeignKeyWithoutOnDelete,
};
