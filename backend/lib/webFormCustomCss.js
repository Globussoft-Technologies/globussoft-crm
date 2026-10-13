const MAX_CUSTOM_CSS_LENGTH = 20000;

/**
 * Custom CSS is rendered in the form's isolated iframe. Keep the feature
 * focused on presentation rules and prevent external resource loads or
 * legacy script-like CSS constructs from being persisted.
 */
function sanitizeCustomCss(value) {
  const css = String(value == null ? "" : value).slice(0, MAX_CUSTOM_CSS_LENGTH);

  return css
    .replace(/<\/?\s*style\b[^>]*>/gi, "")
    .replace(/@import\s+[^;{}]+;?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/(?:-moz-binding|behavior)\s*:[^;{}]+;?/gi, "")
    .replace(/javascript\s*:/gi, "")
    .trim();
}

module.exports = {
  MAX_CUSTOM_CSS_LENGTH,
  sanitizeCustomCss,
};
