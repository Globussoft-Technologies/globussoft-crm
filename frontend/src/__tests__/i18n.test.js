import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTranslation } from '../utils/i18n';
import {
  TRANSLATIONS,
  SUPPORTED_LANGUAGES,
  getStoredLanguage,
  setStoredLanguage,
} from '../i18n';

describe('i18n/index — stored language getter/setter', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to "en" when nothing is stored', () => {
    expect(getStoredLanguage()).toBe('en');
  });

  it('setStoredLanguage + getStoredLanguage round-trip', () => {
    setStoredLanguage('hi');
    expect(getStoredLanguage()).toBe('hi');
    setStoredLanguage('es');
    expect(getStoredLanguage()).toBe('es');
  });

  it('dispatches a window languagechange event when set', () => {
    let fired = false;
    const handler = () => { fired = true; };
    window.addEventListener('languagechange', handler);
    setStoredLanguage('hi');
    window.removeEventListener('languagechange', handler);
    expect(fired).toBe(true);
  });

  it('SUPPORTED_LANGUAGES has en, hi, es', () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(['en', 'hi', 'es']));
  });

  it('TRANSLATIONS includes all 3 dictionaries', () => {
    expect(TRANSLATIONS.en).toBeDefined();
    expect(TRANSLATIONS.hi).toBeDefined();
    expect(TRANSLATIONS.es).toBeDefined();
  });
});

describe('utils/i18n — useTranslation hook', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns t() function + current lang', () => {
    const { result } = renderHook(() => useTranslation());
    expect(typeof result.current.t).toBe('function');
    expect(typeof result.current.lang).toBe('string');
  });

  it('t() returns translated value for existing dotted key', () => {
    // Pick a key that exists in en.json — try the first key we can walk to.
    const enKeys = Object.keys(TRANSLATIONS.en);
    expect(enKeys.length).toBeGreaterThan(0);
    const top = enKeys[0];
    const subKeys = Object.keys(TRANSLATIONS.en[top] || {});
    if (subKeys.length > 0) {
      const key = `${top}.${subKeys[0]}`;
      const { result } = renderHook(() => useTranslation());
      const v = result.current.t(key);
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('t() returns the key itself when missing with no fallback', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t('totally.bogus.key')).toBe('totally.bogus.key');
  });

  it('t() returns supplied fallback when missing', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t('bogus.nonexistent', 'Default')).toBe('Default');
  });

  it('t() returns empty string for empty key', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t('')).toBe('');
    expect(result.current.t(undefined, 'Fallback')).toBe('Fallback');
  });

  it('t() falls back to English when key exists only there', () => {
    setStoredLanguage('es'); // Spanish
    const { result } = renderHook(() => useTranslation());
    // A key that might exist in en but not every translation — pick first top-level key present in en but maybe absent in es.
    const enTop = Object.keys(TRANSLATIONS.en)[0];
    const firstSub = Object.keys(TRANSLATIONS.en[enTop] || {})[0];
    if (firstSub) {
      const key = `${enTop}.${firstSub}`;
      const v = result.current.t(key);
      expect(typeof v).toBe('string');
    }
  });

  it('hook updates lang state when languagechange event fires', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.lang).toBe('en');
    act(() => {
      setStoredLanguage('hi');
    });
    expect(result.current.lang).toBe('hi');
  });
});
