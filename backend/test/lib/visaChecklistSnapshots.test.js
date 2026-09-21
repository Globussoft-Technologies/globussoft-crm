import { describe, expect, test, vi } from 'vitest';

const {
  loadChecklistComboState,
} = require('../../lib/visaChecklistSnapshots.js');

describe('visaChecklistSnapshots.loadChecklistComboState', () => {
  test('queries only fields that exist on checklist template and source models', async () => {
    const prisma = {
      visaChecklistTemplate: {
        findMany: vi.fn().mockResolvedValue([
          { docType: 'Passport', required: true, sortOrder: 1, notes: null },
        ]),
      },
      visaChecklistSource: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 12,
            sourceName: 'Consulate',
            sourceUrl: 'https://example.test/visa',
            sourceKind: 'consulate',
            notes: null,
            isActive: true,
          },
        ]),
      },
    };

    const result = await loadChecklistComboState(prisma, {
      tenantId: 7,
      applicationType: 'tourist',
      destinationCountry: 'US',
    });

    expect(prisma.visaChecklistTemplate.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, applicationType: 'tourist', destinationCountry: 'US' },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { docType: true, required: true, sortOrder: true, notes: true },
    });
    expect(prisma.visaChecklistSource.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 7,
        applicationType: 'tourist',
        destinationCountry: 'US',
        isActive: true,
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        sourceName: true,
        sourceUrl: true,
        sourceKind: true,
        notes: true,
        isActive: true,
      },
    });
    expect(result.items).toEqual([
      { docType: 'Passport', required: true, sortOrder: 1, notes: null },
    ]);
    expect(result.sourceList).toHaveLength(1);
  });
});
