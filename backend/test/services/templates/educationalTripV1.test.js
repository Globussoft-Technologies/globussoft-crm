// Phase D1 — vitest coverage for the template renderer system.
//
// What this exercises:
//   1. Registry: isTemplatePage / getTemplate / parseTemplateContent /
//      renderTemplate happy paths + edge cases.
//   2. Dispatch: landingPageRenderer.renderPage routes template pages
//      to the template renderer; block-based pages stay on the legacy
//      path; both produce HTML.
//   3. educationalTripV1.render: every editable slot lands in the
//      output when populated; missing/optional slots are silently
//      skipped (no crash, no rendered junk).
//   4. Defaults: empty content yields a tolerable page (no crash; the
//      DEFAULT_CONTENT "[REVIEW]" markers visible so reviewers see
//      placeholder state).
//   5. Security: HTML escape; safeUrl blocks javascript: schemes.
//   6. Stub templates (travel-premium-v1 / religious-tour-v1 /
//      luxury-tour-v1) delegate to educational-trip-v1 cleanly.

import { describe, test, expect, beforeEach } from 'vitest';

// CJS modules — vitest interop.
const landing = require('../../../services/landingPageRenderer');
const templates = require('../../../services/templates');
const educationalTripV1 = require('../../../services/templates/educationalTripV1');

beforeEach(() => {
  if (typeof educationalTripV1._resetCssCache === 'function') educationalTripV1._resetCssCache();
});

describe('templates registry', () => {
  test('TEMPLATE_IDS contains the 5 declared templates (4 family + travel-premium legacy)', () => {
    expect(templates.TEMPLATE_IDS).toContain('educational-trip-v1');
    expect(templates.TEMPLATE_IDS).toContain('travel-premium-v1');
    expect(templates.TEMPLATE_IDS).toContain('religious-tour-v1');
    expect(templates.TEMPLATE_IDS).toContain('family-trip-v1');
    expect(templates.TEMPLATE_IDS).toContain('luxury-tour-v1');
  });

  test('isTemplatePage: true for known ids, false for everything else', () => {
    expect(templates.isTemplatePage({ templateType: 'educational-trip-v1' })).toBe(true);
    expect(templates.isTemplatePage({ templateType: 'travel-premium-v1' })).toBe(true);
    expect(templates.isTemplatePage({ templateType: 'travel_destination' })).toBe(false);
    expect(templates.isTemplatePage({ templateType: 'lead_capture' })).toBe(false);
    expect(templates.isTemplatePage({ templateType: '' })).toBe(false);
    expect(templates.isTemplatePage({})).toBe(false);
    expect(templates.isTemplatePage(null)).toBe(false);
    expect(templates.isTemplatePage(undefined)).toBe(false);
  });

  test('getTemplate returns module for known ids; null for unknown', () => {
    expect(templates.getTemplate('educational-trip-v1')).toBeTruthy();
    expect(templates.getTemplate('educational-trip-v1').id).toBe('educational-trip-v1');
    expect(templates.getTemplate('unknown')).toBeNull();
    expect(templates.getTemplate(null)).toBeNull();
    expect(templates.getTemplate(undefined)).toBeNull();
  });

  test('parseTemplateContent handles string / object / null / invalid JSON', () => {
    expect(templates.parseTemplateContent({ content: '{"hero":{"headline":"H"}}' })).toEqual({ hero: { headline: 'H' } });
    expect(templates.parseTemplateContent({ content: { hero: { headline: 'H' } } })).toEqual({ hero: { headline: 'H' } });
    expect(templates.parseTemplateContent({ content: null })).toEqual({});
    expect(templates.parseTemplateContent({ content: '' })).toEqual({});
    expect(templates.parseTemplateContent({ content: 'not json' })).toEqual({});
    // Arrays are not treated as object payloads — old block-array content
    // returns empty {} so the renderer falls through to its defaults
    // rather than rendering garbage.
    expect(templates.parseTemplateContent({ content: '[]' })).toEqual({});
    expect(templates.parseTemplateContent(null)).toEqual({});
  });

  test('CATALOGUE surfaces operator-facing entries with status flags', () => {
    expect(Array.isArray(templates.CATALOGUE)).toBe(true);
    const ids = templates.CATALOGUE.map((e) => e.id);
    expect(ids).toContain('educational-trip-v1');
    const edu = templates.CATALOGUE.find((e) => e.id === 'educational-trip-v1');
    expect(edu.status).toBe('ready');
    // PR-E Phase 1: all four family templates are 'ready'.
    expect(templates.CATALOGUE.find((e) => e.id === 'religious-tour-v1').status).toBe('ready');
    expect(templates.CATALOGUE.find((e) => e.id === 'family-trip-v1').status).toBe('ready');
    expect(templates.CATALOGUE.find((e) => e.id === 'luxury-tour-v1').status).toBe('ready');
    // travel-premium-v1 is now a backwards-compat shell — flagged 'legacy'.
    const tp = templates.CATALOGUE.find((e) => e.id === 'travel-premium-v1');
    expect(tp.status).toBe('legacy');
    // Catalogue rows carry family + themeId so the builder UI can render
    // them grouped by family and indicate the default theme variant.
    expect(edu.family).toBe('educational');
    // PR-E Option B: family-generic style-bucket id (legacy
    // `educational-japan` aliases to this for backwards compat).
    expect(edu.themeId).toBe('educational-academic');
  });

  test('renderTemplate throws on unknown templateType', () => {
    expect(() => templates.renderTemplate({ templateType: 'unknown' })).toThrow(/unknown templateType/);
  });
});

describe('landingPageRenderer dispatch', () => {
  test('routes templateType=educational-trip-v1 to the template renderer', () => {
    const html = landing.renderPage({
      templateType: 'educational-trip-v1',
      slug: 'test',
      title: 'Test',
      content: JSON.stringify({ hero: { headline: 'My Trip' } }),
    });
    expect(html).toContain('<div class="trips-page">');
    expect(html).toContain('My Trip');
    // The template loads its own CSS file — token `.trips-page` lives
    // inside the inline <style>.
    expect(html).toContain('.trips-page');
  });

  test('block-array pages still use the legacy path', () => {
    const html = landing.renderPage({
      templateType: 'lead_capture',
      slug: 'lead-x',
      title: 'Lead Capture',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    expect(html).toContain('<div class="lp-container">');
    expect(html).not.toContain('<div class="trips-page">');
    expect(html).toContain('Hi');
  });

  test('object-shaped content with templateType=travel_destination falls through (legacy gate)', () => {
    // Defensive — a misconfigured page (string templateType, object content)
    // should not crash. The block-based render path returns an HTML page
    // even when content can't be coerced to an array (it yields []).
    const html = landing.renderPage({
      templateType: 'travel_destination',
      slug: 'oops',
      title: 'Oops',
      content: JSON.stringify({ hero: { headline: 'x' } }),
    });
    expect(html).toContain('<html'); // produced some HTML, didn't throw
  });
});

describe('educational-trip-v1 — slot rendering', () => {
  function render(payload) {
    return landing.renderPage({
      templateType: 'educational-trip-v1',
      slug: 'demo',
      title: 'Demo Trip',
      content: JSON.stringify(payload || {}),
    });
  }

  test('empty content renders the default placeholder shell without crashing', () => {
    const html = render({});
    expect(html).toContain('<html');
    expect(html).toContain('<div class="trips-page">');
    expect(html).toContain('[REVIEW]');
  });

  test('hero slot — headline, lede, partner logos, eyebrow, kicker, countdown', () => {
    const html = render({
      brand: {
        label: 'BALI 2026',
        kanji: '島',
        partnerLogos: [{ src: '/logo-a.png', alt: 'Studio A' }],
      },
      hero: {
        headline: 'Bali — Slow, Saline, Sacred.',
        lede: 'Ten days for two travellers — temples, terraces, tide pools.',
        kicker: '10 Days. 3 Cities.',
        eyebrow: { date: 'APR-MAY 2026', audience: 'COUPLES', batchPill: 'Limited to 8 guests' },
        posterUrl: '/bali_hero.jpg',
        countdown: {
          label: 'EARLY-BIRD CLOSES IN',
          deadlineIso: '2026-12-31T23:59:59+05:30',
          ctaText: 'Reserve',
          ctaHref: '#register',
        },
        benefitCards: [
          { icon: '◈', title: 'Slow', desc: 'Lower mileage' },
          { icon: '⊕', title: 'Sacred', desc: 'Temple immersion' },
        ],
      },
    });
    expect(html).toContain('Bali — Slow, Saline, Sacred.');
    expect(html).toContain('Ten days for two travellers');
    expect(html).toContain('10 Days. 3 Cities.');
    expect(html).toContain('APR-MAY 2026');
    expect(html).toContain('Limited to 8 guests');
    expect(html).toContain('/bali_hero.jpg');
    expect(html).toContain('EARLY-BIRD CLOSES IN');
    expect(html).toContain('t-countdown');
    expect(html).toContain('id="t-countdown"');
    expect(html).toContain('/logo-a.png');
    expect(html).toContain('class="t-card">');
    expect(html).toContain('Lower mileage');
  });

  test('marquee slot — cities duplicated for infinite-loop animation', () => {
    const html = render({
      marquee: {
        cities: [
          { tag: 'TEMPLE', title: 'Ubud', img: 'https://example.test/ubud.jpg' },
          { tag: 'COAST', title: 'Uluwatu', img: 'https://example.test/uluwatu.jpg' },
        ],
      },
    });
    expect(html).toContain('t-photo-strip-track');
    // 2 unique cards × 2 (duplicated for the loop) = 4 occurrences of "Ubud" / "Uluwatu"
    const ubudCount = (html.match(/Ubud/g) || []).length;
    const uluCount = (html.match(/Uluwatu/g) || []).length;
    expect(ubudCount).toBeGreaterThanOrEqual(2);
    expect(uluCount).toBeGreaterThanOrEqual(2);
  });

  test('cultural slot — flip-card with body paragraphs + benefit pull quote', () => {
    const html = render({
      cultural: {
        show: true,
        title: 'Cultural Highlights',
        items: [
          {
            id: 'ubud',
            name: 'Ubud',
            label: 'RICEFIELDS',
            icon: 'tokyo', // Reuse a known SVG glyph
            body: ['Slow walks past rice terraces.', 'Temple-side coffee at dawn.'],
            benefit: 'Patience as a practice.',
          },
        ],
      },
    });
    expect(html).toContain('t-ch-card');
    expect(html).toContain('RICEFIELDS');
    expect(html).toContain('Slow walks past rice terraces.');
    expect(html).toContain('Patience as a practice.');
    expect(html).toContain('DERIVED BENEFIT');
    // SVG glyph from the icon library
    expect(html).toContain('<svg');
  });

  test('safety slot — dark section with features + included items + banner', () => {
    const html = render({
      safety: {
        show: true,
        title: 'Engineered for Safety.',
        features: [
          { icon: 'shield', title: '1:6 host ratio', desc: 'Trained local guides at every stop.' },
          { icon: 'briefcase', title: '4-star stays', desc: 'Pre-vetted properties.' },
        ],
        included: {
          title: "What's Included",
          items: ['Return flights', 'All meals', 'Travel insurance'],
        },
        banner: {
          title: 'Your safety, end-to-end.',
          body: 'Every detail covered.',
          ctaText: 'Reserve',
          ctaHref: '#register',
        },
        quote: 'Independence within structure.',
      },
    });
    expect(html).toContain('Engineered for Safety.');
    expect(html).toContain('1:6 host ratio');
    expect(html).toContain('What&#39;s Included');
    expect(html).toContain('Return flights');
    expect(html).toContain('Your safety, end-to-end.');
    expect(html).toContain('Independence within structure.');
  });

  test('investment slot — tiers + indicative inclusions + start-here badge', () => {
    const html = render({
      investment: {
        show: true,
        title: 'Investment',
        currency: '₹',
        tiers: [
          { step: 1, title: 'Booking', subtitle: 'Deposit', amount: '50,000', tag: 'Non-refundable', date: 'Apr 30', startHere: true },
          { step: 2, title: 'Mid', subtitle: 'Pre-departure', amount: '1,00,000' },
        ],
        inclusions: { label: 'INDICATIVE INCLUSIONS', items: ['Flights', 'Hotels', 'Visa'] },
      },
    });
    expect(html).toContain('START HERE');
    expect(html).toContain('₹50,000');
    expect(html).toContain('Non-refundable');
    expect(html).toContain('INDICATIVE INCLUSIONS');
    expect(html).toContain('Flights');
  });

  test('investment tiers with null amount render Pricing TBD placeholder', () => {
    const html = render({
      investment: {
        show: true,
        tiers: [{ step: 1, title: 'Booking', amount: null }],
      },
    });
    expect(html).toContain('t-tier-amount--empty');
  });

  test('faq slot — categories + items with searchable data attributes', () => {
    const html = render({
      faq: {
        show: true,
        title: 'FAQ',
        categories: [
          { id: 'all', label: 'ALL', icon: '📋' },
          { id: 'tour', label: 'TOUR', icon: '📍' },
        ],
        items: [
          { cat: 'tour', q: 'Question one?', a: 'Answer one.' },
          { cat: 'tour', q: 'Question two?', a: 'Answer two.' },
        ],
      },
    });
    expect(html).toContain('t-faq-item');
    expect(html).toContain('Question one?');
    expect(html).toContain('Answer one.');
    expect(html).toContain('t-faq-tab');
    expect(html).toContain('data-cat="tour"');
    // Data-text holds lowercased searchable content
    expect(html).toContain('question one?');
  });

  test('registration slot — 2-step funnel with progress bars, optional school select', () => {
    const html = render({
      registration: {
        show: true,
        title: 'Register',
        submitText: 'Confirm',
        schoolOptions: ['School A', 'School B'],
        tenantSlug: 'travel-stall',
        leadSubBrand: 'tmc',
      },
    });
    expect(html).toContain('id="t-reg-form"');
    expect(html).toContain('data-tenant-slug="travel-stall"');
    expect(html).toContain('data-sub-brand="tmc"');
    expect(html).toContain('data-step="1"');
    expect(html).toContain('data-step="2"');
    expect(html).toContain('<option value="School A">School A</option>');
    expect(html).toContain('Confirm');
  });

  test('brochure slot — info cards + lead-capture form', () => {
    const html = render({
      brochure: {
        show: true,
        infoCards: [
          { title: 'ITINERARY', desc: 'See the day-by-day.' },
        ],
        headTitle: 'Download the brochure.',
        ctaText: 'GET IT NOW',
        tenantSlug: 'travel-stall',
      },
    });
    expect(html).toContain('Download the brochure.');
    expect(html).toContain('GET IT NOW');
    expect(html).toContain('ITINERARY');
    expect(html).toContain('id="t-broch-form"');
  });

  test('contact / footer slot', () => {
    const html = render({
      contact: {
        show: true,
        label: 'BALI 2026',
        tagline: 'Slow, Saline, Sacred.',
        logoUrl: '/footer-logo.png',
        sections: [
          { label: 'EMAIL', lines: ['hello@example.com'] },
          { label: 'PHONE', lines: ['+91 1234'] },
        ],
        copyright: '© 2026 Studio',
      },
    });
    expect(html).toContain('Slow, Saline, Sacred.');
    expect(html).toContain('hello@example.com');
    expect(html).toContain('+91 1234');
    expect(html).toContain('© 2026 Studio');
    expect(html).toContain('/footer-logo.png');
  });

  test('floating CTA renders when content.floatingCta.show is true', () => {
    const html = render({ floatingCta: { show: true, text: 'BOOK NOW', href: '#register' } });
    expect(html).toContain('t-float-register');
    expect(html).toContain('BOOK NOW');
  });

  test('details strip renders steps + tagline', () => {
    const html = render({
      details: {
        show: true,
        title: 'How It Works',
        leftPill: '10 DAYS',
        taglineRight: 'One curated trip.',
        steps: [
          { num: 1, label: 'Apply' },
          { num: 2, label: 'Pay' },
          { num: 3, label: 'Pack' },
        ],
        ctaText: 'APPLY NOW',
      },
    });
    expect(html).toContain('How It Works');
    expect(html).toContain('10 DAYS');
    expect(html).toContain('Apply');
    expect(html).toContain('Pay');
    expect(html).toContain('Pack');
    expect(html).toContain('APPLY NOW');
  });

  test('inline scripts always present (countdown + FAQ + registration)', () => {
    const html = render({});
    expect(html).toContain('<script>');
    expect(html).toContain('t-faq-list');
    expect(html).toContain('t-reg-form');
  });

  // ───────────────────────────────────────────────────────────────
  // PR-E Phase 1.6 — new renderer branches
  // ───────────────────────────────────────────────────────────────

  test('safety.stats[] renders stat tiles BEFORE feature cards (Phase 1.6)', () => {
    const html = render({
      safety: {
        show: true,
        title: 'Engineered for Safety.',
        stats: [
          { stat: '1:6', title: 'Host Ratio', body: 'One trained guide per six students.' },
          { stat: '4★', title: 'Vetted Stays', body: 'Inspected accommodations.' },
          { stat: '24/7', title: 'On-Call Desk', body: 'India-based support line.' },
        ],
        features: [
          { icon: 'shield', title: 'Insurance', desc: 'Comprehensive cover.' },
        ],
      },
    });
    expect(html).toContain('t-safety-stats');
    expect(html).toContain('t-sstat');
    expect(html).toContain('t-sstat-num');
    expect(html).toContain('1:6');
    expect(html).toContain('Host Ratio');
    expect(html).toContain('One trained guide per six students.');
    // Feature cards still render alongside.
    expect(html).toContain('t-sfeat');
    expect(html).toContain('Insurance');
  });

  test('empty safety.stats[] = back-compat (no stat tiles, feature cards only)', () => {
    const html = render({
      safety: {
        show: true,
        features: [{ icon: 'shield', title: 'Insurance', desc: 'Cover.' }],
      },
    });
    // Use the body-level wrapper class — the polish CSS file declares
    // .t-safety-stats and .t-sstat as selectors, so substring checks
    // would false-positive on the inlined <style> block. Check for the
    // actual element being absent in the rendered body.
    expect(html).not.toContain('<div class="t-safety-stats">');
    expect(html).not.toContain('class="t-sstat"');
    expect(html).toContain('class="t-sfeat"');
  });

  test('hero caption overlay lives INSIDE the t-poster frame (Phase 1.6)', () => {
    const html = render({
      hero: {
        headline: 'Test',
        visualTitle: 'Japan 2026 Programme',
        visualSub: 'A structured nine-day immersion.',
        posterUrl: '/hero.jpg',
      },
    });
    expect(html).toContain('class="t-hero-caption"');
    expect(html).toContain('class="t-caption-title"');
    expect(html).toContain('class="t-caption-sub"');
    expect(html).toContain('Japan 2026 Programme');
    expect(html).toContain('A structured nine-day immersion.');
    // Sanity — the caption ELEMENT (not CSS selector) comes AFTER the
    // hero img in source order so it overlays it. Compare element
    // markers, not bare class names (which appear in the polish CSS).
    const imgIdx = html.indexOf('<img src="/hero.jpg"');
    const capIdx = html.indexOf('<div class="t-hero-caption">');
    expect(imgIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(imgIdx);
  });

  test('registration.covers[] renders the side-by-side covers panel (Phase 1.6)', () => {
    const html = render({
      registration: {
        show: true,
        title: 'Register',
        coversTitle: 'What you receive',
        coversIntro: 'Within 24 hours.',
        covers: [
          { title: 'Full Itinerary', body: 'Day-by-day plan.' },
          { title: 'Safety Model', body: 'Supervision details.' },
          { title: 'Cost Sheet', body: 'Transparent breakdown.' },
          { title: 'Direct Q&A', body: 'Scheduled call.' },
        ],
      },
    });
    expect(html).toContain('t-register-grid');
    expect(html).toContain('t-register-covers');
    expect(html).toContain('t-cover-card');
    expect(html).toContain('What you receive');
    expect(html).toContain('Full Itinerary');
    expect(html).toContain('Direct Q&amp;A'); // HTML-escaped
  });

  test('empty registration.covers[] = back-compat (narrow single-column layout)', () => {
    const html = render({
      registration: { show: true, title: 'Register' },
    });
    expect(html).not.toContain('<div class="t-wrap t-register-grid">');
    expect(html).not.toContain('<div class="t-cover-card">');
    expect(html).toContain('<div class="t-wrap t-narrow">');
  });

  test('investment.featuredIndex marks the indexed tier as featured (Phase 1.6)', () => {
    const html = render({
      investment: {
        show: true,
        title: 'Investment',
        featuredIndex: 1,
        featuredBadge: 'RECOMMENDED',
        tiers: [
          { step: 1, title: 'Booking', amount: '50,000' },
          { step: 2, title: 'Mid-payment', amount: '1,00,000' },
          { step: 3, title: 'Balance', amount: '1,00,000' },
        ],
      },
    });
    expect(html).toContain('class="t-tier t-tier-start t-tier-featured"');
    expect(html).toContain('<span class="t-tier-badge">RECOMMENDED</span>');
    // Scope to BODY (after the inlined <style> blocks) so the CSS
    // selectors don't pollute the count.
    const bodyIdx = html.lastIndexOf('</style>');
    const body = html.slice(bodyIdx);
    // Exactly ONE featured tier should render (the one at featuredIndex=1).
    const featuredMatches = body.match(/class="t-tier t-tier-start t-tier-featured"/g) || [];
    expect(featuredMatches.length).toBe(1);
    // Exactly ONE badge should render (only on the featured tier).
    const badgeMatches = body.match(/<span class="t-tier-badge">RECOMMENDED<\/span>/g) || [];
    expect(badgeMatches.length).toBe(1);
    // And the non-featured tiers render with the bare class.
    const plainMatches = body.match(/<div class="t-tier">/g) || [];
    expect(plainMatches.length).toBe(2); // tiers at index 0 and 2
  });

  test('per-tier startHere=true OR featured=true also marks featured (Phase 1.6 back-compat)', () => {
    const html = render({
      investment: {
        show: true,
        tiers: [{ step: 1, title: 'Reservation', startHere: true, amount: '50,000' }],
      },
    });
    expect(html).toContain('t-tier-start');
    expect(html).toContain('t-tier-featured');
  });

  test('per-tier badge text wins over inv.featuredBadge default (Phase 1.6)', () => {
    const html = render({
      investment: {
        show: true,
        featuredBadge: 'RECOMMENDED',
        tiers: [{ step: 1, startHere: true, title: 'Reservation', badge: 'BEST VALUE', amount: '50,000' }],
      },
    });
    expect(html).toContain('BEST VALUE');
    expect(html).not.toContain('RECOMMENDED');
  });
});

describe('educational-trip-v1 — security', () => {
  function render(payload) {
    return landing.renderPage({
      templateType: 'educational-trip-v1',
      slug: 'sec',
      title: 'Sec',
      content: JSON.stringify(payload),
    });
  }

  test('HTML in user-supplied strings is escaped', () => {
    const html = render({ hero: { headline: '<script>alert(1)</script>' } });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('javascript: scheme blocked in posterUrl', () => {
    const html = render({ hero: { posterUrl: 'javascript:alert(1)', headline: 'h' } });
    expect(html).not.toContain('javascript:alert(1)');
  });

  test('javascript: scheme blocked in cta href', () => {
    const html = render({
      hero: { headline: 'h', countdown: { deadlineIso: '2026-01-01', ctaText: 'go', ctaHref: 'javascript:alert(1)' } },
    });
    expect(html).not.toContain('javascript:alert(1)');
  });

  test('javascript: scheme blocked in nav link href', () => {
    const html = render({ nav: { links: [{ label: 'X', href: 'javascript:alert(1)' }] } });
    expect(html).not.toContain('javascript:alert(1)');
  });

  test('iframe-src restricted to http/https in preview video', () => {
    const html = render({
      preview: {
        show: true,
        videoEmbedUrl: 'javascript:alert(1)',
        title: 'P',
      },
    });
    expect(html).not.toContain('javascript:alert(1)');
  });
});

describe('educational-trip-v1 — mergeContent', () => {
  test('overrides take precedence; missing keys fall back to defaults', () => {
    const merged = educationalTripV1._mergeContent(
      educationalTripV1.defaultContent,
      { hero: { headline: 'Custom' } }
    );
    expect(merged.hero.headline).toBe('Custom');
    // Default countdown ctaText preserved when not overridden.
    expect(merged.hero.countdown.ctaText).toBeTruthy();
    // Default safety section preserved when not in override.
    expect(merged.safety).toBeTruthy();
  });

  test('arrays in overrides REPLACE (do not concat) defaults', () => {
    const merged = educationalTripV1._mergeContent(
      educationalTripV1.defaultContent,
      { hero: { benefitCards: [{ icon: '◇', title: 'one', desc: 'only one' }] } }
    );
    expect(merged.hero.benefitCards).toHaveLength(1);
    expect(merged.hero.benefitCards[0].title).toBe('one');
  });

  test('null override falls back to default', () => {
    const merged = educationalTripV1._mergeContent(educationalTripV1.defaultContent, null);
    expect(merged.hero.headline).toBeTruthy(); // default placeholder
  });
});

describe('sibling templates share the universal shell', () => {
  test('travel-premium-v1 (legacy) renders the same trips-page wrapper', () => {
    const eduHtml = landing.renderPage({
      templateType: 'educational-trip-v1',
      slug: 'a',
      title: 'A',
      content: JSON.stringify({ hero: { headline: 'X' } }),
    });
    const tpHtml = landing.renderPage({
      templateType: 'travel-premium-v1',
      slug: 'a',
      title: 'A',
      content: JSON.stringify({ hero: { headline: 'X' } }),
    });
    expect(eduHtml).toContain('<div class="trips-page">');
    expect(tpHtml).toContain('<div class="trips-page">');
    expect(tpHtml).toContain('X');
  });

  test('religious-tour-v1, family-trip-v1, luxury-tour-v1 all render without throwing', () => {
    const a = landing.renderPage({
      templateType: 'religious-tour-v1', slug: 's1', title: 'S', content: '{}',
    });
    const b = landing.renderPage({
      templateType: 'family-trip-v1', slug: 's2', title: 'F', content: '{}',
    });
    const c = landing.renderPage({
      templateType: 'luxury-tour-v1', slug: 's3', title: 'L', content: '{}',
    });
    expect(a).toContain('<div class="trips-page">');
    expect(b).toContain('<div class="trips-page">');
    expect(c).toContain('<div class="trips-page">');
  });
});

// ── Phase D1 bridge: LLM block-array → semantic content payload ─────

describe('educationalTripV1.mapBlocksToContent — AI bridge', () => {
  const { mapBlocksToContent } = educationalTripV1;

  // Canonical 9-block array that mirrors what the existing LLM
  // (services/landingPagePrompts.js) is prompted to emit.
  function llmBlocksFor(destination = 'Bali', days = 7) {
    return [
      { type: 'destinationHero', props: {
        destination, headline: `${destination} — A Journey of Discovery`, subhead: `${days} days across temples, terraces, tide pools.`, ctaText: 'Reserve Your Spot', posterUrl: null,
      } },
      { type: 'highlightsGrid', props: {
        items: [
          { icon: '◈', title: 'Slow travel', body: 'Lower mileage, deeper presence.' },
          { icon: '⊕', title: 'Cultural depth', body: 'Temple visits, daily-life immersion.' },
          { icon: '⌂', title: 'Safe framework', body: 'Pre-vetted hosts at every stop.' },
          { icon: '❖', title: 'Curated meals', body: 'Local cuisine, dietary needs honoured.' },
        ],
      } },
      { type: 'cityCards', props: {
        title: 'Where You Go', subtitle: 'Three regions, one rhythm.',
        cards: [
          { tag: 'TEMPLES', title: 'Ubud', body: 'Slow walks past rice terraces and temple-side coffee at dawn.', benefit: 'Patience as a practice.', img: null },
          { tag: 'COAST', title: 'Uluwatu', body: 'Cliff temples and surf-side dinners.', benefit: 'Awe at scale.', img: null },
          { tag: 'CULTURE', title: 'Denpasar', body: 'Markets and museums showcasing the modern arts scene.', benefit: 'Past meets present.', img: null },
        ],
      } },
      { type: 'safetyFeatures', props: {
        items: [
          { icon: 'shield', title: 'Pre-vetted hosts', body: 'Each lodge inspected.' },
          { icon: 'briefcase', title: 'Insurance included', body: '24/7 medical evac cover.' },
          { icon: 'send', title: '24/7 hotline', body: 'India-based emergency desk.' },
          { icon: 'package', title: 'Curated transport', body: 'Private chartered vehicles.' },
        ],
      } },
      { type: 'inclusionsGrid', props: {
        items: ['Flights', 'Hotels', 'Visa processing', 'All meals', 'Travel insurance', 'Local transport', 'Guides', 'Activities'],
      } },
      { type: 'itineraryTimeline', props: {
        days: [
          { day: 1, title: 'Arrival', bullets: ['Airport pickup', 'Welcome briefing'] },
          { day: 2, title: 'Ubud', bullets: ['Temple walk', 'Coffee tasting'] },
          { day: 3, title: 'Uluwatu', bullets: ['Cliff visit', 'Sunset dinner'] },
        ],
      } },
      { type: 'tierPricing', props: {
        title: 'Investment', subtitle: '', currency: '₹',
        tiers: [
          { step: 1, label: 'Booking', subtitle: 'Deposit', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
          { step: 2, label: 'Mid-term', subtitle: 'Pre-departure', amount: null, dueDate: null, vendor: null, tag: null, badge: null },
        ],
      } },
      { type: 'faqAccordion', props: {
        title: 'FAQs', subtitle: 'Common questions.',
        categories: [
          { id: 'all', label: 'All', icon: '◇' },
          { id: 'tour', label: 'Tour', icon: '◈' },
        ],
        faqs: [
          { cat: 'tour', q: 'How are meals arranged?', a: 'All meals included.' },
          { cat: 'tour', q: 'Is travel insurance included?', a: 'Yes, comprehensive cover.' },
        ],
      } },
      { type: 'contactFooter', props: { brandName: null, phone: null, email: null, ctaText: 'Reserve', ctaUrl: null } },
    ];
  }

  test('produces a complete content payload with the expected slot keys', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    // Every slot the template editor's structured forms cover must be present.
    expect(content).toHaveProperty('brand');
    expect(content).toHaveProperty('nav');
    expect(content).toHaveProperty('hero');
    expect(content).toHaveProperty('marquee');
    expect(content).toHaveProperty('programme');
    expect(content).toHaveProperty('cultural');
    expect(content).toHaveProperty('safety');
    expect(content).toHaveProperty('investment');
    expect(content).toHaveProperty('registration');
    expect(content).toHaveProperty('faq');
    expect(content).toHaveProperty('contact');
    expect(content).toHaveProperty('floatingCta');
  });

  test('hero gets headline + lede from destinationHero, benefitCards from highlightsGrid', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.hero.headline).toBe('Bali — A Journey of Discovery');
    expect(content.hero.lede).toBe('7 days across temples, terraces, tide pools.');
    expect(content.hero.benefitCards).toHaveLength(4);
    expect(content.hero.benefitCards[0]).toEqual({ icon: '◈', title: 'Slow travel', desc: 'Lower mileage, deeper presence.' });
    // Audience flows into the eyebrow.
    expect(content.hero.eyebrow.audience).toBe('COUPLES');
    // Days + city count flow into the kicker.
    expect(content.hero.kicker).toBe('7 Days. 3 Cities.');
  });

  test('cultural slot (flip cards) gets content DIRECTLY from cityCards — AI fills body + benefit', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.cultural.show).toBe(true);
    expect(content.cultural.items).toHaveLength(3);
    const ubud = content.cultural.items[0];
    expect(ubud.name).toBe('Ubud');
    expect(ubud.label).toBe('TEMPLES');
    // Flip-card BACK body — AI-generated paragraphs map straight onto
    // the body[] array the template flip card renders.
    expect(ubud.body).toEqual(['Slow walks past rice terraces and temple-side coffee at dawn.']);
    // Flip-card "Derived Benefit" pull quote — AI-generated.
    expect(ubud.benefit).toBe('Patience as a practice.');
    // Stable id derived from the city title.
    expect(ubud.id).toBe('ubud');
  });

  test('marquee.cities mirror cityCards but with images null (operator uploads)', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.marquee.cities).toHaveLength(3);
    expect(content.marquee.cities[0]).toEqual({ tag: 'TEMPLES', title: 'Ubud', img: null });
  });

  test('safety.features map from safetyFeatures with icon-id allowlist', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.safety.features).toHaveLength(4);
    expect(content.safety.features[0]).toEqual({ icon: 'shield', title: 'Pre-vetted hosts', desc: 'Each lodge inspected.' });
    // safety.included.items pulled from inclusionsGrid.
    expect(content.safety.included.items).toContain('Flights');
    expect(content.safety.included.items).toContain('Hotels');
  });

  test('investment.tiers preserve labels but ALL commercial fields stay null', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.investment.tiers).toHaveLength(2);
    const t0 = content.investment.tiers[0];
    expect(t0.title).toBe('Booking');
    expect(t0.subtitle).toBe('Deposit');
    expect(t0.step).toBe(1);
    expect(t0.startHere).toBe(true); // first tier
    // Operator-only fields stay null — publish gate catches these.
    expect(t0.amount).toBeNull();
    expect(t0.tag).toBeNull();
    expect(t0.date).toBeNull();
    expect(t0.vendor).toBeNull();
    // Indicative inclusions pulled from inclusionsGrid (capped at 6).
    expect(content.investment.inclusions.items.length).toBeLessThanOrEqual(6);
    expect(content.investment.inclusions.items).toContain('Flights');
  });

  test('faq.categories + faq.items pass through unchanged', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.faq.categories).toHaveLength(2);
    expect(content.faq.items).toHaveLength(2);
    expect(content.faq.items[0].q).toBe('How are meals arranged?');
    expect(content.faq.items[0].a).toBe('All meals included.');
  });

  test('contact slot stays null/shell — operator fills phone/email', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.contact.show).toBe(true);
    expect(content.contact.label).toBe('BALI');
    expect(content.contact.sections).toEqual([]); // operator fills
    expect(content.contact.logoUrl).toBe('');
  });

  test('programme.leftParagraphs derived from hero subhead + itinerary days', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.programme.show).toBe(true);
    expect(content.programme.leftParagraphs.length).toBeGreaterThan(0);
    expect(content.programme.leftParagraphs.length).toBeLessThanOrEqual(3);
    expect(content.programme.leftParagraphs[0]).toContain('temples, terraces');
    // rightChecks pulled from highlights titles.
    expect(content.programme.rightChecks).toContain('Slow travel');
  });

  test('registration.leadSubBrand + leadSource flow from input.subBrand', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples', subBrand: 'travelstall' });
    expect(content.registration.leadSubBrand).toBe('travelstall');
    expect(content.registration.leadSource).toBe('landing_page_travelstall');
  });

  test('brand.programmeTagline is filled from hero.subhead (first sentence, ≤60 chars)', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), {
      destination: 'Bali', durationDays: 7, audience: 'Couples',
    });
    // hero.subhead = "7 days across temples, terraces, tide pools."
    expect(content.brand.programmeTagline).toBeTruthy();
    expect(content.brand.programmeTagline.length).toBeLessThanOrEqual(60);
    expect(content.brand.programmeTagline).toContain('temples');
  });

  test('brand.programmeTagline falls back to metaDescription when hero subhead empty', () => {
    const blocks = llmBlocksFor('Bali', 7);
    blocks[0].props.subhead = '';
    const content = mapBlocksToContent(blocks, {
      destination: 'Bali', durationDays: 7, audience: 'Couples',
      metaDescription: 'Discover the spiritual heart of Bali in seven days.',
    });
    expect(content.brand.programmeTagline).toContain('spiritual heart');
  });

  test('hero.visualTitle gets the LLM suggestedTitle, visualSub from metaDescription', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), {
      destination: 'Bali', durationDays: 7, audience: 'Couples',
      suggestedTitle: 'Bali 2026 — A Journey of Discovery',
      metaDescription: 'A curated 7-day immersion across Ubud, Uluwatu, and Denpasar for couples seeking depth.',
    });
    expect(content.hero.visualTitle).toBe('Bali 2026 — A Journey of Discovery');
    expect(content.hero.visualSub).toBeTruthy();
    expect(content.hero.visualSub).toContain('immersion');
  });

  // ─────────────────────────────────────────────────────────────────
  // PR-E Option B: the bridge no longer reads destination strings to
  // pick decorative glyphs. The mapper returns empty kanji slots; the
  // renderer fills them from theme.decorative (Arabic for religious
  // themes; empty for educational/family/luxury so no destination-tied
  // script is imposed). Below tests verify the bridge stays truly
  // destination-agnostic across every supported destination.
  // ─────────────────────────────────────────────────────────────────

  test('mapBlocksToContent does NOT read destination string to inject decorative glyph', () => {
    // Every destination — Japan, Umrah, Bali, Kerala, Iceland, Vietnam,
    // Turkey, anything — gets the same empty decorative slots from the
    // mapper. The renderer's theme.decorative fallback handles the
    // glyph at render time, not the content mapper.
    const destinations = ['Japan', 'Umrah Mecca Madinah', 'Bali Indonesia', 'Kerala India', 'Iceland', 'Vietnam', 'Turkey', 'Egypt'];
    for (const dest of destinations) {
      const content = mapBlocksToContent(llmBlocksFor(dest, 7), {
        destination: dest, durationDays: 7, audience: 'Travellers',
      });
      expect(content.brand.kanji).toBe('');
      expect(content.hero.kanjiWatermark).toBe('');
    }
  });

  test('subBrand=rfu does NOT shortcut into Arabic at the content layer (theme handles it)', () => {
    // Pre-Option-B the mapper used subBrand=rfu as a shortcut to inject
    // Arabic. Option B keeps that decision out of the bridge — the
    // religious-tour-v1 TEMPLATE picks religious-classical theme by
    // default, and the THEME carries Arabic in theme.decorative. The
    // bridge stays purely structural.
    const content = mapBlocksToContent(llmBlocksFor('Holy Land', 10), {
      destination: 'Holy Land', durationDays: 10, audience: 'Pilgrims', subBrand: 'rfu',
    });
    expect(content.brand.kanji).toBe('');
    expect(content.hero.kanjiWatermark).toBe('');
  });

  test('operator can still set decorative glyph explicitly on content payload (renderer respects it)', () => {
    // If the operator/AI wants 日本 on a Japan page, they can set
    // content.brand.kanji explicitly — the renderer uses content
    // first, theme.decorative only as fallback.
    const html = landing.renderPage({
      templateType: 'educational-trip-v1',
      slug: 'jp', title: 'Japan',
      content: JSON.stringify({ brand: { kanji: '日本', label: 'JAPAN 2026' }, hero: { kanjiWatermark: '成長', headline: 'Japan' } }),
    });
    expect(html).toContain('日本');
    expect(html).toContain('成長');
  });

  test('operator-only image fields stay null (poster, partner logos, city images)', () => {
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples' });
    expect(content.hero.posterUrl).toBe('');
    expect(content.brand.logoUrl).toBe('');
    expect(content.brand.partnerLogos).toEqual([]);
    content.marquee.cities.forEach((c) => expect(c.img).toBeNull());
  });

  test('empty or malformed blocks input produces a valid (mostly-empty) payload', () => {
    const empty = mapBlocksToContent([], { destination: '', durationDays: 0, audience: '' });
    // Doesn't throw, produces a shape consistent with the template editor.
    expect(empty).toHaveProperty('hero');
    expect(empty.hero.benefitCards).toEqual([]);
    expect(empty.cultural.items).toEqual([]);
    expect(empty.marquee.cities).toEqual([]);
    expect(empty.investment.tiers).toEqual([]);
    expect(empty.faq.items).toEqual([]);
    // null input also doesn't crash.
    const nullInput = mapBlocksToContent(null, null);
    expect(nullInput).toHaveProperty('hero');
  });

  test('end-to-end: bridge output renders cleanly through educationalTripV1.render', () => {
    // The most important contract — content produced by the bridge
    // must round-trip through the template renderer without crashing
    // and surface AI-generated content in the rendered HTML.
    const content = mapBlocksToContent(llmBlocksFor('Bali', 7), { destination: 'Bali', durationDays: 7, audience: 'Couples', subBrand: 'travelstall' });
    const html = landing.renderPage({
      templateType: 'educational-trip-v1',
      slug: 'bali-couples-7d',
      title: 'Bali — A Journey of Discovery',
      content: JSON.stringify(content),
    });
    // Hero headline.
    expect(html).toContain('Bali — A Journey of Discovery');
    // Hero benefit card.
    expect(html).toContain('Slow travel');
    // Cultural flip card name + benefit (the AI-generated pull quote).
    expect(html).toContain('Ubud');
    expect(html).toContain('Patience as a practice.');
    // Safety feature.
    expect(html).toContain('Pre-vetted hosts');
    // Inclusion list.
    expect(html).toContain('Flights');
    // FAQ item.
    expect(html).toContain('How are meals arranged?');
    // Eyebrow audience.
    expect(html).toContain('COUPLES');
    // Investment tier label survives, but no pricing leaks.
    expect(html).toContain('Booking');
    expect(html).toContain('t-tier-amount--empty');
  });
});
