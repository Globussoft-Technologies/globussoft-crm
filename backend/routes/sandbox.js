const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

// ──────────────────────────────────────────────────────────────────
// Sandbox Snapshots — capture / restore / reset tenant data
// All routes require auth. Restore + reset + delete require ADMIN.
// ──────────────────────────────────────────────────────────────────

// Helpers ─────────────────────────────────────────────────────────
function jsonSize(str) {
  return Buffer.byteLength(str || "", "utf8");
}

function safeStripIds(rec) {
  // strip auto-increment id; keep relational ids since tenant data is fully wiped first
  const { id, ...rest } = rec;
  return rest;
}

// GET /api/sandbox — list snapshots for current tenant
router.get("/", verifyToken, async (req, res) => {
  try {
    const snapshots = await prisma.sandboxSnapshot.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        userId: true,
        createdAt: true,
        // exclude data field — large
      },
    });

    // Compute size for each snapshot in a separate aggregate query (cheap LENGTH)
    const ids = snapshots.map((s) => s.id);
    let sizes = {};
    if (ids.length > 0) {
      // Raw query for byte length of data; works on MySQL
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, OCTET_LENGTH(data) AS size FROM SandboxSnapshot WHERE id IN (${ids.join(",")})`
      );
      for (const r of rows) {
        sizes[r.id] = Number(r.size) || 0;
      }
    }

    res.json(
      snapshots.map((s) => ({ ...s, sizeBytes: sizes[s.id] || 0 }))
    );
  } catch (err) {
    console.error("[sandbox] list error:", err);
    res.status(500).json({ error: "Failed to list snapshots" });
  }
});

// POST /api/sandbox — capture a new snapshot of current tenant data
router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    const tenantId = req.user.tenantId;
    const where = { tenantId };

    const [
      contacts,
      deals,
      activities,
      tasks,
      invoices,
      estimates,
      estimateLineItems,
      contracts,
      quotes,
      quoteLineItems,
      pipelines,
      pipelineStages,
      emailMessages,
    ] = await Promise.all([
      prisma.contact.findMany({ where, take: 1000, orderBy: { id: "asc" } }),
      prisma.deal.findMany({ where, take: 1000, orderBy: { id: "asc" } }),
      prisma.activity.findMany({ where, orderBy: { id: "asc" } }),
      prisma.task.findMany({ where, orderBy: { id: "asc" } }),
      prisma.invoice.findMany({ where, orderBy: { id: "asc" } }),
      prisma.estimate.findMany({ where, orderBy: { id: "asc" } }),
      prisma.estimateLineItem.findMany({
        where: { estimate: { tenantId } },
        orderBy: { id: "asc" },
      }),
      prisma.contract.findMany({ where, orderBy: { id: "asc" } }),
      prisma.quote.findMany({ where, orderBy: { id: "asc" } }),
      prisma.quoteLineItem.findMany({
        where: { quote: { tenantId } },
        orderBy: { id: "asc" },
      }),
      prisma.pipeline.findMany({ where, orderBy: { id: "asc" } }),
      prisma.pipelineStage.findMany({ where, orderBy: { id: "asc" } }),
      prisma.emailMessage.findMany({ where, take: 500, orderBy: { id: "desc" } }),
    ]);

    const blob = {
      version: 1,
      capturedAt: new Date().toISOString(),
      tenantId,
      counts: {
        contacts: contacts.length,
        deals: deals.length,
        activities: activities.length,
        tasks: tasks.length,
        invoices: invoices.length,
        estimates: estimates.length,
        estimateLineItems: estimateLineItems.length,
        contracts: contracts.length,
        quotes: quotes.length,
        quoteLineItems: quoteLineItems.length,
        pipelines: pipelines.length,
        pipelineStages: pipelineStages.length,
        emailMessages: emailMessages.length,
      },
      data: {
        contacts,
        deals,
        activities,
        tasks,
        invoices,
        estimates,
        estimateLineItems,
        contracts,
        quotes,
        quoteLineItems,
        pipelines,
        pipelineStages,
        emailMessages,
      },
    };

    const dataString = JSON.stringify(blob);
    const sizeBytes = jsonSize(dataString);

    const created = await prisma.sandboxSnapshot.create({
      data: {
        name,
        description: description || null,
        data: dataString,
        tenantId,
        userId: req.user.id || req.user.userId || null,
      },
      select: { id: true, name: true, createdAt: true },
    });

    res.status(201).json({ id: created.id, name: created.name, createdAt: created.createdAt, sizeBytes });
  } catch (err) {
    console.error("[sandbox] create error:", err);
    res.status(500).json({ error: "Failed to create snapshot" });
  }
});

// GET /api/sandbox/:id — metadata only
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid snapshot id" });

    const snap = await prisma.sandboxSnapshot.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: {
        id: true,
        name: true,
        description: true,
        userId: true,
        createdAt: true,
      },
    });
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });

    // Size + counts via raw query and a partial header parse
    const rows = await prisma.$queryRawUnsafe(
      `SELECT OCTET_LENGTH(data) AS size FROM SandboxSnapshot WHERE id = ${id}`
    );
    const sizeBytes = rows && rows[0] ? Number(rows[0].size) : 0;

    res.json({ ...snap, sizeBytes });
  } catch (err) {
    console.error("[sandbox] get error:", err);
    res.status(500).json({ error: "Failed to fetch snapshot" });
  }
});

// GET /api/sandbox/:id/download — full JSON download
router.get("/:id/download", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid snapshot id" });

    const snap = await prisma.sandboxSnapshot.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });

    const safeName = (snap.name || `snapshot-${id}`).replace(/[^a-z0-9_\-]/gi, "_");
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sandbox_${safeName}_${id}.json"`
    );
    res.send(snap.data);
  } catch (err) {
    console.error("[sandbox] download error:", err);
    res.status(500).json({ error: "Failed to download snapshot" });
  }
});

// DELETE /api/sandbox/:id — admin only
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid snapshot id" });

    const existing = await prisma.sandboxSnapshot.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Snapshot not found" });

    await prisma.sandboxSnapshot.delete({ where: { id: existing.id } });
    res.json({ message: "Snapshot deleted" });
  } catch (err) {
    console.error("[sandbox] delete error:", err);
    res.status(500).json({ error: "Failed to delete snapshot" });
  }
});

// Internal helper: WIPE all tenant data across the modeled scope
async function wipeTenantData(tenantId) {
  // Delete child / dependent records first to satisfy FKs.
  // Use deleteMany scoped to tenantId where the model has it directly,
  // or via parent relation when it doesn't.
  await prisma.activity.deleteMany({ where: { tenantId } });
  await prisma.task.deleteMany({ where: { tenantId } });
  await prisma.estimateLineItem.deleteMany({ where: { estimate: { tenantId } } });
  await prisma.estimate.deleteMany({ where: { tenantId } });
  await prisma.quoteLineItem.deleteMany({ where: { quote: { tenantId } } });
  await prisma.quote.deleteMany({ where: { tenantId } });
  await prisma.invoice.deleteMany({ where: { tenantId } });
  await prisma.contract.deleteMany({ where: { tenantId } });
  await prisma.deal.deleteMany({ where: { tenantId } });
  await prisma.contact.deleteMany({ where: { tenantId } });
  await prisma.pipelineStage.deleteMany({ where: { tenantId } });
  await prisma.pipeline.deleteMany({ where: { tenantId } });
}

// POST /api/sandbox/:id/restore — DESTRUCTIVE, admin only
router.post(
  "/:id/restore",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid snapshot id" });

      const tenantId = req.user.tenantId;
      const snap = await prisma.sandboxSnapshot.findFirst({
        where: { id, tenantId },
      });
      if (!snap) return res.status(404).json({ error: "Snapshot not found" });

      let blob;
      try {
        blob = JSON.parse(snap.data);
      } catch (parseErr) {
        return res.status(400).json({ error: "Snapshot data is corrupted (invalid JSON)" });
      }

      const data = blob.data || blob;

      console.warn(
        `[sandbox] DESTRUCTIVE RESTORE — tenant ${tenantId} initiated by user ${req.user.id || req.user.userId}, snapshot ${id}`
      );

      // 1. WIPE all current tenant data
      await wipeTenantData(tenantId);

      // 2. Re-create records, retaining tenantId. Use createMany where possible.
      const restored = {
        contacts: 0,
        deals: 0,
        activities: 0,
        tasks: 0,
        invoices: 0,
        estimates: 0,
        estimateLineItems: 0,
        contracts: 0,
        quotes: 0,
        quoteLineItems: 0,
        pipelines: 0,
        pipelineStages: 0,
        emailMessages: 0,
      };

      const arr = (k) => (Array.isArray(data[k]) ? data[k] : []);

      // Pipelines & PipelineStages first (independent of others)
      if (arr("pipelines").length) {
        const r = await prisma.pipeline.createMany({
          data: arr("pipelines").map((p) => ({ ...p, tenantId })),
        });
        restored.pipelines = r.count;
      }
      if (arr("pipelineStages").length) {
        const r = await prisma.pipelineStage.createMany({
          data: arr("pipelineStages").map((p) => ({ ...p, tenantId })),
        });
        restored.pipelineStages = r.count;
      }

      // Contacts (parent of many)
      if (arr("contacts").length) {
        const r = await prisma.contact.createMany({
          data: arr("contacts").map((c) => ({ ...c, tenantId })),
          skipDuplicates: true,
        });
        restored.contacts = r.count;
      }

      // Deals (depends on Contact via optional FK)
      if (arr("deals").length) {
        const r = await prisma.deal.createMany({
          data: arr("deals").map((d) => ({ ...d, tenantId })),
        });
        restored.deals = r.count;
      }

      // Activities (require contactId)
      if (arr("activities").length) {
        const r = await prisma.activity.createMany({
          data: arr("activities").map((a) => ({ ...a, tenantId })),
        });
        restored.activities = r.count;
      }

      // Tasks
      if (arr("tasks").length) {
        const r = await prisma.task.createMany({
          data: arr("tasks").map((t) => ({ ...t, tenantId })),
        });
        restored.tasks = r.count;
      }

      // Invoices (require contactId)
      if (arr("invoices").length) {
        const r = await prisma.invoice.createMany({
          data: arr("invoices").map((i) => ({ ...i, tenantId })),
          skipDuplicates: true,
        });
        restored.invoices = r.count;
      }

      // Estimates + line items
      if (arr("estimates").length) {
        const r = await prisma.estimate.createMany({
          data: arr("estimates").map((e) => ({ ...e, tenantId })),
          skipDuplicates: true,
        });
        restored.estimates = r.count;
      }
      if (arr("estimateLineItems").length) {
        const r = await prisma.estimateLineItem.createMany({
          data: arr("estimateLineItems").map((li) => safeStripIds(li)),
        });
        restored.estimateLineItems = r.count;
      }

      // Contracts
      if (arr("contracts").length) {
        const r = await prisma.contract.createMany({
          data: arr("contracts").map((c) => ({ ...c, tenantId })),
        });
        restored.contracts = r.count;
      }

      // Quotes (require dealId) + line items
      if (arr("quotes").length) {
        const r = await prisma.quote.createMany({
          data: arr("quotes").map((q) => ({ ...q, tenantId })),
        });
        restored.quotes = r.count;
      }
      if (arr("quoteLineItems").length) {
        const r = await prisma.quoteLineItem.createMany({
          data: arr("quoteLineItems").map((li) => safeStripIds(li)),
        });
        restored.quoteLineItems = r.count;
      }

      // Email messages
      if (arr("emailMessages").length) {
        const r = await prisma.emailMessage.createMany({
          data: arr("emailMessages").map((m) => ({ ...m, tenantId })),
        });
        restored.emailMessages = r.count;
      }

      console.warn(`[sandbox] RESTORE complete — tenant ${tenantId}, counts: ${JSON.stringify(restored)}`);
      res.json({ message: "Snapshot restored", restored });
    } catch (err) {
      console.error("[sandbox] restore error:", err);
      res.status(500).json({ error: "Restore failed: " + (err.message || "unknown error") });
    }
  }
);

// POST /api/sandbox/reset — admin only, wipe everything (no restore)
router.post(
  "/reset",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { confirm } = req.body || {};
      if (confirm !== "DELETE_EVERYTHING") {
        return res.status(400).json({
          error:
            "Safety check failed. Send body { confirm: 'DELETE_EVERYTHING' } to proceed.",
        });
      }

      const tenantId = req.user.tenantId;
      console.warn(
        `[sandbox] DESTRUCTIVE RESET — tenant ${tenantId} initiated by user ${req.user.id || req.user.userId}`
      );

      await wipeTenantData(tenantId);

      res.json({ message: "Tenant data wiped clean", tenantId });
    } catch (err) {
      console.error("[sandbox] reset error:", err);
      res.status(500).json({ error: "Reset failed: " + (err.message || "unknown error") });
    }
  }
);

module.exports = router;
