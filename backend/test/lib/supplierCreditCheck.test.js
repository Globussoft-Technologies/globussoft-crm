// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER G042 — supplier credit-limit guard helper tests.
 *
 * Pins the contract for backend/lib/supplierCreditCheck.js:
 *
 *   - checkCreditLimit()   computes current outstanding A/P + projected total
 *                          against the supplier's configured creditLimit.
 *                          Returns { allowed, current, limit, projected,
 *                          supplierExists }.
 *
 *   - deriveCreditStatus() maps a current+limit pair to one of three bands:
 *                          ok (<80%), warning (80-99%), exceeded (≥100%).
 *
 * Mocking shape: vi.fn() stubs for prisma.travelSupplier.findFirst and
 * prisma.travelSupplierPayable.aggregate. The helper is pure-functional w.r.t.
 * the prisma client passed in — no module-level prisma import inside the
 * helper, so the mock simply impersonates the two methods.
 */

import { describe, test, expect, vi } from 'vitest';
import { checkCreditLimit, deriveCreditStatus } from '../../lib/supplierCreditCheck.js';

function makePrisma({ supplier = { id: 9, creditLimit: 100_000 }, sum = 0 } = {}) {
  return {
    travelSupplier: {
      findFirst: vi.fn().mockResolvedValue(supplier),
    },
    travelSupplierPayable: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: sum } }),
    },
  };
}

describe('checkCreditLimit — math correctness', () => {
  test('allows when projected total stays under limit', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: '100000' },
      sum: '50000',
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 25_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(50_000);
    expect(result.limit).toBe(100_000);
    expect(result.projected).toBe(75_000);
    expect(result.supplierExists).toBe(true);
  });

  test('blocks when projected total exceeds limit', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: '100000' },
      sum: '80000',
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 30_000,
    });
    expect(result.allowed).toBe(false);
    expect(result.current).toBe(80_000);
    expect(result.limit).toBe(100_000);
    expect(result.projected).toBe(110_000);
  });

  test('boundary at exactly 100% — projected==limit is ALLOWED (≤ not <)', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: '100000' },
      sum: '70000',
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 30_000,
    });
    expect(result.projected).toBe(100_000);
    expect(result.allowed).toBe(true);
  });

  test('boundary at 1 unit over — blocked', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: '100000' },
      sum: '70000',
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 30_001,
    });
    expect(result.projected).toBe(100_001);
    expect(result.allowed).toBe(false);
  });

  test('null creditLimit means unconditional allow', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: null },
      sum: '99999999',
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 50_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
  });

  test('missing supplier returns supplierExists:false + allowed:true', async () => {
    const prisma = makePrisma({ supplier: null });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 999, addAmount: 1000,
    });
    expect(result.supplierExists).toBe(false);
    expect(result.allowed).toBe(true);
  });

  test('zero outstanding + addAmount=0 returns projected=0', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: '50000' },
      sum: null,
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 0,
    });
    expect(result.current).toBe(0);
    expect(result.projected).toBe(0);
    expect(result.allowed).toBe(true);
  });

  test('aggregate WHERE excludes paid + cancelled payables', async () => {
    const prisma = makePrisma({ supplier: { id: 9, creditLimit: '100000' }, sum: '0' });
    await checkCreditLimit({ prisma, tenantId: 1, supplierId: 9, addAmount: 1000 });
    expect(prisma.travelSupplierPayable.aggregate).toHaveBeenCalledWith({
      where: {
        supplierId: 9,
        tenantId: 1,
        status: { notIn: ['paid', 'cancelled'] },
      },
      _sum: { amount: true },
    });
  });

  test('handles fractional decimal amounts (Decimal → Number)', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: '100.50' },
      sum: '50.25',
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 25.10,
    });
    expect(result.projected).toBe(75.35);
    expect(result.allowed).toBe(true);
  });

  test('non-finite addAmount coerces to 0 (defensive)', async () => {
    const prisma = makePrisma({
      supplier: { id: 9, creditLimit: '100000' },
      sum: '500',
    });
    const result = await checkCreditLimit({
      prisma, tenantId: 1, supplierId: 9, addAmount: 'not-a-number',
    });
    expect(result.projected).toBe(500);
  });
});

describe('deriveCreditStatus — 3-band advisory', () => {
  test('utilization < 80% → ok', () => {
    expect(deriveCreditStatus({ current: 50_000, limit: 100_000 })).toEqual({
      utilizationPct: 50,
      status: 'ok',
    });
  });

  test('utilization at exactly 80% → warning (boundary inclusive)', () => {
    expect(deriveCreditStatus({ current: 80_000, limit: 100_000 })).toEqual({
      utilizationPct: 80,
      status: 'warning',
    });
  });

  test('utilization at 99.9% → warning', () => {
    const result = deriveCreditStatus({ current: 99_900, limit: 100_000 });
    expect(result.status).toBe('warning');
    expect(result.utilizationPct).toBeGreaterThanOrEqual(99.8);
  });

  test('utilization at exactly 100% → exceeded (boundary inclusive)', () => {
    expect(deriveCreditStatus({ current: 100_000, limit: 100_000 })).toEqual({
      utilizationPct: 100,
      status: 'exceeded',
    });
  });

  test('utilization >100% → exceeded', () => {
    expect(deriveCreditStatus({ current: 150_000, limit: 100_000 })).toEqual({
      utilizationPct: 150,
      status: 'exceeded',
    });
  });

  test('null limit → ok, utilizationPct:null', () => {
    expect(deriveCreditStatus({ current: 999_999, limit: null })).toEqual({
      utilizationPct: null,
      status: 'ok',
    });
  });

  test('limit=0 (degenerate) → ok, utilizationPct:null', () => {
    expect(deriveCreditStatus({ current: 100, limit: 0 })).toEqual({
      utilizationPct: null,
      status: 'ok',
    });
  });
});
