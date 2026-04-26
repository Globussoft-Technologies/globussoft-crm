/**
 * Lead-side SLA endpoints (PRD §6.4).
 *
 * Mounted at /api/lead-sla. Dashboard surfaces "leads still waiting for first
 * response and past due" so a manager can intervene per the PRD §6.7
 * "zero missed leads" agent goal.
 *
 * Tenant-scoped, ADMIN/MANAGER only.
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
const { runForTenant: runLeadSlaForTenant } = require("../cron/leadSlaEngine");

const tenantId = (req) => req.user?.tenantId || 1;

// All endpoints in this router require ADMIN or MANAGER. The manager-level
// dashboard cluster (lead breaches, escalation queue) is a coaching surface
// for line managers and the owner; line USERs see their own assigned leads
// elsewhere.
router.use(verifyRole(["ADMIN", "MANAGER"]));

// GET /api/lead-sla/breaches — leads currently breaching first-response SLA
//
// Includes both:
//   1. Cron-flagged breaches (slaBreached=true) — already emitted on the bus
//   2. On-the-fly past-due leads (firstResponseDueAt < now, no response, not
//      yet flagged) — covers the gap between "due passed" and "next cron tick"
//
// Returns the union, deduped by contact id, ordered by due-date asc.
router.get("/breaches", async (req, res) => {
  try {
    const now = new Date();
    const tid = tenantId(req);

    const leads = await prisma.contact.findMany({
      where: {
        tenantId: tid,
        status: "Lead",
        firstResponseAt: null,
        firstResponseDueAt: { lt: now },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        source: true,
        aiScore: true,
        assignedToId: true,
        assignedTo: { select: { id: true, name: true, email: true } },
        firstResponseDueAt: true,
        slaBreached: true,
        slaBreachedAt: true,
        createdAt: true,
      },
      orderBy: { firstResponseDueAt: "asc" },
      take: 500,
    });

    const enriched = leads.map((l) => ({
      ...l,
      overdueMinutes: l.firstResponseDueAt
        ? Math.max(
            0,
            Math.round(
              (now.getTime() - new Date(l.firstResponseDueAt).getTime()) / 60000,
            ),
          )
        : 0,
    }));

    res.json(enriched);
  } catch (err) {
    console.error("[LeadSLA][breaches]", err);
    res.status(500).json({ error: "Failed to fetch lead SLA breaches" });
  }
});

// GET /api/lead-sla/stats — quick counts for the dashboard tile
router.get("/stats", async (req, res) => {
  try {
    const tid = tenantId(req);
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const [pendingLeads, breachesToday, totalBreaches] = await Promise.all([
      prisma.contact.count({
        where: {
          tenantId: tid,
          status: "Lead",
          firstResponseAt: null,
          deletedAt: null,
        },
      }),
      prisma.contact.count({
        where: {
          tenantId: tid,
          status: "Lead",
          slaBreached: true,
          slaBreachedAt: { gte: startOfDay },
          deletedAt: null,
        },
      }),
      prisma.contact.count({
        where: {
          tenantId: tid,
          status: "Lead",
          slaBreached: true,
          deletedAt: null,
        },
      }),
    ]);

    res.json({ pendingLeads, breachesToday, totalBreaches });
  } catch (err) {
    console.error("[LeadSLA][stats]", err);
    res.status(500).json({ error: "Failed to fetch lead SLA stats" });
  }
});

// POST /api/lead-sla/check-breaches — admin-only manual trigger for tests/ops.
// Idempotent (the engine's slaBreached=false gate keeps already-fired leads
// from re-emitting).
router.post("/check-breaches", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const result = await runLeadSlaForTenant(tenantId(req));
    res.json(result);
  } catch (err) {
    console.error("[LeadSLA][check-breaches]", err);
    res.status(500).json({ error: "Failed to run lead SLA check" });
  }
});

module.exports = router;
