const path = require("path");
// Try to load root .env (where shared API keys live) — non-fatal if missing.
try {
  require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
} catch (e) {
  // dotenv missing or root .env not present — process.env is still honored.
}

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// ── Configuration helpers ─────────────────────────────────────────

function getFrontendBase(req) {
  return process.env.FRONTEND_URL || `${req.protocol}://${req.get("host")}`;
}

function getBackendBase(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
}

function getGoogleConfig(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${getBackendBase(req)}/api/sso/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

function getMicrosoftConfig(req) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenantPath = process.env.MICROSOFT_TENANT || "common";
  const redirectUri =
    process.env.MICROSOFT_REDIRECT_URI ||
    `${getBackendBase(req)}/api/sso/microsoft/callback`;
  return { clientId, clientSecret, redirectUri, tenantPath };
}

async function generateUniqueSlug(base) {
  const root = (base || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
  let slug = root;
  let i = 1;
  while (await prisma.tenant.findUnique({ where: { slug } })) {
    i += 1;
    slug = `${root}-${i}`;
  }
  return slug;
}

// Find-or-create user given a verified SSO identity. Creates a new tenant for net-new users.
async function findOrCreateSsoUser({ provider, providerId, email, name }) {
  if (!email) throw new Error("SSO provider did not return an email");

  const providerIdField = provider === "google" ? "googleId" : "microsoftId";

  // 1. Look up by provider id
  let user = await prisma.user.findFirst({
    where: { [providerIdField]: providerId },
    include: { tenant: true },
  });
  if (user) return user;

  // 2. Look up by email — link existing local account
  user = await prisma.user.findUnique({ where: { email }, include: { tenant: true } });
  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { [providerIdField]: providerId, ssoProvider: provider },
      include: { tenant: true },
    });
    return user;
  }

  // 3. Net new user — provision a fresh tenant + user
  const orgBase = name ? `${name}'s Organization` : email.split("@")[0] + "'s Organization";
  const slug = await generateUniqueSlug(orgBase);
  const tenant = await prisma.tenant.create({
    data: { name: orgBase, slug, ownerEmail: email, plan: "starter" },
  });

  // password column is required — store an unusable random hash for SSO accounts
  const placeholderPassword = require("crypto").randomBytes(32).toString("hex");

  user = await prisma.user.create({
    data: {
      email,
      password: placeholderPassword,
      name: name || email.split("@")[0],
      role: "ADMIN",
      tenantId: tenant.id,
      [providerIdField]: providerId,
      ssoProvider: provider,
    },
    include: { tenant: true },
  });
  return user;
}

function issueJwt(user) {
  const jti = crypto.randomBytes(16).toString("hex");
  return jwt.sign(
    {
      userId: user.id,
      role: user.role,
      wellnessRole: user.wellnessRole ?? null,
      tenantId: user.tenantId,
      jti,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function redirectWithToken(res, frontendBase, token, tenant) {
  const tenantPayload = tenant
    ? encodeURIComponent(
        JSON.stringify({ id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan })
      )
    : "";
  const url = `${frontendBase}/sso/return?token=${encodeURIComponent(token)}&tenant=${tenantPayload}`;
  return res.redirect(url);
}

function redirectWithError(res, frontendBase, message) {
  const url = `${frontendBase}/sso/return?error=${encodeURIComponent(message)}`;
  return res.redirect(url);
}

// ── Google OAuth ──────────────────────────────────────────────────

router.get("/google/start", (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri } = getGoogleConfig(req);
    if (!clientId || !clientSecret) {
      return res
        .status(500)
        .send("Google SSO not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["openid", "profile", "email"],
    });
    res.redirect(url);
  } catch (err) {
    console.error("[sso] google/start error:", err);
    res.status(500).json({ error: "Failed to start Google SSO flow" });
  }
});

router.get("/google/callback", async (req, res) => {
  const frontendBase = getFrontendBase(req);
  try {
    const { code, error } = req.query;
    if (error) return redirectWithError(res, frontendBase, String(error));
    if (!code) return redirectWithError(res, frontendBase, "Missing authorization code");

    const { clientId, clientSecret, redirectUri } = getGoogleConfig(req);
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2.getToken(String(code));
    oauth2.setCredentials(tokens);

    // Fetch user profile from Google.
    const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
    const { data: profile } = await oauth2Api.userinfo.get();
    if (!profile || !profile.id || !profile.email) {
      return redirectWithError(res, frontendBase, "Google did not return a profile");
    }

    const user = await findOrCreateSsoUser({
      provider: "google",
      providerId: profile.id,
      email: profile.email,
      name: profile.name || profile.given_name || null,
    });
    const token = issueJwt(user);
    return redirectWithToken(res, frontendBase, token, user.tenant);
  } catch (err) {
    console.error("[sso] google/callback error:", err);
    return redirectWithError(res, frontendBase, "Google SSO failed");
  }
});

// ── Microsoft OAuth (raw fetch — no SDK) ──────────────────────────

router.get("/microsoft/start", (req, res) => {
  try {
    const { clientId, redirectUri, tenantPath } = getMicrosoftConfig(req);
    if (!clientId) {
      return res
        .status(500)
        .send("Microsoft SSO not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.");
    }
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: "openid profile email User.Read",
    });
    const url = `https://login.microsoftonline.com/${tenantPath}/oauth2/v2.0/authorize?${params.toString()}`;
    res.redirect(url);
  } catch (err) {
    console.error("[sso] microsoft/start error:", err);
    res.status(500).json({ error: "Failed to start Microsoft SSO flow" });
  }
});

router.get("/microsoft/callback", async (req, res) => {
  const frontendBase = getFrontendBase(req);
  try {
    const { code, error, error_description } = req.query;
    if (error) {
      return redirectWithError(res, frontendBase, String(error_description || error));
    }
    if (!code) return redirectWithError(res, frontendBase, "Missing authorization code");

    const { clientId, clientSecret, redirectUri, tenantPath } = getMicrosoftConfig(req);
    if (!clientId || !clientSecret) {
      return redirectWithError(res, frontendBase, "Microsoft SSO not configured");
    }

    // Exchange code for access token
    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "openid profile email User.Read",
    });
    const tokenResp = await fetch(
      `https://login.microsoftonline.com/${tenantPath}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      }
    );
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      console.error("[sso] microsoft token exchange failed:", tokenResp.status, text);
      return redirectWithError(res, frontendBase, "Microsoft token exchange failed");
    }
    const tokenJson = await tokenResp.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      return redirectWithError(res, frontendBase, "Microsoft did not return an access token");
    }

    // Fetch user from Graph
    const meResp = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meResp.ok) {
      const text = await meResp.text();
      console.error("[sso] microsoft graph fetch failed:", meResp.status, text);
      return redirectWithError(res, frontendBase, "Microsoft profile fetch failed");
    }
    const profile = await meResp.json();
    const email = profile.mail || profile.userPrincipalName;
    const providerId = profile.id;
    if (!providerId || !email) {
      return redirectWithError(res, frontendBase, "Microsoft did not return a usable profile");
    }

    const user = await findOrCreateSsoUser({
      provider: "microsoft",
      providerId,
      email,
      name: profile.displayName || profile.givenName || null,
    });
    const token = issueJwt(user);
    return redirectWithToken(res, frontendBase, token, user.tenant);
  } catch (err) {
    console.error("[sso] microsoft/callback error:", err);
    return redirectWithError(res, frontendBase, "Microsoft SSO failed");
  }
});

// ── Tenant SSO Configuration (admin) ─────────────────────────────

function maskSecret(secret) {
  if (!secret) return null;
  if (secret.length <= 4) return "****";
  return `${secret.slice(0, 2)}${"*".repeat(Math.max(4, secret.length - 4))}${secret.slice(-2)}`;
}

router.get("/config", verifyToken, async (req, res) => {
  try {
    const configs = await prisma.ssoConfig.findMany({
      where: { tenantId: req.user.tenantId },
    });
    const safe = configs.map((c) => ({
      id: c.id,
      provider: c.provider,
      clientId: c.clientId,
      clientSecret: maskSecret(c.clientSecret),
      redirectUri: c.redirectUri,
      isActive: c.isActive,
      tenantId: c.tenantId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
    res.json(safe);
  } catch (err) {
    console.error("[sso] config GET error:", err);
    res.status(500).json({ error: "Failed to load SSO configuration" });
  }
});

router.put("/config/:provider", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const provider = String(req.params.provider).toLowerCase();
    if (!["google", "microsoft"].includes(provider)) {
      return res.status(400).json({ error: "Unsupported SSO provider" });
    }
    const { clientId, clientSecret, redirectUri, isActive } = req.body || {};

    const data = {
      provider,
      tenantId: req.user.tenantId,
      clientId: clientId ?? null,
      // Only overwrite the secret if a non-empty value was supplied (preserves prior secret on partial updates).
      ...(clientSecret ? { clientSecret } : {}),
      redirectUri: redirectUri ?? null,
      isActive: typeof isActive === "boolean" ? isActive : false,
    };

    const upserted = await prisma.ssoConfig.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      create: { ...data, clientSecret: clientSecret || null },
      update: data,
    });

    res.json({
      id: upserted.id,
      provider: upserted.provider,
      clientId: upserted.clientId,
      clientSecret: maskSecret(upserted.clientSecret),
      redirectUri: upserted.redirectUri,
      isActive: upserted.isActive,
      tenantId: upserted.tenantId,
    });
  } catch (err) {
    console.error("[sso] config PUT error:", err);
    res.status(500).json({ error: "Failed to save SSO configuration" });
  }
});

module.exports = router;
