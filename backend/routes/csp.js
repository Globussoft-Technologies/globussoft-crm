/**
 * #917 slice 2 — POST /api/csp/report — CSP violation-report ingestion.
 *
 * Why this exists
 * ───────────────
 * Slice 1 (commit `8c1bd5e`, pinned by e2e/tests/security-headers.spec.js:222-230)
 * layered a STRICT Content-Security-Policy in Report-Only mode alongside the
 * existing transitional enforce-mode CSP. That report-only header has no
 * `report-uri` directive yet — browsers see the strict policy but have no
 * working endpoint to deliver violation reports to. Slice 2 (this file) adds
 * the ingestion endpoint; slice 2b wires `report-uri /api/csp/report` into
 * the directive list so the loop closes.
 *
 * What this endpoint accepts
 * ──────────────────────────
 *  - W3C CSP3 reporting format (`application/csp-report`):
 *      { "csp-report": { "document-uri", "violated-directive",
 *                        "blocked-uri", "source-file", "line-number", ... } }
 *  - Newer Reporting API format (`application/reports+json`):
 *      [ { "type": "csp-violation", "body": {...} }, ... ]
 *  - Plain `application/json` (some browsers + test runners).
 *
 * Body is capped at 4 KiB — any larger payload is dropped with 413. A CSP
 * report endpoint must be intentionally taciturn: it MUST NOT echo any
 * content back (would create an amplification surface) and MUST NOT fail
 * loud on malformed input (browsers won't retry; just drop and move on).
 *
 * Storage
 * ───────
 * Violations land in AuditLog with entity='CSPViolation', action='REPORT'.
 * tenantId is hardcoded to 1 in slice 2; slice 3 will derive it from the
 * Host header by looking up Tenant by domain. (AuditLog.tenantId is NOT
 * NULL with @default(1) so we can't write NULL today even if we wanted.)
 *
 * Auth
 * ────
 * NO auth required. Browsers cannot send Authorization headers on CSP
 * reports (W3C spec — they're emitted by the browser, not by JS). The
 * global auth guard at server.js exempts `/csp/report` via openPaths.
 *
 * Rate-limiting is provided by the global `/api` apiLimiter
 * (server.js:152-159) — a malicious site flooding our endpoint with
 * fake reports hits that limit; we don't need a separate per-route
 * limiter (the route does no expensive work either way).
 */
const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// Hard cap on the JSON body size — anything larger is 413'd.
const MAX_CSP_REPORT_BYTES = 4 * 1024; // 4 KiB

// Accept all three content-types browsers + test runners send for CSP
// reports. `express.json({ type })` matches a function or string; an
// array of strings tells the underlying body-parser to accept any of
// them. The `verify` hook caps the raw body length BEFORE JSON.parse
// runs so an attacker can't bypass the limit via deeply-nested JSON.
const cspJsonParser = express.json({
  type: [
    "application/csp-report",
    "application/reports+json",
    "application/json",
  ],
  limit: MAX_CSP_REPORT_BYTES,
  // strict: false — `application/reports+json` ships a top-level array, not
  // an object. express.json defaults to strict:true which would reject the
  // array shape with a 400.
  strict: false,
});

/**
 * POST /api/csp/report — receive a CSP violation report.
 *
 * Response is always 204 No Content with empty body, regardless of input
 * shape (valid, empty, or malformed). 413 PAYLOAD_TOO_LARGE is the ONE
 * exception — the body-parser threw before we could fire-and-forget.
 */
router.post("/report", (req, res, _next) => {
  cspJsonParser(req, res, (err) => {
    if (err) {
      // express.json's PayloadTooLargeError carries `.status === 413`
      if (err.status === 413 || err.statusCode === 413 || err.type === "entity.too.large") {
        return res.status(413).json({
          error: "Payload too large",
          code: "PAYLOAD_TOO_LARGE",
          limit: MAX_CSP_REPORT_BYTES,
        });
      }
      // Any other parser error (malformed JSON, etc.) → still 204. CSP
      // endpoints stay quiet on bad input by design.
      return res.status(204).end();
    }

    // Persist fire-and-forget. We don't await before responding because:
    //   (a) browsers don't wait for or retry on the response anyway,
    //   (b) latency on a security-telemetry write must not back-pressure
    //       the originating page request.
    // tenantId hardcoded to 1 in slice 2; slice 3 derives from Host.
    const reportPayload = req.body || {};
    const detailsStr = (() => {
      try {
        return JSON.stringify(reportPayload);
      } catch (_) {
        return "<unserializable>";
      }
    })();

    prisma.auditLog
      .create({
        data: {
          tenantId: 1,
          entity: "CSPViolation",
          action: "REPORT",
          details: detailsStr,
        },
      })
      .catch((dbErr) => {
        // Telemetry should never throw to the caller. Log + swallow.
        console.error("[CSP][report] persist failed:", dbErr?.message || dbErr);
      });

    return res.status(204).end();
  });
});

module.exports = router;
