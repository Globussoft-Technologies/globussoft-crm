const express = require("express");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");

const router = express.Router();
const STATUSES = new Set(["IN_PROGRESS", "COMPLETED", "DISMISSED"]);
const TOUR_KEY = /^[a-z0-9][a-z0-9-]{0,99}:\d{1,6}$/;
const DEFAULT_PREFERENCES = { enabled: true, autoStart: true };

function parseObject(value, fallback) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function asIso(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serialize(row, organizationEnabled = true) {
  if (!row) {
    return { preferences: { ...DEFAULT_PREFERENCES }, progress: {}, progressResetAt: null, organizationEnabled, updatedAt: null };
  }
  const progressResetAt = row.progressResetAt ? new Date(row.progressResetAt).toISOString() : null;
  const resetTime = progressResetAt ? Date.parse(progressResetAt) : 0;
  const progress = Object.fromEntries(Object.entries(parseObject(row.progressJson, {}))
    .filter(([, item]) => Date.parse(item?.updatedAt || "") > resetTime));
  return {
    preferences: { ...DEFAULT_PREFERENCES, ...parseObject(row.preferencesJson, {}) },
    progress,
    progressResetAt,
    organizationEnabled,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

function validatePreferences(value, partial = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["enabled", "autoStart"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") return null;
    result[key] = value[key];
  }
  if (!partial && Object.keys(result).length !== 2) return null;
  const updatedAt = asIso(value.updatedAt);
  if (value.updatedAt != null && !updatedAt) return null;
  if (updatedAt) result.updatedAt = updatedAt;
  return result;
}

function validateProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 250) return null;
  const clean = {};
  for (const [key, item] of entries) {
    if (!TOUR_KEY.test(key) || !item || typeof item !== "object" || !STATUSES.has(item.status)) return null;
    const currentStep = Number(item.currentStep);
    const updatedAt = asIso(item.updatedAt);
    if (!Number.isInteger(currentStep) || currentStep < 0 || currentStep > 500 || !updatedAt) return null;
    clean[key] = { status: item.status, currentStep, updatedAt };
    for (const timestamp of ["completedAt", "dismissedAt"]) {
      if (item[timestamp] !== undefined) {
        const normalized = asIso(item[timestamp]);
        if (!normalized) return null;
        clean[key][timestamp] = normalized;
      }
    }
  }
  return clean;
}

function time(value) {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeStates(stored, incoming) {
  const progressResetAt = time(incoming.progressResetAt) >= time(stored.progressResetAt)
    ? incoming.progressResetAt
    : stored.progressResetAt;
  const resetTime = time(progressResetAt);
  const progress = {};
  for (const key of new Set([...Object.keys(stored.progress), ...Object.keys(incoming.progress)])) {
    const storedItem = stored.progress[key];
    const incomingItem = incoming.progress[key];
    const winner = time(incomingItem?.updatedAt) >= time(storedItem?.updatedAt) ? incomingItem : storedItem;
    if (winner && time(winner.updatedAt) > resetTime) progress[key] = winner;
  }
  const preferences = time(incoming.preferences.updatedAt) >= time(stored.preferences.updatedAt)
    ? incoming.preferences
    : stored.preferences;
  return { preferences, progress, progressResetAt };
}

async function ownedUser(req) {
  return prisma.user.findFirst({
    where: { id: req.user.userId, tenantId: req.user.tenantId },
    select: { id: true, tenant: { select: { productToursEnabled: true } } },
  });
}

function organizationEnabled(user) {
  return user?.tenant?.productToursEnabled !== false;
}

function requireTourAdmin(req, res, next) {
  if (req.user?.isOwner || req.user?.role === "OWNER" || req.user?.role === "ADMIN") return next();
  return res.status(403).json({
    error: "You don't have permission to perform this action. Contact your administrator.",
    code: "RBAC_DENIED",
  });
}

async function findState(req) {
  return prisma.userTourProgress.findUnique({
    where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } },
  });
}

async function saveState(req, preferences, progress, progressResetAt) {
  return prisma.userTourProgress.upsert({
    where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } },
    create: {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      preferencesJson: sanitizeJsonForStringColumn(preferences),
      progressJson: sanitizeJsonForStringColumn(progress),
      progressResetAt,
    },
    update: {
      preferencesJson: sanitizeJsonForStringColumn(preferences),
      progressJson: sanitizeJsonForStringColumn(progress),
      progressResetAt,
    },
  });
}

router.use(verifyToken);

router.get("/state", async (req, res) => {
  try {
    const user = await ownedUser(req);
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    return res.json(serialize(await findState(req), organizationEnabled(user)));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to load tour progress", code: "TOUR_PROGRESS_READ_FAILED" });
  }
});

router.put("/state", async (req, res) => {
  try {
    const preferences = validatePreferences(req.body?.preferences);
    const progress = validateProgress(req.body?.progress);
    const resetIso = asIso(req.body?.progressResetAt);
    if (!preferences || !progress || (req.body?.progressResetAt && !resetIso)) {
      return res.status(400).json({ error: "Invalid tour state", code: "INVALID_TOUR_STATE" });
    }
    const user = await ownedUser(req);
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    const merged = mergeStates(serialize(await findState(req)), {
      preferences,
      progress,
      progressResetAt: resetIso,
    });
    const row = await saveState(req, merged.preferences, merged.progress, merged.progressResetAt ? new Date(merged.progressResetAt) : null);
    return res.json(serialize(row, organizationEnabled(user)));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to save tour progress", code: "TOUR_PROGRESS_WRITE_FAILED" });
  }
});

router.put("/preferences", async (req, res) => {
  try {
    const patch = validatePreferences(req.body, true);
    if (!patch || !Object.keys(patch).some((key) => key !== "updatedAt")) {
      return res.status(400).json({ error: "Invalid tour preferences", code: "INVALID_TOUR_PREFERENCES" });
    }
    const user = await ownedUser(req);
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    const existing = await findState(req);
    const current = serialize(existing);
    const preferences = { ...current.preferences, ...patch, updatedAt: new Date().toISOString() };
    const row = await saveState(req, preferences, current.progress, current.progressResetAt ? new Date(current.progressResetAt) : null);
    return res.json(serialize(row, organizationEnabled(user)));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to save tour preferences", code: "TOUR_PREFERENCES_WRITE_FAILED" });
  }
});

router.put("/progress/:tourKey", async (req, res) => {
  try {
    const key = req.params.tourKey;
    const progressItem = validateProgress({ [key]: { ...req.body, updatedAt: new Date().toISOString() } });
    if (!progressItem) return res.status(400).json({ error: "Invalid tour progress", code: "INVALID_TOUR_PROGRESS" });
    const user = await ownedUser(req);
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    const existing = await findState(req);
    const current = serialize(existing);
    const progress = { ...current.progress, [key]: progressItem[key] };
    const row = await saveState(req, current.preferences, progress, current.progressResetAt ? new Date(current.progressResetAt) : null);
    return res.json(serialize(row, organizationEnabled(user)));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to save tour progress", code: "TOUR_PROGRESS_WRITE_FAILED" });
  }
});

router.delete("/progress", async (req, res) => {
  try {
    const user = await ownedUser(req);
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    const existing = await findState(req);
    const current = serialize(existing);
    const resetAt = new Date();
    const row = await saveState(req, current.preferences, {}, resetAt);
    return res.json(serialize(row, organizationEnabled(user)));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to reset tour progress", code: "TOUR_PROGRESS_WRITE_FAILED" });
  }
});

router.get("/organization-preferences", async (req, res) => {
  try {
    const user = await ownedUser(req);
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    return res.json({ organizationEnabled: organizationEnabled(user) });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to load organization tour preferences", code: "TOUR_ORGANIZATION_READ_FAILED" });
  }
});

router.put("/organization-preferences", requireTourAdmin, async (req, res) => {
  try {
    if (typeof req.body?.organizationEnabled !== "boolean") {
      return res.status(400).json({ error: "organizationEnabled must be a boolean", code: "INVALID_TOUR_ORGANIZATION_PREFERENCES" });
    }
    const result = await prisma.tenant.updateMany({
      where: { id: req.user.tenantId },
      data: { productToursEnabled: req.body.organizationEnabled },
    });
    if (result.count === 0) return res.status(404).json({ error: "Organization not found", code: "TENANT_NOT_FOUND" });
    return res.json({ organizationEnabled: req.body.organizationEnabled });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to save organization tour preferences", code: "TOUR_ORGANIZATION_WRITE_FAILED" });
  }
});

module.exports = router;
