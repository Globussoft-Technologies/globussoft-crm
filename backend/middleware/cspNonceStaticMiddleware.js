// #917 slice S35 (FR-3.X) — CSP-nonce static-file middleware.
//
// Why this middleware exists
// --------------------------
// Slice S1 (backend/lib/cspNonce.js) mints a per-request CSP nonce and
// publishes it on res.locals.cspNonce. The strict Report-Only CSP header
// advertises `'nonce-<base64>'` on script-src/style-src so the browser will
// accept inline scripts/styles ONLY when they carry the matching nonce
// attribute. The remaining ingredient — and the contract this slice closes —
// is the HTML side: every inline `<script>` / `<style>` plus the
// `<meta name="csp-nonce" content="...">` tag must carry the SAME nonce
// the browser saw in the CSP header.
//
// frontend/index.html ships with a literal `__CSP_NONCE__` placeholder. In
// production this substitution can live in Nginx (sub_filter directive); in
// dev + as a no-extra-infra fallback in prod it lives here in Express.
// This middleware reads frontend/dist/index.html (vite build output) once,
// caches the template, and on every GET that hits it, substitutes the
// placeholder with res.locals.cspNonce and sends the HTML.
//
// Contract
// --------
// - Handles GETs only — non-GET falls through to next().
// - Falls through to next() for /api/* paths (those are real route handlers).
// - Falls through to next() for paths containing a dot (those are static
//   assets — /assets/index-abc.js, /favicon.svg, /uploads/foo.pdf, etc. —
//   which are handled by express.static and Vite-built asset routes).
// - Reads frontend/dist/index.html in production (built by vite build).
//   Falls back to frontend/index.html in dev so local-stack runs don't
//   require a `vite build` step before the middleware is exercised.
// - Caches the template source on first read (filesystem I/O happens once
//   per process). The `clearCache()` test seam forces a re-read; production
//   redeploys naturally re-cache by spawning a new pm2 worker.
// - On file-read failure (missing dist/, permission error, etc.) calls
//   next() — the SPA catch-all higher in the chain can serve a fallback.
//   The middleware never sends a 5xx itself; that would surface as a hard
//   block on every page-load if the dist/ path was misconfigured.
// - Substitutes ALL occurrences of __CSP_NONCE__ (template may carry the
//   placeholder on the meta tag + on the inline FOUC-prevention script +
//   on any future inline style tag — substitution is global so future
//   nonce-attribute additions don't need a middleware change).
//
// Wiring (deferred to a follow-up slice — server.js shared-file hazard with
// concurrent agents):
//   In server.js, mount this middleware:
//     1. AFTER `app.use(attachNonce)` (which populates res.locals.cspNonce)
//     2. AFTER `app.use(helmetMiddleware)` + the strict Report-Only CSP
//        (so the CSP header is set before the HTML response goes out)
//     3. BEFORE the SPA catch-all `app.get('*', ...)` if one exists, or
//        before any express.static('frontend/dist') that would serve the
//        un-substituted index.html.
//
// The middleware is intentionally tiny + side-effect-free aside from the
// module-scoped template cache so it can be unit-tested without booting
// Express.

const fs = require('fs');
const path = require('path');

let cachedTemplate = null;

/**
 * Read frontend/dist/index.html (production) with a fallback to
 * frontend/index.html (dev). Throws if neither path exists or the
 * read fails — caller is responsible for catching.
 *
 * @returns {string} index.html source
 */
function readIndexHtml() {
  const distPath = path.resolve(__dirname, '../../frontend/dist/index.html');
  const devPath = path.resolve(__dirname, '../../frontend/index.html');
  const target = fs.existsSync(distPath) ? distPath : devPath;
  return fs.readFileSync(target, 'utf8');
}

/**
 * Test seam: drop the cached template so the next request re-reads from
 * disk. Production code MUST NOT call this — relies on pm2 worker restart
 * for cache invalidation on deploy. Exported only so vitest can verify the
 * cache + re-read contract without spawning new workers.
 */
function clearCache() {
  cachedTemplate = null;
}

/**
 * Express middleware: substitute `__CSP_NONCE__` in index.html and serve.
 *
 * See module-level docstring for the full contract. Short version: handles
 * GET requests for paths that look like SPA routes (no dot, not /api/*),
 * everything else falls through.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function cspNonceStaticMiddleware(req, res, next) {
  // Non-GET → fall through. SPA index.html is only ever served on GET; a
  // POST to / is either an API call mis-routed (let the real handler 404
  // it) or a CSRF probe.
  if (req.method !== 'GET') return next();

  // API routes have their own handlers — don't intercept.
  if (req.path.startsWith('/api/')) return next();

  // Static assets (paths containing a dot — /favicon.svg, /assets/x.js,
  // /uploads/y.pdf, /robots.txt) are served by express.static or by route
  // handlers. We only serve the SPA shell.
  if (req.path.includes('.')) return next();

  // Server-rendered public landing pages (/p/:slug) and the /embed lead-form
  // surface have dedicated route handlers mounted later in server.js. Don't
  // serve the SPA shell for those paths.
  if (req.path.startsWith('/p/')) return next();
  if (req.path.startsWith('/embed/')) return next();

  try {
    if (!cachedTemplate) cachedTemplate = readIndexHtml();
    // res.locals.cspNonce is populated by attachNonce (mounted upstream).
    // If absent (test harness, mis-wired middleware order), substitute with
    // an empty string — the resulting CSP header will reject inline scripts
    // (the nonce won't match) but the page still renders rather than 500ing.
    const nonce = (res.locals && res.locals.cspNonce) || '';
    const html = cachedTemplate.replace(/__CSP_NONCE__/g, nonce);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    // File-read failure → fall through to whatever catch-all comes next
    // (typically the SPA route in Nginx, or a 404 handler). We log so the
    // misconfiguration is visible but don't 500 — a hard block on every
    // page-load would be worse than a graceful fallthrough.
    // eslint-disable-next-line no-console
    console.error('[cspNonceStatic] index.html read failed:', e.message);
    next();
  }
}

module.exports = cspNonceStaticMiddleware;
module.exports.cspNonceStaticMiddleware = cspNonceStaticMiddleware;
module.exports.clearCache = clearCache;
