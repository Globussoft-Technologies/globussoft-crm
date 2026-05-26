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
const { requireTravelTenant } = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");

const router = express.Router();

// All endpoints require auth + ADMIN/MANAGER + travel-vertical tenant.
router.use(verifyToken);

const VISA_SUB_BRAND = "visasure";

// ─── V16 — rejection-recovery success rate ───────────────────────────
router.get(
  "/rejection-recovery",
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN", "MANAGER"]),
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

module.exports = router;
