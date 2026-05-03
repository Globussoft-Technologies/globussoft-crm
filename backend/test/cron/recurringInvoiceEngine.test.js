// Unit tests for backend/cron/recurringInvoiceEngine.js — verifies the
// due-rows query excludes BOTH 'VOID' and 'VOIDED' status spellings.
//
// Why this matters (closes #410): the cron originally filtered only
// status='VOID', but routes/billing.js's public POST /api/billing/invoices/:id/void
// route writes status='VOIDED'. A voided recurring invoice template
// could regenerate via the cron path. This test pins the contract — if
// someone reverts the fix, the assertion on the where-clause shape fails.
//
// Mocking strategy mirrors backend/test/lib/notificationService.test.js:
// import the prisma singleton, monkey-patch model methods. The cron
// module is inlined via vitest.config.js → server.deps.inline so its
// require("../lib/prisma") resolves to the same singleton instance.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { processRecurringInvoices } from '../../cron/recurringInvoiceEngine.js';

beforeAll(() => {
  prisma.invoice = {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  prisma.auditLog = { create: vi.fn() };
});

beforeEach(() => {
  prisma.invoice.findMany.mockReset();
  prisma.invoice.create.mockReset();
  prisma.invoice.update.mockReset();
  prisma.auditLog.create.mockReset();

  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.invoice.create.mockResolvedValue({});
  prisma.invoice.update.mockResolvedValue({});
  prisma.auditLog.create.mockResolvedValue({});
});

describe('cron/recurringInvoiceEngine — due-rows query (closes #410)', () => {
  test('findMany where-clause excludes both VOID and VOIDED status spellings', async () => {
    await processRecurringInvoices(null);

    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.invoice.findMany.mock.calls[0][0];
    // Pin the exact contract — Prisma `notIn` operator over both spellings.
    expect(arg.where.status).toEqual({ notIn: ['VOID', 'VOIDED'] });
    expect(arg.where.isRecurring).toBe(true);
    expect(arg.where.nextRecurDate).toHaveProperty('lte');
  });

  test('does NOT use bare not:VOID (the original buggy form)', async () => {
    await processRecurringInvoices(null);
    const arg = prisma.invoice.findMany.mock.calls[0][0];
    // Sanity guard — if someone reverts the fix to `not: 'VOID'`, this fails.
    expect(arg.where.status).not.toEqual({ not: 'VOID' });
  });

  test('VOIDED rows returned by findMany would be filtered out at the DB layer', async () => {
    // The query itself is what filters; we simulate a DB that respects the
    // notIn operator by returning [] when the where excludes VOIDED, and
    // assert no child invoice was minted.
    prisma.invoice.findMany.mockImplementation(async (args) => {
      const excluded = args.where.status?.notIn || [];
      // Pretend the only invoice in the table is a VOIDED template — DB
      // filters it out.
      const all = [{ id: 1, status: 'VOIDED', isRecurring: true, recurFrequency: 'monthly',
                     nextRecurDate: new Date(Date.now() - 86400000), invoiceNum: 'INV-X',
                     amount: 100, contactId: 1, dealId: null, tenantId: 1, contact: { name: 'Acme' } }];
      return all.filter(r => !excluded.includes(r.status));
    });

    await processRecurringInvoices(null);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('non-voided due rows still mint child invoices (positive control)', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 42,
        status: 'UNPAID',
        isRecurring: true,
        recurFrequency: 'monthly',
        nextRecurDate: new Date(Date.now() - 86400000),
        invoiceNum: 'INV-PARENT',
        amount: 250,
        contactId: 7,
        dealId: null,
        tenantId: 3,
        contact: { name: 'Globussoft' },
      },
    ]);

    await processRecurringInvoices(null);
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);

    const created = prisma.invoice.create.mock.calls[0][0].data;
    expect(created.parentInvoiceId).toBe(42);
    expect(created.tenantId).toBe(3);
    expect(created.amount).toBe(250);
    expect(created.status).toBe('UNPAID');
  });

  test('engine swallows per-row errors and continues (no throw)', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 1, status: 'UNPAID', isRecurring: true, recurFrequency: 'monthly',
        nextRecurDate: new Date(Date.now() - 86400000), invoiceNum: 'INV-1',
        amount: 100, contactId: 1, dealId: null, tenantId: 1, contact: { name: 'A' } },
      { id: 2, status: 'UNPAID', isRecurring: true, recurFrequency: 'monthly',
        nextRecurDate: new Date(Date.now() - 86400000), invoiceNum: 'INV-2',
        amount: 200, contactId: 2, dealId: null, tenantId: 1, contact: { name: 'B' } },
    ]);
    prisma.invoice.create
      .mockRejectedValueOnce(new Error('DB write failed'))
      .mockResolvedValueOnce({});

    await expect(processRecurringInvoices(null)).resolves.not.toThrow();
    // First row failed, second row still processed.
    expect(prisma.invoice.create).toHaveBeenCalledTimes(2);
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
