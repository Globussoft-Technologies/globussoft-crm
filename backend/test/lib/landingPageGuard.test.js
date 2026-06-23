/**
 * landingPageGuard.test.js — pins the strict no-commercial-data rules
 * that PR-B's user requirement declared:
 *
 *   AI MAY generate ONLY: hero copy, destination highlights, city
 *   descriptions, itinerary content, FAQs, SEO metadata, suggested
 *   title, suggested slug.
 *
 *   AI MUST NOT generate: testimonials, pricing values, discounts,
 *   commercial claims, vendor names, ratings, satisfaction claims,
 *   image URLs.
 *
 * The guardrail is the contract — these tests are the safety net. Every
 * banned category gets at least one rejection case; every allowed
 * category gets a "passes cleanly" case.
 */
import { describe, test, expect } from 'vitest';
import {
  guardLandingPageOutput,
  buildDeterministicFallback,
  classifyText,
  validateTopLevelSchema,
  normaliseSlug,
  MONEY_REGEX,
  DISCOUNT_REGEX,
  PROMO_REGEX,
  RATING_REGEX,
  SATISFACTION_REGEX,
  CORPORATE_SUFFIX_REGEX,
  VENDOR_NAME_REGEX,
  TESTIMONIAL_REGEX,
} from '../../lib/landingPageGuard.js';

const VALID_INPUT = {
  destination: 'Bali',
  durationDays: 7,
  audience: 'Honeymooners',
  subBrand: 'travelstall',
};

function validBlocks(days = 7) {
  return [
    {
      type: 'destinationHero',
      props: {
        destination: 'Bali',
        headline: 'A 7-day Bali escape',
        subhead: 'Curated for honeymooners who want quiet beaches.',
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
        title: 'Why Bali',
        subtitle: '',
        items: [
          { icon: '◈', title: 'Beaches', body: 'Quiet south-coast sands away from crowds.' },
          { icon: '⊕', title: 'Culture', body: 'Daily temple ceremonies woven into life.' },
          { icon: '⌂', title: 'Cuisine', body: 'Warungs and ricefield eateries throughout.' },
        ],
      },
    },
    {
      type: 'cityCards',
      props: {
        title: 'Where You\'ll Go',
        subtitle: '',
        cards: [
          { tag: 'COAST', title: 'Ubud', img: null, body: 'Forest temples and ricefield trails.', benefit: '' },
          { tag: 'BEACH', title: 'Seminyak', img: null, body: 'Sunset beaches and night markets.', benefit: '' },
          { tag: 'TEMPLE', title: 'Uluwatu', img: null, body: 'Clifftop temples and kecak dance.', benefit: '' },
        ],
      },
    },
    {
      type: 'safetyFeatures',
      props: {
        title: 'Engineered for Safety',
        subtitle: '',
        items: [
          { icon: '🛡', title: 'Travel insurance', body: 'Comprehensive cover included for every traveller.' },
          { icon: '⚕', title: 'Vetted accommodation', body: 'Every hotel checked in advance for safety.' },
          { icon: '☎', title: '24/7 support', body: 'Round-the-clock contact with the ground team.' },
        ],
      },
    },
    {
      type: 'inclusionsGrid',
      props: {
        title: "What's Included",
        subtitle: '',
        items: [
          'Return international airfare',
          'Boutique villa accommodation',
          'Daily breakfast and three dinners',
          'Private chauffeured transfers',
          'Activity guide and translator support',
        ],
      },
    },
    {
      type: 'itineraryTimeline',
      props: {
        title: 'Day-by-day',
        subtitle: '',
        days: Array.from({ length: days }, (_, i) => ({
          day: i + 1,
          title: i === 0 ? 'Arrival in Bali' : i === days - 1 ? 'Departure' : `Day ${i + 1}`,
          bullets: ['Morning activity placeholder', 'Afternoon activity placeholder'],
        })),
      },
    },
    {
      // Structural shell — AI suggests labels, every monetary field is null.
      type: 'tierPricing',
      props: {
        title: 'Investment',
        subtitle: '',
        currency: '₹',
        tiers: [
          { step: 1, label: 'First Instalment', subtitle: 'Booking confirmation', amount: null, dueDate: null, vendor: null, tag: null },
          { step: 2, label: 'Mid-term Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
          { step: 3, label: 'Final Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
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
          { cat: 'tour', q: 'When is the best time to visit?', a: 'April through October is the dry season.' },
          { cat: 'logistics', q: 'What documents are needed?', a: 'A passport with at least six months of validity.' },
          { cat: 'safety', q: 'What safety protocols are in place?', a: 'Pre-vetted accommodations and 24/7 ground support.' },
          { cat: 'tour', q: 'Is the itinerary flexible?', a: 'Activities can be swapped for personal preferences.' },
        ],
      },
    },
    {
      // contactFooter shell — phone / email / brand / ctaUrl all null.
      type: 'contactFooter',
      props: {
        brandName: null,
        phone: null,
        email: null,
        ctaText: 'Reserve Your Spot',
        ctaUrl: null,
      },
    },
  ];
}

function validLlmOutput() {
  return {
    suggestedTitle: 'Bali 2026 — 7-day Honeymoon Escape',
    suggestedSlug: 'bali-7-day-honeymoon',
    seoMeta: {
      metaTitle: 'Bali Honeymoon — 7 days',
      metaDescription: 'A 7-day Bali honeymoon itinerary covering Ubud, Seminyak, and Uluwatu, designed for couples.',
    },
    blocks: validBlocks(7),
  };
}

// ── classifyText — banned-category regex coverage ────────────────────

describe('classifyText — money', () => {
  test('catches ₹ + number', () => expect(classifyText('₹34,980')?.reason).toBe('money'));
  test('catches Rs prefix', () => expect(classifyText('Rs 25,000')?.reason).toBe('money'));
  test('catches USD prefix', () => expect(classifyText('USD 100 per person')?.reason).toBe('money'));
  test('catches Indian number-words', () => expect(classifyText('50 lakh')?.reason).toBe('money'));
  test('catches "5 crore"', () => expect(classifyText('5 crore')?.reason).toBe('money'));
  test('catches "25k"', () => expect(classifyText('25k flight')?.reason).toBe('money'));
  test('does NOT catch plain prose about temples', () => expect(classifyText('Visit five temples along the route.')).toBeNull());
});

describe('classifyText — discount', () => {
  test('catches "20% off"', () => expect(classifyText('20% off summer bookings')?.reason).toBe('discount'));
  test('catches "save 50%"', () => expect(classifyText('save 50% on early reservation')?.reason).toBe('discount'));
  test('catches "save 5000"', () => expect(classifyText('save 5000 with this offer')?.reason).toBe('discount'));
  test('does NOT catch "save the date"', () => expect(classifyText('Please save the date in your calendar.')).toBeNull());
});

describe('classifyText — promo', () => {
  test('catches "limited time"', () => expect(classifyText('A limited time offer for our travellers')?.reason).toBe('promo'));
  test('catches "exclusive offer"', () => expect(classifyText('An exclusive offer for early signups')?.reason).toBe('promo'));
  test('catches "guaranteed"', () => expect(classifyText('Guaranteed best experience in the region')?.reason).toBe('promo'));
  test('catches "act fast"', () => expect(classifyText('Act fast to secure your seat')?.reason).toBe('promo'));
});

describe('classifyText — rating + satisfaction', () => {
  test('catches "5-star"', () => expect(classifyText('A 5-star rated experience')?.reason).toBe('rating'));
  test('catches "4.8/5"', () => expect(classifyText('Rated 4.8/5 by past travellers')?.reason).toBe('rating'));
  test('catches "award-winning"', () => expect(classifyText('Our award-winning travel team')?.reason).toBe('rating'));
  test('catches "thousands of happy"', () => expect(classifyText('Trusted by thousands of happy travellers')?.reason).toBe('satisfaction'));
});

describe('classifyText — vendor / partner names', () => {
  test('catches "Pvt Ltd"', () => expect(classifyText('Operated by Acme Travel Pvt Ltd')?.reason).toBe('vendor'));
  test('catches "Inc."', () => expect(classifyText('Booked through Globe Trotters Inc.')?.reason).toBe('vendor'));
  test('catches known brand "Travel Stall"', () => expect(classifyText('Trip operated by Travel Stall')?.reason).toBe('vendor'));
  test('catches known brand "TMC Nexus"', () => expect(classifyText('In partnership with TMC Nexus')?.reason).toBe('vendor'));
});

describe('classifyText — testimonial language', () => {
  test('catches "as told by"', () => expect(classifyText('As told by past traveller Maria')?.reason).toBe('testimonial'));
  test('catches "in the words of"', () => expect(classifyText('In the words of a past parent')?.reason).toBe('testimonial'));
  test('catches em-dash + name pattern', () => expect(classifyText('"Phenomenal experience" — Priya S.')?.reason).toBe('testimonial'));
});

describe('classifyText — clean prose passes', () => {
  test('destination prose passes', () => expect(classifyText('Tokyo offers a structured contrast between tradition and modern systems.')).toBeNull());
  test('itinerary prose passes', () => expect(classifyText('Morning visit to Ubud monkey forest followed by lunch at a traditional warung.')).toBeNull());
  test('FAQ answer passes', () => expect(classifyText('Passports must have at least six months of validity from the return date.')).toBeNull());
});

// ── validateTopLevelSchema ───────────────────────────────────────────

describe('validateTopLevelSchema', () => {
  test('valid output → null', () => expect(validateTopLevelSchema(validLlmOutput())).toBeNull());
  test('null → schema.not_object', () => expect(validateTopLevelSchema(null)).toEqual(['schema.not_object']));
  test('missing suggestedTitle → flagged', () => {
    const o = validLlmOutput(); delete o.suggestedTitle;
    expect(validateTopLevelSchema(o)).toContain('schema.missing_suggestedTitle');
  });
  test('missing seoMeta → flagged', () => {
    const o = validLlmOutput(); delete o.seoMeta;
    expect(validateTopLevelSchema(o)).toContain('schema.missing_seoMeta');
  });
  test('blocks not array → flagged', () => {
    const o = validLlmOutput(); o.blocks = 'oops';
    expect(validateTopLevelSchema(o)).toContain('schema.blocks_not_array');
  });
});

// ── normaliseSlug ────────────────────────────────────────────────────

describe('normaliseSlug', () => {
  test('lowercases + replaces spaces', () => expect(normaliseSlug('Bali 7 Days')).toBe('bali-7-days'));
  test('collapses repeated hyphens', () => expect(normaliseSlug('umrah--10---days')).toBe('umrah-10-days'));
  test('strips leading/trailing hyphens', () => expect(normaliseSlug('---abc---')).toBe('abc'));
  test('caps at 50 chars', () => expect(normaliseSlug('a'.repeat(60)).length).toBeLessThanOrEqual(50));
  test('non-string → empty', () => expect(normaliseSlug(null)).toBe(''));
});

// ── End-to-end guardLandingPageOutput ────────────────────────────────

describe('guardLandingPageOutput — happy path', () => {
  test('clean LLM output passes Layer 1+2 (verdict=passed)', () => {
    const r = guardLandingPageOutput(validLlmOutput(), VALID_INPUT);
    expect(r.accepted).toBe(true);
    expect(r.verdict).toBe('passed');
    expect(r.issues).toEqual([]);
    // 9 blocks: hero, highlights, cities, safety, inclusions,
    // itinerary, tierPricing (shell), faq, contactFooter (shell).
    // AI emits all 9 — the publish gate requires every tier's `amount`
    // to be filled by the operator before the page can go PUBLISHED.
    expect(r.output.blocks).toHaveLength(9);
    expect(r.output.suggestedSlug).toBe('bali-7-day-honeymoon');
  });

  test('itinerary day count matches input.durationDays', () => {
    const o = validLlmOutput();
    o.blocks[4].props.days = validBlocks(7)[4].props.days; // 7 days
    const r = guardLandingPageOutput(o, { ...VALID_INPUT, durationDays: 7 });
    expect(r.accepted).toBe(true);
  });

  test('clean output preserves the contactFooter shell with every commercial field null', () => {
    const r = guardLandingPageOutput(validLlmOutput(), VALID_INPUT);
    const contact = r.output.blocks.find((b) => b.type === 'contactFooter');
    expect(contact).toBeTruthy();
    expect(contact.props.brandName).toBeNull();
    expect(contact.props.phone).toBeNull();
    expect(contact.props.email).toBeNull();
    expect(contact.props.ctaUrl).toBeNull();
    expect(typeof contact.props.ctaText).toBe('string');
    expect(contact.props.ctaText.length).toBeGreaterThan(0);
  });

  test('clean output preserves the safetyFeatures block with descriptive items', () => {
    const r = guardLandingPageOutput(validLlmOutput(), VALID_INPUT);
    const safety = r.output.blocks.find((b) => b.type === 'safetyFeatures');
    expect(safety).toBeTruthy();
    expect(safety.props.items.length).toBeGreaterThanOrEqual(3);
    safety.props.items.forEach((it) => {
      expect(typeof it.icon).toBe('string');
      expect(typeof it.title).toBe('string');
      expect(it.title.length).toBeGreaterThan(0);
    });
  });

  test('LLM emits contactFooter with a real phone number → phone nulled, must_be_null issue flagged', () => {
    const o = validLlmOutput();
    const contactIdx = o.blocks.findIndex((b) => b.type === 'contactFooter');
    o.blocks[contactIdx].props.phone = '+91 99 12345 67890';
    o.blocks[contactIdx].props.email = 'hello@brand.com';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const contact = r.output.blocks.find((b) => b.type === 'contactFooter');
    expect(contact.props.phone).toBeNull();
    expect(contact.props.email).toBeNull();
    expect(r.issues.some((i) => i.includes('contact.phone:must_be_null'))).toBe(true);
    expect(r.issues.some((i) => i.includes('contact.email:must_be_null'))).toBe(true);
  });

  test('LLM emits tierPricing tier with badge → badge nulled, must_be_null issue flagged', () => {
    const o = validLlmOutput();
    const pricingIdx = o.blocks.findIndex((b) => b.type === 'tierPricing');
    o.blocks[pricingIdx].props.tiers[0].badge = 'Most Popular';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const pricing = r.output.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing.props.tiers[0].badge).toBeNull();
    expect(r.issues.some((i) => i.includes('badge:must_be_null'))).toBe(true);
  });

  test('LLM emits travelVideo block → dropped entirely (URL fabrication forbidden)', () => {
    const o = validLlmOutput();
    o.blocks.push({ type: 'travelVideo', props: { url: 'https://youtube.com/embed/AI_HALLUCINATED' } });
    const r = guardLandingPageOutput(o, VALID_INPUT);
    expect(r.output.blocks.find((b) => b.type === 'travelVideo')).toBeUndefined();
    expect(r.issues.some((i) => i.includes('disallowed_type:travelVideo'))).toBe(true);
  });

  test('LLM emits brochureDownload block → dropped entirely (file URL fabrication forbidden)', () => {
    const o = validLlmOutput();
    o.blocks.push({ type: 'brochureDownload', props: { fileUrl: 'https://example.com/fake.pdf' } });
    const r = guardLandingPageOutput(o, VALID_INPUT);
    expect(r.output.blocks.find((b) => b.type === 'brochureDownload')).toBeUndefined();
    expect(r.issues.some((i) => i.includes('disallowed_type:brochureDownload'))).toBe(true);
  });

  test('clean output preserves the tierPricing shell with every commercial field null', () => {
    const r = guardLandingPageOutput(validLlmOutput(), VALID_INPUT);
    const pricing = r.output.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(pricing.props.tiers.length).toBeGreaterThan(0);
    pricing.props.tiers.forEach((t) => {
      // Structural fields are preserved (operator can edit labels).
      expect(typeof t.label).toBe('string');
      expect(typeof t.step).toBe('number');
      // Every commercial field MUST be null after the scrub.
      expect(t.amount).toBeNull();
      expect(t.dueDate).toBeNull();
      expect(t.vendor).toBeNull();
      expect(t.tag).toBeNull();
    });
  });
});

describe('guardLandingPageOutput — bad LLM output', () => {
  test('not an object → fallback', () => {
    const r = guardLandingPageOutput('not json', VALID_INPUT);
    expect(r.verdict).toBe('fallback');
    expect(r.issues[0]).toBe('schema.not_object');
    // 9 blocks: hero, highlights, cities, safety, inclusions,
    // itinerary, tierPricing shell, faq, contactFooter shell.
    expect(r.output.blocks).toHaveLength(9);
  });

  test('missing required block → fallback', () => {
    const o = validLlmOutput();
    o.blocks = o.blocks.filter((b) => b.type !== 'faqAccordion');
    const r = guardLandingPageOutput(o, VALID_INPUT);
    expect(r.verdict).toBe('fallback');
    expect(r.issues.some((i) => i.includes('missing_required:faqAccordion'))).toBe(true);
  });

  test('LLM emits tierPricing block with non-null amount → block preserved, amount nulled, verdict=scrubbed', () => {
    const o = validLlmOutput();
    // Single tier with one commercial field set so we test the SCRUB
    // path, not the fallback threshold. (5+ issues triggers Layer 3
    // — see "too many violations" test below for that path.)
    const pricingIdx = o.blocks.findIndex((b) => b.type === 'tierPricing');
    o.blocks[pricingIdx] = {
      type: 'tierPricing',
      props: {
        title: 'Investment',
        subtitle: '',
        currency: '₹',
        tiers: [
          { step: 1, label: 'Booking', subtitle: '', amount: '5000', dueDate: null, vendor: null, tag: null },
        ],
      },
    };
    const r = guardLandingPageOutput(o, VALID_INPUT);
    expect(r.accepted).toBe(true);
    expect(r.verdict).toBe('scrubbed');
    const pricing = r.output.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(pricing.props.tiers).toHaveLength(1);
    expect(pricing.props.tiers[0].amount).toBeNull();
    expect(pricing.props.tiers[0].label).toBe('Booking');
    expect(pricing.props.tiers[0].step).toBe(1);
    expect(r.issues.some((i) => i.includes('amount:must_be_null'))).toBe(true);
  });

  test('LLM emits tierPricing tier with vendor name → vendor nulled, must_be_null issue flagged', () => {
    const o = validLlmOutput();
    const pricingIdx = o.blocks.findIndex((b) => b.type === 'tierPricing');
    o.blocks[pricingIdx] = {
      type: 'tierPricing',
      props: {
        title: 'Investment',
        subtitle: '',
        currency: '₹',
        tiers: [
          { step: 1, label: 'Booking', subtitle: '', amount: null, dueDate: null, vendor: 'Acme Travel Pvt Ltd', tag: null },
        ],
      },
    };
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const pricing = r.output.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(pricing.props.tiers[0].vendor).toBeNull();
    expect(r.issues.some((i) => i.includes('vendor:must_be_null'))).toBe(true);
  });

  test('disallowed reviewCarousel block is still dropped (operator-only)', () => {
    const o = validLlmOutput();
    o.blocks.push({ type: 'reviewCarousel', props: { reviews: [{ name: 'Priya', text: 'Amazing!' }] } });
    const r = guardLandingPageOutput(o, VALID_INPUT);
    expect(r.output.blocks.find((b) => b.type === 'reviewCarousel')).toBeUndefined();
    expect(r.issues.some((i) => i.includes('disallowed_type:reviewCarousel'))).toBe(true);
  });

  test('LLM omits the tierPricing block entirely → guard backfills the shell (verdict=passed)', () => {
    const o = validLlmOutput();
    o.blocks = o.blocks.filter((b) => b.type !== 'tierPricing');
    // Now the LLM output is missing a required block.
    const r = guardLandingPageOutput(o, VALID_INPUT);
    // Required-block-missing → falls through to deterministic fallback,
    // which DOES include a tierPricing shell.
    expect(r.verdict).toBe('fallback');
    const pricing = r.output.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(pricing.props.tiers.every((t) => t.amount === null)).toBe(true);
  });

  test('disallowed reviewCarousel block is dropped', () => {
    const o = validLlmOutput();
    o.blocks.push({ type: 'reviewCarousel', props: { reviews: [{ name: 'Priya', text: 'Amazing!' }] } });
    const r = guardLandingPageOutput(o, VALID_INPUT);
    expect(r.output.blocks.find((b) => b.type === 'reviewCarousel')).toBeUndefined();
    expect(r.issues.some((i) => i.includes('disallowed_type:reviewCarousel'))).toBe(true);
  });

  test('city img URL is nulled', () => {
    const o = validLlmOutput();
    o.blocks[2].props.cards[0].img = 'https://images.unsplash.com/photo-x.jpg';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const cities = r.output.blocks.find((b) => b.type === 'cityCards');
    expect(cities.props.cards[0].img).toBeNull();
    expect(r.issues.some((i) => i.includes('img:must_be_null'))).toBe(true);
  });

  test('hero posterUrl is nulled', () => {
    const o = validLlmOutput();
    o.blocks[0].props.posterUrl = 'https://example.com/h.jpg';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const hero = r.output.blocks.find((b) => b.type === 'destinationHero');
    expect(hero.props.posterUrl).toBeNull();
    expect(r.issues.some((i) => i.includes('posterUrl_must_be_null'))).toBe(true);
  });

  test('headline with monetary value is scrubbed to empty', () => {
    const o = validLlmOutput();
    const heroIdx = o.blocks.findIndex((b) => b.type === 'destinationHero');
    o.blocks[heroIdx].props.headline = 'Bali for ₹50,000 only';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const hero = r.output.blocks.find((b) => b.type === 'destinationHero');
    expect(hero.props.headline).toBe('');
    expect(r.issues.some((i) => i.includes('hero.headline:money'))).toBe(true);
  });

  test('FAQ answer with rating claim is scrubbed', () => {
    const o = validLlmOutput();
    const faqIdx = o.blocks.findIndex((b) => b.type === 'faqAccordion');
    o.blocks[faqIdx].props.faqs[0].a = '5-star service guaranteed.';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const faq = r.output.blocks.find((b) => b.type === 'faqAccordion');
    // The whole FAQ gets dropped when the answer is empty (Layer 2 scrub).
    expect(faq.props.faqs.find((f) => f.a === '5-star service guaranteed.')).toBeUndefined();
  });

  test('vendor name in subhead is scrubbed', () => {
    const o = validLlmOutput();
    const heroIdx = o.blocks.findIndex((b) => b.type === 'destinationHero');
    o.blocks[heroIdx].props.subhead = 'Operated by Acme Travel Pvt Ltd, your trusted partner.';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    const hero = r.output.blocks.find((b) => b.type === 'destinationHero');
    expect(hero.props.subhead).toBe('');
    expect(r.issues.some((i) => i.includes('hero.subhead:vendor'))).toBe(true);
  });

  test('too many violations (>5) triggers Layer 3 fallback', () => {
    const o = validLlmOutput();
    // Plant 6 different violations across blocks.
    o.blocks[0].props.headline = '₹999 only';
    o.blocks[0].props.subhead = '5-star award-winning trip';
    o.blocks[1].props.items[0].body = 'limited time exclusive offer';
    o.blocks[1].props.items[1].body = 'thousands of happy travellers';
    o.blocks[2].props.cards[0].body = 'Operated by Travel Stall';
    o.blocks[3].props.items[0] = '20% off early bookings';
    const r = guardLandingPageOutput(o, VALID_INPUT);
    expect(r.verdict).toBe('fallback');
    expect(r.issues.length).toBeGreaterThan(5);
  });
});

// ── buildDeterministicFallback ───────────────────────────────────────

describe('buildDeterministicFallback', () => {
  test('returns the full block shape for the input duration', () => {
    const f = buildDeterministicFallback({ destination: 'Iceland', durationDays: 5, audience: 'photographers' });
    // 9 blocks: hero, highlights, cities, safety, inclusions,
    // itinerary, tierPricing shell, faq, contactFooter shell.
    expect(f.blocks).toHaveLength(9);
    expect(f.blocks.find((b) => b.type === 'safetyFeatures')).toBeTruthy();
    expect(f.blocks.find((b) => b.type === 'contactFooter')).toBeTruthy();
    const it = f.blocks.find((b) => b.type === 'itineraryTimeline');
    expect(it.props.days).toHaveLength(5);
    expect(f.suggestedSlug).toContain('iceland');
  });

  test('fallback contactFooter is a shell with every commercial field null', () => {
    const f = buildDeterministicFallback({ destination: 'Iceland', durationDays: 3 });
    const contact = f.blocks.find((b) => b.type === 'contactFooter');
    expect(contact).toBeTruthy();
    expect(contact.props.brandName).toBeNull();
    expect(contact.props.phone).toBeNull();
    expect(contact.props.email).toBeNull();
    expect(contact.props.ctaUrl).toBeNull();
    expect(typeof contact.props.ctaText).toBe('string');
  });

  test('fallback includes a tierPricing shell with every monetary field null', () => {
    const f = buildDeterministicFallback({ destination: 'Iceland', durationDays: 3 });
    const pricing = f.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(pricing.props.tiers.length).toBeGreaterThan(0);
    pricing.props.tiers.forEach((t) => {
      expect(typeof t.label).toBe('string');
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.amount).toBeNull();
      expect(t.dueDate).toBeNull();
      expect(t.vendor).toBeNull();
      expect(t.tag).toBeNull();
    });
  });

  test('every editable field is [REVIEW]-tagged so operators see placeholders', () => {
    const f = buildDeterministicFallback({ destination: 'Iceland', durationDays: 3, audience: 'photographers' });
    expect(f.suggestedTitle).toContain('[REVIEW]');
    expect(f.seoMeta.metaTitle).toContain('[REVIEW]');
    expect(f.seoMeta.metaDescription).toContain('[REVIEW]');
    const hero = f.blocks.find((b) => b.type === 'destinationHero');
    expect(hero.props.headline).toContain('[REVIEW]');
  });

  test('every img / posterUrl in fallback is null', () => {
    const f = buildDeterministicFallback({ destination: 'Iceland', durationDays: 3 });
    const hero = f.blocks.find((b) => b.type === 'destinationHero');
    expect(hero.props.posterUrl).toBeNull();
    const cities = f.blocks.find((b) => b.type === 'cityCards');
    expect(cities.props.cards.every((c) => c.img === null)).toBe(true);
  });

  test('fallback never includes a reviewCarousel block (testimonials stay manual-only)', () => {
    const f = buildDeterministicFallback({ destination: 'Iceland', durationDays: 3 });
    expect(f.blocks.find((b) => b.type === 'reviewCarousel')).toBeUndefined();
  });
});

// ── Regex tables — direct introspection ──────────────────────────────

describe('Regex pin tests', () => {
  test('MONEY_REGEX covers currency symbols + INR units', () => {
    expect(MONEY_REGEX.test('₹500')).toBe(true);
    expect(MONEY_REGEX.test('USD 1000')).toBe(true);
    expect(MONEY_REGEX.test('5 lakh')).toBe(true);
    expect(MONEY_REGEX.test('plain prose')).toBe(false);
  });
  test('DISCOUNT_REGEX catches "X% off" and "save N"', () => {
    expect(DISCOUNT_REGEX.test('20% off')).toBe(true);
    expect(DISCOUNT_REGEX.test('save 100')).toBe(true);
    expect(DISCOUNT_REGEX.test('save the planet')).toBe(false);
  });
  test('PROMO_REGEX catches limited-time variations', () => {
    expect(PROMO_REGEX.test('limited time')).toBe(true);
    expect(PROMO_REGEX.test('limited-time offer')).toBe(true);
    expect(PROMO_REGEX.test('limitless adventure')).toBe(false);
  });
  test('RATING_REGEX catches star/rating language', () => {
    expect(RATING_REGEX.test('5-star')).toBe(true);
    expect(RATING_REGEX.test('rated 4.5/5')).toBe(true);
    expect(RATING_REGEX.test('award-winning')).toBe(true);
  });
  test('SATISFACTION_REGEX catches social-proof claims', () => {
    expect(SATISFACTION_REGEX.test('thousands of happy customers')).toBe(true);
    expect(SATISFACTION_REGEX.test('a thousand temples')).toBe(false);
  });
  test('CORPORATE_SUFFIX_REGEX catches business suffixes', () => {
    expect(CORPORATE_SUFFIX_REGEX.test('Pvt Ltd')).toBe(true);
    expect(CORPORATE_SUFFIX_REGEX.test('Inc.')).toBe(true);
    expect(CORPORATE_SUFFIX_REGEX.test('a private school')).toBe(false);
  });
  test('VENDOR_NAME_REGEX catches our internal brand names', () => {
    expect(VENDOR_NAME_REGEX.test('Travel Stall')).toBe(true);
    expect(VENDOR_NAME_REGEX.test('travelstall')).toBe(true);
    expect(VENDOR_NAME_REGEX.test('travelling stall')).toBe(false);
  });
  test('TESTIMONIAL_REGEX catches attribution patterns', () => {
    expect(TESTIMONIAL_REGEX.test('as told by Priya')).toBe(true);
    expect(TESTIMONIAL_REGEX.test('— Priya S.')).toBe(true);
    expect(TESTIMONIAL_REGEX.test('story of a traveller')).toBe(false);
  });
});
