const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { verifyToken, verifyRole } = require("../middleware/auth");

const crypto = require("crypto");

const router = express.Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// In-memory store for password reset tokens (token -> { userId, expiresAt })
const resetTokens = new Map();

// Register Epic
router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name }
    });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    
  } catch (error) {
    res.status(500).json({ error: "Server registration error" });
  }
});

// Login Epic
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Auth bypass for testing without actual DB population during simulation
    if (email === "admin" && password === "admin") {
      const token = jwt.sign({ userId: 1, role: "ADMIN" }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, user: { id: 1, email: "admin@crm.com", name: "Super Admin", role: "ADMIN" } });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: "Login system failure" });
  }
});

// Admin User Management
router.get("/users", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const users = await prisma.user.findMany({ select: { id: true, email: true, name: true, role: true, createdAt: true } });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch directory" });
  }
});

router.put("/users/:id/role", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { role } = req.body;
    const user = await prisma.user.update({ where: { id: parseInt(req.params.id) }, data: { role } });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to update role" });
  }
});

router.delete("/users/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to obliterate user" });
  }
});

// Forgot Password — generate reset token
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const user = await prisma.user.findUnique({ where: { email } });

    // Always return success message to avoid email enumeration
    const response = { message: "If the email exists, a reset link has been generated" };

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      resetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 3600000 }); // 1 hour
      response.resetToken = token; // Returned since no email service configured
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: "Failed to process password reset request" });
  }
});

// Reset Password — consume token and set new password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required" });

    const entry = resetTokens.get(token);
    if (!entry) return res.status(400).json({ error: "Invalid or expired reset token" });
    if (Date.now() > entry.expiresAt) {
      resetTokens.delete(token);
      return res.status(400).json({ error: "Reset token has expired" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: entry.userId }, data: { password: hashedPassword } });
    resetTokens.delete(token);

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// Get current user profile
router.get("/me", verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, name: true, email: true, role: true, createdAt: true }
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Update current user profile
router.put("/me", verifyToken, async (req, res) => {
  try {
    const { name, email, currentPassword, newPassword } = req.body;
    const updateData = {};

    if (name) updateData.name = name;

    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== req.user.userId) {
        return res.status(400).json({ error: "Email already in use by another account" });
      }
      updateData.email = email;
    }

    // Password change requires current password verification
    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: "Current password is required to set a new password" });

      const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) return res.status(400).json({ error: "Current password is incorrect" });

      updateData.password = await bcrypt.hash(newPassword, 10);
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.userId },
      data: updateData,
      select: { id: true, name: true, email: true, role: true, createdAt: true }
    });

    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

module.exports = router;