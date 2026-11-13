// Curated, system-backed font stacks for campaign landing pages. Keeping the
// values local avoids a network font dependency and keeps the public page fast
// on smaller devices.
export const LANDING_FONT_STYLES = Object.freeze([
  {
    id: 'modern',
    label: 'Modern sans',
    description: 'Clean, compact typography for contemporary campaigns.',
    family: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  },
  {
    id: 'classic',
    label: 'Classic serif',
    description: 'Traditional serif lettering with a trusted editorial feel.',
    family: 'Georgia, Times New Roman, serif',
  },
  {
    id: 'editorial',
    label: 'Editorial serif',
    description: 'A softer, more expressive serif style for premium stories.',
    family: 'Palatino Linotype, Book Antiqua, Palatino, Georgia, serif',
  },
  {
    id: 'friendly',
    label: 'Friendly sans',
    description: 'Approachable rounded-feeling system typography for outreach.',
    family: 'Trebuchet MS, Arial, sans-serif',
  },
]);

// Travel/Wanderlux keeps a broader, local-font catalogue because its editor
// supports typography at both page and section level. These stacks do not
// require a remote font request, so the page remains fast and predictable on
// mobile devices and in offline previews.
export const WANDERLUX_FONT_STYLES = Object.freeze([
  {
    id: 'modern',
    label: 'Modern sans',
    description: 'Clean, compact typography for contemporary campaigns.',
    family: "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  {
    id: 'clean',
    label: 'Clean Arial',
    description: 'Familiar, highly readable sans-serif lettering for practical pages.',
    family: 'Arial, Helvetica, sans-serif',
  },
  {
    id: 'neutral',
    label: 'Neutral Helvetica',
    description: 'Balanced professional typography with a restrained visual tone.',
    family: 'Helvetica Neue, Helvetica, Arial, sans-serif',
  },
  {
    id: 'humanist',
    label: 'Humanist sans',
    description: 'Open and friendly lettering that stays legible at smaller sizes.',
    family: "Trebuchet MS, Arial, sans-serif",
  },
  {
    id: 'friendly',
    label: 'Friendly sans',
    description: 'Approachable rounded-feeling system typography for outreach.',
    family: "Trebuchet MS, Arial, sans-serif",
  },
  {
    id: 'soft',
    label: 'Soft Verdana',
    description: 'Wide, approachable text for information-heavy travel pages.',
    family: 'Verdana, Geneva, sans-serif',
  },
  {
    id: 'geometric',
    label: 'Geometric sans',
    description: 'A structured geometric look for bold, modern campaign layouts.',
    family: "Century Gothic, AppleGothic, sans-serif",
  },
  {
    id: 'classic',
    label: 'Classic serif',
    description: 'Traditional serif lettering with a trusted editorial feel.',
    family: "Georgia, 'Times New Roman', serif",
  },
  {
    id: 'editorial',
    label: 'Editorial serif',
    description: 'A softer, more expressive serif style for premium stories.',
    family: "'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
  },
  {
    id: 'traditional',
    label: 'Traditional Times',
    description: 'A formal newspaper-inspired serif treatment for classic journeys.',
    family: "'Times New Roman', Times, serif",
  },
  {
    id: 'book',
    label: 'Book Cambria',
    description: 'Comfortable book-like serif typography for long-form content.',
    family: 'Cambria, Georgia, serif',
  },
  {
    id: 'garamond',
    label: 'Elegant Garamond',
    description: 'Refined, high-contrast serif lettering for luxury travel pages.',
    family: 'Garamond, Baskerville, serif',
  },
]);

export const DEFAULT_LANDING_FONT_STYLE = 'modern';

export function resolveLandingFontStyle(styleId) {
  return LANDING_FONT_STYLES.find((style) => style.id === styleId)
    || LANDING_FONT_STYLES.find((style) => style.id === DEFAULT_LANDING_FONT_STYLE);
}
