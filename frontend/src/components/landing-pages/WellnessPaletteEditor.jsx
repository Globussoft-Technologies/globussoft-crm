import { WELLNESS_LANDING_COLOR_FIELDS, getWellnessColorOverrides, normalizeWellnessHexColor, resolveWellnessLandingTheme } from '../../utils/wellnessLandingThemes';

function ColorField({ field, value, onChange, disabled }) {
  const safeValue = normalizeWellnessHexColor(value);
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <label htmlFor={`wellness-color-${field.key}`} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {field.label}
        <small style={{ display: 'block', marginTop: 2, lineHeight: 1.3 }}>{field.description}</small>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <input
          id={`wellness-color-${field.key}`}
          type="color"
          value={safeValue}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-label={`${field.label} picker`}
          style={{ width: 36, height: 32, padding: 2, border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
        <input
          type="text"
          value={value || ''}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-label={`${field.label} hex value`}
          maxLength={7}
          style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--bg-color, #fff)', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 12 }}
        />
      </div>
    </div>
  );
}

export default function WellnessPaletteEditor({ theme, baseThemeId = 'botanical', onChange, onReset, disabled = false }) {
  const baseTheme = resolveWellnessLandingTheme(baseThemeId);
  const draft = resolveWellnessLandingTheme('custom', theme || getWellnessColorOverrides(baseTheme));
  const update = (key, value) => {
    if (disabled || typeof onChange !== 'function') return;
    onChange({ ...getWellnessColorOverrides(draft), [key]: value });
  };

  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, padding: '0.9rem', background: 'rgba(255,255,255,0.6)', opacity: disabled ? 0.8 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.6rem' }}>
        <div>
          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>Custom wellness colors</div>
          <div style={{ marginTop: 3, fontSize: '0.76rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>Fine-tune the page background, text, buttons, accents, and card surfaces without changing the content or travel CRM theme.</div>
        </div>
        {onReset && (
          <button type="button" onClick={onReset} disabled={disabled} style={{ flexShrink: 0, padding: '0.35rem 0.65rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'transparent', color: 'var(--text-primary)', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '0.78rem' }}>
            Reset colors
          </button>
        )}
      </div>

      <div style={{ height: 56, borderRadius: 10, background: `linear-gradient(135deg, ${draft.primary}, ${draft.accent})`, border: `1px solid ${draft.border}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22)' }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 4, marginTop: 6 }}>
        {[draft.primary, draft.accent, draft.surfaceSoft, draft.bg].map((color) => <span key={color} aria-hidden="true" style={{ height: 10, borderRadius: 999, background: color, border: '1px solid rgba(15,23,42,0.08)' }} />)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 175px), 1fr))', gap: '0.7rem', marginTop: '0.9rem' }}>
        {WELLNESS_LANDING_COLOR_FIELDS.map((field) => (
          <ColorField key={field.key} field={field} value={draft[field.key]} onChange={(value) => update(field.key, value)} disabled={disabled} />
        ))}
      </div>
      <div style={{ marginTop: '0.75rem', fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>
        Custom colors are saved inside this wellness campaign only. Travel palettes and other CRM pages are not affected.
      </div>
    </div>
  );
}
