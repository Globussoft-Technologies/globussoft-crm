const prisma = require('./prisma');

async function resolveSubscriptionAccess(user) {
  if (!user || !user.userId || !user.tenantId) return null;

  const now = new Date();
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: {
      id: true,
      subscriptionStatus: true,
      trialEndsAt: true,
    },
  });

  if (!dbUser) return null;

  const activeCoverage = await prisma.subscription.findFirst({
    where: {
      tenantId: user.tenantId,
      status: { in: ['ACTIVE', 'SCHEDULED'] },
      startDate: { lte: now },
      endDate: { gt: now },
    },
    orderBy: [
      { endDate: 'desc' },
      { startDate: 'desc' },
    ],
  });

  const trialEndsAt = dbUser.trialEndsAt || null;
  const trialStillValid = !!trialEndsAt && now <= new Date(trialEndsAt);
  const daysRemaining = trialEndsAt
    ? Math.max(0, Math.ceil((new Date(trialEndsAt) - now) / (1000 * 60 * 60 * 24)))
    : 0;

  let subscriptionStatus;
  if (activeCoverage) {
    subscriptionStatus = 'ACTIVE';
  } else if (dbUser.subscriptionStatus === 'TRIAL' && trialStillValid) {
    subscriptionStatus = 'TRIAL';
  } else if (dbUser.subscriptionStatus === 'CANCELLED') {
    subscriptionStatus = 'CANCELLED';
  } else if (dbUser.subscriptionStatus === 'TRIAL') {
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
};
