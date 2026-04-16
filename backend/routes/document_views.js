const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const router = express.Router();

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const VALID_TYPES = ["Quote", "Estimate", "Contract", "Proposal"];

function generateTrackingId() {
  return crypto.randomBytes(24).toString("hex");
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

// ── Public tracking endpoints (NO auth) ───────────────────────────
// Mounted under /api/document-views; openPaths matches "/document-views/track".

// GET /track/:trackingId — record view + return loading HTML
router.get("/track/:trackingId", async (req, res) => {
  try {
    const view = await prisma.documentView.findUnique({
      where: { trackingId: req.params.trackingId },
    });

    if (!view) {
      return res.status(404).send(
        `<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">` +
        `<h2>Document not found</h2><p>This tracking link is invalid or has been removed.</p></body></html>`
      );
    }

    // Only set viewedAt on first view
    if (!view.viewedAt) {
      await prisma.documentView.update({
        where: { id: view.id },
        data: {
          viewedAt: new Date(),
          ipAddress: getClientIp(req),
          userAgent: req.headers["user-agent"] || null,
        },
      });
    }

    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Loading document...</title></head>` +
      `<body style="font-family:system-ui;padding:40px;text-align:center;background:#f9fafb;color:#111">` +
      `<h2>Loading document...</h2>` +
      `<p>This view has been recorded.</p>` +
      `<script>` +
      `(function(){` +
      `var start=Date.now();` +
      `var trackingId=${JSON.stringify(req.params.trackingId)};` +
      `function logDuration(){` +
      `var d=Math.round((Date.now()-start)/1000);` +
      `try{` +
      `var b=new Blob([JSON.stringify({duration:d})],{type:"application/json"});` +
      `navigator.sendBeacon("/api/document-views/track/"+trackingId+"/duration",b);` +
      `}catch(e){}` +
      `}` +
      `window.addEventListener("beforeunload",logDuration);` +
      `window.addEventListener("pagehide",logDuration);` +
      `setTimeout(function(){try{window.close();}catch(e){}},2000);` +
      `})();` +
      `</script>` +
      `</body></html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("[DocumentViews] track GET error:", err);
    res.status(500).send(
      `<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">` +
      `<h2>Unable to record view</h2></body></html>`
    );
  }
});

// POST /track/:trackingId/duration — record viewing duration
router.post("/track/:trackingId/duration", async (req, res) => {
  try {
    const { duration } = req.body || {};
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60 * 60 * 24) {
      return res.status(400).json({ error: "Invalid duration" });
    }

    const view = await prisma.documentView.findUnique({
      where: { trackingId: req.params.trackingId },
    });
    if (!view) return res.status(404).json({ error: "Tracking ID not found" });

    // Accumulate duration across multiple beacons / re-opens
    const total = (view.duration || 0) + Math.round(seconds);

    await prisma.documentView.update({
      where: { id: view.id },
      data: { duration: total },
    });

    res.json({ success: true, duration: total });
  } catch (err) {
    console.error("[DocumentViews] duration POST error:", err);
    res.status(500).json({ error: "Failed to record duration" });
  }
});

// ── Authenticated endpoints ───────────────────────────────────────
// (Global auth guard already runs verifyToken for /api/* outside openPaths.)

// POST /create — create tracking record + return URL to embed in email
router.post("/create", async (req, res) => {
  try {
    const { documentType, documentId, viewerEmail } = req.body || {};
    if (!VALID_TYPES.includes(documentType)) {
      return res.status(400).json({ error: `documentType must be one of ${VALID_TYPES.join(", ")}` });
    }
    const docId = parseInt(documentId, 10);
    if (!Number.isFinite(docId) || docId <= 0) {
      return res.status(400).json({ error: "documentId is required" });
    }

    let trackingId = generateTrackingId();
    // Extremely unlikely collision, but retry once just in case
    const existing = await prisma.documentView.findUnique({ where: { trackingId } });
    if (existing) trackingId = generateTrackingId();

    const record = await prisma.documentView.create({
      data: {
        documentType,
        documentId: docId,
        trackingId,
        viewerEmail: viewerEmail || null,
        viewedAt: null,
        tenantId: req.user.tenantId,
      },
    });

    const trackingUrl = `${BASE_URL}/api/document-views/track/${trackingId}`;
    res.status(201).json({ id: record.id, trackingId, trackingUrl });
  } catch (err) {
    console.error("[DocumentViews] create error:", err);
    res.status(500).json({ error: "Failed to create tracking record" });
  }
});

// GET / — list all tracking records (filterable by documentType, documentId)
router.get("/", async (req, res) => {
  try {
    const { documentType, documentId } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (documentType && VALID_TYPES.includes(documentType)) where.documentType = documentType;
    if (documentId) {
      const id = parseInt(documentId, 10);
      if (Number.isFinite(id)) where.documentId = id;
    }

    const views = await prisma.documentView.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    res.json(views);
  } catch (err) {
    console.error("[DocumentViews] list error:", err);
    res.status(500).json({ error: "Failed to fetch document views" });
  }
});

// GET /document/:type/:id — views for a specific document, with aggregates
router.get("/document/:type/:id", async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid document type` });
    }
    const docId = parseInt(id, 10);
    if (!Number.isFinite(docId)) return res.status(400).json({ error: "Invalid document id" });

    const views = await prisma.documentView.findMany({
      where: { tenantId: req.user.tenantId, documentType: type, documentId: docId },
      orderBy: { createdAt: "desc" },
    });

    const opened = views.filter(v => v.viewedAt);
    const viewedTimes = opened
      .map(v => new Date(v.viewedAt).getTime())
      .sort((a, b) => a - b);

    const summary = {
      documentType: type,
      documentId: docId,
      totalRecipients: views.length,
      totalViews: opened.length,
      uniqueViewers: new Set(opened.map(v => v.viewerEmail).filter(Boolean)).size,
      firstViewedAt: viewedTimes.length ? new Date(viewedTimes[0]).toISOString() : null,
      lastViewedAt: viewedTimes.length ? new Date(viewedTimes[viewedTimes.length - 1]).toISOString() : null,
      totalDuration: opened.reduce((sum, v) => sum + (v.duration || 0), 0),
      viewers: opened.map(v => ({
        id: v.id,
        viewerEmail: v.viewerEmail,
        viewedAt: v.viewedAt,
        duration: v.duration,
        ipAddress: v.ipAddress,
        userAgent: v.userAgent,
      })),
    };

    res.json({ summary, views });
  } catch (err) {
    console.error("[DocumentViews] document detail error:", err);
    res.status(500).json({ error: "Failed to fetch document views" });
  }
});

// GET /stats — tenant-wide stats
router.get("/stats", async (req, res) => {
  try {
    const all = await prisma.documentView.findMany({
      where: { tenantId: req.user.tenantId },
      select: {
        documentType: true,
        documentId: true,
        viewerEmail: true,
        viewedAt: true,
        duration: true,
      },
    });

    const docKeys = new Set(all.map(v => `${v.documentType}:${v.documentId}`));
    const opened = all.filter(v => v.viewedAt);
    const uniqueViewers = new Set(opened.map(v => v.viewerEmail).filter(Boolean));
    const totalDuration = opened.reduce((s, v) => s + (v.duration || 0), 0);
    const avgDuration = opened.length ? Math.round(totalDuration / opened.length) : 0;

    res.json({
      documentsTracked: docKeys.size,
      totalRecipients: all.length,
      totalViews: opened.length,
      uniqueViewers: uniqueViewers.size,
      avgViewDuration: avgDuration,
    });
  } catch (err) {
    console.error("[DocumentViews] stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

module.exports = router;
