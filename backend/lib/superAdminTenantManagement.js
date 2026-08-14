"use strict";

// Super Admin tenant/subscription management + combined revenue analytics.
//
// Covers the CRM-PLATFORM subscription (what a tenant pays to use the CRM
// itself — SubscriptionPlan/Subscription, Razorpay-billed via
// routes/subscriptions.js) which had zero Super Admin visibility before this
// file. AI credit management (AiSubscriptionPlan/AiTenantSubscription/
// AiCreditWallet) is intentionally NOT duplicated here — that's fully owned
// by lib/aiProviderManagement.js's superAdminAdjustCredits/
// superAdminSetSubscriptionStatus; this file only reads AI state (via
// getTenantAiState) to show a combined snapshot per tenant.
//
// No schema migration was needed: `Subscription` rows are already created
// fresh per successful payment (see routes/subscriptions.js verify-payment —
// never updated in place for renewals), so they already function as a
// revenue ledger. `AiCreditOrder` already tracks AI purchases with
// paidAt/amount/status. A manually-granted Subscription is distinguished
// from a real payment purely by `razorpayPaymentId == null` — no new column.

const prisma = require("./prisma");
const aiProviderManagement = require("./aiProviderManagement");
const { writeAudit } = require("./audit");

// ── date helpers (local copy — aiProviderManagement's normalizeAnalyticsDate
// is not exported; this is a small pure utility, safe to duplicate) ────────
function normalizeAnalyticsDate(value, boundary = "start") {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const plainDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  let parsed;
  if (plainDate) {
    const [, year, month, day] = plainDate;
    parsed = new Date(
      boundary === "end"
        ? Date.UTC(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
        : Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0),
    );
  } else {
    parsed = new Date(raw);
  }

  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
}

function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function isManualGrant(sub) {
  return !sub?.razorpayPaymentId;
}

// Local copy of aiProviderManagement's notifyTenantAdmins (also not
// exported) — same shape, distinct entityType so notifications are
// traceable to this feature.
async function notifyTenantAdmins(tenantId, title, message, link = "/settings") {
  const admins = await prisma.user.findMany({
    where: { tenantId, role: "ADMIN" },
    select: { id: true },
    take: 25,
  });
  if (!admins.length) return;
  await prisma.notification.createMany({
    data: admins.map((admin) => ({
      tenantId,
      userId: admin.id,
      title,
      message,
      type: "system",
      priority: "high",
      link,
      entityType: "tenant-management",
    })),
  });
}

// ── Cross-tenant overview ───────────────────────────────────────────────
async function getSuperAdminTenantsOverview({ search = "", from, to } = {}) {
  const fromDate = normalizeAnalyticsDate(from, "start");
  const toDate = normalizeAnalyticsDate(to, "end");
  const searchTerm = String(search || "").trim().toLowerCase();

  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true, slug: true, ownerEmail: true, isActive: true, createdAt: true },
    orderBy: { name: "asc" },
  });

  const subRevenueWhere = { razorpayPaymentId: { not: null } };
  const aiRevenueWhere = { status: "PAID" };
  if (fromDate || toDate) {
    subRevenueWhere.createdAt = {};
    aiRevenueWhere.paidAt = {};
    if (fromDate) {
      subRevenueWhere.createdAt.gte = fromDate;
      aiRevenueWhere.paidAt.gte = fromDate;
    }
    if (toDate) {
      subRevenueWhere.createdAt.lte = toDate;
      aiRevenueWhere.paidAt.lte = toDate;
    }
  }

  const [paidSubs, paidAiOrders] = await Promise.all([
    prisma.subscription.findMany({ where: subRevenueWhere, select: { tenantId: true, amount: true } }),
    prisma.aiCreditOrder.findMany({ where: aiRevenueWhere, select: { tenantId: true, amount: true } }),
  ]);

  const revenueByTenant = new Map();
  for (const s of paidSubs) {
    revenueByTenant.set(s.tenantId, (revenueByTenant.get(s.tenantId) || 0) + Number(s.amount));
  }
  for (const o of paidAiOrders) {
    revenueByTenant.set(o.tenantId, (revenueByTenant.get(o.tenantId) || 0) + Number(o.amount));
  }

  const results = [];
  for (const tenant of tenants) {
    const [latestSub, aiState] = await Promise.all([
      prisma.subscription.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
      }),
      aiProviderManagement.getTenantAiState(tenant.id),
    ]);

    const row = {
      tenantId: tenant.id,
      organization: tenant.name,
      slug: tenant.slug,
      ownerEmail: tenant.ownerEmail || null,
      status: tenant.isActive ? "active" : "disabled",
      createdAt: tenant.createdAt,
      platformSubscription: latestSub
        ? {
            id: latestSub.id,
            planName: latestSub.planName,
            status: latestSub.status,
            amount: Number(latestSub.amount),
            currency: latestSub.currency,
            startDate: latestSub.startDate,
            endDate: latestSub.endDate,
            renewalDate: latestSub.renewalDate,
            isManualGrant: isManualGrant(latestSub),
          }
        : null,
      aiAccess: {
        resolverAccess: aiState.resolverAccess,
        balanceTokens: aiState.creditWallet.balanceTokens,
        percentRemaining: aiState.creditWallet.percentRemaining,
      },
      lifetimeRevenue: revenueByTenant.get(tenant.id) || 0,
    };

    if (searchTerm) {
      const haystack = [row.organization, row.slug, row.ownerEmail, String(row.tenantId)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchTerm)) continue;
    }
    results.push(row);
  }

  return {
    tenants: results,
    summary: {
      totalTenants: results.length,
      activePlatformSubs: results.filter((t) => t.platformSubscription?.status === "ACTIVE").length,
      activeAiSubs: results.filter((t) => t.aiAccess.resolverAccess === "crm-managed").length,
      totalLifetimeRevenue: results.reduce((sum, t) => sum + t.lifetimeRevenue, 0),
    },
    appliedFilters: {
      search: searchTerm,
      from: fromDate ? fromDate.toISOString() : null,
      to: toDate ? toDate.toISOString() : null,
    },
  };
}

// ── Single-tenant detail ────────────────────────────────────────────────
async function getSuperAdminTenantDetail(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, ownerEmail: true, isActive: true, vertical: true, createdAt: true },
  });
  if (!tenant) {
    const err = new Error("Tenant not found");
    err.code = "TENANT_NOT_FOUND";
    throw err;
  }

  const [users, platformSubscriptions, aiOrders, aiState] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId },
      select: { id: true, name: true, email: true, role: true, userType: true, subscriptionStatus: true, createdAt: true },
      orderBy: { id: "asc" },
    }),
    prisma.subscription.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.aiCreditOrder.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    aiProviderManagement.getTenantAiState(tenantId),
  ]);

  const platformTotal = platformSubscriptions
    .filter((s) => s.razorpayPaymentId)
    .reduce((sum, s) => sum + Number(s.amount), 0);
  const aiTotal = aiOrders
    .filter((o) => o.status === "PAID")
    .reduce((sum, o) => sum + Number(o.amount), 0);

  return {
    tenantId: tenant.id,
    organization: tenant.name,
    slug: tenant.slug,
    ownerEmail: tenant.ownerEmail || null,
    status: tenant.isActive ? "active" : "disabled",
    vertical: tenant.vertical,
    createdAt: tenant.createdAt,
    users,
    platformSubscriptions: platformSubscriptions.map((s) => ({
      id: s.id,
      planName: s.planName,
      status: s.status,
      amount: Number(s.amount),
      currency: s.currency,
      billingIntervalDays: s.billingIntervalDays,
      startDate: s.startDate,
      endDate: s.endDate,
      renewalDate: s.renewalDate,
      isManualGrant: isManualGrant(s),
      createdAt: s.createdAt,
    })),
    aiState,
    aiOrders: aiOrders.map((o) => ({
      id: o.id,
      planId: o.planId,
      amount: Number(o.amount),
      currency: o.currency,
      creditTokens: o.creditTokens,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
    })),
    revenue: {
      platformTotal,
      aiTotal,
      combinedTotal: platformTotal + aiTotal,
    },
  };
}

// ── Manual platform-subscription grant ──────────────────────────────────
//
// Supersedes rather than queues: the paid-purchase flow's
// reconcileSubscriptions (routes/subscriptions.js) implements a private,
// unexported state machine that stacks ACTIVE + SCHEDULED periods
// back-to-back. Replicating that queueing here would add real complexity
// for what is fundamentally an admin correction/comp action — this function
// just cancels any existing ACTIVE subscription and starts a fresh one now.
async function superAdminGrantSubscription({
  tenantId,
  planId,
  superAdminUsername,
  reason,
  customAmount,
  customDurationDays,
}) {
  if (!tenantId) {
    const err = new Error("tenantId is required");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (!planId) {
    const err = new Error("planId is required");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (!reason || !String(reason).trim()) {
    const err = new Error("A reason is required for a manual subscription grant.");
    err.code = "REASON_REQUIRED";
    throw err;
  }

  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: Number(planId) } });
  if (!plan) {
    const err = new Error("Subscription plan not found");
    err.code = "PLAN_NOT_FOUND";
    throw err;
  }

  // Subscription.userId is a required FK — attach to the tenant's earliest
  // ADMIN user (mirrors notifyTenantAdmins' "who represents this tenant"
  // convention used throughout the AI subscription system).
  const adminUser = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN" },
    orderBy: { id: "asc" },
  });
  if (!adminUser) {
    const err = new Error("This tenant has no ADMIN user to attach the subscription to.");
    err.code = "NO_ADMIN_USER";
    throw err;
  }

  const durationDays = Number(customDurationDays) > 0 ? Number(customDurationDays) : (plan.billingIntervalDays || 30);
  const hasCustomAmount = customAmount !== undefined && customAmount !== null && customAmount !== "";
  const amount = hasCustomAmount && Number.isFinite(Number(customAmount)) ? Number(customAmount) : Number(plan.price);

  const previousActive = await prisma.subscription.findFirst({
    where: { tenantId, status: "ACTIVE" },
  });
  if (previousActive) {
    await prisma.subscription.update({
      where: { id: previousActive.id },
      data: { status: "CANCELLED" },
    });
  }

  const now = new Date();
  const endDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const subscription = await prisma.subscription.create({
    data: {
      userId: adminUser.id,
      planId: plan.id,
      planName: plan.name,
      status: "ACTIVE",
      amount,
      currency: plan.currency,
      billingIntervalDays: durationDays,
      startDate: now,
      endDate,
      renewalDate: endDate,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      features: plan.features,
      tenantId,
    },
  });

  // Mirrors verify-payment's post-purchase User update exactly (status +
  // trialEndsAt clear) so a manually-granted subscription behaves
  // identically to a paid one from the tenant's perspective.
  await prisma.user.update({
    where: { id: adminUser.id },
    data: { subscriptionStatus: "ACTIVE", trialEndsAt: null },
  });

  await writeAudit("Subscription", "SUPER_ADMIN_GRANT", subscription.id, null, tenantId, {
    reason: String(reason).slice(0, 2000),
    performedBySuperAdmin: superAdminUsername,
    planId: plan.id,
    planName: plan.name,
    amount,
    durationDays,
    previousSubscriptionId: previousActive ? previousActive.id : null,
  });

  await notifyTenantAdmins(
    tenantId,
    "Your CRM subscription has been updated",
    `Your organization's CRM subscription plan is now "${plan.name}", granted by the platform administrator.`,
  );

  return subscription;
}

// ── Manual platform-subscription cancel ─────────────────────────────────
async function superAdminCancelPlatformSubscription({ tenantId, superAdminUsername, reason }) {
  if (!reason || !String(reason).trim()) {
    const err = new Error("A reason is required to cancel a subscription.");
    err.code = "REASON_REQUIRED";
    throw err;
  }

  const active = await prisma.subscription.findFirst({
    where: { tenantId, status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!active) {
    const err = new Error("This tenant has no active platform subscription to cancel.");
    err.code = "NO_ACTIVE_SUBSCRIPTION";
    throw err;
  }

  const updated = await prisma.subscription.update({
    where: { id: active.id },
    data: { status: "CANCELLED" },
  });

  await writeAudit("Subscription", "SUPER_ADMIN_CANCEL", active.id, null, tenantId, {
    reason: String(reason).slice(0, 2000),
    performedBySuperAdmin: superAdminUsername,
    planId: active.planId,
  });

  // Mirrors PATCH /:id/cancel's remaining-coverage check: only flip user
  // status when nothing ACTIVE/SCHEDULED is left for this tenant.
  const remainingCoverage = await prisma.subscription.findFirst({
    where: { tenantId, status: { in: ["ACTIVE", "SCHEDULED"] } },
  });
  if (!remainingCoverage) {
    await prisma.user.updateMany({
      where: { tenantId, subscriptionStatus: "ACTIVE" },
      data: { subscriptionStatus: "CANCELLED" },
    });
  }

  await notifyTenantAdmins(
    tenantId,
    "Your CRM subscription has been cancelled",
    "Your organization's CRM subscription has been cancelled by the platform administrator.",
  );

  return updated;
}

// ── Combined revenue analytics ──────────────────────────────────────────
//
// "Revenue" only ever counts real money collected: platform Subscription
// rows with a razorpayPaymentId, and AiCreditOrder rows with status=PAID.
// Manually-granted subscriptions (razorpayPaymentId null) and manual AI
// credit adjustments (aiCreditLedger.creditTokens — never creates an
// AiCreditOrder row) are correctly excluded automatically.
async function getSuperAdminRevenueSummary({ from, to } = {}) {
  const fromDate = normalizeAnalyticsDate(from, "start");
  const toDate = normalizeAnalyticsDate(to, "end");

  const subWhere = { razorpayPaymentId: { not: null } };
  const aiWhere = { status: "PAID" };
  if (fromDate || toDate) {
    subWhere.createdAt = {};
    aiWhere.paidAt = {};
    if (fromDate) {
      subWhere.createdAt.gte = fromDate;
      aiWhere.paidAt.gte = fromDate;
    }
    if (toDate) {
      subWhere.createdAt.lte = toDate;
      aiWhere.paidAt.lte = toDate;
    }
  }

  const [paidSubs, paidAiOrders, activeSubs] = await Promise.all([
    prisma.subscription.findMany({
      where: subWhere,
      select: { tenantId: true, amount: true, createdAt: true, tenant: { select: { name: true } } },
    }),
    prisma.aiCreditOrder.findMany({
      where: aiWhere,
      select: { tenantId: true, amount: true, paidAt: true, tenant: { select: { name: true } } },
    }),
    prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      select: { amount: true, billingIntervalDays: true, planName: true },
    }),
  ]);

  const platformRevenue = paidSubs.reduce((sum, s) => sum + Number(s.amount), 0);
  const aiRevenue = paidAiOrders.reduce((sum, o) => sum + Number(o.amount), 0);
  // Normalized to a 30-day month so plans with different billing intervals
  // (weekly/quarterly/annual) contribute comparably. Platform-only — AI
  // credit packs are mostly one-time and don't map cleanly onto "recurring".
  const currentPlatformMRR = activeSubs.reduce((sum, s) => {
    const days = s.billingIntervalDays || 30;
    return sum + Number(s.amount) * (30 / days);
  }, 0);

  const trendMap = new Map();
  for (const s of paidSubs) {
    const key = monthKey(s.createdAt);
    const bucket = trendMap.get(key) || { month: key, platformRevenue: 0, aiRevenue: 0 };
    bucket.platformRevenue += Number(s.amount);
    trendMap.set(key, bucket);
  }
  for (const o of paidAiOrders) {
    const key = monthKey(o.paidAt);
    const bucket = trendMap.get(key) || { month: key, platformRevenue: 0, aiRevenue: 0 };
    bucket.aiRevenue += Number(o.amount);
    trendMap.set(key, bucket);
  }
  const monthlyTrend = Array.from(trendMap.values())
    .map((b) => ({ ...b, totalRevenue: b.platformRevenue + b.aiRevenue }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const planMixMap = new Map();
  for (const s of activeSubs) {
    planMixMap.set(s.planName, (planMixMap.get(s.planName) || 0) + 1);
  }
  const planMix = Array.from(planMixMap.entries()).map(([planName, count]) => ({ planName, count }));

  const tenantRevenueMap = new Map();
  for (const s of paidSubs) {
    const entry = tenantRevenueMap.get(s.tenantId) || {
      tenantId: s.tenantId,
      tenantName: s.tenant?.name || `Tenant #${s.tenantId}`,
      revenue: 0,
    };
    entry.revenue += Number(s.amount);
    tenantRevenueMap.set(s.tenantId, entry);
  }
  for (const o of paidAiOrders) {
    const entry = tenantRevenueMap.get(o.tenantId) || {
      tenantId: o.tenantId,
      tenantName: o.tenant?.name || `Tenant #${o.tenantId}`,
      revenue: 0,
    };
    entry.revenue += Number(o.amount);
    tenantRevenueMap.set(o.tenantId, entry);
  }
  const topTenants = Array.from(tenantRevenueMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    totals: {
      platformRevenue,
      aiRevenue,
      combinedRevenue: platformRevenue + aiRevenue,
      currentPlatformMRR: Math.round(currentPlatformMRR * 100) / 100,
    },
    monthlyTrend,
    planMix,
    topTenants,
    appliedFilters: {
      from: fromDate ? fromDate.toISOString() : null,
      to: toDate ? toDate.toISOString() : null,
    },
  };
}

module.exports = {
  getSuperAdminTenantsOverview,
  getSuperAdminTenantDetail,
  superAdminGrantSubscription,
  superAdminCancelPlatformSubscription,
  getSuperAdminRevenueSummary,
};
