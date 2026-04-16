const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// In-memory round-robin counter, keyed by `${tenantId}:${ruleId}`
const rrCounters = {};

// ─── Helpers ────────────────────────────────────────────────────────

function safeJson(str, fallback) {
  if (!str) return fallback;
  if (typeof str === "object") return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

function checkConditionsMatch(conditions, contact) {
  // conditions = { field: value } OR { field: { op: "eq|contains|in", value: ... } }
  if (!conditions || typeof conditions !== "object") return true;
  const keys = Object.keys(conditions);
  if (keys.length === 0) return true;

  for (const field of keys) {
    const cond = conditions[field];
    const actual = contact[field];

    if (cond && typeof cond === "object" && !Array.isArray(cond) && cond.op) {
      const target = cond.value;
      switch (cond.op) {
        case "eq":
          if (String(actual ?? "").toLowerCase() !== String(target ?? "").toLowerCase()) return false;
          break;
        case "neq":
          if (String(actual ?? "").toLowerCase() === String(target ?? "").toLowerCase()) return false;
          break;
        case "contains":
          if (!String(actual ?? "").toLowerCase().includes(String(target ?? "").toLowerCase())) return false;
          break;
        case "in":
          if (!Array.isArray(target) || !target.map(v => String(v).toLowerCase()).includes(String(actual ?? "").toLowerCase())) return false;
          break;
        case "gt":
          if (!(Number(actual) > Number(target))) return false;
          break;
        case "lt":
          if (!(Number(actual) < Number(target))) return false;
          break;
        default:
          if (String(actual ?? "").toLowerCase() !== String(target ?? "").toLowerCase()) return false;
      }
    } else if (Array.isArray(cond)) {
      if (!cond.map(v => String(v).toLowerCase()).includes(String(actual ?? "").toLowerCase())) return false;
    } else {
      if (String(actual ?? "").toLowerCase() !== String(cond ?? "").toLowerCase()) return false;
    }
  }
  return true;
}

async function pickAssigneeForRule(rule, contact, tenantId) {
  if (rule.assignType === "specific_user") {
    return rule.assignTo || null;
  }

  if (rule.assignType === "territory") {
    const territories = await prisma.territory.findMany({ where: { tenantId } });
    let match = null;
    for (const t of territories) {
      const regions = safeJson(t.regions, []);
      const haystack = [contact.country, contact.city, contact.state, contact.region]
        .filter(Boolean)
        .map(s => String(s).toLowerCase());
      const hit = regions.some(r => haystack.some(h => h.includes(String(r).toLowerCase()) || String(r).toLowerCase().includes(h)));
      if (hit) { match = t; break; }
    }
    if (!match) return null;
    const users = safeJson(match.assignedUserIds, []);
    if (!users.length) return null;
    const key = `${tenantId}:T:${match.id}`;
    const idx = (rrCounters[key] || 0) % users.length;
    rrCounters[key] = (rrCounters[key] || 0) + 1;
    return Number(users[idx]);
  }

  // Default: round_robin across active tenant users
  const users = await prisma.user.findMany({ where: { tenantId }, orderBy: { id: "asc" } });
  if (!users.length) return null;
  const key = `${tenantId}:R:${rule.id}`;
  const idx = (rrCounters[key] || 0) % users.length;
  rrCounters[key] = (rrCounters[key] || 0) + 1;
  return users[idx].id;
}

// ─── Routes ─────────────────────────────────────────────────────────

// GET / — list rules ordered by priority asc
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const rules = await prisma.leadRoutingRule.findMany({
      where: { tenantId },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    res.json(rules.map(r => ({ ...r, conditions: safeJson(r.conditions, {}) })));
  } catch (err) {
    console.error("lead_routing GET / error:", err);
    res.status(500).json({ error: "Failed to load lead routing rules" });
  }
});

// POST / — create rule
router.post("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { name, conditions, assignType, assignTo, priority, isActive } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });
    const rule = await prisma.leadRoutingRule.create({
      data: {
        name,
        conditions: JSON.stringify(conditions || {}),
        assignType: assignType || "round_robin",
        assignTo: assignTo ? Number(assignTo) : null,
        priority: priority != null ? Number(priority) : 100,
        isActive: isActive !== false,
        tenantId,
      },
    });
    res.status(201).json({ ...rule, conditions: safeJson(rule.conditions, {}) });
  } catch (err) {
    console.error("lead_routing POST / error:", err);
    res.status(500).json({ error: "Failed to create routing rule" });
  }
});

// PUT /:id — update
router.put("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.leadRoutingRule.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Rule not found" });

    const { name, conditions, assignType, assignTo, priority, isActive } = req.body || {};
    const updated = await prisma.leadRoutingRule.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(conditions !== undefined && { conditions: JSON.stringify(conditions || {}) }),
        ...(assignType !== undefined && { assignType }),
        ...(assignTo !== undefined && { assignTo: assignTo === null ? null : Number(assignTo) }),
        ...(priority !== undefined && { priority: Number(priority) }),
        ...(isActive !== undefined && { isActive: !!isActive }),
      },
    });
    res.json({ ...updated, conditions: safeJson(updated.conditions, {}) });
  } catch (err) {
    console.error("lead_routing PUT /:id error:", err);
    res.status(500).json({ error: "Failed to update routing rule" });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.leadRoutingRule.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Rule not found" });
    await prisma.leadRoutingRule.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("lead_routing DELETE /:id error:", err);
    res.status(500).json({ error: "Failed to delete routing rule" });
  }
});

// POST /apply/:contactId — apply rules to a single contact
router.post("/apply/:contactId", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contactId = Number(req.params.contactId);
    if (Number.isNaN(contactId)) return res.status(400).json({ error: "Invalid contact id" });

    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const rules = await prisma.leadRoutingRule.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });

    let assignedUserId = null;
    let matchedRule = null;
    for (const rule of rules) {
      const conds = safeJson(rule.conditions, {});
      if (checkConditionsMatch(conds, contact)) {
        const userId = await pickAssigneeForRule(rule, contact, tenantId);
        if (userId) {
          assignedUserId = userId;
          matchedRule = rule;
          break;
        }
      }
    }

    if (assignedUserId) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { assignedToId: assignedUserId },
      });
    }

    res.json({
      contactId: contact.id,
      assignedUserId,
      matchedRule: matchedRule ? { id: matchedRule.id, name: matchedRule.name } : null,
    });
  } catch (err) {
    console.error("lead_routing apply error:", err);
    res.status(500).json({ error: "Failed to apply routing rules" });
  }
});

// POST /apply-all — apply rules to all unassigned contacts
router.post("/apply-all", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contacts = await prisma.contact.findMany({
      where: { tenantId, assignedToId: null },
    });

    const rules = await prisma.leadRoutingRule.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });

    let assignedCount = 0;
    for (const contact of contacts) {
      let userId = null;
      for (const rule of rules) {
        const conds = safeJson(rule.conditions, {});
        if (checkConditionsMatch(conds, contact)) {
          userId = await pickAssigneeForRule(rule, contact, tenantId);
          if (userId) break;
        }
      }
      if (userId) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { assignedToId: userId },
        });
        assignedCount++;
      }
    }

    res.json({ processed: contacts.length, assigned: assignedCount });
  } catch (err) {
    console.error("lead_routing apply-all error:", err);
    res.status(500).json({ error: "Failed to apply routing rules in bulk" });
  }
});

module.exports = router;
