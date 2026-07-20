/**
 * /api/support-chat — Wellness Admin Support Chatbot endpoints.
 *
 *   POST /message    — one chat turn through the LLM tool loop
 *                      (search_help_docs / get_page_info).
 *   GET  /analytics  — ADMIN-only rollup of LlmCallLog task='support-chat'
 *                      rows (adoption / tokens / cost / failures).
 *
 * Both are wellness-tenant gated: the chatbot only exists for the
 * wellness vertical (the widget renders only there), so non-wellness
 * tenants get a clean 403 rather than a spend path on a shared key.
 *
 * Error contract:
 *   - 503 AI_PROVIDER_NOT_CONFIGURED — no BYOK config and (in production)
 *     no internal fallback. Friendly message; the widget renders it as a
 *     chat bubble, not a toast.
 *   - 502 AI_PROVIDER_ERROR — the upstream provider call failed.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole, RBAC_DENIED_MESSAGE } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const chatbot = require("../services/supportChatbot");

// Wellness-tenant gate. Mirrors middleware/wellnessRole.js's vertical
// resolution (JWT claim first, cached Tenant lookup fallback) but carries
// no wellnessRole requirement — any authenticated wellness staff member
// may use the support chatbot.
async function requireWellnessTenant(req, res, next) {
  try {
    let vertical = req.user && req.user.vertical;
    if (!vertical && req.user && req.user.tenantId) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { vertical: true },
      });
      vertical = (tenant && tenant.vertical) || "generic";
      req.user.vertical = vertical; // memoize for downstream middleware
    }
    if (vertical !== "wellness") {
      return res.status(403).json({
        error: RBAC_DENIED_MESSAGE,
        code: "WELLNESS_TENANT_REQUIRED",
      });
    }
    return next();
  } catch (e) {
    console.error("[support-chat] vertical check failed:", e.message);
    return res.status(500).json({ error: "Failed to verify tenant vertical" });
  }
}

// ─── POST /message — one chat turn ────────────────────────────────────
//
// Body: { message: string, history?: [{role, content}], pageContext?:
// { path, pageName } }. Response: { reply, links, ticket, toolsUsed }.
router.post("/message", verifyToken, requireWellnessTenant, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.message || typeof body.message !== "string" || !body.message.trim()) {
      return res.status(400).json({ error: "message is required", code: "MISSING_MESSAGE" });
    }
    // Bounded inputs: history capped server-side too (service also caps),
    // pageContext whittled to the two fields the prompt builder reads.
    const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
    const pageContext =
      body.pageContext && typeof body.pageContext === "object"
        ? {
            path: String(body.pageContext.path || "").slice(0, 200),
            pageName: String(body.pageContext.pageName || "").slice(0, 120),
          }
        : null;

    const result = await chatbot.handleChatMessage({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      message: body.message,
      history,
      pageContext,
    });
    return res.json(result);
  } catch (e) {
    if (e.code === "AI_PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: e.message, code: e.code });
    }
    if (e.code === "MISSING_MESSAGE") {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    console.error("[support-chat] message error:", e.message);
    return res.status(502).json({
      error: "The AI provider could not answer right now. Please try again.",
      code: "AI_PROVIDER_ERROR",
    });
  }
});

// ─── GET /analytics — ADMIN rollup over LlmCallLog ───────────────────
router.get(
  "/analytics",
  verifyToken,
  requireWellnessTenant,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const analytics = await chatbot.getAnalytics(req.user.tenantId);
      return res.json(analytics);
    } catch (e) {
      console.error("[support-chat] analytics error:", e.message);
      return res.status(500).json({ error: "Failed to load support chat analytics" });
    }
  },
);

module.exports = router;
