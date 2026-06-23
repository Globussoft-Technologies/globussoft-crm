/**
 * travel-premium-v1 — generic premium destination template.
 *
 * PR-E Phase 1 — kept as a working template for backwards compatibility
 * with pages created before the four-family architecture landed. It
 * acts as a generic-destination-microsite shell, sharing the universal
 * components renderer with a neutral palette (family-bali is the
 * vibrant-but-versatile default).
 *
 * New AI generation flows go through Travel Experience Engine which
 * picks one of {educational, religious, family, luxury} explicitly;
 * the engine never emits travel-premium-v1. Existing pages keep
 * working through this delegate.
 */

'use strict';

const universal = require('./universalComponents');
const themeTokens = require('./themeTokens');
const educationalTripV1 = require('./educationalTripV1');

const TEMPLATE_ID = 'travel-premium-v1';
// PR-E Option B: family-generic style bucket. Legacy `family-bali` alias
// resolves through themeTokens for any persisted pages.
const DEFAULT_THEME_ID = 'family-tropical';

function render(landingPage, options = {}) {
  let themeId = options.theme || (landingPage && landingPage.themeId);
  if (!themeId && landingPage && landingPage.content) {
    try {
      const parsed = typeof landingPage.content === 'string'
        ? JSON.parse(landingPage.content)
        : landingPage.content;
      if (parsed && typeof parsed === 'object' && parsed._themeId) themeId = parsed._themeId;
    } catch (_e) { /* ignore */ }
  }
  const theme = (themeId && themeTokens.getTheme(themeId))
    || themeTokens.getTheme(DEFAULT_THEME_ID)
    || themeTokens.getDefaultTheme('family');
  // Use the educational template's default content shape so existing
  // travel-premium-v1 pages — which were authored against that shape
  // when it was the only available template — keep rendering exactly.
  return universal.renderTemplatePage(
    landingPage,
    educationalTripV1.defaultContent,
    theme,
    options
  );
}

module.exports = {
  id: TEMPLATE_ID,
  themeId: DEFAULT_THEME_ID,
  family: 'family',
  schema: educationalTripV1.schema,
  defaultContent: educationalTripV1.defaultContent,
  render,
  mapBlocksToContent: educationalTripV1.mapBlocksToContent,
};
