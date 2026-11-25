const router = require("express").Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const {
  resolveAuditTenantScope,
  auditTenantWhere,
  loadTenantAuditActors,
  attachTenantAuditActors,
} = require("../lib/auditTenantScope");

// GET / — tenant-scoped audit history. Admin-only because details can contain
// sensitive change data and personal information.
router.get("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const scope = await resolveAuditTenantScope(req.user.tenantId);
    if (!scope) {
      return res.status(403).json({ error: "Invalid audit tenant scope", code: "AUDIT_SCOPE_INVALID" });
    }

    const { entity, action } = req.query;
    const where = auditTenantWhere(scope);

    if (entity) where.entity = entity;
    if (action) where.action = action;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const actors = await loadTenantAuditActors(logs.map((log) => log.userId), scope);
    res.json(attachTenantAuditActors(logs, actors));
  } catch (err) {
    console.error("[AuditLog] List error:", err);
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

module.exports = router;
