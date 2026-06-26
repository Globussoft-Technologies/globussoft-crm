/**
 * wanderlux/index.js — Wanderlux landing-page renderer (Road A, 2026-06-23).
 *
 * Why this exists:
 *   The four-family CRM template architecture (educational / religious /
 *   family / luxury) was producing pages that did not match the visual
 *   quality of the standalone reference at
 *   `C:\Users\Admin\Downloads\Telegram Desktop\dynamic_page_geneator`
 *   (the "Wanderlux" reference). After multiple rounds of incremental fixes
 *   ("opacity drop", "pattern removal", "bridge slot fills"), the gap was
 *   still structural: the reference uses a single config-driven Design
 *   Component (`<x-dc>`) that renders an entire premium microsite from a
 *   `config` object, while the CRM's renderer is a 1000-line per-family
 *   composer with its own CSS. We ported the reference verbatim — copying
 *   `landing-page.dc.html` + `support.js` from the reference folder into
 *   this directory — and surface it as a new templateType, "wanderlux-v1".
 *
 * Render contract:
 *   render({ landingPage, options }) → HTML string.
 *   The HTML is the reference's `landing-page.dc.html` with:
 *     - `<script>window.__PAGE_CONFIG = <configJson>;</script>` injected
 *       BEFORE the support.js script tag, so the dc-runtime picks the
 *       config up at boot.
 *     - The relative `<script src="./support.js">` rewritten to the
 *       absolute static path the route exposes
 *       (`/api/landing-pages/wanderlux-static/support.js`).
 *
 * Config shape:
 *   The reference's config schema is documented in
 *   `backend/services/templates/wanderlux/README.md` (copied from the
 *   reference). Every block is optional; omitted blocks (or empty arrays)
 *   simply do not render — there are NO `[REVIEW]` placeholders. The
 *   landing-page row stores the config object as JSON-stringified
 *   `LandingPage.content`. The bridge that maps the LLM's emitted content
 *   into this config shape lives in `wanderluxBridge.js` (next file).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const layoutComposer = require('./layoutComposer');

const TEMPLATE_ID = 'wanderlux-v1';
const TEMPLATE_DIR = __dirname;
const HTML_PATH = path.join(TEMPLATE_DIR, 'landing-page.dc.html');

let CACHED_HTML = null;
function readTemplateHtml() {
  if (CACHED_HTML) return CACHED_HTML;
  CACHED_HTML = fs.readFileSync(HTML_PATH, 'utf8');
  return CACHED_HTML;
}

// `composeLayout` ALWAYS runs (with effective layout = DEFAULT_SECTION_ORDER
// when no operator customisation is present). The wrapper-div + bridge-
// script overhead is tiny, and running unconditionally means the editor's
// click-on-canvas → scroll-the-panel affordance works from the first
// preview — operators don't have to make any layout change before they
// can click around. Visual output for an un-customised page is identical
// to the raw template (the wrappers are inert transparent divs).

/**
 * Build the rendered HTML for one landing page.
 *
 * @param {Object} landingPage    — Prisma LandingPage row (we read .content)
 * @param {Object} [options]      — { previewMode: boolean, supportJsUrl: string }
 * @returns {string} HTML
 */
function render(landingPage, options = {}) {
  let config = null;
  if (landingPage && typeof landingPage.content === 'string') {
    try {
      config = JSON.parse(landingPage.content);
    } catch (e) {
      // Bad JSON in DB — render the reference's built-in Japan demo so the
      // page still looks like SOMETHING instead of a broken stub. The
      // builder's save-side validation guards against this in normal flow.
      config = null;
    }
  } else if (landingPage && typeof landingPage.content === 'object' && landingPage.content) {
    config = landingPage.content;
  }

  // Fill the submission endpoints for PUBLISHED renders (the public
  // /p/:slug surface). The bridge persists `register.endpoint` and
  // `brochure.endpoint` as null because the slug isn't always stable at
  // generation time; we wire them at render time so submissions hit the
  // right /api/landing-pages/:slug/submit route. The dc-runtime's
  // submitForm() treats a missing endpoint as "preview mode" and
  // surfaces a toast instead of POSTing — that path is intentional for
  // operator previews and for any draft / archived render.
  if (config && landingPage && landingPage.slug && !options.preview && landingPage.status === 'PUBLISHED') {
    const submitUrl = `/api/landing-pages/${encodeURIComponent(landingPage.slug)}/submit`;
    if (config.register && typeof config.register === 'object') {
      config.register.endpoint = submitUrl;
    }
    if (config.brochure && typeof config.brochure === 'object') {
      config.brochure.endpoint = submitUrl;
    }
  }
  // Pass the preview flag through to the runtime so the toast can tell
  // the visitor "this is a preview — submissions aren't saved."
  if (config && typeof config === 'object') {
    config.meta = Object.assign({}, config.meta || {}, {
      isPreview: !!options.preview,
      isPublished: !!(landingPage && landingPage.status === 'PUBLISHED'),
    });
  }

  let html = readTemplateHtml();

  // Hybrid layout: always compose so the editor click-on-canvas bridge
  // works from the first preview. When _layout is absent the composer
  // emits the default section order — visually identical to the raw
  // template aside from the inert data-wlx wrappers + bridge script.
  try {
    const slug = (landingPage && landingPage.slug) || '';
    html = layoutComposer.composeLayout(html, config || {}, slug);
  } catch (e) {
    // Fall back to the un-rewritten template — better a layout-defaults
    // render than a 500. The composer throws only when the template's
    // section markers have drifted (template-shape regression caught
    // by the wanderlux-layout vitest).
    console.error('[wanderlux] layout composer failed, falling back:', e && e.message);
  }

  // The reference template references `./support.js` (relative). When
  // served from `/api/landing-pages/:id/preview` (or the public /p/:slug)
  // the relative path resolves to the wrong URL. Rewrite to the absolute
  // static path the route exposes (mounted by routes/landing_pages.js).
  const supportJsUrl = options.supportJsUrl || '/api/landing-pages/wanderlux-static/support.js';
  const supportTag = `<script src="${supportJsUrl}"></script>`;
  let out = html.replace(
    /<script\s+src="\.\/support\.js"\s*><\/script>/,
    supportTag,
  );

  // Inject the config as a global RIGHT BEFORE the support.js tag. The
  // dc-runtime reads `window.__PAGE_CONFIG` at boot (see landing-page.dc.html
  // renderVals()), deep-merges it with DEFAULT_CONFIG, and renders. Empty
  // config (null/undefined) skips injection — the reference's built-in
  // Japan demo renders instead, which is the intended preview-without-
  // content behaviour.
  if (config) {
    const safeJson = JSON.stringify(config)
      // Defence-in-depth: escape `</` so a string field can't break out
      // of the <script> tag.
      .replace(/<\//g, '<\\/');
    const injection = `<script>window.__PAGE_CONFIG = ${safeJson};</script>\n${supportTag}`;
    out = out.replace(supportTag, injection);
  }

  return out;
}

const wanderlux = {
  id: TEMPLATE_ID,
  themeId: null, // Theme is config.theme, set by the LLM/bridge per-tour.
  family: 'wanderlux',
  render,
  // The wanderlux template stores config-shape content directly — no
  // pre-render bridge layer. The /generate-from-destination route
  // converts LLM block-output to the config shape via wanderluxBridge.
  schema: { editorSlots: [], slotLabels: {} },
  // Empty default content = the reference renders its built-in Japan demo.
  defaultContent: {},
};

module.exports = wanderlux;
