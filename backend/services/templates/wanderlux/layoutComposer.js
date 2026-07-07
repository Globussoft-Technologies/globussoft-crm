// Wanderlux hybrid-layout composer.
//
// Splits the static `landing-page.dc.html` template into named section
// chunks so they can be reordered, hidden, or interleaved with custom
// blocks (Heading/Text/Image/Button/Divider/Spacer/Video/TwoColumns)
// from the manual block-builder catalogue.
//
// Why this exists:
//   The wanderlux template renders a FIXED order of sections via a chain
//   of `<sc-if value="{{ showX }}">…</sc-if>` blocks evaluated by the
//   dc-runtime in support.js. Operators want the same reorder / add /
//   delete affordances they get on manually-built pages without us
//   migrating the template to a pure block-array model. This file is
//   that bridge: it reads `config._layout.items[]` (the saved order +
//   custom blocks) and rewrites the body of the template HTML
//   accordingly. When `_layout` is absent, the original template HTML
//   passes through untouched — full backwards compatibility with every
//   wanderlux page already in the DB.
//
// Section keys (stable identifiers): hero, countdown, cities, video,
//   intro, highlights, safety, testimonials, investment, register,
//   brochure, faqs, finalCta, footer. Sticky nav + floating register
//   button stay fixed (always before / after the body); reordering is
//   scoped to body sections only.
//
// Custom blocks are rendered via the manual public renderer's
// `renderComponent()` — same HTML output as a manual landing page —
// wrapped in a max-width wanderlux-styled section so they match the
// template's visual rhythm.

'use strict';

// Section marker → stable key. The marker text is the prose label inside
// the `<!-- ===================== LABEL ===================== -->` line
// in landing-page.dc.html. Keys mirror the top-level config keys
// (config.hero, config.cities, etc.) so the editor can compute a stable
// title from the key alone.
const SECTION_KEY_BY_MARKER = Object.freeze({
  'HERO': 'hero',
  'COUNTDOWN': 'countdown',
  'CITY MARQUEE': 'cities',
  'VIDEO / PREVIEW': 'video',
  'INTRO / WHY IT MATTERS': 'intro',
  'CULTURAL HIGHLIGHTS / FLIP CARDS': 'highlights',
  'SAFETY (dark)': 'safety',
  'TESTIMONIALS': 'testimonials',
  'INVESTMENT / PRICING': 'investment',
  'REGISTRATION': 'register',
  'BROCHURE': 'brochure',
  'FAQ (light)': 'faqs',
  'FINAL CTA (brand)': 'finalCta',
  'FOOTER': 'footer',
});

// Body-section order as it appears in the template. Used as the default
// when `_layout` is absent (= no operator customisation) AND as the
// canonical list for "what sections does this template know about".
const DEFAULT_SECTION_ORDER = Object.freeze([
  'hero', 'countdown', 'cities', 'video', 'intro', 'highlights', 'safety',
  'testimonials', 'investment', 'register', 'brochure', 'faqs', 'finalCta',
  'footer',
]);

const ALL_SECTION_KEYS = new Set(DEFAULT_SECTION_ORDER);

// Custom-block types operators can interleave between sections. Mirrors
// the generic group in LandingPageBuilder.jsx's COMPONENT_TYPES — kept
// in lockstep so a block added on a wanderlux page renders identically
// to the same block on a manual page.
const CUSTOM_BLOCK_TYPES = Object.freeze(new Set([
  'heading', 'text', 'image', 'button', 'divider', 'spacer', 'video', 'columns',
]));

// FIRST section marker = boundary between the always-on prefix
// (doctype/head/nav/sticky header) and the reorderable body.
// LAST sentinel = the FLOATING REGISTER marker that closes the body.
// We keep the floating-register pill always-on because it's a fixed
// overlay, not a flow element — hiding it would surprise operators who
// expect the "Register" CTA to stay visible while scrolling.
const FIRST_BODY_MARKER = '<!-- ===================== HERO ===================== -->';
const FLOATING_MARKER = '<!-- ===================== FLOATING REGISTER ===================== -->';

// Regex matches every section comment line. Capture group is the inner
// label (e.g. "HERO" or "CITY MARQUEE"). Anchored to the comment marker
// shape exactly so an in-content `===` (none today, but defensive) can't
// accidentally split a section.
//
// The closing `-->` is NOT required on the same line — the FAQ marker
// in the live template is a multi-line comment whose label sits on the
// first line and prose continues for several more before `-->`. The
// negative-charclass `[^=\n]+?` keeps the label single-line and prevents
// the regex from greedily swallowing later sections.
const SECTION_MARKER_RE = /<!--\s*=+\s*([^=\n]+?)\s*=+/g;

let CACHED_SPLIT = null;
function _resetCache() { CACHED_SPLIT = null; }

/**
 * Split the wanderlux template HTML into prefix + per-section chunks +
 * suffix. Cached after first call (the template never changes at
 * runtime); tests can reset via `_resetCache`.
 *
 * @param {string} html — the full landing-page.dc.html
 * @returns {{
 *   prefix: string,
 *   sections: Record<string, string>,
 *   suffix: string,
 *   sectionOrder: string[],
 *   unknownMarkers: string[],
 * }}
 */
function splitTemplate(html) {
  if (CACHED_SPLIT && CACHED_SPLIT._sourceLength === html.length) {
    return CACHED_SPLIT;
  }

  const firstIdx = html.indexOf(FIRST_BODY_MARKER);
  const floatingIdx = html.indexOf(FLOATING_MARKER);
  if (firstIdx < 0 || floatingIdx < 0) {
    // Template shape changed — bail out and let the caller fall back to
    // the unmodified template. Better than rendering broken HTML.
    throw new Error('wanderlux/layoutComposer: section boundary markers not found in template');
  }

  const prefix = html.slice(0, firstIdx);
  const body = html.slice(firstIdx, floatingIdx);
  const suffix = html.slice(floatingIdx);

  // Walk the body, splitting at each section marker. We accept all
  // markers found, even unknown ones — unknown markers stay glued to
  // the preceding section so we don't lose content if the template
  // grows a new marker we haven't mapped yet.
  const sections = {};
  const sectionOrder = [];
  const unknownMarkers = [];

  const matches = [];
  SECTION_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_MARKER_RE.exec(body)) !== null) {
    matches.push({ start: m.index, label: m[1].trim() });
  }

  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].start;
    const end = i + 1 < matches.length ? matches[i + 1].start : body.length;
    const chunk = body.slice(start, end);
    const key = SECTION_KEY_BY_MARKER[matches[i].label];
    if (key) {
      sections[key] = chunk;
      sectionOrder.push(key);
    } else {
      // Unknown marker — append the chunk to the previous known section
      // so it still renders (just in the same position).
      unknownMarkers.push(matches[i].label);
      const last = sectionOrder[sectionOrder.length - 1];
      if (last) sections[last] += chunk;
      else {
        // No previous section to glue to → prepend to suffix-equivalent
        // by stashing in a synthetic key. Realistically unreachable for
        // the current template; defensive only.
        sections.__unknown_head = (sections.__unknown_head || '') + chunk;
      }
    }
  }

  CACHED_SPLIT = {
    _sourceLength: html.length,
    prefix,
    sections,
    suffix,
    sectionOrder,
    unknownMarkers,
  };
  return CACHED_SPLIT;
}

/**
 * Normalise the operator-supplied `_layout.items[]` into a clean list
 * the renderer can iterate without further validation. Drops:
 *   - section refs whose key isn't in DEFAULT_SECTION_ORDER (typo /
 *     stale data from an older template version)
 *   - duplicate section refs (a section can appear at most once)
 *   - custom blocks with no/invalid `type` (the catalogue is closed)
 *   - non-object entries
 *
 * @returns {Array<{kind:'section', key:string} | {kind:'block', id:string, type:string, props:object}>}
 */
function normaliseLayoutItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  const seenSections = new Set();
  for (let i = 0; i < rawItems.length; i += 1) {
    const it = rawItems[i];
    if (!it || typeof it !== 'object') continue;
    if (it.kind === 'section') {
      if (typeof it.key !== 'string') continue;
      if (!ALL_SECTION_KEYS.has(it.key)) continue;
      if (seenSections.has(it.key)) continue;
      seenSections.add(it.key);
      out.push({ kind: 'section', key: it.key });
    } else if (it.kind === 'block') {
      if (typeof it.type !== 'string') continue;
      if (!CUSTOM_BLOCK_TYPES.has(it.type)) continue;
      out.push({
        kind: 'block',
        id: typeof it.id === 'string' && it.id ? it.id : `b_${Date.now()}_${i}`,
        type: it.type,
        props: it.props && typeof it.props === 'object' && !Array.isArray(it.props) ? it.props : {},
      });
    }
  }
  return out;
}

/**
 * Build the list of items the page should render. When the operator
 * hasn't customised the layout yet (`_layout` absent or empty), this is
 * just the default section order with no custom blocks — preserving the
 * exact pre-layout behaviour.
 */
function effectiveLayout(config) {
  const cfgLayout = config && config._layout;
  if (cfgLayout && Array.isArray(cfgLayout.items) && cfgLayout.items.length > 0) {
    return normaliseLayoutItems(cfgLayout.items);
  }
  return DEFAULT_SECTION_ORDER.map((key) => ({ kind: 'section', key }));
}

/**
 * Render a custom block to HTML using the manual landing-page
 * renderer's `renderComponent`. Wraps the output in a wanderlux-styled
 * `<section>` so it matches the visual rhythm of native sections.
 *
 * Slug is forwarded so a custom Form block's submit URL still resolves
 * to /p/<slug>/submit (parity with manual pages).
 */
function renderCustomBlock(item, slug) {
  // Late-required to dodge a require cycle: landingPageRenderer.js
  // requires ./templates/index.js (via the dispatcher), which requires
  // wanderlux/index.js, which requires this file. Late-requiring keeps
  // module init order safe.
  const { renderComponent } = require('../../landingPageRenderer');
  let inner;
  try {
    inner = renderComponent({ type: item.type, props: item.props || {} }, slug || '');
  } catch (_e) {
    // Fail-soft: a malformed prop set should not 500 the whole page.
    inner = '';
  }
  if (!inner) return '';
  return (
    `<section aria-label="Custom block" style="background:var(--c-light);padding:48px 28px">` +
    `<div style="max-width:1240px;margin:0 auto">${inner}</div>` +
    `</section>`
  );
}

// Editor postMessage bridge — injected once at the end of the body so
// clicks on a `[data-wlx-section]` or `[data-wlx-block]` wrapper
// bubble up to the builder. The wanderlux preview opens in either an
// iframe (future inline-preview tab) OR a popup window
// (`window.open(...)` from the builder's "Preview" button — current
// flow), so we post to `window.opener` first and fall back to
// `window.parent`. The script no-ops when neither exists, leaving
// production /p/<slug> renders untouched. Origin filtering happens on
// the receiver side.
const EDITOR_BRIDGE_SCRIPT =
  `<script>(function(){` +
  `var target=window.opener||(window.parent&&window.parent!==window?window.parent:null);` +
  `if(!target)return;` +
  `function findKey(el){while(el&&el!==document.body){` +
  `if(el.dataset&&(el.dataset.wlxSection||el.dataset.wlxBlock))` +
  `return{kind:el.dataset.wlxSection?'section':'block',` +
  `id:el.dataset.wlxSection||el.dataset.wlxBlock};` +
  `el=el.parentElement;}return null;}` +
  `document.addEventListener('click',function(e){` +
  `var hit=findKey(e.target);if(!hit)return;` +
  `try{target.postMessage({type:'wlx-canvas-click',kind:hit.kind,id:hit.id},'*');}catch(_){}` +
  `},true);})();</script>`;

/**
 * Assemble the final HTML by walking the effective layout. Sections
 * not present in the layout are HIDDEN (omitted entirely). Custom
 * blocks render inline between sections.
 *
 * `templateHtml` is the cached `landing-page.dc.html`. We split it into
 * chunks, then concatenate prefix + ordered body + suffix.
 *
 * Each emitted chunk is wrapped in a `data-wlx-section="<key>"` or
 * `data-wlx-block="<id>"` div so the editor postMessage bridge can map
 * a canvas click back to the matching panel entry. The wrapper is
 * inline + transparent, so the dc-runtime walks through it as plain
 * HTML and visual output is identical to a non-editor render.
 */
function composeLayout(templateHtml, config, slug) {
  const split = splitTemplate(templateHtml);
  const layout = effectiveLayout(config);

  const bodyParts = [];
  for (const item of layout) {
    if (item.kind === 'section') {
      const chunk = split.sections[item.key];
      if (chunk) {
        bodyParts.push(`<div data-wlx-section="${item.key}">${chunk}</div>`);
      }
      // Unknown section key → already filtered by normaliseLayoutItems.
    } else if (item.kind === 'block') {
      const html = renderCustomBlock(item, slug);
      if (html) {
        const safeId = String(item.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
        bodyParts.push(`<div data-wlx-block="${safeId}">${html}</div>`);
      }
    }
  }

  // Bridge script appended at the END of the body so it sits after the
  // section markup it observes; the dc-runtime tolerates trailing
  // <script> tags inside <x-dc> (they execute in DOM-order after the
  // template parses). The script self-no-ops outside an iframe.
  return split.prefix + bodyParts.join('\n') + EDITOR_BRIDGE_SCRIPT + split.suffix;
}

module.exports = {
  SECTION_KEY_BY_MARKER,
  DEFAULT_SECTION_ORDER,
  CUSTOM_BLOCK_TYPES,
  splitTemplate,
  normaliseLayoutItems,
  effectiveLayout,
  composeLayout,
  renderCustomBlock,
  _resetCache,
};
