const express = require("express");
const { verifyToken } = require("../middleware/auth");
const { renderPage } = require("../services/landingPageRenderer");

const router = express.Router();
const publicRouter = express.Router();
const prisma = require("../lib/prisma");

// ── Authenticated CRUD ────────────────────────────────────────────

router.get("/", verifyToken, async (req, res) => {
  try {
    res.json(await prisma.landingPage.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, title: true, slug: true, status: true, visits: true, submissions: true, templateType: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "desc" },
    }));
  } catch (err) { res.status(500).json({ error: "Failed to fetch landing pages" }); }
});

router.get("/templates/list", verifyToken, (req, res) => {
  res.json(TEMPLATES);
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    res.json(page);
  } catch (err) { res.status(500).json({ error: "Failed to fetch page" }); }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const { title, slug, templateType, content } = req.body;
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    const trimmedTitle = title.trim();

    // #339: dedup-on-create — if a Draft landing page with the same title
    // (case-insensitive trim) already exists for this tenant, reject with 409
    // so the user opens the existing draft instead of accumulating dupes.
    // Published / archived pages don't block (a stale "Lead Capture" PUBLISHED
    // doesn't prevent starting a fresh draft to replace it). Fetch the tenant's
    // drafts and JS-compare with toLowerCase().trim() — Prisma `equals` with
    // `mode: 'insensitive'` isn't portable across all MySQL collations, so the
    // JS path is the safer match for the spec.
    const existingDrafts = await prisma.landingPage.findMany({
      where: { tenantId: req.user.tenantId, status: "DRAFT" },
      select: { id: true, title: true },
    });
    const needle = trimmedTitle.toLowerCase();
    const dupe = existingDrafts.find(
      (p) => (p.title || "").trim().toLowerCase() === needle
    );
    if (dupe) {
      return res.status(409).json({
        error: `A landing page named '${trimmedTitle}' already exists in Draft. Open it or rename.`,
        existingId: dupe.id,
      });
    }

    const finalSlug = slug || trimmedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Date.now().toString(36);

    let finalContent = content;
    if (templateType && !content) {
      const tmpl = TEMPLATES.find(t => t.id === templateType);
      if (tmpl) finalContent = JSON.stringify(tmpl.content);
    }

    const page = await prisma.landingPage.create({
      data: { title: trimmedTitle, slug: finalSlug, templateType, content: finalContent || "[]", userId: req.user.userId, tenantId: req.user.tenantId },
    });
    res.status(201).json(page);
  } catch (err) {
    console.error("[LandingPages] Create error:", err);
    res.status(500).json({ error: "Failed to create page" });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    const { title, content, cssOverrides, metaTitle, metaDescription, slug } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (content !== undefined) data.content = typeof content === "string" ? content : JSON.stringify(content);
    if (cssOverrides !== undefined) data.cssOverrides = cssOverrides;
    if (metaTitle !== undefined) data.metaTitle = metaTitle;
    if (metaDescription !== undefined) data.metaDescription = metaDescription;
    if (slug !== undefined) data.slug = slug;

    res.json(await prisma.landingPage.update({ where: { id: existing.id }, data }));
  } catch (err) { res.status(500).json({ error: "Failed to update page" }); }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    await prisma.landingPage.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to delete page" }); }
});

router.post("/:id/publish", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    res.json(await prisma.landingPage.update({ where: { id: existing.id }, data: { status: "PUBLISHED", publishedAt: new Date() } }));
  } catch (err) { res.status(500).json({ error: "Failed to publish" }); }
});

router.post("/:id/unpublish", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    res.json(await prisma.landingPage.update({ where: { id: existing.id }, data: { status: "DRAFT" } }));
  } catch (err) { res.status(500).json({ error: "Failed to unpublish" }); }
});

router.post("/:id/duplicate", verifyToken, async (req, res) => {
  try {
    const orig = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!orig) return res.status(404).json({ error: "Page not found" });
    const copy = await prisma.landingPage.create({
      data: {
        title: `Copy of ${orig.title}`,
        slug: `${orig.slug}-copy-${Date.now().toString(36)}`,
        content: orig.content,
        cssOverrides: orig.cssOverrides,
        templateType: orig.templateType,
        metaTitle: orig.metaTitle,
        metaDescription: orig.metaDescription,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(copy);
  } catch (err) { res.status(500).json({ error: "Failed to duplicate" }); }
});

router.get("/:id/analytics", verifyToken, async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const events = await prisma.landingPageAnalytics.findMany({
      where: { landingPageId: page.id, tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const visits = events.filter(e => e.eventType === "VISIT").length;
    const submissions = events.filter(e => e.eventType === "FORM_SUBMIT").length;
    res.json({ events, visits, submissions, conversionRate: visits > 0 ? ((submissions / visits) * 100).toFixed(1) : 0 });
  } catch (err) { res.status(500).json({ error: "Failed to fetch analytics" }); }
});

// ── Public routes (no auth) ───────────────────────────────────────
// Pages are looked up by slug (globally unique). Inferred tenantId comes from the page itself.

publicRouter.get("/:slug", async (req, res) => {
  try {
    const page = await prisma.landingPage.findUnique({ where: { slug: req.params.slug } });
    if (!page || page.status !== "PUBLISHED") return res.status(404).send("<h1>Page not found</h1>");

    await prisma.landingPage.update({ where: { id: page.id }, data: { visits: { increment: 1 } } });
    await prisma.landingPageAnalytics.create({
      data: { landingPageId: page.id, eventType: "VISIT", visitorIp: req.ip, userAgent: req.headers["user-agent"], referrer: req.headers["referer"], tenantId: page.tenantId || 1 },
    });

    const html = renderPage(page);
    res.set("Content-Type", "text/html").send(html);
  } catch (err) {
    console.error("[LandingPage] Render error:", err);
    res.status(500).send("<h1>Server error</h1>");
  }
});

publicRouter.post("/:slug/submit", express.json(), async (req, res) => {
  try {
    const page = await prisma.landingPage.findUnique({ where: { slug: req.params.slug } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const tenantId = page.tenantId || 1;

    const { email, name, full_name, phone, company, company_name } = req.body;
    const contactEmail = email || `lp-${page.slug}-${Date.now()}@anonymous.local`;
    const contactName = name || full_name || "Landing Page Lead";

    const contact = await prisma.contact.upsert({
      where: { email: contactEmail },
      update: { source: `Landing Page: ${page.title}` },
      create: {
        name: contactName,
        email: contactEmail,
        phone: phone || null,
        company: company || company_name || null,
        status: "Lead",
        source: `Landing Page: ${page.title}`,
        aiScore: 30,
        tenantId,
      },
    });

    await prisma.deal.create({
      data: { title: `LP Inbound: ${page.title}`, amount: 0, stage: "lead", contactId: contact.id, tenantId },
    });

    await prisma.landingPage.update({ where: { id: page.id }, data: { submissions: { increment: 1 } } });
    await prisma.landingPageAnalytics.create({
      data: { landingPageId: page.id, eventType: "FORM_SUBMIT", visitorIp: req.ip, metadata: JSON.stringify(req.body), tenantId },
    });

    if (req.io) req.io.emit("deal_updated", {});

    res.json({ success: true, message: "Thank you for your submission!" });
  } catch (err) {
    console.error("[LandingPage] Submit error:", err);
    res.status(500).json({ error: "Submission failed" });
  }
});

publicRouter.get("/:slug/track", async (req, res) => {
  try {
    const page = await prisma.landingPage.findUnique({ where: { slug: req.params.slug } });
    if (page) {
      await prisma.landingPageAnalytics.create({
        data: { landingPageId: page.id, eventType: req.query.event || "VISIT", visitorIp: req.ip, userAgent: req.headers["user-agent"], tenantId: page.tenantId || 1 },
      });
    }
  } catch (err) { /* silent */ }
  // 1x1 transparent GIF
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store" }).send(gif);
});

// ── Templates ─────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: "lead_capture", name: "Lead Capture", description: "Simple lead generation form with headline and CTA",
    content: [
      { type: "heading", props: { text: "Get Started Today", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Fill out the form below and our team will get back to you within 24 hours.", align: "center", color: "#64748b" } },
      { type: "spacer", props: { height: "30px" } },
      { type: "form", props: { fields: [{ label: "Full Name", name: "name", type: "text", required: true }, { label: "Email", name: "email", type: "email", required: true }, { label: "Phone", name: "phone", type: "tel", required: false }, { label: "Company", name: "company", type: "text", required: false }], submitText: "Get in Touch", thankYouMessage: "Thank you! We'll be in touch soon." } },
    ],
  },
  {
    id: "product_showcase", name: "Product Showcase", description: "Showcase your product with features and a signup form",
    content: [
      { type: "heading", props: { text: "The Best Solution for Your Business", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Trusted by 10,000+ businesses worldwide. See why teams love our platform.", align: "center", color: "#64748b" } },
      { type: "image", props: { src: "https://placehold.co/800x400/3b82f6/white?text=Product+Screenshot", alt: "Product", maxWidth: "800px" } },
      { type: "spacer", props: { height: "40px" } },
      { type: "columns", props: { gap: "2rem", columns: [{ components: [{ type: "heading", props: { text: "Fast Setup", level: "h3", align: "center", color: "#1e293b" } }, { type: "text", props: { text: "Get started in minutes, not months.", align: "center", color: "#64748b" } }] }, { components: [{ type: "heading", props: { text: "Powerful Analytics", level: "h3", align: "center", color: "#1e293b" } }, { type: "text", props: { text: "Real-time dashboards and insights.", align: "center", color: "#64748b" } }] }, { components: [{ type: "heading", props: { text: "24/7 Support", level: "h3", align: "center", color: "#1e293b" } }, { type: "text", props: { text: "Our team is always here to help.", align: "center", color: "#64748b" } }] }] } },
      { type: "spacer", props: { height: "40px" } },
      { type: "form", props: { fields: [{ label: "Name", name: "name", type: "text", required: true }, { label: "Work Email", name: "email", type: "email", required: true }], submitText: "Start Free Trial", thankYouMessage: "Welcome aboard! Check your email for next steps." } },
    ],
  },
  {
    id: "event_registration", name: "Event Registration", description: "Event landing page with details and registration form",
    content: [
      { type: "heading", props: { text: "Annual Business Summit 2026", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Join 500+ industry leaders on March 15, 2026 for a day of insights, networking, and innovation.", align: "center", color: "#64748b", fontSize: "1.1rem" } },
      { type: "spacer", props: { height: "20px" } },
      { type: "video", props: { url: "https://www.youtube.com/embed/dQw4w9WgXcQ", width: "100%" } },
      { type: "spacer", props: { height: "30px" } },
      { type: "form", props: { fields: [{ label: "Full Name", name: "name", type: "text", required: true }, { label: "Email", name: "email", type: "email", required: true }, { label: "Company", name: "company", type: "text", required: true }, { label: "Job Title", name: "title", type: "text", required: false }], submitText: "Register Now", thankYouMessage: "You're registered! We'll send confirmation details to your email." } },
    ],
  },
  {
    id: "webinar_signup", name: "Webinar Signup", description: "Webinar registration with countdown and signup form",
    content: [
      { type: "heading", props: { text: "Free Webinar: Scaling Your Sales Pipeline", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Learn proven strategies to 3x your pipeline in 90 days. Live on April 20, 2026 at 2:00 PM IST.", align: "center", color: "#64748b" } },
      { type: "image", props: { src: "https://placehold.co/600x300/10b981/white?text=Webinar+Preview", alt: "Webinar", maxWidth: "600px" } },
      { type: "spacer", props: { height: "30px" } },
      { type: "form", props: { fields: [{ label: "Name", name: "name", type: "text", required: true }, { label: "Email", name: "email", type: "email", required: true }], submitText: "Save My Spot", thankYouMessage: "You're in! Check your inbox for the webinar link." } },
    ],
  },
];

module.exports = { router, publicRouter };
