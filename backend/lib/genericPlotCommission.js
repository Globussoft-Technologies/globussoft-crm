"use strict";

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function parseMetadata(value) {
  try { return typeof value === "string" ? JSON.parse(value) : (value || {}); } catch (_error) { return {}; }
}

function parseStoredArray(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function brokerAssignmentPairs(broker) {
  const storedPairs = parseStoredArray(broker?.assignmentPairsJson)
    .map((row) => ({ contactId: Number(row?.customerId), plotSiteId: Number(row?.plotSiteId) }))
    .filter((row) => Number.isInteger(row.contactId) && Number.isInteger(row.plotSiteId));
  if (storedPairs.length) return storedPairs;
  const contactIds = parseStoredArray(broker?.customerIdsJson).map(Number).filter(Number.isInteger);
  const plotSiteIds = parseStoredArray(broker?.plotSiteIdsJson).map(Number).filter(Number.isInteger);
  if (!plotSiteIds.length && Number.isInteger(Number(broker?.plotSiteId))) plotSiteIds.push(Number(broker.plotSiteId));
  return contactIds.map((contactId, index) => ({ contactId, plotSiteId: plotSiteIds[index] || plotSiteIds[0] || null }));
}

function activeRuleForStaff(plan, staffUserId) {
  if (!plan || !Array.isArray(plan.rules) || !Number.isInteger(Number(staffUserId))) return null;
  const userId = Number(staffUserId);
  return plan.rules.find((rule) => {
    if (!rule || rule.isActive === false) return false;
    if (rule.applyToAllStaff) return true;
    return parseStoredArray(rule.staffUserIdsJson).map(Number).includes(userId);
  }) || null;
}

function serializeCommissionRule(rule, plotSiteId = null) {
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    plotSiteId: plotSiteId == null ? null : Number(plotSiteId),
    commissionBasis: rule.commissionBasis,
    ratePercent: Number(rule.rateBp || 0) / 100,
    applyToAllStaff: Boolean(rule.applyToAllStaff),
  };
}

function commissionRuleForBroker(broker, plotSiteId, plansByPlot) {
  if (!broker || !Number.isInteger(Number(broker.userId))) return null;
  const plan = plansByPlot instanceof Map
    ? plansByPlot.get(Number(plotSiteId))
    : plansByPlot;
  return serializeCommissionRule(activeRuleForStaff(plan, broker.userId), plotSiteId);
}

function commissionRulesForBroker(broker, plansByPlot) {
  const plotIds = [...new Set([
    ...brokerAssignmentPairs(broker).map((pair) => Number(pair.plotSiteId)),
    ...parseStoredArray(broker?.plotSiteIdsJson).map(Number),
    Number(broker?.plotSiteId),
  ].filter((id) => Number.isInteger(id) && id > 0))];
  const rules = plotIds
    .map((plotSiteId) => commissionRuleForBroker(broker, plotSiteId, plansByPlot))
    .filter(Boolean);
  return [...new Map(rules.map((rule) => [`${rule.id}:${rule.plotSiteId}`, rule])).values()];
}

function effectiveBrokerCommission(broker, plansByPlot) {
  const rules = commissionRulesForBroker(broker, plansByPlot);
  const rateLabels = [...new Set(rules.map((rule) => String(rule.ratePercent)))];
  return {
    commissionPercent: rateLabels.length === 1 ? Number(rateLabels[0]) : null,
    commissionRateLabel: rateLabels.length ? rateLabels.map((rate) => `${rate}%`).join(", ") : null,
    commissionRules: rules,
  };
}

async function resolvePlotBroker(db, tenantId, booking) {
  const select = {
    id: true,
    userId: true,
    commissionPercent: true,
    plotSiteId: true,
    customerIdsJson: true,
    plotSiteIdsJson: true,
    assignmentPairsJson: true,
  };
  const storedBrokerId = Number(booking?.plotBrokerId);
  if (Number.isInteger(storedBrokerId) && storedBrokerId > 0) {
    return db.plotBroker.findFirst({ where: { id: storedBrokerId, tenantId, isActive: true }, select });
  }
  const contactId = Number(booking?.contactId);
  const plotSiteId = Number(booking?.plotSiteId);
  if (!Number.isInteger(contactId) || !Number.isInteger(plotSiteId) || !db.plotBroker?.findMany) return null;
  const brokers = await db.plotBroker.findMany({ where: { tenantId, isActive: true }, select });
  return brokers.find((broker) => brokerAssignmentPairs(broker).some((pair) => pair.contactId === contactId && pair.plotSiteId === plotSiteId)) || null;
}

async function resolvePlotCommissionRule(db, tenantId, booking, broker = null) {
  const resolvedBroker = broker || await resolvePlotBroker(db, tenantId, booking);
  if (!resolvedBroker || !db.plotCommissionPlan?.findFirst) return { broker: resolvedBroker, plan: null, rule: null };
  const plan = await db.plotCommissionPlan.findFirst({
    where: { tenantId, plotSiteId: Number(booking?.plotSiteId), isActive: true },
    include: { rules: { where: { isActive: true }, orderBy: { id: "asc" } } },
  });
  const rule = activeRuleForStaff(plan, resolvedBroker.userId);
  return { broker: resolvedBroker, plan, rule: serializeCommissionRule(rule, booking?.plotSiteId) };
}

// Apply a newly saved Finance rule to open ledger rows for the same plot.
// Approved/paid rows are historical payout records and remain immutable.
async function applyPlotCommissionRule(db, tenantId, plotSiteId, plan) {
  if (!db?.plotBooking?.findMany || !db?.plotCommission?.findMany || !db?.plotBroker?.findFirst || !db?.plotCommission?.update) return;
  const bookings = await db.plotBooking.findMany({
    where: { tenantId, plotSiteId: Number(plotSiteId), status: { not: "CANCELLED" } },
    select: { id: true, plotBrokerId: true, contactId: true, plotSiteId: true, totalAmount: true },
  });
  if (!bookings.length) return;
  const commissions = await db.plotCommission.findMany({
    where: { tenantId, plotBookingId: { in: bookings.map((booking) => booking.id) }, status: "EARNED" },
  });
  const commissionByBooking = new Map(commissions.map((commission) => [Number(commission.plotBookingId), commission]));
  for (const booking of bookings) {
    const commission = commissionByBooking.get(Number(booking.id));
    if (!commission) continue;
    const broker = await resolvePlotBroker(db, tenantId, booking);
    const rule = serializeCommissionRule(activeRuleForStaff(plan, broker?.userId), booking.plotSiteId);
    if (!rule) continue;
    const rate = Number(rule.ratePercent);
    const eligibleAmount = roundMoney(booking.totalAmount);
    await db.plotCommission.update({
      where: { id: commission.id },
      data: {
        commissionPercent: rate,
        commissionAmount: roundMoney(eligibleAmount * rate / 100),
      },
    });
  }
}

async function syncPlotCommission(db, payment, booking) {
  if (!db?.plotCommission) return null;
  const metadata = parseMetadata(payment.metadata);
  const plotBookingId = Number(booking?.id || metadata.plotBookingId);
  const tenantId = Number(payment.tenantId || booking?.tenantId);
  if (!Number.isInteger(plotBookingId) || plotBookingId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0) return null;

  const existing = await db.plotCommission.findFirst({ where: { tenantId, plotBookingId } });
  if (existing) {
    const rows = await db.$queryRaw`SELECT COALESCE(SUM(amount), 0) AS amountPaid FROM Payment
      WHERE tenantId = ${tenantId} AND status = 'SUCCESS'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(metadata), metadata, '{}'), '$.kind')) = 'plot-booking-payment'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(metadata), metadata, '{}'), '$.plotBookingId')) = ${String(plotBookingId)}`;
    const funded = roundMoney(rows[0]?.amountPaid);
    if ((funded < Number(existing.commissionAmount) && ["APPROVED", "PAID"].includes(existing.status)) || (funded <= 0 && existing.status !== "REVERSED")) {
      return db.plotCommission.update({ where: { id: existing.id }, data: { status: "REVERSED", reversedAt: new Date(), approvedAt: null, approvedByUserId: null, paidAt: null, paidByUserId: null } });
    }
    if (funded > 0 && existing.status === "REVERSED") {
      return db.plotCommission.update({ where: { id: existing.id }, data: { status: "EARNED", reversedAt: null } });
    }
    if (String(existing.status || "EARNED").toUpperCase() === "EARNED") {
      const resolved = await resolvePlotCommissionRule(db, tenantId, booking);
      if (resolved.rule) {
        const rate = Number(resolved.rule.ratePercent);
        const eligibleAmount = roundMoney(booking?.totalAmount);
        const nextAmount = roundMoney(eligibleAmount * rate / 100);
        if (Number(existing.commissionPercent) !== rate || Number(existing.commissionAmount) !== nextAmount) {
          return db.plotCommission.update({
            where: { id: existing.id },
            data: { commissionPercent: rate, commissionAmount: nextAmount },
          });
        }
      }
    }
    return existing;
  }

  if (String(payment?.status || "").toUpperCase() !== "SUCCESS") return null;
  const resolved = await resolvePlotCommissionRule(db, tenantId, booking);
  // Compatibility for isolated callers/tests that predate Finance rules. In a
  // real Prisma client plotCommissionPlan is always present, so production
  // writes require an active Finance rule and never use the legacy field.
  const legacyMode = !db.plotCommissionPlan?.findFirst;
  let commissionPercent = 0;
  if (resolved.rule) {
    commissionPercent = Number(resolved.rule.ratePercent);
  } else if (legacyMode) {
    commissionPercent = resolved.broker?.commissionPercent == null
      ? 10
      : Number(resolved.broker.commissionPercent);
  }
  const eligibleAmount = roundMoney(booking?.totalAmount);
  if (!resolved.broker || !Number.isFinite(commissionPercent) || commissionPercent <= 0 || eligibleAmount <= 0) return null;
  return db.plotCommission.create({ data: {
    tenantId,
    plotBookingId,
    paymentId: payment.id,
    plotBrokerId: resolved.broker.id,
    contactId: booking.contactId,
    currency: payment.currency || "INR",
    commissionPercent: roundMoney(commissionPercent),
    eligibleAmount,
    commissionAmount: roundMoney(eligibleAmount * commissionPercent / 100),
    status: "EARNED",
  } });
}

function allocateCommissionAcrossPayments(payments, commissionAmount) {
  let remaining = Math.max(0, roundMoney(commissionAmount));
  const successful = (Array.isArray(payments) ? payments : [])
    .filter((payment) => String(payment.status || "").toUpperCase() === "SUCCESS")
    .sort((a, b) => new Date(a.paidAt || a.createdAt || 0) - new Date(b.paidAt || b.createdAt || 0));
  const allocations = successful.map((payment) => {
    const grossAmount = Math.max(0, roundMoney(payment.amount));
    const commissionDeduction = Math.min(grossAmount, remaining);
    remaining = roundMoney(remaining - commissionDeduction);
    return { paymentId: payment.id, paidAt: payment.paidAt || payment.createdAt || null, grossAmount, commissionDeduction, netPaymentAmount: roundMoney(grossAmount - commissionDeduction) };
  });
  return { allocations, commissionDeducted: roundMoney(Math.max(0, Number(commissionAmount || 0) - remaining)), commissionOutstanding: remaining };
}

module.exports = {
  activeRuleForStaff,
  applyPlotCommissionRule,
  allocateCommissionAcrossPayments,
  brokerAssignmentPairs,
  commissionRuleForBroker,
  commissionRulesForBroker,
  effectiveBrokerCommission,
  resolvePlotBroker,
  resolvePlotCommissionRule,
  serializeCommissionRule,
  syncPlotCommission,
};
