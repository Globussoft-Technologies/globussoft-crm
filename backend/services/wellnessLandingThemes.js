'use strict';

// Wellness-only campaign palettes. These are deliberately kept separate from
// the travel theme registry so a wellness admin can change the look of a
// campaign without changing any shared travel branding.
const WELLNESS_LANDING_THEMES = Object.freeze({
  botanical: Object.freeze({
    id: 'botanical',
    label: 'Botanical calm',
    description: 'Warm greens with a natural, reassuring feel.',
    bg: '#f7fbf4',
    surface: '#fffdf8',
    surfaceSoft: '#e8f1e5',
    ink: '#173b2c',
    muted: '#63766b',
    primary: '#2f6b50',
    primaryDeep: '#194a37',
    accent: '#d49b50',
    accentSoft: '#fff1d8',
    border: '#d7e2d0',
    inverse: '#ffffff',
  }),
  coral: Object.freeze({
    id: 'coral',
    label: 'Coral energy',
    description: 'Vibrant coral accents balanced by deep plum.',
    bg: '#fff8f5',
    surface: '#ffffff',
    surfaceSoft: '#fff0eb',
    ink: '#482532',
    muted: '#7f626b',
    primary: '#db5d52',
    primaryDeep: '#9f3846',
    accent: '#f5b84b',
    accentSoft: '#fff4d7',
    border: '#f0d5ce',
    inverse: '#ffffff',
  }),
  lagoon: Object.freeze({
    id: 'lagoon',
    label: 'Lagoon clarity',
    description: 'Fresh teal and blue for modern clinics and care.',
    bg: '#effaff',
    surface: '#ffffff',
    surfaceSoft: '#dff4f5',
    ink: '#083b4c',
    muted: '#527482',
    primary: '#007f86',
    primaryDeep: '#075985',
    accent: '#ef7b63',
    accentSoft: '#ffe7e1',
    border: '#c3e3e7',
    inverse: '#ffffff',
  }),
  lavender: Object.freeze({
    id: 'lavender',
    label: 'Lavender glow',
    description: 'Soft violet tones for beauty and self-care campaigns.',
    bg: '#fbf8ff',
    surface: '#ffffff',
    surfaceSoft: '#f1e9ff',
    ink: '#35224f',
    muted: '#716382',
    primary: '#8b5cf6',
    primaryDeep: '#5b21b6',
    accent: '#ec6b9b',
    accentSoft: '#ffe8f1',
    border: '#e3d6f4',
    inverse: '#ffffff',
  }),
  cobalt: Object.freeze({
    id: 'cobalt',
    label: 'Cobalt clinic',
    description: 'Confident blue and icy cyan for modern clinics and care events.',
    bg: '#f4f8ff',
    surface: '#ffffff',
    surfaceSoft: '#e3f7fa',
    ink: '#142b52',
    muted: '#5d718d',
    primary: '#2457a6',
    primaryDeep: '#12346b',
    accent: '#49c6d2',
    accentSoft: '#dff7fa',
    border: '#d2e2f4',
    inverse: '#ffffff',
  }),
  rosewood: Object.freeze({
    id: 'rosewood',
    label: 'Rosewood care',
    description: 'Distinct wine and blush tones for an intimate, premium care experience.',
    bg: '#fff7fa',
    surface: '#fffdfd',
    surfaceSoft: '#f8e6ee',
    ink: '#3b1c2a',
    muted: '#775a68',
    primary: '#7a2347',
    primaryDeep: '#4b1330',
    accent: '#e3a0b5',
    accentSoft: '#fbe4ed',
    border: '#ebcdd9',
    inverse: '#ffffff',
  }),
});

const DEFAULT_WELLNESS_LANDING_THEME = 'botanical';

const WELLNESS_LANDING_LAYOUTS = Object.freeze({
  editorial: Object.freeze({
    id: 'editorial',
    label: 'Editorial flow',
    description: 'Story-led hero, proof, gallery, and a strong registration finish.',
  }),
  clinical: Object.freeze({
    id: 'clinical',
    label: 'Clinical trust',
    description: 'Structured, calm, and information-forward for clinics and consultations.',
  }),
  immersive: Object.freeze({
    id: 'immersive',
    label: 'Immersive campaign',
    description: 'Image-led hero treatment for events and high-energy campaigns.',
  }),
  community: Object.freeze({
    id: 'community',
    label: 'Community spotlight',
    description: 'Warm, people-first spacing for outreach and community wellness drives.',
  }),
});

const DEFAULT_WELLNESS_LANDING_LAYOUT = 'editorial';

const WELLNESS_LANDING_COLOR_KEYS = ['bg', 'surface', 'surfaceSoft', 'ink', 'muted', 'primary', 'primaryDeep', 'accent', 'accentSoft', 'border', 'inverse'];
const WELLNESS_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function resolveWellnessLandingTheme(themeId, customColors = {}) {
  const key = String(themeId || '').trim().toLowerCase();
  const baseTheme = WELLNESS_LANDING_THEMES[key] || WELLNESS_LANDING_THEMES[DEFAULT_WELLNESS_LANDING_THEME];
  if (key !== 'custom' || !customColors || typeof customColors !== 'object') return baseTheme;
  const colors = Object.fromEntries(WELLNESS_LANDING_COLOR_KEYS.map((colorKey) => {
    const value = String(customColors[colorKey] || '').trim();
    return [colorKey, WELLNESS_HEX.test(value) ? value : baseTheme[colorKey]];
  }));
  return {
    ...baseTheme,
    ...colors,
    id: 'custom',
    label: 'Custom palette',
    description: 'Your wellness campaign colors, tuned for this page.',
  };
}

function resolveWellnessLandingLayout(layoutId) {
  const key = String(layoutId || '').trim().toLowerCase();
  return WELLNESS_LANDING_LAYOUTS[key] || WELLNESS_LANDING_LAYOUTS[DEFAULT_WELLNESS_LANDING_LAYOUT];
}

module.exports = {
  WELLNESS_LANDING_THEMES,
  DEFAULT_WELLNESS_LANDING_THEME,
  resolveWellnessLandingTheme,
  WELLNESS_LANDING_LAYOUTS,
  DEFAULT_WELLNESS_LANDING_LAYOUT,
  resolveWellnessLandingLayout,
};
