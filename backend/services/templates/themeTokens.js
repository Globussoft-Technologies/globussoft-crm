/**
 * themeTokens.js — PR-E Phase 1 (Option B refactor).
 *
 * Theme registry for the destination-agnostic Travel Experience Engine.
 * Defines four template families (educational / religious / family /
 * luxury) and a SMALL number of STYLE-BUCKET variants per family. Theme
 * variant IDs are family-generic — never destination-tied — so any new
 * destination (Iceland, Vietnam, Turkey, Egypt, Kerala, …) inherits a
 * sensible look just by picking a variant that matches its "feel":
 *
 *    educational-academic    — structured, achievement-oriented (Japan-style)
 *    educational-modern      — clean, contemporary, urban
 *    educational-classical   — collegiate, traditional, navy + brass
 *    educational-tech        — STEM, electric-blue + mint
 *
 *    religious-classical     — warm gold + emerald (the Umrah/Madinah palette)
 *    religious-spiritual     — antique gold, deeper devotional
 *    religious-premium       — olive limestone, refined
 *
 *    family-tropical         — coral + tropical teal (Bali / Vietnam / NZ tropic)
 *    family-vibrant          — saffron + jade (busier, photo-rich)
 *    family-resort           — desert sand + gulf blue (Dubai / Egypt / Morocco)
 *
 *    luxury-alpine           — alpine night charcoal + champagne (Switzerland /
 *                              Iceland / Norway / NZ alpine)
 *    luxury-coastal          — deep ocean charcoal + lagoon teal (Maldives /
 *                              Greek isles / Caribbean)
 *    luxury-continental      — continental charcoal + burnished gold + burgundy
 *                              (Europe / Turkey ancient cities)
 *
 * Each theme is a pure-data bundle:
 *   • palette     — CSS variable values (--bg / --ink / --accent / etc.)
 *   • typography  — serif / sans font stacks + headline weight
 *   • decorative  — brand-watermark glyph (Arabic for religious family;
 *                   empty by default for educational/family/luxury so no
 *                   destination-tied glyph is ever imposed). Pattern-
 *                   overlay variant (shippo / arabesque / wave / rule /
 *                   none) the renderer can pick by name.
 *   • sectionOrder — default section composition for this family
 *   • iconLibrary  — family-generic SVG glyphs the theme registers with
 *                   the universal SVG library. Iconography is grouped by
 *                   FAMILY FEEL, not by destination:
 *                     religious  → kaaba / mosque / minaret / dome
 *                     family-tropical → palm / temple / wave
 *                     family-resort   → dune / falcon / arch
 *                     luxury-alpine   → alps / chalet / lake
 *                     luxury-coastal  → overwater / palmcoast
 *                     luxury-continental → arch / villa
 *                   Operators / Phase-2 AI pick icon IDs by feel.
 *
 * Public surface
 * ──────────────
 *   THEME_FAMILIES         — array of family ids ('educational' / …)
 *   THEME_VARIANTS_BY_FAMILY — { family: [variantId, …] }
 *   THEME_REGISTRY         — full theme map { themeId: themeObject }
 *   DEFAULT_THEME_BY_FAMILY — { family: themeId }
 *   THEME_ALIASES          — { oldName: newName } so existing pages
 *                            persisted with PR-E-pre-Option-B variant
 *                            ids (educational-japan, family-bali,
 *                            religious-umrah, luxury-switzerland, etc.)
 *                            keep resolving without a data migration
 *   getTheme(themeId)      — lookup; honours aliases; null on miss
 *   getDefaultTheme(family) — family default, or educational-academic
 *   resolveTheme(input)    — picks (family, variant) from explicit
 *                            inputs. NO destination-keyword routing —
 *                            that is the Phase-2 Travel Experience
 *                            Engine's job; this function only handles
 *                            the explicit "operator/AI passed a theme
 *                            id" case + family-default fallback.
 *   renderThemeOverlayCss(theme) — emits the inline CSS variable
 *                            overlay block + family-specific style
 *                            tweaks. The renderer inlines this after
 *                            the base CSS.
 */

'use strict';

// ── FAMILY-LEVEL CONSTANTS ──────────────────────────────────────────

const THEME_FAMILIES = Object.freeze([
  'educational',
  'religious',
  'family',
  'luxury',
]);

// ── PALETTES ────────────────────────────────────────────────────────
// CSS variable bundles. The base template CSS consumes these via
// var(--*). Adding a variant is a one-entry edit; renderer untouched.

const PALETTES = Object.freeze({
  // ── Educational ─────────────────────────────────────────────────
  'educational-academic': {
    // The Japan-reference palette — preserved exactly so the existing
    // /trips visual benchmark is unchanged when this is the default.
    bg: '#f4efe6', bgAlt: '#faf6ee', bgBand: '#f4e8e4',
    ink: '#1f1a17', inkSoft: '#3a322c', muted: '#6f655c',
    accent: '#c0392b', accentDeep: '#9c2b20',
    secondary: '#b8893b', secondaryDeep: '#8f6a2d',
    line: '#e3d9c8', card: '#fffdf8',
    dark: '#1a1f2e', darkInk: '#e8dfd4', darkMuted: '#a99e92',
    btnDark: '#1f2430', btnDarkHover: '#11151d',
    btnTeal: '#3d8580', btnTealHover: '#2f6e6a',
  },
  'educational-modern': {
    bg: '#f1f3f5', bgAlt: '#fafbfc', bgBand: '#e6eef5',
    ink: '#0d1d33', inkSoft: '#28415e', muted: '#5b6b80',
    accent: '#bc1f2c', accentDeep: '#8e1620',
    secondary: '#ce9a3d', secondaryDeep: '#a17628',
    line: '#d6dde3', card: '#ffffff',
    dark: '#0f1c2e', darkInk: '#e2e8ee', darkMuted: '#9eabba',
    btnDark: '#172537', btnDarkHover: '#0a1322',
    btnTeal: '#1e6e7a', btnTealHover: '#15555f',
  },
  'educational-classical': {
    bg: '#f6f3ee', bgAlt: '#fcfaf6', bgBand: '#ece6db',
    ink: '#1c2a3c', inkSoft: '#3a4757', muted: '#6b7488',
    accent: '#1d3a6e', accentDeep: '#142a52',
    secondary: '#a87a3a', secondaryDeep: '#7e5a2a',
    line: '#dcd4c7', card: '#ffffff',
    dark: '#152033', darkInk: '#dde5ef', darkMuted: '#9aa6b8',
    btnDark: '#1a2436', btnDarkHover: '#0d1422',
    btnTeal: '#386b75', btnTealHover: '#28525a',
  },
  'educational-tech': {
    bg: '#f3f5f8', bgAlt: '#fbfcfd', bgBand: '#e6ecf4',
    ink: '#0f1c33', inkSoft: '#2a3a5a', muted: '#5a667c',
    accent: '#1561c4', accentDeep: '#0d4793',
    secondary: '#16b29a', secondaryDeep: '#0e8772',
    line: '#d6dde7', card: '#ffffff',
    dark: '#0b1530', darkInk: '#dee5ef', darkMuted: '#94a1b8',
    btnDark: '#142242', btnDarkHover: '#08132a',
    btnTeal: '#0d8a9a', btnTealHover: '#066875',
  },

  // ── Religious — warm-gold and emerald, regardless of destination ─
  'religious-classical': {
    bg: '#faf6ec', bgAlt: '#fffaf0', bgBand: '#f3eadc',
    ink: '#2a2014', inkSoft: '#4a3a26', muted: '#7a6b56',
    accent: '#a37f29', accentDeep: '#7a5e1c',
    secondary: '#1d6e54', secondaryDeep: '#114a3a',
    line: '#e8dcc1', card: '#fffdf6',
    dark: '#1a1308', darkInk: '#f0e3c2', darkMuted: '#b8a87c',
    btnDark: '#241a0e', btnDarkHover: '#120a04',
    btnTeal: '#1d6e54', btnTealHover: '#114a3a',
  },
  'religious-spiritual': {
    bg: '#f7f2e6', bgAlt: '#fffaf0', bgBand: '#efe7d2',
    ink: '#1f180e', inkSoft: '#3d3018', muted: '#796a4f',
    accent: '#8a6a1a', accentDeep: '#5e4810',
    secondary: '#154a3b', secondaryDeep: '#0a3025',
    line: '#e3d6b5', card: '#fffef7',
    dark: '#16100a', darkInk: '#ede0bd', darkMuted: '#b09c70',
    btnDark: '#1f1809', btnDarkHover: '#0e0a04',
    btnTeal: '#154a3b', btnTealHover: '#0a3025',
  },
  'religious-premium': {
    bg: '#f3eee2', bgAlt: '#faf6ec', bgBand: '#e8dec6',
    ink: '#2a2218', inkSoft: '#4a3d2a', muted: '#7a6c54',
    accent: '#9c6f2a', accentDeep: '#75521c',
    secondary: '#3a5942', secondaryDeep: '#243829',
    line: '#dccdaa', card: '#fffcf2',
    dark: '#1e1810', darkInk: '#e8d9b5', darkMuted: '#b09c75',
    btnDark: '#241c10', btnDarkHover: '#120d05',
    btnTeal: '#3a5942', btnTealHover: '#243829',
  },

  // ── Family — vibrant, photo-friendly ────────────────────────────
  'family-tropical': {
    bg: '#fff8f0', bgAlt: '#ffffff', bgBand: '#ffe9d3',
    ink: '#2a1a0d', inkSoft: '#4a2e1b', muted: '#7a5f4a',
    accent: '#e85a3c', accentDeep: '#b8401f',
    secondary: '#1ea58a', secondaryDeep: '#127361',
    line: '#f3d9be', card: '#ffffff',
    dark: '#2a1a0d', darkInk: '#fde6cc', darkMuted: '#c4a37e',
    btnDark: '#2a1a0d', btnDarkHover: '#170a04',
    btnTeal: '#1ea58a', btnTealHover: '#127361',
  },
  'family-vibrant': {
    bg: '#fff7ec', bgAlt: '#fffefb', bgBand: '#ffe5c6',
    ink: '#2a1607', inkSoft: '#4a2c14', muted: '#7a5b3d',
    accent: '#e0992a', accentDeep: '#a76d14',
    secondary: '#1d8a7a', secondaryDeep: '#0f5e54',
    line: '#f5dbb8', card: '#fffefa',
    dark: '#2a1607', darkInk: '#fde7c8', darkMuted: '#c19b6e',
    btnDark: '#2a1607', btnDarkHover: '#150900',
    btnTeal: '#1d8a7a', btnTealHover: '#0f5e54',
  },
  'family-resort': {
    bg: '#fbf5ec', bgAlt: '#ffffff', bgBand: '#f3e5cc',
    ink: '#1f1a14', inkSoft: '#3d3526', muted: '#736548',
    accent: '#d8a23a', accentDeep: '#a37520',
    secondary: '#1a6c8e', secondaryDeep: '#0d4660',
    line: '#ecd9b3', card: '#fffdf6',
    dark: '#1f1a14', darkInk: '#f5e6c2', darkMuted: '#c4ad7e',
    btnDark: '#231d14', btnDarkHover: '#100b05',
    btnTeal: '#1a6c8e', btnTealHover: '#0d4660',
  },

  // ── Luxury — dark, photography-first, restrained accent ─────────
  'luxury-alpine': {
    bg: '#11161d', bgAlt: '#1a212a', bgBand: '#22293a',
    ink: '#f4ece0', inkSoft: '#cbc3b6', muted: '#92897d',
    accent: '#c2a366', accentDeep: '#8e7440',
    secondary: '#4d7a99', secondaryDeep: '#2f5470',
    line: '#2c333d', card: '#1c232c',
    dark: '#0c1018', darkInk: '#ebe2cd', darkMuted: '#928879',
    btnDark: '#0c1018', btnDarkHover: '#05080d',
    btnTeal: '#4d7a99', btnTealHover: '#2f5470',
  },
  'luxury-coastal': {
    bg: '#0f1418', bgAlt: '#161c22', bgBand: '#1d262e',
    ink: '#f5ede0', inkSoft: '#cdc3b3', muted: '#8f8678',
    accent: '#c9a567', accentDeep: '#9a7b3f',
    secondary: '#3a8a8a', secondaryDeep: '#256565',
    line: '#2a323a', card: '#1a2026',
    dark: '#0a0e12', darkInk: '#e8dfc8', darkMuted: '#8f8676',
    btnDark: '#0a0e12', btnDarkHover: '#04060a',
    btnTeal: '#3a8a8a', btnTealHover: '#256565',
  },
  'luxury-continental': {
    bg: '#13181f', bgAlt: '#1c232b', bgBand: '#252d38',
    ink: '#f3ead8', inkSoft: '#cbc1ad', muted: '#928775',
    accent: '#b89860', accentDeep: '#8a703a',
    secondary: '#6e3a3a', secondaryDeep: '#4e2424',
    line: '#2e353f', card: '#1e252e',
    dark: '#0d1118', darkInk: '#ece2cc', darkMuted: '#90877a',
    btnDark: '#0d1118', btnDarkHover: '#06080c',
    btnTeal: '#6e3a3a', btnTealHover: '#4e2424',
  },
});

// ── TYPOGRAPHY (family-level) ───────────────────────────────────────

const TYPOGRAPHY = Object.freeze({
  educational: {
    serif: "Georgia, 'Times New Roman', serif",
    sans: "'Helvetica Neue', Arial, sans-serif",
    headlineWeight: 400, bodyWeight: 400, letterSpacing: 'normal',
    h1Size: 'clamp(2.4rem, 5.4vw, 4.2rem)',
    h2Size: 'clamp(1.9rem, 3.6vw, 2.6rem)',
    h1Style: 'italic', h1HeadlineWeight: 300,
  },
  religious: {
    serif: "'Cormorant Garamond', 'Cormorant', Georgia, 'Times New Roman', serif",
    sans: "'Lato', 'Helvetica Neue', Arial, sans-serif",
    headlineWeight: 400, bodyWeight: 400, letterSpacing: '.01em',
    h1Size: 'clamp(2.5rem, 5.6vw, 4.4rem)',
    h2Size: 'clamp(2rem, 3.8vw, 2.8rem)',
    h1Style: 'italic', h1HeadlineWeight: 300,
  },
  family: {
    serif: "'Nunito', 'Quicksand', 'Helvetica Neue', Arial, sans-serif",
    sans: "'Open Sans', 'Helvetica Neue', Arial, sans-serif",
    headlineWeight: 700, bodyWeight: 400, letterSpacing: 'normal',
    h1Size: 'clamp(2.3rem, 5vw, 4rem)',
    h2Size: 'clamp(1.8rem, 3.4vw, 2.5rem)',
    h1Style: 'normal', h1HeadlineWeight: 700,
  },
  luxury: {
    serif: "'Playfair Display', 'Didot', Georgia, 'Times New Roman', serif",
    sans: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    headlineWeight: 400, bodyWeight: 300, letterSpacing: '.02em',
    h1Size: 'clamp(2.6rem, 5.8vw, 4.6rem)',
    h2Size: 'clamp(2.1rem, 4vw, 3rem)',
    h1Style: 'italic', h1HeadlineWeight: 300,
  },
});

// ── DECORATIVE GLYPHS + ORNAMENTS ───────────────────────────────────
// Brand watermark + section ornament — FAMILY-LEVEL only, never tied
// to a specific destination. The religious family carries Arabic
// devotional script (الحج / الإيمان / سلام) because that's the
// religious shared script across Islamic pilgrimage; educational /
// family / luxury default to empty so no destination-tied glyph is
// imposed. Operators / Phase-2 AI can override per page if they want
// (e.g. a Japan trip can opt in to 日本 via content.brand.kanji).
//
// `ornament` names a CSS pattern overlay applied at low opacity on
// light sections (and inverted on dark sections). Renderer picks the
// SVG by name from PATTERN_OVERLAYS.

const DECORATIVE = Object.freeze({
  'educational-academic':   { brand: '',     watermark: '',     ornament: 'shippo'     },
  'educational-modern':     { brand: '',     watermark: '',     ornament: 'thin-rule'  },
  'educational-classical':  { brand: '',     watermark: '',     ornament: 'shippo'     },
  'educational-tech':       { brand: '',     watermark: '',     ornament: 'grid'       },
  'religious-classical':    { brand: 'الحج', watermark: 'الإيمان', ornament: 'arabesque' },
  'religious-spiritual':    { brand: 'الحج', watermark: 'الإيمان', ornament: 'arabesque' },
  'religious-premium':      { brand: 'سلام', watermark: 'سلام',   ornament: 'arabesque' },
  'family-tropical':        { brand: '',     watermark: '',     ornament: 'wave'       },
  'family-vibrant':         { brand: '',     watermark: '',     ornament: 'wave'       },
  'family-resort':          { brand: '',     watermark: '',     ornament: 'arabesque'  },
  'luxury-alpine':          { brand: '',     watermark: '',     ornament: 'none'       },
  'luxury-coastal':         { brand: '',     watermark: '',     ornament: 'none'       },
  'luxury-continental':     { brand: '',     watermark: '',     ornament: 'none'       },
});

// ── PATTERN OVERLAYS ────────────────────────────────────────────────
// SVG data-URI strings for the section background ornament. Each is a
// small tilable graphic; the renderer projects it onto a CSS custom
// property (--ornament-pattern-light / --ornament-pattern-dark) so the
// base CSS can opt sections in or out via background-image.

const PATTERN_OVERLAYS = Object.freeze({
  // Shippo: concentric-circle Japanese wabi-style pattern.
  shippo: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Cg stroke='%23c2a88f' stroke-width='1' fill='none'%3E%3Ccircle cx='0' cy='0' r='40'/%3E%3Ccircle cx='80' cy='0' r='40'/%3E%3Ccircle cx='0' cy='80' r='40'/%3E%3Ccircle cx='80' cy='80' r='40'/%3E%3Ccircle cx='40' cy='40' r='40'/%3E%3Ccircle cx='40' cy='40' r='28'/%3E%3Ccircle cx='40' cy='40' r='16'/%3E%3C/g%3E%3C/svg%3E")`,
  // Arabesque: 8-point star + diamond Islamic-art tile.
  arabesque: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'%3E%3Cg stroke='%23a37f29' stroke-width='1' fill='none' opacity='0.6'%3E%3Cpolygon points='50,12 60,38 88,38 65,55 75,82 50,66 25,82 35,55 12,38 40,38'/%3E%3Ccircle cx='50' cy='50' r='10'/%3E%3C/g%3E%3C/svg%3E")`,
  // Wave: thin horizontal wave lines.
  wave: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='40' viewBox='0 0 120 40'%3E%3Cpath d='M0 20 Q15 10 30 20 T60 20 T90 20 T120 20' stroke='%23e85a3c' stroke-width='1' fill='none' opacity='0.5'/%3E%3C/svg%3E")`,
  // Grid: simple dotted grid (tech / STEM).
  grid: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Ccircle cx='2' cy='2' r='1' fill='%231561c4' opacity='0.4'/%3E%3C/svg%3E")`,
  // Thin-rule: horizontal hairline (Modern editorial).
  'thin-rule': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'%3E%3Cline x1='0' y1='30' x2='60' y2='30' stroke='%23a87a3a' stroke-width='0.5' opacity='0.5'/%3E%3C/svg%3E")`,
  // None: no overlay (luxury reads cleaner without it).
  none: '',
});

// ── SECTION COMPOSITION (default ordering per family) ───────────────

const SECTION_COMPOSITION = Object.freeze({
  educational: [
    'nav', 'hero', 'marquee', 'preview', 'programme', 'cultural', 'safety',
    'testimonials', 'investment', 'registration', 'brochure', 'faq', 'details',
    'finalCta', 'contact', 'floatingCta',
  ],
  religious: [
    'nav', 'hero', 'programme', 'cultural', 'marquee', 'safety',
    'investment', 'registration', 'brochure', 'faq', 'details',
    'finalCta', 'contact', 'floatingCta',
  ],
  family: [
    'nav', 'hero', 'marquee', 'cultural', 'preview', 'safety',
    'investment', 'registration', 'brochure', 'faq', 'details',
    'finalCta', 'contact', 'floatingCta',
  ],
  luxury: [
    'nav', 'hero', 'marquee', 'cultural', 'preview',
    'investment', 'registration', 'faq', 'finalCta', 'contact', 'floatingCta',
  ],
});

// ── ICONOGRAPHY OVERRIDES per theme (family-feel, not destination) ──
// Religious gets Islamic-pilgrimage SVGs (work for Umrah, Hajj, Mecca,
// Madinah — any Islamic destination). Family-tropical gets tropical
// icons (work for Bali, Vietnam, Kerala, NZ tropic). Family-resort
// gets desert-resort icons (work for Dubai, Egypt, Morocco). Luxury-
// alpine gets alpine icons (work for Switzerland, Iceland, Norway, NZ
// alpine). Operators / AI pick icon IDs from these libraries by FEEL.

const ICONS = Object.freeze({
  // Educational — no per-theme overrides; falls back to the universal
  // SVG library (which carries cultural_tokyo / cultural_fuji / etc. as
  // generic decorative-glyph options operators can pick by id).

  'religious-classical': {
    cultural_kaaba: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><rect x="14" y="20" width="22" height="22" rx="1"/><path d="M14 28 L36 28"/><path d="M19 20 Q19 12 25 12 Q31 12 31 20"/></svg>`,
    cultural_mosque: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M10 40 L10 26 Q10 18 25 18 Q40 18 40 26 L40 40 Z"/><path d="M25 18 Q25 12 25 8"/><circle cx="25" cy="6" r="2"/><path d="M5 40 L45 40"/></svg>`,
    cultural_minaret: `<svg viewBox="0 0 30 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><rect x="11" y="14" width="8" height="34"/><path d="M11 14 Q15 6 19 14"/><path d="M15 6 L15 2"/><circle cx="15" cy="0.5" r="1.5"/><line x1="11" y1="22" x2="19" y2="22"/><line x1="11" y1="32" x2="19" y2="32"/></svg>`,
    cultural_dome: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 36 L6 22 Q6 10 25 10 Q44 10 44 22 L44 36 Z"/><path d="M25 10 L25 4"/><circle cx="25" cy="2.5" r="1.5"/></svg>`,
  },
  'religious-spiritual': {
    cultural_kaaba: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><rect x="14" y="20" width="22" height="22" rx="1"/><path d="M14 28 L36 28"/><path d="M19 20 Q19 12 25 12 Q31 12 31 20"/></svg>`,
    cultural_arafat: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M4 34 L20 14 L30 22 L42 6 L46 34 Z"/></svg>`,
    cultural_mina: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M8 36 L18 18 L28 36 Z"/><path d="M22 36 L32 12 L42 36 Z"/></svg>`,
  },
  'religious-premium': {
    cultural_dome: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 42 L6 26 Q6 12 25 12 Q44 12 44 26 L44 42 Z"/><circle cx="25" cy="8" r="2"/></svg>`,
    cultural_olive: `<svg viewBox="0 0 40 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M20 48 L20 24"/><ellipse cx="20" cy="18" rx="14" ry="14"/><path d="M10 14 Q14 10 18 14"/><path d="M22 12 Q26 8 30 12"/></svg>`,
  },
  'family-tropical': {
    cultural_palm: `<svg viewBox="0 0 40 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M20 48 L20 22"/><path d="M20 22 Q4 18 4 8"/><path d="M20 22 Q36 18 36 8"/><path d="M20 22 Q8 14 4 18"/><path d="M20 22 Q32 14 36 18"/><circle cx="20" cy="22" r="2"/></svg>`,
    cultural_temple: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M25 4 L8 18 L12 18 L12 44 L38 44 L38 18 L42 18 Z"/><line x1="20" y1="44" x2="20" y2="28"/><line x1="30" y1="44" x2="30" y2="28"/></svg>`,
    cultural_wave: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M2 26 Q12 14 22 22 Q32 30 42 18 Q47 14 50 18"/><path d="M2 34 Q12 22 22 30 Q32 38 42 26 Q47 22 50 26"/></svg>`,
    cultural_boat: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 32 L44 32 L40 42 L10 42 Z"/><line x1="25" y1="32" x2="25" y2="8"/><path d="M25 8 L42 24 L25 24 Z"/></svg>`,
  },
  'family-vibrant': {
    cultural_palm: `<svg viewBox="0 0 40 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M20 48 L20 22"/><path d="M20 22 Q4 18 4 8"/><path d="M20 22 Q36 18 36 8"/></svg>`,
    cultural_temple: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M25 4 L10 16 L40 16 Z"/><line x1="14" y1="16" x2="14" y2="44"/><line x1="36" y1="16" x2="36" y2="44"/><line x1="10" y1="44" x2="40" y2="44"/><line x1="25" y1="16" x2="25" y2="44"/></svg>`,
    cultural_elephant: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><ellipse cx="22" cy="22" rx="14" ry="10"/><circle cx="34" cy="20" r="6"/><line x1="14" y1="32" x2="14" y2="38"/><line x1="22" y1="32" x2="22" y2="38"/><line x1="30" y1="32" x2="30" y2="38"/><path d="M40 22 L46 28 L44 34"/></svg>`,
    cultural_lantern: `<svg viewBox="0 0 30 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><line x1="15" y1="2" x2="15" y2="10"/><path d="M8 10 L22 10 L22 14 L8 14 Z"/><path d="M6 14 Q6 26 15 30 Q24 26 24 14"/><path d="M8 34 L22 34"/><line x1="15" y1="34" x2="15" y2="44"/></svg>`,
  },
  'family-resort': {
    cultural_burj: `<svg viewBox="0 0 30 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><polygon points="15 2 11 48 19 48"/><polygon points="15 14 8 48 22 48"/><line x1="11" y1="22" x2="19" y2="22"/><line x1="9" y1="32" x2="21" y2="32"/></svg>`,
    cultural_dune: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M2 32 Q14 16 26 24 Q38 32 50 18"/><path d="M2 36 L50 36"/></svg>`,
    cultural_falcon: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M4 22 Q14 6 24 18 Q34 30 46 14"/><circle cx="25" cy="20" r="2"/></svg>`,
    cultural_pyramid: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><polygon points="25 6 8 44 42 44"/><line x1="25" y1="6" x2="25" y2="44"/><line x1="16" y1="26" x2="34" y2="26"/></svg>`,
  },
  'luxury-alpine': {
    cultural_alps: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M2 36 L14 16 L22 28 L30 12 L40 26 L48 36 Z"/><path d="M14 16 L16 22 L22 28"/><path d="M30 12 L34 22"/></svg>`,
    cultural_chalet: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M8 24 L25 8 L42 24 L42 44 L8 44 Z"/><line x1="20" y1="44" x2="20" y2="30"/><line x1="30" y1="44" x2="30" y2="30"/></svg>`,
    cultural_lake: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><ellipse cx="25" cy="28" rx="20" ry="6"/><path d="M10 24 L18 12 L24 20 L32 8 L40 22"/></svg>`,
    cultural_aurora: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M4 28 Q14 4 24 20 Q34 36 44 14"/><path d="M2 36 L48 36"/><path d="M14 32 L14 36"/><path d="M28 30 L28 36"/><path d="M40 32 L40 36"/></svg>`,
  },
  'luxury-coastal': {
    cultural_overwater: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M10 22 L10 14 L24 6 L38 14 L38 22 Z"/><line x1="14" y1="22" x2="14" y2="32"/><line x1="34" y1="22" x2="34" y2="32"/><path d="M2 34 Q14 30 24 34 Q38 38 48 32"/></svg>`,
    cultural_palmcoast: `<svg viewBox="0 0 40 50" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M20 48 L20 24"/><path d="M20 24 Q4 18 6 8"/><path d="M20 24 Q36 18 34 8"/><path d="M2 48 L38 48"/></svg>`,
    cultural_yacht: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M4 30 L46 30 L40 36 L10 36 Z"/><line x1="25" y1="30" x2="25" y2="6"/><path d="M25 6 L40 28 L25 28 Z"/></svg>`,
  },
  'luxury-continental': {
    cultural_arch: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M10 44 L10 20 Q10 8 25 8 Q40 8 40 20 L40 44"/><line x1="6" y1="44" x2="44" y2="44"/></svg>`,
    cultural_villa: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M6 22 L25 8 L44 22"/><path d="M10 22 L10 44 L40 44 L40 22"/><rect x="22" y="30" width="6" height="14"/></svg>`,
    cultural_column: `<svg viewBox="0 0 30 50" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><rect x="6" y="6" width="18" height="4"/><rect x="6" y="42" width="18" height="6"/><line x1="9" y1="10" x2="9" y2="42"/><line x1="14" y1="10" x2="14" y2="42"/><line x1="20" y1="10" x2="20" y2="42"/></svg>`,
  },
});

// ── THEME REGISTRY ──────────────────────────────────────────────────

function buildTheme(id, family, variant) {
  const palette = PALETTES[id];
  if (!palette) throw new Error(`themeTokens: missing palette for "${id}"`);
  return Object.freeze({
    id,
    family,
    variant,
    palette,
    typography: TYPOGRAPHY[family],
    decorative: DECORATIVE[id] || { brand: '', watermark: '', ornament: 'none' },
    sectionOrder: SECTION_COMPOSITION[family],
    icons: ICONS[id] || {},
  });
}

const THEME_REGISTRY = Object.freeze({
  // Educational
  'educational-academic':   buildTheme('educational-academic',   'educational', 'academic'),
  'educational-modern':     buildTheme('educational-modern',     'educational', 'modern'),
  'educational-classical':  buildTheme('educational-classical',  'educational', 'classical'),
  'educational-tech':       buildTheme('educational-tech',       'educational', 'tech'),
  // Religious
  'religious-classical':    buildTheme('religious-classical',    'religious', 'classical'),
  'religious-spiritual':    buildTheme('religious-spiritual',    'religious', 'spiritual'),
  'religious-premium':      buildTheme('religious-premium',      'religious', 'premium'),
  // Family
  'family-tropical':        buildTheme('family-tropical',        'family', 'tropical'),
  'family-vibrant':         buildTheme('family-vibrant',         'family', 'vibrant'),
  'family-resort':          buildTheme('family-resort',          'family', 'resort'),
  // Luxury
  'luxury-alpine':          buildTheme('luxury-alpine',          'luxury', 'alpine'),
  'luxury-coastal':         buildTheme('luxury-coastal',         'luxury', 'coastal'),
  'luxury-continental':     buildTheme('luxury-continental',     'luxury', 'continental'),
});

const THEME_IDS = Object.freeze(Object.keys(THEME_REGISTRY));

const DEFAULT_THEME_BY_FAMILY = Object.freeze({
  educational: 'educational-academic',
  religious:   'religious-classical',
  family:      'family-tropical',
  luxury:      'luxury-alpine',
});

const THEME_VARIANTS_BY_FAMILY = Object.freeze({
  educational: ['academic', 'modern', 'classical', 'tech'],
  religious:   ['classical', 'spiritual', 'premium'],
  family:      ['tropical', 'vibrant', 'resort'],
  luxury:      ['alpine', 'coastal', 'continental'],
});

// ── BACKWARDS-COMPAT ALIASES ────────────────────────────────────────
// Existing landing pages persisted with PR-E-pre-Option-B variant IDs
// (educational-japan, religious-umrah, family-bali, etc.) keep
// resolving to the equivalent style bucket without a data migration.
// Aliases ONLY come into play when the persisted id is missing from
// THEME_REGISTRY — never breaks new code.

const THEME_ALIASES = Object.freeze({
  'educational-japan':     'educational-academic',
  'educational-singapore': 'educational-modern',
  'educational-uk':        'educational-classical',
  'educational-stem':      'educational-tech',
  'religious-umrah':       'religious-classical',
  'religious-hajj':        'religious-spiritual',
  'religious-jerusalem':   'religious-premium',
  'family-bali':           'family-tropical',
  'family-thailand':       'family-vibrant',
  'family-dubai':          'family-resort',
  'luxury-maldives':       'luxury-coastal',
  'luxury-switzerland':    'luxury-alpine',
  'luxury-europe':         'luxury-continental',
});

// ── LOOKUP HELPERS ──────────────────────────────────────────────────

function getTheme(themeId) {
  if (typeof themeId !== 'string') return null;
  // Direct hit first.
  if (THEME_REGISTRY[themeId]) return THEME_REGISTRY[themeId];
  // Alias the legacy destination-named id to its style bucket.
  const aliased = THEME_ALIASES[themeId];
  if (aliased && THEME_REGISTRY[aliased]) return THEME_REGISTRY[aliased];
  return null;
}

function getDefaultTheme(family) {
  const id = DEFAULT_THEME_BY_FAMILY[family] || 'educational-academic';
  return THEME_REGISTRY[id];
}

/**
 * Resolve a theme from EXPLICIT inputs only.
 *
 * Algorithm (no destination-keyword routing — that's the Phase-2 TEE's
 * job; this helper only handles trusted explicit inputs):
 *
 *   1. themeId  — exact match (or alias) wins.
 *   2. family+variant — exact `${family}-${variant}` match.
 *   3. family — family default.
 *   4. Final fallback — educational-academic.
 *
 * The destination / subBrand strings are accepted but IGNORED here.
 * Phase-2's Travel Experience Engine is the only place that maps those
 * to (family, variant). Keeping the responsibility in one layer means
 * adding a new destination is always one decision, made once, in the
 * TEE — never a keyword regex hunt across the codebase.
 */
function resolveTheme(input = {}) {
  const { themeId, family, variant } = input || {};
  // 1. Explicit theme id.
  const direct = getTheme(themeId);
  if (direct) return direct;
  // 2. Family + variant.
  if (family && variant) {
    const composed = `${family}-${variant}`.toLowerCase();
    if (THEME_REGISTRY[composed]) return THEME_REGISTRY[composed];
  }
  // 3. Family default.
  if (family && DEFAULT_THEME_BY_FAMILY[family]) {
    return THEME_REGISTRY[DEFAULT_THEME_BY_FAMILY[family]];
  }
  // 4. Final fallback.
  return THEME_REGISTRY['educational-academic'];
}

/**
 * Emit the inline CSS overlay block. Inlined after the shared base CSS
 * so its CSS-variable overrides take effect. Pure function — safe to
 * render at request time, no I/O.
 */
function renderThemeOverlayCss(theme) {
  if (!theme || !theme.palette) return '';
  const p = theme.palette;
  const t = theme.typography || {};
  const ornamentKey = (theme.decorative && theme.decorative.ornament) || 'none';
  const ornamentPattern = PATTERN_OVERLAYS[ornamentKey] || '';
  const luxuryFlag = theme.family === 'luxury';
  return `
.trips-page {
  --bg:        ${p.bg};
  --bg-alt:    ${p.bgAlt};
  --bg-band:   ${p.bgBand};
  --ink:       ${p.ink};
  --ink-soft:  ${p.inkSoft};
  --muted:     ${p.muted};
  --red:       ${p.accent};
  --red-deep:  ${p.accentDeep};
  --gold:      ${p.secondary};
  --gold-deep: ${p.secondaryDeep};
  --line:      ${p.line};
  --card:      ${p.card};
  --dark:      ${p.dark};
  --dark-ink:  ${p.darkInk};
  --dark-muted:${p.darkMuted};
  --btn-dark:       ${p.btnDark};
  --btn-dark-hover: ${p.btnDarkHover};
  --btn-teal:       ${p.btnTeal};
  --btn-teal-hover: ${p.btnTealHover};

  --serif: ${t.serif || "Georgia, 'Times New Roman', serif"};
  --sans:  ${t.sans  || "'Helvetica Neue', Arial, sans-serif"};
  --h-weight: ${t.headlineWeight || 400};
  --body-weight: ${t.bodyWeight || 400};
  --letter-spacing: ${t.letterSpacing || 'normal'};
  --h1-size: ${t.h1Size || 'clamp(2.4rem, 5.4vw, 4.2rem)'};
  --h2-size: ${t.h2Size || 'clamp(1.9rem, 3.6vw, 2.6rem)'};
  --h1-style: ${t.h1Style || 'normal'};
  --h1-weight: ${t.h1HeadlineWeight || t.headlineWeight || 400};

  --ornament-pattern: ${ornamentPattern || 'none'};
  /* Pattern opacity dropped 0.35 -> 0.10 (luxury 0.12 -> 0.06) on 2026-06-23
     so content + photography dominate the page. Reference: Japan microsite
     where ornament is a quiet texture, never visual chrome. */
  --ornament-opacity: ${ornamentKey === 'none' ? '0' : (luxuryFlag ? '0.06' : '0.10')};

  --bg-color:      ${p.bg};
  --surface-color: ${p.card};
  --text-primary:  ${p.ink};
  --border-color:  ${p.line};
  --glass-bg:      ${p.bg};
  --glass-border:  ${p.line};

  background: ${p.bg};
  color: ${p.ink};
}
.trips-page h2 { font-size: var(--h2-size); }
.trips-page h1 {
  font-size: var(--h1-size);
  font-style: var(--h1-style);
  font-weight: var(--h1-weight);
}
${luxuryFlag ? `
.trips-page .t-hero,
.trips-page .t-cultural,
.trips-page .t-reviews,
.trips-page .t-invest,
.trips-page .t-register,
.trips-page .t-faqs,
.trips-page .t-final-cta {
  background: ${p.bg};
  color: ${p.ink};
}
.trips-page .t-light,
.trips-page .t-safety .t-light { color: ${p.ink}; }
.trips-page .t-tier { background: ${p.card}; color: ${p.ink}; border-color: ${p.line}; }
.trips-page .t-tier h4 { color: ${p.ink}; }
.trips-page .t-tier-amount { color: ${p.accent}; }
.trips-page .t-tier-num { color: ${p.accent}; }
.trips-page .t-card { background: ${p.card}; border-color: ${p.line}; color: ${p.ink}; }
.trips-page .t-card h3, .trips-page .t-card p { color: ${p.ink}; }
.trips-page header.t-nav { background: ${p.bg} !important; background-color: ${p.bg} !important; border-bottom-color: ${p.line}; color: ${p.ink}; }
.trips-page header.t-nav .t-brand,
.trips-page header.t-nav .t-links a,
.trips-page header.t-nav .t-links a:visited { color: ${p.ink}; }
/* PR-E Phase 1.6 — dark variants of the caption overlay + covers panel + partner logos */
.trips-page .t-hero-caption {
  background: color-mix(in srgb, ${p.bg} 88%, transparent);
  border-bottom-color: color-mix(in srgb, ${p.gold || p.accent} 40%, transparent);
}
.trips-page .t-caption-title { color: ${p.accent}; }
.trips-page .t-caption-sub { color: ${p.inkSoft}; }
.trips-page .t-covers-title { color: ${p.ink}; }
.trips-page .t-covers-intro { color: ${p.inkSoft}; }
.trips-page .t-cover-card { background: ${p.card}; border-color: ${p.line}; border-left-color: ${p.accent}; }
.trips-page .t-cover-card h4 { color: ${p.ink}; }
.trips-page .t-cover-card p { color: ${p.inkSoft}; }
.trips-page .t-partner-logo { mix-blend-mode: screen; filter: brightness(0.95) grayscale(20%); }
.trips-page .t-cd-clock .t-cd-unit span { color: ${p.ink}; }
` : ''}
${theme.family === 'religious' ? `
.trips-page .t-safety { background: ${p.dark}; color: ${p.darkInk}; }
.trips-page .t-tag { color: ${p.accent}; }
.trips-page .t-jp { color: ${p.accent}; font-weight: 600; }
` : ''}
${theme.family === 'family' ? `
.trips-page .t-hero h1 { color: ${p.ink}; }
.trips-page .t-tag { color: ${p.accent}; }
.trips-page .t-eyebrow { color: ${p.muted}; }
` : ''}
`.trim();
}

module.exports = {
  THEME_FAMILIES,
  THEME_VARIANTS_BY_FAMILY,
  THEME_REGISTRY,
  THEME_IDS,
  THEME_ALIASES,
  DEFAULT_THEME_BY_FAMILY,
  PALETTES,
  TYPOGRAPHY,
  DECORATIVE,
  SECTION_COMPOSITION,
  ICONS,
  PATTERN_OVERLAYS,
  getTheme,
  getDefaultTheme,
  resolveTheme,
  renderThemeOverlayCss,
};
