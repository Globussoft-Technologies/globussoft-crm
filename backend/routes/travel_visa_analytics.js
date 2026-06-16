// Travel CRM — Visa Sure analytics endpoint SHELL (Phase 3 cluster B3).
//
// Backend data wiring for the Reports.jsx SHELL shipped at 4d70d35.
// Three read-only metrics per docs/PRD_VISA_SURE_PHASE_3.md §3 FR-7
// (portal-matrix rows V16-V18):
//
//   V16  GET /api/travel/visa/analytics/rejection-recovery
//        Recovery success rate — VisaApplications that were rejected and
//        subsequently entered a recovery program (recoveryProgramId set)
//        and either reached `outcome=approved` or `status=approved`.
//        Envelope: { totalRejected, recoveryAttempts, recoverySuccesses,
//                    successRate, rows: [...] }
//
//   V17  GET /api/travel/visa/analytics/conversion-by-readiness
//        Conversion rate by diagnostic readiness level (1..4). Joins
//        TravelDiagnostic (the readiness classifier) → VisaApplication
//        via contactId.
//        Envelope: { byReadinessLevel: [{ level, count, converted,
//                    conversionRate }, ...], rows: [...] }
//
//   V18  GET /api/travel/visa/analytics/lead-source-rate
//        Lead-source → visa-application conversion. Groups Contact.source
//        and counts downstream VisaApplications for each source.
//        Envelope: { bySource: [{ source, leads, applications, rate }, ...],
//                    rows: [...] }
//
// Aggregation pattern mirrors backend/routes/admin.js:206 /llm-spend
// (Prisma groupBy + count, parallel queries, response shape stable
// across empty + populated states).
//
// Sub-brand scoping discipline. VisaApplication itself has NO subBrand
// column (the schema slice we use here only carries applicationType +
// status + readinessLevel + outcome + recoveryProgramId). Visa-Sure-ness
// is encoded via Contact.subBrand="visasure" — Contact is the upstream
// owner of the visa pipeline. Every endpoint joins through Contact and
// filters on Contact.subBrand="visasure" so non-visa applications
// (which would be a schema anomaly today but might exist in fixtures)
// stay out of the rollup. Reverse-filter to req.user.tenantId on the
// VisaApplication row itself for tenant isolation.
//
// Auth: verifyToken (router-level) + verifyRole(['ADMIN','MANAGER'])
// per endpoint + requireTravelTenant (rejects non-travel tenants 403
// WRONG_VERTICAL).
//
// Empty-state contract. Each endpoint returns `rows: []` with a `note`
// field when no VisaApplication rows exist for the tenant — graceful
// for the Reports.jsx SHELL until data accumulates. This is intentional
// SHELL behaviour, NOT a 404; advisor dashboards must render
// "no data yet" cards rather than error toasts.
//
// SCHEMA NOTE — originalStatus column. The dispatch brief named an
// `originalStatus` column that does NOT exist on VisaApplication today.
// The closest available signal is `recoveryProgramId` (FK to a future
// RejectionRecoveryProgram model) which is set when an application
// re-enters processing after a rejection. We use:
//
//   - totalRejected      = applications with status="rejected" OR outcome="rejected"
//   - recoveryAttempts   = applications with recoveryProgramId != null
//                          AND (status="rejected" OR outcome="rejected"
//                               in their history)
//   - recoverySuccesses  = recoveryAttempts where outcome="approved" OR status="approved"
//
// When the RejectionRecoveryProgram model lands (PRD §5 product call),
// this can tighten the join. The contract shape stays the same.

const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");

const router = express.Router();

// All endpoints require auth + ADMIN/MANAGER + travel-vertical tenant.
router.use(verifyToken);

const VISA_SUB_BRAND = "visasure";

// Pinned to `model VisaApplication.status` schema comment
// (prisma/schema.prisma:4688): `String @default("intake") // intake |
// docs-pending | filed | approved | rejected | appeal`. Mirrors
// VALID_STATUSES in backend/routes/travel_visa.js (the upstream owner of
// the status enum). Kept here as a local copy so the analytics route
// stays self-contained for status validation + per-bucket per-month split.
const VALID_STATUSES = [
  "intake",
  "docs-pending",
  "filed",
  "approved",
  "rejected",
  "appeal",
];

// Map status enum value → per-month rollup field name. Used by V19 to
// split monthly counts by status across all 6 enum values.
const STATUS_FIELD = {
  intake: "intakeCount",
  "docs-pending": "docsPendingCount",
  filed: "filedCount",
  approved: "approvedCount",
  rejected: "rejectedCount",
  appeal: "appealCount",
};

// ─── V16 — rejection-recovery success rate ───────────────────────────
router.get(
  "/rejection-recovery",
  requirePermission("visa", "read"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Resolve the set of Visa-Sure contact IDs first. We narrow the
      // VisaApplication scan to applications owned by visasure-tagged
      // contacts; a non-visasure application (schema-anomalous today)
      // is dropped from the rollup.
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true },
      });
      const contactIds = visaContacts.map((c) => c.id);

      if (contactIds.length === 0) {
        return res.json({
          totalRejected: 0,
          recoveryAttempts: 0,
          recoverySuccesses: 0,
          successRate: 0,
          rows: [],
          note: "No Visa Sure contacts yet; data wiring incomplete (cluster B3 PRD §3 FR-7 multi-day work)",
        });
      }

      const whereBase = { tenantId, contactId: { in: contactIds } };

      // Parallel aggregates. groupBy on status gives counts per terminal
      // state; outcome groupBy isolates the "rejected then recovered"
      // population. recoveryProgramId presence is the recovery-attempt
      // marker (schema TODO: tighten when RejectionRecoveryProgram lands).
      const [totalRejected, recoveryAttempts, recoverySuccesses, byStatus] =
        await Promise.all([
          prisma.visaApplication.count({
            where: {
              ...whereBase,
              OR: [{ status: "rejected" }, { outcome: "rejected" }],
            },
          }),
          prisma.visaApplication.count({
            where: {
              ...whereBase,
              recoveryProgramId: { not: null },
            },
          }),
          prisma.visaApplication.count({
            where: {
              ...whereBase,
              recoveryProgramId: { not: null },
              OR: [{ outcome: "approved" }, { status: "approved" }],
            },
          }),
          prisma.visaApplication.groupBy({
            by: ["status"],
            where: whereBase,
            _count: { _all: true },
          }),
        ]);

      const successRate =
        recoveryAttempts > 0 ? recoverySuccesses / recoveryAttempts : 0;

      const rows = byStatus.map((r) => ({
        status: r.status,
        count: r._count._all,
      }));

      await writeAudit(
        "VisaApplication",
        "ANALYTICS_READ",
        0,
        req.user.userId,
        tenantId,
        { metric: "rejection-recovery", subBrand: VISA_SUB_BRAND },
      ).catch(() => {});

      res.json({
        totalRejected,
        recoveryAttempts,
        recoverySuccesses,
        successRate: Number(successRate.toFixed(4)),
        rows,
      });
    } catch (e) {
      console.error("[travel-visa-analytics/recovery] error:", e.message);
      res.status(500).json({
        error: "Failed to compute rejection-recovery metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── V17 — conversion by diagnostic readiness level ───────────────────
router.get(
  "/conversion-by-readiness",
  requirePermission("visa", "read"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // VisaApplication.readinessLevel is denormalized from the upstream
      // TravelDiagnostic.classification ("level_1".."level_4") into an
      // integer 1..4. We groupBy readinessLevel on VisaApplications
      // scoped to visasure contacts, then split into total + converted
      // populations.
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true },
      });
      const contactIds = visaContacts.map((c) => c.id);

      if (contactIds.length === 0) {
        return res.json({
          byReadinessLevel: [],
          rows: [],
          note: "No Visa Sure contacts yet; data wiring incomplete (cluster B3 PRD §3 FR-7 multi-day work)",
        });
      }

      const whereBase = { tenantId, contactId: { in: contactIds } };

      const [totals, converted] = await Promise.all([
        prisma.visaApplication.groupBy({
          by: ["readinessLevel"],
          where: whereBase,
          _count: { _all: true },
        }),
        prisma.visaApplication.groupBy({
          by: ["readinessLevel"],
          where: {
            ...whereBase,
            OR: [{ outcome: "approved" }, { status: "approved" }],
          },
          _count: { _all: true },
        }),
      ]);

      // Build a level → counts map. Levels are 1..4 per PRD §4.2; we
      // include every level (even with zero counts) so the chart UI has
      // a stable axis.
      const convertedByLevel = new Map(
        converted.map((r) => [r.readinessLevel, r._count._all]),
      );
      const totalByLevel = new Map(
        totals.map((r) => [r.readinessLevel, r._count._all]),
      );

      const LEVELS = [1, 2, 3, 4];
      const byReadinessLevel = LEVELS.map((lvl) => {
        const count = totalByLevel.get(lvl) || 0;
        const conv = convertedByLevel.get(lvl) || 0;
        const rate = count > 0 ? conv / count : 0;
        return {
          level: `level_${lvl}`,
          count,
          converted: conv,
          conversionRate: Number(rate.toFixed(4)),
        };
      });

      // Also surface rows with null/unknown readinessLevel for ops
      // visibility — they don't fit the 1..4 buckets but they exist.
      const nullCount = totalByLevel.get(null) || 0;
      if (nullCount > 0) {
        const nullConv = convertedByLevel.get(null) || 0;
        byReadinessLevel.push({
          level: "unknown",
          count: nullCount,
          converted: nullConv,
          conversionRate: nullCount > 0 ? Number((nullConv / nullCount).toFixed(4)) : 0,
        });
      }

      await writeAudit(
        "VisaApplication",
        "ANALYTICS_READ",
        0,
        req.user.userId,
        tenantId,
        { metric: "conversion-by-readiness", subBrand: VISA_SUB_BRAND },
      ).catch(() => {});

      res.json({
        byReadinessLevel,
        rows: byReadinessLevel,
      });
    } catch (e) {
      console.error("[travel-visa-analytics/readiness] error:", e.message);
      res.status(500).json({
        error: "Failed to compute conversion-by-readiness metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── V18 — lead source → application conversion rate ─────────────────
router.get(
  "/lead-source-rate",
  requirePermission("visa", "read"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Group Contacts by `source` field, scoped to subBrand=visasure
      // for the lead-side denominator. Then count downstream
      // VisaApplications per Contact for the applications numerator.
      // groupBy on source gives lead counts per source. Then for each
      // source we count distinct contactIds that have ≥1 VisaApplication.
      const contactsBySource = await prisma.contact.groupBy({
        by: ["source"],
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        _count: { _all: true },
      });

      if (contactsBySource.length === 0) {
        return res.json({
          bySource: [],
          rows: [],
          note: "No Visa Sure leads yet; data wiring incomplete (cluster B3 PRD §3 FR-7 multi-day work)",
        });
      }

      // For each source bucket, find how many of its contacts have
      // ≥1 VisaApplication. We fetch the full set of contactIds per
      // source then probe applications in a single query for efficiency.
      const allVisaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true, source: true },
      });

      // Map contactId → source for the application-side rollup.
      const contactToSource = new Map(
        allVisaContacts.map((c) => [c.id, c.source || "(none)"]),
      );

      // Pull distinct contactIds that have ≥1 visa application.
      const appContactsRaw = await prisma.visaApplication.findMany({
        where: {
          tenantId,
          contactId: { in: allVisaContacts.map((c) => c.id) },
        },
        select: { contactId: true },
        distinct: ["contactId"],
      });
      const appContactIds = new Set(appContactsRaw.map((a) => a.contactId));

      // Aggregate per source.
      const appsBySource = new Map();
      for (const cid of appContactIds) {
        const src = contactToSource.get(cid) || "(none)";
        appsBySource.set(src, (appsBySource.get(src) || 0) + 1);
      }

      const bySource = contactsBySource
        .map((r) => {
          const source = r.source || "(none)";
          const leads = r._count._all;
          const applications = appsBySource.get(source) || 0;
          const rate = leads > 0 ? applications / leads : 0;
          return {
            source,
            leads,
            applications,
            rate: Number(rate.toFixed(4)),
          };
        })
        .sort((a, b) => b.leads - a.leads);

      await writeAudit(
        "VisaApplication",
        "ANALYTICS_READ",
        0,
        req.user.userId,
        tenantId,
        { metric: "lead-source-rate", subBrand: VISA_SUB_BRAND },
      ).catch(() => {});

      res.json({
        bySource,
        rows: bySource,
      });
    } catch (e) {
      console.error("[travel-visa-analytics/lead-source] error:", e.message);
      res.status(500).json({
        error: "Failed to compute lead-source-rate metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── V19 — by-month time series rollup ────────────────────────────────
//
// GET /api/travel/visa/analytics/by-month
//
// Tenant-wide VisaApplication time-series bucketed by UTC YYYY-MM, joined
// via Contact.subBrand='visasure'. 4th analytics endpoint complementing
// V16/V17/V18 (the single-rollup metrics shipped in slice 3). Where the
// other endpoints emit one envelope per rollup dimension, V19 emits one
// row per UTC-month present in the scoped application set + a per-status
// split + complexCount + flaggedCount breakdown.
//
// Mirrors backend/routes/travel_quotes.js /quotes/by-month (slice 16 at
// dc0b1cfa) for the bucketing template (UTC YYYY-MM regex validation,
// orderBy semantics, "unknown" bucket fallback for null/invalid
// createdAt, limit/offset pagination AFTER aggregation). Status enum
// derived from VALID_STATUSES (the canonical visa-application status
// list also used by /applications/stats just-shipped at 20d91295).
//
// Bucket key shape: ISO YYYY-MM string (e.g. "2026-05") derived from
// VisaApplication.createdAt's UTC year + month. UTC chosen deliberately
// so bucket labels stay stable across operator timezones — visa
// reconciliation works in calendar-month UTC for cross-border work.
//
// Scope rules:
//   - Tenant-scoped on VisaApplication.tenantId.
//   - Sub-brand-restricted via Contact.subBrand="visasure" — same join
//     pattern as V16/V17/V18.
//   - verifyToken (router-level) + verifyRole(['ADMIN','MANAGER']) +
//     requireTravelTenant per the V16-V18 pattern.
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
// Response shape:
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
router.get(
  "/by-month",
  requirePermission("visa", "read"),
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

      // Status enum validation — mirrors /applications list.
      if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "INVALID_STATUS",
        });
      }

      // YYYY-MM validation — same regex slice 16 (/quotes/by-month) uses.
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

      // Resolve visa-sure contact IDs first (mirrors the V16/V17/V18 pattern).
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
      // either bound is set; kept otherwise. Mirrors slice 16 (/quotes/by-month).
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

      await writeAudit(
        "VisaApplication",
        "ANALYTICS_READ",
        0,
        req.user.userId,
        tenantId,
        { metric: "by-month", subBrand: VISA_SUB_BRAND },
      ).catch(() => {});

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
      console.error("[travel-visa-analytics/by-month] error:", e.message);
      res.status(500).json({
        error: "Failed to compute by-month metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── V20 — by-quarter time series rollup ──────────────────────────────
//
// GET /api/travel/visa/analytics/by-quarter
//
// 5th analytics endpoint (V20) completing the V16-V19 + V20 set. Mirrors
// V19 /by-month at calendar-quarter resolution. Tenant-wide
// VisaApplication time-series bucketed by UTC YYYY-Qn (Q1=Jan-Mar,
// Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec), joined via Contact.subBrand=
// 'visasure'. Where /by-month emits one row per UTC-month, V20 emits one
// row per UTC-quarter with the same per-status + complex + flagged
// split. Useful for QBR-style executive summaries where 12 monthly rows
// is too noisy and the natural cadence is 4 quarterly rows per year.
//
// Bucket key shape: ISO YYYY-Qn string (e.g. "2026-Q2") derived from
// VisaApplication.createdAt's UTC year + month → quarter mapping.
// month [1..3]→Q1, [4..6]→Q2, [7..9]→Q3, [10..12]→Q4. UTC chosen
// deliberately so bucket labels stay stable across operator timezones —
// visa reconciliation works in calendar-quarter UTC for cross-border
// work.
//
// Scope rules:
//   - Tenant-scoped on VisaApplication.tenantId.
//   - Sub-brand-restricted via Contact.subBrand="visasure" — same join
//     pattern as V16/V17/V18/V19.
//   - verifyToken (router-level) + verifyRole(['ADMIN','MANAGER']) +
//     requireTravelTenant per the V16-V19 pattern.
//
// Query string:
//   status    optional VisaApplication.status filter (intake / docs-pending
//             / filed / approved / rejected / appeal); invalid → 400
//             INVALID_STATUS.
//   from      optional inclusive lower bound on bucket (YYYY-Qn); invalid
//             → 400 INVALID_QUARTER_FORMAT.
//   to        optional inclusive upper bound on bucket (YYYY-Qn); invalid
//             → 400 INVALID_QUARTER_FORMAT.
//   orderBy   default "quarter:asc" (chronological); also accepts
//             "quarter:desc", "count:asc|desc", "approvedCount:asc|desc".
//             Unknown tokens degrade silently to default.
//   limit     default 12 (three years), max 40 (10 years).
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
// from/to is set, kept otherwise so the count surface stays accurate).
// Empty scoped-contact set → all-zeros envelope (NOT 404 / 500) so the
// dashboard tile renders gracefully.
router.get(
  "/by-quarter",
  requirePermission("visa", "read"),
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

      // Status enum validation — mirrors V19.
      if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "INVALID_STATUS",
        });
      }

      // YYYY-Qn validation — calendar quarter (Q1..Q4 only).
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

      // Resolve visa-sure contact IDs first (mirrors V16-V19).
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

      // Aggregate per-UTC-quarter. Map "YYYY-Qn" → row.
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
            // getUTCMonth() is 0-indexed; (m/3 floor)+1 gives Q1..Q4.
            const q = Math.floor(dt.getUTCMonth() / 3) + 1;
            quarterKey = `${yyyy}-Q${q}`;
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

      // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
      // either bound is set; kept otherwise. Mirrors V19.
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

      // Sort. "quarter" sorts lexicographically on YYYY-Qn (also
      // chronological since the quarter token Q1<Q2<Q3<Q4 sorts correctly
      // alongside the year prefix). "unknown" sorts last in asc / first in
      // desc.
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

      await writeAudit(
        "VisaApplication",
        "ANALYTICS_READ",
        0,
        req.user.userId,
        tenantId,
        { metric: "by-quarter", subBrand: VISA_SUB_BRAND },
      ).catch(() => {});

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
      console.error("[travel-visa-analytics/by-quarter] error:", e.message);
      res.status(500).json({
        error: "Failed to compute by-quarter metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// ─── V21 — by-year time series rollup ─────────────────────────────────
//
// GET /api/travel/visa/analytics/by-year
//
// 6th analytics endpoint (V21) completing the V16-V21 set. Mirrors V19
// (/by-month) + V20 (/by-quarter) at calendar-year resolution.
// Tenant-wide VisaApplication time-series bucketed by UTC YYYY (4-digit
// calendar year), joined via Contact.subBrand='visasure'. Where
// /by-month emits one row per UTC-month and /by-quarter one per
// UTC-quarter, V21 emits one row per UTC-year with the same per-status
// + complex + flagged split. Useful for board-level annual reports
// where the natural cadence is "how many visas did we process this
// calendar year, broken down by terminal outcome".
//
// Bucket key shape: ISO YYYY string (e.g. "2026") derived from
// VisaApplication.createdAt's UTC year via getUTCFullYear(). UTC
// chosen deliberately so bucket labels stay stable across operator
// timezones — visa reconciliation works in calendar-year UTC for
// cross-border work, matching V19/V20.
//
// Scope rules:
//   - Tenant-scoped on VisaApplication.tenantId.
//   - Sub-brand-restricted via Contact.subBrand="visasure" — same join
//     pattern as V16/V17/V18/V19/V20.
//   - verifyToken (router-level) + verifyRole(['ADMIN','MANAGER']) +
//     requireTravelTenant per the V16-V20 pattern.
//
// Query string:
//   status    optional VisaApplication.status filter (intake / docs-pending
//             / filed / approved / rejected / appeal); invalid → 400
//             INVALID_STATUS.
//   from      optional inclusive lower bound on bucket (YYYY); invalid →
//             400 INVALID_YEAR_FORMAT.
//   to        optional inclusive upper bound on bucket (YYYY); invalid →
//             400 INVALID_YEAR_FORMAT.
//   orderBy   default "year:asc" (chronological); also accepts
//             "year:desc", "count:asc|desc", "approvedCount:asc|desc".
//             Unknown tokens degrade silently to default.
//   limit     default 10 (one decade), max 30 (three decades).
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
// from/to is set, kept otherwise so the count surface stays accurate).
// Empty scoped-contact set → all-zeros envelope (NOT 404 / 500) so the
// dashboard tile renders gracefully.
router.get(
  "/by-year",
  requirePermission("visa", "read"),
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

      // Status enum validation — mirrors V19/V20.
      if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "INVALID_STATUS",
        });
      }

      // YYYY validation — strict 4-digit calendar year.
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

      // Resolve visa-sure contact IDs first (mirrors V16-V20).
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

      // Aggregate per-UTC-year. Map "YYYY" → row.
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

      // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
      // either bound is set; kept otherwise. Mirrors V19/V20.
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

      await writeAudit(
        "VisaApplication",
        "ANALYTICS_READ",
        0,
        req.user.userId,
        tenantId,
        { metric: "by-year", subBrand: VISA_SUB_BRAND },
      ).catch(() => {});

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
      console.error("[travel-visa-analytics/by-year] error:", e.message);
      res.status(500).json({
        error: "Failed to compute by-year metrics",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

module.exports = router;
