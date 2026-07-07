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

  test('points form submit at /p/<slug>/submit', () => {
    const html = renderPage({
      slug: 'lead-magnet',
      content: [{ type: 'form', props: { fields: [{ name: 'email' }] } }],
    });
    expect(html).toContain('/p/lead-magnet/submit');
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

// ── #447 — URL scheme allowlist ───────────────────────────────────────
//
// QA pass on 2026-05-04 found that Image / Button / Video components
// accepted javascript: + data:text/html + vbscript: schemes verbatim.
// The renderer's only defence was escapeHtml on the attribute VALUE,
// which prevents `"` injection but leaves the scheme untouched. In
// particular the button component renders `<a href="...">` — and a
// `<a href="javascript:alert(1)">` link DOES execute when clicked.
//
// The fix added `safeUrl(input, kind)` to the renderer with three
// kinds: 'image-src' (most permissive, allows data:image/*),
// 'link-href' (allows mailto:/tel:/sms: in addition to http(s):), and
// 'iframe-src' (most restrictive — http(s): only). Tests below pin
// the contract.

const { safeUrl, renderComponent } = landing;

describe('safeUrl — image-src allowlist (#447)', () => {
  test.each([
    ['https://example.com/photo.png'],
    ['http://example.com/photo.jpg'],
    ['/uploads/local-photo.png'],
    ['//cdn.example.com/x.webp'],
    ['data:image/png;base64,iVBORw0KG'],
    ['data:image/svg+xml;utf8,<svg/>'],
    ['relative-path-no-scheme.png'],
    ['#anchor'],
  ])('allows %s', (input) => {
    expect(safeUrl(input, 'image-src')).toBe(input);
  });

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:void(0)',
    '\tjavascript:void(0)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:application/x-msdownload,xyz',
    'file:///etc/passwd',
    'about:blank',
    'jar:http://x/!/',
  ])('rejects dangerous %s → falls back to ""', (input) => {
    expect(safeUrl(input, 'image-src')).toBe('');
  });

  test('null / undefined / empty fall back to ""', () => {
    expect(safeUrl(null, 'image-src')).toBe('');
    expect(safeUrl(undefined, 'image-src')).toBe('');
    expect(safeUrl('', 'image-src')).toBe('');
  });
});

describe('safeUrl — link-href allowlist (#447 — the bigger XSS surface)', () => {
  test.each([
    'https://example.com',
    'http://example.com',
    'mailto:a@b.co',
    'tel:+919876500001',
    'sms:+919876500001',
    '/contact',
    '#section',
    '//cdn.example.com',
    'page.html',
  ])('allows %s', (input) => {
    expect(safeUrl(input, 'link-href')).toBe(input);
  });

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:void(0)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/png;base64,xyz',
    'file:///etc/passwd',
    'jar:http://x/!/',
  ])('rejects dangerous %s → falls back to "#"', (input) => {
    expect(safeUrl(input, 'link-href')).toBe('#');
  });

  test('null / undefined / empty fall back to "#"', () => {
    expect(safeUrl(null, 'link-href')).toBe('#');
    expect(safeUrl(undefined, 'link-href')).toBe('#');
    expect(safeUrl('', 'link-href')).toBe('#');
  });
});

describe('safeUrl — iframe-src allowlist (most restrictive)', () => {
  test.each([
    'https://www.youtube.com/embed/abc',
    'http://example.com/video',
    '/local/video',
    '//cdn.example.com/v',
  ])('allows %s', (input) => {
    expect(safeUrl(input, 'iframe-src')).toBe(input);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'mailto:a@b.co',
    'file:///etc/passwd',
  ])('rejects %s → falls back to "about:blank"', (input) => {
    expect(safeUrl(input, 'iframe-src')).toBe('about:blank');
  });
});

describe('renderComponent — image with malicious src (#447)', () => {
  test('javascript: src is stripped before reaching the rendered HTML', () => {
    const html = renderComponent({ type: 'image', props: { src: 'javascript:alert(1)', alt: 'x' } }, 'slug-1');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('src=""');
  });

  test('data:text/html src is stripped before reaching the rendered HTML', () => {
    const html = renderComponent({ type: 'image', props: { src: 'data:text/html,<script>alert(1)</script>' } }, 'slug-1');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/text\/html/i);
    expect(html).toContain('src=""');
  });

  test('data:image/png src IS allowed (legitimate inline image)', () => {
    const html = renderComponent({ type: 'image', props: { src: 'data:image/png;base64,iVBORw0KG' } }, 'slug-1');
    expect(html).toContain('data:image/png');
  });
});

describe('renderComponent — button with malicious href (#447 — confirms the actually-executable XSS)', () => {
  test('javascript: href is stripped to "#"', () => {
    const html = renderComponent({ type: 'button', props: { url: 'javascript:alert(1)', text: 'click' } }, 'slug-1');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('href="#"');
  });

  test('vbscript: href is stripped to "#"', () => {
    const html = renderComponent({ type: 'button', props: { url: 'vbscript:msgbox(1)', text: 'x' } }, 'slug-1');
    expect(html).not.toMatch(/vbscript:/i);
    expect(html).toContain('href="#"');
  });

  test('mailto: href renders as-is (legitimate)', () => {
    const html = renderComponent({ type: 'button', props: { url: 'mailto:hi@example.com', text: 'mail' } }, 'slug-1');
    expect(html).toContain('href="mailto:hi@example.com"');
  });
});

describe('renderComponent — video iframe with malicious src (#447)', () => {
  test('javascript: iframe src falls back to about:blank', () => {
    const html = renderComponent({ type: 'video', props: { url: 'javascript:alert(1)' } }, 'slug-1');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('src="about:blank"');
  });

  test('data:text/html iframe src falls back to about:blank', () => {
    const html = renderComponent({ type: 'video', props: { url: 'data:text/html,<script>alert(1)</script>' } }, 'slug-1');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('src="about:blank"');
  });
});

describe('renderPage — full integration (#447 surfaces never appear in final HTML)', () => {
  test('image + button + video components with all-malicious URLs emit zero javascript:/script', () => {
    const lp = {
      title: 'Test Page',
      slug: 'test-slug',
      content: JSON.stringify([
        { type: 'image', props: { src: 'javascript:alert(1)' } },
        { type: 'button', props: { url: 'javascript:alert(2)', text: 'click' } },
        { type: 'video', props: { url: 'javascript:alert(3)' } },
      ]),
    };
    const html = renderPage(lp);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<script>alert/i);
  });
});

// ─── Form submission flow + successRedirectUrl validation (#451) ───────
//
// The form component embeds inline JS that POSTs to /p/:slug/submit
// and either reveals the thank-you panel or redirects to a configured URL.
// The redirect URL is validated AT RENDER TIME — invalid URLs (javascript:,
// mailto:, malformed) silently fall back to the thank-you panel mode so a
// bad URL never reaches the browser's location.assign.

describe('form — submit JS + successRedirectUrl validation', () => {
  test('default success path reveals the thank-you panel (no redirect)', () => {
    const html = renderPage({
      slug: 'p',
      content: [{ type: 'form', props: { fields: [{ name: 'email' }] } }],
    });
    // The thank-you reveal block is present in the success branch.
    expect(html).toContain('document.getElementById');
    expect(html).toContain('_thanks');
    // No window.location.assign embedded in the script.
    expect(html).not.toContain('window.location.assign');
  });

  test('valid https successRedirectUrl emits window.location.assign branch', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          successRedirectUrl: 'https://example.com/thanks',
        },
      }],
    });
    expect(html).toContain('window.location.assign');
    expect(html).toContain('"https://example.com/thanks"');
  });

  test('valid http successRedirectUrl is also accepted', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          successRedirectUrl: 'http://example.com/thanks',
        },
      }],
    });
    expect(html).toContain('window.location.assign');
    expect(html).toContain('"http://example.com/thanks"');
  });

  test('javascript: successRedirectUrl falls back to thank-you panel', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          successRedirectUrl: 'javascript:alert(1)',
        },
      }],
    });
    // The validator URL ctor accepts the parse but the protocol check
    // rejects it → fall back to the thank-you-panel branch.
    expect(html).not.toContain('window.location.assign');
    expect(html).not.toMatch(/javascript:alert/i);
    expect(html).toContain('_thanks');
  });

  test('mailto: successRedirectUrl falls back to thank-you panel', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          successRedirectUrl: 'mailto:a@b.co',
        },
      }],
    });
    expect(html).not.toContain('window.location.assign');
    expect(html).toContain('_thanks');
  });

  test('file: successRedirectUrl falls back to thank-you panel', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          successRedirectUrl: 'file:///etc/passwd',
        },
      }],
    });
    expect(html).not.toContain('window.location.assign');
    expect(html).not.toMatch(/file:\/\//);
  });

  test('malformed (un-parseable) successRedirectUrl falls back to thank-you panel', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          // Not a valid absolute URL → URL ctor throws → caught → fallback
          successRedirectUrl: 'not a url at all',
        },
      }],
    });
    expect(html).not.toContain('window.location.assign');
  });

  test('non-string successRedirectUrl is ignored (typeof guard)', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          successRedirectUrl: 12345, // number, not string
        },
      }],
    });
    expect(html).not.toContain('window.location.assign');
    expect(html).not.toContain('12345');
  });

  test('empty-string successRedirectUrl is ignored', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          successRedirectUrl: '',
        },
      }],
    });
    expect(html).not.toContain('window.location.assign');
  });
});

describe('form — CAPTCHA / Turnstile (#451)', () => {
  test('without enableCaptcha, no Turnstile script or widget rendered', () => {
    const html = renderPage({
      slug: 'p',
      content: [{ type: 'form', props: { fields: [{ name: 'email' }] } }],
    });
    expect(html).not.toContain('challenges.cloudflare.com/turnstile');
    expect(html).not.toContain('cf-turnstile');
  });

  test('with enableCaptcha=true, Turnstile script + widget appear', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: { fields: [{ name: 'email' }], enableCaptcha: true },
      }],
    });
    expect(html).toContain('challenges.cloudflare.com/turnstile');
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('cfTurnstileToken');
    // The default test site-key is used when no override + no env var.
    expect(html).toContain('1x00000000000000000000AA');
  });

  test('with enableCaptcha=true + per-form turnstileSiteKey override, override wins', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          enableCaptcha: true,
          turnstileSiteKey: '0xMYREALSITEKEY123',
        },
      }],
    });
    expect(html).toContain('0xMYREALSITEKEY123');
    expect(html).not.toContain('1x00000000000000000000AA');
  });

  test('Turnstile site-key is HTML-escaped to prevent attribute injection', () => {
    const html = renderPage({
      slug: 'p',
      content: [{
        type: 'form',
        props: {
          fields: [{ name: 'email' }],
          enableCaptcha: true,
          turnstileSiteKey: '"><script>alert(1)</script>',
        },
      }],
    });
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

// ─── safeUrl edge cases — percent-encoded XSS, CR/LF, bizarre schemes ───
//
// Browsers normalize whitespace and percent-encoding before scheme parsing.
// safeUrl does not URL-decode, so a percent-encoded "javascript:" stays
// embedded verbatim and lands in the no-scheme-match relative-path branch.
// We pin the contract so future "should we URL-decode?" refactors notice.

describe('safeUrl — percent-encoded / malformed / exotic edge cases', () => {
  test('percent-encoded "javascript%3A" does NOT match the dangerous scheme regex (passes through as relative)', () => {
    // Trimmed value starts with "javascript%3A..." — no `:` at the
    // unencoded scheme position, so the scheme regex doesn't match.
    // It falls through to the no-scheme branch which treats it as relative.
    // This is the documented contract — caller is responsible for further
    // decoding if URL-decoded interpretation is needed.
    const out = safeUrl('javascript%3Aalert(1)', 'link-href');
    // Verify it is NOT rejected (i.e. it didn't fall back to '#').
    // The output should be the input verbatim (preserved as relative).
    expect(out).toBe('javascript%3Aalert(1)');
  });

  test('CR-LF in URL is preserved (no scheme match → treated as relative)', () => {
    const out = safeUrl('foo\nbar.png', 'image-src');
    // Input doesn't start with a denied scheme — passes through.
    expect(out).toBe('foo\nbar.png');
  });

  test('webcal: scheme falls back (not on the link-href allowlist)', () => {
    expect(safeUrl('webcal://cal.example.com/feed', 'link-href')).toBe('#');
  });

  test('ftp: scheme falls back for image-src', () => {
    expect(safeUrl('ftp://example.com/photo.png', 'image-src')).toBe('');
  });

  test('chrome-extension: scheme falls back', () => {
    expect(safeUrl('chrome-extension://aaa/file.png', 'image-src')).toBe('');
  });

  test('safeUrl with unknown kind returns "" fallback even for valid scheme', () => {
    // The safeUrl signature accepts a `kind` string; the kind-specific
    // branches (image-src/link-href/iframe-src) each return the input on
    // success. An unknown kind falls through past every branch to the
    // final `return SAFE_FALLBACK[kind] ?? ''` — which yields '' because
    // SAFE_FALLBACK has no key for unknown kinds.
    expect(safeUrl('https://example.com', 'unknown-kind')).toBe('');
    // Null input + unknown kind → '' too (early-return uses same
    // SAFE_FALLBACK[kind] ?? '' fallback).
    expect(safeUrl(null, 'unknown-kind')).toBe('');
    // Empty input + unknown kind → '' likewise.
    expect(safeUrl('', 'unknown-kind')).toBe('');
  });

  test('whitespace-only input returns the kind-specific fallback', () => {
    expect(safeUrl('   ', 'link-href')).toBe('#');
    expect(safeUrl('   ', 'image-src')).toBe('');
    expect(safeUrl('   ', 'iframe-src')).toBe('about:blank');
  });

  test('tab-prefixed javascript: still rejected (browser parses TAB before scheme)', () => {
    expect(safeUrl('\tjavascript:alert(1)', 'link-href')).toBe('#');
  });

  test('case-insensitive scheme detection (JaVaScRiPt:)', () => {
    expect(safeUrl('JaVaScRiPt:alert(1)', 'link-href')).toBe('#');
    expect(safeUrl('JAVASCRIPT:alert(1)', 'image-src')).toBe('');
    expect(safeUrl('javaScript:alert(1)', 'iframe-src')).toBe('about:blank');
  });

  test('data:image/svg+xml IS accepted for image-src (SVG can self-XSS but the matcher is permissive by design)', () => {
    // Note: the implementation allows ANY data:image/* (including SVG, which
    // can host JS via <script> tags inside the SVG body). This is the
    // current contract — pinning it for review. A tighter implementation
    // would limit to data:image/(png|jpe?g|gif|webp) only.
    expect(safeUrl('data:image/svg+xml,<svg/>', 'image-src')).toBe('data:image/svg+xml,<svg/>');
  });
});
