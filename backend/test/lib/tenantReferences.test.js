import { describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  TenantReferenceError,
  parseReferenceId,
  requireTenantReferences,
} = requireCJS('../../lib/tenantReferences');

describe('tenantReferences', () => {
  test('resolves every supplied id under the caller tenant', async () => {
    const prisma = {
      contact: { findFirst: vi.fn().mockResolvedValue({ id: 4 }) },
      deal: { findFirst: vi.fn().mockResolvedValue({ id: 8 }) },
    };

    const result = await requireTenantReferences(prisma, 17, [
      { key: 'contactId', model: 'contact', value: '4', label: 'Contact' },
      { key: 'dealId', model: 'deal', value: 8, label: 'Deal' },
    ]);

    expect(result).toEqual({ contactId: 4, dealId: 8 });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 4, tenantId: 17 },
      select: { id: true },
    });
    expect(prisma.deal.findFirst).toHaveBeenCalledWith({
      where: { id: 8, tenantId: 17 },
      select: { id: true },
    });
  });

  test('rejects a missing or cross-tenant reference with 404', async () => {
    const prisma = { contact: { findFirst: vi.fn().mockResolvedValue(null) } };

    await expect(requireTenantReferences(prisma, 2, [
      { key: 'contactId', model: 'contact', value: 99, label: 'Contact' },
    ])).rejects.toMatchObject({
      name: 'TenantReferenceError',
      status: 404,
      code: 'REFERENCE_NOT_FOUND',
      message: 'Contact not found',
    });
  });

  test('treats omitted relationships as null without querying', async () => {
    const findFirst = vi.fn();
    const result = await requireTenantReferences(
      { contact: { findFirst } },
      3,
      [{ key: 'contactId', model: 'contact', value: '', label: 'Contact' }],
    );
    expect(result).toEqual({ contactId: null });
    expect(findFirst).not.toHaveBeenCalled();
  });

  test('rejects malformed relationship ids before Prisma', () => {
    expect(() => parseReferenceId('4x', 'Contact')).toThrow(TenantReferenceError);
    try {
      parseReferenceId('4x', 'Contact');
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'INVALID_REFERENCE' });
    }
  });
});
