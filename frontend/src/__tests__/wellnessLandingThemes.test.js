import { describe, expect, it } from 'vitest';
import { WELLNESS_LANDING_THEMES, resolveWellnessLandingTheme, isWellnessLandingPage } from '../utils/wellnessLandingThemes';

describe('wellness landing palettes', () => {
  it('limits wellness styling to known wellness templates or explicit wellness content', () => {
    for (const templateType of ['generic-site-general-v1', 'generic-site-hospitality-v1', 'generic-site-technology-v1', 'travel-stall']) {
      expect(isWellnessLandingPage({ templateType })).toBe(false);
    }
    for (const templateType of ['generic-site-health-v1', 'generic-site-hospital-v1', 'generic-site-fitness-v1', 'generic-site-hair-treatment', 'generic-site-eye-care']) {
      expect(isWellnessLandingPage({ templateType })).toBe(true);
    }
    expect(isWellnessLandingPage({}, [{ type: 'columns', props: { variant: 'wellness-campaign-page' } }])).toBe(true);
  });
  it('exposes the blue and rose professional presets in the picker registry', () => {
    expect(WELLNESS_LANDING_THEMES.map((theme) => theme.id)).toEqual(expect.arrayContaining(['cobalt', 'rosewood']));
    expect(resolveWellnessLandingTheme('cobalt').primary).toBe('#2457a6');
    expect(resolveWellnessLandingTheme('rosewood').primary).toBe('#7a2347');
  });
});
