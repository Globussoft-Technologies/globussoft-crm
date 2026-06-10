// @ts-check
/**
 * S57 — seed-travel.js default CancellationPolicy rows (TMC + RFU).
 *
 * What this file pins:
 *   The S57 seed addition to `backend/prisma/seed-travel.js` — a
 *   `seedDefaultCancellationPolicies(tenantId)` helper that idempotently
 *   provisions two starter cancellation policies:
 *     - "TMC Default" → subBrand=tmc, tiers 60d/100, 30d/50, 7d/25, 0d/0
 *     - "RFU Default" → subBrand=rfu, tiers 90d/100, 45d/75, 14d/50, 0d/0
 *   plus the call-site wire-in inside `main()` so the helper actually runs
 *   when the seeder is invoked.
 *
 * Why this exists:
 *   S33 (commit 1614f88e) shipped the CancellationPolicy model + auto-CR-NOTE
 *   issuance on POST /api/travel/invoices/:id/void. Without seed defaults
 *   on a fresh deploy, the void handler's resolveCancellationOutcome()
 *   falls through to "no policy applied" → zero auto-refund → the entire
 *   feature is invisible until a human manually POSTs a policy. S57
 *   closes that gap.
 *
 * Why a text-based pin (vs a real-prisma runtime test):
 *   1. `backend/test/setup.js` ships a PrismaClient surface guard (T39) that
 *      throws on every `prisma.model.method()` call under vitest unless
 *      `PRISMA_ALLOW_REAL_CALLS=1` AND a real database are configured.
 *      Real-DB runtime tests live under `backend/test/integration/` with
 *      a separate vitest config.
 *   2. The contract being pinned IS the seed-script text — the exact
 *      policy names, sub-brand assignments, tier arrays, refundPercent
 *      values, and idempotency strategy. A text-shape assertion is the
 *      most direct expression of that contract.
 *   3. Established precedent — `backend/test/prisma/itinerary-schema.test.js`
 *      and `backend/test/prisma/tmcDiagnosticEngineSchema.test.js` both
 *      pin Prisma-adjacent contracts via schema-text regex; this follows
 *      the same pattern at the seed layer instead of the schema layer.
 *
 * Maintenance contract:
 *   If S57's tier ladders need to be edited (e.g. Yasin's product call
 *   moves TMC's 60-day cutoff to 45 days), update BOTH this test and
 *   `backend/prisma/seed-travel.js` in the same PR. Drift between the
 *   seeded numbers and the test's expectations is the failure mode this
 *   suite is designed to surface immediately.
 *
 * Related:
 *   - docs/TRAVEL_BIG_SCOPE_BACKLOG.md row S57 (this slice).
 *   - docs/TRAVEL_BIG_SCOPE_BACKLOG.md row S33 (the model + void handler).
 *   - prisma/schema.prisma `model CancellationPolicy` (the @@unique key
 *     that backs the idempotent upsert pattern).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_PATH = path.resolve(__dirname, '../../prisma/seed-travel.js');
const SEED_SRC = fs.readFileSync(SEED_PATH, 'utf8');

// ── Function body extractor ─────────────────────────────────────────
//
// Walks brace depth to extract the body of the named async function. Same
// shape as the model-body extractor in itinerary-schema.test.js, adapted
// for `async function <name>(...) { ... }`.
function extractAsyncFnBody(src, name) {
  const re = new RegExp(`async\\s+function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

const fnBody = extractAsyncFnBody(SEED_SRC, 'seedDefaultCancellationPolicies');

describe('seed-travel.js — S57 default cancellation policies', () => {
  test('declares seedDefaultCancellationPolicies(tenantId) async helper', () => {
    expect(
      fnBody,
      'seedDefaultCancellationPolicies async function not found in seed-travel.js — S57 may have been reverted or renamed.',
    ).not.toBeNull();
  });

  // ── Call-site wire-in ───────────────────────────────────────────────
  //
  // The helper is dead code unless main() actually invokes it. This guards
  // against the common "function added, never wired" regression.
  test('main() invokes seedDefaultCancellationPolicies(tenant.id)', () => {
    expect(
      /await\s+seedDefaultCancellationPolicies\(\s*tenant\.id\s*\)/.test(SEED_SRC),
      'seedDefaultCancellationPolicies is not called from main() with tenant.id — S57 helper is dead code without the wire-in.',
    ).toBe(true);
  });

  // ── TMC Default policy shape ────────────────────────────────────────
  //
  // The 4-tier ladder is the contract: 60d/100 → 30d/50 → 7d/25 → 0d/0.
  // Tier values are split into 8 numeric asserts so a single-field drift
  // (e.g. someone changing 30d to 45d) surfaces exactly which tier moved.
  describe('TMC Default policy', () => {
    test('name + subBrand + description present', () => {
      expect(fnBody).toMatch(/name:\s*["']TMC Default["']/);
      expect(fnBody).toMatch(/subBrand:\s*["']tmc["']/);
      expect(fnBody).toMatch(/description:\s*["']Standard TMC school-trip cancellation policy["']/);
    });

    test('tier ladder: 60d/100, 30d/50, 7d/25, 0d/0', () => {
      // The TMC tiersJson block as a single multiline regex — preserves
      // the exact tier order (the resolver walks tiers DESC by threshold,
      // so order in the seed array doesn't matter functionally, but
      // pinning it keeps the seed-script readable and diff-friendly).
      const tmcTiers = /name:\s*["']TMC Default["'][\s\S]*?tiersJson:\s*JSON\.stringify\(\s*\[\s*\{\s*daysBeforeServiceStart:\s*60,\s*refundPercent:\s*100\s*\}\s*,\s*\{\s*daysBeforeServiceStart:\s*30,\s*refundPercent:\s*50\s*\}\s*,\s*\{\s*daysBeforeServiceStart:\s*7,\s*refundPercent:\s*25\s*\}\s*,\s*\{\s*daysBeforeServiceStart:\s*0,\s*refundPercent:\s*0\s*\}\s*,?\s*\]\s*\)/;
      expect(
        tmcTiers.test(fnBody),
        'TMC Default tier ladder drifted from the canonical 60d/100, 30d/50, 7d/25, 0d/0 shape.',
      ).toBe(true);
    });
  });

  // ── RFU Default policy shape ────────────────────────────────────────
  //
  // Umrah tiers are stricter — visa + hotel deposits land earlier so
  // late-cancellation refunds shrink faster: 90d/100 → 45d/75 → 14d/50 → 0d/0.
  describe('RFU Default policy', () => {
    test('name + subBrand + description present', () => {
      expect(fnBody).toMatch(/name:\s*["']RFU Default["']/);
      expect(fnBody).toMatch(/subBrand:\s*["']rfu["']/);
      expect(fnBody).toMatch(/description:\s*["']Standard RFU Umrah-trip cancellation policy["']/);
    });

    test('tier ladder: 90d/100, 45d/75, 14d/50, 0d/0', () => {
      const rfuTiers = /name:\s*["']RFU Default["'][\s\S]*?tiersJson:\s*JSON\.stringify\(\s*\[\s*\{\s*daysBeforeServiceStart:\s*90,\s*refundPercent:\s*100\s*\}\s*,\s*\{\s*daysBeforeServiceStart:\s*45,\s*refundPercent:\s*75\s*\}\s*,\s*\{\s*daysBeforeServiceStart:\s*14,\s*refundPercent:\s*50\s*\}\s*,\s*\{\s*daysBeforeServiceStart:\s*0,\s*refundPercent:\s*0\s*\}\s*,?\s*\]\s*\)/;
      expect(
        rfuTiers.test(fnBody),
        'RFU Default tier ladder drifted from the canonical 90d/100, 45d/75, 14d/50, 0d/0 shape.',
      ).toBe(true);
    });
  });

  // ── Idempotency guard ────────────────────────────────────────────────
  //
  // The seed MUST be re-run-safe. The helper uses findFirst + create/update
  // keyed on (tenantId, name) — the same shape backed by the schema's
  // @@unique([tenantId, name]) constraint. Asserting both halves so a
  // regression like "rewrite as bare create() without the existence check"
  // surfaces here.
  describe('idempotency', () => {
    test('finds existing row by (tenantId, name) before mutating', () => {
      expect(
        /prisma\.cancellationPolicy\.findFirst\(\s*\{\s*where:\s*\{\s*tenantId\s*,\s*name:\s*spec\.name\s*\}/.test(fnBody),
        'Helper must findFirst on (tenantId, name) before deciding create-vs-update — required for re-run safety.',
      ).toBe(true);
    });

    test('branches into update OR create based on existence', () => {
      expect(fnBody).toMatch(/prisma\.cancellationPolicy\.update\(/);
      expect(fnBody).toMatch(/prisma\.cancellationPolicy\.create\(/);
    });

    test('update branch preserves operator-tuned tiersJson', () => {
      // The update path MUST touch description + isActive only — leaving
      // tiersJson alone so operators who tuned the ladder via the admin UI
      // keep their tuning across seed re-runs.
      const updateBlock = fnBody.match(/prisma\.cancellationPolicy\.update\(\s*\{[\s\S]*?\}\s*\)/);
      expect(updateBlock, 'update() call not found inside helper body').not.toBeNull();
      // The update payload must NOT contain a tiersJson assignment.
      expect(
        /tiersJson\s*:/.test(updateBlock[0]),
        'update payload includes tiersJson — operator tuning would be clobbered on every seed re-run.',
      ).toBe(false);
    });
  });

  // ── Tenant-scoping ──────────────────────────────────────────────────
  //
  // The function MUST receive a tenantId arg and use it in both branches —
  // a regression like a hard-coded `tenantId: 1` would silently scope the
  // seed to tenant #1 only on a multi-tenant box.
  test('helper accepts tenantId arg and uses it in find + create', () => {
    expect(/async\s+function\s+seedDefaultCancellationPolicies\s*\(\s*tenantId\s*\)/.test(SEED_SRC)).toBe(true);
    expect(/where:\s*\{\s*tenantId\s*,/.test(fnBody)).toBe(true);
    expect(/tenantId\s*,\s*\n\s*name:\s*spec\.name/.test(fnBody) || /data:\s*\{[\s\S]*?tenantId\s*,/.test(fnBody)).toBe(true);
  });

  // ── Both policies present ───────────────────────────────────────────
  //
  // Catch-all: the POLICIES array has exactly 2 entries; the seed-output
  // log line mentions both. Belt-and-braces for "someone deleted RFU".
  test('helper logs both policies in its summary line', () => {
    expect(fnBody).toMatch(/TMC Default \+ RFU Default/);
  });
});
