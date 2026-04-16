// Lightweight i18n hook. Pages opt in via:
//   const { t } = useTranslation();
//   return <button>{t('common.save')}</button>;
//
// Change language anywhere via setStoredLanguage('hi') from '../i18n'.
import { useState, useEffect } from 'react';
import { TRANSLATIONS, getStoredLanguage } from '../i18n';

export function useTranslation() {
  const [lang, setLang] = useState(getStoredLanguage);

  useEffect(() => {
    const handler = () => setLang(getStoredLanguage());
    window.addEventListener('languagechange', handler);
    return () => window.removeEventListener('languagechange', handler);
  }, []);

  const t = (key, fallback) => {
    if (!key) return fallback || '';
    const parts = key.split('.');
    let val = TRANSLATIONS[lang] || TRANSLATIONS.en;
    for (const p of parts) {
      val = val?.[p];
      if (val == null) break;
    }
    if (val == null) {
      // Fallback to English if missing in selected language
      let enVal = TRANSLATIONS.en;
      for (const p of parts) {
        enVal = enVal?.[p];
        if (enVal == null) break;
      }
      val = enVal;
    }
    return val || fallback || key;
  };

  return { t, lang };
}
