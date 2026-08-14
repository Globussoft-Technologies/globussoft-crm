const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { listPublicPlans } = require("../lib/aiSubscriptionPlans");
const { createCreditOrder, verifyCreditPayment } = require("../lib/aiSubscriptionPurchase");
const { getWalletState } = require("../lib/aiCreditLedger");

// Public-to-tenant catalog (any authenticated user can browse plans; only
// ADMIN can purchase). Mirrors subscriptions.js's /plans pattern.
router.get("/plans", verifyToken, async (_req, res) => {
  try {
    const plans = await listPublicPlans();
    res.json(plans);
  } catch (err) {
    console.error("[ai-subscriptions.get/plans]", err.message);
    res.status(500).json({ error: "Failed to fetch AI subscription plans" });
  }
});

router.post("/create-order", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const planId = parseInt(req.body?.planId, 10);
    if (!Number.isInteger(planId)) {
      return res.status(400).json({ error: "planId is required" });
    }
    const order = await createCreditOrder({
      tenantId: req.user.tenantId,
      purchasedByUserId: req.user.userId,
      planId,
    });
    res.json(order);
  } catch (err) {
    console.error("[ai-subscriptions.post/create-order]", err.message);
    const status = err.code === "PLAN_NOT_FOUND" ? 404 : 500;
    res.status(status).json({
      error: err.code === "PLAN_NOT_FOUND" ? "AI subscription plan not found or inactive." : "Failed to create order",
      code: err.code || "AI_ORDER_CREATE_FAILED",
    });
  }
});

router.post("/verify-payment", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
    const result = await verifyCreditPayment({
      tenantId: req.user.tenantId,
      purchasedByUserId: req.user.userId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });
    res.json({
      success: true,
      alreadyProcessed: Boolean(result.alreadyProcessed),
      wallet: result.wallet
        ? { balanceTokens: result.wallet.balanceTokens, totalPurchasedTokens: result.wallet.totalPurchasedTokens }
        : null,
    });
  } catch (err) {
    console.error("[ai-subscriptions.post/verify-payment]", err.message);
    const status = err.code === "ORDER_NOT_FOUND" ? 404 : err.code === "INVALID_SIGNATURE" || err.code === "MISSING_PAYMENT_DETAILS" ? 400 : 500;
    res.status(status).json({
      error: err.message || "Failed to verify AI subscription payment",
      code: err.code || "AI_PAYMENT_VERIFY_FAILED",
    });
  }
});

// Tenant AI Usage dashboard — current subscription, credit balance/usage,
// renewal date, and recent request history. ADMIN-only, matching the
// existing /api/subscriptions/status convention (billing state is an
// admin concern).
router.get("/usage", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const state = await getWalletState(tenantId);

    const [recentTransactions, recentRequests] = await Promise.all([
      prisma.aiCreditTransaction.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.llmCallLog.findMany({
        where: { tenantId, reason: "crm-managed" },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          task: true,
          model: true,
          provider: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({
      subscription: state.activeSubscription
        ? {
            id: state.activeSubscription.id,
            planId: state.activeSubscription.planId,
            planName: state.activeSubscription.planNameSnapshot,
            startDate: state.activeSubscription.startDate,
            renewalDate: state.activeSubscription.endDate,
            plan: state.activeSubscription.plan
              ? {
                  name: state.activeSubscription.plan.name,
                  creditTokens: state.activeSubscription.plan.creditTokens,
                  billingCycle: state.activeSubscription.plan.billingCycle,
                }
              : null,
          }
        : null,
      credits: {
        remainingTokens: state.wallet.balanceTokens,
        usedTokens: state.wallet.totalUsedTokens,
        totalTokens: state.wallet.totalPurchasedTokens,
        usagePercent: state.percentUsed,
      },
      recentTransactions,
      recentRequests,
    });
  } catch (err) {
    console.error("[ai-subscriptions.get/usage]", err.message);
    res.status(500).json({ error: "Failed to load AI usage dashboard" });
  }
});

// Billing history for AI credit purchases — mirrors subscriptions.js's
// /invoices endpoint.
router.get("/orders", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const orders = await prisma.aiCreditOrder.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { plan: { select: { name: true } } },
    });
    res.json(
      orders.map((o) => ({
        id: o.id,
        planName: o.plan?.name || null,
        amount: parseFloat(o.amount),
        currency: o.currency,
        creditTokens: o.creditTokens,
        status: o.status,
        razorpayOrderId: o.razorpayOrderId,
        razorpayPaymentId: o.razorpayPaymentId,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        invoiceNum: `AICR-${String(o.id).padStart(6, "0")}`,
      })),
    );
  } catch (err) {
    console.error("[ai-subscriptions.get/orders]", err.message);
    res.status(500).json({ error: "Failed to fetch AI credit purchase history" });
  }
});

module.exports = router;
