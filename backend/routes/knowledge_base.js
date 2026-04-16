const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

// ─── Helpers ────────────────────────────────────────────────────────────────

const slugify = (text) =>
  String(text || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80) || `article-${Date.now()}`;

const ensureUniqueSlug = async (model, baseSlug, tenantId, ignoreId = null) => {
  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const existing = await prisma[model].findFirst({
      where: { slug, tenantId, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) },
    });
    if (!existing) return slug;
    counter += 1;
    slug = `${baseSlug}-${counter}`;
  }
};

// ─── PUBLIC ENDPOINTS (no auth — mounted before authenticated routes) ───────

// GET /api/knowledge-base/public/:tenantSlug/categories
router.get("/public/:tenantSlug/categories", async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.tenantSlug } });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    const categories = await prisma.kbCategory.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: "asc" },
    });

    // Count only published articles for public view
    const withCounts = await Promise.all(
      categories.map(async (c) => ({
        ...c,
        articleCount: await prisma.kbArticle.count({
          where: { categoryId: c.id, tenantId: tenant.id, isPublished: true },
        }),
      }))
    );
    res.json(withCounts);
  } catch (err) {
    console.error("[KB][public categories]", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// GET /api/knowledge-base/public/:tenantSlug/articles?categoryId=
router.get("/public/:tenantSlug/articles", async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.tenantSlug } });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    const where = { tenantId: tenant.id, isPublished: true };
    if (req.query.categoryId) where.categoryId = parseInt(req.query.categoryId);

    const articles = await prisma.kbArticle.findMany({
      where,
      select: {
        id: true, title: true, slug: true, categoryId: true,
        views: true, createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    res.json(articles);
  } catch (err) {
    console.error("[KB][public articles]", err);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

// GET /api/knowledge-base/public/:tenantSlug/article/:slug
router.get("/public/:tenantSlug/article/:slug", async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.tenantSlug } });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    const article = await prisma.kbArticle.findFirst({
      where: { slug: req.params.slug, tenantId: tenant.id, isPublished: true },
    });
    if (!article) return res.status(404).json({ error: "Article not found" });

    // Best-effort view increment
    prisma.kbArticle
      .update({ where: { id: article.id }, data: { views: { increment: 1 } } })
      .catch(() => {});

    res.json(article);
  } catch (err) {
    console.error("[KB][public article]", err);
    res.status(500).json({ error: "Failed to fetch article" });
  }
});

// ─── AUTHENTICATED ENDPOINTS (admin write, all read) ────────────────────────

// GET /api/knowledge-base/categories — list with article counts
router.get("/categories", async (req, res) => {
  try {
    const categories = await prisma.kbCategory.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { name: "asc" },
    });
    const withCounts = await Promise.all(
      categories.map(async (c) => ({
        ...c,
        articleCount: await prisma.kbArticle.count({
          where: { categoryId: c.id, tenantId: req.user.tenantId },
        }),
      }))
    );
    res.json(withCounts);
  } catch (err) {
    console.error("[KB][categories]", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// POST /api/knowledge-base/categories
router.post("/categories", verifyToken, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const baseSlug = slugify(name);
    const slug = await ensureUniqueSlug("kbCategory", baseSlug, req.user.tenantId);

    const category = await prisma.kbCategory.create({
      data: {
        name,
        slug,
        parentId: parentId ? parseInt(parentId) : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(category);
  } catch (err) {
    console.error("[KB][create category]", err);
    res.status(500).json({ error: "Failed to create category" });
  }
});

// PUT /api/knowledge-base/categories/:id
router.put("/categories/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.kbCategory.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Category not found" });

    const { name, parentId } = req.body;
    const data = {};
    if (name !== undefined) {
      data.name = name;
      const baseSlug = slugify(name);
      data.slug = await ensureUniqueSlug("kbCategory", baseSlug, req.user.tenantId, id);
    }
    if (parentId !== undefined) data.parentId = parentId ? parseInt(parentId) : null;

    const category = await prisma.kbCategory.update({ where: { id }, data });
    res.json(category);
  } catch (err) {
    console.error("[KB][update category]", err);
    res.status(500).json({ error: "Failed to update category" });
  }
});

// DELETE /api/knowledge-base/categories/:id
router.delete("/categories/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.kbCategory.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Category not found" });

    // Detach articles in this category
    await prisma.kbArticle.updateMany({
      where: { categoryId: id, tenantId: req.user.tenantId },
      data: { categoryId: null },
    });
    await prisma.kbCategory.delete({ where: { id } });
    res.json({ message: "Category deleted" });
  } catch (err) {
    console.error("[KB][delete category]", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// GET /api/knowledge-base/articles?categoryId=&published=
router.get("/articles", async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.categoryId) where.categoryId = parseInt(req.query.categoryId);
    if (req.query.published === "true") where.isPublished = true;
    if (req.query.published === "false") where.isPublished = false;

    const articles = await prisma.kbArticle.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });
    res.json(articles);
  } catch (err) {
    console.error("[KB][articles]", err);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

// GET /api/knowledge-base/articles/:id
router.get("/articles/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const article = await prisma.kbArticle.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json(article);
  } catch (err) {
    console.error("[KB][article]", err);
    res.status(500).json({ error: "Failed to fetch article" });
  }
});

// POST /api/knowledge-base/articles
router.post("/articles", async (req, res) => {
  try {
    const { title, content, categoryId, isPublished } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const baseSlug = slugify(title);
    const slug = await ensureUniqueSlug("kbArticle", baseSlug, req.user.tenantId);

    const article = await prisma.kbArticle.create({
      data: {
        title,
        slug,
        content: content || "",
        categoryId: categoryId ? parseInt(categoryId) : null,
        isPublished: !!isPublished,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(article);
  } catch (err) {
    console.error("[KB][create article]", err);
    res.status(500).json({ error: "Failed to create article" });
  }
});

// PUT /api/knowledge-base/articles/:id
router.put("/articles/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.kbArticle.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Article not found" });

    const { title, content, categoryId, isPublished, slug } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (content !== undefined) data.content = content;
    if (categoryId !== undefined) data.categoryId = categoryId ? parseInt(categoryId) : null;
    if (isPublished !== undefined) data.isPublished = !!isPublished;
    if (slug !== undefined && slug) {
      data.slug = await ensureUniqueSlug("kbArticle", slugify(slug), req.user.tenantId, id);
    } else if (title !== undefined && !slug) {
      // Auto-regen slug if title changes and slug not explicitly provided
      data.slug = await ensureUniqueSlug("kbArticle", slugify(title), req.user.tenantId, id);
    }

    const article = await prisma.kbArticle.update({ where: { id }, data });
    res.json(article);
  } catch (err) {
    console.error("[KB][update article]", err);
    res.status(500).json({ error: "Failed to update article" });
  }
});

// DELETE /api/knowledge-base/articles/:id
router.delete("/articles/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.kbArticle.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Article not found" });
    await prisma.kbArticle.delete({ where: { id } });
    res.json({ message: "Article deleted" });
  } catch (err) {
    console.error("[KB][delete article]", err);
    res.status(500).json({ error: "Failed to delete article" });
  }
});

// POST /api/knowledge-base/articles/:id/publish
router.post("/articles/:id/publish", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.kbArticle.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Article not found" });

    const article = await prisma.kbArticle.update({
      where: { id },
      data: { isPublished: true },
    });
    res.json(article);
  } catch (err) {
    console.error("[KB][publish]", err);
    res.status(500).json({ error: "Failed to publish article" });
  }
});

// POST /api/knowledge-base/articles/:id/view
router.post("/articles/:id/view", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.kbArticle.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Article not found" });

    const article = await prisma.kbArticle.update({
      where: { id },
      data: { views: { increment: 1 } },
    });
    res.json({ views: article.views });
  } catch (err) {
    console.error("[KB][view]", err);
    res.status(500).json({ error: "Failed to record view" });
  }
});

module.exports = router;
