const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { findDuplicateContact, findDuplicateMarketplaceLead } = require("../utils/deduplication");

const router = express.Router();
const prisma = new PrismaClient();

// ── Authenticated routes ──────────────────────────────────────────

// List marketplace leads with filters (scoped to current tenant)
router.get("/", verifyToken, async (req, res) => {
  try {
    const { provider, status, from, to, page = 1, limit = 50 } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (provider) where.provider = provider;
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [leads, total] = await Promise.all([
      prisma.marketplaceLead.findMany({
        where,
        include: { contact: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: parseInt(limit),
      }),
      prisma.marketplaceLead.count({ where }),
    ]);

    res.json({ leads, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error("[MarketplaceLeads] List error:", err);
    res.status(500).json({ error: "Failed to fetch marketplace leads." });
  }
});

// Dashboard stats — scoped to tenant
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [byProvider, byStatus, total, thisWeek] = await Promise.all([
      prisma.marketplaceLead.groupBy({ by: ["provider"], where: { tenantId }, _count: true }),
      prisma.marketplaceLead.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
      prisma.marketplaceLead.count({ where: { tenantId } }),
      prisma.marketplaceLead.count({
        where: { tenantId, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    const imported = byStatus.find((s) => s.status === "Imported")?._count || 0;
    const conversionRate = total > 0 ? ((imported / total) * 100).toFixed(1) : 0;

    res.json({
      total,
      thisWeek,
      conversionRate: parseFloat(conversionRate),
      byProvider: byProvider.map((p) => ({ provider: p.provider, count: p._count })),
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
    });
  } catch (err) {
    console.error("[MarketplaceLeads] Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});

// Import a single marketplace lead into CRM contacts
router.post("/import/:id", verifyToken, async (req, res) => {
  try {
    const lead = await prisma.marketplaceLead.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!lead) return res.status(404).json({ error: "Lead not found." });
    if (lead.status === "Imported") return res.status(400).json({ error: "Lead already imported." });

    const existing = await findDuplicateContact(lead.email, lead.phone);
    if (existing && existing.tenantId === req.user.tenantId) {
      await prisma.marketplaceLead.update({
        where: { id: lead.id },
        data: { status: "Duplicate", contactId: existing.id },
      });
      return res.json({ imported: false, duplicate: true, contactId: existing.id, message: "Duplicate contact found — lead linked." });
    }

    const contactEmail = lead.email || `marketplace-${lead.provider}-${lead.id}@imported.local`;
    const contact = await prisma.contact.create({
      data: {
        name: lead.name || "Marketplace Lead",
        email: contactEmail,
        phone: lead.phone || null,
        company: lead.company || null,
        status: "Lead",
        source: lead.provider.charAt(0).toUpperCase() + lead.provider.slice(1),
        aiScore: 25,
        tenantId: req.user.tenantId,
      },
    });

    await prisma.deal.create({
      data: {
        title: `${lead.product || "Inquiry"} — ${lead.company || lead.name || "Unknown"}`,
        amount: 0,
        stage: "lead",
        contactId: contact.id,
        tenantId: req.user.tenantId,
      },
    });

    await prisma.marketplaceLead.update({
      where: { id: lead.id },
      data: { status: "Imported", contactId: contact.id },
    });

    await prisma.auditLog.create({
      data: {
        action: "CREATE",
        entity: "Contact",
        entityId: contact.id,
        details: JSON.stringify({ source: `Marketplace import (${lead.provider})`, leadId: lead.id }),
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });

    if (req.io) {
      req.io.emit("marketplace_lead_imported", { leadId: lead.id, contactId: contact.id });
      req.io.emit("deal_updated", {});
    }

    res.json({ imported: true, contactId: contact.id });
  } catch (err) {
    console.error("[MarketplaceLeads] Import error:", err);
    res.status(500).json({ error: "Failed to import lead." });
  }
});

// Bulk import selected leads
router.post("/import-bulk", verifyToken, async (req, res) => {
  try {
    const { leadIds } = req.body;
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: "No lead IDs provided." });
    }

    const results = { imported: 0, duplicates: 0, failed: 0 };

    for (const id of leadIds) {
      try {
        const lead = await prisma.marketplaceLead.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
        if (!lead || lead.status === "Imported") { results.failed++; continue; }

        const existing = await findDuplicateContact(lead.email, lead.phone);
        if (existing && existing.tenantId === req.user.tenantId) {
          await prisma.marketplaceLead.update({ where: { id: lead.id }, data: { status: "Duplicate", contactId: existing.id } });
          results.duplicates++;
          continue;
        }

        const contactEmail = lead.email || `marketplace-${lead.provider}-${lead.id}@imported.local`;
        const contact = await prisma.contact.create({
          data: {
            name: lead.name || "Marketplace Lead",
            email: contactEmail,
            phone: lead.phone || null,
            company: lead.company || null,
            status: "Lead",
            source: lead.provider.charAt(0).toUpperCase() + lead.provider.slice(1),
            aiScore: 25,
            tenantId: req.user.tenantId,
          },
        });

        await prisma.deal.create({
          data: {
            title: `${lead.product || "Inquiry"} — ${lead.company || lead.name || "Unknown"}`,
            amount: 0,
            stage: "lead",
            contactId: contact.id,
            tenantId: req.user.tenantId,
          },
        });

        await prisma.marketplaceLead.update({ where: { id: lead.id }, data: { status: "Imported", contactId: contact.id } });
        results.imported++;
      } catch (e) {
        console.error(`[MarketplaceLeads] Bulk import error for lead ${id}:`, e.message);
        results.failed++;
      }
    }

    if (req.io) req.io.emit("marketplace_lead_imported", { bulk: true, ...results });
    res.json(results);
  } catch (err) {
    console.error("[MarketplaceLeads] Bulk import error:", err);
    res.status(500).json({ error: "Bulk import failed." });
  }
});

// Dismiss a lead
router.put("/dismiss/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.marketplaceLead.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Lead not found" });
    const lead = await prisma.marketplaceLead.update({
      where: { id: existing.id },
      data: { status: "Dismissed" },
    });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: "Failed to dismiss lead." });
  }
});

// ── Configuration (ADMIN only) ────────────────────────────────────

router.get("/config", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const configs = await prisma.marketplaceConfig.findMany({ where: { tenantId: req.user.tenantId } });
    const masked = configs.map((c) => ({
      ...c,
      apiKey: c.apiKey ? "••••" + c.apiKey.slice(-4) : null,
      apiSecret: c.apiSecret ? "••••" + c.apiSecret.slice(-4) : null,
      glueCrmKey: c.glueCrmKey ? "••••" + c.glueCrmKey.slice(-4) : null,
    }));
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch config." });
  }
});

// Upsert config for a provider (per tenant)
router.put("/config/:provider", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { provider } = req.params;
    const { apiKey, apiSecret, glueCrmKey, isActive, settings } = req.body;

    const data = { isActive: isActive ?? false };
    if (apiKey && !apiKey.startsWith("••••")) data.apiKey = apiKey;
    if (apiSecret && !apiSecret.startsWith("••••")) data.apiSecret = apiSecret;
    if (glueCrmKey && !glueCrmKey.startsWith("••••")) data.glueCrmKey = glueCrmKey;
    if (settings !== undefined) data.settings = typeof settings === "string" ? settings : JSON.stringify(settings);

    const config = await prisma.marketplaceConfig.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      update: data,
      create: { provider, ...data, tenantId: req.user.tenantId },
    });

    res.json({ success: true, provider: config.provider, isActive: config.isActive });
  } catch (err) {
    console.error("[MarketplaceLeads] Config update error:", err);
    res.status(500).json({ error: "Failed to update config." });
  }
});

router.post("/sync/:provider", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { syncMarketplace } = require("../cron/marketplaceEngine");
    const result = await syncMarketplace(req.params.provider, req.io);
    res.json(result);
  } catch (err) {
    console.error("[MarketplaceLeads] Manual sync error:", err);
    res.status(500).json({ error: "Sync failed." });
  }
});

// ── Public webhook endpoints (no auth) ────────────────────────────
// Inbound webhooks default to Default Org tenant (id=1).
// In production, route by configured tenant credentials/provider key.

router.post("/webhook/indiamart", async (req, res) => {
  try {
    console.log("[IndiaMART Webhook] Received:", JSON.stringify(req.body).slice(0, 500));
    const leads = Array.isArray(req.body) ? req.body : req.body.RESPONSE || [req.body];

    let created = 0;
    for (const raw of leads) {
      const externalId = String(raw.UNIQUE_QUERY_ID || raw.QUERY_ID || raw.query_id || "");
      if (!externalId) continue;

      const existing = await findDuplicateMarketplaceLead("indiamart", externalId);
      if (existing) continue;

      await prisma.marketplaceLead.create({
        data: {
          provider: "indiamart",
          externalLeadId: externalId,
          rawPayload: JSON.stringify(raw),
          name: raw.SENDER_NAME || raw.sender_name || null,
          email: raw.SENDER_EMAIL || raw.sender_email || null,
          phone: raw.SENDER_MOBILE || raw.sender_mobile || raw.SENDER_PHONE || null,
          company: raw.SENDER_COMPANY || raw.sender_company || null,
          product: raw.QUERY_PRODUCT_NAME || raw.query_product_name || null,
          message: raw.QUERY_MESSAGE || raw.query_message || null,
          city: raw.SENDER_CITY || raw.sender_city || null,
          status: "New",
          tenantId: 1,
        },
      });
      created++;
    }

    if (created > 0 && req.io) {
      req.io.emit("marketplace_lead_new", { provider: "indiamart", count: created });
    }

    res.json({ success: true, created });
  } catch (err) {
    console.error("[IndiaMART Webhook] Error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

router.post("/webhook/justdial", async (req, res) => {
  try {
    console.log("[JustDial Webhook] Received:", JSON.stringify(req.body).slice(0, 500));
    const leads = Array.isArray(req.body) ? req.body : [req.body];

    let created = 0;
    for (const raw of leads) {
      const externalId = String(raw.leadid || raw.lead_id || raw.id || "");
      if (!externalId) continue;

      const existing = await findDuplicateMarketplaceLead("justdial", externalId);
      if (existing) continue;

      await prisma.marketplaceLead.create({
        data: {
          provider: "justdial",
          externalLeadId: externalId,
          rawPayload: JSON.stringify(raw),
          name: raw.name || raw.prefix + " " + raw.name || null,
          email: raw.email || null,
          phone: raw.phone || raw.mobile || null,
          company: raw.company || raw.companyname || null,
          product: raw.category || null,
          message: raw.description || raw.query || null,
          city: raw.city || raw.area || null,
          status: "New",
          tenantId: 1,
        },
      });
      created++;
    }

    if (created > 0 && req.io) {
      req.io.emit("marketplace_lead_new", { provider: "justdial", count: created });
    }

    res.json({ success: true, created });
  } catch (err) {
    console.error("[JustDial Webhook] Error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

router.post("/webhook/tradeindia", async (req, res) => {
  try {
    console.log("[TradeIndia Webhook] Received:", JSON.stringify(req.body).slice(0, 500));
    const leads = Array.isArray(req.body) ? req.body : [req.body];

    let created = 0;
    for (const raw of leads) {
      const externalId = String(raw.inquiry_id || raw.rfi_id || raw.id || "");
      if (!externalId) continue;

      const existing = await findDuplicateMarketplaceLead("tradeindia", externalId);
      if (existing) continue;

      await prisma.marketplaceLead.create({
        data: {
          provider: "tradeindia",
          externalLeadId: externalId,
          rawPayload: JSON.stringify(raw),
          name: raw.sender_name || raw.contact_person || null,
          email: raw.sender_email || raw.email_id || null,
          phone: raw.sender_mobile || raw.mobile_no || null,
          company: raw.sender_company || raw.company_name || null,
          product: raw.product_name || raw.subject || null,
          message: raw.message || raw.query_message || null,
          city: raw.sender_city || raw.city || null,
          status: "New",
          tenantId: 1,
        },
      });
      created++;
    }

    if (created > 0 && req.io) {
      req.io.emit("marketplace_lead_new", { provider: "tradeindia", count: created });
    }

    res.json({ success: true, created });
  } catch (err) {
    console.error("[TradeIndia Webhook] Error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

module.exports = router;
