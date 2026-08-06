/**
 * Travel CRM — RAG knowledge base admin routes.
 *
 * Mounted at /api/travel/knowledge-base by server.js. Provides:
 *   GET    /config                    read the stored Drive root folder id
 *   POST   /config                    set the Drive root folder id (admin/write)
 *   POST   /sync                      trigger a sync from Drive to Qdrant (admin/write)
 *   GET    /status                    indexed-file + Qdrant chunk stats per sub-brand
 *   GET    /jobs                      recent sync jobs (paginated)
 *   GET    /files                     indexed files (paginated, filter by subBrand)
 *   DELETE /files/:id                 remove a file from the index (admin/write)
 *   GET    /oauth/status              Google Drive OAuth connection status
 *   GET    /oauth/auth-url            generate the Google consent URL
 *   GET    /oauth/callback            Google OAuth redirect URI (backend)
 *   POST   /oauth/exchange            frontend fallback to finish OAuth if Google
 *                                     redirects to the frontend URL instead
 *   GET    /folders                   list Drive folders for the picker
 *
 * All endpoints are tenant-scoped to the caller's travel tenant. The RAG sidecar
 * is intentionally additive: if Qdrant or OpenAI is not configured, sync
 * returns a clear error code instead of corrupting data.
 */

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const syncEngine = require("../lib/travelKnowledgeBaseSync");
const qdrant = require("../lib/qdrantClient");
const oauth = require("../lib/googleDriveOAuth");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");

const CONFIG_KEY = "travel.knowledgeBase.rootFolderId";

async function getRootFolderId(tenantId) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: CONFIG_KEY } },
  });
  return row?.value || null;
}

async function setRootFolderId(tenantId, rootFolderId) {
  const clean = String(rootFolderId || "").trim();
  if (!clean) {
    const err = new Error("rootFolderId is required");
    err.status = 400;
    err.code = "MISSING_FOLDER_ID";
    throw err;
  }
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: CONFIG_KEY } },
    create: { tenantId, key: CONFIG_KEY, value: clean, category: "travel" },
    update: { value: clean, category: "travel" },
  });
  return clean;
}

// GET /api/travel/knowledge-base/config
router.get("/config", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const rootFolderId = await getRootFolderId(req.travelTenant.id);
    res.json({ rootFolderId, qdrantEnabled: qdrant.isEnabled() });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-kb] get config error:", e.message);
    res.status(500).json({ error: "Failed to read config" });
  }
});

// POST /api/travel/knowledge-base/config
router.post(
  "/config",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const rootFolderId = await setRootFolderId(
        req.travelTenant.id,
        req.body?.rootFolderId,
      );
      res.json({ rootFolderId });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-kb] set config error:", e.message);
      res.status(500).json({ error: "Failed to save config" });
    }
  },
);

// POST /api/travel/knowledge-base/sync
router.post(
  "/sync",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const rootFolderId =
        String(req.body?.rootFolderId || "").trim() ||
        (await getRootFolderId(req.travelTenant.id));
      if (!rootFolderId) {
        return res.status(400).json({
          error: "Drive root folder id is required. Save it in config or pass it in the body.",
          code: "MISSING_FOLDER_ID",
        });
      }
      const result = await syncEngine.runSync({
        tenantId: req.travelTenant.id,
        rootFolderId,
      });
      res.status(201).json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-kb] sync error:", e.message);
      res.status(500).json({ error: e.message || "Sync failed", code: e.code || "SYNC_FAILED" });
    }
  },
);

// GET /api/travel/knowledge-base/status
router.get("/status", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const stats = await syncEngine.getStats(req.travelTenant.id);
    const lastJob = await prisma.travelKnowledgeBaseSyncJob.findFirst({
      where: { tenantId: req.travelTenant.id },
      orderBy: { startedAt: "desc" },
    });
    res.json({ stats, lastJob });
  } catch (e) {
    console.error("[travel-kb] status error:", e.message);
    res.status(500).json({ error: "Failed to read status" });
  }
});

// GET /api/travel/knowledge-base/jobs
router.get("/jobs", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = parseInt(req.query.offset, 10) || 0;
    const [jobs, total] = await Promise.all([
      prisma.travelKnowledgeBaseSyncJob.findMany({
        where: { tenantId: req.travelTenant.id },
        orderBy: { startedAt: "desc" },
        take,
        skip,
      }),
      prisma.travelKnowledgeBaseSyncJob.count({
        where: { tenantId: req.travelTenant.id },
      }),
    ]);
    res.json({ jobs, total, limit: take, offset: skip });
  } catch (e) {
    console.error("[travel-kb] jobs error:", e.message);
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

// GET /api/travel/knowledge-base/files
router.get("/files", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) where.subBrand = String(req.query.subBrand);

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const [files, total] = await Promise.all([
      prisma.travelKnowledgeBaseFile.findMany({
        where,
        orderBy: { indexedAt: "desc" },
        take,
        skip,
      }),
      prisma.travelKnowledgeBaseFile.count({ where }),
    ]);
    res.json({ files, total, limit: take, offset: skip });
  } catch (e) {
    console.error("[travel-kb] files error:", e.message);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// DELETE /api/travel/knowledge-base/files/:id
router.delete(
  "/files/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const file = await prisma.travelKnowledgeBaseFile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!file) {
        return res.status(404).json({ error: "File not found", code: "NOT_FOUND" });
      }
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, file.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }
      await syncEngine.deleteFileFromIndex({
        tenantId: file.tenantId,
        subBrand: file.subBrand,
        driveFileId: file.driveFileId,
      });
      res.json({ deleted: true });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-kb] delete file error:", e.message);
      res.status(500).json({ error: "Failed to delete file" });
    }
  },
);

// GET /api/travel/knowledge-base/oauth/status
router.get("/oauth/status", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const connected = await oauth.isConnected(req.travelTenant.id);
    const rootFolderId = await getRootFolderId(req.travelTenant.id);
    let userInfo = null;
    if (connected) {
      try {
        const drive = await oauth.getDriveClient(req.travelTenant.id);
        userInfo = await oauth.getUserInfo(drive);
      } catch (e) {
        // Token may be invalid; surface as not connected so user re-auths.
        console.error("[travel-kb] oauth userinfo failed:", e.message);
      }
    }
    res.json({
      configured: oauth.isConfigured(),
      connected: connected && userInfo !== null,
      userInfo,
      rootFolderId,
    });
  } catch (e) {
    console.error("[travel-kb] oauth status error:", e.message);
    res.status(500).json({ error: "Failed to read OAuth status" });
  }
});

// GET /api/travel/knowledge-base/oauth/auth-url
router.get(
  "/oauth/auth-url",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      if (!oauth.isConfigured()) {
        return res.status(503).json({
          error: "Google OAuth is not configured on the server.",
          code: "OAUTH_NOT_CONFIGURED",
        });
      }
      const frontendBase = (
        process.env.FRONTEND_URL ||
        req.headers.origin ||
        req.headers.referer ||
        ""
      ).replace(/\/$/, "");
      const state = encodeURIComponent(
        JSON.stringify({
          tenantId: req.travelTenant.id,
          userId: req.user.userId,
          redirectTo: "/travel/trip-knowledge",
          frontendBase,
        }),
      );
      const url = oauth.getAuthUrl(state);
      res.json({ url, state });
    } catch (e) {
      console.error("[travel-kb] auth-url error:", e.message);
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  },
);

async function completeOAuth({ code, state, error }) {
  let meta = {};
  try {
    meta = JSON.parse(decodeURIComponent(state || "{}"));
  } catch {
    // ignore corrupt state
  }
  let frontendBase = String(meta.frontendBase || "").replace(/\/$/, "");
  if (!frontendBase || !/^https?:\/\//.test(frontendBase)) {
    frontendBase = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  }
  if (!frontendBase && process.env.NODE_ENV !== "production") {
    frontendBase = "http://localhost:5173";
  }
  const redirectPath = frontendBase
    ? `${frontendBase}/travel/trip-knowledge`
    : "/travel/trip-knowledge";

  if (error || !code) {
    return {
      success: false,
      redirectPath,
      message: error || "no code",
      code: "OAUTH_DENIED",
    };
  }
  const tokens = await oauth.exchangeCode(code);
  if (!tokens.refresh_token) {
    return {
      success: false,
      redirectPath,
      message: "No refresh token returned. Please revoke access in Google Account permissions and try again.",
      code: "NO_REFRESH_TOKEN",
    };
  }
  const tenantId = Number(meta.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error("[travel-kb] oauth rejected: missing/invalid tenantId in state", { state, meta });
    return {
      success: false,
      redirectPath,
      message: "Invalid session state. Please start the connection again from the Travel Knowledge page.",
      code: "INVALID_STATE",
    };
  }
  const userId = String(meta.userId || "");
  await oauth.storeTokens(tenantId, tokens);
  console.log(`[travel-kb] oauth success: tokens stored for tenant ${tenantId}, user ${userId || "unknown"}`);
  return { success: true, redirectPath, tenantId };
}

// GET /api/travel/knowledge-base/oauth/callback
// Called by Google after user consents. Redirects back to the frontend with a
// success or error query param.
router.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    console.log("[travel-kb] oauth callback reached", {
      code: code ? "present" : "missing",
      state: state ? "present" : "missing",
      error: error || "none",
    });
    const result = await completeOAuth({ code, state, error });
    if (result.success) {
      return res.redirect(`${result.redirectPath}?oauth=success`);
    }
    return res.redirect(
      `${result.redirectPath}?oauth=error&message=${encodeURIComponent(result.message)}&code=${result.code}`,
    );
  } catch (e) {
    console.error("[travel-kb] oauth callback error:", e.message);
    const fallback = (process.env.FRONTEND_URL || "").replace(/\/$/, "") || "http://localhost:5173";
    res.redirect(`${fallback}/travel/trip-knowledge?oauth=error&message=${encodeURIComponent(e.message)}`);
  }
});

// POST /api/travel/knowledge-base/oauth/exchange
// Fallback for when Google redirects back to the frontend URL instead of the
// backend callback. The frontend POSTs the code/state here and we finish the flow.
router.post("/oauth/exchange", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const { code, state, error } = req.body || {};
    console.log("[travel-kb] oauth exchange reached", {
      code: code ? "present" : "missing",
      state: state ? "present" : "missing",
      error: error || "none",
    });
    const result = await completeOAuth({ code, state, error });
    if (result.success) {
      return res.json({ success: true, redirectPath: result.redirectPath });
    }
    return res.status(400).json({ success: false, error: result.message, code: result.code });
  } catch (e) {
    console.error("[travel-kb] oauth exchange error:", e.message);
    res.status(500).json({ error: e.message || "OAuth exchange failed", code: "EXCHANGE_FAILED" });
  }
});

// POST /api/travel/knowledge-base/oauth/disconnect
// Clears the stored Google Drive refresh token for this tenant. The user must
// also revoke the app in their Google Account if they want to break the link.
router.post(
  "/oauth/disconnect",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      await oauth.disconnectTokens(req.travelTenant.id);
      console.log(`[travel-kb] oauth disconnected for tenant ${req.travelTenant.id}`);
      res.json({ disconnected: true });
    } catch (e) {
      console.error("[travel-kb] oauth disconnect error:", e.message);
      res.status(500).json({ error: "Failed to disconnect Google Drive" });
    }
  },
);

// GET /api/travel/knowledge-base/folders
// Lists Drive folders under a parent (default: root). Used by the folder picker.
router.get(
  "/folders",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const parentId = String(req.query.parentId || "root").trim() || "root";
      const drive = await oauth.getDriveClient(req.travelTenant.id);
      const folders = await oauth.listFolders(drive, parentId);
      res.json({ parentId, folders });
    } catch (e) {
      if (e.code === "DRIVE_NOT_CONNECTED") {
        return res.status(401).json({ error: e.message, code: e.code });
      }
      console.error("[travel-kb] folders error:", e.message);
      res.status(500).json({ error: "Failed to list folders" });
    }
  },
);

module.exports = router;
