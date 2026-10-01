const prisma = require('./prisma');

async function getTenantCoverage(tenantId, now = new Date()) {
  if (!tenantId) return null;
  const coverage = await prisma.subscription.findFirst({
    where: {
      tenantId,
      status: { in: ['ACTIVE', 'SCHEDULED'] },
      startDate: { lte: now },
      endDate: { gt: now },
    },
    orderBy: [
      { endDate: 'desc' },
      { startDate: 'desc' },
    ],
  });
  return coverage;
}

async function hasTenantSubscriptionCoverage(tenantId, now = new Date()) {
  return !!(await getTenantCoverage(tenantId, now));
}

async function getTenantTrialEnd(tenantId, now = new Date()) {
  // Once a clinic has purchased a plan, an old personal trial cannot reopen
  // the workspace after that paid period expires.
  const previousPurchase = await prisma.subscription.findFirst({
    where: { tenantId },
    select: { id: true },
  });
  if (previousPurchase) return null;
  const trialAdmin = await prisma.user.findFirst({
    where: {
      tenantId,
      role: 'ADMIN',
      subscriptionStatus: 'TRIAL',
      trialEndsAt: { gte: now },
      deactivatedAt: null,
    },
    select: { trialEndsAt: true },
  });
  return trialAdmin?.trialEndsAt || null;
}

// Patients and staff share the clinic's paid coverage or original admin trial.
async function hasTenantPortalAccess(tenantId, now = new Date()) {
  if (await hasTenantSubscriptionCoverage(tenantId, now)) return true;
  return !!(await getTenantTrialEnd(tenantId, now));
}

async function resolveSubscriptionAccess(user) {
  if (!user || !user.userId || !user.tenantId) return null;

  const now = new Date();
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { id: true },
  });

  if (!dbUser) return null;

  const activeCoverage = await getTenantCoverage(user.tenantId, now);
  const tenantTrialEndsAt = activeCoverage ? null : await getTenantTrialEnd(user.tenantId, now);

  const trialEndsAt = tenantTrialEndsAt;
  const trialStillValid = !!trialEndsAt;
  const daysRemaining = trialEndsAt
    ? Math.max(0, Math.ceil((new Date(trialEndsAt) - now) / (1000 * 60 * 60 * 24)))
    : 0;

  let subscriptionStatus;
  if (activeCoverage) {
    subscriptionStatus = 'ACTIVE';
  } else if (trialStillValid) {
    subscriptionStatus = 'TRIAL';
  } else {
    subscriptionStatus = 'EXPIRED';
  }

  const resolved = {
    userId: dbUser.id,
    tenantId: user.tenantId,
    subscriptionStatus,
    trialEndsAt,
    daysRemaining,
    trialDaysRemaining: subscriptionStatus === 'TRIAL' ? daysRemaining : 0,
    hasActiveCoverage: !!activeCoverage,
  };

  user.subscriptionStatus = resolved.subscriptionStatus;
  user.trialEndsAt = resolved.trialEndsAt;
  user.daysRemaining = resolved.daysRemaining;

  return resolved;
}

module.exports = {
  resolveSubscriptionAccess,
  hasTenantSubscriptionCoverage,
  hasTenantPortalAccess,
};
