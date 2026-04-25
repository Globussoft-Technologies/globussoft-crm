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

// #171: enums + restrict recipients to tenant users to prevent PII exfil to
// arbitrary external mailboxes. Schedules are an automated export channel —
// they must not be a generic "email arbitrary data anywhere" feature.
const ALLOWED_REPORT_TYPES = new Set(["deals", "contacts", "tasks", "calls", "invoices", "expenses"]);
const ALLOWED_REPORT_FORMATS = new Set(["PDF", "CSV", "XLSX"]);
const ALLOWED_FREQUENCIES = new Set(["daily", "weekly", "monthly", "quarterly"]);

async function validateRecipientsAgainstTenant(recipients, tenantId) {
  // Reuse the shape check (regex, count, etc.).
  const shapeErr = validateRecipients(recipients);
  if (shapeErr) return shapeErr;
  // Hard constraint: every recipient must be a known user in this tenant. This
  // prevents the exfil vector flagged in #171 (attacker@evil.com was accepted).
  const list = recipients.map((r) => String(r).trim().toLowerCase());
  const known = await prisma.user.findMany({
    where: { tenantId, email: { in: list } },
    select: { email: true },
  });
  const knownSet = new Set(known.map((u) => u.email.toLowerCase()));
  const external = list.filter((r) => !knownSet.has(r));
  if (external.length) {
    return {
      status: 400,
      error: `Recipients must be users in this tenant. External: ${external.join(", ")}`,
      code: "EXTERNAL_RECIPIENT_FORBIDDEN",
    };
  }
  return null;
}

// Create a new report schedule
router.post("/", async (req, res) => {
  try {
    const { name, reportType, metrics, groupBy, frequency, cronExpression, recipients, format, enabled } = req.body;

    // #171: validate enums up front — reject "EXE" / "NOT_A_TYPE" / "every-5-minutes"
    // instead of silently coercing or persisting garbage.
    if (reportType !== undefined && !ALLOWED_REPORT_TYPES.has(reportType)) {
      return res.status(400).json({
        error: `reportType must be one of: ${[...ALLOWED_REPORT_TYPES].join(", ")}`,
        code: "INVALID_REPORT_TYPE",
      });
    }
    if (format !== undefined && !ALLOWED_REPORT_FORMATS.has(format)) {
      return res.status(400).json({
        error: `format must be one of: ${[...ALLOWED_REPORT_FORMATS].join(", ")}`,
        code: "INVALID_REPORT_FORMAT",
      });
    }
    if (frequency !== undefined && !ALLOWED_FREQUENCIES.has(frequency)) {
      return res.status(400).json({
        error: `frequency must be one of: ${[...ALLOWED_FREQUENCIES].join(", ")}`,
        code: "INVALID_FREQUENCY",
      });
    }

    // #171: tenant-bounded recipients (was the headline security finding).
    if (recipients !== undefined) {
      const recipErr = await validateRecipientsAgainstTenant(recipients, req.user.tenantId);
      if (recipErr) return res.status(recipErr.status).json(recipErr);
    }

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
      // #171: same tenant-bounded check on update.
      const recipErr = await validateRecipientsAgainstTenant(recipients, req.user.tenantId);
      if (recipErr) return res.status(recipErr.status).json(recipErr);
      data.recipients = JSON.stringify(recipients);
    }
    if (format !== undefined) {
      if (!ALLOWED_REPORT_FORMATS.has(format)) {
        return res.status(400).json({ error: `format must be one of: ${[...ALLOWED_REPORT_FORMATS].join(", ")}`, code: "INVALID_REPORT_FORMAT" });
      }
      data.format = format;
    }
    if (reportType !== undefined) {
      if (!ALLOWED_REPORT_TYPES.has(reportType)) {
        return res.status(400).json({ error: `reportType must be one of: ${[...ALLOWED_REPORT_TYPES].join(", ")}`, code: "INVALID_REPORT_TYPE" });
      }
    }
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
