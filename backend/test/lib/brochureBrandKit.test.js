/**
 * Unit tests for backend/lib/brochureBrandKit.js — the Brochure Engine's
 * server-side brand-kit trust boundary. Mirrors the upstream sanitizer's
 * contract: drop-don't-reject, raster-only logos, clamped custom placement.
 */
// globals: true in vitest.config.js — describe/it/expect are ambient.
const { sanitizeBrandKit } = require('../../lib/brochureBrandKit');

// A real, tiny 1x1 PNG (valid signature + IHDR/IDAT/IEND) so the magic-byte
// sniff passes and the logo is re-emitted as a clean data: URI.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

describe('brochureBrandKit.sanitizeBrandKit', () => {
  it('returns undefined for non-objects / empty input', () => {
    expect(sanitizeBrandKit(undefined)).toBeUndefined();
    expect(sanitizeBrandKit(null)).toBeUndefined();
    expect(sanitizeBrandKit('nope')).toBeUndefined();
    expect(sanitizeBrandKit({})).toBeUndefined();
  });

  it('passes a clean PNG logo through, re-emitted as a normalised data: URI', () => {
    const kit = sanitizeBrandKit({ logoUrl: PNG_1x1 });
    expect(kit).toBeDefined();
    expect(kit.logoUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('drops an SVG logo (script-bearing) → no logoUrl', () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');
    const kit = sanitizeBrandKit({ logoUrl: svg, name: 'Acme' });
    expect(kit).toBeDefined();
    expect(kit.logoUrl).toBeUndefined(); // logo dropped, but name survives
    expect(kit.name).toBe('Acme');
  });

  it('drops an external-URL logo (SSRF / non-determinism)', () => {
    const kit = sanitizeBrandKit({ logoUrl: 'https://evil.example.com/logo.png', name: 'Acme' });
    expect(kit.logoUrl).toBeUndefined();
  });

  it('drops an oversized logo (> 120KB)', () => {
    // ~135KB of decoded bytes — well over the 120KB cap.
    const big = 'data:image/png;base64,' + 'A'.repeat(184_000);
    const kit = sanitizeBrandKit({ logoUrl: big, name: 'Acme' });
    expect(kit.logoUrl).toBeUndefined();
  });

  it('length-caps text fields and validates hex colours', () => {
    const kit = sanitizeBrandKit({
      name: 'x'.repeat(500),
      tagline: 'y'.repeat(500),
      colors: { accent: '#12ab34', accentSecondary: 'not-a-hex' },
    });
    expect(kit.name.length).toBe(80);
    expect(kit.tagline.length).toBe(140);
    expect(kit.colors.accent).toBe('#12ab34');
    expect(kit.colors.accentSecondary).toBeUndefined();
  });

  it('rejects a fully-invalid colour object (no colors key)', () => {
    const kit = sanitizeBrandKit({ name: 'Acme', colors: { accent: 'blue' } });
    expect(kit.colors).toBeUndefined();
  });

  it('slugs socials, caps contact lines', () => {
    const kit = sanitizeBrandKit({
      name: 'Acme',
      socials: ['Insta gram!', 'face@book', 'x', 'y', 'z', 'a', 'b', 'overflow'],
      contact: ['+91 1', '+91 2', '+91 3', '+91 4', '+91 5', '+91 6'],
    });
    expect(kit.socials).toEqual(['instagram', 'facebook', 'x', 'y', 'z', 'a']); // slugged + capped to 6
    expect(kit.contact.length).toBe(4); // capped to 4 lines
  });

  it('clamps custom placement numbers and coerces an invalid corner to top-left', () => {
    const kit = sanitizeBrandKit({
      logoUrl: PNG_1x1,
      custom: {
        cover: { x: -5, y: 99, scale: 99 },
        interior: { corner: 'javascript:alert(1)', scale: 99 },
        backing: 'plate',
      },
    });
    expect(kit.custom).toBeDefined();
    expect(kit.custom.cover.x).toBe(0); // clamped to [0,1]
    expect(kit.custom.cover.y).toBe(1); // clamped to [0,1]
    expect(kit.custom.cover.scale).toBe(0.6); // clamped to COVER_SCALE.hi
    expect(kit.custom.interior.corner).toBe('top-left'); // invalid enum → fixed default
    expect(kit.custom.interior.scale).toBe(0.3); // clamped to INNER_SCALE.hi
    expect(kit.onDark).toBe(true); // backing:'plate' → onDark true
  });

  it('ignores custom placement when there is no logo to place', () => {
    const kit = sanitizeBrandKit({ name: 'Acme', custom: { cover: { x: 0.5, y: 0.3, scale: 0.2 } } });
    expect(kit.custom).toBeUndefined();
  });

  it('backing:"none" forces onDark false (logo as-uploaded)', () => {
    const kit = sanitizeBrandKit({
      logoUrl: PNG_1x1,
      custom: { interior: { corner: 'top-right', scale: 0.12 }, backing: 'none' },
    });
    expect(kit.onDark).toBe(false);
    expect(kit.custom.interior.corner).toBe('top-right');
  });
});
