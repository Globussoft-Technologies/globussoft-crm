const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
const { runForTenant: runSlaBreachForTenant } = require("../cron/slaBreachEngine");

// ─── Helpers ────────────────────────────────────────────────────────────────

const tenantId = (req) => req.user?.tenantId || 1;

const minutesBetween = (a, b) => {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
};

// Coerce a minutes input. Treats 0 as a valid "instant SLA" value (used by
// deterministic breach tests). null / undefined / non-numeric → returns the
// supplied default. Negative → returns the sentinel { negative: true } so the
// caller can return a 400.
const coerceMinutes = (raw, fallback) => {
  if (raw === null || raw === undefined || raw === "") return { value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: fallback };
  const i = Math.trunc(n);
  if (i < 0) return { negative: true };
  return { value: i };
};

// ─── SLA POLICIES ──────────────────────────────────────────────────────────

// GET /api/sla/policies — list SLA policies for tenant
router.get("/policies", async (req, res) => {
  try {
    const policies = await prisma.slaPolicy.findMany({
      where: { tenantId: tenantId(req) },
      orderBy: [{ isActive: "desc" }, { priority: "asc" }, { createdAt: "desc" }],
    });
    res.json(policies);
  } catch (err) {
    console.error("[SLA][policies]", err);
    res.status(500).json({ error: "Failed to fetch SLA policies" });
  }
});

// POST /api/sla/policies — create
router.post("/policies", async (req, res) => {
  try {
    const { name, priority, responseMinutes, resolveMinutes, isActive } = req.body;
    if (!name || !priority) {
      return res.status(400).json({ error: "name and priority are required" });
    }

    // 0 is a VALID "instant SLA" value; only null/undefined/non-numeric fall
    // back to the default of 60 (response) / 1440 (resolve).
    const respCoerced = coerceMinutes(responseMinutes, 60);
    if (respCoerced.negative) {
      return res
        .status(400)
        .json({ error: "responseMinutes cannot be negative", code: "INVALID_RESPONSE_MINUTES" });
    }
    const resolveCoerced = coerceMinutes(resolveMinutes, 1440);
    if (resolveCoerced.negative) {
      return res
        .status(400)
        .json({ error: "resolveMinutes cannot be negative", code: "INVALID_RESOLVE_MINUTES" });
    }

    const policy = await prisma.slaPolicy.create({
      data: {
        name: String(name),
        priority: String(priority),
        responseMinutes: respCoerced.value,
        resolveMinutes: resolveCoerced.value,
        isActive: isActive === undefined ? true : !!isActive,
        tenantId: tenantId(req),
      },
    });
    res.status(201).json(policy);
  } catch (err) {
    console.error("[SLA][create policy]", err);
    res.status(500).json({ error: "Failed to create SLA policy" });
  }
});

// PUT /api/sla/policies/:id
router.put("/policies/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.slaPolicy.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Policy not found" });

    const { name, priority, responseMinutes, resolveMinutes, isActive } = req.body;
    const data = {};
    if (name !== undefined) data.name = String(name);
    if (priority !== undefined) data.priority = String(priority);
    if (responseMinutes !== undefined) {
      // Same rules as POST: 0 is valid (instant SLA); negative → 400.
      const c = coerceMinutes(responseMinutes, existing.responseMinutes);
      if (c.negative) {
        return res
          .status(400)
          .json({ error: "responseMinutes cannot be negative", code: "INVALID_RESPONSE_MINUTES" });
      }
      data.responseMinutes = c.value;
    }
    if (resolveMinutes !== undefined) {
      const c = coerceMinutes(resolveMinutes, existing.resolveMinutes);
      if (c.negative) {
        return res
          .status(400)
          .json({ error: "resolveMinutes cannot be negative", code: "INVALID_RESOLVE_MINUTES" });
      }
      data.resolveMinutes = c.value;
    }
    if (isActive !== undefined) data.isActive = !!isActive;

    const policy = await prisma.slaPolicy.update({ where: { id }, data });
    res.json(policy);
  } catch (err) {
    console.error("[SLA][update policy]", err);
    res.status(500).json({ error: "Failed to update SLA policy" });
  }
});

// DELETE /api/sla/policies/:id
router.delete("/policies/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.slaPolicy.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Policy not found" });

    await prisma.slaPolicy.delete({ where: { id } });
    res.json({ message: "Policy deleted" });
  } catch (err) {
    console.error("[SLA][delete policy]", err);
    res.status(500).json({ error: "Failed to delete SLA policy" });
  }
});

// ─── APPLY SLA TO TICKETS ──────────────────────────────────────────────────

// POST /api/sla/apply/:ticketId — apply matching SLA to a single ticket
router.post("/apply/:ticketId", async (req, res) => {
  try {
    const ticketId = parseInt(req.params.ticketId);
    if (isNaN(ticketId)) return res.status(400).json({ error: "Invalid ticket id" });

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, tenantId: tenantId(req) },
    });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const policy = await prisma.slaPolicy.findFirst({
      where: { tenantId: tenantId(req), priority: ticket.priority, isActive: true },
      orderBy: { createdAt: "desc" },
    });
    if (!policy) {
      return res.status(404).json({ error: "No active SLA policy matches this ticket priority" });
    }

    const base = new Date(ticket.createdAt).getTime();
    const slaResponseDue = new Date(base + policy.responseMinutes * 60000);
    const slaResolveDue = new Date(base + policy.resolveMinutes * 60000);

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: { slaResponseDue, slaResolveDue },
    });
    res.json({ ticket: updated, policy });
  } catch (err) {
    console.error("[SLA][apply]", err);
    res.status(500).json({ error: "Failed to apply SLA to ticket" });
  }
});

// POST /api/sla/apply-all — apply policies to all tickets.
// Default (force=false): only stamp tickets that have no slaResponseDue yet —
//   safe for cron jobs / repeated calls (backwards-compatible).
// ?force=true: re-apply policies to in-flight tickets too, OVERWRITING
//   slaResponseDue / slaResolveDue based on createdAt + current policy minutes.
//   Use after editing a policy that should propagate to existing tickets.
router.post("/apply-all", async (req, res) => {
  try {
    const tid = tenantId(req);
    const force = req.query.force === "true" || req.query.force === "1" || req.body?.force === true;

    const policies = await prisma.slaPolicy.findMany({
      where: { tenantId: tid, isActive: true },
    });
    const policyByPriority = {};
    for (const p of policies) {
      // first match wins (deterministic order: descending createdAt would matter; keep first)
      if (!policyByPriority[p.priority]) policyByPriority[p.priority] = p;
    }

    const tickets = await prisma.ticket.findMany({
      where: force
        ? { tenantId: tid }
        : { tenantId: tid, slaResponseDue: null },
    });

    let applied = 0;
    let skipped = 0;
    for (const t of tickets) {
      const policy = policyByPriority[t.priority];
      if (!policy) {
        skipped += 1;
        continue;
      }
      const base = new Date(t.createdAt).getTime();
      await prisma.ticket.update({
        where: { id: t.id },
        data: {
          slaResponseDue: new Date(base + policy.responseMinutes * 60000),
          slaResolveDue: new Date(base + policy.resolveMinutes * 60000),
        },
      });
      applied += 1;
    }

    res.json({ applied, skipped, total: tickets.length, force });
  } catch (err) {
    console.error("[SLA][apply-all]", err);
    res.status(500).json({ error: "Failed to apply SLAs" });
  }
});

// ─── BREACHES ──────────────────────────────────────────────────────────────

// GET /api/sla/breaches — tickets currently breaching response or resolve
router.get("/breaches", async (req, res) => {
  try {
    const now = new Date();
    const tickets = await prisma.ticket.findMany({
      where: {
        tenantId: tenantId(req),
        OR: [
          { slaResponseDue: { lt: now }, firstResponseAt: null },
          { slaResolveDue: { lt: now }, status: { not: "Resolved" } },
        ],
      },
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: { slaResponseDue: "asc" },
    });

    const enriched = tickets.map((t) => {
      const responseBreach =
        t.slaResponseDue && !t.firstResponseAt && new Date(t.slaResponseDue) < now;
      const resolveBreach =
        t.slaResolveDue && t.status !== "Resolved" && new Date(t.slaResolveDue) < now;
      const responseOverdueMinutes = responseBreach
        ? Math.round((now - new Date(t.slaResponseDue)) / 60000)
        : 0;
      const resolveOverdueMinutes = resolveBreach
        ? Math.round((now - new Date(t.slaResolveDue)) / 60000)
        : 0;
      return {
        ...t,
        responseBreach,
        resolveBreach,
        responseOverdueMinutes,
        resolveOverdueMinutes,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("[SLA][breaches]", err);
    res.status(500).json({ error: "Failed to fetch breaches" });
  }
});

// GET /api/sla/stats — counts and averages
router.get("/stats", async (req, res) => {
  try {
    const tid = tenantId(req);
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const [activePolicies, breachesToday, respondedTickets, resolvedTickets] = await Promise.all([
      prisma.slaPolicy.count({ where: { tenantId: tid, isActive: true } }),
      prisma.ticket.count({
        where: {
          tenantId: tid,
          OR: [
            { slaResponseDue: { lt: now, gte: startOfDay }, firstResponseAt: null },
            { slaResolveDue: { lt: now, gte: startOfDay }, status: { not: "Resolved" } },
          ],
        },
      }),
      prisma.ticket.findMany({
        where: { tenantId: tid, firstResponseAt: { not: null } },
        select: { createdAt: true, firstResponseAt: true },
        take: 500,
        orderBy: { firstResponseAt: "desc" },
      }),
      prisma.ticket.findMany({
        where: { tenantId: tid, resolvedAt: { not: null } },
        select: { createdAt: true, resolvedAt: true },
        take: 500,
        orderBy: { resolvedAt: "desc" },
      }),
    ]);

    const avg = (arr) => (arr.length === 0 ? 0 : Math.round(arr.reduce((s, n) => s + n, 0) / arr.length));
    const responseTimes = respondedTickets
      .map((t) => minutesBetween(t.createdAt, t.firstResponseAt))
      .filter((n) => n !== null && n >= 0);
    const resolveTimes = resolvedTickets
      .map((t) => minutesBetween(t.createdAt, t.resolvedAt))
      .filter((n) => n !== null && n >= 0);

    res.json({
      activePolicies,
      breachesToday,
      avgResponseMinutes: avg(responseTimes),
      avgResolveMinutes: avg(resolveTimes),
      sampleResponseCount: responseTimes.length,
      sampleResolveCount: resolveTimes.length,
    });
  } catch (err) {
    console.error("[SLA][stats]", err);
    res.status(500).json({ error: "Failed to fetch SLA stats" });
  }
});

// POST /api/sla/check-breaches — admin-only manual trigger of the SLA breach
// engine for the calling tenant. Useful for tests + ops without waiting for
// the 5-minute cron tick. Idempotent (the engine's breached=false gate keeps
// already-fired tickets from re-emitting).
router.post("/check-breaches", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const result = await runSlaBreachForTenant(tenantId(req));
    res.json(result);
  } catch (err) {
    console.error("[SLA][check-breaches]", err);
    res.status(500).json({ error: "Failed to run SLA breach check" });
  }
});

module.exports = router;
