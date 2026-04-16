const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

const VALID_ROLES = ["ADMIN", "MANAGER", "USER"];

// GET / — list users in current tenant (exclude password)
router.get("/", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch staff." });
  }
});

// PUT /:id/role — update user role (ADMIN only)
router.put("/:id/role", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
    }

    const userId = parseInt(req.params.id, 10);

    // Prevent self-demotion
    if (req.user.userId === userId && role !== "ADMIN") {
      return res.status(400).json({ error: "Cannot change your own role." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    const user = await prisma.user.update({
      where: { id: target.id },
      data: { role },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });
    res.json(user);
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    res.status(500).json({ error: "Failed to update role." });
  }
});

// DELETE /:id — delete user (ADMIN only)
router.delete("/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);

    // Prevent self-deletion
    if (req.user.userId === userId) {
      return res.status(400).json({ error: "Cannot delete your own account." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    await prisma.user.delete({
      where: { id: target.id },
    });
    res.json({ message: "User deleted." });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    res.status(500).json({ error: "Failed to delete user." });
  }
});

module.exports = router;
