/**
 * Brochure style catalog — pure config/data, no runtime/engine logic.
 *
 * The single source of truth for selectable design styles. Consumed by:
 *  - the runs API (allowlist a styleKey against a pack's finalize.styles),
 *  - the orchestrator (resolveArtDirection -> wrapArtDirection -> injected into
 *    the finalize agent's system prompt as a SELECTED ART DIRECTION block),
 *  - the web /api/sectors route (BROCHURE_STYLE_LIST -> picker labels).
 *
 * Each `artDirection` is a complete, self-contained design brief the designer
 * follows verbatim (palette, 2 Google fonts, imagery incl. Pollinations prompt
 * suffix, layout, inline-SVG accents). Structural invariants (single self-
 * contained HTML, @page A4 full-bleed cover, gradient-wrapped images,
 * completeness-first) remain owned by the designer's system prompt — these
 * briefs only drive the *look*.
 */

export const STYLE_KEYS = [
  'auto',
  'vintage-poster',
  'luxury-magazine',
  'modern-minimal',
  'art-deco',
  'bold-contemporary',
  'botanical-watercolor',
] as const;

export type StyleKey = (typeof STYLE_KEYS)[number];

/**
 * Brochure-ENGINE template picker metadata (the `brochure_json` finalize path).
 * Unlike the art-direction styles above (which drive an HTML designer's prompt),
 * these are TEMPLATE keys selected at RENDER time — the template owns the look,
 * the engine owns layout/pagination. Kept as static metadata so this package need
 * not depend on @agentic-os/tools. KEEP IN SYNC with tools' brochure TEMPLATES.
 */
export interface BrochureTemplateStyle {
  key: string;
  name: string;
  blurb: string;
}

export const BROCHURE_TEMPLATE_STYLES: BrochureTemplateStyle[] = [
  {
    key: 'tmc-press',
    name: 'TMC Press',
    blurb: 'Bold full-bleed banded poster — edge-to-edge colour blocks, a dotted timeline and a signature map page. Adapts its colour to any destination.',
  },
  {
    key: 'editorial-sakura',
    name: 'Editorial Sakura',
    blurb: 'Premium magazine editorial — a cinematic masthead cover, numbered sections, a feature spread and a saturated pull-quote on warm cream paper. Refined, clean, the accent made to pop. Adapts to any destination.',
  },
];

export const BROCHURE_TEMPLATE_KEYS: string[] = BROCHURE_TEMPLATE_STYLES.map((t) => t.key);
export const DEFAULT_BROCHURE_TEMPLATE_KEY = 'tmc-press';

export interface BrochureStyle {
  key: StyleKey;
  /** Human-facing label for the UI picker. */
  name: string;
  /** Self-contained art-direction brief the designer follows verbatim. */
  artDirection: string;
}

export const DEFAULT_STYLE_KEY: StyleKey = 'auto';

export const BROCHURE_STYLES: Record<StyleKey, BrochureStyle> = {
  'auto': {
    key: 'auto',
    name: 'Auto (best for destination)',
    artDirection:
      "AUTO: Choose the single aesthetic that best fits THIS destination and trip mood from these families — vintage travel poster, luxury magazine, modern minimal, art deco, bold contemporary, botanical watercolour. Pick ONE and commit fully; do NOT blend. Derive the palette from the destination's mood/colours the researcher gave you; pair an elegant DISPLAY font with a clean SANS via Google Fonts; hero = cinematic full-bleed Pollinations image, spots = additional Pollinations images with specific prompts (loremflickr only as a last resort, with 3+ specific tags), each gradient-wrapped. Strong type hierarchy, generous rhythm, destination-appropriate inline-SVG accents. Justify nothing in the output — just execute the chosen look.",
  },
  'vintage-poster': {
    key: 'vintage-poster',
    name: 'Vintage Travel Poster',
    artDirection:
      "VINTAGE TRAVEL POSTER (1930s-50s railway/airline). Palette: 3-4 flat screen-print colours (mustard, dusty teal, burnt-orange, cream) + deep ink outlines; no photo gradients on the cover. Fonts: a condensed/slab display ('Alfa Slab One' or 'Oswald') + body 'Work Sans'. Imagery: STYLISED Pollinations hero (append suffix 'vintage travel poster, flat screenprint, limited palette, WPA style'); duotone any loremflickr photos and prefer flat colour blocks over photos. Layout: full-bleed banded/arched poster cover with a strong horizon line, bold centred wordmark, thin keylines; content uses flat colour blocks + ticket-stub motifs. Inline-SVG: sunbursts, mountain silhouettes, dashed travel routes.",
  },
  'luxury-magazine': {
    key: 'luxury-magazine',
    name: 'Luxury Magazine Editorial',
    artDirection:
      "LUXURY MAGAZINE EDITORIAL (Conde Nast Traveler). Palette: ivory/charcoal near-mono + ONE jewel accent (emerald/sapphire/oxblood) + a thin gold rule (#C9A227). Fonts: 'Playfair Display' + 'Inter'. Imagery: cinematic full-bleed Pollinations hero (suffix 'luxury travel editorial, cinematic, golden hour, magazine cover') + large loremflickr spreads. Layout: asymmetric editorial grid, generous white margins, drop-cap intro, small-caps kickers, hairline gold dividers, slim caption columns. Inline-SVG: thin gold dividers, minimal monogram.",
  },
  'modern-minimal': {
    key: 'modern-minimal',
    name: 'Modern Minimal',
    artDirection:
      "MODERN MINIMAL (Swiss/Kinfolk calm). Palette: white/off-white, soft greys, ONE muted accent (sage/terracotta/sky). Fonts: 'Fraunces' + 'Manrope', 2-3 weights with big size jumps for hierarchy. Imagery: airy light-toned Pollinations hero (suffix 'minimal, bright, airy, soft natural light, negative space') used sparingly — NOT dense full-bleed. Layout: spacious left-aligned grid, generous margins, restrained colour blocks, large readable type, thin hairline rules, no ornament. Inline-SVG: ultra-thin lines, a single small geometric mark.",
  },
  'art-deco': {
    key: 'art-deco',
    name: 'Art Deco',
    artDirection:
      "ART DECO (1920s Gatsby / Orient-Express). Palette: black/deep-navy + gold/brass + cream, strong metallic contrast, optional jewel accent (emerald/sapphire). Fonts: a geometric deco display ('Poiret One' or 'Cinzel') + 'Josefin Sans'. Imagery: glamorous symmetrical Pollinations hero (suffix 'art deco, 1920s, gold geometric, glamorous, symmetrical'). Layout: vertical symmetry, geometric gold frames, stepped/chevron borders, tall geometric-arch cover, centred lockups. Inline-SVG: chevrons, sunburst fans, ziggurat borders, gold linework.",
  },
  'bold-contemporary': {
    key: 'bold-contemporary',
    name: 'Bold Contemporary',
    artDirection:
      "BOLD CONTEMPORARY (high-energy editorial-tech). Palette: 2-3 saturated high-contrast colours (electric blue / hot coral / lime) on white or near-black; confident blocking. Fonts: a heavy modern grotesque ('Archivo Black' or 'Anton') + 'Space Grotesk'. Imagery: punchy Pollinations hero (suffix 'vibrant, high contrast, bold modern travel, saturated') + duotone-treated loremflickr photos in hard-edged blocks. Layout: oversized headlines that bleed off-edge, diagonal/overlapping blocks, big day-numerals, energetic full-bleed cover. Inline-SVG: thick bars, arrows, oversized index numbers.",
  },
  'botanical-watercolor': {
    key: 'botanical-watercolor',
    name: 'Botanical Watercolor',
    artDirection:
      "BOTANICAL WATERCOLOUR (soft hand-painted organic). Palette: muted naturals (sage, blush, sand, dusty blue) with CSS washes; deep slate text, no hard black. Fonts: 'Cormorant Garamond' + 'Lato'. Imagery: painterly Pollinations hero (suffix 'watercolour illustration, botanical, soft washes, hand-painted, delicate'); soften/fade any photo edges with light overlays. Layout: soft full-bleed wash cover (CSS radial/linear gradients blended), framed botanical borders, airy content pages, rounded dividers. Inline-SVG: hand-drawn leaves/vines, low-opacity radial watercolour blobs, floral corners.",
  },
};

/** Ordered list for UI pickers (preserves STYLE_KEYS order, 'auto' first). */
export const BROCHURE_STYLE_LIST: BrochureStyle[] = STYLE_KEYS.map((k) => BROCHURE_STYLES[k]);

/** Narrowing guard for an arbitrary string. */
export function isStyleKey(s: string): s is StyleKey {
  return (STYLE_KEYS as readonly string[]).includes(s);
}

/**
 * Resolve a (possibly absent/invalid) style key to its art-direction brief.
 * Falls back to 'auto' for defense-in-depth (the API already allowlists keys).
 */
export function resolveArtDirection(styleKey?: string): string {
  const key: StyleKey = styleKey && isStyleKey(styleKey) ? styleKey : DEFAULT_STYLE_KEY;
  return BROCHURE_STYLES[key].artDirection;
}

/**
 * The phrase designer prompts reference and the wrapper below emits. Centralized
 * here so the orchestrator's injected block and the designer prompts can never
 * drift out of sync (a silent total-style-collapse bug). Designer prompts should
 * say they will receive a "SELECTED ART DIRECTION" block.
 */
export const ART_DIRECTION_HEADER = 'SELECTED ART DIRECTION';

/**
 * Wrap an art-direction brief in the delimited block the orchestrator appends to
 * the designer's system prompt. The orchestrator must NOT hand-write the header —
 * it calls this so the contract stays structural, not prose-coordinated.
 */
export function wrapArtDirection(artDirection: string): string {
  return `\n\n===== ${ART_DIRECTION_HEADER} (FOLLOW THIS EXACTLY) =====\n${artDirection}\n${'='.repeat(ART_DIRECTION_HEADER.length + 32)}`;
}
