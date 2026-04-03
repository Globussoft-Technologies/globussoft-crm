const express = require("express");
const { PrismaClient } = require("@prisma/client");
const nodemailer = require("nodemailer");

const router = express.Router();
const prisma = new PrismaClient();

// In a real production setup, these would be loaded from process.env configured by each user
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: process.env.SMTP_PORT || 587,
  auth: {
    user: process.env.SMTP_USER || 'demo',
    pass: process.env.SMTP_PASS || 'demo123'
  }
});

// GET all communications (Unified Inbox)
router.get("/inbox", async (req, res) => {
  try {
    const emails = await prisma.emailMessage.findMany({
      include: { contact: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch inbox load" });
  }
});

// POST to send email via CRM
router.post("/send-email", async (req, res) => {
  try {
    const { to, subject, body, contactId } = req.body;
    
    // Abstracted sendMail mock for demo environments.
    // In production: await transporter.sendMail({ from: "CRM Admin <admin@crm.com>", to, subject, text: body });
    console.log(`[NodeMailer Mock] Sending email to ${to}: ${subject}`);

    const emailRecord = await prisma.emailMessage.create({
      data: {
        subject,
        body,
        from: "admin@globussoft.com",
        to,
        direction: "OUTBOUND",
        read: true,
        contactId: contactId ? parseInt(contactId) : null,
        userId: req.user ? req.user.userId : null
      }
    });

    if (req.io) req.io.emit('email_sent', emailRecord);
    res.status(200).json({ success: true, email: emailRecord });
  } catch (err) {
    res.status(500).json({ error: "Email dispatch failed" });
  }
});

// GET all call logs
router.get("/calls", async (req, res) => {
  try {
    const calls = await prisma.callLog.findMany({
      include: { contact: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch call history" });
  }
});

// POST to log a call
router.post("/log-call", async (req, res) => {
  try {
    const { duration, notes, contactId, direction, recordingUrl } = req.body;
    const callLog = await prisma.callLog.create({
      data: {
        duration: parseInt(duration),
        notes,
        direction: direction || "OUTBOUND",
        recordingUrl,
        contactId: contactId ? parseInt(contactId) : null,
        userId: req.user ? req.user.userId : null
      }
    });

    if (req.io) req.io.emit('call_logged', callLog);
    res.status(201).json(callLog);
  } catch (err) {
    res.status(500).json({ error: "Logging phone interaction failed" });
  }
});

module.exports = router;
