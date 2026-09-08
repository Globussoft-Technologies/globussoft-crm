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
const multer = require("multer");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const syncEngine = require("../lib/travelKnowledgeBaseSync");
const qdrant = require("../lib/qdrantClient");
const embedClient = require("../lib/embedClient");
const oauth = require("../lib/googleDriveOAuth");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");

const CONFIG_KEY = "travel.knowledgeBase.rootFolderId";
const tmcCatalogueUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname)),
});

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
    const embedCfg = await embedClient.resolveEmbedConfig(req.travelTenant.id);
    res.json({
      rootFolderId,
      qdrantEnabled: qdrant.isEnabled(),
      embedEnabled: Boolean(embedCfg),
      embedProvider: embedCfg?.providerId || null,
      embedModel: embedCfg ? embedClient.getDefaultModel(embedCfg.providerId) : null,
      vectorSize: embedCfg ? embedClient.getVectorSize(embedCfg.providerId) : null,
    });
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

// POST /api/travel/knowledge-base/sync/jobs
// Starts a sync in the background and returns immediately with the job id so the
// UI can poll progress and request a stop.
router.post(
  "/sync/jobs",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      if (!qdrant.isEnabled()) {
        return res.status(503).json({ error: "Qdrant is not configured", code: "QDRANT_NOT_CONFIGURED" });
      }
      const embedCfg = await embedClient.resolveEmbedConfig(req.travelTenant.id);
      if (!embedCfg) {
        return res.status(503).json({
          error: "No supported AI provider is configured for embeddings. Configure OpenAI or Gemini in AI Settings.",
          code: "EMBEDDING_PROVIDER_NOT_CONFIGURED",
        });
      }
      const rootFolderId =
        String(req.body?.rootFolderId || "").trim() ||
        (await getRootFolderId(req.travelTenant.id));
      if (!rootFolderId) {
        return res.status(400).json({
          error: "Drive root folder id is required. Save it in config or pass it in the body.",
          code: "MISSING_FOLDER_ID",
        });
      }
      const job = await prisma.travelKnowledgeBaseSyncJob.create({
        data: { tenantId: req.travelTenant.id, rootFolderId, status: "running" },
      });
      // Start processing without awaiting; the UI polls for completion.
      syncEngine
        .runSync({ tenantId: req.travelTenant.id, rootFolderId, job })
        .catch((e) => console.error("[travel-kb] background sync failed:", e.message));
      res.status(202).json({
        jobId: job.id,
        status: "running",
        startedAt: job.startedAt,
        providerId: embedCfg.providerId,
        vectorSize: embedClient.getVectorSize(embedCfg.providerId),
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-kb] sync/jobs error:", e.message);
      res.status(500).json({ error: e.message || "Sync failed", code: e.code || "SYNC_FAILED" });
    }
  },
);

// POST /api/travel/knowledge-base/sync/wipe-and-resync
// Wipes all indexed data for this tenant (all provider collections + the file
// registry) and starts a fresh sync from the supplied or saved root folder.
// Use this when switching to a completely different Drive folder and you want
// old folder data removed from the RAG index.
router.post(
  "/sync/wipe-and-resync",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      if (!qdrant.isEnabled()) {
        return res.status(503).json({ error: "Qdrant is not configured", code: "QDRANT_NOT_CONFIGURED" });
      }
      const embedCfg = await embedClient.resolveEmbedConfig(req.travelTenant.id);
      if (!embedCfg) {
        return res.status(503).json({
          error: "No supported AI provider is configured for embeddings. Configure OpenAI or Gemini in AI Settings.",
          code: "EMBEDDING_PROVIDER_NOT_CONFIGURED",
        });
      }
      const rootFolderId =
        String(req.body?.rootFolderId || "").trim() ||
        (await getRootFolderId(req.travelTenant.id));
      if (!rootFolderId) {
        return res.status(400).json({
          error: "Drive root folder id is required. Save it in config or pass it in the body.",
          code: "MISSING_FOLDER_ID",
        });
      }
      const tenantId = req.travelTenant.id;

      // Stop any in-flight syncs for this tenant.
      const runningJobs = await prisma.travelKnowledgeBaseSyncJob.findMany({
        where: { tenantId, status: "running" },
      });
      for (const job of runningJobs) syncEngine.stopSyncJob(job.id);
      await prisma.travelKnowledgeBaseSyncJob.updateMany({
        where: { tenantId, status: "running" },
        data: { status: "stopped", completedAt: new Date() },
      });

      // Wipe Qdrant points across all supported provider collections.
      for (const providerId of embedClient.getSupportedProviders()) {
        await qdrant.deleteByTenant(tenantId, providerId);
      }

      // Wipe the file registry so the next sync re-indexes every PDF.
      await prisma.travelKnowledgeBaseFile.deleteMany({ where: { tenantId } });

      const job = await prisma.travelKnowledgeBaseSyncJob.create({
        data: { tenantId, rootFolderId, status: "running" },
      });
      syncEngine
        .runSync({ tenantId, rootFolderId, job })
        .catch((e) => console.error("[travel-kb] background wipe-and-resync failed:", e.message));
      res.status(202).json({
        jobId: job.id,
        status: "running",
        startedAt: job.startedAt,
        providerId: embedCfg.providerId,
        vectorSize: embedClient.getVectorSize(embedCfg.providerId),
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-kb] wipe-and-resync error:", e.message);
      res.status(500).json({ error: e.message || "Wipe and resync failed", code: e.code || "WIPE_RESYNC_FAILED" });
    }
  },
);

// GET /api/travel/knowledge-base/jobs/:jobId
router.get(
  "/jobs/:jobId",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const jobId = parseInt(req.params.jobId, 10);
      if (!Number.isFinite(jobId)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const job = await prisma.travelKnowledgeBaseSyncJob.findFirst({
        where: { id: jobId, tenantId: req.travelTenant.id },
      });
      if (!job) return res.status(404).json({ error: "Job not found", code: "NOT_FOUND" });
      res.json({ job });
    } catch (e) {
      console.error("[travel-kb] get job error:", e.message);
      res.status(500).json({ error: "Failed to read job" });
    }
  },
);

// POST /api/travel/knowledge-base/sync/:jobId/stop
router.post(
  "/sync/:jobId/stop",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const jobId = parseInt(req.params.jobId, 10);
      if (!Number.isFinite(jobId)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const job = await prisma.travelKnowledgeBaseSyncJob.findFirst({
        where: { id: jobId, tenantId: req.travelTenant.id },
      });
      if (!job) return res.status(404).json({ error: "Job not found", code: "NOT_FOUND" });
      if (job.status !== "running") {
        return res.status(400).json({ error: "Job is not running", code: "NOT_RUNNING" });
      }
      const stopped = syncEngine.stopSyncJob(jobId);
      res.json({ stopped });
    } catch (e) {
      console.error("[travel-kb] stop sync error:", e.message);
      res.status(500).json({ error: "Failed to stop sync" });
    }
  },
);

// POST /api/travel/knowledge-base/sync/stop-all
// Stops every sync job still marked "running" for this tenant. Useful when a
// previous process died and left a zombie "running" row, or when multiple
// workers started overlapping jobs.
router.post(
  "/sync/stop-all",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const runningJobs = await prisma.travelKnowledgeBaseSyncJob.findMany({
        where: { tenantId: req.travelTenant.id, status: "running" },
      });
      for (const job of runningJobs) {
        syncEngine.stopSyncJob(job.id);
      }
      // Mark all running rows as stopped, even if the in-memory controller is gone.
      const { count } = await prisma.travelKnowledgeBaseSyncJob.updateMany({
        where: { tenantId: req.travelTenant.id, status: "running" },
        data: { status: "stopped", completedAt: new Date() },
      });
      res.json({ stopped: count });
    } catch (e) {
      console.error("[travel-kb] stop all syncs error:", e.message);
      res.status(500).json({ error: "Failed to stop running syncs" });
    }
  },
);

// GET /api/travel/knowledge-base/status
router.get("/status", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const tenantId = req.travelTenant.id;
    const embedCfg = await embedClient.resolveEmbedConfig(tenantId);
    const activeProvider = embedCfg?.providerId || null;

    // Per-provider Qdrant chunk counts so the UI can warn when the active
    // provider's collection is empty but another provider's collection has data.
    const providerChunks = {};
    for (const providerId of embedClient.getSupportedProviders()) {
      providerChunks[providerId] = await qdrant.countPoints(tenantId, undefined, providerId);
    }

    const stats = await syncEngine.getStats(tenantId, activeProvider || "openai");
    const lastJob = await prisma.travelKnowledgeBaseSyncJob.findFirst({
      where: { tenantId },
      orderBy: { startedAt: "desc" },
    });
    res.json({
      activeProvider,
      activeVectorSize: activeProvider ? embedClient.getVectorSize(activeProvider) : null,
      activeEmbedModel: activeProvider ? embedClient.getDefaultModel(activeProvider) : null,
      providerChunks,
      stats,
      lastJob,
    });
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

// POST /api/travel/knowledge-base/jobs/bulk-delete
// Bulk-delete sync-job history rows. Running jobs must be stopped first
// (use /sync/:jobId/stop or /sync/stop-all) so operators don't accidentally
// delete an in-flight job whose background worker is still writing points.
router.post(
  "/jobs/bulk-delete",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => Number.isFinite(Number(id))) : [];
      if (ids.length === 0) {
        return res.status(400).json({ error: "ids must be a non-empty array", code: "INVALID_IDS" });
      }

      const jobs = await prisma.travelKnowledgeBaseSyncJob.findMany({
        where: { id: { in: ids }, tenantId: req.travelTenant.id },
      });
      const foundIds = new Set(jobs.map((j) => j.id));
      const missing = ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        return res.status(404).json({ error: "Some jobs were not found", code: "NOT_FOUND", missing });
      }

      const running = jobs.filter((j) => j.status === "running");
      if (running.length > 0) {
        return res.status(409).json({
          error: "Stop running jobs before deleting them",
          code: "JOBS_RUNNING",
          runningIds: running.map((j) => j.id),
        });
      }

      const { count } = await prisma.travelKnowledgeBaseSyncJob.deleteMany({
        where: { id: { in: ids }, tenantId: req.travelTenant.id },
      });
      res.json({ deleted: count });
    } catch (e) {
      console.error("[travel-kb] bulk-delete jobs error:", e.message);
      res.status(500).json({ error: "Failed to delete jobs" });
    }
  },
);

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

// POST /api/travel/knowledge-base/files/bulk-delete
// Remove multiple indexed files from Qdrant and the file registry in one call.
// Each file is validated for tenant + sub-brand access before deletion.
router.post(
  "/files/bulk-delete",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => Number.isFinite(Number(id))) : [];
      if (ids.length === 0) {
        return res.status(400).json({ error: "ids must be a non-empty array", code: "INVALID_IDS" });
      }

      const files = await prisma.travelKnowledgeBaseFile.findMany({
        where: { id: { in: ids }, tenantId: req.travelTenant.id },
      });
      const foundIds = new Set(files.map((f) => f.id));
      const missing = ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        return res.status(404).json({ error: "Some files were not found", code: "NOT_FOUND", missing });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      const denied = files.filter((f) => !canAccessSubBrand(allowed, f.subBrand));
      if (denied.length > 0) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED", deniedIds: denied.map((f) => f.id) });
      }

      for (const file of files) {
        await syncEngine.deleteFileFromIndex({
          tenantId: file.tenantId,
          subBrand: file.subBrand,
          driveFileId: file.driveFileId,
        });
      }

      res.json({ deleted: files.length });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-kb] bulk-delete files error:", e.message);
      res.status(500).json({ error: "Failed to delete files" });
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

// GET /api/travel/knowledge-base/browse?parentId=root
// Like /folders but returns BOTH folders and files (PDFs) — read-only Drive
// browse for the TMC Catalogue admin's "Drive Library" tab, so operators can
// see the existing sub-brand PDF tree alongside the new "CRM Itineraries"
// output folder in one place. On-demand only, no sync/cron.
router.get(
  "/browse",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const parentId = String(req.query.parentId || "root").trim() || "root";
      const drive = await oauth.getDriveClient(req.travelTenant.id);
      const children = await syncEngine.listFolderChildren(drive, parentId);
      const items = children.map((c) => ({ ...c, isFolder: c.mimeType === "application/vnd.google-apps.folder" }));
      res.json({ parentId, items });
    } catch (e) {
      if (e.code === "DRIVE_NOT_CONNECTED") {
        return res.status(401).json({ error: e.message, code: e.code });
      }
      console.error("[travel-kb] browse error:", e.message);
      res.status(500).json({ error: "Failed to browse Drive" });
    }
  },
);

// TMC-only Drive management. Files are kept in root/TMC/CRM Itineraries so
// the catalogue can manage generated and manually uploaded itinerary PDFs.
router.post(
  "/tmc-catalogue/upload",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  tmcCatalogueUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Please choose a PDF file", code: "PDF_REQUIRED" });
      const rootFolderId = await getRootFolderId(req.travelTenant.id);
      if (!rootFolderId) return res.status(400).json({ error: "Connect Google Drive and choose a knowledge folder first", code: "FOLDER_NOT_CONFIGURED" });
      const drive = await oauth.getDriveClient(req.travelTenant.id);
      const rootItems = await syncEngine.listFolderChildren(drive, rootFolderId);
      const tmc = rootItems.find((item) => item.mimeType === "application/vnd.google-apps.folder" && String(item.name).replace(/[^a-z0-9]/gi, "").toLowerCase() === "tmc");
      const tmcFolderId = tmc?.id || await oauth.findOrCreateFolder(drive, rootFolderId, "TMC");
      const itineraryFolderId = await oauth.findOrCreateFolder(drive, tmcFolderId, "CRM Itineraries");
      const uploaded = await oauth.uploadFileToDrive(drive, itineraryFolderId, req.file.originalname, "application/pdf", req.file.buffer);
      res.status(201).json({ ...uploaded, fileName: req.file.originalname, folder: "TMC/CRM Itineraries" });
    } catch (e) {
      if (e.code === "DRIVE_NOT_CONNECTED") return res.status(401).json({ error: e.message, code: e.code });
      console.error("[travel-kb] TMC catalogue upload error:", e.message);
      res.status(500).json({ error: "Failed to upload PDF" });
    }
  },
);

router.get(
  "/tmc-catalogue/drive-files/:fileId/thumbnail",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const drive = await oauth.getDriveClient(req.travelTenant.id);
      const meta = await drive.files.get({ fileId: String(req.params.fileId), fields: "thumbnailLink" });
      if (!meta.data.thumbnailLink) return res.status(404).json({ error: "Thumbnail not available", code: "THUMBNAIL_NOT_AVAILABLE" });
      const authClient = drive.context?._options?.auth;
      const token = await authClient?.getAccessToken();
      const thumbnail = await fetch(meta.data.thumbnailLink, { headers: token?.token ? { Authorization: `Bearer ${token.token}` } : {} });
      if (!thumbnail.ok) return res.status(404).json({ error: "Thumbnail not available", code: "THUMBNAIL_NOT_AVAILABLE" });
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Type", thumbnail.headers.get("content-type") || "image/jpeg");
      res.send(Buffer.from(await thumbnail.arrayBuffer()));
    } catch (e) {
      console.error("[travel-kb] TMC thumbnail error:", e.message);
      res.status(404).json({ error: "Thumbnail not available", code: "THUMBNAIL_NOT_AVAILABLE" });
    }
  },
);

router.delete(
  "/tmc-catalogue/drive-files/:fileId",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    let fileId = null;
    try {
      fileId = String(req.params.fileId || "").trim();
      if (!fileId) return res.status(400).json({ error: "fileId is required", code: "INVALID_FILE_ID" });
      const rootFolderId = await getRootFolderId(req.travelTenant.id);
      if (!rootFolderId) return res.status(400).json({ error: "Drive folder is not configured", code: "FOLDER_NOT_CONFIGURED" });
      const drive = await oauth.getDriveClient(req.travelTenant.id);
      const file = await drive.files.get({ fileId, fields: "id, name, parents, mimeType, trashed" });
      const generatedItinerary = await prisma.itinerary.findFirst({
        where: { tenantId: req.travelTenant.id, subBrand: "tmc", catalogueDriveFileId: fileId },
        select: { id: true },
      });
      let parentIds = file.data.parents || [];
      let foundTmc = false;
      let foundCrmItineraries = false;
      // A generated PDF may sit in a child folder under CRM Itineraries. Walk
      // its complete Drive ancestry rather than requiring a direct parent.
      for (let depth = 0; depth < 10 && parentIds.length > 0; depth += 1) {
        const parentId = parentIds[0];
        const parent = await drive.files.get({ fileId: parentId, fields: "id, name, parents" });
        const normalized = String(parent.data.name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
        if (normalized === "crmitineraries") foundCrmItineraries = true;
        if (normalized === "tmc") foundTmc = true;
        if (parent.data.id === rootFolderId) break;
        parentIds = parent.data.parents || [];
      }
      if (!generatedItinerary && (!foundTmc || !foundCrmItineraries)) return res.status(403).json({ error: "Only files in TMC / CRM Itineraries can be deleted here", code: "OUTSIDE_TMC_FOLDER" });
      await oauth.deleteFileFromDrive(drive, fileId);
      res.json({ deleted: true, fileId });
    } catch (e) {
      if (e.code === "DRIVE_NOT_CONNECTED") return res.status(401).json({ error: e.message, code: e.code });
      if (e.code === 404 || e.response?.status === 404) {
        // The Drive file may already have been removed outside the CRM. Clear
        // the generated-itinerary reference so it does not remain stuck in
        // the pending-sync list forever.
        await prisma.itinerary.updateMany({
          where: { tenantId: req.travelTenant.id, subBrand: "tmc", catalogueDriveFileId: fileId },
          data: { catalogueDriveFileId: null, catalogueDriveViewLink: null, catalogueSyncedAt: null },
        });
        return res.json({ deleted: true, stale: true, fileId });
      }
      console.error("[travel-kb] TMC catalogue delete error:", e.message);
      res.status(500).json({ error: "Failed to delete Drive file" });
    }
  },
);

module.exports = router;
