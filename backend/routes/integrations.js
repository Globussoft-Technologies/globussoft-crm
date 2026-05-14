const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const router = express.Router();

const AVAILABLE_INTEGRATIONS = [
  {
    provider: "slack",
    name: "Slack",
    description: "Send deal/contact notifications to Slack channels",
    category: "communication",
  },
  {
    provider: "google",
    name: "Google Workspace",
    description: "Calendar, Contacts, and Drive sync",
    category: "productivity",
  },
  {
    provider: "stripe",
    name: "Stripe",
    description: "Payment processing for invoices",
    category: "payments",
  },
  {
    provider: "razorpay",
    name: "Razorpay",
    description: "Indian payment gateway for invoices",
    category: "payments",
  },
  {
    provider: "mailchimp",
    name: "Mailchimp",
    description: "Email marketing campaign sync",
    category: "marketing",
  },
  {
    provider: "quickbooks",
    name: "QuickBooks",
    description: "Accounting & bookkeeping sync",
    category: "accounting",
  },
  {
    provider: "xero",
    name: "Xero",
    description: "Cloud accounting platform sync",
    category: "accounting",
  },
  {
    provider: "tally",
    name: "Tally Prime",
    description: "Indian accounting software sync",
    category: "accounting",
  },
  {
    provider: "zapier",
    name: "Zapier",
    description: "Connect to 5000+ apps via triggers & actions",
    category: "automation",
  },
  {
    provider: "whatsapp",
    name: "WhatsApp Business",
    description: "Send messages via WhatsApp Cloud API",
    category: "communication",
  },
  {
    provider: "indiamart",
    name: "IndiaMART",
    description: "Auto-import B2B leads",
    category: "marketplace",
  },
  {
    provider: "justdial",
    name: "JustDial",
    description: "Auto-import local business leads",
    category: "marketplace",
  },
];

router.get("/", verifyToken, async (req, res) => {
  try {
    const connected = await prisma.integration.findMany({
      where: { tenantId: req.user.tenantId },
    });
    const connectedMap = {};
    for (const c of connected) connectedMap[c.provider] = c;

    const integrations = AVAILABLE_INTEGRATIONS.map((a) => ({
      ...a,
      isActive: connectedMap[a.provider]?.isActive || false,
      connectedAt: connectedMap[a.provider]?.updatedAt || null,
      id: connectedMap[a.provider]?.id || null,
    }));
    res.json(integrations);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch integrations" });
  }
});

router.post(
  "/connect",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { provider, token, settings } = req.body;
      if (!provider)
        return res.status(400).json({ error: "Provider required" });

      const integration = await prisma.integration.upsert({
        where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
        update: {
          isActive: true,
          token: token || null,
          settings: settings ? JSON.stringify(settings) : null,
        },
        create: {
          provider,
          isActive: true,
          token: token || null,
          settings: settings ? JSON.stringify(settings) : null,
          tenantId: req.user.tenantId,
        },
      });
      res.json(integration);
    } catch (_err) {
      res.status(500).json({ error: "Failed to connect integration" });
    }
  },
);

router.post(
  "/disconnect",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { provider } = req.body;
      await prisma.integration.updateMany({
        where: { tenantId: req.user.tenantId, provider },
        data: { isActive: false, token: null },
      });
      res.json({ success: true });
    } catch (_err) {
      res.status(500).json({ error: "Failed to disconnect" });
    }
  },
);

// Legacy toggle endpoint (kept for backwards compat). ADMIN-only — sister
// /connect + /disconnect already require ADMIN; toggle is the same write
// surface. Closes #409.
router.post("/toggle", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { provider, isActive } = req.body;
    const integration = await prisma.integration.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      update: { isActive },
      create: { provider, isActive, tenantId: req.user.tenantId },
    });
    res.json(integration);
  } catch (_err) {
    res.status(500).json({ error: "Failed to toggle integration" });
  }
});

// GET /api/integrations/marketplace/status
// Closes #437. Per-provider status chip data for the /marketplace-leads page
// header — lets the Owner see at a glance whether each marketplace integration
// is configured, when it last synced, and whether leads are flowing.
//
// Response shape:
//   [{
//     provider: "indiamart",
//     label:    "IndiaMART",
//     configured: true,           // a MarketplaceConfig row exists
//     isActive:   true,           // ...and isActive is set
//     lastSyncAt: "2026-05-06T...",
//     leadsLast30d: 47,
//     healthHint: "connected" | "idle" | "stale" | "never_configured" | "inactive"
//   }, ...]
//
// healthHint semantics (consumer-facing chip color cue):
//   - "connected"        — configured + isActive + leadsLast30d > 0 (green)
//   - "idle"             — configured + isActive + 0 leads in last 30d but
//                          lastSyncAt within last 24h (gray — "all quiet")
//   - "stale"            — configured + isActive + lastSyncAt older than 24h
//                          OR null (amber — "may be broken")
//   - "inactive"         — configured but isActive=false (gray)
//   - "never_configured" — no MarketplaceConfig row (gray + CTA)
//
// Non-admin readable so Owners + Managers can see the status row; the
// existing /api/marketplace-leads/config endpoint stays admin-only because
// it returns the (masked) API keys.
const MARKETPLACE_PROVIDERS = [
  { provider: "indiamart", label: "IndiaMART" },
  { provider: "justdial", label: "JustDial" },
  { provider: "tradeindia", label: "TradeIndia" },
];

router.get("/marketplace/status", verifyToken, async (req, res) => {
  try {
    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

    const tenantId = req.user.tenantId;

    // One round-trip for all configs; one count per provider for the
    // 30-day lead volume. The cron interval is every 5 min so 24h is
    // ample slack for the "stale" detection — anything older than 24h
    // means cron has been failing for 288+ ticks.
    const [configs, ...leadCounts] = await Promise.all([
      prisma.marketplaceConfig.findMany({
        where: { tenantId },
        select: { provider: true, isActive: true, lastSyncAt: true },
      }),
      ...MARKETPLACE_PROVIDERS.map(({ provider }) =>
        prisma.marketplaceLead.count({
          where: { tenantId, provider, createdAt: { gte: thirtyDaysAgo } },
        }),
      ),
    ]);

    const configMap = {};
    for (const c of configs) configMap[c.provider] = c;

    const status = MARKETPLACE_PROVIDERS.map((p, i) => {
      const cfg = configMap[p.provider];
      const leadsLast30d = leadCounts[i];
      let healthHint;
      if (!cfg) {
        healthHint = "never_configured";
      } else if (!cfg.isActive) {
        healthHint = "inactive";
      } else if (leadsLast30d > 0) {
        healthHint = "connected";
      } else if (cfg.lastSyncAt && cfg.lastSyncAt > oneDayAgo) {
        healthHint = "idle";
      } else {
        healthHint = "stale";
      }
      return {
        provider: p.provider,
        label: p.label,
        configured: !!cfg,
        isActive: !!(cfg && cfg.isActive),
        lastSyncAt: cfg?.lastSyncAt || null,
        leadsLast30d,
        healthHint,
      };
    });

    res.json(status);
  } catch (err) {
    console.error("[Integrations] Marketplace status error:", err);
    res.status(500).json({ error: "Failed to fetch marketplace status" });
  }
});

// GET /api/integrations/callified/auth-url
// Generates a signed JWT token for Callified SSO and returns the Callified auth URL.
// The JWT is signed with the shared Callified secret from environment variables.
router.get("/callified/auth-url", verifyToken, async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");

    // Get the Callified SSO secret from environment — must match Callified's SSO_SHARED_SECRET
    const callifiedSecret = process.env.CALLIFIED_SSO_SECRET;
    if (!callifiedSecret) {
      return res.status(503).json({
        error:
          "Callified integration is not yet available. Please contact your administrator to configure it.",
      });
    }

    // 1. Load Callified integration config for this tenant (optional — dashboardUrl comes from here)
    const integration = await prisma.integration.findFirst({
      where: {
        tenantId: req.user.tenantId,
        provider: "callified",
        isActive: true,
      },
    });
    const settings = integration?.settings
      ? JSON.parse(integration.settings)
      : {};

    // 2. Fetch current user for email + name
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });
    if (!user) return res.status(401).json({ error: "User not found" });

    // 3. Map CRM roles to Callified roles (admin, viewer, agent)
    // Callified has three role types with different visibility/permissions
    const callifiedRoleMap = {
      ADMIN: "admin", // Full access
      MANAGER: "agent", // Agent/team lead access
      USER: "viewer", // Viewer/read-only access
    };
    const callifiedRole = callifiedRoleMap[user.role] || "viewer";

    // 4. Sign the JWT — matches the Callified-specified format
    const payload = {
      iss: "globussoft-internal",
      aud: "callified",
      sub: settings.sub || "globussoft-crm",
      email: user.email,
      name: user.name,
      role: callifiedRole, // Use mapped Callified role
      org_id: parseInt(settings.orgId) || 1,
    };
    const token = jwt.sign(payload, callifiedSecret, {
      algorithm: "HS256",
      expiresIn: 1800,
    });

    // 4. Construct the Callified auth URL with token and redirect params
    // For development: use local Callified at http://localhost:8001
    // For production: set CALLIFIED_DASHBOARD_URL env var
    const callifiedBaseUrl =
      process.env.CALLIFIED_DASHBOARD_URL ||
      settings.dashboardUrl ||
      "http://localhost:8001/api/auth/sso/jwt";
    const redirect = settings.redirectPath || "/crm";
    const authUrl = `${callifiedBaseUrl}?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(redirect)}`;

    res.json({ authUrl });
  } catch (err) {
    console.error("[integrations] callified auth-url:", err);
    res.status(500).json({ error: "Failed to generate Callified auth URL" });
  }
});

// GET /api/integrations/callified/sso
// Direct redirect to Callified with JWT. Browser opens this URL immediately,
// no async/await needed on frontend. Solves popup blocker issues.
router.get("/callified/sso", verifyToken, async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");

    const callifiedSecret = process.env.CALLIFIED_SSO_SECRET;
    if (!callifiedSecret) {
      return res
        .status(503)
        .send(
          "Callified integration is not yet available. Please contact your administrator to configure it.",
        );
    }

    const integration = await prisma.integration.findFirst({
      where: {
        tenantId: req.user.tenantId,
        provider: "callified",
        isActive: true,
      },
    });
    const settings = integration?.settings
      ? JSON.parse(integration.settings)
      : {};

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });
    if (!user) return res.status(401).send("User not found");

    // Map CRM roles to Callified roles (admin, viewer, agent)
    const callifiedRoleMap = {
      ADMIN: "admin",
      MANAGER: "agent",
      USER: "viewer",
    };
    const callifiedRole = callifiedRoleMap[user.role] || "viewer";

    const payload = {
      iss: "globussoft-internal",
      aud: "callified",
      sub: settings.sub || "globussoft-crm",
      email: user.email,
      name: user.name,
      role: callifiedRole,
      org_id: parseInt(settings.orgId) || 1,
    };
    const token = jwt.sign(payload, callifiedSecret, {
      algorithm: "HS256",
      expiresIn: 1800,
    });

    const callifiedBaseUrl =
      process.env.CALLIFIED_DASHBOARD_URL ||
      settings.dashboardUrl ||
      "http://localhost:8001/api/auth/sso/jwt";
    const redirect = settings.redirectPath || "/crm";
    const authUrl = `${callifiedBaseUrl}?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(redirect)}`;

    // Redirect browser directly to Callified with JWT
    res.redirect(authUrl);
  } catch (err) {
    console.error("[integrations] callified sso:", err);
    res.status(500).send("Failed to redirect to Callified");
  }
});

module.exports = router;
