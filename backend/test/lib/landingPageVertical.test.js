import { describe, expect, test } from 'vitest';
import {
  isGenericLandingPage,
  isPageAllowedForVertical,
  isTravelLandingPage,
  isWellnessLandingPage,
  verticalWhere,
} from '../../lib/landingPageVertical.js';

describe('landing page vertical contracts', () => {
  test('keeps generic v2 pages separate from legacy wellness templates', () => {
    expect(isGenericLandingPage({ templateType: 'generic-site-real_estate-v2' })).toBe(true);
    expect(isGenericLandingPage({ templateType: 'generic-site-wellness-v1' })).toBe(false);
    expect(isPageAllowedForVertical({ templateType: 'generic-site-real_estate-v2' }, 'generic')).toBe(true);
    expect(isPageAllowedForVertical({ templateType: 'generic-site-wellness-v1' }, 'generic')).toBe(false);
  });

  test('keeps wellness and travel contracts isolated', () => {
    expect(isWellnessLandingPage({ templateType: 'wellness-site-health-v1' })).toBe(true);
    expect(isPageAllowedForVertical({ templateType: 'wellness-site-health-v1' }, 'generic')).toBe(false);
    expect(isTravelLandingPage({ templateType: 'wanderlux-v1', subBrand: 'tmc' })).toBe(true);
    expect(isTravelLandingPage({ templateType: 'generic-site-real_estate-v2', subBrand: 'tmc' })).toBe(false);
    expect(isPageAllowedForVertical({ templateType: 'wanderlux-v1', subBrand: 'tmc' }, 'wellness')).toBe(false);
  });

  test('builds a tenant list predicate for generic pages', () => {
    const where = verticalWhere('generic');
    expect(where.OR).toEqual(expect.arrayContaining([
      { templateType: { startsWith: 'generic-campaign-' } },
    ]));
    expect(where.OR[1].AND[1].NOT).toEqual(expect.arrayContaining([
      { templateType: { startsWith: 'generic-site-wellness' } },
    ]));
  });
});
