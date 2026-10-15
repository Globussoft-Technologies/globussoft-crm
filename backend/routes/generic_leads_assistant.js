const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, RBAC_DENIED_MESSAGE } = require("../middleware/auth");
const { requirePermission, requireAnyPermission, userHasPermission } = require("../middleware/requirePermission");
const { llmLimiter } = require("../middleware/apiRateLimiters");
const assistant = require("../services/genericLeadsAssistant");

const router = express.Router();

async function requireGenericTenant(req, res, next) {
  try {
    let vertical = req.user?.vertical;
    if (!vertical && req.user?.tenantId) {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { vertical: true } });
      vertical = tenant?.vertical || "generic";
      req.user.vertical = vertical;
    }
    if (vertical !== "generic") {
      return res.status(403).json({ error: RBAC_DENIED_MESSAGE, code: "GENERIC_TENANT_REQUIRED" });
    }
    return next();
  } catch (error) {
    console.error("[generic-leads-assistant] vertical check failed:", error.message);
    return res.status(500).json({ error: "Failed to verify tenant vertical", code: "TENANT_CHECK_FAILED" });
  }
}

function contextFromBody(body) {
  const context = body?.context && typeof body.context === "object" ? body.context : {};
  const activeFilters = context.activeFilters && typeof context.activeFilters === "object" ? context.activeFilters : {};
  const advancedFilters = Array.isArray(activeFilters.advancedFilters)
    ? activeFilters.advancedFilters.slice(0, 20).map((filter) => ({
        field: String(filter?.field || "").slice(0, 80),
        operator: String(filter?.operator || "").slice(0, 40),
        values: Array.isArray(filter?.values) ? filter.values.slice(0, 10).map((value) => String(value).slice(0, 200)) : [],
      }))
    : [];
  return {
    selectedLeadId: Number.isInteger(Number(context.selectedLeadId)) ? Number(context.selectedLeadId) : null,
    activeFilters: {
      search: String(activeFilters.search || "").slice(0, 200),
      source: String(activeFilters.source || "").slice(0, 128),
      campaign: String(activeFilters.campaign || "").slice(0, 64),
      callStatus: String(activeFilters.callStatus || "").slice(0, 64),
      assignee: String(activeFilters.assignee || "").slice(0, 64),
      advancedFilters,
    },
  };
}

function requireMessage(req, res, next) {
  if (typeof req.body?.message !== "string" || !req.body.message.trim()) {
    return res.status(400).json({ error: "message is required", code: "MISSING_MESSAGE" });
  }
  return next();
}

router.post("/message", verifyToken, requireGenericTenant, requireMessage, requirePermission("leads", "read"), llmLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const context = contextFromBody(body);
    const [canLeadWrite, canLeadUpdate, canDealWrite, canDealUpdate, canDealRead, canPipelineRead, canReportRead] = await Promise.all([
      userHasPermission(req.user, "leads", "write"),
      userHasPermission(req.user, "leads", "update"),
      userHasPermission(req.user, "deals", "write"),
      userHasPermission(req.user, "deals", "update"),
      userHasPermission(req.user, "deals", "read"),
      userHasPermission(req.user, "pipeline", "read"),
      userHasPermission(req.user, "reports", "read"),
    ]);
    const result = await assistant.handleChatMessage({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: req.user.role,
      canLeadWrite,
      canLeadUpdate,
      canDealWrite,
      canDealUpdate,
      canDealRead,
      canPipelineRead,
      canReportRead,
      message: body.message,
      history: Array.isArray(body.history) ? body.history.slice(-20) : [],
      selectedLeadId: context.selectedLeadId,
      activeFilters: context.activeFilters,
    });
    return res.json(result);
  } catch (error) {
    if (["MISSING_MESSAGE", "INVALID_DATE", "LEAD_ID_REQUIRED", "INVALID_REPORT_TYPE"].includes(error.code)) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    if (error.code === "AI_PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: error.message, code: error.code });
    }
    if (error.code === "AI_PROVIDER_RATE_LIMITED") {
      return res.status(429).json({ error: error.message, code: error.code });
    }
    console.error("[generic-leads-assistant] message error:", error.message);
    return res.status(502).json({ error: "The AI provider could not answer right now. Please try again.", code: "AI_PROVIDER_ERROR" });
  }
});

router.post("/report/export", verifyToken, requireGenericTenant, requirePermission("reports", "read"), async (req, res) => {
  try {
    const body = req.body || {};
    const reportType = String(body.reportType || "summary").toLowerCase();
    const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters) ? body.filters : {};
    const format = String(body.format || "").toLowerCase();
    const result = await assistant.exportLeadReport({ reportType, filters, format }, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      role: req.user.role,
      canReportRead: true,
    });
    res.set({
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.buffer.length),
      "Cache-Control": "no-store",
    });
    return res.send(result.buffer);
  } catch (error) {
    if (["INVALID_REPORT_FORMAT", "INVALID_REPORT_TYPE", "INVALID_DATE"].includes(error.code)) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    console.error("[generic-leads-assistant] report export error:", error.message);
    return res.status(500).json({ error: "The lead report could not be generated.", code: "REPORT_EXPORT_FAILED" });
  }
});

router.post(
  "/confirm",
  verifyToken,
  requireGenericTenant,
  requireAnyPermission([
    { module: "leads", action: "write" },
    { module: "leads", action: "update" },
    { module: "deals", action: "write" },
    { module: "deals", action: "update" },
  ]),
  async (req, res) => {
    try {
      const [canLeadWrite, canLeadUpdate, canDealWrite, canDealUpdate] = await Promise.all([
        userHasPermission(req.user, "leads", "write"),
        userHasPermission(req.user, "leads", "update"),
        userHasPermission(req.user, "deals", "write"),
        userHasPermission(req.user, "deals", "update"),
      ]);
      const result = await assistant.executeConfirmedAction({
        action: req.body?.action,
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        role: req.user.role,
        canLeadWrite,
        canLeadUpdate,
        canDealWrite,
        canDealUpdate,
      });
      return res.json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
      console.error("[generic-leads-assistant] confirmation error:", error.message);
      return res.status(500).json({ error: "The requested CRM action could not be completed.", code: "ACTION_FAILED" });
    }
  },
);

module.exports = router;
