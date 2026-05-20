const express = require('express');
const prisma = require('../lib/prisma');
const { verifyToken, verifyRole } = require('../middleware/auth');
const razorpayService = require('../services/razorpayService');

const router = express.Router();

// Get current user's subscription status
router.get('/status', verifyToken, verifyRole(['ADMIN', 'OWNER']), async (req, res) => {
  try {
    const { userId, tenantId } = req.user;

    if (!userId || !tenantId) {
      return res.status(401).json({ error: 'User context missing', received: { userId, tenantId } });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        trialStartDate: true,
        trialEndsAt: true,
        subscriptionStatus: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get active subscription if exists
    const subscription = await prisma.subscription.findFirst({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE'
      }
    });

    const daysRemaining = user.trialEndsAt
      ? Math.ceil((new Date(user.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24))
      : 0;

    return res.json({
      subscriptionStatus: user.subscriptionStatus,
      trialStartDate: user.trialStartDate,
      trialEndsAt: user.trialEndsAt,
      trialDaysRemaining: Math.max(0, daysRemaining),
      daysRemaining: Math.max(0, daysRemaining),
      subscription: subscription ? {
        id: subscription.id,
        planName: subscription.planName,
        status: subscription.status,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        renewalDate: subscription.renewalDate,
        amount: subscription.amount,
        currency: subscription.currency,
        billingIntervalDays: subscription.billingIntervalDays
      } : null
    });
  } catch (err) {
    console.error('[subscriptions.get/status] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch subscription status', details: err.message });
  }
});

// Get available subscription plans
router.get('/plans', verifyToken, verifyRole(['ADMIN', 'OWNER']), async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' }
    });

    const formattedPlans = plans.map(p => ({
      id: p.id,
      name: p.name,
      price: parseFloat(p.price),
      currency: p.currency,
      billingIntervalDays: p.billingIntervalDays,
      features: p.features ? JSON.parse(p.features) : [],
      description: p.description
    }));

    res.json(formattedPlans);
  } catch (err) {
    console.error('[subscriptions.get/plans]', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// Create a Razorpay order
router.post('/create-order', verifyToken, verifyRole(['ADMIN', 'OWNER']), async (req, res) => {
  try {
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: parseInt(planId) }
    });

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const order = await razorpayService.createOrder(
      parseFloat(plan.price),
      parseInt(planId)
    );

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      planId: plan.id,
      planName: plan.name
    });
  } catch (err) {
    console.error('[subscriptions.post/create-order]', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Verify payment and create subscription
router.post('/verify-payment', verifyToken, verifyRole(['ADMIN', 'OWNER']), async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, planId } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !planId) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    // Verify signature
    console.log('[subscriptions.verify-payment] Verifying signature:', { razorpayOrderId, razorpayPaymentId, razorpaySignature: razorpaySignature.slice(0, 20) + '...' });
    const isValid = razorpayService.verifySignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    console.log('[subscriptions.verify-payment] Signature valid:', isValid);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Check if subscription already exists for this order
    const existing = await prisma.subscription.findUnique({
      where: { razorpayOrderId }
    });

    if (existing) {
      return res.status(400).json({ error: 'Subscription already exists for this order' });
    }

    // Get plan
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: parseInt(planId) }
    });

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const now = new Date();
    const billingDays = plan.billingIntervalDays || 30;
    const endDate = new Date(now.getTime() + billingDays * 24 * 60 * 60 * 1000);

    // Create subscription
    const subscription = await prisma.subscription.create({
      data: {
        userId,
        planId: parseInt(planId),
        planName: plan.name,
        status: 'ACTIVE',
        amount: plan.price,
        currency: plan.currency,
        billingIntervalDays: plan.billingIntervalDays,
        startDate: now,
        endDate: endDate,
        renewalDate: endDate,
        razorpayOrderId,
        razorpayPaymentId,
        features: plan.features,
        tenantId
      }
    });

    // Update user subscription status
    await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: 'ACTIVE',
        trialEndsAt: null
      }
    });

    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        planName: subscription.planName,
        status: subscription.status,
        endDate: subscription.endDate
      }
    });
  } catch (err) {
    console.error('[subscriptions.post/verify-payment] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to verify payment', details: err.message });
  }
});

// Cancel subscription
router.patch('/:id/cancel', verifyToken, verifyRole(['ADMIN', 'OWNER']), async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const { id } = req.params;

    const subscription = await prisma.subscription.findFirst({
      where: {
        id: parseInt(id),
        userId,
        tenantId
      }
    });

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const updated = await prisma.subscription.update({
      where: { id: parseInt(id) },
      data: { status: 'CANCELLED' }
    });

    // Update user status
    const hasActiveSubscription = await prisma.subscription.findFirst({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE'
      }
    });

    if (!hasActiveSubscription) {
      await prisma.user.update({
        where: { id: userId },
        data: { subscriptionStatus: 'CANCELLED' }
      });
    }

    res.json({
      success: true,
      subscription: {
        id: updated.id,
        status: updated.status
      }
    });
  } catch (err) {
    console.error('[subscriptions.patch/cancel]', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
