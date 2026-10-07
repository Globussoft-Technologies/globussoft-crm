import { describe, expect, test } from 'vitest';
import { WELLNESS_LANDING_THEMES, resolveWellnessLandingTheme } from '../../services/wellnessLandingThemes.js';

describe('wellness landing palettes', () => {
  test('includes distinct blue and rose professional presets', () => {
    expect(WELLNESS_LANDING_THEMES.cobalt).toMatchObject({
      id: 'cobalt',
      label: 'Cobalt clinic',
      primary: '#2457a6',
      accent: '#49c6d2',
    });
    expect(WELLNESS_LANDING_THEMES.rosewood).toMatchObject({
      id: 'rosewood',
      label: 'Rosewood care',
      primary: '#7a2347',
      accent: '#e3a0b5',
    });
    expect(resolveWellnessLandingTheme('cobalt').bg).not.toBe(resolveWellnessLandingTheme('rosewood').bg);
  });
});
