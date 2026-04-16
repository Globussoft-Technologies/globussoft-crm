import en from './en.json';
import hi from './hi.json';
import es from './es.json';

export const TRANSLATIONS = { en, hi, es };

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', flag: 'GB' },
  { code: 'hi', name: 'हिन्दी', flag: 'IN' },
  { code: 'es', name: 'Español', flag: 'ES' },
];

export function getStoredLanguage() {
  try {
    return localStorage.getItem('language') || 'en';
  } catch {
    return 'en';
  }
}

export function setStoredLanguage(code) {
  try {
    localStorage.setItem('language', code);
  } catch {
    // ignore storage failures
  }
  window.dispatchEvent(new Event('languagechange'));
}
