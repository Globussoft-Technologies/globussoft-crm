/**
 * luxury-tour-v1 — premium / boutique travel template (PR-E Phase 1).
 *
 * For Maldives, Switzerland, Europe Luxury, and similar high-end
 * destination marketing. Shares the universal shell with the other
 * templates; differs in:
 *
 *   • Palette        — deep charcoal background + champagne gold
 *                      accent + warm cream text (dark / premium /
 *                      photography-first; minimal accent usage)
 *   • Typography     — Playfair Display / Didot for spacious editorial
 *                      headlines; Inter for body
 *   • Iconography    — alpine peak, chalet, lake, overwater bungalow,
 *                      arch, villa silhouettes (luxury-maldives /
 *                      -switzerland / -europe variants in themeTokens)
 *   • Brand glyph    — empty (no kanji / watermark — luxury reads
 *                      cleaner without ornamental glyphs)
 *   • Section order  — hero + marquee + cultural (curated experiences)
 *                      promoted; programme / brochure / details
 *                      hidden by default (photo-first, copy-light);
 *                      tighter footer
 *   • Default copy   — "curated" / "private" / "exclusive" framing;
 *                      registration funnel asks for the lead guest +
 *                      party size + travel month rather than student +
 *                      parent.
 */

'use strict';

const universal = require('./universalComponents');
const themeTokens = require('./themeTokens');
const educationalTripV1 = require('./educationalTripV1');

const TEMPLATE_ID = 'luxury-tour-v1';
// PR-E Option B: family-generic style bucket. The legacy
// `luxury-switzerland` alias still resolves for any persisted pages.
const DEFAULT_THEME_ID = 'luxury-alpine';

const DEFAULT_CONTENT = {
  brand: {
    kanji: '',
    label: '[REVIEW] PRIVATE COLLECTION 2026',
    programmeName: '[REVIEW] Curated Experience Name',
    programmeTagline: '[REVIEW] A boutique tagline.',
    logoUrl: '',
    partnerLogos: [],
  },
  nav: {
    links: [
      { label: 'Experience', href: '#hero' },
      { label: 'Curation', href: '#cultural' },
      { label: 'Investment', href: '#investment' },
      { label: 'FAQs', href: '#faqs' },
    ],
    ctaText: 'Enquire',
    ctaHref: '#register',
  },
  hero: {
    kanjiWatermark: '',
    eyebrow: { date: '[REVIEW] Travel Window', audience: '[REVIEW] Couples / Discerning Travellers', batchPill: 'BY APPLICATION' },
    kicker: '',
    headline: '[REVIEW] A Quietly Extraordinary Journey.',
    lede: '[REVIEW] Operator to write the editorial lede — emphasise privacy, curation, restraint.',
    benefitCards: [
      { icon: '✦', title: '[REVIEW] Private', desc: '[REVIEW] No groups. No queues.' },
      { icon: '◈', title: '[REVIEW] Curated', desc: '[REVIEW] Hand-chosen properties.' },
      { icon: '◊', title: '[REVIEW] Considered', desc: '[REVIEW] Each detail intentional.' },
      { icon: '✧', title: '[REVIEW] Quiet', desc: '[REVIEW] Designed for slow.' },
    ],
    countdown: {
      label: 'APPLICATIONS CLOSE',
      deadlineIso: '',
      ctaText: 'Apply',
      ctaHref: '#register',
    },
    visualTitle: '',
    visualSub: '',
    posterUrl: '',
    posterAlt: 'Curated luxury hero',
  },
  marquee: { cities: [] },
  preview: {
    show: false,
    kanjiWatermark: '',
    tag: 'TRAILER',
    title: 'A Moment In The Itinerary.',
    subtitle: '',
    quote: '',
    videoEmbedUrl: '',
    ctaText: 'APPLY',
    ctaHref: '#register',
  },
  // Luxury templates typically hide programme (long copy reads heavy).
  programme: {
    show: false,
    kanjiWatermark: '',
    leftHeadline: '',
    leftParagraphs: [],
    rightHeadline: '',
    rightQuote: '',
    rightChecks: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  cultural: {
    show: false,
    kanjiWatermark: '',
    tag: 'CURATION',
    title: 'Each Stay, A Story.',
    subtitle: '',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  // Safety section is not the focus for luxury — typically hidden;
  // operators can re-enable for destinations where it's relevant.
  safety: {
    show: false,
    title: 'Considered Care',
    subtitle: '',
    stats: [],
    features: [],
    included: { title: "What's Included", items: [] },
    banner: { title: '', body: '', ctaText: '', ctaHref: '#register' },
    quote: '',
  },
  testimonials: {
    show: false,
    title: 'Past Guests',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  investment: {
    show: true,
    tag: 'INVESTMENT',
    title: 'Investment',
    subtitle: '',
    currency: '€',
    tiers: [],
    inclusions: { label: 'INCLUSIONS', items: [] },
    foot: '',
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  registration: {
    show: true,
    tag: 'APPLY',
    title: 'Apply To Travel',
    subtitle: '',
    schoolOptions: [],
    successTitle: 'Application Received',
    successBody: 'A senior travel concierge will reach you within 24 hours to begin the conversation.',
    submitText: 'Send Application',
    personLabel: 'Your Name',
    personPlaceholder: 'Enter your full name',
    showStudentFields: false,
    showSchoolField: false,
    guardianLabel: 'Travel Companion (optional)',
    guardianPlaceholder: 'Name of partner / companion',
    step1Title: 'Step 1: Guest Information',
    step2Title: 'Step 2: Contact Details',
    coversTitle: '',
    coversIntro: '',
    covers: [],
    leadSource: 'landing_page_luxury',
    leadSubBrand: 'travelstall',
    tenantSlug: '',
  },
  brochure: {
    show: false,
    infoCards: [],
    pillText: '',
    headTitle: '',
    infoBody: '',
    dividerText: '',
    schoolOptions: [],
    ctaText: 'REQUEST DOSSIER',
    footNote: '',
    leadSource: 'brochure_request',
    leadSubBrand: 'travelstall',
    tenantSlug: '',
  },
  faq: {
    show: true,
    kanjiWatermark: '',
    tag: 'QUESTIONS',
    title: 'Frequently Asked',
    subtitle: '',
    categories: [
      { id: 'all', label: 'All', icon: '◇' },
      { id: 'experience', label: 'The Experience', icon: '◈' },
      { id: 'logistics', label: 'Logistics', icon: '✈' },
      { id: 'investment', label: 'Investment', icon: '€' },
    ],
    items: [],
  },
  details: {
    show: false,
    title: '',
    leftPill: '',
    taglineRight: '',
    steps: [],
    ctaText: '',
    ctaHref: '#register',
  },
  contact: {
    show: true,
    kanji: '',
    label: '[REVIEW] PRIVATE COLLECTION',
    tagline: '',
    logoUrl: '',
    sections: [],
    copyright: '',
  },
  finalCta: {
    show: false,
    eyebrow: '',
    title: '',
    subtitle: '',
    steps: [],
    ctaLabel: 'Apply',
    ctaHref: '#register',
  },
  floatingCta: { show: true, text: 'APPLY', href: '#register' },
};

function render(landingPage, options = {}) {
  let themeId = options.theme || (landingPage && landingPage.themeId);
  if (!themeId && landingPage && landingPage.content) {
    try {
      const parsed = typeof landingPage.content === 'string'
        ? JSON.parse(landingPage.content)
        : landingPage.content;
      if (parsed && typeof parsed === 'object' && parsed._themeId) themeId = parsed._themeId;
    } catch (_e) { /* ignore */ }
  }
  const theme = (themeId && themeTokens.getTheme(themeId))
    || themeTokens.getTheme(DEFAULT_THEME_ID)
    || themeTokens.getDefaultTheme('luxury');
  return universal.renderTemplatePage(landingPage, DEFAULT_CONTENT, theme, options);
}

// PR-E Phase 2.2 — TEE bridge for luxury template.
function mapTeeOutputToContent({ rawLLMOutput, teeOutput, input, existingContent }) {
  const { mapTeeOutputToContent: bridge } = require('../teeContentBridge');
  return bridge({
    rawLLMOutput,
    teeOutput,
    input,
    templateDefaults: DEFAULT_CONTENT,
    existingContent,
  });
}

module.exports = {
  id: TEMPLATE_ID,
  themeId: DEFAULT_THEME_ID,
  family: 'luxury',
  schema: educationalTripV1.schema,
  defaultContent: DEFAULT_CONTENT,
  render,
  mapBlocksToContent: educationalTripV1.mapBlocksToContent,
  mapTeeOutputToContent,
};
