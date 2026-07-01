/**
 * travel_brochures.js — Brochure Engine routes for the Travel vertical.
 *
 * Wraps the agentic-orchcrm brochure engine (sibling folder) behind the CRM's
 * JWT + tenant guard, persists the finished deliverable as a TravelBrochure
 * Prisma row, and exposes a live SSE trace so the operator UI can watch the
 * orchestration in real time.
 *
 * Per INTEGRATION.md §5 — runs are TRANSIENT (~30-60s) and live in memory
 * for the lifetime of the subprocess; only the final deliverable (PDF URL +
 * cost + brief) is persisted via Prisma. This route keeps an in-memory
 * `RUN_STATE` map for the active SSE subscribers — entries are pruned 10
 * minutes after the run settles so a late stream-subscriber can still replay.
 *
 * Endpoints (all mounted at /api/travel under /brochures/*):
 *   POST   /brochures/runs          start a new run, returns { runId }
 *   GET    /brochures/runs/:runId    poll status + result + DB row
 *   GET    /brochures/runs/:runId/stream  SSE event stream
 *   GET    /brochures/sectors        list available sectors + style keys
 *   GET    /brochures                list this tenant's past brochures
 *   GET    /brochures/:id            fetch one persisted brochure
 *   DELETE /brochures/:id            soft-archive a brochure row
 *
 * Permissions — reuse the existing "marketing" module since brochures are a
 * marketing/sales artifact (mirrors Landing Pages + Marketing Flyer Studio).
 * Adding a dedicated "brochures" module is a follow-up if the operator wants
 * finer-grained gating.
 */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { requireTravelTenant } = require("../middleware/travelGuards");
const prisma = require("../lib/prisma");
const brochureEngine = require("../services/brochureEngineBridge");
const { sanitizeBrandKit } = require("../lib/brochureBrandKit");
const brochureS3Store = require("../lib/brochureS3Store");

// SSE note: EventSource (the browser SSE client) intentionally rejects
// custom request headers, so the operator UI passes the JWT on the URL as
// ?token=<jwt> when subscribing to the live trace. The global auth guard
// in server.js promotes that query param to the Authorization header for
// THIS exact route shape only (`GET /travel/brochures/runs/:runId/stream`)
// before verifyToken runs — so plain verifyToken below works for both the
// header-auth case and the EventSource query-token case.

// In-memory live state for SSE subscribers. Keyed by runId. Each entry:
//   { events: [], status: 'running' | 'completed' | 'failed',
//     result?, error?, subscribers: Set<res>, settledAt?: number }
// Settled entries are GC'd 10 minutes after completion to bound memory.
const RUN_STATE = new Map();
const SETTLED_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [runId, state] of RUN_STATE.entries()) {
    if (state.settledAt && now - state.settledAt > SETTLED_TTL_MS) {
      RUN_STATE.delete(runId);
    }
  }
}, 60_000).unref();

function newRunId() {
  return "br_" + crypto.randomBytes(8).toString("hex");
}

/** Push an event into the in-memory buffer + fan out to live SSE subscribers. */
function pushEvent(runId, event) {
  const state = RUN_STATE.get(runId);
  if (!state) return;
  state.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.subscribers) {
    try {
      res.write(payload);
    } catch {
      state.subscribers.delete(res);
    }
  }
}

/** Send the same SSE payload to one subscriber. */
function sendOne(res, event) {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    /* connection closed */
  }
}

// ─── POST /brochures/runs ─────────────────────────────────────────────────
// Start ONE orchestration. Returns the runId synchronously; the operator UI
// then opens the SSE stream to watch live trace events.
router.post(
  "/brochures/runs",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "write"),
  async (req, res) => {
    try {
      const goal = typeof req.body.goal === "string" ? req.body.goal.trim() : "";
      const sectorKey =
        typeof req.body.sectorKey === "string" && req.body.sectorKey.trim()
          ? req.body.sectorKey.trim()
          : "travel";
      const styleKey =
        typeof req.body.styleKey === "string" && req.body.styleKey.trim()
          ? req.body.styleKey.trim()
          : undefined;
      // Trust boundary: the engine forwards `brand` verbatim into the render
      // subprocess, so it MUST be sanitized here (raster-only logo, length caps,
      // clamped placement). Invalid input is dropped → undefined, never rejected.
      const brand = sanitizeBrandKit(req.body.brand);
      // Switchable models: an optional per-tier model id map, OR a strategy
      // preset ('recommended' | 'cheapest' | 'smartest'). The engine applies
      // `models` first and falls back to `strategy`; both are validated there
      // against the live catalog, so we only shape-check here.
      const models =
        req.body.models && typeof req.body.models === "object" && !Array.isArray(req.body.models)
          ? req.body.models
          : undefined;
      const strategy =
        typeof req.body.strategy === "string" && req.body.strategy.trim()
          ? req.body.strategy.trim()
          : undefined;
      const tripId =
        typeof req.body.tripId === "number" ? req.body.tripId : undefined;
      const itineraryId =
        typeof req.body.itineraryId === "number" ? req.body.itineraryId : undefined;

      if (!goal) {
        return res.status(400).json({ error: "goal is required", code: "GOAL_REQUIRED" });
      }
      if (goal.length > 8000) {
        return res
          .status(400)
          .json({ error: "goal exceeds 8000 characters", code: "GOAL_TOO_LONG" });
      }

      const runId = newRunId();
      const tenantId = req.travelTenant.id;
      const userId = req.user.userId;

      // Pre-create a Prisma row in `running` state so the operator can see it
      // in their history list immediately. Updated on completion / failure.
      const initial = await prisma.travelBrochure.create({
        data: {
          tenantId,
          userId,
          runId,
          sectorKey,
          styleKey: styleKey || null,
          goal,
          status: "running",
          tripId: tripId || null,
          itineraryId: itineraryId || null,
          // Snapshot the SANITIZED brand for audit / replay (column already
          // exists on the model). Stored post-sanitization so a replay can't
          // resurrect un-hardened input.
          brandJson: brand ? JSON.stringify(brand) : null,
        },
      });

      // Seed the in-memory run state.
      RUN_STATE.set(runId, {
        events: [],
        status: "running",
        result: null,
        error: null,
        subscribers: new Set(),
        settledAt: null,
        brochureRowId: initial.id,
      });

      // Kick off the engine subprocess. Fire-and-forget — the route returns
      // synchronously with the runId. Failures land in the DB row + the
      // settled in-memory state for late stream-subscribers.
      brochureEngine
        .startRun({
          runId,
          tenantId,
          sectorKey,
          goal,
          styleKey,
          brand,
          models,
          strategy,
          onEvent: (event) => pushEvent(runId, event),
        })
        .then(async ({ result, billedUsd, pdfUrl }) => {
          const state = RUN_STATE.get(runId);
          if (state) {
            state.status = "completed";
            state.result = { result, pdfUrl, billedUsd };
            state.settledAt = Date.now();
          }
          pushEvent(runId, {
            type: "run.completed",
            data: { result, pdfUrl, billedUsd },
          });
          // Close SSE subscribers gracefully.
          if (state) {
            for (const sub of state.subscribers) {
              try {
                sub.end();
              } catch {
                /* ignore */
              }
            }
            state.subscribers.clear();
          }
          try {
            await prisma.travelBrochure.update({
              where: { id: initial.id },
              data: {
                status: "completed",
                pdfUrl: pdfUrl || null,
                billedUsd: billedUsd != null ? Number(billedUsd.toFixed(6)) : null,
                completedAt: new Date(),
              },
            });
          } catch (e) {
            console.error("[brochures] failed to persist completion:", e.message);
          }
        })
        .catch(async (err) => {
          // RUN_CANCELLED comes from cancelRun() killing the subprocess (Stop button).
          // Treat it as a clean cancellation, not an engine failure.
          const cancelled = (err.message || "") === "RUN_CANCELLED";
          const msg = cancelled ? "Cancelled by user" : err.message || String(err);
          const state = RUN_STATE.get(runId);
          if (state) {
            state.status = cancelled ? "cancelled" : "failed";
            state.error = msg;
            state.settledAt = Date.now();
          }
          pushEvent(runId, {
            type: cancelled ? "run.cancelled" : "run.failed",
            data: { error: msg },
          });
          if (state) {
            for (const sub of state.subscribers) {
              try {
                sub.end();
              } catch {
                /* ignore */
              }
            }
            state.subscribers.clear();
          }
          try {
            await prisma.travelBrochure.update({
              where: { id: initial.id },
              data: {
                status: cancelled ? "cancelled" : "failed",
                errorMessage: msg.slice(0, 1000),
                completedAt: new Date(),
              },
            });
          } catch (e) {
            console.error("[brochures] failed to persist failure:", e.message);
          }
        });

      return res.json({ runId, brochureId: initial.id, status: "running" });
    } catch (e) {
      console.error("[brochures] start run error:", e);
      return res
        .status(500)
        .json({ error: "Failed to start brochure run", code: "START_FAILED" });
    }
  },
);

// ─── GET /brochures/runs/:runId ───────────────────────────────────────────
// Snapshot of an active or recently-settled run — used by the operator UI
// when the SSE channel isn't available (polling fallback) or to fetch the
// final pdfUrl after the stream has closed.
router.get(
  "/brochures/runs/:runId",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    const { runId } = req.params;
    const row = await prisma.travelBrochure.findFirst({
      where: { runId, tenantId: req.travelTenant.id },
    });
    if (!row) {
      return res.status(404).json({ error: "Run not found", code: "RUN_NOT_FOUND" });
    }
    const state = RUN_STATE.get(runId);
    return res.json({
      runId,
      brochureId: row.id,
      status: row.status,
      pdfUrl: row.pdfUrl || null,
      billedUsd: row.billedUsd != null ? Number(row.billedUsd) : null,
      goal: row.goal,
      sectorKey: row.sectorKey,
      styleKey: row.styleKey,
      errorMessage: row.errorMessage,
      events: state ? state.events : [],
    });
  },
);

// ─── POST /brochures/runs/:runId/cancel ───────────────────────────────────
// Stop an in-flight run (operator hit Generate by mistake). Ownership-checked,
// then kills the engine subprocess; startRun's promise rejects RUN_CANCELLED and
// its .catch marks the run/DB row "cancelled" + closes SSE subscribers. Idempotent:
// a run that already settled (or an unknown live child) returns cancelled:false.
router.post(
  "/brochures/runs/:runId/cancel",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "write"),
  async (req, res) => {
    const { runId } = req.params;
    const row = await prisma.travelBrochure.findFirst({
      where: { runId, tenantId: req.travelTenant.id },
    });
    if (!row) {
      return res.status(404).json({ error: "Run not found", code: "RUN_NOT_FOUND" });
    }
    const cancelled = brochureEngine.cancelRun(runId);
    return res.json({ runId, cancelled, status: cancelled ? "cancelling" : row.status });
  },
);

// ─── GET /brochures/runs/:runId/stream ────────────────────────────────────
// SSE live trace. Replays buffered events on connect, then streams new ones
// until the run settles. The `X-Accel-Buffering: no` header disables Nginx
// buffering on the demo deploy (Nginx proxy_buffering is on by default and
// will hold the response until it has bytes worth flushing — fatal for SSE).
router.get(
  "/brochures/runs/:runId/stream",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    const { runId } = req.params;
    const row = await prisma.travelBrochure.findFirst({
      where: { runId, tenantId: req.travelTenant.id },
      select: { id: true, status: true },
    });
    if (!row) {
      return res.status(404).json({ error: "Run not found", code: "RUN_NOT_FOUND" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const state = RUN_STATE.get(runId);

    // Replay any buffered events so a late subscriber doesn't miss the run.
    if (state) {
      for (const e of state.events) sendOne(res, e);
    }

    // If the run has already settled, send a terminal event + close.
    if (!state || state.status !== "running") {
      const finalEvent = state
        ? state.status === "completed"
          ? { type: "run.completed", data: state.result || {} }
          : { type: "run.failed", data: { error: state.error || "Unknown error" } }
        : { type: "run.completed", data: { note: "Run already finished (no live state)" } };
      sendOne(res, finalEvent);
      return res.end();
    }

    state.subscribers.add(res);

    // 15s heartbeat to keep intermediaries from idle-closing the connection.
    const hb = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(hb);
      }
    }, 15_000);

    req.on("close", () => {
      clearInterval(hb);
      state.subscribers.delete(res);
    });
  },
);

// ─── GET /brochures/sectors ───────────────────────────────────────────────
// Sector + style catalog for the operator UI's picker. Returns the static
// allowlist that mirrors @agentic-os/sectors registry.
router.get(
  "/brochures/sectors",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    try {
      const sectors = await brochureEngine.listSectors();
      return res.json({ sectors });
    } catch (e) {
      console.error("[brochures] list sectors error:", e);
      return res.status(500).json({ error: "Failed to list sectors" });
    }
  },
);

// ─── GET /brochures/models ────────────────────────────────────────────────
// Model catalog for the operator UI's picker + pre-run cost estimate. Shells
// into the engine's CATALOG mode (BROCHURE_MODE=catalog, no LLM call) and
// returns { tiers, strategies, defaults, models:[…] }. `available` reflects
// which providers the configured keys can actually reach. If the engine isn't
// vendored / installed, this returns 503 with a hint rather than 500 so the UI
// can degrade to the strategy presets without a hard error.
router.get(
  "/brochures/models",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    try {
      const catalog = await brochureEngine.listModels();
      return res.json(catalog);
    } catch (e) {
      console.error("[brochures] list models error:", e.message);
      return res.status(503).json({
        error: "Model catalog unavailable — the brochure engine may not be installed.",
        code: "ENGINE_UNAVAILABLE",
        models: [],
        tiers: [],
        strategies: [],
      });
    }
  },
);

// ─── GET /brochures ───────────────────────────────────────────────────────
// List this tenant's past brochures (newest first, capped at 100).
router.get(
  "/brochures",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id, archivedAt: null };
      if (req.query.status) {
        where.status = String(req.query.status);
      }
      if (req.query.tripId) {
        const tid = parseInt(req.query.tripId, 10);
        if (Number.isInteger(tid)) where.tripId = tid;
      }
      if (req.query.itineraryId) {
        const iid = parseInt(req.query.itineraryId, 10);
        if (Number.isInteger(iid)) where.itineraryId = iid;
      }
      const rows = await prisma.travelBrochure.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          runId: true,
          status: true,
          goal: true,
          sectorKey: true,
          styleKey: true,
          pdfUrl: true,
          billedUsd: true,
          tripId: true,
          itineraryId: true,
          errorMessage: true,
          createdAt: true,
          completedAt: true,
        },
      });
      return res.json({ brochures: rows });
    } catch (e) {
      console.error("[brochures] list error:", e);
      return res.status(500).json({ error: "Failed to list brochures" });
    }
  },
);

// ─── Brand profiles (saved Brand Kits) ────────────────────────────────────
// Tenant-scoped, server-persisted brand presets so an agency saves its logo /
// accent / contacts / socials / QR link once and reuses them across devices and
// team members (NOT browser-local). The stored `payload` is the brand-kit FORM
// snapshot (round-trips straight back into the UI); it is re-sanitized by
// sanitizeBrandKit on every actual run, so this store only guards size/shape.
const PROFILE_LIMIT = 50;

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Validate the brand-kit FORM for storage (cap sizes, keep only a sane logo data-URI,
// valid hex, http(s) QR). Returns null when there's nothing usable.
function sanitizeProfileForm(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cap = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const form = {
    name: cap(raw.name, 80),
    tagline: cap(raw.tagline, 140),
    accentMode: raw.accentMode === "manual" ? "manual" : "auto",
    accent:
      typeof raw.accent === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.accent.trim())
        ? raw.accent.trim()
        : "#122647",
    qrUrl: typeof raw.qrUrl === "string" ? raw.qrUrl.slice(0, 500) : "",
    contact: Array.isArray(raw.contact)
      ? raw.contact.filter((x) => typeof x === "string").map((x) => x.slice(0, 120)).slice(0, 4)
      : [],
    socials: Array.isArray(raw.socials)
      ? raw.socials.filter((x) => typeof x === "string").map((x) => x.slice(0, 60)).slice(0, 6)
      : [],
    logoUrl: "",
    imagePool: [],
    custom: raw.custom && typeof raw.custom === "object" ? raw.custom : null,
    coverLogos: [],
    interiorLogos: null,
  };
  const okLogo = (u) => {
    if (typeof u !== "string") return false;
    if (u.length > 14_000_000) return false;
    // Legacy base64-inlined images (existing presets) keep working.
    if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(u)) return true;
    // S3-hosted images from the configured bucket.
    if (brochureS3Store.isS3Url(u)) return true;
    return false;
  };
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  // Keep only a reasonable raster data:image logo (base64 of a ≤200KB image ≈ 270KB).
  if (okLogo(raw.logoUrl)) form.logoUrl = raw.logoUrl;
  // Unified image pool — every uploaded image the user can select from for front / inside.
  if (Array.isArray(raw.imagePool)) {
    form.imagePool = raw.imagePool.filter((u) => okLogo(u)).slice(0, 8);
  }
  // Additional cover logos — keep valid data-URIs with numeric placement, capped at 8.
  if (Array.isArray(raw.coverLogos)) {
    form.coverLogos = raw.coverLogos
      .filter((l) => l && typeof l === "object" && okLogo(l.url))
      .slice(0, 8)
      .map((l) => ({ url: l.url, x: num(l.x, 0.5), y: num(l.y, 0.32), scale: num(l.scale, 0.24) }));
  }
  // Interior logo band — band enum + shared scale + items (valid data-URI + x), capped.
  if (raw.interiorLogos && typeof raw.interiorLogos === "object" && Array.isArray(raw.interiorLogos.items)) {
    const items = raw.interiorLogos.items
      .filter((l) => l && typeof l === "object" && okLogo(l.url))
      .slice(0, 8)
      .map((l) => ({ url: l.url, x: num(l.x, 0.5) }));
    if (items.length) {
      form.interiorLogos = {
        band: raw.interiorLogos.band === "bottom" ? "bottom" : "header",
        scale: num(raw.interiorLogos.scale, 0.16),
        items,
      };
    }
  }
  return form;
}

/** Collect every image URL stored in a brand-kit payload so we can diff or delete them. */
function collectBrandImageUrls(payload) {
  const urls = new Set();
  const form = safeParseJson(payload);
  if (form.logoUrl) urls.add(form.logoUrl);
  if (Array.isArray(form.imagePool)) form.imagePool.forEach((u) => urls.add(u));
  if (Array.isArray(form.coverLogos)) form.coverLogos.forEach((l) => l?.url && urls.add(l.url));
  if (form.interiorLogos?.items) form.interiorLogos.items.forEach((it) => it?.url && urls.add(it.url));
  return urls;
}

/** Multer instance for brand-image uploads: keep files in memory and pass buffers to S3. */
const brandImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only PNG, JPEG, WebP, or GIF images are allowed"));
  },
});

router.post(
  "/brochures/brand-images/upload",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "write"),
  brandImageUpload.array("images", 8),
  async (req, res) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        return res.status(400).json({ error: "No images uploaded", code: "NO_IMAGES" });
      }
      const tenantId = req.travelTenant.id;

      // S3 path
      if (brochureS3Store.isEnabled()) {
        const urls = await Promise.all(files.map((f) => brochureS3Store.uploadBrandImage(tenantId, f)));
        return res.json({ urls, storage: "s3" });
      }

      // Zero-config fallback: return base64 data URIs so the UI still works without S3.
      const urls = files.map((f) => `data:${f.mimetype};base64,${f.buffer.toString("base64")}`);
      return res.json({ urls, storage: "inline" });
    } catch (e) {
      console.error("[brand-images] upload error:", e);
      return res.status(500).json({ error: "Failed to upload brand images", code: "UPLOAD_FAILED" });
    }
  },
);

router.delete(
  "/brochures/brand-images/file",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "write"),
  async (req, res) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      if (!url) return res.status(400).json({ error: "url is required", code: "URL_REQUIRED" });
      const result = await brochureS3Store.deleteBrandImage(req.travelTenant.id, url);
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error("[brand-images] delete error:", e);
      return res.status(500).json({ error: "Failed to delete brand image", code: "DELETE_FAILED" });
    }
  },
);

router.get(
  "/brochures/brand-profiles",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    try {
      const rows = await prisma.travelBrandProfile.findMany({
        where: { tenantId: req.travelTenant.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const profiles = rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        brand: safeParseJson(r.payload),
      }));
      return res.json({ profiles });
    } catch (e) {
      console.error("[brand-profiles] list error:", e);
      return res.status(500).json({ error: "Failed to load brand profiles" });
    }
  },
);

router.post(
  "/brochures/brand-profiles",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "write"),
  async (req, res) => {
    try {
      const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 120) : "";
      if (!name) {
        return res.status(400).json({ error: "Profile name is required", code: "NAME_REQUIRED" });
      }
      const form = sanitizeProfileForm(req.body.brand);
      if (!form) {
        return res.status(400).json({ error: "brand is required", code: "BRAND_REQUIRED" });
      }
      const payload = JSON.stringify(form);
      // Re-saving the same name overwrites (so a profile is a stable named slot).
      const existing = await prisma.travelBrandProfile.findFirst({
        where: { tenantId: req.travelTenant.id, name },
      });
      if (!existing) {
        const count = await prisma.travelBrandProfile.count({
          where: { tenantId: req.travelTenant.id },
        });
        if (count >= PROFILE_LIMIT) {
          return res
            .status(400)
            .json({ error: `Profile limit reached (${PROFILE_LIMIT}). Delete one first.`, code: "LIMIT" });
        }
      }
      const row = existing
        ? await prisma.travelBrandProfile.update({ where: { id: existing.id }, data: { payload } })
        : await prisma.travelBrandProfile.create({
            data: { tenantId: req.travelTenant.id, userId: req.user?.userId ?? null, name, payload },
          });

      // Clean up S3 images that were dropped during the update (name-based overwrite).
      if (existing && brochureS3Store.isEnabled()) {
        const oldUrls = collectBrandImageUrls(existing.payload);
        const newUrls = collectBrandImageUrls(payload);
        for (const url of oldUrls) {
          if (!newUrls.has(url)) {
            await brochureS3Store.deleteBrandImage(req.travelTenant.id, url);
          }
        }
      }

      return res.json({ id: row.id, name: row.name, createdAt: row.createdAt, brand: form });
    } catch (e) {
      console.error("[brand-profiles] create error:", e);
      return res.status(500).json({ error: "Failed to save brand profile" });
    }
  },
);

router.delete(
  "/brochures/brand-profiles/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "write"),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
    }
    try {
      const row = await prisma.travelBrandProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!row) {
        return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
      }
      if (brochureS3Store.isEnabled()) {
        for (const url of collectBrandImageUrls(row.payload)) {
          await brochureS3Store.deleteBrandImage(req.travelTenant.id, url);
        }
      }
      await prisma.travelBrandProfile.delete({ where: { id } });
      return res.json({ deleted: true, id });
    } catch (e) {
      console.error("[brand-profiles] delete error:", e);
      return res.status(500).json({ error: "Failed to delete brand profile" });
    }
  },
);

// ─── GET /brochures/:id ───────────────────────────────────────────────────
router.get(
  "/brochures/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
    }
    const row = await prisma.travelBrochure.findFirst({
      where: { id, tenantId: req.travelTenant.id, archivedAt: null },
    });
    if (!row) {
      return res.status(404).json({ error: "Brochure not found" });
    }
    return res.json(row);
  },
);

// ─── GET /brochures/:id/download ──────────────────────────────────────────
// Auth-gated download/view proxy. Serves the persisted brochure artifact from
// S3 (or local disk for pre-S3 rows) so the frontend doesn't depend on the S3
// bucket being world-readable. Default Content-Disposition is attachment so the
// browser saves the file with a sensible name. Pass ?inline=1 to display it
// inline (used by the "Open" link).
router.get(
  "/brochures/:id/download",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "read"),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
    }
    const row = await prisma.travelBrochure.findFirst({
      where: { id, tenantId: req.travelTenant.id, archivedAt: null },
      select: { id: true, pdfUrl: true, runId: true, goal: true },
    });
    if (!row) {
      return res.status(404).json({ error: "Brochure not found" });
    }
    if (!row.pdfUrl) {
      return res.status(404).json({ error: "Brochure file not ready" });
    }

    try {
      const url = row.pdfUrl;
      const isLocal = url.startsWith("/api/brochure-assets/") || url.startsWith("/brochure-assets/");
      const isS3 = brochureS3Store.isS3Url(url);

      // Derive a friendly download filename from the run id + goal.
      const safeGoal = String(row.goal || "brochure")
        .split(/\s+/)
        .slice(0, 6)
        .join("-")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 40) || "brochure";
      const isHtml = /\.html?($|\?)/i.test(url);
      const ext = isHtml ? "html" : "pdf";
      const downloadName = `${safeGoal}-${row.runId || row.id}.${ext}`;
      const contentType = isHtml ? "text/html" : "application/pdf";
      const inline = req.query.inline === '1';
      const dispositionType = inline ? 'inline' : 'attachment';

      if (isS3) {
        try {
          const { stream, contentType: s3Type, contentLength } = await brochureS3Store.streamBrochure(
            req.travelTenant.id,
            url,
          );
          res.setHeader("Content-Type", s3Type || contentType);
          res.setHeader("Content-Disposition", `${dispositionType}; filename="${downloadName}"`);
          if (contentLength) res.setHeader("Content-Length", contentLength);
          stream.on("error", (err) => {
            console.error(`[brochures] S3 stream error for ${id}:`, err.message);
            if (!res.headersSent) {
              return res.status(502).json({ error: "Failed to stream brochure file", code: "DOWNLOAD_FAILED" });
            }
            res.destroy();
          });
          stream.pipe(res);
          return;
        } catch (s3Err) {
          console.error(`[brochures] S3 validation/stream error for ${id}:`, s3Err.message);
          return res.status(502).json({ error: "Failed to access brochure file", code: "S3_ACCESS_FAILED", details: s3Err.message });
        }
      }

      if (isLocal) {
        const localName = url.replace("/api/brochure-assets/", "").replace("/brochure-assets/", "");
        const localPath = path.join(brochureEngine.GENERATED_DIR, localName);
        try {
          await fs.promises.access(localPath);
        } catch {
          return res.status(404).json({ error: "Brochure file not found on disk" });
        }
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `${dispositionType}; filename="${downloadName}"`);
        const fileStream = fs.createReadStream(localPath);
        fileStream.on("error", (err) => {
          console.error(`[brochures] local file stream error for ${id}:`, err.message);
          if (!res.headersSent) {
            return res.status(502).json({ error: "Failed to stream brochure file", code: "DOWNLOAD_FAILED" });
          }
          res.destroy();
        });
        return fileStream.pipe(res);
      }

      // External / legacy URL — redirect rather than proxying cross-origin.
      return res.redirect(url);
    } catch (e) {
      console.error(`[brochures] download error for ${id}:`, e.message);
      return res.status(502).json({ error: "Failed to stream brochure file", code: "DOWNLOAD_FAILED" });
    }
  },
);

// ─── DELETE /brochures/:id ────────────────────────────────────────────────
// Soft-archive — keeps the row + PDF on disk for audit / undo.
router.delete(
  "/brochures/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("marketing", "delete"),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
    }
    try {
      const result = await prisma.travelBrochure.updateMany({
        where: { id, tenantId: req.travelTenant.id, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      if (result.count === 0) {
        return res.status(404).json({ error: "Brochure not found" });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error("[brochures] delete error:", e);
      return res.status(500).json({ error: "Failed to archive brochure" });
    }
  },
);


module.exports = router;
