const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { verifyToken } = require("../middleware/auth");
const { renderPage } = require("../services/landingPageRenderer");

const router = express.Router();
const publicRouter = express.Router();
const prisma = require("../lib/prisma");

// ── #446 — image-upload multer config ─────────────────────────────
//
// Why: pre-fix the Image component in the LandingPageBuilder only accepted
// a URL string (`props.src`). Users had to host the image elsewhere first
// (S3, Imgur, etc.) and paste a URL. This route lets the builder POST the
// raw file and get back a `{ url }` we can drop straight into props.src.
//
// Storage: backend/uploads/landing-page-images/<tenantId>/<unique>.<ext>
// Served by: app.use("/uploads", express.static(...)) at server.js:428,
// so the returned `url` field is the public path "/uploads/landing-page-
// images/<tenantId>/<file>".
//
// Constraints:
//   - 5 MB hard limit (multer LIMIT_FILE_SIZE → 400)
//   - MIME-type allowlist: png / jpg / jpeg / webp / gif. SVG is OFF —
//     SVG is a script-execution surface (XSS via inline <script> /
//     onload) when served from same-origin /uploads. The branding logo
//     route (wellness.js:3585) accepts SVG because tenant ADMINs are a
//     trusted population; the landing-page upload should match the
//     tighter image-allowlist used in the public renderer's safeUrl
//     helper (services/landingPageRenderer.js:67-69 only allows http/
//     https/data:image/* — but not svg+xml).
//   - File extension is derived from MIME, not the client's filename,
//     so `evil.svg` masquerading as image/png renders as .png on disk.
const ALLOWED_IMAGE_MIMES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(
        __dirname, "..", "uploads", "landing-page-images", `tenant-${req.user.tenantId}`
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Derive ext from MIME, not from the client filename. The MIME
      // allowlist is enforced in fileFilter so this lookup is safe.
      const ext = ALLOWED_IMAGE_MIMES[(file.mimetype || "").toLowerCase()] || ".bin";
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      cb(null, `${unique}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES[(file.mimetype || "").toLowerCase()]) return cb(null, true);
    cb(new Error("Only PNG, JPG, WebP, and GIF images are allowed"));
  },
});

// #378: slug validation — only lowercase a-z, 0-9, hyphens; max 50 chars.
// Anything else produces broken public URLs (spaces, uppercase, special chars).
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const isValidSlug = (s) =>
  typeof s === "string" && s.length > 0 && s.length <= 50 && SLUG_PATTERN.test(s);

// ── Authenticated CRUD ────────────────────────────────────────────

router.get("/", verifyToken, async (req, res) => {
  try {
    res.json(await prisma.landingPage.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, title: true, slug: true, status: true, visits: true, submissions: true, templateType: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "desc" },
    }));
  } catch (_err) { res.status(500).json({ error: "Failed to fetch landing pages" }); }
});

router.get("/templates/list", verifyToken, (req, res) => {
  res.json(TEMPLATES);
});

// ── #446 — image upload for the builder's Image block ─────────────
//
// POST /api/landing-pages/upload (multipart/form-data, field name "image")
//
// Returns: 201 { url, mimetype, size, filename }
// Errors:
//   400 — wrong MIME, missing file, multer LIMIT_FILE_SIZE
//   401/403 — verifyToken (mounted in the global guard, but route-level
//             verifyToken duplicated for explicit defence-in-depth)
//
// Tenant isolation: storage path includes req.user.tenantId so a
// directory listing on disk is segmented per tenant. The returned
// `url` is `/uploads/landing-page-images/tenant-<id>/<file>`. We do
// NOT persist a row in the DB — the URL is opaque and gets stored in
// the parent LandingPage row's `content` JSON when the user saves.
router.post(
  "/upload",
  verifyToken,
  (req, res, next) => {
    imageUpload.single("image")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE"
          ? "Image too large (max 5 MB)"
          : (err.message || "Image upload failed");
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided (field 'image')" });
    }
    const url = `/uploads/landing-page-images/tenant-${req.user.tenantId}/${path.basename(req.file.path)}`;
    res.status(201).json({
      url,
      mimetype: req.file.mimetype,
      size: req.file.size,
      filename: path.basename(req.file.path),
    });
  }
);

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    res.json(page);
  } catch (_err) { res.status(500).json({ error: "Failed to fetch page" }); }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const { title, slug, templateType, content } = req.body;
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    const trimmedTitle = title.trim();

    // #378: if a slug is provided by the client, validate before insert.
    // Auto-generated slugs (built below) already conform to [a-z0-9-]+.
    if (slug !== undefined && slug !== null && slug !== "" && !isValidSlug(slug)) {
      return res.status(400).json({
        error: "Invalid slug. Use lowercase letters, numbers, and hyphens only (max 50 chars).",
      });
    }

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

    // #378: cap auto-generated slugs at 50 chars (incl. timestamp suffix).
    const tsSuffix = Date.now().toString(36);
    const baseSlug = trimmedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const truncatedBase = baseSlug.slice(0, Math.max(0, 50 - tsSuffix.length - 1));
    const finalSlug = slug || (truncatedBase ? `${truncatedBase}-${tsSuffix}` : tsSuffix);

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
    if (slug !== undefined) {
      // #378: reject invalid slugs on update too — same rules as create.
      if (!isValidSlug(slug)) {
        return res.status(400).json({
          error: "Invalid slug. Use lowercase letters, numbers, and hyphens only (max 50 chars).",
        });
      }
      // #456: tenant-scoped uniqueness check before update. Pre-fix the
      // user could change a slug to one that another draft was already
      // using; the second page silently shadowed the first at /p/<slug>
      // (whichever resolved first won, the other became unreachable).
      // Pre-check + return 409 instead of relying on a DB-level unique
      // constraint to throw a P2002 (which surfaces as 500).
      if (slug !== existing.slug) {
        const collision = await prisma.landingPage.findFirst({
          where: { tenantId: req.user.tenantId, slug, NOT: { id: existing.id } },
          select: { id: true, title: true, status: true },
        });
        if (collision) {
          return res.status(409).json({
            error: `Slug '${slug}' is already used by '${collision.title}' (${collision.status.toLowerCase()}, id ${collision.id}). Pick a different slug.`,
            existingId: collision.id,
          });
        }
        // #456: slug change on a PUBLISHED page breaks every inbound link
        // (ad campaigns, email links, QR codes). Don't block — the owner
        // may legitimately need to rename — but require an explicit
        // ?confirmSlugChange=true query so an accidental autosave can't
        // strand customers. The frontend builder should pop a "this will
        // break /p/<old-slug>" dialog before sending the confirmation.
        if (existing.status === "PUBLISHED" && req.query.confirmSlugChange !== "true") {
          return res.status(409).json({
            error: `Page is PUBLISHED. Changing the slug breaks every inbound link to /p/${existing.slug}. Re-submit with ?confirmSlugChange=true to proceed.`,
            code: "PUBLISHED_SLUG_CHANGE_REQUIRES_CONFIRM",
            currentSlug: existing.slug,
            requestedSlug: slug,
          });
        }
      }
      data.slug = slug;
    }

    res.json(await prisma.landingPage.update({ where: { id: existing.id }, data }));
  } catch (_err) { res.status(500).json({ error: "Failed to update page" }); }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    await prisma.landingPage.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (_err) { res.status(500).json({ error: "Failed to delete page" }); }
});

router.post("/:id/publish", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    res.json(await prisma.landingPage.update({ where: { id: existing.id }, data: { status: "PUBLISHED", publishedAt: new Date() } }));
  } catch (_err) { res.status(500).json({ error: "Failed to publish" }); }
});

router.post("/:id/unpublish", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    res.json(await prisma.landingPage.update({ where: { id: existing.id }, data: { status: "DRAFT" } }));
  } catch (_err) { res.status(500).json({ error: "Failed to unpublish" }); }
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
  } catch (_err) { res.status(500).json({ error: "Failed to duplicate" }); }
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
  } catch (_err) { res.status(500).json({ error: "Failed to fetch analytics" }); }
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

// ── #451 — verify a Cloudflare Turnstile token ─────────────────────
//
// Stub-friendly: if `TURNSTILE_SECRET_KEY` is unset we WARN once per
// process and skip verification (returns true so the submit goes
// through). This means dev/CI environments don't 500 just because the
// secret is missing. In production the env-var must be set.
//
// On real verification we POST the token to Cloudflare's siteverify
// endpoint with `secret + response + remoteip`. Cloudflare returns
// `{ success: true|false, ... }`.
let _turnstileWarnedMissing = false;
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (!_turnstileWarnedMissing) {
      console.warn(
        "[LandingPage] TURNSTILE_SECRET_KEY not set — CAPTCHA verification skipped. Set this env var to enforce Cloudflare Turnstile."
      );
      _turnstileWarnedMissing = true;
    }
    return true;
  }
  if (!token || typeof token !== "string") return false;
  try {
    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", token);
    if (remoteIp) body.set("remoteip", remoteIp);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.success;
  } catch (err) {
    console.error("[LandingPage] Turnstile verify error:", err.message);
    return false;
  }
}

// ── #451 — apply a per-form lead-routing rule ──────────────────────
//
// Reads the form-level config out of the page's content JSON. If the
// form component has `leadRoutingRuleId`, we look up that rule (must
// belong to the same tenant), compute the assignee per rule type, and
// set contact.assignedToId. Errors are swallowed — routing failure
// shouldn't reject the lead.
//
// If unset, the contact is created without an assignee so the
// tenant-level lead_routing apply-all path picks it up later.
async function pickFormFromContent(content) {
  if (!content) return null;
  let arr = [];
  try {
    arr = typeof content === "string" ? JSON.parse(content) : content;
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  // First top-level form wins. Columns nested forms aren't covered yet.
  return arr.find((c) => c && c.type === "form") || null;
}
async function applyLeadRouting(formProps, tenantId, contactId) {
  if (!formProps || !formProps.leadRoutingRuleId) return null;
  const ruleId = parseInt(formProps.leadRoutingRuleId, 10);
  if (!Number.isFinite(ruleId)) return null;
  try {
    const rule = await prisma.leadRoutingRule.findFirst({
      where: { id: ruleId, tenantId, isActive: true },
    });
    if (!rule) return null;
    let assigneeId = null;
    if (rule.assignType === "user" && rule.assignTo) {
      assigneeId = parseInt(rule.assignTo, 10) || null;
    } else if (rule.assignType === "round_robin") {
      // Best-effort: pick the first ADMIN/MANAGER/USER on this tenant.
      // Full round-robin counter lives in lead_routing.js — we don't
      // duplicate that complexity here for the inbound landing-page
      // path.
      const candidate = await prisma.user.findFirst({
        where: { tenantId, role: { in: ["ADMIN", "MANAGER", "USER"] } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assigneeId = candidate?.id ?? null;
    }
    if (assigneeId) {
      await prisma.contact.update({ where: { id: contactId }, data: { assignedToId: assigneeId } });
      return assigneeId;
    }
  } catch (err) {
    console.error("[LandingPage] applyLeadRouting failed:", err.message);
  }
  return null;
}

publicRouter.post("/:slug/submit", express.json(), async (req, res) => {
  try {
    const page = await prisma.landingPage.findUnique({ where: { slug: req.params.slug } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const tenantId = page.tenantId || 1;

    // #451: locate the form component in the page's content so we can
    // honour its enableCaptcha / leadRoutingRuleId / successRedirectUrl
    // props on the server side too. The renderer-side checks aren't
    // sufficient — a malicious client could bypass the JS guard.
    const formComp = await pickFormFromContent(page.content);
    const formProps = (formComp && formComp.props) || {};

    // #451: CAPTCHA verification before any DB writes.
    if (formProps.enableCaptcha) {
      const ok = await verifyTurnstile(req.body.cfTurnstileToken, req.ip);
      if (!ok) {
        return res.status(400).json({ error: "CAPTCHA verification failed. Please try again." });
      }
    }

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

    // #451: apply per-form lead routing if configured.
    await applyLeadRouting(formProps, tenantId, contact.id);

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
  } catch (_err) { /* silent */ }
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
