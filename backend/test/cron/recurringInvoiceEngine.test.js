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
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  prisma.auditLog = { create: vi.fn() };
  // Post-214017c1 each due row is processed inside a $transaction(tx => ...).
  // The atomic-lock rewrite re-reads the parent via tx.invoice.findUnique and
  // mints child invoices in a catch-up while-loop. Run the callback against
  // the same singleton (tx === prisma); array form resolves in parallel.
  prisma.$transaction = vi.fn(async (arg) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
  );
});

beforeEach(() => {
  prisma.invoice.findMany.mockReset();
  prisma.invoice.findUnique.mockReset();
  prisma.invoice.create.mockReset();
  prisma.invoice.update.mockReset();
  prisma.auditLog.create.mockReset();

  prisma.invoice.findMany.mockResolvedValue([]);
  // The transaction re-reads the parent by id (tx.invoice.findUnique). By
  // default echo back the row the engine is iterating: resolve to whatever
  // findMany already returned for that id (read from its recorded results so
  // we do NOT inflate findMany's call count). Tests needing a specific parent
  // state override findUnique directly.
  prisma.invoice.findUnique.mockImplementation(async ({ where }) => {
    const results = prisma.invoice.findMany.mock.results;
    const last = results[results.length - 1];
    const rows = last ? await last.value : null;
    if (Array.isArray(rows)) {
      const hit = rows.find((r) => r.id === where.id);
      if (hit) return hit;
    }
    return null;
  });
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
    // Default to ~2 days ago so the catch-up while-loop mints exactly ONE
    // child (single missed period). Tests that exercise multi-period catch-up
    // override nextRecurDate explicitly.
    nextRecurDate: new Date(Date.now() - 2 * 86400000),
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

  // Post-214017c1 the transaction body runs a CATCH-UP while-loop: it mints
  // one child for EVERY missed period from nextRecurDate up to now, then
  // advances the parent to the first FUTURE period. To pin the per-interval
  // `addInterval` math deterministically (independent of the wall-clock date
  // the suite runs on) we seed nextRecurDate a few days in the PAST so the
  // loop runs exactly once: one child minted, parent advanced by one interval.
  const recentPast = (days = 2) => new Date(Date.now() - days * 86400000);

  test('monthly cadence — advances by exactly 1 month from the missed nextRecurDate', async () => {
    // This pins the specific bug class: addInterval(nextDate, ...) walks from
    // the PARENT's schedule, not from clock-now. With a single missed period
    // the parent advances by one month past the missed date.
    const parentDate = recentPast();
    prisma.invoice.findMany.mockResolvedValue([dueRow({ nextRecurDate: parentDate, recurFrequency: 'monthly' })]);

    await processRecurringInvoices(null);

    // One missed period → exactly one child minted, one parent advance.
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 100 });
    const expected = new Date(parentDate); expected.setMonth(expected.getMonth() + 1);
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe(expected.toISOString());
  });

  test('quarterly cadence — advances by 3 months', async () => {
    const parentDate = recentPast();
    prisma.invoice.findMany.mockResolvedValue([dueRow({ nextRecurDate: parentDate, recurFrequency: 'quarterly' })]);

    await processRecurringInvoices(null);

    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    const expected = new Date(parentDate); expected.setMonth(expected.getMonth() + 3);
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe(expected.toISOString());
  });

  test('yearly cadence — advances by 1 full year', async () => {
    const parentDate = recentPast();
    prisma.invoice.findMany.mockResolvedValue([dueRow({ nextRecurDate: parentDate, recurFrequency: 'yearly' })]);

    await processRecurringInvoices(null);

    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    const expected = new Date(parentDate); expected.setFullYear(expected.getFullYear() + 1);
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe(expected.toISOString());
  });

  test('unknown / malformed recurFrequency defaults to monthly (no throw)', async () => {
    // addInterval's switch has `default: d.setMonth(d.getMonth() + 1)`.
    // A row with a garbage frequency should NOT poison the loop; it
    // should fall through to the monthly default.
    const parentDate = recentPast();
    prisma.invoice.findMany.mockResolvedValue([
      dueRow({ nextRecurDate: parentDate, recurFrequency: 'fortnightly' }),
    ]);

    await expect(processRecurringInvoices(null)).resolves.not.toThrow();
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    const expected = new Date(parentDate); expected.setMonth(expected.getMonth() + 1);
    expect(updateArgs.data.nextRecurDate.toISOString()).toBe(expected.toISOString());
  });

  test('catch-up loop mints one child per missed period', async () => {
    // New post-214017c1 behaviour: if the cron was down for several periods,
    // the while-loop mints a child for EACH missed month, not just one. Three
    // missed months (~70 days ago, monthly) → 3 children, single parent advance.
    const parentDate = new Date(Date.now() - 70 * 86400000); // ~2 months + change
    prisma.invoice.findMany.mockResolvedValue([
      dueRow({ nextRecurDate: parentDate, recurFrequency: 'monthly' }),
    ]);

    await processRecurringInvoices(null);

    // Walk the periods to compute how many fall on/before now.
    let n = 0; const cursor = new Date(parentDate);
    while (cursor <= new Date()) { n++; cursor.setMonth(cursor.getMonth() + 1); }
    expect(n).toBeGreaterThanOrEqual(2);
    expect(prisma.invoice.create).toHaveBeenCalledTimes(n);
    // Exactly one parent advance + one audit summary regardless of child count.
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  test('socket.io emit fires exactly once per tick with total created count', async () => {
    // Three parents, each one missed period (recent past) → 3 children total.
    prisma.invoice.findMany.mockResolvedValue([
      dueRow({ id: 1, invoiceNum: 'INV-A', nextRecurDate: recentPast() }),
      dueRow({ id: 2, invoiceNum: 'INV-B', nextRecurDate: recentPast() }),
      dueRow({ id: 3, invoiceNum: 'INV-C', nextRecurDate: recentPast() }),
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

  test('audit log payload has correct shape — single summary row referencing the batch of generated invoices', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      dueRow({ id: 77, invoiceNum: 'INV-PARENT-77', tenantId: 5, nextRecurDate: recentPast() }),
    ]);

    await processRecurringInvoices(null);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditData = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditData.action).toBe('CREATE');
    expect(auditData.entity).toBe('Invoice');
    expect(auditData.tenantId).toBe(5);

    // Post-214017c1 the audit row summarises the whole catch-up batch:
    // details = { source, parentInvoice, generated: [...childNums], count }.
    const details = JSON.parse(auditData.details);
    expect(details.source).toBe('Recurring');
    expect(details.parentInvoice).toBe('INV-PARENT-77');
    expect(Array.isArray(details.generated)).toBe(true);
    expect(details.count).toBe(details.generated.length);
    expect(details.count).toBe(1); // one missed period → one child
    // Each generated child number is `INV-<6 hex uppercase>` (crypto.randomBytes(3)).
    for (const num of details.generated) {
      expect(num).toMatch(/^INV-[0-9A-F]{6}$/);
    }
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
