const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// ---------- Helpers ----------

function generateBackupCode() {
  // 8-char alphanumeric code (uppercase, no ambiguous chars)
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function generateBackupCodeSet(count = 10) {
  const plain = [];
  const hashed = [];
  for (let i = 0; i < count; i++) {
    const code = generateBackupCode();
    plain.push(code);
    hashed.push(await bcrypt.hash(code, 10));
  }
  return { plain, hashed };
}

function verifyTotp(secretBase32, token) {
  if (!secretBase32 || !token) return false;
  return speakeasy.totp.verify({
    secret: secretBase32,
    encoding: "base32",
    token: String(token).trim(),
    window: 1, // allow ±30s clock drift
  });
}

// ---------- POST /setup ----------
// Generate a TOTP secret, save (not enabled), return secret + QR data URL.
router.post("/setup", verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const secret = speakeasy.generateSecret({
      name: `Globussoft CRM (${user.email})`,
      issuer: "Globussoft CRM",
      length: 20,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret.base32 },
    });

    const qrCode = await QRCode.toDataURL(secret.otpauth_url);

    res.json({ secret: secret.base32, qrCode });
  } catch (err) {
    console.error("[2fa] setup error:", err);
    res.status(500).json({ error: "Failed to initialize 2FA setup" });
  }
});

// ---------- POST /enable ----------
// Verify TOTP, enable 2FA, generate + return backup codes (plaintext, ONCE).
router.post("/enable", verifyToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Verification code is required" });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.twoFactorSecret) {
      return res.status(400).json({ error: "2FA setup has not been initialized. Call /setup first." });
    }

    if (!verifyTotp(user.twoFactorSecret, code)) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    const { plain, hashed } = await generateBackupCodeSet(10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        backupCodes: JSON.stringify(hashed),
      },
    });

    res.json({ success: true, backupCodes: plain });
  } catch (err) {
    console.error("[2fa] enable error:", err);
    res.status(500).json({ error: "Failed to enable 2FA" });
  }
});

// ---------- POST /disable ----------
// Requires current password + current TOTP code. Clears 2FA state.
router.post("/disable", verifyToken, async (req, res) => {
  try {
    const { password, code } = req.body;
    if (!password || !code) {
      return res.status(400).json({ error: "Password and verification code are required" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.twoFactorEnabled) {
      return res.status(400).json({ error: "2FA is not enabled on this account" });
    }

    const passwordOk = await bcrypt.compare(password, user.password);
    if (!passwordOk) return res.status(400).json({ error: "Current password is incorrect" });

    if (!verifyTotp(user.twoFactorSecret, code)) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        backupCodes: null,
      },
    });

    res.json({ success: true, message: "2FA disabled successfully" });
  } catch (err) {
    console.error("[2fa] disable error:", err);
    res.status(500).json({ error: "Failed to disable 2FA" });
  }
});

// ---------- POST /verify ----------
// NO verifyToken middleware — accepts a short-lived tempToken from /auth/login.
// Returns final 7-day JWT + user + tenant on success.
router.post("/verify", async (req, res) => {
  try {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) {
      return res.status(400).json({ error: "Temp token and verification code are required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(tempToken, JWT_SECRET);
    } catch (err) {
      if (err && err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "2FA challenge expired, please log in again" });
      }
      return res.status(401).json({ error: "Invalid 2FA challenge token" });
    }

    if (!decoded || decoded.awaiting2FA !== true || !decoded.userId) {
      return res.status(401).json({ error: "Invalid 2FA challenge token" });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { tenant: true },
    });
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(400).json({ error: "2FA is not enabled for this account" });
    }

    let verified = verifyTotp(user.twoFactorSecret, code);
    let consumedBackupCode = false;

    // Fallback: backup code
    if (!verified && user.backupCodes) {
      try {
        const hashedCodes = JSON.parse(user.backupCodes);
        if (Array.isArray(hashedCodes)) {
          const submitted = String(code).trim().toUpperCase();
          for (let i = 0; i < hashedCodes.length; i++) {
            if (await bcrypt.compare(submitted, hashedCodes[i])) {
              hashedCodes.splice(i, 1);
              await prisma.user.update({
                where: { id: user.id },
                data: { backupCodes: JSON.stringify(hashedCodes) },
              });
              verified = true;
              consumedBackupCode = true;
              break;
            }
          }
        }
      } catch (e) {
        console.error("[2fa] backup code parse error:", e);
      }
    }

    if (!verified) {
      return res.status(401).json({ error: "Invalid verification code" });
    }

    const tenantId = user.tenantId || 1;
    const token = jwt.sign(
      { userId: user.id, role: user.role, tenantId },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: user.tenant
        ? { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, plan: user.tenant.plan }
        : { id: tenantId },
      backupCodeUsed: consumedBackupCode,
    });
  } catch (err) {
    console.error("[2fa] verify error:", err);
    res.status(500).json({ error: "Failed to verify 2FA code" });
  }
});

module.exports = router;
