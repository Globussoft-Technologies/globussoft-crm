import { WANDERLUX_FONT_STYLES } from '../../utils/landingFontStyles';
import { createThemeDraft } from './ThemePaletteEditor';

const KEEP_CURRENT = '__current__';
const RESET_TO_DEFAULT = '__reset__';
const THEME_DEFAULT = '__theme_default__';
const THEME_DEFAULT_SERIF = "'Cormorant Garamond', Georgia, serif";
const THEME_DEFAULT_SANS = "'Inter', system-ui, sans-serif";

const FONT_STYLE_OPTIONS = [
  { id: THEME_DEFAULT, label: 'Original typography' },
  { id: KEEP_CURRENT, label: 'Keep current saved typography' },
  ...WANDERLUX_FONT_STYLES,
];

const FONT_STYLE_IDS = new Set(WANDERLUX_FONT_STYLES.map((fontStyle) => fontStyle.id));

function getFontStyle(styleId) {
  return WANDERLUX_FONT_STYLES.find((fontStyle) => fontStyle.id === styleId) || null;
}

function safeStyleId(styleId, fallback = KEEP_CURRENT) {
  return FONT_STYLE_IDS.has(styleId) ? styleId : fallback;
}

function selectStyle(selectValue) {
  return selectValue === KEEP_CURRENT || selectValue === RESET_TO_DEFAULT || selectValue === THEME_DEFAULT
    ? null
    : getFontStyle(selectValue);
}

function fontStyleDescription(styleId) {
  if (styleId === THEME_DEFAULT) return 'Uses the original Cormorant Garamond headings and Inter body typography.';
  return getFontStyle(styleId)?.description || 'Uses the typography already saved in this page theme.';
}

export default function WanderluxTypographyEditor({ theme, sections = [], onChange, disabled = false }) {
  const draft = createThemeDraft(theme);
  const sectionOverrides = draft.sectionFontStyles && typeof draft.sectionFontStyles === 'object'
    ? draft.sectionFontStyles
    : {};
  const hasCustomSavedFonts = draft.serifFont !== THEME_DEFAULT_SERIF || draft.sansFont !== THEME_DEFAULT_SANS;
  const pageStyleId = safeStyleId(draft.fontStyleId, hasCustomSavedFonts ? KEEP_CURRENT : THEME_DEFAULT);
  const pageStyleLabel = getFontStyle(pageStyleId)?.label || (pageStyleId === THEME_DEFAULT ? 'Original typography' : null);
  const inheritedOptionLabel = pageStyleLabel || 'Use page default';

  const updateTheme = (nextTheme) => {
    if (disabled || typeof onChange !== 'function') return;
    onChange(nextTheme);
  };

  const setPageStyle = (styleId) => {
    const next = { ...draft, sectionFontStyles: {} };
    const selected = selectStyle(styleId);

    if (selected) {
      next.fontStyleId = selected.id;
      next.serifFont = selected.family;
      next.sansFont = selected.family;
    } else if (styleId === THEME_DEFAULT) {
      delete next.fontStyleId;
      next.serifFont = THEME_DEFAULT_SERIF;
      next.sansFont = THEME_DEFAULT_SANS;
    } else {
      delete next.fontStyleId;
    }

    // A page-wide selection is intentionally authoritative: it clears old
    // section overrides so the user immediately gets one consistent style.
    updateTheme(next);
  };

  const setSectionStyle = (sectionKey, styleId) => {
    const nextOverrides = { ...sectionOverrides };
    const selected = selectStyle(styleId);

    if (selected) nextOverrides[sectionKey] = selected.id;
    else delete nextOverrides[sectionKey];

    updateTheme({ ...draft, sectionFontStyles: nextOverrides });
  };

  return (
    <div
      style={{
        marginTop: '0.8rem',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: '0.85rem',
        background: 'rgba(255,255,255,0.6)',
        opacity: disabled ? 0.8 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>Typography</div>
        <div style={{ marginTop: '0.2rem', fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Choose one font style for the entire page, or override individual sections. The Raw JSON editor remains available below for advanced changes.
        </div>
      </div>

      <label
        htmlFor="wanderlux-page-font-style"
        style={{ display: 'grid', gap: '0.35rem', marginTop: '0.8rem', fontSize: '0.78rem', color: 'var(--text-primary)', fontWeight: 600 }}
      >
        Font style for entire page
        <select
          id="wanderlux-page-font-style"
          aria-label="Font style for entire page"
          value={pageStyleId}
          onChange={(event) => setPageStyle(event.target.value)}
          disabled={disabled}
          style={{ ...inputStyle, boxSizing: 'border-box', minWidth: 0, fontWeight: 500 }}
        >
          {FONT_STYLE_OPTIONS.map((fontStyle) => (
            <option key={fontStyle.id} value={fontStyle.id}>{fontStyle.label}</option>
          ))}
        </select>
      </label>
      <div style={{ marginTop: '0.35rem', fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        {fontStyleDescription(pageStyleId)}
      </div>
      {getFontStyle(pageStyleId) && (
        <div
          aria-label="Selected font preview"
          style={{ marginTop: '0.55rem', padding: '0.65rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-color)', color: 'var(--text-primary)', fontFamily: getFontStyle(pageStyleId)?.family, fontSize: '1.05rem', lineHeight: 1.25 }}
        >
          Aa — Singapore 7 Days
          <span style={{ display: 'block', marginTop: '0.2rem', fontFamily: 'inherit', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            Preview of the selected font family
          </span>
        </div>
      )}

      <div style={{ marginTop: '0.85rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)' }}>
        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>Section-specific overrides</div>
        <div style={{ marginTop: '0.2rem', marginBottom: '0.6rem', fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Optional. A section shown with the page style follows the page-wide selection.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: '0.6rem', minWidth: 0 }}>
          {sections.map((section) => {
            const selectedSectionStyle = safeStyleId(sectionOverrides[section.key]);
            return (
              <label
                key={section.key}
                htmlFor={`wanderlux-section-font-${section.key}`}
                style={{ display: 'grid', gap: '0.3rem', minWidth: 0, fontSize: '0.74rem', color: 'var(--text-primary)', fontWeight: 600 }}
              >
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{section.label}</span>
                <select
                  id={`wanderlux-section-font-${section.key}`}
                  aria-label={`${section.label} font style`}
                  value={selectedSectionStyle}
                  onChange={(event) => setSectionStyle(section.key, event.target.value)}
                  disabled={disabled}
                  style={{ ...inputStyle, boxSizing: 'border-box', minWidth: 0, fontSize: '0.78rem', fontWeight: 500 }}
                >
                  <option value={KEEP_CURRENT}>{inheritedOptionLabel}</option>
                  {pageStyleLabel && <option value={RESET_TO_DEFAULT}>Use page default</option>}
                  {WANDERLUX_FONT_STYLES.map((fontStyle) => (
                    <option key={fontStyle.id} value={fontStyle.id}>{fontStyle.label}</option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '0.55rem 0.7rem',
  background: 'var(--bg-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  fontSize: '0.85rem',
};
