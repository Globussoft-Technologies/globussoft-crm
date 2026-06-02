const express = require('express');
const PDFDocument = require('pdfkit');
const prisma = require('../lib/prisma');
const { verifyToken, verifyRole } = require('../middleware/auth');
const razorpayService = require('../services/razorpayService');
const { formatMoney } = require('../utils/formatMoney');

const router = express.Router();

// Catalog editing (POST/PUT/DELETE plans) is platform-level — only the
// Globussoft owner (User.userType === 'OWNER', surfaces as req.user.isOwner)
// may change prices/features. Tenant ADMINs see /pricing and BUY plans, but
// cannot edit the catalog.
const requireOwner = (req, res, next) => {
  if (!req.user || !req.user.isOwner) {
    return res.status(403).json({
      error: "Catalog editing is restricted to the platform owner.",
      code: 'RBAC_DENIED',
    });
  }
  next();
};

// Subscription lifecycle states stored in Subscription.status:
//   ACTIVE    — the period currently being consumed (startDate <= now < endDate)
//   SCHEDULED — bought while another period was still running; queued to begin
//               when the prior period ends (startDate is in the future)
//   EXPIRED   — period fully elapsed
//   CANCELLED — cancelled by the admin
//
// Stacking model: when a user buys again while a paid period is still running
// (intentionally or by mistake), we DON'T overwrite or run two periods at once.
// The new period is queued to start the instant the current one ends, so two
// back-to-back one-month buys give two consecutive months, never overlapping.
//
// reconcileSubscriptions is a lazy, read-time state machine (no cron needed):
// it expires periods whose endDate has passed and promotes the next queued
// (SCHEDULED) period to ACTIVE once its startDate arrives. Call it before
// reading a user's subscription state. Returns the resolved user-level status.
async function reconcileSubscriptions(userId, tenantId) {
  const now = new Date();

  // Walk forward through the user's timeline: expire elapsed periods, then
  // promote the earliest queued period that has reached its start. Loop so a
  // chain of short back-to-back periods all settle in one pass.
  let resolvedStatus = null;
  // Bounded: each iteration either settles (breaks) or promotes exactly one
  // queued period. The cap is a safety backstop against an unexpected cycle.
  for (let guard = 0; guard < 100; guard++) {
    // Expire any ACTIVE period whose window has fully elapsed.
    await prisma.subscription.updateMany({
      where: { userId, tenantId, status: 'ACTIVE', endDate: { lte: now } },
      data: { status: 'EXPIRED' },
    });

    // Is a period currently active (window covers now)?
    const active = await prisma.subscription.findFirst({
      where: { userId, tenantId, status: 'ACTIVE' },
      orderBy: { startDate: 'asc' },
    });
    if (active) {
      resolvedStatus = 'ACTIVE';
      break;
    }

    // No active period — promote the earliest queued period that has started.
    const due = await prisma.subscription.findFirst({
      where: { userId, tenantId, status: 'SCHEDULED', startDate: { lte: now } },
      orderBy: { startDate: 'asc' },
    });
    if (!due) {
      // Nothing active and nothing due to start yet. If a future-dated queued
      // period exists the user is still effectively ACTIVE (their current paid
      // period just hasn't been created as a separate row) — but in practice
      // the prior period would still be ACTIVE in that case, so falling here
      // means the user has no live coverage.
      resolvedStatus = null;
      break;
    }

    await prisma.subscription.update({
      where: { id: due.id },
      data: { status: 'ACTIVE' },
    });
    // Loop again: the just-promoted period might itself already be elapsed.
  }

  return resolvedStatus;
}

// Get current user's subscription status. ADMIN-only — the tenant admin is
// the one who buys + manages the subscription. Managers/staff don't see
// billing state.
router.get('/status', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
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

    // Settle the timeline on read: expire elapsed periods and promote the next
    // queued (SCHEDULED) period once its start arrives. This is what makes a
    // queued purchase "automatically apply" when the current period ends, with
    // no cron job required.
    await reconcileSubscriptions(userId, tenantId);

    // Get active subscription if exists
    const subscription = await prisma.subscription.findFirst({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE'
      }
    });

    // Surface the next queued period (if the admin bought ahead) so the UI can
    // show "next plan starts on <startDate>".
    const upcoming = await prisma.subscription.findFirst({
      where: {
        userId,
        tenantId,
        status: 'SCHEDULED'
      },
      orderBy: { startDate: 'asc' }
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
      } : null,
      // The queued period waiting behind the active one (null if none). Begins
      // automatically the instant the active period's endDate passes.
      upcomingSubscription: upcoming ? {
        id: upcoming.id,
        planName: upcoming.planName,
        status: upcoming.status,
        startDate: upcoming.startDate,
        endDate: upcoming.endDate,
        renewalDate: upcoming.renewalDate,
        amount: upcoming.amount,
        currency: upcoming.currency,
        billingIntervalDays: upcoming.billingIntervalDays
      } : null
    });
  } catch (err) {
    console.error('[subscriptions.get/status] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch subscription status', details: err.message });
  }
});

// Helper — formats a SubscriptionPlan row for the public catalog response.
// `pricing` is stored as a JSON string in MySQL Text; parse on read so the
// frontend doesn't have to. Anything missing falls back to the legacy
// `price`+`currency` columns (one canonical price), so plans seeded before
// the multi-currency upgrade still render.
function formatPlan(p) {
  let pricing = null;
  if (p.pricing) {
    try { pricing = JSON.parse(p.pricing); } catch { pricing = null; }
  }
  return {
    id: p.id,
    planKey: p.planKey,
    name: p.name,
    description: p.description,
    price: parseFloat(p.price),
    currency: p.currency,
    billingIntervalDays: p.billingIntervalDays,
    features: p.features ? (() => { try { return JSON.parse(p.features); } catch { return []; } })() : [],
    pricing,
    displayOrder: p.displayOrder ?? 0,
    popular: !!p.popular,
    accentColor: p.accentColor,
    cta: p.cta,
    featuresLabel: p.featuresLabel,
    isActive: p.isActive,
  };
}

// Public catalog — anonymous visitors hit this from the /pricing page.
// Auth is intentionally NOT required here; the server.js global guard
// has a method-aware exception (GET /subscriptions/plans only).
// Admin CRUD endpoints below stay gated.
router.get('/plans', async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }]
    });
    res.json(plans.map(formatPlan));
  } catch (err) {
    console.error('[subscriptions.get/plans]', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// Owner-only: list ALL plans including inactive, for the Manage Plans UI.
router.get('/plans/admin', verifyToken, requireOwner, async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }]
    });
    res.json(plans.map(formatPlan));
  } catch (err) {
    console.error('[subscriptions.get/plans/admin]', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// Owner-only: create a new plan.
router.post('/plans', verifyToken, requireOwner, async (req, res) => {
  try {
    const {
      name, description, price, currency, billingIntervalDays,
      features, pricing, planKey, displayOrder, popular,
      accentColor, cta, featuresLabel, isActive
    } = req.body;

    if (!name || price == null) {
      return res.status(400).json({ error: 'name and price are required' });
    }

    const plan = await prisma.subscriptionPlan.create({
      data: {
        name,
        description: description ?? null,
        price,
        currency: currency || 'INR',
        billingIntervalDays: billingIntervalDays ?? 30,
        features: Array.isArray(features) ? JSON.stringify(features) : (features ?? null),
        pricing: pricing && typeof pricing === 'object' ? JSON.stringify(pricing) : (typeof pricing === 'string' ? pricing : null),
        planKey: planKey || null,
        displayOrder: displayOrder ?? 0,
        popular: !!popular,
        accentColor: accentColor || null,
        cta: cta || null,
        featuresLabel: featuresLabel || null,
        isActive: isActive !== false,
      }
    });
    res.status(201).json(formatPlan(plan));
  } catch (err) {
    console.error('[subscriptions.post/plans]', err);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A plan with that key or (name, billing interval) already exists' });
    }
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

// Owner-only: update an existing plan.
router.put('/plans/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    if (!Number.isInteger(planId)) return res.status(400).json({ error: 'Invalid plan id' });

    const {
      name, description, price, currency, billingIntervalDays,
      features, pricing, planKey, displayOrder, popular,
      accentColor, cta, featuresLabel, isActive
    } = req.body;

    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (price !== undefined) data.price = price;
    if (currency !== undefined) data.currency = currency;
    if (billingIntervalDays !== undefined) data.billingIntervalDays = billingIntervalDays;
    if (features !== undefined) data.features = Array.isArray(features) ? JSON.stringify(features) : features;
    if (pricing !== undefined) data.pricing = pricing && typeof pricing === 'object' ? JSON.stringify(pricing) : (typeof pricing === 'string' ? pricing : null);
    if (planKey !== undefined) data.planKey = planKey;
    if (displayOrder !== undefined) data.displayOrder = displayOrder;
    if (popular !== undefined) data.popular = !!popular;
    if (accentColor !== undefined) data.accentColor = accentColor;
    if (cta !== undefined) data.cta = cta;
    if (featuresLabel !== undefined) data.featuresLabel = featuresLabel;
    if (isActive !== undefined) data.isActive = !!isActive;

    const plan = await prisma.subscriptionPlan.update({
      where: { id: planId },
      data
    });
    res.json(formatPlan(plan));
  } catch (err) {
    console.error('[subscriptions.put/plans]', err);
    if (err.code === 'P2025') return res.status(404).json({ error: 'Plan not found' });
    if (err.code === 'P2002') return res.status(409).json({ error: 'A plan with that key or (name, billing interval) already exists' });
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// Owner-only: soft-delete (set isActive=false). Hard-delete is avoided
// because existing Subscription rows reference SubscriptionPlan.
router.delete('/plans/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    if (!Number.isInteger(planId)) return res.status(400).json({ error: 'Invalid plan id' });

    const plan = await prisma.subscriptionPlan.update({
      where: { id: planId },
      data: { isActive: false }
    });
    res.json({ success: true, id: plan.id });
  } catch (err) {
    console.error('[subscriptions.delete/plans]', err);
    if (err.code === 'P2025') return res.status(404).json({ error: 'Plan not found' });
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// Create a Razorpay order.
//
// Accepts optional `currency` ('usd'|'inr') + `billingPeriod` ('annual'|'monthly')
// from the body so the user gets charged the price they actually saw on the
// /pricing card (currency toggle × annual/monthly toggle). Falls back to the
// plan's legacy single `price`+`currency` columns when those toggles aren't
// passed or when the plan has no `pricing` JSON populated yet.
router.post('/create-order', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const { planId, currency: bodyCurrency, billingPeriod } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: parseInt(planId) }
    });

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Resolve the actual charge amount from the plan's pricing JSON when the
    // client passed a currency+period; fall back to the legacy columns.
    let chargeAmount = parseFloat(plan.price);
    let chargeCurrency = plan.currency;
    if (plan.pricing && bodyCurrency && billingPeriod) {
      try {
        const parsed = JSON.parse(plan.pricing);
        const cur = String(bodyCurrency).toLowerCase();
        const per = String(billingPeriod).toLowerCase() === 'annual' ? 'annual' : 'monthly';
        const bucket = parsed[cur];
        if (bucket && bucket[per] != null) {
          // Pricing JSON stores amounts as numbers OR comma-formatted strings
          // (e.g. "1,499"). Strip commas before parsing.
          const raw = String(bucket[per]).replace(/,/g, '').trim();
          const parsedAmount = parseFloat(raw);
          if (!Number.isNaN(parsedAmount) && parsedAmount > 0) {
            chargeAmount = parsedAmount;
            chargeCurrency = cur === 'usd' ? 'USD' : 'INR';
          }
        }
      } catch {
        // bad JSON → silently keep the legacy fallback
      }
    }

    const order = await razorpayService.createOrder(
      chargeAmount,
      parseInt(planId),
      chargeCurrency
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

// Verify payment and create subscription — ADMIN-only (the tenant admin is
// the buyer). Owner doesn't subscribe; owner is platform staff.
router.post('/verify-payment', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
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

    // Settle any elapsed/queued periods first so we stack onto the true tail.
    await reconcileSubscriptions(userId, tenantId);

    // Find the latest period the user still has coverage for (ACTIVE or already
    // SCHEDULED). If its end is in the future, this purchase is QUEUED to begin
    // the instant that period ends — so buying again mid-cycle (intentionally
    // or by mistake) never overlaps or wastes time; it appends a full period to
    // the tail. e.g. active 1st→1st, buy on the 6th → new runs 1st→next-1st.
    const latest = await prisma.subscription.findFirst({
      where: { userId, tenantId, status: { in: ['ACTIVE', 'SCHEDULED'] } },
      orderBy: { endDate: 'desc' },
    });

    const hasFutureCoverage = latest && latest.endDate && new Date(latest.endDate) > now;
    const startDate = hasFutureCoverage ? new Date(latest.endDate) : now;
    const endDate = new Date(startDate.getTime() + billingDays * 24 * 60 * 60 * 1000);
    const newStatus = hasFutureCoverage ? 'SCHEDULED' : 'ACTIVE';

    // Create subscription
    const subscription = await prisma.subscription.create({
      data: {
        userId,
        planId: parseInt(planId),
        planName: plan.name,
        status: newStatus,
        amount: plan.price,
        currency: plan.currency,
        billingIntervalDays: plan.billingIntervalDays,
        startDate: startDate,
        endDate: endDate,
        renewalDate: endDate,
        razorpayOrderId,
        razorpayPaymentId,
        features: plan.features,
        tenantId
      }
    });

    // The admin always has live coverage after a successful purchase — either
    // the new period started now, or an existing period is still running with
    // this one queued behind it.
    await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: 'ACTIVE',
        trialEndsAt: null
      }
    });

    // Log the subscription spend as a cash-drawer expense (POS Cash Register
    // → Expenses tab) so it's visible + deducted from the drawer. Best-effort:
    // only lands if a shift is open, and never blocks the purchase.
    let posExpenseRecorded = false;
    try {
      const { recordSubscriptionExpense } = require('../lib/posExpense');
      const r = await recordSubscriptionExpense({
        tenantId,
        userId,
        amount: subscription.amount,
        reason: `Subscription: ${subscription.planName}`,
      });
      posExpenseRecorded = !!r.recorded;
    } catch (e) {
      console.error('[subscriptions.verify-payment] POS expense log failed:', e.message);
    }

    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        planName: subscription.planName,
        status: subscription.status,
        startDate: subscription.startDate,
        endDate: subscription.endDate
      },
      // True when the purchase was queued behind a still-running period rather
      // than activated immediately — lets the UI say "starts on <startDate>".
      scheduled: subscription.status === 'SCHEDULED',
      // Surfaced so the UI can hint "open a shift to record this expense" when
      // the spend couldn't be logged to the drawer (no open shift).
      posExpenseRecorded,
    });
  } catch (err) {
    console.error('[subscriptions.post/verify-payment] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to verify payment', details: err.message });
  }
});

// Cancel subscription — ADMIN-only (only the admin who bought it can cancel).
router.patch('/:id/cancel', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
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

    // Settle the timeline: if the cancelled period was the live one and a queued
    // period is already due to start, promote it. Then decide the user's status
    // from what coverage remains — a still-running period OR a queued one the
    // admin already paid for both keep the account ACTIVE.
    await reconcileSubscriptions(userId, tenantId);

    const remainingCoverage = await prisma.subscription.findFirst({
      where: {
        userId,
        tenantId,
        status: { in: ['ACTIVE', 'SCHEDULED'] }
      }
    });

    if (!remainingCoverage) {
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

// List billing history — every subscription record (paid + cancelled +
// expired) the current admin has on this tenant, newest first. Feeds the
// Profile page's "Download Invoice" picker and any future billing-history
// UI. ADMIN-only because Subscription rows are owned by the buyer; a
// MANAGER/USER on the same tenant should not see their admin's payments.
router.get('/invoices', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const subs = await prisma.subscription.findMany({
      where: { userId, tenantId },
      orderBy: { startDate: 'desc' },
      select: {
        id: true, planName: true, status: true, amount: true, currency: true,
        billingIntervalDays: true, startDate: true, endDate: true,
        razorpayOrderId: true, razorpayPaymentId: true, createdAt: true,
      },
    });
    res.json(subs.map((s) => ({
      ...s,
      amount: parseFloat(s.amount),
      invoiceNum: `SUB-${String(s.id).padStart(6, '0')}`,
    })));
  } catch (err) {
    console.error('[subscriptions.get/invoices]', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// Generate + stream a PDF invoice for a specific subscription payment.
// Mirrors the billing.js invoice PDF template (same layout / fonts /
// colors) so customer-facing PDFs feel like one consistent product.
// Scoped to the current admin's own subscriptions (userId + tenantId in
// the where clause) — an admin cannot pull another tenant's invoice by
// guessing IDs.
router.get('/:id/invoice.pdf', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const subId = parseInt(req.params.id);
    if (!Number.isInteger(subId)) return res.status(400).json({ error: 'Invalid subscription id' });

    const { userId, tenantId } = req.user;
    const sub = await prisma.subscription.findFirst({
      where: { id: subId, userId, tenantId },
      include: {
        user: { select: { name: true, email: true } },
        tenant: { select: { name: true, slug: true, defaultCurrency: true, locale: true } },
        plan: { select: { name: true, description: true } },
      },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const invoiceNum = `SUB-${String(sub.id).padStart(6, '0')}`;
    const currency = sub.currency || sub.tenant?.defaultCurrency || 'INR';
    const locale = sub.tenant?.locale || undefined;
    const amount = parseFloat(sub.amount);

    const billingPeriodLabel = (() => {
      const days = sub.billingIntervalDays;
      if (days === 30) return 'Monthly';
      if (days === 90) return 'Quarterly';
      if (days === 365) return 'Annual';
      if (days) return `${days}-day cycle`;
      return 'One-time';
    })();

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${invoiceNum}.pdf`);
    doc.pipe(res);

    // Header
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#000000').text('Globussoft CRM', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#666666').text('Subscription Invoice', 50, 80);

    // Invoice meta
    doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold')
      .text(`Invoice: ${invoiceNum}`, 50, 130);
    doc.fontSize(10).font('Helvetica').fillColor('#333333');
    doc.text(`Status: ${sub.status}`, 50, 155);
    doc.text(`Issue Date: ${new Date(sub.startDate).toLocaleDateString()}`, 50, 172);
    if (sub.endDate) {
      doc.text(`Covers Through: ${new Date(sub.endDate).toLocaleDateString()}`, 50, 189);
    }
    if (sub.razorpayPaymentId) {
      doc.text(`Payment Ref: ${sub.razorpayPaymentId}`, 50, 206);
    }

    // Bill To
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text('Bill To:', 50, 240);
    doc.fontSize(10).font('Helvetica').fillColor('#333333')
      .text(sub.user?.name || 'Unknown', 50, 260)
      .text(sub.user?.email || '', 50, 275)
      .text(sub.tenant?.name || '', 50, 290);

    // Line item table
    doc.moveTo(50, 325).lineTo(545, 325).strokeColor('#cccccc').stroke();
    doc.fillColor('#ffffff').rect(50, 340, 495, 30).fill('#4f46e5');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
      .text('Description', 60, 348)
      .text('Billing', 320, 348, { width: 90, align: 'left' })
      .text('Amount', 450, 348, { width: 85, align: 'right' });

    const planLine = sub.planName || sub.plan?.name || 'Subscription Plan';
    doc.fillColor('#333333').font('Helvetica').fontSize(10)
      .text(`${planLine} plan`, 60, 385, { width: 250 })
      .text(billingPeriodLabel, 320, 385, { width: 90, align: 'left' })
      .text(formatMoney(amount, currency, locale), 450, 385, { width: 85, align: 'right' });

    // Total
    doc.moveTo(50, 415).lineTo(545, 415).strokeColor('#cccccc').stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000')
      .text('Total Paid:', 350, 430)
      .text(formatMoney(amount, currency, locale), 450, 430, { width: 85, align: 'right' });

    // Notes
    doc.fontSize(9).font('Helvetica').fillColor('#666666')
      .text(
        sub.plan?.description ||
          'Thank you for your subscription. Your access continues through the covers-through date above.',
        50, 480, { width: 495, align: 'left' }
      );

    // Footer
    doc.fontSize(8).font('Helvetica').fillColor('#999999')
      .text('Generated by Globussoft CRM', 50, 760, { align: 'center' })
      .text('For billing questions, contact your Globussoft account manager.', 50, 775, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[subscriptions.get/:id/invoice.pdf]', err);
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
});

module.exports = router;
