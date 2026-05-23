// Travel CRM — Visa Sure applications endpoints (Phase 3 backend SHELL + CREATE).
//
// Backend wire-up for the Phase 3 cluster B3 Visa Sure frontend SHELLs:
//   - frontend/src/pages/travel/visa/Applications.jsx (875c082) — list view
//   - frontend/src/pages/travel/visa/AdvisorDashboard.jsx (90b58fa) — per-row
//     detail (V8 diagnostic answers / V9 AI summary / V10 risk indicators)
//
// Endpoints:
//   GET  /api/travel/visa/applications              — paginated list with filters
//   GET  /api/travel/visa/applications/:id          — single application detail
//   POST /api/travel/visa/applications              — create new application (intake)
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

      // Resolve visa-sure contact IDs first (mirrors the analytics pattern).
      // Non-visa applications (schema-anomaly) stay out of the list this way.
      const visaContacts = await prisma.contact.findMany({
        where: { tenantId, subBrand: VISA_SUB_BRAND },
        select: { id: true, name: true, email: true, phone: true },
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
      const contactById = new Map(visaContacts.map((c) => [c.id, c]));

      const where = {
        tenantId,
        contactId: { in: contactIds },
      };
      if (statusFilter) where.status = statusFilter;

      const [applications, total] = await Promise.all([
        prisma.visaApplication.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          skip,
        }),
        prisma.visaApplication.count({ where }),
      ]);

      // Decorate each row with its Contact projection. Doing this here
      // (rather than via a Prisma `include`) avoids the missing
      // `VisaApplication.contact` relation in the schema — VisaApplication
      // carries `contactId Int` only, no @relation block back to Contact.
      const decorated = applications.map((a) => ({
        ...a,
        contact: contactById.get(a.contactId) || null,
      }));

      // Best-effort audit. Same .catch(() => {}) idiom as the analytics
      // surface — never blocks the response.
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
        },
      ).catch(() => {});

      res.json({
        applications: decorated,
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
      // events without polling. Mirrors the canonical pattern from
      // billing.js's payment.collected emission (wave-6a).
      if (data.status && data.status !== existing.status) {
        try {
          const eventBus = require("../lib/eventBus");
          eventBus
            .emitEvent(
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
            )
            .catch((err) =>
              console.warn("[travel-visa/patch] visa.status_changed emit failed:", err.message),
            );
        } catch (emitErr) {
          console.warn("[travel-visa/patch] visa.status_changed setup failed:", emitErr.message);
        }
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

module.exports = router;
