/**
 * HTML → downloadable artifact (PDF via headless Chrome, HTML fallback).
 *
 * This is intentionally NOT an agent tool. Passing a large HTML document through
 * a tool-call argument makes smaller models loop and balloons the context until
 * it 413s. Instead, a designer agent simply *outputs* the HTML, and the
 * orchestrator calls this function once, after the run, to produce the file.
 *
 * Writes to GENERATED_DIR (default <cwd>/public/generated → served at /generated)
 * and returns the public URL.
 *
 * RenderOptions are SERVER-controlled (from a pack's finalize.pdf), never agent
 * supplied — only short strings, so no HTML is ever passed through arguments.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RenderResult {
  url: string;
  format: 'pdf' | 'html';
}

/** Server-controlled PDF options (mirrors SectorFinalize.pdf). */
export interface RenderOptions {
  /** Noun for the success message (used by the caller, not here). */
  label?: string;
  /** Output filename prefix (sanitized). Defaults to 'brochure'. */
  basePrefix?: string;
  /** PDF <title> metadata, injected only when the HTML lacks a <title>. */
  title?: string;
  /** Page-number footer. Off by default (conflicts with full-bleed covers). */
  footer?: { text?: string } | boolean;
}

export interface PrintLayoutAuditOptions {
  /** Image URLs that must remain logo-sized rather than becoming hero artwork. */
  protectedLogoUrls?: string[];
  /** Expected number of deliberately composed A4 pages. */
  minPages?: number;
  maxPages?: number;
}

export interface PrintLayoutAuditResult {
  ok: boolean;
  issues: string[];
  pageCount: number;
}

function outputDir(): string {
  return process.env.GENERATED_DIR || path.join(process.cwd(), 'public', 'generated');
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'brochure';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip markdown fences / preamble so we always feed Chromium clean HTML. */
export function sanitizeHtml(raw: string): string {
  let h = raw.trim();
  h = h.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const start = h.indexOf('<');
  if (start > 0) h = h.slice(start);
  const end = h.lastIndexOf('>');
  if (end >= 0 && end < h.length - 1) h = h.slice(0, end + 1);
  // Defense-in-depth: this HTML may be served same-origin as a fallback artifact
  // and previewed in an iframe, so strip anything executable. A brochure/report
  // never legitimately needs scripts or inline event handlers.
  h = h
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
  return h;
}

/** True if the text looks like an HTML document we can render. */
export function looksLikeHtml(raw: string): boolean {
  return /<\s*(!doctype|html|body|div|section|style)/i.test(raw);
}

/**
 * Inject a <title> for PDF metadata when the document lacks one. No-op when
 * there's no <head> (e.g. a bare <div>) so we never corrupt the markup.
 */
function ensureTitle(html: string, title?: string): string {
  if (!title) return html;
  if (/<title>/i.test(html)) return html;
  if (!/<head[^>]*>/i.test(html)) return html;
  return html.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(title)}</title>`);
}

/**
 * Inject a UTF-8 charset + print-hardening CSS so: tinted backgrounds/accent
 * colours actually print (Chromium can drop them), the page is A4 full-bleed,
 * cards/headings don't split awkwardly across pages, and accented/CJK text never
 * mojibakes. Deterministic — doesn't rely on the model emitting any of it.
 */
function injectPrintHardening(html: string): string {
  const snippet =
    '<meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0}' +
    '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    'img{break-inside:avoid}h1,h2,h3{break-after:avoid}' +
    '@page{size:A4;margin:0}</style>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${snippet}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${snippet}</head>`);
  return snippet + html;
}

/**
 * Wait for every <img> to actually finish (load OR error), bounded.
 *
 * `networkidle0` alone is NOT sufficient: it resolves on network quiet and its
 * timeout is swallowed by the caller, so with a dozen external photo hosts the
 * page routinely proceeded while images were still in flight. That produced
 * BOTH visible symptoms — photos silently missing from the exported PDF, and
 * the print preflight marking still-loading images as `image_N_failed_to_load`
 * and rejecting every AI-composed design in favour of the plain fallback.
 *
 * Passed to page.evaluate as a STRING (a function literal would be rewritten
 * by tsx/esbuild with a `__name` helper that doesn't exist in the browser).
 */
const SETTLE_IMAGES_JS = `(async () => {
  var imgs = Array.prototype.slice.call(document.images);
  await Promise.all(imgs.map(function (img) {
    if (img.complete) return null;
    return new Promise(function (resolve) {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }));
})()`;

async function settleImages(page: any, budgetMs: number): Promise<void> {
  try {
    await Promise.race([
      page.evaluate(SETTLE_IMAGES_JS),
      new Promise((resolve) => setTimeout(resolve, budgetMs)),
    ]);
  } catch {
    /* Best-effort: a broken page must never block the render/preflight. */
  }
}

/**
 * Shared page-detection logic, exposed as a `findPages()` function so it can
 * be spliced into other injected scripts (the salvage pass below). The SAME
 * heuristic runs everywhere a "which element is page N" question is asked, so
 * indices always agree between the audit, the retry prompt's page numbers,
 * and the salvage pass that targets those exact indices.
 */
const LAYOUT_FIND_PAGES_JS = `function findPages(){
  var all = Array.prototype.slice.call(document.body.querySelectorAll('*'));
  var candidates = all.filter(function(el){
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var cls = String(el.className || '').toLowerCase();
    return cs.breakAfter === 'page' || cs.pageBreakAfter === 'always' ||
      ((cls.indexOf('page') !== -1 || el.tagName === 'SECTION') && r.height >= 850);
  });
  var pages = candidates.filter(function(el){
    return !candidates.some(function(other){ return other !== el && other.contains(el); });
  });
  if (!pages.length) {
    pages = Array.prototype.slice.call(document.body.children).filter(function(el){
      return el.getBoundingClientRect().height >= 850;
    });
  }
  return pages;
}`;

/**
 * The full geometry probe as an invocable string: `(function(options){ ...
 * return {issues, pageCount}; })`. Used by both `auditPrintLayout` and the
 * salvage pass's re-check, so "does this design still have a problem" is
 * always answered by the identical logic.
 */
const LAYOUT_PROBE_JS = `(function(options){
  ${LAYOUT_FIND_PAGES_JS}
  var issues = [];
  var all = Array.prototype.slice.call(document.body.querySelectorAll('*'));
  var pages = findPages();

  pages.forEach(function(el, index){
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var overflowHidden = cs.overflow === 'hidden' || cs.overflowY === 'hidden';
    var overflow = el.scrollHeight > el.clientHeight + 5 || el.scrollWidth > el.clientWidth + 5;
    var descendants = Array.prototype.slice.call(el.querySelectorAll('*'));
    var escaped = descendants.some(function(child){
      var cr = child.getBoundingClientRect();
      return cr.bottom > r.bottom + 5 || cr.right > r.right + 5 || cr.left < r.left - 5;
    });
    // A page failed with the SAME bare label on every one of the 3 redesign
    // attempts (e.g. "page_6_clips_or_overflows") because that label alone
    // gives the model nothing to act on differently — it doesn't know HOW
    // MUCH too tall the page is or WHICH content is responsible, so a
    // "start again from a blank canvas" redesign has no way to converge and
    // just regenerates a same-sized page that fails the same way. Quantify
    // the overage in real mm (viewport height 1123px = 297mm) and name the
    // offending heading so the retry brief can say something the model can
    // actually fix (split this page, shrink that image, trim this list) —
    // and so the salvage pass below knows exactly which page(s) to target.
    var mmPerPx = 297 / 1123;
    var heading = (el.querySelector('h1,h2,h3') || {}).innerText || '';
    var headingNote = heading ? ', heading "' + heading.trim().slice(0, 60) + '"' : '';
    if (r.height > 1145) {
      var overMm = Math.round((r.height - 1123) * mmPerPx);
      issues.push('page_' + (index + 1) + '_exceeds_a4 (about ' + overMm + 'mm taller than A4' + headingNote + ')');
    }
    if (overflow || (overflowHidden && escaped)) {
      var overflowMm = Math.round(Math.max(0, el.scrollHeight - el.clientHeight) * mmPerPx);
      issues.push(
        'page_' + (index + 1) + '_clips_or_overflows (content runs about ' +
        (overflowMm > 0 ? overflowMm + 'mm past the bottom edge' : 'past an edge') + headingNote + ')',
      );
    }
    var text = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
    // Day cards must use the same full-width reading order across the trip.
    if (/itinerary/i.test(text)) {
      var dayLabels = descendants.filter(function(child){
        return !child.children.length && /^day\\s+\\d+$/i.test(String(child.innerText || '').trim());
      });
      if (dayLabels.some(function(label,i){
        var a=label.getBoundingClientRect();
        return dayLabels.slice(i+1).some(function(other){
          var b=other.getBoundingClientRect();
          return Math.abs(a.top-b.top)<35 && Math.abs(a.left-b.left)>r.width*.25;
        });
      })) issues.push('page_' + (index + 1) + '_itinerary_columns_inconsistent');
    }
    var meaningful = descendants.filter(function(child){
      var tag = String(child.tagName || '').toLowerCase();
      if (tag === 'style' || tag === 'script') return false;
      var cr = child.getBoundingClientRect();
      if (cr.width < 2 || cr.height < 2) return false;
      // Measure content, not tall empty containers, footers or colour fields.
      if (child.matches('header,footer,[data-underfill-art]') || child.closest('header,footer')) return false;
      return tag === 'img' || (!child.children.length && String(child.innerText || '').trim().length > 0);
    });
    // A photographic background on the page itself is also cover artwork.
    // Previously only descendants counted, rejecting short-title photo covers.
    var largeVisual = String(cs.backgroundImage || '').indexOf('url(') >= 0 || descendants.some(function(child){
      var cr = child.getBoundingClientRect();
      var areaRatio = (cr.width * cr.height) / Math.max(1, r.width * r.height);
      if (areaRatio < 0.16) return false;
      var tag = String(child.tagName || '').toLowerCase();
      var bg = String(getComputedStyle(child).backgroundImage || '');
      return tag === 'img' || (bg && bg !== 'none');
    });
    if (text.length < 55 && !largeVisual) {
      issues.push('page_' + (index + 1) + '_is_sparse');
    } else if (index > 0 && meaningful.length) {
      var minTop = Math.min.apply(null, meaningful.map(function(child){ return child.getBoundingClientRect().top; }));
      var maxBottom = Math.max.apply(null, meaningful.map(function(child){ return child.getBoundingClientRect().bottom; }));
      var usedHeightRatio = Math.max(0, maxBottom - minTop) / Math.max(1, r.height);
      // Short content should be reflowed even when a small photo is present.
      // Empty card height and decorative gradients must not mask unused space.
      if (usedHeightRatio < 0.58 && text.length < 2200) {
        issues.push('page_' + (index + 1) + '_is_underfilled');
      }
    }
    var hasEmptyPanel = descendants.some(function(child){
      var cr = child.getBoundingClientRect();
      var ratio = (cr.width * cr.height) / Math.max(1, r.width * r.height);
      if (ratio < 0.045 || ratio > 0.5) return false;
      var childText = String(child.innerText || '').replace(/\s+/g, ' ').trim();
      if (childText || child.querySelector('img,svg,canvas,video')) return false;
      var style = getComputedStyle(child);
      var framed = parseFloat(style.borderTopWidth || '0') > 0 || parseFloat(style.borderLeftWidth || '0') > 0;
      return framed && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (hasEmptyPanel) issues.push('page_' + (index + 1) + '_contains_empty_panel');
    var hasNarrowLongCopy = descendants.some(function(child){
      var cr = child.getBoundingClientRect();
      var childText = String(child.innerText || '').replace(/\s+/g, ' ').trim();
      return cr.width > 0 && cr.width < r.width * 0.23 && cr.height > 70 && childText.length > 180;
    });
    if (hasNarrowLongCopy) issues.push('page_' + (index + 1) + '_has_narrow_long_copy');
  });

  var images = Array.prototype.slice.call(document.images);
  images.forEach(function(img, index){
    if (!img.complete || img.naturalWidth < 2 || img.naturalHeight < 2) {
      issues.push('image_' + (index + 1) + '_failed_to_load');
    }
  });
  var logoRectsByUrl = {};
  (options.protectedLogoUrls || []).filter(Boolean).forEach(function(url){
    var rects = images.filter(function(img){ return img.currentSrc === url || img.src === url; })
      .map(function(img){ return img.getBoundingClientRect(); });
    logoRectsByUrl[url] = rects;
    rects.forEach(function(r){
      if (r.width > 300 || r.height > 180) issues.push('logo_used_as_hero_artwork');
    });
    images.filter(function(img){ return img.currentSrc === url || img.src === url; }).forEach(function(img){
      var box = img.getBoundingClientRect();
      var frame = img.parentElement;
      if (frame && !frame.textContent.trim() && frame.querySelectorAll('img').length === 1) {
        var frameBox = frame.getBoundingClientRect();
        if (frameBox.width <= 300 && frameBox.height <= 180) box = frameBox;
      }
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        if (!node.textContent.trim() || !node.parentElement || node.parentElement.closest('style,script')) continue;
        var range = document.createRange(); range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some(function(r){
          return Math.min(r.right,box.right)-Math.max(r.left,box.left)>3 && Math.min(r.bottom,box.bottom)-Math.max(r.top,box.top)>3;
        })) { issues.push('logo_overlaps_text'); break; }
      }
    });
    all.forEach(function(el){
      if (String(getComputedStyle(el).backgroundImage || '').indexOf(url) !== -1) {
        issues.push('logo_used_as_background');
      }
    });
  });
  // The two co-brand marks (TMC + school) are drawn as SEPARATE identity marks
  // — every render must keep them visually distinct. A geometric check catches
  // "the two logo circles overlap in the corner" reliably, where a text
  // instruction to the model alone kept failing to prevent it.
  var logoUrls = Object.keys(logoRectsByUrl);
  for (var li = 0; li < logoUrls.length; li++) {
    for (var lj = li + 1; lj < logoUrls.length; lj++) {
      logoRectsByUrl[logoUrls[li]].forEach(function(a){
        logoRectsByUrl[logoUrls[lj]].forEach(function(b){
          var overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          var overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapW > 3 && overlapH > 3) issues.push('logo_marks_overlap');
          var pageA = pages.findIndex(function(page){
            var pr = page.getBoundingClientRect();
            var cy = (a.top + a.bottom) / 2;
            return cy >= pr.top && cy <= pr.bottom;
          });
          var pageB = pages.findIndex(function(page){
            var pr = page.getBoundingClientRect();
            var cy = (b.top + b.bottom) / 2;
            return cy >= pr.top && cy <= pr.bottom;
          });
          if (pageA >= 0 && pageA === pageB) {
            var heightRatio = Math.max(a.height, b.height) / Math.max(1, Math.min(a.height, b.height));
            if (heightRatio > 1.55) issues.push('logo_marks_unbalanced');
          }
        });
      });
    }
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 5) {
    issues.push('document_has_horizontal_overflow');
  }
  return { issues: Array.from(new Set(issues)), pageCount: pages.length };
})`;

/**
 * Render-aware preflight for AI-composed brochure HTML.
 *
 * A string-level sanity check cannot see the failures that matter in print:
 * an A4 section quietly growing onto a second sheet, clipped descendants,
 * broken images, or a logo enlarged into cover artwork. This uses the same
 * Chromium/font/image environment as the final PDF and rejects those layouts
 * before they can ship. Callers can then fall back to the deterministic
 * brochure template.
 */
export async function auditPrintLayout(
  rawHtml: string,
  opts: PrintLayoutAuditOptions = {},
): Promise<PrintLayoutAuditResult> {
  const html = injectPrintHardening(sanitizeHtml(rawHtml));
  const minPages = opts.minPages ?? 7;
  const maxPages = opts.maxPages ?? 14;
  let browser: any;
  try {
    const mod = (await import('puppeteer')) as unknown as { default: any };
    const puppeteer = mod.default ?? mod;
    browser = await Promise.race([
      puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8000)),
    ]);
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    } catch {
      /* Slow image hosts are reported as broken below when they truly failed. */
    }
    // Give slow-but-working images a real chance to finish before judging them,
    // so a slow host is never mistaken for a broken image (which would reject
    // an otherwise-good design).
    await settleImages(page, 8_000);
    try {
      await Promise.race([
        page.evaluate('(async()=>{try{await document.fonts.ready}catch(e){}})()'),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      /* Font readiness is best-effort; geometry checks still provide value. */
    }

    const result = (await page.evaluate(
      `${LAYOUT_PROBE_JS}(${JSON.stringify({ protectedLogoUrls: opts.protectedLogoUrls ?? [] })})`,
    )) as { issues: string[]; pageCount: number };

    if (result.pageCount < minPages) result.issues.push(`too_few_pages_${result.pageCount}`);
    if (result.pageCount > maxPages) result.issues.push(`too_many_pages_${result.pageCount}`);
    result.issues = [...new Set(result.issues)];
    return { ok: result.issues.length === 0, ...result };
  } catch (err) {
    return { ok: false, issues: [`layout_audit_failed:${(err as Error).message}`], pageCount: 0 };
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Best-effort, fully deterministic SALVAGE for a design that failed the
 * preflight ONLY on page-height overflow (never on a broken image, a logo
 * misused as artwork, or horizontal overflow — text-shrinking can't fix any
 * of those, so this bails out and lets the caller fall back to a real
 * AI redesign for those). Repeatedly asking the model to "redesign from a
 * blank canvas" is slow, costs real money per attempt, and is genuinely
 * uncertain — three attempts previously failed on the IDENTICAL page for the
 * identical reason. Font-size/line-height reduction is a universally SAFE
 * text-reflow change: it can't move an image, break an absolute-positioned
 * layout, or alter anything the print-preflight otherwise checks — so rather
 * than throw the whole (otherwise good) design away, this nudges just the
 * offending page(s) smaller, step by step, and re-runs the EXACT SAME
 * geometry check after every step. Only ships if that re-check comes back
 * completely clean; otherwise returns null and the caller proceeds to a real
 * redesign as before, unblocking the AI path in the common case without ever
 * risking a silently-broken salvage in the uncommon one.
 *
 * Uses Chromium's non-standard `zoom` CSS property, not `transform: scale`.
 * The audit measures `scrollHeight`/`clientHeight` — genuine LAYOUT box
 * dimensions — and `transform` is a paint-only effect that never changes
 * those (an earlier version of this used per-element `font-size`, which has
 * the same blind spot: it does nothing to an image's fixed height, and does
 * nothing at all to any descendant that sets its OWN absolute font-size,
 * which AI-authored CSS does constantly per Block 1's "10.5pt minimum"
 * instruction — so it silently failed to shrink real overflow). `zoom`
 * actually rescales the box model — images included — so it reliably moves
 * `scrollHeight`. It's applied to a WRAPPER inserted around the page's
 * existing children, not the page element itself, so the page keeps its
 * correct fixed A4 box for print pagination; only its content shrinks
 * within that unchanged frame.
 */
export async function shrinkOverflowingPages(
  rawHtml: string,
  issues: string[],
  opts: PrintLayoutAuditOptions = {},
): Promise<string | null> {
  const overflowPageNums = new Set<number>();
  const failedImageNums = new Set<number>();
  const underfilledPageNums = new Set<number>();
  const sparsePageNums = new Set<number>();
  const narrowCopyPageNums = new Set<number>();
  const emptyPanelPageNums = new Set<number>();
  const passesAudit = (result: { issues: string[]; pageCount: number }) =>
    !result.issues.length && result.pageCount >= (opts.minPages ?? 1)
    && result.pageCount <= (opts.maxPages ?? 20);
  let repairProtectedLogos = false;
  let repairHorizontalOverflow = false;
  const unsupportedIssues: string[] = [];
  for (const issue of issues) {
    const emptyMatch = issue.match(/^page_(\d+)_contains_empty_panel\b/);
    if (emptyMatch) {
      emptyPanelPageNums.add(Number(emptyMatch[1]));
      continue;
    }
    const narrowMatch = issue.match(/^page_(\d+)_has_narrow_long_copy\b/);
    if (narrowMatch) {
      narrowCopyPageNums.add(Number(narrowMatch[1]));
      continue;
    }
    const m = issue.match(/^page_(\d+)_(?:clips_or_overflows|exceeds_a4)\b/);
    if (m) {
      overflowPageNums.add(parseInt(m[1]!, 10));
      continue;
    }
    const imageMatch = issue.match(/^image_(\d+)_failed_to_load\b/);
    if (imageMatch) {
      failedImageNums.add(parseInt(imageMatch[1]!, 10));
      continue;
    }
    const underfilledMatch = issue.match(/^page_(\d+)_(?:is_underfilled|itinerary_columns_inconsistent)\b/);
    if (underfilledMatch) {
      underfilledPageNums.add(parseInt(underfilledMatch[1]!, 10));
      continue;
    }
    const sparseMatch = issue.match(/^page_(\d+)_is_sparse\b/);
    if (sparseMatch) {
      sparsePageNums.add(parseInt(sparseMatch[1]!, 10));
      continue;
    }
    if (/^(?:logo_used_as_hero_artwork|logo_used_as_background|logo_marks_overlap|logo_marks_unbalanced|logo_overlaps_text)$/.test(issue)) {
      repairProtectedLogos = true;
      continue;
    }
    if (issue === 'document_has_horizontal_overflow') {
      repairHorizontalOverflow = true;
      continue;
    }
    // Any issue that isn't overflow (or the purely cosmetic "sparse" note) needs
    // a real redesign — never salvage past a defect this fix can't address.
    unsupportedIssues.push(issue);
  }
  if (unsupportedIssues.length) return null;
  // A truly sparse page with no failed visual is a content/composition defect,
  // not something mechanical salvage should disguise. When images failed,
  // restoring those visual slots may resolve sparse/underfilled findings.
  if (sparsePageNums.size && !failedImageNums.size) return null;
  if (
    !overflowPageNums.size
    && !failedImageNums.size
    && !underfilledPageNums.size
    && !narrowCopyPageNums.size
    && !emptyPanelPageNums.size
    && !repairProtectedLogos
    && !repairHorizontalOverflow
  ) return null;

  const html = injectPrintHardening(sanitizeHtml(rawHtml));
  let pageNumsJson = JSON.stringify([...overflowPageNums]);
  const failedImagesJson = JSON.stringify([...failedImageNums]);
  const underfilledPageNumsJson = JSON.stringify([...underfilledPageNums]);
  let browser: any;
  try {
    const mod = (await import('puppeteer')) as unknown as { default: any };
    const puppeteer = mod.default ?? mod;
    browser = await Promise.race([
      puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8000)),
    ]);
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    } catch {
      /* Slow image hosts settle below; still worth attempting the salvage. */
    }
    await settleImages(page, 8_000);
    try {
      await Promise.race([
        page.evaluate('(async()=>{try{await document.fonts.ready}catch(e){}})()'),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      /* best-effort */
    }

    // Preserve the failed photo's frame instead of removing it and collapsing
    // the layout. A neutral labelled visual is safer than substituting an
    // unrelated destination photo. Protected brand logos are never replaced.
    if (failedImageNums.size) {
      await page.evaluate(
        `(function(imageNums, options){
          ${LAYOUT_FIND_PAGES_JS}
          var images = Array.prototype.slice.call(document.images);
          var protectedUrls = (options.protectedLogoUrls || []).filter(Boolean);
          function isProtected(img){
            return protectedUrls.some(function(url){ return img.currentSrc === url || img.src === url; });
          }
          function escXml(value){
            return String(value || '').replace(/[&<>"']/g, function(ch){
              return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[ch];
            });
          }
          imageNums.slice().sort(function(a,b){ return b-a; }).forEach(function(n){
            var img = images[n - 1];
            // A transient image may have loaded on this second browser pass.
            if (!img || (img.complete && img.naturalWidth >= 2 && img.naturalHeight >= 2) || isProtected(img)) return;
            // Never substitute decorative artwork for functional maps/QRs.
            if (/map|qr|logo/i.test(String(img.alt || '') + ' ' + String(img.className || ''))) return;
            var owner = findPages().find(function(candidate){ return candidate.contains(img); });
            var heading = owner && owner.querySelector('h1,h2,h3,h4');
            var label = String((heading && heading.textContent) || img.alt || 'Journey highlight').trim().slice(0, 70);
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">' +
              '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#14213d"/><stop offset=".55" stop-color="#1aafe0"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs>' +
              '<rect width="1200" height="800" fill="url(#g)"/><circle cx="1010" cy="120" r="230" fill="rgba(255,255,255,.10)"/><circle cx="170" cy="730" r="300" fill="rgba(255,255,255,.08)"/>' +
              '<text x="70" y="675" fill="white" font-family="Arial,sans-serif" font-size="48" font-weight="700">' + escXml(label) + '</text></svg>';
            img.removeAttribute('srcset');
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            img.alt = label;
            img.style.objectFit = img.style.objectFit || 'cover';
          });
        })(${failedImagesJson}, ${JSON.stringify({ protectedLogoUrls: opts.protectedLogoUrls ?? [] })})`,
      );
      await settleImages(page, 2_000);
    }

    if (emptyPanelPageNums.size) {
      await page.evaluate(`(function(pageNums){
        ${LAYOUT_FIND_PAGES_JS}
        var pages=findPages();
        pageNums.forEach(function(n){
          var owner=pages[n-1]; if(!owner) return;
          var pageRect=owner.getBoundingClientRect();
          Array.from(owner.querySelectorAll('*')).reverse().forEach(function(el){
            var r=el.getBoundingClientRect(), ratio=r.width*r.height/(pageRect.width*pageRect.height);
            if(ratio<.045 || ratio>.5 || String(el.innerText||'').trim() || el.querySelector('img,svg,canvas,video')) return;
            var style=getComputedStyle(el);
            // Preserve intentional artwork, pseudo-elements and controls.
            if(style.backgroundImage!=='none' || el.querySelector('input,button,a,iframe') ||
              !['none','normal','""'].includes(getComputedStyle(el,'::before').content) ||
              !['none','normal','""'].includes(getComputedStyle(el,'::after').content)) return;
            if(parseFloat(style.borderTopWidth)>0 || parseFloat(style.borderLeftWidth)>0) el.remove();
          });
        });
      })(${JSON.stringify([...emptyPanelPageNums])})`);
    }

    // Widen the nearest column layout containing long, pinched copy. This
    // defect must not short-circuit unrelated overflow/image repairs.
    if (narrowCopyPageNums.size) {
      await page.evaluate(`(function(pageNums){
        ${LAYOUT_FIND_PAGES_JS}
        var pages=findPages();
        pageNums.forEach(function(n){
          var owner=pages[n-1]; if(!owner) return;
          Array.from(owner.querySelectorAll('*')).forEach(function(el){
            var r=el.getBoundingClientRect();
            if(r.width<=0 || r.width>=owner.clientWidth*.23 || r.height<=70 || String(el.innerText||'').trim().length<=180) return;
            var grid=el.parentElement;
            while(grid && grid!==owner){
              var style=getComputedStyle(grid);
              if(style.display==='grid' || style.display==='flex') break;
              grid=grid.parentElement;
            }
            if(!grid || grid===owner) return;
            grid.style.setProperty('display','grid','important');
            grid.style.setProperty('grid-template-columns','minmax(0,1fr)','important');
            Array.from(grid.children).forEach(function(card){
              card.style.setProperty('width','auto','important');
              card.style.setProperty('max-width','none','important');
              card.style.setProperty('min-width','0','important');
            });
          });
        });
      })(${JSON.stringify([...narrowCopyPageNums])})`);
    }

    // Reflow actual cards into readable vertical space. Every resulting page
    // still passes the same audit, including overflow and density checks.
    if (underfilledPageNums.size) {
      await page.evaluate(
        `(function(pageNums){
          ${LAYOUT_FIND_PAGES_JS}
          var pages = findPages();
          pageNums.forEach(function(n){
            var el = pages[n - 1];
            if (!el) return;
            Array.prototype.slice.call(el.querySelectorAll('[data-underfill-art]')).forEach(function(art){ art.remove(); });
            // Stack paired cards on short pages. Preserve their content and
            // photos; never fill empty space with an unrelated decoration.
            Array.prototype.slice.call(el.querySelectorAll('*')).forEach(function(grid){
              var style = getComputedStyle(grid);
              if (grid.children.length < 2 || grid.children.length > 4) return;
              if (style.display !== 'grid' && style.display !== 'flex') return;
              var rect = grid.getBoundingClientRect();
              if (rect.width < el.clientWidth * .65 || rect.height < 140) return;
              grid.style.setProperty('display', 'grid', 'important');
              grid.style.setProperty('grid-template-columns', 'minmax(0,1fr)', 'important');
              grid.style.setProperty('gap', '24px', 'important');
              Array.prototype.slice.call(grid.children).forEach(function(card){
                card.style.setProperty('width','auto','important');
                card.style.setProperty('min-width','0','important');
              });
            });
            Array.prototype.slice.call(el.querySelectorAll('p,li')).forEach(function(text){
              if (parseFloat(getComputedStyle(text).fontSize) < 18) {
                text.style.setProperty('font-size','18px','important');
                text.style.setProperty('line-height','1.6','important');
              }
            });
          });
        })(${underfilledPageNumsJson})`,
      );
    }

    // Smaller models occasionally reuse a supplied logo token as a full-size
    // photograph, put both identity marks at the same coordinates, or emit a
    // logo as a CSS background. Repair those mechanical defects without asking
    // the model to rewrite otherwise-good copy and composition. The repair is
    // still accepted only when the complete print audit below passes.
    if (repairProtectedLogos || repairHorizontalOverflow) {
      await page.evaluate(
        `(function(options){
          ${LAYOUT_FIND_PAGES_JS}
          var protectedUrls = (options.protectedLogoUrls || []).filter(Boolean);
          var images = Array.prototype.slice.call(document.images);
          function isProtected(img){
            return protectedUrls.some(function(url){ return img.currentSrc === url || img.src === url; });
          }
          function pageFor(el){
            return findPages().find(function(page){ return page === el || page.contains(el); }) || null;
          }

          protectedUrls.forEach(function(url){
            var backgroundOwners = [];
            Array.prototype.slice.call(document.querySelectorAll('*')).forEach(function(el){
              if (String(getComputedStyle(el).backgroundImage || '').indexOf(url) !== -1) {
                el.style.backgroundImage = 'none';
                backgroundOwners.push(el);
              }
            });
            var logoImages = images.filter(function(img){ return img.currentSrc === url || img.src === url; });
            if (!logoImages.length && backgroundOwners.length) {
              var restoredLogo = document.createElement('img');
              restoredLogo.src = url;
              restoredLogo.alt = 'Brand logo';
              restoredLogo.style.cssText = 'position:absolute;right:24px;top:24px;width:112px;height:72px;object-fit:contain;z-index:20;';
              var backgroundPage = pageFor(backgroundOwners[0]);
              if (backgroundPage) backgroundPage.appendChild(restoredLogo);
            }
            logoImages.forEach(function(img){
              var rect = img.getBoundingClientRect();
              if (rect.width > 300 || rect.height > 180) {
                img.style.setProperty('width', '112px', 'important');
                img.style.setProperty('height', '72px', 'important');
                img.style.setProperty('min-width', '0', 'important');
                img.style.setProperty('min-height', '0', 'important');
              }
              img.removeAttribute('width');
              img.removeAttribute('height');
              img.style.setProperty('max-width', '180px', 'important');
              img.style.setProperty('max-height', '110px', 'important');
              img.style.setProperty('object-fit', 'contain', 'important');
            });
          });

          images = Array.prototype.slice.call(document.images);
          for (var aIndex = 0; aIndex < protectedUrls.length; aIndex++) {
            for (var bIndex = aIndex + 1; bIndex < protectedUrls.length; bIndex++) {
              var aImages = images.filter(function(img){ return img.currentSrc === protectedUrls[aIndex] || img.src === protectedUrls[aIndex]; });
              var bImages = images.filter(function(img){ return img.currentSrc === protectedUrls[bIndex] || img.src === protectedUrls[bIndex]; });
              aImages.forEach(function(a){
                bImages.forEach(function(b){
                  if (pageFor(a) !== pageFor(b)) return;
                  var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                  var heightRatio = Math.max(ar.height, br.height) / Math.max(1, Math.min(ar.height, br.height));
                  if (heightRatio > 1.55) {
                    var balancedHeight = Math.max(38, Math.min(92, (ar.height + br.height) / 2));
                    [a, b].forEach(function(img){
                      img.removeAttribute('width');
                      img.removeAttribute('height');
                      img.style.setProperty('width', 'auto', 'important');
                      img.style.setProperty('height', balancedHeight + 'px', 'important');
                      img.style.setProperty('max-height', balancedHeight + 'px', 'important');
                      img.style.setProperty('min-width', '0', 'important');
                      img.style.setProperty('min-height', '0', 'important');
                      img.style.setProperty('object-fit', 'contain', 'important');
                    });
                    ar = a.getBoundingClientRect();
                    br = b.getBoundingClientRect();
                  }
                  var overlapW = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
                  var overlapH = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
                  if (overlapW <= 3 || overlapH <= 3) return;
                  var ownerPage = pageFor(b);
                  var pr = ownerPage ? ownerPage.getBoundingClientRect() : { left: 0, right: 794 };
                  var rightShift = ar.right - br.left + 14;
                  var leftShift = br.right - ar.left + 14;
                  var shift = br.right + rightShift <= pr.right - 12 ? rightShift : -leftShift;
                  b.style.position = 'relative';
                  b.style.left = shift + 'px';
                });
              });
            }
          }

          // Locate a free top-of-page position when a logo intersects copy.
          images.filter(isProtected).forEach(function(img){
            var owner = pageFor(img); if (!owner) return;
            var textRects = [];
            var walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
            while(walker.nextNode()) {
              var node = walker.currentNode;
              if (!node.textContent.trim() || node.parentElement.closest('style,script')) continue;
              var range = document.createRange(); range.selectNodeContents(node);
              textRects.push.apply(textRects, Array.from(range.getClientRects()));
            }
            function overlaps(a,b){ return Math.min(a.right,b.right)-Math.max(a.left,b.left)>3 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>3; }
            var collisionBox = img.getBoundingClientRect(), frame = img.parentElement;
            if (frame && !frame.textContent.trim() && frame.querySelectorAll('img').length === 1) {
              var frameBox = frame.getBoundingClientRect();
              if (frameBox.width <= 300 && frameBox.height <= 180) collisionBox = frameBox;
            }
            if (!textRects.some(function(r){return overlaps(collisionBox,r);})) return;
            var pr = owner.getBoundingClientRect(), ir = img.getBoundingClientRect();
            var others = images.filter(function(other){return other !== img && isProtected(other);}).map(function(other){return other.getBoundingClientRect();});
            for(var y=24;y<180;y+=24) for(var x=24;x+ir.width<pr.width-24;x+=24) {
              var candidate={left:pr.left+x,top:pr.top+y,right:pr.left+x+ir.width,bottom:pr.top+y+ir.height};
              if (textRects.concat(others).some(function(r){return overlaps(candidate,{left:r.left-12,top:r.top-12,right:r.right+12,bottom:r.bottom+12});})) continue;
              var previous=img.parentElement;
              if(getComputedStyle(owner).position==='static') owner.style.position='relative';
              owner.appendChild(img);
              img.style.cssText='position:absolute!important;left:'+x+'px!important;top:'+y+'px!important;width:'+ir.width+'px!important;height:'+ir.height+'px!important;object-fit:contain;background:white;border-radius:8px;z-index:30;';
              if(previous!==owner && !previous.textContent.trim() && !previous.querySelector('img,svg')) previous.remove();
              return;
            }
          });
          if (options.repairHorizontalOverflow) {
            document.documentElement.style.maxWidth = '100%';
            document.documentElement.style.overflowX = 'hidden';
            document.body.style.maxWidth = '100%';
            document.body.style.overflowX = 'hidden';
            Array.prototype.slice.call(document.images).forEach(function(img){ img.style.maxWidth = img.style.maxWidth || '100%'; });
          }
        })(${JSON.stringify({
          protectedLogoUrls: opts.protectedLogoUrls ?? [],
          repairHorizontalOverflow,
        })})`,
      );
      await settleImages(page, 3_000);
    }

    // Constrain oversized route/photo elements to their content column before
    // shrinking text. Explicit map widths otherwise keep escaping sideways.
    await page.evaluate(`(function(pageNums){
      ${LAYOUT_FIND_PAGES_JS}
      var pages = findPages();
      pageNums.forEach(function(n){
        var el = pages[n - 1];
        if (!el) return;
        Array.prototype.slice.call(el.querySelectorAll('img,svg,canvas')).forEach(function(image){
          var parent = image.parentElement;
          if (!parent) return;
          var style = getComputedStyle(parent);
          var available = parent.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
          if (available > 0 && image.getBoundingClientRect().width > available + 5) {
            image.style.setProperty('max-width', available + 'px', 'important');
            image.style.setProperty('height', 'auto', 'important');
          }
        });
      });
    })(${pageNumsJson})`);
    // Preserve typography: balance overview columns and reclaim photo height
    // before resorting to whole-page scaling.
    await page.evaluate(`(function(pageNums){
      ${LAYOUT_FIND_PAGES_JS}
      var pages=findPages();
      pageNums.forEach(function(n){
        var owner=pages[n-1]; if(!owner) return;
        if (/overview/i.test(String((owner.querySelector('h2')||{}).textContent||''))) {
          Array.from(owner.querySelectorAll('*')).forEach(function(grid){
            if(getComputedStyle(grid).display!=='grid' || grid.children.length!==2) return;
            var cols=Array.from(grid.children);
            if(!cols.every(function(col){return col.children.length>=2;})) return;
            function bottom(col){return Math.max.apply(null,Array.from(col.children).map(function(c){return c.getBoundingClientRect().bottom;}));}
            var a=bottom(cols[0]),b=bottom(cols[1]);
            if(Math.abs(a-b)<180) return;
            var short=a<b?cols[0]:cols[1], tall=a<b?cols[1]:cols[0];
            var card=tall.lastElementChild, originalNext=card.nextSibling;
            if(card.querySelector('img') || !card.textContent.trim()) return;
            short.appendChild(card);
            if(Math.abs(bottom(cols[0])-bottom(cols[1]))>=Math.abs(a-b)) tall.insertBefore(card,originalNext);
            else card.style.setProperty('margin-top','24px');
          });
        }
        var cards=owner.querySelectorAll('.day-card');
        if(cards.length<1) return;
        var r=owner.getBoundingClientRect();
        var end=Math.max.apply(null,Array.from(cards).map(function(c){return c.getBoundingClientRect().bottom;}));
        var excess=Math.max(end-r.bottom+24, owner.scrollHeight-owner.clientHeight+8);
        var photos=Array.from(cards).flatMap(function(card){return Array.from(card.querySelectorAll('img'));});
        if(excess<=0 || !photos.length) return;
        var capacity=photos.reduce(function(sum,img){return sum+Math.max(0,img.getBoundingClientRect().height-120);},0);
        if(capacity<excess) return;
        photos.forEach(function(img){
          var h=img.getBoundingClientRect().height;
          img.style.setProperty('height',String(h-excess*Math.max(0,h-120)/capacity)+'px','important');
          img.style.setProperty('object-fit','cover','important');
        });
      });
    })(${pageNumsJson})`);
    const repairedAudit = await page.evaluate(
      `${LAYOUT_PROBE_JS}(${JSON.stringify({ protectedLogoUrls: opts.protectedLogoUrls ?? [] })})`,
    ) as { issues: string[]; pageCount: number };
    if (passesAudit(repairedAudit)) return await page.content();
    // Reflow can change which pages need splitting. Use the current geometry.
    overflowPageNums.clear();
    repairedAudit.issues.forEach((issue) => {
      const match = issue.match(/^page_(\d+)_(?:clips_or_overflows|exceeds_a4)/);
      if (match) overflowPageNums.add(Number(match[1]));
    });
    pageNumsJson = JSON.stringify([...overflowPageNums]);

    for (const zoom of [0.94, 0.9, 0.86, 0.82]) {
      await page.evaluate(
        `(function(pageNums, zoom){
          ${LAYOUT_FIND_PAGES_JS}
          var pages = findPages();
          pageNums.forEach(function(n){
            var el = pages[n - 1];
            if (!el) return;
            // First touch: move the page's existing children into a fresh
            // wrapper so ONLY that wrapper gets zoomed — the page element
            // itself must stay at its real A4 box for print pagination to
            // stay correct. Later iterations reuse the same wrapper and just
            // change its zoom value.
            if (el.querySelector('.day-card')) return;
            var wrap = el.querySelector('[data-shrink-wrap]');
            if (!wrap) {
              wrap = document.createElement('div');
              wrap.setAttribute('data-shrink-wrap', '1');
              while (el.firstChild) wrap.appendChild(el.firstChild);
              el.appendChild(wrap);
            }
            wrap.style.zoom = String(zoom);
          });
        })(${pageNumsJson}, ${zoom})`,
      );
      const recheck = (await page.evaluate(
        `${LAYOUT_PROBE_JS}(${JSON.stringify({ protectedLogoUrls: opts.protectedLogoUrls ?? [] })})`,
      )) as { issues: string[]; pageCount: number };
      if (passesAudit(recheck)) return await page.content();
    }

    // Large overflows (the observed 187mm case is more than half a page) cannot
    // be fixed legibly by further shrinking. Restore full-size typography and
    // split the overflowing content container across cloned A4 page shells. The
    // page's surrounding header/footer/background are cloned with it, while
    // content blocks move in source order until every physical page fits.
    const splitOk = (await page.evaluate(
      `(function(pageNums){
        ${LAYOUT_FIND_PAGES_JS}
        function isOverflowing(el){
          if (!el) return false;
          var r = el.getBoundingClientRect();
          if (el.scrollHeight > el.clientHeight + 5 || el.scrollWidth > el.clientWidth + 5) return true;
          return Array.prototype.slice.call(el.querySelectorAll('*')).some(function(ch){
            var cr = ch.getBoundingClientRect();
            return cr.bottom > r.bottom + 5 || cr.right > r.right + 5 || cr.left < r.left - 5;
          });
        }
        function depthFrom(root, el){
          var d = 0;
          while (el && el !== root) { d++; el = el.parentElement; }
          return d;
        }
        function splitContainer(pageEl){
          var pr = pageEl.getBoundingClientRect();
          var candidates = Array.prototype.slice.call(pageEl.querySelectorAll('*')).filter(function(el){
            if (!el.children || el.children.length < 2) return false;
            // Split the cards inside an oversized body, not the outer shell
            // containing a header and that entire body. Moving the whole body
            // merely reproduces the overflow on the next page.
            if (Array.prototype.slice.call(el.children).some(function(child){
              return child.children.length >= 2 && child.getBoundingClientRect().height > pageEl.clientHeight - 100;
            })) return false;
            var tag = String(el.tagName || '').toLowerCase();
            if (tag === 'style' || tag === 'script' || tag === 'svg') return false;
            var maxBottom = 0;
            Array.prototype.slice.call(el.children).forEach(function(ch){
              maxBottom = Math.max(maxBottom, ch.getBoundingClientRect().bottom);
            });
            return maxBottom > pr.bottom + 5 || el.scrollHeight > el.clientHeight + 5;
          });
          candidates.sort(function(a,b){
            var da = depthFrom(pageEl, a), db = depthFrom(pageEl, b);
            if (da !== db) return da - db;
            return b.children.length - a.children.length;
          });
          return candidates[0] || null;
        }
        function pathTo(root, node){
          var path = [];
          while (node && node !== root) {
            var parent = node.parentElement;
            if (!parent) return null;
            path.unshift(Array.prototype.indexOf.call(parent.children, node));
            node = parent;
          }
          return node === root ? path : null;
        }
        function atPath(root, path){
          var node = root;
          for (var i = 0; i < path.length; i++) {
            node = node && node.children[path[i]];
          }
          return node || null;
        }

        var initialPages = findPages();
        var queue = pageNums.map(function(n){ return initialPages[n - 1]; }).filter(Boolean);
        queue.forEach(function(pg){
          Array.prototype.slice.call(pg.querySelectorAll('[data-shrink-wrap]')).forEach(function(w){ w.style.zoom = '1'; });
        });
        var guard = 0;
        while (queue.length && guard++ < 40) {
          var sourcePage = queue.shift();
          if (!sourcePage || !isOverflowing(sourcePage)) continue;
          var sourceContainer = splitContainer(sourcePage);
          if (!sourceContainer) return false;
          var path = pathTo(sourcePage, sourceContainer);
          if (!path) return false;
          var continuation = sourcePage.cloneNode(true);
          var continuationContainer = atPath(continuation, path);
          if (!continuationContainer) return false;
          while (continuationContainer.firstChild) continuationContainer.removeChild(continuationContainer.firstChild);
          sourcePage.parentNode.insertBefore(continuation, sourcePage.nextSibling);
          var moved = 0;
          while (isOverflowing(sourcePage) && sourceContainer.children.length > 1) {
            continuationContainer.insertBefore(sourceContainer.lastElementChild, continuationContainer.firstChild);
            moved++;
          }
          if (!moved) {
            continuation.parentNode.removeChild(continuation);
            return false;
          }
          if (isOverflowing(sourcePage)) queue.unshift(sourcePage);
          if (isOverflowing(continuation)) queue.push(continuation);
          if (findPages().length > 20) return false;
        }
        return queue.length === 0;
      })(${pageNumsJson})`,
    )) as boolean;
    if (splitOk) {
      const recheck = (await page.evaluate(
        `${LAYOUT_PROBE_JS}(${JSON.stringify({ protectedLogoUrls: opts.protectedLogoUrls ?? [] })})`,
      )) as { issues: string[]; pageCount: number };
      if (passesAudit(recheck)) return await page.content();
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}

export async function renderHtmlToArtifact(
  rawHtml: string,
  id: string,
  opts?: RenderOptions,
): Promise<RenderResult> {
  const html = injectPrintHardening(ensureTitle(sanitizeHtml(rawHtml), opts?.title));
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const prefix = (opts?.basePrefix ?? 'brochure').replace(/[^a-zA-Z0-9_-]/g, '') || 'brochure';
  const base = `${prefix}-${safeId(id)}`;

  const wantFooter = !!opts?.footer;
  const footerText =
    typeof opts?.footer === 'object' && opts.footer ? escapeHtml(opts.footer.text ?? '') : '';

  try {
    const mod = (await import('puppeteer')) as unknown as { default: any };
    const puppeteer = mod.default ?? mod;
    const browser = await puppeteer.launch({
      headless: true,
      // --disable-dev-shm-usage: Linux/Docker /dev/shm defaults to 64 MB —
      // Chromium crashes or wedges against it under render load.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    try {
      const page = await browser.newPage();
      // Render at 2x so images/text are crisp in the PDF (default DSR=1 prints soft).
      await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });
      try {
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      } catch {
        // Slow/large internet images — proceed and render what has loaded;
        // gradient fallbacks cover anything that didn't finish in time.
      }
      // networkidle0's timeout above is swallowed, so without this the PDF was
      // exported while photos were still downloading — the "images are missing
      // from the brochure" defect. Wait for them to actually settle first.
      await settleImages(page, 12_000);
      // Wait for web fonts so the style system's Google-font pairings render
      // deterministically. Guarded so it never blocks past the budget above.
      try {
        // Bounded: try/catch only catches a rejection, not a promise that never
        // settles. A never-resolving fonts.ready would otherwise hang the run and
        // leak the concurrency slot — so race it against a short timer.
        await Promise.race([
          page.evaluate(async () => {
            await (globalThis as any).document?.fonts?.ready;
          }),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch {
        /* fonts.ready unsupported or slow — render anyway */
      }
      await page.pdf({
        path: path.join(dir, `${base}.pdf`),
        format: 'A4',
        printBackground: true,
        timeout: 30_000,
        // Honor the document's own @page (full-bleed) for deterministic pagination —
        // but NOT with a footer on (that needs the JS bottom margin set below).
        ...(wantFooter ? {} : { preferCSSPageSize: true }),
        displayHeaderFooter: wantFooter,
        headerTemplate: '<span></span>',
        footerTemplate: wantFooter
          ? `<div style="width:100%;font-size:8px;color:#888;padding:0 12mm;display:flex;justify-content:space-between"><span>${footerText}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
          : '<span></span>',
        // A footer needs a bottom margin; otherwise stay edge-to-edge for the
        // full-bleed cover (one margin applies to the whole document).
        margin: { top: '0', right: '0', bottom: wantFooter ? '12mm' : '0', left: '0' },
      });
      await writeFile(path.join(dir, `${base}.html`), html, 'utf8');
      return { url: `/generated/${base}.pdf`, format: 'pdf' };
    } finally {
      await browser.close();
    }
  } catch (err) {
    // Chromium unavailable — save the HTML so it's still usable (open & print).
    // eslint-disable-next-line no-console
    console.warn(`renderHtmlToArtifact: PDF engine unavailable, saving HTML (${(err as Error).message})`);
    await writeFile(path.join(dir, `${base}.html`), html, 'utf8');
    return { url: `/generated/${base}.html`, format: 'html' };
  }
}

/**
 * Measure the real rendered height (in mm) of each editorial block in headless
 * Chrome, so the brochure engine can paginate WITHOUT ever clipping content
 * (height estimates can't know true font metrics; this reads the truth).
 *
 * Implementation notes (hardened): the measuring HTML carries NO remote images
 * (the engine strips `src` and substitutes fixed-geometry CSS boxes), so we wait
 * only for `domcontentloaded` + web fonts — never `networkidle0` — keeping the
 * pass deterministic and fast (≈ launch + a few seconds, never a 30s image hole).
 * Every step is timeout-bounded; ANY failure (no Chromium, launch hang, bad read)
 * returns null so the engine falls back to its conservative over-estimates. Runs
 * the same sanitize → print-hardening pipeline as the real render for safety.
 *
 * Returns a map of block id → height in mm (a per-id value of -1 means "unknown";
 * the engine treats that as "use the estimate" for that block).
 */
export async function measureEditorialBlocks(
  measuringHtml: string,
  ids: string[],
): Promise<Record<string, number> | null> {
  const html = injectPrintHardening(sanitizeHtml(measuringHtml));
  let browser: any;
  try {
    const mod = (await import('puppeteer')) as unknown as { default: any };
    const puppeteer = mod.default ?? mod;
    // Guard an unbounded launch (driver/cdp hang) — without this the whole run could stall.
    browser = await Promise.race([
      puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('launch timeout')), 8000)),
    ]);
    const page = await browser.newPage();
    // DSR 1: getBoundingClientRect returns CSS pixels regardless of device scale.
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 8000 });
    } catch {
      /* proceed; fonts/layout settle below */
    }
    // The display italic 700 face drives kicker/heading heights — fonts MUST be
    // ready before measuring or the numbers are wrong. Bounded so it can't hang.
    // NOTE: the evaluated code is passed as a STRING, not a function literal —
    // tsx/esbuild instruments inline function literals with a `__name` helper that
    // does not exist in the browser context (→ "__name is not defined"). A string
    // body is handed to Chromium verbatim, sidestepping that transform entirely.
    try {
      await Promise.race([
        page.evaluate('(async()=>{try{await document.fonts.ready}catch(e){}})()'),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch {
      /* fonts.ready unsupported — measure anyway */
    }
    // Family-agnostic: matches any probe carrying data-ed-id (.ed-probe for the
    // editorial family, .bd-probe for the banded section-flow). The id attribute is
    // just a carrier — the same measurer serves both families.
    const measureScript = `(function(idList){
      var out = {};
      function esc(s){ return (window.CSS && window.CSS.escape) ? window.CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); }
      for (var i=0;i<idList.length;i++){
        var id = idList[i];
        var el = document.querySelector('[data-ed-id="'+esc(id)+'"]');
        var target = (el && el.firstElementChild) || el;
        out[id] = target ? target.getBoundingClientRect().height : -1;
      }
      return out;
    })(${JSON.stringify(ids)})`;
    const raw = (await page.evaluate(measureScript)) as Record<string, number>;
    const PX_PER_MM = 96 / 25.4;
    const mm: Record<string, number> = {};
    for (const id of ids) {
      const px = raw[id];
      mm[id] = typeof px === 'number' && px > 0 ? px / PX_PER_MM : -1;
    }
    return mm;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('measureEditorialBlocks failed:', (err as Error)?.message);
    return null;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}
