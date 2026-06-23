/**
 * family-trip-v1 — premium family / leisure travel template (PR-E Phase 1).
 *
 * For Bali Family, Thailand Family, Dubai Family, and similar
 * vibrant family-holiday marketing. Shares the universal shell with
 * the other templates; differs in:
 *
 *   • Palette        — vibrant coral / sand / tropical teal
 *                      (warm, family-friendly, photography-friendly)
 *   • Typography     — Nunito / Open Sans (friendly sans for headlines
 *                      instead of formal serif)
 *   • Iconography    — palm + temple + wave + elephant + burj
 *                      etc. for cultural cards (family-bali / -thailand
 *                      / -dubai variants in themeTokens.js)
 *   • Brand glyph    — light, decorative (旅 / 文化 for Asia variants;
 *                      Arabic for Dubai variant)
 *   • Section order  — marquee promoted EARLY (photo-first impression);
 *                      cultural reframed as ACTIVITIES not landmarks;
 *                      programme demoted / typically hidden
 *   • Default copy   — "magic memories" / "what kids love" / "family
 *                      time" framing throughout; the registration
 *                      funnel asks for the lead parent + headcount
 *                      instead of student + parent.
 */

'use strict';

const universal = require('./universalComponents');
const themeTokens = require('./themeTokens');
const educationalTripV1 = require('./educationalTripV1');

const TEMPLATE_ID = 'family-trip-v1';
// PR-E Option B: family-generic style bucket. The legacy `family-bali`
// alias still resolves for any persisted pages.
const DEFAULT_THEME_ID = 'family-tropical';

const DEFAULT_CONTENT = {
  brand: {
    kanji: '',
    label: '[REVIEW] FAMILY HOLIDAY 2026',
    programmeName: '[REVIEW] Holiday Name',
    programmeTagline: '[REVIEW] Memorable family experience.',
    logoUrl: '',
    partnerLogos: [],
  },
  nav: {
    links: [
      { label: 'Highlights', href: '#programme' },
      { label: 'Activities', href: '#cultural' },
      { label: 'Safety', href: '#safety' },
      { label: 'Pricing', href: '#investment' },
      { label: 'FAQs', href: '#faqs' },
    ],
    ctaText: 'Book This Trip',
    ctaHref: '#register',
  },
  hero: {
    kanjiWatermark: '',
    eyebrow: { date: '[REVIEW] Dates', audience: '[REVIEW] FAMILY · 2 ADULTS + 2 KIDS', batchPill: '' },
    kicker: '',
    headline: '[REVIEW] A Holiday Built For The Whole Family.',
    lede: '[REVIEW] Sun, water, food, photos. Lots of photos.',
    benefitCards: [
      { icon: '☀', title: '[REVIEW] Sun & Sand', desc: '[REVIEW] Beach time daily.' },
      { icon: '🌴', title: '[REVIEW] Kid-Friendly', desc: '[REVIEW] Activities for all ages.' },
      { icon: '🍳', title: '[REVIEW] Easy Meals', desc: '[REVIEW] Curated for picky eaters.' },
      { icon: '📸', title: '[REVIEW] Photo Moments', desc: '[REVIEW] Lifetime memories.' },
    ],
    countdown: {
      label: 'BOOK BY',
      deadlineIso: '',
      ctaText: 'Reserve This Trip',
      ctaHref: '#register',
    },
    visualTitle: '',
    visualSub: '',
    posterUrl: '',
    posterAlt: 'Family holiday hero',
  },
  marquee: { cities: [] },
  preview: {
    show: false,
    kanjiWatermark: '',
    tag: 'WATCH THE TRIP',
    title: 'See Yourself There.',
    subtitle: '',
    quote: '',
    videoEmbedUrl: '',
    ctaText: 'BOOK NOW',
    ctaHref: '#register',
  },
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
    tag: 'WHAT YOU\'LL DO',
    title: 'Activities Built For Family Fun',
    subtitle: '',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  safety: {
    show: true,
    title: 'Family Safe. Travel Easy.',
    subtitle: '',
    stats: [],
    features: [
      { icon: 'shield', title: '[REVIEW] Kid-safe properties', desc: '[REVIEW] Describe.' },
      { icon: 'briefcase', title: '[REVIEW] Health & wellness', desc: '[REVIEW] Describe.' },
      { icon: 'send', title: '[REVIEW] 24/7 support', desc: '[REVIEW] Describe.' },
      { icon: 'package', title: '[REVIEW] Door-to-door planning', desc: '[REVIEW] Describe.' },
    ],
    included: { title: "What's Included", items: [] },
    banner: { title: '', body: '', ctaText: 'Reserve This Trip', ctaHref: '#register' },
    quote: '',
  },
  testimonials: {
    show: false,
    title: 'Families Who Travelled With Us',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  investment: {
    show: true,
    tag: 'TRANSPARENT PRICING',
    title: 'Family Holiday Pricing',
    subtitle: '',
    currency: '₹',
    tiers: [],
    inclusions: { label: 'INDICATIVE INCLUSIONS', items: [] },
    foot: '',
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  registration: {
    show: true,
    tag: 'BOOK THIS TRIP',
    title: 'Hold Your Dates',
    subtitle: '',
    schoolOptions: [],
    successTitle: 'Booking Request Received',
    successBody: 'Our family travel team will reach you within 24 hours to confirm dates and finalise the package.',
    submitText: 'Send Booking Request',
    personLabel: 'Lead Family Member Name',
    personPlaceholder: 'Enter your full name',
    showStudentFields: false,
    showSchoolField: false,
    guardianLabel: 'Number Of Travellers',
    guardianPlaceholder: 'e.g., 2 adults + 2 kids',
    step1Title: 'Step 1: Family Group',
    step2Title: 'Step 2: Contact Details',
    coversTitle: '',
    coversIntro: '',
    covers: [],
    leadSource: 'landing_page_family',
    leadSubBrand: 'travelstall',
    tenantSlug: '',
  },
  brochure: {
    show: false,
    infoCards: [],
    pillText: 'WANT MORE DETAIL?',
    headTitle: 'Download the Day-By-Day Itinerary.',
    infoBody: '',
    dividerText: '',
    schoolOptions: [],
    ctaText: 'DOWNLOAD ITINERARY',
    footNote: 'No obligation. Use it to plan with your family.',
    leadSource: 'brochure_request',
    leadSubBrand: 'travelstall',
    tenantSlug: '',
  },
  faq: {
    show: true,
    kanjiWatermark: '',
    tag: 'FAMILY QUESTIONS',
    title: 'Frequently Asked Questions',
    subtitle: '',
    categories: [
      { id: 'all', label: 'All Questions', icon: '◇' },
      { id: 'family', label: 'For Families', icon: '👨‍👩‍👧‍👦' },
      { id: 'logistics', label: 'Logistics', icon: '✈' },
      { id: 'safety', label: 'Safety', icon: '🛡' },
    ],
    items: [],
  },
  details: {
    show: false,
    title: 'How It Works',
    leftPill: '',
    taglineRight: '',
    steps: [],
    ctaText: '',
    ctaHref: '#register',
  },
  contact: {
    show: true,
    kanji: '',
    label: '[REVIEW] FAMILY HOLIDAY 2026',
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
    ctaLabel: 'Book This Trip',
    ctaHref: '#register',
  },
  floatingCta: { show: true, text: 'BOOK THIS TRIP', href: '#register' },
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
    || themeTokens.getDefaultTheme('family');
  return universal.renderTemplatePage(landingPage, DEFAULT_CONTENT, theme, options);
}

// PR-E Phase 2.2 — TEE bridge for family template.
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
  family: 'family',
  schema: educationalTripV1.schema,
  defaultContent: DEFAULT_CONTENT,
  render,
  mapBlocksToContent: educationalTripV1.mapBlocksToContent,
  mapTeeOutputToContent,
};
