#!/usr/bin/env node
/**
 * validate-landing-page-ai-quality.js
 *
 * Operator-runnable CLI harness for PR-C quality validation. Exercises
 * the real Gemini call against 4 destinations and prints a pass/fail
 * verdict per destination across the hard rules:
 *
 *   - destination-specific content appears (no fallback markers)
 *   - tierPricing block is present as a shell (every commercial field null)
 *   - contactFooter block is present as a shell (every contact field null)
 *   - safetyFeatures block is present with ≥3 items
 *   - no monetary values anywhere
 *   - no testimonial language
 *   - no rating claims
 *   - no vendor / partner brand names
 *   - no image URLs
 *   - itinerary day count matches input
 *
 * Usage:
 *   cd backend && node scripts/validate-landing-page-ai-quality.js
 *
 * Optionally limit destinations:
 *   DESTINATIONS=Umrah,Bali node scripts/validate-landing-page-ai-quality.js
 *
 * Writes a JSON report to docs/PR_C_AI_QUALITY_REPORT.json so UAT has
 * concrete evidence.
 *
 * The script DOES NOT touch any database — it calls the generator
 * service directly and inspects the returned JSON.
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env'), override: false });

const fs = require('fs');
const path = require('path');
const {
  generateLandingPageContent,
  realModeEnabled,
} = require('../services/landingPageGeneratorLLM');
const {
  MONEY_REGEX,
  DISCOUNT_REGEX,
  RATING_REGEX,
  SATISFACTION_REGEX,
  CORPORATE_SUFFIX_REGEX,
  VENDOR_NAME_REGEX,
  TESTIMONIAL_REGEX,
} = require('../lib/landingPageGuard');

const SCENARIOS = [
  { destination: 'Umrah', durationDays: 10, audience: 'Pilgrims from India', subBrand: 'rfu' },
  { destination: 'Bali', durationDays: 10, audience: 'Families with kids 6-12', subBrand: 'travelstall' },
  { destination: 'Thailand', durationDays: 7, audience: 'Couples on honeymoon', subBrand: 'travelstall' },
  { destination: 'Japan', durationDays: 9, audience: 'School groups Grades 6-12', subBrand: 'tmc' },
];

const TENANT_ID = parseInt(process.env.VALIDATE_TENANT_ID || '1', 10);

// Walk every string in a structure and run the predicate. Returns the
// first string that matches, or null. Used to detect any rule violation
// in the AI's structured output.
function findMatchingString(obj, predicate) {
  if (typeof obj === 'string') return predicate(obj) ? obj : null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findMatchingString(v, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const hit = findMatchingString(v, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

function validate(result, input) {
  const checks = [];
  const issues = [];

  // ── Destination-specific content (no fallback markers) ──
  const fallbackHit = findMatchingString(result, (s) => /\[REVIEW\]/.test(s));
  checks.push({ name: 'no-fallback-markers', pass: !fallbackHit, detail: fallbackHit || 'no [REVIEW] markers' });

  // ── Structural blocks present ──
  const blocks = Array.isArray(result.blocks) ? result.blocks : [];
  const byType = Object.fromEntries(blocks.map((b) => [b.type, b]));
  for (const required of ['destinationHero', 'highlightsGrid', 'cityCards', 'safetyFeatures', 'inclusionsGrid', 'itineraryTimeline', 'tierPricing', 'faqAccordion', 'contactFooter']) {
    checks.push({ name: `block-present:${required}`, pass: Boolean(byType[required]), detail: byType[required] ? 'present' : 'MISSING' });
  }

  // ── Itinerary day count matches input ──
  const itin = byType.itineraryTimeline;
  const itinDays = itin?.props?.days?.length || 0;
  checks.push({ name: 'itinerary-day-count', pass: itinDays === input.durationDays, detail: `expected ${input.durationDays}, got ${itinDays}` });

  // ── tierPricing shell — every commercial field null ──
  const pricing = byType.tierPricing;
  let pricingShellOk = Boolean(pricing) && Array.isArray(pricing.props?.tiers);
  let pricingViolation = null;
  if (pricingShellOk) {
    for (const t of pricing.props.tiers) {
      for (const field of ['amount', 'dueDate', 'vendor', 'tag', 'badge']) {
        if (t[field] != null && t[field] !== '') {
          pricingShellOk = false;
          pricingViolation = `${field}=${JSON.stringify(t[field])}`;
          break;
        }
      }
      if (!pricingShellOk) break;
    }
  }
  checks.push({ name: 'pricing-shell-null', pass: pricingShellOk, detail: pricingShellOk ? `${pricing?.props?.tiers?.length || 0} tiers, all commercial fields null` : `violation: ${pricingViolation}` });

  // ── contactFooter shell — every contact field null ──
  const contact = byType.contactFooter;
  let contactShellOk = Boolean(contact);
  let contactViolation = null;
  if (contact) {
    for (const field of ['brandName', 'phone', 'email', 'ctaUrl']) {
      if (contact.props?.[field] != null && contact.props?.[field] !== '') {
        contactShellOk = false;
        contactViolation = `${field}=${JSON.stringify(contact.props[field])}`;
        break;
      }
    }
  }
  checks.push({ name: 'contact-shell-null', pass: contactShellOk, detail: contactShellOk ? 'all contact fields null' : `violation: ${contactViolation}` });

  // ── safetyFeatures has ≥3 items ──
  const safety = byType.safetyFeatures;
  const safetyCount = safety?.props?.items?.length || 0;
  checks.push({ name: 'safety-items-≥3', pass: safetyCount >= 3, detail: `${safetyCount} items` });

  // ── No prohibited content anywhere ──
  const moneyHit = findMatchingString(result, (s) => MONEY_REGEX.test(s) || DISCOUNT_REGEX.test(s));
  checks.push({ name: 'no-money-or-discount', pass: !moneyHit, detail: moneyHit || 'clean' });

  const ratingHit = findMatchingString(result, (s) => RATING_REGEX.test(s));
  checks.push({ name: 'no-ratings', pass: !ratingHit, detail: ratingHit || 'clean' });

  const satHit = findMatchingString(result, (s) => SATISFACTION_REGEX.test(s));
  checks.push({ name: 'no-satisfaction-claims', pass: !satHit, detail: satHit || 'clean' });

  const vendorHit = findMatchingString(result, (s) => CORPORATE_SUFFIX_REGEX.test(s) || VENDOR_NAME_REGEX.test(s));
  checks.push({ name: 'no-vendor-names', pass: !vendorHit, detail: vendorHit || 'clean' });

  const testimonialHit = findMatchingString(result, (s) => TESTIMONIAL_REGEX.test(s));
  checks.push({ name: 'no-testimonials', pass: !testimonialHit, detail: testimonialHit || 'clean' });

  // ── No image URLs (posterUrl + img + fileUrl must all be null) ──
  const urlHit = findMatchingString(result, (s) => typeof s === 'string' && (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/uploads/')));
  checks.push({ name: 'no-urls', pass: !urlHit, detail: urlHit || 'clean' });

  // ── reviewCarousel block not present ──
  checks.push({ name: 'no-reviewCarousel', pass: !byType.reviewCarousel, detail: byType.reviewCarousel ? 'present!' : 'absent' });

  for (const c of checks) {
    if (!c.pass) issues.push(c);
  }

  return { checks, issues, passed: issues.length === 0 };
}

async function main() {
  const filter = (process.env.DESTINATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const scenarios = filter.length > 0
    ? SCENARIOS.filter((s) => filter.includes(s.destination))
    : SCENARIOS;

  const realMode = await realModeEnabled(TENANT_ID);
  if (!realMode) {
    console.error('\nGEMINI_API_KEY not configured in backend/.env (or SupplierCredential row missing).');
    console.error('Quality validation requires real Gemini calls — set the key and re-run.\n');
    process.exit(2);
  }

  console.log(`\nValidating ${scenarios.length} destination(s) against real Gemini (tenantId=${TENANT_ID})…\n`);

  const report = {
    tenantId: TENANT_ID,
    generatedAt: new Date().toISOString(),
    model: 'gemini-2.5-flash',
    scenarios: [],
  };

  let scenarioIndex = 0;
  for (const scenario of scenarios) {
    // Pace requests to avoid bursting the free-tier per-minute quota
    // (gemini-2.5-flash: 10 RPM on the free tier). 8s between calls
    // keeps us well under and gives the cascade a chance to recover
    // from any transient 503.
    if (scenarioIndex > 0) await new Promise((r) => setTimeout(r, 8000));
    scenarioIndex += 1;
    process.stdout.write(`→ ${scenario.destination} (${scenario.durationDays}d, ${scenario.audience}) … `);
    try {
      const result = await generateLandingPageContent({
        tenantId: TENANT_ID,
        ...scenario,
      });
      const v = validate(result, scenario);
      const passed = v.passed && result.source === 'gemini';
      console.log(`${passed ? 'PASS' : 'FAIL'} (source=${result.source}, verdict=${result.verdict}, ${v.issues.length} issue${v.issues.length === 1 ? '' : 's'})`);
      if (!passed) {
        for (const issue of v.issues) {
          console.log(`     ✗ ${issue.name}: ${issue.detail}`);
        }
      }
      report.scenarios.push({
        scenario,
        source: result.source,
        verdict: result.verdict,
        stub: result.stub,
        guardrailIssues: result.guardrailIssues || [],
        suggestedTitle: result.suggestedTitle,
        suggestedSlug: result.suggestedSlug,
        seoMeta: result.seoMeta,
        blockTypes: (result.blocks || []).map((b) => b.type),
        sampleHeroHeadline: result.blocks?.find((b) => b.type === 'destinationHero')?.props?.headline || null,
        passed,
        checks: v.checks,
      });
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      report.scenarios.push({ scenario, error: err.message });
    }
  }

  const docsDir = path.resolve(__dirname, '..', '..', 'docs');
  const outPath = path.join(docsDir, 'PR_C_AI_QUALITY_REPORT.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const allPassed = report.scenarios.every((s) => s.passed);
  console.log(`\nFull report written to ${outPath}`);
  console.log(`\nOverall: ${allPassed ? 'PASS' : 'FAIL'} (${report.scenarios.filter((s) => s.passed).length}/${report.scenarios.length} scenarios passed)\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(2);
});
