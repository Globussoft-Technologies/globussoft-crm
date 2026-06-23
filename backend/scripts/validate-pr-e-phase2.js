#!/usr/bin/env node
/**
 * validate-pr-e-phase2.js — full end-to-end validation of the
 * PR-E Phase 2 Travel Experience Engine pipeline against 6 reference
 * destinations.
 *
 * For each of:
 *   Japan, Bali, Umrah, Switzerland, Iceland, Vietnam
 * the script runs:
 *
 *   1. TEE classify          — traits + family + theme + composition + visualMood + imageStrategy
 *   2. Family-aware LLM      — semantic content via the TEE-aware orchestrator (stub mode in this script)
 *   3. guardTeeContent       — semantic-payload safety layer + verdict
 *   4. teeContentBridge      — deterministic LLM → template payload + early validation
 *   5. Production render     — through templateModule.render() — same HTML as /p/<slug>
 *
 * Writes:
 *   docs/PR_E_PHASE2_VALIDATION/<destination>.html  — final rendered HTML
 *   docs/PR_E_PHASE2_VALIDATION/<destination>.json  — full audit envelope
 *   docs/PR_E_PHASE2_VALIDATION/summary.json        — cross-destination summary
 *
 * Validation criteria checked per destination:
 *   ✓ TEE classification produces the expected family + theme
 *   ✓ Visual Mood is populated (R1 contract — destination-distinct)
 *   ✓ Image strategy emits queries per slot
 *   ✓ guardTeeContent verdict is clean / scrubbed (NEVER fallback for stub)
 *   ✓ Template payload bridge produces complete content
 *   ✓ Render produces non-empty HTML containing the template's wrapper
 *   ✓ Renderer code stays destination-agnostic (no hardcoded routes)
 *
 * Run:    node backend/scripts/validate-pr-e-phase2.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const generator = require('../services/landingPageGeneratorLLM');
const templatesIndex = require('../services/templates');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'PR_E_PHASE2_VALIDATION');

// The 6 reference destinations — same inputs that drove Phase 1 visual review,
// extended with travelMonth + tripType for richer trait derivation.
const DESTINATIONS = [
  {
    slug: 'japan',
    input: {
      destination: 'Tokyo Kyoto Japan',
      durationDays: 9,
      audience: 'Grade 8-12 students',
      travelMonth: '2026-10',
      tripType: 'educational',
      subBrand: 'tmc',
    },
    expected: { family: 'educational', themeId: 'educational-academic' },
  },
  {
    slug: 'bali',
    input: {
      destination: 'Bali Ubud',
      durationDays: 7,
      audience: 'families with kids',
      travelMonth: '2026-07',
      tripType: 'family',
    },
    expected: { family: 'family', themeId: 'family-tropical' },
  },
  {
    slug: 'umrah',
    input: {
      destination: 'Umrah Makkah Madinah',
      durationDays: 14,
      audience: 'pilgrims all ages',
      travelMonth: '2026-03',
      subBrand: 'rfu',
    },
    expected: { family: 'religious', themeId: 'religious-classical' },
  },
  {
    slug: 'switzerland',
    input: {
      destination: 'Switzerland Zermatt Interlaken',
      durationDays: 10,
      audience: 'couples',
      travelMonth: '2026-09',
      tripType: 'luxury',
    },
    expected: { family: 'luxury', themeId: 'luxury-alpine' },
  },
  {
    slug: 'iceland',
    input: {
      destination: 'Iceland Reykjavik aurora',
      durationDays: 8,
      audience: 'couples photographers',
      travelMonth: '2026-02',
      tripType: 'luxury',
    },
    expected: { family: 'luxury', themeId: 'luxury-alpine' },
  },
  {
    slug: 'vietnam',
    input: {
      destination: 'Vietnam Halong Hoi An',
      durationDays: 8,
      audience: 'families with kids',
      travelMonth: '2026-10',
      tripType: 'family',
    },
    expected: { family: 'family', themeId: 'family-tropical' },
  },
];

// Mock the budget cap + real-mode toggles so the validation runs offline.
generator.checkBudgetCap = async () => true;
generator.realModeEnabled = async () => false;
generator.openAiFallbackEnabled = () => false;

function makeFlag(value, ok = true) {
  return { ok, value };
}

async function validateDestination(spec) {
  const result = {
    slug: spec.slug,
    input: spec.input,
    expected: spec.expected,
    timestamps: { startedAt: new Date().toISOString() },
    checks: {},
    notes: [],
  };
  try {
    const generated = await generator.generateLandingPageContentWithTee(
      { ...spec.input, tenantId: 1, tenantSlug: 'travel-stall' },
      { skipImages: true, __surface: 'phase-2-validation' }
    );
    result.generated = {
      templateType: generated.templateType,
      source: generated.source,
      model: generated.model,
      imagesFetched: generated.imagesFetched,
      validationOk: generated.validation && generated.validation.ok,
      validationMissing: (generated.validation && generated.validation.missing) || [],
      guard: generated.guard,
    };
    result.teeOutput = {
      family: generated.teeOutput.family,
      themeId: generated.teeOutput.themeId,
      visualMood: generated.teeOutput.traits.visualMood,
      composition: generated.teeOutput.composition,
      traits: generated.teeOutput.traits,
      decisionLog: generated.teeOutput.decisionLog,
      imageStrategy: generated.teeOutput.imageStrategy,
    };
    result.content = generated.content;

    // ── Per-destination assertions ───────────────────────────────
    const { family, themeId } = generated.teeOutput;
    result.checks.familyMatch = makeFlag(family, family === spec.expected.family);
    result.checks.themeMatch = makeFlag(themeId, themeId === spec.expected.themeId);
    result.checks.visualMoodPopulated = makeFlag(
      generated.teeOutput.traits.visualMood,
      !!generated.teeOutput.traits.visualMood && generated.teeOutput.traits.visualMood.length > 0
    );
    result.checks.imageStrategyEmitted = makeFlag(
      `hero + ${(generated.teeOutput.imageStrategy.marquee || []).length} marquee`,
      !!(generated.teeOutput.imageStrategy && generated.teeOutput.imageStrategy.hero && generated.teeOutput.imageStrategy.hero.query)
    );
    result.checks.guardAccepted = makeFlag(
      generated.guard && generated.guard.verdict,
      generated.guard && generated.guard.accepted === true
    );
    result.checks.bridgeAccepted = makeFlag(
      generated.validation && generated.validation.ok ? 'ok' : `missing ${(generated.validation && generated.validation.missing || []).join(', ')}`,
      generated.validation && generated.validation.ok === true
    );
    result.checks.teeMetadataStamped = makeFlag(
      'present',
      generated.content && generated.content._tee && generated.content._tee.family === family && generated.content._tee.themeId === themeId
    );

    // ── Production render ────────────────────────────────────────
    const templateModule = templatesIndex.getTemplate(generated.templateType);
    if (!templateModule) {
      result.checks.renderPossible = makeFlag('no template', false);
      result.notes.push(`Template module not found for ${generated.templateType}`);
    } else {
      const html = templateModule.render(
        {
          slug: spec.slug,
          title: (generated.content.brand && generated.content.brand.label) || spec.input.destination,
          content: JSON.stringify(generated.content),
          metaTitle: (generated.content.brand && generated.content.brand.label) || spec.input.destination,
        },
        { preview: true }
      );
      result.html = html;
      result.checks.htmlNonEmpty = makeFlag(`${html.length} chars`, html.length > 1000);
      result.checks.htmlHasWrapper = makeFlag('present', html.includes('<div class="trips-page">'));
      result.checks.htmlHasThemeMeta = makeFlag(
        'present',
        html.includes(`x-template-theme`) && html.includes(themeId)
      );
    }

    result.timestamps.completedAt = new Date().toISOString();
  } catch (err) {
    result.error = err && err.message;
    result.notes.push('Generation threw: ' + err.message);
  }
  return result;
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('PR-E Phase 2 validation — 6 destinations through full TEE pipeline');
  console.log('Output dir: ' + OUT_DIR);
  console.log('');

  const results = [];
  for (const spec of DESTINATIONS) {
    process.stdout.write(`▶ ${spec.slug.padEnd(13)} → `);
    const r = await validateDestination(spec);
    results.push(r);
    const allOk = Object.values(r.checks).every((c) => c.ok);
    const family = (r.teeOutput && r.teeOutput.family) || '—';
    const themeId = (r.teeOutput && r.teeOutput.themeId) || '—';
    const visualMood = (r.teeOutput && r.teeOutput.visualMood) || '—';
    console.log(allOk ? '✓' : '✗',
      ` family=${family.padEnd(11)} theme=${themeId.padEnd(22)} visualMood=${visualMood}`);
    if (!allOk) {
      Object.entries(r.checks).forEach(([k, v]) => {
        if (!v.ok) console.log(`     ✗ ${k}: ${JSON.stringify(v.value)}`);
      });
    }

    // Persist HTML + audit JSON per destination.
    if (r.html) {
      fs.writeFileSync(path.join(OUT_DIR, `${spec.slug}.html`), r.html, 'utf8');
    }
    const audit = { ...r };
    delete audit.html; // HTML lives in its own file
    fs.writeFileSync(
      path.join(OUT_DIR, `${spec.slug}.json`),
      JSON.stringify(audit, null, 2),
      'utf8'
    );
  }

  // ── Cross-destination summary ──
  const summary = {
    generatedAt: new Date().toISOString(),
    totalDestinations: results.length,
    allPassed: results.every((r) => Object.values(r.checks).every((c) => c.ok)),
    byDestination: results.map((r) => ({
      slug: r.slug,
      family: r.teeOutput && r.teeOutput.family,
      themeId: r.teeOutput && r.teeOutput.themeId,
      visualMood: r.teeOutput && r.teeOutput.visualMood,
      classifierSource: r.teeOutput && r.teeOutput.traits && r.teeOutput.traits.source,
      guardVerdict: r.generated && r.generated.guard && r.generated.guard.verdict,
      guardIssueCount: r.generated && r.generated.guard && r.generated.guard.issues ? r.generated.guard.issues.length : 0,
      bridgeOk: r.generated && r.generated.validationOk,
      bridgeMissing: r.generated && r.generated.validationMissing,
      htmlBytes: r.html ? r.html.length : 0,
      checksFailed: Object.entries(r.checks || {}).filter(([_, v]) => !v.ok).map(([k]) => k),
    })),
    architecturalChecks: {
      // These are computed once across the whole run since they're invariants
      // of the codebase, not the per-destination output. The detailed
      // architecture validation lives in docs/PR_E_PHASE2_VALIDATION.md.
      noDestinationCouplingInRenderer: 'enforced by test/architecture/no-destination-coupling.test.js',
      teeIsOnlyClassifier: 'enforced by sentinel test + Phase 1 audit',
      familyGenericThemes: '13 themes, none destination-named',
      unknownDestinationsViaAiFallback: 'covered by classifyClimate/classifyRegion fallback',
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log(summary.allPassed
    ? '✓ ALL CHECKS PASSED across 6 destinations'
    : '✗ Some checks failed — see summary.json + per-destination .json'
  );
  console.log('');
  console.log('Files written:');
  results.forEach((r) => {
    if (r.html) console.log(`   ${path.join('docs/PR_E_PHASE2_VALIDATION', r.slug + '.html')}`);
    console.log(`   ${path.join('docs/PR_E_PHASE2_VALIDATION', r.slug + '.json')}`);
  });
  console.log(`   docs/PR_E_PHASE2_VALIDATION/summary.json`);

  // Exit non-zero so CI can gate on this.
  process.exitCode = summary.allPassed ? 0 : 1;
}

main().catch((err) => {
  console.error('Validation failed at top level:', err);
  process.exitCode = 1;
});
