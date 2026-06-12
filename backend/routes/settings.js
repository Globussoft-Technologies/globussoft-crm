const express = require("express");
const crypto = require("crypto");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { encrypt } = require("../lib/fieldEncryption");
const { isTenantWebhookEntitled } = require("../lib/webhookEntitlement");

const router = express.Router();
const prisma = require("../lib/prisma");

// ── Webhook Signing Credential (per-tenant HMAC secret) ──────────────
//
// Lives under /api/settings (surfaced in the Settings page → "Webhook Signing
// Credential" card) rather than the Developer page. Replaces the single global
// process.env.WEBHOOK_HMAC_SECRET: each tenant gets its OWN HMAC secret,
// generated + managed by an ADMIN, used to sign every outbound webhook for that
// tenant (see lib/webhookDelivery.js + lib/webhookEntitlement.js).
//
// Show-once model (Stripe/GitHub/AWS): the raw secret is returned ONLY in the
// generate/rotate response — never re-served. The GET below exposes status +
// metadata, never secret bytes. Lost secret ⇒ rotate + reconfigure the
// receiver. Generation/rotation are subscription-gated (402 when the tenant
// has no active paid subscription and no active trial). ADMIN-only.

// Static config a receiver (e.g. GlobusPhone) needs to verify our signatures.
const WEBHOOK_SIGNING_INFO = {
  header: "X-Globussoft-Signature",
  algorithm: "HMAC-SHA256",
  signedPayload: "<t>.<rawBody>", // HMAC-SHA256(secret, "<t>.<body>") == v1
  receiverEnvVar: "WEBHOOK_HMAC_SECRET_CRM", // GlobusPhone's inbound-verify env name
};

// Public, non-secret reference id for a credential — lets a config/UI name
// "which key" without exposing the secret. Not used in signing.
function newSigningId() {
  return `whid_${crypto.randomBytes(8).toString("hex")}`;
}

// 64-hex (32-byte) HMAC secret, matching the `openssl rand -hex 32` the env
// docs recommended for the legacy global secret.
function newWebhookSecret() {
  return crypto.randomBytes(32).toString("hex");
}

// Public projection of a credential row — NEVER includes the raw secret.
// secretMasked is a non-recoverable hint derived from the PUBLIC signingId.
function publicCredentialView(cred) {
  if (!cred) return { exists: false, status: null, signingId: null, lastRotatedAt: null, createdAt: null, secretMasked: null };
  return {
    exists: true,
    status: cred.status,
    signingId: cred.signingId,
    lastRotatedAt: cred.lastRotatedAt,
    createdAt: cred.createdAt,
    secretMasked: `whsec_••••••${cred.signingId.slice(-4)}`,
  };
}

// GET — current tenant's signing credential status + entitlement. Safe to
// call in any state (no credential / revoked / active); never leaks the secret.
router.get("/webhook-credential", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { tenantId } = req.user;
    const cred = await prisma.webhookCredential.findUnique({ where: { tenantId } });
    const { entitled, reason } = await isTenantWebhookEntitled(tenantId);
    res.json({
      ...publicCredentialView(cred),
      entitled,
      entitlementReason: reason,
      signing: WEBHOOK_SIGNING_INFO,
    });
  } catch (err) {
    console.error("[settings/webhook-credential GET]", err);
    res.status(500).json({ error: "Failed to read webhook credential." });
  }
});

// POST — generate the tenant's signing secret. Entitlement-gated. Returns the
// raw secret ONCE (the only time it is ever exposed). 409 if an ACTIVE
// credential already exists (rotate instead); a previously REVOKED row is
// reactivated with a fresh secret.
router.post("/webhook-credential", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { tenantId, userId } = req.user;

    const { entitled, reason } = await isTenantWebhookEntitled(tenantId);
    if (!entitled) {
      return res.status(402).json({
        error: "No active subscription. Webhook generation requires an active subscription or trial.",
        code: "NO_ACTIVE_SUBSCRIPTION",
        entitlementReason: reason,
        upgradeUrl: "/pricing",
      });
    }

    const existing = await prisma.webhookCredential.findUnique({ where: { tenantId } });
    if (existing && existing.status === "ACTIVE") {
      return res.status(409).json({
        error: "A signing credential already exists. Rotate it instead of generating a new one.",
        code: "CREDENTIAL_EXISTS",
      });
    }

    const rawSecret = newWebhookSecret();
    const signingId = newSigningId();
    const data = {
      secret: encrypt(rawSecret), // ENC:v1:... when WELLNESS_FIELD_KEY set, else raw
      signingId,
      status: "ACTIVE",
      createdById: userId,
    };

    const cred = existing
      ? await prisma.webhookCredential.update({
          where: { tenantId },
          data: { ...data, lastRotatedAt: new Date() }, // reactivating a revoked row
        })
      : await prisma.webhookCredential.create({ data: { ...data, tenantId } });

    // The raw secret is surfaced HERE and nowhere else — show-once.
    res.status(201).json({
      ...publicCredentialView(cred),
      secret: rawSecret,
      signing: WEBHOOK_SIGNING_INFO,
      warning: "Save this secret now — it will not be shown again. If you lose it, rotate the credential.",
    });
  } catch (err) {
    console.error("[settings/webhook-credential POST]", err);
    res.status(500).json({ error: "Failed to generate webhook credential." });
  }
});

// POST /rotate — replace the secret. Entitlement-gated. Returns the new raw
// secret once; the old value becomes unrecoverable. Also reactivates a
// revoked credential (status → ACTIVE).
router.post("/webhook-credential/rotate", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { tenantId } = req.user;

    const { entitled, reason } = await isTenantWebhookEntitled(tenantId);
    if (!entitled) {
      return res.status(402).json({
        error: "No active subscription. Rotating a signing secret requires an active subscription or trial.",
        code: "NO_ACTIVE_SUBSCRIPTION",
        entitlementReason: reason,
        upgradeUrl: "/pricing",
      });
    }

    const existing = await prisma.webhookCredential.findUnique({ where: { tenantId } });
    if (!existing) {
      return res.status(404).json({
        error: "No signing credential to rotate. Generate one first.",
        code: "CREDENTIAL_NOT_FOUND",
      });
    }

    const rawSecret = newWebhookSecret();
    const cred = await prisma.webhookCredential.update({
      where: { tenantId },
      data: {
        secret: encrypt(rawSecret),
        signingId: newSigningId(),
        status: "ACTIVE",
        lastRotatedAt: new Date(),
      },
    });

    res.json({
      ...publicCredentialView(cred),
      secret: rawSecret,
      signing: WEBHOOK_SIGNING_INFO,
      warning: "Save this secret now — it will not be shown again. Update your receiver (e.g. GlobusPhone) with the new value.",
    });
  } catch (err) {
    console.error("[settings/webhook-credential rotate]", err);
    res.status(500).json({ error: "Failed to rotate webhook credential." });
  }
});

// DELETE — revoke. Delivery stops immediately (the entitlement+secret resolver
// in webhookDelivery.js will no longer match an ACTIVE credential). The row is
// kept (status REVOKED) rather than deleted so it can be reactivated by
// generating/rotating. No entitlement gate — revoking must always be possible.
router.delete("/webhook-credential", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { tenantId } = req.user;
    const existing = await prisma.webhookCredential.findUnique({ where: { tenantId } });
    if (!existing) {
      return res.status(404).json({ error: "No signing credential found.", code: "CREDENTIAL_NOT_FOUND" });
    }
    const cred = await prisma.webhookCredential.update({
      where: { tenantId },
      data: { status: "REVOKED" },
    });
    res.json({ success: true, ...publicCredentialView(cred) });
  } catch (err) {
    console.error("[settings/webhook-credential DELETE]", err);
    res.status(500).json({ error: "Failed to revoke webhook credential." });
  }
});

module.exports = router;
