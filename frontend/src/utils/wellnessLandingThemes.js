export const WELLNESS_LANDING_THEMES = Object.freeze([
  {
    id: 'botanical',
    label: 'Botanical calm',
    description: 'Warm greens with a natural, reassuring feel.',
    colors: ['#2f6b50', '#d49b50', '#f7fbf4'],
    bg: '#f7fbf4', surface: '#fffdf8', surfaceSoft: '#e8f1e5', ink: '#173b2c', muted: '#63766b', primary: '#2f6b50', primaryDeep: '#194a37', accent: '#d49b50', accentSoft: '#fff1d8', border: '#d7e2d0', inverse: '#ffffff',
  },
  {
    id: 'coral',
    label: 'Coral energy',
    description: 'Vibrant coral accents balanced by deep plum.',
    colors: ['#db5d52', '#f5b84b', '#fff8f5'],
    bg: '#fff8f5', surface: '#ffffff', surfaceSoft: '#fff0eb', ink: '#482532', muted: '#7f626b', primary: '#db5d52', primaryDeep: '#9f3846', accent: '#f5b84b', accentSoft: '#fff4d7', border: '#f0d5ce', inverse: '#ffffff',
  },
  {
    id: 'lagoon',
    label: 'Lagoon clarity',
    description: 'Fresh teal and blue for modern clinics and care.',
    colors: ['#007f86', '#ef7b63', '#effaff'],
    bg: '#effaff', surface: '#ffffff', surfaceSoft: '#dff4f5', ink: '#083b4c', muted: '#527482', primary: '#007f86', primaryDeep: '#075985', accent: '#ef7b63', accentSoft: '#ffe7e1', border: '#c3e3e7', inverse: '#ffffff',
  },
  {
    id: 'lavender',
    label: 'Lavender glow',
    description: 'Soft violet tones for beauty and self-care campaigns.',
    colors: ['#8b5cf6', '#ec6b9b', '#fbf8ff'],
    bg: '#fbf8ff', surface: '#ffffff', surfaceSoft: '#f1e9ff', ink: '#35224f', muted: '#716382', primary: '#8b5cf6', primaryDeep: '#5b21b6', accent: '#ec6b9b', accentSoft: '#ffe8f1', border: '#e3d6f4', inverse: '#ffffff',
  },
  {
    id: 'cobalt',
    label: 'Cobalt clinic',
    description: 'Confident blue and icy cyan for modern clinics and care events.',
    colors: ['#2457a6', '#49c6d2', '#f4f8ff'],
    bg: '#f4f8ff', surface: '#ffffff', surfaceSoft: '#e3f7fa', ink: '#142b52', muted: '#5d718d', primary: '#2457a6', primaryDeep: '#12346b', accent: '#49c6d2', accentSoft: '#dff7fa', border: '#d2e2f4', inverse: '#ffffff',
  },
  {
    id: 'rosewood',
    label: 'Rosewood care',
    description: 'Distinct wine and blush tones for an intimate, premium care experience.',
    colors: ['#7a2347', '#e3a0b5', '#fff7fa'],
    bg: '#fff7fa', surface: '#fffdfd', surfaceSoft: '#f8e6ee', ink: '#3b1c2a', muted: '#775a68', primary: '#7a2347', primaryDeep: '#4b1330', accent: '#e3a0b5', accentSoft: '#fbe4ed', border: '#ebcdd9', inverse: '#ffffff',
  },
]);

export const DEFAULT_WELLNESS_LANDING_THEME = 'botanical';

export const WELLNESS_LANDING_COLOR_FIELDS = Object.freeze([
  { key: 'bg', label: 'Page background', description: 'The main canvas behind every section.' },
  { key: 'surface', label: 'Surface', description: 'Cards, header, and form surfaces.' },
  { key: 'surfaceSoft', label: 'Soft section', description: 'Tinted bands and supporting areas.' },
  { key: 'ink', label: 'Heading text', description: 'Primary titles and dark content.' },
  { key: 'muted', label: 'Muted text', description: 'Supporting copy and labels.' },
  { key: 'primary', label: 'Primary color', description: 'Buttons, accents, and highlights.' },
  { key: 'primaryDeep', label: 'Deep primary', description: 'Strong contrast and dark gradients.' },
  { key: 'accent', label: 'Accent color', description: 'Warm secondary emphasis.' },
  { key: 'accentSoft', label: 'Soft accent', description: 'Light accent backgrounds.' },
  { key: 'border', label: 'Border color', description: 'Cards, inputs, and dividers.' },
  { key: 'inverse', label: 'Inverse text', description: 'Text used on dark sections.' },
]);

const WELLNESS_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeWellnessHexColor(value, fallback = '#ffffff') {
  const candidate = String(value || '').trim();
  const safeFallback = String(fallback || '#ffffff').trim();
  return WELLNESS_HEX.test(candidate) ? candidate : (WELLNESS_HEX.test(safeFallback) ? safeFallback : '#ffffff');
}

export function getWellnessColorOverrides(theme = {}) {
  return Object.fromEntries(WELLNESS_LANDING_COLOR_FIELDS.map(({ key }) => [key, normalizeWellnessHexColor(theme[key], '#ffffff')]));
}

export function resolveWellnessLandingTheme(themeId, customColors = {}) {
  const baseTheme = WELLNESS_LANDING_THEMES.find((theme) => theme.id === themeId)
    || WELLNESS_LANDING_THEMES.find((theme) => theme.id === DEFAULT_WELLNESS_LANDING_THEME);
  if (themeId !== 'custom' || !customColors || typeof customColors !== 'object') return baseTheme;
  const colors = Object.fromEntries(WELLNESS_LANDING_COLOR_FIELDS.map(({ key }) => [key, normalizeWellnessHexColor(customColors[key], baseTheme[key])]));
  return {
    ...baseTheme,
    ...colors,
    id: 'custom',
    label: 'Custom palette',
    description: 'Your wellness campaign colors, tuned for this page.',
    colors: [colors.primary, colors.accent, colors.bg],
  };
}

export const WELLNESS_LANDING_LAYOUTS = Object.freeze([
  {
    id: 'editorial',
    label: 'Editorial flow',
    description: 'Story-led hero, proof, gallery, and a strong registration finish.',
  },
  {
    id: 'clinical',
    label: 'Clinical trust',
    description: 'Structured, calm, and information-forward for clinics and consultations.',
  },
  {
    id: 'immersive',
    label: 'Immersive campaign',
    description: 'Image-led hero treatment for events and high-energy campaigns.',
  },
  {
    id: 'community',
    label: 'Community spotlight',
    description: 'Warm, people-first spacing for outreach and community wellness drives.',
  },
]);

export const DEFAULT_WELLNESS_LANDING_LAYOUT = 'editorial';
