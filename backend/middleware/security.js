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
// pre-storage mutation. Replaced with a narrow regex that only strips truly
// dangerous tags as defense-in-depth.
const DANGEROUS_TAG_RE = /<\/?(script|iframe|object|embed|style|link|meta|form|svg)\b[^>]*>/gi;

function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  next();
}

function sanitizeObject(obj) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      // Strip dangerous tags but preserve raw text (incl. ampersands and
      // angle-bracket tokens like "<budget>") verbatim.
      obj[key] = obj[key].replace(DANGEROUS_TAG_RE, '');
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
