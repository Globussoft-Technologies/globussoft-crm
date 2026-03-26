const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// Global Omnisearch Engine
router.get("/", verifyToken, async (req, res) => {
  try {
    const query = req.query.q || "";
    if (query.trim().length === 0) return res.json({ contacts: [], deals: [], invoices: [] });

    // Parallel federated querying across Postgres indices
    const [contacts, deals, invoices] = await Promise.all([
      prisma.contact.findMany({
        where: {
          OR: [
            { name: { contains: query } },
            { email: { contains: query } },
            { company: { contains: query } }
          ]
        },
        take: 5
      }),
      prisma.deal.findMany({
        where: { title: { contains: query } },
        take: 5
      }),
      prisma.invoice.findMany({
        where: { invoiceNum: { contains: query } },
        take: 5,
        include: { contact: true }
      })
    ]);

    res.json({ contacts, deals, invoices });
  } catch (err) {
    res.status(500).json({ error: "Omnisearch federated query failed" });
  }
});

module.exports = router;
