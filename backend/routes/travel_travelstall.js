// Travel CRM — Travel Stall sub-brand surfaces.
//
// Endpoints:
//   POST /api/travel/travelstall/personalised-pdf/regen
//     Customer-facing personalised 3-5 destination PDF (PRD §4.5 + §9.1).
//     ADMIN/MANAGER-gated. Calls llmRouter (bulk-text → gemini-flash
//     primary, claude-haiku fallback per PRD §9.1's locked Q11 routing
//     table) for prose, then renders a branded PDF via
//     services/pdfRenderer.renderTravelStallPersonalisedPdf().
//
// 4th consumer of the lib/llmRouter.js scaffold (commit 583c06b) after
// talking-points (cf876af), form-vs-call (4a7c623), and itinerary
// draft/regen (f02fa5a). Same payload + envelope shape as the third
// consumer — bulk-text → gemini-flash, stub-mode under Q11 absence,
// 1-line swap to real-mode when keys land.
//
// STUB mode today:
//   - Until Q11 LLM keys land, llmRouter returns deterministic
//     [STUB-BULK-TEXT] synthetic prose with stub:true. The endpoint's
//     response envelope surfaces `stub` so callers can flag the
//     pre-creds state in the UI.
//   - Until Q22 brand assets arrive (Yasin's hand-over of the Travel
//     Stall logo + font pack + color palette), the PDF template uses
//     placeholder branding (the existing navy accent + Helvetica
//     defaults). The `// STUB:` marker in pdfRenderer.js's
//     renderTravelStallPersonalisedPdf flags the swap point.
//
// PII discipline: payload includes contact name only — no email /
// phone / address forwarded to the LLM. Mirrors talking-points and
// itinerary-draft patterns.
//
// Mounted at /api/travel by server.js.

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { renderTravelStallPersonalisedPdf } = require("../services/pdfRenderer");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { findLatestDiagnostic } = require("../lib/travelLatestDiagnostic");
const llmRouter = require("../lib/llmRouter");

// POST /api/travel/travelstall/personalised-pdf/regen
//
// Body: { contactId: number, destinations?: string[],
//         budget?: number, durationDays?: number }
//
// - Loads the contact (must be travel-tenant-scoped) + latest TravelDiagnostic
//   for the travelstall sub-brand (optional — the prose still renders if
//   the customer hasn't completed a diagnostic yet, just without tier framing)
// - Calls llmRouter.routeRequest({ task: "bulk-text", ... }) for the
//   destination-by-destination prose
// - Renders a branded PDF via pdfRenderer.renderTravelStallPersonalisedPdf()
// - Returns { pdfUrl, generatedAt, model, stub } envelope. `pdfUrl` is a
//   data URL of the PDF buffer base64-encoded — Phase 2 keeps the PDF
//   transient (no storage layer yet); the eventual blob-store path lands
//   alongside Q22 brand assets.
//
// Validation:
//   400 INVALID_BODY  — non-object body
//   400 INVALID_CONTACT_ID — contactId missing or not a number
//   404 CONTACT_NOT_FOUND  — contact not owned by this tenant
//   400 INVALID_DESTINATIONS — destinations not an array of strings
//   400 INVALID_BUDGET / INVALID_DURATION — numeric coercion fails
router.post(
  "/travelstall/personalised-pdf/regen",
  verifyToken,
  requirePermission("reports", "export"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Body must be an object", code: "INVALID_BODY" });
      }

      const contactId = Number(body.contactId);
      if (!Number.isFinite(contactId) || contactId <= 0) {
        return res.status(400).json({
          error: "contactId required (positive number)",
          code: "INVALID_CONTACT_ID",
        });
      }

      // Optional destinations array — 3 to 5 entries per PRD §4.5. We
      // accept 1..10 for flexibility (advisor may want a single-destination
      // teaser OR a longer "ideas" sheet). The PDF template caps the
      // visible cards at 5 to keep the print compact.
      let destinations = body.destinations;
      if (destinations !== undefined) {
        if (
          !Array.isArray(destinations) ||
          !destinations.every((d) => typeof d === "string" && d.length > 0)
        ) {
          return res.status(400).json({
            error: "destinations must be an array of non-empty strings",
            code: "INVALID_DESTINATIONS",
          });
        }
      }

      let budget = body.budget;
      if (budget !== undefined && budget !== null) {
        budget = Number(budget);
        if (!Number.isFinite(budget) || budget < 0) {
          return res.status(400).json({
            error: "budget must be a non-negative number",
            code: "INVALID_BUDGET",
          });
        }
      }

      let durationDays = body.durationDays;
      if (durationDays !== undefined && durationDays !== null) {
        durationDays = Number(durationDays);
        if (!Number.isInteger(durationDays) || durationDays <= 0) {
          return res.status(400).json({
            error: "durationDays must be a positive integer",
            code: "INVALID_DURATION",
          });
        }
      }

      const contact = await prisma.contact.findFirst({
        where: { id: contactId, tenantId: req.travelTenant.id },
        select: { id: true, name: true, email: true, phone: true },
      });
      if (!contact) {
        return res.status(404).json({
          error: "Contact not found in this tenant",
          code: "CONTACT_NOT_FOUND",
        });
      }

      // Optional latest diagnostic — feeds the prose with tier framing.
      // null is fine; the LLM prompt still has destinations + budget +
      // duration to work with.
      const diagnostic = await findLatestDiagnostic(
        prisma,
        req.travelTenant.id,
        contact.id,
        "travelstall",
      );

      // PII-minimal payload — contact NAME only, never email / phone.
      // Mirrors talking-points + itinerary-draft patterns.
      const payload = {
        subBrand: "travelstall",
        contact: { name: contact.name || null },
        destinations: destinations || null,
        budget: budget != null ? Number(budget) : null,
        durationDays: durationDays != null ? Number(durationDays) : null,
        diagnostic: diagnostic
          ? {
              classification: diagnostic.classification,
              classificationLabel: diagnostic.classificationLabel,
              recommendedTier: diagnostic.recommendedTier,
              score:
                diagnostic.score != null ? Number(diagnostic.score) : null,
            }
          : null,
      };

      const result = await llmRouter.routeRequest({
        task: "bulk-text",
        payload,
        tenantId: req.travelTenant.id,
      });

      const generatedAt = new Date().toISOString();

      // STUB: Travel Stall personalised-PDF template pending Q22 brand assets
      const pdfBuffer = await renderTravelStallPersonalisedPdf({
        contact,
        destinations: destinations || [],
        budget: budget != null ? Number(budget) : null,
        durationDays: durationDays != null ? Number(durationDays) : null,
        diagnostic,
        proseText: result.text,
        generatedAt,
      });

      // Phase 2 keeps the PDF transient — return a data: URL the
      // operator's browser can open / download. Persistent blob-store
      // wiring lands with Q22 brand assets (when we'll also persist a
      // PersonalisedPdf row keyed by contactId + version).
      const pdfUrl = `data:application/pdf;base64,${pdfBuffer.toString("base64")}`;

      res.status(201).json({
        pdfUrl,
        generatedAt,
        model: result.model,
        stub: Boolean(result.stub),
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-travelstall] personalised-pdf regen error:", e.message);
      res
        .status(500)
        .json({ error: "Failed to generate personalised PDF", code: "PDF_RENDER_FAILED" });
    }
  },
);

module.exports = router;
