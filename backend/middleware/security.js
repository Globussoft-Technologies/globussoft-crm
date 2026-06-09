const helmet = require('helmet');
const { attachNonce } = require('../lib/cspNonce');

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
      // #921 slice S4 (FR-3.6) — frame-ancestors flipped from 'self' to
      // 'none' as the global default. The CRM is not designed to be
      // legitimately iframed by anyone (including ourselves) outside of
      // the explicit embed widget at /embed/lead-form.html, which loads
      // INTO partner sites and so cares about the OUTBOUND framing
      // (handled by the partner's CSP, not ours). The previous 'self'
      // value left a clickjacking window open via subdomain takeover (an
      // attacker controlling any *.globusdemos.com origin could iframe
      // the admin UI and replay clicks). 'none' closes that window
      // unconditionally. Per-route overrides for the embed widget are
      // wired via the `allowIframeEmbedding(allowList)` middleware
      // exported below; per-tenant allowlist via Tenant.embedAllowlistJson
      // is FOLLOW-UP (column doesn't exist yet — see slice S4 commit body).
      frameAncestors: ["'none'"],
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
  // #921 slice S4 (FR-3.6) — X-Frame-Options flipped from 'sameorigin' to
  // 'deny' as the global default. Paired with CSP frame-ancestors 'none'
  // above; X-Frame-Options is the legacy companion header for browsers
  // that predate CSP2 frame-ancestors (every supported browser today
  // honors both; we ship both for defense-in-depth + audit trail).
  // The embed widget at /embed/lead-form.html overrides this per-route
  // via the `allowIframeEmbedding()` middleware so it remains framable
  // by partner sites that legitimately host the lead-capture widget.
  xFrameOptions: { action: 'deny' },
  // Pinned explicitly so future helmet upgrades can't silently drop them.
  xContentTypeOptions: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

// 1a-strict. #917 slice 1 — additive STRICT Content-Security-Policy in
// Report-Only mode.
//
// The transitional CSP above (helmetMiddleware) ships 'unsafe-inline' on
// script-src + style-src because the Vite-built SPA emits inline scripts/styles
// and a small number of legacy inline event handlers haven't been migrated yet.
// That allowance defeats one of the strongest XSS mitigations the browser
// offers — a single un-escaped contact name / itinerary note / supplier
// description becomes immediate account takeover when combined with the JWT
// in sessionStorage (#914).
//
// Slice 1 (shipped): emit a SECOND CSP header — `Content-Security-Policy-
// Report-Only` — WITHOUT 'unsafe-inline' on script-src + style-src. Browsers
// log violations to devtools/`report-uri` but do NOT block them. This lets
// us observe what would break under a strict enforce-mode CSP without
// shipping a regression. A future slice promotes report-only → enforce-mode
// after the SPA's inline-script/inline-style surface is migrated to external
// bundles + nonces.
//
// Slice S1 (this commit, FR-3.2): mint a cryptographically-random per-request
// nonce via lib/cspNonce.js and advertise it as `'nonce-<base64>'` on
// script-src + style-src of the strict Report-Only CSP. The HTML template
// (frontend/index.html) carries a `<meta name="csp-nonce" content="__CSP_NONCE__">`
// placeholder; production-serving Nginx (or the Express static handler) is
// expected to substitute `__CSP_NONCE__` with the live nonce per response
// and to stamp the same nonce onto each `<script>` / `<style>` it ships.
// That deploy-layer wiring is the follow-up to this slice — the contract
// landed here is "backend mints + advertises the nonce; frontend has the
// hook; report-only header surfaces what enforce mode would block".
//
// Promotion to enforce mode is gated on CSP_ENFORCE=1 (planned follow-up
// per FR-3.7 backward-compat cadence); the report-only header continues to
// ship alongside until a clean violation window is observed.
//
// Why a second helmet instance rather than `reportOnly: true` on the existing
// one: we want BOTH headers on the response — the enforce-mode transitional
// CSP (already shipping) for actual defense today, AND the strict
// Report-Only header observing future-state violations. Helmet supports
// emitting both: helmet 8.x's `contentSecurityPolicy.reportOnly: true`
// switches the SINGLE CSP header from enforce → report-only mode, but we
// can layer a second helmet just for the Report-Only header.
//
// Helmet supports function directives of the shape `(req, res) => string`,
// invoked per-request. We use that to splice the nonce off res.locals which
// `attachNonce` populates upstream.
const nonceScriptSrc = (req, res) => `'nonce-${res.locals && res.locals.cspNonce ? res.locals.cspNonce : ''}'`;
const nonceStyleSrc = (req, res) => `'nonce-${res.locals && res.locals.cspNonce ? res.locals.cspNonce : ''}'`;

const helmetStrictReportOnlyMiddleware = helmet({
  // Disable every header this second helmet would otherwise duplicate; we
  // only want the strict Report-Only CSP.
  contentSecurityPolicy: {
    useDefaults: false,
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      // No 'unsafe-inline'. The per-request nonce minted by attachNonce
      // (mounted upstream in server.js) is spliced in via the function
      // directive — the only inline scripts/styles the browser will allow
      // (when enforce-mode flips) are ones explicitly carrying the matching
      // nonce attribute set by the HTML template substitution layer.
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', nonceScriptSrc],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', nonceStyleSrc],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
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
      objectSrc: ["'none'"],
      formAction: ["'self'"],
      // Strict 'none' here (vs 'self' in transitional) — clickjacking defense
      // tightens once observed-clean.
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      // #917 slice 2b — point violation reports at the slice 2a ingestion
      // endpoint (backend/routes/csp.js → POST /api/csp/report). Browsers
      // deliver violation reports here as application/csp-report or
      // application/reports+json; the route persists each as an AuditLog
      // row with entity='CSPViolation'. `report-uri` is the legacy
      // (CSP2-era) directive — universally supported. The newer
      // `report-to` directive needs a Reporting-Endpoints HTTP header
      // companion, deferred until we wire that header in a future slice.
      reportUri: ["/api/csp/report"],
    },
  },
  // Disable all other headers — the transitional helmetMiddleware above
  // already sets them. Layering a second helmet should only contribute the
  // strict Report-Only CSP header, nothing else.
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  dnsPrefetchControl: false,
  frameguard: false,
  hidePoweredBy: false,
  hsts: false,
  ieNoOpen: false,
  noSniff: false,
  originAgentCluster: false,
  permittedCrossDomainPolicies: false,
  referrerPolicy: false,
  xssFilter: false,
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

// #921 slice S4 (FR-3.6) — per-route iframe-embed override.
//
// The global default (helmetMiddleware above) ships X-Frame-Options: DENY
// + CSP frame-ancestors 'none' — every route refuses to be iframed by
// anything, including itself. The embed lead-capture widget at
// `/embed/lead-form.html` is the ONE legitimate cross-origin iframe case;
// partner sites (callified.ai, partner CRMs) embed the widget INTO an
// iframe on THEIR origin pointing at OUR URL. For that to work we need
// to permit being framed by those partner origins.
//
// Two override paths, factory-returning a middleware:
//
//   allowIframeEmbedding({ allowList: ['https://partner.com'] })
//       — explicit list of origins allowed to frame. X-Frame-Options has
//         no list-form (only DENY/SAMEORIGIN/ALLOW-FROM-uri, and
//         ALLOW-FROM is deprecated + not honored by Chromium since 76),
//         so we DROP the X-Frame-Options header (the modern browser uses
//         CSP frame-ancestors anyway) and set CSP frame-ancestors to the
//         provided allowList.
//
//   allowIframeEmbedding({ allowList: ['*'] })
//       — wildcard "anyone can frame", used for the public embed widget
//         where partner origins aren't known upfront. Drops X-Frame-Options
//         and sets `frame-ancestors *`. Use carefully — only on routes
//         that are intentionally publicly embeddable.
//
// Follow-up gap (NOT in this slice — flagged for separate cron tracker
// row): Tenant.embedAllowlistJson column doesn't exist yet. Once added,
// the embed handler can call allowIframeEmbedding({
//   allowList: tenant.embedAllowlistJson || ['*']
// }) for per-tenant control. For now we ship the override mechanism +
// the per-tenant read returns null + falls back to wildcard.
function allowIframeEmbedding({ allowList } = {}) {
  return function iframeEmbedOverride(req, res, next) {
    // Drop the global DENY — its presence overrides any frame-ancestors
    // value in older browsers.
    if (typeof res.removeHeader === 'function') {
      res.removeHeader('X-Frame-Options');
    }
    // Build the frame-ancestors source list. Wildcard '*' is preserved
    // verbatim; explicit origins are joined space-separated per CSP spec.
    const list = Array.isArray(allowList) && allowList.length ? allowList : ['*'];
    const ancestorList = list.join(' ');

    // Splice frame-ancestors into the existing CSP header without
    // discarding the other directives (script-src, style-src, etc.
    // that the SPA bootstrap still needs). Helmet has already set the
    // Content-Security-Policy header by the time this runs.
    const currentCsp = (typeof res.getHeader === 'function' && res.getHeader('Content-Security-Policy')) || '';
    if (currentCsp) {
      const updated = String(currentCsp).replace(
        /frame-ancestors[^;]*/i,
        `frame-ancestors ${ancestorList}`
      );
      // If the directive wasn't present (shouldn't happen with current
      // helmetMiddleware config, but be defensive), append it.
      const finalCsp = updated === String(currentCsp)
        ? `${updated}; frame-ancestors ${ancestorList}`
        : updated;
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Security-Policy', finalCsp);
      }
    } else if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestorList}`);
    }
    next();
  };
}

// #921 slice S4 (FR-3.6) — convenience: read per-tenant allowlist from the
// Tenant.embedAllowlistJson column. Returns an array of allowed-origin strings
// when the column is populated with a valid JSON array; null otherwise (no
// per-tenant override → caller falls back to wildcard or route-level allowList).
//
// Slice S39 (2026-06-10) wired this to the real Prisma read after the column
// landed; pre-S39 this stub returned null unconditionally. The signature
// `(prisma, tenantId)` is preserved so existing callers don't need updates —
// the dependency-injected `prisma` keeps the function unit-testable without
// monkey-patching the module-level `prisma` import.
async function readTenantEmbedAllowlist(prisma, tenantId) {
  try {
    if (!prisma || !tenantId) return null;
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { embedAllowlistJson: true },
    });
    if (!tenant || !tenant.embedAllowlistJson) return null;
    const parsed = JSON.parse(tenant.embedAllowlistJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn('[readTenantEmbedAllowlist] failed:', err.message);
    return null;
  }
}

module.exports = {
  // #917 slice S1 — re-exported here for convenience; the canonical home is
  // backend/lib/cspNonce.js. Mount this BEFORE helmetStrictReportOnlyMiddleware
  // so res.locals.cspNonce is populated when the CSP function-directives run.
  attachNonce,
  helmetMiddleware,
  helmetStrictReportOnlyMiddleware,
  permissionsPolicyMiddleware,
  sanitizeBody,
  stripTenantOverride,
  // #921 slice S4 (FR-3.6)
  allowIframeEmbedding,
  readTenantEmbedAllowlist,
};
