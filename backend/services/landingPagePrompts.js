/**
 * landingPagePrompts.js — prompt builder for the
 * landing-page-generate task.
 *
 * Single export: `buildDestinationLandingPagePrompt({ destination,
 * durationDays, audience, subBrand })` returns `{ system, user }` strings
 * for the Gemini call.
 *
 * Hard product rules from the user (PR-B kickoff):
 *
 *   The LLM is allowed to generate ONLY:
 *     - destinationHero copy        (headline, subhead, ctaText — no posterUrl)
 *     - highlightsGrid items        (icon + title + body)
 *     - cityCards descriptions      (tag + title + body — no img URLs)
 *     - inclusionsGrid items        (plain-text bullets)
 *     - itineraryTimeline content   (day, title, bullets)
 *     - tierPricing shell           (structural labels ONLY — every
 *                                    monetary field is the literal JSON
 *                                    value null, see scrubTierPricing
 *                                    in lib/landingPageGuard.js)
 *     - faqAccordion entries        (cat + q + a + categories list)
 *     - seoMeta                     (metaTitle, metaDescription)
 *     - suggestedTitle              (top-level)
 *     - suggestedSlug               (top-level)
 *
 *   The LLM MUST NOT emit:
 *     - tierPricing values          (the block exists as a shell, but
 *                                    amount / dueDate / vendor / tag are
 *                                    ALL null — operator fills them)
 *     - reviewCarousel blocks       (testimonials are manual-only)
 *     - any monetary value          (no ₹/$/€, no "5000", no "50% off")
 *     - any discount / promo claim  (no "save", "limited time", "exclusive")
 *     - any rating / satisfaction   (no "5-star", "97% satisfied")
 *     - any vendor / partner name   (no "Pvt Ltd", "Travel Stall", brand names)
 *     - any image URL              (posterUrl, img — all must be null)
 *
 * The companion guardrail
 * (backend/lib/landingPageGuard.js) re-validates every rule at the schema +
 * content-strip layers. This prompt's job is to set the LLM's expectations
 * so the guardrail's Layer 3 fallback is the exception, not the norm.
 */

'use strict';

// ── Voice + hallucination guards (inlined verbatim into the prompt) ──
const VOICE_RULES = [
  '- Write in a calm, observational, planner voice — informative, not promotional.',
  '- Address the reader directly when natural (e.g. "you", "your group"), but never claim outcomes you cannot guarantee.',
  '- Keep every sentence factual about the destination. No superlatives, no urgency manipulation.',
  '- Do not pretend to quote real travellers, schools, or partners.',
  '- Do not invent dates, prices, headcount caps, vendor names, or partner brands.',
];

const HARD_REJECTIONS = [
  '- NO monetary values: never write any number followed by ₹, $, €, £, INR, USD, EUR, Rs, k, lakh, crore, "off", "discount", or "%". Pricing is operator-entered, never AI-generated.',
  '- NO discount or promotional language: avoid "save", "discount", "limited time", "limited-time", "exclusive", "guaranteed", "best price", "lowest", "unbeatable", "deal", "offer".',
  '- NO testimonial language: never write quotes, reviewer names, "as told by", "we are loved", "thousands of happy travellers", or anything implying a customer said something.',
  '- NO ratings: no "5-star", "4.8/5", "rated", "highest-rated", "award-winning", "best in class".',
  '- NO vendor / partner / brand names: never write "Pvt Ltd", "Inc", "LLC", "Travel Stall", "TMC", "Globussoft", or any travel agency / airline / hotel chain. Do not invent ones either.',
  '- NO image URLs: every posterUrl, img, photoUrl field must be the literal JSON value null. Do not paste Unsplash, Pexels, or any other URL.',
  '- NO satisfaction claims: no "loved by", "trusted by", "thousands have", "everyone who attended".',
  '- NO tierPricing values: emit the tierPricing block as a SHELL (structural labels in `label` + `subtitle`), but every `amount` / `dueDate` / `vendor` / `tag` field MUST be the literal JSON value null. The operator types the real values into the builder.',
  '- NO reviewCarousel block: testimonials are operator-only. Do not emit a reviewCarousel entry under any circumstances.',
];

// ── Block shape contracts (a slice of what backend/services/
// landingPageRenderer.js's switch statement accepts). Keep these in sync
// with renderer + guardrail.
//
// The prompt enumerates these so the LLM emits exactly the shape the
// renderer + builder both understand — extra fields are rejected at the
// schema layer.
const ALLOWED_BLOCKS = [
  'destinationHero',
  'highlightsGrid',
  'cityCards',
  'safetyFeatures',
  'inclusionsGrid',
  'itineraryTimeline',
  'tierPricing',
  'faqAccordion',
  'contactFooter',
];

const ALLOWED_FAQ_CATEGORY_IDS = ['all', 'tour', 'logistics', 'safety', 'registration'];

/**
 * Slug rules: lowercase, [a-z0-9-]+, max 50 chars (matches backend
 * routes/landing_pages.js `SLUG_PATTERN`). The LLM emits a suggestion;
 * the route's slug-normalisation pipe runs anyway.
 */
const SLUG_RULES = 'lowercase letters, digits, and hyphens only; max 50 characters; should describe the destination + duration (e.g. "umrah-10-days", "bali-family-7d").';

/**
 * Build the prompt for one generation call.
 *
 * @param {Object} input
 * @param {string} input.destination     — free-text destination ("Umrah", "Bali", "Greece")
 * @param {number} input.durationDays    — integer 1-60
 * @param {string} input.audience        — free-text traveller profile ("Pilgrims", "School groups Grades 6-12")
 * @param {string} [input.subBrand]      — 'tmc' | 'rfu' | 'travelstall' | 'visasure' | null
 *
 * @returns {{ system: string, user: string }}
 */
function buildDestinationLandingPagePrompt(input) {
  const {
    destination = '',
    durationDays = 0,
    audience = '',
    subBrand = null,
  } = input || {};

  const destLabel = String(destination).trim().slice(0, 80) || '(unknown destination)';
  const daysLabel = Number.isFinite(durationDays) && durationDays > 0
    ? Math.min(60, Math.max(1, Math.trunc(durationDays)))
    : 1;
  const audienceLabel = String(audience).trim().slice(0, 200) || 'travellers';
  const subBrandLabel = subBrand ? String(subBrand).trim().slice(0, 40) : null;

  const system = [
    'You are a structured-content generator for a CRM\'s travel landing-page builder.',
    '',
    'Your task: produce a complete LandingPage block array describing the supplied destination, plus SEO metadata, a suggested page title, and a suggested URL slug. Return ONE JSON object — no markdown fences, no prose preamble, no trailing commentary.',
    '',
    'Required JSON shape (exact keys, no extras):',
    '{',
    '  "suggestedTitle": "<destination + duration, max 60 chars>",',
    '  "suggestedSlug": "<' + SLUG_RULES + '>",',
    '  "seoMeta": {',
    '    "metaTitle": "<max 60 chars, no clickbait, no caps-lock>",',
    '    "metaDescription": "<max 160 chars, factual, no promo language>"',
    '  },',
    '  "blocks": [ <ordered array of block objects — see below> ]',
    '}',
    '',
    'Block array MUST contain exactly these entries, in this order:',
    '  1. destinationHero',
    '  2. highlightsGrid',
    '  3. cityCards',
    '  4. safetyFeatures   (descriptive safety topics — see banned-content rules; do NOT invent specific operator ratios or named partners)',
    '  5. inclusionsGrid',
    '  6. itineraryTimeline',
    '  7. tierPricing      (structural shell only — amount/dueDate/vendor/tag/badge are ALL the literal JSON value null; operator fills these manually)',
    '  8. faqAccordion',
    '  9. contactFooter    (structural shell only — phone/email/ctaUrl/brandName are ALL the literal JSON value null; operator fills these manually)',
    '',
    'Block shapes (every field is required unless marked optional). Fields not listed here are forbidden — the schema validator rejects extras:',
    '',
    'destinationHero:',
    '  { "type": "destinationHero", "props": {',
    '      "destination": <string, ≤80 chars>,',
    '      "headline": <string, ≤80 chars>,',
    '      "subhead": <string, ≤200 chars>,',
    '      "posterUrl": null,',
    '      "countdownTo": null,',
    '      "ctaText": <string, ≤40 chars, e.g. "Reserve Your Spot">,',
    '      "ctaScrollTarget": "",',
    '      "palette": { "bg": "#1f1a17", "fg": "#ffffff", "accent": "#b8893b" }',
    '  }}',
    '',
    'highlightsGrid:',
    '  { "type": "highlightsGrid", "props": {',
    '      "title": <string, ≤60 chars>,',
    '      "subtitle": <string, ≤120 chars or empty>,',
    '      "items": [ { "icon": <single character or empty>, "title": <≤40 chars — short noun phrase naming the place or attraction>, "body": <≤140 chars — ONE clear sentence explaining what visitors do there or why it matters; rendered inline next to the title in the gains list, so keep it tight> }, … ]  // 4 to 6 items',
    '  }}',
    '',
    'cityCards:',
    '  { "type": "cityCards", "props": {',
    '      "title": <string, ≤60 chars>,',
    '      "subtitle": <string, ≤120 chars or empty>,',
    '      "cards": [ { "tag": <string, ≤22 chars, uppercase — a THEMATIC category that describes WHY this stop matters, NOT the city name. e.g. "TEA HERITAGE", "WILDLIFE", "SPIRITUAL CENTRE", "ANCIENT CAPITAL", "RIVERSIDE CULTURE", "ARTISAN QUARTER", "MOUNTAIN GATEWAY". The card already shows the title (e.g. "Jorhat") prominently — emitting "JORHAT" as the tag duplicates that and looks wrong>, "title": <≤40 chars>, "img": null, "body": <240-280 chars — 2-3 complete sentences describing what visitors do, see, and experience here; this is the back of the flip card and a short one-liner reads as empty>, "benefit": <≤140 chars — REQUIRED italic pull quote summarising the takeaway the traveller leaves with; must be a single complete sentence, never empty> }, … ]  // exactly 5 cards (the flip-card grid renders as 3 on top + 2 centred below; more than 5 overflows the layout)',
    '  }}',
    '',
    'safetyFeatures:',
    '  { "type": "safetyFeatures", "props": {',
    '      "title": <string, ≤60 chars, e.g. "Engineered for Safety">,',
    '      "subtitle": <string, ≤140 chars or empty>,',
    '      "items": [ { "icon": <single character>, "title": <≤40 chars>, "body": <≤200 chars — generic protocol-style description> }, … ]  // 3 to 6 items',
    '  }}',
    '  // The safetyFeatures block surfaces GENERIC safety reassurances (travel insurance included, pre-vetted accommodations, 24/7 emergency contact, dietary accommodations). DO NOT invent specific operator ratios ("1:20 supervision"), specific partner names ("Travel Stall"), specific certifications, or specific phone numbers. The operator edits this block to add their actual specifics.',
    '',
    'inclusionsGrid:',
    '  { "type": "inclusionsGrid", "props": {',
    '      "title": <string, ≤60 chars>,',
    '      "subtitle": "",',
    '      "items": [ <string, each ≤120 chars>, … ]  // 5 to 10 items, no monetary numbers',
    '  }}',
    '',
    'itineraryTimeline:',
    '  { "type": "itineraryTimeline", "props": {',
    '      "title": <string, ≤60 chars>,',
    '      "subtitle": <string, ≤120 chars or empty>,',
    '      "days": [ { "day": <integer 1..N>, "title": <≤60 chars>, "icon": <single character emoji or symbol, OPTIONAL — may be empty string>, "bullets": [ <string, ≤140 chars>, … ], "notes": <≤140 chars italic secondary line, OPTIONAL — for things like "Optional evening activity" or "Travel day, light schedule"; may be empty string> }, … ]',
    '  }}',
    '  // The days array MUST have exactly ' + daysLabel + ' entries — one per day of the trip. Each day needs a title plus 3-5 bullets describing the day\'s plan. Bullets are specific (named landmarks, dishes, experiences). Do not annotate bullets with prices or vendor names. icon and notes are OPTIONAL — populate them only when they add value (e.g. icon "✈" for arrival/departure days, notes for free time or optional activities).',
    '',
    'tierPricing:',
    '  { "type": "tierPricing", "props": {',
    '      "title": <string, ≤60 chars, e.g. "Investment">,',
    '      "subtitle": "",',
    '      "currency": "₹",',
    '      "tiers": [',
    '        { "step": 1, "label": <descriptive instalment label, ≤40 chars, e.g. "First Instalment">, "subtitle": <short context, ≤60 chars, e.g. "Booking confirmation">, "amount": null, "dueDate": null, "vendor": null, "tag": null, "badge": null },',
    '        { "step": 2, "label": <descriptive instalment label, ≤40 chars, e.g. "Mid-term Payment">, "subtitle": <short context, ≤60 chars, e.g. "Pre-departure">, "amount": null, "dueDate": null, "vendor": null, "tag": null, "badge": null },',
    '        { "step": 3, "label": <descriptive instalment label, ≤40 chars, e.g. "Final Payment">, "subtitle": <short context, ≤60 chars, e.g. "On confirmation of itinerary">, "amount": null, "dueDate": null, "vendor": null, "tag": null, "badge": null }',
    '      ]',
    '  }}',
    '  // The tierPricing block is a STRUCTURAL SHELL only. amount / dueDate / vendor / tag / badge fields MUST be the literal JSON value null on every tier. Do NOT invent monetary values, due dates, vendor names, or promotional badges. The operator fills these in the builder before publishing. Three tiers is the canonical default; you may emit 1-4 tiers if the audience genuinely calls for a different cadence (e.g. single deposit for a short trip).',
    '',
    'faqAccordion:',
    '  { "type": "faqAccordion", "props": {',
    '      "title": <string, ≤60 chars>,',
    '      "subtitle": <string, ≤120 chars or empty>,',
    '      "categories": [ { "id": <one of "all", "tour", "logistics", "safety", "registration">, "label": <≤30 chars>, "icon": <single character> } ],',
    '      "faqs": [ { "cat": <category id from categories list>, "q": <≤140 chars>, "a": <≤500 chars — full, conversational answer with specifics> }, … ]  // 6 to 10 FAQs covering tour, logistics, safety, registration',
    '  }}',
    '',
    'contactFooter:',
    '  { "type": "contactFooter", "props": {',
    '      "brandName": null,',
    '      "phone": null,',
    '      "email": null,',
    '      "ctaText": <string, ≤30 chars, e.g. "Reserve Your Spot">,',
    '      "ctaUrl": null',
    '  }}',
    '  // The contactFooter is a STRUCTURAL SHELL. brandName / phone / email / ctaUrl MUST be the literal JSON value null. Only ctaText is AI-generated (a short structural CTA label). The operator fills in the real brand / contact details / link in the builder before publishing.',
    '',
    'BLOCKS YOU MUST NOT EMIT:',
    '  - reviewCarousel — testimonials are operator-only. Omit entirely.',
    '  - travelVideo — URLs must come from the operator. Omit entirely.',
    '  - brochureDownload — file URLs must come from the operator. Omit entirely.',
    '  - Any block type other than the nine listed above.',
    '',
    'Voice rules:',
    ...VOICE_RULES,
    '',
    'Hard rejections (the downstream guardrail will strip any field that violates these, even if you think the wording is harmless):',
    ...HARD_REJECTIONS,
    '',
    'If you cannot produce a field without violating a rule, return an empty string (or null for explicit-null fields). An empty field is safe; a rule-violating field is dropped.',
    '',
    'Return the JSON now. No markdown, no fences, no commentary.',
  ].join('\n');

  const user = [
    'Inputs for this generation:',
    '',
    `Destination: ${destLabel}`,
    `Duration (days): ${daysLabel}`,
    `Audience: ${audienceLabel}`,
    `Sub-brand: ${subBrandLabel || '(not specified)'}`,
    '',
    'Constraints recap:',
    '- Block count: exactly 9 (in the order destinationHero → highlightsGrid → cityCards → safetyFeatures → inclusionsGrid → itineraryTimeline → tierPricing → faqAccordion → contactFooter).',
    `- itineraryTimeline.days MUST have exactly ${daysLabel} entries.`,
    '- Every img / posterUrl field is the literal JSON value null.',
    '- tierPricing is a SHELL — every amount / dueDate / vendor / tag / badge MUST be the literal JSON value null. Do NOT invent any pricing data or promotional labels.',
    '- contactFooter is a SHELL — brandName / phone / email / ctaUrl MUST be the literal JSON value null. Only ctaText is structural copy.',
    '- safetyFeatures contains GENERIC descriptive content only — no specific operator ratios, partner brands, or invented certifications.',
    '- No reviewCarousel, travelVideo, or brochureDownload blocks. (These are operator-added because URLs and testimonials cannot be AI-generated.)',
    '- No monetary values, discounts, vendor names, ratings, or testimonial language anywhere.',
    '',
    'Produce the JSON object now.',
  ].join('\n');

  return { system, user };
}

module.exports = {
  buildDestinationLandingPagePrompt,
  // Exported for unit-test introspection + future config UI surfaces.
  VOICE_RULES,
  HARD_REJECTIONS,
  ALLOWED_BLOCKS,
  ALLOWED_FAQ_CATEGORY_IDS,
  SLUG_RULES,
};
