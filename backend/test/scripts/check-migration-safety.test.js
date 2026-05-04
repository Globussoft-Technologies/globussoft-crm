// Unit tests for backend/scripts/check-migration-safety.js — focused on
// the commit-message blessing path added in issue #425.
//
// What's tested here (vs. the e2e/tests/migration-safety.spec.js
// playwright spec):
//   - The Playwright spec drives the script as a child process against
//     real fixture .prisma files and asserts exit codes / log shape. It
//     is the regression suite for the detector outputs.
//   - This vitest unit test exercises the LIBRARY surface of the script
//     directly — `analyse()` + `readBlessingsFromCommitMessage()` —
//     without invoking `prisma migrate diff`. Fast (< 50 ms), no
//     fixtures, no network. Covers the four blessing markers:
//       [allow-unique], [allow-drop], [allow-not-null], [allow-narrow]
//     and the cross-class isolation invariant (a [allow-unique] commit
//     does NOT bless a NOT_NULL_WITHOUT_DEFAULT risk).
//
// Why we test the env override path:
//   The script falls back to env var `MIGRATION_SAFETY_COMMIT_MSG` when
//   set, exactly so this test can feed synthetic commit messages
//   without fabricating real commits. This is the same hatch the
//   playwright spec uses for its blessing-path tests.
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  analyse,
  readBlessingsFromCommitMessage,
} from '../../scripts/check-migration-safety.js';

// Real DDL emitted by `prisma migrate diff` for our fixture pairs.
// Captured once with --verbose to keep this test self-contained — no
// child process invocation needed, no prisma engine dependency.
//
// We do, however, need the `against` schema path so analyse() can run
// `parseFromSchema()` and learn that (e.g.) FixturePost.title was
// already NOT NULL in the baseline — otherwise the NOT_NULL detector
// would falsely fire on the narrowing MODIFY statement (the safety
// script handles this via the FROM-schema nullability map; reproducing
// that branch in pure-fn tests is the same shape).
const FX = path.resolve(__dirname, '..', '..', 'scripts', 'fixtures', 'migration-safety');
const BASELINE = path.join(FX, 'baseline.prisma');

const SQL_DANGEROUS_UNIQUE =
  'CREATE UNIQUE INDEX `FixtureUser_name_key` ON `FixtureUser`(`name`);';
const SQL_DANGEROUS_DROP =
  'ALTER TABLE `FixtureUser` DROP COLUMN `bio`;';
const SQL_DANGEROUS_NOT_NULL =
  'ALTER TABLE `FixtureUser` MODIFY `name` VARCHAR(255) NOT NULL;\n' +
  'ALTER TABLE `FixturePost` ADD COLUMN `requiredField` VARCHAR(50) NOT NULL;';
const SQL_DANGEROUS_NARROWING =
  'ALTER TABLE `FixturePost` MODIFY `title` VARCHAR(50) NOT NULL;';

const NO_BLESSINGS = {
  allowUnique: false,
  allowDrop: false,
  allowNotNull: false,
  allowNarrow: false,
};

describe('check-migration-safety — readBlessingsFromCommitMessage', () => {
  beforeEach(() => {
    delete process.env.MIGRATION_SAFETY_COMMIT_MSG;
  });
  afterEach(() => {
    delete process.env.MIGRATION_SAFETY_COMMIT_MSG;
  });

  test('returns all-false when no markers in env override', () => {
    process.env.MIGRATION_SAFETY_COMMIT_MSG = 'feat(routes): add /foo';
    const b = readBlessingsFromCommitMessage();
    expect(b.allowUnique).toBe(false);
    expect(b.allowDrop).toBe(false);
    expect(b.allowNotNull).toBe(false);
    expect(b.allowNarrow).toBe(false);
  });

  test('detects [allow-unique] marker (case-insensitive)', () => {
    process.env.MIGRATION_SAFETY_COMMIT_MSG = 'fix(schema): add tenantId [Allow-Unique]';
    const b = readBlessingsFromCommitMessage();
    expect(b.allowUnique).toBe(true);
    expect(b.allowDrop).toBe(false);
    expect(b.allowNotNull).toBe(false);
    expect(b.allowNarrow).toBe(false);
  });

  test('detects [allow-drop] marker', () => {
    process.env.MIGRATION_SAFETY_COMMIT_MSG = 'chore: prune dead column [allow-drop]';
    const b = readBlessingsFromCommitMessage();
    expect(b.allowDrop).toBe(true);
    expect(b.allowUnique).toBe(false);
  });

  test('detects [allow-not-null] marker', () => {
    process.env.MIGRATION_SAFETY_COMMIT_MSG = 'fix: backfilled, tightening [allow-not-null]';
    const b = readBlessingsFromCommitMessage();
    expect(b.allowNotNull).toBe(true);
  });

  test('detects [allow-narrow] marker', () => {
    process.env.MIGRATION_SAFETY_COMMIT_MSG = 'refactor: shrink title col [allow-narrow]';
    const b = readBlessingsFromCommitMessage();
    expect(b.allowNarrow).toBe(true);
  });

  test('multiple markers in one message', () => {
    process.env.MIGRATION_SAFETY_COMMIT_MSG =
      'feat(schema): big sweep\n\n[allow-drop] [allow-unique]';
    const b = readBlessingsFromCommitMessage();
    expect(b.allowDrop).toBe(true);
    expect(b.allowUnique).toBe(true);
    expect(b.allowNotNull).toBe(false);
    expect(b.allowNarrow).toBe(false);
  });

  test('similar-but-wrong markers do not match', () => {
    // Defensive: someone writing `[allow_unique]` (underscore) or
    // `allow-unique` (no brackets) should NOT trigger the blessing.
    process.env.MIGRATION_SAFETY_COMMIT_MSG =
      'feat: allow-unique on the column allow_unique [allowunique]';
    const b = readBlessingsFromCommitMessage();
    expect(b.allowUnique).toBe(false);
  });
});

describe('check-migration-safety — analyse() honours commit blessings', () => {
  test('UNIQUE_ADDITION + no blessings → 1 failing risk', () => {
    const report = analyse(SQL_DANGEROUS_UNIQUE, {
      allowDrop: false,
      allowUnique: false,
      blessings: NO_BLESSINGS,
    });
    expect(report.failing.length).toBe(1);
    expect(report.failing[0].class).toBe('UNIQUE_ADDITION');
    expect(report.blessedCount).toBe(0);
  });

  test('UNIQUE_ADDITION + [allow-unique] blessing → 0 failing, 1 blessed', () => {
    const report = analyse(SQL_DANGEROUS_UNIQUE, {
      allowDrop: false,
      allowUnique: false,
      blessings: { ...NO_BLESSINGS, allowUnique: true },
    });
    expect(report.failing.length).toBe(0);
    expect(report.risks.length).toBe(1);
    expect(report.risks[0].suppressed).toBe(true);
    expect(report.risks[0].suppressedBy).toBe('commit-blessing');
    expect(report.blessedCount).toBe(1);
  });

  test('UNIQUE_ADDITION + --allow-unique flag → 0 failing, marked as flag (not blessing)', () => {
    const report = analyse(SQL_DANGEROUS_UNIQUE, {
      allowDrop: false,
      allowUnique: true,
      blessings: NO_BLESSINGS,
    });
    expect(report.failing.length).toBe(0);
    expect(report.risks[0].suppressedBy).toBe('flag');
    expect(report.blessedCount).toBe(0);
  });

  test('COLUMN_DROP + [allow-drop] blessing → 0 failing, 1 blessed', () => {
    const report = analyse(SQL_DANGEROUS_DROP, {
      allowDrop: false,
      allowUnique: false,
      blessings: { ...NO_BLESSINGS, allowDrop: true },
    });
    expect(report.failing.length).toBe(0);
    expect(report.blessedCount).toBe(1);
    expect(report.risks[0].class).toBe('COLUMN_DROP');
    expect(report.risks[0].suppressedBy).toBe('commit-blessing');
  });

  test('NOT_NULL_WITHOUT_DEFAULT + [allow-not-null] blessing → 0 failing, all blessed', () => {
    const report = analyse(SQL_DANGEROUS_NOT_NULL, {
      allowDrop: false,
      allowUnique: false,
      blessings: { ...NO_BLESSINGS, allowNotNull: true },
    });
    expect(report.failing.length).toBe(0);
    // Two NOT_NULL risks in this fixture (existing column + new column)
    expect(report.risks.filter(r => r.class === 'NOT_NULL_WITHOUT_DEFAULT').length).toBe(2);
    expect(report.blessedCount).toBe(2);
  });

  test('TYPE_NARROWING + [allow-narrow] blessing → 0 failing, 1 blessed', () => {
    // `against` is required so the NOT_NULL detector can see that
    // FixturePost.title was already NOT NULL in the baseline and skip
    // the MODIFY — without this context the synthetic SQL also fires
    // NOT_NULL_WITHOUT_DEFAULT (which is correct conservative behaviour
    // when no FROM-schema context is available).
    const report = analyse(SQL_DANGEROUS_NARROWING, {
      allowDrop: false,
      allowUnique: false,
      against: BASELINE,
      blessings: { ...NO_BLESSINGS, allowNarrow: true },
    });
    expect(report.failing.length).toBe(0);
    expect(report.blessedCount).toBe(1);
    expect(report.risks[0].class).toBe('TYPE_NARROWING');
  });

  test('cross-class isolation: [allow-unique] does NOT bless NOT_NULL_WITHOUT_DEFAULT', () => {
    // The whole point of having distinct markers — author saying "I
    // verified the unique add" mustn't accidentally also wave through
    // a NOT-NULL backfill bomb.
    const report = analyse(SQL_DANGEROUS_NOT_NULL, {
      allowDrop: false,
      allowUnique: false,
      blessings: { ...NO_BLESSINGS, allowUnique: true },
    });
    expect(report.failing.length).toBe(2);
    expect(report.failing.every(r => r.class === 'NOT_NULL_WITHOUT_DEFAULT')).toBe(true);
    expect(report.blessedCount).toBe(0);
  });

  test('cross-class isolation: [allow-not-null] does NOT bless UNIQUE_ADDITION', () => {
    const report = analyse(SQL_DANGEROUS_UNIQUE, {
      allowDrop: false,
      allowUnique: false,
      blessings: { ...NO_BLESSINGS, allowNotNull: true },
    });
    expect(report.failing.length).toBe(1);
    expect(report.failing[0].class).toBe('UNIQUE_ADDITION');
    expect(report.blessedCount).toBe(0);
  });

  test('no blessings object provided → defaults to all-false (backwards compat)', () => {
    // Pre-#425 callers passed { allowDrop, allowUnique } without a
    // blessings field. The default object inside analyse() must keep
    // their behaviour identical.
    const report = analyse(SQL_DANGEROUS_UNIQUE, {
      allowDrop: false,
      allowUnique: false,
    });
    expect(report.failing.length).toBe(1);
    expect(report.blessedCount).toBe(0);
  });
});
