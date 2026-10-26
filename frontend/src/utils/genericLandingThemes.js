import { WELLNESS_LANDING_LAYOUTS, WELLNESS_LANDING_THEMES } from './wellnessLandingThemes';

// Generic pages reuse the established color tokens and layout ids so their
// rendered CSS stays consistent. Only the generic presentation copy lives here;
// wellness labels never appear in generic UI.
const GENERIC_THEME_COPY = Object.freeze([
  { label: 'Blueprint clarity', description: 'Structured blue and slate tones for business campaigns.' },
  { label: 'Growth signal', description: 'Confident warm accents for acquisition and conversion.' },
  { label: 'Market pulse', description: 'Energetic teal and coral for launches and promotions.' },
  { label: 'Modern spectrum', description: 'Distinct violet and rose tones for creative campaigns.' },
  { label: 'Trust standard', description: 'Dependable blue and cyan for high-consideration offers.' },
  { label: 'Premium graphite', description: 'Refined wine and blush tones for premium brands.' },
]);

const GENERIC_LAYOUT_COPY = Object.freeze([
  { label: 'Conversion flow', description: 'Story-led hero, proof points, and a clear action path.' },
  { label: 'Trust builder', description: 'Structured, information-forward sections for considered decisions.' },
  { label: 'Visual campaign', description: 'Image-led treatment for launches, offers, and announcements.' },
  { label: 'Community reach', description: 'Warm, people-first spacing for outreach and public campaigns.' },
]);

export const GENERIC_LANDING_THEMES = Object.freeze(
  WELLNESS_LANDING_THEMES.map((theme, index) => ({
    ...theme,
    ...GENERIC_THEME_COPY[index],
  })),
);

export const DEFAULT_GENERIC_LANDING_THEME = 'cobalt';

export const GENERIC_LANDING_LAYOUTS = Object.freeze(
  WELLNESS_LANDING_LAYOUTS.map((layout, index) => ({
    ...layout,
    ...GENERIC_LAYOUT_COPY[index],
  })),
);

export const DEFAULT_GENERIC_LANDING_LAYOUT = 'editorial';
