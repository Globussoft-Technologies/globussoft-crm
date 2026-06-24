/**
 * educational-trip-v1 — premium travel microsite template (PR-E refactor).
 *
 * This module is now a THIN WRAPPER around the shared universal-
 * components renderer with the educational theme tokens. The Japan
 * reference page (frontend/src/pages/public/TripsLanding.jsx) remains
 * the visual benchmark; this template ships its server-side, content-
 * driven port. PR-E Phase 1 extracted the section renderers + inline
 * scripts into [universalComponents.js](./universalComponents.js) so
 * the three sibling templates (religious / family / luxury) share the
 * same shell + conversion components without code duplication.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  CONTENT SCHEMA (the operator / AI fills these slots)       │
 * ├─────────────────────────────────────────────────────────────┤
 * │  brand        — programme name + kanji eyebrow + logo URL   │
 * │  nav          — sticky top-nav links + register CTA         │
 * │  hero         — 4 benefit cards + countdown + poster        │
 * │  marquee      — scrolling destination photo strip           │
 * │  preview      — interactive video preview section           │
 * │  programme    — "why" two-column section + CTA banner       │
 * │  cultural     — flip-cards (front: icon+name; back: body)   │
 * │  safety       — dark safety section + inclusions + banner   │
 * │  testimonials — operator-only manual reviews                │
 * │  investment   — tier pricing + indicative inclusions        │
 * │  registration — 2-step parent registration funnel           │
 * │  brochure     — info cards + lead-capture brochure flow     │
 * │  faq          — categorised + searchable accordion          │
 * │  details      — red CTA strip ("Details That Matter")       │
 * │  contact      — premium dark footer with brand mark         │
 * │  floatingCta  — fixed-position register button              │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Compatibility — every slot has a default block in DEFAULT_CONTENT so
 * an operator can leave any section blank and the page still renders.
 * The defaults carry "[REVIEW]" markers so reviewers see at a glance
 * what's placeholder.
 *
 * Bridge: legacy block-array → semantic content payload
 * ────────────────────────────────────────────────────
 * mapBlocksToContent() takes the LLM's 9-block scrubbed array (see
 * services/landingPagePrompts.js) and folds it into the template's
 * semantic slot model. PR-E Phase 2 will swap the LLM prompt to emit
 * the semantic payload directly; this bridge keeps the existing
 * generator working unmodified.
 */

'use strict';

const universal = require('./universalComponents');
const themeTokens = require('./themeTokens');

const TEMPLATE_ID = 'educational-trip-v1';
// PR-E Option B: family-generic variant id. The legacy
// `educational-japan` id stays resolvable via themeTokens.THEME_ALIASES
// so any persisted page still loads.
const THEME_ID = 'educational-academic';

// Re-export utilities so existing tests + callers can keep importing
// them from this module.
const { mergeContent, resetCssCache, escapeHtml } = universal;

// ── DEFAULT CONTENT ─────────────────────────────────────────────────
// Used (a) as the seed for newly-created template pages and (b) as
// fallback for slots the operator left empty. Every operator-editable
// value uses the "[REVIEW]" prefix so reviewers see at a glance.
const DEFAULT_CONTENT = {
  brand: {
    kanji: '',
    label: '[REVIEW] PROGRAMME 2026',
    programmeName: '[REVIEW] Programme Name',
    programmeTagline: '[REVIEW] One-line tagline',
    logoUrl: '',
    partnerLogos: [],
  },
  nav: {
    links: [
      { label: 'Programme', href: '#programme' },
      { label: 'Safety', href: '#safety' },
      { label: 'Investment', href: '#investment' },
      { label: 'FAQs', href: '#faqs' },
    ],
    ctaText: 'Register Now',
    ctaHref: '#register',
  },
  hero: {
    kanjiWatermark: '',
    eyebrow: { date: '[REVIEW] Dates', audience: '[REVIEW] Audience', batchPill: '' },
    kicker: '',
    headline: '[REVIEW] Hero Headline',
    lede: '[REVIEW] Operator to write the lede paragraph.',
    benefitCards: [
      { icon: '◈', title: '[REVIEW] Benefit one', desc: '[REVIEW] Describe.' },
      { icon: '⊕', title: '[REVIEW] Benefit two', desc: '[REVIEW] Describe.' },
      { icon: '⌂', title: '[REVIEW] Benefit three', desc: '[REVIEW] Describe.' },
      { icon: '❖', title: '[REVIEW] Benefit four', desc: '[REVIEW] Describe.' },
    ],
    countdown: {
      label: 'REGISTRATION CLOSES IN',
      deadlineIso: '',
      ctaText: 'Reserve Your Spot',
      ctaHref: '#register',
    },
    visualTitle: '',
    visualSub: '',
    posterUrl: '',
    posterAlt: 'Programme hero',
  },
  marquee: {
    cities: [],
  },
  preview: {
    show: false,
    kanjiWatermark: '',
    tag: 'INTERACTIVE PREVIEW',
    title: 'See the Experience Before You Decide.',
    subtitle: '',
    quote: '',
    videoEmbedUrl: '',
    ctaText: 'REGISTER NOW',
    ctaHref: '#register',
  },
  programme: {
    show: false,
    kanjiWatermark: '',
    leftHeadline: '[REVIEW] Why this programme.',
    leftParagraphs: ['[REVIEW] Operator to add 2-3 paragraphs.'],
    rightHeadline: 'What Participants Gain',
    rightQuote: '',
    rightChecks: ['[REVIEW] Outcome one', '[REVIEW] Outcome two', '[REVIEW] Outcome three'],
    rightItems: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  cultural: {
    show: false,
    kanjiWatermark: '',
    tag: 'CULTURAL HIGHLIGHTS',
    title: 'Cultural Highlights',
    subtitle: '',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  safety: {
    show: true,
    title: 'Engineered for Safety. Designed for Growth.',
    subtitle: '',
    // PR-E Phase 1.6 — Stat tiles render BEFORE features when populated.
    // Empty by default; operator/AI fills with trust metrics ("1:6", "4★", "24/7").
    stats: [],
    features: [
      { icon: 'shield', title: '[REVIEW] Safety pillar one', desc: '[REVIEW] Describe.' },
      { icon: 'briefcase', title: '[REVIEW] Safety pillar two', desc: '[REVIEW] Describe.' },
      { icon: 'send', title: '[REVIEW] Safety pillar three', desc: '[REVIEW] Describe.' },
      { icon: 'package', title: '[REVIEW] Safety pillar four', desc: '[REVIEW] Describe.' },
    ],
    included: { title: "What's Included", items: [] },
    banner: { title: '', body: '', ctaText: 'Register for Orientation', ctaHref: '#register' },
    quote: '',
  },
  testimonials: {
    show: false,
    title: 'What People Say',
    items: [],
    cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
  },
  investment: {
    show: true,
    tag: 'TRANSPARENT PROGRAMME INVESTMENT',
    title: 'Transparent Programme Investment',
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
    title: 'Register Now',
    subtitle: '',
    schoolOptions: [],
    successTitle: 'Registration Submitted!',
    successBody: 'Our team will contact you within 24 hours to confirm your slot and share next steps.',
    submitText: 'Confirm Registration',
    // PR-E Phase 1.6 — Covers panel renders a 4-card side panel when populated.
    // Empty by default; operator/AI fills with what registration unlocks
    // (full itinerary / safety model / costs / Q&A access).
    coversTitle: '',
    coversIntro: '',
    covers: [],
    leadSource: 'landing_page_registration',
    leadSubBrand: '',
    tenantSlug: '',
  },
  brochure: {
    show: false,
    infoCards: [],
    pillText: 'STILL EXPLORING?',
    headTitle: 'Download the Detailed Programme Overview.',
    infoBody: '',
    dividerText: '',
    schoolOptions: [],
    ctaText: 'DOWNLOAD PROGRAMME BROCHURE',
    footNote: 'No obligation. For informed decision-making.',
    leadSource: 'brochure_request',
    leadSubBrand: '',
    tenantSlug: '',
  },
  faq: {
    show: true,
    kanjiWatermark: '',
    tag: 'CLARIFICATIONS',
    title: 'Frequently Asked Questions',
    subtitle: '',
    categories: [{ id: 'all', label: 'All Questions', icon: '📋' }],
    items: [],
  },
  details: {
    show: false,
    title: 'The Details That Matter',
    leftPill: '',
    taglineRight: '',
    steps: [],
    ctaText: '',
    ctaHref: '#register',
  },
  contact: {
    show: true,
    kanji: '',
    label: '[REVIEW] PROGRAMME 2026',
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
    ctaLabel: 'Register Now',
    ctaHref: '#register',
  },
  floatingCta: { show: true, text: 'REGISTER NOW', href: '#register' },
};

// ── Public render entry ─────────────────────────────────────────────
// Thin wrapper around universalComponents.renderTemplatePage with the
// educational-japan theme. options.preview omits the analytics pixel.
function render(landingPage, options = {}) {
  const theme = themeTokens.getTheme(THEME_ID) || themeTokens.getDefaultTheme('educational');
  return universal.renderTemplatePage(landingPage, DEFAULT_CONTENT, theme, options);
}

// ── EDITOR SCHEMA (a thin description of editable slots) ────────────
const EDITOR_SCHEMA = Object.freeze({
  editorSlots: ['brand', 'nav', 'hero', 'programme', 'cultural', 'safety', 'investment', 'faq', 'registration', 'brochure', 'contact'],
  slotLabels: {
    brand: 'Brand & partner logos',
    nav: 'Top navigation',
    hero: 'Hero section',
    marquee: 'Photo marquee (JSON)',
    preview: 'Video preview (JSON)',
    programme: 'Programme / "Why" section',
    cultural: 'Cultural highlights',
    safety: 'Safety section',
    testimonials: 'Testimonials (JSON, operator-only)',
    investment: 'Investment / Pricing',
    registration: 'Registration form',
    brochure: 'Brochure download',
    faq: 'FAQ section',
    details: 'Details strip (JSON)',
    contact: 'Footer / contact',
    floatingCta: 'Floating CTA (JSON)',
  },
});

// ── BRIDGE: legacy block-array → semantic content payload ───────────
//
// Why: the existing AI generator (services/landingPageGeneratorLLM.js +
// services/landingPagePrompts.js) was designed in PR-B to produce a
// 9-block array against the legacy `travel_destination` templateType.
// This bridge lets the operator pick the premium template at AI-
// generation time WITHOUT waiting for a generator rewrite. The flow:
//
//   1. The LLM emits a scrubbed block array (existing prompt + guard).
//   2. The bridge MECHANICALLY maps blocks → semantic slots:
//        destinationHero  → hero (headline, lede)
//        highlightsGrid   → hero.benefitCards
//        cityCards        → cultural.items (flip cards) + marquee.cities
//        safetyFeatures   → safety.features
//        inclusionsGrid   → safety.included.items + investment.inclusions
//        itineraryTimeline → programme.leftParagraphs (fold-down)
//        tierPricing      → investment.tiers (shell)
//        faqAccordion     → faq.categories + faq.items
//        contactFooter    → contact (shell)
//   3. Operator-only slots (pricing values, poster image, partner
//      logos, phone/email, testimonials) stay null so the publish gate
//      catches them before public release.
//   4. Persisted as templateType=educational-trip-v1 + content=JSON
//      object so the builder opens in template-editor mode.
//
// PR-E Phase 2 will swap the LLM prompt to emit the semantic payload
// directly + carry the chosen theme alongside content.
//
// PR-E Option B: decorative glyphs (brand kanji / hero watermark) come
// EXCLUSIVELY from theme tokens — the destination-keyword smart-default
// has been removed (it was the last destination-coupled bit in the
// rendering layer). When the renderer encounters an empty
// `content.brand.kanji` / `content.hero.kanjiWatermark` slot, it falls
// back to the theme's `decorative.brand` / `decorative.watermark`
// strings (defined per family in themeTokens.js; empty for
// educational/family/luxury, Arabic for religious). Operators / Phase-2
// AI can still set these explicitly per-page in content for cases like
// "this Japan trip wants 日本".

// Extract a short tagline (first sentence, ≤ 60 chars) from the
// hero subhead. Falls back to metaDescription if hero is empty.
function pickTagline(heroSubhead, metaDescription) {
  const source = (heroSubhead && heroSubhead.trim()) || (metaDescription && metaDescription.trim()) || '';
  if (!source) return '';
  const first = source.split(/[.!?]\s/)[0].trim();
  const truncated = first.length <= 60 ? first : first.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  return truncated;
}

// Truncate a string at a sentence boundary, with a hard char cap. Keeps
// the FIRST 1-2 sentences (whichever fits) and falls back to a hard
// word-boundary cut if no sentence punctuation lands inside the cap.
// Used to keep flip-card body / benefit text from overflowing — the LLM
// emits up to 280 chars per body which crowds the card.
function truncateAtSentence(raw, maxChars) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  // Try to break at the last sentence boundary within the cap.
  const slice = text.slice(0, maxChars);
  const lastPunct = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastPunct > maxChars * 0.5) return slice.slice(0, lastPunct + 1).trim();
  // No good sentence break — cut at the last word boundary, ellipsis.
  return slice.replace(/\s+\S*$/, '').trim() + '…';
}

function mapBlocksToContent(blocks, input) {
  const inp = (input && typeof input === 'object') ? input : {};
  const safeArray = Array.isArray(blocks) ? blocks : [];
  const byType = {};
  for (const b of safeArray) {
    if (b && typeof b === 'object' && typeof b.type === 'string') {
      (byType[b.type] = byType[b.type] || []).push(b);
    }
  }
  const propsOf = (type) => (byType[type] && byType[type][0] && byType[type][0].props) || {};
  const hero = propsOf('destinationHero');
  const highlights = propsOf('highlightsGrid');
  const cities = propsOf('cityCards');
  const safety = propsOf('safetyFeatures');
  const inclusions = propsOf('inclusionsGrid');
  const itinerary = propsOf('itineraryTimeline');
  const pricing = propsOf('tierPricing');
  const faq = propsOf('faqAccordion');

  const destination = String(inp.destination || '').trim() || (hero.destination || '');
  const audience = String(inp.audience || '').trim();
  const days = Number.isFinite(Number(inp.durationDays))
    ? Math.max(1, Math.min(60, Math.trunc(Number(inp.durationDays))))
    : 7;
  const cityCount = Array.isArray(cities.cards) ? cities.cards.length : 0;
  const subBrand = String(inp.subBrand || '').trim();
  const suggestedTitle = String(inp.suggestedTitle || '').trim();
  const metaDescription = String(inp.metaDescription || '').trim();
  // Decorative glyph slots stay empty here — the renderer fills them
  // from theme.decorative if the operator/AI hasn't set them on the
  // content payload. See universalComponents.renderTemplatePage.
  const programmeTagline = pickTagline(hero.subhead, metaDescription);

  const idify = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

  return {
    brand: {
      kanji: '',  // theme.decorative.brand fills if empty
      label: destination ? `${destination.toUpperCase()}`.slice(0, 60) : '',
      programmeName: hero.destination || destination || '',
      programmeTagline,
      logoUrl: '',
      partnerLogos: [],
    },
    nav: {
      links: [
        { label: 'Programme', href: '#programme' },
        { label: 'Cultural', href: '#cultural' },
        { label: 'Safety', href: '#safety' },
        { label: 'Investment', href: '#investment' },
        { label: 'FAQs', href: '#faqs' },
      ],
      ctaText: 'Register Now',
      ctaHref: '#register',
    },
    hero: {
      kanjiWatermark: '',  // theme.decorative.watermark fills if empty
      eyebrow: {
        date: '',
        audience: audience ? audience.toUpperCase().slice(0, 40) : '',
        batchPill: '',
      },
      kicker: cityCount > 0
        ? `${days} Day${days === 1 ? '' : 's'}. ${cityCount} ${cityCount === 1 ? 'City' : 'Cities'}.`
        : `${days} Day${days === 1 ? '' : 's'}.`,
      headline: hero.headline || '',
      lede: hero.subhead || '',
      benefitCards: (Array.isArray(highlights.items) ? highlights.items : []).slice(0, 4).map((it) => ({
        icon: it.icon || '◈',
        title: it.title || '',
        desc: it.body || '',
      })),
      countdown: {
        label: 'REGISTRATION CLOSES IN',
        deadlineIso: '',
        ctaText: hero.ctaText || 'Reserve Your Spot',
        ctaHref: '#register',
      },
      visualTitle: suggestedTitle,
      visualSub: pickTagline(metaDescription, ''),
      posterUrl: '',
      posterAlt: hero.headline || destination,
    },
    marquee: {
      cities: (Array.isArray(cities.cards) ? cities.cards : []).map((c) => ({
        tag: c.tag || '',
        title: c.title || '',
        img: null,
      })),
    },
    preview: {
      show: false,
      kanjiWatermark: '',
      tag: 'INTERACTIVE PREVIEW',
      title: 'See the Experience Before You Decide.',
      subtitle: '',
      quote: '',
      videoEmbedUrl: '',
      ctaText: 'REGISTER NOW',
      ctaHref: '#register',
    },
    programme: {
      show: true,
      kanjiWatermark: '',
      leftHeadline: hero.subhead ? `Why ${destination || 'this programme'}.` : 'Why this programme.',
      leftParagraphs: (() => {
        const paras = [];
        if (hero.subhead) paras.push(hero.subhead);
        const itDays = Array.isArray(itinerary.days) ? itinerary.days : [];
        itDays.slice(0, 2).forEach((d) => {
          if (d && d.title) {
            const bullets = Array.isArray(d.bullets) ? d.bullets.join(' · ') : '';
            paras.push(`${d.title}${bullets ? ` — ${bullets}` : ''}`);
          }
        });
        if (paras.length === 0) paras.push('');
        return paras.slice(0, 3);
      })(),
      rightHeadline: 'What You Gain',
      // rightQuote: pull the FIRST highlight body (most impactful learning
      // outcome the LLM emitted) so the red-bordered card aside has a real
      // pull quote rather than empty space. The Japan reference uses a
      // hand-written quote here; deriving from highlights gets us 80% there
      // without an extra prompt slot.
      rightQuote: (Array.isArray(highlights.items) && highlights.items[0] && highlights.items[0].body) || '',
      rightChecks: (Array.isArray(highlights.items) ? highlights.items : [])
        .slice(0, 4)
        .map((it) => it.title || '')
        .filter(Boolean),
      // rightItems — same data as rightChecks but with the LLM's
      // per-highlight `body` description preserved, so the renderer can
      // surface title + short description as a card (image 2 reference)
      // instead of an icon-only bullet list. rightChecks stays for
      // back-compat with any caller that still expects string[].
      //
      // When the LLM emits highlightsGrid items as landmark NAMES
      // (Victoria Memorial, Howrah Bridge, etc. — observed for Kolkata
      // city tours), the body is often empty because outcome-style
      // descriptions don't fit landmark items. Fall back to the matching
      // cityCards body in that case so each list item shows a real
      // description instead of just the title.
      rightItems: (() => {
        const hi = Array.isArray(highlights.items) ? highlights.items : [];
        const cityList = Array.isArray(cities.cards) ? cities.cards : [];
        const findCityBody = (title) => {
          const norm = String(title || '').trim().toLowerCase();
          if (!norm) return '';
          const match = cityList.find((c) => String(c && c.title || '').trim().toLowerCase() === norm);
          return (match && match.body) || '';
        };
        return hi.slice(0, 4)
          .map((it, idx) => ({
            title: it.title || '',
            desc: it.body || findCityBody(it.title) || (cityList[idx] && cityList[idx].body) || '',
          }))
          .filter((it) => it.title);
      })(),
      // programme.cta banner — derived structural copy + LLM-emitted ctaText.
      // This populates the banner row below the programme grid (was empty
      // and the renderer skipped it). Destination-aware title + a generic
      // structural body that doesn't fabricate operator-specific claims.
      cta: {
        title: destination ? `Every Day Has a Purpose in ${destination}.` : 'Every Day Has a Purpose.',
        body: 'See the full day-by-day plan and how each stop fits the programme.',
        ctaText: hero.ctaText || 'Reserve Your Seat',
        ctaHref: '#register',
      },
    },
    cultural: {
      show: cityCount > 0,
      kanjiWatermark: '',
      tag: 'CULTURAL HIGHLIGHTS',
      title: cities.title || 'Cultural Highlights',
      subtitle: cities.subtitle || '',
      // Hard-cap body / benefit lengths so the flip-card back face never
      // overflows the card height. The LLM prompt allows up to 280 chars
      // for body and 140 for benefit; in practice that produces 4-5
      // sentences which crowds the card. CSS line-clamp catches the
      // worst overflow but truncating at the source keeps the visual
      // contract honest. 160 chars ≈ 2 short sentences.
      items: (Array.isArray(cities.cards) ? cities.cards : []).map((c) => ({
        id: idify(c.title),
        icon: idify(c.title),
        name: c.title || '',
        label: c.tag || '',
        body: c.body ? [truncateAtSentence(String(c.body), 160)] : [],
        benefit: c.benefit ? truncateAtSentence(String(c.benefit), 90) : '',
      })),
      cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
    },
    safety: {
      show: true,
      title: 'Engineered for Safety. Designed for Growth.',
      subtitle: '',
      features: (Array.isArray(safety.items) ? safety.items : []).slice(0, 4).map((it) => ({
        icon: ['shield', 'briefcase', 'send', 'package', 'shieldCheck'].includes(it.icon)
          ? it.icon
          : 'shield',
        title: it.title || '',
        desc: it.body || '',
      })),
      included: {
        title: "What's Included",
        items: Array.isArray(inclusions.items) ? inclusions.items : [],
      },
      // banner — populates the dark safety-section CTA banner (was empty
      // → renderer skipped it). Destination-aware structural copy.
      banner: {
        title: 'Built to Reassure Every Parent and Traveller.',
        body: destination
          ? `Every safeguard, every checkpoint, every contact protocol for ${destination} — explained on a single call.`
          : 'Every safeguard, every checkpoint, every contact protocol — explained on a single call.',
        ctaText: 'Register for Orientation',
        ctaHref: '#register',
      },
      // quote — pull from the safetyFeatures subtitle (often a one-liner the
      // LLM emits framing the safety stance) so the dark section has a real
      // pull quote instead of empty whitespace.
      quote: safety.subtitle || '',
    },
    testimonials: {
      show: false,
      title: 'What People Say',
      items: [],
      cta: { title: '', body: '', ctaText: '', ctaHref: '#register' },
    },
    investment: {
      show: true,
      tag: 'TRANSPARENT PROGRAMME INVESTMENT',
      title: pricing.title || 'Investment',
      subtitle: pricing.subtitle || '',
      currency: pricing.currency || '₹',
      tiers: (Array.isArray(pricing.tiers) ? pricing.tiers : []).map((t, i) => ({
        step: Number.isFinite(t.step) ? t.step : i + 1,
        title: t.label || '',
        subtitle: t.subtitle || '',
        amount: null,
        tag: null,
        date: null,
        vendor: null,
        startHere: i === 0,
      })),
      inclusions: {
        label: 'INDICATIVE INCLUSIONS',
        items: (Array.isArray(inclusions.items) ? inclusions.items : []).slice(0, 6),
      },
      foot: '',
      cta: { title: '', body: '', ctaText: 'Reserve Your Seat', ctaHref: '#register' },
    },
    registration: {
      show: true,
      tag: 'REGISTRATION',
      title: 'Register Your Interest',
      subtitle: '',
      schoolOptions: [],
      // covers — populates the 4-card "what registration unlocks" panel on
      // the right of the registration block. Pull from inclusionsGrid so
      // the operator sees a populated 2-column layout instead of a single-
      // column form on a blank background. Each cover is a one-line label
      // taken from the inclusion item; body is a derived structural line.
      covers: (Array.isArray(inclusions.items) ? inclusions.items : [])
        .slice(0, 4)
        .map((title) => ({
          title: String(title || '').slice(0, 60),
          body: 'Detail shared during the orientation call.',
        })),
      successTitle: 'Registration Submitted!',
      successBody: 'Our team will contact you within 24 hours to confirm next steps.',
      submitText: 'Confirm Registration',
      leadSource: subBrand ? `landing_page_${subBrand}` : 'landing_page',
      leadSubBrand: subBrand,
      tenantSlug: '',
    },
    brochure: {
      show: false,
      infoCards: [],
      pillText: 'STILL EXPLORING?',
      headTitle: '',
      infoBody: '',
      dividerText: '',
      schoolOptions: [],
      ctaText: 'DOWNLOAD PROGRAMME BROCHURE',
      footNote: 'No obligation. For informed decision-making.',
      leadSource: 'brochure_request',
      leadSubBrand: subBrand,
      tenantSlug: '',
    },
    faq: {
      show: true,
      kanjiWatermark: '',
      tag: 'CLARIFICATIONS',
      title: faq.title || 'Frequently Asked Questions',
      subtitle: faq.subtitle || '',
      categories: Array.isArray(faq.categories) && faq.categories.length > 0
        ? faq.categories
        : [{ id: 'all', label: 'All Questions', icon: '◇' }],
      items: Array.isArray(faq.faqs) ? faq.faqs : [],
    },
    // details — was previously omitted (show:false). Flipped on (2026-06-23)
    // so the red full-bleed "Details That Matter" strip ships with every
    // generated page; the steps + destination kicker are structural, not
    // operator-specific, so this is safe to populate without a prompt change.
    details: {
      show: true,
      title: 'The Details That Matter',
      leftPill: cityCount > 0 ? `${days} DAYS. ${cityCount} ${cityCount === 1 ? 'CITY' : 'CITIES'}.` : `${days} DAYS.`,
      taglineRight: destination
        ? `One Transformational Journey in ${destination}.`
        : 'One Transformational Journey.',
      steps: [
        { num: 1, label: 'Register your interest' },
        { num: 2, label: 'Review the framework' },
        { num: 3, label: 'Decide with clarity' },
      ],
      ctaText: 'REGISTER NOW',
      ctaHref: '#register',
    },
    // finalCta — was previously omitted (template default show:false). Add
    // a final pre-footer close so generated pages don't end on the contact
    // block. Structural copy + LLM-emitted ctaText.
    finalCta: {
      show: true,
      eyebrow: cityCount > 0
        ? `${days} DAYS · ${cityCount} ${cityCount === 1 ? 'CITY' : 'CITIES'}`
        : `${days} DAYS`,
      title: destination ? `Plan ${destination} With Confidence.` : 'Plan With Confidence.',
      subtitle: 'One structured journey. One team. One clear path from interest to departure.',
      steps: [
        { label: 'Register interest' },
        { label: 'Review the plan' },
        { label: 'Confirm the seat' },
      ],
      ctaText: hero.ctaText || 'Reserve Your Seat',
      ctaHref: '#register',
    },
    contact: {
      show: true,
      kanji: '',
      label: destination ? destination.toUpperCase() : '',
      tagline: '',
      logoUrl: '',
      sections: [],
      copyright: '',
    },
    floatingCta: { show: true, text: 'REGISTER NOW', href: '#register' },
  };
}

// ── PR-E Phase 2.2 — TEE bridge ─────────────────────────────────────
// Receives a TeeOutput (from travelExperienceEngine.classify) + the LLM-
// emitted semantic content (from teePrompts.buildTeeContentPrompt). Calls
// the shared deterministic bridge to produce a fully-populated template
// payload + early validation. Throws TeeContentValidationError when
// critical slots are missing; the caller decides fallback policy.
function mapTeeOutputToContent({ rawLLMOutput, teeOutput, input, existingContent }) {
  const { mapTeeOutputToContent: bridge } = require('../teeContentBridge');
  const result = bridge({
    rawLLMOutput,
    teeOutput,
    input,
    templateDefaults: DEFAULT_CONTENT,
    existingContent,
  });
  // Derive programme.rightItems (title + short desc) from cultural.items
  // when the LLM hasn't populated it explicitly. The TEE prompt asks for
  // rightChecks as plain strings; cultural.items always carries body[]
  // descriptions, so this gives the "What You Gain" section real
  // descriptions per item instead of an empty title list. Existing
  // operator overrides via existingContent are preserved by the bridge
  // before this hook runs.
  if (result && result.content) {
    const c = result.content;
    const culturalItems = (c.cultural && Array.isArray(c.cultural.items)) ? c.cultural.items : [];
    const programmeRightItems = (c.programme && Array.isArray(c.programme.rightItems)) ? c.programme.rightItems : [];
    const needsRightItems = programmeRightItems.length === 0
      || programmeRightItems.every((it) => !it || !it.desc);
    if (needsRightItems && culturalItems.length > 0) {
      c.programme = c.programme || {};
      c.programme.rightItems = culturalItems.slice(0, 4).map((it) => {
        const body = Array.isArray(it.body) ? it.body.join(' ') : String(it.body || '');
        return { title: it.name || '', desc: body.trim() };
      }).filter((it) => it.title);
    }
  }
  return result;
}

module.exports = {
  id: TEMPLATE_ID,
  themeId: THEME_ID,
  family: 'educational',
  schema: EDITOR_SCHEMA,
  defaultContent: DEFAULT_CONTENT,
  render,
  mapBlocksToContent,         // legacy block-array → semantic bridge (still supported)
  mapTeeOutputToContent,      // PR-E Phase 2.2 — TEE-emitted content → semantic bridge
  // Test-only exposures (preserved for the existing 818-line test suite).
  _mergeContent: mergeContent,
  _resetCssCache: resetCssCache,
  // Helpers re-exposed for backwards compatibility.
  _escapeHtml: escapeHtml,
};
