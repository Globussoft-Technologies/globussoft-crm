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

// ============================================================================
// GET /api/csp/violations/stats — tenant-wide CSP-violation aggregate rollup
// (#917 CSP hardening slice 5).
//
// Sibling to GET /violations (slice 3): same data source (AuditLog rows where
// entity='CSPViolation' + action='REPORT'), same tenant-scoping, same ADMIN
// gate. While /violations is the paginated listing surface for forensic
// triage, /violations/stats is the at-a-glance KPI surface — what the
// CSPViolations admin dashboard renders in its header summary strip:
//   "5 violations · script-src: 3, img-src: 2 · last reported 2h ago"
//
// Without this, the frontend has to fetch the full /violations slice and
// reduce client-side over a paginated window — which would systematically
// undercount once the table grows past `limit` rows (see the 2026-05-07
// wave-2 standing rule on client-side aggregation over paginated endpoints).
//
// Mirrors /suppliers/stats + /commission-profiles/stats posture across the
// rollup family — same {total, byX:{}, lastActivityAt} envelope, same
// INVALID_DATE error code on bad ?from/?to, same NO-audit-row contract.
//
// Sub-brand handling
// ──────────────────
// Slice 2 hardcoded tenantId=1 and didn't carry any sub-brand discriminator
// (CSP reports are emitted by the browser, not by an authenticated user, so
// there's no sub-brand context at ingest time). Stats endpoint is therefore
// tenant-scoped only — no sub-brand narrowing required or possible. This
// matches how the sibling /violations listing scopes (tenantId only).
//
// Query params
// ────────────
//   ?from — optional ISO date lower bound on createdAt; invalid → 400 INVALID_DATE
//   ?to   — optional ISO date upper bound on createdAt; invalid → 400 INVALID_DATE
//
// Response envelope
// ─────────────────
//   {
//     total:           <int>                — count of CSP violation rows
//     byDirective:     { "script-src": N }  — count by violated-directive,
//                                              parsed from details JSON
//     byBlockedUri:    { "eval": N }        — count by blocked-uri, top-10
//                                              entries only (cap)
//     lastReportedAt:  ISO | null           — max(createdAt) across matched rows
//   }
//
// Auth: verifyToken + verifyRole(['ADMIN']). Defense-in-depth matching the
// sibling /violations endpoint above.
//
// NO audit row written — anodyne read-only meta surface.
//
// Express route ordering: this is a literal-path /violations/stats. The
// /violations listing handler at line 229 above takes no path-suffix args
// so there's no /:id collision risk, but we place this BEFORE module.exports
// for symmetry with the rollup-family ordering convention.
// ============================================================================
const STATS_FETCH_CAP = 5000;
const BY_BLOCKED_URI_TOP_N = 10;

router.get(
  "/violations/stats",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const where = {
        tenantId: req.user.tenantId,
        entity: "CSPViolation",
        action: "REPORT",
      };

      // ?from / ?to ISO date bounds on createdAt. Bad input → 400 INVALID_DATE
      // (matches /suppliers/stats + /commission-profiles/stats convention).
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw) {
        const d = new Date(fromRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
      }

      // Fetch + count in parallel. We pull the rows (capped) for in-memory
      // aggregation because directive + blockedUri both live inside the
      // JSON-stringified `details` column — there's no index-side groupBy
      // available. count() runs over the full where so `total` is accurate
      // even when the row population exceeds STATS_FETCH_CAP.
      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          select: { details: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: STATS_FETCH_CAP,
        }),
        prisma.auditLog.count({ where }),
      ]);

      const byDirective = {};
      const byBlockedUriAll = {};
      let lastReportedAt = null;

      for (const row of rows) {
        // lastReportedAt — max(createdAt). Skip rows with null/invalid
        // createdAt defensively (count() still includes them in `total`).
        if (row.createdAt) {
          const ts = row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt);
          if (!Number.isNaN(ts.getTime())) {
            if (!lastReportedAt || ts > lastReportedAt) lastReportedAt = ts;
          }
        }

        // Parse details + extract the normalised W3C/Reporting-API fields
        // using the same helpers as /violations so the bucket keys stay
        // consistent across the listing + stats surfaces.
        const parsed = parseDetails(row.details);
        const fields = extractReportFields(parsed);

        if (fields.directive) {
          const key = String(fields.directive);
          byDirective[key] = (byDirective[key] || 0) + 1;
        }
        if (fields.blockedUri) {
          const key = String(fields.blockedUri);
          byBlockedUriAll[key] = (byBlockedUriAll[key] || 0) + 1;
        }
      }

      // Cap byBlockedUri to the top-N to keep the response payload bounded.
      // Sort by count desc, then key asc for deterministic tie-breaking.
      const byBlockedUri = {};
      const sortedBlockedEntries = Object.entries(byBlockedUriAll)
        .sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        })
        .slice(0, BY_BLOCKED_URI_TOP_N);
      for (const [k, v] of sortedBlockedEntries) byBlockedUri[k] = v;

      return res.json({
        total,
        byDirective,
        byBlockedUri,
        lastReportedAt: lastReportedAt ? lastReportedAt.toISOString() : null,
      });
    } catch (err) {
      console.error("[CSP][violations/stats] failed:", err && err.message);
      return res.status(500).json({
        error: "Failed to fetch CSP violation stats",
        code: "CSP_VIOLATIONS_STATS_FAILED",
      });
    }
  },
);

// ============================================================================
// GET /api/csp/violations/by-day — tenant-wide CSP-violation daily rollup
// (#917 CSP hardening slice 6).
//
// Sibling to GET /violations/stats (slice 5) and GET /violations (slice 3):
// same data source (AuditLog rows where entity='CSPViolation' +
// action='REPORT'), same tenant-scoping, same ADMIN gate. While /stats is the
// at-a-glance KPI surface and /violations is the paginated forensic listing,
// /by-day is the daily TIME-SERIES surface — what the CSPViolations admin
// dashboard renders as a Recharts area chart of violation volume over time.
//
// Without this, the frontend would have to fetch the full /violations slice
// and reduce client-side, undercounting once the row population exceeds the
// pagination window (the 2026-05-07 wave-2 standing rule on client-side
// aggregation over paginated endpoints).
//
// Mirrors /suppliers/by-month posture (UTC-bucket aggregation with
// JS-side rollup + post-aggregation sort + post-aggregation pagination) but
// at daily resolution. AuditLog-backed not Prisma-model-backed —
// `details` is a JSON-stringified W3C / Reporting-API payload that we parse
// with parseDetails + extractReportFields for shape parity with /stats.
//
// Query params
// ────────────
//   ?from   — optional inclusive YYYY-MM-DD lower bound; invalid → 400
//             INVALID_DATE_FORMAT
//   ?to     — optional inclusive YYYY-MM-DD upper bound; invalid → 400
//             INVALID_DATE_FORMAT
//   ?orderBy — default 'day:asc'; accepts day:{asc|desc}, count:{asc|desc}
//   ?limit  — default 30, capped at 90
//   ?offset — default 0
//
// Response envelope
// ─────────────────
//   {
//     total: <pre-pagination day-bucket count>,
//     rows: [
//       { day: "2026-05-15", count: 3, byDirective: { "script-src": 2, "img-src": 1 } },
//       ...
//     ]
//   }
//
// Aggregation discipline
// ──────────────────────
//   - UTC YYYY-MM-DD bucketing (date-bucket sort is lexicographic = chronological).
//   - "unknown" bucket for null/invalid createdAt; excluded when ?from/?to set
//     (no comparable token).
//   - Pagination AFTER aggregation + sort + ?from/?to filter, mirroring
//     /suppliers/by-month posture.
//
// Auth: verifyToken + verifyRole(['ADMIN']). Defense-in-depth matching the
// sibling /violations + /violations/stats endpoints.
//
// NO audit row written — anodyne read-only meta surface.
//
// Express route ordering: literal-path /violations/by-day. Placed BEFORE
// module.exports for symmetry with the slice-5 stats handler. No /:id family
// exists today on this router, so there's no collision risk — but matching
// the convention keeps future readers grepping for the right place to slot
// any /violations/:id endpoint a future slice might add.
// ============================================================================
const BY_DAY_FETCH_CAP = 5000;
const BY_DAY_DEFAULT_LIMIT = 30;
const BY_DAY_MAX_LIMIT = 90;
const DAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BY_DAY_VALID_ORDER_BY = new Set([
  "day:asc",
  "day:desc",
  "count:asc",
  "count:desc",
]);

router.get(
  "/violations/by-day",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      // ── Validation ────────────────────────────────────────────────────
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !DAY_DATE_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-MM-DD format",
          code: "INVALID_DATE_FORMAT",
        });
      }
      if (toRaw !== null && !DAY_DATE_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-MM-DD format",
          code: "INVALID_DATE_FORMAT",
        });
      }

      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "day:asc";
      const orderBy = BY_DAY_VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "day:asc";

      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = BY_DAY_DEFAULT_LIMIT;
      if (limit > BY_DAY_MAX_LIMIT) limit = BY_DAY_MAX_LIMIT;

      let offset = parseInt(req.query.offset, 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;

      // ── Where clause: tenant-scoped, CSPViolation/REPORT only ─────────
      const where = {
        tenantId: req.user.tenantId,
        entity: "CSPViolation",
        action: "REPORT",
      };

      // ── Fetch + JS-side aggregation ───────────────────────────────────
      // Pull rows + parse details client-side because the directive lives
      // inside the JSON-string `details` column (no SQL-side groupBy).
      // STATS_FETCH_CAP-sized take is enough for the day rollup — even a
      // year of moderate-noise CSP traffic stays well under 5k violations.
      const rows = await prisma.auditLog.findMany({
        where,
        select: { details: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: BY_DAY_FETCH_CAP,
      });

      // Aggregate per-UTC-day. Map "YYYY-MM-DD" → { day, count, byDirective }.
      const byDay = new Map();
      for (const row of rows) {
        let dayKey = "unknown";
        if (row.createdAt) {
          const dt = row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
            const dd = String(dt.getUTCDate()).padStart(2, "0");
            dayKey = `${yyyy}-${mm}-${dd}`;
          }
        }

        let bucket = byDay.get(dayKey);
        if (!bucket) {
          bucket = { day: dayKey, count: 0, byDirective: {} };
          byDay.set(dayKey, bucket);
        }
        bucket.count += 1;

        // Per-bucket directive breakdown — mirrors /stats helper usage so
        // the keys stay consistent across the listing + stats + by-day
        // surfaces.
        const parsed = parseDetails(row.details);
        const fields = extractReportFields(parsed);
        if (fields.directive) {
          const key = String(fields.directive);
          bucket.byDirective[key] = (bucket.byDirective[key] || 0) + 1;
        }
      }

      let days = [...byDay.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise so the count
      // surface remains complete. Mirrors /suppliers/by-month posture.
      if (fromRaw !== null) {
        days = days.filter((r) => r.day !== "unknown" && r.day >= fromRaw);
      }
      if (toRaw !== null) {
        days = days.filter((r) => r.day !== "unknown" && r.day <= toRaw);
      }

      // Sort. "day" sorts lexicographically on YYYY-MM-DD (= chronological).
      // "unknown" sorts last in asc / first in desc (lexicographically >
      // "9999-12-31") — acceptable for a defensive fallback bucket.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      days.sort((a, b) => {
        if (field === "day") {
          if (a.day < b.day) return -1 * mult;
          if (a.day > b.day) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const total = days.length;

      // Pagination AFTER aggregation + sort + filter, same as
      // /suppliers/by-month + /flyer-templates/by-month posture.
      const paged = days.slice(offset, offset + limit);

      return res.json({
        total,
        rows: paged,
      });
    } catch (err) {
      console.error("[CSP][violations/by-day] failed:", err && err.message);
      return res.status(500).json({
        error: "Failed to fetch CSP violation daily rollup",
        code: "CSP_VIOLATIONS_BY_DAY_FAILED",
      });
    }
  },
);

module.exports = router;
