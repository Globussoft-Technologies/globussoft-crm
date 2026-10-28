"use strict";
const DEFAULT_COMMISSION_PERCENT = 10;
function roundMoney(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }
function parseMetadata(value) { try { return typeof value === "string" ? JSON.parse(value) : (value || {}); } catch (_error) { return {}; } }
function parseStoredArray(value) { try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; } catch (_error) { return []; } }
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
async function resolvePlotBroker(db, tenantId, booking) {
  const storedBrokerId = Number(booking?.plotBrokerId);
  if (Number.isInteger(storedBrokerId) && storedBrokerId > 0) {
    return db.plotBroker.findFirst({ where: { id: storedBrokerId, tenantId, isActive: true }, select: { id: true, commissionPercent: true } });
  }
  const contactId = Number(booking?.contactId);
  const plotSiteId = Number(booking?.plotSiteId);
  if (!Number.isInteger(contactId) || !Number.isInteger(plotSiteId) || !db.plotBroker?.findMany) return null;
  const brokers = await db.plotBroker.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, commissionPercent: true, plotSiteId: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true },
  });
  return brokers.find((broker) => brokerAssignmentPairs(broker).some((pair) => pair.contactId === contactId && pair.plotSiteId === plotSiteId)) || null;
}
async function syncPlotCommission(db, payment, booking) {
  if (!db?.plotCommission) return null;
  const metadata = parseMetadata(payment.metadata); const plotBookingId = Number(booking?.id || metadata.plotBookingId); const tenantId = Number(payment.tenantId || booking?.tenantId);
  if (!Number.isInteger(plotBookingId) || plotBookingId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0) return null;
  const existing = await db.plotCommission.findFirst({ where: { tenantId, plotBookingId } }); if (existing) {
    const rows = await db.$queryRaw`SELECT COALESCE(SUM(amount), 0) AS amountPaid FROM Payment
      WHERE tenantId = ${tenantId} AND status = 'SUCCESS'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(metadata), metadata, '{}'), '$.kind')) = 'plot-booking-payment'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(metadata), metadata, '{}'), '$.plotBookingId')) = ${String(plotBookingId)}`;
    const funded = roundMoney(rows[0]?.amountPaid);
    if ((funded < Number(existing.commissionAmount) && ['APPROVED', 'PAID'].includes(existing.status)) || (funded <= 0 && existing.status !== 'REVERSED')) {
      return db.plotCommission.update({ where: { id: existing.id }, data: { status: 'REVERSED', reversedAt: new Date(), approvedAt: null, approvedByUserId: null, paidAt: null, paidByUserId: null } });
    }
    if (funded > 0 && existing.status === 'REVERSED') {
      return db.plotCommission.update({ where: { id: existing.id }, data: { status: 'EARNED', reversedAt: null } });
    }
    return existing;
  }
  if (String(payment?.status || '').toUpperCase() !== 'SUCCESS') return null;
  const broker = await resolvePlotBroker(db, tenantId, booking);
  const commissionPercent = broker?.commissionPercent == null
    ? DEFAULT_COMMISSION_PERCENT
    : Number(broker.commissionPercent);
  const eligibleAmount = roundMoney(booking?.totalAmount);
  if (!broker || !Number.isFinite(commissionPercent) || commissionPercent <= 0 || eligibleAmount <= 0) return null;
  return db.plotCommission.create({ data: { tenantId, plotBookingId, paymentId: payment.id, plotBrokerId: broker.id, contactId: booking.contactId, currency: payment.currency || "INR", commissionPercent: roundMoney(commissionPercent), eligibleAmount, commissionAmount: roundMoney(eligibleAmount * commissionPercent / 100), status: "EARNED" } });
}
function allocateCommissionAcrossPayments(payments, commissionAmount) {
  let remaining = Math.max(0, roundMoney(commissionAmount));
  const successful = (Array.isArray(payments) ? payments : []).filter((payment) => String(payment.status || "").toUpperCase() === "SUCCESS").sort((a, b) => new Date(a.paidAt || a.createdAt || 0) - new Date(b.paidAt || b.createdAt || 0));
  const allocations = successful.map((payment) => { const grossAmount = Math.max(0, roundMoney(payment.amount)); const commissionDeduction = Math.min(grossAmount, remaining); remaining = roundMoney(remaining - commissionDeduction); return { paymentId: payment.id, paidAt: payment.paidAt || payment.createdAt || null, grossAmount, commissionDeduction, netPaymentAmount: roundMoney(grossAmount - commissionDeduction) }; });
  return { allocations, commissionDeducted: roundMoney(Math.max(0, Number(commissionAmount || 0) - remaining)), commissionOutstanding: remaining };
}
module.exports = { syncPlotCommission, allocateCommissionAcrossPayments };
