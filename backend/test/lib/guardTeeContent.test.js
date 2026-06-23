// PR-E Phase 2.4.0 — vitest coverage for guardTeeContent().
//
// What this exercises:
//   1. Pricing patterns — ban currency symbols + words + lakh/crore +
//      discount % phrasing (positive + negative cases)
//   2. Rating patterns — ban X/5, X-star, ★★★★★, "highest-rated"
//   3. Urgency patterns — ban "act now", "ends today", "only N left",
//      "limited time", "while stocks last"
//   4. URL allowlist — relative paths ok; only Unsplash/Pexels/Pixabay
//      hosts allowed for external; javascript:/data:/vbscript: blocked
//   5. Operator-only slot clearing — testimonials.items=[],
//      investment.tiers commercial fields=null, image URL fields="",
//      contact section email/phone scrubbed
//   6. Unknown top-level slot keys dropped
//   7. Required-slot validation per family (4 families)
//   8. Top-level payload shape guard (non-object → fallback)
//   9. Issue catalogue surfaces every transform for audit
//  10. Verdict — clean / scrubbed / fallback

import { describe, test, expect } from 'vitest';

const guard = require('../../lib/guardTeeContent');

describe('isPricingText', () => {
  test('catches currency symbols', () => {
    expect(guard.isPricingText('₹50,000 only')).toBe(true);
    expect(guard.isPricingText('Costs $499')).toBe(true);
    expect(guard.isPricingText('€2,800 per couple')).toBe(true);
    expect(guard.isPricingText('£199 deposit')).toBe(true);
    expect(guard.isPricingText('¥30,000')).toBe(true);
  });
  test('catches currency words', () => {
    expect(guard.isPricingText('Investment of USD 4500')).toBe(true);
    expect(guard.isPricingText('Pay INR via bank transfer')).toBe(true);
    expect(guard.isPricingText('AED 18000 total')).toBe(true);
  });
  test('catches lakh/crore + thousand phrasing', () => {
    expect(guard.isPricingText('Around 2 lakh per pilgrim')).toBe(true);
    expect(guard.isPricingText('Total 1 crore investment')).toBe(true);
    expect(guard.isPricingText('Save 5 thousand')).toBe(true);
  });
  test('catches discount + promo phrasing', () => {
    expect(guard.isPricingText('Get 20% off')).toBe(true);
    expect(guard.isPricingText('Save 30% off')).toBe(true);
    expect(guard.isPricingText('Save up to 5000')).toBe(true);
    expect(guard.isPricingText('Free trial available')).toBe(true);
    expect(guard.isPricingText('Promo code TRAVEL2026')).toBe(true);
    expect(guard.isPricingText('Cashback on every booking')).toBe(true);
    expect(guard.isPricingText('Discount available')).toBe(true);
  });
  test('clean text passes', () => {
    expect(guard.isPricingText('A structured cultural immersion')).toBe(false);
    expect(guard.isPricingText('Pilgrimage guided by scholar')).toBe(false);
    expect(guard.isPricingText('Reservation opens January')).toBe(false);
  });
  test('null / undefined / empty / non-string → false', () => {
    expect(guard.isPricingText(null)).toBe(false);
    expect(guard.isPricingText(undefined)).toBe(false);
    expect(guard.isPricingText('')).toBe(false);
    expect(guard.isPricingText(123)).toBe(false);
  });
});

describe('isRatingText', () => {
  test('catches X/5 and X-star ratings', () => {
    expect(guard.isRatingText('Rated 5/5 by parents')).toBe(true);
    expect(guard.isRatingText('4.8/5 across reviews')).toBe(true);
    expect(guard.isRatingText('5-star hotels throughout')).toBe(true);
    expect(guard.isRatingText('Three 4 star resorts')).toBe(true);
  });
  test('catches literal star symbols', () => {
    expect(guard.isRatingText('Hotel quality: ★★★★★')).toBe(true);
    expect(guard.isRatingText('4.5★ accommodations')).toBe(true);
  });
  test('catches "highest-rated" / "top-rated" language', () => {
    expect(guard.isRatingText('Highest-rated programme')).toBe(true);
    expect(guard.isRatingText('Award-winning operator')).toBe(true);
    expect(guard.isRatingText('Top rated experience')).toBe(true);
  });
  test('clean text passes', () => {
    expect(guard.isRatingText('Pre-vetted accommodations')).toBe(false);
    expect(guard.isRatingText('Comfortable hotels near Haram')).toBe(false);
  });
});

describe('isUrgencyText', () => {
  test('catches "act now", "hurry", "last chance"', () => {
    expect(guard.isUrgencyText('Act now to secure your seat')).toBe(true);
    expect(guard.isUrgencyText('Hurry, only a few left!')).toBe(true);
    expect(guard.isUrgencyText('Last chance to book')).toBe(true);
    expect(guard.isUrgencyText('Final call for couples')).toBe(true);
  });
  test('catches "limited time" / "exclusive offer" / "while stocks last"', () => {
    expect(guard.isUrgencyText('Limited time only')).toBe(true);
    expect(guard.isUrgencyText('Exclusive offer for early bookers')).toBe(true);
    expect(guard.isUrgencyText('Available while stocks last')).toBe(true);
  });
  test('catches "only N spots left" / "X seats remaining"', () => {
    expect(guard.isUrgencyText('Only 3 spots left available')).toBe(true);
    expect(guard.isUrgencyText('only 5 seats remaining available')).toBe(true);
  });
  test('catches "ends today" / "ends this week"', () => {
    expect(guard.isUrgencyText('Booking ends today')).toBe(true);
    expect(guard.isUrgencyText('Ends this week')).toBe(true);
    expect(guard.isUrgencyText('Ends tomorrow')).toBe(true);
  });
  test('catches "book now or miss out"', () => {
    expect(guard.isUrgencyText('Book now to secure your place')).toBe(true);
    expect(guard.isUrgencyText('Reserve today to lock the price')).toBe(true);
  });
  test('clean text passes', () => {
    expect(guard.isUrgencyText('Registration opens 1 February')).toBe(false);
    expect(guard.isUrgencyText('Bookings close 30 days before departure')).toBe(false);
  });
});

describe('isSafeUrl', () => {
  test('relative paths + fragment URLs are safe', () => {
    expect(guard.isSafeUrl('/p/japan-2026')).toBe(true);
    expect(guard.isSafeUrl('/uploads/landing-page-images/x.jpg')).toBe(true);
    expect(guard.isSafeUrl('#register')).toBe(true);
    expect(guard.isSafeUrl('')).toBe(true);
  });
  test('allowlisted image hosts pass', () => {
    expect(guard.isSafeUrl('https://images.unsplash.com/photo-x.jpg')).toBe(true);
    expect(guard.isSafeUrl('https://images.pexels.com/photos/x/y.jpg')).toBe(true);
    expect(guard.isSafeUrl('https://pixabay.com/photo-x.jpg')).toBe(true);
    expect(guard.isSafeUrl('https://cdn.pixabay.com/photo-x.jpg')).toBe(true);
  });
  test('dangerous schemes blocked', () => {
    expect(guard.isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(guard.isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(guard.isSafeUrl('vbscript:alert(1)')).toBe(false);
    expect(guard.isSafeUrl('file:///etc/passwd')).toBe(false);
  });
  test('arbitrary external hosts blocked', () => {
    expect(guard.isSafeUrl('https://malicious.example/payload.js')).toBe(false);
    expect(guard.isSafeUrl('https://some-cdn.net/image.jpg')).toBe(false);
    expect(guard.isSafeUrl('http://images.unsplash.com/x.jpg')).toBe(false); // http blocked
  });
  test('malformed URLs blocked', () => {
    expect(guard.isSafeUrl('not-a-url')).toBe(false);
    expect(guard.isSafeUrl('https://')).toBe(false);
  });
});

describe('stripBannedTextFields — recursive scrub', () => {
  test('scrubs pricing in nested copy slots', () => {
    const payload = {
      hero: { headline: 'Save 20% off the booking', lede: 'Clean lede' },
      cultural: { items: [{ name: 'Tokyo', body: ['costs ₹50,000 only'] }] },
    };
    const issues = [];
    guard.stripBannedTextFields(payload, issues);
    expect(payload.hero.headline).toBe('');
    expect(payload.hero.lede).toBe('Clean lede');
    expect(payload.cultural.items[0].body[0]).toBe('');
    expect(issues).toContain('pricing-text:hero.headline');
    expect(issues).toContain('pricing-text:cultural.items[0].body[0]');
  });

  test('scrubs ratings in nested fields', () => {
    const payload = {
      brand: { programmeTagline: 'Top-rated programme worldwide' },
      safety: { features: [{ title: '5-star vetted hotels' }] },
    };
    const issues = [];
    guard.stripBannedTextFields(payload, issues);
    expect(payload.brand.programmeTagline).toBe('');
    expect(payload.safety.features[0].title).toBe('');
    expect(issues.length).toBe(2);
  });

  test('scrubs urgency phrases in nested fields', () => {
    const payload = {
      hero: { kicker: 'Act now to secure your seat' },
      registration: { subtitle: 'Hurry, only 3 seats remaining available' },
    };
    const issues = [];
    guard.stripBannedTextFields(payload, issues);
    expect(payload.hero.kicker).toBe('');
    expect(payload.registration.subtitle).toBe('');
    expect(issues.length).toBe(2);
  });

  test('scrubs unsafe URLs in URL-shaped fields', () => {
    const payload = {
      hero: { posterUrl: 'javascript:alert(1)' },
      cultural: { items: [{ name: 'X', img: 'https://bad-host.example/x.jpg' }] },
      nav: { ctaHref: 'https://images.unsplash.com/photo-x.jpg' }, // safe
    };
    const issues = [];
    guard.stripBannedTextFields(payload, issues);
    expect(payload.hero.posterUrl).toBe('');
    expect(payload.cultural.items[0].img).toBe('');
    expect(payload.nav.ctaHref).toBe('https://images.unsplash.com/photo-x.jpg'); // unchanged
    expect(issues).toContain('unsafe-url:hero.posterUrl');
  });

  test('does NOT scrub plain text fields that happen to mention a URL substring', () => {
    const payload = { hero: { lede: 'A page like example.com is what we offer.' } };
    const issues = [];
    guard.stripBannedTextFields(payload, issues);
    expect(payload.hero.lede).toBe('A page like example.com is what we offer.'); // unchanged
  });

  test('null payload + non-object passed through gracefully', () => {
    expect(guard.stripBannedTextFields(null)).toBe(null);
    expect(guard.stripBannedTextFields('string')).toBe('string');
    expect(guard.stripBannedTextFields(123)).toBe(123);
  });
});

describe('forceClearOperatorOnlySlots', () => {
  test('empties testimonials.items if LLM tried to populate', () => {
    const payload = { testimonials: { items: [{ name: 'X', text: 'Y' }] } };
    const issues = [];
    guard.forceClearOperatorOnlySlots(payload, issues);
    expect(payload.testimonials.items).toEqual([]);
    expect(issues).toContain('testimonials-emptied');
  });

  test('nulls investment.tiers commercial fields', () => {
    const payload = {
      investment: {
        tiers: [
          { step: 1, title: 'Booking', subtitle: 'Reserve', amount: '50,000', tag: 'EARLY', date: 'Apr', vendor: 'X' },
          { step: 2, title: 'Balance', amount: '1,25,000' },
        ],
      },
    };
    const issues = [];
    guard.forceClearOperatorOnlySlots(payload, issues);
    expect(payload.investment.tiers[0].amount).toBeNull();
    expect(payload.investment.tiers[0].tag).toBeNull();
    expect(payload.investment.tiers[0].date).toBeNull();
    expect(payload.investment.tiers[0].vendor).toBeNull();
    expect(payload.investment.tiers[1].amount).toBeNull();
    // Structural fields preserved.
    expect(payload.investment.tiers[0].title).toBe('Booking');
    expect(payload.investment.tiers[0].subtitle).toBe('Reserve');
    expect(issues).toContain('investment-tier-amounts-nulled');
  });

  test('clears hero.posterUrl, brand.logoUrl, partnerLogos, marquee.cities[].img', () => {
    const payload = {
      hero: { posterUrl: 'https://leak.example/hero.jpg' },
      brand: { logoUrl: 'https://leak.example/logo.png', partnerLogos: [{ src: 'x.png', alt: 'X' }] },
      marquee: { cities: [{ title: 'Tokyo', img: 'https://leak.example/city.jpg' }] },
    };
    const issues = [];
    guard.forceClearOperatorOnlySlots(payload, issues);
    expect(payload.hero.posterUrl).toBe('');
    expect(payload.brand.logoUrl).toBe('');
    expect(payload.brand.partnerLogos).toEqual([]);
    expect(payload.marquee.cities[0].img).toBeNull();
  });

  test('scrubs email + phone leakage from contact.sections.lines', () => {
    const payload = {
      contact: {
        sections: [
          { label: 'EMAIL', lines: ['hello@example.com', 'general info'] },
          { label: 'PHONE', lines: ['+91 9876543210', 'office hours 9-5'] },
        ],
      },
    };
    const issues = [];
    guard.forceClearOperatorOnlySlots(payload, issues);
    expect(payload.contact.sections[0].lines).toEqual(['general info']);
    expect(payload.contact.sections[1].lines).toEqual(['office hours 9-5']);
    expect(issues).toContain('contact-sections-scrubbed');
  });
});

describe('dropUnknownTopLevelKeys', () => {
  test('removes hallucinated top-level slots', () => {
    const payload = {
      brand: { label: 'X' },
      hero: { headline: 'X' },
      // Hallucinated by the LLM:
      promotionalBanner: 'Save 50%',
      adminSettings: { secret: 'x' },
    };
    const issues = [];
    guard.dropUnknownTopLevelKeys(payload, issues);
    expect(payload.brand).toBeDefined();
    expect(payload.hero).toBeDefined();
    expect(payload.promotionalBanner).toBeUndefined();
    expect(payload.adminSettings).toBeUndefined();
    expect(issues).toContain('unknown-slot:promotionalBanner');
    expect(issues).toContain('unknown-slot:adminSettings');
  });
});

describe('checkRequiredSlots — per family', () => {
  function basePayload() {
    return {
      brand: { label: 'X', programmeName: 'Y' },
      hero: { headline: 'H', lede: 'L' },
      cultural: { items: [{ name: '1' }, { name: '2' }] },
      safety: { features: [{ title: 'a' }, { title: 'b' }] },
      programme: { leftHeadline: 'Why' },
      investment: { tiers: [{ step: 1 }, { step: 2 }] },
      faq: { items: [{ q: '1' }, { q: '2' }, { q: '3' }] },
      contact: { label: 'C' },
    };
  }
  test('educational happy path → no missing', () => {
    expect(guard.checkRequiredSlots(basePayload(), 'educational')).toEqual([]);
  });
  test('religious requires programme.leftHeadline', () => {
    const p = basePayload();
    delete p.programme;
    expect(guard.checkRequiredSlots(p, 'religious')).toContain('programme.leftHeadline');
  });
  test('luxury requires investment.tiers >= 2', () => {
    const p = basePayload();
    p.investment.tiers = [{ step: 1 }];
    expect(guard.checkRequiredSlots(p, 'luxury')).toContain('investment.tiers[length>=2]');
  });
  test('family requires cultural.items >= 2', () => {
    const p = basePayload();
    p.cultural.items = [];
    expect(guard.checkRequiredSlots(p, 'family')).toContain('cultural.items[length>=2]');
  });
  test('unknown family falls back to educational spec', () => {
    expect(guard.checkRequiredSlots(basePayload(), 'mystery')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Top-level guardTeeContent — integration / end-to-end behaviour
// ─────────────────────────────────────────────────────────────────────

describe('guardTeeContent — integration', () => {
  function fullCleanPayload() {
    return {
      brand: { label: 'JAPAN 2026', programmeName: 'Japan 2026', programmeTagline: 'A structured cultural immersion.' },
      hero: { headline: 'Japan 2026 — Heritage', lede: 'Tokyo and Kyoto.' },
      cultural: { items: [{ name: 'Tokyo', body: ['Modern velocity'] }, { name: 'Kyoto', body: ['Ancient ritual'] }] },
      safety: { features: [{ title: 'Vetted hosts' }, { title: 'Travel insurance' }] },
      faq: { items: [{ q: 'Q1?', a: 'A1' }, { q: 'Q2?', a: 'A2' }, { q: 'Q3?', a: 'A3' }] },
      contact: { label: 'JAPAN 2026' },
    };
  }

  test('clean payload → verdict=clean, no issues', () => {
    const r = guard.guardTeeContent(fullCleanPayload(), { family: 'educational' });
    expect(r.accepted).toBe(true);
    expect(r.verdict).toBe('clean');
    expect(r.issues).toEqual([]);
  });

  test('payload with pricing leakage in a non-critical slot → verdict=scrubbed', () => {
    // Use a NON-critical slot so the scrub doesn't trigger a missing-
    // required-slot fallback. brand.programmeTagline is optional.
    const p = fullCleanPayload();
    p.brand.programmeTagline = 'Only ₹50,000 per person, save 20% off';
    const r = guard.guardTeeContent(p, { family: 'educational' });
    expect(r.accepted).toBe(true);
    expect(r.verdict).toBe('scrubbed');
    expect(r.issues).toContain('pricing-text:brand.programmeTagline');
    expect(r.output.brand.programmeTagline).toBe('');
  });

  test('pricing leakage in a CRITICAL slot scrubs to empty AND triggers fallback', () => {
    const p = fullCleanPayload();
    p.hero.lede = 'Tokyo and Kyoto for ₹50,000';
    const r = guard.guardTeeContent(p, { family: 'educational' });
    // hero.lede is critical — scrubbed to '' → counts as missing.
    expect(r.accepted).toBe(false);
    expect(r.verdict).toBe('fallback');
    expect(r.issues).toContain('pricing-text:hero.lede');
    expect(r.issues).toContain('missing-required:hero.lede');
    expect(r.output.hero.lede).toBe('');
  });

  test('payload with banned URL → verdict=scrubbed', () => {
    const p = fullCleanPayload();
    p.hero.posterUrl = 'javascript:alert(1)';
    const r = guard.guardTeeContent(p, { family: 'educational' });
    expect(r.verdict).toBe('scrubbed');
    // The banned URL is caught by the URL allowlist (looksLikeUrlField +
    // isSafeUrl) in stripBannedTextFields BEFORE the operator-clear
    // phase runs. The issue id reflects that pathway.
    expect(r.issues.some((i) => i.startsWith('unsafe-url:hero.posterUrl'))).toBe(true);
    expect(r.output.hero.posterUrl).toBe('');
  });

  test('payload missing required slots → verdict=fallback', () => {
    const p = fullCleanPayload();
    p.cultural.items = []; // < 2
    const r = guard.guardTeeContent(p, { family: 'educational' });
    expect(r.accepted).toBe(false);
    expect(r.verdict).toBe('fallback');
    expect(r.issues).toContain('missing-required:cultural.items[length>=2]');
  });

  test('non-object input → verdict=fallback, output={}', () => {
    expect(guard.guardTeeContent(null).verdict).toBe('fallback');
    expect(guard.guardTeeContent('text').verdict).toBe('fallback');
    expect(guard.guardTeeContent([]).verdict).toBe('fallback');
  });

  test('hallucinated top-level slots dropped silently', () => {
    const p = fullCleanPayload();
    p.promotionalBanner = 'Save 50%';
    p.someOtherSlot = { x: 1 };
    const r = guard.guardTeeContent(p, { family: 'educational' });
    expect(r.output.promotionalBanner).toBeUndefined();
    expect(r.output.someOtherSlot).toBeUndefined();
    expect(r.issues).toContain('unknown-slot:promotionalBanner');
  });

  test('investment tier amount/tag/date/vendor force-nulled', () => {
    const p = fullCleanPayload();
    p.investment = { tiers: [
      { step: 1, title: 'A', subtitle: 'B', amount: '50,000', tag: 'X', date: 'Y', vendor: 'Z' },
      { step: 2, title: 'C', amount: '1,00,000' },
    ]};
    const r = guard.guardTeeContent(p, { family: 'educational' });
    expect(r.output.investment.tiers[0].amount).toBeNull();
    expect(r.output.investment.tiers[0].tag).toBeNull();
    expect(r.output.investment.tiers[0].date).toBeNull();
    expect(r.output.investment.tiers[0].vendor).toBeNull();
    expect(r.output.investment.tiers[1].amount).toBeNull();
  });

  test('testimonials always force-emptied', () => {
    const p = fullCleanPayload();
    p.testimonials = { items: [{ name: 'X', text: 'great!' }] };
    const r = guard.guardTeeContent(p, { family: 'educational' });
    expect(r.output.testimonials.items).toEqual([]);
  });

  test('issues array is a complete audit trail', () => {
    const p = fullCleanPayload();
    p.hero.headline = 'Save 30% off';
    p.hero.lede = 'Rated 5/5';
    p.testimonials = { items: [{ name: 'X' }] };
    p.unknown = 'x';
    const r = guard.guardTeeContent(p, { family: 'educational' });
    expect(r.issues.length).toBeGreaterThanOrEqual(4);
    expect(r.issues.some((i) => i.includes('pricing-text'))).toBe(true);
    expect(r.issues.some((i) => i.includes('rating-text'))).toBe(true);
    expect(r.issues.some((i) => i.includes('testimonials-emptied'))).toBe(true);
    expect(r.issues.some((i) => i.includes('unknown-slot'))).toBe(true);
  });

  test('luxury family validation — investment.tiers >= 2 enforced', () => {
    const p = fullCleanPayload();
    p.investment = { tiers: [{ step: 1, title: 'X' }] };
    const r = guard.guardTeeContent(p, { family: 'luxury' });
    expect(r.accepted).toBe(false);
    expect(r.issues).toContain('missing-required:investment.tiers[length>=2]');
  });

  test('religious family validation — programme.leftHeadline enforced', () => {
    const p = fullCleanPayload();
    // No programme block at all.
    const r = guard.guardTeeContent(p, { family: 'religious' });
    expect(r.accepted).toBe(false);
    expect(r.issues).toContain('missing-required:programme.leftHeadline');
  });
});
