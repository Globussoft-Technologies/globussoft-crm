/**
 * brochureEngineBridge.js — CommonJS shim that drives the agentic-orchcrm
 * brochure engine from the CRM Express backend.
 *
 * The engine workspace (sibling folder `agentic-orchcrm/`) is ESM TypeScript
 * run via `tsx`. Importing it directly from the CRM's CommonJS backend is
 * not portable (NodeNext + .js-pointing-at-.ts specifiers + chained workspace
 * imports). Spawning `tsx apps/orchestrator/src/crm-bridge.ts` per run gives
 * us a clean process boundary: the engine reads its `.env`, runs the
 * orchestration in-process, writes JSONL events to stderr, and prints the
 * final result on stdout.
 *
 * Per INTEGRATION.md §5 — runs are TRANSIENT (~30-60s); the durable record
 * is a Prisma TravelBrochure row written by the route layer on completion.
 * This bridge does not touch the database.
 *
 * Public API:
 *   startRun({ runId, sectorKey, goal, styleKey, brand, onEvent }) → Promise<RunResult>
 *   listSectors() → Promise<Array<{ key, name?, description?, styles?, agents? }>>
 *
 * Both surface engine errors as plain Errors with `.message`; the route layer
 * is responsible for translating to HTTP status codes.
 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const brochureS3Store = require("../lib/brochureS3Store");

// Resolve once at module load — the engine workspace must sit at the repo
// root as a sibling of backend/. INTEGRATION.md vendored as a clone (not
// a workspace) so we walk up two levels from this file.
const ENGINE_ROOT = path.resolve(__dirname, "..", "..", "agentic-orchcrm");
// Invoke tsx's ESM CLI directly via the node binary, NOT the .bin/tsx.cmd
// shim. Node 20+ on Windows throws EINVAL when child_process.spawn() targets
// a .cmd / .bat file directly (CVE-2024-27980 hardening). Using node +
// cli.mjs sidesteps the shim entirely and works identically cross-platform.
const TSX_CLI = path.join(ENGINE_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const BRIDGE_SCRIPT = path.join(
  ENGINE_ROOT,
  "apps",
  "orchestrator",
  "src",
  "crm-bridge.ts",
);

// Where the engine writes its generated PDFs. The engine's loadConfig
// defaults GENERATED_DIR to `<cwd>/public/generated` — and since we spawn
// the subprocess with cwd=ENGINE_ROOT, the actual on-disk path is
// agentic-orchcrm/public/generated/<file>.pdf (NOT apps/web/public/generated,
// which is only used when running `npm run web` from the apps/web directory).
// The Express static mount in server.js serves this directory as
// /brochure-assets/<file>.pdf so the operator UI can fetch the PDF.
const GENERATED_DIR = process.env.GENERATED_DIR
  ? path.resolve(process.env.GENERATED_DIR)
  : path.join(ENGINE_ROOT, "public", "generated");

/**
 * Kick off ONE orchestration. Spawns the bridge script, streams events to
 * onEvent, resolves with the final result.
 *
 * @param {object} args
 * @param {string} args.runId         Run id (caller-supplied so the route can
 *                                    return it before the subprocess starts).
 * @param {number} args.tenantId      Tenant owning this brochure (for S3 key prefix).
 * @param {string} args.sectorKey     "travel" | "report-writing" | ...
 * @param {string} args.goal          The brief.
 * @param {string} [args.styleKey]    Optional template key.
 * @param {object} [args.brand]       Sanitized brand kit.
 * @param {object} [args.models]      Optional per-tier model id map (switchable
 *                                    models), e.g. { reasoning, balanced, fast, writing }.
 * @param {string} [args.strategy]    Optional preset ('recommended'|'cheapest'|'smartest'),
 *                                    applied only when `models` is absent.
 * @param {(e: object) => void} [args.onEvent]  Called for each engine event.
 * @returns {Promise<{ runId: string, result: unknown, billedUsd: number, pdfUrl: string | null }>}
 */
// Live engine subprocesses keyed by runId, so an operator who hit Generate by
// mistake can cancel a run (see cancelRun + the route's /cancel endpoint). Cleared
// on the child's "close" so the map never leaks PIDs.
const RUNNING_CHILDREN = new Map();

function startRun({ runId, tenantId, sectorKey, goal, styleKey, brand, models, strategy, onEvent }) {
  return new Promise((resolve, reject) => {
    const brief = JSON.stringify({ runId, sectorKey, goal, styleKey, brand, models, strategy });
    const child = spawn(process.execPath, [TSX_CLI, BRIDGE_SCRIPT], {
      cwd: ENGINE_ROOT,
      env: { ...process.env, BROCHURE_BRIEF: brief },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (runId) RUNNING_CHILDREN.set(runId, child);

    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });

    // Events arrive one JSON-per-line on stderr.
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      let nl;
      while ((nl = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line) continue;
        if (typeof onEvent === "function") {
          try {
            onEvent(JSON.parse(line));
          } catch {
            // Non-JSON noise from the workspace — surface as a plain log event
            // so the SSE channel stays useful without throwing.
            onEvent({ type: "engine.log", data: { line } });
          }
        }
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Engine subprocess failed to start: ${err.message}`));
    });

    child.on("close", async (code) => {
      if (runId) RUNNING_CHILDREN.delete(runId);
      // Operator cancelled the run (Stop button) — the child was killed, so there's
      // no JSON result to parse. Surface a clean, detectable CANCELLED rejection.
      if (child.__cancelled) {
        return reject(new Error("RUN_CANCELLED"));
      }
      // Flush any trailing stderr bytes that didn't end with \n.
      if (stderrBuf.trim() && typeof onEvent === "function") {
        try {
          onEvent(JSON.parse(stderrBuf.trim()));
        } catch {
          onEvent({ type: "engine.log", data: { line: stderrBuf.trim() } });
        }
      }

      const finalLine = stdoutBuf.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      let parsed;
      try {
        parsed = JSON.parse(finalLine);
      } catch {
        return reject(
          new Error(
            `Engine subprocess exited with code ${code} but no parseable JSON result on stdout.`,
          ),
        );
      }
      if (!parsed.ok) {
        return reject(new Error(parsed.error || `Engine run failed (exit ${code})`));
      }

      // orchestrator.run() returns { runId, result: <string> }. For the
      // brochure path that string is shaped like:
      //   "Your document is ready (PDF).\nDownload: /generated/brochure-<id>.pdf"
      // So we extract the /generated/<file> URL from the body and rewrite
      // it to /api/brochure-assets/<file> — server.js mounts the static
      // dir at BOTH /brochure-assets (legacy, prod-only) and
      // /api/brochure-assets. We emit the /api/ form so Vite's dev proxy
      // forwards the request to the backend; the bare /brochure-assets
      // form hit Vite's SPA fallback and rendered the React 404 page
      // (and the "downloaded PDF" was actually that 404 HTML).
      const result = parsed.result;
      let pdfUrl = null;
      if (typeof result === "string") {
        const m = result.match(/\/generated\/([^\s)]+\.(?:pdf|html))/i);
        if (m) {
          pdfUrl = "/api/brochure-assets/" + m[1];
        }
      } else if (result && typeof result.url === "string" && result.url.startsWith("/generated/")) {
        // Fallback if a future engine version returns the structured shape.
        pdfUrl = "/api/brochure-assets/" + result.url.slice("/generated/".length);
      }

      // If S3 is configured, promote the local file to S3 and remove the staging
      // copy so the server disk doesn't fill up. Failures are logged but never
      // break the run — the local URL remains valid.
      if (brochureS3Store.isEnabled() && pdfUrl) {
        try {
          const fileName = pdfUrl.replace("/api/brochure-assets/", "");
          const pdfPath = path.join(GENERATED_DIR, fileName);
          const htmlPath = pdfPath.replace(/\.pdf$/i, ".html");
          const pdfBuffer = await fs.promises.readFile(pdfPath);
          const htmlExists = await fs.promises
            .access(htmlPath)
            .then(() => true)
            .catch(() => false);
          const [s3PdfUrl] = await Promise.all([
            brochureS3Store.uploadBrochurePdf(tenantId, runId, pdfBuffer),
            htmlExists
              ? brochureS3Store.uploadBrochureHtml(
                  tenantId,
                  runId,
                  await fs.promises.readFile(htmlPath),
                )
              : Promise.resolve(null),
          ]);
          pdfUrl = s3PdfUrl;
          await fs.promises.unlink(pdfPath).catch(() => {});
          if (htmlExists) await fs.promises.unlink(htmlPath).catch(() => {});
        } catch (s3Err) {
          console.error(
            "[brochureEngineBridge] S3 upload failed for run",
            runId,
            "— keeping local PDF:",
            s3Err.message,
          );
        }
      }

      resolve({
        runId: parsed.runId || runId,
        result,
        billedUsd: Number(parsed.billedUsd || 0),
        pdfUrl,
      });
    });
  });
}

/**
 * List the engine's MODEL catalog (CATALOG mode). Spawns crm-bridge.ts exactly
 * like startRun, but with env BROCHURE_MODE=catalog and NO BROCHURE_BRIEF — no
 * LLM call, no event streaming. Reads the single final JSON object from the LAST
 * non-empty stdout line and resolves it.
 *
 * @returns {Promise<{ tiers: string[], strategies: string[], defaults: object,
 *                     models: Array<{ id, label, provider, available, intelligence,
 *                     costEff, inputPer1M, outputPer1M, blurb }> }>}
 */
function listModels() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, BRIDGE_SCRIPT], {
      cwd: ENGINE_ROOT,
      env: { ...process.env, BROCHURE_MODE: "catalog" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(new Error(`Engine subprocess failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      const finalLine = stdoutBuf.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      let parsed;
      try {
        parsed = JSON.parse(finalLine);
      } catch {
        return reject(
          new Error(
            `Engine catalog exited with code ${code} but no parseable JSON on stdout. ${stderrBuf.slice(-200)}`,
          ),
        );
      }
      if (!parsed.ok) {
        return reject(new Error(parsed.error || `Engine catalog failed (exit ${code})`));
      }
      resolve({
        tiers: Array.isArray(parsed.tiers) ? parsed.tiers : [],
        strategies: Array.isArray(parsed.strategies) ? parsed.strategies : [],
        defaults: parsed.defaults || {},
        markup: Number(parsed.markup) > 0 ? Number(parsed.markup) : 1.5, // billing markup → estimate
        models: Array.isArray(parsed.models) ? parsed.models : [],
      });
    });
  });
}

/**
 * Static sector catalog — mirrors the runtime allowlist in @agentic-os/sectors
 * (registry.ts) so the operator UI can render a picker without spinning up a
 * subprocess just to list options. Keep in sync with
 * packages/sectors/src/registry.ts when sectors are added/removed.
 *
 * If you need fully-dynamic sector + style data (e.g. art-direction labels),
 * call `listSectorsViaEngine()` instead — it shells into tsx the same way
 * startRun does and reads the live registry.
 */
function listSectors() {
  return Promise.resolve([
    {
      key: "travel",
      name: "Travel Brochure",
      description:
        "Agency-grade travel brochure — cover, day-by-day itinerary, route map, inclusions, pricing.",
      // From packages/tools/src/brochure/templates.ts — these are TEMPLATE
      // keys (look-and-feel), not art-direction briefs. tmc-press is the
      // default if styleKey is omitted.
      styles: ["tmc-press", "editorial-sakura"],
    },
    {
      key: "report-writing",
      name: "Report (HTML→PDF)",
      description:
        "Long-form report rendered as A4 PDF with an art-direction style picker.",
      // From packages/sectors/src/styles.ts STYLE_KEYS.
      styles: [
        "auto",
        "vintage-poster",
        "luxury-magazine",
        "modern-minimal",
        "art-deco",
        "bold-contemporary",
        "botanical-watercolor",
      ],
    },
    { key: "finance", name: "Finance Brief", description: "Concise financial analysis brief." },
    { key: "healthcare", name: "Healthcare Brief", description: "Healthcare summary brief." },
  ]);
}

/**
 * Cancel an in-flight run by killing its engine subprocess. Returns true if a live
 * child was found and signalled, false otherwise (already finished / unknown runId).
 * The killed child's "close" handler rejects startRun's promise with RUN_CANCELLED.
 */
function cancelRun(runId) {
  const child = RUNNING_CHILDREN.get(runId);
  if (!child) return false;
  child.__cancelled = true;
  try {
    child.kill("SIGTERM");
    // Hard-stop after a grace period if the process ignores SIGTERM (tsx + Chromium
    // can hold on). unref so this timer never keeps the backend alive.
    setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 2000).unref?.();
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  startRun,
  cancelRun,
  listModels,
  listSectors,
  ENGINE_ROOT,
  GENERATED_DIR,
};
