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
    if (text.length < 55 && !el.querySelector('img')) issues.push('page_' + (index + 1) + '_is_sparse');
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
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
    } catch {
      /* Slow image hosts are reported as broken below when they truly failed. */
    }
    // Give slow-but-working images a real chance to finish before judging them,
    // so a slow host is never mistaken for a broken image (which would reject
    // an otherwise-good design).
    await settleImages(page, 20_000);
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
  for (const issue of issues) {
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
    // Any issue that isn't overflow (or the purely cosmetic "sparse" note) needs
    // a real redesign — never salvage past a defect this fix can't address.
    if (!/^page_\d+_is_sparse\b/.test(issue)) return null;
    // A sparse page needs a redesign; shrinking cannot create missing content.
    return null;
  }
  if (!overflowPageNums.size && !failedImageNums.size) return null;

  const html = injectPrintHardening(sanitizeHtml(rawHtml));
  const pageNumsJson = JSON.stringify([...overflowPageNums]);
  const failedImagesJson = JSON.stringify([...failedImageNums]);
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
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
    } catch {
      /* Slow image hosts settle below; still worth attempting the salvage. */
    }
    await settleImages(page, 20_000);
    try {
      await Promise.race([
        page.evaluate('(async()=>{try{await document.fonts.ready}catch(e){}})()'),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      /* best-effort */
    }

    // Remove only images that the audit proved unusable. A broken remote
    // photo should not force an otherwise sound AI composition through four
    // paid redesign attempts; the surrounding editorial layout remains intact.
    if (failedImageNums.size) {
      await page.evaluate(
        `(function(imageNums){
          var images = Array.prototype.slice.call(document.images);
          imageNums.slice().sort(function(a,b){ return b-a; }).forEach(function(n){
            var img = images[n - 1];
            if (img && img.parentNode) img.parentNode.removeChild(img);
          });
        })(${failedImagesJson})`,
      );
    }

    for (const zoom of [0.94, 0.9, 0.86, 0.82, 0.78, 0.72, 0.66, 0.6, 0.54, 0.5]) {
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
      const blocking = recheck.issues;
      if (!blocking.length) return await page.content();
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
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45_000 });
      } catch {
        // Slow/large internet images — proceed and render what has loaded;
        // gradient fallbacks cover anything that didn't finish in time.
      }
      // networkidle0's timeout above is swallowed, so without this the PDF was
      // exported while photos were still downloading — the "images are missing
      // from the brochure" defect. Wait for them to actually settle first.
      await settleImages(page, 25_000);
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
