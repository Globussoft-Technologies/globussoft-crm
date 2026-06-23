// Unit tests for the 8 travel-destination block renderers added to
// backend/services/landingPageRenderer.js. The renderer is pure (no DB,
// no network), so these are straight input → HTML assertions. The
// shared travel CSS is loaded once from the sibling .css file and
// inlined into pages whose templateType === "travel_destination".
import { describe, test, expect, beforeEach } from 'vitest';
import landing from '../../services/landingPageRenderer.js';

const { renderPage, renderComponent, isTravelDestinationPage, _resetTravelCssCache } = landing;

beforeEach(() => {
  if (typeof _resetTravelCssCache === 'function') _resetTravelCssCache();
});

describe('isTravelDestinationPage', () => {
  test('templateType === "travel_destination" → true', () => {
    expect(isTravelDestinationPage({ templateType: 'travel_destination' }, [])).toBe(true);
  });

  test('any travel block in content → true even without templateType', () => {
    expect(isTravelDestinationPage({}, [{ type: 'destinationHero', props: {} }])).toBe(true);
    expect(isTravelDestinationPage({}, [{ type: 'cityCards', props: {} }])).toBe(true);
    expect(isTravelDestinationPage({}, [{ type: 'highlightsGrid', props: {} }])).toBe(true);
    expect(isTravelDestinationPage({}, [{ type: 'inclusionsGrid', props: {} }])).toBe(true);
    expect(isTravelDestinationPage({}, [{ type: 'itineraryTimeline', props: {} }])).toBe(true);
    expect(isTravelDestinationPage({}, [{ type: 'tierPricing', props: {} }])).toBe(true);
    expect(isTravelDestinationPage({}, [{ type: 'faqAccordion', props: {} }])).toBe(true);
    expect(isTravelDestinationPage({}, [{ type: 'reviewCarousel', props: {} }])).toBe(true);
  });

  test('only generic blocks → false', () => {
    expect(isTravelDestinationPage({}, [{ type: 'heading', props: {} }, { type: 'text', props: {} }])).toBe(false);
  });
});

describe('renderPage — travel CSS injection', () => {
  test('travel_destination template wraps body in .trips-page', () => {
    const html = renderPage({ templateType: 'travel_destination', content: '[]', slug: 'umrah-10d' });
    expect(html).toContain('<div class="trips-page">');
    expect(html).not.toContain('<div class="lp-container">');
  });

  test('travel page injects the travel stylesheet', () => {
    const html = renderPage({ templateType: 'travel_destination', content: '[]', slug: 'x' });
    // The travel CSS file uses `.trips-page` as its root selector, so
    // detecting that token inside a <style> block confirms the file
    // was loaded. We don't pin the file's body — the test would rot
    // every time the CSS evolves.
    expect(html).toContain('.trips-page');
  });

  test('non-travel page does not inject travel CSS or use trips-page wrapper', () => {
    const html = renderPage({
      templateType: 'lead_capture',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
      slug: 'lp',
    });
    expect(html).toContain('<div class="lp-container">');
    expect(html).not.toContain('<div class="trips-page">');
  });
});

describe('destinationHero block', () => {
  test('renders destination tag, headline, subhead, CTA', () => {
    const html = renderComponent({
      type: 'destinationHero',
      props: {
        destination: 'Umrah',
        headline: 'A Journey of Faith',
        subhead: '10 days of guided pilgrimage.',
        ctaText: 'Reserve Now',
        ctaScrollTarget: 'register',
      },
    }, 'umrah-10d');
    expect(html).toContain('Umrah');
    expect(html).toContain('A Journey of Faith');
    expect(html).toContain('10 days of guided pilgrimage.');
    expect(html).toContain('Reserve Now');
    expect(html).toContain('class="t-hero"');
  });

  test('escapes HTML in headline + subhead', () => {
    const html = renderComponent({
      type: 'destinationHero',
      props: { headline: '<script>x</script>', subhead: 'a & b' },
    }, 's');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  });

  test('rejects javascript: in posterUrl via safeUrl', () => {
    const html = renderComponent({
      type: 'destinationHero',
      props: { posterUrl: 'javascript:alert(1)', headline: 'h' },
    }, 's');
    expect(html).not.toContain('javascript:alert');
  });

  test('omits countdown block when countdownTo is null', () => {
    const html = renderComponent({
      type: 'destinationHero',
      props: { headline: 'h', countdownTo: null },
    }, 's');
    expect(html).not.toContain('t-hero-countdown');
    expect(html).not.toContain('data-unit');
  });

  test('emits countdown markup + tick script when countdownTo is set', () => {
    const html = renderComponent({
      type: 'destinationHero',
      props: { headline: 'h', countdownTo: '2026-12-31T00:00:00Z' },
    }, 's');
    expect(html).toContain('t-hero-countdown');
    expect(html).toContain('data-unit="d"');
    expect(html).toContain('data-unit="h"');
    expect(html).toContain('data-unit="m"');
    expect(html).toContain('data-unit="s"');
    expect(html).toContain('setInterval(tick,1000)');
  });

  test('palette tokens flow into inline custom properties', () => {
    const html = renderComponent({
      type: 'destinationHero',
      props: { headline: 'h', palette: { bg: '#222222', fg: '#fafafa', accent: '#abcdef' } },
    }, 's');
    expect(html).toContain('--t-hero-fg:#fafafa');
    expect(html).toContain('--t-hero-accent:#abcdef');
  });
});

describe('cityCards block', () => {
  test('renders one card per entry with empty-state for null img', () => {
    const html = renderComponent({
      type: 'cityCards',
      props: {
        title: 'Where',
        cards: [
          { tag: 'ICONIC', title: 'Mecca', img: 'https://example.com/m.jpg', body: 'Sacred.' },
          { tag: 'HERITAGE', title: 'Medina', img: null, body: 'Heritage.' },
        ],
      },
    }, 'umrah');
    expect(html).toContain('Where');
    expect(html).toContain('Mecca');
    expect(html).toContain('Medina');
    expect(html).toContain('Sacred.');
    expect(html).toContain('Heritage.');
    // The image-bearing card uses background-image; the null card uses
    // the empty-state class.
    expect(html).toContain("background-image:url('https://example.com/m.jpg')");
    expect(html).toContain('t-city-img--empty');
  });

  test('zero cards → empty city-grid (no crash)', () => {
    const html = renderComponent({
      type: 'cityCards',
      props: { title: 'Where', cards: [] },
    }, 's');
    expect(html).toContain('t-city-grid');
    expect(html).toContain('Where');
  });
});

describe('highlightsGrid block', () => {
  test('renders each item with icon + title + body', () => {
    const html = renderComponent({
      type: 'highlightsGrid',
      props: {
        title: 'Why',
        items: [
          { icon: '◈', title: 'Confidence', body: 'Body one.' },
          { icon: '⊕', title: 'Perspective', body: 'Body two.' },
        ],
      },
    }, 's');
    expect(html).toContain('Why');
    expect(html).toContain('◈');
    expect(html).toContain('Confidence');
    expect(html).toContain('Body one.');
    expect(html).toContain('⊕');
    expect(html).toContain('Perspective');
  });
});

describe('inclusionsGrid block', () => {
  test('renders each item as a checklist li', () => {
    const html = renderComponent({
      type: 'inclusionsGrid',
      props: {
        title: 'Included',
        items: ['Airfare', '4-star hotels', 'All meals'],
      },
    }, 's');
    expect(html).toContain('t-inclusion-list');
    expect(html).toContain('Airfare');
    expect(html).toContain('4-star hotels');
    expect(html).toContain('All meals');
    expect((html.match(/t-inclusion-item/g) || []).length).toBe(3);
  });
});

describe('itineraryTimeline block', () => {
  test('renders one day entry per item with day number and bullets', () => {
    const html = renderComponent({
      type: 'itineraryTimeline',
      props: {
        title: 'Day-by-day',
        days: [
          { day: 1, title: 'Arrival', bullets: ['Airport pickup', 'Hotel check-in'] },
          { day: 2, title: 'Mecca', bullets: ['Umrah ritual', 'Group reflection'] },
        ],
      },
    }, 's');
    expect(html).toContain('Day-by-day');
    expect(html).toContain('Arrival');
    expect(html).toContain('Mecca');
    expect(html).toContain('Airport pickup');
    expect(html).toContain('Umrah ritual');
    expect((html.match(/t-day-marker/g) || []).length).toBe(2);
  });
});

describe('tierPricing block — pricing is never AI-generated', () => {
  test('null amount renders "Pricing TBD" placeholder', () => {
    const html = renderComponent({
      type: 'tierPricing',
      props: {
        title: 'Investment',
        currency: '₹',
        tiers: [
          { step: 1, label: 'Registration', amount: null, dueDate: null, vendor: null },
        ],
      },
    }, 's');
    expect(html).toContain('Registration');
    expect(html).toContain('Pricing TBD');
    expect(html).toContain('t-tier-amount--empty');
  });

  test('non-null amount renders with currency prefix', () => {
    const html = renderComponent({
      type: 'tierPricing',
      props: {
        currency: '₹',
        tiers: [
          { step: 1, label: 'Registration', amount: '34,980', dueDate: '30 June 2026', vendor: 'TMC' },
        ],
      },
    }, 's');
    expect(html).toContain('₹34,980');
    expect(html).toContain('30 June 2026');
    expect(html).toContain('TMC');
    expect(html).not.toContain('Pricing TBD');
  });

  test('escapes amount, dueDate, vendor as untrusted strings', () => {
    const html = renderComponent({
      type: 'tierPricing',
      props: {
        tiers: [
          { step: 1, label: 'Reg', amount: '<script>1</script>', dueDate: 'a & b', vendor: '<b>x</b>' },
        ],
      },
    }, 's');
    expect(html).not.toContain('<script>1</script>');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('faqAccordion block', () => {
  test('renders categories bar + each FAQ as details/summary', () => {
    const html = renderComponent({
      type: 'faqAccordion',
      props: {
        title: 'Questions',
        categories: [
          { id: 'all', label: 'All', icon: '◇' },
          { id: 'tour', label: 'Tour', icon: '◈' },
        ],
        faqs: [
          { cat: 'tour', q: 'When?', a: 'September 2026.' },
          { cat: 'tour', q: 'Where?', a: 'Mecca + Medina.' },
        ],
      },
    }, 's');
    expect(html).toContain('Questions');
    expect(html).toContain('t-faq-cats');
    expect(html).toContain('data-cat="all"');
    expect(html).toContain('data-cat="tour"');
    expect(html).toContain('When?');
    expect(html).toContain('September 2026.');
    expect((html.match(/<details/g) || []).length).toBe(2);
  });

  test('escapes Q+A as untrusted strings', () => {
    const html = renderComponent({
      type: 'faqAccordion',
      props: {
        faqs: [{ cat: 'x', q: '<img src=x onerror=1>', a: '<script>y</script>' }],
      },
    }, 's');
    expect(html).not.toContain('<script>y');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;y');
  });
});

describe('reviewCarousel block — manual-only', () => {
  test('renders supplied reviews with initial, name, quote', () => {
    const html = renderComponent({
      type: 'reviewCarousel',
      props: {
        title: 'Parents Say',
        reviews: [
          { initial: 'P', name: 'PRIYA S.', text: 'Phenomenal planning.' },
          { initial: 'R', name: 'RAHUL M.', text: 'Complete peace of mind.' },
        ],
      },
    }, 's');
    expect(html).toContain('Parents Say');
    expect(html).toContain('Phenomenal planning.');
    expect(html).toContain('PRIYA S.');
    expect(html).toContain('RAHUL M.');
    expect((html.match(/t-review-avatar/g) || []).length).toBe(2);
  });

  test('derives initial from name when initial is missing', () => {
    const html = renderComponent({
      type: 'reviewCarousel',
      props: {
        reviews: [{ name: 'Alok M.', text: 'Trip was excellent.' }],
      },
    }, 's');
    expect(html).toContain('>A<');
  });
});
