import { describe, expect, test, vi } from 'vitest';
import invoiceNumberModule from '../../lib/travelInvoiceNumber.js';

const {
  createTravelInvoiceWithNumber,
  nextTravelInvoiceNum,
  serialFromInvoiceNum,
} = invoiceNumberModule;

describe('travelInvoiceNumber', () => {
  test('parses only the canonical numeric format', () => {
    expect(serialFromInvoiceNum('TINV-2026-0042', 2026)).toBe(42);
    expect(serialFromInvoiceNum('TINV-2026-T1018-P4', 2026)).toBeNull();
    expect(serialFromInvoiceNum('TINV-2025-0042', 2026)).toBeNull();
  });

  test('previews one above the persisted sequence without scanning invoices', async () => {
    const prisma = {
      travelInvoiceSequence: {
        findUnique: vi.fn().mockResolvedValue({ lastSerial: 12 }),
      },
    };
    await expect(nextTravelInvoiceNum(prisma, 3, new Date('2026-09-15')))
      .resolves.toBe('TINV-2026-0013');
    expect(prisma.travelInvoiceSequence.findUnique).toHaveBeenCalledWith({
      where: { tenantId_year: { tenantId: 3, year: 2026 } },
      select: { lastSerial: true },
    });
  });

  test('creates the invoice from an atomic sequence increment', async () => {
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(prisma)),
      travelInvoiceSequence: {
        findUnique: vi.fn().mockResolvedValue({ lastSerial: 12 }),
        upsert: vi.fn().mockResolvedValue({ lastSerial: 13 }),
      },
      travelInvoice: {
        create: vi.fn().mockImplementation(async ({ data }) => ({ id: 2, ...data })),
      },
    };

    const created = await createTravelInvoiceWithNumber(
      prisma,
      3,
      { status: 'Draft' },
      { date: new Date('2026-09-15') },
    );
    expect(created.invoiceNum).toBe('TINV-2026-0013');
    expect(prisma.travelInvoiceSequence.upsert).toHaveBeenCalledWith({
      where: { tenantId_year: { tenantId: 3, year: 2026 } },
      create: { tenantId: 3, year: 2026, lastSerial: 1 },
      update: { lastSerial: { increment: 1 } },
      select: { lastSerial: true },
    });
    expect(prisma.travelInvoice.create).toHaveBeenCalledTimes(1);
  });

  test('allocates unique numbers for a burst of concurrent creates', async () => {
    let lastSerial = 0;
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(prisma)),
      travelInvoiceSequence: {
        findUnique: vi.fn().mockResolvedValue({ lastSerial: 0 }),
        upsert: vi.fn(async () => ({ lastSerial: ++lastSerial })),
      },
      travelInvoice: {
        create: vi.fn(async ({ data }) => ({ id: data.invoiceNum, ...data })),
      },
    };

    const invoices = await Promise.all(
      Array.from({ length: 10 }, () => createTravelInvoiceWithNumber(
        prisma,
        3,
        { status: 'Draft' },
        { date: new Date('2026-09-15') },
      )),
    );

    expect(new Set(invoices.map((invoice) => invoice.invoiceNum)).size).toBe(10);
    expect(invoices.map((invoice) => invoice.invoiceNum).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `TINV-2026-${String(index + 1).padStart(4, '0')}`),
    );
  });

  test('bootstraps a missing sequence from legacy canonical numbers once', async () => {
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(prisma)),
      travelInvoiceSequence: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ lastSerial: 8 }),
      },
      travelInvoice: {
        findMany: vi.fn().mockResolvedValue([
          { invoiceNum: 'TINV-2026-0007' },
          { invoiceNum: 'TINV-2026-T1018-P4' },
        ]),
        create: vi.fn(async ({ data }) => ({ id: 8, ...data })),
      },
    };

    const created = await createTravelInvoiceWithNumber(
      prisma,
      3,
      { status: 'Draft' },
      { date: new Date('2026-09-15') },
    );

    expect(created.invoiceNum).toBe('TINV-2026-0008');
    expect(prisma.travelInvoiceSequence.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { tenantId: 3, year: 2026, lastSerial: 8 },
      }),
    );
  });
});
