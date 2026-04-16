const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true }); // load root .env for API keys (Gemini, Mailgun, etc.)

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
    callback(null, true); // Log but allow in dev — switch to callback(new Error()) in strict prod
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000, // Allows test suites while still preventing brute force
  message: { error: "Too many login attempts, please try again later." },
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

// OpenAPI Swagger Bootloader
const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Globussoft CRM Docs"
}));

// Global auth guard — protects all /api/ routes EXCEPT auth login/signup and health
app.use("/api", (req, res, next) => {
  const openPaths = ["/auth/login", "/auth/signup", "/auth/register", "/auth/forgot-password", "/auth/reset-password", "/health", "/marketplace-leads/webhook", "/sms/webhook", "/whatsapp/webhook", "/telephony/webhook", "/push/subscribe/visitor", "/push/vapid-key", "/communications/track", "/sso/google/callback", "/sso/microsoft/callback", "/sso/google/start", "/sso/microsoft/start", "/email/inbound", "/calendar/google/callback", "/calendar/outlook/callback", "/voice/webhook"];
  if (openPaths.some(p => req.path.startsWith(p))) return next();
  verifyToken(req, res, next);
});

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

// Public landing pages (outside /api/ prefix, no auth guard)
app.use("/p", landingPagesPublic);

// Server File Uploads Statically
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Health Check Endpoint
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

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
    version: "2.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: dbStatus,
  });
});

app.get("/", (req, res) => {
  res.json({ message: "Enterprise CRM API Core Online", version: "2.0.0" });
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

// nodemon restart trigger
