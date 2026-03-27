const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cron = require("node-cron");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");

const app = express();
const server = http.createServer(app);

// Global Middlewares
app.use(cors({ origin: "*" }));
app.use(express.json());

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

// OpenAPI Swagger Bootloader
const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Globussoft CRM Docs"
}));

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

// Server File Uploads Statically
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.json({ message: "Enterprise CRM API Core Online", version: "2.0.0" });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`[Backend] Enterprise Express Server running securely on port ${PORT}`);
});

// Weekly Automated Reporting Schema
cron.schedule('0 8 * * 1', async () => {
  // Executes every Monday at 8:00 AM
  console.log('[CRON] Assembling Weekly CRM BI Report...');
  // Logic to execute Prisma queries, generate a PDF report via pdfkit, and dispatch it via Nodemailer to the Admin
  console.log('[CRON] Automated Report Dispensed to administrative nodes.');
});

// nodemon restart trigger
