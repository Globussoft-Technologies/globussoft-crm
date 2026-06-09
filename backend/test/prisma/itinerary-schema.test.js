// @ts-check
/**
 * S8 — ItineraryItem schema pin (additive nullable columns for FR-3.3 + FR-3.4).
 *
 * What this file pins:
 *   The 3 additive nullable columns added to `ItineraryItem` by S8 of
 *   docs/TRAVEL_BIG_SCOPE_BACKLOG.md — `dayNumber Int?`, `latitude Float?`,
 *   `longitude Float?`. Consumed by S9 (day-by-day visual editor groups by
 *   dayNumber + drag-reorders within / across days) and S10 (map preview
 *   plots every item with both latitude + longitude set).
 *
 * Why a schema-text test (vs a runtime Prisma client test):
 *   1. The schema text is the source-of-truth for the contract. Reading
 *      it directly catches drift at the lowest possible layer — no DB
 *      push, no client regenerate, no migration noise.
 *   2. The repo's vitest harness wraps `PrismaClient` with the T39 surface
 *      guard (backend/test/setup.js) — runtime queries against unmocked
 *      surfaces throw under vitest unless `PRISMA_ALLOW_REAL_CALLS=1`
 *      AND `ALLOW_REMOTE_DB_IN_TESTS=1` (or a local DB) are set. Real-DB
 *      runtime tests live under `backend/test/integration/` with their
 *      own vitest config; this is a unit-shape pin per the established
 *      `backend/test/prisma/tmcDiagnosticEngineSchema.test.js` precedent.
 *   3. The columns are nullable + additive, so the contract being pinned
 *      is *literally* the schema text (field name + type + `?` suffix +
 *      absence of `@default`). A schema-text regex is the most direct
 *      assertion of that contract.
 *
 * PRD anchors (docs/PRD_TRAVEL_ITINERARY_UPGRADES.md):
 *   §3.3  (FR-3.3) — Day-by-day visual editor; `dayNumber` is the grouping
 *                    key per (c) + (d).
 *   §3.4  (FR-3.4) — LLM suggest itinerary; returned shape carries
 *                    `dayNumber` per day + `latitude` / `longitude` per item.
 *   §8    — Dependencies: "`ItineraryItem` extended with `dayNumber`,
 *           `latitude`, `longitude`".
 *
 * Maintenance contract:
 *   If S9 / S10 / S11 discover the columns should be different (e.g.
 *   `dayNumber` needs a default, `latitude` should be Decimal not Float,
 *   a composite `(itineraryId, dayNumber)` index needed for editor
 *   queries), update both this test and schema.prisma in the same PR.
 *   Drift between schema + test is the failure mode this suite is
 *   designed to surface immediately.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

// __dirname under ESM; mirrors tmcDiagnosticEngineSchema.test.js +
// schema-invariants.test.js.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.resolve(__dirname, '../../prisma/schema.prisma');
const SCHEMA = fs.readFileSync(SCHEMA_PATH, 'utf8');

// ── Model body extractor ─────────────────────────────────────────────
//
// Same brace-depth walker as tmcDiagnosticEngineSchema.test.js so we don't
// trip on bracketed args inside @@unique / @relation / @@index.
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

const itineraryItemBody = extractModelBody(SCHEMA, 'ItineraryItem');

// ── S8 column expectations ──────────────────────────────────────────
//
// All three columns are nullable. They carry NO `@default` — the editor
// (S9) will write the value on save, the LLM suggest path (FR-3.4) will
// populate them when present, and bulk imports / pre-S8 rows just leave
// them null. The patterns require the `?` suffix to be present AND no
// `@default` on the same line — the latter is enforced by asserting the
// line ends with the type (modulo whitespace + optional inline comment).
const EXPECTED_S8_FIELDS = [
  {
    name: 'dayNumber',
    // 1-indexed integer; null for items not yet assigned to a day.
    pattern: /^\s*dayNumber\s+Int\?\s*$/m,
    why: 'FR-3.3 (c)(d) — day grouping key for the visual editor; drag-reorder swaps dayNumber.',
  },
  {
    name: 'latitude',
    // Float (not Decimal) — sufficient precision (~11m at typical zoom)
    // and matches the lat/lng convention already established by
    // TravelCostMaster.attributesJson (PRD §FR-3.2 (b)).
    pattern: /^\s*latitude\s+Float\?\s*$/m,
    why: 'FR-3.4 (d) + FR-3.3 (e) — map pin placement (numbered pins + route polyline).',
  },
  {
    name: 'longitude',
    pattern: /^\s*longitude\s+Float\?\s*$/m,
    why: 'FR-3.4 (d) + FR-3.3 (e) — map pin placement (numbered pins + route polyline).',
  },
];

// Pre-existing fields that S8 MUST NOT touch — guards against accidental
// shape change while editing the model. Each pattern is anchored to a
// line so a rename or type change would surface here.
const EXPECTED_PREEXISTING_FIELDS = [
  { name: 'id', pattern: /^\s*id\s+Int\s+@id\s+@default\(autoincrement\(\)\)/m },
  { name: 'itineraryId', pattern: /^\s*itineraryId\s+Int\b/m },
  { name: 'itemType', pattern: /^\s*itemType\s+String\b/m },
  { name: 'position', pattern: /^\s*position\s+Int\b/m },
  { name: 'description', pattern: /^\s*description\s+String\b/m },
  { name: 'detailsJson', pattern: /^\s*detailsJson\s+String\?\s+@db\.Text/m },
  { name: 'supplierId', pattern: /^\s*supplierId\s+Int\?/m },
  { name: 'unitCost', pattern: /^\s*unitCost\s+Decimal\?\s+@db\.Decimal\(15,\s*2\)/m },
  { name: 'totalPrice', pattern: /^\s*totalPrice\s+Decimal\?\s+@db\.Decimal\(15,\s*2\)/m },
  {
    name: 'itinerary (relation)',
    pattern: /^\s*itinerary\s+Itinerary\s+@relation\(fields:\s*\[itineraryId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/m,
  },
];

// ── Suite ────────────────────────────────────────────────────────────

describe('ItineraryItem — S8 schema pin (dayNumber + latitude + longitude)', () => {
  test('extractor located ItineraryItem model body', () => {
    expect(itineraryItemBody, 'ItineraryItem model not found in schema.prisma').not.toBeNull();
  });

  // ── S8 additive columns ─────────────────────────────────────────────
  test('declares dayNumber + latitude + longitude as additive nullable columns', () => {
    const missing = [];
    for (const { name, pattern, why } of EXPECTED_S8_FIELDS) {
      if (!pattern.test(itineraryItemBody)) {
        missing.push(`${name} — ${why}`);
      }
    }
    expect(
      missing,
      `Expected S8 columns missing or wrong shape on ItineraryItem:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  test('S8 columns are all nullable (every field declaration ends with `?`)', () => {
    // Belt-and-braces — the EXPECTED_S8_FIELDS patterns above already
    // require the `?` suffix, but a future edit that loosens those
    // patterns shouldn't slip a NOT-NULL through. This grep is harder
    // to soften by accident.
    for (const field of ['dayNumber', 'latitude', 'longitude']) {
      // Match the field line and capture the type token (optionally `?`).
      const re = new RegExp(`^\\s*${field}\\s+(\\w+\\??)`, 'm');
      const m = re.exec(itineraryItemBody);
      expect(m, `${field} field line not found on ItineraryItem`).not.toBeNull();
      // The captured type token MUST end with `?`. If it doesn't, the
      // migration check would flag NOT_NULL_WITHOUT_DEFAULT against
      // any populated table → blocks the deploy gate.
      expect(
        m[1].endsWith('?'),
        `${field} must be nullable (S8 ships additive nullable per CLAUDE.md migration-safety rule). ` +
          `Found type token "${m[1]}". A NOT-NULL column on ItineraryItem requires a backfill + ` +
          `[allow-not-null] bless marker — S8's PRD scope is strictly additive.`,
      ).toBe(true);
    }
  });

  test('S8 columns carry NO @default (S9 + S10 write the value on save)', () => {
    // Reading back: a row with NO dayNumber / latitude / longitude set
    // should come back with null on each of those three fields. If a
    // @default slips in, pre-existing rows that S8 leaves alone would
    // get the default backfilled at next save — not the contract S9
    // expects.
    for (const field of ['dayNumber', 'latitude', 'longitude']) {
      const re = new RegExp(`^\\s*${field}\\s+\\w+\\?\\s+(@default\\([^)]*\\))`, 'm');
      const m = re.exec(itineraryItemBody);
      expect(
        m,
        `${field} must NOT carry @default — found ${m ? m[1] : ''}. S8 contract is "null until ` +
          `the editor (S9) writes the value". A @default would silently backfill on next save.`,
      ).toBeNull();
    }
  });

  // ── Pre-existing fields unchanged ──────────────────────────────────
  test('pre-existing ItineraryItem fields unchanged by S8', () => {
    const missing = [];
    for (const { name, pattern } of EXPECTED_PREEXISTING_FIELDS) {
      if (!pattern.test(itineraryItemBody)) {
        missing.push(name);
      }
    }
    expect(
      missing,
      `Pre-existing fields drifted (S8 must NOT touch them):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  test('@@index([itineraryId, position]) preserved (existing ordered-list read path)', () => {
    expect(
      /@@index\(\[itineraryId,\s*position\]\)/.test(itineraryItemBody),
      'existing @@index([itineraryId, position]) must survive S8',
    ).toBe(true);
  });
});
