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
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { requireTravelTenant } = require("../middleware/travelGuards");
const prisma = require("../lib/prisma");
const brochureEngine = require("../services/brochureEngineBridge");

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
      const brand =
        req.body.brand && typeof req.body.brand === "object" ? req.body.brand : undefined;
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
          sectorKey,
          goal,
          styleKey,
          brand,
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
          const state = RUN_STATE.get(runId);
          if (state) {
            state.status = "failed";
            state.error = err.message || String(err);
            state.settledAt = Date.now();
          }
          pushEvent(runId, {
            type: "run.failed",
            data: { error: err.message || String(err) },
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
                status: "failed",
                errorMessage: (err.message || String(err)).slice(0, 1000),
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
