// PR-C renderer coverage — pins the 4 new block render cases
// (travelVideo / safetyFeatures / brochureDownload / contactFooter) plus
// the new optional fields on the 3 existing blocks (cityCards.benefit,
// itineraryTimeline.icon/notes, tierPricing.badge).
import { describe, test, expect } from 'vitest';
import landing from '../../services/landingPageRenderer.js';

const { renderComponent, isTravelDestinationPage } = landing;

describe('isTravelDestinationPage — PR-C block types', () => {
  test('detects each new travel block type', () => {
    for (const type of ['travelVideo', 'safetyFeatures', 'brochureDownload', 'contactFooter']) {
      expect(isTravelDestinationPage({}, [{ type, props: {} }])).toBe(true);
    }
  });
});

describe('travelVideo', () => {
  test('renders an iframe when a URL is provided', () => {
    const html = renderComponent({
      type: 'travelVideo',
      props: { title: 'Watch', url: 'https://www.youtube.com/embed/abc', aspectRatio: '16:9' },
    }, 'slug');
    expect(html).toContain('Watch');
    expect(html).toContain('<iframe');
    expect(html).toContain('youtube.com/embed/abc');
    expect(html).toContain('16 / 9');
  });

  test('rejects javascript: schemes via safeUrl', () => {
    const html = renderComponent({
      type: 'travelVideo',
      props: { url: 'javascript:alert(1)' },
    }, 'slug');
    expect(html).not.toContain('javascript:alert');
  });

  test('renders the empty-state placeholder when URL is missing', () => {
    const html = renderComponent({ type: 'travelVideo', props: {} }, 'slug');
    expect(html).toContain('t-video-empty');
    expect(html).not.toContain('<iframe');
  });

  test('9:16 aspect ratio renders as vertical', () => {
    const html = renderComponent({
      type: 'travelVideo',
      props: { url: 'https://player.vimeo.com/video/123', aspectRatio: '9:16' },
    }, 'slug');
    expect(html).toContain('9 / 16');
  });

  test('normalises a youtube.com/watch URL to /embed before rendering', () => {
    const html = renderComponent({
      type: 'travelVideo',
      props: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    }, 'slug');
    expect(html).toContain('<iframe');
    expect(html).toContain('youtube.com/embed/dQw4w9WgXcQ');
    expect(html).not.toContain('watch?v=');
  });

  test('normalises a youtube.com/shorts URL to /embed (the 2026-06-22 bug)', () => {
    const html = renderComponent({
      type: 'travelVideo',
      props: { url: 'https://www.youtube.com/shorts/vYbKn1uE3zoS' },
    }, 'slug');
    expect(html).toContain('youtube.com/embed/vYbKn1uE3zoS');
    expect(html).not.toContain('/shorts/');
  });

  test('renders a local /uploads/landing-page-videos URL as <video controls>, not <iframe>', () => {
    const html = renderComponent({
      type: 'travelVideo',
      props: { url: '/uploads/landing-page-videos/tenant-1/abc.mp4' },
    }, 'slug');
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('/uploads/landing-page-videos/tenant-1/abc.mp4');
    expect(html).not.toContain('<iframe');
  });
});

describe('generic video block — normalisation + local-upload', () => {
  test('normalises a youtu.be share URL to youtube.com/embed', () => {
    const html = renderComponent({
      type: 'video',
      props: { url: 'https://youtu.be/dQw4w9WgXcQ' },
    }, 'slug');
    expect(html).toContain('youtube.com/embed/dQw4w9WgXcQ');
  });

  test('renders a local upload as <video controls>', () => {
    const html = renderComponent({
      type: 'video',
      props: { url: '/uploads/landing-page-videos/tenant-1/clip.mp4' },
    }, 'slug');
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).not.toContain('<iframe');
  });
});

describe('safetyFeatures', () => {
  test('renders one item per entry with icon + title + body', () => {
    const html = renderComponent({
      type: 'safetyFeatures',
      props: {
        title: 'Safety',
        items: [
          { icon: '🛡', title: 'Insurance', body: 'Covered' },
          { icon: '⚕', title: 'Medical', body: 'On call' },
        ],
      },
    }, 'slug');
    expect(html).toContain('Safety');
    expect(html).toContain('Insurance');
    expect(html).toContain('Covered');
    expect(html).toContain('Medical');
    expect(html).toContain('t-section t-safety');
    expect((html.match(/t-safety-item/g) || []).length).toBe(2);
  });

  test('escapes HTML in item bodies', () => {
    const html = renderComponent({
      type: 'safetyFeatures',
      props: { items: [{ icon: '◈', title: '<x>', body: 'a & b' }] },
    }, 'slug');
    expect(html).not.toContain('<x>');
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('a &amp; b');
  });
});

describe('brochureDownload', () => {
  test('with fileUrl renders a download anchor', () => {
    const html = renderComponent({
      type: 'brochureDownload',
      props: { title: 'PDF', ctaText: 'Get it', fileUrl: '/uploads/landing-page-images/tenant-1/brochure.pdf' },
    }, 'slug');
    expect(html).toContain('PDF');
    expect(html).toContain('Get it');
    expect(html).toContain('href="/uploads/landing-page-images/tenant-1/brochure.pdf"');
    expect(html).toContain('download');
  });

  test('without fileUrl renders a lead-capture form', () => {
    const html = renderComponent({
      type: 'brochureDownload',
      props: { title: 'PDF', ctaText: 'Send me the PDF' },
    }, 'slug');
    expect(html).not.toContain('href="https://');
    expect(html).toContain('Send me the PDF');
    expect(html).toContain('<form');
    expect(html).toContain('brochureRequest:true');
  });

  test('rejects javascript: in fileUrl via safeUrl', () => {
    const html = renderComponent({
      type: 'brochureDownload',
      props: { ctaText: 'Go', fileUrl: 'javascript:alert(1)' },
    }, 'slug');
    expect(html).not.toContain('javascript:alert');
  });
});

describe('contactFooter', () => {
  test('renders phone + email when supplied', () => {
    const html = renderComponent({
      type: 'contactFooter',
      props: {
        brandName: 'Acme Travel',
        phone: '+91 9912345678',
        email: 'hi@acme.com',
        ctaText: 'Reserve',
        ctaUrl: 'https://acme.com/reserve',
      },
    }, 'slug');
    expect(html).toContain('Acme Travel');
    expect(html).toContain('+91 9912345678');
    expect(html).toContain('hi@acme.com');
    expect(html).toContain('mailto:hi@acme.com');
    expect(html).toContain('tel:+919912345678');
    expect(html).toContain('Reserve');
  });

  test('renders placeholder labels when phone/email are null (operator hasn\'t set them)', () => {
    const html = renderComponent({
      type: 'contactFooter',
      props: { ctaText: 'Reserve' },
    }, 'slug');
    expect(html).toContain('[Add phone]');
    expect(html).toContain('[Add email]');
  });

  test('omits the CTA button when text or URL is missing', () => {
    const html = renderComponent({
      type: 'contactFooter',
      props: { phone: '+91 1', email: 'a@b.c', ctaText: 'Reserve' /* no ctaUrl */ },
    }, 'slug');
    expect(html).not.toContain('t-contact-cta');
  });
});

describe('cityCards.benefit (PR-C optional field)', () => {
  test('renders the benefit pull-quote when present', () => {
    const html = renderComponent({
      type: 'cityCards',
      props: {
        cards: [{
          tag: 'CULTURAL', title: 'Tokyo', img: null,
          body: 'A bustling capital.',
          benefit: 'Exposure to structured complexity.',
        }],
      },
    }, 'slug');
    expect(html).toContain('t-city-benefit');
    expect(html).toContain('Exposure to structured complexity.');
    expect(html).toContain('DERIVED BENEFIT');
  });

  test('omits the benefit block when empty', () => {
    const html = renderComponent({
      type: 'cityCards',
      props: { cards: [{ tag: 'X', title: 'Tokyo', img: null, body: 'a' }] },
    }, 'slug');
    expect(html).not.toContain('t-city-benefit');
  });
});

describe('itineraryTimeline.icon + notes (PR-C optional fields)', () => {
  test('icon replaces the day number in the marker', () => {
    const html = renderComponent({
      type: 'itineraryTimeline',
      props: {
        days: [{ day: 1, title: 'Arrival', icon: '✈', bullets: ['Pickup'] }],
      },
    }, 'slug');
    expect(html).toContain('t-day-icon');
    expect(html).toContain('✈');
    // Day number markup not present when icon is.
    expect(html).not.toMatch(/<span class="t-day-num">\s*1\s*<\/span>/);
  });

  test('notes render below the bullets when present', () => {
    const html = renderComponent({
      type: 'itineraryTimeline',
      props: {
        days: [{ day: 2, title: 'Day 2', bullets: ['A'], notes: 'Optional evening activity' }],
      },
    }, 'slug');
    expect(html).toContain('t-day-notes');
    expect(html).toContain('Optional evening activity');
  });

  test('day number renders when icon is omitted', () => {
    const html = renderComponent({
      type: 'itineraryTimeline',
      props: { days: [{ day: 3, title: 'Day 3', bullets: ['a'] }] },
    }, 'slug');
    expect(html).toContain('<span class="t-day-num">3</span>');
  });
});

describe('tierPricing.badge (PR-C optional field)', () => {
  test('renders the badge ribbon when present + uses the badged class', () => {
    const html = renderComponent({
      type: 'tierPricing',
      props: {
        tiers: [{ step: 1, label: 'Reg', amount: '5000', badge: 'Most Popular' }],
      },
    }, 'slug');
    expect(html).toContain('t-tier--badged');
    expect(html).toContain('Most Popular');
  });

  test('omits the badge ribbon when badge is null', () => {
    const html = renderComponent({
      type: 'tierPricing',
      props: { tiers: [{ step: 1, label: 'Reg', amount: '5000' }] },
    }, 'slug');
    expect(html).not.toContain('t-tier--badged');
  });
});
