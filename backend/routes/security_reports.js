/**
 * backend/routes/security_reports.js
 *
 * PRD_TRAVEL_SECURITY_ARCHITECTURE FR-3.7 (S5) — security telemetry surface.
 *
 * Endpoints (mounted at /api/security):
 *
 *   POST /csp-report              — public, CSP violation ingest
 *   GET  /incidents               — ADMIN, paginated listing scoped to caller's tenant
 *   POST /incidents/:id/review    — ADMIN, mark incident as triaged
 *
 * Why a separate namespace from /api/csp
 * ───────────────────────────────────────
 * `/api/csp` already exists (slice 2 of #917 — see backend/routes/csp.js).
 * It writes to AuditLog with entity='CSPViolation', tied to slice 1's
 * Report-Only header. THIS module (S5 / FR-3.7) introduces a separate
 * `SecurityIncident` model that:
 *   - covers MORE THAN just CSP — cross-tenant intercepts, rate-limit
 *     exceedances, future incident classes,
 *   - has its own review-trail columns (reviewedAt, reviewedById,
 *     reviewNote) that AuditLog never had,
 *   - persists with a nullable tenantId (CSP reports can pre-date auth
 *     resolution; AuditLog.tenantId is NOT NULL with @default(1)).
 *
 * Both surfaces coexist during the transition. A future slice may collapse
 * /api/csp/report into /api/security/csp-report; until then `/api/csp` is
 * the pinned compat shape for the existing test suite.
 *
 * Auth posture
 * ────────────
 *   - POST /csp-report is PUBLIC (browsers can't carry Authorization headers
 *     on CSP-Report-Only pings). The mount in server.js adds `/security/csp-
 *     report` to the openPaths allowlist.
 *   - GET /incidents + POST /incidents/:id/review go through the global
 *     verifyToken guard, then re-assert verifyRole(['ADMIN']) at the route.
 *
 * Rate-limiting
 * ─────────────
 * The global apiLimiter (server.js:211, 5000/15min/IP in prod) covers the
 * public endpoint. A per-IP cspReportLimiter (100/min) is added locally
 * for defense-in-depth — a misbehaving site (or a malicious script) could
 * burst-flood without the local limiter and exhaust the global budget for
 * every other endpoint on the same IP. NODE_ENV=test bumps the local
 * ceiling so the gate suite's tight loops don't 429.
 *
 * Vitest contract is pinned at backend/test/routes/security_reports.test.js.
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

// ── Local rate limiter for the public CSP report ingest ───────────────
// In production: 100 req/min/IP. Browsers normally emit one report per
// violation; bursts come from a noisy page reload. The intent of the cap
// is "defense in depth" — exhausting it is a signal in itself worth a
// telemetry write, but we keep the route's behavior simple: 429.
const cspReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === "test" ? 100000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by IP — a per-tenant key isn't possible because there's no
  // session on these requests.
  message: { error: "Too many CSP reports from this IP." },
  validate: { trustProxy: false, xForwardedForHeader: false },
});

// CSP browsers send `application/csp-report` or `application/reports+json`;
// some test runners + curl invocations use plain `application/json`. Accept
// all three. strict:false so reports-+json's top-level array is tolerated.
const MAX_CSP_REPORT_BYTES = 8 * 1024; // 8 KiB — slightly looser than /api/csp/report (4 KiB)
const cspJsonParser = express.json({
  type: [
    "application/csp-report",
    "application/reports+json",
    "application/json",
  ],
  limit: MAX_CSP_REPORT_BYTES,
  strict: false,
});

/**
 * Infer severity from the CSP `effective-directive` (or `violated-directive`).
 * script-src violation = high (active-content risk, most common XSS vector).
 * style-src violation  = medium (CSS injection / data exfil).
 * Everything else      = low.
 */
function severityForDirective(directive) {
  if (!directive || typeof directive !== "string") return "low";
  const lower = directive.toLowerCase();
  if (lower.includes("script-src")) return "high";
  if (lower.includes("style-src")) return "medium";
  return "low";
}

/**
 * Pull the canonical CSP fields from a request body that could be in any of
 * the formats browsers send. Returns null fields for shapes we can't decode
 * — the row still persists with the raw JSON so operators can inspect.
 */
function extractCspFields(body) {
  if (!body || typeof body !== "object") {
    return { directive: null, blockedUri: null, documentUri: null };
  }
  // W3C: { "csp-report": { ... } }
  if (body["csp-report"] && typeof body["csp-report"] === "object") {
    const r = body["csp-report"];
    return {
      directive: r["effective-directive"] || r["violated-directive"] || null,
      blockedUri: r["blocked-uri"] || null,
      documentUri: r["document-uri"] || null,
    };
  }
  // Reporting-API: top-level array of { type, body: { effectiveDirective, ... } }
  if (Array.isArray(body) && body.length > 0 && body[0] && body[0].body) {
    const r = body[0].body;
    return {
      directive: r.effectiveDirective || r.violatedDirective || null,
      blockedUri: r.blockedURL || null,
      documentUri: r.documentURL || null,
    };
  }
  // Plain JSON variant: read field names directly.
  return {
    directive:
      body["effective-directive"] ||
      body["violated-directive"] ||
      body.effectiveDirective ||
      body.violatedDirective ||
      null,
    blockedUri: body["blocked-uri"] || body.blockedURL || null,
    documentUri: body["document-uri"] || body.documentURL || null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// POST /csp-report — public CSP violation ingest
//
// Always returns 204 No Content, regardless of input shape (valid, empty,
// or malformed). Browsers don't retry on response, so the route stays
// quiet: no error envelope to leak our parsing logic, no body to amplify
// a malicious sender's flood.
//
// 413 PAYLOAD_TOO_LARGE is the one exception — the body-parser threw
// before the handler could fire-and-forget.
//
// 429 from cspReportLimiter is the other — surfaces the rate-limit gate.
// ─────────────────────────────────────────────────────────────────────
router.post("/csp-report", cspReportLimiter, (req, res, _next) => {
  cspJsonParser(req, res, async (err) => {
    if (err) {
      if (
        err.status === 413 ||
        err.statusCode === 413 ||
        err.type === "entity.too.large"
      ) {
        return res.status(413).json({
          error: "Payload too large",
          code: "PAYLOAD_TOO_LARGE",
          limit: MAX_CSP_REPORT_BYTES,
        });
      }
      // Malformed JSON / other parse error — stay quiet. 204.
      return res.status(204).end();
    }

    const payload = req.body || {};
    const fields = extractCspFields(payload);
    const severity = severityForDirective(fields.directive);

    let reportJson;
    try {
      reportJson = JSON.stringify(payload);
    } catch (_) {
      reportJson = "<unserializable>";
    }

    // Best-effort tenant resolution from the Host header (subdomain →
    // tenant slug). Falls back to null on miss — the row still persists
    // because the model allows tenantId=null for pre-auth CSP traffic.
    let tenantId = null;
    try {
      const host = (req.headers && req.headers.host) || "";
      const subdomain = host.split(":")[0].split(".")[0];
      if (subdomain) {
        const tenant = await prisma.tenant.findUnique({
          where: { slug: subdomain },
          select: { id: true },
        });
        if (tenant) tenantId = tenant.id;
      }
    } catch (_) {
      // Tenant lookup is best-effort. tenantId stays null.
    }

    // Fire-and-forget persistence. Don't await — browsers don't wait on
    // the response, and a slow telemetry write must not back-pressure the
    // page that emitted the report.
    prisma.securityIncident
      .create({
        data: {
          tenantId,
          incidentType: "csp-violation",
          severity,
          reportJson,
          userAgent:
            (req.headers && req.headers["user-agent"]) || null,
          ipAddress: req.ip || null,
          url: fields.documentUri || null,
          blockedUri: fields.blockedUri || null,
          effectiveDirective: fields.directive || null,
        },
      })
      .catch((dbErr) => {
        // eslint-disable-next-line no-console
        console.error(
          "[security/csp-report] persist failed:",
          dbErr && dbErr.message,
        );
      });

    return res.status(204).end();
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /incidents — ADMIN-only paginated listing scoped to caller's tenant
//
// Query:
//   ?type=csp-violation        filter by incidentType
//   ?since=2026-06-01          ISO date lower bound on createdAt
//   ?limit=100&offset=0        pagination
//
// Returns { incidents, total, limit, offset }.
// ─────────────────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

router.get("/incidents", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const where = {
      tenantId: req.user.tenantId,
    };

    if (req.query.type) {
      where.incidentType = String(req.query.type);
    }
    if (req.query.since) {
      const d = new Date(String(req.query.since));
      if (!Number.isNaN(d.getTime())) {
        where.createdAt = { gte: d };
      }
    }

    const [incidents, total] = await Promise.all([
      prisma.securityIncident.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.securityIncident.count({ where }),
    ]);

    return res.json({ incidents, total, limit, offset });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[security/incidents] list failed:", err && err.message);
    return res.status(500).json({
      error: "Failed to fetch security incidents",
      code: "SECURITY_INCIDENTS_LIST_FAILED",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /violations — ADMIN-only, tenant-scoped CSP violation observability
// (S121 — Developer-page tab go/no-go signal for CSP_ENFORCE flip)
//
// Why this lives alongside the existing GET /incidents
// ────────────────────────────────────────────────────
// /incidents reads from the SecurityIncident model (S5 / FR-3.7 — the
// MORE-than-just-CSP incident surface with review-trail columns). The
// existing /api/csp/violations endpoint (slice 3 of #917) reads from
// AuditLog rows where entity='CSPViolation' — written by routes/csp.js's
// POST /report handler, which is what S117's CSP_ENFORCE flip cares about.
//
// S121 is the operator-facing observability surface for THAT lineage. It
// gives the Developer-page UI a single endpoint to:
//   1. List recent CSPViolation AuditLog rows (within the lookback window).
//   2. Return a `clean24h` boolean — the go/no-go signal for flipping
//      CSP_ENFORCE=1. The flag is TRUE when zero violations have landed in
//      the last 24h AND the queried window covers at least the last 24h.
//
// The frontend uses `clean24h===true` to render a green "safe to enforce"
// badge; FALSE renders a red "do not flip yet" warning. Operators only
// set the env var when the green badge has been stable for 24h.
//
// Auth: verifyToken + verifyRole(['ADMIN']). Tenant-scoped via
// req.user.tenantId so ADMIN of tenant A cannot see tenant B's reports.
//
// Query params
// ────────────
//   ?limit=N        — clamp 1..500, default 100
//   ?since=ISO      — lookback lower bound on createdAt, default now-24h
//
// Response envelope
// ─────────────────
//   {
//     violations: [<AuditLog row>...],   // newest-first
//     total:      <int>,                 // length of violations array
//     sinceIso:   <ISO string>,          // resolved lower bound
//     clean24h:   <bool>,                // go/no-go signal for CSP_ENFORCE
//   }
//
// NO audit row written — anodyne read-only surface.
// ─────────────────────────────────────────────────────────────────────
const VIOLATIONS_DEFAULT_LIMIT = 100;
const VIOLATIONS_MAX_LIMIT = 500;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

router.get(
  "/violations",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = VIOLATIONS_DEFAULT_LIMIT;
      if (limit > VIOLATIONS_MAX_LIMIT) limit = VIOLATIONS_MAX_LIMIT;

      const now = Date.now();
      const defaultSince = new Date(now - TWENTY_FOUR_HOURS_MS);
      let since = defaultSince;
      if (req.query.since) {
        const parsed = new Date(String(req.query.since));
        if (!Number.isNaN(parsed.getTime())) {
          since = parsed;
        }
      }

      const where = {
        entity: "CSPViolation",
        tenantId: req.user.tenantId,
        createdAt: { gte: since },
      };

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      // clean24h is the go/no-go signal: ZERO rows AND the lookback window
      // covers at least the last 24h. A narrower `since=` window (e.g. last
      // hour) being empty is NOT enough to prove "24h clean" — the operator
      // hasn't asked the question that S121 is supposed to answer.
      const windowCoversLast24h = since.getTime() <= now - TWENTY_FOUR_HOURS_MS + 1000;
      const clean24h = rows.length === 0 && windowCoversLast24h;

      return res.json({
        violations: rows,
        total: rows.length,
        sinceIso: since.toISOString(),
        clean24h,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[security/violations] list failed:", err && err.message);
      return res.status(500).json({
        error: "Failed to fetch CSP violations",
        code: "SECURITY_VIOLATIONS_LIST_FAILED",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────
// POST /incidents/:id/review — ADMIN, tenant-scoped triage marker
//
// Body: { reviewNote: string, severity?: string }
// - reviewNote required (400 MISSING_REVIEW_NOTE if absent / blank)
// - severity optional, validated against allowed bucket if provided
// - 404 NOT_FOUND if no row at (id, req.user.tenantId)
// - Returns { success: true, incident: <updated row> }
// ─────────────────────────────────────────────────────────────────────
const ALLOWED_SEVERITIES = ["low", "medium", "high", "critical"];

router.post(
  "/incidents/:id/review",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
      }

      const reviewNote =
        req.body && typeof req.body.reviewNote === "string"
          ? req.body.reviewNote.trim()
          : "";
      if (!reviewNote) {
        return res.status(400).json({
          error: "reviewNote is required",
          code: "MISSING_REVIEW_NOTE",
        });
      }

      const severity =
        req.body && req.body.severity
          ? String(req.body.severity).trim().toLowerCase()
          : null;
      if (severity && !ALLOWED_SEVERITIES.includes(severity)) {
        return res.status(400).json({
          error: "Invalid severity",
          code: "INVALID_SEVERITY",
          allowed: ALLOWED_SEVERITIES,
        });
      }

      // Tenant-scoped lookup — even ADMIN of tenant A must not review
      // tenant B's incident. We can't do `findUnique({ where: { id,
      // tenantId } })` because (id) is the only @@unique key. Do an
      // existence + tenantId check first; 404 on mismatch so the row's
      // existence isn't confirmed cross-tenant.
      const existing = await prisma.securityIncident.findUnique({
        where: { id },
        select: { id: true, tenantId: true },
      });
      if (!existing || existing.tenantId !== req.user.tenantId) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }

      const data = {
        reviewedAt: new Date(),
        reviewedById: req.user.userId || null,
        reviewNote,
      };
      if (severity) data.severity = severity;

      const incident = await prisma.securityIncident.update({
        where: { id },
        data,
      });

      return res.json({ success: true, incident });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[security/incidents/review] failed:", err && err.message);
      return res.status(500).json({
        error: "Failed to record incident review",
        code: "SECURITY_INCIDENT_REVIEW_FAILED",
      });
    }
  },
);

module.exports = router;
