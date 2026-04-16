const helmet = require('helmet');
const sanitizeHtml = require('sanitize-html');

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

// 2. Sanitize req.body strings recursively (prevent stored XSS)
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  next();
}

function sanitizeObject(obj) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      // Don't sanitize known HTML fields (landing page content, KB articles, email body, doc templates)
      const htmlFields = ['body', 'content', 'terms', 'description', 'notes', 'cssOverrides', 'flow', 'steps', 'layout', 'config', 'availability', 'rawPayload', 'data'];
      if (!htmlFields.includes(key)) {
        obj[key] = sanitizeHtml(obj[key], { allowedTags: [], allowedAttributes: {} }); // strip ALL HTML
      }
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
