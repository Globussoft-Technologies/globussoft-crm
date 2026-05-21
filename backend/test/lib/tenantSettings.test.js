// Unit tests for backend/lib/tenantSettings.js (Phase 2 PRD §4.7).
//
// The helper accepts `prisma` as a parameter (unlike most lib modules
// that import their own singleton), so this test passes a synthetic
// mock object directly instead of needing the hoisted-prisma-mock
// pattern from deduplication.test.js.
//
// What's covered:
//   1. getTenantSetting — happy path (row found), miss (fallback used),
//      missing tenantId/key bail-out, undefined fallback path.
//   2. getTravelAdvanceRatio — sub-brand-scoped key wins, falls back to
//      tenant default, falls back to 0.5 hard-coded when neither set.
//   3. Bounds-check defence — negative / >1 / NaN / non-numeric values
//      are REJECTED at each layer, so a fat-fingered admin setting
//      doesn't poison the booking flow. Falls through to the next
//      layer (sub-brand bad → tenant default; tenant default bad →
//      hard-coded 0.5) rather than returning the bad value.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getTenantSetting, getTravelAdvanceRatio } from '../../lib/tenantSettings.js';

// Synthetic mock — only the surface the helper actually touches.
let prisma;

beforeEach(() => {
  prisma = {
    tenantSetting: {
      findUnique: vi.fn(),
    },
  };
});

describe('tenantSettings — getTenantSetting', () => {
  test('returns the row value when present', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: '0.3' });
    const out = await getTenantSetting(prisma, 1, 'travel.advanceRatio.rfu', 'def');
    expect(out).toBe('0.3');
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 1, key: 'travel.advanceRatio.rfu' } },
      select: { value: true },
    });
  });

  test('returns supplied fallback when row missing', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTenantSetting(prisma, 1, 'travel.advanceRatio.rfu', 'fallback-val');
    expect(out).toBe('fallback-val');
  });

  test('default fallback is null when caller omits it', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTenantSetting(prisma, 1, 'k');
    expect(out).toBeNull();
  });

  test('returns fallback immediately when tenantId missing (no prisma call)', async () => {
    const out = await getTenantSetting(prisma, null, 'k', 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('returns fallback immediately when tenantId is 0', async () => {
    const out = await getTenantSetting(prisma, 0, 'k', 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('returns fallback immediately when key missing (no prisma call)', async () => {
    const out = await getTenantSetting(prisma, 1, '', 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('returns fallback immediately when key is null', async () => {
    const out = await getTenantSetting(prisma, 1, null, 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });
});

describe('tenantSettings — getTravelAdvanceRatio (PRD §4.7)', () => {
  test('sub-brand-scoped key wins over tenant default + hard-coded', async () => {
    // First lookup: sub-brand key returns 0.3 → used immediately.
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '0.3' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.3);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 1, key: 'travel.advanceRatio.rfu' } },
      select: { value: true },
    });
  });

  test('falls back to tenant default when sub-brand key absent', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce(null) // travel.advanceRatio.rfu missing
      .mockResolvedValueOnce({ value: '0.4' }); // travel.advanceRatio.default
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.4);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.tenantSetting.findUnique.mock.calls[1][0]).toEqual({
      where: { tenantId_key: { tenantId: 1, key: 'travel.advanceRatio.default' } },
      select: { value: true },
    });
  });

  test('falls back to 0.5 when neither sub-brand nor tenant default set', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTravelAdvanceRatio(prisma, 1, 'travelstall');
    expect(out).toBe(0.5);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  test('falls back to 0.5 when subBrand missing — only checks tenant default', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTravelAdvanceRatio(prisma, 1, null);
    expect(out).toBe(0.5);
    // Sub-brand lookup is skipped entirely when subBrand is falsy.
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tenantSetting.findUnique.mock.calls[0][0].where.tenantId_key.key)
      .toBe('travel.advanceRatio.default');
  });

  test('falls back to 0.5 when tenantId missing (helper short-circuits)', async () => {
    const out = await getTravelAdvanceRatio(prisma, null, 'rfu');
    expect(out).toBe(0.5);
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('rejects negative sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '-0.1' })
      .mockResolvedValueOnce({ value: '0.7' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.7);
  });

  test('rejects zero sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '0' })
      .mockResolvedValueOnce({ value: '0.6' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.6);
  });

  test('rejects >1 sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '1.5' })
      .mockResolvedValueOnce({ value: '0.45' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.45);
  });

  test('rejects non-numeric sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: 'half' })
      .mockResolvedValueOnce({ value: '0.5' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.5);
  });

  test('rejects bad value at BOTH layers → falls all the way to 0.5', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '-1' })
      .mockResolvedValueOnce({ value: 'NaN' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.5);
  });

  test('accepts boundary 1.0 (full advance — pay-upfront subbrands)', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '1' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'visasure');
    expect(out).toBe(1);
  });

  test('rejects ratio at strict-zero boundary (must be >0)', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '0' })
      .mockResolvedValueOnce(null);
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.5);
  });

  test('accepts a small ratio like 0.1', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '0.1' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.1);
  });
});
