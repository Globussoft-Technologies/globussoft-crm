/**
 * teePrompts.js — PR-E Phase 2.2.
 *
 * Family-aware LLM prompt builder for the Travel Experience Engine.
 *
 * Architectural invariant (locked in Phase 2.2 user direction)
 * ────────────────────────────────────────────────────────────
 * TEE is the AUTHORITATIVE source of:
 *   family, themeId, visualMood, composition, imageStrategy
 *
 * The LLM MUST NOT re-classify or override those decisions. This file
 * receives the TEE output as EXPLICIT INPUTS and produces a prompt that
 * tells the LLM: "Generate content for this exact family, themed by
 * this exact visualMood, into this exact schema." The LLM emits only
 * the CONTENT slots; the bridge fills structural defaults.
 *
 * Flow: TEE → schema → prompt → structured-content generation → payload
 *
 * What this file does
 * ───────────────────
 *   - SHARED_GUARDRAILS — content bans the existing 3-layer guard
 *     enforces (no pricing, no testimonials, no vendor names, etc.).
 *     The prompt restates these so the LLM doesn't waste tokens on
 *     content the guard will scrub anyway.
 *
 *   - FAMILY_VOICE — voice rules per family (educational / religious
 *     / family / luxury). Each carries a "DO" list, a "DO NOT" list,
 *     example headlines, and tone descriptors.
 *
 *   - VISUAL_MOOD_GUIDANCE — how visualMood threads through the
 *     content slots: hero tone, copy style, image-query phrasing,
 *     CTA language register, FAQ tone. The visualMood label itself
 *     is destination-agnostic (the AI generated it from traits +
 *     destination); the GUIDANCE here uses it as a styling lever.
 *
 *   - PER_FAMILY_SCHEMA — the JSON output shape the LLM must emit
 *     for each family. Schemas differ per family because section
 *     composition and slot shapes differ (e.g. religious carries
 *     pilgrim+mahram registration fields; luxury skips programme).
 *
 *   - buildTeeContentPrompt({ teeOutput, input }) — assembles the
 *     final system + user prompts. Always callable; never throws.
 */

'use strict';

// ── SHARED GUARDRAILS (mirror the existing landingPageGuard scrub) ──
// The LLM is told these explicitly so it doesn't waste tokens on
// content the 3-layer guard would scrub anyway. This is a soft check;
// guard is still authoritative.

const SHARED_GUARDRAILS = `
HARD CONTENT BANS — output that violates these will be scrubbed:
  ❌ NO monetary values, prices, discounts, "save X%", "limited offer", "₹", "$", "EUR", "GBP", or any currency symbol
  ❌ NO testimonial / review / rating text. testimonials[] must be []. Reviewers are operator-only.
  ❌ NO vendor / brand / company names (Travel Stall, The Modern Classroom, RFU, Rahmat, named airlines, named hotels)
  ❌ NO image URLs. All posterUrl / img fields must be null or empty string. Image strategy is generated separately.
  ❌ NO promotional language ("best", "premium-rated", "world-class", "award-winning", "guaranteed")
  ❌ NO fabricated certifications ("ISO-certified", "AAA-rated") — operator adds real claims if any
  ❌ NO discount or promo codes
  ❌ NO operator phone numbers / emails / specific URLs (operator fills these)

PLACEHOLDER POLICY:
  ✅ Where the LLM cannot confidently fill a slot, leave it as the empty string ""
     OR populate with a [REVIEW] prefix (e.g. "[REVIEW] Outcome one"). The bridge
     converts empty strings to [REVIEW] placeholders so the operator sees what
     needs filling.
`;

// ── FAMILY VOICE rules ──────────────────────────────────────────────
// One voice block per family. Voice rules ARE WHERE the differentiation
// lives — same template structure, vastly different copy register.

const FAMILY_VOICE = Object.freeze({
  educational: {
    register: 'structured, achievement-oriented, parent-reassuring',
    tone: 'thoughtful, academic, factual — write for a parent investing in their child',
    DO: [
      'Frame outcomes in skill / cultural-fluency / discipline terms',
      'Reassure parents on safety, supervision, and structure at every turn',
      'Use measured language: "designed for", "structured around", "led by"',
      'Include 2-4 word kicker lines like "09 Days. 04 Cities."',
      'Reference learning outcomes (not "fun"), university-readiness exposure, cultural literacy',
    ],
    DONT: [
      'Casual / kid-friendly phrasing ("super fun", "kid-tastic")',
      'Religious / pilgrimage language',
      'Luxury / boutique register',
      'Adventure / extreme-sport language',
    ],
    examples: [
      'Headline: "Japan 2026 — Heritage Meets Tomorrow."',
      'Lede: "Tokyo, Kyoto, Osaka and Nara. A structured cultural immersion designed for serious students."',
      'CTA: "Reserve Your Seat" / "Register Now"',
    ],
  },
  religious: {
    register: 'reverent, scholar-led, care-focused, trust-driven',
    tone: 'measured, dignified, devotional — write for pilgrims AND their families back home',
    DO: [
      'Use pilgrimage / spiritual / devotional language ("guided", "scholar-led", "reverent")',
      'Emphasise CARE: doctor on tour, elderly-first, wheelchair access, near-Haram hotels',
      'Frame outcomes as spiritual clarity, devotional discipline, companionship',
      'For Umrah / Islamic pilgrimage: respect Arabic script and Islamic terminology (Haram, Tawaaf, Ihram, Mahram, Maulana)',
      'Registration fields are pilgrim + mahram (companion), NOT student + parent',
    ],
    DONT: [
      'Educational / school / student framing',
      'Family-holiday / "fun" language',
      'Luxury / boutique register',
      'Marketing exclamation ("amazing!", "incredible!")',
      'Photos of people, faces, or Allah\'s name — image queries must respect this',
    ],
    examples: [
      'Headline: "Umrah 2026 — Scholar-Led, Family-Cared."',
      'Lede: "Makkah and Madinah, with three-times-daily group du\'a, scholar-led guidance, and elderly-first care."',
      'CTA: "Reserve Your Place" / "Begin the Journey"',
    ],
  },
  family: {
    register: 'warm, vibrant, kid-friendly, photo-rich, joyful',
    tone: 'inviting, energetic, fun — write for parents planning a memorable holiday for the whole family',
    DO: [
      'Use family / holiday / activity / "memories" language',
      'Highlight kid activities, easy meals, beach time, photo moments, safety for children',
      'Emphasise "all sorted" / "we handle it" / "door-to-door" framing for parents',
      'Frame outcomes as memories, joy, family-time, photos, fun',
      'Registration asks for the lead family member name + headcount, NOT a student',
    ],
    DONT: [
      'Academic / educational framing',
      'Religious / pilgrimage language',
      'Editorial / minimal / "discerning" register',
      'Stiff or formal language',
    ],
    examples: [
      'Headline: "Bali Family 2026 — Slow, Saline, Sacred."',
      'Lede: "Sun, sand, and slow family time across three regions."',
      'CTA: "Book This Trip" / "Hold Your Dates"',
    ],
  },
  luxury: {
    register: 'editorial restraint, application-style, "considered", "curated", "private"',
    tone: 'sparse, elegant, photography-first — write fewer words; each one earns its place',
    DO: [
      'Use private / curated / boutique / considered language',
      'Restrained sentence construction — no exclamation marks, no superlatives',
      'Frame outcomes as: stillness, restoration, witnessing, slowness',
      'Application-style registration: "Apply", "Discovery call", "Concierge pairing"',
      'Emphasise "no groups, no queues, just you" — the privacy is the product',
      'Eyebrow uses "BY APPLICATION" or similar gatekeeping cue',
    ],
    DONT: [
      'Educational / academic framing',
      'Religious / pilgrimage language',
      'Family-holiday / vibrant register',
      'Loud or busy copy — luxury reads sparse',
      'Repeated CTAs — one clean ask per section',
    ],
    examples: [
      'Headline: "Switzerland — A Quietly Extraordinary Journey."',
      'Lede: "Zermatt, Interlaken, Lucerne, and Lake Geneva. By private train and chauffeur."',
      'CTA: "Apply" / "Begin the Conversation"',
    ],
  },
});

// ── VISUAL MOOD threading (R1 — drives hero/copy/image/CTA/FAQ) ─────
// The TEE generates a visualMood label per destination (e.g.
// 'northern-aurora-mystical', 'alpine-heritage-craft', 'lantern-streets-junk-cruise').
// This file uses it as a STYLING LEVER — never as routing logic. Two
// destinations sharing the same (family, themeId) but different
// visualMood get distinct copy + queries because the prompt threads
// visualMood into each section.

const VISUAL_MOOD_GUIDANCE = `
The visualMood label is a 2-4 word phrase capturing the destination's visual essence
(e.g. "northern-aurora-mystical", "alpine-heritage-craft", "lantern-streets-junk-cruise").
Thread it through every content surface:

  HERO TONE:        Hero copy should evoke the visualMood. If "aurora-mystical" → reference
                    long nights, watching, stillness. If "heritage-craft" → reference woodwork,
                    bells, generations of skill.
  CONTENT STYLE:    Cultural items + programme paragraphs lean into the visualMood's keywords
                    (without name-dropping the label itself — the operator never sees it).
  IMAGERY QUERIES:  Each image_strategy.* query already carries the visualMood from the TEE.
                    Do not rewrite the queries.
  CTA LANGUAGE:     CTA verb register matches visualMood. "Aurora-mystical" → "Begin the
                    journey"; "heritage-craft" → "Reserve a seat"; "lantern-streets" → "Book
                    this trip"; "sacred-haram-dawn" → "Reserve your place".
  FAQ TONE:         FAQ answers reflect the visualMood. Spiritual moods → measured + dignified;
                    family moods → warm + practical; luxury moods → restrained + considered.

Critical: visualMood NEVER references the destination by name. It's a style label only.
The destination string is provided separately for content reference.
`;

// ── PER-FAMILY SCHEMA — JSON shape the LLM must emit ────────────────
// Each family's schema is the SEMANTIC template payload, narrowed to
// the slots THIS family populates. The LLM emits only these slots;
// the bridge fills the rest (show flags, schema defaults, _tee block).

const EDUCATIONAL_SCHEMA = `
{
  "brand":        { "label": string,                "programmeName": string,            "programmeTagline": string },
  "hero": {
    "eyebrow":    { "date": string, "audience": string, "batchPill": string },
    "kicker":     string,
    "headline":   string,
    "lede":       string,
    "benefitCards": [ { "icon": string (single char like ◈⊕⌂❖), "title": string, "desc": string } ] (exactly 4 entries),
    "countdown":  { "label": string, "ctaText": string, "ctaHref": "#register" },
    "visualTitle": string,
    "visualSub":   string,
    "posterAlt":   string
  },
  "marquee":      { "cities": [ { "tag": string (≤14 chars uppercase), "title": string } ] (3-6 entries) },
  "programme": {
    "leftHeadline":   string,
    "leftParagraphs": [ string ] (2-3 entries),
    "rightHeadline":  string,
    "rightChecks":    [ string ] (3-5 entries)
  },
  "cultural": {
    "tag":          string (e.g. "CULTURAL HIGHLIGHTS"),
    "title":        string,
    "subtitle":     string,
    "items":        [ { "name": string, "label": string (≤24 chars uppercase),
                        "body": [ string ] (1-2 short paragraphs),
                        "benefit": string (≤14 words, a derived-benefit pull quote) } ] (4-6 entries)
  },
  "safety": {
    "title":     string,
    "subtitle":  string,
    "stats":     [ { "stat": string (e.g. "1:6", "24/7", "4★"), "title": string, "body": string } ] (3-4 entries),
    "features":  [ { "icon": "shield"|"briefcase"|"send"|"package"|"shieldCheck", "title": string, "desc": string } ] (3-4 entries),
    "included":  { "title": "What's Included", "items": [ string ] (5-8 entries) },
    "banner":    { "title": string, "body": string, "ctaText": string, "ctaHref": "#register" },
    "quote":     string
  },
  "investment": {
    "tag":       string (e.g. "TRANSPARENT PROGRAMME INVESTMENT"),
    "title":     string,
    "subtitle":  string,
    "tiers":     [ { "step": int, "title": string, "subtitle": string,
                     "amount": null, "tag": null, "date": null, "vendor": null } ] (2-3 entries),
    "inclusions": { "label": "INDICATIVE INCLUSIONS", "items": [ string ] (4-8 entries) }
  },
  "registration": {
    "tag":           string (e.g. "REGISTRATION"),
    "title":         string,
    "subtitle":      string,
    "coversTitle":   string,
    "coversIntro":   string,
    "covers":        [ { "title": string, "body": string } ] (3-4 entries)
  },
  "faq": {
    "tag":        string (e.g. "CLARIFICATIONS"),
    "title":      string,
    "subtitle":   string,
    "categories": [ { "id": string, "label": string, "icon": string } ] (3-5 entries; first id="all"),
    "items":      [ { "cat": string (matches categories[*].id), "q": string, "a": string } ] (6-12 entries)
  },
  "finalCta": {
    "eyebrow":   string,
    "title":     string,
    "subtitle":  string,
    "steps":     [ { "label": string } ] (3-4 entries)
  },
  "contact": {
    "label":   string,
    "tagline": string
  }
}
`;

// For the OTHER 3 families, the schema is the same SHAPE but with
// family-appropriate slot labels (registration funnel asks for
// pilgrim+mahram on religious; family lead+headcount on family;
// guest+companion on luxury). The LLM is told to emit the same JSON
// keys; the bridge maps to template-specific field names. This keeps
// the prompt small + the LLM output uniform.

function schemaFor(family) {
  // We currently use one schema string for the LLM. Variation lives
  // in the FAMILY_VOICE block + the per-family registration slot map
  // in teeContentBridge.
  return EDUCATIONAL_SCHEMA;
}

// ── Build the prompt ────────────────────────────────────────────────

/**
 * buildTeeContentPrompt({ teeOutput, input }) — returns { system, user }.
 *
 * The system prompt is the heavy contract (voice rules + schema + bans).
 * The user prompt carries the TEE decisions + the (small) destination
 * facts the LLM needs to write content. The LLM never gets to RE-PICK
 * family / themeId / visualMood / composition — those are inputs, not
 * outputs.
 */
function buildTeeContentPrompt({ teeOutput, input }) {
  const family = (teeOutput && teeOutput.family) || 'educational';
  const themeId = (teeOutput && teeOutput.themeId) || 'educational-academic';
  const visualMood = (teeOutput && teeOutput.traits && teeOutput.traits.visualMood) || 'generic-leisure';
  const traits = (teeOutput && teeOutput.traits) || {};
  const voice = FAMILY_VOICE[family] || FAMILY_VOICE.educational;
  const schema = schemaFor(family);
  const inp = input || {};

  const system = `
You are generating SEMANTIC CONTENT for a travel landing page. You are NOT
generating HTML. You are NOT picking the family, theme, or visualMood —
those decisions have already been made by the Travel Experience Engine
(TEE) and are provided to you as INPUTS. Your job is to write COPY that
fits the chosen family + theme + visualMood, in the exact JSON schema
provided. Do not deviate from the schema. Do not invent slot names.

Output: a single JSON object. No prose, no markdown fences, no commentary.
If a slot's value cannot be confidently filled, use the empty string ""
or the [REVIEW] placeholder convention described below.

═══════════════════════════════════════════════════════════════════
INPUTS FROM THE TRAVEL EXPERIENCE ENGINE (AUTHORITATIVE — DO NOT CHANGE)
═══════════════════════════════════════════════════════════════════

family:       ${family}
themeId:      ${themeId}
visualMood:   ${visualMood}
traits:       climate=${traits.climate || '?'}, regionFeel=${traits.regionFeel || '?'},
              tripStyle=${traits.tripStyle || '?'}, audienceTier=${traits.audienceTier || '?'},
              luxuryLevel=${typeof traits.luxuryLevel === 'number' ? traits.luxuryLevel : '?'},
              mood=${traits.mood || '?'}

═══════════════════════════════════════════════════════════════════
FAMILY VOICE (write in this register; failures will be re-prompted)
═══════════════════════════════════════════════════════════════════

Register: ${voice.register}
Tone:     ${voice.tone}

DO:
${voice.DO.map((d) => '  ✅ ' + d).join('\n')}

DO NOT:
${voice.DONT.map((d) => '  ❌ ' + d).join('\n')}

Reference examples:
${voice.examples.map((e) => '  • ' + e).join('\n')}

═══════════════════════════════════════════════════════════════════
VISUAL MOOD GUIDANCE — thread "${visualMood}" through every surface
═══════════════════════════════════════════════════════════════════
${VISUAL_MOOD_GUIDANCE.trim()}

═══════════════════════════════════════════════════════════════════
GUARDRAILS (the post-processing guard will scrub violators)
═══════════════════════════════════════════════════════════════════
${SHARED_GUARDRAILS.trim()}

═══════════════════════════════════════════════════════════════════
OUTPUT SCHEMA — EMIT THIS EXACT JSON SHAPE
═══════════════════════════════════════════════════════════════════
${schema.trim()}
`.trim();

  const user = `
Destination:   ${inp.destination || '(unspecified)'}
Duration:      ${inp.durationDays || '?'} days
Audience:      ${inp.audience || '(unspecified)'}
Travel month:  ${inp.travelMonth || '(unspecified)'}
Trip type:     ${inp.tripType || '(unspecified)'}
Sub-brand:     ${inp.subBrand || '(unspecified)'}

Write the JSON object now. Output JSON only.
`.trim();

  return { system, user };
}

// ── Per-family registration-slot mapping (used by the bridge) ──────
// The bridge maps the LLM's uniform "registration" object onto family-
// specific field labels. This means the LLM doesn't have to know each
// family's funnel naming — that lives here, ONE place to edit.

const REGISTRATION_SLOT_MAP = Object.freeze({
  educational: {
    personLabel: 'Student Full Name',
    personPlaceholder: "Enter student's full name",
    showStudentFields: true,
    showSchoolField: true,
    guardianLabel: 'Parent / Guardian Name',
    guardianPlaceholder: "Enter parent's full name",
    step1Title: 'Step 1: Student Information',
    step2Title: 'Step 2: Parent / Guardian Details',
    submitText: 'Confirm Registration',
  },
  religious: {
    personLabel: 'Pilgrim Full Name',
    personPlaceholder: "Enter pilgrim's full name",
    showStudentFields: false,
    showSchoolField: false,
    guardianLabel: 'Mahram / Companion Name',
    guardianPlaceholder: 'Enter mahram / companion name',
    step1Title: 'Step 1: Pilgrim Information',
    step2Title: 'Step 2: Mahram / Companion Details',
    submitText: 'Confirm Reservation',
  },
  family: {
    personLabel: 'Lead Family Member Name',
    personPlaceholder: 'Enter your full name',
    showStudentFields: false,
    showSchoolField: false,
    guardianLabel: 'Number Of Travellers',
    guardianPlaceholder: 'e.g., 2 adults + 2 kids',
    step1Title: 'Step 1: Family Group',
    step2Title: 'Step 2: Contact Details',
    submitText: 'Send Booking Request',
  },
  luxury: {
    personLabel: 'Your Name',
    personPlaceholder: 'Enter your full name',
    showStudentFields: false,
    showSchoolField: false,
    guardianLabel: 'Travel Companion (optional)',
    guardianPlaceholder: 'Name of partner / companion',
    step1Title: 'Step 1: Guest Information',
    step2Title: 'Step 2: Contact Details',
    submitText: 'Send Application',
  },
});

module.exports = {
  buildTeeContentPrompt,
  FAMILY_VOICE,
  VISUAL_MOOD_GUIDANCE,
  SHARED_GUARDRAILS,
  REGISTRATION_SLOT_MAP,
  schemaFor,
  // Exposed for testing.
  _EDUCATIONAL_SCHEMA: EDUCATIONAL_SCHEMA,
};
