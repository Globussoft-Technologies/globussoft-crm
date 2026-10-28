'use strict';

// Landing pages are stored in one table, but they are not one product. Keep
// the vertical contract in one place so a new generic page can never be
// mistaken for a wellness or travel page merely because it uses the same
// renderer and CSS tokens.
const LEGACY_WELLNESS_PREFIXES = [
  'generic-site-wellness',
  'generic-site-health',
  'generic-site-hospital',
  'generic-site-fitness',
];

const TRAVEL_TEMPLATE_TYPES = new Set([
  'travel_destination',
  'wanderlux-v1',
  'educational-trip-v1',
  'religious-tour-v1',
  'family-trip-v1',
  'luxury-tour-v1',
  'travel-premium-v1',
]);

const WELLNESS_SECTORS = new Set(['wellness', 'health', 'hospital', 'fitness']);

function normalizeVertical(value) {
  const key = String(value || '').trim().toLowerCase();
  return key === 'wellness' || key === 'travel' ? key : 'generic';
}

function templateType(pageOrTemplate) {
  return typeof pageOrTemplate === 'string'
    ? pageOrTemplate.toLowerCase()
    : String(pageOrTemplate?.templateType || '').toLowerCase();
}

function isTravelLandingPage(page = {}) {
  const subBrand = String(page.subBrand || '').toLowerCase();
  const type = templateType(page);
  if (type.startsWith('generic-') || type.startsWith('wellness-site-')) return false;
  return TRAVEL_TEMPLATE_TYPES.has(type) || Boolean(subBrand && ['tmc', 'rfu', 'travelstall', 'visasure'].includes(subBrand));
}

function isLegacyWellnessTemplate(value) {
  const type = templateType(value);
  return LEGACY_WELLNESS_PREFIXES.some((prefix) => type === prefix || type.startsWith(`${prefix}-`));
}

function isWellnessLandingPage(page = {}, blocks = []) {
  return templateType(page).startsWith('wellness-site-') ||
    isLegacyWellnessTemplate(page) ||
    blocks.some((block) => block?.type === 'columns' && block.props?.variant === 'wellness-campaign-page');
}

function isGenericLandingPage(page = {}, blocks = []) {
  const type = templateType(page);
  return (type.startsWith('generic-site-') && !isLegacyWellnessTemplate(page)) ||
    type.startsWith('generic-campaign-') ||
    blocks.some((block) => block?.type === 'columns' && block.props?.variant === 'generic-campaign-page');
}

function isPageAllowedForVertical(page = {}, vertical) {
  const key = normalizeVertical(vertical);
  if (key === 'travel') return isTravelLandingPage(page);
  if (key === 'wellness') return isWellnessLandingPage(page, []);
  return isGenericLandingPage(page, []);
}

function verticalWhere(vertical) {
  const key = normalizeVertical(vertical);
  if (key === 'travel') {
    return {
      AND: [
        {
          OR: [
            { subBrand: { in: ['tmc', 'rfu', 'travelstall', 'visasure'] } },
            { templateType: { in: [...TRAVEL_TEMPLATE_TYPES] } },
          ],
        },
        { NOT: [{ templateType: { startsWith: 'generic-' } }, { templateType: { startsWith: 'wellness-site-' } }] },
      ],
    };
  }
  if (key === 'wellness') {
    return {
      OR: [
        { templateType: { startsWith: 'wellness-site-' } },
        ...LEGACY_WELLNESS_PREFIXES.map((prefix) => ({ templateType: { startsWith: prefix } })),
      ],
    };
  }
  return {
    OR: [
      { templateType: { startsWith: 'generic-campaign-' } },
      {
        AND: [
          { templateType: { startsWith: 'generic-site-' } },
          { NOT: LEGACY_WELLNESS_PREFIXES.map((prefix) => ({ templateType: { startsWith: prefix } })) },
        ],
      },
    ],
  };
}

function isWellnessSector(value) {
  return WELLNESS_SECTORS.has(String(value || '').trim().toLowerCase());
}

module.exports = {
  LEGACY_WELLNESS_PREFIXES,
  TRAVEL_TEMPLATE_TYPES,
  WELLNESS_SECTORS,
  normalizeVertical,
  isTravelLandingPage,
  isWellnessLandingPage,
  isGenericLandingPage,
  isPageAllowedForVertical,
  verticalWhere,
  isWellnessSector,
};
