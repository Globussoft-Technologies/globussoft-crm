const prisma = require('./prisma');
const { syncPlotBookingInvoice } = require('./plotBookingInvoice');
const { syncPlotCommission } = require('./genericPlotCommission');

// Payment.metadata is a TEXT column. Extract exact JSON values in MySQL,
// rather than matching an ID prefix (12 must never match 123).
async function successfulPaymentTotal(db, tenantId, bookingId) {
  const rows = await db.$queryRaw`
    SELECT COALESCE(SUM(amount), 0) AS amountPaid FROM Payment
    WHERE tenantId = ${tenantId} AND status = 'SUCCESS'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(metadata), metadata, '{}'), '$.kind')) = 'plot-booking-payment'
      AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(metadata), metadata, '{}'), '$.plotBookingId')) = ${String(bookingId)}
  `;
  return Number(rows[0]?.amountPaid || 0);
}

async function lockBooking(db, tenantId, bookingId) {
  await db.$queryRaw`SELECT id FROM PlotBooking WHERE id = ${bookingId} AND tenantId = ${tenantId} FOR UPDATE`;
}

async function reconcilePlotBookingPayment(payment) {
  let metadata;
  try { metadata = JSON.parse(payment?.metadata || '{}'); } catch { return null; }
  const bookingId = Number(metadata?.plotBookingId);
  if (metadata?.kind !== 'plot-booking-payment' || !Number.isInteger(bookingId) || bookingId <= 0) return null;
  return prisma.$transaction(async (tx) => {
    // All booking balance writers take the same row lock before reading.
    await lockBooking(tx, payment.tenantId, bookingId);
    const booking = await tx.plotBooking.findFirst({ where: { id: bookingId, tenantId: payment.tenantId } });
    if (!booking) return null;
    const total = Number(booking.totalAmount || 0);
    const amountPaid = Math.min(total, await successfulPaymentTotal(tx, payment.tenantId, bookingId));
    const balance = Math.max(0, total - amountPaid);
    const updated = await tx.plotBooking.update({
      where: { id: booking.id },
      data: { amountPaid, balance, paymentStatus: balance === 0 ? 'PAID' : 'PARTIAL' },
    });
    await syncPlotCommission(tx, payment, { ...booking, ...updated });
    const installmentId = Number(metadata.installmentId);
    if (Number.isInteger(installmentId) && installmentId > 0) {
      const paymentStatus = String(payment.status || '').toUpperCase();
      const installmentStatus = paymentStatus === 'SUCCESS'
        ? 'PAID'
        : paymentStatus === 'FAILED'
          ? 'FAILED'
          : paymentStatus === 'PROCESSING'
            ? 'PROCESSING'
            : paymentStatus === 'REFUNDED'
              ? 'PLANNED'
              : 'PAYMENT_INITIATED';
      await tx.plotInstallment.updateMany({
        where: { id: installmentId, tenantId: payment.tenantId, plotBookingId: booking.id, ...(paymentStatus === 'SUCCESS' ? {} : { paymentId: payment.id }), ...(['PROCESSING', 'FAILED', 'PENDING'].includes(paymentStatus) ? { status: { not: 'PAID' } } : {}) },
        data: {
          status: installmentStatus,
          paymentId: paymentStatus === 'REFUNDED' ? null : payment.id,
        },
      });
    }
    const reconciled = {
      ...booking,
      ...updated,
      totalAmount: total,
      amountPaid,
      balance,
    };
    await syncPlotBookingInvoice(tx, {
      tenantId: payment.tenantId,
      booking: reconciled,
      paymentId: payment.id,
      amountPaid: reconciled.amountPaid,
      balance: reconciled.balance,
      paymentMode: payment.gateway,
      paidAt: payment.paidAt || new Date(),
    });
    return reconciled;
  });
}

module.exports = { lockBooking, successfulPaymentTotal, reconcilePlotBookingPayment };
