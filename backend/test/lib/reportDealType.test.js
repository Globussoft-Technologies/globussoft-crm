import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const { reportDealTypeWhere } = createRequire(import.meta.url)('../../lib/reportDealType');

describe('reportDealTypeWhere', () => {
  it('uses the renamed original type for untyped deals, not the current default', async () => {
    const findUnique = vi.fn().mockResolvedValue({ value: JSON.stringify([
      { id: 'new-business', name: 'Sales' }, { id: 'other', name: 'Other', isDefault: true },
    ]) });
    const db = { tenantSetting: { findUnique } };
    expect(await reportDealTypeWhere(db, 17, 'Sales')).toEqual({ OR: [{ dealType: 'Sales' }, { dealType: null }] });
    expect(await reportDealTypeWhere(db, 17, 'Other')).toEqual({ dealType: 'Other' });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId_key: { tenantId: 17, key: 'generic.dealTypes' } } }));
  });

  it('falls back to default configuration and skips lookup without a filter', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { tenantSetting: { findUnique } };
    expect(await reportDealTypeWhere(db, 1, '')).toEqual({});
    expect(findUnique).not.toHaveBeenCalled();
    expect(await reportDealTypeWhere(db, 1, 'New Business')).toEqual({ OR: [{ dealType: 'New Business' }, { dealType: null }] });
  });
});
