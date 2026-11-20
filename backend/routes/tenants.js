const express = require("express");
const bcrypt = require("bcryptjs");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");
const { KEYS, getGenericCrmTimezone, normalizeWorkspaceTimezone } = require("../lib/tenantSettings");

// GET /api/tenants/current — return current tenant info
router.get("/current", verifyToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });
    const timezone = tenant.vertical === "generic" ? await getGenericCrmTimezone(tenant.id) : undefined;
    res.json({ ...tenant, timezone });
  } catch (err) {
    console.error("[tenants] current error:", err);
    res.status(500).json({ error: "Failed to fetch tenant" });
  }
});

// PUT /api/tenants/current — update tenant settings (ADMIN only)
router.put("/current", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { name, plan, ownerEmail, isActive, emailRetention, defaultCurrency, timezone } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (plan !== undefined) data.plan = plan;
    if (ownerEmail !== undefined) data.ownerEmail = ownerEmail;
    if (isActive !== undefined) data.isActive = isActive;
    // #611: emailRetention boolean — controls whether OUTBOUND email sends
    // persist EmailMessage rows (Sent folder + audit trail) or fire-and-forget.
    if (emailRetention !== undefined) data.emailRetention = !!emailRetention;
    if (defaultCurrency !== undefined) {
      const normalizedCurrency = String(defaultCurrency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
        return res.status(400).json({ error: "Reporting currency must be a 3-letter currency code" });
      }
      data.defaultCurrency = normalizedCurrency;
    }

    const tenantId = req.user.tenantId;
    if (timezone !== undefined) {
      const zone = normalizeWorkspaceTimezone(timezone);
      if (!zone) return res.status(400).json({ error: "Choose a valid workspace timezone.", code: "INVALID_TIMEZONE" });
      const current = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
      if (current?.vertical !== "generic") {
        return res.status(400).json({ error: "Workspace timezone is available in Generic CRM.", code: "TIMEZONE_UNAVAILABLE" });
      }
      const tenant = await prisma.$transaction(async (tx) => {
        const updated = await tx.tenant.update({ where: { id: tenantId }, data });
        const key = KEYS.CALLIFIED_RETRY_TIMEZONE;
        const where = { tenantId_key: { tenantId, key } };
        const previous = await tx.tenantSetting.findUnique({ where, select: { value: true } });
        if ((normalizeWorkspaceTimezone(previous?.value) || "UTC") !== zone) {
          await tx.tenantSetting.upsert({
            where,
            create: { tenantId, key, value: zone, category: "feature-flag" },
            update: { value: zone },
          });
          const scheduledModes = {
            [KEYS.CALLIFIED_PENDING_RETRY_MODE]: "pending",
            [KEYS.CALLIFIED_DNP_RETRY_MODE]: "dnp",
          };
          const modes = await tx.tenantSetting.findMany({
            where: { tenantId, key: { in: Object.keys(scheduledModes) }, value: "scheduled" },
            select: { key: true },
          });
          if (modes.length) {
            await tx.contact.updateMany({
              where: { tenantId, status: "Lead", deletedAt: null, callifiedLeadStatus: { in: modes.map(({ key: mode }) => scheduledModes[mode]) }, callifiedDnpNextRetryAt: { not: null } },
              data: { callifiedDnpNextRetryAt: null },
            });
          }
        }
        return updated;
      });
      return res.json({ ...tenant, timezone: zone });
    }
    const tenant = await prisma.tenant.update({ where: { id: tenantId }, data });
    const currentZone = tenant.vertical === "generic" ? await getGenericCrmTimezone(tenantId) : undefined;
    res.json({ ...tenant, timezone: currentZone });
  } catch (err) {
    console.error("[tenants] update error:", err);
    res.status(500).json({ error: "Failed to update tenant" });
  }
});

// GET /api/tenants/users — list users in current tenant
router.get("/users", verifyToken, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
    res.json(users);
  } catch (err) {
    console.error("[tenants] list users error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /api/tenants/users — invite user into current tenant (ADMIN only)
router.post("/users", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    // Email is unique per-tenant — only block if it already exists in THIS org.
    const existing = await prisma.user.findFirst({ where: { email, tenantId: req.user.tenantId } });
    if (existing) return res.status(400).json({ error: "User with this email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashed,
        role: role || "USER",
        tenantId: req.user.tenantId,
      },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
    res.status(201).json(user);
  } catch (err) {
    console.error("[tenants] invite user error:", err);
    res.status(500).json({ error: "Failed to invite user" });
  }
});

module.exports = router;
