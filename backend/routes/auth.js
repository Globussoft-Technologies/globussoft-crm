const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

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

// Middleware Endpoint mapping export
module.exports = router;