/**
 * universalComponents.js — PR-E Phase 1.
 *
 * Shared section renderers used by ALL four template families
 * (educational / religious / family / luxury). Extracts the section
 * rendering work from the legacy educationalTripV1.js into reusable
 * functions so the per-template files can stay small (~150-200 lines
 * each) and so adding a new family doesn't mean duplicating 1500
 * lines of section markup.
 *
 * Contract for each renderer
 * ──────────────────────────
 *   render<Section>(content, theme) → htmlString
 *     - content : merged semantic content payload (DEFAULT_CONTENT
 *                 overlayed with operator/AI overrides)
 *     - theme   : a theme object from themeTokens.js (palette,
 *                 typography, decorative, icons). Theme drives ONLY:
 *                   • SVG icon resolution (theme.icons overrides
 *                     extend the base SVG library so e.g. religious
 *                     tours render mosque silhouettes where
 *                     educational renders pagodas)
 *                   • the brand-watermark glyph default (when content
 *                     leaves brand.kanji blank, the theme's brand
 *                     decoration fills in)
 *                 Palette/typography come via CSS variables; the
 *                 section renderers never inline color values.
 *
 * Returns '' for sections the operator/AI chose to hide. Each section's
 * HTML class names are identical to the legacy educationalTripV1.js so
 * the existing 818-line test suite continues to pin the shape.
 *
 * Composition
 * ───────────
 * Templates call `renderTemplatePage(landingPage, theme, options)` which:
 *   1. Parses + merges content with the template's defaultContent
 *   2. Iterates theme.sectionOrder, invoking the matching renderer
 *   3. Wraps the result in `<html>...<body><div class="trips-page" data-theme-family="X" data-theme-id="Y">...</div></body></html>`
 *   4. Inlines the shared base CSS + the theme overlay CSS
 *   5. Appends the universal inline-script block (countdown / FAQ /
 *      registration funnel / brochure submit)
 *
 * Why extract instead of refactor in-place
 * ────────────────────────────────────────
 * The educationalTripV1.js test suite (818 lines) pins specific HTML
 * fragments + class names. Replacing those renderers carries regression
 * risk. Extracting and routing the legacy template through the same
 * universal renderers preserves the exact HTML output (verified by
 * tests) while letting the 3 new templates share the same code.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { safeUrl } = require('../landingPageRenderer');
const themeTokens = require('./themeTokens');

// ── HTML escape (mirrors landingPageRenderer's helper) ──────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── BASE SVG library ─────────────────────────────────────────────────
// Shared SVG fragments referenced by stable id. Templates extend via
// `theme.icons` (additional per-family / per-variant glyphs). Operator
// + AI reference by id; never write raw SVG.

const BASE_SVG = Object.freeze({
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  briefcase: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="9.5" y1="13.5" x2="14.5" y2="13.5"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  package: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  shieldCheck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  building: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="1"/><line x1="9" y1="6" x2="9.01" y2="6"/><line x1="15" y1="6" x2="15.01" y2="6"/><line x1="9" y1="10" x2="9.01" y2="10"/><line x1="15" y1="10" x2="15.01" y2="10"/><line x1="9" y1="14" x2="9.01" y2="14"/><line x1="15" y1="14" x2="15.01" y2="14"/><path d="M10 22v-4h4v4"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  // Legacy educational-japan cultural glyphs — preserved so existing
  // educationalTripV1 content with icon: 'tokyo' / 'fuji' / etc. still
  // resolves. Names are family-neutral fallbacks too.
  cultural_tokyo: `<svg viewBox="0 0 40 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M20 2 L20 6"/><path d="M20 6 L14 50 L26 50 Z"/><line x1="16.5" y1="20" x2="23.5" y2="20"/><line x1="15.5" y1="30" x2="24.5" y2="30"/><line x1="14.5" y1="40" x2="25.5" y2="40"/></svg>`,
  cultural_fuji: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M4 36 L25 6 L46 36 Z"/><path d="M18 18 L25 10 L32 18"/></svg>`,
  cultural_kyoto: `<svg viewBox="0 0 50 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M3 8 Q25 -1 47 8"/><line x1="6" y1="13" x2="44" y2="13"/><line x1="13" y1="13" x2="13" y2="38"/><line x1="37" y1="13" x2="37" y2="38"/></svg>`,
  cultural_nara: `<svg viewBox="0 0 40 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><line x1="20" y1="2" x2="20" y2="8"/><line x1="10" y1="8" x2="30" y2="8"/><line x1="13" y1="12" x2="27" y2="12"/><line x1="13" y1="12" x2="13" y2="50"/><line x1="27" y1="12" x2="27" y2="50"/><line x1="13" y1="24" x2="27" y2="24"/><line x1="13" y1="38" x2="27" y2="38"/></svg>`,
  cultural_osaka: `<svg viewBox="0 0 40 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><line x1="20" y1="2" x2="20" y2="8"/><line x1="14" y1="12" x2="26" y2="12"/><line x1="8" y1="18" x2="8" y2="28"/><line x1="32" y1="18" x2="32" y2="28"/><line x1="3" y1="28" x2="37" y2="28"/><line x1="11" y1="32" x2="11" y2="48"/><line x1="29" y1="32" x2="29" y2="48"/><line x1="6" y1="48" x2="34" y2="48"/><line x1="20" y1="32" x2="20" y2="48"/></svg>`,
  // Generic landmark glyph fallback — cultural section reaches for this
  // when neither the theme's icons nor the legacy library know the id.
  cultural_generic: `<svg viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><circle cx="25" cy="25" r="18"/><path d="M14 30 L25 16 L36 30"/><circle cx="25" cy="33" r="2"/></svg>`,
});

/**
 * Resolve a glyph by id. Search order:
 *   1. theme.icons[id]   — per-theme override (e.g. religious-umrah cultural_kaaba)
 *   2. theme.icons[`cultural_${id}`] — bare cultural id (operator wrote 'kaaba' not 'cultural_kaaba')
 *   3. BASE_SVG[id]      — shared library
 *   4. BASE_SVG[`cultural_${id}`]
 *   5. BASE_SVG.cultural_generic — final fallback
 */
function svg(name, theme) {
  if (!name) return BASE_SVG.cultural_generic;
  const themeIcons = (theme && theme.icons) || {};
  if (themeIcons[name]) return themeIcons[name];
  const culturalKey = `cultural_${name}`;
  if (themeIcons[culturalKey]) return themeIcons[culturalKey];
  if (BASE_SVG[name]) return BASE_SVG[name];
  if (BASE_SVG[culturalKey]) return BASE_SVG[culturalKey];
  return BASE_SVG.cultural_generic;
}

// ── Inline CSS (loaded once at module init) ─────────────────────────
// Two layers, concatenated in order:
//   1. educationalTripV1.css — the original shell that pins the
//      HTML-class contract pinned by the 818-line educationalTripV1
//      test suite. Loaded first so all base class selectors exist.
//   2. baseTravelTemplate-polish.css — PR-E Phase 1.5 visual polish
//      additive layer (italic light serif h1, clamp() typography,
//      glass nav, radial-gradient hero atmosphere, alternating
//      section backgrounds, premium FAQ, stronger footer, final-CTA
//      treatment, pulse animations, tall-portrait marquee, etc.).
//      Loaded SECOND so it wins on overlapping properties. Uses ONLY
//      CSS variables — no hardcoded palette / typography — so every
//      lift applies to all four template families equally.
//
// Theme overlay CSS (rendered from themeTokens.renderThemeOverlayCss
// at request time) is inlined AFTER both so its CSS-variable values
// take effect on every selector both layers reference.

let _CSS_CACHE = null;
function loadBaseCss() {
  if (_CSS_CACHE !== null) return _CSS_CACHE;
  let base = '';
  let polish = '';
  try { base = fs.readFileSync(path.join(__dirname, 'educationalTripV1.css'), 'utf8'); } catch (_e) { /* ignore */ }
  try { polish = fs.readFileSync(path.join(__dirname, 'baseTravelTemplate-polish.css'), 'utf8'); } catch (_e) { /* ignore */ }
  _CSS_CACHE = base + '\n\n/* ── PR-E Phase 1.5 polish layer ── */\n' + polish;
  return _CSS_CACHE;
}

function resetCssCache() {
  _CSS_CACHE = null;
}

// ── Deep-merge helper ───────────────────────────────────────────────
// Tolerant merge of operator payload over template defaults. Arrays
// from payload REPLACE the default; plain objects merge recursively.
// Mirrors the educationalTripV1 helper exactly so existing _mergeContent
// tests stay green.

function mergeContent(defaults, overrides) {
  if (overrides == null) return defaults;
  if (typeof defaults !== 'object' || defaults === null) return overrides;
  if (typeof overrides !== 'object' || overrides === null) return defaults;
  if (Array.isArray(defaults) || Array.isArray(overrides)) return overrides;
  const out = {};
  const keys = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) {
      out[k] = mergeContent(defaults[k], overrides[k]);
    } else {
      out[k] = defaults[k];
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// SECTION RENDERERS
// Each takes (content, theme) → htmlString. They DELIBERATELY do not
// know which template family invoked them — palette/typography flow in
// via CSS variables; iconography flows via the theme parameter only
// for glyph-id resolution.
// ═══════════════════════════════════════════════════════════════════

// Resolve the decorative brand glyph: content explicit > theme fallback.
function brandGlyphFor(content, theme) {
  const explicit = (content && content.brand && content.brand.kanji) || '';
  if (explicit) return explicit;
  return (theme && theme.decorative && theme.decorative.brand) || '';
}

// Resolve the decorative hero watermark glyph: content > brand > theme.
function watermarkGlyphFor(content, theme) {
  const explicit = (content && content.hero && content.hero.kanjiWatermark) || '';
  if (explicit) return explicit;
  const brand = (content && content.brand && content.brand.kanji) || '';
  if (brand) return brand;
  return (theme && theme.decorative && theme.decorative.watermark) || '';
}

function renderNav(content, theme) {
  const nav = content.nav || {};
  const brand = content.brand || {};
  const links = Array.isArray(nav.links) ? nav.links : [];
  const ctaText = escapeHtml(nav.ctaText || 'Register Now');
  const ctaHref = escapeHtml(safeUrl(nav.ctaHref || '#register', 'link-href'));
  const glyph = brandGlyphFor(content, theme);
  return `<header class="t-nav">
    <div class="t-nav-inner">
      <a class="t-brand" href="#">
        ${glyph ? `<span class="t-jp">${escapeHtml(glyph)}</span>` : ''} ${escapeHtml(brand.label || '')}
      </a>
      <nav class="t-links">
        ${links.map((l) => `<a href="${escapeHtml(safeUrl(l.href || '#', 'link-href'))}">${escapeHtml(l.label || '')}</a>`).join('')}
      </nav>
      <a class="t-btn t-btn-primary" href="${ctaHref}">${ctaText}</a>
    </div>
  </header>`;
}

function renderHero(content, theme) {
  const hero = content.hero || {};
  const eyebrow = hero.eyebrow || {};
  const cards = Array.isArray(hero.benefitCards) ? hero.benefitCards : [];
  const partners = Array.isArray((content.brand || {}).partnerLogos) ? content.brand.partnerLogos : [];
  const countdown = hero.countdown || {};
  const watermark = watermarkGlyphFor(content, theme);

  const partnersHtml = partners.length
    ? `<div class="t-partners">${partners
        .map((p) => {
          if (!p || !p.src) return '';
          const url = escapeHtml(safeUrl(p.src, 'image-src'));
          const alt = escapeHtml(p.alt || 'partner');
          return `<img src="${url}" alt="${alt}" class="t-partner-logo" loading="lazy" />`;
        })
        .join('')}</div>`
    : '';

  const eyebrowChips = [];
  if (eyebrow.date) eyebrowChips.push(`<span>${escapeHtml(eyebrow.date)}</span>`);
  if (eyebrow.audience) eyebrowChips.push(`<span>${escapeHtml(eyebrow.audience)}</span>`);
  const eyebrowHtml = (eyebrowChips.length || eyebrow.batchPill)
    ? `<div class="t-eyebrow">${eyebrowChips.join('<span class="t-sep">|</span>')}${eyebrow.batchPill ? `<span class="t-pill">${escapeHtml(eyebrow.batchPill)}</span>` : ''}</div>`
    : '';

  const benefitCardsHtml = cards.length
    ? `<div class="t-cards">${cards
        .map((c) => `<div class="t-card">
          <div class="t-card-icon">${escapeHtml(c.icon || '◈')}</div>
          <h3>${escapeHtml(c.title || '')}</h3>
          <p>${escapeHtml(c.desc || '')}</p>
        </div>`)
        .join('')}</div>`
    : '';

  const countdownHtml = countdown.deadlineIso
    ? `<div class="t-countdown">
        <p class="t-cd-label">${escapeHtml(countdown.label || 'REGISTRATION CLOSES IN')}</p>
        <div class="t-cd-clock" id="t-countdown" data-target="${escapeHtml(countdown.deadlineIso)}">
          <div class="t-cd-unit"><span data-unit="d">--</span><small>DAYS</small></div>
          <i>:</i>
          <div class="t-cd-unit"><span data-unit="h">--</span><small>HOURS</small></div>
          <i>:</i>
          <div class="t-cd-unit"><span data-unit="m">--</span><small>MINUTES</small></div>
          <i>:</i>
          <div class="t-cd-unit"><span data-unit="s">--</span><small>SECONDS</small></div>
        </div>
        ${countdown.ctaText ? `<a class="t-btn t-btn-primary t-cd-cta" href="${escapeHtml(safeUrl(countdown.ctaHref || '#register', 'link-href'))}">${escapeHtml(countdown.ctaText)}</a>` : ''}
      </div>`
    : '';

  const posterUrl = hero.posterUrl ? escapeHtml(safeUrl(hero.posterUrl, 'image-src')) : '';
  // PR-E Phase 1.6 — Caption is overlaid INSIDE the poster frame as a
  // translucent backdrop-blur header (matches the Japan reference's
  // "imageTitle + imageSubtitle on translucent header" treatment).
  // When the operator leaves visualTitle/visualSub blank the overlay
  // is omitted so the photo reads clean.
  const captionHtml = (hero.visualTitle || hero.visualSub)
    ? `<div class="t-hero-caption">
        ${hero.visualTitle ? `<h2 class="t-caption-title">${escapeHtml(hero.visualTitle)}</h2>` : ''}
        ${hero.visualSub ? `<p class="t-caption-sub">${escapeHtml(hero.visualSub)}</p>` : ''}
      </div>`
    : '';
  // Hero visual block always renders SOMETHING. When posterUrl is set
  // (image provider returned a destination photo) we render the photo.
  // When posterUrl is empty we render a stylised destination focal point
  // — large destination label on a brand-toned gradient — so the hero
  // never reads as half-built. Pre-2026-06-23 the empty state was a
  // literal "Hero image not set" placeholder; the all-or-nothing
  // omission (intermediate fix) collapsed the hero grid and made the
  // page feel weightless. The focal-point fallback restores visual
  // balance until the operator uploads a hero image.
  const heroFocalLabel = (hero.posterAlt || hero.headline || '').toString().split(' ').slice(0, 3).join(' ').toUpperCase();
  const visualBlock = posterUrl
    ? `<aside class="t-hero-visual">
        <div class="t-poster">
          <img src="${posterUrl}" alt="${escapeHtml(hero.posterAlt || 'Hero image')}" />
          ${captionHtml}
        </div>
      </aside>`
    : `<aside class="t-hero-visual t-hero-visual-focal">
        <div class="t-poster t-poster-focal">
          <span class="t-poster-focal-bg" aria-hidden="true"></span>
          <span class="t-poster-focal-glyph" aria-hidden="true">${escapeHtml(watermark || heroFocalLabel.split(' ')[0] || '◆')}</span>
          ${heroFocalLabel ? `<span class="t-poster-focal-label">${escapeHtml(heroFocalLabel)}</span>` : ''}
          ${captionHtml}
        </div>
      </aside>`;

  return `<section class="t-hero">
    ${watermark ? `<span class="t-kanji-wm t-kanji-left">${escapeHtml(watermark)}</span>` : ''}
    <div class="t-hero-grid">
      <div class="t-hero-copy">
        ${partnersHtml}
        ${eyebrowHtml}
        ${hero.kicker ? `<p class="t-hero-kicker">${escapeHtml(hero.kicker)}</p>` : ''}
        <h1>${escapeHtml(hero.headline || '')}</h1>
        ${hero.lede ? `<p class="t-lede">${escapeHtml(hero.lede)}</p>` : ''}
        ${benefitCardsHtml}
        ${countdownHtml}
      </div>
      ${visualBlock}
    </div>
  </section>`;
}

function renderMarquee(content /*, theme */) {
  const cities = Array.isArray((content.marquee || {}).cities) ? content.marquee.cities : [];
  if (cities.length === 0) return '';
  // Track duplicated for the infinite-loop animation.
  const doubled = [...cities, ...cities];
  const cards = doubled
    .map((c) => {
      const img = c.img ? escapeHtml(safeUrl(c.img, 'image-src')) : '';
      const style = img ? `background-image:url('${img}');` : 'background:#d9cdb8;';
      return `<div class="t-photo-strip-card" style="${style}">
        <div class="t-pcard-grad"></div>
        <div class="t-pcard-cap">
          ${c.tag ? `<span class="t-pcat">${escapeHtml(c.tag)}</span>` : ''}
          <h3>${escapeHtml(c.title || '')}</h3>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="t-photo-strip">
    <div class="t-photo-strip-track">${cards}</div>
  </div>`;
}

function renderPreview(content /*, theme */) {
  const p = content.preview || {};
  if (!p.show) return '';
  const safeVideoUrl = p.videoEmbedUrl ? escapeHtml(safeUrl(p.videoEmbedUrl, 'iframe-src')) : '';
  return `<section class="t-preview">
    ${p.kanjiWatermark ? `<span class="t-kanji-wm t-kanji-right">${escapeHtml(p.kanjiWatermark)}</span>` : ''}
    <div class="t-wrap t-center">
      ${p.tag ? `<p class="t-tag t-tag-red">${escapeHtml(p.tag)}</p>` : ''}
      ${p.title ? `<h2 class="t-preview-title">${escapeHtml(p.title)}</h2>` : ''}
      ${p.subtitle ? `<p class="t-muted t-preview-sub">${escapeHtml(p.subtitle)}</p>` : ''}
      ${p.quote ? `<div class="t-preview-quote"><span class="t-quote-line"></span><p>${escapeHtml(p.quote)}</p><span class="t-quote-line"></span></div>` : ''}
      ${safeVideoUrl ? `<div class="t-video-frame"><div class="t-video-wrap"><iframe class="t-video-iframe" src="${safeVideoUrl}" title="Programme preview" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen frameborder="0" scrolling="no"></iframe></div></div>` : ''}
      ${p.ctaText ? `<a class="t-btn t-btn-primary t-preview-cta" href="${escapeHtml(safeUrl(p.ctaHref || '#register', 'link-href'))}">${escapeHtml(p.ctaText)}</a>` : ''}
    </div>
  </section>`;
}

function renderProgramme(content /*, theme */) {
  const p = content.programme || {};
  if (!p.show) return '';
  const leftParas = Array.isArray(p.leftParagraphs) ? p.leftParagraphs : [];
  const rightChecks = Array.isArray(p.rightChecks) ? p.rightChecks : [];
  const cta = p.cta || {};
  return `<section class="t-why" id="programme">
    ${p.kanjiWatermark ? `<span class="t-kanji-wm t-kanji-right">${escapeHtml(p.kanjiWatermark)}</span>` : ''}
    <div class="t-wrap">
      <div class="t-why-grid">
        <div class="t-why-left">
          ${p.leftHeadline ? `<h2>${escapeHtml(p.leftHeadline)}</h2>` : ''}
          <div class="t-why-divider"></div>
          ${leftParas.map((para) => `<p>${escapeHtml(para)}</p>`).join('')}
        </div>
        <aside class="t-why-card">
          ${p.rightHeadline ? `<h3>${escapeHtml(p.rightHeadline)}</h3>` : ''}
          ${p.rightQuote ? `<p class="t-why-card-quote">${escapeHtml(p.rightQuote)}</p>` : ''}
          <ul class="t-checks">${rightChecks.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </aside>
      </div>
      ${cta.title || cta.body
        ? `<div class="t-why-cta">
            <div class="t-why-cta-content">
              ${cta.title ? `<h3>${escapeHtml(cta.title)}</h3>` : ''}
              ${cta.body ? `<p>${escapeHtml(cta.body)}</p>` : ''}
            </div>
            ${cta.ctaText ? `<a href="${escapeHtml(safeUrl(cta.ctaHref || '#register', 'link-href'))}" class="t-btn t-btn-primary">${escapeHtml(cta.ctaText)}</a>` : ''}
          </div>`
        : ''}
    </div>
  </section>`;
}

function renderCultural(content, theme) {
  const c = content.cultural || {};
  if (!c.show) return '';
  const items = Array.isArray(c.items) ? c.items : [];
  if (items.length === 0) return '';
  const cta = c.cta || {};
  const cards = items
    // Skip cards that have neither name nor body — the empty white card
    // with a red border in the screenshot was an LLM emission with all
    // fields blank. Don't render those.
    .filter((item) => item && (item.name || (Array.isArray(item.body) ? item.body.length : item.body)))
    .map((item) => {
      const body = Array.isArray(item.body) ? item.body : (item.body ? [item.body] : []);
      // Photo-first front face (2026-06-23): when item.img is set (the
      // generate-from-destination route fills these from the image
      // provider chain), render a full-bleed photo on the flip-card
      // front. SVG glyph is the LAST-RESORT fallback when no provider
      // returned anything — previously rendered every time and made
      // every card feel like a placeholder.
      const frontFace = item.img
        ? `<div class="t-ch-front t-ch-front-photo" style="background-image:url('${escapeHtml(safeUrl(item.img, 'image-src'))}');background-size:cover;background-position:center;">
            <div class="t-ch-front-overlay"></div>
            <h3 class="t-ch-name-photo">${escapeHtml(item.name || '')}</h3>
          </div>`
        : `<div class="t-ch-front">
            <div class="t-ch-icon" aria-hidden="true">${svg(item.icon || 'generic', theme)}</div>
            <h3>${escapeHtml(item.name || '')}</h3>
            <div class="t-ch-underline"></div>
          </div>`;
      return `<article class="t-ch-card" tabindex="0">
        ${frontFace}
        <div class="t-ch-back">
          <h3>${escapeHtml(item.name || '')}</h3>
          ${item.label ? `<p class="t-ch-label">${escapeHtml(item.label)}</p>` : ''}
          <div class="t-ch-body">${body.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</div>
          ${item.benefit ? `<div class="t-ch-benefit"><span>DERIVED BENEFIT</span><em>&ldquo;${escapeHtml(item.benefit)}&rdquo;</em></div>` : ''}
        </div>
      </article>`;
    })
    .join('');
  return `<section class="t-cultural" id="cultural">
    ${c.kanjiWatermark ? `<span class="t-kanji-wm t-kanji-left">${escapeHtml(c.kanjiWatermark)}</span>` : ''}
    <div class="t-wrap">
      ${c.tag ? `<p class="t-tag t-tag-red t-center">${escapeHtml(c.tag)}</p>` : ''}
      ${c.title ? `<h2 class="t-center t-cultural-title">${escapeHtml(c.title)}</h2>` : ''}
      ${c.subtitle ? `<p class="t-muted t-center t-cultural-sub">${escapeHtml(c.subtitle)}</p>` : ''}
      <div class="t-ch-grid">${cards}</div>
      ${cta.title || cta.body
        ? `<div class="t-ch-cta"><div class="t-why-cta">
            <div class="t-why-cta-content">
              ${cta.title ? `<h3>${escapeHtml(cta.title)}</h3>` : ''}
              ${cta.body ? `<p>${escapeHtml(cta.body)}</p>` : ''}
            </div>
            ${cta.ctaText ? `<a href="${escapeHtml(safeUrl(cta.ctaHref || '#register', 'link-href'))}" class="t-btn t-btn-primary">${escapeHtml(cta.ctaText)}</a>` : ''}
          </div></div>`
        : ''}
    </div>
  </section>`;
}

function renderSafety(content, theme) {
  const s = content.safety || {};
  if (!s.show) return '';
  const features = Array.isArray(s.features) ? s.features : [];
  // PR-E Phase 1.6 — Stats mode (backwards-compat additive).
  // Stat tiles are the most impactful trust treatment from the
  // Japan reference (the "1:8" "4★" "24/7" pattern). When the
  // operator/AI populates `safety.stats[]`, we render BIG number
  // tiles BEFORE the feature cards. Feature cards stay as a
  // secondary detail row so existing pages don't lose anything.
  // Empty stats array → identical render to pre-Phase-1.6.
  const stats = Array.isArray(s.stats) ? s.stats : [];
  const includedItems = Array.isArray((s.included || {}).items) ? s.included.items : [];
  const banner = s.banner || {};
  return `<section class="t-safety" id="safety">
    <div class="t-wrap">
      ${s.title ? `<h2 class="t-center t-light">${escapeHtml(s.title)}</h2>` : ''}
      ${s.subtitle ? `<p class="t-muted t-center t-light">${escapeHtml(s.subtitle)}</p>` : ''}
      ${stats.length ? `<div class="t-safety-stats">
        ${stats.map((st) => `<div class="t-sstat">
          <div class="t-sstat-num">${escapeHtml(String(st.stat != null ? st.stat : ''))}</div>
          <h4>${escapeHtml(st.title || '')}</h4>
          <p>${escapeHtml(st.body || '')}</p>
        </div>`).join('')}
      </div>` : ''}
      <div class="t-safety-grid">
        ${features.map((f) => `<div class="t-sfeat">
          <div class="t-sfeat-icon" aria-hidden="true">${svg(f.icon, theme)}</div>
          <h4>${escapeHtml(f.title || '')}</h4>
          <p>${escapeHtml(f.desc || '')}</p>
        </div>`).join('')}
      </div>
      ${includedItems.length ? `<div class="t-included">
        ${(s.included && s.included.title) ? `<h3>${escapeHtml(s.included.title)}</h3>` : ''}
        <div class="t-inc-grid">
          ${includedItems.map((item) => `<div class="t-inc-item">
            <span class="t-inc-check" aria-hidden="true">${svg('check', theme)}</span>
            <span>${escapeHtml(item)}</span>
          </div>`).join('')}
        </div>
      </div>` : ''}
      ${(banner.title || banner.body) ? `<div class="t-safety-banner">
        <div class="t-sb-icon" aria-hidden="true">${svg('shieldCheck', theme)}</div>
        <div class="t-sb-content">
          ${banner.title ? `<h3>${escapeHtml(banner.title)}</h3>` : ''}
          ${banner.body ? `<p>${escapeHtml(banner.body)}</p>` : ''}
        </div>
        ${banner.ctaText ? `<a href="${escapeHtml(safeUrl(banner.ctaHref || '#register', 'link-href'))}" class="t-btn t-btn-primary">${escapeHtml(banner.ctaText)} &rarr;</a>` : ''}
      </div>` : ''}
      ${s.quote ? `<p class="t-safety-quote">${escapeHtml(s.quote)}</p>` : ''}
    </div>
  </section>`;
}

function renderTestimonials(content /*, theme */) {
  const t = content.testimonials || {};
  if (!t.show) return '';
  const items = Array.isArray(t.items) ? t.items : [];
  if (items.length === 0) return '';
  const cta = t.cta || {};
  return `<section class="t-reviews">
    <div class="t-wrap">
      ${t.title ? `<h2 class="t-center">${escapeHtml(t.title)}</h2>` : ''}
      <div class="t-review-grid">
        ${items.map((r) => `<article class="t-review">
          ${(typeof r.stars === 'number' && r.stars > 0) ? `<div class="t-stars">${'★'.repeat(Math.min(5, Math.max(0, Math.round(r.stars))))}</div>` : ''}
          <span class="t-quote-mark">&rdquo;</span>
          <p>&ldquo;${escapeHtml(r.text || '')}&rdquo;</p>
          <div class="t-reviewer">
            <span class="t-avatar">${escapeHtml((r.initial || (r.name || '?').charAt(0) || '?').toString().toUpperCase().slice(0, 1))}</span>
            <div>
              <b>${escapeHtml(r.name || '')}</b>
              ${r.source ? `<small>${escapeHtml(r.source)}</small>` : ''}
            </div>
          </div>
        </article>`).join('')}
      </div>
      ${(cta.title || cta.body) ? `<div class="t-cta-band">
        <div>
          ${cta.title ? `<h3>${escapeHtml(cta.title)}</h3>` : ''}
          ${cta.body ? `<p class="t-muted">${escapeHtml(cta.body)}</p>` : ''}
        </div>
        ${cta.ctaText ? `<a class="t-btn t-btn-primary" href="${escapeHtml(safeUrl(cta.ctaHref || '#register', 'link-href'))}">${escapeHtml(cta.ctaText)}</a>` : ''}
      </div>` : ''}
    </div>
  </section>`;
}

function renderInvestment(content, theme) {
  const inv = content.investment || {};
  if (!inv.show) return '';
  const tiers = Array.isArray(inv.tiers) ? inv.tiers : [];
  const inclusionItems = Array.isArray((inv.inclusions || {}).items) ? inv.inclusions.items : [];
  const currency = escapeHtml(inv.currency || '₹');
  const cta = inv.cta || {};
  // PR-E Phase 1.6 — featured tier resolution.
  // The reference uses ONE strongly-highlighted tier (the "RECOMMENDED" / "START
  // HERE" pick). We support two equivalent ways to mark it:
  //   (a) per-tier flag: tier.startHere === true OR tier.featured === true
  //   (b) section-level: inv.featuredIndex (0-based index into tiers)
  // Both render as the .t-tier-start / .t-tier-featured visual treatment
  // (scale lift + accent top-bar + corner badge). The badge label is
  // tunable via tier.badge / inv.featuredBadge (defaults: "START HERE").
  const featuredIdx = Number.isFinite(Number(inv.featuredIndex)) ? Math.trunc(Number(inv.featuredIndex)) : -1;
  const defaultBadge = escapeHtml(inv.featuredBadge || 'START HERE');
  return `<section class="t-invest" id="investment">
    <div class="t-wrap">
      ${inv.tag ? `<p class="t-tag t-center">${escapeHtml(inv.tag)}</p>` : ''}
      ${inv.title ? `<h2 class="t-center t-invest-title">${escapeHtml(inv.title)}</h2>` : ''}
      <div class="t-invest-divider"></div>
      ${inv.subtitle ? `<p class="t-muted t-center t-invest-sub">${escapeHtml(inv.subtitle)}</p>` : ''}
      <div class="t-tiers">
        ${tiers.map((t, i) => {
          const isFeatured = t.startHere === true || t.featured === true || i === featuredIdx;
          const badgeText = t.badge ? escapeHtml(t.badge) : defaultBadge;
          return `<div class="t-tier${isFeatured ? ' t-tier-start t-tier-featured' : ''}">
          ${isFeatured ? `<span class="t-tier-badge">${badgeText}</span>` : ''}
          <div class="t-tier-head">
            <span class="t-tier-num">${escapeHtml(String(t.step != null ? t.step : ''))}</span>
            <div class="t-tier-titles">
              <h4>${escapeHtml(t.title || '')}</h4>
              <small>${escapeHtml(t.subtitle || '')}</small>
            </div>
          </div>
          <p class="t-tier-amount">${t.amount ? currency + escapeHtml(String(t.amount)) : '<span class="t-tier-amount-pending" aria-hidden="true">—</span>'}</p>
          ${t.tag ? `<span class="t-tier-tag">${escapeHtml(t.tag)}</span>` : ''}
          <div class="t-tier-meta">
            ${t.date ? `<p><span class="t-tier-ico">${svg('calendar', theme)}</span> ${escapeHtml(t.date)}</p>` : ''}
            ${t.vendor ? `<p><span class="t-tier-ico">${svg('building', theme)}</span> ${escapeHtml(t.vendor)}</p>` : ''}
          </div>
        </div>`;
        }).join('')}
      </div>
      ${inclusionItems.length ? `<div class="t-inclusions">
        <p class="t-inclusions-label">${escapeHtml((inv.inclusions && inv.inclusions.label) || 'INDICATIVE INCLUSIONS')}</p>
        <div class="t-inclusions-grid">
          ${inclusionItems.map((item) => `<div class="t-inc-bullet"><span class="t-inc-square" aria-hidden="true"></span><span>${escapeHtml(item)}</span></div>`).join('')}
        </div>
      </div>` : ''}
      ${inv.foot ? `<p class="t-invest-foot">${escapeHtml(inv.foot)}</p>` : ''}
      ${(cta.title || cta.body) ? `<div class="t-invest-cta"><div class="t-why-cta">
        <div class="t-why-cta-content">
          ${cta.title ? `<h3>${escapeHtml(cta.title)}</h3>` : ''}
          ${cta.body ? `<p>${escapeHtml(cta.body)}</p>` : ''}
        </div>
        ${cta.ctaText ? `<a href="${escapeHtml(safeUrl(cta.ctaHref || '#register', 'link-href'))}" class="t-btn t-btn-primary">${escapeHtml(cta.ctaText)}</a>` : ''}
      </div></div>` : ''}
    </div>
  </section>`;
}

function renderRegistration(content /*, theme */) {
  const r = content.registration || {};
  if (!r.show) return '';
  const schools = Array.isArray(r.schoolOptions) ? r.schoolOptions : [];
  const tenantSlug = escapeHtml(r.tenantSlug || '');
  const subBrand = escapeHtml(r.leadSubBrand || '');
  const leadSource = escapeHtml(r.leadSource || 'landing_page_registration');
  const slug = escapeHtml(content._slug || '');
  // Field-1 label is operator-tunable so non-educational templates can
  // ask for "Family lead name" / "Pilgrim name" / "Guest name" instead.
  const personLabel = escapeHtml(r.personLabel || 'Student Full Name');
  const personPlaceholder = escapeHtml(r.personPlaceholder || "Enter student's full name");
  const showStudentFields = r.showStudentFields !== false;
  const personField = `<label>
    <span class="t-label-text">${personLabel} <span class="t-req">*</span></span>
    <input type="text" name="studentName" placeholder="${personPlaceholder}" required />
  </label>`;
  const gradeField = showStudentFields
    ? `<label>
        <span class="t-label-text">${escapeHtml(r.gradeLabel || 'Grade')} <span class="t-req">*</span></span>
        <input type="text" name="grade" placeholder="${escapeHtml(r.gradePlaceholder || 'e.g., 8th Grade')}" required />
      </label>`
    : '';
  // School dropdown — if operator provides options we render select;
  // otherwise fall back to a free-text input. The non-educational
  // templates can hide this field entirely via showSchoolField=false.
  const showSchoolField = r.showSchoolField !== false;
  const schoolLabel = escapeHtml(r.schoolLabel || 'School');
  const schoolField = !showSchoolField
    ? ''
    : (schools.length
      ? `<label>
          <span class="t-label-text">${schoolLabel} <span class="t-req">*</span></span>
          <select name="school" required>
            <option value="">Select ${escapeHtml((r.schoolLabel || 'school').toLowerCase())}</option>
            ${schools.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
          </select>
        </label>`
      : `<label>
          <span class="t-label-text">${schoolLabel} <span class="t-req">*</span></span>
          <input type="text" name="school" placeholder="${escapeHtml(r.schoolPlaceholder || (r.schoolLabel || 'School') + ' name')}" required />
        </label>`);

  const guardianLabel = escapeHtml(r.guardianLabel || 'Parent / Guardian Name');
  const guardianPlaceholder = escapeHtml(r.guardianPlaceholder || "Enter parent's full name");
  const step1Title = escapeHtml(r.step1Title || 'Step 1: Student Information');
  const step2Title = escapeHtml(r.step2Title || 'Step 2: Parent / Guardian Details');

  // PR-E Phase 1.6 — When the operator/AI populates
  // `registration.covers[]` (4-card premium side panel listing what
  // signing up unlocks), the section switches from the narrow
  // single-column funnel layout to a 2-column "form + covers" grid.
  // Empty array → identical layout to pre-Phase-1.6.
  const covers = Array.isArray(r.covers) ? r.covers : [];
  const wrapClass = covers.length > 0 ? 't-wrap t-register-grid' : 't-wrap t-narrow';
  const coversHtml = covers.length > 0
    ? `<aside class="t-register-covers" aria-label="What this registration covers">
        ${r.coversTitle ? `<h3 class="t-covers-title">${escapeHtml(r.coversTitle)}</h3>` : ''}
        ${r.coversIntro ? `<p class="t-covers-intro">${escapeHtml(r.coversIntro)}</p>` : ''}
        <div class="t-covers-grid">
          ${covers.map((c) => `<div class="t-cover-card">
            <h4>${escapeHtml(c.title || '')}</h4>
            <p>${escapeHtml(c.body || '')}</p>
          </div>`).join('')}
        </div>
      </aside>`
    : '';
  return `<section class="t-register" id="register">
    <div class="${wrapClass}">
      ${r.tag ? `<p class="t-tag t-center">${escapeHtml(r.tag)}</p>` : ''}
      ${r.title ? `<h2 class="t-center">${escapeHtml(r.title)}</h2>` : ''}
      ${r.subtitle ? `<p class="t-muted t-center">${escapeHtml(r.subtitle)}</p>` : ''}
      ${covers.length > 0 ? `<div class="t-register-grid-inner">` : ''}
      ${covers.length > 0 ? `<div class="t-register-form-col">` : ''}
      <form class="t-form" id="t-reg-form"
            data-tenant-slug="${tenantSlug}"
            data-sub-brand="${subBrand}"
            data-lead-source="${leadSource}"
            data-page-slug="${slug}">
        <div class="t-form-progress" aria-label="Step 1 of 3">
          <span class="t-form-bar t-form-bar-active" data-step="1"></span>
          <span class="t-form-bar" data-step="2"></span>
          <span class="t-form-bar" data-step="3"></span>
        </div>
        <div class="t-form-step" data-step="1">
          <h3 class="t-step-title">${step1Title}</h3>
          ${personField}
          ${gradeField}
          ${schoolField}
          <button class="t-btn t-btn-dark t-wide" type="button" data-action="next">Next &rarr;</button>
          <p class="t-form-secure">Your data is secure. You will be redirected to the confirmation page.</p>
        </div>
        <div class="t-form-step" data-step="2" style="display:none;">
          <h3 class="t-step-title">${step2Title}</h3>
          <label>
            <span class="t-label-text">${guardianLabel} <span class="t-req">*</span></span>
            <input type="text" name="parentName" placeholder="${guardianPlaceholder}" required />
          </label>
          <label>
            <span class="t-label-text">Mobile Number <span class="t-req">*</span></span>
            <input type="tel" name="phone" placeholder="+91 98765 43210" required />
          </label>
          <label>
            <span class="t-label-text">Email Address <span class="t-req">*</span></span>
            <input type="email" name="email" placeholder="you@email.com" required />
          </label>
          <label>
            <span class="t-label-text">City</span>
            <input type="text" name="city" placeholder="e.g., Bangalore" />
          </label>
          <div class="t-form-row">
            <button class="t-btn t-btn-outline" type="button" data-action="back">&larr; Back</button>
            <button class="t-btn t-btn-dark" type="submit">${escapeHtml(r.submitText || 'Confirm Registration')} &rarr;</button>
          </div>
          <p class="t-form-secure">Your data is secure. You will be redirected to the confirmation page.</p>
        </div>
      </form>
      <div class="t-success" id="t-reg-success" style="display:none;">
        <div class="t-success-icon">${svg('check')}</div>
        <h3>${escapeHtml(r.successTitle || 'Registration Submitted!')}</h3>
        <p>${escapeHtml(r.successBody || 'Our team will contact you within 24 hours.')}</p>
      </div>
      ${covers.length > 0 ? `</div>` : ''}
      ${coversHtml}
      ${covers.length > 0 ? `</div>` : ''}
    </div>
  </section>`;
}

function renderBrochure(content /*, theme */) {
  const b = content.brochure || {};
  if (!b.show) return '';
  const infoCards = Array.isArray(b.infoCards) ? b.infoCards : [];
  const schools = Array.isArray(b.schoolOptions) ? b.schoolOptions : [];
  const slug = escapeHtml(content._slug || '');
  const tenantSlug = escapeHtml(b.tenantSlug || '');
  const subBrand = escapeHtml(b.leadSubBrand || '');
  const leadSource = escapeHtml(b.leadSource || 'brochure_request');

  const schoolField = schools.length
    ? `<label>
        <span class="t-label-text">SELECT SCHOOL</span>
        <select name="school">
          <option value="">Select your school</option>
          ${schools.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
        </select>
      </label>`
    : '';

  return `<section class="t-brochure">
    <div class="t-wrap">
      ${infoCards.length ? `<div class="t-info-cards">
        ${infoCards.map((c) => `<div class="t-info-card">
          <b>${escapeHtml(c.title || '')}</b>
          <p>${escapeHtml(c.desc || '')}</p>
        </div>`).join('')}
      </div>` : ''}
      <div class="t-brochure-head t-center">
        ${b.pillText ? `<span class="t-still-pill">${escapeHtml(b.pillText)}</span>` : ''}
        ${b.headTitle ? `<h2 class="t-center">${escapeHtml(b.headTitle)}</h2>` : ''}
      </div>
      ${(b.infoBody || b.dividerText) ? `<div class="t-brochure-info">
        ${b.infoBody ? `<p class="t-muted t-center">${escapeHtml(b.infoBody)}</p>` : ''}
        ${b.dividerText ? `<div class="t-school-divider">
          <span class="t-school-line"></span>
          <span class="t-school-text">${escapeHtml(b.dividerText)}</span>
          <span class="t-school-line"></span>
        </div>` : ''}
      </div>` : ''}
      <div class="t-brochure-card">
        <form class="t-form t-brochure-form" id="t-broch-form"
              data-tenant-slug="${tenantSlug}"
              data-sub-brand="${subBrand}"
              data-lead-source="${leadSource}"
              data-page-slug="${slug}">
          <label>
            <span class="t-label-text">PARENT&#39;S NAME</span>
            <input type="text" name="parentName" placeholder="Enter full name" required />
          </label>
          <label>
            <span class="t-label-text">PHONE NUMBER</span>
            <input type="tel" name="phone" placeholder="+91" required />
          </label>
          ${schoolField}
          <label>
            <span class="t-label-text">PARENT&#39;S EMAIL</span>
            <input type="email" name="email" placeholder="Enter email address" required />
          </label>
          <button class="t-btn t-btn-primary t-wide" type="submit" id="t-broch-btn">${escapeHtml(b.ctaText || 'DOWNLOAD PROGRAMME BROCHURE')} &rarr;</button>
          ${b.footNote ? `<p class="t-brochure-note">${escapeHtml(b.footNote)}</p>` : ''}
        </form>
      </div>
    </div>
  </section>`;
}

function renderFaq(content, theme) {
  const f = content.faq || {};
  if (!f.show) return '';
  const categories = Array.isArray(f.categories) ? f.categories : [];
  const items = Array.isArray(f.items) ? f.items : [];
  const catCounts = {};
  categories.forEach((c) => {
    catCounts[c.id] = c.id === 'all' ? items.length : items.filter((i) => i.cat === c.id).length;
  });
  return `<section class="t-faqs" id="faqs">
    ${f.kanjiWatermark ? `<span class="t-kanji-wm t-kanji-left">${escapeHtml(f.kanjiWatermark)}</span>` : ''}
    <div class="t-wrap">
      ${f.tag ? `<p class="t-tag t-tag-red t-center">${escapeHtml(f.tag)}</p>` : ''}
      ${f.title ? `<h2 class="t-center t-faq-title">${escapeHtml(f.title)}</h2>` : ''}
      <div class="t-faq-divider"></div>
      ${f.subtitle ? `<p class="t-muted t-center t-faq-sub">${escapeHtml(f.subtitle)}</p>` : ''}
      <div class="t-faq-search">
        ${svg('search', theme)}
        <input type="text" placeholder="Search questions..." id="t-faq-query" />
      </div>
      <div class="t-faq-tabs">
        ${categories.map((c, i) => `<button type="button" class="t-faq-tab${i === 0 ? ' t-faq-tab-active' : ''}" data-cat="${escapeHtml(c.id || '')}">
          <span class="t-faq-tab-icon" aria-hidden="true">${escapeHtml(c.icon || '·')}</span>
          <span class="t-faq-tab-label">${escapeHtml(c.label || '')}</span>
          <span class="t-faq-tab-count">${catCounts[c.id] || 0}</span>
        </button>`).join('')}
      </div>
      <div class="t-faq-list" id="t-faq-list">
        ${items.map((it, idx) => `<div class="t-faq-item" data-cat="${escapeHtml(it.cat || '')}" data-text="${escapeHtml(((it.q || '') + ' ' + (it.a || '')).toLowerCase())}">
          <button type="button" class="t-faq-q" data-faq-toggle="${idx}">
            <span>${escapeHtml(it.q || '')}</span>
            <span class="t-faq-chevron" aria-hidden="true">${svg('chevronDown', theme)}</span>
          </button>
          <div class="t-faq-a" style="display:none;">${escapeHtml(it.a || '')}</div>
        </div>`).join('')}
      </div>
      <p class="t-faq-empty" id="t-faq-empty" style="display:none;">No questions match your search.</p>
    </div>
  </section>`;
}

function renderDetails(content /*, theme */) {
  const d = content.details || {};
  if (!d.show) return '';
  const steps = Array.isArray(d.steps) ? d.steps : [];
  return `<section class="t-details">
    <div class="t-wrap t-center">
      ${d.title ? `<h2 class="t-details-title">${escapeHtml(d.title)}</h2>` : ''}
      <div class="t-details-divider"></div>
      ${(d.leftPill || d.taglineRight) ? `<div class="t-details-pill-row">
        ${d.leftPill ? `<span class="t-details-pill">${escapeHtml(d.leftPill)}</span>` : ''}
        ${d.taglineRight ? `<span class="t-details-pill-line"></span><em class="t-details-tagline">${escapeHtml(d.taglineRight)}</em>` : ''}
      </div>` : ''}
      ${steps.length ? `<div class="t-details-steps">
        ${steps.map((s, i) => `${i > 0 ? '<span class="t-details-arrow">&rarr;</span>' : ''}<div class="t-details-step"><span class="t-details-num">${escapeHtml(String(s.num != null ? s.num : i + 1))}</span><span class="t-details-label">${escapeHtml(s.label || '')}</span></div>`).join('')}
      </div>` : ''}
      ${d.ctaText ? `<a href="${escapeHtml(safeUrl(d.ctaHref || '#register', 'link-href'))}" class="t-details-cta">${escapeHtml(d.ctaText)}</a>` : ''}
    </div>
  </section>`;
}

function renderFooter(content, theme) {
  const c = content.contact || {};
  if (!c.show) return '';
  const sections = Array.isArray(c.sections) ? c.sections : [];
  const logoUrl = c.logoUrl ? escapeHtml(safeUrl(c.logoUrl, 'image-src')) : '';
  // Content's footer kanji overrides; otherwise fall back to theme's
  // brand glyph so the footer carries the same family identity as the
  // header (Arabic for religious, empty for others by default).
  const footKanji = c.kanji || ((theme && theme.decorative && theme.decorative.brand) || '');
  return `<footer class="t-foot">
    <div class="t-foot-top t-center">
      ${(c.label || footKanji) ? `<h3 class="t-foot-title">${footKanji ? `<span class="t-jp">${escapeHtml(footKanji)}</span> ` : ''}${escapeHtml(c.label || '')}</h3>` : ''}
      ${c.tagline ? `<p class="t-foot-tagline">${escapeHtml(c.tagline)}</p>` : ''}
      ${logoUrl ? `<img src="${logoUrl}" alt="${escapeHtml(c.label || 'logo')}" class="t-foot-logo" />` : ''}
    </div>
    ${sections.length ? `<div class="t-wrap t-foot-grid">
      ${sections.map((s) => `<div>
        <p class="t-foot-h">${escapeHtml(s.label || '')}</p>
        ${(Array.isArray(s.lines) ? s.lines : []).map((l) => `<p>${escapeHtml(l)}</p>`).join('')}
      </div>`).join('')}
    </div>` : ''}
    ${c.copyright ? `<p class="t-copy">${escapeHtml(c.copyright)}</p>` : ''}
  </footer>`;
}

// PR-E Phase 1.5 — Final CTA full-bleed conversion close.
// Brand-color section that sits before the footer. Renders only when
// content.finalCta carries at least a title — operators / Phase-2 AI
// can opt in per page. Steps array renders numbered chips inline.
function renderFinalCta(content /*, theme */) {
  const f = content.finalCta || {};
  if (!f.show && !f.title) return '';
  const steps = Array.isArray(f.steps) ? f.steps : [];
  return `<section class="t-final-cta" aria-label="Get started">
    <div class="t-wrap t-center">
      ${f.eyebrow ? `<p class="t-tag">${escapeHtml(f.eyebrow)}</p>` : ''}
      ${f.title ? `<h2>${escapeHtml(f.title)}</h2>` : ''}
      ${f.subtitle ? `<p class="t-final-sub">${escapeHtml(f.subtitle)}</p>` : ''}
      ${steps.length ? `<div class="t-final-steps">
        ${steps.map((s, i) => `<div class="t-final-step">
          <span class="t-final-num">${escapeHtml(String(s.num != null ? s.num : i + 1))}</span>
          <span>${escapeHtml(s.label || '')}</span>
        </div>`).join('')}
      </div>` : ''}
      ${f.ctaLabel || f.ctaText ? `<a class="t-btn t-btn-primary" href="${escapeHtml(safeUrl(f.ctaHref || '#register', 'link-href'))}">${escapeHtml(f.ctaLabel || f.ctaText)}</a>` : ''}
    </div>
  </section>`;
}

function renderFloatingCta(content /*, theme */) {
  const f = content.floatingCta || {};
  if (!f.show || !f.text) return '';
  return `<a class="t-float-register" href="${escapeHtml(safeUrl(f.href || '#register', 'link-href'))}">
    <span class="t-dot"></span> ${escapeHtml(f.text)}
  </a>`;
}

// ── SECTION DISPATCH MAP ────────────────────────────────────────────
// Maps a section id (as used in theme.sectionOrder) to its renderer.
// Templates can override per-section composition without touching the
// universal module.

const SECTION_RENDERERS = Object.freeze({
  nav: renderNav,
  hero: renderHero,
  marquee: renderMarquee,
  preview: renderPreview,
  programme: renderProgramme,
  cultural: renderCultural,
  safety: renderSafety,
  testimonials: renderTestimonials,
  investment: renderInvestment,
  registration: renderRegistration,
  brochure: renderBrochure,
  faq: renderFaq,
  details: renderDetails,
  finalCta: renderFinalCta,
  contact: renderFooter,
  floatingCta: renderFloatingCta,
});

// ── INLINE SCRIPTS (countdown / FAQ / registration / brochure) ──────

function renderInlineScripts() {
  return `<script>
(function(){
  function pad(n){return String(n).padStart(2,'0');}

  // ── Countdown ─────────────────────────────
  var cdRoot=document.getElementById('t-countdown');
  if(cdRoot){
    var target=new Date(cdRoot.dataset.target).getTime();
    if(!isNaN(target)){
      function tickCd(){
        var diff=Math.max(0,target-Date.now());
        var d=Math.floor(diff/86400000);
        var h=Math.floor(diff/3600000)%24;
        var m=Math.floor(diff/60000)%60;
        var s=Math.floor(diff/1000)%60;
        cdRoot.querySelectorAll('[data-unit]').forEach(function(el){
          if(el.dataset.unit==='d')el.textContent=pad(d);
          else if(el.dataset.unit==='h')el.textContent=pad(h);
          else if(el.dataset.unit==='m')el.textContent=pad(m);
          else if(el.dataset.unit==='s')el.textContent=pad(s);
        });
      }
      tickCd();setInterval(tickCd,1000);
    }
  }

  // ── FAQ search + category filter + accordion ─────────────────
  var faqList=document.getElementById('t-faq-list');
  var faqQuery=document.getElementById('t-faq-query');
  var faqEmpty=document.getElementById('t-faq-empty');
  var faqTabs=document.querySelectorAll('.t-faq-tab');
  var activeCat=(faqTabs[0]&&faqTabs[0].dataset.cat)||'all';
  function refreshFaqs(){
    if(!faqList)return;
    var query=(faqQuery&&faqQuery.value||'').trim().toLowerCase();
    var anyVisible=false;
    faqList.querySelectorAll('.t-faq-item').forEach(function(item){
      var cat=item.dataset.cat||'';
      var text=item.dataset.text||'';
      var catMatch=(activeCat==='all'||cat===activeCat);
      var qMatch=(query.length===0||text.indexOf(query)>=0);
      if(catMatch&&qMatch){item.style.display='';anyVisible=true;}
      else{item.style.display='none';}
    });
    if(faqEmpty)faqEmpty.style.display=anyVisible?'none':'block';
  }
  faqTabs.forEach(function(tab){
    tab.addEventListener('click',function(){
      faqTabs.forEach(function(t){t.classList.remove('t-faq-tab-active');});
      tab.classList.add('t-faq-tab-active');
      activeCat=tab.dataset.cat||'all';
      refreshFaqs();
    });
  });
  if(faqQuery)faqQuery.addEventListener('input',refreshFaqs);
  if(faqList){
    faqList.querySelectorAll('[data-faq-toggle]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var item=btn.closest('.t-faq-item');
        if(!item)return;
        var ans=item.querySelector('.t-faq-a');
        var isOpen=item.classList.toggle('t-faq-item-open');
        if(ans)ans.style.display=isOpen?'block':'none';
      });
    });
  }

  // ── Registration funnel (2 steps + submit) ──────────────────
  var regForm=document.getElementById('t-reg-form');
  if(regForm){
    var steps=regForm.querySelectorAll('.t-form-step');
    var bars=regForm.querySelectorAll('.t-form-bar');
    var success=document.getElementById('t-reg-success');
    function showStep(n){
      steps.forEach(function(el){el.style.display=(parseInt(el.dataset.step,10)===n)?'':'none';});
      bars.forEach(function(b){
        var s=parseInt(b.dataset.step,10);
        if(s<=n)b.classList.add('t-form-bar-active');
        else b.classList.remove('t-form-bar-active');
      });
    }
    regForm.querySelectorAll('[data-action]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var action=btn.dataset.action;
        if(action==='next'){
          var step1=regForm.querySelector('.t-form-step[data-step="1"]');
          var required=step1.querySelectorAll('[required]');
          for(var i=0;i<required.length;i++){
            if(!required[i].value){required[i].reportValidity&&required[i].reportValidity();return;}
          }
          showStep(2);
        }
        else if(action==='back')showStep(1);
      });
    });
    regForm.addEventListener('submit',function(e){
      e.preventDefault();
      var data={};
      regForm.querySelectorAll('input, select, textarea').forEach(function(el){
        if(el.name)data[el.name]=el.value;
      });
      var body={
        tenantSlug:regForm.dataset.tenantSlug||'',
        subBrand:regForm.dataset.subBrand||'',
        name:data.parentName||data.studentName||'',
        email:data.email||'',
        phone:data.phone||'',
        source:regForm.dataset.leadSource||'landing_page_registration',
        landingPage:'/p/'+(regForm.dataset.pageSlug||''),
        metaJson:JSON.stringify({
          studentName:data.studentName,
          grade:data.grade,
          school:data.school,
          city:data.city,
        }),
      };
      var submitBtn=regForm.querySelector('button[type=submit]');
      if(submitBtn){submitBtn.disabled=true;submitBtn.textContent='Submitting…';}
      fetch('/api/travel/inbound/leads/web_form',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),
      }).catch(function(){
        return fetch('/api/pages/'+(regForm.dataset.pageSlug||'')+'/submit',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(data),
        });
      }).finally(function(){
        regForm.style.display='none';
        if(success)success.style.display='block';
      });
    });
  }

  // ── Brochure submit ────────────────────────────────────────
  var brochForm=document.getElementById('t-broch-form');
  if(brochForm){
    brochForm.addEventListener('submit',function(e){
      e.preventDefault();
      var data={brochureRequest:true};
      brochForm.querySelectorAll('input, select').forEach(function(el){
        if(el.name)data[el.name]=el.value;
      });
      var body={
        tenantSlug:brochForm.dataset.tenantSlug||'',
        subBrand:brochForm.dataset.subBrand||'',
        name:data.parentName||'',
        email:data.email||'',
        phone:data.phone||'',
        source:brochForm.dataset.leadSource||'brochure_request',
        landingPage:'/p/'+(brochForm.dataset.pageSlug||''),
        metaJson:JSON.stringify({school:data.school}),
      };
      var btn=document.getElementById('t-broch-btn');
      if(btn){btn.disabled=true;btn.textContent='Submitting…';}
      fetch('/api/travel/inbound/leads/web_form',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),
      }).catch(function(){
        return fetch('/api/pages/'+(brochForm.dataset.pageSlug||'')+'/submit',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(data),
        });
      }).finally(function(){
        if(btn){btn.textContent='✓ Brochure Request Sent!';}
        setTimeout(function(){brochForm.reset();if(btn){btn.disabled=false;btn.textContent='DOWNLOAD PROGRAMME BROCHURE →';}},3000);
      });
    });
  }
})();
</script>`;
}

// ── PUBLIC RENDER ENTRY ─────────────────────────────────────────────
//
// Single render entrypoint shared by all 4 template families. Each
// template's render() calls this with its own (defaultContent, theme)
// so the output is fully themed but the shared shell stays identical.
//
// Parameters
// ──────────
//   landingPage    — the LandingPage row (slug, title, content,
//                    cssOverrides, metaTitle, metaDescription)
//   defaultContent — the template's DEFAULT_CONTENT (used as a
//                    tolerance fallback for partially-filled payloads)
//   theme          — theme object from themeTokens.getTheme(...)
//   options        — { preview: bool, sectionOrderOverride: string[] }
//                    preview=true omits the tracking pixel; sectionOrder
//                    override lets the per-template-content override
//                    the family default composition.
//
// Returns the full <html>...<body>...</body></html> document.
//
function renderTemplatePage(landingPage, defaultContent, theme, options = {}) {
  const lp = landingPage || {};
  const previewMode = !!options.preview;

  // ── Content parse + merge ────────────────────────────────────────
  // We accept either object content (template-style) or, for backwards
  // compatibility, a JSON string. Arrays fall through to {} so legacy
  // block-array content can't accidentally parse into the template.
  let raw = lp.content;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      raw = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_e) {
      raw = {};
    }
  } else if (raw == null || Array.isArray(raw) || typeof raw !== 'object') {
    raw = {};
  }
  const content = mergeContent(defaultContent, raw);
  content._slug = lp.slug || '';
  content._preview = previewMode;

  // ── Section composition: content override > theme default ────────
  // Operator / AI can set content._sectionOrder to a string array of
  // section ids. Otherwise the theme's family default fires. We never
  // throw on an unknown section id — it's skipped silently.
  let sectionOrder = Array.isArray(content._sectionOrder) && content._sectionOrder.length
    ? content._sectionOrder
    : (theme && Array.isArray(theme.sectionOrder) ? theme.sectionOrder : null);
  if (!sectionOrder) sectionOrder = themeTokens.SECTION_COMPOSITION.educational;

  const sectionsHtml = sectionOrder
    .map((id) => {
      const fn = SECTION_RENDERERS[id];
      if (typeof fn !== 'function') return '';
      try {
        return fn(content, theme) || '';
      } catch (_e) {
        // Section-level safety — never propagate a render error.
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');

  // ── CSS assembly ─────────────────────────────────────────────────
  // 1. Base shared CSS (currently from educationalTripV1.css)
  // 2. Theme overlay CSS (CSS variable overrides per theme)
  // 3. Operator's cssOverrides — last word, highest specificity
  const baseCss = loadBaseCss();
  const themeOverlayCss = theme ? themeTokens.renderThemeOverlayCss(theme) : '';
  const cssOverrides = lp.cssOverrides ? `<style>${lp.cssOverrides}</style>` : '';

  const pageTitle = escapeHtml(lp.metaTitle || lp.title || (content.brand || {}).programmeName || 'Travel Programme');
  const pageDescription = lp.metaDescription
    ? `<meta name="description" content="${escapeHtml(lp.metaDescription)}" />`
    : '';

  // Theme identity is encoded via the inline CSS overlay (palette,
  // typography, decorative ornaments). Tests pin <div class="trips-page">
  // as a literal substring so we keep the wrapper attribute-free; theme
  // metadata lives in a sibling <meta name="x-template-theme"> tag for
  // tooling / debug / analytics that wants to read it.
  const themeMeta = theme
    ? `<meta name="x-template-theme" content="${escapeHtml(theme.id)}" />
  <meta name="x-template-family" content="${escapeHtml(theme.family)}" />
  <meta name="x-template-variant" content="${escapeHtml(theme.variant)}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pageTitle}</title>
  ${pageDescription}
  ${themeMeta}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
  </style>
  <style>${baseCss}</style>
  ${themeOverlayCss ? `<style>${themeOverlayCss}</style>` : ''}
  ${cssOverrides}
</head>
<body>
<div class="trips-page">
${sectionsHtml}
${renderInlineScripts()}
</div>
${previewMode ? '' : `<img src="/api/pages/${escapeHtml(lp.slug || '')}/track?event=VISIT" width="1" height="1" style="position:absolute;opacity:0;" />`}
</body>
</html>`;
}

module.exports = {
  // Utilities
  escapeHtml,
  safeUrl,
  svg,
  mergeContent,
  loadBaseCss,
  resetCssCache,
  // Section renderers
  renderNav,
  renderHero,
  renderMarquee,
  renderPreview,
  renderProgramme,
  renderCultural,
  renderSafety,
  renderTestimonials,
  renderInvestment,
  renderRegistration,
  renderBrochure,
  renderFaq,
  renderDetails,
  renderFinalCta,
  renderFooter,
  renderFloatingCta,
  // Dispatch map
  SECTION_RENDERERS,
  // Scripts
  renderInlineScripts,
  // Public render entry — all 4 templates use this
  renderTemplatePage,
  // SVG library (exposed for tests + per-template extensions)
  BASE_SVG,
};
