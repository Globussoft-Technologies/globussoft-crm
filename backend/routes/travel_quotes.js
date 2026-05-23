/**
 * /api/travel/quotes — TravelQuote CRUD (PRD_TRAVEL_QUOTE_BUILDER DD-5.1)
 *
 * Sibling to /api/travel/suppliers (commit 192b8c1) and the upcoming
 * /api/travel/invoices. The TravelQuote model landed at commit fdb793e
 * (2026-05-24 tick #94) as the fork-side of the symmetric Quote/Billing/
 * Supplier decision. This module ships the operator-facing CRUD scaffold.
 *
 * Future slices (not in this commit): pricing engine + line items (PRD §3.2),
 * tax calculation per sub-brand default (DD-5.3 pending product call),
 * PDF render via pdfRenderer.js (DD-5.6 RESOLVED: extend existing),
 * counter-offer flow (DD-5.5 simple-delta v1 / rich-line-edit v2),
 * send-via-WA/email flow (depends on Q9 cred-chase).
 *
 * Sub-brand isolation: every quote carries .subBrand. External API keys
 * scoped to a sub-brand cannot create/edit quotes under a different
 * sub-brand. Operator auth allows cross-sub-brand if multi-grant.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");

const VALID_QUOTE_STATUSES = ["Draft", "Sent", "Accepted", "Rejected"];

function assertValidStatus(s) {
  if (s == null) return;
  if (!VALID_QUOTE_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_QUOTE_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

/**
 * Parse + validate a validUntil date. Accepts ISO 8601 strings or
 * anything Date can swallow; rejects unparseable input and any date
 * earlier than today (midnight comparison so "today" is still valid).
 *
 * Returns the parsed Date (or null if input was nullish).
 */
function parseValidUntil(input) {
  if (input == null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("validUntil must be a parseable date");
    err.status = 400;
    err.code = "INVALID_VALID_UNTIL";
    throw err;
  }
  // Compare against today's midnight so a "today" validUntil is allowed.
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  if (d.getTime() < todayMidnight.getTime()) {
    const err = new Error("validUntil must be today or a future date");
    err.status = 400;
    err.code = "INVALID_VALID_UNTIL";
    throw err;
  }
  return d;
}

// GET /api/travel/quotes
// Honors ?subBrand=tmc (filter to that sub-brand) and ?status=Draft.
router.get("/quotes", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.status) {
      assertValidStatus(String(req.query.status));
      where.status = String(req.query.status);
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [quotes, total] = await Promise.all([
      prisma.travelQuote.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        take,
        skip,
      }),
      prisma.travelQuote.count({ where }),
    ]);
    res.json({ quotes, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] list error:", e.message);
    res.status(500).json({ error: "Failed to list quotes" });
  }
});

// GET /api/travel/quotes/:id
router.get("/quotes/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const quote = await prisma.travelQuote.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!quote) {
      return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, quote.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(quote);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] get error:", e.message);
    res.status(500).json({ error: "Failed to get quote" });
  }
});

// POST /api/travel/quotes — ADMIN/MANAGER only.
// Required: contactId, totalAmount, currency.
// Optional: subBrand (per Q25 — defaults to "tmc"), status (default "Draft"),
// validUntil (parseable date, today-or-future).
router.post(
  "/quotes",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        contactId, totalAmount, currency,
        subBrand, status, validUntil,
      } = req.body || {};

      if (contactId == null || totalAmount == null || !currency) {
        return res.status(400).json({
          error: "contactId, totalAmount, currency required",
          code: "MISSING_FIELDS",
        });
      }

      const contactIdInt = parseInt(contactId, 10);
      if (!Number.isFinite(contactIdInt)) {
        return res.status(400).json({
          error: "contactId must be a number",
          code: "INVALID_CONTACT_ID",
        });
      }

      assertValidStatus(status);
      if (subBrand) assertValidSubBrand(subBrand);
      const parsedValidUntil = parseValidUntil(validUntil);

      // Sub-brand isolation: reject create that targets a sub-brand the
      // caller can't access. Same pattern as travel_suppliers POST.
      const targetSubBrand = subBrand || "tmc";
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, targetSubBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const created = await prisma.travelQuote.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: targetSubBrand,
          contactId: contactIdInt,
          status: status || "Draft",
          totalAmount: totalAmount,
          currency: String(currency),
          validUntil: parsedValidUntil,
        },
      });

      await writeAudit(
        "TravelQuote",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          subBrand: created.subBrand,
          contactId: created.contactId,
          status: created.status,
          currency: created.currency,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] create error:", e.message);
      res.status(500).json({ error: "Failed to create quote" });
    }
  },
);

// PUT /api/travel/quotes/:id — ADMIN/MANAGER only.
router.put(
  "/quotes/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const data = {};
      const {
        contactId, totalAmount, currency,
        subBrand, status, validUntil,
      } = req.body || {};

      if (contactId !== undefined) {
        const ci = parseInt(contactId, 10);
        if (!Number.isFinite(ci)) {
          return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
        }
        data.contactId = ci;
      }
      if (totalAmount !== undefined) data.totalAmount = totalAmount;
      if (currency !== undefined) data.currency = String(currency);
      if (status !== undefined) {
        assertValidStatus(status);
        data.status = status;
      }
      if (subBrand !== undefined) {
        assertValidSubBrand(subBrand);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
        data.subBrand = subBrand;
      }
      if (validUntil !== undefined) {
        data.validUntil = parseValidUntil(validUntil);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelQuote.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelQuote",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] update error:", e.message);
      res.status(500).json({ error: "Failed to update quote" });
    }
  },
);

// DELETE /api/travel/quotes/:id — ADMIN/MANAGER only.
// Hard-delete via prisma.delete (Quote rows are draft-shaped business
// artifacts; hard-delete is fine unlike Supplier which uses soft-delete
// for referential integrity).
router.delete(
  "/quotes/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Audit BEFORE delete so the entityId still resolves cleanly and
      // the audit row records the intent regardless of whether the
      // delete subsequently succeeds.
      await writeAudit(
        "TravelQuote",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          subBrand: existing.subBrand,
          contactId: existing.contactId,
          status: existing.status,
        },
      );

      await prisma.travelQuote.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete quote" });
    }
  },
);

module.exports = router;
