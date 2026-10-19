const prisma = require('./prisma');
const { syncPlotBookingInvoice } = require('./plotBookingInvoice');

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
  const reconciled = await prisma.$transaction(async (tx) => {
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
    return {
      ...booking,
      ...updated,
      totalAmount: total,
      amountPaid,
      balance,
    };
  });
  if (!reconciled) return null;
  await syncPlotBookingInvoice(prisma, {
    tenantId: payment.tenantId,
    booking: reconciled,
    paymentId: payment.id,
    amountPaid: reconciled.amountPaid,
    balance: reconciled.balance,
    paymentMode: payment.gateway,
    paidAt: payment.paidAt || new Date(),
  });
  return reconciled;
}

module.exports = { lockBooking, successfulPaymentTotal, reconcilePlotBookingPayment };
