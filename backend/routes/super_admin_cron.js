/**
 * routes/super_admin_cron.js — Cron Maintenance module (Super Admin Portal).
 *
 * All routes here require requireSuperAdmin (mounted with that middleware
 * in server.js). None of this touches the regular User/tenant auth system.
 *
 * Endpoint groups:
 *   Cron Management: GET /crons, GET /crons/:name, POST /crons,
 *     PUT /crons/:name, DELETE /crons/:name, POST /crons/:name/enable,
 *     POST /crons/:name/disable, PUT /crons/:name/schedule,
 *     POST /crons/:name/run-now
 *   Cron Logs: GET /logs (paginated + filterable), GET /logs/:id,
 *     DELETE /logs/:id, POST /logs/clear
 *   Settings: GET /settings/log-retention, PUT /settings/log-retention
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const cronRegistry = require("../lib/cronRegistry");
const { isValidHandlerKey, VALID_HANDLER_KEYS, getHandlerCatalog, buildDynamicTickFn } = require("../lib/cronDynamicHandlers");

const RETENTION_SETTING_KEY = "cron_log_retention_days";
const DEFAULT_RETENTION_DAYS = 30;

// ── Cron Management ─────────────────────────────────────────────────────

router.get("/crons", async (req, res) => {
  try {
    const crons = await prisma.cronConfig.findMany({
      orderBy: { name: "asc" },
      include: {
        logs: { orderBy: { startedAt: "desc" }, take: 1 },
      },
    });
    const registered = new Set(cronRegistry.listRegistered().map((r) => r.name));
    const decorated = crons.map((c) => {
      const lastLog = c.logs[0] || null;
      const { logs, ...rest } = c;
      return {
        ...rest,
        isRegisteredInProcess: registered.has(c.name),
        lastExecutionAt: lastLog ? lastLog.startedAt : null,
        lastStatus: lastLog ? lastLog.status : null,
      };
    });
    res.json({ crons: decorated });
  } catch (e) {
    console.error("[super-admin-cron] GET /crons failed:", e.message);
    res.status(500).json({ error: "Failed to list crons" });
  }
});

// Catalog of dynamic-cron handler types. The UI consumes this so adding a
// new handler in lib/cronDynamicHandlers.js does not require a frontend
// code change to show up in the "Create Cron" form.
router.get("/cron-handlers", async (req, res) => {
  try {
    res.json({ handlers: getHandlerCatalog() });
  } catch (e) {
    console.error("[super-admin-cron] GET /cron-handlers failed:", e.message);
    res.status(500).json({ error: "Failed to load handler catalog" });
  }
});

router.get("/crons/:name", async (req, res) => {
  try {
    const cron = await prisma.cronConfig.findUnique({ where: { name: req.params.name } });
    if (!cron) return res.status(404).json({ error: "Cron not found", code: "CRON_NOT_FOUND" });
    res.json({ cron });
  } catch (e) {
    console.error("[super-admin-cron] GET /crons/:name failed:", e.message);
    res.status(500).json({ error: "Failed to load cron" });
  }
});

// Create a NEW dynamic cron (isSystem:false). System engines (isSystem:true)
// are only ever created by cronRegistry.register() at boot — this route
// can't create or overwrite one of those.
router.post("/crons", async (req, res) => {
  try {
    const { name, description, schedule, handlerKey, metadataJson, enabled } = req.body || {};
    if (!name || typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(name)) {
      return res.status(400).json({
        error: "name is required and must be alphanumeric/dash/underscore, 1-100 chars",
        code: "INVALID_NAME",
      });
    }
    if (!schedule || !cronRegistry.isValidExpression(schedule)) {
      return res.status(400).json({ error: "schedule is not a valid cron expression", code: "INVALID_SCHEDULE" });
    }
    if (!handlerKey || !isValidHandlerKey(handlerKey)) {
      return res.status(400).json({
        error: `handlerKey must be one of: ${VALID_HANDLER_KEYS.join(", ")}`,
        code: "INVALID_HANDLER_KEY",
      });
    }
    if (metadataJson) {
      try {
        JSON.parse(metadataJson);
      } catch {
        return res.status(400).json({ error: "metadataJson is not valid JSON", code: "INVALID_METADATA_JSON" });
      }
    }

    const existing = await prisma.cronConfig.findUnique({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: "A cron with this name already exists", code: "CRON_NAME_TAKEN" });
    }

    const created = await prisma.cronConfig.create({
      data: {
        name,
        description: description || null,
        schedule,
        enabled: enabled !== false,
        isSystem: false,
        handlerKey,
        metadataJson: metadataJson || null,
        createdBy: req.superAdmin.username,
      },
    });

    // Register it live immediately — no restart needed.
    const tickFn = buildDynamicTickFn(handlerKey, metadataJson);
    await cronRegistry.register({
      name,
      description,
      defaultSchedule: schedule,
      defaultEnabled: enabled !== false,
      tickFn,
    });

    res.status(201).json({ cron: created });
  } catch (e) {
    console.error("[super-admin-cron] POST /crons failed:", e.message);
    res.status(500).json({ error: "Failed to create cron" });
  }
});

// Update a dynamic cron's description/handlerKey/metadata (schedule/enabled
// have their own dedicated routes below so the UI's distinct actions map
// 1:1 to distinct endpoints, matching the PRD's separate "Edit Schedule" /
// "Enable/Disable" affordances).
router.put("/crons/:name", async (req, res) => {
  try {
    const existing = await prisma.cronConfig.findUnique({ where: { name: req.params.name } });
    if (!existing) return res.status(404).json({ error: "Cron not found", code: "CRON_NOT_FOUND" });
    if (existing.isSystem) {
      return res.status(403).json({
        error: "System cron engines can only be enabled/disabled/rescheduled, not edited",
        code: "SYSTEM_CRON_READONLY",
      });
    }

    const { description, handlerKey, metadataJson } = req.body || {};
    const data = {};
    if (description !== undefined) data.description = description;
    if (handlerKey !== undefined) {
      if (!isValidHandlerKey(handlerKey)) {
        return res.status(400).json({
          error: `handlerKey must be one of: ${VALID_HANDLER_KEYS.join(", ")}`,
          code: "INVALID_HANDLER_KEY",
        });
      }
      data.handlerKey = handlerKey;
    }
    if (metadataJson !== undefined) {
      if (metadataJson) {
        try {
          JSON.parse(metadataJson);
        } catch {
          return res.status(400).json({ error: "metadataJson is not valid JSON", code: "INVALID_METADATA_JSON" });
        }
      }
      data.metadataJson = metadataJson || null;
    }

    const updated = await prisma.cronConfig.update({ where: { name: req.params.name }, data });

    // Re-register with the (possibly new) handler/metadata so the change is live.
    const tickFn = buildDynamicTickFn(updated.handlerKey, updated.metadataJson);
    await cronRegistry.register({
      name: updated.name,
      description: updated.description,
      defaultSchedule: updated.schedule,
      tickFn,
    });
    await cronRegistry.applyConfig(updated.name);

    res.json({ cron: updated });
  } catch (e) {
    console.error("[super-admin-cron] PUT /crons/:name failed:", e.message);
    res.status(500).json({ error: "Failed to update cron" });
  }
});

// Delete — only dynamic (isSystem:false) crons. System engines are
// protected/critical and can only ever be disabled, never removed, since
// they correspond to real code that still runs at every boot.
router.delete("/crons/:name", async (req, res) => {
  try {
    const existing = await prisma.cronConfig.findUnique({ where: { name: req.params.name } });
    if (!existing) return res.status(404).json({ error: "Cron not found", code: "CRON_NOT_FOUND" });
    if (existing.isSystem) {
      return res.status(403).json({
        error: "System cron engines are protected and cannot be deleted — disable it instead",
        code: "SYSTEM_CRON_PROTECTED",
      });
    }

    cronRegistry.unregister(existing.name);
    await prisma.cronConfig.delete({ where: { name: existing.name } });
    res.json({ ok: true, deleted: existing.name });
  } catch (e) {
    console.error("[super-admin-cron] DELETE /crons/:name failed:", e.message);
    res.status(500).json({ error: "Failed to delete cron" });
  }
});

router.post("/crons/:name/enable", async (req, res) => {
  await setEnabled(req, res, true);
});

router.post("/crons/:name/disable", async (req, res) => {
  await setEnabled(req, res, false);
});

async function setEnabled(req, res, enabled) {
  try {
    const existing = await prisma.cronConfig.findUnique({ where: { name: req.params.name } });
    if (!existing) return res.status(404).json({ error: "Cron not found", code: "CRON_NOT_FOUND" });

    const updated = await prisma.cronConfig.update({
      where: { name: req.params.name },
      data: { enabled },
    });
    // Live effect — no restart needed.
    await cronRegistry.applyConfig(req.params.name);
    res.json({ cron: updated });
  } catch (e) {
    console.error(`[super-admin-cron] set enabled=${enabled} failed:`, e.message);
    res.status(500).json({ error: "Failed to update cron enabled state" });
  }
}

router.put("/crons/:name/schedule", async (req, res) => {
  try {
    const { schedule } = req.body || {};
    if (!schedule || !cronRegistry.isValidExpression(schedule)) {
      return res.status(400).json({ error: "schedule is not a valid cron expression", code: "INVALID_SCHEDULE" });
    }
    const existing = await prisma.cronConfig.findUnique({ where: { name: req.params.name } });
    if (!existing) return res.status(404).json({ error: "Cron not found", code: "CRON_NOT_FOUND" });

    const updated = await prisma.cronConfig.update({
      where: { name: req.params.name },
      data: { schedule },
    });
    // Live effect — tears down + recreates the node-cron task immediately.
    await cronRegistry.applyConfig(req.params.name);
    res.json({ cron: updated });
  } catch (e) {
    console.error("[super-admin-cron] PUT /crons/:name/schedule failed:", e.message);
    res.status(500).json({ error: "Failed to update cron schedule" });
  }
});

// Manual "Run now" trigger — fires immediately regardless of schedule,
// logged with triggerType:"manual" so the Cron Logs screen distinguishes
// it from a real scheduled/startup firing.
router.post("/crons/:name/run-now", async (req, res) => {
  try {
    if (!cronRegistry.isRegistered(req.params.name)) {
      return res.status(409).json({
        error: "This cron is not currently registered in this process (server may need a restart, or it's disabled)",
        code: "CRON_NOT_REGISTERED",
      });
    }
    const result = await cronRegistry.runTick(req.params.name, "manual");
    res.json({ result });
  } catch (e) {
    console.error("[super-admin-cron] POST /crons/:name/run-now failed:", e.message);
    res.status(500).json({ error: "Failed to trigger cron" });
  }
});

// ── Cron Logs ────────────────────────────────────────────────────────────

router.get("/logs", async (req, res) => {
  try {
    const {
      page = "1",
      pageSize = "25",
      cronName,
      status,
      from,
      to,
      search,
    } = req.query;

    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = {};
    if (cronName) where.cronName = cronName;
    if (status) where.status = status;
    if (from || to) {
      where.startedAt = {};
      if (from) {
        const fromDate = new Date(from);
        if (isNaN(fromDate.getTime())) return res.status(400).json({ error: "Invalid `from` date", code: "INVALID_DATE" });
        where.startedAt.gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        if (isNaN(toDate.getTime())) return res.status(400).json({ error: "Invalid `to` date", code: "INVALID_DATE" });
        where.startedAt.lte = toDate;
      }
    }
    if (search) {
      where.OR = [
        { cronName: { contains: search } },
        { errorMessage: { contains: search } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.cronExecutionLog.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip,
        take,
      }),
      prisma.cronExecutionLog.count({ where }),
    ]);

    res.json({ logs, total, page: Number(page), pageSize: take });
  } catch (e) {
    console.error("[super-admin-cron] GET /logs failed:", e.message);
    res.status(500).json({ error: "Failed to list logs" });
  }
});

router.get("/logs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid log id", code: "INVALID_ID" });
    const log = await prisma.cronExecutionLog.findUnique({ where: { id } });
    if (!log) return res.status(404).json({ error: "Log not found", code: "LOG_NOT_FOUND" });
    res.json({ log });
  } catch (e) {
    console.error("[super-admin-cron] GET /logs/:id failed:", e.message);
    res.status(500).json({ error: "Failed to load log" });
  }
});

router.delete("/logs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid log id", code: "INVALID_ID" });
    const existing = await prisma.cronExecutionLog.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Log not found", code: "LOG_NOT_FOUND" });
    await prisma.cronExecutionLog.delete({ where: { id } });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    console.error("[super-admin-cron] DELETE /logs/:id failed:", e.message);
    res.status(500).json({ error: "Failed to delete log" });
  }
});

// Bulk clear — optionally scoped to a single cron name; otherwise clears ALL logs.
router.post("/logs/clear", async (req, res) => {
  try {
    const { cronName } = req.body || {};
    const where = cronName ? { cronName } : {};
    const result = await prisma.cronExecutionLog.deleteMany({ where });
    res.json({ ok: true, deletedCount: result.count });
  } catch (e) {
    console.error("[super-admin-cron] POST /logs/clear failed:", e.message);
    res.status(500).json({ error: "Failed to clear logs" });
  }
});

// ── Settings: log retention ─────────────────────────────────────────────

router.get("/settings/log-retention", async (req, res) => {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
    const retainDays = setting ? parseInt(setting.value, 10) : DEFAULT_RETENTION_DAYS;
    res.json({ retainDays: Number.isFinite(retainDays) ? retainDays : DEFAULT_RETENTION_DAYS });
  } catch (e) {
    console.error("[super-admin-cron] GET /settings/log-retention failed:", e.message);
    res.status(500).json({ error: "Failed to load retention setting" });
  }
});

router.put("/settings/log-retention", async (req, res) => {
  try {
    const { retainDays } = req.body || {};
    const parsed = parseInt(retainDays, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3650) {
      return res.status(400).json({ error: "retainDays must be an integer between 1 and 3650", code: "INVALID_RETENTION_DAYS" });
    }
    const setting = await prisma.systemSetting.upsert({
      where: { key: RETENTION_SETTING_KEY },
      update: { value: String(parsed), updatedBy: req.superAdmin.username },
      create: {
        key: RETENTION_SETTING_KEY,
        value: String(parsed),
        category: "cron-maintenance",
        updatedBy: req.superAdmin.username,
      },
    });
    res.json({ retainDays: parseInt(setting.value, 10) });
  } catch (e) {
    console.error("[super-admin-cron] PUT /settings/log-retention failed:", e.message);
    res.status(500).json({ error: "Failed to update retention setting" });
  }
});

module.exports = router;
