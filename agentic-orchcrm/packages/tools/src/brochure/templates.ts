/**
 * The brochure template catalog — 10 distinct visual styles. Each is a pure
 * LOOK: fonts, a palette strategy (destination accent → CSS vars), a cover
 * archetype, and a small signature CSS block layered over the var-driven base in
 * render-core.ts. Content is never hardcoded here.
 */
import type { BrochureTemplate } from './types.js';
import { darken, lighten, contrastInk } from './render-core.js';

export const TEMPLATES: Record<string, BrochureTemplate> = {
  // 0) TMC Press — the agency reference: full-bleed banded poster, edge-to-edge
  //    colour bands, dotted timeline, signature map page. Adaptive to any accent.
  'tmc-press': {
    key: 'tmc-press',
    name: 'TMC Press',
    blurb: 'Bold full-bleed banded poster — edge-to-edge colour blocks, photo columns, a dotted timeline and a signature map page. Anton + Mulish.',
    family: 'banded',
    fonts: { display: 'Anton', body: 'Mulish' },
    // Elegant serif cover wordmark (refined cover → bold interior bands).
    coverFont: 'Playfair Display',
    cover: 'photo-sun',
    // Return {} so the engine's bandedScheme(accent) drives the whole 3-tone palette.
    theme: () => ({}),
    css: `
.tl .t{letter-spacing:.015em}
`,
  },

  // 1) Editorial Sakura — premium magazine editorial (the `editorial` family).
  //    A DISTINCT identity from TMC's bold banded poster: a cinematic masthead
  //    cover, numbered section grammar, a feature-spread, big accent day-numerals
  //    and a saturated pull-quote — warm cream paper, the accent pushed to POP.
  //    The engine (EDITORIAL_CSS + editorialScheme) owns the look; this entry
  //    only names the fonts and lets the accent come from the destination.
  'editorial-sakura': {
    key: 'editorial-sakura',
    name: 'Editorial Sakura',
    blurb: 'Premium magazine editorial — cinematic masthead cover, numbered sections, a feature spread, big accent day-numerals and a saturated pull-quote. Warm cream paper, the accent made to pop. Playfair Display + Inter.',
    family: 'editorial',
    fonts: { display: 'Playfair Display', body: 'Inter' },
    cover: 'photo-sun', // unused by the editorial engine (it has its own cover) — kept for the type.
    // Return {} so the engine's editorialScheme(accent) drives the whole palette
    // from the destination accent. Override a var here only to re-tune the look.
    theme: () => ({}),
    css: ``,
  },
};

export const DEFAULT_TEMPLATE_KEY = 'tmc-press';

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);

export function getTemplate(key?: string): BrochureTemplate {
  return (key && TEMPLATES[key]) || TEMPLATES[DEFAULT_TEMPLATE_KEY] || Object.values(TEMPLATES)[0]!;
}

export interface TemplateSummary {
  key: string;
  name: string;
  blurb: string;
}

export const TEMPLATE_LIST: TemplateSummary[] = Object.values(TEMPLATES).map((t) => ({
  key: t.key,
  name: t.name,
  blurb: t.blurb,
}));

// Re-export colour helpers so templates can derive shades in their theme().
export { darken, lighten, contrastInk };
