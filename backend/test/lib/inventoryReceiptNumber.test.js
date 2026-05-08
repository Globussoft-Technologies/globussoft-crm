// Wave 11 Agent HH — Unit tests for the receiptNumber generator.
//
// Tests three exports:
//   formatReceiptNumber  — pure formatter, fast.
//   parseReceiptNumber   — pure parser, fast.
//   generateReceiptNumber — Prisma transaction-bound; mocks tx.inventoryReceipt.findFirst.
//
// The generator is what gives InventoryReceipt rows their tenant-scoped
// human-readable id ("RCP-2026-0001"). Format stability matters because
// (a) end users see this id on receipts, search by it, and reference it
// in support tickets, and (b) the lexicographic sort property
// "RCP-YYYY-NNNN" with zero-padding lets us cheaply find the max via
// `findFirst({ orderBy: receiptNumber desc })` instead of a numeric extract.

import { describe, test, expect, vi } from 'vitest';
import {
  formatReceiptNumber,
  parseReceiptNumber,
  generateReceiptNumber,
} from '../../lib/inventoryReceiptNumber.js';

describe('lib/inventoryReceiptNumber — formatReceiptNumber', () => {
  test('zero-pads the sequence to 4 digits', () => {
    expect(formatReceiptNumber(2026, 1)).toBe('RCP-2026-0001');
    expect(formatReceiptNumber(2026, 42)).toBe('RCP-2026-0042');
    expect(formatReceiptNumber(2026, 999)).toBe('RCP-2026-0999');
  });

  test('does not truncate sequences ≥ 10000 (overflow path)', () => {
    expect(formatReceiptNumber(2026, 10000)).toBe('RCP-2026-10000');
    expect(formatReceiptNumber(2026, 99999)).toBe('RCP-2026-99999');
  });

  test('inserts the year exactly as supplied', () => {
    expect(formatReceiptNumber(2030, 1)).toBe('RCP-2030-0001');
    expect(formatReceiptNumber(2099, 1)).toBe('RCP-2099-0001');
  });

  test('rejects non-integer year', () => {
    expect(() => formatReceiptNumber('2026', 1)).toThrow();
    expect(() => formatReceiptNumber(2026.5, 1)).toThrow();
  });

  test('rejects out-of-range year', () => {
    expect(() => formatReceiptNumber(1999, 1)).toThrow();
    expect(() => formatReceiptNumber(10000, 1)).toThrow();
  });

  test('rejects non-positive sequence', () => {
    expect(() => formatReceiptNumber(2026, 0)).toThrow();
    expect(() => formatReceiptNumber(2026, -1)).toThrow();
    expect(() => formatReceiptNumber(2026, 1.5)).toThrow();
  });

  test('lexicographic order matches numeric order within a year (4-digit safe)', () => {
    const ids = [9, 10, 99, 100, 999, 1000].map((s) => formatReceiptNumber(2026, s));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

describe('lib/inventoryReceiptNumber — parseReceiptNumber', () => {
  test('parses a well-formed id', () => {
    expect(parseReceiptNumber('RCP-2026-0001')).toEqual({ year: 2026, seq: 1 });
    expect(parseReceiptNumber('RCP-2099-9999')).toEqual({ year: 2099, seq: 9999 });
    expect(parseReceiptNumber('RCP-2026-10000')).toEqual({ year: 2026, seq: 10000 });
  });

  test('returns null on garbage', () => {
    expect(parseReceiptNumber('')).toBeNull();
    expect(parseReceiptNumber('rcp-2026-0001')).toBeNull(); // case-sensitive
    expect(parseReceiptNumber('RCP-2026')).toBeNull();
    expect(parseReceiptNumber('RCP-26-0001')).toBeNull(); // year must be 4-digit
    expect(parseReceiptNumber('PO-2026-0001')).toBeNull();
    expect(parseReceiptNumber(null)).toBeNull();
    expect(parseReceiptNumber(undefined)).toBeNull();
    expect(parseReceiptNumber(12345)).toBeNull();
  });

  test('round-trips with formatReceiptNumber', () => {
    for (const year of [2026, 2030, 2099]) {
      for (const seq of [1, 42, 9999]) {
        const id = formatReceiptNumber(year, seq);
        const parsed = parseReceiptNumber(id);
        expect(parsed).toEqual({ year, seq });
      }
    }
  });
});

describe('lib/inventoryReceiptNumber — generateReceiptNumber', () => {
  function makeTx(latestReceiptNumber) {
    return {
      inventoryReceipt: {
        findFirst: vi.fn().mockResolvedValue(
          latestReceiptNumber ? { receiptNumber: latestReceiptNumber } : null
        ),
      },
    };
  }

  test('returns RCP-YYYY-0001 for the first receipt of the year', async () => {
    const tx = makeTx(null);
    const now = new Date('2026-05-09T10:00:00Z');
    const result = await generateReceiptNumber(tx, 1, now);
    expect(result).toBe('RCP-2026-0001');
  });

  test('increments the sequence when prior receipts exist', async () => {
    const tx = makeTx('RCP-2026-0042');
    const now = new Date('2026-05-09T10:00:00Z');
    const result = await generateReceiptNumber(tx, 1, now);
    expect(result).toBe('RCP-2026-0043');
  });

  test('rolls over to RCP-YYYY+1-0001 when the year ticks over', async () => {
    const tx = makeTx(null); // findFirst with year=2027 prefix → null
    const now = new Date('2027-01-01T00:00:00Z');
    const result = await generateReceiptNumber(tx, 1, now);
    expect(result).toBe('RCP-2027-0001');
  });

  test('queries with the correct (tenantId, prefix) filter', async () => {
    const tx = makeTx('RCP-2026-0007');
    const now = new Date('2026-05-09T10:00:00Z');
    await generateReceiptNumber(tx, 42, now);
    expect(tx.inventoryReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 42, receiptNumber: { startsWith: 'RCP-2026-' } },
        orderBy: { receiptNumber: 'desc' },
      })
    );
  });

  test('handles a malformed legacy receiptNumber by starting the sequence at 1', async () => {
    const tx = makeTx('legacy-import-99'); // not RCP-...
    const now = new Date('2026-05-09T10:00:00Z');
    const result = await generateReceiptNumber(tx, 1, now);
    expect(result).toBe('RCP-2026-0001');
  });

  test('uses UTC year (deterministic across server time zones)', async () => {
    const tx = makeTx(null);
    // 2026-12-31 23:30 UTC → year is 2026
    const lateUtc = new Date('2026-12-31T23:30:00Z');
    expect(await generateReceiptNumber(tx, 1, lateUtc)).toBe('RCP-2026-0001');
    // 2027-01-01 00:30 UTC → year flips to 2027
    const earlyUtc = new Date('2027-01-01T00:30:00Z');
    expect(await generateReceiptNumber(tx, 1, earlyUtc)).toBe('RCP-2027-0001');
  });

  test('crosses 4-digit boundary cleanly (9999 → 10000)', async () => {
    const tx = makeTx('RCP-2026-9999');
    const now = new Date('2026-05-09T10:00:00Z');
    const result = await generateReceiptNumber(tx, 1, now);
    expect(result).toBe('RCP-2026-10000');
  });
});
