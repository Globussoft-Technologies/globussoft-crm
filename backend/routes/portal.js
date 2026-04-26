const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const PORTAL_TOKEN_TTL = "7d";

// In-memory reset token store: token -> { contactId, expiresAt }
const resetTokens = new Map();

// ─── Inline portal JWT middleware ───────────────────────────────────────────
const verifyPortalToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Portal token required" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== "PORTAL") {
      return res.status(401).json({ error: "Invalid portal token" });
    }
    req.portal = decoded;
    next();
  } catch (err) {
    if (err && err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Portal session expired" });
    }
    res.status(401).json({ error: "Invalid portal token" });
  }
};

// ─── PUBLIC ENDPOINTS ───────────────────────────────────────────────────────

// POST /api/portal/login — { email, password }
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    // Contact.email is not @unique in schema (multi-tenant — same email can
    // belong to contacts in different tenants). findUnique throws a Prisma
    // validation error, caught by the catch block as a 500. findFirst returns
    // the first match by id (deterministic) and 401s when there's no portal
    // user with this email.
    const contact = await prisma.contact.findFirst({ where: { email } });
    if (!contact || !contact.portalPasswordHash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, contact.portalPasswordHash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { contactId: contact.id, tenantId: contact.tenantId, type: "PORTAL" },
      JWT_SECRET,
      { expiresIn: PORTAL_TOKEN_TTL }
    );

    res.json({
      token,
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        company: contact.company,
      },
    });
  } catch (err) {
    console.error("[Portal][login]", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/portal/set-password — { email, currentPassword?, newPassword }
router.post("/set-password", async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ error: "email and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // findFirst not findUnique — Contact.email isn't unique in schema.
    const contact = await prisma.contact.findFirst({ where: { email } });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    if (contact.portalPasswordHash) {
      // Existing password — require current
      if (!currentPassword) {
        return res.status(400).json({ error: "currentPassword is required to change existing password" });
      }
      const valid = await bcrypt.compare(currentPassword, contact.portalPasswordHash);
      if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.contact.update({
      where: { id: contact.id },
      data: { portalPasswordHash: hash },
    });
    res.json({ message: "Password set successfully" });
  } catch (err) {
    console.error("[Portal][set-password]", err);
    res.status(500).json({ error: "Failed to set password" });
  }
});

// POST /api/portal/forgot — { email }
router.post("/forgot", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });

    // findFirst not findUnique — Contact.email isn't unique in schema.
    const contact = await prisma.contact.findFirst({ where: { email } });
    // Always return success to prevent enumeration
    if (contact) {
      const token = crypto.randomBytes(32).toString("hex");
      resetTokens.set(token, {
        contactId: contact.id,
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
      });
      // In production this would email the link to the contact
      console.log(`[Portal][forgot] Reset token for ${email}: ${token}`);
    }
    res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    console.error("[Portal][forgot]", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// POST /api/portal/reset — { token, newPassword }
router.post("/reset", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: "token and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const entry = resetTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      resetTokens.delete(token);
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.contact.update({
      where: { id: entry.contactId },
      data: { portalPasswordHash: hash },
    });
    resetTokens.delete(token);

    res.json({ message: "Password reset successfully" });
  } catch (err) {
    console.error("[Portal][reset]", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ─── AUTHENTICATED PORTAL ENDPOINTS ─────────────────────────────────────────

// GET /api/portal/me
router.get("/me", verifyPortalToken, async (req, res) => {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: req.portal.contactId },
      select: {
        id: true, name: true, email: true, phone: true, company: true,
        title: true, status: true, tenantId: true, createdAt: true,
      },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json(contact);
  } catch (err) {
    console.error("[Portal][me]", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// GET /api/portal/tickets
router.get("/tickets", verifyPortalToken, async (req, res) => {
  try {
    // Ticket model doesn't have contactId — return tickets in the contact's tenant
    const tickets = await prisma.ticket.findMany({
      where: { tenantId: req.portal.tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(tickets);
  } catch (err) {
    console.error("[Portal][tickets]", err);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// POST /api/portal/tickets — create on behalf of the logged-in contact
router.post("/tickets", verifyPortalToken, async (req, res) => {
  try {
    const { subject, description, priority } = req.body;
    if (!subject) return res.status(400).json({ error: "subject is required" });
    const ticket = await prisma.ticket.create({
      data: {
        subject,
        description: description || null,
        priority: priority || "Low",
        status: "Open",
        tenantId: req.portal.tenantId,
      },
    });
    res.status(201).json(ticket);
  } catch (err) {
    console.error("[Portal][create ticket]", err);
    res.status(500).json({ error: "Failed to create ticket" });
  }
});

// GET /api/portal/invoices
router.get("/invoices", verifyPortalToken, async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
      orderBy: { issuedDate: "desc" },
    });
    res.json(invoices);
  } catch (err) {
    console.error("[Portal][invoices]", err);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
});

// GET /api/portal/contracts
router.get("/contracts", verifyPortalToken, async (req, res) => {
  try {
    const contracts = await prisma.contract.findMany({
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(contracts);
  } catch (err) {
    console.error("[Portal][contracts]", err);
    res.status(500).json({ error: "Failed to fetch contracts" });
  }
});

module.exports = router;
