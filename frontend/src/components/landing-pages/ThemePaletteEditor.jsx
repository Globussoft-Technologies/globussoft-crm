export const THEME_COLOR_FIELDS = [
  { key: 'brandColor', label: 'Brand color' },
  { key: 'accentColor', label: 'Accent color' },
  { key: 'darkColor', label: 'Dark color' },
  { key: 'footerColor', label: 'Footer color' },
  { key: 'lightBg', label: 'Light background' },
  { key: 'panelBg', label: 'Panel background' },
  { key: 'softBg', label: 'Soft background' },
  { key: 'textColor', label: 'Text color' },
  { key: 'textColor2', label: 'Muted text color' },
  { key: 'borderColor', label: 'Border color' },
];

const THEME_DEFAULTS = {
  brandColor: '#123B63',
  accentColor: '#D9A441',
  darkColor: '#0D2440',
  footerColor: '#081A2D',
  lightBg: '#F8FBFC',
  panelBg: '#FFFFFF',
  softBg: '#E8F2F7',
  textColor: '#152030',
  textColor2: '#5A6877',
  borderColor: '#D8E3EE',
  serifFont: "'Cormorant Garamond', Georgia, serif",
  sansFont: "'Inter', system-ui, sans-serif",
  pattern: 'none',
};

function normalizeHexColor(value, fallback) {
  const candidate = String(value || '').trim();
  const fallbackValue = String(fallback || '#000000').trim() || '#000000';
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(candidate)) {
    return candidate.startsWith('#') ? candidate.toUpperCase() : `#${candidate.toUpperCase()}`;
  }
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(fallbackValue)) {
    return fallbackValue.startsWith('#') ? fallbackValue.toUpperCase() : `#${fallbackValue.toUpperCase()}`;
  }
  return '#000000';
}

function normalizeOptionalText(value, fallback = '') {
  const candidate = String(value || '').trim();
  return candidate || String(fallback || '').trim();
}

export function createThemeDraft(theme = {}) {
  const source = theme && typeof theme === 'object' ? theme : {};
  const draft = {
    ...THEME_DEFAULTS,
    ...source,
  };

  for (const field of THEME_COLOR_FIELDS) {
    draft[field.key] = normalizeHexColor(draft[field.key], THEME_DEFAULTS[field.key]);
  }

  draft.serifFont = normalizeOptionalText(draft.serifFont, THEME_DEFAULTS.serifFont);
  draft.sansFont = normalizeOptionalText(draft.sansFont, THEME_DEFAULTS.sansFont);
  draft.pattern = normalizeOptionalText(draft.pattern, THEME_DEFAULTS.pattern);

  return draft;
}

function ColorPickerField({ id, label, value, onChange, disabled }) {
  const safeValue = normalizeHexColor(value, '#000000');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {label}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <input
          id={id}
          type="color"
          value={safeValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          style={{
            width: 36,
            height: 32,
            border: '1px solid var(--border-color)',
            borderRadius: 4,
            cursor: disabled ? 'not-allowed' : 'pointer',
            padding: 2,
            background: 'transparent',
            flexShrink: 0,
          }}
          aria-label={`${label} picker`}
        />
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-color, rgba(255,255,255,0.05))',
            color: 'var(--text-primary)',
            fontSize: 12,
            outline: 'none',
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            fontFamily: 'monospace',
            opacity: disabled ? 0.7 : 1,
          }}
          aria-label={`${label} hex value`}
          maxLength={9}
        />
      </div>
    </div>
  );
}

export default function ThemePaletteEditor({
  title = 'Theme palette',
  description,
  note,
  theme,
  onChange,
  onReset,
  resetLabel = 'Reset to palette',
  disabled = false,
  baseThemeLabel = '',
}) {
  const draft = createThemeDraft(theme);
  const swatches = [draft.brandColor, draft.accentColor, draft.softBg, draft.lightBg];

  const updateTheme = (field, value) => {
    if (disabled || typeof onChange !== 'function') return;
    onChange({
      ...draft,
      [field]: value,
    });
  };

  return (
    <div
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: '0.85rem',
        background: 'rgba(255,255,255,0.6)',
        opacity: disabled ? 0.8 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.55rem' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
          {description && (
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.45, marginTop: '0.2rem' }}>
              {description}
            </div>
          )}
        </div>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            disabled={disabled}
            style={{
              border: '1px solid var(--border-color)',
              background: 'transparent',
              color: 'var(--text-primary)',
              borderRadius: 8,
              padding: '0.35rem 0.65rem',
              fontSize: '0.78rem',
              cursor: disabled ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
          >
            {resetLabel}
          </button>
        )}
      </div>

      {baseThemeLabel && (
        <div style={{ fontSize: '0.72rem', color: '#b8893b', marginBottom: '0.55rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Based on {baseThemeLabel}
        </div>
      )}

      <div
        style={{
          height: 54,
          borderRadius: 10,
          background: `linear-gradient(135deg, ${draft.brandColor}, ${draft.accentColor})`,
          border: `1px solid ${draft.borderColor}`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16)',
        }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 120px), 1fr))', gap: '0.35rem', marginTop: '0.45rem' }}>
        {swatches.map((swatch) => (
          <span
            key={swatch}
            aria-hidden="true"
            style={{
              height: 10,
              borderRadius: 999,
              background: swatch,
              border: '1px solid rgba(15, 23, 42, 0.06)',
            }}
          />
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: '0.65rem', marginTop: '0.8rem' }}>
        {THEME_COLOR_FIELDS.map((field) => (
          <ColorPickerField
            key={field.key}
            id={`theme-${field.key}`}
            label={field.label}
            value={draft[field.key]}
            onChange={(value) => updateTheme(field.key, value)}
            disabled={disabled}
          />
        ))}
      </div>

      {note && (
        <div style={{ marginTop: '0.7rem', fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          {note}
        </div>
      )}
    </div>
  );
}
