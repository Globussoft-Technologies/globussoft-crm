// Shared subscription-purchase fulfillment logic, used by BOTH:
//   1. routes/subscriptions.js  POST /verify-payment (client-driven, fires
//      from the Razorpay checkout `handler` callback in the browser)
//   2. routes/payments.js       POST /webhook/razorpay (server-to-server,
//      fires from Razorpay's own infrastructure regardless of whether the
//      browser tab stayed open long enough to call verify-payment)
//
// Extracted so a subscription is created exactly once no matter which path
// reports the payment first — fulfillSubscriptionOrder() is idempotent on
// razorpayOrderId (unique constraint), so calling it twice for the same
// order is a safe no-op the second time.

const prisma = require('./prisma');

// Subscription lifecycle states stored in Subscription.status:
//   ACTIVE    - the period currently being consumed (startDate <= now < endDate)
//   SCHEDULED - bought while another period was still running; queued to begin
//               when the prior period ends (startDate is in the future)
//   EXPIRED   - period fully elapsed
//   CANCELLED - cancelled by the admin
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
  return await prisma.$transaction(async (tx) => {
    const now = new Date();

    // Walk forward through the user's timeline: expire elapsed periods, then
    // promote the earliest queued period that has reached its start. Loop so a
    // chain of short back-to-back periods all settle in one pass.
    let resolvedStatus = null;
    // Bounded: each iteration either settles (breaks) or promotes exactly one
    // queued period. The cap is a safety backstop against an unexpected cycle.
    for (let guard = 0; guard < 100; guard++) {
      // Expire any ACTIVE period whose window has fully elapsed.
      await tx.subscription.updateMany({
        where: { userId, tenantId, status: 'ACTIVE', endDate: { lte: now } },
        data: { status: 'EXPIRED' },
      });

      // Is a period currently active (window covers now)?
      const active = await tx.subscription.findFirst({
        where: { userId, tenantId, status: 'ACTIVE' },
        orderBy: { startDate: 'asc' },
      });
      if (active) {
        resolvedStatus = 'ACTIVE';
        break;
      }

      // No active period - promote the earliest queued period that has started.
      const due = await tx.subscription.findFirst({
        where: { userId, tenantId, status: 'SCHEDULED', startDate: { lte: now } },
        orderBy: { startDate: 'asc' },
      });
      if (!due) {
        // Nothing active and nothing due to start yet. If a future-dated queued
        // period exists the user is still effectively ACTIVE (their current paid
        // period just hasn't been created as a separate row) - but in practice
        // the prior period would still be ACTIVE in that case, so falling here
        // means the user has no live coverage.
        resolvedStatus = null;
        break;
      }

      await tx.subscription.update({
        where: { id: due.id },
        data: { status: 'ACTIVE' },
      });
      // Loop again: the just-promoted period might itself already be elapsed.
    }

    return resolvedStatus;
  });
}

// Creates the Subscription row (+ flips user.subscriptionStatus + logs the
// expense) for a captured Razorpay payment. Idempotent on razorpayOrderId:
// if a Subscription already exists for this order, returns
// { alreadyExists: true } instead of creating a duplicate.
//
// Throws Error('Plan not found') if planId doesn't resolve - callers map
// that to their own 404 shape.
async function fulfillSubscriptionOrder({
  tenantId,
  userId,
  planId,
  razorpayOrderId,
  razorpayPaymentId,
  currency: bodyCurrency,
  billingPeriod,
}) {
  const existing = await prisma.subscription.findUnique({
    where: { razorpayOrderId },
  });
  if (existing) {
    return { alreadyExists: true, subscription: existing };
  }

  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: parseInt(planId) },
  });
  if (!plan) {
    throw new Error('Plan not found');
  }

  const now = new Date();
  let chargeAmount = parseFloat(plan.price);
  let chargeCurrency = plan.currency;
  const period = String(billingPeriod || (plan.billingIntervalDays === 365 ? 'annual' : 'monthly')).toLowerCase() === 'annual' ? 'annual' : 'monthly';
  const rawCurrency = String(bodyCurrency || plan.currency || 'INR').toLowerCase();
  if (plan.pricing && rawCurrency && period) {
    try {
      const parsed = JSON.parse(plan.pricing);
      const bucket = parsed[rawCurrency];
      if (bucket && bucket[period] != null) {
        const raw = String(bucket[period]).replace(/,/g, '').trim();
        const parsedAmount = parseFloat(raw);
        if (!Number.isNaN(parsedAmount) && parsedAmount > 0) {
          chargeAmount = period === 'annual' ? parsedAmount * 12 : parsedAmount;
          chargeCurrency = rawCurrency === 'usd' ? 'USD' : 'INR';
        }
      }
    } catch {
      // bad JSON - silently keep the legacy fallback
    }
  }
  const billingDays = period === 'annual' ? 365 : (plan.billingIntervalDays || 30);

  // Settle any elapsed/queued periods first so we stack onto the true tail.
  await reconcileSubscriptions(userId, tenantId);

  // Find the latest period the user still has coverage for (ACTIVE or already
  // SCHEDULED). If its end is in the future, this purchase is QUEUED to begin
  // the instant that period ends - so buying again mid-cycle (intentionally
  // or by mistake) never overlaps or wastes time; it appends a full period to
  // the tail. e.g. active 1st to 1st, buy on the 6th to new runs 1st to next-1st.
  const latest = await prisma.subscription.findFirst({
    where: { userId, tenantId, status: { in: ['ACTIVE', 'SCHEDULED'] } },
    orderBy: { endDate: 'desc' },
  });

  const hasFutureCoverage = latest && latest.endDate && new Date(latest.endDate) > now;
  const startDate = hasFutureCoverage ? new Date(latest.endDate) : now;
  const endDate = new Date(startDate.getTime() + billingDays * 24 * 60 * 60 * 1000);
  const newStatus = hasFutureCoverage ? 'SCHEDULED' : 'ACTIVE';

  const subscription = await prisma.subscription.create({
    data: {
      userId,
      planId: parseInt(planId),
      planName: plan.name,
      status: newStatus,
      amount: chargeAmount,
      currency: chargeCurrency,
      billingIntervalDays: billingDays,
      startDate,
      endDate,
      renewalDate: endDate,
      razorpayOrderId,
      razorpayPaymentId,
      features: plan.features,
      tenantId,
    },
  });

  // The admin always has live coverage after a successful purchase - either
  // the new period started now, or an existing period is still running with
  // this one queued behind it.
  await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: 'ACTIVE',
      trialEndsAt: null,
    },
  });

  // Log the subscription spend in two places, both best-effort (never block
  // the purchase):
  //   1. Expense Management ledger (/expenses) - NOT shift-scoped, so it
  //      lands reliably in every environment. This is the canonical record.
  //   2. POS Cash Register Expenses tab - only when a drawer shift is OPEN,
  //      so it's deducted from the live cash drawer.
  let expenseRecorded = false;
  let posExpenseRecorded = false;
  try {
    const { recordSubscriptionExpenseEntry, recordSubscriptionExpense } = require('./posExpense');
    const exp = await recordSubscriptionExpenseEntry({
      tenantId,
      userId,
      amount: subscription.amount,
      planName: subscription.planName,
    });
    expenseRecorded = !!exp.recorded;

    const pos = await recordSubscriptionExpense({
      tenantId,
      userId,
      amount: subscription.amount,
      reason: `Subscription: ${subscription.planName}`,
    });
    posExpenseRecorded = !!pos.recorded;
  } catch (e) {
    console.error('[subscriptionFulfillment] expense log failed:', e.message);
  }

  return { alreadyExists: false, subscription, expenseRecorded, posExpenseRecorded };
}

module.exports = { reconcileSubscriptions, fulfillSubscriptionOrder };
