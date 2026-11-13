'use strict';

// Keep this allowlist in sync with frontend/src/utils/landingFontStyles.js.
// These are system-backed stacks so published landing pages do not depend on
// a third-party font request or accept arbitrary CSS from page content.
const LANDING_FONT_FAMILIES = Object.freeze({
  modern: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  classic: 'Georgia, Times New Roman, serif',
  editorial: 'Palatino Linotype, Book Antiqua, Palatino, Georgia, serif',
  friendly: 'Trebuchet MS, Arial, sans-serif',
});

const DEFAULT_LANDING_FONT_STYLE = 'modern';

function resolveLandingFontFamily(styleId) {
  return LANDING_FONT_FAMILIES[styleId] || LANDING_FONT_FAMILIES[DEFAULT_LANDING_FONT_STYLE];
}

module.exports = {
  LANDING_FONT_FAMILIES,
  DEFAULT_LANDING_FONT_STYLE,
  resolveLandingFontFamily,
};
