const commission = require('../../lib/genericPlotCommission');
describe('genericPlotCommission', () => {
  test('creates one commission against the full deal', async () => { const db = { plotCommission: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(async ({ data }) => data) }, plotBroker: { findFirst: vi.fn().mockResolvedValue({ id: 51, commissionPercent: 10 }) } }; const row = await commission.syncPlotCommission(db, { id: 701, tenantId: 7, status: 'SUCCESS' }, { id: 501, contactId: 61, plotBrokerId: 51, totalAmount: 4500000 }); expect(row).toMatchObject({ commissionAmount: 450000, eligibleAmount: 4500000 }); });
  test('uses the generic CRM 10 percent default when the assigned broker rate is unset', async () => {
    const db = {
      plotCommission: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => data),
      },
      plotBroker: { findFirst: vi.fn().mockResolvedValue({ id: 51, commissionPercent: null }) },
    };

    const row = await commission.syncPlotCommission(
      db,
      { id: 701, tenantId: 7, status: 'SUCCESS', currency: 'INR' },
      { id: 501, tenantId: 7, contactId: 61, plotBrokerId: 51, totalAmount: 2900099 },
    );

    expect(row).toMatchObject({
      plotBrokerId: 51,
      commissionPercent: 10,
      eligibleAmount: 2900099,
      commissionAmount: 290009.9,
      status: 'EARNED',
    });
  });
  test('resolves a broker assignment when an admin-created booking has no broker id', async () => {
    const db = {
      plotCommission: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => data),
      },
      plotBroker: {
        findMany: vi.fn().mockResolvedValue([
          { id: 50, commissionPercent: 5, assignmentPairsJson: '[{"customerId":61,"plotSiteId":29}]' },
          { id: 51, commissionPercent: 10, assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]' },
        ]),
      },
    };

    const row = await commission.syncPlotCommission(
      db,
      { id: 701, tenantId: 7, status: 'SUCCESS', currency: 'INR' },
      { id: 501, tenantId: 7, contactId: 61, plotSiteId: 30, plotBrokerId: null, totalAmount: 4500000 },
    );

    expect(row).toMatchObject({ plotBrokerId: 51, commissionPercent: 10, commissionAmount: 450000 });
    expect(db.plotBroker.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 7, isActive: true } }));
  });
  test('uses the active Finance rule assigned to the linked sales executive', async () => {
    const db = {
      plotCommission: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => data),
      },
      plotBroker: {
        findFirst: vi.fn().mockResolvedValue({ id: 51, userId: 77, commissionPercent: 1 }),
      },
      plotCommissionPlan: {
        findFirst: vi.fn().mockResolvedValue({
          plotSiteId: 30,
          rules: [{
            id: 90,
            name: 'Sales team commission',
            commissionBasis: 'COLLECTED_AMOUNT',
            rateBp: 400,
            applyToAllStaff: false,
            staffUserIdsJson: '[77]',
            isActive: true,
          }],
        }),
      },
    };

    const row = await commission.syncPlotCommission(
      db,
      { id: 701, tenantId: 7, status: 'SUCCESS', currency: 'INR' },
      { id: 501, tenantId: 7, contactId: 61, plotSiteId: 30, plotBrokerId: 51, totalAmount: 4500000 },
    );

    expect(row).toMatchObject({ commissionPercent: 4, commissionAmount: 180000 });
    expect(db.plotCommissionPlan.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, plotSiteId: 30, isActive: true },
    }));
  });
  test('does not create commission when the Finance rule is assigned to another staff member', async () => {
    const db = {
      plotCommission: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      plotBroker: {
        findFirst: vi.fn().mockResolvedValue({ id: 51, userId: 88, commissionPercent: 10 }),
      },
      plotCommissionPlan: {
        findFirst: vi.fn().mockResolvedValue({
          plotSiteId: 30,
          rules: [{ rateBp: 400, applyToAllStaff: false, staffUserIdsJson: '[77]', isActive: true }],
        }),
      },
    };

    const row = await commission.syncPlotCommission(
      db,
      { id: 701, tenantId: 7, status: 'SUCCESS', currency: 'INR' },
      { id: 501, tenantId: 7, contactId: 61, plotSiteId: 30, plotBrokerId: 51, totalAmount: 4500000 },
    );

    expect(row).toBeNull();
    expect(db.plotCommission.create).not.toHaveBeenCalled();
  });
  test('applies a newly saved Finance rule to open ledger rows for linked staff', async () => {
    const db = {
      plotBooking: {
        findMany: vi.fn().mockResolvedValue([{ id: 501, plotBrokerId: 51, contactId: 61, plotSiteId: 30, totalAmount: 4500000 }]),
      },
      plotCommission: {
        findMany: vi.fn().mockResolvedValue([{ id: 801, plotBookingId: 501, status: 'EARNED' }]),
        update: vi.fn().mockResolvedValue({ id: 801 }),
      },
      plotBroker: {
        findFirst: vi.fn().mockResolvedValue({ id: 51, userId: 77 }),
      },
    };

    await commission.applyPlotCommissionRule(db, 7, 30, {
      rules: [{ rateBp: 400, applyToAllStaff: false, staffUserIdsJson: '[77]', isActive: true }],
    });

    expect(db.plotCommission.update).toHaveBeenCalledWith({
      where: { id: 801 },
      data: { commissionPercent: 4, commissionAmount: 180000 },
    });
  });
  test('allocates commission across successful payments in order', () => { expect(commission.allocateCommissionAcrossPayments([{ id: 2, amount: 300, status: 'SUCCESS', paidAt: '2026-02-01' }, { id: 1, amount: 200, status: 'SUCCESS', paidAt: '2026-01-01' }], 350)).toEqual({ allocations: [expect.objectContaining({ paymentId: 1, commissionDeduction: 200 }), expect.objectContaining({ paymentId: 2, commissionDeduction: 150 })], commissionDeducted: 350, commissionOutstanding: 0 }); });
});

test.each(['EARNED', 'APPROVED', 'PAID'])('reverses %s commissions when payments are refunded', async status => {
  const db = { plotCommission: { findFirst: vi.fn().mockResolvedValue({ id: 1, status, commissionAmount: 100 }), update: vi.fn().mockImplementation(async ({ data }) => data) }, $queryRaw: vi.fn().mockResolvedValue([{ amountPaid: 0 }]) };
  expect(await commission.syncPlotCommission(db, { status: 'REFUNDED', tenantId: 7 }, { id: 501 })).toMatchObject({ status: 'REVERSED', paidAt: null, approvedAt: null });
});
