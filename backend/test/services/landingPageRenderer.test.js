// Unit tests for backend/services/landingPageRenderer.js — pure HTML
// renderer with no I/O. The actual exported surface is just `renderPage`,
// which takes a LandingPage row (already fetched) and produces a full
// HTML document. Component dispatch + HTML escaping are covered.
import { describe, test, expect } from 'vitest';
import landing from '../../services/landingPageRenderer.js';

const { renderPage } = landing;

describe('module shape', () => {
  test('exports renderPage', () => {
    expect(typeof renderPage).toBe('function');
  });

  test('does NOT export prisma-backed lookup or analytics helpers', () => {
    // Renderer is pure — it operates on a LandingPage row passed in by the
    // caller. Lookup + analytics live in routes/landing_pages.js, not here.
    expect(landing.findBySlug).toBeUndefined();
    expect(landing.recordVisitorAnalytics).toBeUndefined();
    expect(landing.handleFormSubmission).toBeUndefined();
  });
});

describe('renderPage — top-level document', () => {
  test('returns a full HTML5 document', () => {
    const html = renderPage({ title: 'Hello', slug: 'hello', content: '[]' });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="UTF-8"');
    expect(html).toContain('viewport');
  });

  test('uses metaTitle when provided, falls back to title', () => {
    const a = renderPage({ title: 'Page Title', metaTitle: 'SEO Title', content: '[]' });
    expect(a).toContain('<title>SEO Title</title>');

    const b = renderPage({ title: 'Page Title', content: '[]' });
    expect(b).toContain('<title>Page Title</title>');
  });

  test('default title used when none supplied', () => {
    const html = renderPage({ content: '[]' });
    expect(html).toContain('<title>Landing Page</title>');
  });

  test('renders metaDescription tag when present', () => {
    const html = renderPage({
      title: 't',
      metaDescription: 'A wonderful page',
      content: '[]',
    });
    expect(html).toContain('<meta name="description" content="A wonderful page" />');
  });

  test('omits description meta tag when not provided', () => {
    const html = renderPage({ title: 't', content: '[]' });
    expect(html).not.toContain('name="description"');
  });

  test('injects cssOverrides when supplied', () => {
    const html = renderPage({
      title: 't',
      content: '[]',
      cssOverrides: '.lp-container { background: red; }',
    });
    expect(html).toContain('<style>.lp-container { background: red; }</style>');
  });

  test('omits override style block when no cssOverrides', () => {
    const html = renderPage({ title: 't', content: '[]' });
    // there is one main <style>…</style> block from base CSS — we just
    // want to check we didn't add a 2nd identifier-empty block.
    const styleCount = (html.match(/<style>/g) || []).length;
    expect(styleCount).toBe(1);
  });

  test('embeds analytics tracking pixel pointing at /api/pages/<slug>/track', () => {
    const html = renderPage({ title: 't', slug: 'pricing-2026', content: '[]' });
    expect(html).toContain('/api/pages/pricing-2026/track?event=VISIT');
    expect(html).toContain('width="1" height="1"');
  });

  test('escapes slug used in tracking pixel URL', () => {
    const html = renderPage({ title: 't', slug: 'a"b<c', content: '[]' });
    expect(html).toContain('/api/pages/a&quot;b&lt;c/track');
  });

  test('handles missing content (no body components)', () => {
    const html = renderPage({ title: 't' });
    expect(html).toContain('<div class="lp-container">');
    // No components to render — but the document is still valid.
    expect(html).toContain('</body>');
  });

  test('parses JSON-string content', () => {
    const html = renderPage({
      title: 't',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    expect(html).toContain('Hi');
  });

  test('accepts already-parsed content array', () => {
    const html = renderPage({
      title: 't',
      content: [{ type: 'heading', props: { text: 'Hi' } }],
    });
    expect(html).toContain('Hi');
  });

  test('survives malformed JSON content (does not throw)', () => {
    // Should swallow the parse error and render zero components.
    const html = renderPage({ title: 't', content: '{ not json' });
    expect(html).toContain('<div class="lp-container">');
  });
});

describe('renderPage — XSS / HTML escaping in chrome', () => {
  test('escapes <script> in metaTitle', () => {
    const html = renderPage({
      metaTitle: '<script>alert(1)</script>',
      content: '[]',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('escapes quotes in metaDescription', () => {
    const html = renderPage({
      title: 't',
      metaDescription: 'foo "bar" \'baz\'',
      content: '[]',
    });
    expect(html).toContain('&quot;bar&quot;');
    expect(html).toContain('&#39;baz&#39;');
  });

  test('escapes ampersands so they do not turn into entities accidentally', () => {
    const html = renderPage({ metaTitle: 'A & B', content: '[]' });
    expect(html).toContain('A &amp; B');
  });
});

describe('component: heading', () => {
  test('renders default h1 with text', () => {
    const html = renderPage({
      content: [{ type: 'heading', props: { text: 'Welcome' } }],
    });
    expect(html).toContain('<h1');
    expect(html).toContain('>Welcome</h1>');
  });

  test('honours level prop (h2)', () => {
    const html = renderPage({
      content: [{ type: 'heading', props: { text: 'Sub', level: 'h2' } }],
    });
    expect(html).toContain('<h2');
    expect(html).toContain('</h2>');
  });

  test('escapes HTML in heading text', () => {
    const html = renderPage({
      content: [{ type: 'heading', props: { text: '<b>X</b>' } }],
    });
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(html).not.toContain('<b>X</b>');
  });

  test('handles missing text gracefully', () => {
    const html = renderPage({ content: [{ type: 'heading' }] });
    expect(html).toContain('<h1');
    expect(html).toContain('></h1>');
  });
});

describe('component: text', () => {
  test('renders paragraph', () => {
    const html = renderPage({
      content: [{ type: 'text', props: { text: 'Lorem ipsum' } }],
    });
    expect(html).toContain('<p');
    expect(html).toContain('Lorem ipsum');
    expect(html).toContain('</p>');
  });

  test('escapes user-supplied text', () => {
    const html = renderPage({
      content: [{ type: 'text', props: { text: '<img src=x onerror=alert(1)>' } }],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('component: image', () => {
  test('renders img tag with src + alt', () => {
    const html = renderPage({
      content: [{ type: 'image', props: { src: '/static/hero.png', alt: 'Hero' } }],
    });
    expect(html).toContain('<img src="/static/hero.png"');
    expect(html).toContain('alt="Hero"');
  });

  test('escapes src to prevent attribute injection', () => {
    const html = renderPage({
      content: [{ type: 'image', props: { src: '" onerror="alert(1)' } }],
    });
    // The double-quote breaker is HTML-escaped, so the value can't break
    // out of the src= attribute. The literal substring "onerror=" still
    // appears in the rendered string but only as escaped attribute text.
    expect(html).toContain('&quot; onerror=&quot;alert(1)');
    // The raw, unescaped breakout sequence must NOT appear in the output.
    expect(html).not.toContain('" onerror="alert(1)');
  });

  test('escapes alt text', () => {
    const html = renderPage({
      content: [{ type: 'image', props: { src: 'a.jpg', alt: '"<x>"' } }],
    });
    expect(html).toContain('&quot;&lt;x&gt;&quot;');
  });
});

describe('component: button', () => {
  test('renders anchor styled as button with text + url', () => {
    const html = renderPage({
      content: [{
        type: 'button',
        props: { text: 'Buy now', url: 'https://example.com/buy' },
      }],
    });
    expect(html).toContain('href="https://example.com/buy"');
    expect(html).toContain('Buy now');
  });

  test('escapes url to prevent javascript: hijack via attribute injection', () => {
    const html = renderPage({
      content: [{
        type: 'button',
        props: { text: 'X', url: '" onclick="alert(1)' },
      }],
    });
    expect(html).toContain('&quot; onclick=&quot;alert(1)');
    expect(html).not.toMatch(/href="" onclick/);
  });

  test('large size uses bigger padding', () => {
    const html = renderPage({
      content: [{ type: 'button', props: { text: 'X', size: 'large' } }],
    });
    expect(html).toContain('padding:16px 40px');
  });

  test('small size uses smaller padding', () => {
    const html = renderPage({
      content: [{ type: 'button', props: { text: 'X', size: 'small' } }],
    });
    expect(html).toContain('padding:8px 20px');
  });

  test('falls back to # url + Click label', () => {
    const html = renderPage({ content: [{ type: 'button', props: {} }] });
    expect(html).toContain('href="#"');
    expect(html).toContain('Click');
  });
});

describe('component: form', () => {
  test('renders form with declared fields', () => {
    const html = renderPage({
      slug: 'contact',
      content: [{
        type: 'form',
        props: {
          fields: [
            { name: 'email', label: 'Email', type: 'email', required: true },
            { name: 'name', label: 'Name' },
          ],
          submitText: 'Send',
        },
      }],
    });
    expect(html).toContain('<form');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="name"');
    expect(html).toContain('type="email"');
    expect(html).toContain('Send');
    // required attr present where requested
    expect(html).toMatch(/name="email"\s+required/);
  });

  test('escapes submitText and thankYouMessage', () => {
    const html = renderPage({
      content: [{
        type: 'form',
        props: {
          fields: [],
          submitText: '<x>Submit</x>',
          thankYouMessage: '<y>Thanks</y>',
        },
      }],
    });
    expect(html).toContain('&lt;x&gt;Submit&lt;/x&gt;');
    expect(html).toContain('&lt;y&gt;Thanks&lt;/y&gt;');
  });

  test('points form submit at /api/pages/<slug>/submit', () => {
    const html = renderPage({
      slug: 'lead-magnet',
      content: [{ type: 'form', props: { fields: [{ name: 'email' }] } }],
    });
    expect(html).toContain('/api/pages/lead-magnet/submit');
  });

  test('escapes slug in form submit URL', () => {
    const html = renderPage({
      slug: '"><script>alert(1)</script>',
      content: [{ type: 'form', props: { fields: [{ name: 'email' }] } }],
    });
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // The literal break-out string must NOT appear unescaped in the JS.
    expect(html).not.toContain('"><script>alert(1)</script>');
  });

  test('uses field name as label when label missing', () => {
    const html = renderPage({
      content: [{
        type: 'form',
        props: { fields: [{ name: 'phone' }] },
      }],
    });
    expect(html).toContain('>phone<');
  });
});

describe('component: divider, spacer, video', () => {
  test('divider renders <hr>', () => {
    const html = renderPage({ content: [{ type: 'divider', props: {} }] });
    expect(html).toContain('<hr');
  });

  test('divider honours custom color', () => {
    const html = renderPage({
      content: [{ type: 'divider', props: { color: '#ff0000' } }],
    });
    expect(html).toContain('border-top:1px solid #ff0000');
  });

  test('spacer renders div with height', () => {
    const html = renderPage({
      content: [{ type: 'spacer', props: { height: '64px' } }],
    });
    expect(html).toContain('height:64px');
  });

  test('video renders iframe with escaped url', () => {
    const html = renderPage({
      content: [{
        type: 'video',
        props: { url: 'https://www.youtube.com/embed/abc"<x>' },
      }],
    });
    expect(html).toContain('<iframe');
    expect(html).toContain('https://www.youtube.com/embed/abc&quot;&lt;x&gt;');
  });
});

describe('component: columns (recursive render)', () => {
  test('renders nested components inside columns', () => {
    const html = renderPage({
      content: [{
        type: 'columns',
        props: {
          columns: [
            { components: [{ type: 'heading', props: { text: 'Left' } }] },
            { components: [{ type: 'text', props: { text: 'Right' } }] },
          ],
        },
      }],
    });
    expect(html).toContain('Left');
    expect(html).toContain('Right');
    expect(html).toContain('display:flex');
  });

  test('escaping is applied in nested column children too', () => {
    const html = renderPage({
      content: [{
        type: 'columns',
        props: {
          columns: [
            { components: [{ type: 'heading', props: { text: '<script>x</script>' } }] },
          ],
        },
      }],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  test('handles empty columns array', () => {
    const html = renderPage({
      content: [{ type: 'columns', props: { columns: [] } }],
    });
    expect(html).toContain('display:flex');
  });
});

describe('component: unknown type', () => {
  test('returns empty string for unknown component types', () => {
    const html = renderPage({
      content: [
        { type: 'heading', props: { text: 'before' } },
        { type: 'mystery-widget', props: { foo: 'bar' } },
        { type: 'heading', props: { text: 'after' } },
      ],
    });
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(html).not.toContain('mystery-widget');
  });
});
