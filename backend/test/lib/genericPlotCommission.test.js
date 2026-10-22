const commission = require('../../lib/genericPlotCommission');
describe('genericPlotCommission', () => {
  test('creates one commission against the full deal', async () => { const db = { plotCommission: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(async ({ data }) => data) }, plotBroker: { findFirst: vi.fn().mockResolvedValue({ id: 51, commissionPercent: 10 }) } }; const row = await commission.syncPlotCommission(db, { id: 701, tenantId: 7, status: 'SUCCESS' }, { id: 501, contactId: 61, plotBrokerId: 51, totalAmount: 4500000 }); expect(row).toMatchObject({ commissionAmount: 450000, eligibleAmount: 4500000 }); });
  test('allocates commission across successful payments in order', () => { expect(commission.allocateCommissionAcrossPayments([{ id: 2, amount: 300, status: 'SUCCESS', paidAt: '2026-02-01' }, { id: 1, amount: 200, status: 'SUCCESS', paidAt: '2026-01-01' }], 350)).toEqual({ allocations: [expect.objectContaining({ paymentId: 1, commissionDeduction: 200 }), expect.objectContaining({ paymentId: 2, commissionDeduction: 150 })], commissionDeducted: 350, commissionOutstanding: 0 }); });
});

test.each(['EARNED', 'APPROVED', 'PAID'])('reverses %s commissions when payments are refunded', async status => {
  const db = { plotCommission: { findFirst: vi.fn().mockResolvedValue({ id: 1, status, commissionAmount: 100 }), update: vi.fn().mockImplementation(async ({ data }) => data) }, $queryRaw: vi.fn().mockResolvedValue([{ amountPaid: 0 }]) };
  expect(await commission.syncPlotCommission(db, { status: 'REFUNDED', tenantId: 7 }, { id: 501 })).toMatchObject({ status: 'REVERSED', paidAt: null, approvedAt: null });
});
