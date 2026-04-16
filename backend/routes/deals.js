const express = require("express");
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");

const router = express.Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    if (user.tenantId === undefined || user.tenantId === null) user.tenantId = 1;
    req.user = user;
    next();
  });
};

router.use(authenticateToken); // Protect all deal routes

// GET all deals with relational parsing
router.get("/", async (req, res) => {
  try {
    const deals = await prisma.deal.findMany({
      where: { tenantId: req.user.tenantId },
      include: { contact: true, owner: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(deals);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch deals timeline" });
  }
});

// POST new deal + Emit Socket event
router.post("/", async (req, res) => {
  try {
    const { title, amount, probability, stage } = req.body;
    const deal = await prisma.deal.create({
      data: {
        title,
        amount: parseFloat(amount) || 0,
        probability: parseInt(probability) || 50,
        stage: stage || 'lead',
        ownerId: req.user.userId,
        tenantId: req.user.tenantId,
      }
    });

    // Broadcast real-time update to all connected clients
    if(req.io) req.io.emit("deal_updated", deal);

    res.status(201).json(deal);
  } catch (error) {
    res.status(500).json({ error: "Pipeline injection failed" });
  }
});

// PUT update stage
router.put("/:id/stage", async (req, res) => {
  try {
    const { id } = req.params;
    const { stage } = req.body;
    const existing = await prisma.deal.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Deal not found" });
    const deal = await prisma.deal.update({
      where: { id: existing.id },
      data: { stage }
    });
    if(req.io) req.io.emit("deal_updated", deal);
    res.json(deal);
  } catch (error) {
    res.status(500).json({ error: "Stage transition error" });
  }
});
// DELETE deal
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.deal.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Deal not found" });
    await prisma.deal.delete({ where: { id: existing.id } });
    if(req.io) req.io.emit("deal_deleted", parseInt(id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete deal" });
  }
});

module.exports = router;
