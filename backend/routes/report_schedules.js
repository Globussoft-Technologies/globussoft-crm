const express = require("express");

const router = express.Router();
const prisma = require("../lib/prisma");

// #127: validate recipient lists before persisting. The cron mailer would
// otherwise try to deliver to junk like "@@@" and harm sender reputation.
// Pragmatic regex (RFC-5322 lite); we tolerate plus-addressing and dots.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
function validateRecipients(recipients) {
  if (recipients == null) return null; // allowed (server falls back to req.user.email)
  const list = Array.isArray(recipients) ? recipients : [];
  if (list.length === 0) return { error: "At least one recipient is required", code: "RECIPIENTS_REQUIRED" };
  const bad = list.map((r) => String(r).trim()).filter((r) => !EMAIL_RE.test(r));
  if (bad.length) return { error: `Invalid email address(es): ${bad.join(", ")}`, code: "INVALID_RECIPIENT" };
  return null;
}

// List report schedules in current tenant (admins see all in tenant, others see own)
router.get("/", async (req, res) => {
  try {
    const where = req.user.role === 'ADMIN'
      ? { tenantId: req.user.tenantId }
      : { tenantId: req.user.tenantId, userId: req.user.userId };
    const schedules = await prisma.reportSchedule.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch report schedules" });
  }
});

// Create a new report schedule
router.post("/", async (req, res) => {
  try {
    const { name, reportType, metrics, groupBy, frequency, cronExpression, recipients, format, enabled } = req.body;

    const recipErr = validateRecipients(recipients);
    if (recipErr) return res.status(400).json(recipErr);

    const schedule = await prisma.reportSchedule.create({
      data: {
        name,
        reportType: reportType || 'deals',
        metrics: metrics ? JSON.stringify(metrics) : null,
        groupBy: groupBy || null,
        frequency: frequency || 'weekly',
        cronExpression: cronExpression || getCronFromFrequency(frequency || 'weekly'),
        recipients: JSON.stringify(recipients || [req.user.email || 'admin@globussoft.com']),
        format: format || 'PDF',
        enabled: enabled !== false,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      },
      include: { user: { select: { id: true, name: true, email: true } } }
    });
    res.status(201).json(schedule);
  } catch (err) {
    console.error("[Report Schedule Create Error]:", err);
    res.status(500).json({ error: "Failed to create report schedule" });
  }
});

// Update a report schedule
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.reportSchedule.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Schedule not found" });

    const { name, reportType, metrics, groupBy, frequency, cronExpression, recipients, format, enabled } = req.body;

    const data = {};
    if (name !== undefined) data.name = name;
    if (reportType !== undefined) data.reportType = reportType;
    if (metrics !== undefined) data.metrics = JSON.stringify(metrics);
    if (groupBy !== undefined) data.groupBy = groupBy;
    if (frequency !== undefined) {
      data.frequency = frequency;
      if (!cronExpression) data.cronExpression = getCronFromFrequency(frequency);
    }
    if (cronExpression !== undefined) data.cronExpression = cronExpression;
    if (recipients !== undefined) {
      const recipErr = validateRecipients(recipients);
      if (recipErr) return res.status(400).json(recipErr);
      data.recipients = JSON.stringify(recipients);
    }
    if (format !== undefined) data.format = format;
    if (enabled !== undefined) data.enabled = enabled;

    const schedule = await prisma.reportSchedule.update({
      where: { id: existing.id },
      data,
      include: { user: { select: { id: true, name: true, email: true } } }
    });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: "Failed to update report schedule" });
  }
});

// Delete a report schedule
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.reportSchedule.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Schedule not found" });
    await prisma.reportSchedule.delete({ where: { id: existing.id } });
    res.json({ message: "Schedule deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete report schedule" });
  }
});

// Toggle enable/disable
router.put("/:id/toggle", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.reportSchedule.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Schedule not found" });

    const schedule = await prisma.reportSchedule.update({
      where: { id: existing.id },
      data: { enabled: !existing.enabled },
      include: { user: { select: { id: true, name: true, email: true } } }
    });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: "Failed to toggle schedule" });
  }
});

function getCronFromFrequency(frequency) {
  switch (frequency) {
    case 'daily': return '0 8 * * *';       // 8am daily
    case 'weekly': return '0 8 * * 1';      // Monday 8am
    case 'monthly': return '0 8 1 * *';     // 1st of month 8am
    default: return '0 8 * * 1';
  }
}

module.exports = router;
