/**
 * Brochure content + template model.
 *
 * The LLM (composer agent) emits a `BrochureContent` JSON object — NO HTML, no
 * CSS. Everything is optional and variable-length, so the same shape works for a
 * one-line prompt or a richly detailed multi-week itinerary. The render engine
 * (render-core.ts) fetches real assets from the queries/cities, picks a template
 * (a pure *style*), and flows the content across as many A4 pages as it needs.
 *
 * A template never hardcodes content — it owns the LOOK (fonts, palette strategy,
 * component treatments, cover layout). Content owns the WORDS and the structure.
 */

/** A photo card: a label + caption, plus a free-text image search query. */
export interface BrochureCard {
  label: string;
  caption?: string;
  /** Photo search query (e.g. "Kyoto Fushimi Inari torii gates"). Resolved server-side. */
  query?: string;
}

/** A label → value pair (inclusions, spec rows, "good to know" facts). */
export interface BrochureKV {
  k: string;
  v: string;
}

/** One itinerary day (or stage). */
export interface BrochureDay {
  title: string;
  text: string;
}

/**
 * A rich place block for the map page (banded family). Lets a city carry a
 * headline, a short description and an activities line — exactly the radiating
 * info blocks of the reference page 3. Falls back to a bare name if absent.
 */
export interface BrochurePlace {
  /** City/region name shown as the accent label, e.g. "Tokyo". */
  name: string;
  /** Bold sub-label, e.g. "Urban Intensity". */
  subtitle?: string;
  /** One short paragraph. */
  body?: string;
  /** Comma-joined activities line, e.g. "Shibuya, teamLab, Skytree". */
  activities?: string;
  /** Optional geocode hint if the name alone is ambiguous (e.g. "Nara, Japan"). */
  geo?: string;
}

/** One pricing row. `emphasize` renders the value in the display face. */
export interface BrochurePriceRow {
  label: string;
  value: string;
  emphasize?: boolean;
}

/**
 * A flexible extra section so a rich prompt can grow the brochure beyond the core
 * sections (dining, "good to know", why-us, gallery, testimonials, …). The engine
 * renders it generically in the active template's style.
 */
export interface BrochureSection {
  kicker?: string;
  heading?: string;
  body?: string;
  /** How to lay out this section's data. Defaults inferred from which field is set. */
  layout?: 'prose' | 'grid' | 'cards' | 'gallery';
  /** For layout 'grid' — two-column label/value rows. */
  items?: BrochureKV[];
  /** For layout 'cards' / 'gallery' — photo cards. */
  cards?: BrochureCard[];
  /** For layout 'prose' — bullet points under the body. */
  bullets?: string[];
}

/** The complete, structured brochure content. Every field is optional but `title`. */
export interface BrochureContent {
  /** Destination-derived palette. accent is the dominant brand colour (hex). */
  palette?: { accent?: string; accentSecondary?: string };

  // ---- Cover ----
  agencyName?: string;
  topLeft?: string;
  topRight?: string;
  preTitle?: string;
  title: string;
  subtitle?: string;
  /** Bold cover tagline line, e.g. "Where Precision Fuels Possibility". */
  tagline?: string;
  /** Big cover year/edition mark, e.g. "2026". */
  year?: string;
  /** e.g. "Tokyo — Hakone — Kyoto — Nara — Osaka". */
  routeLine?: string;
  badge?: string;
  /** e.g. "Bangalore · www.wanderlustjourneys.in". */
  agencyLine?: string;
  /** Image search query for the full-bleed cover hero. */
  heroQuery?: string;

  // ---- Intro band ----
  intro?: { kicker?: string; heading?: string; body?: string };

  // ---- Highlights grid ----
  highlights?: {
    kicker?: string;
    heading?: string;
    cards?: BrochureCard[];
    /** Optional accent stat tile, e.g. { big: "8", label: "Days of wonder" }. */
    stat?: { big: string; label: string };
  };

  // ---- Day-by-day itinerary ----
  itinerary?: { kicker?: string; heading?: string; days?: BrochureDay[] };

  // ---- Route map ----
  route?: {
    kicker?: string;
    heading?: string;
    cities?: string[];
    /** Big accent headline on the map page, e.g. "From neon cities to sacred landscapes". */
    headline?: string;
    /** Closing line on the map page's bottom ink band. */
    closing?: string;
    /** Rich per-place info blocks. If absent, blocks are derived from `cities`. */
    places?: BrochurePlace[];
  };

  // ---- Flexible extra sections (grow the page count for rich prompts) ----
  sections?: BrochureSection[];

  // ---- Inclusions / spec grid ----
  inclusions?: { kicker?: string; heading?: string; items?: BrochureKV[] };

  // ---- Pricing ----
  pricing?: { kicker?: string; heading?: string; rows?: BrochurePriceRow[]; note?: string };

  // ---- Footer / CTA ----
  footer?: {
    cta?: string;
    ctaSub?: string;
    contactLines?: string[];
    /** Accent-tick checklist (banded CTA block), e.g. orientation agenda items. */
    checklist?: string[];
    /** URL/text to encode into the QR code. */
    qrData?: string;
    /** Simple Icons slugs, e.g. ["instagram","whatsapp","facebook"]. */
    social?: string[];
  };
}

/** Cover layout archetypes the engine knows how to build. */
export type CoverMode =
  | 'photo-sun' // full-bleed hero + accent disc, centred lockup
  | 'editorial-split' // photo half + solid colour half, side lockup
  | 'poster-band' // flat banded travel-poster cover, centred wordmark
  | 'deco-arch' // symmetric arch frame over hero
  | 'minimal-type' // type-led, small photo strip, lots of air
  | 'bold-blocks' // oversized headline bleeding over hard colour blocks
  | 'wash' // soft gradient wash over a faded hero
  | 'filmstrip' // hero + a thin strip of secondary frames
  | 'passport' // framed "stamp" cover, boxed lockup
  | 'gradient-veil'; // cinematic dark gradient veil, bottom-left lockup

/**
 * A template = a pure visual style. It maps the destination accent to a full CSS
 * variable set (its palette strategy) and supplies the style's CSS. The engine
 * provides the structural skeleton + functional defaults; the template's CSS
 * gives it its identity.
 */
export interface BrochureTemplate {
  key: string;
  /** UI label. */
  name: string;
  /** One-line description for the picker. */
  blurb: string;
  /**
   * Layout family. 'flow' = the generic margined-flow engine (default, legacy
   * behaviour). 'banded' = the full-bleed composed-page "press banded" engine
   * (edge-to-edge colour bands, photo columns, signature map page). 'editorial' =
   * the premium magazine-editorial engine (cinematic masthead cover, numbered
   * section grammar, feature-spread highlights, accent pull-quote — a distinct
   * identity from the bold banded look).
   */
  family?: 'flow' | 'banded' | 'editorial';
  fonts: { display: string; body: string };
  /**
   * Optional elegant display face used ONLY for the cover wordmark (banded
   * family). Lets a bold-interior template open with a refined serif cover.
   * Defaults to an elegant serif if absent.
   */
  coverFont?: string;
  cover: CoverMode;
  /**
   * Map the destination accent (and optional secondary) → CSS custom-property
   * values. MUST return at least: --accent, --ink, --bg, --surface, --line,
   * --muted, --cover-bg. The engine fills the rest (shades, contrast) if absent.
   */
  theme: (accent: string, accentSecondary?: string) => Record<string, string>;
  /** Style-specific CSS appended after the base + theme vars. */
  css: string;
}
