const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");

const router = express.Router();

// ───────────────────────────────────────────────────────────────────
// Token Management Endpoints (require standard JWT auth via global guard)
// ───────────────────────────────────────────────────────────────────

function maskToken(stored) {
  if (!stored) return "";
  // Stored value is a bcrypt hash; we cannot recover plaintext. Return a generic mask.
  return `scim_••••••••${stored.slice(-4)}`;
}

// GET /tokens — list SCIM tokens for tenant (mask token value)
router.get("/tokens", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const tokens = await prisma.scimToken.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      tokens.map((t) => ({
        id: t.id,
        name: t.name,
        token: maskToken(t.token),
        lastUsed: t.lastUsed,
        createdAt: t.createdAt,
      }))
    );
  } catch (err) {
    console.error("[scim] tokens list error:", err);
    res.status(500).json({ error: "Failed to list SCIM tokens." });
  }
});

// POST /tokens — generate new token. Returns plaintext ONCE.
router.post("/tokens", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    const plaintext = `scim_${crypto.randomBytes(32).toString("hex")}`;
    const hash = await bcrypt.hash(plaintext, 10);

    const created = await prisma.scimToken.create({
      data: {
        token: hash,
        name,
        tenantId: req.user.tenantId,
      },
    });

    res.status(201).json({
      id: created.id,
      name: created.name,
      createdAt: created.createdAt,
      token: plaintext, // shown ONCE — caller must store it
      warning: "Store this token now. It will never be shown again.",
    });
  } catch (err) {
    console.error("[scim] tokens create error:", err);
    res.status(500).json({ error: "Failed to create SCIM token." });
  }
});

// DELETE /tokens/:id — revoke
router.delete("/tokens/:id", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.scimToken.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Token not found" });
    await prisma.scimToken.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[scim] tokens delete error:", err);
    res.status(500).json({ error: "Failed to revoke SCIM token." });
  }
});

// ───────────────────────────────────────────────────────────────────
// SCIM v2 Endpoints — Bearer token (NOT JWT) auth
// ───────────────────────────────────────────────────────────────────

async function scimAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "401",
        detail: "Bearer token required.",
      });
    }
    const presented = authHeader.slice(7).trim();
    if (!presented) return res.status(401).json({ status: "401", detail: "Empty token." });

    // We can't query by hash directly — fetch all tokens and bcrypt-compare.
    // SCIM token tables remain small per tenant; acceptable for typical IDP throughput.
    const tokens = await prisma.scimToken.findMany({});
    let match = null;
    for (const t of tokens) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(presented, t.token)) {
        match = t;
        break;
      }
    }
    if (!match) {
      return res.status(401).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "401",
        detail: "Invalid SCIM token.",
      });
    }

    req.scim = { tenantId: match.tenantId, tokenId: match.id };

    // Touch lastUsed (fire-and-forget; don't block response)
    prisma.scimToken
      .update({ where: { id: match.id }, data: { lastUsed: new Date() } })
      .catch((e) => console.error("[scim] failed to update lastUsed:", e.message));

    next();
  } catch (err) {
    console.error("[scim] auth error:", err);
    res.status(500).json({ status: "500", detail: "SCIM auth failed." });
  }
}

// Helper: convert internal user → SCIM User resource
function toScimUser(user) {
  const parts = (user.name || "").trim().split(/\s+/);
  const givenName = parts[0] || "";
  const familyName = parts.slice(1).join(" ") || "";
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: String(user.id),
    userName: user.email,
    name: { givenName, familyName, formatted: user.name || user.email },
    emails: [{ value: user.email, primary: true, type: "work" }],
    active: true,
    meta: {
      resourceType: "User",
      created: user.createdAt,
      lastModified: user.createdAt,
      location: `/api/scim/v2/Users/${user.id}`,
    },
  };
}

// GET /v2/Users — list users in tenant
router.get("/v2/Users", scimAuth, async (req, res) => {
  try {
    const startIndex = Math.max(parseInt(req.query.startIndex, 10) || 1, 1);
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 100, 1), 500);

    const where = { tenantId: req.scim.tenantId };

    // Minimal SCIM filter support: userName eq "x"
    if (req.query.filter && typeof req.query.filter === "string") {
      const m = req.query.filter.match(/userName\s+eq\s+"([^"]+)"/i);
      if (m) where.email = m[1];
    }

    const total = await prisma.user.count({ where });
    const users = await prisma.user.findMany({
      where,
      orderBy: { id: "asc" },
      skip: startIndex - 1,
      take: count,
    });

    res.json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: total,
      startIndex,
      itemsPerPage: users.length,
      Resources: users.map(toScimUser),
    });
  } catch (err) {
    console.error("[scim] users list error:", err);
    res.status(500).json({ status: "500", detail: "Failed to list users." });
  }
});

// POST /v2/Users — create
router.post("/v2/Users", scimAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const userName = body.userName || (body.emails && body.emails[0] && body.emails[0].value);
    if (!userName) {
      return res.status(400).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "400",
        detail: "userName is required.",
      });
    }

    // Reject duplicates
    const existing = await prisma.user.findUnique({ where: { email: userName } });
    if (existing) {
      return res.status(409).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "409",
        detail: "User already exists.",
      });
    }

    const givenName = body.name && body.name.givenName ? body.name.givenName : "";
    const familyName = body.name && body.name.familyName ? body.name.familyName : "";
    const fullName = [givenName, familyName].filter(Boolean).join(" ") || (body.name && body.name.formatted) || userName;

    const password = body.password || crypto.randomBytes(16).toString("hex");
    const hashed = await bcrypt.hash(password, 10);

    const created = await prisma.user.create({
      data: {
        email: userName,
        password: hashed,
        name: fullName,
        role: "USER",
        tenantId: req.scim.tenantId,
      },
    });

    res.status(201).json(toScimUser(created));
  } catch (err) {
    console.error("[scim] users create error:", err);
    res.status(500).json({ status: "500", detail: "Failed to create user." });
  }
});

// GET /v2/Users/:id — single user
router.get("/v2/Users/:id", scimAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const user = await prisma.user.findFirst({
      where: { id, tenantId: req.scim.tenantId },
    });
    if (!user) {
      return res.status(404).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "404",
        detail: "User not found.",
      });
    }
    res.json(toScimUser(user));
  } catch (err) {
    console.error("[scim] user get error:", err);
    res.status(500).json({ status: "500", detail: "Failed to fetch user." });
  }
});

// PATCH /v2/Users/:id — partial update per SCIM spec
router.patch("/v2/Users/:id", scimAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const user = await prisma.user.findFirst({
      where: { id, tenantId: req.scim.tenantId },
    });
    if (!user) return res.status(404).json({ status: "404", detail: "User not found." });

    const data = {};
    const ops = (req.body && Array.isArray(req.body.Operations)) ? req.body.Operations : [];

    for (const op of ops) {
      const opName = (op.op || "").toLowerCase();
      if (opName !== "replace" && opName !== "add") continue;
      // Path-style: { op:"replace", path:"userName", value:"x" }
      if (op.path) {
        const path = op.path;
        if (path === "userName" || path === "emails[primary eq true].value") {
          data.email = op.value;
        } else if (path === "name.givenName") {
          const parts = (user.name || "").split(/\s+/);
          parts[0] = op.value;
          data.name = parts.join(" ").trim();
        } else if (path === "name.familyName") {
          const parts = (user.name || "").split(/\s+/);
          data.name = [parts[0] || "", op.value].filter(Boolean).join(" ");
        } else if (path === "active") {
          // Active toggle — no schema column; skipped silently
        }
      } else if (op.value && typeof op.value === "object") {
        // No-path bulk replace: { op:"replace", value: { userName, name:{...} } }
        const v = op.value;
        if (v.userName) data.email = v.userName;
        if (v.name) {
          const g = v.name.givenName || "";
          const f = v.name.familyName || "";
          data.name = [g, f].filter(Boolean).join(" ") || v.name.formatted || user.name;
        }
        if (v.password) data.password = await bcrypt.hash(v.password, 10);
      }
    }

    if (Object.keys(data).length > 0) {
      await prisma.user.update({ where: { id }, data });
    }
    const fresh = await prisma.user.findUnique({ where: { id } });
    res.json(toScimUser(fresh));
  } catch (err) {
    console.error("[scim] user patch error:", err);
    res.status(500).json({ status: "500", detail: "Failed to update user." });
  }
});

// DELETE /v2/Users/:id — hard delete (per spec)
router.delete("/v2/Users/:id", scimAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const user = await prisma.user.findFirst({
      where: { id, tenantId: req.scim.tenantId },
    });
    if (!user) return res.status(404).json({ status: "404", detail: "User not found." });
    await prisma.user.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    console.error("[scim] user delete error:", err);
    res.status(500).json({ status: "500", detail: "Failed to delete user." });
  }
});

// GET /v2/Groups — empty list (groups not modeled)
router.get("/v2/Groups", scimAuth, async (req, res) => {
  res.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 0,
    startIndex: 1,
    itemsPerPage: 0,
    Resources: [],
  });
});

module.exports = router;
