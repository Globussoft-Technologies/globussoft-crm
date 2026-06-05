// ─────────────────────────────────────────────────────────────────
// Per-tenant payment-gateway configuration (#848 minimal slice).
//
// Lets a tenant ADMIN bring their OWN Razorpay merchant keys so their
// customers' payments settle into the tenant's account. Mirrors the
// SMS / WhatsApp provider-config routes verbatim: GET returns masked
// `{ configured, last4 }` shapes; PUT requires the FULL fresh secret and
// treats masked-sentinel echoes as "unchanged" (skip). Secrets are
// AES-256-GCM-encrypted at rest via credentialMasking.
//
// NOTE: this is the TENANT's gateway (customer → tenant). The platform's
// own Razorpay account (subscription billing, tenant → Globussoft) stays
// in env vars and is configured by ops, not here.
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const {
  encryptCredential,
  looksLikeMaskedSentinel,
  maskConfigRow,
} = require("../lib/credentialMasking");
const { writeAudit } = require("../lib/audit");

const router = express.Router();

const PROVIDER = "razorpay";
// Secret fields masked on GET / sentinel-skipped on PUT. keyId is the public
// rzp_… identifier (ships to the browser checkout) so it is NOT masked.
// Only Key Secret is collected — same two values as the platform .env
// (RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET); there is no separate webhook secret.
const SECRET_FIELDS = ["keySecret"];
// The schema still carries a webhookSecret column (forward-compat) but the
// minimal slice never collects or exposes it — strip it from GET responses.
const HIDDEN_FIELDS = ["webhookSecret"];

function toClientRow(row) {
  const masked = maskConfigRow(row, SECRET_FIELDS);
  for (const f of HIDDEN_FIELDS) delete masked[f];
  return masked;
}

// GET /api/payment-gateways — list this tenant's gateway configs (masked).
// MANAGER + ADMIN may read (operations can audit settings without write).
router.get(
  "/",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const configs = await prisma.paymentGatewayConfig.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: { createdAt: "desc" },
      });
      res.json(configs.map(toClientRow));
    } catch (err) {
      console.error("[payment-gateways] list error:", err);
      res.status(500).json({ error: "Failed to fetch payment gateway config" });
    }
  },
);

// PUT /api/payment-gateways/razorpay — upsert the tenant's Razorpay keys.
// ADMIN only. Full fresh secret required for any rotated field; masked
// sentinels echoed back from GET are skipped (preserve stored value).
router.put(
  "/:provider",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { provider } = req.params;
      if (provider !== PROVIDER) {
        return res.status(400).json({
          error: `Unsupported gateway provider '${provider}'. Only 'razorpay' is supported.`,
          code: "UNSUPPORTED_PROVIDER",
        });
      }

      const { keyId, isActive } = req.body || {};

      // keyId is the public identifier — light validation only. Allow empty
      // (config-not-finished is legitimate); reject an obviously-wrong shape
      // when set so a typo doesn't silently break checkout later.
      if (typeof keyId === "string" && keyId.length > 0 && !/^rzp_/.test(keyId)) {
        return res.status(400).json({
          error: "Razorpay Key ID must start with 'rzp_' (e.g. rzp_live_… or rzp_test_…)",
          code: "INVALID_KEY_ID",
        });
      }

      // Strip masked sentinels (same contract as SMS/WhatsApp config): the
      // frontend echoes the GET shape ({configured,last4}) for non-rotated
      // secrets, so only a fresh plaintext string counts as a rotation.
      const rotatedFields = [];
      const cleanSecrets = {};
      for (const f of SECRET_FIELDS) {
        const v = req.body[f];
        if (v === undefined) continue;
        if (v === null || v === "") {
          cleanSecrets[f] = null; // explicit clear
          rotatedFields.push(f);
          continue;
        }
        if (typeof v === "object") continue; // GET shape echoed back — skip
        if (typeof v !== "string") continue; // ignore garbage
        if (looksLikeMaskedSentinel(v)) continue; // unchanged masked sentinel
        cleanSecrets[f] = encryptCredential(v);
        rotatedFields.push(f);
      }

      const stampRotation = rotatedFields.length > 0;

      const config = await prisma.paymentGatewayConfig.upsert({
        where: {
          tenantId_provider: { tenantId: req.user.tenantId, provider },
        },
        create: {
          provider,
          keyId: keyId || null,
          keySecret:
            cleanSecrets.keySecret !== undefined ? cleanSecrets.keySecret : null,
          isActive: isActive !== undefined ? !!isActive : false,
          tenantId: req.user.tenantId,
          ...(stampRotation && { lastRotatedAt: new Date() }),
        },
        update: {
          ...cleanSecrets,
          ...(keyId !== undefined && { keyId: keyId || null }),
          ...(isActive !== undefined && { isActive: !!isActive }),
          ...(stampRotation && { lastRotatedAt: new Date() }),
        },
      });

      await writeAudit(
        "PaymentGatewayConfig",
        stampRotation ? "ROTATE" : "UPDATE",
        config.id,
        req.user.userId,
        req.user.tenantId,
        { provider, rotatedFields, isActive: config.isActive },
      );

      res.json({
        success: true,
        config: toClientRow(config),
      });
    } catch (err) {
      console.error("[payment-gateways] upsert error:", err);
      res.status(500).json({ error: "Failed to save payment gateway config" });
    }
  },
);

// DELETE /api/payment-gateways/razorpay — remove the tenant's Razorpay config
// entirely. ADMIN only. After this, customer-payment buttons go back to the
// "not configured" state until keys are re-added. Historic Payment rows are
// untouched (they reference the gateway by name, not by FK), so no payment
// history is lost. Idempotent: deleting a non-existent config returns success.
router.delete(
  "/:provider",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { provider } = req.params;
      if (provider !== PROVIDER) {
        return res.status(400).json({
          error: `Unsupported gateway provider '${provider}'. Only 'razorpay' is supported.`,
          code: "UNSUPPORTED_PROVIDER",
        });
      }

      const existing = await prisma.paymentGatewayConfig.findFirst({
        where: { tenantId: req.user.tenantId, provider },
        select: { id: true },
      });

      const result = await prisma.paymentGatewayConfig.deleteMany({
        where: { tenantId: req.user.tenantId, provider },
      });

      if (existing) {
        await writeAudit(
          "PaymentGatewayConfig",
          "DELETE",
          existing.id,
          req.user.userId,
          req.user.tenantId,
          { provider },
        );
      }

      res.json({ success: true, deleted: result.count });
    } catch (err) {
      console.error("[payment-gateways] delete error:", err);
      res.status(500).json({ error: "Failed to delete payment gateway config" });
    }
  },
);

module.exports = router;
