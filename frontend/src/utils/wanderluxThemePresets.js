const BRAND_DEFAULT_THEMES = {
  tmc: {
    brandColor: '#0F1B3D',
    accentColor: '#D9A441',
    darkColor: '#0A1330',
    footerColor: '#080F25',
    lightBg: '#F7F9FC',
    panelBg: '#FFFFFF',
    softBg: '#EEF3FB',
    textColor: '#16202E',
    textColor2: '#5A6678',
    borderColor: '#DCE3EF',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  rfu: {
    brandColor: '#0E7C7B',
    accentColor: '#C89A4E',
    darkColor: '#0B3954',
    footerColor: '#072438',
    lightBg: '#F7FAF9',
    panelBg: '#FFFFFF',
    softBg: '#E8F3F1',
    textColor: '#15242B',
    textColor2: '#5B6B70',
    borderColor: '#DCE6E4',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  travelstall: {
    brandColor: '#122647',
    accentColor: '#C89A4E',
    darkColor: '#0A1430',
    footerColor: '#070D1F',
    lightBg: '#F7F6F1',
    panelBg: '#FFFFFF',
    softBg: '#EEEAE0',
    textColor: '#1A1F2E',
    textColor2: '#5A5E68',
    borderColor: '#E0DBCF',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  visasure: {
    brandColor: '#1E3A8A',
    accentColor: '#E0A458',
    darkColor: '#0F1F4E',
    footerColor: '#0B1638',
    lightBg: '#F7F9FC',
    panelBg: '#FFFFFF',
    softBg: '#E8EEF8',
    textColor: '#15202E',
    textColor2: '#5B6678',
    borderColor: '#D9E2F0',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
};

const STATIC_THEME_PRESETS = [
  {
    id: 'sakura-indigo',
    label: 'Sakura Indigo',
    description: 'Soft blossom tones for Japan and East Asia trips.',
    keywords: ['japan', 'tokyo', 'kyoto', 'osaka', 'seoul', 'south korea', 'korea', 'hanami'],
    theme: {
      brandColor: '#15224B',
      accentColor: '#E06C96',
      darkColor: '#0A1024',
      footerColor: '#081022',
      lightBg: '#F7F5FB',
      panelBg: '#FFFFFF',
      softBg: '#EEE6F4',
      textColor: '#1B2233',
      textColor2: '#59617A',
      borderColor: '#DDD7EB',
      serifFont: "'Cormorant Garamond', Georgia, serif",
      sansFont: "'Inter', system-ui, sans-serif",
      pattern: 'none',
    },
  },
  {
    id: 'coastal-sand',
    label: 'Coastal Sand',
    description: 'Warm shoreline tones for beaches, islands, and tropical trips.',
    keywords: ['goa', 'bali', 'andaman', 'maldives', 'kerala', 'sri lanka', 'srilanka', 'phuket', 'beach', 'island', 'coast', 'tropical'],
    theme: {
      brandColor: '#123B63',
      accentColor: '#D9A441',
      darkColor: '#0D2440',
      footerColor: '#081A2D',
      lightBg: '#F8FBFC',
      panelBg: '#FFFFFF',
      softBg: '#E8F2F7',
      textColor: '#152030',
      textColor2: '#5A6877',
      borderColor: '#D8E3EE',
      serifFont: "'Cormorant Garamond', Georgia, serif",
      sansFont: "'Inter', system-ui, sans-serif",
      pattern: 'none',
    },
  },
  {
    id: 'desert-gold',
    label: 'Desert Gold',
    description: 'Warm desert tones for Umrah and Gulf journeys.',
    keywords: ['umrah', 'makkah', 'madinah', 'mecca', 'medina', 'dubai', 'uae', 'arabia', 'desert', 'middle east'],
    theme: {
      brandColor: '#1E4A3F',
      accentColor: '#D8A64A',
      darkColor: '#0F2520',
      footerColor: '#081512',
      lightBg: '#FAF7EF',
      panelBg: '#FFFFFF',
      softBg: '#F2E8D7',
      textColor: '#1C2220',
      textColor2: '#5D675F',
      borderColor: '#E5D7C0',
      serifFont: "'Cormorant Garamond', Georgia, serif",
      sansFont: "'Inter', system-ui, sans-serif",
      pattern: 'none',
    },
  },
  {
    id: 'heritage-rose',
    label: 'Heritage Rose',
    description: 'Rose and maroon tones for forts, palaces, and heritage cities.',
    keywords: ['jaipur', 'udaipur', 'agra', 'rajasthan', 'delhi', 'varanasi', 'amritsar', 'heritage', 'palace', 'fort'],
    theme: {
      brandColor: '#6D3145',
      accentColor: '#D49A4A',
      darkColor: '#311723',
      footerColor: '#1C0E15',
      lightBg: '#FBF4F2',
      panelBg: '#FFFFFF',
      softBg: '#F4E5E3',
      textColor: '#2B1F25',
      textColor2: '#6B5860',
      borderColor: '#E8D6D2',
      serifFont: "'Cormorant Garamond', Georgia, serif",
      sansFont: "'Inter', system-ui, sans-serif",
      pattern: 'none',
    },
  },
  {
    id: 'alpine-azure',
    label: 'Alpine Azure',
    description: 'Cool mountain tones for snow, hills, and high-altitude routes.',
    keywords: ['switzerland', 'manali', 'shimla', 'nainital', 'mussoorie', 'nepal', 'himalaya', 'mountain', 'snow', 'glacier', 'alps'],
    theme: {
      brandColor: '#153E66',
      accentColor: '#6BA8D9',
      darkColor: '#0D233B',
      footerColor: '#081521',
      lightBg: '#F6FBFD',
      panelBg: '#FFFFFF',
      softBg: '#E5F0F6',
      textColor: '#172633',
      textColor2: '#5B6A78',
      borderColor: '#D6E4EE',
      serifFont: "'Cormorant Garamond', Georgia, serif",
      sansFont: "'Inter', system-ui, sans-serif",
      pattern: 'none',
    },
  },
];

function normalizeText(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeThemeId(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cloneTheme(theme) {
  return { ...(theme || {}) };
}

function buildBrandDefaultChoice(subBrand) {
  const key = String(subBrand || '').toLowerCase();
  const theme = BRAND_DEFAULT_THEMES[key] || BRAND_DEFAULT_THEMES.travelstall;
  return {
    id: 'brand-default',
    label: 'Keep current palette',
    description: 'Use the existing sub-brand colors without changing the trip mood.',
    keywords: [],
    theme: cloneTheme(theme),
  };
}

function findStaticPresetByDestination(destination) {
  const haystack = normalizeText(destination);
  if (!haystack) return null;
  for (const preset of STATIC_THEME_PRESETS) {
    if ((preset.keywords || []).some((keyword) => haystack.includes(keyword))) {
      return preset;
    }
  }
  return null;
}

function getStaticThemeChoice(themeId) {
  const normalized = normalizeThemeId(themeId);
  const found = STATIC_THEME_PRESETS.find((preset) => preset.id === normalized);
  if (!found) return null;
  return {
    id: found.id,
    label: found.label,
    description: found.description,
    keywords: [...(found.keywords || [])],
    theme: cloneTheme(found.theme),
  };
}

export function listWanderluxThemePresets(subBrand) {
  return [
    buildBrandDefaultChoice(subBrand),
    ...STATIC_THEME_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      keywords: [...(preset.keywords || [])],
      theme: cloneTheme(preset.theme),
    })),
  ];
}

export function resolveWanderluxThemePreset(input = {}) {
  const themeId = normalizeThemeId(input.themeId);
  if (themeId === 'brand-default' || themeId === 'current-palette' || themeId === 'default') {
    return buildBrandDefaultChoice(input.subBrand);
  }

  const direct = getStaticThemeChoice(themeId);
  if (direct) return direct;

  const destinationMatch = findStaticPresetByDestination(input.destination);
  if (destinationMatch) {
    return {
      id: destinationMatch.id,
      label: destinationMatch.label,
      description: destinationMatch.description,
      keywords: [...(destinationMatch.keywords || [])],
      theme: cloneTheme(destinationMatch.theme),
    };
  }

  return buildBrandDefaultChoice(input.subBrand);
}

export function getWanderluxThemePreset(themeId, input = {}) {
  const direct = resolveWanderluxThemePreset({ themeId, ...input });
  return direct || null;
}

export const WANDERLUX_THEME_PRESETS = STATIC_THEME_PRESETS;

export default STATIC_THEME_PRESETS;
