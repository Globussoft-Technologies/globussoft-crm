const express = require("express");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");

const router = express.Router();

const IDENTIFIER = /^[a-z0-9][a-z0-9_.:-]{0,99}$/i;
const EVENT_TYPES = new Set([
  "ANNOUNCEMENT_VIEWED",
  "ANNOUNCEMENT_DISMISSED",
  "CHECKLIST_OPENED",
  "CHECKLIST_ACTIONED",
  "TOUR_STARTED",
  "TOUR_COMPLETED",
  "TOUR_ABANDONED",
  "TOUR_SKIPPED",
  "TOUR_STEP_SKIPPED",
  "TOUR_TARGET_MISSING",
  "FEATURE_NOT_FOUND",
]);

const CHECKLIST = [
  { key: "first-contact", label: "Create your first contact", path: "/contacts", roles: ["ADMIN", "MANAGER", "USER"] },
  { key: "first-lead", label: "Create your first lead", path: "/leads", roles: ["ADMIN", "MANAGER", "USER"] },
  { key: "first-deal", label: "Create your first deal", path: "/pipeline", roles: ["ADMIN", "MANAGER", "USER"] },
  { key: "invite-staff", label: "Invite a staff member", path: "/staff", roles: ["ADMIN"] },
  { key: "configure-email-calendar", label: "Configure email or calendar", path: "/calendar-sync", roles: ["ADMIN", "MANAGER", "USER"] },
  { key: "first-report", label: "Create your first report", path: "/custom-reports", roles: ["ADMIN", "MANAGER"] },
];

function parseObject(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && IDENTIFIER.test(item)).slice(0, 100) : [];
  } catch {
    return [];
  }
}

function isIdentifier(value, max = 100) {
  return value == null || (typeof value === "string" && value.length <= max && IDENTIFIER.test(value));
}

function requireAnalyticsAccess(req, res, next) {
  if (["ADMIN", "MANAGER"].includes(String(req.onboardingUser?.role || "").toUpperCase()) || req.user?.isOwner) return next();
  return res.status(403).json({ error: "You don't have permission to view onboarding analytics", code: "RBAC_DENIED" });
}

async function findProgress(req) {
  return prisma.userTourProgress.findUnique({
    where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } },
  });
}

async function persistOnboarding(req, checklist, dismissedAnnouncements) {
  const data = {
    checklistJson: sanitizeJsonForStringColumn(checklist),
    dismissedAnnouncementsJson: sanitizeJsonForStringColumn(dismissedAnnouncements),
  };
  return prisma.userTourProgress.upsert({
    where: { tenantId_userId: { tenantId: req.user.tenantId, userId: req.user.userId } },
    create: {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      preferencesJson: "{}",
      progressJson: "{}",
      ...data,
    },
    update: data,
  });
}

async function achievedMilestones(req) {
  const tenantId = req.user.tenantId;
  const userId = req.user.userId;
  const [contacts, leads, deals, staff, calendar, gmail, reports] = await Promise.all([
    prisma.contact.count({ where: { tenantId } }),
    prisma.lead.count({ where: { tenantId } }),
    prisma.deal.count({ where: { tenantId } }),
    prisma.user.count({ where: { tenantId, userType: "STAFF", deactivatedAt: null, id: { not: userId } } }),
    prisma.calendarIntegration.count({ where: { tenantId, userId, syncEnabled: true } }),
    prisma.gmailIntegration.count({ where: { tenantId, userId, syncEnabled: true } }),
    prisma.customReport.count({ where: { tenantId } }),
  ]);
  return {
    "first-contact": contacts > 0,
    "first-lead": leads > 0,
    "first-deal": deals > 0,
    "invite-staff": staff > 0,
    "configure-email-calendar": calendar + gmail > 0,
    "first-report": reports > 0,
  };
}

router.use(verifyToken);
router.use(async (req, res, next) => {
  try {
    req.onboardingUser = await prisma.user.findFirst({
      where: { id: req.user.userId, tenantId: req.user.tenantId },
      select: { id: true, role: true },
    });
    if (!req.onboardingUser) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    return next();
  } catch (_error) {
    return res.status(500).json({ error: "Failed to verify onboarding user", code: "ONBOARDING_USER_READ_FAILED" });
  }
});

router.get("/state", async (req, res) => {
  try {
    const row = await findProgress(req);
    const saved = parseObject(row?.checklistJson);
    const achieved = await achievedMilestones(req);
    const now = new Date().toISOString();
    const checklist = { ...saved };
    for (const item of CHECKLIST) {
      if (achieved[item.key] && !checklist[item.key]?.completedAt) {
        checklist[item.key] = { completedAt: now };
      }
    }
    const dismissedAnnouncements = parseArray(row?.dismissedAnnouncementsJson);
    if (JSON.stringify(checklist) !== JSON.stringify(saved)) {
      await persistOnboarding(req, checklist, dismissedAnnouncements);
    }
    const role = String(req.onboardingUser.role || "USER").toUpperCase();
    const items = CHECKLIST.filter((item) => item.roles.includes(role)).map((item) => ({
      key: item.key,
      label: item.label,
      path: item.path,
      completedAt: checklist[item.key]?.completedAt || null,
    }));
    const completed = items.filter((item) => item.completedAt).length;
    return res.json({
      checklist: items,
      completed,
      total: items.length,
      completionPercentage: items.length ? Math.round((completed / items.length) * 100) : 100,
      dismissedAnnouncements,
    });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to load onboarding state", code: "ONBOARDING_READ_FAILED" });
  }
});

router.put("/announcements/:announcementId/dismiss", async (req, res) => {
  try {
    const announcementId = req.params.announcementId;
    if (!isIdentifier(announcementId)) {
      return res.status(400).json({ error: "Invalid announcement ID", code: "INVALID_ANNOUNCEMENT_ID" });
    }
    const row = await findProgress(req);
    const checklist = parseObject(row?.checklistJson);
    const dismissed = parseArray(row?.dismissedAnnouncementsJson);
    const dismissedAnnouncements = dismissed.includes(announcementId) ? dismissed : [...dismissed, announcementId].slice(-100);
    await persistOnboarding(req, checklist, dismissedAnnouncements);
    return res.json({ dismissedAnnouncements });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to dismiss announcement", code: "ANNOUNCEMENT_DISMISS_FAILED" });
  }
});

router.post("/events", async (req, res) => {
  try {
    const { eventType, featureKey = null, tourKey = null, stepKey = null, reason = null, sessionId = null } = req.body || {};
    if (!EVENT_TYPES.has(eventType)
      || !isIdentifier(featureKey)
      || !isIdentifier(tourKey)
      || !isIdentifier(stepKey)
      || !isIdentifier(reason, 80)
      || !isIdentifier(sessionId, 64)) {
      return res.status(400).json({ error: "Invalid onboarding event", code: "INVALID_ONBOARDING_EVENT" });
    }
    await prisma.onboardingEvent.create({
      data: { tenantId: req.user.tenantId, userId: req.user.userId, eventType, featureKey, tourKey, stepKey, reason, sessionId },
    });
    return res.status(201).json({ recorded: true });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to record onboarding event", code: "ONBOARDING_EVENT_WRITE_FAILED" });
  }
});

router.get("/analytics", requireAnalyticsAccess, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [byType, skippedSteps, missingTargets, featuresNotFound] = await Promise.all([
      prisma.onboardingEvent.groupBy({ by: ["eventType"], where: { tenantId }, _count: { _all: true } }),
      prisma.onboardingEvent.groupBy({ by: ["tourKey", "stepKey"], where: { tenantId, eventType: "TOUR_STEP_SKIPPED" }, _count: { _all: true } }),
      prisma.onboardingEvent.groupBy({ by: ["tourKey", "stepKey", "reason"], where: { tenantId, eventType: "TOUR_TARGET_MISSING" }, _count: { _all: true } }),
      prisma.onboardingEvent.groupBy({ by: ["featureKey"], where: { tenantId, eventType: "FEATURE_NOT_FOUND" }, _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(byType.map((row) => [row.eventType, row._count._all]));
    const starts = counts.TOUR_STARTED || 0;
    const completed = counts.TOUR_COMPLETED || 0;
    const abandoned = counts.TOUR_ABANDONED || 0;
    return res.json({
      tours: {
        started: starts,
        completed,
        abandoned,
        completionRate: starts ? Math.round((completed / starts) * 100) : 0,
        abandonmentRate: starts ? Math.round((abandoned / starts) * 100) : 0,
      },
      skippedSteps: skippedSteps.map((row) => ({ tourKey: row.tourKey, stepKey: row.stepKey, count: row._count._all })).sort((a, b) => b.count - a.count).slice(0, 20),
      missingTargets: missingTargets.map((row) => ({ tourKey: row.tourKey, stepKey: row.stepKey, reason: row.reason, count: row._count._all })).sort((a, b) => b.count - a.count).slice(0, 20),
      featuresNotFound: featuresNotFound.map((row) => ({ featureKey: row.featureKey, count: row._count._all })).sort((a, b) => b.count - a.count).slice(0, 20),
      privacy: "Only allowlisted product identifiers and aggregate counts are stored; CRM record data and search text are excluded.",
    });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to load onboarding analytics", code: "ONBOARDING_ANALYTICS_READ_FAILED" });
  }
});

module.exports = router;
