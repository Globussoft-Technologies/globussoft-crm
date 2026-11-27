const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

router.use(verifyToken, verifyRole(["ADMIN", "MANAGER"]));

const userSelect = { id: true, name: true, email: true, role: true };
const includeTeam = {
  members: { include: { user: { select: userSelect } } },
  manager: { select: userSelect },
  createdBy: { select: userSelect },
  updatedBy: { select: userSelect },
};
const tenantWhere = (req, id) => ({ id, tenantId: req.user.tenantId });
const parseIdList = (value) => {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isInteger);
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch (_err) {
    return [];
  }
};
const readTeamFields = (body, generic = false) => ({
  description: body?.description === undefined ? undefined : String(body.description || "").trim() || null,
  status: body?.status === "Inactive" ? "Inactive" : "Active",
  ...(generic ? {
    territoryMode: body?.territoryMode === "team" ? "team" : "individual",
    territoryId: body?.territoryMode === "team" && body?.territoryId !== null && body?.territoryId !== undefined && body?.territoryId !== ""
      ? (Number.isInteger(Number(body.territoryId)) && Number(body.territoryId) > 0 ? Number(body.territoryId) : null)
      : null,
  } : {}),
});
const syncGenericTeamTerritory = async (req, previousTerritoryId, nextTerritoryId, previousMemberIds, nextMemberIds) => {
  if (req.user.vertical !== "generic") return;
  const previousId = Number(previousTerritoryId) || null;
  const nextId = Number(nextTerritoryId) || null;
  const previousMembers = new Set((previousMemberIds || []).map(Number));
  const nextMembers = new Set((nextMemberIds || []).map(Number));
  if (previousId) {
    const previousTerritory = await prisma.territory.findFirst({ where: { id: previousId, tenantId: req.user.tenantId } });
    if (previousTerritory) {
      const assignedUserIds = parseIdList(previousTerritory.assignedUserIds).filter((userId) => !previousMembers.has(userId));
      if (previousId !== nextId) {
        await prisma.territory.update({ where: { id: previousTerritory.id }, data: { assignedUserIds: JSON.stringify(assignedUserIds) } });
      }
    }
  }
  if (nextId) {
    const nextTerritory = await prisma.territory.findFirst({ where: { id: nextId, tenantId: req.user.tenantId } });
    if (nextTerritory) {
      const assignedUserIds = new Set(parseIdList(nextTerritory.assignedUserIds));
      nextMembers.forEach((userId) => assignedUserIds.add(userId));
      if (previousId === nextId) previousMembers.forEach((userId) => assignedUserIds.delete(userId));
      nextMembers.forEach((userId) => assignedUserIds.add(userId));
      await prisma.territory.update({ where: { id: nextTerritory.id }, data: { assignedUserIds: JSON.stringify([...assignedUserIds]) } });
    }
  }
};
const resolveManagerId = async (req, res) => {
  if (req.body?.managerId === null || req.body?.managerId === "") return null;
  const managerId = Number(req.body?.managerId);
  if (!Number.isInteger(managerId) || managerId <= 0) {
    res.status(400).json({ error: "Select a valid team manager", code: "TEAM_MANAGER_INVALID" });
    return undefined;
  }
  const manager = await prisma.user.findFirst({
    where: { id: managerId, tenantId: req.user.tenantId, ...(req.user.vertical === "generic" ? {} : { role: { in: ["ADMIN", "MANAGER"] } }), deactivatedAt: null },
    select: { id: true },
  });
  if (!manager) {
    res.status(400).json({ error: "Team manager must be an active admin or manager in this organization", code: "TEAM_MANAGER_INVALID" });
    return undefined;
  }
  return manager.id;
};

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
    const managerId = req.body?.managerId === undefined ? null : await resolveManagerId(req, res);
    if (managerId === undefined) return;
    const users = await prisma.user.findMany({ where: { tenantId: req.user.tenantId, id: { in: memberIds } }, select: { id: true } });
    const teamFields = readTeamFields(req.body, req.user.vertical === "generic");
    const team = await prisma.salesTeam.create({ data: { name, ...teamFields, managerId, tenantId: req.user.tenantId, createdById: req.user.userId, updatedById: req.user.userId, members: { create: users.map(({ id }) => ({ userId: id, tenantId: req.user.tenantId })) } }, include: includeTeam });
    await syncGenericTeamTerritory(req, null, teamFields.territoryId, [], users.map(({ id }) => id));
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
    const existingMembers = await prisma.salesTeamMember.findMany({ where: { teamId: id, tenantId: req.user.tenantId }, select: { userId: true } });
    const previousMemberIds = existingMembers.map(({ userId }) => userId);
    const managerId = req.body?.managerId === undefined ? (existing.managerId ?? null) : await resolveManagerId(req, res);
    if (managerId === undefined) return;
    if (memberIds) {
      const users = await prisma.user.findMany({ where: { tenantId: req.user.tenantId, id: { in: memberIds } }, select: { id: true } });
      await prisma.salesTeamMember.deleteMany({ where: { teamId: id, tenantId: req.user.tenantId } });
      await prisma.salesTeamMember.createMany({ data: users.map(({ id: userId }) => ({ teamId: id, userId, tenantId: req.user.tenantId })) });
    }
    const teamFields = readTeamFields(req.body, req.user.vertical === "generic");
    const updated = await prisma.salesTeam.update({ where: { id }, data: { name, ...teamFields, managerId, updatedById: req.user.userId }, include: includeTeam });
    await syncGenericTeamTerritory(req, existing.territoryId, teamFields.territoryId, previousMemberIds, memberIds || previousMemberIds);
    res.json(updated);
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
