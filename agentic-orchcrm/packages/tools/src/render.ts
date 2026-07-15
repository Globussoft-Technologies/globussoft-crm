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
