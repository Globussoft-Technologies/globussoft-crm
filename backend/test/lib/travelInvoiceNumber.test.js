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

  test('chooses one above the highest numeric serial and ignores custom formats', async () => {
    const prisma = {
      travelInvoice: {
        findMany: vi.fn().mockResolvedValue([
          { invoiceNum: 'TINV-2026-0009' },
          { invoiceNum: 'TINV-2026-T1018-P4' },
          { invoiceNum: 'TINV-2026-0012' },
        ]),
      },
    };
    await expect(nextTravelInvoiceNum(prisma, 3, new Date('2026-09-15')))
      .resolves.toBe('TINV-2026-0013');
  });

  test('retries when another request takes the generated number', async () => {
    const conflict = Object.assign(new Error('unique invoiceNum'), {
      code: 'P2002',
      meta: { target: ['tenantId', 'invoiceNum'] },
    });
    const prisma = {
      travelInvoice: {
        findMany: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ invoiceNum: 'TINV-2026-0001' }]),
        create: vi.fn()
          .mockRejectedValueOnce(conflict)
          .mockImplementationOnce(async ({ data }) => ({ id: 2, ...data })),
      },
    };

    const created = await createTravelInvoiceWithNumber(
      prisma,
      3,
      { status: 'Draft' },
      { date: new Date('2026-09-15') },
    );
    expect(created.invoiceNum).toBe('TINV-2026-0002');
    expect(prisma.travelInvoice.create).toHaveBeenCalledTimes(2);
  });
});
