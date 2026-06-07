// @ts-check
/**
 * TMC Diagnostic & Sales-Routing Engine — schema pin (Tick 1 of the arc).
 *
 * What this file pins:
 *   The Prisma schema slice that the rest of the TMC Diagnostic & Sales-
 *   Routing Engine arc is built on. This is the foundational tick: the
 *   engine module (Tick 2), seed-travel.js catalogue loader (Tick 2),
 *   admin entry screen, and report renderer all depend on these shapes.
 *
 * Why a schema-text test (vs a runtime Prisma client test):
 *   The schema is the SOURCE-OF-TRUTH for shape contracts the engine
 *   relies on (every weight defaults to its PRD §3.3.3 value, every
 *   new TravelDiagnostic column is nullable so pre-existing rows
 *   remain valid, indexes cover the engine's hot read paths). Reading
 *   the schema text directly catches drift at the lowest possible layer
 *   — no DB push, no client regenerate, no migration noise.
 *
 *   The repo's `backend/test/schema/schema-invariants.test.js` uses the
 *   same fs.readFileSync + regex pattern (G-24 multi-tenant safety net);
 *   this file mirrors that style for the TMC slice.
 *
 * PRD anchors (PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md):
 *   §3.2  — TmcTripCatalogue field schema (DD-5.1 RESOLVED: new model).
 *   §3.3.3 — EngineWeights defaults (50 / 20 / 15 / 10 / 10 / 8 / 70).
 *   §3.3.7 — Weight-tuning protocol (single config row, version bumped).
 *   §3.8  — Data model: 10 additive TravelDiagnostic columns.
 *
 * Maintenance contract:
 *   When the TMC schema slice changes (e.g. a new column on
 *   TmcTripCatalogue, a new EngineWeights default, a new engineState
 *   value), update this file IN THE SAME PR so the pin moves with the
 *   contract. Drift between schema + test is the failure mode this
 *   suite is designed to surface immediately.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

// __dirname under ESM; mirrors schema-invariants.test.js.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.resolve(__dirname, '../../prisma/schema.prisma');
const SCHEMA = fs.readFileSync(SCHEMA_PATH, 'utf8');

// ── Model body extractor ─────────────────────────────────────────────
//
// Same brace-depth walker as schema-invariants.test.js so we don't trip
// on bracketed args inside @@unique / @relation.
function extractModelBody(src, name) {
  const re = new RegExp(`^model\\s+${name}\\s*\\{`, 'm');
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

// ── Field-shape expectations for each model ──────────────────────────
//
// Format: { name, pattern, why }. Patterns are anchored to a line so a
// field appearing in a comment doesn't match accidentally.

// PRD §3.2 + §3.8 — 18 catalogue fields + id/tenantId/audit columns.
// `status` defaults to "archived" — humans flip to active only after
// curriculum_hooks + price_band are verified (NF-9).
// `indicativePricePerStudent` is nullable: variable-price trips carry
// null and the brief renderer falls back to "varies by group size".
const EXPECTED_TMC_TRIP_CATALOGUE_FIELDS = [
  { name: 'id', pattern: /^\s*id\s+Int\s+@id\s+@default\(autoincrement\(\)\)/m },
  { name: 'tenantId', pattern: /^\s*tenantId\s+Int\s+@default\(1\)/m },
  { name: 'tripId', pattern: /^\s*tripId\s+String\b/m },
  { name: 'title', pattern: /^\s*title\s+String\b/m },
  // tagline is nullable + Text (long-form display copy).
  { name: 'tagline', pattern: /^\s*tagline\s+String\?\s+@db\.Text/m },
  { name: 'tier', pattern: /^\s*tier\s+String\b/m },
  // region is nullable — day-tier programs have no region anchor.
  { name: 'region', pattern: /^\s*region\s+String\?/m },
  { name: 'durationDays', pattern: /^\s*durationDays\s+Int\b/m },
  { name: 'durationNights', pattern: /^\s*durationNights\s+Int\s+@default\(0\)/m },
  { name: 'minGradeBand', pattern: /^\s*minGradeBand\s+String\b/m },
  { name: 'maxGradeBand', pattern: /^\s*maxGradeBand\s+String\b/m },
  { name: 'boardsSupportedJson', pattern: /^\s*boardsSupportedJson\s+String\s+@db\.Text/m },
  { name: 'minGroupSize', pattern: /^\s*minGroupSize\s+Int\b/m },
  { name: 'priceBand', pattern: /^\s*priceBand\s+String\b/m },
  // indicativePricePerStudent is nullable (variable-price trips).
  { name: 'indicativePricePerStudent', pattern: /^\s*indicativePricePerStudent\s+Int\?/m },
  { name: 'primaryOutcomesJson', pattern: /^\s*primaryOutcomesJson\s+String\s+@db\.Text/m },
  { name: 'skillsDevelopedJson', pattern: /^\s*skillsDevelopedJson\s+String\s+@db\.Text/m },
  { name: 'subjectsTouchedJson', pattern: /^\s*subjectsTouchedJson\s+String\s+@db\.Text/m },
  { name: 'anchorExperiencesJson', pattern: /^\s*anchorExperiencesJson\s+String\s+@db\.Text/m },
  { name: 'curriculumHooksJson', pattern: /^\s*curriculumHooksJson\s+String\s+@db\.Text/m },
  { name: 'reportSkillBlurb', pattern: /^\s*reportSkillBlurb\s+String\s+@db\.Text/m },
  { name: 'summaryForBrief', pattern: /^\s*summaryForBrief\s+String\s+@db\.Text/m },
  // imageUrl nullable — not every trip carries a curated image at tag time.
  { name: 'imageUrl', pattern: /^\s*imageUrl\s+String\?/m },
  // status default = archived per spec (humans promote to active).
  { name: 'status', pattern: /^\s*status\s+String\s+@default\("archived"\)/m },
  // Required tenant FK back-relation.
  { name: 'tenant', pattern: /^\s*tenant\s+Tenant\s+@relation\(/m },
  { name: 'createdAt', pattern: /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)/m },
  { name: 'updatedAt', pattern: /^\s*updatedAt\s+DateTime\s+@updatedAt/m },
];

// PRD §3.3.3 — defaults match the scoring table EXACTLY. A typo in any
// of these silently re-tunes the engine for every tenant, so we pin
// each one. version defaults to "v1" so the first scored submission
// captures a meaningful weightsVersion (per §3.3.7 audit).
const EXPECTED_ENGINE_WEIGHTS_FIELDS = [
  { name: 'id', pattern: /^\s*id\s+Int\s+@id\s+@default\(autoincrement\(\)\)/m },
  // tenantId is @unique — single config row per tenant (NF-2).
  { name: 'tenantId', pattern: /^\s*tenantId\s+Int\s+@unique\s+@default\(1\)/m },
  { name: 'version', pattern: /^\s*version\s+String\s+@default\("v1"\)/m },
  { name: 'weightPrimaryOutcome', pattern: /^\s*weightPrimaryOutcome\s+Int\s+@default\(50\)/m },
  { name: 'weightSecondarySkill', pattern: /^\s*weightSecondarySkill\s+Int\s+@default\(20\)/m },
  { name: 'weightGrowthArea', pattern: /^\s*weightGrowthArea\s+Int\s+@default\(15\)/m },
  { name: 'weightCurriculumHook', pattern: /^\s*weightCurriculumHook\s+Int\s+@default\(10\)/m },
  { name: 'weightGradeBandCenter', pattern: /^\s*weightGradeBandCenter\s+Int\s+@default\(10\)/m },
  { name: 'weightTierValueLean', pattern: /^\s*weightTierValueLean\s+Int\s+@default\(8\)/m },
  { name: 'scoresWellThreshold', pattern: /^\s*scoresWellThreshold\s+Int\s+@default\(70\)/m },
  { name: 'tenant', pattern: /^\s*tenant\s+Tenant\s+@relation\(/m },
  { name: 'createdAt', pattern: /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)/m },
  { name: 'updatedAt', pattern: /^\s*updatedAt\s+DateTime\s+@updatedAt/m },
];

// PRD §3.8 — 10 ADDITIVE nullable columns on the existing
// TravelDiagnostic model. Pre-existing diagnostic rows must remain
// valid; every column carries `?`. Note: deliberately NO FK constraint
// on recommendedTripId / alternativeTripId — kept as bare Int? so the
// catalogue can archive rows without cascade churn (the engine resolves
// IDs via lookup; see model docstring).
const EXPECTED_TRAVEL_DIAGNOSTIC_ADDED_FIELDS = [
  { name: 'engineState', pattern: /^\s*engineState\s+String\?/m },
  { name: 'engineScoresJson', pattern: /^\s*engineScoresJson\s+String\?\s+@db\.Text/m },
  { name: 'recommendedTripId', pattern: /^\s*recommendedTripId\s+Int\?/m },
  { name: 'alternativeTripId', pattern: /^\s*alternativeTripId\s+Int\?/m },
  { name: 'icpTier', pattern: /^\s*icpTier\s+String\?/m },
  { name: 'leadQuality', pattern: /^\s*leadQuality\s+String\?/m },
  {
    name: 'leadQualityReasonsJson',
    pattern: /^\s*leadQualityReasonsJson\s+String\?\s+@db\.Text/m,
  },
  { name: 'flagsJson', pattern: /^\s*flagsJson\s+String\?\s+@db\.Text/m },
  { name: 'humanPick', pattern: /^\s*humanPick\s+String\?/m },
  { name: 'weightsVersion', pattern: /^\s*weightsVersion\s+String\?/m },
];

// ── Extract bodies once at module load ────────────────────────────────
const tmcBody = extractModelBody(SCHEMA, 'TmcTripCatalogue');
const ewBody = extractModelBody(SCHEMA, 'EngineWeights');
const tdBody = extractModelBody(SCHEMA, 'TravelDiagnostic');
const tenantBody = extractModelBody(SCHEMA, 'Tenant');

// ── Suite ─────────────────────────────────────────────────────────────

describe('TMC Diagnostic Engine — schema pin', () => {
  // Sanity check: bodies were extracted. If a model rename slipped
  // through, every other test would fail with the same "body is null"
  // message; surfacing it once up-front saves triage time.
  test('extractor located all 4 model bodies (TmcTripCatalogue, EngineWeights, TravelDiagnostic, Tenant)', () => {
    expect(tmcBody, 'TmcTripCatalogue model not found in schema.prisma').not.toBeNull();
    expect(ewBody, 'EngineWeights model not found in schema.prisma').not.toBeNull();
    expect(tdBody, 'TravelDiagnostic model not found in schema.prisma').not.toBeNull();
    expect(tenantBody, 'Tenant model not found in schema.prisma').not.toBeNull();
  });

  // ── TmcTripCatalogue field/type/nullability shape ──────────────────
  test('TmcTripCatalogue declares the expected field set with correct types + nullability', () => {
    const missing = [];
    for (const { name, pattern } of EXPECTED_TMC_TRIP_CATALOGUE_FIELDS) {
      if (!pattern.test(tmcBody)) missing.push(name);
    }
    expect(
      missing,
      `TmcTripCatalogue is missing fields or has the wrong type/nullability:\n` +
        `  - ${missing.join('\n  - ')}\n\n` +
        `Fix the schema or update EXPECTED_TMC_TRIP_CATALOGUE_FIELDS if the\n` +
        `change is intentional. See PRD §3.2 for the canonical shape.`,
    ).toEqual([]);
  });

  // ── TmcTripCatalogue @@unique([tenantId, tripId]) ──────────────────
  test('TmcTripCatalogue has @@unique([tenantId, tripId]) — slug lookup key', () => {
    expect(tmcBody).toMatch(/@@unique\(\[\s*tenantId\s*,\s*tripId\s*\]\)/);
  });

  // ── TmcTripCatalogue 3 expected engine-hot indexes ─────────────────
  test('TmcTripCatalogue has the 3 expected indexes (status, status+tier, status+priceBand)', () => {
    // (tenantId, status) — list all active trips for this tenant.
    expect(tmcBody).toMatch(/@@index\(\[\s*tenantId\s*,\s*status\s*\]\)/);
    // (tenantId, status, tier) — tier-filtered surveys (day | domestic | international).
    expect(tmcBody).toMatch(/@@index\(\[\s*tenantId\s*,\s*status\s*,\s*tier\s*\]\)/);
    // (tenantId, status, priceBand) — budget-filtered surveys (Q9 bands).
    expect(tmcBody).toMatch(/@@index\(\[\s*tenantId\s*,\s*status\s*,\s*priceBand\s*\]\)/);
  });

  // ── TmcTripCatalogue.status defaults to "archived" ─────────────────
  // PRD §3.2 + NF-9: humans promote to active only after curriculum_hooks
  // + price_band are verified. A row created without explicit status MUST
  // NOT auto-publish to the engine.
  test('TmcTripCatalogue.status defaults to "archived" (engine recommends only "active" rows)', () => {
    expect(tmcBody).toMatch(/^\s*status\s+String\s+@default\("archived"\)/m);
  });

  // ── EngineWeights single-row-per-tenant constraint ─────────────────
  // PRD §3.3.7 — single config row per tenant; weights edits are config,
  // not migrations. Enforced by @unique on the FK column.
  test('EngineWeights enforces single-row-per-tenant via @unique on tenantId', () => {
    expect(ewBody).toMatch(/^\s*tenantId\s+Int\s+@unique\s+@default\(1\)/m);
  });

  // ── EngineWeights defaults match the §3.3.3 scoring table ──────────
  // A typo in any default silently re-tunes the engine for every tenant
  // on first row creation. Pin every value verbatim.
  test('EngineWeights defaults match PRD §3.3.3 (50 / 20 / 15 / 10 / 10 / 8 / threshold 70)', () => {
    const missing = [];
    for (const { name, pattern } of EXPECTED_ENGINE_WEIGHTS_FIELDS) {
      if (!pattern.test(ewBody)) missing.push(name);
    }
    expect(
      missing,
      `EngineWeights is missing fields or default values don't match\n` +
        `PRD §3.3.3 scoring table:\n` +
        `  - ${missing.join('\n  - ')}\n\n` +
        `Edits to the §3.3.3 weights MUST update both the schema AND this\n` +
        `expected list in the same PR. The defaults are the live tuning\n` +
        `surface for every new tenant.`,
    ).toEqual([]);
  });

  // ── EngineWeights.version defaults to "v1" ─────────────────────────
  // Required by §3.3.7 — every scored TravelDiagnostic captures
  // weightsVersion at scoring time; replaying the score requires a
  // non-null starting version. "v1" is the canonical seed value.
  test('EngineWeights.version defaults to "v1" (replay/audit seed)', () => {
    expect(ewBody).toMatch(/^\s*version\s+String\s+@default\("v1"\)/m);
  });

  // ── TravelDiagnostic 10 additive nullable columns ──────────────────
  // PRD §3.8. All nullable so pre-existing rows survive the migration
  // unchanged; the engine fills them in over the scoring lifecycle.
  test('TravelDiagnostic has the 10 new nullable columns with expected types', () => {
    const missing = [];
    for (const { name, pattern } of EXPECTED_TRAVEL_DIAGNOSTIC_ADDED_FIELDS) {
      if (!pattern.test(tdBody)) missing.push(name);
    }
    expect(
      missing,
      `TravelDiagnostic is missing TMC-engine fields, or one has lost its\n` +
        `nullable marker (breaks pre-existing rows):\n` +
        `  - ${missing.join('\n  - ')}\n\n` +
        `Every TMC-engine column on TravelDiagnostic MUST be nullable\n` +
        `(\`?\`) — pre-existing diagnostic rows shipped before the engine\n` +
        `landed must remain valid forever.`,
    ).toEqual([]);
  });

  // ── TravelDiagnostic new engineState index ─────────────────────────
  // The engine queue / dashboard filter routes will read by
  // (tenantId, subBrand, engineState) — pin the index so the migration
  // doesn't silently drop it under a re-format.
  test('TravelDiagnostic has the new @@index([tenantId, subBrand, engineState])', () => {
    expect(tdBody).toMatch(
      /@@index\(\[\s*tenantId\s*,\s*subBrand\s*,\s*engineState\s*\]\)/,
    );
  });

  // ── Tenant back-relations ──────────────────────────────────────────
  // tmcTripCatalogues TmcTripCatalogue[]  — one-to-many catalogue rows.
  // engineWeights     EngineWeights?      — one-to-zero-or-one config
  //                                         row (singular type, NOT a
  //                                         list — enforced by the
  //                                         @unique on EngineWeights.tenantId).
  test('Tenant has the new tmcTripCatalogues + engineWeights back-relations', () => {
    expect(tenantBody).toMatch(/^\s*tmcTripCatalogues\s+TmcTripCatalogue\[\]/m);
    // singular EngineWeights? (not EngineWeights[]) — single-row config.
    expect(tenantBody).toMatch(/^\s*engineWeights\s+EngineWeights\?/m);
  });

  // ── Engine FK columns intentionally stay bare Int ───────────────────
  // PRD-driven design choice: the engine resolves recommendedTripId /
  // alternativeTripId via lookup, NOT via a Prisma FK constraint. This
  // keeps pilot tuning cheap — archived catalogue rows can be removed
  // without cascading orphans into already-scored TravelDiagnostic
  // rows (which preserve their pick-at-the-time for audit). If a
  // future maintainer "completes the FK", this assertion goes red and
  // the design choice gets re-litigated in PR review.
  test('TravelDiagnostic.recommendedTripId / alternativeTripId have NO @relation FK (bare Int? by design)', () => {
    // Negative assertion: no @relation tied to TmcTripCatalogue
    // referenced from a recommendedTripId or alternativeTripId field.
    // The bare `Int?` declarations are the entire column line.
    const recommendedLine = tdBody.match(/^\s*recommendedTripId.+$/m);
    const alternativeLine = tdBody.match(/^\s*alternativeTripId.+$/m);
    expect(recommendedLine, 'recommendedTripId field not found').not.toBeNull();
    expect(alternativeLine, 'alternativeTripId field not found').not.toBeNull();
    expect(recommendedLine[0]).not.toMatch(/@relation/);
    expect(alternativeLine[0]).not.toMatch(/@relation/);
    // Also confirm no `tmcRecommendedTrip` / `tmcAlternativeTrip`-style
    // relation field was added pointing back at TmcTripCatalogue.
    expect(tdBody).not.toMatch(
      /^\s*\w+\s+TmcTripCatalogue\s+@relation\([^)]*recommendedTripId/m,
    );
    expect(tdBody).not.toMatch(
      /^\s*\w+\s+TmcTripCatalogue\s+@relation\([^)]*alternativeTripId/m,
    );
  });
});
