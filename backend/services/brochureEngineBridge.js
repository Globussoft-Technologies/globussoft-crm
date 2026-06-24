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
const { spawn } = require("child_process");

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
 * @param {string} args.sectorKey     "travel" | "report-writing" | ...
 * @param {string} args.goal          The brief.
 * @param {string} [args.styleKey]    Optional template key.
 * @param {object} [args.brand]       Sanitized brand kit.
 * @param {(e: object) => void} [args.onEvent]  Called for each engine event.
 * @returns {Promise<{ runId: string, result: unknown, billedUsd: number, pdfUrl: string | null }>}
 */
function startRun({ runId, sectorKey, goal, styleKey, brand, onEvent }) {
  return new Promise((resolve, reject) => {
    const brief = JSON.stringify({ runId, sectorKey, goal, styleKey, brand });
    const child = spawn(process.execPath, [TSX_CLI, BRIDGE_SCRIPT], {
      cwd: ENGINE_ROOT,
      env: { ...process.env, BROCHURE_BRIEF: brief },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

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

    child.on("close", (code) => {
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

module.exports = {
  startRun,
  listSectors,
  ENGINE_ROOT,
  GENERATED_DIR,
};
