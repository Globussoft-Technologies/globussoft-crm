/** Public surface of the brochure template engine. */
export * from './types.js';
export {
  buildBrochureHtml,
  parseBrochureContent,
  buildFallbackBrochureContent,
  ensureBriefCoverage,
  normalizeAccent,
  contrastInk,
  darken,
  lighten,
  type BrochureRenderOptions,
  type BrandKit,
  type LogoPlacement,
  type LogoCorner,
  type LogoPlacementCustom,
  type EdMeasureFn,
} from './render-core.js';
export {
  TEMPLATES,
  TEMPLATE_KEYS,
  TEMPLATE_LIST,
  DEFAULT_TEMPLATE_KEY,
  getTemplate,
  type TemplateSummary,
} from './templates.js';
