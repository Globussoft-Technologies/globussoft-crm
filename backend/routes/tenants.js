const express = require("express");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/tenants/current — return current tenant info
router.get("/current", verifyToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });
    res.json(tenant);
  } catch (err) {
    console.error("[tenants] current error:", err);
    res.status(500).json({ error: "Failed to fetch tenant" });
  }
});

// PUT /api/tenants/current — update tenant settings (ADMIN only)
router.put("/current", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { name, plan, ownerEmail, isActive } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (plan !== undefined) data.plan = plan;
    if (ownerEmail !== undefined) data.ownerEmail = ownerEmail;
    if (isActive !== undefined) data.isActive = isActive;

    const tenant = await prisma.tenant.update({ where: { id: req.user.tenantId }, data });
    res.json(tenant);
  } catch (err) {
    console.error("[tenants] update error:", err);
    res.status(500).json({ error: "Failed to update tenant" });
  }
});

// GET /api/tenants/users — list users in current tenant
router.get("/users", verifyToken, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
    res.json(users);
  } catch (err) {
    console.error("[tenants] list users error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /api/tenants/users — invite user into current tenant (ADMIN only)
router.post("/users", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: "User with this email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashed,
        role: role || "USER",
        tenantId: req.user.tenantId,
      },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
    res.status(201).json(user);
  } catch (err) {
    console.error("[tenants] invite user error:", err);
    res.status(500).json({ error: "Failed to invite user" });
  }
});

module.exports = router;
