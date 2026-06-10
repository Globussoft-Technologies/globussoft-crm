const express = require("express");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const router = express.Router();

// Wellness-tenant + PHI-eligible-role gate for Patient inclusion in the
// global search. Mirrors the role list in routes/wellness.js phiReadGate
// (clinical / doctor / professional / telecaller / admin / manager).
// Generic-tenant callers and non-PHI roles get a null result so the
// front-end "patients" section silently stays empty for them — no leak.
const PHI_WELLNESS_ROLES = new Set([
  "doctor",
  "professional",
  "telecaller",
  "helper",
]);
async function canSearchPatients(req) {
  if (!req.user?.tenantId) return false;
  if (req.user.role === "ADMIN" || req.user.role === "MANAGER") {
    // ADMIN/MANAGER still need to be on a wellness tenant.
  } else if (!PHI_WELLNESS_ROLES.has(req.user.wellnessRole)) {
    return false;
  }
  let vertical = req.user.vertical;
  if (!vertical) {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { vertical: true },
      });
      vertical = tenant?.vertical || "generic";
      req.user.vertical = vertical;
    } catch {
      return false;
    }
  }
  return vertical === "wellness";
}

router.get("/", verifyToken, async (req, res) => {
  try {
    const query = req.query.q || "";
    if (query.trim().length === 0) return res.json({});
    const tenantId = req.user.tenantId;

    const includePatients = await canSearchPatients(req);

    const [contacts, deals, invoices, tickets, tasks, projects, contracts, estimates, emails, kbArticles, patients] = await Promise.all([
      prisma.contact.findMany({
        where: { tenantId, OR: [{ name: { contains: query } }, { email: { contains: query } }, { company: { contains: query } }, { phone: { contains: query } }] },
        take: 5, select: { id: true, name: true, email: true, company: true, status: true },
      }),
      prisma.deal.findMany({
        where: { tenantId, title: { contains: query } },
        take: 5, select: { id: true, title: true, amount: true, stage: true },
      }),
      prisma.invoice.findMany({
        where: { tenantId, invoiceNum: { contains: query } },
        take: 5, include: { contact: { select: { name: true } } },
      }),
      prisma.ticket.findMany({
        where: { tenantId, OR: [{ subject: { contains: query } }, { description: { contains: query } }] },
        take: 5, select: { id: true, subject: true, status: true, priority: true },
      }),
      prisma.task.findMany({
        where: { tenantId, title: { contains: query } },
        take: 5, select: { id: true, title: true, status: true, priority: true },
      }),
      prisma.project.findMany({
        where: { tenantId, name: { contains: query } },
        take: 5, select: { id: true, name: true, status: true },
      }),
      prisma.contract.findMany({
        where: { tenantId, title: { contains: query } },
        take: 5, select: { id: true, title: true, status: true },
      }),
      prisma.estimate.findMany({
        where: { tenantId, OR: [{ title: { contains: query } }, { estimateNum: { contains: query } }] },
        take: 5, select: { id: true, title: true, estimateNum: true, status: true },
      }),
      prisma.emailMessage.findMany({
        where: { tenantId, OR: [{ subject: { contains: query } }, { from: { contains: query } }, { to: { contains: query } }] },
        take: 5, select: { id: true, subject: true, from: true, to: true, direction: true, createdAt: true },
      }),
      prisma.kbArticle.findMany({
        where: { tenantId, OR: [{ title: { contains: query } }, { content: { contains: query } }] },
        take: 5, select: { id: true, title: true, slug: true, isPublished: true },
      }),
      // Wellness Patient — only queried for wellness-tenant + PHI-eligible
      // viewers (see canSearchPatients). #1109 regression: pre-fix the
      // omnibar's only patient-like surface was the legacy Contact match,
      // so newly-created Patient rows that had no shadow Contact were
      // invisible in global search. Soft-deleted rows excluded via
      // deletedAt:null to match the Patients page contract.
      includePatients
        ? prisma.patient.findMany({
            where: {
              tenantId,
              deletedAt: null,
              OR: [
                { name: { contains: query } },
                { phone: { contains: query } },
                { email: { contains: query } },
              ],
            },
            take: 5,
            orderBy: { createdAt: "desc" },
            select: { id: true, name: true, email: true, phone: true },
          })
        : Promise.resolve([]),
    ]);

    const totalResults = contacts.length + deals.length + invoices.length + tickets.length + tasks.length + projects.length + contracts.length + estimates.length + emails.length + kbArticles.length + patients.length;

    res.json({ contacts, deals, invoices, tickets, tasks, projects, contracts, estimates, emails, kbArticles, patients, totalResults });
  } catch (err) {
    console.error("[Search] Error:", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

module.exports = router;
