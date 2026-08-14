"use strict";

// AI subscription purchase flow — Razorpay order-create/verify for
// CRM-managed AI credit plans. Uses the PLATFORM's own Razorpay keys
// (services/razorpayService.js, same instance routes/subscriptions.js
// uses for CRM subscription billing) because this is the CRM billing the
// tenant, not the tenant billing their own customers (that's
// lib/tenantPaymentGateway.js — a different, deliberately separate flow).

const prisma = require("./prisma");
const razorpayService = require("../services/razorpayService");
const { writeAudit } = require("./audit");
const { creditTokens } = require("./aiCreditLedger");
const { formatPlan } = require("./aiSubscriptionPlans");

async function createCreditOrder({ tenantId, purchasedByUserId, planId }) {
  const plan = await prisma.aiSubscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) {
    const err = new Error("AI subscription plan not found or inactive.");
    err.code = "PLAN_NOT_FOUND";
    throw err;
  }

  const amount = parseFloat(plan.price);
  const razorpayOrder = await razorpayService.createOrder(amount, `ai-plan-${plan.id}`, plan.currency || "INR");

  const order = await prisma.aiCreditOrder.create({
    data: {
      tenantId,
      planId: plan.id,
      purchasedByUserId,
      amount,
      currency: plan.currency || "INR",
      creditTokens: plan.creditTokens,
      status: "PENDING",
      razorpayOrderId: razorpayOrder.id,
    },
  });

  await writeAudit("AiCreditOrder", "CREATE", order.id, purchasedByUserId, tenantId, {
    planId: plan.id,
    planName: plan.name,
    amount,
    currency: order.currency,
    creditTokens: plan.creditTokens,
  });

  return {
    orderId: razorpayOrder.id,
    amount: razorpayOrder.amount,
    currency: razorpayOrder.currency,
    plan: formatPlan(plan),
    localOrderId: order.id,
  };
}

async function verifyCreditPayment({
  tenantId,
  purchasedByUserId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    const err = new Error("Missing payment details.");
    err.code = "MISSING_PAYMENT_DETAILS";
    throw err;
  }

  const order = await prisma.aiCreditOrder.findUnique({
    where: { razorpayOrderId },
    include: { plan: true },
  });
  if (!order || order.tenantId !== tenantId) {
    const err = new Error("AI credit order not found for this organization.");
    err.code = "ORDER_NOT_FOUND";
    throw err;
  }
  if (order.status === "PAID") {
    // Idempotent — a duplicate verify call (retry/double-click) is a no-op
    // success rather than a double-credit.
    return { alreadyProcessed: true, order };
  }

  const isValid = razorpayService.verifySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
  if (!isValid) {
    await prisma.aiCreditOrder.update({
      where: { id: order.id },
      data: { status: "FAILED", failureReason: "Invalid payment signature", razorpayPaymentId },
    });
    await writeAudit("AiCreditOrder", "PAYMENT_FAILED", order.id, purchasedByUserId, tenantId, {
      reason: "invalid_signature",
    });
    const err = new Error("Invalid payment signature.");
    err.code = "INVALID_SIGNATURE";
    throw err;
  }

  const now = new Date();
  const validityDays = order.plan.validityDays ?? (order.plan.billingCycle === "monthly" ? 30 : null);
  const endDate = validityDays ? new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000) : null;

  const [paidOrder, subscription] = await prisma.$transaction([
    prisma.aiCreditOrder.update({
      where: { id: order.id },
      data: { status: "PAID", razorpayPaymentId, paidAt: now },
    }),
    prisma.aiTenantSubscription.create({
      data: {
        tenantId,
        planId: order.planId,
        planNameSnapshot: order.plan.name,
        status: "ACTIVE",
        startDate: now,
        endDate,
      },
    }),
  ]);

  const { wallet, transaction } = await creditTokens({
    tenantId,
    tokens: order.creditTokens,
    type: "PURCHASE",
    orderId: order.id,
    reason: `Purchased plan "${order.plan.name}"`,
  });

  await writeAudit("AiCreditOrder", "PAYMENT_VERIFIED", order.id, purchasedByUserId, tenantId, {
    planId: order.planId,
    planName: order.plan.name,
    creditTokens: order.creditTokens,
    newBalance: wallet.balanceTokens,
    razorpayPaymentId,
  });

  return {
    alreadyProcessed: false,
    order: paidOrder,
    subscription,
    wallet,
    transaction,
  };
}

module.exports = {
  createCreditOrder,
  verifyCreditPayment,
};
