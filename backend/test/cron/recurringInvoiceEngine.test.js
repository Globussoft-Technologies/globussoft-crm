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

describe('cron/recurringInvoiceEngine — cadence math + side-effects', () => {
  // Helper: build a due-row scaffold with sensible defaults.
  const dueRow = (overrides = {}) => ({
    id: 100,
    status: 'UNPAID',
    isRecurring: true,
    recurFrequency: 'monthly',
    nextRecurDate: new Date('2026-01-15T00:00:00.000Z'),
    invoiceNum: 'INV-PARENT',
    amount: 500,
    contactId: 9,
    dealId: null,
    tenantId: 2,
    contact: { name: 'Globussoft Demo' },
    ...overrides,
  });

  test('empty due list — no creates, no updates, no audit, no socket emit', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    const io = { emit: vi.fn() };

    await processRecurringInvoices(io);

    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    // `if (created > 0)` guards the emit — empty list must NOT fire it.
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('monthly cadence — next nextRecurDate advances by exactly 1 month from PRIOR nextRecurDate (not from now)', async () => {
    // This pins the specific bug class: addInterval(inv.nextRecurDate, ...)
    // walks from the PARENT's schedule, not from clock-now. Otherwise a
    // late-running cron (e.g. server downtime for 3 days) would silently
    // skip those 3 days of recurrence instead of catching up next tick.
    const parentDate = new Date('2026-02-10T00:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([dueRow({ nextRecurDate: parentDate, recurFrequency: 'monthly' })]);

    await processRecurringInvoices(null);

    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 100 });
    // Parent was 2026-02-10; +1 month = 2026-03-10 (NOT today + 1 month).
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });

  test('quarterly cadence — advances by 3 months', async () => {
    const parentDate = new Date('2026-01-15T00:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([dueRow({ nextRecurDate: parentDate, recurFrequency: 'quarterly' })]);

    await processRecurringInvoices(null);

    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe('2026-04-15T00:00:00.000Z');
  });

  test('yearly cadence — advances by 1 full year', async () => {
    const parentDate = new Date('2026-03-20T00:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([dueRow({ nextRecurDate: parentDate, recurFrequency: 'yearly' })]);

    await processRecurringInvoices(null);

    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe('2027-03-20T00:00:00.000Z');
  });

  test('unknown / malformed recurFrequency defaults to monthly (no throw)', async () => {
    // addInterval's switch has `default: d.setMonth(d.getMonth() + 1)`.
    // A row with a garbage frequency should NOT poison the loop; it
    // should fall through to the monthly default.
    const parentDate = new Date('2026-05-01T00:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([
      dueRow({ nextRecurDate: parentDate, recurFrequency: 'fortnightly' }),
    ]);

    await expect(processRecurringInvoices(null)).resolves.not.toThrow();
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  test('socket.io emit fires exactly once per tick with created count', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      dueRow({ id: 1, invoiceNum: 'INV-A' }),
      dueRow({ id: 2, invoiceNum: 'INV-B' }),
      dueRow({ id: 3, invoiceNum: 'INV-C' }),
    ]);
    const io = { emit: vi.fn() };

    await processRecurringInvoices(io);

    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith('invoice_created', { count: 3 });
  });

  test('tenantId falls back to 1 when parent invoice has null tenantId (legacy seed data)', async () => {
    // Legacy seed data pre-multi-tenant could have null tenantId. The
    // `inv.tenantId || 1` fallback prevents the FK constraint from blowing
    // up — both the child invoice AND the audit log inherit tenant 1.
    prisma.invoice.findMany.mockResolvedValue([dueRow({ tenantId: null })]);

    await processRecurringInvoices(null);

    const createdInvoice = prisma.invoice.create.mock.calls[0][0].data;
    const createdAudit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(createdInvoice.tenantId).toBe(1);
    expect(createdAudit.tenantId).toBe(1);
  });

  test('audit log payload has correct shape — action/entity/details JSON references both invoices', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      dueRow({ id: 77, invoiceNum: 'INV-PARENT-77', tenantId: 5 }),
    ]);

    await processRecurringInvoices(null);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditData = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditData.action).toBe('CREATE');
    expect(auditData.entity).toBe('Invoice');
    expect(auditData.tenantId).toBe(5);

    // details is a JSON-stringified blob — parse + assert structure.
    const details = JSON.parse(auditData.details);
    expect(details.source).toBe('Recurring');
    expect(details.parentInvoice).toBe('INV-PARENT-77');
    // newInvoice format is `INV-<6 hex uppercase>` from crypto.randomBytes(3).
    expect(details.newInvoice).toMatch(/^INV-[0-9A-F]{6}$/);
  });

  test('findMany rejection — outer catch swallows; no socket emit, no throw', async () => {
    // The outer try/catch around the whole engine should absorb a DB
    // outage during the initial findMany — engine returns silently
    // rather than crashing the cron host process.
    prisma.invoice.findMany.mockRejectedValue(new Error('connection refused'));
    const io = { emit: vi.fn() };

    await expect(processRecurringInvoices(io)).resolves.not.toThrow();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
});
