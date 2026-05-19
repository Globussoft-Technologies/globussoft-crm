const helmet = require('helmet');

// 1. Helmet with CRM-appropriate config — closes #186 (missing security headers)
// and #342 (regression: headers not firing in production) and #654 (CSP enabled,
// transitional).
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
//   • crossOriginEmbedderPolicy: false — the embed widget loads from external
//     partner origins, which COEP=require-corp would refuse.
//   • crossOriginResourcePolicy: 'cross-origin' — the widget JS is fetched
//     by partner sites (callified.ai, partner CRMs); 'same-site' rejected
//     those legitimate cross-origin loads.
//
// #654 — CSP TRANSITIONAL ENABLE (2026-05):
//   Two attack vectors CSP addresses today:
//     (a) XSS-injected <script> exfiltrating session token from sessionStorage
//         (we ship credentials there per #343/#344) — bounded by script-src.
//     (b) Form-action / object-src abuse + frame-ancestor clickjacking on
//         the admin UI — bounded by form-action / object-src / frame-ancestors.
//   We CANNOT yet emit a strict nonce-based CSP because:
//     - The Vite-built SPA ships inline styles (React.createElement style
//       prop + Recharts inline SVG style tags).
//     - Legacy components still carry a small number of inline `onclick=`
//       attributes — migration to event-handler-attach is filed as
//       a follow-up issue.
//   So we ship a TRANSITIONAL CSP with `'unsafe-inline'` on script-src and
//   style-src — it does NOT block inline scripts (and therefore does not yet
//   close the full XSS exfil surface), but it DOES block:
//     - third-party origins from loading scripts (only self + jsdelivr CDN)
//     - third-party origins from injecting connect-src fetches (only self +
//       payment providers + SendGrid)
//     - object-src plugins entirely
//     - external frame embedding (frame-ancestors: 'self')
//   This is a STRICT IMPROVEMENT over the previous `contentSecurityPolicy:
//   false` state. The tightening to nonces is filed as a follow-up issue.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    // useDefaults: false — emit only what we explicitly enumerate. Helmet's
    // built-in defaults include `upgrade-insecure-requests` which is fine
    // but we want the directive list visible in code review.
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' on script-src is a TRANSITIONAL allowance.
      // Follow-up issue: migrate legacy inline event handlers to attached
      // listeners + emit a nonce per request, then drop 'unsafe-inline'.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      // 'unsafe-inline' on style-src is REQUIRED today because Vite/React
      // emit inline style attributes (style={{}}). Hash-based or nonce-based
      // tightening requires a build-step change.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      // data: + https: img sources — covers QR codes (data:image/png) +
      // any CDN-hosted asset. blob: needed for client-rendered PDF previews.
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      // connectSrc: the SPA hits its own /api + a small set of third-party
      // providers (SendGrid, Razorpay, Stripe checkout). wss: needed for the
      // Socket.io upgrade. *.sentry.io for Sentry browser SDK.
      connectSrc: [
        "'self'",
        'https://api.sendgrid.com',
        'https://api.razorpay.com',
        'https://checkout.razorpay.com',
        'https://api.stripe.com',
        'https://*.sentry.io',
        'wss:',
      ],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      // object-src 'none' kills <object> / <embed> / Flash. Strict.
      objectSrc: ["'none'"],
      // form-action: limit the destination of <form action=> POSTs to self —
      // bounds CSRF-via-form-submission to the same-origin set.
      formAction: ["'self'"],
      // frame-ancestors 'self' replaces X-Frame-Options SAMEORIGIN
      // semantically and is the modern equivalent. Pinned spec
      // (security-headers.spec.js) also asserts the legacy header for
      // browsers that haven't migrated to CSP frame-ancestors.
      frameAncestors: ["'self'"],
      // base-uri 'self' blocks an injected <base> tag from rewriting the
      // document base URL and exfiltrating relative-URL requests.
      baseUri: ["'self'"],
    },
  },
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
//
// Records what it stripped on req.strippedFields so route handlers that want
// to fail-loud (e.g. issue #422 drift #3 — POST /reply rejecting attempted
// cross-tenant writes with 400 IMMUTABLE_FIELD instead of silently 200'ing
// a no-op) can introspect what came in. Routes that don't care continue to
// work unchanged.
//
// Exception: Public endpoints like /customer/register need tenantId from the body
// since users aren't authenticated yet.
function stripTenantOverride(req, res, next) {
  req.strippedFields = req.strippedFields || {};

  // Skip stripping for public endpoints that need tenantId
  const shouldSkip = req.path.includes('/customer/register');

  // Debug logging
  if (req.path.includes('/customer/register')) {
    console.log('[stripTenantOverride] Path:', req.path, 'shouldSkip:', shouldSkip, 'tenantId in body:', 'tenantId' in (req.body || {}), 'tenantId value:', req.body?.tenantId);
  }

  if (req.body && typeof req.body === 'object') {
    if (!shouldSkip) {
      if ('tenantId' in req.body) {
        req.strippedFields.tenantId = req.body.tenantId;
        delete req.body.tenantId; // routes add tenantId from req.user.tenantId, never from input
      }
      if ('userId' in req.body) {
        req.strippedFields.userId = req.body.userId;
        delete req.body.userId; // same protection
      }
    } else {
      // Debug: show we're skipping
      if (req.path.includes('/customer/register')) {
        console.log('[stripTenantOverride] SKIPPING deletion for customer/register - tenantId should remain');
      }
    }
  }
  next();
}

module.exports = { helmetMiddleware, permissionsPolicyMiddleware, sanitizeBody, stripTenantOverride };
