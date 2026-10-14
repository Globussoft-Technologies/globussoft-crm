const { Prisma } = require('@prisma/client');

// Contact IDs can be shared by a family and are never payment ownership.
// Legacy invoices without patientId may establish ownership through a visit;
// an explicit patientId always takes precedence over that legacy fallback.
function customerPaymentQuery({ tenantId, patientId, id, invoiceId, status, gateway, createdAt = {}, limit = 200, offset = 0, aggregate = false, paymentDate = false }) {
  const projection = aggregate
    ? Prisma.sql`COUNT(*) AS total, COALESCE(SUM(CASE WHEN p.status IN ('SUCCESS','PAID','CAPTURED') THEN p.amount ELSE 0 END),0) AS collected,
      COALESCE(SUM(p.status = 'PENDING'),0) AS pending, COALESCE(SUM(p.status = 'FAILED'),0) AS failed`
    : Prisma.sql`p.id, p.invoiceId, p.description, p.amount, p.currency, p.gateway, p.status, p.paidAt, p.createdAt`;
  const date = paymentDate ? Prisma.sql`COALESCE(p.paidAt,p.createdAt)` : Prisma.sql`p.createdAt`;
  return Prisma.sql`SELECT ${projection} FROM Payment p
    WHERE p.tenantId = ${tenantId} AND p.invoiceId IS NOT NULL
    AND EXISTS (SELECT 1 FROM Invoice i WHERE i.id = p.invoiceId AND i.tenantId = p.tenantId
      AND (i.patientId = ${patientId} OR (i.patientId IS NULL AND EXISTS
        (SELECT 1 FROM Visit v WHERE v.id = i.visitId AND v.tenantId = i.tenantId AND v.patientId = ${patientId}))))
    ${id !== undefined ? Prisma.sql`AND p.id = ${id}` : Prisma.empty}
    ${invoiceId !== undefined ? Prisma.sql`AND p.invoiceId = ${invoiceId}` : Prisma.empty}
    ${status ? Prisma.sql`AND p.status = ${status}` : Prisma.empty}
    ${gateway ? Prisma.sql`AND p.gateway = ${gateway}` : Prisma.empty}
    ${createdAt.gte ? Prisma.sql`AND ${date} >= ${createdAt.gte}` : Prisma.empty}
    ${createdAt.lte ? Prisma.sql`AND ${date} <= ${createdAt.lte}` : Prisma.empty}
    ${aggregate ? Prisma.empty : Prisma.sql`ORDER BY p.createdAt DESC, p.id DESC LIMIT ${id !== undefined ? 1 : limit} OFFSET ${offset}`}`;
}

module.exports = { customerPaymentQuery };
