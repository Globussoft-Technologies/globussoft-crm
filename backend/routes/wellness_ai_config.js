/**
 * /api/wellness/ai-provider-config — BYOK management for the Wellness
 * Admin Support Chatbot.
 *
 *   GET    /ai-provider-config        — current config, apiKey MASKED
 *                                       (sk-...XXXX). Never returns the
 *                                       raw key, never logs it.
 *   POST   /ai-provider-config        — upsert { provider, apiKey, model,
 *                                       baseUrl }. apiKey is encrypted at
 *                                       rest (lib/fieldEncryption AES-256-GCM)
 *                                       inside the TenantSetting JSON blob.
 *   POST   /ai-provider-config/test   — live round-trip against the
 *                                       provider ("ping") using either the
 *                                       saved config or ad-hoc body values
 *                                       (so an admin can test BEFORE saving).
 *   DELETE /ai-provider-config        — remove the BYOK config (falls back
 *                                       to the internal proxy outside
 *                                       production; disables the bot in
 *                                       production).
 *
 * All routes: verifyToken + wellness tenant + ADMIN. The config is
 * tenant-scoped via TenantSetting (KEYS.WELLNESS_AI_PROVIDER_CONFIG).
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole, RBAC_DENIED_MESSAGE } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { setSetting, KEYS } = require("../lib/tenantSettings");
const { encrypt, decrypt } = require("../lib/fieldEncryption");
const { writeAudit } = require("../lib/audit");
const {
  SUPPORTED_PROVIDERS,
  DEFAULT_GEMINI_MODEL,
  maskApiKey,
  validateProviderBaseUrl,
  resolveProviderConfig,
  generateChatCompletion,
} = require("../services/supportChatbot/providerAdapters");

// Wellness-tenant gate — mirror of the same middleware in
// routes/support_chat.js (route files here stay self-contained; see the
// vertical-resolution comment in middleware/wellnessRole.js).
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

// Reads + parses the stored blob. Returns null when unset/corrupt. The
// apiKey comes back DECRYPTED — callers must only ever expose it masked.
async function readStoredConfig(tenantId) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: KEYS.WELLNESS_AI_PROVIDER_CONFIG } },
    select: { value: true, updatedAt: true },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || !parsed.provider || !parsed.apiKey) return null;
    return { ...parsed, apiKey: decrypt(parsed.apiKey), updatedAt: row.updatedAt };
  } catch (_e) {
    return null;
  }
}

function publicView(stored) {
  return {
    configured: true,
    provider: stored.provider,
    model: stored.model || null,
    baseUrl: stored.baseUrl || null,
    maskedApiKey: maskApiKey(stored.apiKey),
    updatedAt: stored.updatedAt || null,
  };
}

// ─── GET /ai-provider-config ──────────────────────────────────────────
router.get("/ai-provider-config", gate, async (req, res) => {
  try {
    const stored = await readStoredConfig(req.user.tenantId);
    if (stored) return res.json(publicView(stored));
    // No BYOK row — report which fallback (if any) the chatbot will use.
    const fallback = await resolveProviderConfig(req.user.tenantId);
    return res.json({
      configured: false,
      fallback: fallback ? fallback.source : "none",
      model: fallback ? fallback.model : null,
    });
  } catch (e) {
    console.error("[wellness-ai-config] get error:", e.message);
    return res.status(500).json({ error: "Failed to load AI provider config" });
  }
});

// ─── POST /ai-provider-config ─────────────────────────────────────────
//
// Body: { provider, apiKey?, model?, baseUrl? }. On first save apiKey is
// required. On subsequent edits, sending the masked placeholder (or an
// empty apiKey) keeps the stored key — lets an admin rotate model/baseUrl
// without re-entering the secret.
router.post("/ai-provider-config", gate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const body = req.body || {};
    const provider = String(body.provider || "");
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
        code: "INVALID_PROVIDER",
        supportedProviders: SUPPORTED_PROVIDERS,
      });
    }

    const existing = await readStoredConfig(tenantId);
    const incomingKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const looksMasked = incomingKey.includes("...") || incomingKey.startsWith("••");

    let apiKey;
    if (incomingKey && !looksMasked) {
      apiKey = incomingKey;
    } else if (existing && existing.provider === provider) {
      apiKey = existing.apiKey; // keep the stored key
    } else {
      return res.status(400).json({ error: "apiKey is required", code: "MISSING_API_KEY" });
    }

    const model =
      (typeof body.model === "string" && body.model.trim()) ||
      (provider === "gemini" ? DEFAULT_GEMINI_MODEL : existing && existing.model) ||
      null;
    if (provider === "openai-compatible" && !model) {
      return res.status(400).json({
        error: "model is required for openai-compatible providers",
        code: "MISSING_MODEL",
      });
    }
    const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : null;
    try {
      validateProviderBaseUrl(provider, baseUrl);
    } catch (urlErr) {
      return res.status(400).json({ error: urlErr.message, code: urlErr.code });
    }

    const blob = JSON.stringify({ provider, apiKey: encrypt(apiKey), model, baseUrl });
    await setSetting(tenantId, KEYS.WELLNESS_AI_PROVIDER_CONFIG, blob, { category: "integrations" });

    // Audit WITHOUT the key — masked form only (the key must never appear
    // in logs or the audit chain).
    await writeAudit("TenantSetting", existing ? "UPDATE" : "CREATE", null, req.user.userId, tenantId, {
      key: KEYS.WELLNESS_AI_PROVIDER_CONFIG,
      provider,
      model,
      maskedApiKey: maskApiKey(apiKey),
    });

    return res.json(publicView({ provider, apiKey, model, baseUrl, updatedAt: new Date() }));
  } catch (e) {
    console.error("[wellness-ai-config] save error:", e.message);
    return res.status(500).json({ error: "Failed to save AI provider config" });
  }
});

// ─── POST /ai-provider-config/test ────────────────────────────────────
//
// Live round-trip. Body MAY carry { provider, apiKey, model, baseUrl } to
// test unsaved values; otherwise the saved config is tested. The probe is
// a minimal 1-turn generation ("Reply with exactly: OK") with no tools.
router.post("/ai-provider-config/test", gate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const body = req.body || {};

    let config = null;
    if (body.provider && body.apiKey && !String(body.apiKey).includes("...")) {
      config = {
        provider: String(body.provider),
        apiKey: String(body.apiKey),
        model: body.model || (body.provider === "gemini" ? DEFAULT_GEMINI_MODEL : null),
        baseUrl: body.baseUrl || null,
        source: "ad-hoc",
      };
      try {
        validateProviderBaseUrl(config.provider, config.baseUrl, { source: "ad-hoc" });
      } catch (urlErr) {
        return res.status(400).json({ error: urlErr.message, code: urlErr.code });
      }
    } else {
      config = await resolveProviderConfig(tenantId);
    }
    if (!config) {
      return res.status(404).json({
        error: "No AI provider configured to test.",
        code: "AI_PROVIDER_NOT_CONFIGURED",
      });
    }

    const started = Date.now();
    try {
      const resp = await generateChatCompletion(config, {
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      });
      return res.json({
        ok: true,
        provider: config.provider,
        model: resp.model || config.model,
        latencyMs: Date.now() - started,
        sample: (resp.text || "").slice(0, 60),
      });
    } catch (callErr) {
      // Surface status/family only — upstream bodies can echo secrets.
      return res.status(502).json({
        ok: false,
        provider: config.provider,
        error: `Provider call failed (${callErr.status || "network error"}). Check the API key, model and base URL.`,
        code: "AI_PROVIDER_ERROR",
      });
    }
  } catch (e) {
    console.error("[wellness-ai-config] test error:", e.message);
    return res.status(500).json({ error: "Failed to test AI provider config" });
  }
});

// ─── DELETE /ai-provider-config ───────────────────────────────────────
router.delete("/ai-provider-config", gate, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const existing = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: KEYS.WELLNESS_AI_PROVIDER_CONFIG } },
      select: { id: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "AI provider config not found", code: "NOT_FOUND" });
    }
    await prisma.tenantSetting.delete({
      where: { tenantId_key: { tenantId, key: KEYS.WELLNESS_AI_PROVIDER_CONFIG } },
    });
    await writeAudit("TenantSetting", "DELETE", existing.id, req.user.userId, tenantId, {
      key: KEYS.WELLNESS_AI_PROVIDER_CONFIG,
    });
    return res.status(204).end();
  } catch (e) {
    console.error("[wellness-ai-config] delete error:", e.message);
    return res.status(500).json({ error: "Failed to delete AI provider config" });
  }
});

module.exports = router;
