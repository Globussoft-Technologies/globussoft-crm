// Travel CRM — Visa Sure applications endpoints (Phase 3 backend SHELL + CREATE).
//
// Backend wire-up for the Phase 3 cluster B3 Visa Sure frontend SHELLs:
//   - frontend/src/pages/travel/visa/Applications.jsx (875c082) — list view
//   - frontend/src/pages/travel/visa/AdvisorDashboard.jsx (90b58fa) — per-row
//     detail (V8 diagnostic answers / V9 AI summary / V10 risk indicators)
//
// Endpoints:
//   GET   /api/travel/visa/applications                       — paginated list with filters
//   GET   /api/travel/visa/applications/:id                   — single application detail
//   POST  /api/travel/visa/applications                       — create new application (intake)
//   PATCH /api/travel/visa/applications/:id                   — field-by-field edit + status transitions
//   GET   /api/travel/visa/applications/:id/status-history    — read-only audit-derived history (slice)
//
// PATCH / DELETE are intentionally NOT in this commit. Status transitions
// (intake → docs-pending → filed → approved/rejected) need an explicit
// state-machine + audit; complex enough to warrant a separate scope.
//
// Mounted under /api/travel/visa by server.js (parallel to the analytics
// sub-mount at /api/travel/visa/analytics). The path-precedence rule of
// Express's router stack means the analytics sub-mount is hit FIRST for
// any /api/travel/visa/analytics/* request, then this catches the
// /applications surface.
//
// Sub-brand scoping (same rationale as travel_visa_analytics.js / 45dde56):
//   VisaApplication itself has NO subBrand column on its row (schema only
//   carries applicationType + destinationCountry + status + readinessLevel
//   + advisorRiskFlag + outcome + filedAt + decidedAt + complexCase +
//   rejectionHistoryJson + recoveryProgramId). Visa-Sure-ness is encoded
//   via Contact.subBrand="visasure" — the Contact is the upstream owner
//   of the visa pipeline. Both endpoints filter through Contact and
//   narrow to subBrand="visasure" so a non-visa application (schema-anomaly
//   today but might exist via fixture/migration) stays out of the list.
//
// Tenant isolation rides BOTH layers: req.travelTenant.id is the
// VisaApplication tenant filter, and Contact lookups are also tenant-
// scoped, so cross-tenant data leakage requires breaking both filters.
//
// Auth gate: verifyToken (router-level) + verifyRole(["ADMIN","MANAGER"])
// per endpoint + requireTravelTenant. Same RBAC posture as the analytics
// surface — USER role is rejected with 403, generic-vertical ADMIN is
// rejected with 403 WRONG_VERTICAL.
//
// Schema NOTES (what we shipped vs. what was originally asked for):
//
//   - "documents list" → We surface `documentChecklist` (the real
//     relation on VisaApplication: VisaDocumentChecklistItem[]). There
//     is no separate "documents" relation in the schema; the checklist
//     IS the documents surface. Field name preserved verbatim from the
//     schema so the frontend can drive UI from it without aliasing.
//
//   - "diagnostic if exists" → We resolve the latest TravelDiagnostic
//     row for this contact + sub-brand via findLatestDiagnostic (the
//     same helper used by routes/travel_itineraries.js for product-tier
//     defaulting). Returned as `diagnostic: {...} | null`. The diagnostic
//     join is OPTIONAL — applications without a completed diagnostic
//     surface diagnostic=null (advisor can still drilldown).
//
//   - "joined Contact" → We include id + name + email + phone + source.
//     PII surface mirrors what travel_itineraries.js /:id returns;
//     phone/email needed by the advisor dashboard to action the case.
//
// Audit log: each read writes an `APPLICATION_READ` (detail) or
// `APPLICATION_LIST_READ` (list) row under entity="VisaApplication".
// Best-effort — failures don't block the response (matches the analytics
// pattern's `.catch(() => {})`). Per HIPAA/DPDP §11 of the wellness PRD
// every PHI-bearing read should be auditable; visa applications are
// PII-bearing (passport-tier data lives on RfuLeadProfile but identity +
// rejection history live here) so the audit trail is the same shape.

const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { findLatestDiagnostic } = require("../lib/travelLatestDiagnostic");
// #920 slice S43: opt-in slim shape via `?fields=summary` for GET /applications.
// SQL-drops PII columns (rejectionHistoryJson, outcomeReason, familySize,
// priorApplicationId, recoveryProgramId, updatedAt) at the Prisma layer +
// SKIPS the post-query `.map(a => ({...a, contact}))` decoration that would
// otherwise re-introduce contact PII (name/email/phone) into the payload.
// Default shape stays full row + contact decoration (back-compat with the
// frontend Applications.jsx + AdvisorDashboard.jsx pages that destructure
// `a.contact.name` etc.). See backend/lib/listProjection.js's VisaApplication
// entry for the per-field rationale and the decoration-skip contract.
const listProjection = require("../lib/listProjection");
const { isFullShape } = listProjection;

const router = express.Router();

router.use(verifyToken);

const VISA_SUB_BRAND = "visasure";
const VALID_STATUSES = [
  "intake",
  "docs-pending",
  "filed",
  "approved",
  "rejected",
  "appeal",
];

// Pinned to `model VisaApplication.applicationType` schema comment
// (prisma/schema.prisma:4502): `String // tourist | business | student |
// work | umrah | hajj`. Matches docs/TRAVEL_CRM_PRD.md §VisaApplication
// (line 429) verbatim. The dispatch brief named additional values like
// `family` / `other` — NOT in the schema today; if a future card needs
// them the migration is a single ALTER + this list update.
const VALID_APPLICATION_TYPES = [
  "tourist",
  "business",
  "student",
  "work",
  "umrah",
  "hajj",
];

// Pinned to `model VisaApplication.advisorRiskFlag` schema comment
// (prisma/schema.prisma:4508): `String? // null | low | medium | high |
// priority`. PATCH callers may clear the flag by sending null OR an empty
// string (normalized to null before write).
const VALID_RISK_FLAGS = ["low", "medium", "high", "priority"];

// Map status enum value → per-month rollup field name. Used by the
// /applications/by-month endpoint to split monthly counts by status
// across all 6 enum values. Mirrors STATUS_FIELD in
// backend/routes/travel_visa_analytics.js (V19) verbatim — kept here
// as a local copy so the operational route stays self-contained.
const STATUS_FIELD = {
  intake: "intakeCount",
  "docs-pending": "docsPendingCount",
  filed: "filedCount",
  approved: "approvedCount",
  rejected: "rejectedCount",
  appeal: "appealCount",
};

// ─── GET /api/travel/visa/applications ──────────────────────────────
//
// Paginated list of Visa Sure applications scoped to the caller's tenant
// AND to Contact.subBrand="visasure".
//
// Query filters:
//   ?status=<intake|docs-pending|filed|approved|rejected|appeal>
//   ?limit=N (max 200, default 50)
//   ?offset=N (default 0)
//
// Response envelope:
//   {
//     applications: [
//       { id, contactId, applicationType, destinationCountry, status,
//         readinessLevel, advisorRiskFlag, complexCase, filedAt,
//         decidedAt, outcome, createdAt, contact: {id, name, email, phone} },
//       ...
//     ],
//     total: <int>,
//     limit: <int>,
//     offset: <int>
//   }
//
// Empty-state contract: when no visa-sure contacts (or no applications
// for them) exist, returns { applications: [], total: 0, limit, offset }.
// Never 500s on empty.
//
// #920 slice S43 — slim shape opt-in via `?fields=summary`. When the caller
// passes `?fields=summary`, the response:
//   1. SQL-drops PII columns (rejectionHistoryJson, outcomeReason,
//      familySize, priorApplicationId, recoveryProgramId, updatedAt) at the
//      Prisma layer via select projection;
//   2. SKIPS the `.map(a => ({...a, contact}))` decoration so contact PII
//      (name/email/phone) NEVER rides the slim payload — the picker/
//      autocomplete caller follows GET /:id for the full contact join;
//   3. Still emits the APPLICATION_LIST_READ audit row (regulatory
//      "operator hit the list" visibility) with a `shape:"summary"` marker
//      so reviewers can answer "did this call disclose contact PII?"
//      without a join. Default shape stays full row + contact decoration.
router.get(
  "/applications",
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Filter parse + validation.
      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;

      let statusFilter = null;
      if (req.query.status) {
        const s = String(req.query.status);
        if (!VALID_STATUSES.includes(s)) {
          return res.status(400).json({
            error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
            code: "INVALID_STATUS",
          });
        }
        statusFilter = s;
      }

      // S43 — slim opt-in. The slim path skips both the Contact PII fetch
      // (no decoration → no need for the Contact projection) AND the
      // post-query .map() decoration. The full path keeps both for
      // backward-compat with Applications.jsx + AdvisorDashboard.jsx.
      const wantFullShape = isFullShape(req.query);

      // Resolve visa-sure contact IDs. On the FULL path we also need the
      // contact PII (name/email/phone) for the decoration; on the SLIM
      // path we only need the ids list (used as a sub-brand isolation
      // filter — non-visa-sure applications must stay out of the list
      // regardless of shape).
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: wantFullShape
          ? { id: true, name: true, email: true, phone: true }
          : { id: true },
      });

      if (visaContacts.length === 0) {
        return res.json({
          applications: [],
          total: 0,
          limit: take,
          offset: skip,
        });
      }

      const contactIds = visaContacts.map((c) => c.id);
      const contactById = wantFullShape
        ? new Map(visaContacts.map((c) => [c.id, c]))
        : null;

      const where = {
        tenantId,
        contactId: { in: contactIds },
      };
      if (statusFilter) where.status = statusFilter;

      const findManyArgs = {
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
      };
      if (!wantFullShape) {
        // Slim projection — SQL-drops the load-bearing PII columns
        // (rejectionHistoryJson, outcomeReason, familySize,
        // priorApplicationId, recoveryProgramId, updatedAt, tenantId).
        findManyArgs.select = listProjection("VisaApplication", false);
      }

      const [applications, total] = await Promise.all([
        prisma.visaApplication.findMany(findManyArgs),
        prisma.visaApplication.count({ where }),
      ]);

      // Decoration is FULL-PATH ONLY. The slim path returns the Prisma
      // rows verbatim (no contact join) so the load-bearing privacy
      // contract holds: no contact PII rides a `?fields=summary` payload.
      const payload = wantFullShape
        ? applications.map((a) => ({
            ...a,
            contact: contactById.get(a.contactId) || null,
          }))
        : applications;

      // Best-effort audit. Same .catch(() => {}) idiom as the analytics
      // surface — never blocks the response. The shape marker lets
      // reviewers answer "did this list call disclose contact PII?" by
      // looking at one row instead of joining tables.
      writeAudit(
        "VisaApplication",
        "APPLICATION_LIST_READ",
        0,
        req.user.userId,
        tenantId,
        {
          subBrand: VISA_SUB_BRAND,
          statusFilter: statusFilter || null,
          count: applications.length,
          shape: wantFullShape ? "full" : "summary",
        },
      ).catch(() => {});

      res.json({
        applications: payload,
        total,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      console.error("[travel-visa/list] error:", e.message);
      res.status(500).json({
        error: "Failed to list visa applications",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ============================================================================
// GET /api/travel/visa/applications/stats — tenant-wide visa rollup
// (PRD_TRAVEL_VISA Phase 3 — mirrors #905 slice 18 /commission-profiles/stats
// + #903 slice 23 /suppliers/stats + #908 slice 19 /flyer-templates/global-stats).
//
// USER-readable anodyne aggregate. Powers the Visa Sure Applications page's
// header summary strip ("142 applications · 28 intake · 45 docs-pending ·
// 35 filed · 30 approved · 4 rejected · 12 complex · 7 risk-flagged ·
// last activity 6h ago"). Without this, the frontend has to fire {list,
// count by status×6, count by applicationType×6, count by destination×N,
// count where complexCase=true, count where advisorRiskFlag != null} —
// N+1 round-trips for a single visual surface.
//
// Sub-brand scoping — same rationale as the analytics surface and the
// /applications list endpoint above:
//   VisaApplication itself has NO subBrand column on its row; visa-sure-ness
//   is encoded via Contact.subBrand="visasure" — the Contact is the upstream
//   owner of the visa pipeline. This stats endpoint resolves visa-sure
//   contact IDs first, then aggregates VisaApplication rows whose contactId
//   is in that set. Non-visa applications (schema anomaly today) stay out.
//
// Behaviour:
//   - Tenant-scoped count of ALL VisaApplication rows joined via
//     Contact.subBrand='visasure'.
//   - Counts by status, applicationType, destinationCountry (capped to
//     top-10 most-common; the rest aggregate into a `_other` bucket).
//   - complexCount = count where complexCase=true.
//   - flaggedCount = count where advisorRiskFlag IS NOT NULL (any non-null
//     value — low/medium/high/priority all qualify).
//   - lastActivityAt = max(updatedAt) across all matching rows; null when
//     zero rows.
//   - ?from / ?to (ISO date bounds) filter VisaApplication.createdAt before
//     aggregation. Both optional. 400 INVALID_DATE on garbage.
//
// USER-readable: anodyne aggregate (counts + timestamps); safe. No audit
// row: read-only meta surface, mirrors /suppliers/stats + /commission-
// profiles/stats. Role gate is verifyRole(['ADMIN','MANAGER','USER'])
// explicitly — a level looser than the /applications list (ADMIN/MANAGER)
// because aggregate counters are anodyne. This is the same posture
// /suppliers/stats and /commission-profiles/stats use.
//
// Express path-precedence: literal-path /applications/stats MUST be declared
// BEFORE /applications/:id or the `:id="stats"` shape would 400 INVALID_ID
// before reaching this handler.
// ============================================================================
router.get(
  "/applications/stats",
  verifyRole(["ADMIN", "MANAGER", "USER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Optional ISO date bounds on VisaApplication.createdAt — same shape
      // as /suppliers/stats. Both bounds optional; invalid date → 400.
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      const createdAtFilter = {};
      if (fromRaw) {
        const d = new Date(fromRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        createdAtFilter.gte = d;
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        createdAtFilter.lte = d;
      }

      // Empty-shape baseline used by both the no-contacts and no-applications
      // short-circuits. byStatus pre-seeded with all enum values at zero so
      // the frontend can render every status tile without missing-key
      // defensiveness.
      const emptyShape = () => ({
        total: 0,
        byStatus: VALID_STATUSES.reduce((acc, s) => {
          acc[s] = { count: 0 };
          return acc;
        }, {}),
        byApplicationType: {},
        byDestinationCountry: {},
        complexCount: 0,
        flaggedCount: 0,
        lastActivityAt: null,
      });

      // Resolve visa-sure contact IDs first (mirrors /applications list).
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true },
      });

      if (visaContacts.length === 0) {
        return res.json(emptyShape());
      }

      const contactIds = visaContacts.map((c) => c.id);

      const where = {
        tenantId,
        contactId: { in: contactIds },
      };
      if (createdAtFilter.gte || createdAtFilter.lte) {
        where.createdAt = createdAtFilter;
      }

      // Fetch the projection needed for in-process aggregation. We pick the
      // minimal set of columns (status / applicationType / destinationCountry
      // / complexCase / advisorRiskFlag / updatedAt) — no PII surface,
      // anodyne row data only.
      const applications = await prisma.visaApplication.findMany({
        where,
        select: {
          id: true,
          status: true,
          applicationType: true,
          destinationCountry: true,
          complexCase: true,
          advisorRiskFlag: true,
          updatedAt: true,
        },
      });

      if (applications.length === 0) {
        return res.json(emptyShape());
      }

      const result = emptyShape();
      result.total = applications.length;

      // Provisional destination tally — will be capped to top-10 after the
      // loop completes (smaller-than-cap stays as-is; larger-than-cap moves
      // overflow into `_other`).
      const destinationTally = {};

      let lastActivityAt = null;
      for (const a of applications) {
        // byStatus — defensive: null / unknown status doesn't crash, just
        // creates a new bucket (forward-compat for any future status enum
        // values added before this endpoint catches up).
        if (a.status) {
          const sKey = String(a.status);
          if (!result.byStatus[sKey]) result.byStatus[sKey] = { count: 0 };
          result.byStatus[sKey].count += 1;
        }

        // byApplicationType — null/missing skips the bucket per the brief.
        if (a.applicationType) {
          const tKey = String(a.applicationType);
          if (!result.byApplicationType[tKey]) {
            result.byApplicationType[tKey] = { count: 0 };
          }
          result.byApplicationType[tKey].count += 1;
        }

        // byDestinationCountry — null/missing/empty skips the bucket.
        if (a.destinationCountry) {
          const dKey = String(a.destinationCountry);
          if (!destinationTally[dKey]) destinationTally[dKey] = 0;
          destinationTally[dKey] += 1;
        }

        if (a.complexCase === true) result.complexCount += 1;
        if (a.advisorRiskFlag) result.flaggedCount += 1;

        const ts =
          a.updatedAt instanceof Date ? a.updatedAt : new Date(a.updatedAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
        }
      }

      // Cap byDestinationCountry to top-10; everything beyond aggregates
      // into `_other`. Keeps response shape bounded even when a tenant has
      // 50+ unique destinations.
      const DEST_CAP = 10;
      const sortedDest = Object.entries(destinationTally).sort(
        (a, b) => b[1] - a[1],
      );
      const top = sortedDest.slice(0, DEST_CAP);
      const rest = sortedDest.slice(DEST_CAP);
      for (const [k, count] of top) {
        result.byDestinationCountry[k] = { count };
      }
      if (rest.length > 0) {
        const otherCount = rest.reduce((sum, [, c]) => sum + c, 0);
        result.byDestinationCountry._other = { count: otherCount };
      }

      result.lastActivityAt = lastActivityAt
        ? lastActivityAt.toISOString()
        : null;

      res.json(result);
    } catch (e) {
      console.error("[travel-visa/stats] error:", e.message);
      res.status(500).json({
        error: "Failed to summarise visa applications",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ============================================================================
// GET /api/travel/visa/applications/by-month — tenant-wide monthly rollup
// (PRD_TRAVEL_VISA Phase 3 — operational complement to V19 at
// /api/travel/visa/analytics/by-month c66d63fd).
//
// SAME SHAPE as the V19 analytics endpoint, deliberately. The difference
// is WHERE this lives: the analytics route file serves the V16-V19 reports
// view; THIS route file (travel_visa.js) is the operational surface that
// Visa-Sure operators hit alongside /applications, /applications/stats
// (20d91295), /applications/:id, and /applications/:id/status-history
// (f1741b6c). The Applications page header summary strip pulls /stats
// for "live now" snapshot; the monthly time-series mini-chart on the same
// page pulls /by-month for "how did we trend the last 12 months?" — both
// belong on the operational route file so the page doesn't have to fan
// out across two mount points.
//
// Sub-brand scoping (same rationale as the other endpoints in this file):
//   VisaApplication itself has NO subBrand column on its row; visa-sure-ness
//   is encoded via Contact.subBrand="visasure". Resolve visa-sure contact
//   IDs first, then aggregate VisaApplication rows whose contactId is in
//   that set. Non-visa applications (schema anomaly today) stay out.
//
// Bucket key: ISO YYYY-MM string (e.g. "2026-05") derived from
// VisaApplication.createdAt's UTC year + month. UTC chosen deliberately so
// bucket labels stay stable across operator timezones — visa reconciliation
// works in calendar-month UTC for cross-border work.
//
// USER-readable: anodyne aggregate (counts only, no PII surface). Role
// gate is verifyRole(['ADMIN','MANAGER','USER']) — same posture as
// /applications/stats and consistent with the "anodyne aggregate" reads
// in this CRM. The V19 analytics surface uses ADMIN/MANAGER; this slice
// loosens it to USER because the Applications page itself is USER-
// readable and the by-month tile renders alongside the /stats summary
// strip.
//
// Query string:
//   status    optional VisaApplication.status filter (intake / docs-pending
//             / filed / approved / rejected / appeal); invalid → 400
//             INVALID_STATUS.
//   from      optional inclusive lower bound on bucket (YYYY-MM); invalid
//             → 400 INVALID_MONTH_FORMAT.
//   to        optional inclusive upper bound on bucket (YYYY-MM); invalid
//             → 400 INVALID_MONTH_FORMAT.
//   orderBy   default "month:asc" (chronological); also accepts
//             "month:desc", "count:asc|desc", "approvedCount:asc|desc".
//             Unknown tokens degrade silently to default.
//   limit     default 12 (one year), max 60 (5 years).
//   offset    default 0
//
// Response shape (mirrors V19):
//   {
//     months: [ {
//       month: "2026-05",
//       count,
//       intakeCount, docsPendingCount, filedCount, approvedCount,
//       rejectedCount, appealCount,
//       complexCount, flaggedCount,
//     } ],
//     totalMonths,
//     grandCount,
//     grandApprovedCount,
//     grandRejectedCount,
//     limit, offset,
//   }
//
// Defensive: null/invalid createdAt → "unknown" bucket (excluded when
// from/to is set, kept otherwise so the count surface stays accurate).
// Empty scoped-contact set → all-zeros envelope (NOT 404 / 500) so the
// dashboard tile renders gracefully.
//
// Express path-precedence: literal-path /applications/by-month MUST be
// declared BEFORE /applications/:id or the `:id="by-month"` shape would
// 400 INVALID_ID before reaching this handler. Same constraint that
// /applications/stats relies on.
// ============================================================================
router.get(
  "/applications/by-month",
  verifyRole(["ADMIN", "MANAGER", "USER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const statusFilter = req.query.status ? String(req.query.status) : null;
      const orderByRaw = req.query.orderBy
        ? String(req.query.orderBy)
        : "month:asc";

      // Status enum validation — mirrors /applications list + V19 analytics.
      if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "INVALID_STATUS",
        });
      }

      // YYYY-MM validation — same regex V19 (slice 16) uses.
      const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !MONTH_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-MM format",
          code: "INVALID_MONTH_FORMAT",
        });
      }
      if (toRaw !== null && !MONTH_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-MM format",
          code: "INVALID_MONTH_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "month:asc",
        "month:desc",
        "count:asc",
        "count:desc",
        "approvedCount:asc",
        "approvedCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Resolve visa-sure contact IDs first (mirrors the other handlers).
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true },
      });

      // Empty-shape baseline used by both no-contacts and no-applications
      // short-circuits.
      const emptyEnvelope = () => ({
        months: [],
        totalMonths: 0,
        grandCount: 0,
        grandApprovedCount: 0,
        grandRejectedCount: 0,
        limit: take,
        offset: skip,
      });

      if (visaContacts.length === 0) {
        return res.json(emptyEnvelope());
      }

      const contactIds = visaContacts.map((c) => c.id);

      const where = { tenantId, contactId: { in: contactIds } };
      if (statusFilter) where.status = statusFilter;

      // Minimal projection — no PII surface. createdAt + status + the two
      // flag columns are all the aggregation needs.
      const applications = await prisma.visaApplication.findMany({
        where,
        select: {
          id: true,
          status: true,
          complexCase: true,
          advisorRiskFlag: true,
          createdAt: true,
        },
      });

      if (applications.length === 0) {
        return res.json(emptyEnvelope());
      }

      // Aggregate per-UTC-month. Map "YYYY-MM" → row.
      const makeEmptyRow = (monthKey) => ({
        month: monthKey,
        count: 0,
        intakeCount: 0,
        docsPendingCount: 0,
        filedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        appealCount: 0,
        complexCount: 0,
        flaggedCount: 0,
      });

      const byMonth = new Map();
      for (const a of applications) {
        let monthKey = "unknown";
        if (a.createdAt) {
          const dt = new Date(a.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
            monthKey = `${yyyy}-${mm}`;
          }
        }

        let row = byMonth.get(monthKey);
        if (!row) {
          row = makeEmptyRow(monthKey);
          byMonth.set(monthKey, row);
        }

        row.count += 1;

        // Status split — defensive: null/unknown status doesn't crash, just
        // doesn't increment any sub-bucket (forward-compat for any future
        // enum values added before this endpoint catches up).
        if (a.status) {
          const field = STATUS_FIELD[a.status];
          if (field) row[field] += 1;
        }

        if (a.complexCase === true) row.complexCount += 1;
        if (a.advisorRiskFlag) row.flaggedCount += 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
      // either bound is set; kept otherwise. Mirrors V19 + slice 16.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM (also chronological).
      // "unknown" sorts last in asc / first in desc (lexicographically >
      // "9999-12") — acceptable for a defensive fallback bucket.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      months.sort((a, b) => {
        if (field === "month") {
          if (a.month < b.month) return -1 * mult;
          if (a.month > b.month) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalMonths = months.length;
      const grandCount = months.reduce((acc, r) => acc + (r.count || 0), 0);
      const grandApprovedCount = months.reduce(
        (acc, r) => acc + (r.approvedCount || 0),
        0,
      );
      const grandRejectedCount = months.reduce(
        (acc, r) => acc + (r.rejectedCount || 0),
        0,
      );

      // Pagination applied AFTER aggregation + sort + filter.
      const paged = months.slice(skip, skip + take);

      // No audit row written: read-only meta surface (mirrors /stats +
      // /status-history — meta reads don't audit-back themselves).

      res.json({
        months: paged,
        totalMonths,
        grandCount,
        grandApprovedCount,
        grandRejectedCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      console.error("[travel-visa/applications-by-month] error:", e.message);
      res.status(500).json({
        error: "Failed to compute by-month metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ============================================================================
// GET /api/travel/visa/applications/by-quarter — tenant-wide quarterly rollup
// (PRD_TRAVEL_VISA Phase 3 — operational complement to /applications/by-month
// fc7b8165 + /applications/stats 20d91295 + /applications/:id/status-history
// f1741b6c).
//
// SAME SHAPE FAMILY as /applications/by-month, with the bucket key swapped
// from YYYY-MM to YYYY-Qn. Calendar quarters (Q1=Jan-Mar, Q2=Apr-Jun,
// Q3=Jul-Sep, Q4=Oct-Dec) computed in UTC for the same cross-border
// stability rationale as by-month. Operators often review visa pipeline
// performance quarterly (board reporting, ATL/BTL spend reconciliation,
// quarterly recovery-program reviews) — monthly resolution is too noisy
// and yearly resolution is too coarse.
//
// Sub-brand scoping: same as siblings — VisaApplication has no subBrand
// column; visa-sure-ness is encoded via Contact.subBrand="visasure".
// Resolve visa-sure contact IDs first, then aggregate VisaApplication
// rows whose contactId is in that set.
//
// Bucket key: YYYY-Qn (e.g. "2026-Q2") derived from VisaApplication.createdAt's
// UTC year + quarter. Quarter = floor(month0 / 3) + 1.
//
// USER-readable: anodyne aggregate (counts only). Role gate matches by-month:
// verifyRole(['ADMIN','MANAGER','USER']).
//
// Query string:
//   status    optional VisaApplication.status filter; invalid → 400
//             INVALID_STATUS.
//   from      optional inclusive lower bound on bucket (YYYY-Qn); invalid
//             → 400 INVALID_QUARTER_FORMAT.
//   to        optional inclusive upper bound on bucket (YYYY-Qn); invalid
//             → 400 INVALID_QUARTER_FORMAT.
//   orderBy   default "quarter:asc" (chronological); also accepts
//             "quarter:desc", "count:asc|desc", "approvedCount:asc|desc".
//             Unknown tokens degrade silently to default.
//   limit     default 12 (three years), max 40 (ten years).
//   offset    default 0
//
// Response shape:
//   {
//     quarters: [ {
//       quarter: "2026-Q2",
//       count,
//       intakeCount, docsPendingCount, filedCount, approvedCount,
//       rejectedCount, appealCount,
//       complexCount, flaggedCount,
//     } ],
//     totalQuarters,
//     grandCount,
//     grandApprovedCount,
//     grandRejectedCount,
//     limit, offset,
//   }
//
// Defensive: null/invalid createdAt → "unknown" bucket (excluded when
// from/to is set, kept otherwise). Empty scoped-contact set → all-zeros
// envelope (NOT 404 / 500).
//
// Express path-precedence: literal-path /applications/by-quarter MUST be
// declared BEFORE /applications/:id (otherwise `:id="by-quarter"` would
// 400 INVALID_ID before reaching this handler). Same constraint as
// /applications/by-month + /applications/stats.
// ============================================================================
router.get(
  "/applications/by-quarter",
  verifyRole(["ADMIN", "MANAGER", "USER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
      const skip = parseInt(req.query.offset, 10) || 0;
      const statusFilter = req.query.status ? String(req.query.status) : null;
      const orderByRaw = req.query.orderBy
        ? String(req.query.orderBy)
        : "quarter:asc";

      // Status enum validation — mirrors /applications list + by-month.
      if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "INVALID_STATUS",
        });
      }

      // YYYY-Qn validation. Quarter token is Q1..Q4 only.
      const QUARTER_RE = /^\d{4}-Q[1-4]$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-Qn format (e.g. 2026-Q2)",
          code: "INVALID_QUARTER_FORMAT",
        });
      }
      if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-Qn format (e.g. 2026-Q2)",
          code: "INVALID_QUARTER_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "quarter:asc",
        "quarter:desc",
        "count:asc",
        "count:desc",
        "approvedCount:asc",
        "approvedCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw)
        ? orderByRaw
        : "quarter:asc";

      // Resolve visa-sure contact IDs first.
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true },
      });

      const emptyEnvelope = () => ({
        quarters: [],
        totalQuarters: 0,
        grandCount: 0,
        grandApprovedCount: 0,
        grandRejectedCount: 0,
        limit: take,
        offset: skip,
      });

      if (visaContacts.length === 0) {
        return res.json(emptyEnvelope());
      }

      const contactIds = visaContacts.map((c) => c.id);

      const where = { tenantId, contactId: { in: contactIds } };
      if (statusFilter) where.status = statusFilter;

      const applications = await prisma.visaApplication.findMany({
        where,
        select: {
          id: true,
          status: true,
          complexCase: true,
          advisorRiskFlag: true,
          createdAt: true,
        },
      });

      if (applications.length === 0) {
        return res.json(emptyEnvelope());
      }

      const makeEmptyRow = (quarterKey) => ({
        quarter: quarterKey,
        count: 0,
        intakeCount: 0,
        docsPendingCount: 0,
        filedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        appealCount: 0,
        complexCount: 0,
        flaggedCount: 0,
      });

      const byQuarter = new Map();
      for (const a of applications) {
        let quarterKey = "unknown";
        if (a.createdAt) {
          const dt = new Date(a.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const qn = Math.floor(dt.getUTCMonth() / 3) + 1;
            quarterKey = `${yyyy}-Q${qn}`;
          }
        }

        let row = byQuarter.get(quarterKey);
        if (!row) {
          row = makeEmptyRow(quarterKey);
          byQuarter.set(quarterKey, row);
        }

        row.count += 1;

        if (a.status) {
          const field = STATUS_FIELD[a.status];
          if (field) row[field] += 1;
        }

        if (a.complexCase === true) row.complexCount += 1;
        if (a.advisorRiskFlag) row.flaggedCount += 1;
      }

      let quarters = [...byQuarter.values()];

      // Apply ?from / ?to bucket filter. YYYY-Qn sorts lexicographically =
      // chronologically because the year is fixed-width and Q1<Q2<Q3<Q4
      // lexicographically. "unknown" rows excluded when either bound set.
      if (fromRaw !== null) {
        quarters = quarters.filter(
          (r) => r.quarter !== "unknown" && r.quarter >= fromRaw,
        );
      }
      if (toRaw !== null) {
        quarters = quarters.filter(
          (r) => r.quarter !== "unknown" && r.quarter <= toRaw,
        );
      }

      // Sort. "quarter" sorts lexicographically on YYYY-Qn (also chronological).
      // "unknown" sorts last in asc / first in desc (lexicographically >
      // "9999-Q4") — acceptable for a defensive fallback bucket.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      quarters.sort((a, b) => {
        if (field === "quarter") {
          if (a.quarter < b.quarter) return -1 * mult;
          if (a.quarter > b.quarter) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalQuarters = quarters.length;
      const grandCount = quarters.reduce((acc, r) => acc + (r.count || 0), 0);
      const grandApprovedCount = quarters.reduce(
        (acc, r) => acc + (r.approvedCount || 0),
        0,
      );
      const grandRejectedCount = quarters.reduce(
        (acc, r) => acc + (r.rejectedCount || 0),
        0,
      );

      const paged = quarters.slice(skip, skip + take);

      // No audit row written: anodyne aggregate (mirrors /stats + /by-month).

      res.json({
        quarters: paged,
        totalQuarters,
        grandCount,
        grandApprovedCount,
        grandRejectedCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      console.error("[travel-visa/applications-by-quarter] error:", e.message);
      res.status(500).json({
        error: "Failed to compute by-quarter metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ============================================================================
// GET /api/travel/visa/applications/by-year — tenant-wide annual rollup
// (PRD_TRAVEL_VISA Phase 3 — completes the operational rollup triplet:
// by-month fc7b8165 + by-quarter <prior> + by-year THIS COMMIT). Mirrors
// the pattern of /itineraries/by-year + /suppliers/by-year +
// /visa/analytics/by-year (V21, 1006+) family.
//
// SAME SHAPE FAMILY as /applications/by-month + /applications/by-quarter,
// with the bucket key swapped to a 4-digit UTC year (YYYY). Annual
// resolution is what board-level reporting + multi-year trend
// visualisations need; the operators' dashboard renders monthly +
// quarterly + yearly side-by-side from this triplet.
//
// Sub-brand scoping: same as siblings — VisaApplication has no subBrand
// column; visa-sure-ness is encoded via Contact.subBrand="visasure".
// Resolve visa-sure contact IDs first, then aggregate VisaApplication
// rows whose contactId is in that set. The narrowing is structurally
// IDENTICAL to /applications/by-quarter (Contact.subBrand="visasure"
// gate — no extra restriction needed at the aggregation layer because
// every surviving row is visa-sure by construction).
//
// Bucket key: YYYY (e.g. "2026") derived from VisaApplication.createdAt's
// UTC year. UTC over local-tz for the same cross-border-stability
// rationale as the month/quarter siblings.
//
// USER-readable: anodyne aggregate (counts only). Role gate matches
// by-month + by-quarter: verifyRole(['ADMIN','MANAGER','USER']).
//
// Query string:
//   status    optional VisaApplication.status filter; invalid → 400
//             INVALID_STATUS.
//   from      optional inclusive lower bound on bucket (YYYY); invalid
//             → 400 INVALID_YEAR_FORMAT.
//   to        optional inclusive upper bound on bucket (YYYY); invalid
//             → 400 INVALID_YEAR_FORMAT.
//   orderBy   default "year:asc" (chronological); also accepts
//             "year:desc", "count:asc|desc", "approvedCount:asc|desc".
//             Unknown tokens degrade silently to default.
//   limit     default 10, max 30 (mirrors analytics V21 by-year).
//   offset    default 0
//
// Response shape:
//   {
//     years: [ {
//       year: "2026",
//       count,
//       intakeCount, docsPendingCount, filedCount, approvedCount,
//       rejectedCount, appealCount,
//       complexCount, flaggedCount,
//     } ],
//     totalYears,
//     grandCount,
//     grandApprovedCount,
//     grandRejectedCount,
//     limit, offset,
//   }
//
// Defensive: null/invalid createdAt → "unknown" bucket (excluded when
// from/to is set, kept otherwise). Empty scoped-contact set → all-zeros
// envelope (NOT 404 / 500).
//
// No audit row written — anodyne aggregate, mirrors /stats + /by-month +
// /by-quarter. (Analytics V21 writes ANALYTICS_READ; operational variants
// stay silent.)
//
// Express path-precedence: literal-path /applications/by-year MUST be
// declared BEFORE /applications/:id (otherwise `:id="by-year"` would
// 400 INVALID_ID before reaching this handler). Same constraint as
// /applications/by-month + /applications/by-quarter + /applications/stats.
// ============================================================================
router.get(
  "/applications/by-year",
  verifyRole(["ADMIN", "MANAGER", "USER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const statusFilter = req.query.status ? String(req.query.status) : null;
      const orderByRaw = req.query.orderBy
        ? String(req.query.orderBy)
        : "year:asc";

      // Status enum validation — mirrors by-month + by-quarter.
      if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "INVALID_STATUS",
        });
      }

      // YYYY validation — strict 4-digit calendar year. Same regex as
      // analytics V21 by-year.
      const YEAR_RE = /^\d{4}$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !YEAR_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY format (e.g. 2026)",
          code: "INVALID_YEAR_FORMAT",
        });
      }
      if (toRaw !== null && !YEAR_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY format (e.g. 2026)",
          code: "INVALID_YEAR_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "year:asc",
        "year:desc",
        "count:asc",
        "count:desc",
        "approvedCount:asc",
        "approvedCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

      // Resolve visa-sure contact IDs first.
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true },
      });

      const emptyEnvelope = () => ({
        years: [],
        totalYears: 0,
        grandCount: 0,
        grandApprovedCount: 0,
        grandRejectedCount: 0,
        limit: take,
        offset: skip,
      });

      if (visaContacts.length === 0) {
        return res.json(emptyEnvelope());
      }

      const contactIds = visaContacts.map((c) => c.id);

      const where = { tenantId, contactId: { in: contactIds } };
      if (statusFilter) where.status = statusFilter;

      const applications = await prisma.visaApplication.findMany({
        where,
        select: {
          id: true,
          status: true,
          complexCase: true,
          advisorRiskFlag: true,
          createdAt: true,
        },
      });

      if (applications.length === 0) {
        return res.json(emptyEnvelope());
      }

      const makeEmptyRow = (yearKey) => ({
        year: yearKey,
        count: 0,
        intakeCount: 0,
        docsPendingCount: 0,
        filedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        appealCount: 0,
        complexCount: 0,
        flaggedCount: 0,
      });

      const byYear = new Map();
      for (const a of applications) {
        let yearKey = "unknown";
        if (a.createdAt) {
          const dt = new Date(a.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            yearKey = String(dt.getUTCFullYear());
          }
        }

        let row = byYear.get(yearKey);
        if (!row) {
          row = makeEmptyRow(yearKey);
          byYear.set(yearKey, row);
        }

        row.count += 1;

        if (a.status) {
          const field = STATUS_FIELD[a.status];
          if (field) row[field] += 1;
        }

        if (a.complexCase === true) row.complexCount += 1;
        if (a.advisorRiskFlag) row.flaggedCount += 1;
      }

      let years = [...byYear.values()];

      // Apply ?from / ?to bucket filter. YYYY sorts lexicographically =
      // chronologically because the year is fixed-width. "unknown" rows
      // excluded when either bound set.
      if (fromRaw !== null) {
        years = years.filter(
          (r) => r.year !== "unknown" && r.year >= fromRaw,
        );
      }
      if (toRaw !== null) {
        years = years.filter(
          (r) => r.year !== "unknown" && r.year <= toRaw,
        );
      }

      // Sort. "year" sorts lexicographically on YYYY (also chronological).
      // "unknown" sorts last in asc / first in desc (lexicographically >
      // "9999") — acceptable for a defensive fallback bucket.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      years.sort((a, b) => {
        if (field === "year") {
          if (a.year < b.year) return -1 * mult;
          if (a.year > b.year) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalYears = years.length;
      const grandCount = years.reduce((acc, r) => acc + (r.count || 0), 0);
      const grandApprovedCount = years.reduce(
        (acc, r) => acc + (r.approvedCount || 0),
        0,
      );
      const grandRejectedCount = years.reduce(
        (acc, r) => acc + (r.rejectedCount || 0),
        0,
      );

      const paged = years.slice(skip, skip + take);

      // No audit row written: anodyne aggregate (mirrors /stats + /by-month
      // + /by-quarter).

      res.json({
        years: paged,
        totalYears,
        grandCount,
        grandApprovedCount,
        grandRejectedCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      console.error("[travel-visa/applications-by-year] error:", e.message);
      res.status(500).json({
        error: "Failed to compute by-year metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── GET /api/travel/visa/applications/:id ─────────────────────────
//
// Full detail for a single visa application. Drives the AdvisorDashboard
// SHELL (90b58fa) per-row drilldown.
//
// Response shape:
//   {
//     id, tenantId, contactId, applicationType, destinationCountry,
//     status, readinessLevel, complexCase, advisorRiskFlag,
//     rejectionHistoryJson, filedAt, decidedAt, outcome, outcomeReason,
//     recoveryProgramId, createdAt, updatedAt,
//     contact: { id, name, email, phone, source, subBrand } | null,
//     diagnostic: { id, classification, classificationLabel,
//                   recommendedTier, score, createdAt } | null,
//     documentChecklist: [ { id, docType, required, status, attachmentId,
//                            notes }, ... ]
//   }
//
// Errors:
//   400 INVALID_ID          — :id not numeric
//   404 NOT_FOUND           — no application for this tenant
//   404 NOT_VISA_SURE       — application exists but its Contact has
//                             subBrand != "visasure" (sub-brand isolation)
router.get(
  "/applications/:id",
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "id must be a number",
          code: "INVALID_ID",
        });
      }

      const application = await prisma.visaApplication.findFirst({
        where: { id, tenantId },
        include: {
          documentChecklist: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!application) {
        return res.status(404).json({
          error: "Visa application not found",
          code: "NOT_FOUND",
        });
      }

      // Sub-brand isolation: load Contact and reject if its subBrand
      // is not "visasure". This keeps an accidental TMC/RFU/Travel-Stall
      // contact (with a stray VisaApplication row) out of the Visa Sure
      // surface. Same defense-in-depth posture as the analytics surface.
      const contact = await prisma.contact.findFirst({
        where: { id: application.contactId, tenantId },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          source: true,
          subBrand: true,
        },
      });

      if (!contact || contact.subBrand !== VISA_SUB_BRAND) {
        return res.status(404).json({
          error: "Visa application not found",
          code: "NOT_VISA_SURE",
        });
      }

      // Optional diagnostic join — the latest TravelDiagnostic row for
      // this contact + visasure sub-brand. Tolerant of "no diagnostic
      // ever taken" — surfaces diagnostic=null in that case.
      let diagnostic = null;
      try {
        const latest = await findLatestDiagnostic(
          prisma,
          tenantId,
          application.contactId,
          VISA_SUB_BRAND,
        );
        if (latest) {
          diagnostic = {
            id: latest.id,
            classification: latest.classification || null,
            classificationLabel: latest.classificationLabel || null,
            recommendedTier: latest.recommendedTier || null,
            score: latest.score != null ? Number(latest.score) : null,
            // findLatestDiagnostic's projection exposes createdAt only —
            // there is no completedAt column on TravelDiagnostic. The
            // create-time IS the completion-time since the helper
            // populates the row on diagnostic submit.
            createdAt: latest.createdAt || null,
          };
        }
      } catch (e) {
        // Diagnostic lookup failure is non-fatal — surface diagnostic=null
        // and continue. The advisor dashboard renders the empty-state
        // copy for the diagnostic section in that case.
        console.error(
          "[travel-visa/detail] diagnostic lookup non-fatal error:",
          e.message,
        );
      }

      // Best-effort audit.
      writeAudit(
        "VisaApplication",
        "APPLICATION_READ",
        id,
        req.user.userId,
        tenantId,
        { subBrand: VISA_SUB_BRAND, applicationType: application.applicationType },
      ).catch(() => {});

      res.json({
        ...application,
        contact,
        diagnostic,
      });
    } catch (e) {
      console.error("[travel-visa/detail] error:", e.message);
      res.status(500).json({
        error: "Failed to load visa application",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── POST /api/travel/visa/applications ─────────────────────────────
//
// CREATE a new Visa Sure application in intake state. Drives the
// Applications.jsx (c0ab496) "Create Application" drawer (future follow-
// up tick wiring the UI side — this dispatch is backend only).
//
// Body shape:
//   {
//     contactId: <Int> (REQUIRED) — existing Contact on this tenant; must
//                                  carry subBrand="visasure" or 403
//                                  NOT_VISA_SURE. 404 NOT_FOUND if the
//                                  contact doesn't exist on this tenant.
//     applicationType: <String> (REQUIRED) — one of VALID_APPLICATION_TYPES
//                                  (tourist | business | student | work |
//                                  umrah | hajj). 400 INVALID_APPLICATION_TYPE
//                                  on anything else.
//     destinationCountry: <String> (REQUIRED) — 1..200 chars. 400
//                                  MISSING_FIELDS / INVALID_DESTINATION
//                                  outside that range.
//   }
//
// SCHEMA NOTES (drift from dispatch brief):
//   - The dispatch named a `notes` body field. VisaApplication has NO
//     `notes` column today; notes live on VisaDocumentChecklistItem
//     (per-document, not per-application). DROPPED from the body.
//     If a future card needs an application-level note, that's a
//     schema migration (`notes String? @db.Text`) — separate scope.
//   - The dispatch named a `priorityLevel` body field. NOT in schema
//     today. The closest signal is `advisorRiskFlag` (null | low |
//     medium | high | priority), but that's a derived signal owned by
//     visaRiskFlagEngine, NOT a body-supplied field. DROPPED from the
//     body.
//   - The dispatch named `destination`; schema column is
//     `destinationCountry`. Renamed in the body contract to match.
//
// Behavior: create the row with `status="intake"` (the schema default;
// pinned explicitly here for shape clarity), `tenantId` from
// req.travelTenant.id, all other optional columns left null.
//
// Audit log: writeAudit("VisaApplication", "CREATE", id, ...) — same
// envelope as the GET endpoints, but with the new id surfaced for the
// audit-viewer drilldown.
//
// Errors:
//   400 MISSING_FIELDS              — contactId / applicationType /
//                                     destinationCountry missing or wrong type
//   400 INVALID_APPLICATION_TYPE    — applicationType not in enum
//   400 INVALID_DESTINATION         — destinationCountry empty or > 200 chars
//   404 NOT_FOUND                   — contactId not on this tenant
//   403 NOT_VISA_SURE               — contact exists but Contact.subBrand
//                                     != "visasure" (sub-brand isolation)
//   500 INTERNAL_ERROR              — Prisma error or unexpected
router.post(
  "/applications",
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      const body = req.body || {};

      // contactId presence + type.
      const contactId =
        typeof body.contactId === "number" ? body.contactId : null;
      if (!Number.isFinite(contactId)) {
        return res.status(400).json({
          error: "contactId is required and must be a number",
          code: "MISSING_FIELDS",
        });
      }

      // applicationType presence + enum.
      const applicationType =
        typeof body.applicationType === "string"
          ? body.applicationType.trim()
          : "";
      if (!applicationType) {
        return res.status(400).json({
          error: "applicationType is required",
          code: "MISSING_FIELDS",
        });
      }
      if (!VALID_APPLICATION_TYPES.includes(applicationType)) {
        return res.status(400).json({
          error: `applicationType must be one of: ${VALID_APPLICATION_TYPES.join(", ")}`,
          code: "INVALID_APPLICATION_TYPE",
        });
      }

      // destinationCountry presence + length.
      const destinationCountry =
        typeof body.destinationCountry === "string"
          ? body.destinationCountry.trim()
          : "";
      if (!destinationCountry) {
        return res.status(400).json({
          error: "destinationCountry is required",
          code: "MISSING_FIELDS",
        });
      }
      if (destinationCountry.length > 200) {
        return res.status(400).json({
          error: "destinationCountry must be 1..200 chars",
          code: "INVALID_DESTINATION",
        });
      }

      // Contact existence + tenant + sub-brand verification. Single
      // findFirst with tenantId scope avoids cross-tenant leakage; the
      // sub-brand check is the second layer (defense-in-depth — same
      // posture as the GET /:id detail handler).
      const contact = await prisma.contact.findFirst({
        where: { id: contactId, tenantId },
        select: { id: true, subBrand: true },
      });
      if (!contact) {
        return res.status(404).json({
          error: "Contact not found on this tenant",
          code: "NOT_FOUND",
        });
      }
      if (contact.subBrand !== VISA_SUB_BRAND) {
        return res.status(403).json({
          error:
            "Contact is not in the Visa Sure sub-brand; visa applications can only be created for visasure contacts",
          code: "NOT_VISA_SURE",
        });
      }

      // Create. `status` is pinned to "intake" here for shape clarity even
      // though the schema default would land us at the same value.
      const created = await prisma.visaApplication.create({
        data: {
          tenantId,
          contactId,
          applicationType,
          destinationCountry,
          status: "intake",
        },
      });

      // Best-effort audit — never blocks the response.
      writeAudit(
        "VisaApplication",
        "CREATE",
        created.id,
        req.user.userId,
        tenantId,
        {
          subBrand: VISA_SUB_BRAND,
          contactId,
          applicationType,
          destinationCountry,
        },
      ).catch(() => {});

      res.status(201).json(created);
    } catch (e) {
      console.error("[travel-visa/create] error:", e.message);
      res.status(500).json({
        error: "Failed to create visa application",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── PATCH /api/travel/visa/applications/:id ────────────────────────
//
// Status transitions + advisor edits. Drives the AdvisorDashboard
// per-row action surface (status pill click, "mark complex case" toggle,
// "set risk flag = priority" button, applicationType correction). Mirrors
// the field-by-field opt-in PATCH pattern in routes/travel_itineraries.js
// (PATCH /itineraries/:id) — only fields present in the body are mutated,
// everything else is left alone.
//
// Body shape (every field OPTIONAL — at least one must be present):
//   {
//     status?:             <enum>  — VALID_STATUSES (intake|docs-pending|
//                                    filed|approved|rejected|appeal)
//     applicationType?:    <enum>  — VALID_APPLICATION_TYPES
//     destinationCountry?: <str>   — 1..200 chars
//     advisorRiskFlag?:    <enum|null|""> — VALID_RISK_FLAGS, or null/""
//                                    to clear the flag
//     complexCase?:        <bool>  — flips the complex-case marker
//   }
//
// SCHEMA NOTES (drift from dispatch brief):
//   - The dispatch named a `notes` field. VisaApplication has NO `notes`
//     column today (per-application notes live nowhere on the row;
//     per-document notes live on VisaDocumentChecklistItem). DROPPED from
//     the PATCH body. If a future card needs an application-level note
//     that's a schema migration + separate scope. Same drift as the POST
//     handler's brief.
//
// Behavior: load the application, verify Contact.subBrand="visasure"
// (sub-brand isolation — identical posture to the GET /:id and POST
// handlers), build an update object with ONLY the provided fields, write,
// audit, return 200 + the updated row.
//
// Audit log: writeAudit("VisaApplication", "UPDATE", id, ..., {
//   changedFields: [...keys of update object] }) — surfaces exactly which
// columns the PATCH mutated, for the audit-viewer drilldown.
//
// Errors:
//   400 INVALID_ID                — :id not numeric
//   400 EMPTY_BODY                — request body had zero updatable fields
//   400 INVALID_STATUS            — status not in enum
//   400 INVALID_APPLICATION_TYPE  — applicationType not in enum
//   400 INVALID_DESTINATION       — destinationCountry empty or > 200 chars
//   400 INVALID_RISK_FLAG         — advisorRiskFlag not in enum (and not
//                                   null/"" clear)
//   400 INVALID_COMPLEX_CASE      — complexCase not a boolean
//   404 NOT_FOUND                 — no application for this tenant
//   404 NOT_VISA_SURE             — application exists but its Contact has
//                                   subBrand != "visasure"
//   500 INTERNAL_ERROR            — Prisma error or unexpected
router.patch(
  "/applications/:id",
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "id must be a number",
          code: "INVALID_ID",
        });
      }

      // Verify application exists on this tenant.
      // #929 Part B — also select `status` so we can detect status
      // transitions + emit `visa.status_changed` webhook after update.
      const existing = await prisma.visaApplication.findFirst({
        where: { id, tenantId },
        select: { id: true, contactId: true, status: true },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Visa application not found",
          code: "NOT_FOUND",
        });
      }

      // Sub-brand isolation: load the upstream Contact and reject if its
      // subBrand isn't visasure. Same defense-in-depth as GET /:id.
      const contact = await prisma.contact.findFirst({
        where: { id: existing.contactId, tenantId },
        select: { id: true, subBrand: true },
      });
      if (!contact || contact.subBrand !== VISA_SUB_BRAND) {
        return res.status(404).json({
          error: "Visa application not found",
          code: "NOT_VISA_SURE",
        });
      }

      // Field-by-field opt-in. Only fields present in the body are
      // mutated; everything else stays put. Matches travel_itineraries.js
      // PATCH pattern (line 271+).
      const body = req.body || {};
      const data = {};

      if (body.status !== undefined) {
        if (typeof body.status !== "string" || !VALID_STATUSES.includes(body.status)) {
          return res.status(400).json({
            error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
            code: "INVALID_STATUS",
          });
        }
        data.status = body.status;
      }

      if (body.applicationType !== undefined) {
        if (
          typeof body.applicationType !== "string" ||
          !VALID_APPLICATION_TYPES.includes(body.applicationType)
        ) {
          return res.status(400).json({
            error: `applicationType must be one of: ${VALID_APPLICATION_TYPES.join(", ")}`,
            code: "INVALID_APPLICATION_TYPE",
          });
        }
        data.applicationType = body.applicationType;
      }

      if (body.destinationCountry !== undefined) {
        const dest =
          typeof body.destinationCountry === "string"
            ? body.destinationCountry.trim()
            : "";
        if (!dest || dest.length > 200) {
          return res.status(400).json({
            error: "destinationCountry must be 1..200 chars",
            code: "INVALID_DESTINATION",
          });
        }
        data.destinationCountry = dest;
      }

      if (body.advisorRiskFlag !== undefined) {
        // null OR empty string clears the flag.
        if (body.advisorRiskFlag === null || body.advisorRiskFlag === "") {
          data.advisorRiskFlag = null;
        } else if (
          typeof body.advisorRiskFlag !== "string" ||
          !VALID_RISK_FLAGS.includes(body.advisorRiskFlag)
        ) {
          return res.status(400).json({
            error: `advisorRiskFlag must be one of: ${VALID_RISK_FLAGS.join(", ")} (or null/"" to clear)`,
            code: "INVALID_RISK_FLAG",
          });
        } else {
          data.advisorRiskFlag = body.advisorRiskFlag;
        }
      }

      if (body.complexCase !== undefined) {
        if (typeof body.complexCase !== "boolean") {
          return res.status(400).json({
            error: "complexCase must be a boolean",
            code: "INVALID_COMPLEX_CASE",
          });
        }
        data.complexCase = body.complexCase;
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "no updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      const updated = await prisma.visaApplication.update({
        where: { id },
        data,
      });

      writeAudit(
        "VisaApplication",
        "UPDATE",
        id,
        req.user.userId,
        tenantId,
        {
          subBrand: VISA_SUB_BRAND,
          changedFields: Object.keys(data),
        },
      ).catch(() => {});

      // #929 Part B — fire-and-forget webhook emission when status
      // transitions (e.g. intake → docs-pending → filed → approved).
      // Subscribers (Callified.ai, partner SaaSes) can react to lifecycle
      // events without polling. Uses shared safeEmitEvent helper
      // (extracted to lib/eventBus.js tick #47).
      if (data.status && data.status !== existing.status) {
        const { safeEmitEvent } = require("../lib/eventBus");
        safeEmitEvent(
          "visa.status_changed",
          {
            id,
            contactId: existing.contactId,
            subBrand: VISA_SUB_BRAND,
            oldStatus: existing.status,
            newStatus: data.status,
            tenantId,
            changedAt: new Date().toISOString(),
          },
          tenantId,
          "travel-visa/patch",
        );
      }

      res.json(updated);
    } catch (e) {
      console.error("[travel-visa/patch] error:", e.message);
      res.status(500).json({
        error: "Failed to update visa application",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── GET /api/travel/visa/applications/:id/status-history ───────────
//
// Read-only audit-derived chronological history of an application's
// lifecycle events (CREATE / UPDATE / status transitions). Mirrors the
// audit-trail pattern shipped at:
//   - #900 slice 15 — backend/routes/travel_quotes.js /quotes/:id/audit-trail
//   - #908 slice 18 — backend/routes/travel_flyer_templates.js /audit-trail
//
// Surfaced for the AdvisorDashboard SHELL (90b58fa) so the per-row
// drilldown can render an inline "history" drawer (who moved this
// application from intake → docs-pending → filed, when, with what
// metadata) without paging the generic /api/audit feed and filtering
// client-side (heavy + leaks other entities + cross-tenant risk).
//
// AUDIT-ROW NOTES (what is and isn't emitted today):
//   - CREATE rows: emitted by POST /applications (see writeAudit
//     "CREATE" call around line ~514).
//   - UPDATE rows: emitted by PATCH /applications/:id (see writeAudit
//     "UPDATE" call around line ~713). The `details` JSON includes
//     `changedFields: [...]` — so callers can detect "status changed"
//     by inspecting whether `'status'` appears in changedFields.
//   - A dedicated `STATUS_CHANGE` action is NOT currently written by
//     this route's PATCH handler — that's a future slice (the route's
//     header comment historically said "status transitions need an
//     explicit state-machine + audit"; the dedicated row type would
//     land alongside that work). This endpoint reads whatever rows
//     the audit table has today: CREATE + UPDATE (and any forward-
//     compatible STATUS_CHANGE rows if the future slice ships them).
//   - APPLICATION_READ rows are intentionally EXCLUDED — they're
//     read-event audit (PHI access tracking) not lifecycle events,
//     and surfacing them in a status-history drawer would clutter
//     the timeline. Same exclusion as #900 slice 15.
//
// Behavior:
//   - 400 INVALID_ID for non-numeric :id.
//   - 404 NOT_FOUND for cross-tenant or missing application (resolved
//     via the same {id, tenantId} pattern as GET /:id).
//   - 404 NOT_VISA_SURE when application exists but its owning
//     Contact.subBrand != 'visasure' — defense-in-depth sub-brand
//     isolation, identical posture to the other Visa endpoints.
//   - Defensive empty: if no audit rows exist for this entityId
//     (route never emitted any, or row table was pruned), returns
//     `{applicationId, total: 0, history: []}` — NOT 404.
//
// Query params:
//   ?limit=N   default 100, clamped to [1..500] (matches slice 15's 500 cap)
//   ?from=ISO  optional lower bound on createdAt (inclusive)
//   ?to=ISO    optional upper bound on createdAt (inclusive)
//   Bad ISO date → 400 INVALID_DATE_BOUND.
//
// Response shape:
//   {
//     applicationId: <int>,
//     total:         <int>,           // count BEFORE limit
//     history: [
//       {
//         at:          <ISO string>,
//         action:      <string>,       // CREATE | UPDATE | STATUS_CHANGE | ...
//         fromStatus:  <string|null>,  // from details.fromStatus if present
//         toStatus:    <string|null>,  // from details.toStatus or details.status
//         userId:      <int|null>,     // actor id; null for system/cron writes
//         details:     <object|null>   // parsed details JSON (full payload)
//       },
//       ...
//     ]
//   }
//
// Auth: same gate as the rest of the file — verifyToken (router-level)
// + verifyRole(['ADMIN','MANAGER']) + requireTravelTenant.
//
// No audit row written: read-only meta surface (mirrors slice 12 / 13
// / 17 / 18 — meta reads don't audit-back themselves).
router.get(
  "/applications/:id/status-history",
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "id must be a number",
          code: "INVALID_ID",
        });
      }

      // Resolve + tenant-gate the application FIRST so cross-tenant /
      // cross-sub-brand callers can't enumerate audit-event existence
      // via a 200-with-empty-history reply.
      const application = await prisma.visaApplication.findFirst({
        where: { id, tenantId },
        select: { id: true, contactId: true },
      });
      if (!application) {
        return res.status(404).json({
          error: "Visa application not found",
          code: "APPLICATION_NOT_FOUND",
        });
      }

      // Sub-brand isolation: same defense-in-depth as GET /:id and PATCH.
      const contact = await prisma.contact.findFirst({
        where: { id: application.contactId, tenantId },
        select: { id: true, subBrand: true },
      });
      if (!contact || contact.subBrand !== VISA_SUB_BRAND) {
        return res.status(404).json({
          error: "Visa application not found",
          code: "NOT_VISA_SURE",
        });
      }

      // Limit clamp: [1..500], default 100. Mirrors #900 slice 15.
      const limitRaw = parseInt(req.query.limit, 10);
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(limitRaw, 500)
          : 100;

      // Optional date bounds. ISO-only; bad input → 400.
      const where = {
        tenantId,
        entity: "VisaApplication",
        entityId: id,
        action: { in: ["CREATE", "UPDATE", "STATUS_CHANGE"] },
      };

      if (req.query.from !== undefined && req.query.from !== "") {
        const fromDate = new Date(String(req.query.from));
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date",
            code: "INVALID_DATE_BOUND",
          });
        }
        where.createdAt = { ...(where.createdAt || {}), gte: fromDate };
      }
      if (req.query.to !== undefined && req.query.to !== "") {
        const toDate = new Date(String(req.query.to));
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE_BOUND",
          });
        }
        where.createdAt = { ...(where.createdAt || {}), lte: toDate };
      }

      // Read in chronological (asc) order — UI renders oldest-first.
      // Total is computed BEFORE limit so the consumer can detect
      // truncation when total > history.length.
      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take: limit,
          select: {
            id: true,
            action: true,
            createdAt: true,
            userId: true,
            details: true,
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      // Re-parse stored details (String? @db.Text JSON) so consumers
      // don't have to. Surface status-transition projections explicitly:
      //   fromStatus → details.fromStatus (future STATUS_CHANGE rows)
      //   toStatus   → details.toStatus  (future) OR details.status (today's
      //                UPDATE rows carry the new status only if the caller
      //                included it in changedFields — the actual new value
      //                is in details.status when explicitly written, else
      //                null). Tolerant of legacy null-details rows.
      const history = rows.map((row) => {
        let parsedDetails = null;
        if (row.details != null) {
          if (typeof row.details === "string") {
            try {
              parsedDetails = JSON.parse(row.details);
            } catch (_e) {
              parsedDetails = { _raw: row.details };
            }
          } else {
            parsedDetails = row.details;
          }
        }

        const fromStatus =
          parsedDetails && typeof parsedDetails === "object"
            ? (parsedDetails.fromStatus ?? parsedDetails.oldStatus ?? null)
            : null;
        const toStatus =
          parsedDetails && typeof parsedDetails === "object"
            ? (parsedDetails.toStatus ?? parsedDetails.newStatus ?? parsedDetails.status ?? null)
            : null;

        const at =
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : new Date(row.createdAt).toISOString();

        return {
          at,
          action: row.action,
          fromStatus,
          toStatus,
          userId: row.userId ?? null,
          details: parsedDetails,
        };
      });

      res.json({
        applicationId: id,
        total,
        history,
      });
    } catch (e) {
      console.error("[travel-visa/status-history] error:", e.message);
      res.status(500).json({
        error: "Failed to load visa application status history",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

module.exports = router;
