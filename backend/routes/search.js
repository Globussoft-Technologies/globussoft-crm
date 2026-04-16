const express = require("express");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const router = express.Router();

router.get("/", verifyToken, async (req, res) => {
  try {
    const query = req.query.q || "";
    if (query.trim().length === 0) return res.json({});
    const tenantId = req.user.tenantId;

    const [contacts, deals, invoices, tickets, tasks, projects, contracts, estimates, emails, kbArticles] = await Promise.all([
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
    ]);

    const totalResults = contacts.length + deals.length + invoices.length + tickets.length + tasks.length + projects.length + contracts.length + estimates.length + emails.length + kbArticles.length;

    res.json({ contacts, deals, invoices, tickets, tasks, projects, contracts, estimates, emails, kbArticles, totalResults });
  } catch (err) {
    console.error("[Search] Error:", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

module.exports = router;
