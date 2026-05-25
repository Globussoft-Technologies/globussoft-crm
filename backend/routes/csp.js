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
const { verifyToken, verifyRole } = require("../middleware/auth");

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

/**
 * GET /api/csp/violations — operator-inspect surface for slice 2 ingestions.
 *
 * Slice 3 (#917). Read-only ADMIN-only listing of the AuditLog rows that
 * slice 2's POST /report has been writing as the strict CSP-Report-Only
 * header catches violations in the browser. The security-audit team uses
 * this to triage whether a candidate CSP tightening is safe to flip from
 * Report-Only to enforce — a noisy directive (lots of legitimate
 * violations) needs widening first, a clean directive can flip.
 *
 * Tenant scoping
 * ──────────────
 * AuditLog.tenantId is NOT NULL with @default(1). Slice 2 hardcoded
 * tenantId=1 (single-tenant demo); future slices may resolve the tenant
 * from the Host header. Either way, scope by req.user.tenantId — an
 * ADMIN in tenant A must not see tenant B's violation reports.
 *
 * Defensive parsing
 * ─────────────────
 * `details` is a String column storing JSON.stringify(report). If a row's
 * details was written outside the slice-2 path and isn't parseable JSON,
 * surface a `{_raw: '<truncated>'}` stub rather than 500ing the whole
 * listing. The viewer should never go red because of one malformed row.
 *
 * Originalpolicy is truncated to 200 chars because the CSP policy string
 * is several KB and would dominate the response payload.
 *
 * Query filters
 * ─────────────
 *   limit    — default 100, capped at 500
 *   offset   — default 0
 *   from/to  — ISO date bounds on createdAt (optional)
 *   directive — filters by violated-directive (parsed from details)
 *
 * Auth: verifyToken + verifyRole(['ADMIN']). The global guard at
 * server.js:570 already gates this route since `/csp/violations` is NOT
 * in openPaths (`/csp/report` is the only CSP-namespaced open path).
 * Local guards here are defense-in-depth.
 */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const POLICY_TRUNC = 200;

function parseDetails(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Surface a stub so the listing keeps working under partial corruption.
    const truncated = typeof raw === "string" ? raw.slice(0, 200) : "<non-string>";
    return { _raw: truncated };
  }
}

function extractReportFields(parsed) {
  // Slice 2 stores either:
  //   {"csp-report": {...}}          (W3C application/csp-report)
  //   [{"type":"csp-violation","body":{...}}]  (application/reports+json)
  //   {...}                          (plain JSON variants)
  //
  // Normalise to the first violation's fields. If we can't pick a single
  // record (e.g. _raw stub or empty object), return nulls — the row still
  // appears in the listing so operators can investigate.
  if (!parsed || typeof parsed !== "object") return {};
  if (parsed._raw !== undefined) return { _raw: parsed._raw };

  // W3C csp-report wrapper
  let body = null;
  if (parsed["csp-report"] && typeof parsed["csp-report"] === "object") {
    body = parsed["csp-report"];
  } else if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && parsed[0].body) {
    // Reporting-API: take the first entry's body.
    const first = parsed[0].body;
    // Reporting-API uses camelCase fields. Map to W3C kebab-case so the
    // response shape is uniform regardless of which protocol the browser used.
    body = {
      "document-uri": first.documentURL || null,
      "violated-directive": first.effectiveDirective || null,
      "blocked-uri": first.blockedURL || null,
      "source-file": first.sourceFile || null,
      "line-number": first.lineNumber || null,
      "column-number": first.columnNumber || null,
      "original-policy": first.originalPolicy || null,
    };
  } else {
    // Plain JSON — try direct field reads.
    body = parsed;
  }

  return {
    directive: body["violated-directive"] || body["effective-directive"] || null,
    blockedUri: body["blocked-uri"] || null,
    documentUri: body["document-uri"] || null,
    sourceFile: body["source-file"] || null,
    lineNumber: body["line-number"] != null ? Number(body["line-number"]) : null,
    columnNumber: body["column-number"] != null ? Number(body["column-number"]) : null,
    originalPolicy: typeof body["original-policy"] === "string"
      ? body["original-policy"].slice(0, POLICY_TRUNC)
      : null,
  };
}

router.get(
  "/violations",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      // Parse + clamp pagination.
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;

      let offset = parseInt(req.query.offset, 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;

      // Build the where-clause. Tenant scoping is required — an ADMIN of
      // tenant A must not see tenant B's CSP reports.
      const where = {
        tenantId: req.user.tenantId,
        entity: "CSPViolation",
        action: "REPORT",
      };

      // Optional ISO date bounds.
      if (req.query.from || req.query.to) {
        where.createdAt = {};
        if (req.query.from) {
          const d = new Date(req.query.from);
          if (!isNaN(d.getTime())) where.createdAt.gte = d;
        }
        if (req.query.to) {
          const d = new Date(req.query.to);
          if (!isNaN(d.getTime())) where.createdAt.lte = d;
        }
        // If the from/to were both invalid the {} stays, which Prisma
        // treats as a no-op filter — same as omitting.
        if (!where.createdAt.gte && !where.createdAt.lte) {
          delete where.createdAt;
        }
      }

      // Directive filter is applied AFTER parsing because the directive
      // lives inside the JSON-string `details` column — we can't do a
      // SQL-side index lookup on it. Fetch the unfiltered slice + filter
      // in-memory. Cap on `limit` keeps this bounded.
      const directiveFilter = req.query.directive
        ? String(req.query.directive).trim().toLowerCase()
        : null;

      // If a directive filter is present we may need to walk more rows
      // than `limit` to satisfy it. Pre-fetch up to MAX_LIMIT and slice.
      const fetchLimit = directiveFilter ? MAX_LIMIT : limit;
      const fetchOffset = directiveFilter ? 0 : offset;

      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: fetchOffset,
          take: fetchLimit,
        }),
        prisma.auditLog.count({ where }),
      ]);

      const decorated = rows.map((row) => {
        const parsed = parseDetails(row.details);
        const fields = extractReportFields(parsed);
        return {
          at: row.createdAt,
          directive: fields.directive || null,
          blockedUri: fields.blockedUri || null,
          documentUri: fields.documentUri || null,
          sourceFile: fields.sourceFile || null,
          lineNumber: fields.lineNumber || null,
          columnNumber: fields.columnNumber || null,
          tenantId: row.tenantId,
          originalPolicy: fields.originalPolicy || null,
          // If the row's details didn't parse, surface the truncated raw
          // string so operators can spot the malformed row.
          ...(fields._raw !== undefined ? { _raw: fields._raw } : {}),
        };
      });

      let violations = decorated;
      if (directiveFilter) {
        violations = violations.filter(
          (v) => v.directive && v.directive.toLowerCase().includes(directiveFilter),
        );
        // Apply pagination AFTER filtering for the directive-filter path.
        violations = violations.slice(offset, offset + limit);
      }

      return res.json({
        total,
        violations,
        limit,
        offset,
      });
    } catch (err) {
      console.error("[CSP][violations] list failed:", err && err.message);
      return res.status(500).json({
        error: "Failed to fetch CSP violations",
        code: "CSP_VIOLATIONS_LIST_FAILED",
      });
    }
  },
);

module.exports = router;
