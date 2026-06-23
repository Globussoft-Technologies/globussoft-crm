/**
 * religious-tour-v1 — premium pilgrimage microsite template (PR-E Phase 1).
 *
 * For Umrah, Hajj, Jerusalem / Holy Land, and similar pilgrimage
 * marketing. Shares the same shell (sticky nav, hero, countdown,
 * marquee, programme, cultural cards, safety, investment, registration
 * funnel, FAQ, brochure, footer, floating CTA) as the educational
 * template; differs in:
 *
 *   • Palette        — placeholder gold + cream + emerald
 *                      (Yasin brand pack swap is a single themeTokens
 *                      edit when Q22 lands)
 *   • Typography     — Cormorant Garamond serif for classical / elegant
 *                      headline feel
 *   • Iconography    — mosque silhouette / Kaaba / minaret / dome for
 *                      cultural cards (theme.icons in themeTokens.js)
 *   • Brand glyph    — Arabic الحج for brand watermark + الإيمان for
 *                      hero kanji-style decorative overlay
 *   • Section order  — programme + cultural promoted above safety
 *                      (theme.sectionOrder); the "why pilgrimage"
 *                      narrative is the conversion pivot
 *   • Default copy   — pilgrimage / spiritual / trust-driven framing
 *                      throughout. No school-specific fields; the
 *                      registration funnel asks for the pilgrim name +
 *                      mahram contact rather than student + parent.
 *
 * Schema is identical to educational-trip-v1 — operator-AI bridge,
 * editor UI, and existing tooling work without code changes.
 */

'use strict';

const universal = require('./universalComponents');
const themeTokens = require('./themeTokens');
const educationalTripV1 = require('./educationalTripV1');

const TEMPLATE_ID = 'religious-tour-v1';
// PR-E Option B: family-generic style bucket. The legacy
// `religious-umrah` alias still resolves for any persisted pages.
const DEFAULT_THEME_ID = 'religious-classical';

const DEFAULT_CONTENT = {
  brand: {
    // Empty by default — theme.decorative.brand (Arabic الحج) fills in.
    // Operator/AI may override explicitly per page.
    kanji: '',
    label: '[REVIEW] PILGRIMAGE 2026',
    programmeName: '[REVIEW] Pilgrimage Name',
    programmeTagline: '[REVIEW] One-line spiritual tagline',
    logoUrl: '',
    partnerLogos: [],
  },
  nav: {
    links: [
      { label: 'Journey', href: '#programme' },
      { label: 'Holy Sites', href: '#cultural' },
      { label: 'Trust & Care', href: '#safety' },
      { label: 'Investment', href: '#investment' },
      { label: 'FAQs', href: '#faqs' },
    ],
    ctaText: 'Reserve Your Place',
    ctaHref: '#register',
  },
  hero: {
    // Theme.decorative.watermark (الإيمان) fills if left empty.
    kanjiWatermark: '',
    eyebrow: { date: '[REVIEW] Dates', audience: '[REVIEW] Pilgrims', batchPill: '' },
    kicker: '',
    headline: '[REVIEW] A Pilgrimage Worth Preparing For.',
    lede: '[REVIEW] Describe the spiritual depth and care framework of the journey.',
    benefitCards: [
      { icon: '☪', title: '[REVIEW] Spiritual depth', desc: '[REVIEW] Guided prayer + reflection.' },
      { icon: '✦', title: '[REVIEW] Trusted leadership', desc: '[REVIEW] Scholar-led journey.' },
      { icon: '✧', title: '[REVIEW] Care first', desc: '[REVIEW] Medical + elderly support.' },
      { icon: '◈', title: '[REVIEW] Group dignity', desc: '[REVIEW] Small group, big presence.' },
    ],
    countdown: {
      label: 'BOOKINGS CLOSE IN',
      deadlineIso: '',
      ctaText: 'Reserve Your Place',
      ctaHref: '#register',
    },
    visualTitle: '',
    visualSub: '',
    posterUrl: '',
    posterAlt: 'Pilgrimage hero',
  },
  marquee: { cities: [] },
  preview: {
    show: false,
    kanjiWatermark: '',
    tag: 'JOURNEY PREVIEW',
    title: 'A Glimpse of the Path Ahead.',
    subtitle: '',
    quote: '',
    videoEmbedUrl: '',
    ctaText: 'RESERVE',
    ctaHref: '#register',
  },
  programme: {
    show: true,
    kanjiWatermark: '',
    leftHeadline: '[REVIEW] Why this pilgrimage.',
    leftParagraphs: [
      '[REVIEW] Lead pastor/scholar background.',
      '[REVIEW] The spiritual rhythm of the trip.',
      '[REVIEW] Who this journey is meant for.',
    ],
    rightHeadline: 'What Pilgrims Carry Home',
    rightQuote: '',
    rightChecks: [
      '[REVIEW] Spiritual clarity',
      '[REVIEW] A practiced rhythm of prayer',
      '[REVIEW] Connection with fellow pilgrims',
    ],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  cultural: {
    show: false,
    kanjiWatermark: '',
    tag: 'HOLY SITES',
    title: 'Sites You Will Walk',
    subtitle: '',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  safety: {
    show: true,
    title: 'Cared For, Every Step.',
    subtitle: '',
    // PR-E Phase 1.6 — stat tiles, empty by default.
    stats: [],
    features: [
      { icon: 'shield', title: '[REVIEW] Medical staff on-call', desc: '[REVIEW] Describe.' },
      { icon: 'briefcase', title: '[REVIEW] Elderly support', desc: '[REVIEW] Describe.' },
      { icon: 'shieldCheck', title: '[REVIEW] Insurance included', desc: '[REVIEW] Describe.' },
      { icon: 'package', title: '[REVIEW] Vetted hotels near Haram', desc: '[REVIEW] Describe.' },
    ],
    included: { title: "What's Included", items: [] },
    banner: { title: '', body: '', ctaText: 'Reserve Your Place', ctaHref: '#register' },
    quote: '',
  },
  testimonials: {
    show: false,
    title: 'Voices From Past Journeys',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  investment: {
    show: true,
    tag: 'PILGRIMAGE INVESTMENT',
    title: 'Transparent Pilgrimage Investment',
    subtitle: '',
    currency: '₹',
    tiers: [],
    inclusions: { label: 'INDICATIVE INCLUSIONS', items: [] },
    foot: '',
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  registration: {
    show: true,
    tag: 'REGISTRATION',
    title: 'Reserve Your Place',
    subtitle: '',
    schoolOptions: [],
    successTitle: 'Reservation Received',
    successBody: 'Our pilgrimage team will contact you within 24 hours to confirm next steps.',
    submitText: 'Confirm Reservation',
    // Tunable field labels — registration funnel asks for pilgrim +
    // mahram instead of student + parent, matching the canonical
    // pilgrimage CRM intake.
    personLabel: 'Pilgrim Full Name',
    personPlaceholder: "Enter pilgrim's full name",
    showStudentFields: false,
    showSchoolField: false,
    guardianLabel: 'Mahram / Companion Name',
    guardianPlaceholder: "Enter mahram / companion name",
    step1Title: 'Step 1: Pilgrim Information',
    step2Title: 'Step 2: Mahram / Companion Details',
    // PR-E Phase 1.6 — covers panel, empty by default.
    coversTitle: '',
    coversIntro: '',
    covers: [],
    leadSource: 'landing_page_pilgrimage',
    leadSubBrand: 'rfu',
    tenantSlug: '',
  },
  brochure: {
    show: false,
    infoCards: [],
    pillText: 'STILL CONSIDERING?',
    headTitle: 'Download the Pilgrimage Overview.',
    infoBody: '',
    dividerText: '',
    schoolOptions: [],
    ctaText: 'DOWNLOAD PILGRIMAGE BROCHURE',
    footNote: 'No obligation. For informed decision-making.',
    leadSource: 'brochure_request',
    leadSubBrand: 'rfu',
    tenantSlug: '',
  },
  faq: {
    show: true,
    kanjiWatermark: '',
    tag: 'CLARIFICATIONS',
    title: 'Frequently Asked Questions',
    subtitle: '',
    categories: [
      { id: 'all', label: 'All Questions', icon: '◇' },
      { id: 'spiritual', label: 'Spiritual', icon: '☪' },
      { id: 'logistics', label: 'Logistics', icon: '✈' },
      { id: 'care', label: 'Care & Health', icon: '✚' },
      { id: 'registration', label: 'Registration', icon: '✍' },
    ],
    items: [],
  },
  details: {
    show: false,
    title: 'The Path That Awaits',
    leftPill: '',
    taglineRight: '',
    steps: [],
    ctaText: '',
    ctaHref: '#register',
  },
  contact: {
    show: true,
    kanji: '',
    label: '[REVIEW] PILGRIMAGE 2026',
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
    ctaLabel: 'Reserve Your Place',
    ctaHref: '#register',
  },
  floatingCta: { show: true, text: 'RESERVE YOUR PLACE', href: '#register' },
};

/**
 * Render a landing page with the religious-tour template.
 *
 *   options.theme — caller may pin a specific religious-* variant
 *                   (e.g. 'religious-jerusalem'). Otherwise content
 *                   may specify `_themeId` for per-page override.
 *                   Defaults to religious-umrah.
 */
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
    || themeTokens.getDefaultTheme('religious');
  return universal.renderTemplatePage(landingPage, DEFAULT_CONTENT, theme, options);
}

// PR-E Phase 2.2 — TEE bridge for religious template.
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
  family: 'religious',
  // Editor schema is identical to educational-trip-v1 — same content slots.
  schema: educationalTripV1.schema,
  defaultContent: DEFAULT_CONTENT,
  render,
  mapBlocksToContent: educationalTripV1.mapBlocksToContent,
  mapTeeOutputToContent,
};
