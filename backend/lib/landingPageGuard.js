/**
 * landingPageGuard.js — 3-layer validation for AI-generated landing-page
 * block JSON.
 *
 * Why: the Gemini call is asked to follow the prompt rules in
 * services/landingPagePrompts.js, but the LLM can ignore those at any
 * time. This guard is the contract enforcement — every output that
 * reaches the operator's builder canvas has been through:
 *
 *   Layer 1 (schema)
 *     Top-level shape: { suggestedTitle, suggestedSlug, seoMeta, blocks }
 *     Each block has type ∈ ALLOWED_BLOCKS, required props present,
 *     extra props removed. Block array has the right ordering + count
 *     for each block type.
 *     If Layer 1 fails → fall through to Layer 3 fallback.
 *
 *   Layer 2 (content strip-check)
 *     Walks every string field and runs the strict bans declared by the
 *     user in the PR-B kickoff:
 *       - Monetary values (₹/$/€/INR/USD/EUR/Rs/k/lakh/crore/% off)
 *       - Discount + promo terms (save, discount, limited time, …)
 *       - Rating + satisfaction claims (5-star, 97% satisfied, …)
 *       - Vendor / partner names (Pvt Ltd, Inc, LLC, named brands)
 *       - Testimonial-pattern language ("loved by", "thousands have")
 *       - Disallowed block types (tierPricing, reviewCarousel — strip)
 *       - Non-null image URLs (posterUrl, img — coerce to null)
 *     Each violation is either CORRECTABLE (nulled / stripped without
 *     dropping the block) or BLOCKING (drops the block). The output
 *     after Layer 2 is the "scrubbed" version of the LLM's response.
 *     If ≥ 3 blocks were dropped OR seoMeta is unrecoverable → Layer 3.
 *
 *   Layer 3 (deterministic fallback)
 *     Builds a complete block array from the input parameters alone,
 *     with every editable field marked "[REVIEW]" so the operator can
 *     see the page is a placeholder. Same shape as a successful Layer 1
 *     pass, so the builder consumer doesn't branch.
 *
 * Public surface:
 *   guardLandingPageOutput(rawOutput, input) → {
 *     accepted: boolean,
 *     verdict: 'passed' | 'scrubbed' | 'fallback',
 *     output: { suggestedTitle, suggestedSlug, seoMeta, blocks },
 *     issues: string[],   // human-readable reasons
 *   }
 *
 *   buildDeterministicFallback(input) → same `output` shape
 *
 * Both functions are PURE. No I/O, no Prisma, no global state.
 */

'use strict';

const { ALLOWED_BLOCKS, ALLOWED_FAQ_CATEGORY_IDS } = require('../services/landingPagePrompts');

// ── Strict-ban regex tables (PR-B kickoff hard rules) ────────────────
//
// The patterns are case-insensitive and anchored on word boundaries so
// they don't false-positive on legitimate prose (e.g. "save the date"
// is caught by "save", but "savory cuisine" is NOT — \bsave\b vs \bsave\w).

// Currency symbols + INR/USD/EUR keywords + Indian number-word units.
// Catches "₹5000", "Rs 25,000", "USD 100", "₹50 lakh", "5 crore", "25k".
const MONEY_REGEX = /(?:₹|\$|€|£|Rs\.?\s*|\bINR\b|\bUSD\b|\bEUR\b|\bGBP\b)\s*\d|\b\d+\s*(?:k\b|lakh\b|crore\b|cr\b)/i;

// Discount / percent-off / "20% off" / "save 50%".
const DISCOUNT_REGEX = /\b\d+(?:\.\d+)?\s*%\s*(?:off|discount|save|savings)\b|\bsave\s+\d|\b\d+\s*%\s*off/i;

// Promotional vocabulary — single-word + multi-word.
const PROMO_REGEX = /\b(?:limited[- ]?time|exclusive(?:\s+offer)?|guaranteed|best\s+price|lowest\s+price|unbeatable|special\s+deal|flash\s+sale|early[- ]bird|act\s+fast|don't\s+miss|book\s+now\s+and\s+save)\b/i;

// "Save" / "discount" / "free" / "offer" as standalone promotional verbs.
// Tighter than PROMO_REGEX to avoid "save the date" / "discount on shopping"
// (acceptable in faqAccordion) — only fires when paired with a number or
// a money symbol on the same line. Combined with MONEY_REGEX above.
const STANDALONE_PROMO_REGEX = /\b(?:discount|offer|deal|sale)\b/i;
const STANDALONE_SAVE_PROMO_REGEX = /\bsave\s+(?:up\s+to\s+)?\d/i;

// Rating / star / satisfaction claims.
// Three alternations:
//   1. "X.Y/5" or "X/5" (split rating notation)
//   2. "<digit> star(s)" / "<digit>-star" / "<digit> rated" / "<digit> out of 5"
//      The [\s-]* lets the digit be glued to "star" by a hyphen rather
//      than a space ("5-star" is the canonical hyphenated form).
//   3. Whole-word brand-claim phrases (award-winning, top-rated, etc.)
const RATING_REGEX = /\b\d(?:\.\d+)?\s*\/\s*5\b|\b\d(?:\.\d+)?[\s-]*(?:star|stars|rating|rated|out\s+of\s+5)\b|\b(?:award[- ]winning|highest[- ]?rated|best[- ]?in[- ]?class|top[- ]?rated|five[- ]?star)\b/i;

const SATISFACTION_REGEX = /\b(?:thousands\s+of\s+(?:happy|satisfied)|loved\s+by\s+thousands|\d+%\s+satisfied|trusted\s+by\s+(?:thousands|millions|over)|highly\s+(?:rated|recommended\s+by)|customer[- ]?favourite)\b/i;

// Vendor / corporate suffix patterns. Catches "TMC Nexus Pvt Ltd",
// "Acme Inc", "Travel Stall LLC". Plus a small allowlist-of-blocks
// for known partner brands the user explicitly called out.
const CORPORATE_SUFFIX_REGEX = /\b(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Pvt\s+Ltd|LLC|Inc\.?|Corp\.?|Corporation|GmbH|S\.?A\.?|Co\.?\s*Ltd)\b/i;
const VENDOR_NAME_REGEX = /\b(?:travel\s*stall|tmc\s*nexus|globussoft|callified|adsgpt|voyagr|ratehawk)\b/i;

// Testimonial-pattern language (quote markers, named travellers).
// Conservative: only fires on obvious patterns so legitimate destination
// prose (e.g. "travellers say Tokyo is busiest in spring") isn't flagged.
//
// Each alternation owns its boundary anchors because the em-dash form
// (`— Priya S.`) has no word characters at either end — a single
// outer `\b…\b` would suppress it. The em-dash class accepts both em-dash
// (U+2014) and hyphen-minus.
const TESTIMONIAL_REGEX = /\bas\s+told\s+by\b|\bin\s+the\s+words\s+of\b|\bone\s+(?:parent|student|traveller)\s+(?:said|told\s+us)\b|[—-]\s*[A-Z][a-z]+\s+[A-Z]\.|\bquoted\s+from\s+a\s+(?:past|previous)\s+(?:traveller|customer)\b/i;

// Image URL patterns. ANY non-null value in posterUrl/img is forbidden —
// not even a /uploads/ path. Operator uploads in the builder.
const URL_REGEX = /^https?:\/\/|^\/uploads\//i;

// ── Top-level scrub patterns ─────────────────────────────────────────

/**
 * Walk one string. Return either the original string (passes) or an
 * object describing what's wrong: { reason: <code>, original: <string> }.
 *
 * Reasons:
 *   - 'money'     monetary value detected
 *   - 'discount'  percent-off / discount claim
 *   - 'promo'     promotional language
 *   - 'rating'    rating / star / satisfaction claim
 *   - 'vendor'    corporate suffix or known vendor name
 *   - 'testimonial' testimonial-pattern language
 *
 * Caller decides per-field whether to strip (replace with "") or null
 * out the parent block.
 */
function classifyText(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (MONEY_REGEX.test(value)) return { reason: 'money' };
  if (DISCOUNT_REGEX.test(value)) return { reason: 'discount' };
  if (STANDALONE_SAVE_PROMO_REGEX.test(value)) return { reason: 'discount' };
  if (PROMO_REGEX.test(value)) return { reason: 'promo' };
  if (RATING_REGEX.test(value)) return { reason: 'rating' };
  if (SATISFACTION_REGEX.test(value)) return { reason: 'satisfaction' };
  if (CORPORATE_SUFFIX_REGEX.test(value)) return { reason: 'vendor' };
  if (VENDOR_NAME_REGEX.test(value)) return { reason: 'vendor' };
  if (TESTIMONIAL_REGEX.test(value)) return { reason: 'testimonial' };
  // STANDALONE_PROMO_REGEX is intentionally evaluated LAST — many legitimate
  // FAQ answers reference these terms (e.g. "Are there shopping discounts
  // available?" is fine in context). Only flag if a money/percent token is
  // ALSO present on the same line.
  if (STANDALONE_PROMO_REGEX.test(value) && /\d/.test(value)) return { reason: 'promo' };
  return null;
}

function isStringLike(v) { return typeof v === 'string'; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Length caps shared with the prompt. The guard is the source of truth —
// the prompt mirrors these so the LLM aims at them, but the guard trims
// over-length strings rather than rejecting whole blocks.
const CAPS = {
  suggestedTitle: 60,
  metaTitle: 60,
  metaDescription: 160,
  hero_destination: 80,
  hero_headline: 80,
  hero_subhead: 200,
  hero_ctaText: 40,
  highlights_title: 60,
  highlight_item_title: 40,
  highlight_item_body: 240, // PR-C: 180 → 240 for richer copy
  cities_title: 60,
  city_tag: 20,
  city_title: 40,
  city_body: 280, // PR-C: 200 → 280 for richer descriptions
  city_benefit: 140, // PR-C NEW
  safety_title: 60,
  safety_item_title: 40,
  safety_item_body: 200,
  inclusions_title: 60,
  inclusions_item: 120,
  itinerary_title: 60,
  itinerary_day_title: 60,
  itinerary_bullet: 140, // PR-C: 120 → 140
  itinerary_day_notes: 140, // PR-C NEW
  pricing_title: 60,
  pricing_tier_label: 40,
  pricing_tier_subtitle: 60,
  faq_title: 60,
  faq_q: 140,
  faq_a: 500, // PR-C: 320 → 500 for longer answers
  faq_category_label: 30,
  contact_brandName: 60,
  contact_ctaText: 30,
  section_subtitle: 140,
};

/**
 * Trim a string to a cap. Empty / non-string → empty string.
 */
function trim(value, cap) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (t.length <= cap) return t;
  return t.slice(0, cap);
}

/**
 * Normalise a slug suggestion. Drops anything outside [a-z0-9-], collapses
 * repeated hyphens, trims to 50 chars (the backend route's SLUG_PATTERN).
 */
function normaliseSlug(value) {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// ── Layer 1 — Schema validation ──────────────────────────────────────

const ALLOWED_BLOCK_SET = new Set(ALLOWED_BLOCKS);
// Only reviewCarousel + URL-bearing blocks are dropped entirely:
//   - reviewCarousel: testimonials are manual-only (no AI hallucination)
//   - travelVideo:    URLs come from operator (no AI URL fabrication)
//   - brochureDownload: file URLs come from operator
// tierPricing + contactFooter are preserved as structural shells (every
// commercial field nulled by their scrubbers). Operator fills the shells
// in the builder before publishing.
const DISALLOWED_BLOCK_TYPES = new Set(['reviewCarousel', 'travelVideo', 'brochureDownload']);

/**
 * Top-level shape check. Returns null if OK, else array of issue strings.
 */
function validateTopLevelSchema(output) {
  const reasons = [];
  if (!isObject(output)) {
    return ['schema.not_object'];
  }
  if (!isNonEmptyString(output.suggestedTitle)) reasons.push('schema.missing_suggestedTitle');
  if (!isNonEmptyString(output.suggestedSlug)) reasons.push('schema.missing_suggestedSlug');
  if (!isObject(output.seoMeta)) {
    reasons.push('schema.missing_seoMeta');
  } else {
    if (!isStringLike(output.seoMeta.metaTitle)) reasons.push('schema.missing_metaTitle');
    if (!isStringLike(output.seoMeta.metaDescription)) reasons.push('schema.missing_metaDescription');
  }
  if (!Array.isArray(output.blocks)) reasons.push('schema.blocks_not_array');
  return reasons.length > 0 ? reasons : null;
}

// ── Layer 2 — Per-block scrubbers ────────────────────────────────────
//
// Each scrubber returns either { ok: true, block: <cleaned block> } or
// { ok: false, issues: [...] }. The cleaned block is guaranteed to have
// only the allowlisted prop keys and trimmed strings.

function scrubText(value, cap, issues, label) {
  const trimmed = trim(value, cap);
  if (trimmed.length === 0) return '';
  const cls = classifyText(trimmed);
  if (cls) {
    issues.push(`${label}:${cls.reason}`);
    return '';
  }
  return trimmed;
}

function scrubDestinationHero(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('hero:bad_shape');
    return null;
  }
  const p = block.props;
  // posterUrl forced to null regardless of what the LLM emitted.
  let posterFlag = false;
  if (p.posterUrl != null && p.posterUrl !== '') posterFlag = true;
  if (posterFlag) issues.push('hero:posterUrl_must_be_null');
  return {
    type: 'destinationHero',
    props: {
      destination: scrubText(p.destination, CAPS.hero_destination, issues, 'hero.destination'),
      headline: scrubText(p.headline, CAPS.hero_headline, issues, 'hero.headline'),
      subhead: scrubText(p.subhead, CAPS.hero_subhead, issues, 'hero.subhead'),
      posterUrl: null,
      countdownTo: null,
      ctaText: scrubText(p.ctaText, CAPS.hero_ctaText, issues, 'hero.ctaText') || 'Reserve Your Spot',
      ctaScrollTarget: '',
      palette: { bg: '#1f1a17', fg: '#ffffff', accent: '#b8893b' },
    },
  };
}

function scrubHighlightsGrid(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('highlights:bad_shape');
    return null;
  }
  const p = block.props;
  const items = Array.isArray(p.items) ? p.items : [];
  const cleanedItems = items.map((it, i) => {
    if (!isObject(it)) {
      issues.push(`highlights.items[${i}]:bad_shape`);
      return null;
    }
    return {
      icon: scrubText(it.icon, 3, issues, `highlights.items[${i}].icon`) || '◈',
      title: scrubText(it.title, CAPS.highlight_item_title, issues, `highlights.items[${i}].title`),
      body: scrubText(it.body, CAPS.highlight_item_body, issues, `highlights.items[${i}].body`),
    };
  }).filter((it) => it && it.title);
  return {
    type: 'highlightsGrid',
    props: {
      title: scrubText(p.title, CAPS.highlights_title, issues, 'highlights.title') || 'Why This Destination',
      subtitle: '',
      items: cleanedItems,
    },
  };
}

function scrubCityCards(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('cities:bad_shape');
    return null;
  }
  const p = block.props;
  const cards = Array.isArray(p.cards) ? p.cards : [];
  const cleanedCards = cards.map((c, i) => {
    if (!isObject(c)) {
      issues.push(`cities.cards[${i}]:bad_shape`);
      return null;
    }
    // AI must never emit img URLs. If non-null, log + null out.
    if (c.img != null && c.img !== '') issues.push(`cities.cards[${i}].img:must_be_null`);
    return {
      tag: scrubText(c.tag, CAPS.city_tag, issues, `cities.cards[${i}].tag`).toUpperCase(),
      title: scrubText(c.title, CAPS.city_title, issues, `cities.cards[${i}].title`),
      img: null,
      body: scrubText(c.body, CAPS.city_body, issues, `cities.cards[${i}].body`),
      // PR-C: optional cultural-depth pull quote. Empty string is fine.
      benefit: scrubText(c.benefit, CAPS.city_benefit, issues, `cities.cards[${i}].benefit`),
    };
  }).filter((c) => c && c.title);
  return {
    type: 'cityCards',
    props: {
      title: scrubText(p.title, CAPS.cities_title, issues, 'cities.title') || 'Where You\'ll Go',
      subtitle: scrubText(p.subtitle, CAPS.section_subtitle, issues, 'cities.subtitle'),
      cards: cleanedCards,
    },
  };
}

function scrubInclusionsGrid(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('inclusions:bad_shape');
    return null;
  }
  const p = block.props;
  const items = Array.isArray(p.items) ? p.items : [];
  const cleanedItems = items
    .map((s, i) => scrubText(s, CAPS.inclusions_item, issues, `inclusions.items[${i}]`))
    .filter((s) => s.length > 0);
  return {
    type: 'inclusionsGrid',
    props: {
      title: scrubText(p.title, CAPS.inclusions_title, issues, 'inclusions.title') || "What's Included",
      subtitle: '',
      items: cleanedItems,
    },
  };
}

function scrubItineraryTimeline(block, issues, expectedDays) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('itinerary:bad_shape');
    return null;
  }
  const p = block.props;
  const days = Array.isArray(p.days) ? p.days : [];
  const cleanedDays = days.map((d, i) => {
    if (!isObject(d)) {
      issues.push(`itinerary.days[${i}]:bad_shape`);
      return null;
    }
    const bullets = Array.isArray(d.bullets) ? d.bullets : [];
    const cleanedBullets = bullets
      .map((b, bi) => scrubText(b, CAPS.itinerary_bullet, issues, `itinerary.days[${i}].bullets[${bi}]`))
      .filter((b) => b.length > 0);
    // PR-C: optional icon (single character) + notes (italic secondary
    // line). Both empty by default.
    const rawIcon = typeof d.icon === 'string' ? d.icon.trim() : '';
    const icon = rawIcon.length > 0 && rawIcon.length <= 3 ? rawIcon : '';
    const notes = scrubText(d.notes, CAPS.itinerary_day_notes, issues, `itinerary.days[${i}].notes`);
    return {
      day: Number.isFinite(d.day) ? Number(d.day) : i + 1,
      title: scrubText(d.title, CAPS.itinerary_day_title, issues, `itinerary.days[${i}].title`),
      icon,
      bullets: cleanedBullets,
      notes,
    };
  }).filter((d) => d && d.title);

  if (expectedDays && cleanedDays.length !== expectedDays) {
    issues.push(`itinerary:day_count_mismatch:expected=${expectedDays},got=${cleanedDays.length}`);
  }

  return {
    type: 'itineraryTimeline',
    props: {
      title: scrubText(p.title, CAPS.itinerary_title, issues, 'itinerary.title') || 'Day-by-day',
      subtitle: scrubText(p.subtitle, CAPS.section_subtitle, issues, 'itinerary.subtitle'),
      days: cleanedDays,
    },
  };
}

// scrubTierPricing — preserves the block as a SHELL.
//
// AI is allowed to suggest structural labels (e.g. "First Instalment",
// "Booking confirmation") that the operator can keep or rename. EVERY
// commercial field — amount, dueDate, vendor, tag — is forced to null
// regardless of what the LLM emitted. If the LLM tried to inject a
// vendor name into the label, classifyText (called via scrubText) drops
// the offending string and the operator types a clean label.
//
// Empty tiers array → emit a deterministic 3-tier shell so the builder
// renders something visible. The publish gate (validatePublishReadiness
// in routes/landing_pages.js) will fail until amounts are entered.
function scrubTierPricing(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('pricing:bad_shape');
    return null;
  }
  const p = block.props;
  const rawTiers = Array.isArray(p.tiers) ? p.tiers : [];

  // Cap at 4 tiers (sensible UI max — matches existing TEMPLATES preset).
  const tiers = rawTiers.slice(0, 4).map((t, i) => {
    if (!isObject(t)) {
      issues.push(`pricing.tiers[${i}]:bad_shape`);
      return null;
    }
    // Defence-in-depth: if any of the commercial fields was non-null,
    // flag it so the verdict reflects the LLM violated the rule.
    if (t.amount != null && t.amount !== '') issues.push(`pricing.tiers[${i}].amount:must_be_null`);
    if (t.dueDate != null && t.dueDate !== '') issues.push(`pricing.tiers[${i}].dueDate:must_be_null`);
    if (t.vendor != null && t.vendor !== '') issues.push(`pricing.tiers[${i}].vendor:must_be_null`);
    if (t.tag != null && t.tag !== '') issues.push(`pricing.tiers[${i}].tag:must_be_null`);
    // PR-C: badge is operator-only (promotional / commercial labels).
    if (t.badge != null && t.badge !== '') issues.push(`pricing.tiers[${i}].badge:must_be_null`);
    return {
      step: Number.isFinite(t.step) ? Number(t.step) : i + 1,
      label: scrubText(t.label, CAPS.pricing_tier_label, issues, `pricing.tiers[${i}].label`),
      subtitle: scrubText(t.subtitle, CAPS.pricing_tier_subtitle, issues, `pricing.tiers[${i}].subtitle`),
      amount: null,
      dueDate: null,
      vendor: null,
      tag: null,
      badge: null,
    };
  }).filter((t) => t);

  // If everything got dropped (LLM emitted nonsense), backfill a
  // 3-tier deterministic shell so the block still renders + the publish
  // gate can fire its TIER_UNCONFIGURED issues per tier (which the
  // operator then resolves by entering amounts).
  const finalTiers = tiers.length > 0 ? tiers : [
    { step: 1, label: 'First Instalment', subtitle: 'Booking confirmation', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
    { step: 2, label: 'Mid-term Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
    { step: 3, label: 'Final Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
  ];

  return {
    type: 'tierPricing',
    props: {
      title: scrubText(p.title, CAPS.pricing_title, issues, 'pricing.title') || 'Investment',
      subtitle: '',
      currency: typeof p.currency === 'string' && p.currency.length <= 4 ? p.currency : '₹',
      tiers: finalTiers,
    },
  };
}

// scrubSafetyFeatures — same data shape as highlightsGrid (icon+title+
// body items) but the section is rendered dark-on-light to mirror the
// /trips SAFETY section. AI can populate generic descriptive content
// here; the prompt constrains it from inventing specific operator
// ratios or partner brands. Layer 2 content checks still fire.
function scrubSafetyFeatures(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('safety:bad_shape');
    return null;
  }
  const p = block.props;
  const items = Array.isArray(p.items) ? p.items : [];
  const cleanedItems = items.map((it, i) => {
    if (!isObject(it)) {
      issues.push(`safety.items[${i}]:bad_shape`);
      return null;
    }
    return {
      icon: scrubText(it.icon, 3, issues, `safety.items[${i}].icon`) || '◈',
      title: scrubText(it.title, CAPS.safety_item_title, issues, `safety.items[${i}].title`),
      body: scrubText(it.body, CAPS.safety_item_body, issues, `safety.items[${i}].body`),
    };
  }).filter((it) => it && it.title);
  return {
    type: 'safetyFeatures',
    props: {
      title: scrubText(p.title, CAPS.safety_title, issues, 'safety.title') || 'Engineered for Safety',
      subtitle: scrubText(p.subtitle, CAPS.section_subtitle, issues, 'safety.subtitle'),
      items: cleanedItems,
    },
  };
}

// scrubContactFooter — every contact field is operator-only. AI emits
// only the structural ctaText; brandName / phone / email / ctaUrl MUST
// be null. Defence-in-depth in case the LLM hallucinates a phone.
function scrubContactFooter(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('contact:bad_shape');
    return null;
  }
  const p = block.props;
  if (p.brandName != null && p.brandName !== '') issues.push('contact.brandName:must_be_null');
  if (p.phone != null && p.phone !== '') issues.push('contact.phone:must_be_null');
  if (p.email != null && p.email !== '') issues.push('contact.email:must_be_null');
  if (p.ctaUrl != null && p.ctaUrl !== '') issues.push('contact.ctaUrl:must_be_null');
  return {
    type: 'contactFooter',
    props: {
      brandName: null,
      phone: null,
      email: null,
      ctaText: scrubText(p.ctaText, CAPS.contact_ctaText, issues, 'contact.ctaText') || 'Reserve Your Spot',
      ctaUrl: null,
    },
  };
}

function scrubFaqAccordion(block, issues) {
  if (!isObject(block) || !isObject(block.props)) {
    issues.push('faq:bad_shape');
    return null;
  }
  const p = block.props;
  // Categories — accept only the allowlist ids.
  const cats = Array.isArray(p.categories) ? p.categories : [];
  const cleanedCats = cats.map((c, i) => {
    if (!isObject(c) || !isStringLike(c.id) || !ALLOWED_FAQ_CATEGORY_IDS.includes(c.id)) {
      issues.push(`faq.categories[${i}]:invalid_id`);
      return null;
    }
    return {
      id: c.id,
      label: scrubText(c.label, CAPS.faq_category_label, issues, `faq.categories[${i}].label`) || c.id,
      icon: scrubText(c.icon, 3, issues, `faq.categories[${i}].icon`) || '◇',
    };
  }).filter((c) => c);
  // Ensure "all" is present at the front so the public renderer's
  // category-filter UX has an "All" option.
  if (!cleanedCats.find((c) => c.id === 'all')) {
    cleanedCats.unshift({ id: 'all', label: 'All', icon: '◇' });
  }
  const allowedCatIds = new Set(cleanedCats.map((c) => c.id));
  const faqs = Array.isArray(p.faqs) ? p.faqs : [];
  const cleanedFaqs = faqs.map((f, i) => {
    if (!isObject(f)) {
      issues.push(`faq.faqs[${i}]:bad_shape`);
      return null;
    }
    const cat = isStringLike(f.cat) && allowedCatIds.has(f.cat) ? f.cat : 'all';
    const q = scrubText(f.q, CAPS.faq_q, issues, `faq.faqs[${i}].q`);
    const a = scrubText(f.a, CAPS.faq_a, issues, `faq.faqs[${i}].a`);
    if (!q || !a) return null;
    return { cat, q, a };
  }).filter((f) => f);
  return {
    type: 'faqAccordion',
    props: {
      title: scrubText(p.title, CAPS.faq_title, issues, 'faq.title') || 'Frequently Asked Questions',
      subtitle: '',
      categories: cleanedCats,
      faqs: cleanedFaqs,
    },
  };
}

const SCRUB_BY_TYPE = {
  destinationHero: scrubDestinationHero,
  highlightsGrid: scrubHighlightsGrid,
  cityCards: scrubCityCards,
  safetyFeatures: scrubSafetyFeatures,
  inclusionsGrid: scrubInclusionsGrid,
  itineraryTimeline: scrubItineraryTimeline,
  tierPricing: scrubTierPricing,
  faqAccordion: scrubFaqAccordion,
  contactFooter: scrubContactFooter,
};

// ── Layer 3 — Deterministic fallback ─────────────────────────────────
//
// Builds a complete, gate-clearing block array from input alone. Every
// field uses a "[REVIEW]" prefix so the operator sees at a glance that
// the page is a placeholder, not real content.

function buildDeterministicFallback(input) {
  const {
    destination = '(unknown destination)',
    durationDays = 3,
    audience = 'travellers',
  } = input || {};
  const destLabel = String(destination).trim().slice(0, 60) || '(unknown destination)';
  const days = Math.max(1, Math.min(60, Math.trunc(Number(durationDays) || 3)));
  const audienceLabel = String(audience).trim().slice(0, 60) || 'travellers';

  const itineraryDays = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    title: i === 0
      ? `[REVIEW] Arrival in ${destLabel}`
      : i === days - 1
        ? `[REVIEW] Departure from ${destLabel}`
        : `[REVIEW] Day ${i + 1}`,
    bullets: [
      '[REVIEW] Operator to add the day\'s key activity.',
      '[REVIEW] Operator to add the day\'s secondary activity.',
    ],
  }));

  return {
    suggestedTitle: `[REVIEW] ${destLabel} — ${days} day${days === 1 ? '' : 's'}`,
    suggestedSlug: normaliseSlug(`${destLabel}-${days}-days`),
    seoMeta: {
      metaTitle: `[REVIEW] ${destLabel} — ${days}-day trip`,
      metaDescription: `[REVIEW] Operator to write the SEO description for a ${days}-day ${destLabel} trip designed for ${audienceLabel}.`,
    },
    blocks: [
      {
        type: 'destinationHero',
        props: {
          destination: destLabel,
          headline: `[REVIEW] A ${days}-day journey to ${destLabel}`,
          subhead: `[REVIEW] Operator to add the destination's hook for ${audienceLabel}.`,
          posterUrl: null,
          countdownTo: null,
          ctaText: 'Reserve Your Spot',
          ctaScrollTarget: '',
          palette: { bg: '#1f1a17', fg: '#ffffff', accent: '#b8893b' },
        },
      },
      {
        type: 'highlightsGrid',
        props: {
          title: 'Why This Destination',
          subtitle: '',
          items: [
            { icon: '◈', title: '[REVIEW] Highlight one', body: '[REVIEW] Operator to describe.' },
            { icon: '⊕', title: '[REVIEW] Highlight two', body: '[REVIEW] Operator to describe.' },
            { icon: '⌂', title: '[REVIEW] Highlight three', body: '[REVIEW] Operator to describe.' },
          ],
        },
      },
      {
        type: 'cityCards',
        props: {
          title: "Where You'll Go",
          subtitle: '',
          cards: [
            { tag: 'PLACEHOLDER', title: '[REVIEW] City one', img: null, body: '[REVIEW] Operator to describe.', benefit: '' },
            { tag: 'PLACEHOLDER', title: '[REVIEW] City two', img: null, body: '[REVIEW] Operator to describe.', benefit: '' },
            { tag: 'PLACEHOLDER', title: '[REVIEW] City three', img: null, body: '[REVIEW] Operator to describe.', benefit: '' },
          ],
        },
      },
      {
        type: 'safetyFeatures',
        props: {
          title: 'Engineered for Safety',
          subtitle: '',
          items: [
            { icon: '🛡', title: '[REVIEW] Safety feature one', body: '[REVIEW] Operator to describe.' },
            { icon: '⚕', title: '[REVIEW] Safety feature two', body: '[REVIEW] Operator to describe.' },
            { icon: '☎', title: '[REVIEW] Safety feature three', body: '[REVIEW] Operator to describe.' },
          ],
        },
      },
      {
        type: 'inclusionsGrid',
        props: {
          title: "What's Included",
          subtitle: '',
          items: [
            '[REVIEW] Inclusion item 1',
            '[REVIEW] Inclusion item 2',
            '[REVIEW] Inclusion item 3',
            '[REVIEW] Inclusion item 4',
            '[REVIEW] Inclusion item 5',
          ],
        },
      },
      {
        type: 'itineraryTimeline',
        props: { title: 'Day-by-day', subtitle: '', days: itineraryDays },
      },
      {
        // Structural shell only — operator types real amounts / dates /
        // vendor names in the builder. Same shape as scrubTierPricing's
        // backfill so the renderer + publish gate behave identically
        // whether the page came from LLM-real, LLM-fallback, or template.
        type: 'tierPricing',
        props: {
          title: 'Investment',
          subtitle: '[REVIEW] Operator to enter real amounts before publishing.',
          currency: '₹',
          tiers: [
            { step: 1, label: 'First Instalment', subtitle: 'Booking confirmation', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
            { step: 2, label: 'Mid-term Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
            { step: 3, label: 'Final Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
          ],
        },
      },
      {
        type: 'faqAccordion',
        props: {
          title: 'Frequently Asked Questions',
          subtitle: '',
          categories: [
            { id: 'all', label: 'All', icon: '◇' },
            { id: 'tour', label: 'Tour', icon: '◈' },
            { id: 'logistics', label: 'Logistics', icon: '⊞' },
            { id: 'safety', label: 'Safety', icon: '⊕' },
          ],
          faqs: [
            { cat: 'tour', q: `[REVIEW] What is the highlight of this ${destLabel} trip?`, a: '[REVIEW] Operator to answer.' },
            { cat: 'logistics', q: '[REVIEW] What documents are required?', a: '[REVIEW] Operator to answer.' },
            { cat: 'safety', q: '[REVIEW] What safety protocols are in place?', a: '[REVIEW] Operator to answer.' },
            { cat: 'tour', q: `[REVIEW] Who is this ${days}-day trip designed for?`, a: `[REVIEW] Operator to confirm fit for ${audienceLabel}.` },
          ],
        },
      },
      {
        type: 'contactFooter',
        props: {
          brandName: null,
          phone: null,
          email: null,
          ctaText: 'Reserve Your Spot',
          ctaUrl: null,
        },
      },
    ],
  };
}

// ── Public surface ───────────────────────────────────────────────────

/**
 * Main entry. Validates the LLM's raw output and returns either the
 * scrubbed output or a deterministic fallback.
 *
 * @param {any} rawOutput              — the LLM's parsed JSON output
 * @param {Object} input
 * @param {string} input.destination
 * @param {number} input.durationDays
 * @param {string} [input.audience]
 * @param {string|null} [input.subBrand]
 *
 * @returns {{
 *   accepted: boolean,
 *   verdict: 'passed' | 'scrubbed' | 'fallback',
 *   output: { suggestedTitle: string, suggestedSlug: string,
 *             seoMeta: { metaTitle: string, metaDescription: string },
 *             blocks: Array<object> },
 *   issues: string[],
 * }}
 */
function guardLandingPageOutput(rawOutput, input = {}) {
  // Layer 1 — top-level schema check.
  const schemaIssues = validateTopLevelSchema(rawOutput);
  if (schemaIssues) {
    return {
      accepted: false,
      verdict: 'fallback',
      output: buildDeterministicFallback(input),
      issues: schemaIssues,
    };
  }

  const issues = [];

  // Strip the user-facing strings.
  const suggestedTitle = scrubText(rawOutput.suggestedTitle, CAPS.suggestedTitle, issues, 'suggestedTitle')
    || `[REVIEW] ${String(input.destination || '').trim() || 'Destination'} — ${input.durationDays || 1} day${input.durationDays === 1 ? '' : 's'}`;
  const suggestedSlug = normaliseSlug(rawOutput.suggestedSlug)
    || normaliseSlug(`${input.destination || 'destination'}-${input.durationDays || 1}-days`);
  const metaTitle = scrubText(rawOutput.seoMeta.metaTitle, CAPS.metaTitle, issues, 'seoMeta.metaTitle') || suggestedTitle;
  const metaDescription = scrubText(rawOutput.seoMeta.metaDescription, CAPS.metaDescription, issues, 'seoMeta.metaDescription')
    || `[REVIEW] Operator to write the SEO description for ${input.destination || 'this destination'}.`;

  // Walk each block. Disallowed types are stripped. Unknown types are dropped.
  const blocks = [];
  for (let i = 0; i < rawOutput.blocks.length; i += 1) {
    const block = rawOutput.blocks[i];
    if (!isObject(block) || !isStringLike(block.type)) {
      issues.push(`blocks[${i}]:bad_shape`);
      continue;
    }
    if (DISALLOWED_BLOCK_TYPES.has(block.type)) {
      issues.push(`blocks[${i}]:disallowed_type:${block.type}`);
      continue;
    }
    if (!ALLOWED_BLOCK_SET.has(block.type)) {
      issues.push(`blocks[${i}]:unknown_type:${block.type}`);
      continue;
    }
    const scrubber = SCRUB_BY_TYPE[block.type];
    const expectedDays = block.type === 'itineraryTimeline' ? input.durationDays : null;
    const cleaned = scrubber(block, issues, expectedDays);
    if (cleaned) blocks.push(cleaned);
    else issues.push(`blocks[${i}]:dropped:${block.type}`);
  }

  // If the LLM omitted required block types, fall back. The catalogue is
  // closed so a minimal viable page MUST include all 6 ALLOWED_BLOCKS.
  const presentTypes = new Set(blocks.map((b) => b.type));
  const missing = ALLOWED_BLOCKS.filter((t) => !presentTypes.has(t));
  if (missing.length > 0) {
    missing.forEach((t) => issues.push(`blocks:missing_required:${t}`));
    return {
      accepted: false,
      verdict: 'fallback',
      output: buildDeterministicFallback(input),
      issues,
    };
  }

  // Layer 3 trigger: if more than 5 individual issues fired (any field-
  // level scrub flagged something), fall back. Threshold chosen so a few
  // length-trims don't trip the fallback, but a systemic violation
  // (e.g. the LLM ignored "no money") does.
  if (issues.length > 5) {
    return {
      accepted: false,
      verdict: 'fallback',
      output: buildDeterministicFallback(input),
      issues,
    };
  }

  return {
    accepted: true,
    verdict: issues.length === 0 ? 'passed' : 'scrubbed',
    output: {
      suggestedTitle,
      suggestedSlug,
      seoMeta: { metaTitle, metaDescription },
      blocks,
    },
    issues,
  };
}

module.exports = {
  guardLandingPageOutput,
  buildDeterministicFallback,
  // Exported helpers for unit-test introspection.
  classifyText,
  validateTopLevelSchema,
  normaliseSlug,
  CAPS,
  MONEY_REGEX,
  DISCOUNT_REGEX,
  PROMO_REGEX,
  RATING_REGEX,
  SATISFACTION_REGEX,
  CORPORATE_SUFFIX_REGEX,
  VENDOR_NAME_REGEX,
  TESTIMONIAL_REGEX,
  URL_REGEX,
  DISALLOWED_BLOCK_TYPES,
};
