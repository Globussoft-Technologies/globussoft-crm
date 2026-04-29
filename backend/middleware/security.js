const helmet = require('helmet');

// 1. Helmet with CRM-appropriate config — closes #186 (missing security headers)
// and #342 (regression: headers not firing in production).
//
// #342 root cause investigation: the previous config supplied a custom
// `contentSecurityPolicy` directive block that, combined with the Vite-built
// SPA shipping inline styles + small inline bootstrap scripts, caused browsers
// to silently strip subsequent header values when a directive failed parsing
// in some upstream Nginx/CSP-stripping setup. The embed widget loaded from
// `crm.globusdemos.com` into partner sites also tripped over the
// `same-site` crossOriginResourcePolicy because partner origins are
// cross-site, not same-site.
//
// #342 fix: use Helmet's defaults for the *six core headers* the bug reporter
// flagged (HSTS, X-Frame-Options, Referrer-Policy, X-Content-Type-Options,
// X-DNS-Prefetch-Control, X-XSS-Protection) and explicitly DISABLE the two
// directives that were breaking the SPA + widget:
//   • contentSecurityPolicy: false  — SPA uses inline styles (Vite/React) and
//     a strict CSP without nonce wiring would block them. Re-enable later
//     with a nonce/hash strategy once SSR or CSP-compatible bundling lands.
//   • crossOriginEmbedderPolicy: false — the embed widget loads from external
//     partner origins, which COEP=require-corp would refuse.
//   • crossOriginResourcePolicy: 'cross-origin' — the widget JS is fetched
//     by partner sites (callified.ai, partner CRMs); 'same-site' rejected
//     those legitimate cross-origin loads.
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // 1-year HSTS, conservative — no preload until we're sure every subdomain
  // is HTTPS-ready. includeSubDomains so *.globusdemos.com inherits.
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  // SAMEORIGIN keeps /embed/lead-form.html previewable inside our own admin
  // UI; the widget is loaded BY partner sites (parent iframe is theirs, not
  // ours) so we don't need to allow being framed by anyone else.
  xFrameOptions: { action: 'sameorigin' },
  // Pinned explicitly so future helmet upgrades can't silently drop them.
  xContentTypeOptions: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

// 1b. Permissions-Policy — helmet 8.x doesn't ship this header, so set it
// manually. Camera/mic OFF (consent canvas is pointer-events, not getUserMedia;
// softphone uses Twilio's voice SDK which negotiates separately and we'll
// re-enable per-route if needed). Geolocation only on self (booking page may
// want city auto-fill). interest-cohort=() opts out of FLoC/Topics tracking.
function permissionsPolicyMiddleware(req, res, next) {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(self), interest-cohort=()'
  );
  next();
}

// 2. Sanitize req.body strings recursively. #187 — the previous version called
// sanitize-html with `allowedTags: []` which both stripped anything between
// `<` and `>` AND HTML-encoded ampersands ("A & B" → "A &amp; B"), corrupting
// ordinary user input ("Q3 Plan: <budget>" → "Q3 Plan: "). The right XSS
// defense is output encoding (React already escapes by default), not
// pre-storage mutation. We only strip truly dangerous tags as defense-in-depth.
//
// #213: extended the dangerous-tag list to cover img/video/audio/source/applet/
// base/input/textarea — tags that can pull external resources, fire load/error
// handlers, or stand in for hidden form vectors. Also strip inline event-handler
// attributes (`onclick=`, `onerror=`, `onload=`, …) so a payload like
// `<img onerror=alert(1)>` doesn't survive in any sink that ever uses
// dangerouslySetInnerHTML (PDFs, SMS templates, email HTML, OG cards).
const DANGEROUS_TAG_RE = /<\/?(script|iframe|object|embed|style|link|meta|form|svg|img|video|audio|source|applet|base|input|textarea)\b[^>]*>/gi;
// `javascript:` URLs in href/src; `data:` URLs that carry HTML/JS too
const DANGEROUS_URL_RE = /\b(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|data|vbscript):[^"'>\s]*\2/gi;
// Inline event handlers: onclick=…, onerror=…, onload=…, onmouseover=…
const EVENT_HANDLER_RE = /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  next();
}

function sanitizeObject(obj) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      // Strip dangerous tags + event handlers + javascript: URLs, but preserve
      // raw text (incl. ampersands and angle-bracket tokens like "<budget>")
      // verbatim.
      obj[key] = obj[key]
        .replace(DANGEROUS_TAG_RE, '')
        .replace(DANGEROUS_URL_RE, '')
        .replace(EVENT_HANDLER_RE, '');
    } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      sanitizeObject(obj[key]);
    }
  }
}

// 3. Prevent tenantId injection — strip tenantId from req.body
function stripTenantOverride(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    delete req.body.tenantId; // routes add tenantId from req.user.tenantId, never from input
    delete req.body.userId; // same protection
  }
  next();
}

module.exports = { helmetMiddleware, permissionsPolicyMiddleware, sanitizeBody, stripTenantOverride };
