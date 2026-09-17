const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

router.use(verifyToken, verifyRole(["ADMIN", "MANAGER"]));

const userSelect = { id: true, name: true, email: true, role: true };
const includeTeam = {
  members: { include: { user: { select: userSelect } } },
  createdBy: { select: userSelect },
  updatedBy: { select: userSelect },
};
const tenantWhere = (req, id) => ({ id, tenantId: req.user.tenantId });

router.get("/", async (req, res) => {
  try {
    const teams = await prisma.salesTeam.findMany({ where: { tenantId: req.user.tenantId }, include: includeTeam, orderBy: { createdAt: "desc" } });
    res.json(teams);
  } catch (_err) { res.status(500).json({ error: "Failed to load teams", code: "TEAMS_LOAD_FAILED" }); }
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(Number).filter(Number.isInteger))] : [];
  if (!name) return res.status(400).json({ error: "Team name is required", code: "TEAM_NAME_REQUIRED" });
  try {
    const users = await prisma.user.findMany({ where: { tenantId: req.user.tenantId, id: { in: memberIds } }, select: { id: true } });
    const team = await prisma.salesTeam.create({ data: { name, tenantId: req.user.tenantId, createdById: req.user.userId, updatedById: req.user.userId, members: { create: users.map(({ id }) => ({ userId: id, tenantId: req.user.tenantId })) } }, include: includeTeam });
    res.status(201).json(team);
  } catch (_err) { res.status(500).json({ error: "Failed to create team", code: "TEAM_CREATE_FAILED" }); }
});

router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || "").trim();
  const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(Number).filter(Number.isInteger))] : null;
  if (!name) return res.status(400).json({ error: "Team name is required", code: "TEAM_NAME_REQUIRED" });
  try {
    const existing = await prisma.salesTeam.findFirst({ where: tenantWhere(req, id) });
    if (!existing) return res.status(404).json({ error: "Team not found", code: "TEAM_NOT_FOUND" });
    if (memberIds) {
      const users = await prisma.user.findMany({ where: { tenantId: req.user.tenantId, id: { in: memberIds } }, select: { id: true } });
      await prisma.salesTeamMember.deleteMany({ where: { teamId: id, tenantId: req.user.tenantId } });
      await prisma.salesTeamMember.createMany({ data: users.map(({ id: userId }) => ({ teamId: id, userId, tenantId: req.user.tenantId })) });
    }
    res.json(await prisma.salesTeam.update({ where: { id }, data: { name, updatedById: req.user.userId }, include: includeTeam }));
  } catch (_err) { res.status(500).json({ error: "Failed to update team", code: "TEAM_UPDATE_FAILED" }); }
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await prisma.salesTeam.deleteMany({ where: tenantWhere(req, id) });
    if (!result.count) return res.status(404).json({ error: "Team not found", code: "TEAM_NOT_FOUND" });
    res.json({ ok: true });
  } catch (_err) { res.status(500).json({ error: "Failed to delete team", code: "TEAM_DELETE_FAILED" }); }
});

module.exports = router;
