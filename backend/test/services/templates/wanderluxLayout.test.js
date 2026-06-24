// Hybrid-layout composer for wanderlux-v1 — vitest unit coverage.
//
// What this exercises:
//   1. splitTemplate finds every documented section marker in the live
//      landing-page.dc.html and partitions cleanly around the always-on
//      prefix (nav) + suffix (floating register).
//   2. normaliseLayoutItems drops invalid entries (unknown section,
//      unknown block type, missing fields) without throwing.
//   3. effectiveLayout returns DEFAULT_SECTION_ORDER when no _layout
//      override is set (backwards compatibility for every pre-hybrid
//      page in the DB).
//   4. composeLayout end-to-end:
//      - default-order pass produces output containing every section
//        chunk
//      - operator-reordered pass shuffles section markers in the
//        emitted HTML to match the new order
//      - hidden-section pass omits the section's marker comment AND its
//        wrapping <sc-if> entirely
//      - custom-block interleaving injects the manual renderer's HTML
//        (a Heading block produces an <h2> with the operator's text)
//   5. index.js routes through composeLayout iff _layout.items[] is
//      present + non-empty; otherwise the un-rewritten template path
//      runs (the hasCustomLayout gate is exercised indirectly).

import { describe, test, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const composer = require('../../../services/templates/wanderlux/layoutComposer');
const wanderlux = require('../../../services/templates/wanderlux');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', 'services', 'templates', 'wanderlux', 'landing-page.dc.html');
const TEMPLATE_HTML = fs.readFileSync(TEMPLATE_PATH, 'utf8');

beforeEach(() => {
  composer._resetCache();
});

describe('splitTemplate', () => {
  test('partitions the template into prefix + sections + suffix', () => {
    const split = composer.splitTemplate(TEMPLATE_HTML);
    expect(split.prefix).toContain('<header');
    expect(split.suffix).toContain('FLOATING REGISTER');
    // Every documented body-section key resolves to a chunk.
    for (const key of composer.DEFAULT_SECTION_ORDER) {
      expect(split.sections[key], `section ${key} chunk should exist`).toBeTruthy();
    }
    // Section order in the template matches DEFAULT_SECTION_ORDER.
    expect(split.sectionOrder).toEqual([...composer.DEFAULT_SECTION_ORDER]);
  });

  test('section chunks carry their <sc-if> guard', () => {
    const split = composer.splitTemplate(TEMPLATE_HTML);
    expect(split.sections.hero).toMatch(/<sc-if\s+value="\{\{\s*showHero\s*\}\}"/);
    expect(split.sections.footer).toMatch(/<sc-if\s+value="\{\{\s*showFooter\s*\}\}"/);
  });

  test('throws when boundary markers are missing (template-shape regression guard)', () => {
    composer._resetCache();
    expect(() => composer.splitTemplate('<html><body>no markers here</body></html>')).toThrow(
      /section boundary markers not found/i,
    );
  });
});

describe('normaliseLayoutItems', () => {
  test('drops unknown section keys, duplicate sections, unknown block types, and non-objects', () => {
    const out = composer.normaliseLayoutItems([
      { kind: 'section', key: 'hero' },
      { kind: 'section', key: 'hero' },                            // duplicate → dropped
      { kind: 'section', key: 'made-up-key' },                     // unknown → dropped
      { kind: 'block', type: 'heading', props: { text: 'Hi' } },  // ok
      { kind: 'block', type: 'form' },                             // not in catalogue → dropped
      'garbage',                                                    // not an object → dropped
      null,                                                         // null → dropped
      { kind: 'block' },                                            // missing type → dropped
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'section', key: 'hero' });
    expect(out[1].kind).toBe('block');
    expect(out[1].type).toBe('heading');
    expect(out[1].props).toEqual({ text: 'Hi' });
    expect(typeof out[1].id).toBe('string');
  });

  test('coerces missing/invalid props on a block to an empty object', () => {
    const out = composer.normaliseLayoutItems([
      { kind: 'block', type: 'spacer' },                  // no props
      { kind: 'block', type: 'spacer', props: 'oops' },  // string props
      { kind: 'block', type: 'spacer', props: [] },       // array props
    ]);
    expect(out).toHaveLength(3);
    for (const b of out) expect(b.props).toEqual({});
  });
});

describe('effectiveLayout', () => {
  test('returns the default section order when no _layout is set', () => {
    const layout = composer.effectiveLayout({});
    expect(layout.map((it) => it.key)).toEqual([...composer.DEFAULT_SECTION_ORDER]);
    expect(layout.every((it) => it.kind === 'section')).toBe(true);
  });

  test('returns the default section order when _layout.items is empty', () => {
    const layout = composer.effectiveLayout({ _layout: { items: [] } });
    expect(layout.map((it) => it.key)).toEqual([...composer.DEFAULT_SECTION_ORDER]);
  });

  test('uses the operator-supplied items when present', () => {
    const layout = composer.effectiveLayout({
      _layout: { items: [{ kind: 'section', key: 'hero' }, { kind: 'section', key: 'footer' }] },
    });
    expect(layout).toEqual([
      { kind: 'section', key: 'hero' },
      { kind: 'section', key: 'footer' },
    ]);
  });
});

describe('composeLayout', () => {
  test('default layout produces every section chunk in order', () => {
    const html = composer.composeLayout(TEMPLATE_HTML, {}, 'demo');
    // Each section marker appears, and HERO comes before FOOTER.
    expect(html.indexOf('===================== HERO =====================')).toBeGreaterThan(0);
    expect(html.indexOf('===================== FOOTER =====================')).toBeGreaterThan(0);
    expect(html.indexOf('===================== HERO =====================')).toBeLessThan(
      html.indexOf('===================== FOOTER ====================='),
    );
    // Floating register still always-on.
    expect(html).toContain('FLOATING REGISTER');
  });

  test('reordering moves the section marker in the emitted HTML', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: [
            { kind: 'section', key: 'footer' },
            { kind: 'section', key: 'hero' },
          ],
        },
      },
      'demo',
    );
    // With footer first, footer marker should appear BEFORE hero marker
    // in the emitted body (between prefix and suffix).
    expect(html.indexOf('===================== FOOTER =====================')).toBeLessThan(
      html.indexOf('===================== HERO ====================='),
    );
  });

  test('hidden sections are removed entirely from the emitted HTML', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: composer.DEFAULT_SECTION_ORDER
            .filter((k) => k !== 'safety' && k !== 'testimonials')
            .map((key) => ({ kind: 'section', key })),
        },
      },
      'demo',
    );
    expect(html).not.toContain('===================== SAFETY');
    expect(html).not.toContain('===================== TESTIMONIALS');
    expect(html).not.toMatch(/<sc-if\s+value="\{\{\s*showSafety\s*\}\}"/);
    expect(html).not.toMatch(/<sc-if\s+value="\{\{\s*showTestimonials\s*\}\}"/);
    // Sibling sections still present.
    expect(html).toContain('===================== HERO');
    expect(html).toContain('===================== FOOTER');
  });

  test('custom Heading block renders inline via the manual renderer', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: [
            { kind: 'section', key: 'hero' },
            { kind: 'block', id: 'b1', type: 'heading', props: { text: 'Special announcement', level: 'h2', align: 'center', color: '#111' } },
            { kind: 'section', key: 'footer' },
          ],
        },
      },
      'demo',
    );
    // The heading <h2> + escaped text is present, between hero and footer.
    const heroIdx = html.indexOf('===================== HERO');
    const headingIdx = html.indexOf('Special announcement');
    const footerIdx = html.indexOf('===================== FOOTER');
    expect(headingIdx).toBeGreaterThan(heroIdx);
    expect(footerIdx).toBeGreaterThan(headingIdx);
    expect(html).toMatch(/<h2[^>]*>Special announcement<\/h2>/);
  });

  test('custom Button block escapes javascript: URLs (defence-in-depth)', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: [
            { kind: 'block', id: 'b1', type: 'button', props: { text: 'Click', url: 'javascript:alert(1)' } },
          ],
        },
      },
      'demo',
    );
    expect(html).toContain('Click');
    // safeUrl strips javascript: to '#'
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toMatch(/href="#"/);
  });

  test('Divider + Spacer blocks render through composeLayout without crashing', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: [
            { kind: 'block', id: 'b1', type: 'divider', props: { color: '#ccc', margin: '12px' } },
            { kind: 'block', id: 'b2', type: 'spacer', props: { height: '64px' } },
          ],
        },
      },
      'demo',
    );
    expect(html).toMatch(/<hr[^>]*>/);
    expect(html).toContain('height:64px');
  });

  test('unknown custom-block types are silently dropped (closed catalogue)', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: [
            { kind: 'block', id: 'b1', type: 'form', props: { fields: [] } },           // not in catalogue
            { kind: 'block', id: 'b2', type: 'heading', props: { text: 'Visible' } }, // ok
          ],
        },
      },
      'demo',
    );
    expect(html).toContain('Visible');
    // Form block was dropped — its onsubmit / formId artefacts should not appear.
    expect(html).not.toContain('onsubmit="return false');
  });
});

describe('wanderlux render() integration', () => {
  test('a page with no _layout renders the un-rewritten template (default sections present)', () => {
    const out = wanderlux.render({ content: JSON.stringify({ brand: { name: 'Demo' } }) });
    expect(out).toContain('===================== HERO');
    expect(out).toContain('===================== FOOTER');
    expect(out).toContain('FLOATING REGISTER');
    // Config got injected.
    expect(out).toContain('window.__PAGE_CONFIG');
    // Support.js rewritten to absolute path.
    expect(out).toContain('/api/landing-pages/wanderlux-static/support.js');
  });

  test('a page with _layout.items goes through composeLayout (reorder visible in HTML)', () => {
    const out = wanderlux.render({
      slug: 'reorder-test',
      content: JSON.stringify({
        brand: { name: 'Demo' },
        _layout: {
          items: [
            { kind: 'section', key: 'footer' },
            { kind: 'section', key: 'hero' },
          ],
        },
      }),
    });
    expect(out.indexOf('===================== FOOTER')).toBeLessThan(
      out.indexOf('===================== HERO'),
    );
    // Hidden sections (everything except footer + hero) are omitted.
    expect(out).not.toContain('===================== SAFETY');
    expect(out).not.toContain('===================== INVESTMENT');
  });
});

describe('composeLayout — editor bridge', () => {
  test('every emitted section gets a data-wlx-section wrapper', () => {
    const html = composer.composeLayout(TEMPLATE_HTML, {}, 'demo');
    for (const key of composer.DEFAULT_SECTION_ORDER) {
      expect(html, `section ${key} should be wrapped`).toMatch(
        new RegExp(`<div data-wlx-section="${key}">`),
      );
    }
  });

  test('emitted custom block gets a data-wlx-block wrapper using its id', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: [{ kind: 'block', id: 'b_test_123', type: 'heading', props: { text: 'X' } }],
        },
      },
      'demo',
    );
    expect(html).toContain('<div data-wlx-block="b_test_123">');
  });

  test('block ids are sanitised so a hostile id cannot break out of the attribute', () => {
    const html = composer.composeLayout(
      TEMPLATE_HTML,
      {
        _layout: {
          items: [
            { kind: 'block', id: 'b" onmouseover="alert(1)', type: 'heading', props: { text: 'X' } },
          ],
        },
      },
      'demo',
    );
    // The dangerous chars are stripped; the wrapper has only safe chars.
    expect(html).not.toContain('onmouseover=');
    expect(html).toMatch(/<div data-wlx-block="[a-zA-Z0-9_-]*">/);
  });

  test('the editor bridge script is injected and uses window.opener fallback', () => {
    const html = composer.composeLayout(TEMPLATE_HTML, {}, 'demo');
    expect(html).toContain('wlx-canvas-click');
    expect(html).toContain('window.opener');
    expect(html).toContain('data-wlx-section');
  });
});

describe('always-on composeLayout in render()', () => {
  test('un-customised render still includes the data-wlx wrappers (so the bridge works from the first edit)', () => {
    const out = wanderlux.render({ content: JSON.stringify({ brand: { name: 'Demo' } }) });
    expect(out).toContain('data-wlx-section="hero"');
    expect(out).toContain('data-wlx-section="footer"');
    expect(out).toContain('wlx-canvas-click');
  });
});
