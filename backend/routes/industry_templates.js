const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
// Built-in Industry Templates (used when DB is empty)
// ─────────────────────────────────────────────────────────────────
const BUILT_IN_TEMPLATES = [
  {
    id: "builtin-real-estate",
    industry: "real-estate",
    name: "Real Estate CRM",
    description:
      "Pre-built pipelines and custom objects for real estate brokerages — manage buyers, sellers, listings, and showings end-to-end.",
    config: {
      pipelines: [
        {
          name: "Buyer Pipeline",
          stages: ["Inquiry", "Showing", "Offer", "Closing", "Closed"],
        },
        {
          name: "Seller Pipeline",
          stages: [
            "Listing",
            "Marketing",
            "Offer Received",
            "Under Contract",
            "Sold",
          ],
        },
      ],
      customFields: [
        {
          entity: "Property",
          description: "Real estate property listings",
          fields: [
            { name: "address", type: "Text" },
            { name: "price", type: "Number" },
            { name: "bedrooms", type: "Number" },
            { name: "bathrooms", type: "Number" },
            { name: "sqft", type: "Number" },
            { name: "status", type: "Text" }, // Active/Sold/Pending
          ],
        },
      ],
      sampleStages: [
        "Inquiry",
        "Showing",
        "Offer",
        "Closing",
        "Closed",
        "Listing",
        "Marketing",
        "Offer Received",
        "Under Contract",
        "Sold",
      ],
      sampleContacts: [
        { name: "Aarav Sharma", email: "aarav.buyer@example.com", phone: "+919812340001", company: "Sharma Family", title: "Buyer", status: "Lead" },
        { name: "Priya Verma", email: "priya.buyer@example.com", phone: "+919812340002", company: "Verma Family", title: "Buyer", status: "Lead" },
        { name: "Rohit Mehta", email: "rohit.buyer@example.com", phone: "+919812340003", company: "Mehta Family", title: "Buyer", status: "Lead" },
        { name: "Sunita Iyer", email: "sunita.seller@example.com", phone: "+919812340004", company: "Iyer Estates", title: "Seller", status: "Prospect" },
        { name: "Vikram Patel", email: "vikram.seller@example.com", phone: "+919812340005", company: "Patel Holdings", title: "Seller", status: "Prospect" },
      ],
    },
  },
  {
    id: "builtin-healthcare",
    industry: "healthcare",
    name: "Healthcare CRM",
    description:
      "Built for clinics and hospitals — manage patient acquisition, consultations, and treatment plans with HIPAA-aware workflows.",
    config: {
      pipelines: [
        {
          name: "Patient Acquisition",
          stages: [
            "Inquiry",
            "Consultation",
            "Treatment Plan",
            "Active Treatment",
            "Completed",
          ],
        },
      ],
      customFields: [
        {
          entity: "Appointment",
          description: "Scheduled patient appointments",
          fields: [
            { name: "patientId", type: "Text" },
            { name: "date", type: "Date" },
            { name: "doctor", type: "Text" },
            { name: "type", type: "Text" },
            { name: "status", type: "Text" },
          ],
        },
      ],
      sampleStages: [
        "Inquiry",
        "Consultation",
        "Treatment Plan",
        "Active Treatment",
        "Completed",
      ],
      sampleContacts: [
        { name: "Anjali Rao", email: "anjali.patient@example.com", phone: "+919812350001", company: "Self", title: "Patient", status: "Lead" },
        { name: "Karan Singh", email: "karan.patient@example.com", phone: "+919812350002", company: "Self", title: "Patient", status: "Lead" },
      ],
    },
  },
  {
    id: "builtin-education",
    industry: "education",
    name: "Education CRM",
    description:
      "Designed for schools, colleges, and training institutes — manage student inquiries, applications, interviews, and enrollment.",
    config: {
      pipelines: [
        {
          name: "Student Enrollment",
          stages: ["Lead", "Application", "Interview", "Accepted", "Enrolled"],
        },
      ],
      customFields: [
        {
          entity: "Course",
          description: "Course catalog and enrollment tracking",
          fields: [
            { name: "name", type: "Text" },
            { name: "instructor", type: "Text" },
            { name: "startDate", type: "Date" },
            { name: "capacity", type: "Number" },
            { name: "enrolled", type: "Number" },
          ],
        },
      ],
      sampleStages: ["Lead", "Application", "Interview", "Accepted", "Enrolled"],
      sampleContacts: [
        { name: "Neha Gupta", email: "neha.student@example.com", phone: "+919812360001", company: "Self", title: "Applicant", status: "Lead" },
        { name: "Arjun Desai", email: "arjun.student@example.com", phone: "+919812360002", company: "Self", title: "Applicant", status: "Lead" },
      ],
    },
  },
  {
    id: "builtin-legal",
    industry: "legal",
    name: "Law Firm CRM",
    description:
      "Tailored for law firms — track client intake, engagements, active matters, billable hours, and case resolution.",
    config: {
      pipelines: [
        {
          name: "Client Intake",
          stages: [
            "Consultation",
            "Engagement",
            "Active Matter",
            "Resolution",
            "Closed",
          ],
        },
      ],
      customFields: [
        {
          entity: "Matter",
          description: "Legal matters and case tracking",
          fields: [
            { name: "matterNumber", type: "Text" },
            { name: "type", type: "Text" },
            { name: "openDate", type: "Date" },
            { name: "status", type: "Text" },
            { name: "billable", type: "Boolean" },
          ],
        },
      ],
      sampleStages: [
        "Consultation",
        "Engagement",
        "Active Matter",
        "Resolution",
        "Closed",
      ],
      sampleContacts: [
        { name: "Rajesh Kumar", email: "rajesh.client@example.com", phone: "+919812370001", company: "Kumar Industries", title: "Client", status: "Prospect" },
        { name: "Meera Joshi", email: "meera.client@example.com", phone: "+919812370002", company: "Joshi & Co", title: "Client", status: "Prospect" },
      ],
    },
  },
  {
    id: "builtin-saas",
    industry: "saas",
    name: "SaaS CRM",
    description:
      "Default-style template for B2B SaaS — manage new business pipelines, demos, trials, MRR, and renewals.",
    config: {
      pipelines: [
        {
          name: "New Business",
          stages: ["Lead", "Demo", "Trial", "Negotiation", "Won/Lost"],
        },
      ],
      customFields: [
        {
          entity: "Subscription",
          description: "Customer subscriptions and renewal tracking",
          fields: [
            { name: "plan", type: "Text" },
            { name: "mrr", type: "Number" },
            { name: "renewalDate", type: "Date" },
            { name: "churnRisk", type: "Text" },
          ],
        },
      ],
      sampleStages: ["Lead", "Demo", "Trial", "Negotiation", "Won/Lost"],
      sampleContacts: [
        { name: "Sanjay Bhat", email: "sanjay.saas@example.com", phone: "+919812380001", company: "Bhat Tech", title: "CTO", status: "Lead" },
        { name: "Pooja Nair", email: "pooja.saas@example.com", phone: "+919812380002", company: "Nair Cloud Labs", title: "Product Lead", status: "Prospect" },
      ],
    },
  },
];

const STAGE_COLORS = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#06b6d4", // cyan
];

// ─────────────────────────────────────────────────────────────────
// GET / — list all templates (DB + built-ins fallback)
// ─────────────────────────────────────────────────────────────────
router.get("/", verifyToken, async (req, res) => {
  try {
    const dbTemplates = await prisma.industryTemplate.findMany({
      orderBy: { createdAt: "asc" },
    });

    if (!dbTemplates || dbTemplates.length === 0) {
      return res.json(BUILT_IN_TEMPLATES);
    }

    // Merge DB + built-ins (DB overrides by industry key)
    const dbIndustries = new Set(dbTemplates.map((t) => t.industry));
    const merged = [
      ...dbTemplates.map((t) => ({
        id: t.id,
        industry: t.industry,
        name: t.name,
        description: t.description,
        config: safeParse(t.config),
      })),
      ...BUILT_IN_TEMPLATES.filter((t) => !dbIndustries.has(t.industry)),
    ];
    res.json(merged);
  } catch (err) {
    console.error("[industry_templates] GET / failed:", err);
    res.status(500).json({ error: "Failed to load industry templates" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /apply/:industry — apply template to current tenant
// ─────────────────────────────────────────────────────────────────
router.post("/apply/:industry", verifyToken, async (req, res) => {
  const { industry } = req.params;
  const tenantId = req.user.tenantId || 1;
  const userId = req.user.id || req.user.userId || null;

  try {
    // Resolve template (DB first, then built-in)
    let template = await prisma.industryTemplate.findUnique({
      where: { industry },
    });
    let config;
    let templateName;
    let templateDescription;

    if (template) {
      config = safeParse(template.config);
      templateName = template.name;
      templateDescription = template.description;
    } else {
      const builtIn = BUILT_IN_TEMPLATES.find((t) => t.industry === industry);
      if (!builtIn) {
        return res.status(404).json({ error: `Unknown industry template: ${industry}` });
      }
      config = builtIn.config;
      templateName = builtIn.name;
      templateDescription = builtIn.description;
    }

    const created = {
      pipelines: 0,
      stages: 0,
      customEntities: 0,
      contacts: 0,
    };

    // ── Create Pipelines ────────────────────────────────────────
    const pipelinesToCreate = config.pipelines || [];
    for (const p of pipelinesToCreate) {
      const existing = await prisma.pipeline.findFirst({
        where: { tenantId, name: p.name },
      });
      if (existing) continue;
      await prisma.pipeline.create({
        data: {
          name: p.name,
          description: `${templateName} — ${p.name}`,
          tenantId,
          isDefault: false,
        },
      });
      created.pipelines += 1;
    }

    // ── Create Pipeline Stages (flat per-tenant; dedupe by name) ─
    const allStages = new Set();
    for (const p of pipelinesToCreate) {
      (p.stages || []).forEach((s) => allStages.add(s));
    }
    let position = 0;
    for (const stageName of allStages) {
      const existingStage = await prisma.pipelineStage.findFirst({
        where: { tenantId, name: stageName },
      });
      if (existingStage) {
        position += 1;
        continue;
      }
      await prisma.pipelineStage.create({
        data: {
          name: stageName,
          color: STAGE_COLORS[position % STAGE_COLORS.length],
          position,
          tenantId,
        },
      });
      created.stages += 1;
      position += 1;
    }

    // ── Create Custom Entities + Fields ─────────────────────────
    for (const ce of config.customFields || []) {
      const existing = await prisma.customEntity.findFirst({
        where: { tenantId, name: ce.entity },
      });
      if (existing) continue;
      await prisma.customEntity.create({
        data: {
          name: ce.entity,
          description: ce.description || `${templateName} — ${ce.entity}`,
          tenantId,
          fields: {
            create: (ce.fields || []).map((f) => ({
              name: f.name,
              type: f.type || "Text",
            })),
          },
        },
      });
      created.customEntities += 1;
    }

    // ── Create Sample Contacts (best-effort, skip duplicates) ───
    for (const c of config.sampleContacts || []) {
      try {
        const existing = await prisma.contact.findUnique({
          where: { email: c.email },
        });
        if (existing) continue;
        await prisma.contact.create({
          data: {
            name: c.name,
            email: c.email,
            phone: c.phone || null,
            company: c.company || null,
            title: c.title || null,
            status: c.status || "Lead",
            source: `Industry Template: ${industry}`,
            industry,
            tenantId,
          },
        });
        created.contacts += 1;
      } catch (e) {
        // ignore unique-constraint collisions
      }
    }

    // ── Audit Log ───────────────────────────────────────────────
    try {
      await prisma.auditLog.create({
        data: {
          action: "APPLY",
          entity: "IndustryTemplate",
          entityId: template ? template.id : null,
          details: JSON.stringify({
            industry,
            name: templateName,
            created,
          }),
          tenantId,
          userId: userId || null,
        },
      });
    } catch (e) {
      console.warn("[industry_templates] audit log failed:", e.message);
    }

    res.json({
      applied: true,
      industry,
      template: { name: templateName, description: templateDescription },
      created,
    });
  } catch (err) {
    console.error("[industry_templates] apply failed:", err);
    res.status(500).json({ error: "Failed to apply industry template", detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST / — admin: create custom industry template (rare)
// ─────────────────────────────────────────────────────────────────
router.post("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { industry, name, description, config } = req.body;
    if (!industry || !name || !config) {
      return res.status(400).json({ error: "industry, name, and config are required" });
    }
    const created = await prisma.industryTemplate.create({
      data: {
        industry,
        name,
        description: description || null,
        config: typeof config === "string" ? config : JSON.stringify(config),
      },
    });
    res.status(201).json({
      id: created.id,
      industry: created.industry,
      name: created.name,
      description: created.description,
      config: safeParse(created.config),
    });
  } catch (err) {
    console.error("[industry_templates] POST / failed:", err);
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Industry template already exists" });
    }
    res.status(500).json({ error: "Failed to create industry template" });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /:id — admin only
// ─────────────────────────────────────────────────────────────────
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid template id" });
    }
    await prisma.industryTemplate.delete({ where: { id } });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error("[industry_templates] DELETE failed:", err);
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Template not found" });
    }
    res.status(500).json({ error: "Failed to delete industry template" });
  }
});

// ─────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────
function safeParse(val) {
  if (!val) return {};
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
}

module.exports = router;
