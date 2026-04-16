const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// ── Allowed entities & fields ───────────────────────────────────────────
const ENTITY_MAP = {
  Deal: { model: "deal", fields: ["id", "title", "amount", "stage", "probability", "expectedClose", "ownerId", "createdAt"] },
  Contact: { model: "contact", fields: ["id", "name", "email", "status", "source", "aiScore", "createdAt"] },
  Invoice: { model: "invoice", fields: ["id", "amount", "status", "dueDate", "createdAt"] },
  Activity: { model: "activity", fields: ["id", "type", "description", "createdAt"] },
  Task: { model: "task", fields: ["id", "title", "status", "priority", "dueDate"] },
};

const NUMERIC_FIELDS = new Set(["amount", "probability", "aiScore", "id"]);
const DATE_FIELDS = new Set(["createdAt", "expectedClose", "dueDate"]);

// ── Helpers ────────────────────────────────────────────────────────────
function coerceValue(field, value) {
  if (value === null || value === undefined || value === "") return value;
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(value);
    return isNaN(n) ? value : n;
  }
  if (DATE_FIELDS.has(field)) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d;
  }
  return value;
}

function buildWhere(entitySpec, filters, tenantId) {
  const where = { tenantId };
  if (!Array.isArray(filters)) return where;

  for (const f of filters) {
    if (!f || !f.field || !entitySpec.fields.includes(f.field)) continue;
    const op = f.op || "eq";
    const val = coerceValue(f.field, f.value);

    switch (op) {
      case "eq":     where[f.field] = val; break;
      case "neq":    where[f.field] = { not: val }; break;
      case "gt":     where[f.field] = { gt: val }; break;
      case "gte":    where[f.field] = { gte: val }; break;
      case "lt":     where[f.field] = { lt: val }; break;
      case "lte":    where[f.field] = { lte: val }; break;
      case "contains": where[f.field] = { contains: String(val) }; break;
      case "in":
        where[f.field] = { in: Array.isArray(val) ? val.map(v => coerceValue(f.field, v)) : [val] };
        break;
      default: break;
    }
  }
  return where;
}

async function executeReport(config, tenantId) {
  if (!config || typeof config !== "object") throw new Error("Invalid config");
  const entitySpec = ENTITY_MAP[config.entity];
  if (!entitySpec) throw new Error(`Unsupported entity: ${config.entity}`);

  const where = buildWhere(entitySpec, config.filters || [], tenantId);
  const limit = Math.min(parseInt(config.limit) || 100, 1000);

  let columns = Array.isArray(config.columns) && config.columns.length
    ? config.columns.filter(c => entitySpec.fields.includes(c))
    : entitySpec.fields;
  if (columns.length === 0) columns = entitySpec.fields;

  const orderField = config.orderBy?.field && entitySpec.fields.includes(config.orderBy.field)
    ? config.orderBy.field : "createdAt";
  const orderDir = config.orderBy?.dir === "asc" ? "asc" : "desc";

  const model = prisma[entitySpec.model];
  let rows;

  // ── Grouped query ──
  if (config.groupBy && entitySpec.fields.includes(config.groupBy)) {
    const agg = config.aggregate || { type: "count" };
    const aggField = agg.field && entitySpec.fields.includes(agg.field) ? agg.field : null;
    const groupArgs = { by: [config.groupBy], where, take: limit };

    if (agg.type === "sum" && aggField) groupArgs._sum = { [aggField]: true };
    else if (agg.type === "avg" && aggField) groupArgs._avg = { [aggField]: true };
    else groupArgs._count = { _all: true };

    // Order by group field if it matches; else default
    if (entitySpec.fields.includes(orderField) && orderField === config.groupBy) {
      groupArgs.orderBy = { [config.groupBy]: orderDir };
    }

    const grouped = await model.groupBy(groupArgs);
    rows = grouped.map(g => {
      const row = { [config.groupBy]: g[config.groupBy] };
      if (g._sum && aggField) row[`sum_${aggField}`] = g._sum[aggField] ?? 0;
      if (g._avg && aggField) row[`avg_${aggField}`] = g._avg[aggField] ?? 0;
      if (g._count) row.count = g._count._all ?? 0;
      return row;
    });
    const aggKey = agg.type === "sum" && aggField ? `sum_${aggField}`
                : agg.type === "avg" && aggField ? `avg_${aggField}`
                : "count";
    columns = [config.groupBy, aggKey];
  } else {
    // ── Flat findMany ──
    const select = {};
    for (const c of columns) select[c] = true;
    rows = await model.findMany({
      where,
      select,
      orderBy: { [orderField]: orderDir },
      take: limit,
    });
  }

  return { rows, columns, chartType: config.chartType || "table" };
}

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/custom-reports — list saved reports for tenant
router.get("/", async (req, res) => {
  try {
    const reports = await prisma.customReport.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });
    const parsed = reports.map(r => ({
      ...r,
      config: safeParse(r.config),
    }));
    res.json(parsed);
  } catch (err) {
    console.error("List custom reports error:", err);
    res.status(500).json({ error: "Failed to fetch custom reports" });
  }
});

// GET /api/custom-reports/:id
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const report = await prisma.customReport.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!report) return res.status(404).json({ error: "Report not found" });
    res.json({ ...report, config: safeParse(report.config) });
  } catch (err) {
    console.error("Get custom report error:", err);
    res.status(500).json({ error: "Failed to fetch report" });
  }
});

// POST /api/custom-reports — create
router.post("/", async (req, res) => {
  try {
    const { name, description, config } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!config || typeof config !== "object") return res.status(400).json({ error: "config object required" });

    const created = await prisma.customReport.create({
      data: {
        name,
        description: description || null,
        config: JSON.stringify(config),
        userId: req.user.id || null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json({ ...created, config: safeParse(created.config) });
  } catch (err) {
    console.error("Create custom report error:", err);
    res.status(500).json({ error: "Failed to create report" });
  }
});

// PUT /api/custom-reports/:id
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.customReport.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Report not found" });

    const { name, description, config } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (config !== undefined) data.config = JSON.stringify(config);

    const updated = await prisma.customReport.update({
      where: { id: existing.id },
      data,
    });
    res.json({ ...updated, config: safeParse(updated.config) });
  } catch (err) {
    console.error("Update custom report error:", err);
    res.status(500).json({ error: "Failed to update report" });
  }
});

// DELETE /api/custom-reports/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.customReport.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Report not found" });

    await prisma.customReport.delete({ where: { id: existing.id } });
    res.json({ message: "Report deleted" });
  } catch (err) {
    console.error("Delete custom report error:", err);
    res.status(500).json({ error: "Failed to delete report" });
  }
});

// POST /api/custom-reports/run — ad-hoc execute (no save)
router.post("/run", async (req, res) => {
  try {
    const { config } = req.body;
    if (!config) return res.status(400).json({ error: "config required" });
    const result = await executeReport(config, req.user.tenantId);
    res.json(result);
  } catch (err) {
    console.error("Run custom report error:", err);
    res.status(400).json({ error: err.message || "Failed to run report" });
  }
});

// POST /api/custom-reports/:id/run — load saved + execute
router.post("/:id/run", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const report = await prisma.customReport.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!report) return res.status(404).json({ error: "Report not found" });
    const config = safeParse(report.config);
    const result = await executeReport(config, req.user.tenantId);
    res.json(result);
  } catch (err) {
    console.error("Run saved report error:", err);
    res.status(400).json({ error: err.message || "Failed to run report" });
  }
});

function safeParse(s) {
  try { return typeof s === "string" ? JSON.parse(s) : s; }
  catch { return {}; }
}

module.exports = router;
