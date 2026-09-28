import { describe, expect, it } from 'vitest';

import { resolveThemePreference } from '../utils/themePreference';

describe('resolveThemePreference', () => {
  it('restores an explicit server preference across browsers and devices', () => {
    expect(resolveThemePreference('light', 'dark')).toBe('dark');
    expect(resolveThemePreference('dark', 'light')).toBe('light');
  });

  it('keeps an explicit local preference when the server uses system mode', () => {
    expect(resolveThemePreference('dark', 'system')).toBe('dark');
    expect(resolveThemePreference('light', null)).toBe('light');
  });

  it('falls back to system when neither source has an explicit preference', () => {
    expect(resolveThemePreference('system', 'system')).toBe('system');
    expect(resolveThemePreference('invalid', undefined)).toBe('system');
  });
});
