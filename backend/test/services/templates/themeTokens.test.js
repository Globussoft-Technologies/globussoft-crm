// PR-E Phase 1 (Option B) — vitest coverage for the destination-
// agnostic theme token registry.
//
// What this exercises:
//   1. THEME_REGISTRY has the four declared families and their canonical
//      FAMILY-GENERIC style-bucket variants (no destination-named ids).
//   2. THEME_ALIASES route the legacy PR-E-pre-Option-B destination-
//      named ids (educational-japan, family-bali, religious-umrah,
//      luxury-switzerland, etc.) to their new style-bucket equivalents
//      so existing landing pages keep working without a data migration.
//   3. Lookup helpers (getTheme / getDefaultTheme / resolveTheme) work
//      for happy paths + miss/null cases.
//   4. resolveTheme is purely EXPLICIT — destination/subBrand strings
//      are ignored (Phase-2 Travel Experience Engine owns that mapping;
//      we don't want destination-keyword routing in two places).
//   5. renderThemeOverlayCss emits CSS with every variable the base
//      CSS reads via var(--*) — including the new clamp() typography
//      vars and the pattern-overlay url.
//   6. Each theme bundles the right shape and family-appropriate
//      decorative glyph (Arabic for religious; empty otherwise so no
//      destination-tied glyph is imposed).

import { describe, test, expect } from 'vitest';

const themeTokens = require('../../../services/templates/themeTokens');

describe('themeTokens — families + variants', () => {
  test('THEME_FAMILIES contains the four declared families', () => {
    expect(themeTokens.THEME_FAMILIES).toEqual(['educational', 'religious', 'family', 'luxury']);
  });

  test('every family has the canonical style-bucket variants (family-generic only)', () => {
    expect(themeTokens.THEME_VARIANTS_BY_FAMILY.educational).toEqual(['academic', 'modern', 'classical', 'tech']);
    expect(themeTokens.THEME_VARIANTS_BY_FAMILY.religious).toEqual(['classical', 'spiritual', 'premium']);
    expect(themeTokens.THEME_VARIANTS_BY_FAMILY.family).toEqual(['tropical', 'vibrant', 'resort']);
    expect(themeTokens.THEME_VARIANTS_BY_FAMILY.luxury).toEqual(['alpine', 'coastal', 'continental']);
  });

  test('every family has a default theme id', () => {
    for (const family of themeTokens.THEME_FAMILIES) {
      const defId = themeTokens.DEFAULT_THEME_BY_FAMILY[family];
      expect(typeof defId).toBe('string');
      expect(themeTokens.THEME_REGISTRY[defId]).toBeTruthy();
    }
  });

  test('no destination-named theme ids exist in the live registry', () => {
    // Architectural invariant: variant ids must NOT carry destination
    // names (japan / bali / umrah / switzerland / maldives / etc.).
    const FORBIDDEN_KEYWORDS = ['japan', 'singapore', 'umrah', 'hajj', 'jerusalem', 'bali', 'thailand', 'dubai', 'maldives', 'switzerland', 'europe', 'uk', 'stem'];
    for (const id of themeTokens.THEME_IDS) {
      const variant = id.split('-')[1];
      expect(FORBIDDEN_KEYWORDS).not.toContain(variant);
    }
  });

  test('THEME_REGISTRY entries are shaped consistently', () => {
    for (const id of themeTokens.THEME_IDS) {
      const theme = themeTokens.THEME_REGISTRY[id];
      expect(theme.id).toBe(id);
      expect(themeTokens.THEME_FAMILIES).toContain(theme.family);
      expect(typeof theme.variant).toBe('string');
      expect(theme.palette).toBeTruthy();
      ['bg', 'ink', 'muted', 'accent', 'accentDeep', 'secondary', 'line', 'card', 'dark', 'darkInk'].forEach((k) => {
        expect(typeof theme.palette[k]).toBe('string');
        expect(theme.palette[k]).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      });
      expect(theme.typography).toBeTruthy();
      expect(typeof theme.typography.serif).toBe('string');
      expect(typeof theme.typography.sans).toBe('string');
      expect(typeof theme.typography.h1Size).toBe('string');
      expect(theme.typography.h1Size).toContain('clamp(');
      expect(Array.isArray(theme.sectionOrder)).toBe(true);
      expect(theme.sectionOrder.length).toBeGreaterThan(5);
      expect(theme.sectionOrder[0]).toBe('nav');
      expect(theme.sectionOrder[1]).toBe('hero');
      expect(theme.icons).toBeTruthy();
    }
  });

  test('all four families share the same shell sections but differ in composition order', () => {
    const edu = themeTokens.THEME_REGISTRY['educational-academic'].sectionOrder;
    const rel = themeTokens.THEME_REGISTRY['religious-classical'].sectionOrder;
    const fam = themeTokens.THEME_REGISTRY['family-tropical'].sectionOrder;
    const lux = themeTokens.THEME_REGISTRY['luxury-alpine'].sectionOrder;
    expect(edu).toContain('floatingCta');
    expect(rel).toContain('floatingCta');
    expect(fam).toContain('floatingCta');
    expect(lux).toContain('floatingCta');
    expect(edu).toContain('finalCta');
    expect(lux).not.toContain('programme');
    expect(lux).not.toContain('brochure');
    expect(lux).not.toContain('details');
    expect(fam.indexOf('marquee')).toBeLessThan(fam.indexOf('safety'));
  });
});

describe('themeTokens.getTheme', () => {
  test('returns theme for known id', () => {
    const t = themeTokens.getTheme('educational-academic');
    expect(t).toBeTruthy();
    expect(t.id).toBe('educational-academic');
    expect(t.family).toBe('educational');
  });

  test('returns null for unknown id, non-string input', () => {
    expect(themeTokens.getTheme('not-a-theme')).toBeNull();
    expect(themeTokens.getTheme(null)).toBeNull();
    expect(themeTokens.getTheme(undefined)).toBeNull();
    expect(themeTokens.getTheme(123)).toBeNull();
  });

  test('THEME_ALIASES route legacy destination-named ids to style buckets', () => {
    // Backwards compat — any landing page persisted with the PR-E-pre-
    // Option-B destination-named id still loads correctly.
    expect(themeTokens.getTheme('educational-japan').id).toBe('educational-academic');
    expect(themeTokens.getTheme('educational-singapore').id).toBe('educational-modern');
    expect(themeTokens.getTheme('educational-uk').id).toBe('educational-classical');
    expect(themeTokens.getTheme('educational-stem').id).toBe('educational-tech');
    expect(themeTokens.getTheme('religious-umrah').id).toBe('religious-classical');
    expect(themeTokens.getTheme('religious-hajj').id).toBe('religious-spiritual');
    expect(themeTokens.getTheme('religious-jerusalem').id).toBe('religious-premium');
    expect(themeTokens.getTheme('family-bali').id).toBe('family-tropical');
    expect(themeTokens.getTheme('family-thailand').id).toBe('family-vibrant');
    expect(themeTokens.getTheme('family-dubai').id).toBe('family-resort');
    expect(themeTokens.getTheme('luxury-maldives').id).toBe('luxury-coastal');
    expect(themeTokens.getTheme('luxury-switzerland').id).toBe('luxury-alpine');
    expect(themeTokens.getTheme('luxury-europe').id).toBe('luxury-continental');
  });
});

describe('themeTokens.getDefaultTheme', () => {
  test('returns family-generic default theme', () => {
    expect(themeTokens.getDefaultTheme('educational').id).toBe('educational-academic');
    expect(themeTokens.getDefaultTheme('religious').id).toBe('religious-classical');
    expect(themeTokens.getDefaultTheme('family').id).toBe('family-tropical');
    expect(themeTokens.getDefaultTheme('luxury').id).toBe('luxury-alpine');
  });

  test('falls back to educational-academic on unknown family', () => {
    expect(themeTokens.getDefaultTheme('unknown').id).toBe('educational-academic');
    expect(themeTokens.getDefaultTheme(null).id).toBe('educational-academic');
  });
});

describe('themeTokens.resolveTheme — EXPLICIT inputs only, no destination keyword routing', () => {
  test('explicit themeId wins (direct hit)', () => {
    expect(themeTokens.resolveTheme({ themeId: 'luxury-coastal' }).id).toBe('luxury-coastal');
    expect(themeTokens.resolveTheme({ themeId: 'religious-premium' }).id).toBe('religious-premium');
  });

  test('explicit themeId resolves through THEME_ALIASES (legacy ids)', () => {
    expect(themeTokens.resolveTheme({ themeId: 'educational-japan' }).id).toBe('educational-academic');
    expect(themeTokens.resolveTheme({ themeId: 'family-bali' }).id).toBe('family-tropical');
  });

  test('exact family+variant match wins', () => {
    expect(themeTokens.resolveTheme({ family: 'educational', variant: 'modern' }).id).toBe('educational-modern');
    expect(themeTokens.resolveTheme({ family: 'religious', variant: 'premium' }).id).toBe('religious-premium');
    expect(themeTokens.resolveTheme({ family: 'luxury', variant: 'continental' }).id).toBe('luxury-continental');
  });

  test('family default fills when variant missing', () => {
    expect(themeTokens.resolveTheme({ family: 'family' }).id).toBe('family-tropical');
    expect(themeTokens.resolveTheme({ family: 'luxury' }).id).toBe('luxury-alpine');
  });

  test('destination strings are IGNORED — no keyword routing here', () => {
    // The whole point of Option B: this layer never inspects
    // destination strings. The Phase-2 Travel Experience Engine owns
    // the destination → (family, variant) mapping. Passing a
    // destination without an explicit family must NOT auto-route.
    expect(themeTokens.resolveTheme({ destination: 'Tokyo Japan' }).id).toBe('educational-academic');
    expect(themeTokens.resolveTheme({ destination: 'Umrah Mecca Madinah' }).id).toBe('educational-academic');
    expect(themeTokens.resolveTheme({ destination: 'Bali' }).id).toBe('educational-academic');
    expect(themeTokens.resolveTheme({ destination: 'Switzerland' }).id).toBe('educational-academic');
    // subBrand also ignored — no `rfu → religious-umrah` shortcut here.
    expect(themeTokens.resolveTheme({ subBrand: 'rfu' }).id).toBe('educational-academic');
  });

  test('returns a theme even for completely empty input (educational-academic default)', () => {
    expect(themeTokens.resolveTheme({}).id).toBe('educational-academic');
    expect(themeTokens.resolveTheme().id).toBe('educational-academic');
  });
});

describe('themeTokens.renderThemeOverlayCss', () => {
  test('returns CSS with every variable the base + polish CSS expects', () => {
    const theme = themeTokens.getTheme('religious-classical');
    const css = themeTokens.renderThemeOverlayCss(theme);
    expect(css).toContain('.trips-page');
    expect(css).toContain('--bg:');
    expect(css).toContain('--ink:');
    expect(css).toContain('--red:');
    expect(css).toContain('--gold:');
    expect(css).toContain('--card:');
    expect(css).toContain('--serif:');
    expect(css).toContain('--sans:');
    expect(css).toContain('--surface-color');
    expect(css).toContain('--text-primary');
    // PR-E Phase 1.5 new typography vars
    expect(css).toContain('--h1-size:');
    expect(css).toContain('clamp(');
    expect(css).toContain('--h1-style:');
    expect(css).toContain('--h1-weight:');
    // PR-E Phase 1.5 pattern-overlay var
    expect(css).toContain('--ornament-pattern:');
    // Religious palette injects emerald secondary.
    expect(css).toContain('#1d6e54');
  });

  test('luxury overlay adds family-specific dark-on-dark override blocks', () => {
    const theme = themeTokens.getTheme('luxury-alpine');
    const css = themeTokens.renderThemeOverlayCss(theme);
    expect(css).toMatch(/\.trips-page\s+\.t-hero/);
    expect(css).toContain('.t-final-cta'); // luxury also styles finalCta on dark
  });

  test('returns empty string for null/undefined theme', () => {
    expect(themeTokens.renderThemeOverlayCss(null)).toBe('');
    expect(themeTokens.renderThemeOverlayCss(undefined)).toBe('');
    expect(themeTokens.renderThemeOverlayCss({})).toBe('');
  });

  test('ornament pattern URL is inlined for themes that opt in', () => {
    const edu = themeTokens.renderThemeOverlayCss(themeTokens.getTheme('educational-academic'));
    expect(edu).toContain("data:image/svg+xml"); // shippo pattern
    const luxury = themeTokens.renderThemeOverlayCss(themeTokens.getTheme('luxury-alpine'));
    // Luxury opts out of pattern overlay — should be 'none' or empty.
    expect(luxury).toContain('--ornament-pattern: none');
  });
});

describe('themeTokens — decorative + iconography (family-feel, not destination-feel)', () => {
  test('educational themes carry NO decorative glyph (avoid imposing destination-tied script)', () => {
    expect(themeTokens.THEME_REGISTRY['educational-academic'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['educational-modern'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['educational-classical'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['educational-tech'].decorative.brand).toBe('');
  });

  test('religious themes carry Arabic devotional script (religion-tied, not destination-tied)', () => {
    expect(themeTokens.THEME_REGISTRY['religious-classical'].decorative.brand).toBe('الحج');
    expect(themeTokens.THEME_REGISTRY['religious-classical'].decorative.watermark).toBe('الإيمان');
    expect(themeTokens.THEME_REGISTRY['religious-spiritual'].decorative.brand).toBe('الحج');
    expect(themeTokens.THEME_REGISTRY['religious-premium'].decorative.brand).toBe('سلام');
  });

  test('family + luxury themes carry empty decorative glyph by default', () => {
    expect(themeTokens.THEME_REGISTRY['family-tropical'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['family-vibrant'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['family-resort'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['luxury-alpine'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['luxury-coastal'].decorative.brand).toBe('');
    expect(themeTokens.THEME_REGISTRY['luxury-continental'].decorative.brand).toBe('');
  });

  test('religious themes share Islamic-pilgrimage iconography (no destination coupling)', () => {
    const t = themeTokens.THEME_REGISTRY['religious-classical'];
    expect(t.icons.cultural_kaaba).toContain('<svg');
    expect(t.icons.cultural_mosque).toContain('<svg');
    expect(t.icons.cultural_minaret).toContain('<svg');
    expect(t.icons.cultural_dome).toContain('<svg');
  });

  test('family-tropical icons are tropical-feel (palm + temple + wave) — works for Bali / Vietnam / Kerala / NZ tropic', () => {
    const t = themeTokens.THEME_REGISTRY['family-tropical'];
    expect(t.icons.cultural_palm).toContain('<svg');
    expect(t.icons.cultural_temple).toContain('<svg');
    expect(t.icons.cultural_wave).toContain('<svg');
  });

  test('luxury-alpine icons are alpine-feel (alps + chalet + lake) — works for Switzerland / Iceland / Norway / NZ alpine', () => {
    const t = themeTokens.THEME_REGISTRY['luxury-alpine'];
    expect(t.icons.cultural_alps).toContain('<svg');
    expect(t.icons.cultural_chalet).toContain('<svg');
    expect(t.icons.cultural_lake).toContain('<svg');
  });
});
