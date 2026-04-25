const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true }); // load root .env for API keys (Gemini, Mailgun, etc.)

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

const { initSentry } = require("./lib/sentry");

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const cron = require("node-cron");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const rateLimit = require("express-rate-limit");

const { verifyToken } = require("./middleware/auth");

const app = express();
app.set('trust proxy', 1); // trust first proxy (Nginx)
const server = http.createServer(app);

// Initialize Sentry early for full request capture (no-op if SENTRY_DSN not set)
initSentry(app);

// CORS — restrict to known origins
const ALLOWED_ORIGINS = [
  "https://crm.globusdemos.com",
  "http://localhost:5173",
  "http://localhost:5000",
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Postman)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error("CORS: origin not allowed"), false);
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// Security middleware
const cookieParser = require('cookie-parser');
const { helmetMiddleware, sanitizeBody, stripTenantOverride } = require('./middleware/security');
app.use(helmetMiddleware);
app.use(cookieParser());
app.use(sanitizeBody);
app.use(stripTenantOverride);

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: "Too many login attempts, please try again later." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});
app.use("/api/auth/login", authLimiter);
app.use("/api", apiLimiter);

const io = new Server(server, { cors: { origin: "*" } });
const presenceColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

// Attach socket to requests so routes can emit events
app.use((req, res, next) => {
  req.io = io;
  next();
});

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
const billingRoutes = require("./routes/billing");
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
const auth2faRoutes = require("./routes/auth_2fa");
const ssoRoutes = require("./routes/sso");
const calendarGoogleRoutes = require("./routes/calendar_google");
const calendarOutlookRoutes = require("./routes/calendar_outlook");
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
const accountingRoutes = require("./routes/accounting");
const dealInsightsRoutes = require("./routes/deal_insights");
const dataEnrichmentRoutes = require("./routes/data_enrichment");
const slaRoutes = require("./routes/sla");
const cannedResponsesRoutes = require("./routes/canned_responses");
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
// Wellness vertical (Enhanced Wellness, future clinic clients)
const wellnessRoutes = require("./routes/wellness");
// External partner API v1 (Callified.ai, Globus Phone, etc. — API key auth)
const externalRoutes = require("./routes/external");

// OpenAPI Swagger Bootloader
const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Globussoft CRM Docs"
}));

// Global auth guard — protects all /api/ routes EXCEPT auth login/signup and health
app.use("/api", (req, res, next) => {
  const openPaths = ["/auth/login", "/auth/signup", "/auth/register", "/auth/forgot-password", "/auth/reset-password", "/health", "/marketplace-leads/webhook", "/sms/webhook", "/whatsapp/webhook", "/telephony/webhook", "/push/subscribe/visitor", "/push/vapid-key", "/communications/track", "/sso/google/callback", "/sso/microsoft/callback", "/sso/google/start", "/sso/microsoft/start", "/email/inbound", "/calendar/google/callback", "/calendar/outlook/callback", "/voice/webhook", "/portal/login", "/portal/forgot", "/portal/reset", "/signatures/sign", "/surveys/respond", "/chatbots/chat", "/web-visitors/track", "/payments/webhook", "/scim/v2", "/booking-pages/public", "/knowledge-base/public", "/live-chat/visitor", "/document-views/track", "/zapier/webhook", "/v1/external", "/wellness/public", "/wellness/portal"];
  if (openPaths.some(p => req.path.startsWith(p))) return next();
  verifyToken(req, res, next);
});

// Strip dangerous fields (id, createdAt, updatedAt, tenantId, userId) from all request bodies
const { stripDangerous } = require('./middleware/validateInput');
app.use(stripDangerous);

// Map API Endpoints
app.use("/api/auth", authRoutes);
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
app.use("/api/billing", billingRoutes);
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
app.use("/api/telephony", telephonyRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/landing-pages", landingPagesRoutes);
app.use("/api/tenants", tenantsRoutes);
app.use("/api/auth/2fa", auth2faRoutes);
app.use("/api/sso", ssoRoutes);
app.use("/api/calendar/google", calendarGoogleRoutes);
app.use("/api/calendar/outlook", calendarOutlookRoutes);
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
app.use("/api/accounting", accountingRoutes);
app.use("/api/deal-insights", dealInsightsRoutes);
app.use("/api/data-enrichment", dataEnrichmentRoutes);
app.use("/api/sla", slaRoutes);
app.use("/api/canned-responses", cannedResponsesRoutes);
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
// Wellness vertical
app.use("/api/wellness", wellnessRoutes);
// External partner API (API key auth, versioned)
app.use("/api/v1/external", externalRoutes);

// Public landing pages (outside /api/ prefix, no auth guard)
app.use("/p", landingPagesPublic);

// Server File Uploads Statically
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Health Check Endpoint
const prisma = require("./lib/prisma");

app.get("/api/health", async (req, res) => {
  let dbStatus = "disconnected";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "connected";
  } catch (err) {
    dbStatus = `error: ${err.message}`;
  }

  res.json({
    status: dbStatus === "connected" ? "healthy" : "degraded",
    version: "3.2.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: dbStatus,
  });
});

app.get("/", (req, res) => {
  res.json({ message: "Enterprise CRM API Core Online", version: "3.2.0" });
});

// Global JSON error handler — must come AFTER all routes.
// Catches express.json() body-parse errors, Prisma exceptions, and anything
// uncaught downstream. Returns JSON instead of Express's default HTML page
// so API consumers (browsers, Callified, AdsGPT) always get a parseable body.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({ error: "Invalid JSON body", detail: err.message });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  console.error("[server] unhandled error:", err && err.stack ? err.stack : err);
  res.status(err && err.status ? err.status : 500).json({
    error: (err && err.message) || "Internal server error",
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`[Backend] Enterprise Express Server running securely on port ${PORT}`);
});

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
const { initAppointmentRemindersCron } = require('./cron/appointmentRemindersEngine');
initAppointmentRemindersCron();

// Initialize Wellness Ops Engine (hourly: NPS surveys + junk-lead retention)
const { initWellnessOpsCron } = require('./cron/wellnessOpsEngine');
initWellnessOpsCron();

// Initialize Low-Stock Inventory Alerts (daily 09:00 IST, wellness tenants)
const { initLowStockCron } = require('./cron/lowStockEngine');
initLowStockCron();

// nodemon restart trigger
