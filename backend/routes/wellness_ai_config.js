const express = require("express");
const router = express.Router();

const { verifyToken, verifyRole, RBAC_DENIED_MESSAGE } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  getTenantAiState,
  saveByokConfig,
  removeByokConfig,
  testProviderConnection,
  resolveProviderConfig,
  generateChatCompletion,
} = require("../lib/aiProviderManagement");

async function requireWellnessTenant(req, res, next) {
  try {
    let vertical = req.user && req.user.vertical;
    if (!vertical && req.user && req.user.tenantId) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { vertical: true },
      });
      vertical = (tenant && tenant.vertical) || "generic";
      req.user.vertical = vertical;
    }
    if (vertical !== "wellness") {
      return res.status(403).json({
        error: RBAC_DENIED_MESSAGE,
        code: "WELLNESS_TENANT_REQUIRED",
      });
    }
    return next();
  } catch (e) {
    console.error("[wellness-ai-config] vertical check failed:", e.message);
    return res.status(500).json({ error: "Failed to verify tenant vertical" });
  }
}

const gate = [verifyToken, requireWellnessTenant, verifyRole(["ADMIN"])];

router.get("/ai-provider-config", gate, async (req, res) => {
  try {
    const state = await getTenantAiState(req.user.tenantId);
    if (state.byokConfigured && state.byok) {
      return res.json({
        configured: true,
        provider: state.byok.providerId === "openai" ? "openai-compatible" : state.byok.providerId,
        model: state.byok.model || null,
        baseUrl: state.byok.baseUrl || null,
        maskedApiKey: state.byok.maskedApiKey || null,
        updatedAt: state.byok.updatedAt || null,
      });
    }
    return res.json({
      configured: false,
      fallback: state.resolverAccess === "crm-managed" ? "internal" : "none",
      model: null,
    });
  } catch (e) {
    console.error("[wellness-ai-config] get error:", e.message);
    return res.status(500).json({ error: "Failed to load AI provider config" });
  }
});

router.post("/ai-provider-config", gate, async (req, res) => {
  try {
    const body = req.body || {};
    const providerId = body.provider === "openai-compatible" ? "openai" : body.provider;
    const saved = await saveByokConfig({
      tenantId: req.user.tenantId,
      actorUserId: req.user.userId,
      providerId,
      apiKey: body.apiKey || "",
      model: body.model || "",
      baseUrl: body.baseUrl || "",
    });
    return res.json({
      configured: true,
      provider: body.provider || providerId,
      model: saved.model,
      baseUrl: saved.baseUrl,
      maskedApiKey: saved.maskedApiKey,
      updatedAt: saved.updatedAt,
    });
  } catch (e) {
    const status = e.code && /INVALID|MISSING|UNSUPPORTED/.test(e.code) ? 400 : 500;
    return res.status(status).json({ error: e.message, code: e.code || "AI_PROVIDER_SAVE_FAILED" });
  }
});

router.post("/ai-provider-config/test", gate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const body = req.body || {};
    if (body.provider && body.apiKey && !String(body.apiKey).includes("...")) {
      const providerId = body.provider === "openai-compatible" ? "openai" : body.provider;
      const result = await testProviderConnection({
        providerId,
        apiKey: body.apiKey,
        model: body.model,
        baseUrl: body.baseUrl,
      });
      return res.json({
        ok: true,
        provider: body.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        sample: result.sample,
      });
    }

    const config = await resolveProviderConfig(tenantId);
    if (!config) {
      return res.status(404).json({
        error: "No AI provider configured to test.",
        code: "AI_PROVIDER_NOT_CONFIGURED",
      });
    }

    const started = Date.now();
    const resp = await generateChatCompletion(config, {
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
    return res.json({
      ok: true,
      provider: config.family === "openai-compatible" ? "openai-compatible" : config.providerId,
      model: resp.model || config.model,
      latencyMs: Date.now() - started,
      sample: (resp.text || "").slice(0, 60),
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: `Provider call failed (${e.status || "network error"}). Check the API key, model and base URL.`,
      code: "AI_PROVIDER_ERROR",
    });
  }
});

router.delete("/ai-provider-config", gate, async (req, res) => {
  try {
    await removeByokConfig({
      tenantId: req.user.tenantId,
      actorUserId: req.user.userId,
    });
    return res.status(204).end();
  } catch (e) {
    console.error("[wellness-ai-config] delete error:", e.message);
    return res.status(500).json({ error: "Failed to delete AI provider config" });
  }
});

module.exports = router;
