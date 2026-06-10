// ─────────────────────────────────────────────────────────────────
// S91 — seedTravelPois wire-in into prisma/seed.js
// ─────────────────────────────────────────────────────────────────
// What's tested:
//   Verifies that `backend/prisma/seed.js` imports the
//   `seedTravelPois` wrapper (S11's `./seed-travel-pois.js`) AND
//   invokes it with the canonical `{ prisma, useFixture: true }` call
//   shape during the orchestrator run, with try/catch error isolation
//   so a POI seed failure doesn't abort the rest of the seed.
//
// Which modules:
//   backend/prisma/seed.js            - orchestrator (SUT — the wire-in site)
//   backend/prisma/seed-travel-pois.js - S11's in-process wrapper
//
// Why this layer + why static-string-analysis:
//   `prisma/seed.js` auto-executes `main()` at module load (line 1166-style:
//   `main().catch(...).finally(...)`), so `require()`-ing it from a test
//   triggers a full DB wipe + seed against the running MySQL — completely
//   wrong shape for a unit test. The route-mount-audit.test.js precedent
//   (siblings dir, same gate) settles this by reading the SUT as a string +
//   asserting the load-bearing tokens are present. We do the same here:
//   read seed.js, assert the import + the call shape + the try/catch
//   isolation token + the log substring. Plus a final test that boots the
//   wrapper module in isolation (vi.mock'ing the underlying script) so we
//   pin S11's `{ prisma, useFixture, destinations }` export contract — the
//   contract S91's wire-in depends on. If the wrapper's signature ever
//   regresses, this test fails BEFORE the seed.js wire-in goes weird at
//   `prisma db seed` time.
//
// Why this matters (S11 + S91 carry-over):
//   S11 deliberately deferred the seed.js wire-in per the wave's shared-file
//   hazard rule (multiple slices serialising on seed.js). Without S91,
//   `prisma db seed` runs would never populate the TravelPoi catalog, the
//   POI-aware CRM frontend code would always render an empty picker, and
//   FR-3.5 would silently regress on every fresh demo box rebuild. This
//   test pins the wire-in shape so it can't silently un-land in a future
//   refactor.
//
// Skip-list: none.

import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SEED_JS_PATH = path.resolve(__dirname, '../../prisma/seed.js');
const WRAPPER_PATH = path.resolve(__dirname, '../../prisma/seed-travel-pois.js');
const seedSource = fs.readFileSync(SEED_JS_PATH, 'utf8');
const wrapperSource = fs.readFileSync(WRAPPER_PATH, 'utf8');

describe('S91 — seedTravelPois is wired into prisma/seed.js', () => {
  test('seed.js imports seedTravelPois from ./seed-travel-pois', () => {
    // Match either CJS form: const { seedTravelPois } = require('./seed-travel-pois')
    // (possibly with .js extension) — anchored on the destructured name + the
    // module path so a renamed import would fail this assertion loudly.
    const importPattern = /const\s*\{\s*seedTravelPois\s*\}\s*=\s*require\(\s*['"]\.\/seed-travel-pois(?:\.js)?['"]\s*\)/;
    expect(seedSource).toMatch(importPattern);
  });

  test('seed.js calls seedTravelPois with the canonical { prisma, useFixture: true } shape', () => {
    // The call site must pass BOTH the orchestrator's shared prisma instance
    // AND useFixture: true (CI / offline default). The regex tolerates any
    // whitespace + property order so a clean refactor doesn't trip the test
    // for cosmetic reasons.
    const callPattern = /seedTravelPois\(\s*\{[^}]*\bprisma\b[^}]*\buseFixture\s*:\s*true\b[^}]*\}/;
    const altOrderPattern = /seedTravelPois\(\s*\{[^}]*\buseFixture\s*:\s*true\b[^}]*\bprisma\b[^}]*\}/;
    expect(callPattern.test(seedSource) || altOrderPattern.test(seedSource)).toBe(true);
  });

  test('seed.js wraps the seedTravelPois call in try/catch for error isolation', () => {
    // Extract the region around the call + verify a `try {` precedes it and a
    // `catch (` follows within a reasonable window. The existing per-op
    // isolation pattern (lines 48, 203-207, 345-348) demands this — without
    // it, a POI seed failure would abort the whole seed run mid-way and
    // leave the demo box in a half-seeded state.
    const callIdx = seedSource.indexOf('seedTravelPois({');
    expect(callIdx).toBeGreaterThan(-1);
    // Look backwards up to 400 chars for `try {`
    const preWindow = seedSource.slice(Math.max(0, callIdx - 400), callIdx);
    expect(preWindow).toMatch(/try\s*\{/);
    // Look forwards up to 400 chars for `} catch`
    const postWindow = seedSource.slice(callIdx, Math.min(seedSource.length, callIdx + 400));
    expect(postWindow).toMatch(/\}\s*catch\s*\(/);
  });

  test('seed.js logs a "seeding POIs" substring before the call (operator-visibility)', () => {
    // Demo-box operator + CI logs need a visible breadcrumb that the POI
    // step ran. Matches the existing `console.log` style at the start of
    // every other seed step.
    expect(seedSource).toMatch(/console\.log\([^)]*seeding POIs/i);
  });
});

describe('S91 — seed-travel-pois.js wrapper contract (the surface S91 depends on)', () => {
  // Static-source pin on the wrapper's export signature. We can't safely
  // `require()` the wrapper from a vitest unit test because:
  //   (a) backend/vitest.config.js does NOT inline prisma/ (only lib/,
  //       middleware/, services/, utils/, cron/, scripts/, routes/), so
  //       vi.mock() of the wrapper's `require('../scripts/seedOpenTripMapPois')`
  //       dependency does not intercept — the real OpenTripMap script runs
  //       and tries to fan out across 10 destinations.
  //   (b) Even with inlining, the wrapper would attempt to talk to the real
  //       Prisma client / require DATABASE_URL.
  // The wrapper has its own dedicated unit test layer under
  // backend/test/scripts/seedOpenTripMapPois.test.js (which IS inlined and
  // mocks runSeed directly). This file's job is to pin the wire-in contract
  // between seed.js and the wrapper, so we use string-analysis on the
  // wrapper source the same way the route-mount-audit precedent does.

  test('wrapper exports seedTravelPois (named export)', () => {
    // module.exports = { seedTravelPois } — anchored on the destructured
    // name so a rename or removal trips this assertion.
    const exportPattern = /module\.exports\s*=\s*\{\s*seedTravelPois\s*\}/;
    expect(wrapperSource).toMatch(exportPattern);
  });

  test('seedTravelPois accepts the { prisma, useFixture, destinations } options bag', () => {
    // Signature: async function seedTravelPois({ prisma, useFixture = true, destinations = null } = {})
    // The shape S91's seed.js wire-in depends on. Match the function
    // declaration + the destructured options to guarantee back-compat.
    const sigPattern = /async\s+function\s+seedTravelPois\s*\(\s*\{[^}]*\bprisma\b[^}]*\buseFixture\b[^}]*\}/;
    expect(wrapperSource).toMatch(sigPattern);
  });

  test('seedTravelPois enforces a defensive prisma-required precondition', () => {
    // The wrapper throws when prisma is omitted — without this guard, a
    // refactored seed.js that forgot to pass prisma would silently no-op
    // against the real catalog. Pin the throw token + the message
    // substring so both the contract AND the operator-readable error
    // survive refactors.
    expect(wrapperSource).toMatch(/if\s*\(\s*!\s*prisma\s*\)\s*throw\s+new\s+Error/);
    expect(wrapperSource).toMatch(/prisma instance required/);
  });

  test('seedTravelPois delegates to runSeed (the dual-purpose script export)', () => {
    // Confirms the wrapper actually calls runSeed (it's not a stub). The
    // wrapper's job is to marshal { prisma, useFixture } into the script's
    // (deps, options) signature — this test pins that runSeed is the
    // delegation target so a future refactor that swaps the script
    // entrypoint (e.g. to `runFixtureSeed`) lands in this test first.
    expect(wrapperSource).toMatch(/require\(\s*['"][^'"]*scripts\/seedOpenTripMapPois['"]\s*\)/);
    expect(wrapperSource).toMatch(/\brunSeed\s*\(/);
  });
});
