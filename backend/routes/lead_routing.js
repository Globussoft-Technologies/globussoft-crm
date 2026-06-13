const express = require("express");
const prisma = require("../lib/prisma");
// v3.4.11: sanitization adopted from the v3.4.10 audit. LeadRoutingRule has
// two free-text writeable fields:
//   - name (String) — rendered in the /lead-routing admin UI cards (#245)
//   - conditions (String @db.Text storing JSON) — rendered as a chip per #245
// Both surface in the admin UI; an HTML payload here would land as stored
// XSS the next time an admin views the rule list.
const { sanitizeText, sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");

const router = express.Router();

// In-memory round-robin counter, keyed by `${tenantId}:${ruleId}`
const rrCounters = {};

// Canonical lead pipeline statuses (Issue #299).
// Validated case-insensitively so "lead", "Lead", "LEAD" all pass.
const ALLOWED_STATUSES = ["Lead", "Prospect", "Customer", "Churned", "Junk"];
const ALLOWED_STATUSES_LOWER = ALLOWED_STATUSES.map(s => s.toLowerCase());

// TRAVEL_CRM_PRD §4.1 (gap A8) — rule-based brand assignment. `subBrand` is a
// first-class condition key validated against the canonical travel sub-brand
// codes (tmc | rfu | travelstall | visasure). Imported from the shared
// resolver so the routing vocabulary can't drift from the rest of the travel
// vertical. Matching itself rides the generic checkConditionsMatch path
// (Contact.subBrand is a plain nullable column), so rules WITHOUT a subBrand
// condition keep matching every contact — fully backward compatible.
const { VALID_SUB_BRANDS } = require("../lib/subBrandConfig");

// ─── Helpers ────────────────────────────────────────────────────────

function safeJson(str, fallback) {
  if (!str) return fallback;
  if (typeof str === "object") return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

// Normalizes the three accepted condition shapes — scalar, array, and
// { op, value } — into a flat array of scalar values for enum validation.
function collectConditionValues(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.op) {
    // { op: "...", value: ... }
    return Array.isArray(raw.value) ? raw.value : [raw.value];
  }
  if (Array.isArray(raw)) return raw;
  return [raw];
}

// Returns null if conditions object is valid, or an error message string if not.
// Enforces:
//   #299 — when `status` is a condition, value must be in ALLOWED_STATUSES
//   #302 — at least one condition is required (no "any" rules allowed)
//   PRD §4.1 (gap A8) — when `subBrand` is a condition, value must be a
//     canonical travel sub-brand code (case-insensitive, like status)
function validateConditions(conditions) {
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) {
    return "At least one condition is required";
  }
  const keys = Object.keys(conditions);
  if (keys.length === 0) {
    return "At least one condition is required";
  }

  // status enum validation
  if (Object.prototype.hasOwnProperty.call(conditions, "status")) {
    for (const v of collectConditionValues(conditions.status)) {
      if (v == null || v === "") continue;
      if (!ALLOWED_STATUSES_LOWER.includes(String(v).toLowerCase())) {
        return `Invalid status "${v}". Allowed: ${ALLOWED_STATUSES.join(", ")}`;
      }
    }
  }

  // subBrand enum validation (PRD §4.1 gap A8). VALID_SUB_BRANDS is already
  // lowercase; accept any casing on the wire. Rules without a subBrand
  // condition are untouched (backward compatible).
  if (Object.prototype.hasOwnProperty.call(conditions, "subBrand")) {
    for (const v of collectConditionValues(conditions.subBrand)) {
      if (v == null || v === "") continue;
      if (!VALID_SUB_BRANDS.includes(String(v).toLowerCase())) {
        return `Invalid subBrand "${v}". Allowed: ${VALID_SUB_BRANDS.join(", ")}`;
      }
    }
  }

  return null;
}

function checkConditionsMatch(conditions, contact) {
  // conditions = { field: value } OR { field: { op: "eq|contains|in", value: ... } }
  // PRD §4.1 (gap A8): `subBrand` is matched via this generic field path —
  // a rule with { subBrand: "rfu" } only matches contacts whose
  // Contact.subBrand is "rfu" (case-insensitive); contacts with a null
  // subBrand fail the eq-compare against any code. Rules WITHOUT a subBrand
  // condition never inspect contact.subBrand, so they keep matching
  // everything they matched before.
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
// Supports ?fields=summary opt-in slim shape that drops the heavy
// `conditions` JSON string column (often hundreds of bytes per rule) to
// lighten admin list-view payloads and reduce PII surface on the wire.
// Mirrors prior slices of #920.
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const isSummary = req.query.fields === "summary";
    const findArgs = {
      where: { tenantId },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    };
    if (isSummary) {
      findArgs.select = {
        id: true,
        name: true,
        assignType: true,
        assignTo: true,
        priority: true,
        isActive: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
      };
    }
    const rules = await prisma.leadRoutingRule.findMany(findArgs);
    // Full shape parses the JSON-string `conditions` column back to an object
    // for the wire. Summary mode dropped that column so the post-process is a
    // no-op spread — the slim rows go through as-is.
    res.json(
      isSummary
        ? rules
        : rules.map(r => ({ ...r, conditions: safeJson(r.conditions, {}) }))
    );
  } catch (err) {
    console.error("lead_routing GET / error:", err);
    res.status(500).json({ error: "Failed to load lead routing rules" });
  }
});

// PRD_TRAVEL_MULTICHANNEL_LEADS §3.3 — first-class channel + subBrand
// columns promoted out of the JSON `conditions` blob (G007 — FR-3.3.1).
// Validation reuses the same canonical sub-brand list as the legacy
// `conditions.subBrand` gate (gap A8) so the two surfaces share one
// truth.
const VALID_CHANNELS = [
  "whatsapp", "voice", "sms", "email", "voyagr", "meta_ad",
  "google_ad", "linkedin_ad", "indiamart", "justdial", "tradeindia",
  "referral", "chat", "walk_in", "manual", "web_form",
];
function validateChannel(v) {
  if (v == null || v === "") return null;
  if (!VALID_CHANNELS.includes(String(v).toLowerCase())) {
    return `Invalid channel "${v}". Allowed: ${VALID_CHANNELS.join(", ")}`;
  }
  return null;
}
function validateSubBrandCode(v) {
  if (v == null || v === "") return null;
  if (!VALID_SUB_BRANDS.includes(String(v).toLowerCase())) {
    return `Invalid subBrand "${v}". Allowed: ${VALID_SUB_BRANDS.join(", ")}`;
  }
  return null;
}

// POST / — create rule
router.post("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const {
      name, conditions, assignType, assignTo, priority, isActive,
      // G007 additive top-level columns (FR-3.3.1, 3.3.2, 3.3.4)
      channel, subBrand, fallbackUserId,
    } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });

    // #302: reject rules with zero conditions; #299: reject unknown statuses.
    const condErr = validateConditions(conditions);
    if (condErr) return res.status(400).json({ error: condErr });

    // #301 (min=1) + #332 (max=999): priority must be a positive integer in
    // [1, 999]. Above 999 isn't a "rare" priority, it's a data-entry typo
    // that breaks the sort column and overflows the UI chip.
    const priorityNum = priority != null ? Number(priority) : 100;
    if (!Number.isFinite(priorityNum) || priorityNum < 1 || priorityNum > 999 || !Number.isInteger(priorityNum)) {
      return res.status(400).json({ error: "Priority must be an integer between 1 and 999" });
    }

    // G007: validate the first-class channel + subBrand columns against
    // the canonical enums. Null/empty = wildcard, kept as null.
    const channelErr = validateChannel(channel);
    if (channelErr) return res.status(400).json({ error: channelErr });
    const subBrandErr = validateSubBrandCode(subBrand);
    if (subBrandErr) return res.status(400).json({ error: subBrandErr });

    const rule = await prisma.leadRoutingRule.create({
      data: {
        // v3.4.11: HTML-strip name + sanitize conditions JSON for the admin UI
        // render path. validateConditions ran first against the raw input —
        // sanitizing here doesn't affect that gate (it operates on the
        // pre-sanitized bytes that hit Prisma, NOT on validation logic).
        name: sanitizeText(name),
        conditions: sanitizeJsonForStringColumn(conditions || {}),
        assignType: assignType || "round_robin",
        assignTo: assignTo ? Number(assignTo) : null,
        priority: priorityNum,
        isActive: isActive !== false,
        tenantId,
        // G007 top-level columns — lowercased on write for case-insensitive
        // matching in the resolver; null when not supplied (wildcard).
        channel: channel ? String(channel).toLowerCase() : null,
        subBrand: subBrand ? String(subBrand).toLowerCase() : null,
        fallbackUserId: fallbackUserId ? Number(fallbackUserId) : null,
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

    const {
      name, conditions, assignType, assignTo, priority, isActive,
      // G007 additive top-level columns.
      channel, subBrand, fallbackUserId,
    } = req.body || {};

    // #302 / #299: only validate conditions when they're being changed; partial
    // updates such as the active toggle (sends only { isActive }) must still pass.
    if (conditions !== undefined) {
      const condErr = validateConditions(conditions);
      if (condErr) return res.status(400).json({ error: condErr });
    }

    // #301 + #332: same [1, 999] rule on update.
    let priorityNum;
    if (priority !== undefined) {
      priorityNum = Number(priority);
      if (!Number.isFinite(priorityNum) || priorityNum < 1 || priorityNum > 999 || !Number.isInteger(priorityNum)) {
        return res.status(400).json({ error: "Priority must be an integer between 1 and 999" });
      }
    }
    // G007 partial-validation: only check when present in the payload so
    // a clear-to-null update (channel: null) is allowed.
    if (channel !== undefined && channel !== null && channel !== "") {
      const channelErr = validateChannel(channel);
      if (channelErr) return res.status(400).json({ error: channelErr });
    }
    if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
      const subBrandErr = validateSubBrandCode(subBrand);
      if (subBrandErr) return res.status(400).json({ error: subBrandErr });
    }

    const updated = await prisma.leadRoutingRule.update({
      where: { id },
      data: {
        // v3.4.11: same sanitization as POST. Partial updates only sanitize
        // the fields actually being changed (preserves existing safe values).
        ...(name !== undefined && { name: sanitizeText(name) }),
        ...(conditions !== undefined && { conditions: sanitizeJsonForStringColumn(conditions || {}) }),
        ...(assignType !== undefined && { assignType }),
        ...(assignTo !== undefined && { assignTo: assignTo === null ? null : Number(assignTo) }),
        ...(priority !== undefined && { priority: priorityNum }),
        ...(isActive !== undefined && { isActive: !!isActive }),
        // G007 — lowercase on write; null cleared explicitly.
        ...(channel !== undefined && {
          channel: channel ? String(channel).toLowerCase() : null,
        }),
        ...(subBrand !== undefined && {
          subBrand: subBrand ? String(subBrand).toLowerCase() : null,
        }),
        ...(fallbackUserId !== undefined && {
          fallbackUserId: fallbackUserId === null ? null : Number(fallbackUserId),
        }),
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
