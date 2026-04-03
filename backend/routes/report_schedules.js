const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// List all report schedules for current user (admins see all)
router.get("/", async (req, res) => {
  try {
    const where = req.user.role === 'ADMIN' ? {} : { userId: req.user.userId };
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
    if (recipients !== undefined) data.recipients = JSON.stringify(recipients);
    if (format !== undefined) data.format = format;
    if (enabled !== undefined) data.enabled = enabled;

    const schedule = await prisma.reportSchedule.update({
      where: { id },
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
    await prisma.reportSchedule.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: "Schedule deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete report schedule" });
  }
});

// Toggle enable/disable
router.put("/:id/toggle", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.reportSchedule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Schedule not found" });

    const schedule = await prisma.reportSchedule.update({
      where: { id },
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
