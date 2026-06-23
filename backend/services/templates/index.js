/**
 * Travel-page TEMPLATE renderer registry (PR-E Phase 1).
 *
 * Why this exists
 * ───────────────
 * Block-based composition (the existing `landingPageRenderer.js` switch
 * statement on `content[].type`) gives operators per-section freedom
 * but cannot easily encode section-to-section visual relationships.
 * Templates flip the model: the renderer owns the layout, the operator
 * (or AI) owns the content. A LandingPage with `templateType ∈
 * TEMPLATE_IDS` stores its content as a SEMANTIC PAYLOAD keyed to
 * slots the template understands (hero / programme / cultural / safety
 * / investment / faq / registration / brochure / contact) rather than
 * as a block array. The template renders the payload into a curated
 * HTML + CSS unit whose visual quality matches a handcrafted microsite.
 *
 * Phase 1 lifted the four family templates from "stubs that delegate
 * to educational-trip-v1" to "real implementations sharing the
 * universalComponents module + per-family themeTokens overlays":
 *
 *    educational-trip-v1  → Japan / Singapore / UK / STEM
 *    religious-tour-v1    → Umrah / Hajj / Jerusalem
 *    family-trip-v1       → Bali / Thailand / Dubai (NEW)
 *    luxury-tour-v1       → Maldives / Switzerland / Europe
 *
 * Existing block-based pages are unaffected — the dispatcher in
 * `landingPageRenderer.js` only routes pages whose `templateType` is a
 * known template id; everything else falls through to the block
 * renderer.
 *
 * Backwards-compat: travel-premium-v1 stays in the registry as a
 * generic-destination shell for pages created before Phase 1; new AI
 * generation never emits it (the Travel Experience Engine picks one of
 * the four family templates explicitly).
 *
 * Public surface
 * ──────────────
 *   TEMPLATE_IDS                 — array of registered template ids
 *   isTemplatePage(landingPage)  — true iff page.templateType is a known id
 *   getTemplate(id)              — { id, schema, defaultContent, render, family, themeId } | null
 *   renderTemplate(landingPage)  — html string; throws if templateType unknown
 *   parseTemplateContent(page)   — safe JSON parse of `page.content`; always
 *                                  returns an object (empty {} on parse fail)
 *   CATALOGUE                    — operator-facing list with status + family + theme
 */

'use strict';

const educationalTripV1 = require('./educationalTripV1');
const travelPremiumV1 = require('./travelPremiumV1');
const religiousTourV1 = require('./religiousTourV1');
const familyTripV1 = require('./familyTripV1');
const luxuryTourV1 = require('./luxuryTourV1');
// Road A (2026-06-23) — Wanderlux template ports the standalone reference at
// dynamic_page_geneator/ verbatim. Operator-default for new pages; the four
// family templates above stay registered for backwards-compat with existing
// pages.
const wanderluxV1 = require('./wanderlux');

const REGISTRY = Object.freeze({
  [educationalTripV1.id]: educationalTripV1,
  [travelPremiumV1.id]: travelPremiumV1,
  [religiousTourV1.id]: religiousTourV1,
  [familyTripV1.id]: familyTripV1,
  [luxuryTourV1.id]: luxuryTourV1,
  [wanderluxV1.id]: wanderluxV1,
});

const TEMPLATE_IDS = Object.freeze(Object.keys(REGISTRY));

/**
 * Catalogue of templates surfaced to the builder + create-page UI.
 * Each entry is operator-facing copy — title, description, family,
 * default theme id, and a status flag (`ready` | `stub`). PR-E Phase 1
 * marks all four family templates `ready`; travel-premium-v1 stays as
 * a generic backwards-compat shell.
 */
const CATALOGUE = Object.freeze([
  {
    id: wanderluxV1.id,
    title: 'Premium Destination — Wanderlux',
    family: 'wanderlux',
    themeId: null,
    description:
      'Editorial premium microsite — config-driven, AI-fillable on every section. Right-side ' +
      'hero photo, scrolling destination marquee, photo-fronted flip cards, transparent investment, ' +
      'multi-step registration. Recommended for all new tours.',
    status: 'ready',
  },
  {
    id: educationalTripV1.id,
    title: 'Educational Trip — v1',
    family: 'educational',
    themeId: educationalTripV1.themeId,
    description:
      'School / student immersion programmes. 4-card hero, cultural flip cards, dark safety section, ' +
      'transparent investment, 2-step parent registration. Theme variants: Japan, Singapore, UK, STEM.',
    status: 'ready',
  },
  {
    id: religiousTourV1.id,
    title: 'Religious Tour — v1',
    family: 'religious',
    themeId: religiousTourV1.themeId,
    description:
      'Umrah, Hajj, pilgrimage, Holy-Land tours. Spiritual-first framing, mosque / Kaaba / minaret ' +
      'iconography, pilgrim + mahram registration funnel. Theme variants: Umrah, Hajj, Jerusalem.',
    status: 'ready',
  },
  {
    id: familyTripV1.id,
    title: 'Family Trip — v1',
    family: 'family',
    themeId: familyTripV1.themeId,
    description:
      'Family / leisure travel — Bali, Thailand, Dubai. Vibrant palette, photo-marquee-first ' +
      'composition, activity-focused cultural cards, family-group registration funnel. Theme variants: ' +
      'Bali, Thailand, Dubai.',
    status: 'ready',
  },
  {
    id: luxuryTourV1.id,
    title: 'Luxury Tour — v1',
    family: 'luxury',
    themeId: luxuryTourV1.themeId,
    description:
      'High-end / boutique destination tours — Maldives, Switzerland, Europe luxury. Dark / ' +
      'photography-first treatment, spacious editorial typography, application-style registration. ' +
      'Theme variants: Maldives, Switzerland, Europe.',
    status: 'ready',
  },
  {
    id: travelPremiumV1.id,
    title: 'Travel Premium — v1 (legacy)',
    family: 'family',
    themeId: travelPremiumV1.themeId,
    description:
      'Generic premium destination microsite. Kept for backwards compatibility with pages created ' +
      'before the four-family architecture; new AI generation picks a family template explicitly.',
    status: 'legacy',
  },
]);

function isTemplatePage(landingPage) {
  if (!landingPage || typeof landingPage !== 'object') return false;
  const t = landingPage.templateType;
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(REGISTRY, t);
}

function getTemplate(id) {
  if (typeof id !== 'string') return null;
  return REGISTRY[id] || null;
}

/**
 * Parse the LandingPage row's `content` as a SEMANTIC PAYLOAD object.
 * Tolerant: returns `{}` on any error so the template renderer always
 * gets a defined object (its own merge logic fills slots with defaults).
 */
function parseTemplateContent(landingPage) {
  if (!landingPage) return {};
  const raw = landingPage.content;
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (_e) {
    return {};
  }
}

function renderTemplate(landingPage, options = {}) {
  const tmpl = getTemplate(landingPage && landingPage.templateType);
  if (!tmpl) {
    throw new Error(
      `renderTemplate: unknown templateType "${landingPage && landingPage.templateType}". ` +
      `Known: ${TEMPLATE_IDS.join(', ')}`
    );
  }
  return tmpl.render(landingPage, options);
}

module.exports = {
  TEMPLATE_IDS,
  CATALOGUE,
  REGISTRY,
  isTemplatePage,
  getTemplate,
  parseTemplateContent,
  renderTemplate,
};
