import React from 'react';
import { Globe } from 'lucide-react';
import { SUPPORTED_LANGUAGES, getStoredLanguage, setStoredLanguage } from '../i18n';

export default function LanguageSwitcher() {
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState(getStoredLanguage());
  const ref = React.useRef(null);

  const lang =
    SUPPORTED_LANGUAGES.find((l) => l.code === current) || SUPPORTED_LANGUAGES[0];

  React.useEffect(() => {
    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const change = (code) => {
    setStoredLanguage(code);
    setCurrent(code);
    setOpen(false);
    setTimeout(() => window.location.reload(), 100);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          background: 'none',
          border: '1px solid var(--border-color)',
          borderRadius: '6px',
          padding: '0.4rem 0.7rem',
          cursor: 'pointer',
          color: 'var(--text-primary)',
          fontSize: '0.85rem',
        }}
      >
        <Globe size={14} /> {lang.flag} {lang.name}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: 'var(--card-bg)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            minWidth: '160px',
            zIndex: 100,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            overflow: 'hidden',
          }}
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => change(l.code)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.75rem',
                background: l.code === current ? 'rgba(59,130,246,0.12)' : 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
              }}
            >
              {l.flag} {l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
