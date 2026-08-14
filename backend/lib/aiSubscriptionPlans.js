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
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

async function listPublicPlans() {
  const plans = await prisma.aiSubscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: [{ displayOrder: "asc" }, { price: "asc" }],
    take: 100,
  });
  return plans.map(formatPlan);
}

async function listAllPlans() {
  const plans = await prisma.aiSubscriptionPlan.findMany({
    orderBy: [{ displayOrder: "asc" }, { price: "asc" }],
    take: 200,
  });
  return plans.map(formatPlan);
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

async function createPlan(body) {
  const { errors, data } = validatePlanInput(body, { partial: false });
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.code = "INVALID_PLAN_INPUT";
    throw err;
  }
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
    },
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
  const plan = await prisma.aiSubscriptionPlan.update({
    where: { id: planId },
    data,
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

module.exports = {
  formatPlan,
  listPublicPlans,
  listAllPlans,
  createPlan,
  updatePlan,
  deactivatePlan,
};
