const helmet = require('helmet');

// 1. Helmet with CRM-appropriate config
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // needed for React dev
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "ws:", "wss:", "https://generativelanguage.googleapis.com", "https://api.mailgun.net", "https://graph.facebook.com", "https://api.twitter.com"],
      fontSrc: ["'self'", "data:"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://player.vimeo.com"],
    },
  },
  crossOriginEmbedderPolicy: false, // needed for external images in landing pages
});

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

module.exports = { helmetMiddleware, sanitizeBody, stripTenantOverride };
