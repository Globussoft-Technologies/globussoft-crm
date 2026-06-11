const path = require("path");
// Load env. Historical convention pointed at the repo root, but in practice
// the keys (GEMINI_API_KEY, OPENAI_API_KEY, Mailgun, etc.) live in
// backend/.env. Load root first (no-op if absent), then backend/.env with
// override so backend/.env wins on duplicates. Either file can be empty;
// system env still wins over both if exported in the shell.
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: false });
require("dotenv").config({ path: path.resolve(__dirname, ".env"), override: true });
// One-line startup probe so an operator can confirm AI keys actually
// loaded without grepping logs for fail-soft messages later.
console.log(
  `[env] AI keys: GEMINI=${process.env.GEMINI_API_KEY ? "set" : "MISSING"} ` +
  `OPENAI=${process.env.OPENAI_API_KEY ? "set" : "MISSING"}`,
);

// Fail fast in production if JWT secrets are missing — refuses to boot rather than
// silently fall back to the dev secret baked into the source.
if (process.env.NODE_ENV === "production") {
  if (!process.env.JWT_SECRET) {
    throw new Error("FATAL: JWT_SECRET must be set in production. Refusing to start with the dev fallback secret.");
  }
  if (!process.env.PORTAL_JWT_SECRET) {
    console.warn("[startup] PORTAL_JWT_SECRET not set — patient portal tokens will reuse JWT_SECRET. Set a separate value for defense in depth.");
  }
}

// #447-follow-up + 940b4f0-wave learning: surface the canonical app version
// in /api/health + the / root response. Reading from package.json means the
// version field tracks bumps automatically — no more hardcoded literals
// drifting from reality (the previous "3.2.0" string sat in source for 5+
// release tags, misleading the deploy-divergence diagnosis in the
// triaging-stuck-deploy-gate skill). Required at top so the read happens
// once at boot, not per request.
const APP_VERSION = require("./package.json").version;

const { initSentry } = require("./lib/sentry");

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const _cron = require("node-cron");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const rateLimit = require("express-rate-limit");

// ── Issue #423 — validate numeric `:id` path params BEFORE any route file
// is loaded ─────────────────────────────────────────────────────────────
// Handlers like `/deals/:id`, `/tasks/:id`, `/tickets/:id` did
// `parseInt(req.params.id)` without isNaN check, then handed NaN to Prisma
// which threw and surfaced as a 500. The fix is one param callback that
// fires on every `:id`-bearing route. See middleware/validateNumericId.js
// for the audit (every `:id` in the codebase is numeric) and the
// 400-vs-404 trade-off.
//
// IMPORTANT: `app.param('id', fn)` does NOT propagate to mounted sub-routers
// (Express docs: "Param callback functions are local to the router on which
// they are defined. They are not inherited by mounted apps or routers.").
// Each `routes/*.js` exports its own `express.Router()`, so we monkey-patch
// the Router factory to auto-register the validator on every Router that
// gets constructed. The patch MUST run before any `require("./routes/...")`
// below — that's why this block sits up here, not down by the route mounts.
const { validateNumericId } = require("./middleware/validateNumericId");
{
  const _RouterFactory = express.Router;
  // express.Router is a callable factory (not a class). Wrap it to attach
  // the param callback to every Router we construct from now on.
  express.Router = function patchedRouter(...args) {
    const r = _RouterFactory.apply(this, args);
    try { r.param("id", validateNumericId); } catch (_) { /* defensive */ }
    return r;
  };
  // Preserve any static props the factory carries so `express.Router.someProp`
  // (rare) keeps working.
  Object.assign(express.Router, _RouterFactory);
}

const { verifyToken } = require("./middleware/auth");
const checkSubscription = require("./middleware/checkSubscription");

const app = express();
app.set('trust proxy', 1); // trust first proxy (Nginx)
const server = http.createServer(app);

// ── Express 4 Async Error Patch ─────────────────────────────────────
// Express 4 does not catch rejected promises in async route handlers.
// This patch wraps every route handler so that `throw` or a rejected
// promise inside an async handler is forwarded to `next(err)` and
// reaches the global error handler at the bottom of this file.
// Covers app.* methods and Router.prototype.* methods so sub-routers
// (routes/*.js) are protected too.
function patchAsyncErrorHandling(target, methods) {
  for (const method of methods) {
    const original = target[method];
    // Preserve `this` — Express's verb methods operate on the calling
    // router/app instance (this.stack etc.). Binding to `target` (the shared
    // prototype) would point them at the wrong object, so forward with .call.
    target[method] = function (path, ...handlers) {
      const wrapped = handlers.map((handler) => {
        if (typeof handler !== "function") return handler;
        return function (req, res, next) {
          const result = handler(req, res, next);
          if (result && typeof result.catch === "function") {
            result.catch(next);
          }
        };
      });
      return original.call(this, path, ...wrapped);
    };
  }
}
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
patchAsyncErrorHandling(app, HTTP_METHODS);
// In Express 4 the verb methods live on the `express.Router` function object
// itself (router instances inherit from it via setPrototypeOf), NOT on
// `express.Router.prototype` — patch the former so sub-routers are covered.
patchAsyncErrorHandling(express.Router, HTTP_METHODS);

// Initialize Sentry early for full request capture (no-op if SENTRY_DSN not set)
initSentry(app);

// CORS — restrict to known origins
//
// The four hardcoded entries below are intentional fail-safes:
//   - crm.globusdemos.com         → demo (always-on, never moves)
//   - localhost:5173 / localhost:5000 → local dev (Vite + same-origin SSR)
//   - globuscrm.globussoft.com    → production (added in PR #511; canonical
//                                   prod hostname for the customer-facing
//                                   deployment)
// These exist as literals so a misconfigured deploy (missing env-var,
// typo in CORS_ALLOWED_ORIGINS) can never lock the demo or production
// out of CORS — which would brick the Inbox count poll, websocket
// upgrade, and every fetch from the frontend. Additional origins are
// env-driven via FRONTEND_URL (single) and CORS_ALLOWED_ORIGINS (CSV).
const ALLOWED_ORIGINS = [
  "https://crm.globusdemos.com",
  "http://localhost:5173",
  "http://localhost:5000",
  // #657 — keep 127.0.0.1 and localhost in lockstep. Some test runners
  // (Playwright, supertest) resolve BASE_URL through 127.0.0.1 even when
  // the caller typed `localhost`; without these entries the CORS layer
  // 500s on legitimate per-push gate runs and the originCheck layer
  // never gets to run.
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5000",
  "https://globuscrm.globussoft.com",
  // Dr. Haror's external marketing site — consumes the public wellness
  // catalog + payment endpoints (POST /api/wellness/public/payment/order +
  // /confirm). Hardcoded because it's part of the product surface, not a
  // one-off env override.
  "https://enhancewellness.globusdemos.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
  ...(process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Postman)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // #657 — for unknown origins, do NOT error-out (which sends a 500
    // and breaks the originCheck layer below). Just decline to set the
    // Access-Control-Allow-Origin response header — the browser will
    // refuse to read the response, AND the state-changing POSTs are
    // rejected with a proper 403 by originCheck (next middleware).
    callback(null, false);
  },
  credentials: true,
}));
// ─── WhatsApp webhook (P1 — must mount BEFORE express.json) ──────────────
// Meta signs the raw request body with HMAC-SHA-256 using META_APP_SECRET.
// Any JSON re-serialization would change the byte stream and break the
// signature check. We therefore mount the webhook router here — earlier
// than the global JSON body parser — with its own express.raw() so the
// middleware in middleware/metaWebhook.js sees a Buffer.
//
// The router responds 200 immediately and processes events asynchronously
// via setImmediate; downstream middlewares (express.json, helmet, auth
// guard, etc.) never run for these requests because the response is
// already flushed.
//
// Existing GET/POST /webhook stubs inside routes/whatsapp.js are tombstones
// that log + 503 if they ever fire — that would indicate this mount-order
// is wrong.
// Attach `req.io` BEFORE the webhook mount so the webhook handler can
// emit Socket.IO events to connected operators (real-time inbox push).
// Pre-fix: the matching middleware lower down (~line 322) ran AFTER
// the webhook router → `req.io` was undefined inside handleMessagesEvent
// → emit silently no-op'd → frontend never received the
// `whatsapp:received` event → users had to refresh manually.
app.use((req, _res, next) => { req.io = io; next(); });

app.use("/api/whatsapp/webhook", require("./routes/whatsapp_webhook"));

app.use(express.json({ limit: "10mb" }));
// Twilio voice/telephony/SMS webhooks and Mailgun/Razorpay form posts send
// `application/x-www-form-urlencoded`. Without this parser req.body is empty
// and every webhook 400s on a missing-field check. Found by the e2e smoke
// suite — every voice/telephony webhook test failed for the same reason.
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Security middleware
const cookieParser = require('cookie-parser');
const { attachNonce, helmetMiddleware, helmetStrictReportOnlyMiddleware, permissionsPolicyMiddleware, sanitizeBody, stripTenantOverride, allowIframeEmbedding } = require('./middleware/security');
const { originCheck } = require('./middleware/originCheck');
// #917 slice S35 (FR-3.X) — CSP-nonce static-file middleware. Substitutes
// `__CSP_NONCE__` placeholders in frontend/index.html with the per-request
// nonce minted by attachNonce so the strict Report-Only CSP header's
// `'nonce-<base64>'` source-list value matches what the browser sees on the
// served inline `<script>` / `<style>` / `<meta name="csp-nonce">` tags.
const cspNonceStaticMiddleware = require('./middleware/cspNonceStaticMiddleware');
// #917 slice S1 (FR-3.2) — mint a per-request CSP nonce BEFORE the strict
// Report-Only CSP middleware runs. The CSP function-directives read
// res.locals.cspNonce to advertise `'nonce-<base64>'` on script-src/style-src.
app.use(attachNonce);
app.use(helmetMiddleware);
// #917 slice 1 — additive strict CSP in Report-Only mode (no 'unsafe-inline'
// on script-src/style-src). Browsers log violations to devtools without
// blocking. Promotion to enforce-mode is a future slice once inline-script /
// inline-style surface is migrated to external bundles + nonces.
app.use(helmetStrictReportOnlyMiddleware);
// #917 slice S119 (FR-3.X) — cspNonceStaticMiddleware mount MOVED to AFTER
// the swagger-ui mount further down. S115 placed it here, but the
// middleware's fall-through rules (GET + non-`/api/` prefix + no dot)
// MATCH `/api-docs` and `/api-docs/` — so the SPA index.html was being
// served instead of Swagger UI's HTML, reding the e2e api-docs spec and
// the per-push api_tests gate. See the new mount immediately after
// `app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(...))` below.
app.use(permissionsPolicyMiddleware); // #186 — Permissions-Policy header
app.use(cookieParser());
// #657 — CSRF defense layer for browser flows. Mounted EARLY (before
// rate-limiting + auth) so a forged-origin POST short-circuits to 403
// without burning rate-limit budget or hitting verifyToken's DB lookup.
// Webhook + external-API paths bypass internally; non-browser callers
// (no Origin/Referer headers) pass through.
app.use(originCheck);
app.use(sanitizeBody);
app.use(stripTenantOverride);

// Rate limiting
//
// Local dev / CI gate: NODE_ENV=test bumps the ceiling enormously so the
// full Playwright API gate (~1450 tests, retries, helper auth flows) doesn't
// exhaust the 5000 req/15min budget. Production stays at 5000.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "test" ? 100000 : 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});
// Login brute-force defense (#191):
// Two stacked limiters on POST /api/auth/login. Successful logins (2xx) do
// NOT count toward the limit, so a legitimate user who fat-fingers and then
// succeeds doesn't burn budget. The per-username limiter keys on the lowercased
// email so an attacker can't escape it by rotating IPs.
// IMPORTANT: only applied to /api/auth/login itself — /api/auth/2fa/verify
// is a separate endpoint with its own threat model.
const { ipKeyGenerator } = require("express-rate-limit");
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5, // 5 wrong-password attempts per IP per 15 min
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { error: "Too many login attempts from this IP, please try again later." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});
const loginUsernameLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  // 10/hr was too tight for the 8-shard e2e-full release-validation run —
  // ~120+ spec files each do beforeAll login against admin@globussoft.com,
  // and under contention some return 5xx (counted as failures since
  // skipSuccessfulRequests only skips 2xx). The 10-budget got burned in
  // a single run, locking subsequent runs out until the 1-hour window
  // cleared. 200/hr still catches real credential-stuffing (an attacker
  // tries thousands/hr) but accommodates the legitimate CI burst.
  max: 200, // failed attempts per email per hour, regardless of IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req, res) => {
    const email = (req.body?.email || "").toLowerCase().trim();
    // If no email in body (malformed request), fall back to IP so we don't
    // collapse all anonymous traffic onto a single shared bucket.
    return email || `noemail:${ipKeyGenerator(req, res)}`;
  },
  message: { error: "Too many login attempts for this account, please try again later." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});
// Order matters: per-IP first (cheap, blocks scrapers), per-username second
// (catches distributed attacks against one account). Both must pass before
// the route handler runs. Scoped to POST so OPTIONS preflight isn't counted.
app.post("/api/auth/login", loginIpLimiter, loginUsernameLimiter, (req, res, next) => next());

// #531 (HI-02 mitigation): per-IP and per-email rate limiting on
// /api/auth/forgot-password. Mirrors the login limiter pattern. Without
// these, an attacker can hammer the endpoint to enumerate valid emails
// (HI-02) or to rate-limit-grief other users (DoS the password-reset
// flow). Quotas are looser than login because the forgot-password flow
// has higher legitimate-use churn (typo-prone email entry), but tight
// enough that a 1000-email enumeration attack hits the wall fast.
//
// Note we do NOT use skipSuccessfulRequests here — every successful call
// counts toward the budget regardless. /forgot-password's success branch
// already returns identical-shape response for known and unknown emails
// (per #526), so distinguishing "valid email" vs "noop" via skip count
// would itself be a new oracle.
const forgotPasswordIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === "test" ? 10000 : 20, // 20 requests/hour/IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { error: "Too many password-reset requests from this IP, please try again later." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});
const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === "test" ? 10000 : 5, // 5 requests/hour/email
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const email = (req.body?.email || "").toLowerCase().trim();
    return email || `noemail:${ipKeyGenerator(req, res)}`;
  },
  message: { error: "Too many password-reset requests for this email, please try again later." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});
app.post("/api/auth/forgot-password", forgotPasswordIpLimiter, forgotPasswordEmailLimiter, (req, res, next) => next());

app.use("/api", apiLimiter);

// #545 (MED-04): reject unsupported Content-Type with 415 BEFORE the routes
// run. Without this, a POST with text/plain (or any non-JSON/-form/-multipart
// body) lands in the route with `req.body = {}` (because neither
// express.json nor express.urlencoded matched), then routes typically
// destructure missing fields and 500. Pen-test flagged the 500 as the
// wrong contract — should be 415 (Unsupported Media Type).
//
// Conservative matching:
//   - Only POST / PUT / PATCH (DELETE/GET don't carry bodies in our routes)
//   - Only when Content-Length > 0 (some POSTs are bodyless)
//   - Only when Content-Type is EXPLICITLY set to a non-supported value.
//     Missing Content-Type passes through (back-compat with curl + some
//     SDKs that omit the header on JSON bodies).
//   - Excludes /api/marketing/submit (public form submit, intentionally
//     accepts text/* per the embed widget contract). Add new exclusions
//     here as needed.
const SUPPORTED_CONTENT_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
];
// Wave 7A CSV import endpoints accept text/csv content type; let them
// bypass the JSON-only guard. The route's own readUploadedCsv() helper
// handles multipart-vs-raw-text intake.
const CONTENT_TYPE_GUARD_EXCLUDE_PREFIXES = [
  "/api/marketing/submit",
  "/api/csv/",
  // v3.9.1+ — travel CSV import endpoints accept text/csv same as /api/csv/.
  // Without these the global 415 guard fires BEFORE verifyToken, so the
  // gate spec's "401 without token" case sees 415 and fails — see commit
  // 2840d46 (first push of travel_csv_io.js) and 769c484 (extending to
  // seasons + markup-rules). Every new travel /<resource>/import.csv
  // endpoint must be added here.
  "/api/travel/cost-master/import.csv",
  "/api/travel/diagnostic-banks/import.csv",
  "/api/travel/seasons/import.csv",
  "/api/travel/markup-rules/import.csv",
  // #917 slice 2 — CSP violation reports use application/csp-report or
  // application/reports+json, neither of which is in SUPPORTED_CONTENT_TYPES.
  // The route's own express.json() parser handles them.
  "/api/csp/report",
  // #921 / FR-3.7 (S5) — new SecurityIncident-backed CSP report sink.
  // Same content-type handling rationale as /api/csp/report above.
  "/api/security/csp-report",
];
app.use("/api", (req, res, next) => {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
  const lenHeader = req.headers["content-length"];
  if (!lenHeader || lenHeader === "0") return next();
  const ct = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!ct) return next(); // missing → back-compat pass-through
  if (SUPPORTED_CONTENT_TYPES.includes(ct)) return next();
  if (CONTENT_TYPE_GUARD_EXCLUDE_PREFIXES.some((p) => req.originalUrl.startsWith(p))) return next();
  return res.status(415).json({
    error: "Unsupported Media Type",
    code: "UNSUPPORTED_MEDIA_TYPE",
    received: ct,
    expected: SUPPORTED_CONTENT_TYPES,
  });
});

const io = new Server(server, { cors: { origin: "*" } });
const presenceColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

// Set global io reference for eventBus notifications
const { setIO } = require('./lib/eventBus');
setIO(io);

// req.io is now attached at the top of the middleware chain (above the
// webhook mount) so the WhatsApp webhook handler can use it. No need
// to re-attach here — left as a comment marker only.

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  socket.on('join_presence', (data) => {
    socket.userData = { id: socket.id, name: data.name, color: presenceColors[Math.floor(Math.random() * presenceColors.length)] };
  });

  socket.on('mouse_move', (data) => {
    if (!socket.userData) return;
    socket.broadcast.emit('cursor_update', {
      id: socket.id, rx: data.rx, ry: data.ry,
      name: socket.userData.name, color: socket.userData.color
    });
  });

  socket.on("join_room", (room) => {
    socket.join(room);
  });

  socket.on("disconnect", () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
    io.emit('user_left', socket.id);
  });
});

// Import Enterprise Routes
const authRoutes = require("./routes/auth");
const rolesRoutes = require("./routes/roles");
const widgetsRoutes = require("./routes/widgets");
const pagesRoutes = require("./routes/pages");
// /api/users — per-target user endpoints (currently just :userId/permissions).
// Sister surface to /api/auth/me/* but addresses ANY user, with same-tenant +
// roles.read guards inside the handler.
const usersRoutes = require("./routes/users");
const contactsRoutes = require("./routes/contacts");
const dealsRoutes = require("./routes/deals");
const calendarRoutes = require("./routes/calendar");
const aiScoringRoutes = require("./routes/ai_scoring");
const workflowsRoutes = require("./routes/workflows");
const communicationsRoutes = require("./routes/communications");
const dealsDocumentsRoutes = require("./routes/deals_documents");
const marketingRoutes = require("./routes/marketing");
const reportsRoutes = require("./routes/reports");
const developerRoutes = require("./routes/developer");
const settingsRoutes = require("./routes/settings");
const billingRoutes = require("./routes/billing");
const v1InvoicesRoutes = require("./routes/v1_invoices");
const searchRoutes = require("./routes/search");
const aiRoutes = require("./routes/ai");
const ticketsRoutes = require("./routes/tickets");
const integrationsRoutes = require("./routes/integrations");
const customObjectsRoutes = require("./routes/custom_objects");
const sequencesRoutes = require("./routes/sequences");
const cpqRoutes = require("./routes/cpq");
const tasksRoutes = require("./routes/tasks");
const staffRoutes = require("./routes/staff");
const expensesRoutes = require("./routes/expenses");
const contractsRoutes = require("./routes/contracts");
const estimatesRoutes = require("./routes/estimates");
const projectsRoutes = require("./routes/projects");
const supportRoutes = require("./routes/support");
const reportSchedulesRoutes = require("./routes/report_schedules");
const pipelineStagesRoutes = require("./routes/pipeline_stages");
const notificationsRoutes = require("./routes/notifications");
const subscriptionsRoutes = require("./routes/subscriptions");
const emailTemplatesRoutes = require("./routes/email_templates");
const emailRoutes = require("./routes/email");
const auditRoutes = require("./routes/audit");
const marketplaceLeadsRoutes = require("./routes/marketplace_leads");
const smsRoutes = require("./routes/sms");
const whatsappRoutes = require("./routes/whatsapp");
const telephonyRoutes = require("./routes/telephony");
const pushRoutes = require("./routes/push");
const { router: landingPagesRoutes, publicRouter: landingPagesPublic } = require("./routes/landing_pages");
const tenantsRoutes = require("./routes/tenants");
const tenantSettingsRoutes = require("./routes/tenant_settings");
// #870 — per-user preference surface (theme persistence for cross-device roaming).
const userPreferencesRoutes = require("./routes/user_preferences");
const auth2faRoutes = require("./routes/auth_2fa");
// #654 — step-up auth for destructive admin flows (5-min stepUpToken bound
// to (userId, tenantId)). See backend/routes/auth_stepup.js + the
// requireStepUp() middleware factory in middleware/auth.js.
const authStepupRoutes = require("./routes/auth_stepup");
const ssoRoutes = require("./routes/sso");
const calendarGoogleRoutes = require("./routes/calendar_google");
const calendarOutlookRoutes = require("./routes/calendar_outlook");
const calendarEventsRoutes = require("./routes/calendar_events");
const voiceRoutes = require("./routes/voice");
const emailInboundRoutes = require("./routes/email_inbound");
const gdprRoutes = require("./routes/gdpr");
const auditViewerRoutes = require("./routes/audit_viewer");
// Tier 1
const pipelinesRoutes = require("./routes/pipelines");
const forecastingRoutes = require("./routes/forecasting");
const dashboardsRoutes = require("./routes/dashboards");
const customReportsRoutes = require("./routes/custom_reports");
const bookingPagesRoutes = require("./routes/booking_pages");
const signaturesRoutes = require("./routes/signatures");
const knowledgeBaseRoutes = require("./routes/knowledge_base");
const portalRoutes = require("./routes/portal");
const currenciesRoutes = require("./routes/currencies");
const fieldPermissionsRoutes = require("./routes/field_permissions");
const emailSchedulingRoutes = require("./routes/email_scheduling");
// Tier 2
const leadRoutingRoutes = require("./routes/lead_routing");
const territoriesRoutes = require("./routes/territories");
const quotasRoutes = require("./routes/quotas");
const winLossRoutes = require("./routes/win_loss");
const attributionRoutes = require("./routes/attribution");
const abTestsRoutes = require("./routes/ab_tests");
const webVisitorsRoutes = require("./routes/web_visitors");
const chatbotsRoutes = require("./routes/chatbots");
const approvalsRoutes = require("./routes/approvals");
const documentTemplatesRoutes = require("./routes/document_templates");
const surveysRoutes = require("./routes/surveys");
const paymentsRoutes = require("./routes/payments");
const paymentGatewaysRoutes = require("./routes/payment_gateways");
const accountingRoutes = require("./routes/accounting");
const dealInsightsRoutes = require("./routes/deal_insights");
const dataEnrichmentRoutes = require("./routes/data_enrichment");
const slaRoutes = require("./routes/sla");
const leadSlaRoutes = require("./routes/lead_sla");
const cannedResponsesRoutes = require("./routes/canned_responses");
// #917 slice 2 — CSP violation-report ingestion (public, no-auth, browser-emitted)
const cspRoutes = require("./routes/csp");
// Tier 3
const scimRoutes = require("./routes/scim");
const sharedInboxRoutes = require("./routes/shared_inbox");
const sentimentRoutes = require("./routes/sentiment");
// Wave 4
const liveChatRoutes = require("./routes/live_chat");
const playbooksRoutes = require("./routes/playbooks");
const documentViewsRoutes = require("./routes/document_views");
const industryTemplatesRoutes = require("./routes/industry_templates");
const socialRoutes = require("./routes/social");
const sandboxRoutes = require("./routes/sandbox");
const funnelRoutes = require("./routes/funnel");
const zapierRoutes = require("./routes/zapier");
const voiceTranscriptionRoutes = require("./routes/voice_transcription");
const emailThreadingRoutes = require("./routes/email_threading");
// Travel CRM vertical (Day 1 scaffolding — Phase 1 per docs/TRAVEL_CRM_PRD.md).
// Hosts TMC (school trips), RFU (Umrah), Travel Stall, Visa Sure sub-brands.
const travelRoutes = require("./routes/travel");
const travelDiagnosticsRoutes = require("./routes/travel_diagnostics");
const travelVisaAnalyticsRoutes = require("./routes/travel_visa_analytics");
const travelVisaRoutes = require("./routes/travel_visa");
const travelItinerariesRoutes = require("./routes/travel_itineraries");
const travelTripsRoutes = require("./routes/travel_trips");
const travelCostMasterRoutes = require("./routes/travel_cost_master");
const travelSuppliersRoutes = require("./routes/travel_suppliers");
const travelQuotesRoutes = require("./routes/travel_quotes");
const travelInvoicesRoutes = require("./routes/travel_invoices");
// Brand kits — multi-vertical (travel + generic + wellness). Mounted at
// /api/brand-kits, not /api/travel, because subBrand is optional.
const brandKitsRoutes = require("./routes/brand_kits");
// AdsGPT operator routes — thin wrapper around services/adsGptClient.js
// (stub today, real-mode post Q1 cred handover). Mounted at /api/adsgpt;
// not under /api/travel because the cap applies tenant-wide (any vertical).
const adsgptRoutes = require("./routes/adsgpt");
// RateHawk operator routes — thin wrapper around services/ratehawkClient.js
// (stub today, real-mode post Q19 cred handover). Mounted at /api/ratehawk;
// not under /api/travel because the cap applies tenant-wide (any vertical).
const ratehawkRoutes = require("./routes/ratehawk");
// Callified operator routes — thin wrapper around services/callifiedClient.js
// (stub today, real-mode post Q1 cred handover from Yasin). Mounted at
// /api/callified; AI calling cap + featureFlag gate live in the service.
const callifiedRoutes = require("./routes/callified");
// BookingExpedia operator routes — thin wrapper around services/bookingExpediaClient.js
// (stub today, real-mode post Q-cluster B6/C cred handover). Mounted at
// /api/booking-expedia; Booking.com is Phase 1, Expedia code paths throw
// 503 EXPEDIA_NOT_YET_ENABLED until DC-4 demand-threshold flips. FINAL
// wrapper in the cred-stub series (4/4 — adsgpt, ratehawk, callified, this).
const bookingExpediaRoutes = require("./routes/booking_expedia");
const travelMicrositesRoutes = require("./routes/travel_microsites");
const travelRfuProfilesRoutes = require("./routes/travel_rfu_profiles");
const travelReligiousPacketsRoutes = require("./routes/travel_religious_packets");
const travelPricingRoutes = require("./routes/travel_pricing");
const travelTripBillingRoutes = require("./routes/travel_trip_billing");
const travelWebcheckinRoutes = require("./routes/travel_webcheckin");
const travelCsvIoRoutes = require("./routes/travel_csv_io");
const travelDashboardRoutes = require("./routes/travel_dashboard");
const travelReportsRoutes = require("./routes/travel_reports");
const travelTravelStallRoutes = require("./routes/travel_travelstall");
// Visa Sure Phase 3 — EmbassyRule CRUD (PC-3 + PC-7 resolved 2026-05-24).
// Mounted at /api/embassy-rules (not under /api/travel) because authorship
// is tenant-wide ADMIN, not sub-brand-scoped. Backs the risk-flag engine.
const embassyRulesRoutes = require("./routes/embassy_rules");
// TMC (Travel) Phase 1 — TravelCurriculumMapping CRUD (PC-1 + PC-2/3/4/5
// resolved 2026-05-24). Mounted at /api/travel-curriculum (sibling of
// /api/embassy-rules) since authorship is tenant-wide ADMIN / advisor-head,
// not sub-brand-scoped. Backs the diagnostic-engine destination scoring.
const travelCurriculumRoutes = require("./routes/travel_curriculum");
const travelSchoolTermRoutes = require("./routes/travel_school_terms");
// TS18 Phase 2 SHELL — Travel Stall personalised destination recommender
// (LLM consumer). Mounted at /api/travel-personalised-destinations so the
// URL is sibling-flat with /api/embassy-rules / /api/travel-curriculum
// (operator-tools that aren't sub-brand-scoped path-wise). STUB MODE
// per Q11 cred-block until Travel Stall LLM keys land.
const travelPersonalisedDestinationsRoutes = require("./routes/travel_personalised_destinations");
// Tick #183 — Per-tenant per-sub-brand default theme map (#876 + DD-5.3
// RESOLVED 2026-05-24). Backs the future frontend resolution chain
// user.themePreference → tenant.subBrandThemes[activeSubBrand] → 'system'.
const subBrandThemesRoutes = require("./routes/sub_brand_themes");
// Wellness vertical (Enhanced Wellness, future clinic clients)
const wellnessRoutes = require("./routes/wellness");
// Wave 11 Agent HH — Inventory backbone (categories, vendors, receipts,
// adjustments, auto-consumption rules). Mounted under /api/wellness so URLs
// stay uniform; routes/inventory.js declares only paths that wellness.js does
// not own.
const inventoryRoutes = require("./routes/inventory");
// Wave 2 Agent II — POS / cash register / shift / sale backbone.
const posRoutes = require("./routes/pos");
// D16 Wallet Top-up Arc 1 slice 2-partial — read-only wallet endpoints
// (GET balance + GET transactions). PRD: docs/PRD_WALLET_TOPUP.md §3.
// Top-up/redeem/reverse/expiry routes land in subsequent slices once
// Agent A's WalletBonusRule + WalletCreditBatch schema lands.
const walletRoutes = require("./routes/wallet");
// Wave 2 Agent JJ — Staff Attendance + Biometric webhook + Leave Management.
const attendanceRoutes = require("./routes/attendance");
const leaveRoutes = require("./routes/leave");
// External partner API v1 (Callified.ai, Globus Phone, etc. — API key auth)
const externalRoutes = require("./routes/external");
// Flight Quotation plugin endpoint (#908) — API key auth via X-API-Key
const travelFlightQuotesRoutes = require("./routes/travel_flight_quotes");
// Voyagr (OJR) CMS lead-capture API v1 — API key auth via X-API-Key
// (mirror partner-API pattern). See docs/MANUAL_CODING_BACKLOG.md cluster F1.
// CORS: voyagr's server-to-server call (Next.js API route → CRM) has no
// Origin header so doesn't need CORS allowlist entry. If voyagr ever calls
// directly from the browser, the voyagr production domain(s) will need to
// be added to corsAllowlist below — left as a follow-up since prod domains
// are not finalised yet.
const voyagrRoutes = require("./routes/voyagr");
// Admin tooling — manual triggers + read APIs for ops actions (G-15 backup)
const adminRoutes = require("./routes/admin");
// Wave 7 Agent A — Service catalogue depth (PRD Gap §10):
//   service-categories: hierarchical taxonomy CRUD
//   drugs:              drug catalogue + typeahead
//   csv_io:             services / products / membership-plans import+export
//                       + bookings export-only
const serviceCategoriesRoutes = require("./routes/service_categories");
const drugsRoutes = require("./routes/drugs");
const csvIoRoutes = require("./routes/csv_io");
// Wave 3 — Staff availability blocks (breaks, leave, personal time)
const blockTimesRoutes = require("./routes/block-times");
// Issue #816 — per-entity CSV import/export with template + async modes for
// the wellness list pages (services, packages, products, customers, bookings).
const wellnessCsvRoutes = require("./routes/wellnessCsv");

// OpenAPI Swagger Bootloader
//
// #542: GET /api-docs/swagger.json must return the raw OpenAPI 3 spec as
// JSON so SDK generators (openapi-generator, swagger-codegen, Postman
// import) can consume it programmatically. swagger-ui-express's
// `setup()` mount only serves the *UI*, so without the explicit handler
// below `/api-docs/swagger.json` would fall through to the UI's
// catch-all and return text/html. The explicit handler MUST be
// registered BEFORE the `app.use('/api-docs', ...)` mount because
// Express matches handlers in declaration order.
//
// Both routes are public on purpose — docs discoverability is the
// whole point. The Nginx site config additionally proxies `/api-docs*`
// to the backend (commit applied via scripts/apply-api-docs-nginx.py
// closing #542).
const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
app.get('/api-docs/swagger.json', (req, res) => {
  res.json(swaggerDocument);
});
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Globussoft CRM Docs"
}));

// #917 slice S119 (FR-3.X) — wire S35's cspNonceStaticMiddleware. Mounted
// here (AFTER swagger-ui's `/api-docs` mount) because the middleware's
// fall-through rules (GET + non-`/api/` prefix + no dot) match `/api-docs`
// and `/api-docs/` — placing it BEFORE swagger-ui (S115's mount position)
// caused the SPA index.html to be served instead of Swagger UI's HTML,
// reding the e2e api-docs spec and the api_tests deploy gate.
//
// Positional constraints (all still satisfied at this site):
//   - AFTER `attachNonce`                    (line ~205 — populates res.locals.cspNonce)
//   - AFTER `helmetStrictReportOnlyMiddleware` (line ~211 — sets the CSP header)
//   - AFTER swagger-ui mount                 (line ~666 — swagger-ui wins /api-docs)
//   - BEFORE `app.get("/", ...)`             (line ~1110 — SPA shell fallback)
//   - BEFORE `/uploads` static mounts        (line ~1060 — static asset paths
//     contain dots and so fall through the middleware's own rules anyway)
//
// Express routes are first-match-wins on mount order — moving the mount to
// AFTER swagger-ui means `/api-docs` requests reach swagger-ui's handler
// before this middleware can intercept them.
app.use(cspNonceStaticMiddleware);

// Global auth guard — protects all /api/ routes EXCEPT auth login/signup and health
app.use("/api", (req, res, next) => {
  // /portal/set-password was previously in openPaths — that's a real
  // security hole: any anonymous caller could rewrite a contact's portal
  // password to a value of their choice. Per #537 + portal-api.spec.js:41
  // the route requires a staff (admin / manager) token — the staff user
  // promotes a contact to a portal user. Removing the entry routes the
  // unauthenticated case through the global guard's 401 (RFC 7235), and
  // the authenticated case continues unaffected.
  const openPaths = ["/auth/login", "/auth/signup", "/auth/register", "/auth/customer/register", "/auth/public/tenants", "/auth/forgot-password", "/auth/reset-password", "/auth/2fa/verify", "/health", "/marketplace-leads/webhook", "/sms/webhook", "/whatsapp/webhook", "/telephony/webhook", "/push/subscribe/visitor", "/push/vapid-key", "/communications/track/", "/sso/google/callback", "/sso/microsoft/callback", "/sso/google/start", "/sso/microsoft/start", "/email/inbound", "/calendar/google/callback", "/calendar/outlook/callback", "/voice/webhook", "/portal/login", "/portal/forgot", "/portal/reset", "/portal/me", "/portal/tickets", "/portal/invoices", "/portal/contracts", "/portal/travel", "/portal/kyc", "/signatures/sign", "/surveys/respond", "/surveys/public", "/chatbots/chat", "/web-visitors/track", "/payments/webhook", "/accounting/webhook", "/scim/v2", "/booking-pages/public", "/knowledge-base/public", "/live-chat/visitor", "/document-views/track", "/zapier/webhook", "/marketing/submit", "/v1/external", "/v1/voyagr", "/v1/flight-plugin", "/wellness/public", "/wellness/portal", "/attendance/biometric/webhook", "/travel/microsites/public", "/travel/diagnostics/public", "/travel/itineraries/public", "/travel/inbound/leads", "/v1/flyers/public", "/security/csp-report"];
  if (openPaths.some(p => req.path.startsWith(p))) return next();
  // Public marketing catalog — the /pricing page hits GET /subscriptions/plans
  // anonymously. Admin CRUD (POST/PUT/DELETE + GET /plans/admin) stays gated
  // by the route-level verifyToken+verifyRole middleware below.
  if (req.method === 'GET' && req.path === '/subscriptions/plans') return next();
  // The travel itinerary PDF is opened in a NEW TAB via a plain <a href>
  // (no fetch → no Authorization header), so the frontend passes the bearer
  // JWT as a ?_t= query param. Promote it to the Authorization header so
  // verifyToken can validate. SCOPED to exactly /travel/itineraries/:id/pdf —
  // this does NOT broaden token-in-URL acceptance for any other route, and
  // verifyToken still fully validates the token (no auth bypass).
  if (
    req.method === 'GET' &&
    !req.headers.authorization &&
    req.query && req.query._t &&
    /^\/travel\/itineraries\/\d+\/pdf$/.test(req.path)
  ) {
    req.headers.authorization = `Bearer ${req.query._t}`;
  }
  // TMC public readiness PDF — `/travel/diagnostics/:id/readiness-report.pdf`
  // is designed public per PRD §5.1 DD-5.2 (the school clicks the report-
  // download URL surfaced after public submit-tmc).  Can't be a prefix
  // entry in openPaths because the `:id` segment is dynamic; suffix match
  // on the route shape lets it through without auth.  Tightly scoped to
  // GET + the exact suffix so other /travel/diagnostics/:id sub-routes
  // stay auth-gated.
  if (req.method === 'GET' && /^\/travel\/diagnostics\/\d+\/readiness-report\.pdf$/.test(req.path)) return next();
  // Slice C9 — TravelQuote customer-share landing endpoints (PRD §3.7).
  // Public, JWT-gated by `:shareToken` segment (verified inside the route).
  // GET = read-only envelope; POST = accept|reject|counter customer actions.
  if (req.method === 'GET' && /^\/travel\/quotes\/public\/quote\/[^/]+$/.test(req.path)) return next();
  if (req.method === 'POST' && /^\/travel\/quotes\/public\/quote\/[^/]+\/(accept|reject|counter)$/.test(req.path)) return next();
  verifyToken(req, res, (err) => {
    if (err) return next(err);
    checkSubscription(req, res, next);
  });
});

// Strip dangerous fields (id, createdAt, updatedAt, tenantId, userId) from all request bodies
const { stripDangerous } = require('./middleware/validateInput');
app.use(stripDangerous);

// #426: scrub credential-shaped fields (currently: portalPasswordHash) from
// every API response payload — wraps res.json globally so direct queries AND
// nested `include: { contact: true }` are both covered. See middleware
// header for the full deny-list and extension protocol.
const { scrubResponse } = require('./middleware/scrubResponse');
app.use(scrubResponse);

// Apply the #423 numeric-id validator to the app itself too — covers any
// future `app.get('/foo/:id', …)` registered directly on the app rather
// than on a sub-router. The Router factory was already patched up top so
// every imported sub-router has the callback attached.
app.param("id", validateNumericId);

// Map API Endpoints
app.use("/api/auth", authRoutes);
app.use("/api/roles", rolesRoutes);
// SPEC §C3 — unified /api/me + /api/permissions endpoints. Both come
// from the same module so the SPEC-named endpoint surface is contiguous.
const { meRouter, permissionsRouter } = require("./routes/me");
app.use("/api/me", meRouter);
app.use("/api/permissions", permissionsRouter);
app.use("/api/widgets", widgetsRoutes);
app.use("/api/pages", pagesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/deals", dealsRoutes);
app.use("/api/calendar", calendarRoutes);
app.use("/api/ai_scoring", aiScoringRoutes);
app.use("/api/workflows", workflowsRoutes);
app.use("/api/communications", communicationsRoutes);
app.use("/api/deals_documents", dealsDocumentsRoutes);
app.use("/api/marketing", marketingRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/developer", developerRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/billing", billingRoutes);
// PRD Gap §2 items 7a-d — `/api/v1/invoices` stable public-API alias for the
// legacy /api/billing surface. Includes a NEW POST /:id/payments endpoint
// (item 7c) and a /complete alias for mark-paid (item 7d). Mounted alongside
// /api/billing so existing consumers stay green.
app.use("/api/v1/invoices", v1InvoicesRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/tickets", ticketsRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/custom_objects", customObjectsRoutes);
app.use("/api/sequences", sequencesRoutes);
app.use("/api/cpq", cpqRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/tasks", tasksRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/subscriptions", subscriptionsRoutes);
app.use("/api/contracts", contractsRoutes);
app.use("/api/estimates", estimatesRoutes);
app.use("/api/projects", projectsRoutes);
app.use("/api/report-schedules", reportSchedulesRoutes);
app.use("/api/pipeline_stages", pipelineStagesRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/email_templates", emailTemplatesRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/marketplace-leads", marketplaceLeadsRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/whatsapp", whatsappRoutes);
// P2: WhatsApp embedded-signup onboarding routes. Mounted as a separate
// router under /api/whatsapp/onboard so the rate-limiter + auth guard
// pipeline above applies, but the route handlers live in
// routes/whatsapp_onboard.js. Feature-flagged via WHATSAPP_EMBEDDED_SIGNUP_ENABLED.
app.use("/api/whatsapp/onboard", require("./routes/whatsapp_onboard"));
app.use("/api/telephony", telephonyRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/landing-pages", landingPagesRoutes);
app.use("/api/tenants", tenantsRoutes);
// /api/tenant-settings — operator-writable cap-override surface backing the
// per-tenant cap pattern (helper at backend/lib/tenantSettings.js). Mounted
// next to /api/tenants because the URL space + audience are sibling concerns.
app.use("/api/tenant-settings", tenantSettingsRoutes);
// #870 — GET/PUT /api/user/theme; per-user theme preference for cross-device roaming.
app.use("/api/user", userPreferencesRoutes);
app.use("/api/auth/2fa", auth2faRoutes);
// #654 — POST /api/auth/step-up — mints a 5-min stepUpToken for destructive
// admin flows. Mounted after /api/auth/2fa so the URL space stays tidy.
app.use("/api/auth/step-up", authStepupRoutes);
app.use("/api/sso", ssoRoutes);
app.use("/api/calendar/google", calendarGoogleRoutes);
app.use("/api/calendar/outlook", calendarOutlookRoutes);
app.use("/api/calendar/events", calendarEventsRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/email/inbound", emailInboundRoutes);
app.use("/api/gdpr", gdprRoutes);
app.use("/api/audit-viewer", auditViewerRoutes);
// Tier 1
app.use("/api/pipelines", pipelinesRoutes);
app.use("/api/forecasting", forecastingRoutes);
app.use("/api/dashboards", dashboardsRoutes);
app.use("/api/custom-reports", customReportsRoutes);
app.use("/api/booking-pages", bookingPagesRoutes);
app.use("/api/signatures", signaturesRoutes);
app.use("/api/knowledge-base", knowledgeBaseRoutes);
app.use("/api/portal", portalRoutes);
app.use("/api/currencies", currenciesRoutes);
app.use("/api/field-permissions", fieldPermissionsRoutes);
app.use("/api/email-scheduling", emailSchedulingRoutes);
// Tier 2
app.use("/api/lead-routing", leadRoutingRoutes);
app.use("/api/territories", territoriesRoutes);
app.use("/api/quotas", quotasRoutes);
app.use("/api/win-loss", winLossRoutes);
app.use("/api/attribution", attributionRoutes);
app.use("/api/ab-tests", abTestsRoutes);
app.use("/api/web-visitors", webVisitorsRoutes);
app.use("/api/chatbots", chatbotsRoutes);
app.use("/api/approvals", approvalsRoutes);
app.use("/api/document-templates", documentTemplatesRoutes);
app.use("/api/surveys", surveysRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/payment-gateways", paymentGatewaysRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api/deal-insights", dealInsightsRoutes);
app.use("/api/data-enrichment", dataEnrichmentRoutes);
app.use("/api/sla", slaRoutes);
app.use("/api/lead-sla", leadSlaRoutes);
app.use("/api/canned-responses", cannedResponsesRoutes);
// #917 slice 2 — public CSP violation-report endpoint. Exempt from auth via
// openPaths (above) and from the JSON-content-type guard via
// CONTENT_TYPE_GUARD_EXCLUDE_PREFIXES (browsers send application/csp-report).
app.use("/api/csp", cspRoutes);
// Tier 3
app.use("/api/scim", scimRoutes);
app.use("/api/shared-inbox", sharedInboxRoutes);
app.use("/api/sentiment", sentimentRoutes);
// Wave 4
app.use("/api/live-chat", liveChatRoutes);
app.use("/api/playbooks", playbooksRoutes);
app.use("/api/document-views", documentViewsRoutes);
app.use("/api/industry-templates", industryTemplatesRoutes);
app.use("/api/social", socialRoutes);
app.use("/api/sandbox", sandboxRoutes);
app.use("/api/funnel", funnelRoutes);
app.use("/api/zapier", zapierRoutes);
app.use("/api/voice-transcription", voiceTranscriptionRoutes);
app.use("/api/email-threading", emailThreadingRoutes);
// Travel vertical (Day 1-8: /health, diagnostics, itineraries, trips, cost-master)
app.use("/api/travel", travelRoutes);
// v3.9.1 — CSV I/O routes MUST mount BEFORE the CRUD routes below.
// `/cost-master/export.csv` would otherwise be caught by `/cost-master/:id`
// in travelCostMasterRoutes (with id="export.csv" → parseInt → NaN → 400
// INVALID_ID); same for `/diagnostic-banks/export.csv` vs
// `/diagnostic-banks/:id` in travelDiagnosticsRoutes. The CRUD routes
// use `:id` as a numeric route param so the more-specific export/import
// paths in travelCsvIoRoutes need precedence.
app.use("/api/travel", travelCsvIoRoutes);
// Dashboard mounts BEFORE the CRUD route files for the same reason as
// travelCsvIoRoutes — /dashboard would otherwise look like a `:id` capture
// in any travel route that uses `:id` at the path's first segment. (No
// current collision, but defensive ordering keeps it that way.)
app.use("/api/travel", travelDashboardRoutes);
app.use("/api/travel", travelReportsRoutes);
app.use("/api/travel", travelDiagnosticsRoutes);
app.use("/api/travel/visa/analytics", travelVisaAnalyticsRoutes);
app.use("/api/travel/visa", travelVisaRoutes);
app.use("/api/travel", travelItinerariesRoutes);
app.use("/api/travel", travelTripsRoutes);
// Slice C2 — passport OCR upload + verification queue (stub-mode pending PC-1).
app.use("/api/travel/passport", require("./routes/travel_passport"));
app.use("/api/travel", travelCostMasterRoutes);
app.use("/api/travel", travelSuppliersRoutes);
// Slice C9 — TravelQuote customer-share public landing (PRD §3.7).
// MUST be mounted BEFORE travelQuotesRoutes — the operator route has
// `:id` capture on `/quotes/:id` which would otherwise match `/quotes/public/...`
// at validateNumericId and 400 INVALID_ID before reaching the public router.
app.use("/api/travel/quotes/public", require("./routes/travel_quotes_public"));
app.use("/api/travel/quote-templates", require("./routes/travel_quote_templates"));
app.use("/api/travel/cancellation-policies", require("./routes/travel_cancellation_policies"));
app.use("/api/travel", travelQuotesRoutes);
app.use("/api/travel", travelInvoicesRoutes);
app.use("/api/travel", require("./routes/travel_flyer_templates"));
// S78 (Marketing Flyer #908) — mount the mixed-auth flyer share + public render
// router. POST /:id/share is auth-gated inside the router (verifyToken +
// verifyRole + requireTravelTenant); GET /public/:slug + /public/:slug/meta
// bypass auth via the '/v1/flyers/public' entry added to openPaths above.
// Same shape as travel_quotes_public mount (line 877).
app.use("/api/v1/flyers", require("./routes/travel_flyer_public"));
app.use("/api/travel", require("./routes/travel_commission_profiles"));
// WS-1 — sub-brand session scope (POST /session/switch-brand + GET
// /session/active-brand). Authoritative server-side validation behind the
// sidebar sub-brand switcher; reuses middleware/travelGuards.js plumbing.
app.use("/api/travel", require("./routes/travel_session"));
app.use("/api/brand-kits", brandKitsRoutes);
app.use("/api/adsgpt", adsgptRoutes);
app.use("/api/ratehawk", ratehawkRoutes);
app.use("/api/callified", callifiedRoutes);
app.use("/api/booking-expedia", bookingExpediaRoutes);
app.use("/api/travel", travelMicrositesRoutes);
app.use("/api/travel", travelRfuProfilesRoutes);
app.use("/api/travel", travelReligiousPacketsRoutes);
app.use("/api/travel", travelPricingRoutes);
app.use("/api/travel", travelTripBillingRoutes);
app.use("/api/travel", travelWebcheckinRoutes);
app.use("/api/travel", travelTravelStallRoutes);
app.use("/api/travel", require("./routes/travel_inbound_leads"));
app.use("/api/travel/itinerary-templates", require("./routes/travel_itinerary_templates"));
app.use("/api/travel/sightseeing", require("./routes/travel_sightseeing"));
app.use("/api/travel/pois", require("./routes/travel_pois"));
app.use("/api/embassy-rules", embassyRulesRoutes);
app.use("/api/travel-curriculum", travelCurriculumRoutes);
app.use("/api/travel-school-terms", travelSchoolTermRoutes);
app.use("/api/travel-personalised-destinations", travelPersonalisedDestinationsRoutes);
app.use("/api/travel-tmc-catalogue", require("./routes/travel_tmc_catalogue"));
app.use("/api/travel/engine-weights", require("./routes/travel_engine_weights"));
app.use("/api/tenant/sub-brand-themes", subBrandThemesRoutes);
// Wellness vertical
app.use("/api/wellness", wellnessRoutes);
// Wave 11 Agent HH — Inventory backbone. Mounted on /api/wellness so paths
// like /api/wellness/inventory/receipts work; declares only paths wellness.js
// does NOT own (product-categories, vendors, inventory/receipts,
// inventory/adjustments, inventory/movements, auto-consumption-rules).
app.use("/api/wellness", inventoryRoutes);
// Wave 3 — Staff availability blocks (breaks, leave, personal time). Wellness-gated.
app.use("/api/wellness/block-times", blockTimesRoutes);
// Wave 7 Agent A — Service catalogue depth + Drug catalogue + CSV io.
app.use("/api/wellness/service-categories", serviceCategoriesRoutes);
app.use("/api/wellness/drugs", drugsRoutes);
app.use("/api/csv", csvIoRoutes);
// Issue #816 — /api/wellness/csv/:entity/{template|export|import|import/async|jobs}.
app.use("/api/wellness/csv", wellnessCsvRoutes);
// Wave 2 Agent II — POS / cash register / shift / sale backbone. Mounted at
// /api/pos. Wellness-vertical-gated; generic tenants get a clean 403.
app.use("/api/pos", posRoutes);
// D16 Wallet Top-up Arc 1 slice 2-partial — GET /api/wallet/:patientId/balance
// + GET /api/wallet/:patientId/transactions. phiReadGate-protected.
// Slice 5b — admin bonus-rule CRUD at /api/wallet/rules. MUST mount BEFORE
// the `/api/wallet` line below so the `:patientId` segment doesn't catch
// '/rules' first.
// D16 polish — POST /api/wallet/admin/run-expiry admin manual trigger for
// walletExpiryEngine (mirror of /api/forecasting/snapshot/run pattern).
// MUST mount BEFORE `/api/wallet/rules` AND `/api/wallet` for the same
// `:patientId`-segment-shadowing reason.
app.use("/api/wallet/admin", require("./routes/wallet_admin"));
app.use("/api/wallet/rules", require("./routes/wallet_rules"));
app.use("/api/wallet", walletRoutes);
// Wave 2 Agent JJ — Staff Attendance + Biometric webhook + Leave Management.
// Cross-vertical (wellness AND generic). Mounted top-level. The biometric
// webhook (POST /api/attendance/biometric/webhook) is in openPaths and
// authenticates via X-API-Key against BiometricDevice.apiKey.
app.use("/api/attendance", attendanceRoutes);
app.use("/api/leave", leaveRoutes);
// External partner API (API key auth, versioned)
app.use("/api/v1/external", externalRoutes);
// Voyagr (OJR) CMS lead-capture API (API key auth — bypasses global
// verifyToken via /v1/voyagr entry in openPaths above; uses its own
// X-API-Key middleware).
app.use("/api/v1/voyagr", voyagrRoutes);
// Flight Quotation plugin endpoint (#908 FR-5) — X-API-Key auth (externalAuth);
// applies markup server-side + persists a flight ItineraryItem.
app.use("/api/v1/flight-plugin", travelFlightQuotesRoutes);
// Admin tooling (ADMIN-only ops triggers + read APIs)
app.use("/api/admin", adminRoutes);

// PRD_TRAVEL_SECURITY_ARCHITECTURE FR-3.7 (S5) — SecurityIncident ingest
// + ADMIN triage listing. POST /api/security/csp-report is public (exempt
// via openPaths + CONTENT_TYPE_GUARD_EXCLUDE_PREFIXES); GET /incidents and
// POST /incidents/:id/review re-assert verifyToken + verifyRole(['ADMIN'])
// at the route. Separate from /api/csp (slice 2 of #917) — see route header.
app.use("/api/security", require("./routes/security_reports"));

// Public landing pages (outside /api/ prefix, no auth guard)
app.use("/p", landingPagesPublic);

// #921 slice S38 — wire the iframe-embedding override on /embed/* BEFORE
// the lead-form gate handler. S4 (commit 6561bdc) made the global default
// X-Frame-Options: DENY + CSP frame-ancestors 'none' so no page can be
// iframed by anyone — but the embed widget is the ONE intentionally-public
// iframe surface (partner sites embed our /embed/lead-form.html into their
// own pages via an iframe pointing at our origin). Without this override
// every partner-side embed silently broke when S4 landed. allowList: ['*']
// = "anyone can frame me" — appropriate because the embed widget is
// intentionally public and partner origins aren't known upfront. Once
// Tenant.embedAllowlistJson lands (flagged follow-up in security.js:355+),
// this mount can read per-tenant allowList instead of the wildcard.
app.use("/embed", allowIframeEmbedding({ allowList: ["*"] }));

// #297: /embed/lead-form.html — server-side gate so a malformed/revoked
// API key returns 404 at GET time rather than letting the form render and
// only failing on submit. Pre-fix the static file always loaded with 200
// regardless of key, so bots probing /embed?key=garbage got a 200 +
// fully-rendered form. Now: shape-check the key first; if it's well-formed
// look it up in the ApiKey table; only serve the static HTML when the
// key is missing (slug-mode), or shape+DB valid. In production Nginx
// serves the static asset directly from /var/www/.../embed/, but the
// per-push API gate (against the Express backend on :5000) hits this
// route — see public-booking-api.spec.js for the contract pin.
app.get("/embed/lead-form.html", async (req, res, next) => {
  try {
    const key = req.query.key ? String(req.query.key) : null;
    if (key) {
      // Real keys are issued as `glbs_<base64ish>` (see ApiKey model + seed).
      // A well-formed but unknown key still 404s, same as a malformed one.
      if (!/^glbs_[A-Za-z0-9_-]{8,}$/.test(key)) {
        return res.status(404).type("text/plain").send("Form not found");
      }
      // Lazy-require to avoid cyclic init concerns; the canonical singleton
      // is at lib/prisma.js so all callers share one client.
      const prismaClient = require("./lib/prisma");
      const apiKey = await prismaClient.apiKey.findUnique({
        where: { keySecret: key },
        select: { id: true },
      });
      if (!apiKey) {
        return res.status(404).type("text/plain").send("Form not found");
      }
    }
    // Pass through to the static-file fallback (Nginx in prod; for the
    // local stack the file lives at frontend/public/embed/lead-form.html).
    const embedPath = path.join(__dirname, "..", "frontend", "public", "embed", "lead-form.html");
    return res.sendFile(embedPath, (err) => {
      if (err) next();
    });
  } catch (e) {
    console.error("[embed] gate failed:", e.message);
    return next();
  }
});

// Server File Uploads Statically.
// Mounted at BOTH `/uploads` (legacy, kept for any non-Nginx setups that
// proxy the bare path) AND `/api/uploads` (canonical). The `/api/uploads`
// mount is the one that actually works on the deployed demo + the Vite dev
// server, because Nginx only proxies `/api/*` to the backend (and the Vite
// dev proxy is configured the same way). Bare `/uploads/*` requests hit
// the static-frontend host first and fall through the SPA catch-all → the
// browser renders the React index.html as if it were an image → broken
// image. New upload routes should return `/api/uploads/...` URLs; the
// PHI gating remains the route-level concern (filenames are
// pseudo-random, but the static mount itself is intentionally public so
// `<img src>` works without an Authorization header).
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api/uploads", express.static(path.join(__dirname, "uploads")));
// Health Check Endpoint
const prisma = require("./lib/prisma");

// #543 (MED-02): /api/health is unauthenticated by design (load-balancer
// + uptime probes need to reach it without creds). The pen-test flagged
// the public response as leaking the full version string + uptime to any
// caller, which lets attackers fingerprint the deployed build for
// vulnerable-version targeting.
//
// Two-tier response now:
//   - Unauthenticated (no Authorization header) → minimal body:
//     { status, timestamp } only. Enough for liveness/readiness probes
//     and the demo-monitor cron. No version, no uptime, no DB string.
//   - Authenticated (any valid JWT) → full body: status, version,
//     uptime, timestamp, database. For ops + the
//     `triaging-stuck-deploy-gate` skill's deploy-divergence check.
//
// Detection of "authenticated" is intentionally minimal — just the
// presence of an Authorization header. We do NOT verify the JWT here
// (that would add a DB round-trip for revoked-token check on every
// liveness probe). The server only DISCLOSES extra fields to callers
// who can present a token; it doesn't grant any access. If a stolen
// token is used to probe /api/health, the worst outcome is fingerprint
// disclosure to a caller who already has a tenant credential — not a
// new escalation.
app.get("/api/health", async (req, res) => {
  let dbStatus = "disconnected";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "connected";
  } catch (err) {
    dbStatus = `error: ${err.message}`;
  }

  const status = dbStatus === "connected" ? "healthy" : "degraded";
  const minimal = { status, timestamp: new Date().toISOString() };

  if (!req.headers.authorization) {
    return res.json(minimal);
  }
  res.json({
    ...minimal,
    version: APP_VERSION,
    uptime: process.uptime(),
    database: dbStatus,
  });
});

app.get("/", (req, res) => {
  // #543: same minimal-by-default policy applied to the API root. Public
  // callers see "the API is up"; authenticated callers see the version.
  if (!req.headers.authorization) {
    return res.json({ message: "Enterprise CRM API Core Online" });
  }
  res.json({ message: "Enterprise CRM API Core Online", version: APP_VERSION });
});

// #532 / #535 (PT-03): JSON 404 for unmatched /api/* paths. Express's default
// 404 returns text/html "Cannot GET /api/foo" which broke SPA error handling
// and made API consumers (Callified, AdsGPT) parse HTML on a missed route.
// The pen-test surfaced 17 of 36 detail endpoints as systemic offenders + 1
// specific leaf (#532 /api/wellness/loyalty). One middleware closes both
// classes by returning a stable {error, code, path} envelope that matches
// the rest of the API's error shape. Anything outside /api/ falls through
// to Nginx (which serves the SPA's index.html for client-side routing).
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    code: "API_ROUTE_NOT_FOUND",
    path: req.originalUrl,
    method: req.method,
  });
});

// Global JSON error handler — must come AFTER all routes.
// Catches express.json() body-parse errors, Prisma exceptions, and anything
// uncaught downstream. Returns JSON instead of Express's default HTML page
// so API consumers (browsers, Callified, AdsGPT) always get a parseable body.
//
// #544 (MED-03): canonical response envelope is { error, code } across the
// whole API. The catch-alls below now ALL include `code` so SPA/SDK error
// handlers can branch on stable identifiers instead of regexing the message.
// (Per-route handlers that still return { message: ... } for delete-success
// shapes are tracked under #549 — separate sweep, not blocking this fix.)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({ error: "Invalid JSON body", code: "INVALID_JSON_BODY", detail: err.message });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large", code: "PAYLOAD_TOO_LARGE" });
  }
  console.error("[server] unhandled error:", err && err.stack ? err.stack : err);
  const status = err && err.status ? err.status : 500;
  res.status(status).json({
    error: (err && err.message) || "Internal server error",
    code: status === 500 ? "INTERNAL_ERROR" : (err && err.code) || `HTTP_${status}`,
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`[Backend] Enterprise Express Server running securely on port ${PORT}`);

  // Auto-heal RBAC state on boot so requiredPermission-gated UI (e.g. the
  // "Roles" sidebar entry) appears consistently across local / dev / prod
  // without manual seed-rbac-only.js runs. Fire-and-forget: a DB hiccup must
  // never crash the server. Set DISABLE_RBAC_BOOT_SYNC=1 to opt out.
  const { ensureRbacOnBoot } = require('./scripts/ensureRbacOnBoot');
  ensureRbacOnBoot()
    .then((stats) => {
      if (!stats) return;
      const wrote = stats.rolesCreated + stats.permsCreated + stats.assignmentsCreated;
      if (wrote > 0) {
        console.log(`[rbac-boot] backfilled — roles:${stats.rolesCreated} perms:${stats.permsCreated} assignments:${stats.assignmentsCreated} (skipped users:${stats.usersSkipped})`);
      } else {
        console.log('[rbac-boot] RBAC state already compatible — no changes.');
      }
    })
    .catch((err) => console.error('[rbac-boot] non-fatal error:', err && err.message ? err.message : err));

  // Self-heal the SubscriptionPlan catalog so a fresh install / wiped DB /
  // partial seed always has the 3 canonical plans on /pricing. Idempotent —
  // existing rows are left alone (Owner edits via Manage Plans persist
  // across restarts). Fire-and-forget; never crash boot on a DB hiccup.
  // Set DISABLE_PLANS_BOOT_SYNC=1 to opt out.
  if (process.env.DISABLE_PLANS_BOOT_SYNC !== '1') {
    const ensureSubscriptionPlans = require('./lib/ensureSubscriptionPlans');
    ensureSubscriptionPlans()
      .catch((err) => console.error('[plans-boot] non-fatal error:', err && err.message ? err.message : err));
  }
});

// Graceful shutdown — required for c8 / V8 line coverage to flush its temp
// files (V8 only dumps coverage on clean process exit; SIGTERM-without-handler
// kills before it can flush). Also benefits production: no half-served
// requests on `pm2 restart`.
const _gracefulShutdown = (signal) => {
  console.log(`[shutdown] ${signal} received — closing server`);
  server.close(() => {
    console.log('[shutdown] server closed cleanly');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[shutdown] timeout — forcing exit');
    process.exit(0);
  }, 10000).unref();
};
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => _gracefulShutdown('SIGINT'));

// DISABLE_CRONS=1 lets us boot a side-by-side instance (e.g. for c8 line-
// coverage runs on a different port) without double-firing reminders, blasts,
// orchestrator runs, etc. against the shared DB. Set ONLY on the secondary
// instance — production PM2 should leave it unset.
if (process.env.DISABLE_CRONS === '1') {
  console.log('[crons] DISABLE_CRONS=1 — skipping all cron init (coverage / sandbox mode)');
} else {

  // Scheduled Report Engine (checks hourly for due report schedules)
  const { initReportCron } = require('./cron/reportEngine');
  initReportCron();

  // Initialize Sequence Engine
  const { initSequenceCron } = require('./cron/sequenceEngine');
  initSequenceCron();

  // Initialize Lead Scoring Engine (runs every 10 min, immediate first tick)
  const { initLeadScoringCron } = require('./cron/leadScoringEngine');
  initLeadScoringCron(io);

  // Initialize Recurring Invoice Engine (runs daily at 6 AM)
  const { initRecurringInvoiceCron } = require('./cron/recurringInvoiceEngine');
  initRecurringInvoiceCron(io);

  // Initialize Marketplace Sync Engine (runs every 5 min)
  const { initMarketplaceCron } = require('./cron/marketplaceEngine');
  initMarketplaceCron(io);

  // Initialize GDPR Retention Engine (runs daily at 3 AM)
  const { initRetentionCron } = require('./cron/retentionEngine');
  initRetentionCron();

  // Initialize Scheduled Email Engine (runs every minute)
  const { initScheduledEmailCron } = require('./cron/scheduledEmailEngine');
  initScheduledEmailCron();

  // Initialize Sentiment Analysis Engine (runs every 15 min)
  const { initSentimentCron } = require('./cron/sentimentEngine');
  initSentimentCron();

  // Initialize AI Deal Insights Engine (runs every 6 hours)
  const { initDealInsightsCron } = require('./cron/dealInsightsEngine');
  initDealInsightsCron(io);

  // Initialize Forecast Snapshot Engine (weekly Monday 1 AM)
  const { initForecastSnapshotCron } = require('./cron/forecastSnapshotEngine');
  initForecastSnapshotCron();

  // Initialize Workflow Trigger Engine (event-driven, not polled)
  const { initWorkflowEngine } = require('./cron/workflowEngine');
  initWorkflowEngine(io);

  // Initialize Campaign Send Engine (processes scheduled campaigns every minute)
  const { initCampaignCron } = require('./cron/campaignEngine');
  initCampaignCron();

  // Initialize Automated Backup Engine (daily at 2 AM)
  const { initBackupCron } = require('./cron/backupEngine');
  initBackupCron();

  // Initialize Wellness Orchestrator (daily 07:00 IST)
  const { initOrchestratorCron } = require('./cron/orchestratorEngine');
  initOrchestratorCron();

  // Initialize Appointment Reminders Engine (every 15 min, wellness tenants)
  const { initAppointmentRemindersCron, initNoShowRiskCron } = require('./cron/appointmentRemindersEngine');
  initAppointmentRemindersCron();
  // PRD Gap §12 #4e — daily 08:30 IST no-show risk Notification fan-out.
  initNoShowRiskCron();

  // Initialize Wellness Ops Engine (hourly: NPS surveys + junk-lead retention)
  const { initWellnessOpsCron } = require('./cron/wellnessOpsEngine');
  initWellnessOpsCron();

  // Initialize Travel CRM post-trip feedback cron (daily 06:13 IST).
  // PRD §4.8 + §6.3 — creates a Survey row for TmcTrips whose returnDate
  // is 1-7 days ago. WhatsApp/email dispatch slots in once Wati BSP creds
  // (Q9) land; for now the survey link is just logged.
  const { initTripPostTripFeedbackCron } = require('./cron/tripPostTripFeedback');
  initTripPostTripFeedbackCron();

  // Initialize Travel CRM payment reminders cron (daily 07:13 IST).
  // PRD §4.4 + §6.3 — creates a Notification row for each
  // TripInstalmentPayment in pre-due or overdue windows (per
  // TripPaymentPlan.instalmentsJson reminderDays per entry). Dedupes
  // via (entityType, entityId, type). WhatsApp/email dispatch lands
  // once Wati BSP creds (Q9) arrive.
  const { initTripPaymentRemindersCron } = require('./cron/tripPaymentReminders');
  initTripPaymentRemindersCron();

  // C8 (PRD_TRAVEL_BILLING UC-2.4) — daily 09:13 IST TravelPaymentSchedule
  // T-7 / T-3 / T-1 reminder sweep. Fires SMS + email customer reminders
  // (WA leg stub pending Q9 Wati creds) per milestone whose dueDate lands
  // in window; bumps remindersSentCount + lastReminderSentAt on the row.
  const { initCron: initPaymentScheduleReminderCron } = require('./cron/paymentScheduleReminderEngine');
  initPaymentScheduleReminderCron();

  // Initialize Travel CRM diagnostic-to-advisor escalation (every 5 min).
  // PRD §6.3 row 6 — diagnostics stalled >30 min without advisor outreach
  // surface as high-priority Notification rows on the advisor dashboard.
  // Outreach detected via Activity / Task created after the diagnostic.
  const { initTravelDiagnosticAlertsCron } = require('./cron/travelDiagnosticAdvisorAlerts');
  initTravelDiagnosticAlertsCron();

  // Initialize Travel CRM RFU journey reminders (every 30 min).
  // PRD §4.8 + §6.3 — fires fixed-point milestones (T-7d / T-3d / T-1d /
  // T-0 / T+2d / T+7d) for RFU accepted itineraries. WhatsApp/email
  // dispatch deferred to Wati BSP creds; Notification row is the
  // visible Phase 1 output.
  const { initTravelJourneyRemindersCron } = require('./cron/travelJourneyReminders');
  initTravelJourneyRemindersCron();

  // Initialize Visa Sure risk-flagging engine (every 6 hours, SHELL).
  // PRD Phase 3 §3 FR-3 (rows V5-V7, cluster B3) — scans VisaApplication
  // rows in pending/intake/docs-pending/docs-collected status; writes
  // high-priority Notification rows for complex-case / rejection-history /
  // readinessLevel-4 / existing-flag signals. Real rule-set pending
  // PRD §5 PC-1..PC-5 product calls.
  const { initVisaRiskFlagCron } = require('./cron/visaRiskFlagEngine');
  initVisaRiskFlagCron();
  console.log("✓ Cron engine: visaRiskFlagEngine (every 6 hours)");

  // Initialize Travel CRM web check-in scheduler (every 15 min).
  // PRD §4.6 + §6.3 row 1 — flips WebCheckin status pending → reminded
  // when windowOpenAt arrives, then reminded → fallback-agent if stalled
  // 30m+. Browser-automation half (P1B) deferred — this scheduler only
  // handles the tracking + reminder side.
  const { initWebCheckinSchedulerCron } = require('./cron/webCheckinScheduler');
  initWebCheckinSchedulerCron();

  // Initialize Travel CRM contact greetings (daily 08:13 IST) — Phase 2.
  // PRD §4.8 Phase 2 birthday/anniversary greetings. Year-agnostic
  // month+day match on Contact.birthDate + Contact.anniversary; one
  // Notification per occasion per year. Wati dispatch deferred to Q9.
  const { initContactGreetingsCron } = require('./cron/contactGreetingsEngine');
  initContactGreetingsCron();

  // Initialize Travel CRM religious-guidance delivery (daily 09:13 IST) —
  // PRD §4.8 + §4.10 RFU sub-brand. Scans RFU itineraries in the next
  // 14-day window; for each active ReligiousGuidancePacket whose
  // dayOffset === daysToDeparture, creates one Notification per
  // (packet, itinerary, year) dedup window. WA dispatch deferred to Q9.
  const { initReligiousGuidanceCron } = require('./cron/religiousGuidanceEngine');
  initReligiousGuidanceCron();

  // Slice C9 — Travel CRM quote expiry sweep (daily 09:00 IST).
  // PRD_TRAVEL_QUOTE_BUILDER §3.7 — flips Draft/Sent quotes with validUntil<now
  // to status='Expired' + writes a TravelQuoteSnapshot history row per transition.
  const { initCron: initQuoteExpirySweepCron } = require('./cron/quoteExpirySweep');
  initQuoteExpirySweepCron();

  // #902 GST slice 12 — daily GSTR filing reminder sweep (05:00 UTC = 10:30 IST).
  // Iterates active tenants and emits a tiered reminder (T-7d / T-3d / T-1d / T-0)
  // for each one whose prior-month GSTR filing is approaching its deadline. Notify
  // half is a console-log stub today; real WhatsApp / email dispatch lands when
  // Q9 creds drop. Respects DISABLE_CRONS=1 via the outer guard.
  const { runGstrFilingReminderEngine } = require('./cron/gstrFilingReminderEngine');
  _cron.schedule('0 5 * * *', async () => {
    try {
      const result = await runGstrFilingReminderEngine();
      console.log('[gstr-filing-reminder]', result);
    } catch (e) {
      console.error('[gstr-filing-reminder] cron failed:', e.message);
    }
  });
  console.log('[gstr-filing-reminder] cron initialized (daily 05:00 UTC / 10:30 IST)');

  // Initialize Low-Stock Inventory Alerts (daily 09:00 IST, wellness tenants)
  const { initLowStockCron } = require('./cron/lowStockEngine');
  initLowStockCron();

  // Wave 11 Agent HH — Auto-consumption listener. Subscribes to 'visit.completed'
  // events and applies all active AutoConsumptionRule rows for the visit's
  // service: writes ServiceConsumption rows + decrements Product.currentStock.
  // Idempotent boot; failures are logged and never propagate to the visit
  // response (clinical record stays intact).
  const { start: startAutoConsumption } = require('./lib/autoConsumptionApplier');
  startAutoConsumption();

  // Initialize SLA Breach Engine (every 5 min — flips Ticket.breached + emits 'sla.breached')
  const { initSlaBreachCron } = require('./cron/slaBreachEngine');
  initSlaBreachCron();

  // WhatsApp SaaS P3 — async outbound delivery (every 30s) + media download
  // pipeline (every 60s). Both engines no-op gracefully when the underlying
  // WhatsAppConfig is missing or token is unset, so they're safe to enable
  // even before any tenant has completed onboarding. The outbound engine
  // receives `io` to broadcast whatsapp:sent events back to the frontend
  // as queued messages complete delivery.
  const { initWhatsappOutboundCron } = require('./cron/whatsappOutboundEngine');
  initWhatsappOutboundCron(io);
  const { initWhatsappMediaCron } = require('./cron/whatsappMediaEngine');
  initWhatsappMediaCron();

  // WhatsApp SaaS P4 — daily token-refresh probe + template-sync safety net.
  // Token refresh proactively extends short-lived tokens 7 days before expiry
  // via fb_exchange_token; surfaces unrecoverable expiry via Notification +
  // soft-disconnect. Template sync pulls every approved template from Meta
  // nightly so the local table stays in sync even when webhook events drop.
  const { initWhatsappTokenRefreshCron } = require('./cron/whatsappTokenRefreshEngine');
  initWhatsappTokenRefreshCron();
  const { initWhatsappTemplateSyncCron } = require('./cron/whatsappTemplateSyncEngine');
  initWhatsappTemplateSyncCron();

  // #541 (OPS-1): Demo Hygiene — hourly purge of `_QA_PROBE_*` /
  // `E2E_FLOW_*` test residue from patient list + admin-config models.
  // Set DEMO_HYGIENE_DISABLED=1 in non-demo environments (CI / local) to
  // skip — see backend/cron/demoHygieneEngine.js.
  const { initDemoHygieneCron } = require('./cron/demoHygieneEngine');
  initDemoHygieneCron();

  // Initialize Lead-side SLA Breach Engine (every 2 min — flips Contact.slaBreached
  // + emits 'lead.sla_breached' for the PRD §6.4 lead first-response SLA)
  const { initLeadSlaCron } = require('./cron/leadSlaEngine');
  initLeadSlaCron();

  // #558 — AuditLog hash-chain integrity sweep (daily 04:00, after retention).
  const { initAuditIntegrityCron } = require('./cron/auditIntegrityEngine');
  initAuditIntegrityCron();

  // Wave 8b — POS receipt dispatcher subscribes to sale.completed events
  // and queues SMS (always) + WhatsApp (if Contact opted-in) receipt rows.
  // Event-driven, no cron tick. Fire-and-forget: a dispatch hiccup never
  // affects the sale itself.
  const { start: startPosReceiptDispatcher } = require('./lib/posReceiptDispatcher');
  startPosReceiptDispatcher();

  // Wave 8b — Leave Policy Engine (daily 02:30 IST). Detects fiscal
  // year-end per LeavePolicy and applies carry-forward + encashment
  // payouts where the policy specifies them. Idempotent on a
  // per-(tenant,policy,user,year) basis via LeaveBalance lookups.
  const { initLeavePolicyCron } = require('./cron/leavePolicyEngine');
  initLeavePolicyCron();

  // D16 Wallet Top-up — Arc 1 Slice 6 (PRD_WALLET_TOPUP §3.5 Phase 2).
  // Daily 03:30 IST sweep: flips ACTIVE WalletCreditBatch rows whose
  // expiresAt has passed to EXPIRED, debits Wallet.balance, writes a
  // signed-negative EXPIRY WalletTransaction row, audits WALLET_EXPIRY.
  // Idempotent (status filter is the set-once gate).
  const { initWalletExpiryCron } = require('./cron/walletExpiryEngine');
  initWalletExpiryCron();

  // Initialize Notification Rules Engine — event-driven notifications for
  // business events (SLA breaches, approvals, expenses, leave requests).
  // Subscribes to eventBus events and creates notifications via notificationService.
  const notificationRules = require('./lib/notificationRulesEngine');
  notificationRules.init(io);

} // end DISABLE_CRONS guard

// nodemon restart trigger
