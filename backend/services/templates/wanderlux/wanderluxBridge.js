/**
 * wanderluxBridge.js — maps LLM-emitted block content into the
 * Wanderlux reference's `config` schema.
 *
 * Why: the existing `landingPagePrompts.js` prompts the LLM for a 9-block
 * array (destinationHero / highlightsGrid / cityCards / safetyFeatures /
 * inclusionsGrid / itineraryTimeline / tierPricing / faqAccordion /
 * contactFooter). The reference template renders a CONFIG object with
 * different top-level keys (theme / brand / hero / cities / intro /
 * highlights / safety / investment / register / faqs / finalCta /
 * footer). This bridge converts the former into the latter so the
 * Wanderlux template can render the LLM's output without an LLM-prompt
 * rewrite.
 *
 * Operator guardrails preserved:
 *   - investment.installments[i].amount stays null (operator-only)
 *   - testimonials stay omitted (operator-only)
 *   - footer.email / footer.phones stay empty (operator-only)
 *
 * Image strategy:
 *   The bridge ATTACHES `imagePrompt` strings per slot so the route's
 *   image-fetcher (destinationImageProvider → aiImageFallbackProvider →
 *   Pollinations) can generate matching photos. The reference uses the
 *   same approach. Bridge does NOT call the image provider — that
 *   happens in the route after this bridge returns.
 */

'use strict';

// Per-sub-brand theme palettes. The LLM doesn't emit a theme today; we
// pick one based on subBrand + destination family so each tour ships with
// a distinct visual identity. The reference's sample-config.json shows
// the shape exactly — these are #RRGGBB hex.
const SUB_BRAND_THEMES = {
  rfu: {
    brandColor: '#0E7C7B', accentColor: '#C89A4E', darkColor: '#0B3954',
    footerColor: '#072438', lightBg: '#F7FAF9', panelBg: '#FFFFFF',
    softBg: '#E8F3F1', textColor: '#15242B', textColor2: '#5B6B70',
    borderColor: '#DCE6E4',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  tmc: {
    brandColor: '#0F1B3D', accentColor: '#D9A441', darkColor: '#0A1330',
    footerColor: '#080F25', lightBg: '#F7F9FC', panelBg: '#FFFFFF',
    softBg: '#EEF3FB', textColor: '#16202E', textColor2: '#5A6678',
    borderColor: '#DCE3EF',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  travelstall: {
    brandColor: '#122647', accentColor: '#C89A4E', darkColor: '#0A1430',
    footerColor: '#070D1F', lightBg: '#F7F6F1', panelBg: '#FFFFFF',
    softBg: '#EEEAE0', textColor: '#1A1F2E', textColor2: '#5A5E68',
    borderColor: '#E0DBCF',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  visasure: {
    brandColor: '#1E3A8A', accentColor: '#E0A458', darkColor: '#0F1F4E',
    footerColor: '#0B1638', lightBg: '#F7F9FC', panelBg: '#FFFFFF',
    softBg: '#E8EEF8', textColor: '#15202E', textColor2: '#5B6678',
    borderColor: '#D9E2F0',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
};

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function pickThemeFor(subBrand) {
  return SUB_BRAND_THEMES[subBrand] || SUB_BRAND_THEMES.travelstall;
}

/**
 * Build a vivid imagePrompt for a destination + sub-context. These feed
 * the image-provider chain (Pollinations Flux at the bottom). Rich
 * prompts produce photo-realistic outputs; short queries produce
 * generic mush.
 */
function vividPrompt(destination, subject, mood) {
  const dest = String(destination || '').trim();
  const subj = String(subject || '').trim();
  const flavour = String(mood || 'golden hour, cinematic').trim();
  if (!dest && !subj) return `professional travel photography, ${flavour}`;
  if (!subj) return `${dest}, professional travel photography, ${flavour}, sharp focus, no text, no watermark, photorealistic`;
  if (!dest) return `${subj}, professional travel photography, ${flavour}, sharp focus, no text, no watermark, photorealistic`;
  return `${subj}, ${dest}, professional travel photography, ${flavour}, sharp focus, no text, no watermark, photorealistic`;
}

/**
 * Compute an ISO deadline for the hero countdown — N weeks from now,
 * capped at 28 days minimum (so a "7-day trip" doesn't surface a 1-day
 * urgency). Operator can override in the builder.
 */
function defaultCountdownIso(durationDays) {
  const days = Number.isFinite(durationDays) && durationDays > 0 ? durationDays : 7;
  const offsetDays = Math.max(28, Math.round(days * 2));
  const ms = Date.now() + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function getBlock(blocks, type) {
  const found = (Array.isArray(blocks) ? blocks : []).find(
    (b) => b && b.type === type,
  );
  return (found && found.props) || {};
}

/**
 * Main bridge entry point.
 *
 * @param {Array<Object>} blocks    — LLM block array
 * @param {Object} input            — { destination, durationDays, audience, subBrand, suggestedTitle, metaDescription }
 * @returns {Object} reference-config-shape object
 */
function mapBlocksToWanderluxConfig(blocks, input) {
  const inp = (input && typeof input === 'object') ? input : {};
  const destination = String(inp.destination || '').trim() || 'Destination';
  const audience = String(inp.audience || '').trim();
  const days = Number.isFinite(Number(inp.durationDays))
    ? Math.max(1, Math.min(60, Math.trunc(Number(inp.durationDays))))
    : 7;
  const subBrand = String(inp.subBrand || 'travelstall').toLowerCase();
  const suggestedTitle = String(inp.suggestedTitle || '').trim();
  const metaDescription = String(inp.metaDescription || '').trim();

  const hero = getBlock(blocks, 'destinationHero');
  const highlights = getBlock(blocks, 'highlightsGrid');
  const cities = getBlock(blocks, 'cityCards');
  const safety = getBlock(blocks, 'safetyFeatures');
  const inclusions = getBlock(blocks, 'inclusionsGrid');
  const itinerary = getBlock(blocks, 'itineraryTimeline');
  const pricing = getBlock(blocks, 'tierPricing');
  const faq = getBlock(blocks, 'faqAccordion');

  const cityCards = Array.isArray(cities.cards) ? cities.cards : [];
  const highlightItems = Array.isArray(highlights.items) ? highlights.items : [];
  const safetyItems = Array.isArray(safety.items) ? safety.items : [];
  const inclusionsItems = Array.isArray(inclusions.items) ? inclusions.items : [];
  const itineraryDays = Array.isArray(itinerary.days) ? itinerary.days : [];
  const pricingTiers = Array.isArray(pricing.tiers) ? pricing.tiers : [];
  const faqItems = Array.isArray(faq.faqs) ? faq.faqs : [];
  const faqCategories = Array.isArray(faq.categories) ? faq.categories : [];

  const theme = pickThemeFor(subBrand);
  const cityCount = cityCards.length;
  const kicker = cityCount > 0
    ? `${String(days).padStart(2, '0')} Days. ${String(cityCount).padStart(2, '0')} ${cityCount === 1 ? 'City' : 'Cities'}.`
    : `${String(days).padStart(2, '0')} Days.`;

  return {
    theme,
    brand: {
      subBrand: subBrand === 'rfu' ? 'RFU' : subBrand === 'tmc' ? 'TMC' : subBrand === 'visasure' ? 'VisaSure' : 'TravelStall',
      mark: '',
      name: (destination ? destination.toUpperCase() : 'Untitled Tour').slice(0, 40),
    },
    meta: {
      slug: slugify(`${destination}-${days}d`),
      tripId: null,
    },
    nav: {
      links: [
        { label: 'Itinerary', href: '#itinerary' },
        { label: 'Inclusions', href: '#inclusions' },
        { label: 'Pricing', href: '#investment' },
        { label: 'FAQs', href: '#faqs' },
      ],
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
      ctaHref: '#register',
      floating: true,
    },
    hero: {
      logos: [],
      eyebrow: audience ? audience.toUpperCase() : '',
      badge: '', // operator-controlled (seat scarcity claims)
      kicker,
      titleLines: (hero.headline || destination).split(/\s+/).reduce((acc, w) => {
        // Split the headline into 2-3 lines around its midpoint.
        if (acc.length === 0) return [w];
        const last = acc[acc.length - 1];
        if (last.length + w.length < 18 && acc.length < 3) {
          acc[acc.length - 1] = `${last} ${w}`;
        } else if (acc.length < 3) {
          acc.push(w);
        } else {
          acc[acc.length - 1] = `${last} ${w}`;
        }
        return acc;
      }, []),
      subhead: hero.subhead || metaDescription || '',
      valueCards: highlightItems.slice(0, 4).map((it) => ({
        title: it.title || '',
        body: it.body || '',
      })),
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
      // imagePrompt drives the image-provider chain. Rich + specific.
      imagePrompt: vividPrompt(destination, 'iconic landmark and scenery', 'golden hour, dramatic sky'),
      imageTitle: suggestedTitle || `${destination} ${new Date().getFullYear() + 1}`,
      imageSubtitle: metaDescription || hero.subhead || '',
    },
    countdown: {
      enabled: true,
      deadline: defaultCountdownIso(days),
      label: 'Registration Closes In',
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
      ctaHref: '#register',
    },
    // Cities for the auto-scrolling photo strip. Each card needs an
    // imagePrompt that produces a tall destination photo.
    cities: cityCards.slice(0, 6).map((c) => ({
      name: c.title || '',
      tag: c.tag || '',
      imagePrompt: vividPrompt(destination, c.title || '', 'editorial portrait of the locale, soft natural light'),
    })),
    // Reference's intro block — left col = paragraphs, right col = quote
    // + gains list. Maps from highlights subtitle (intro paragraph) +
    // highlight titles (gains list).
    intro: highlightItems.length > 0 ? {
      title: highlights.title || `Why ${destination}.`,
      paragraphs: [
        hero.subhead || metaDescription || '',
        highlights.subtitle || '',
      ].filter(Boolean),
      gainsTitle: 'What You Gain',
      gainsQuote: (highlightItems[0] && highlightItems[0].body) || '',
      gains: highlightItems.slice(0, 4).map((it) => it.title || '').filter(Boolean),
      ctaLabel: 'Talk to Our Team →',
    } : null,
    // Destination flip cards. Body + benefit + matching photo.
    highlights: cityCards.length > 0 ? {
      eyebrow: 'Destinations',
      title: cities.title || 'Destination Highlights',
      subtitle: cities.subtitle || '',
      cards: cityCards.map((c) => ({
        name: c.title || '',
        eyebrow: c.tag || '',
        frontBody: c.body || '',
        backBody: c.body || '',
        benefit: c.benefit || '',
        imagePrompt: vividPrompt(destination, `${c.title || ''}, ${c.tag || 'cultural landmark'}`, 'cinematic, soft light'),
      })),
      bannerTitle: `Every Day Has a Purpose in ${destination}.`,
      bannerBody: 'See the full day-by-day plan and how each stop fits the programme.',
      bannerCtaLabel: hero.ctaText || 'Reserve Your Spot',
    } : null,
    safety: safetyItems.length > 0 ? {
      eyebrow: 'Safety Framework',
      title: safety.title || 'Safe by Design.',
      subtitle: safety.subtitle || '',
      // Stats are operator-controlled by design (specific ratios feel
      // like vendor claims). We seed 4 generic tiles ready for operator
      // edit.
      stats: [
        { stat: 'All', title: 'Inclusions', body: 'Transport, stays, meals and key activities.' },
        { stat: '24/7', title: 'On-Call Support', body: 'Round-the-clock contact line for parents.' },
        { stat: 'Vetted', title: 'Accommodations', body: 'Inspected stays only.' },
        { stat: '✈', title: 'Return Flights', body: 'Full-service carriers throughout.' },
      ],
      includedTitle: "What's Included",
      includedQuote: safety.subtitle || '',
      included: inclusionsItems.slice(0, 8),
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
    } : null,
    // testimonials — operator-only by design, omitted.
    testimonials: null,
    investment: pricingTiers.length > 0 ? {
      eyebrow: 'Investment',
      title: pricing.title || 'Transparent Pricing',
      subtitle: pricing.subtitle || 'A simple multi-instalment plan. No hidden costs.',
      featuredIndex: 0,
      installments: pricingTiers.map((t) => ({
        tag: t.label || '',
        title: t.label || '',
        sub: t.subtitle || '',
        // amount/date/entity stay empty — operator fills them.
        amount: '',
        date: '',
        entity: '',
      })),
      inclusionsTitle: 'Indicative Inclusions',
      inclusions: inclusionsItems.slice(0, 6),
      note: 'A detailed cost sheet is shared on enquiry.',
    } : null,
    register: {
      eyebrow: 'Reserve Your Seat',
      title: `Register — ${destination} ${new Date().getFullYear() + 1}`,
      intro: "Tell us about you and we'll be in touch within one business day.",
      endpoint: null, // route fills this on persist (post-save)
      // capacity: 50 (was 0) — the reference's "Registration Closed" gate
      // fires when `registered >= capacity`. With capacity=0 + registered=0
      // every fresh draft rendered as already-full despite the countdown
      // showing 27 days remaining. 50 is a sensible default the operator
      // can edit per-tour.
      capacity: 50,
      registered: 0,
      deadline: defaultCountdownIso(days),
      successTitle: 'Thanks — You\'re on the List!',
      successBody: 'Our team will reach out within one business day with the full itinerary and next steps.',
      submitLabel: 'Submit Registration',
      steps: [
        {
          title: 'Traveller',
          fields: [
            { name: 'name', label: 'Full Name', type: 'text', required: true, placeholder: 'Enter your full name' },
            { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'email@example.com' },
            { name: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: 'Mobile number' },
          ],
        },
      ],
      covers: inclusionsItems.slice(0, 4).map((item) => ({
        title: String(item || '').slice(0, 60),
        body: 'Detail shared during the orientation call.',
      })),
    },
    // brochure — operator wires after upload, omitted by default
    brochure: { enabled: false },
    faqs: faqItems.length > 0 ? {
      eyebrow: 'Clarifications',
      title: faq.title || 'Frequently Asked Questions',
      subtitle: faq.subtitle || '',
      allLabel: 'All Questions',
      categories: faqCategories.length > 0
        ? faqCategories.map((c) => ({ id: c.id || 'all', label: c.label || 'All', icon: c.icon || '◇' }))
        : [{ id: 'all', label: 'All Questions', icon: '◇' }],
      items: faqItems.map((q) => ({
        category: q.cat || 'all',
        q: q.q || '',
        a: q.a || '',
      })),
    } : null,
    finalCta: {
      eyebrow: kicker,
      title: `Plan ${destination} With Confidence.`,
      subtitle: 'One structured journey. One team. One clear path.',
      steps: [
        { label: 'Register interest' },
        { label: 'Review the plan' },
        { label: 'Confirm the seat' },
      ],
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
    },
    footer: {
      mark: '',
      name: destination ? destination.toUpperCase() : 'Untitled Tour',
      tagline: metaDescription || hero.subhead || '',
      // email + phones intentionally empty — operator-controlled per
      // commercial guardrails.
      email: '',
      phones: [],
      legal: [`© ${new Date().getFullYear()} ${subBrand === 'rfu' ? 'RFU' : subBrand === 'tmc' ? 'TMC' : subBrand === 'visasure' ? 'Visa Sure' : 'Travel Stall'}`],
    },
    // Itinerary block — the reference renders only when intro is set,
    // but we also expose the day-by-day for the wanderlux intro block.
    // The reference itself doesn't have an itinerary section; we surface
    // it via intro.paragraphs concatenation.
    _itinerary: itineraryDays.map((d) => ({
      day: d.day || 0,
      title: d.title || '',
      bullets: Array.isArray(d.bullets) ? d.bullets : [],
    })),
  };
}

module.exports = {
  mapBlocksToWanderluxConfig,
  vividPrompt,
  pickThemeFor,
  SUB_BRAND_THEMES,
};
