/**
 * teeContentBridge.js — PR-E Phase 2.2.
 *
 * Deterministic bridge from LLM output (semantic content emitted per
 * teePrompts.buildTeeContentPrompt) into the template payload shape
 * each per-family template renders.
 *
 * Architectural invariants (locked Phase 2.2)
 * ───────────────────────────────────────────
 *   1. The LLM does NOT pick family / themeId / visualMood /
 *      composition / imageStrategy. Those come from TEE output as
 *      authoritative inputs.
 *
 *   2. The bridge IS NOT a free-form "fit the LLM blob into the
 *      template" pass. It's a deterministic merge:
 *        (a) take LLM-emitted slots verbatim where present
 *        (b) populate ALL template slots (no missing keys)
 *        (c) fill missing critical slots with [REVIEW] placeholders
 *        (d) inject family-specific registration funnel labels from
 *            teePrompts.REGISTRATION_SLOT_MAP
 *        (e) write `_tee` metadata block onto the payload
 *
 *   3. Early validation: if a CRITICAL slot is missing AND no AI
 *      fallback content was provided, the bridge throws
 *      `TeeContentValidationError`. The caller decides whether to
 *      retry the LLM, fall back to the legacy block-array generator,
 *      or surface the failure to the operator.
 *
 *   4. Operator overrides take precedence — if `existingContent`
 *      (the previous LandingPage.content state) has `_locked: true`
 *      on any slot, that slot is preserved.
 *
 * Public surface
 * ──────────────
 *   mapTeeOutputToContent({ rawLLMOutput, teeOutput, input,
 *                            templateDefaults, existingContent? })
 *     → { content, validation }
 *
 *   validateRequiredSlots(content, family) → { ok, missing[] }
 *   TeeContentValidationError
 */

'use strict';

const { REGISTRATION_SLOT_MAP } = require('./teePrompts');

class TeeContentValidationError extends Error {
  constructor(message, { missing = [], partial } = {}) {
    super(message);
    this.name = 'TeeContentValidationError';
    this.missing = missing;
    this.partial = partial;
  }
}

// ── Critical slots per family ───────────────────────────────────────
// If any of these are missing after the LLM emit + defaults merge,
// the bridge throws. Non-critical slots silently default to [REVIEW]
// placeholders so the operator sees what to fill.

const CRITICAL_SLOTS = Object.freeze({
  educational: [
    'brand.label', 'brand.programmeName',
    'hero.headline', 'hero.lede',
    'cultural.items.[length>=2]',
    'safety.features.[length>=2]',
    'faq.items.[length>=3]',
    'contact.label',
  ],
  religious: [
    'brand.label', 'brand.programmeName',
    'hero.headline', 'hero.lede',
    'programme.leftHeadline',
    'cultural.items.[length>=2]',
    'safety.features.[length>=2]',
    'faq.items.[length>=3]',
    'contact.label',
  ],
  family: [
    'brand.label', 'brand.programmeName',
    'hero.headline', 'hero.lede',
    'cultural.items.[length>=2]',
    'safety.features.[length>=2]',
    'faq.items.[length>=3]',
    'contact.label',
  ],
  luxury: [
    'brand.label', 'brand.programmeName',
    'hero.headline', 'hero.lede',
    'cultural.items.[length>=2]',
    'investment.tiers.[length>=2]',
    'faq.items.[length>=3]',
  ],
});

// ── Helpers ─────────────────────────────────────────────────────────

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isStr(v) { return typeof v === 'string' && v.length > 0; }
function asArr(v) { return Array.isArray(v) ? v : []; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function getPath(obj, path) {
  if (!isObj(obj)) return undefined;
  const m = path.match(/^([^.]+)\.(.+)$/);
  if (!m) return obj[path];
  return getPath(obj[m[1]], m[2]);
}

// Check a critical-slot spec — supports plain dotted paths and
// "[length>=N]" suffix on arrays.
function checkSlot(content, spec) {
  const lenMatch = spec.match(/^(.+)\.\[length>=(\d+)\]$/);
  if (lenMatch) {
    const arr = getPath(content, lenMatch[1]);
    const min = parseInt(lenMatch[2], 10);
    return Array.isArray(arr) && arr.length >= min;
  }
  const v = getPath(content, spec);
  if (Array.isArray(v)) return v.length > 0;
  return isStr(v);
}

function validateRequiredSlots(content, family) {
  const required = CRITICAL_SLOTS[family] || CRITICAL_SLOTS.educational;
  const missing = required.filter((spec) => !checkSlot(content, spec));
  return { ok: missing.length === 0, missing };
}

// Tolerant deep-merge: payload OVER defaults; arrays REPLACE wholesale
// (matches the existing mergeContent semantics in universalComponents).
function deepMerge(defaults, overrides) {
  if (overrides == null) return defaults;
  if (!isObj(defaults)) return overrides;
  if (!isObj(overrides)) return defaults;
  if (Array.isArray(defaults) || Array.isArray(overrides)) return overrides;
  const out = {};
  const keys = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) {
      out[k] = deepMerge(defaults[k], overrides[k]);
    } else {
      out[k] = defaults[k];
    }
  }
  return out;
}

// Preserve operator-locked slots. `_locked` is a child object whose
// keys mark specific slots immutable. Example:
//   content._locked = { 'hero.headline': true, 'cultural.items': true }
// When the bridge sees this, it pins those paths from existingContent.
function pinLockedSlots(merged, existing) {
  const locks = (existing && existing._locked) || null;
  if (!isObj(locks)) return merged;
  const out = clone(merged);
  for (const lockedPath of Object.keys(locks)) {
    if (!locks[lockedPath]) continue;
    const existingValue = getPath(existing, lockedPath);
    if (existingValue === undefined) continue;
    setPath(out, lockedPath, existingValue);
  }
  out._locked = clone(locks);
  return out;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

// Map the LLM's uniform registration shape onto the family-specific
// funnel labels (educational asks student+parent; religious asks
// pilgrim+mahram; family asks lead+headcount; luxury asks guest+companion).
function applyRegistrationSlotMap(content, family) {
  const map = REGISTRATION_SLOT_MAP[family] || REGISTRATION_SLOT_MAP.educational;
  const r = content.registration || {};
  return {
    ...content,
    registration: {
      ...r,
      personLabel: r.personLabel || map.personLabel,
      personPlaceholder: r.personPlaceholder || map.personPlaceholder,
      showStudentFields: r.showStudentFields != null ? r.showStudentFields : map.showStudentFields,
      showSchoolField: r.showSchoolField != null ? r.showSchoolField : map.showSchoolField,
      guardianLabel: r.guardianLabel || map.guardianLabel,
      guardianPlaceholder: r.guardianPlaceholder || map.guardianPlaceholder,
      step1Title: r.step1Title || map.step1Title,
      step2Title: r.step2Title || map.step2Title,
      submitText: r.submitText || map.submitText,
    },
  };
}

// Force the section `show` flags from the TEE composition. If a section
// id is in the composition array, its `show` becomes true; otherwise
// false (so the renderer skips it).
function applyCompositionShowFlags(content, composition) {
  if (!Array.isArray(composition)) return content;
  const SECTIONS = ['nav', 'hero', 'marquee', 'preview', 'programme', 'cultural', 'safety',
                    'testimonials', 'investment', 'registration', 'brochure', 'faq', 'details',
                    'finalCta', 'contact', 'floatingCta'];
  const set = new Set(composition);
  const out = clone(content);
  for (const sec of SECTIONS) {
    if (!isObj(out[sec])) continue;
    // nav / contact / floatingCta always render if data present; otherwise
    // mirror the composition decision so the renderer's section iterator
    // sees the right slot states.
    out[sec].show = set.has(sec) ? true : (out[sec].show === true);
  }
  // The renderer reads content._sectionOrder if present.
  out._sectionOrder = composition.slice();
  return out;
}

// Stamp the _tee metadata block onto the content payload.
function stampTeeMetadata(content, teeOutput) {
  const tee = teeOutput || {};
  return {
    ...content,
    _tee: {
      family: tee.family || null,
      themeId: tee.themeId || null,
      visualMood: (tee.traits && tee.traits.visualMood) || null,
      composition: tee.composition || null,
      traits: tee.traits ? {
        climate: tee.traits.climate,
        regionFeel: tee.traits.regionFeel,
        tripStyle: tee.traits.tripStyle,
        audienceTier: tee.traits.audienceTier,
        luxuryLevel: tee.traits.luxuryLevel,
        mood: tee.traits.mood,
        visualMood: tee.traits.visualMood,
      } : null,
      decisions: tee.decisionLog || null,
      generatedAt: tee.generatedAt || new Date().toISOString(),
      images: null, // populated by destinationImageProvider.applyImagesToContent later
    },
  };
}

/**
 * Public — the deterministic LLM-output → template-payload bridge.
 *
 * @param {Object} args
 *   rawLLMOutput     — the JSON object emitted by the LLM (already
 *                       passed through landingPageGuard.scrub)
 *   teeOutput        — TeeOutput from travelExperienceEngine.classify
 *   input            — the original generation input (destination,
 *                       durationDays, audience, tripType, subBrand,
 *                       travelMonth, tenantSlug)
 *   templateDefaults — the per-template DEFAULT_CONTENT (educational /
 *                       religious / family / luxury)
 *   existingContent? — the prior LandingPage.content (for _locked
 *                       preservation on regeneration). null on first
 *                       generation.
 *
 * @returns { content, validation }
 *   content    — the template payload, ready to render
 *   validation — { ok, missing }
 *
 * @throws TeeContentValidationError when critical slots are missing
 *         (caller handles fallback policy).
 */
function mapTeeOutputToContent({ rawLLMOutput, teeOutput, input, templateDefaults, existingContent }) {
  // 1. Coerce inputs.
  const family = (teeOutput && teeOutput.family) || 'educational';
  const llm = isObj(rawLLMOutput) ? rawLLMOutput : {};
  const defaults = isObj(templateDefaults) ? templateDefaults : {};
  const inp = input || {};

  // 2. Deep-merge LLM output OVER template defaults. The defaults
  //    guarantee EVERY slot exists; the LLM populates content where
  //    it can; missing slots stay as the defaults' [REVIEW] markers.
  let merged = deepMerge(defaults, llm);

  // 3. Drop fields the existing guard scrubs anyway (defensive).
  //    These are never populated by the LLM per the prompt, but
  //    accidental emissions should not survive the bridge.
  if (merged.testimonials) {
    merged.testimonials = { ...merged.testimonials, items: [] };
  }
  if (merged.investment && Array.isArray(merged.investment.tiers)) {
    merged.investment.tiers = merged.investment.tiers.map((t) => ({
      ...t, amount: null, tag: null, date: null, vendor: null,
    }));
  }
  // Image URL fields stay null until the image provider populates them.
  if (merged.hero) merged.hero.posterUrl = '';
  if (merged.brand) {
    merged.brand.logoUrl = '';
    merged.brand.partnerLogos = [];
  }
  if (merged.marquee && Array.isArray(merged.marquee.cities)) {
    merged.marquee.cities = merged.marquee.cities.map((c) => ({ ...c, img: null }));
  }

  // 4. Apply family-specific registration funnel labels.
  merged = applyRegistrationSlotMap(merged, family);

  // 5. Apply the TEE composition's section show flags.
  if (teeOutput && Array.isArray(teeOutput.composition)) {
    merged = applyCompositionShowFlags(merged, teeOutput.composition);
  }

  // 6. Preserve operator-locked slots from existingContent.
  merged = pinLockedSlots(merged, existingContent);

  // 7. Add tenant context so the embedded registration / brochure
  //    forms POST to the right CRM endpoint.
  if (inp.tenantSlug && merged.registration) merged.registration.tenantSlug = inp.tenantSlug;
  if (inp.tenantSlug && merged.brochure) merged.brochure.tenantSlug = inp.tenantSlug;
  if (inp.subBrand && merged.registration) merged.registration.leadSubBrand = inp.subBrand;
  if (inp.subBrand && merged.brochure) merged.brochure.leadSubBrand = inp.subBrand;

  // 8. Stamp _tee metadata block (authoritative decision log).
  merged = stampTeeMetadata(merged, teeOutput);

  // 9. Validate critical slots. Throw if any missing.
  const validation = validateRequiredSlots(merged, family);
  if (!validation.ok) {
    throw new TeeContentValidationError(
      `TEE content bridge: missing critical slots for family=${family}: ${validation.missing.join(', ')}`,
      { missing: validation.missing, partial: merged }
    );
  }

  return { content: merged, validation };
}

module.exports = {
  mapTeeOutputToContent,
  validateRequiredSlots,
  TeeContentValidationError,
  CRITICAL_SLOTS,
  // Helpers exposed for testing
  _deepMerge: deepMerge,
  _applyRegistrationSlotMap: applyRegistrationSlotMap,
  _applyCompositionShowFlags: applyCompositionShowFlags,
  _pinLockedSlots: pinLockedSlots,
  _stampTeeMetadata: stampTeeMetadata,
  _checkSlot: checkSlot,
};
