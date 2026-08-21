"use strict";

// Super Admin AI Subscription Plan catalog — replaces the old manual
// per-tenant custom-price approval flow. Plans are reusable and tenant-
// facing (GET /api/ai-subscriptions/plans); everything configurable here
// flows straight through to the tenant purchase page, nothing hardcoded.

const prisma = require("./prisma");

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

function formatPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || "",
    price: parseFloat(plan.price),
    currency: plan.currency,
    billingCycle: plan.billingCycle,
    creditTokens: plan.creditTokens,
    fairUsagePolicy: plan.fairUsagePolicy || "",
    featureRestrictions: parseJsonArray(plan.featureRestrictions),
    validityDays: plan.validityDays,
    isActive: plan.isActive,
    displayOrder: plan.displayOrder,
    apiKeys: Array.isArray(plan.planKeys)
      ? plan.planKeys
          .filter((pk) => pk.apiKey)
          .map((pk) => ({
            keyId: pk.keyId,
            providerId: pk.apiKey.providerId,
            label: pk.apiKey.label,
            model: pk.apiKey.model || null,
            isEnabled: pk.isEnabled,
          }))
      : [],
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

async function listPublicPlans() {
  const plans = await prisma.aiSubscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: [{ displayOrder: "asc" }, { price: "asc" }],
    take: 100,
    include: { planKeys: { include: { apiKey: true } } },
  });
  return plans.map(formatPlan);
}

async function listAllPlans() {
  const plans = await prisma.aiSubscriptionPlan.findMany({
    orderBy: [{ displayOrder: "asc" }, { price: "asc" }],
    take: 200,
    include: { planKeys: { include: { apiKey: true } } },
  });
  return plans.map(formatPlan);
}

function toNum(dec) {
  if (dec == null) return 0;
  if (typeof dec === "number") return dec;
  if (typeof dec.toNumber === "function") return dec.toNumber();
  return Number(dec) || 0;
}

function validatePlanInput(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (!partial || body.name !== undefined) {
    if (!body.name || !String(body.name).trim()) errors.push("name is required");
    else data.name = String(body.name).trim();
  }
  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) errors.push("price must be a non-negative number");
    else data.price = price;
  }
  if (!partial || body.creditTokens !== undefined) {
    const tokens = Number(body.creditTokens);
    if (!Number.isInteger(tokens) || tokens <= 0) errors.push("creditTokens must be a positive integer");
    else data.creditTokens = tokens;
  }
  if (body.currency !== undefined) data.currency = String(body.currency || "INR").toUpperCase();
  if (body.billingCycle !== undefined) {
    const cycle = String(body.billingCycle || "monthly").toLowerCase();
    if (!["monthly", "one_time"].includes(cycle)) errors.push("billingCycle must be 'monthly' or 'one_time'");
    else data.billingCycle = cycle;
  }
  if (body.description !== undefined) data.description = body.description ? String(body.description).slice(0, 4000) : null;
  if (body.fairUsagePolicy !== undefined) data.fairUsagePolicy = body.fairUsagePolicy ? String(body.fairUsagePolicy).slice(0, 4000) : null;
  if (body.featureRestrictions !== undefined) {
    data.featureRestrictions = Array.isArray(body.featureRestrictions) && body.featureRestrictions.length
      ? JSON.stringify(body.featureRestrictions)
      : null;
  }
  if (body.validityDays !== undefined) {
    data.validityDays = body.validityDays == null || body.validityDays === "" ? null : Number(body.validityDays);
  }
  if (body.displayOrder !== undefined) data.displayOrder = Number(body.displayOrder) || 0;
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

  return { errors, data };
}

function normalizeApiKeys(body) {
  if (!body.apiKeys || !Array.isArray(body.apiKeys)) return [];
  const seen = new Set();
  return body.apiKeys
    .filter((k) => k && Number.isFinite(Number(k.keyId)))
    .map((k) => ({ keyId: Number(k.keyId), isEnabled: k.isEnabled !== false }))
    .filter((k) => {
      if (seen.has(k.keyId)) return false;
      seen.add(k.keyId);
      return true;
    });
}

async function assertPlanApiKeysAttachable(apiKeys, client = prisma) {
  if (!apiKeys.length) return;
  const ids = apiKeys.map((k) => k.keyId);
  const rows = await client.aiManagedApiKey.findMany({
    where: { id: { in: ids } },
    select: { id: true, isEnabled: true },
  });
  const enabledIds = new Set(rows.filter((row) => row.isEnabled).map((row) => row.id));
  const invalidIds = ids.filter((id) => !enabledIds.has(id));
  if (invalidIds.length) {
    const err = new Error(`apiKeys include disabled or unknown key id(s): ${invalidIds.join(", ")}`);
    err.code = "INVALID_PLAN_INPUT";
    throw err;
  }
}

async function createPlan(body) {
  const { errors, data } = validatePlanInput(body, { partial: false });
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.code = "INVALID_PLAN_INPUT";
    throw err;
  }
  const apiKeys = normalizeApiKeys(body);
  await assertPlanApiKeysAttachable(apiKeys);
  const plan = await prisma.aiSubscriptionPlan.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      price: data.price,
      currency: data.currency || "INR",
      billingCycle: data.billingCycle || "monthly",
      creditTokens: data.creditTokens,
      fairUsagePolicy: data.fairUsagePolicy ?? null,
      featureRestrictions: data.featureRestrictions ?? null,
      validityDays: data.validityDays ?? null,
      displayOrder: data.displayOrder ?? 0,
      isActive: data.isActive !== false,
      planKeys: apiKeys.length ? { create: apiKeys } : undefined,
    },
    include: { planKeys: { include: { apiKey: true } } },
  });
  return formatPlan(plan);
}

async function updatePlan(planId, body) {
  const { errors, data } = validatePlanInput(body, { partial: true });
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.code = "INVALID_PLAN_INPUT";
    throw err;
  }
  const apiKeys = normalizeApiKeys(body);
  const plan = await prisma.$transaction(async (tx) => {
    await assertPlanApiKeysAttachable(apiKeys, tx);
    const updated = await tx.aiSubscriptionPlan.update({
      where: { id: planId },
      data,
    });
    if (body.apiKeys !== undefined) {
      await tx.aiSubscriptionPlanKey.deleteMany({ where: { planId: updated.id } });
      if (apiKeys.length) {
        await tx.aiSubscriptionPlanKey.createMany({ data: apiKeys.map((k) => ({ ...k, planId: updated.id })) });
      }
    }
    return tx.aiSubscriptionPlan.findUnique({
      where: { id: updated.id },
      include: { planKeys: { include: { apiKey: true } } },
    });
  });
  return formatPlan(plan);
}

// Soft-delete only (isActive=false) — AiCreditOrder/AiTenantSubscription
// rows reference the plan; hard-delete would orphan purchase history.
async function deactivatePlan(planId) {
  const plan = await prisma.aiSubscriptionPlan.update({
    where: { id: planId },
    data: { isActive: false },
  });
  return formatPlan(plan);
}

async function getPlanSubscriberAnalytics(planId, options = {}) {
  const from = options.from ? new Date(options.from) : null;
  const to = options.to ? new Date(options.to) : null;
  if (from && Number.isNaN(from.getTime())) {
    const err = new Error("Invalid from date");
    err.code = "INVALID_DATE";
    throw err;
  }
  if (to && Number.isNaN(to.getTime())) {
    const err = new Error("Invalid to date");
    err.code = "INVALID_DATE";
    throw err;
  }
  if (to) to.setUTCHours(23, 59, 59, 999);

  const plan = await prisma.aiSubscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) {
    const err = new Error("AI subscription plan not found");
    err.code = "PLAN_NOT_FOUND";
    throw err;
  }

  const [subscriptions, orders] = await Promise.all([
    prisma.aiTenantSubscription.findMany({
      where: { planId },
      orderBy: [{ startDate: "desc" }],
      include: { tenant: { select: { id: true, name: true, slug: true, ownerEmail: true, isActive: true } } },
    }),
    prisma.aiCreditOrder.findMany({
      where: { planId, status: "PAID" },
      orderBy: { paidAt: "desc" },
      select: {
        id: true,
        tenantId: true,
        purchasedByUserId: true,
        amount: true,
        currency: true,
        creditTokens: true,
        paidAt: true,
        createdAt: true,
      },
    }),
  ]);

  const tenantIds = [...new Set([
    ...subscriptions.map((s) => s.tenantId),
    ...orders.map((o) => o.tenantId),
  ])];
  const purchaserUserIds = [...new Set(orders.map((o) => o.purchasedByUserId).filter(Boolean))];

  const createdAt = {};
  if (from) createdAt.gte = from;
  if (to) createdAt.lte = to;
  const hasDateFilter = Boolean(from || to);

  const [wallets, users, logs, transactions] = tenantIds.length
    ? await Promise.all([
        prisma.aiCreditWallet.findMany({ where: { tenantId: { in: tenantIds } } }),
        purchaserUserIds.length
          ? prisma.user.findMany({
              where: { id: { in: purchaserUserIds } },
              select: { id: true, email: true, name: true, tenantId: true },
            })
          : Promise.resolve([]),
        prisma.llmCallLog.findMany({
          where: {
            tenantId: { in: tenantIds },
            ...(hasDateFilter ? { createdAt } : {}),
          },
          select: {
            tenantId: true,
            provider: true,
            model: true,
            task: true,
            status: true,
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            costEstimate: true,
            stub: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 20000,
        }),
        prisma.aiCreditTransaction.findMany({
          where: {
            tenantId: { in: tenantIds },
            ...(hasDateFilter ? { createdAt } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 20000,
        }),
      ])
    : [[], [], [], []];

  const usersById = new Map(users.map((user) => [user.id, user]));
  const walletByTenant = new Map(wallets.map((wallet) => [wallet.tenantId, wallet]));
  const subscriptionsByTenant = new Map();
  for (const subscription of subscriptions) {
    const bucket = subscriptionsByTenant.get(subscription.tenantId) || [];
    bucket.push(subscription);
    subscriptionsByTenant.set(subscription.tenantId, bucket);
  }
  const ordersByTenant = new Map();
  for (const order of orders) {
    const bucket = ordersByTenant.get(order.tenantId) || [];
    bucket.push(order);
    ordersByTenant.set(order.tenantId, bucket);
  }

  const usageByTenant = new Map();
  const totals = { subscribers: tenantIds.length, activeSubscribers: 0, calls: 0, failures: 0, tokens: 0, cost: 0, revenue: 0 };
  for (const row of logs) {
    if (row.stub) continue;
    const bucket = usageByTenant.get(row.tenantId) || {
      calls: 0,
      failures: 0,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      lastActivityAt: null,
      byProvider: {},
      byModel: {},
    };
    const promptTokens = Number(row.promptTokens || 0);
    const completionTokens = Number(row.completionTokens || 0);
    const tokens = Math.max(Number(row.totalTokens || 0), promptTokens + completionTokens);
    const cost = toNum(row.costEstimate);
    bucket.calls += 1;
    bucket.tokens += tokens;
    bucket.promptTokens += promptTokens;
    bucket.completionTokens += completionTokens;
    bucket.cost += cost;
    if (row.status === "failed") bucket.failures += 1;
    if (row.createdAt && (!bucket.lastActivityAt || row.createdAt > bucket.lastActivityAt)) bucket.lastActivityAt = row.createdAt;
    const provider = row.provider || "unknown";
    const model = row.model || "unknown";
    bucket.byProvider[provider] = (bucket.byProvider[provider] || 0) + 1;
    bucket.byModel[model] = (bucket.byModel[model] || 0) + 1;
    usageByTenant.set(row.tenantId, bucket);
  }

  const ledgerByTenant = new Map();
  for (const tx of transactions) {
    const bucket = ledgerByTenant.get(tx.tenantId) || { purchaseTokens: 0, usageTokens: 0, adjustmentTokens: 0, refundTokens: 0 };
    const tokens = Number(tx.tokens || 0);
    if (tx.type === "PURCHASE") bucket.purchaseTokens += tokens;
    else if (tx.type === "USAGE") bucket.usageTokens += Math.abs(tokens);
    else if (tx.type === "ADJUSTMENT") bucket.adjustmentTokens += tokens;
    else if (tx.type === "REFUND") bucket.refundTokens += tokens;
    ledgerByTenant.set(tx.tenantId, bucket);
  }

  const subscribers = tenantIds.map((tenantId) => {
    const tenantSubscriptions = subscriptionsByTenant.get(tenantId) || [];
    const tenantOrders = ordersByTenant.get(tenantId) || [];
    const currentSubscription = tenantSubscriptions.find((s) => s.status === "ACTIVE") || tenantSubscriptions[0] || null;
    const tenant = currentSubscription?.tenant || null;
    const wallet = walletByTenant.get(tenantId) || null;
    const usage = usageByTenant.get(tenantId) || {
      calls: 0,
      failures: 0,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      lastActivityAt: null,
      byProvider: {},
      byModel: {},
    };
    const ledger = ledgerByTenant.get(tenantId) || { purchaseTokens: 0, usageTokens: 0, adjustmentTokens: 0, refundTokens: 0 };
    const emails = [
      tenant?.ownerEmail,
      ...tenantOrders.map((order) => usersById.get(order.purchasedByUserId)?.email),
    ].filter(Boolean);
    const uniqueEmails = [...new Set(emails)];
    const revenue = tenantOrders.reduce((sum, order) => sum + toNum(order.amount), 0);
    totals.revenue += revenue;
    totals.calls += usage.calls;
    totals.failures += usage.failures;
    totals.tokens += usage.tokens;
    totals.cost += usage.cost;
    if (currentSubscription?.status === "ACTIVE") totals.activeSubscribers += 1;

    return {
      tenantId,
      organization: tenant?.name || `Tenant #${tenantId}`,
      slug: tenant?.slug || null,
      ownerEmail: tenant?.ownerEmail || null,
      clientEmails: uniqueEmails,
      purchaserEmails: uniqueEmails,
      tenantStatus: tenant?.isActive === false ? "disabled" : "active",
      subscription: currentSubscription
        ? {
            id: currentSubscription.id,
            status: currentSubscription.status,
            startDate: currentSubscription.startDate,
            endDate: currentSubscription.endDate,
          }
        : null,
      purchaseCount: tenantOrders.length,
      lastPurchasedAt: tenantOrders[0]?.paidAt || tenantOrders[0]?.createdAt || null,
      revenue,
      currency: tenantOrders[0]?.currency || plan.currency,
      credits: {
        balanceTokens: wallet?.balanceTokens || 0,
        totalPurchasedTokens: wallet?.totalPurchasedTokens || 0,
        totalUsedTokens: wallet?.totalUsedTokens || 0,
        percentRemaining: wallet && wallet.totalPurchasedTokens > 0
          ? Math.max(0, Math.min(100, Math.round((wallet.balanceTokens / wallet.totalPurchasedTokens) * 100)))
          : 0,
      },
      ledger,
      usage: {
        ...usage,
        cost: Math.round(usage.cost * 1e6) / 1e6,
      },
    };
  }).sort((a, b) => (new Date(b.lastPurchasedAt || 0) - new Date(a.lastPurchasedAt || 0)) || a.organization.localeCompare(b.organization));

  totals.cost = Math.round(totals.cost * 1e6) / 1e6;
  totals.revenue = Math.round(totals.revenue * 100) / 100;

  return {
    plan: formatPlan({ ...plan, planKeys: [] }),
    subscribers,
    totals,
    appliedFilters: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      attribution: "Usage is inferred by tenant subscription/order history because LlmCallLog rows do not store planId.",
    },
  };
}

module.exports = {
  formatPlan,
  listPublicPlans,
  listAllPlans,
  createPlan,
  updatePlan,
  deactivatePlan,
  getPlanSubscriberAnalytics,
};
