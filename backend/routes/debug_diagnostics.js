/**
 * debug_diagnostics.js — temporary, operator-gated diagnostics for live memory
 * investigations. Mounted under /internal/debug so it bypasses the global auth
 * guard, but protected by a shared secret and/or localhost.
 *
 * Endpoints:
 *   GET  /internal/debug/memory   — process.memoryUsage + v8 heap stats
 *   POST /internal/debug/heapdump — write v8 heap snapshot, return path
 *
 * Disabled unless DEBUG_INTERNAL_ENDPOINTS=1 and the caller supplies the
 * X-Debug-Key header matching DEBUG_INTERNAL_KEY (or calls from 127.0.0.1).
 */

const v8 = require("v8");
const path = require("path");
const fs = require("fs");

const ENABLED = /^(1|true|yes)$/i.test(process.env.DEBUG_INTERNAL_ENDPOINTS || "");
const KEY = process.env.DEBUG_INTERNAL_KEY || "";

function forbidden(res, msg) {
  res.status(403).json({ error: msg, code: "DEBUG_FORBIDDEN" });
}

function authorize(req, res, next) {
  if (!ENABLED) return forbidden(res, "diagnostics disabled");
  const fromLocal = req.ip === "127.0.0.1" || req.socket.remoteAddress === "127.0.0.1";
  const keyOk = KEY && req.get("X-Debug-Key") === KEY;
  if (!fromLocal && !keyOk) return forbidden(res, "invalid or missing debug key");
  next();
}

function getMemoryStats() {
  return {
    pid: process.pid,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    heapStatistics: v8.getHeapStatistics(),
    heapSpaceStatistics: v8.getHeapSpaceStatistics(),
    resourceUsage: process.resourceUsage ? process.resourceUsage() : undefined,
  };
}

module.exports = (router) => {
  router.get("/memory", authorize, (req, res) => {
    res.json({ ok: true, ...getMemoryStats() });
  });

  router.post("/heapdump", authorize, async (req, res) => {
    try {
      const ts = Date.now();
      const outDir = path.join(__dirname, "..", "logs");
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `heapdump-${process.pid}-${ts}.heapsnapshot`);
      console.log(`[debug] writing heap snapshot to ${outPath} ...`);
      v8.writeHeapSnapshot(outPath);
      const stats = fs.statSync(outPath);
      res.json({ ok: true, path: outPath, sizeBytes: stats.size });
    } catch (err) {
      console.error("[debug] heapdump failed:", err);
      res.status(500).json({ error: err.message, code: "HEAPDUMP_FAILED" });
    }
  });

  return router;
};
