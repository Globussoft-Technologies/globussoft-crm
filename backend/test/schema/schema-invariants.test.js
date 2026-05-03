// @ts-check
/**
 * Schema invariants — vitest unit test for backend/prisma/schema.prisma.
 *
 * Why this exists (G-24 from docs/E2E_GAPS.md):
 *   Adding a new Prisma model without a `tenantId` column is the single
 *   highest-severity bug class for a multi-tenant CRM — it produces a
 *   silent cross-tenant data leak. The api_tests gate (Playwright)
 *   catches MOST tenant-scoping bugs at the route level; e.g. the v3.4.0
 *   sweep around #408/#409 surfaced "the route forgot the tenantWhere
 *   filter" defects that were one-line fixes. But "the table itself has
 *   no tenantId column" is not fixable at the route layer — it requires
 *   a schema migration. This test pulls the invariant down to the
 *   schema level so a careless `prisma migrate dev` cannot ship a
 *   tenant-unscoped table to production.
 *
 * What it asserts:
 *   1. Every Prisma model NOT on the NON_TENANT_MODELS whitelist has a
 *      `tenantId Int` column. (Hard fail — data-leak gate.)
 *   2. Every model with a `deletedAt` field declares it as `DateTime?`
 *      (nullable). The codebase's soft-delete query pattern assumes
 *      `deletedAt: { not: null }`; a required `deletedAt` would silently
 *      break the routes' filters.
 *   3. AuditLog has the documented shape (action, entity, entityId,
 *      details, userId, tenantId, createdAt). The shape is load-bearing
 *      for the audit viewer + GDPR export and must not drift.
 *
 * Soft warnings (printed but don't fail the suite):
 *   - Models that have `tenantId Int` but lack a formal
 *     `tenant Tenant @relation(...)` line. ~50 models in the legacy
 *     schema fall into this bucket; converting them is a separate
 *     architectural cleanup, tracked as its own [schema] [P1] issue.
 *     The data-leak invariant only requires the column; the relation
 *     is a convenience for joins/cascades.
 *   - `@@unique([...])` constraints without an inline comment
 *     explaining why. Load-bearing constraints SHOULD be documented
 *     so future migrations don't silently drop them.
 *
 * How to extend (the maintenance contract):
 *   When adding a NEW Prisma model:
 *     - Tenant-scoped (the default): add `tenantId Int @default(1)` and
 *       `tenant Tenant @relation(fields: [tenantId], references: [id],
 *       onDelete: Cascade)`. The test will pass.
 *     - Intentionally GLOBAL (e.g. industry templates shared across all
 *       tenants): add the model name to NON_TENANT_MODELS below WITH a
 *       trailing comment explaining why. The test's whitelist IS the
 *       documentation — every entry is one decision-record.
 *   When changing the AuditLog shape:
 *     - The audit viewer + GDPR export both consume this contract. Bump
 *       both the schema and the EXPECTED_AUDIT_LOG_FIELDS list below
 *       in the same PR, AND add a migration test asserting back-fills
 *       are populated for any new required column. Don't ship one
 *       without the other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

// __dirname isn't defined under ESM; reconstruct it from import.meta.url
// so the schema path resolves the same way as in CJS-style tests.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.resolve(__dirname, '../../prisma/schema.prisma');
const SCHEMA = fs.readFileSync(SCHEMA_PATH, 'utf8');

// ── Schema parser ────────────────────────────────────────────────────
//
// Walks the schema text, locates `model X { ... }` blocks, and returns
// `{ name, body }` pairs. Uses a depth counter rather than a single
// regex because while Prisma model bodies don't currently nest braces,
// `@@unique([...])` and `@relation(...)` arguments have brackets that
// could trip up a naive `[^}]*` regex if the grammar evolves.
function parseModels(src) {
  const models = [];
  const re = /^model\s+(\w+)\s*\{/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    models.push({ name, body });
  }
  return models;
}

// ── Whitelist: models intentionally NOT tenant-scoped ────────────────
//
// Every entry MUST have a comment explaining WHY it's exempt. The
// comment is the documentation — code review of additions to this
// set IS the schema-level approval gate for new tenant-unscoped
// tables. When in doubt, do NOT add a model here; default to
// tenant-scoping it.
const NON_TENANT_MODELS = new Set([
  // The tenancy boundary itself. By definition has no parent tenant.
  'Tenant',
  // Junction / child tables that derive their tenant scope from a parent
  // entity (CustomField/CustomValue → CustomEntity → tenant; SequenceStep
  // → Sequence → tenant; QuoteLineItem → Quote → tenant; EstimateLineItem
  // → Estimate → tenant). Tenant filtering MUST happen on the parent in
  // these cases — see the route handlers, which always join through the
  // parent's tenantId.
  'CustomField',
  'CustomValue',
  'SequenceStep',
  'QuoteLineItem',
  'EstimateLineItem',
  // Globally-shared templates (real-estate, healthcare, education, legal,
  // saas) — seeded once, read by all tenants when they pick an industry.
  // Read-only from a tenant's perspective; no tenant data lives here.
  'IndustryTemplate',
]);

// ── Expected AuditLog shape ──────────────────────────────────────────
//
// Field name → required regex pattern matched against the model body.
// If you change the AuditLog schema, update this list IN THE SAME PR
// — see header. Order doesn't matter; we just check each pattern hits.
const EXPECTED_AUDIT_LOG_FIELDS = [
  // action — string, required, enum-like values (CREATE/UPDATE/DELETE).
  { name: 'action', pattern: /^\s*action\s+String\b/m },
  // entity — string, required (Contact/Deal/Invoice/...).
  { name: 'entity', pattern: /^\s*entity\s+String\b/m },
  // entityId — Int, nullable (some events aren't tied to a row, e.g.
  // bulk-export). Marked Int? in current schema.
  { name: 'entityId', pattern: /^\s*entityId\s+Int\??/m },
  // details — Text, nullable. JSON diff or human description.
  { name: 'details', pattern: /^\s*details\s+String\?\s+@db\.Text/m },
  // createdAt — DateTime with default(now()).
  { name: 'createdAt', pattern: /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)/m },
  // tenantId — Int, required, with default(1) — the data-leak gate.
  { name: 'tenantId', pattern: /^\s*tenantId\s+Int\b/m },
  // userId — Int, nullable. Cron/system-triggered audits have no actor.
  { name: 'userId', pattern: /^\s*userId\s+Int\?/m },
];

// Parse once at module load. Each test re-uses the same model list.
const models = parseModels(SCHEMA);

describe('schema invariants — multi-tenant safety net', () => {
  test('parser found a sane number of models', () => {
    // Sanity check the parser itself before depending on its output.
    // The schema currently declares ~110 models; the floor catches a
    // parser regression (e.g. a brace-counting bug eating half the file).
    expect(models.length).toBeGreaterThan(80);
    // Every model name must be a valid PascalCase identifier.
    for (const { name } of models) {
      expect(name).toMatch(/^[A-Z]\w+$/);
    }
  });

  test('every non-whitelisted model has a tenantId Int column', () => {
    const violations = [];
    for (const { name, body } of models) {
      if (NON_TENANT_MODELS.has(name)) continue;
      const hasTenantId = /^\s*tenantId\s+Int\b/m.test(body);
      if (!hasTenantId) {
        violations.push(name);
      }
    }
    // Failure here = silent cross-tenant data leak risk. Either the new
    // model needs `tenantId Int` added, or it needs to go on
    // NON_TENANT_MODELS with a justification comment.
    expect(
      violations,
      `Models missing tenantId (data-leak risk):\n  - ${violations.join('\n  - ')}\n\n` +
        `Either add \`tenantId Int @default(1)\` to the model, or add it to\n` +
        `NON_TENANT_MODELS in this test file with a comment explaining why.`,
    ).toEqual([]);
  });

  test('every model with a deletedAt field declares it nullable', () => {
    const violations = [];
    for (const { name, body } of models) {
      // Match any line declaring deletedAt + capture its type.
      const m = body.match(/^\s*deletedAt\s+(\S+)/m);
      if (!m) continue;
      const type = m[1];
      // Nullable types end in `?` — "DateTime?", "DateTime?\n", etc.
      if (!type.endsWith('?')) {
        violations.push(`${name}.deletedAt is "${type}" (must be DateTime?)`);
      }
    }
    expect(
      violations,
      `Soft-delete fields must be nullable. The codebase's filter pattern\n` +
        `is \`{ deletedAt: null }\` for "alive" rows; a required column\n` +
        `breaks every list/detail route silently.\nViolations:\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });

  test('AuditLog shape matches the documented contract', () => {
    const auditLog = models.find((mm) => mm.name === 'AuditLog');
    expect(auditLog, 'AuditLog model not found in schema.prisma').toBeDefined();

    const missing = [];
    for (const { name, pattern } of EXPECTED_AUDIT_LOG_FIELDS) {
      if (!pattern.test(auditLog.body)) {
        missing.push(name);
      }
    }
    expect(
      missing,
      `AuditLog is missing fields or has the wrong type/nullability:\n` +
        `  - ${missing.join('\n  - ')}\n\n` +
        `If this drift is intentional, update EXPECTED_AUDIT_LOG_FIELDS in\n` +
        `this test file IN THE SAME PR as the schema change. The audit\n` +
        `viewer + GDPR export both consume the documented shape.`,
    ).toEqual([]);
  });

  // ── Soft warnings ──────────────────────────────────────────────────
  //
  // These don't fail the suite (vitest console.warn-only) because they
  // surface pre-existing architectural drift that's tracked under
  // separate issues. The hard gates above are sufficient for the
  // data-leak invariant. If we converted these to hard fails today,
  // the test would be red against unrelated legacy state.

  test('models with tenantId SHOULD also declare a tenant Tenant @relation (warn)', () => {
    const drift = [];
    for (const { name, body } of models) {
      if (NON_TENANT_MODELS.has(name)) continue;
      const hasTenantId = /^\s*tenantId\s+Int\b/m.test(body);
      if (!hasTenantId) continue; // already failed by the hard test above
      const hasRelation = /^\s*tenant\s+Tenant\s+@relation/m.test(body);
      if (!hasRelation) drift.push(name);
    }
    if (drift.length > 0) {
      console.warn(
        `[schema-invariants] ${drift.length} models have tenantId but no ` +
          `formal \`tenant Tenant @relation\` line. The data-leak gate is the ` +
          `column itself; the relation is a convenience. Tracked under ` +
          `separate [schema] [P1] cleanup issue.\n  - ${drift.join('\n  - ')}`,
      );
    }
    // Test always passes; it's a reporting checkpoint.
    expect(true).toBe(true);
  });

  test('@@unique constraints SHOULD have an explanatory comment (warn)', () => {
    // Walk the schema line by line; flag any @@unique that has no
    // trailing `// ...` comment on the same line and no `// ...`
    // comment on the immediately preceding non-blank line. This is
    // a heuristic, not a parser — the goal is to nudge developers
    // to document load-bearing constraints, not to perfectly classify.
    const lines = SCHEMA.split('\n');
    const undocumented = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/@@unique\(/.test(lines[i])) continue;
      const sameLine = /\/\//.test(lines[i]);
      // Walk backwards past blank lines to find the previous content line.
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === '') j--;
      const prevLineComment = j >= 0 && /^\s*\/\//.test(lines[j]);
      if (!sameLine && !prevLineComment) {
        undocumented.push(`line ${i + 1}: ${lines[i].trim()}`);
      }
    }
    if (undocumented.length > 0) {
      console.warn(
        `[schema-invariants] ${undocumented.length} @@unique constraints ` +
          `lack explanatory comments. Load-bearing constraints SHOULD be ` +
          `documented so future migrations don't silently drop them.\n  - ` +
          undocumented.join('\n  - '),
      );
    }
    expect(true).toBe(true);
  });
});
