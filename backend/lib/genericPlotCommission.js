"use strict";
function roundMoney(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }
function parseMetadata(value) { try { return typeof value === "string" ? JSON.parse(value) : (value || {}); } catch (_error) { return {}; } }
async function syncPlotCommission(db, payment, booking) {
  if (!db?.plotCommission || String(payment?.status || "").toUpperCase() !== "SUCCESS") return null;
  const metadata = parseMetadata(payment.metadata); const plotBookingId = Number(booking?.id || metadata.plotBookingId); const tenantId = Number(payment.tenantId || booking?.tenantId);
  if (!Number.isInteger(plotBookingId) || plotBookingId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0) return null;
  const existing = await db.plotCommission.findFirst({ where: { tenantId, plotBookingId } }); if (existing) return existing;
  const plotBrokerId = Number(booking?.plotBrokerId); if (!Number.isInteger(plotBrokerId) || plotBrokerId <= 0) return null;
  const broker = await db.plotBroker.findFirst({ where: { id: plotBrokerId, tenantId, isActive: true }, select: { id: true, commissionPercent: true } });
  const commissionPercent = Number(broker?.commissionPercent || 0); const eligibleAmount = roundMoney(booking?.totalAmount);
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
