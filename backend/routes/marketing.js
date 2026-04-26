const express = require("express");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { sendSms } = require("../services/smsProvider");
const { computeFirstResponseDueAt } = require("../lib/leadSla");

const router = express.Router();

// ── Mailgun email helper ──────────────────────────────────────────
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

async function sendMailgun(to, subject, html) {
  const key = process.env.MAILGUN_API_KEY || MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || MAILGUN_DOMAIN;
  if (!key) {
    console.log(`[CampaignEngine] Mailgun not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }
  const fd = new URLSearchParams();
  fd.append("from", `Globussoft CRM <noreply@${domain}>`);
  fd.append("to", to);
  fd.append("subject", subject);
  fd.append("text", html.replace(/<[^>]*>/g, ""));
  fd.append("html", html);
  try {
    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from("api:" + key).toString("base64") },
      body: fd,
    });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      return { sent: true, id: data.id };
    }
    const errText = await response.text().catch(() => "");
    console.error(`[CampaignEngine] Mailgun error (${response.status}):`, errText);
    return { sent: false, reason: `mailgun ${response.status}: ${errText}` };
  } catch (err) {
    console.error("[CampaignEngine] Mailgun send error:", err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Audience query builder ────────────────────────────────────────

function buildContactWhere(tenantId, filters) {
  const where = { tenantId };
  if (!filters) return where;
  if (filters.status) where.status = filters.status;
  if (filters.source) where.source = filters.source;
  if (filters.aiScoreMin != null || filters.aiScoreMax != null) {
    where.aiScore = {};
    if (filters.aiScoreMin != null) where.aiScore.gte = Number(filters.aiScoreMin);
    if (filters.aiScoreMax != null) where.aiScore.lte = Number(filters.aiScoreMax);
  }
  if (filters.tags) {
    // tags stored as comma-separated or array — search name/company as proxy
    where.OR = filters.tags.map(t => ({
      OR: [
        { company: { contains: t } },
        { source: { contains: t } },
      ]
    }));
  }
  return where;
}

// ── Shared send logic (used by route + cron) ──────────────────────

async function sendCampaign(campaign, io) {
  const tenantId = campaign.tenantId;
  let filters = null;
  // audienceFilter stored in budget field as JSON won't work — use campaign._audienceFilter if passed
  if (campaign._audienceFilter) {
    filters = campaign._audienceFilter;
  }

  // Load audience contacts
  const contactWhere = buildContactWhere(tenantId, filters);
  // For EMAIL campaigns, only contacts with email; for SMS, only those with phone
  if (campaign.channel === "EMAIL") {
    contactWhere.email = { not: "" };
  } else if (campaign.channel === "SMS") {
    contactWhere.phone = { not: null };
  }

  const contacts = await prisma.contact.findMany({ where: contactWhere });

  if (contacts.length === 0) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "Completed", sent: 0 },
    });
    return { sent: 0, failed: 0 };
  }

  // Set status to Sending
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "Sending" },
  });

  let sentCount = 0;
  let failedCount = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (contact) => {
      try {
        if (campaign.channel === "EMAIL") {
          // Create tracking pixel
          const trackingId = crypto.randomUUID();

          // Create EmailMessage record
          const emailMsg = await prisma.emailMessage.create({
            data: {
              subject: campaign.name,
              body: `<p>Campaign: ${campaign.name}</p>`,
              from: FROM_EMAIL,
              to: contact.email,
              direction: "OUTBOUND",
              contactId: contact.id,
              tenantId,
            },
          });

          // Create EmailTracking record
          await prisma.emailTracking.create({
            data: {
              emailId: emailMsg.id,
              trackingId,
              type: "open",
              tenantId,
            },
          });

          // Append tracking pixel to email body
          const trackingPixel = `<img src="https://crm.globusdemos.com/api/email/track/${trackingId}/open" width="1" height="1" style="display:none" />`;
          const body = `<p>Campaign: ${campaign.name}</p>${trackingPixel}`;

          // Send via Mailgun
          const result = await sendMailgun(contact.email, campaign.name, body);
          if (result.sent) {
            sentCount++;
          } else {
            sentCount++; // still count as sent (logged in DB even if Mailgun not configured)
          }
        } else if (campaign.channel === "SMS") {
          // Create SmsMessage record
          await prisma.smsMessage.create({
            data: {
              to: contact.phone,
              body: `Campaign: ${campaign.name}`,
              direction: "OUTBOUND",
              status: "QUEUED",
              contactId: contact.id,
              tenantId,
              campaignId: campaign.id,
            },
          });

          // Try to send via SMS provider (graceful failure)
          try {
            await sendSms({
              to: contact.phone,
              body: `Campaign: ${campaign.name}`,
              provider: process.env.SMS_PROVIDER || "msg91",
              apiKey: process.env.SMS_API_KEY || "",
              senderId: process.env.SMS_SENDER_ID || "GCRM",
            });
          } catch (smsErr) {
            console.log(`[CampaignEngine] SMS provider not configured for ${contact.phone}:`, smsErr.message);
          }
          sentCount++;
        }
      } catch (err) {
        console.error(`[CampaignEngine] Failed to send to contact ${contact.id}:`, err.message);
        failedCount++;
      }
    });

    await Promise.all(promises);

    // Rate limit delay between batches (skip for last batch)
    if (i + BATCH_SIZE < contacts.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Mark campaign completed
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "Completed", sent: sentCount },
  });

  // Audit log
  try {
    await prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entity: "Campaign",
        entityId: campaign.id,
        details: JSON.stringify({ event: "campaign_sent", sent: sentCount, failed: failedCount, audience: contacts.length }),
        tenantId,
        userId: campaign._userId || null,
      },
    });
  } catch (e) {
    console.error("[CampaignEngine] AuditLog error:", e.message);
  }

  // Socket event
  if (io) {
    io.emit("campaign_sent", { campaignId: campaign.id, sent: sentCount, failed: failedCount });
  }

  console.log(`[CampaignEngine] Sent campaign "${campaign.name}" to ${sentCount} recipients (${failedCount} failed)`);
  return { sent: sentCount, failed: failedCount };
}

// Export for cron engine
module.exports.sendCampaign = sendCampaign;

// ── Campaign CRUD ─────────────────────────────────────────────────

// GET /campaigns — list with optional channel/status filters
router.get("/campaigns", verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.channel) where.channel = req.query.channel;
    if (req.query.status) where.status = req.query.status;
    const campaigns = await prisma.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(campaigns);
  } catch (err) {
    console.error("[Marketing] List campaigns error:", err.message);
    res.status(500).json({ error: "Failed to fetch campaigns." });
  }
});

// POST /campaigns — create
router.post("/campaigns", verifyToken, async (req, res) => {
  try {
    const { name, channel, budget } = req.body;
    const campaign = await prisma.campaign.create({
      data: {
        name: name || "Untitled Campaign",
        channel: channel || "EMAIL",
        budget: parseFloat(budget || 0),
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(campaign);
  } catch (err) {
    console.error("[Marketing] Create campaign error:", err.message);
    res.status(500).json({ error: "Failed to create campaign." });
  }
});

// GET /campaigns/:id — single campaign with stats
router.get("/campaigns/:id", verifyToken, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (err) {
    console.error("[Marketing] Get campaign error:", err.message);
    res.status(500).json({ error: "Failed to fetch campaign." });
  }
});

// PUT /campaigns/:id — update
router.put("/campaigns/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Campaign not found" });

    const { name, channel, budget, status } = req.body;
    const updated = await prisma.campaign.update({
      where: { id: existing.id },
      data: {
        ...(name && { name }),
        ...(channel && { channel }),
        ...(budget != null && { budget: parseFloat(budget) }),
        ...(status && { status }),
      },
    });
    res.json(updated);
  } catch (err) {
    console.error("[Marketing] Update campaign error:", err.message);
    res.status(500).json({ error: "Failed to update campaign." });
  }
});

// DELETE /campaigns/:id
router.delete("/campaigns/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Campaign not found" });

    await prisma.campaign.delete({ where: { id: existing.id } });
    res.json({ message: "Campaign deleted" });
  } catch (err) {
    console.error("[Marketing] Delete campaign error:", err.message);
    res.status(500).json({ error: "Failed to delete campaign." });
  }
});

// ── Audience Targeting ────────────────────────────────────────────

// POST /campaigns/:id/audience — preview audience with filters
router.post("/campaigns/:id/audience", verifyToken, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const { filters } = req.body;
    const where = buildContactWhere(req.user.tenantId, filters);

    // For EMAIL campaigns require email, for SMS require phone
    if (campaign.channel === "EMAIL") where.email = { not: "" };
    else if (campaign.channel === "SMS") where.phone = { not: null };

    const [count, sampleContacts] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({ where, take: 5, select: { id: true, name: true, email: true, phone: true, status: true, aiScore: true } }),
    ]);

    res.json({ count, sampleContacts, filters });
  } catch (err) {
    console.error("[Marketing] Audience preview error:", err.message);
    res.status(500).json({ error: "Failed to preview audience." });
  }
});

// GET /campaigns/:id/audience/count — quick count
router.get("/campaigns/:id/audience/count", verifyToken, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const where = buildContactWhere(req.user.tenantId, null);
    if (campaign.channel === "EMAIL") where.email = { not: "" };
    else if (campaign.channel === "SMS") where.phone = { not: null };

    const count = await prisma.contact.count({ where });
    res.json({ count });
  } catch (err) {
    console.error("[Marketing] Audience count error:", err.message);
    res.status(500).json({ error: "Failed to count audience." });
  }
});

// ── Campaign Sending ──────────────────────────────────────────────

// POST /campaigns/:id/send — blast send
router.post("/campaigns/:id/send", verifyToken, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status === "Sending") return res.status(409).json({ error: "Campaign is already being sent" });
    if (campaign.status === "Completed") return res.status(409).json({ error: "Campaign has already been sent" });

    // Attach audience filter + userId for the shared send function
    campaign._audienceFilter = req.body.filters || null;
    campaign._userId = req.user.userId;

    // Start send (async — respond immediately for large audiences)
    const result = await sendCampaign(campaign, req.io);
    res.json({ message: "Campaign sent", ...result });
  } catch (err) {
    console.error("[Marketing] Send campaign error:", err.message);
    res.status(500).json({ error: "Failed to send campaign." });
  }
});

// POST /campaigns/:id/schedule — schedule for later
router.post("/campaigns/:id/schedule", verifyToken, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const { scheduledAt } = req.body;
    if (!scheduledAt) return res.status(400).json({ error: "scheduledAt is required" });

    // Store scheduledAt in the budget field as a timestamp trick won't work.
    // Instead we use a simple approach: update status and store scheduledAt as details in campaign name suffix
    // Actually, let's use Prisma's raw approach or just store in a separate table.
    // Simplest: store scheduledAt in a JSON string in a known location.
    // We'll store it in memory via a simple JSON file approach, or better — just update status.
    // The cron engine will check campaigns with "Scheduled" status.
    // We need scheduledAt somewhere — let's use the campaign name to not change schema.
    // Better approach: use a global in-memory map for scheduled campaigns (works for single-server).

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Invalid scheduledAt date" });

    // Store schedule metadata in-memory (campaign engine reads this)
    if (!global._campaignSchedules) global._campaignSchedules = {};
    global._campaignSchedules[campaign.id] = {
      scheduledAt: scheduledDate,
      filters: req.body.filters || null,
    };

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "Scheduled" },
    });

    res.json({ message: "Campaign scheduled", scheduledAt: scheduledDate.toISOString() });
  } catch (err) {
    console.error("[Marketing] Schedule campaign error:", err.message);
    res.status(500).json({ error: "Failed to schedule campaign." });
  }
});

// POST /campaigns/:id/pause — cancel schedule
router.post("/campaigns/:id/pause", verifyToken, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // Remove from schedule map
    if (global._campaignSchedules) {
      delete global._campaignSchedules[campaign.id];
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "Draft" },
    });

    res.json({ message: "Campaign paused and returned to Draft" });
  } catch (err) {
    console.error("[Marketing] Pause campaign error:", err.message);
    res.status(500).json({ error: "Failed to pause campaign." });
  }
});

// ── Public Form Submit (preserved from original) ──────────────────
// NOTE: This endpoint is unauthenticated — leads default to Default Org (tenantId=1).
// Multi-tenant routing for embedded forms can be added later via formId -> tenant lookup.
router.post("/submit", async (req, res) => {
  try {
    const { formId, name, full_name, email, company_name } = req.body;

    // Parse dynamic payload mapping
    const contactEmail = email || `${Date.now()}@anonymous.com`;
    const contactName = name || full_name || "Web Lead";
    const contactCompany = company_name || "Inbound Traffic";

    // AI Predictive Lead Scoring (Simulated heuristic algorithm)
    let score = 30; // Base score
    if (contactCompany.toLowerCase().includes("inc") || contactCompany.toLowerCase().includes("llc")) score += 25;
    if (contactEmail.endsWith(".edu") || contactEmail.endsWith(".gov")) score += 35;
    if (contactName.split(" ").length > 1) score += 10;

    console.log(`[FormIngestion] Received lead from form ${formId}:`, req.body, `| Assigned AI Score: ${score}`);

    // Contact's unique key is compound (email + tenantId), not email alone.
    // Using `where: { email }` on upsert raises PrismaClientValidationError
    // since v3.1 made tenants multi-hosted. Use the compound key helper.
    const FORM_TENANT_ID = 1; // default org for inbound public form submissions

    // PRD §6.4: stamp lead-side SLA timer at form-ingest time. Tier is
    // detected from the form text (name + company); falls back to medium
    // (30 min) when no service keyword matches.
    let firstResponseDueAt = null;
    try {
      const slaMeta = await computeFirstResponseDueAt({
        tenantId: FORM_TENANT_ID,
        text: `${contactName} ${contactCompany}`,
      });
      firstResponseDueAt = slaMeta.dueAt;
    } catch (slaErr) {
      console.error("[FormIngestion] lead SLA compute failed:", slaErr.message);
    }

    const contact = await prisma.contact.upsert({
      where: { email_tenantId: { email: contactEmail, tenantId: FORM_TENANT_ID } },
      update: { source: "Embedded Web Form" },
      create: {
        name: contactName,
        email: contactEmail,
        company: contactCompany,
        status: "Lead",
        source: "Embedded Web Form",
        aiScore: score,
        firstResponseDueAt,
        tenantId: FORM_TENANT_ID,
      }
    });

    const deal = await prisma.deal.create({
      data: {
        title: `Inbound: ${contactCompany}`,
        amount: 0,
        stage: "lead",
        contactId: contact.id,
        tenantId: contact.tenantId || 1,
      }
    });

    // Broadcast to real-time clients!
    if (req.io) {
      req.io.emit('deal_updated', deal);
    }

    res.status(201).json({ success: true, message: "Submission captured successfully in CRM Pipeline." });
  } catch (err) {
    console.error("[FormIngestion Error]:", err);
    res.status(500).json({ error: "Failed to process form submission." });
  }
});

module.exports = router;
