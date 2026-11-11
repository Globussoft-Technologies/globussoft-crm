'use strict';

// Keep these stacks local and deterministic. The editor stores a stable style
// id, while the renderer resolves it to a safe CSS font stack on the server.
// This preserves the existing Raw JSON escape hatch without allowing a font
// value to become executable markup in the generated landing page.
const WANDERLUX_FONT_STYLES = Object.freeze({
  modern: Object.freeze({
    family: "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  }),
  clean: Object.freeze({
    family: 'Arial, Helvetica, sans-serif',
  }),
  neutral: Object.freeze({
    family: "Helvetica Neue, Helvetica, Arial, sans-serif",
  }),
  humanist: Object.freeze({
    family: "'Trebuchet MS', Arial, sans-serif",
  }),
  soft: Object.freeze({
    family: 'Verdana, Geneva, sans-serif',
  }),
  geometric: Object.freeze({
    family: "'Century Gothic', AppleGothic, sans-serif",
  }),
  classic: Object.freeze({
    family: "Georgia, 'Times New Roman', serif",
  }),
  editorial: Object.freeze({
    family: "'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
  }),
  traditional: Object.freeze({
    family: "'Times New Roman', Times, serif",
  }),
  book: Object.freeze({
    family: 'Cambria, Georgia, serif',
  }),
  garamond: Object.freeze({
    family: 'Garamond, Baskerville, serif',
  }),
  friendly: Object.freeze({
    family: "'Trebuchet MS', Arial, sans-serif",
  }),
});

function resolveWanderluxFontStyle(styleId) {
  const key = String(styleId || '').trim().toLowerCase();
  return WANDERLUX_FONT_STYLES[key] || null;
}

function applyWanderluxGlobalFontStyle(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const theme = config.theme && typeof config.theme === 'object' && !Array.isArray(config.theme)
    ? config.theme
    : null;
  const style = resolveWanderluxFontStyle(theme && theme.fontStyleId);
  if (!style) return config;

  return {
    ...config,
    theme: {
      ...theme,
      serifFont: style.family,
      sansFont: style.family,
    },
  };
}

function sectionFontStyle(config, sectionKey) {
  const theme = config && config.theme && typeof config.theme === 'object' ? config.theme : {};
  const overrides = theme.sectionFontStyles && typeof theme.sectionFontStyles === 'object'
    ? theme.sectionFontStyles
    : {};
  return resolveWanderluxFontStyle(overrides[sectionKey]);
}

function sectionFontStyleId(config, sectionKey) {
  const theme = config && config.theme && typeof config.theme === 'object' ? config.theme : {};
  const overrides = theme.sectionFontStyles && typeof theme.sectionFontStyles === 'object'
    ? theme.sectionFontStyles
    : {};
  const styleId = String(overrides[sectionKey] || '').trim().toLowerCase();
  return resolveWanderluxFontStyle(styleId) ? styleId : '';
}

function fontStyleVars(style) {
  if (!style || !style.family) return '';
  return ` style="--c-serif:${style.family};--c-sans:${style.family}"`;
}

module.exports = {
  WANDERLUX_FONT_STYLES,
  resolveWanderluxFontStyle,
  applyWanderluxGlobalFontStyle,
  sectionFontStyle,
  sectionFontStyleId,
  fontStyleVars,
};
