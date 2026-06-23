// PR-E Option B + Phase 2 — Architectural sentinel test.
//
// Enforces the destination-agnostic-renderer invariant: zero destination
// keywords appear in EXECUTABLE CODE of the renderer / templates /
// themeTokens modules. Comments + docstrings + SVG asset names + alias
// tables are permitted (they were classified as "Cosmetic / acceptable"
// in the Phase-1 destination-coupling audit).
//
// If this test fails, someone reintroduced destination-keyword routing
// somewhere downstream of the TEE. Fix by moving the routing logic INTO
// travelExperienceEngine.js (the ONE place destination strings may be
// read for classification — never for behavioral branching).

import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// Files that MUST stay destination-agnostic in executable code.
const PROTECTED_RENDERER_FILES = [
  'services/templates/universalComponents.js',
  'services/templates/educationalTripV1.js',
  'services/templates/religiousTourV1.js',
  'services/templates/familyTripV1.js',
  'services/templates/luxuryTourV1.js',
  'services/templates/travelPremiumV1.js',
  'services/templates/index.js',
  'services/landingPageRenderer.js',
];

// Forbidden destination keywords. Strict list — only checks well-known
// common-noun-collision-free destination names. (e.g. 'india' is too
// generic to safely ban; we use 'jakarta' / 'mumbai' which are unambiguous.)
const FORBIDDEN_DESTINATION_KEYWORDS = [
  'tokyo', 'kyoto', 'osaka', 'fuji', 'shinkansen',
  'mecca', 'makkah', 'madinah', 'medina', 'kaaba',
  'bali', 'jakarta', 'denpasar',
  'switzerland', 'zermatt', 'interlaken',
  'reykjavik', 'jokulsarlon', 'thingvellir',
  'hanoi', 'halong',
  'kerala', 'kashmir', 'gulmarg',
];

/**
 * Strip line comments + block comments + JSDoc + JS string literals so
 * the remaining text is pure executable code. We then check that text
 * for forbidden destination keywords.
 *
 * Two-pass strip:
 *   1. Block comments — /* … */
//    2. Line comments  — // …
//    3. String literals — '…' / "…" / `…`
//
// String stripping handles escaped quotes (\' \") and is intentionally
// permissive about template-literal contents (we may strip a few things
// inside ${…} that don't matter for this sentinel).
//
function stripCommentsAndStrings(source) {
  let out = source;
  // 1. Block comments (incl. JSDoc).
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  // 2. Line comments.
  out = out.replace(/\/\/[^\n]*/g, '');
  // 3. String literals — three quote types, handling escapes.
  out = out.replace(/'([^'\\]|\\.)*'/g, "''");
  out = out.replace(/"([^"\\]|\\.)*"/g, '""');
  out = out.replace(/`(?:\\.|[^`\\])*`/g, '``');
  return out;
}

describe('Architecture sentinel — no destination coupling in renderer code', () => {
  for (const relPath of PROTECTED_RENDERER_FILES) {
    test(`${relPath} has zero forbidden destination keywords in executable code`, () => {
      const absPath = path.resolve(__dirname, '..', '..', relPath);
      const source = fs.readFileSync(absPath, 'utf8');
      const codeOnly = stripCommentsAndStrings(source).toLowerCase();
      const hits = FORBIDDEN_DESTINATION_KEYWORDS.filter((kw) => {
        const re = new RegExp(`\\b${kw}\\b`);
        return re.test(codeOnly);
      });
      // If this fails, someone reintroduced destination-keyword routing.
      // Move the logic into backend/services/travelExperienceEngine.js
      // (the ONE module allowed to read destination strings).
      expect(hits).toEqual([]);
    });
  }

  test('travelExperienceEngine.js IS the single module allowed to read destination strings', () => {
    const teePath = path.resolve(__dirname, '..', '..', 'services/travelExperienceEngine.js');
    const tee = fs.readFileSync(teePath, 'utf8');
    const code = stripCommentsAndStrings(tee).toLowerCase();
    // Confirm the TEE exposes the canonical classifier surface — these
    // names show this is the destination-reading entry point.
    expect(code).toContain('classifyclimate');
    expect(code).toContain('classifyregion');
    expect(code).toContain('classify');
  });
});
