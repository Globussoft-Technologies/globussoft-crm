import { describe, expect, it } from 'vitest';
import { WELLNESS_LANDING_THEMES, resolveWellnessLandingTheme } from '../utils/wellnessLandingThemes';

describe('wellness landing palettes', () => {
  it('exposes the blue and rose professional presets in the picker registry', () => {
    expect(WELLNESS_LANDING_THEMES.map((theme) => theme.id)).toEqual(expect.arrayContaining(['cobalt', 'rosewood']));
    expect(resolveWellnessLandingTheme('cobalt').primary).toBe('#2457a6');
    expect(resolveWellnessLandingTheme('rosewood').primary).toBe('#7a2347');
  });
});
