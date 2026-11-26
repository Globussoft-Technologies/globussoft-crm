"use strict";

const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requireTravelTenant, VALID_SUB_BRANDS } = require("../middleware/travelGuards");
const prisma = require("../lib/prisma");
const { sanitizeText } = require("../lib/sanitizeJson");
const automation = require("../lib/travelEmailAutomation");

const router = express.Router();
const admin = [verifyToken, requireTravelTenant, verifyRole(["ADMIN"] )];

function cleanBrand(value) {
  if (value === undefined || value === null || value === "" || value === "all") return null;
  const brand = String(value).trim().toLowerCase();
  if (!VALID_SUB_BRANDS.includes(brand)) {
    const error = new Error("Invalid Travel sub-brand"); error.status = 400; error.code = "INVALID_SUB_BRAND"; throw error;
  }
  return brand;
}

function cleanId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) { const error = new Error(`${label} must be a positive integer`); error.status = 400; error.code = "INVALID_ID"; throw error; }
  return id;
}

function normalizeTravelSteps(steps) {
  return steps.map((step, position) => ({
    templateId: cleanId(step.templateId, "template id"),
    position,
    delayMinutes: Math.max(0, Number(step.delayMinutes || 0)),
  }));
}

router.get("/catalog", ...admin, async (req, res) => {
  try {
    const archived = await prisma.travelEmailTemplate.findMany({
      where: { tenantId: req.user.tenantId, isDefault: true, isArchived: true },
      select: { eventKey: true },
    });
    const archivedKeys = new Set(archived.map((row) => row.eventKey));
    const toCatalogItem = ([value, label, subject, body]) => ({ value, label, subject, body });
    const essential = automation.ESSENTIAL_EVENTS.filter(([value]) => !archivedKeys.has(value)).map(toCatalogItem);
    const optional = [
      ...automation.OPTIONAL_EVENTS,
      ...automation.ESSENTIAL_EVENTS.filter(([value]) => archivedKeys.has(value)),
    ].map(toCatalogItem);
    res.json({ essential, optional, subBrands: VALID_SUB_BRANDS });
  } catch (_error) {
    res.status(500).json({ error: "Failed to load Travel email template catalog", code: "TRAVEL_EMAIL_CATALOG_FAILED" });
  }
});

router.get("/templates", ...admin, async (req, res) => {
  try {
    await automation.ensureDefaultTemplates(req.user.tenantId);
    const where = { tenantId: req.user.tenantId, isArchived: false, eventKey: { in: [...automation.EVENT_LABELS.keys()] } };
    if (req.query.eventKey) {
      const requestedEventKey = String(req.query.eventKey);
      if (!automation.EVENT_LABELS.has(requestedEventKey)) return res.json([]);
      where.eventKey = requestedEventKey;
    }
    const rows = await prisma.travelEmailTemplate.findMany({ where, orderBy: [{ eventKey: "asc" }, { subBrand: "asc" }, { updatedAt: "desc" }] });
    res.json(rows.map((row) => ({ ...row, eventLabel: automation.EVENT_LABELS.get(row.eventKey) || row.eventKey, subBrand: row.subBrand || "all" })));
  } catch (_error) { res.status(500).json({ error: "Failed to list Travel email templates", code: "TRAVEL_EMAIL_TEMPLATE_LIST_FAILED" }); }
});

router.post("/templates", ...admin, async (req, res) => {
  try {
    const { eventKey, name, subject, body, isActive } = req.body || {};
    if (!automation.EVENT_LABELS.has(String(eventKey)) || !name || !subject || !body) return res.status(400).json({ error: "eventKey, name, subject, and body are required", code: "INVALID_TEMPLATE" });
    const subBrand = cleanBrand(req.body.subBrand);
    const duplicate = await prisma.travelEmailTemplate.findFirst({ where: { tenantId: req.user.tenantId, eventKey: String(eventKey), subBrand, isArchived: false } });
    if (duplicate) return res.status(409).json({ error: "A Travel template already exists for this event and sub-brand. Edit it or choose another sub-brand.", code: "TRAVEL_TEMPLATE_DUPLICATE" });
    const created = await prisma.travelEmailTemplate.create({ data: { tenantId: req.user.tenantId, eventKey: String(eventKey), subBrand, name: sanitizeText(name), subject: sanitizeText(subject), body: String(body), isActive: isActive === true, isDefault: false } });
    res.status(201).json(created);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to create Travel email template", code: error.code || "TRAVEL_EMAIL_TEMPLATE_CREATE_FAILED" }); }
});

router.put("/templates/:id", ...admin, async (req, res) => {
  try {
    const id = cleanId(req.params.id, "template id");
    const existing = await prisma.travelEmailTemplate.findFirst({ where: { id, tenantId: req.user.tenantId, isArchived: false } });
    if (!existing) return res.status(404).json({ error: "Travel email template not found", code: "NOT_FOUND" });
    const data = {};
    if (req.body.name !== undefined) data.name = sanitizeText(req.body.name);
    if (req.body.subject !== undefined) data.subject = sanitizeText(req.body.subject);
    if (req.body.body !== undefined) data.body = String(req.body.body);
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
    if (req.body.subBrand !== undefined) data.subBrand = cleanBrand(req.body.subBrand);
    const updated = await prisma.travelEmailTemplate.update({ where: { id }, data });
    res.json(updated);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to update Travel email template", code: error.code || "TRAVEL_EMAIL_TEMPLATE_UPDATE_FAILED" }); }
});

router.delete("/templates/:id", ...admin, async (req, res) => {
  try {
    const id = cleanId(req.params.id, "template id");
    const existing = await prisma.travelEmailTemplate.findFirst({
      where: { id, tenantId: req.user.tenantId, isArchived: false },
      select: { id: true, isDefault: true },
    });
    if (!existing) return res.status(404).json({ error: "Travel email template not found", code: "NOT_FOUND" });
    if (existing.isDefault) {
      await prisma.travelEmailTemplate.update({ where: { id: existing.id }, data: { isArchived: true, isActive: false } });
      return res.status(204).end();
    }
    await prisma.travelEmailTemplate.delete({ where: { id: existing.id } });
    res.status(204).end();
  } catch (error) {
    if (error.code === "P2003") return res.status(409).json({ error: "This template is used by a sequence and cannot be deleted", code: "TEMPLATE_IN_USE" });
    res.status(error.status || 500).json({ error: error.message || "Failed to delete Travel email template", code: error.code || "TRAVEL_EMAIL_TEMPLATE_DELETE_FAILED" });
  }
});

router.get("/templates/:id/preview", ...admin, async (req, res) => {
  try {
    const id = cleanId(req.params.id, "template id");
    const template = await prisma.travelEmailTemplate.findFirst({ where: { id, tenantId: req.user.tenantId, isArchived: false } });
    if (!template) return res.status(404).json({ error: "Travel email template not found", code: "NOT_FOUND" });
    const context = await automation.buildContext(req.user.tenantId, { subBrand: template.subBrand, recipientEmail: "customer@example.com", recipientName: "Travel Customer", destination: "Your next adventure", signInLink: "/travel/portal" });
    res.json({ subject: automation.renderText(template.subject, context), body: automation.renderText(template.body, context), eventKey: template.eventKey });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to preview Travel email template", code: "TRAVEL_EMAIL_TEMPLATE_PREVIEW_FAILED" }); }
});

router.get("/sequences", ...admin, async (req, res) => {
  try {
    const rows = await prisma.travelEmailSequence.findMany({ where: { tenantId: req.user.tenantId }, include: { steps: { orderBy: { position: "asc" }, include: { template: true } }, _count: { select: { enrollments: true } } }, orderBy: { updatedAt: "desc" } });
    res.json(rows.map((row) => ({ ...row, triggerEvent: row.steps[0]?.template?.eventKey || null, triggerLabel: row.steps[0] ? automation.EVENT_LABELS.get(row.steps[0].template.eventKey) : null, subBrand: row.subBrand || "all" })));
  } catch (_error) { res.status(500).json({ error: "Failed to list Travel email sequences", code: "TRAVEL_EMAIL_SEQUENCE_LIST_FAILED" }); }
});

router.post("/sequences", ...admin, async (req, res) => {
  try {
    const { name, steps } = req.body || {};
    if (!name || !Array.isArray(steps) || !steps.length) return res.status(400).json({ error: "name and at least one sequence step are required", code: "INVALID_SEQUENCE" });
    const subBrand = cleanBrand(req.body.subBrand);
    const normalized = normalizeTravelSteps(steps);
    const templateIds = normalized.map((step) => step.templateId);
    const templates = await prisma.travelEmailTemplate.findMany({ where: { tenantId: req.user.tenantId, isArchived: false, id: { in: templateIds } }, select: { id: true } });
    if (templates.length !== templateIds.length) return res.status(400).json({ error: "Every template must belong to this Travel tenant", code: "TEMPLATE_TENANT_MISMATCH" });
    const sequence = await prisma.travelEmailSequence.create({ data: { tenantId: req.user.tenantId, subBrand, name: sanitizeText(name), isActive: true, steps: { create: normalized } }, include: { steps: { orderBy: { position: "asc" }, include: { template: true } } } });
    res.status(201).json({ ...sequence, triggerEvent: sequence.steps[0].template.eventKey });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to create Travel email sequence", code: error.code || "TRAVEL_EMAIL_SEQUENCE_CREATE_FAILED" }); }
});

router.put("/sequences/:id", ...admin, async (req, res) => {
  try {
    const id = cleanId(req.params.id, "sequence id");
    const existing = await prisma.travelEmailSequence.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Travel email sequence not found", code: "NOT_FOUND" });
    const data = {};
    if (req.body.name !== undefined) data.name = sanitizeText(req.body.name);
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
    if (req.body.subBrand !== undefined) data.subBrand = cleanBrand(req.body.subBrand);
    if (Array.isArray(req.body.steps)) {
      const normalized = normalizeTravelSteps(req.body.steps);
      const templateIds = normalized.map((step) => step.templateId);
      const valid = await prisma.travelEmailTemplate.count({ where: { tenantId: req.user.tenantId, isArchived: false, id: { in: templateIds } } });
      if (valid !== templateIds.length) return res.status(400).json({ error: "Every template must belong to this Travel tenant", code: "TEMPLATE_TENANT_MISMATCH" });
      data.steps = { deleteMany: {}, create: normalized };
    }
    const updated = await prisma.travelEmailSequence.update({ where: { id }, data, include: { steps: { orderBy: { position: "asc" }, include: { template: true } } } });
    res.json({ ...updated, triggerEvent: updated.steps[0]?.template?.eventKey || null });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to update Travel email sequence", code: error.code || "TRAVEL_EMAIL_SEQUENCE_UPDATE_FAILED" }); }
});

router.delete("/sequences/:id", ...admin, async (req, res) => {
  try {
    const id = cleanId(req.params.id, "sequence id");
    const existing = await prisma.travelEmailSequence.findFirst({ where: { id, tenantId: req.user.tenantId }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: "Travel email sequence not found", code: "NOT_FOUND" });
    await prisma.travelEmailSequence.delete({ where: { id } });
    res.status(204).end();
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to delete Travel email sequence", code: error.code || "TRAVEL_EMAIL_SEQUENCE_DELETE_FAILED" }); }
});

router.get("/delivery-logs", ...admin, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 15));
    const where = { tenantId: req.user.tenantId };
    const [logs, total] = await Promise.all([
      prisma.travelEmailDeliveryLog.findMany({
        where,
        select: {
          id: true, templateId: true, contactId: true, eventKey: true, recipientEmail: true,
          subject: true, status: true, provider: true, errorMessage: true, sentAt: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.travelEmailDeliveryLog.count({ where }),
    ]);
    res.json({ logs, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (_error) { res.status(500).json({ error: "Failed to list Travel email delivery logs", code: "TRAVEL_EMAIL_LOG_LIST_FAILED" }); }
});

router.post("/delivery-logs/bulk-delete", ...admin, async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length || ids.length !== rawIds.length || ids.length > 200) {
      return res.status(400).json({ error: "ids must contain 1 to 200 unique positive integers", code: "INVALID_LOG_IDS" });
    }
    const result = await prisma.travelEmailDeliveryLog.deleteMany({ where: { tenantId: req.user.tenantId, id: { in: ids } } });
    res.json({ deleted: result.count });
  } catch (_error) { res.status(500).json({ error: "Failed to delete Travel email delivery logs", code: "TRAVEL_EMAIL_LOG_DELETE_FAILED" }); }
});

router.post("/delivery-logs/:id/resend", ...admin, async (req, res) => {
  try {
    const id = cleanId(req.params.id, "delivery log id");
    const result = await automation.resendTravelEmailDelivery(id, req.user.tenantId);
    if (result.ignored === true && result.reason === "not_found") {
      return res.status(404).json({ error: "Travel email delivery log not found", code: "NOT_FOUND" });
    }
    if (result.ignored) {
      return res.status(400).json({ error: "This delivery has no message to resend", code: "RESEND_UNAVAILABLE" });
    }
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Failed to resend Travel email", code: error.code || "TRAVEL_EMAIL_RESEND_FAILED" });
  }
});

router.get("/delivery-logs/:id", ...admin, async (req, res) => {
  try {
    const id = cleanId(req.params.id, "delivery log id");
    const log = await prisma.travelEmailDeliveryLog.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!log) return res.status(404).json({ error: "Travel email delivery log not found", code: "NOT_FOUND" });
    res.json(log);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to load Travel email delivery log", code: error.code || "TRAVEL_EMAIL_LOG_DETAIL_FAILED" }); }
});

router.post("/test-event", ...admin, async (req, res) => {
  try {
    if (!automation.EVENT_LABELS.has(String(req.body?.eventKey))) return res.status(400).json({ error: "Unknown Travel email event", code: "INVALID_EVENT" });
    const result = await automation.processTravelEmailEvent(String(req.body.eventKey), { ...(req.body.payload || {}), recipientEmail: req.body.payload?.recipientEmail || "customer@example.com", recipientName: req.body.payload?.recipientName || "Travel Customer" }, req.user.tenantId);
    res.json(result);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Failed to test Travel email event", code: error.code || "TRAVEL_EMAIL_TEST_FAILED" }); }
});

module.exports = router;
