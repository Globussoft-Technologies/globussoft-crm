// Contacts "Saved Views" — a named, FIXED list of hand-picked contact IDs
// (generic vertical only). E.g. select 10 contacts via the existing
// search/filter/checkbox UI, click "Save View", name it "Mohit Customers".
// The view's membership does NOT re-evaluate over time — it only changes
// when someone explicitly edits it via PUT.
//
// Visibility: tenant-shared READ — any authenticated role in the tenant can
// list views and see a view's members (populates the "Customize table"-style
// dropdown on Contacts.jsx for every teammate, per the user's explicit
// request: "another person from the sales come select there own so they can
// by default see the evevry one"). WRITE-restricted — only the view's
// creator OR an ADMIN may rename/edit-membership/delete it; a MANAGER/USER
// who didn't create a view can select and use it but not modify it.
//
// Generic-vertical-only, enforced server-side (mirrors the pattern in
// routes/table_column_preferences.js) — a direct API call from a
// wellness/travel tenant is rejected rather than silently answered.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

router.use(async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    if (tenant && (tenant.vertical === "wellness" || tenant.vertical === "travel")) {
      return res.status(403).json({
        error: "Saved views are only available for the generic CRM vertical",
        code: "GENERIC_VERTICAL_ONLY",
      });
    }
    next();
  } catch (err) {
    console.error("[contact-views] vertical-check error:", err && err.message);
    res.status(500).json({ error: "Failed to verify tenant vertical" });
  }
});

const MAX_NAME_LEN = 80;
const MAX_MEMBERS = 2000; // generous ceiling — guards against a fat-fingered "select all + save" on a huge tenant

function canModify(view, req) {
  return view.createdByUserId === req.user.userId || req.user.role === "ADMIN";
}

// GET /api/contact-views — list this tenant's saved views (id, name,
// creator, member count) for the dropdown. Tenant-shared: every role sees
// every view. Does NOT include the member list itself (fetch via
// GET /:id/members to avoid a heavy payload on every page load).
router.get("/", async (req, res) => {
  try {
    const views = await prisma.savedContactView.findMany({
      where: { tenantId: req.user.tenantId },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true } },
      },
      orderBy: [{ name: "asc" }],
    });
    res.json(
      views.map((v) => ({
        id: v.id,
        name: v.name,
        createdByUserId: v.createdByUserId,
        createdByName: v.createdBy?.name || v.createdBy?.email || "Unknown",
        memberCount: v._count.members,
        canModify: canModify(v, req),
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    );
  } catch (err) {
    console.error("[contact-views] list error:", err && err.message);
    res.status(500).json({ error: "Failed to load saved views" });
  }
});

// GET /api/contact-views/:id/members — the view's contact IDs, for
// Contacts.jsx to filter its already-loaded contact list against. Returns
// bare IDs only (not full contact rows) since Contacts.jsx already has the
// full row data client-side once the view is selected.
router.get("/:id/members", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid view id" });

    const view = await prisma.savedContactView.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!view) return res.status(404).json({ error: "View not found" });

    const members = await prisma.savedContactViewMember.findMany({
      where: { viewId: id },
      select: { contactId: true },
    });
    res.json({ contactIds: members.map((m) => m.contactId) });
  } catch (err) {
    console.error("[contact-views] members error:", err && err.message);
    res.status(500).json({ error: "Failed to load view members" });
  }
});

// POST /api/contact-views — create a new saved view from a set of contact
// IDs (the caller has already selected them via checkboxes/filters).
// Creator is always the authenticated user — no createdByUserId in the
// body (would let a caller forge authorship of a view).
router.post("/", async (req, res) => {
  try {
    const { name, contactIds } = req.body || {};

    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    if (trimmedName.length > MAX_NAME_LEN) {
      return res.status(400).json({ error: `name must be ${MAX_NAME_LEN} characters or fewer`, code: "NAME_TOO_LONG" });
    }
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: "contactIds must be a non-empty array", code: "CONTACT_IDS_REQUIRED" });
    }
    if (contactIds.length > MAX_MEMBERS) {
      return res.status(413).json({ error: `A view can hold at most ${MAX_MEMBERS} contacts`, code: "TOO_MANY_MEMBERS" });
    }

    const existing = await prisma.savedContactView.findUnique({
      where: { tenantId_name: { tenantId: req.user.tenantId, name: trimmedName } },
    });
    if (existing) {
      return res.status(409).json({ error: "A view with this name already exists", code: "DUPLICATE_VIEW_NAME" });
    }

    // Only keep IDs that are real contacts belonging to this tenant — silently
    // drops anything else rather than failing the whole save (mirrors the
    // "unknown/stale field key" tolerance pattern used elsewhere in this
    // codebase, e.g. writeLeadCustomFieldValues in routes/contacts.js).
    const ids = [...new Set(contactIds.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id)))];
    const validContacts = await prisma.contact.findMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
      select: { id: true },
    });
    if (validContacts.length === 0) {
      return res.status(400).json({ error: "None of the provided contactIds belong to this tenant", code: "NO_VALID_CONTACTS" });
    }

    const created = await prisma.savedContactView.create({
      data: {
        tenantId: req.user.tenantId,
        name: trimmedName,
        createdByUserId: req.user.userId,
        members: {
          create: validContacts.map((c) => ({ contactId: c.id })),
        },
      },
      include: { _count: { select: { members: true } } },
    });

    res.status(201).json({
      id: created.id,
      name: created.name,
      createdByUserId: created.createdByUserId,
      memberCount: created._count.members,
      canModify: true,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  } catch (err) {
    console.error("[contact-views] create error:", err && err.message);
    res.status(500).json({ error: "Failed to create saved view" });
  }
});

// PUT /api/contact-views/:id — rename and/or replace membership. Creator or
// ADMIN only. `contactIds`, when provided, REPLACES the entire membership
// list (not a merge) — matches "edit them" from the request: the user picks
// a fresh set of contacts and overwrites the view's contents.
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid view id" });

    const existing = await prisma.savedContactView.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "View not found" });
    if (!canModify(existing, req)) {
      return res.status(403).json({ error: "Only the view's creator or an admin can edit it", code: "NOT_VIEW_OWNER" });
    }

    const { name, contactIds } = req.body || {};
    const data = {};

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) return res.status(400).json({ error: "name cannot be empty", code: "NAME_REQUIRED" });
      if (trimmedName.length > MAX_NAME_LEN) {
        return res.status(400).json({ error: `name must be ${MAX_NAME_LEN} characters or fewer`, code: "NAME_TOO_LONG" });
      }
      if (trimmedName !== existing.name) {
        const nameClash = await prisma.savedContactView.findUnique({
          where: { tenantId_name: { tenantId: req.user.tenantId, name: trimmedName } },
        });
        if (nameClash) {
          return res.status(409).json({ error: "A view with this name already exists", code: "DUPLICATE_VIEW_NAME" });
        }
      }
      data.name = trimmedName;
    }

    if (contactIds !== undefined) {
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return res.status(400).json({ error: "contactIds must be a non-empty array", code: "CONTACT_IDS_REQUIRED" });
      }
      if (contactIds.length > MAX_MEMBERS) {
        return res.status(413).json({ error: `A view can hold at most ${MAX_MEMBERS} contacts`, code: "TOO_MANY_MEMBERS" });
      }
      const ids = [...new Set(contactIds.map((cid) => parseInt(cid, 10)).filter((cid) => !Number.isNaN(cid)))];
      const validContacts = await prisma.contact.findMany({
        where: { id: { in: ids }, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (validContacts.length === 0) {
        return res.status(400).json({ error: "None of the provided contactIds belong to this tenant", code: "NO_VALID_CONTACTS" });
      }
      // Replace membership: delete all existing rows, insert the new set.
      // Simpler + safer than a diff/patch for a feature whose whole point is
      // "this view now contains exactly these contacts."
      await prisma.$transaction([
        prisma.savedContactViewMember.deleteMany({ where: { viewId: id } }),
        prisma.savedContactViewMember.createMany({
          data: validContacts.map((c) => ({ viewId: id, contactId: c.id })),
        }),
      ]);
    }

    if (Object.keys(data).length > 0) {
      await prisma.savedContactView.update({ where: { id }, data });
    }

    const updated = await prisma.savedContactView.findUnique({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
    res.json({
      id: updated.id,
      name: updated.name,
      createdByUserId: updated.createdByUserId,
      memberCount: updated._count.members,
      canModify: true,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  } catch (err) {
    console.error("[contact-views] update error:", err && err.message);
    res.status(500).json({ error: "Failed to update saved view" });
  }
});

// DELETE /api/contact-views/:id — creator or ADMIN only. Cascades to
// SavedContactViewMember rows (onDelete: Cascade in schema).
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid view id" });

    const existing = await prisma.savedContactView.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "View not found" });
    if (!canModify(existing, req)) {
      return res.status(403).json({ error: "Only the view's creator or an admin can delete it", code: "NOT_VIEW_OWNER" });
    }

    await prisma.savedContactView.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[contact-views] delete error:", err && err.message);
    res.status(500).json({ error: "Failed to delete saved view" });
  }
});

module.exports = router;
