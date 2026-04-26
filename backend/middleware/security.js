const helmet = require('helmet');

// 1. Helmet with CRM-appropriate config — closes #186 (missing security headers).
// Production sites get strict HTTPS-only imgSrc; dev keeps http: so localhost
// asset previews don't break. The 'unsafe-inline' / 'unsafe-eval' on scriptSrc
// remain a known compromise needed by the current Vite/React build — TODO:
// tighten with a strict-CSP nonce/hash strategy once SSR or a CSP-compatible
// build pipeline is in place. The /embed/* iframe is served from THIS origin,
// so frameSrc 'self' + xFrameOptions SAMEORIGIN don't break it; the widget is
// loaded BY external sites INTO their pages, so frame-ancestors stays 'self'
// (we never need to be iframed by anyone else for our own admin UI).
const isProd = process.env.NODE_ENV === 'production';

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // needed for React dev
      styleSrc: ["'self'", "'unsafe-inline'"],
      // #186: tighten imgSrc to https-only in production; keep http: in dev so
      // local asset previews and dev-mode landing-page imports keep working.
      imgSrc: isProd
        ? ["'self'", "data:", "https:"]
        : ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "ws:", "wss:", "https://generativelanguage.googleapis.com", "https://api.mailgun.net", "https://graph.facebook.com", "https://api.twitter.com"],
      fontSrc: ["'self'", "data:"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://player.vimeo.com"],
      // #186: defense-in-depth — block <base href> hijacking and only allow
      // forms to post back to ourselves. Safe additions, no existing flow needs
      // a cross-origin <form action=…> from inside our SPA.
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // needed for external images in landing pages
  // #186: 1-year HSTS, conservative — no preload until we're sure every
  // subdomain is HTTPS-ready. includeSubDomains so *.globusdemos.com inherits.
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  // #186: block iframing from other origins. /embed/lead-form.html is loaded
  // from THIS origin into external sites (the parent iframes us), so we don't
  // need to allow being framed by anyone. SAMEORIGIN keeps internal previews
  // (e.g. landing-page builder rendering /landing/:slug in an iframe) working.
  xFrameOptions: { action: 'sameorigin' },
  // helmet sets these by default but we pin them explicitly so future helmet
  // upgrades can't silently drop them.
  xContentTypeOptions: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // #186: keep our static assets fetchable by same-site embeds (the embed
  // widget JS is served from crm.globusdemos.com and loaded by partner sites
  // — that's a cross-site script load, but we WANT that to work for the
  // widget. same-site allows callified.ai, globusdemos.com siblings, etc.
  // If we ever lock the widget to specific origins we can tighten further.
  crossOriginResourcePolicy: { policy: 'same-site' },
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
