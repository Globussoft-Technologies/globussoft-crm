// @ts-check
/**
 * Unit tests for backend/cron/quoteExpirySweep.js — daily expiry sweep
 * for TravelQuote (C9). PRD_TRAVEL_QUOTE_BUILDER §3.7.
 *
 * Hard contract pins (mirror SUT contract verbatim):
 *   1. No expired quotes → { quotesSwept: 0, errors: [] }.
 *   2. Draft + validUntil < now → swept + snapshot row created.
 *   3. Sent + validUntil < now → swept + snapshot row created.
 *   4. Already-Expired quote → skipped (no update, no snapshot). Filter
 *      excludes them on the findMany WHERE clause, so they never make
 *      it to the per-quote loop.
 *   5. Accepted / Rejected / Cancelled with old validUntil → skipped.
 *      Same filter rationale as (4).
 *   6. Cross-tenant: each tenant's quotes are processed independently —
 *      one tenant's quote failure doesn't abort the rest. tenantId is
 *      propagated into the snapshot row.
 *   7. Idempotency: re-running the sweep doesn't double-snapshot.
 *      Achieved because pass 2's findMany already excludes status=Expired,
 *      so the candidate list is empty.
 *
 * Strategy: standard prisma-singleton monkey-patch. SUT module inlined
 * via vitest.config.js cron/ rule.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

import { sweep } from '../../cron/quoteExpirySweep.js';

beforeAll(() => {
  prisma.travelQuote = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  };
  prisma.travelQuoteSnapshot = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  prisma.auditLog = {
    create: vi.fn().mockResolvedValue({ id: 1 }),
    findFirst: vi.fn().mockResolvedValue(null),
  };
});

function makeQuote(over = {}) {
  return {
    id: 42,
    tenantId: 7,
    subBrand: 'tmc',
    contactId: 99,
    status: 'Sent',
    totalAmount: '50000.00',
    currency: 'INR',
    validUntil: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-05-15T00:00:00Z'),
    updatedAt: new Date('2026-05-20T00:00:00Z'),
    lines: [
      {
        id: 1,
        lineType: 'hotel',
        description: 'Hotel — 3 nights',
        quantity: 3,
        unitPrice: '10000.00',
        amount: '30000.00',
        currency: 'INR',
        supplierId: 12,
        sortOrder: 0,
        notes: 'Internal note',
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  prisma.travelQuote.findMany.mockReset();
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.update.mockReset();
  prisma.travelQuoteSnapshot.findFirst.mockReset();
  prisma.travelQuoteSnapshot.create.mockReset();

  // Sensible defaults that the per-quote loop relies on.
  prisma.travelQuoteSnapshot.findFirst.mockResolvedValue(null);
  prisma.travelQuoteSnapshot.create.mockResolvedValue({ id: 1 });
  prisma.travelQuote.update.mockImplementation(async ({ data, where }) => ({
    id: where.id,
    status: data.status,
  }));
});

describe('sweep — happy and skip paths', () => {
  const NOW = new Date('2026-06-09T00:00:00Z');

  test('1. no expired quotes → quotesSwept=0, errors=[]', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const result = await sweep({ now: NOW });
    expect(result.quotesSwept).toBe(0);
    expect(result.errors).toEqual([]);
    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
    expect(prisma.travelQuoteSnapshot.create).not.toHaveBeenCalled();
  });

  test('2. Draft + validUntil<now → swept + snapshot written', async () => {
    const q = makeQuote({ status: 'Draft' });
    prisma.travelQuote.findMany.mockResolvedValue([q]);
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: q.id, status: q.status, validUntil: q.validUntil, tenantId: q.tenantId,
    });
    const result = await sweep({ now: NOW });
    expect(result.quotesSwept).toBe(1);
    expect(prisma.travelQuote.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { status: 'Expired' },
    });
    expect(prisma.travelQuoteSnapshot.create).toHaveBeenCalledTimes(1);
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    expect(snapArg.quoteId).toBe(42);
    expect(snapArg.tenantId).toBe(7);
    expect(snapArg.statusBefore).toBe('Draft');
    expect(snapArg.statusAfter).toBe('Expired');
    expect(snapArg.changedBy).toBe('system');
    expect(snapArg.changeReason).toBe('validUntil passed');
    expect(snapArg.versionNumber).toBe(1);
  });

  test('3. Sent + validUntil<now → swept + snapshot written', async () => {
    const q = makeQuote({ status: 'Sent' });
    prisma.travelQuote.findMany.mockResolvedValue([q]);
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: q.id, status: q.status, validUntil: q.validUntil, tenantId: q.tenantId,
    });
    const result = await sweep({ now: NOW });
    expect(result.quotesSwept).toBe(1);
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    expect(snapArg.statusBefore).toBe('Sent');
  });

  test('4+5. findMany WHERE filter excludes Expired/Accepted/Rejected (pinned via mock call args)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    await sweep({ now: NOW });
    const callArg = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(callArg.where.status.in).toEqual(['Draft', 'Sent']);
    expect(callArg.where.validUntil).toEqual({ lt: NOW });
  });

  test('6. cross-tenant: each tenant\'s quotes are swept independently', async () => {
    const tenantA = makeQuote({ id: 1, tenantId: 10, status: 'Sent' });
    const tenantB = makeQuote({ id: 2, tenantId: 20, status: 'Draft' });
    prisma.travelQuote.findMany.mockResolvedValue([tenantA, tenantB]);
    prisma.travelQuote.findFirst.mockImplementation(async ({ where }) => {
      if (where.id === 1) return { id: 1, status: 'Sent', validUntil: tenantA.validUntil, tenantId: 10 };
      if (where.id === 2) return { id: 2, status: 'Draft', validUntil: tenantB.validUntil, tenantId: 20 };
      return null;
    });
    const result = await sweep({ now: NOW });
    expect(result.quotesSwept).toBe(2);
    const tenantIds = prisma.travelQuoteSnapshot.create.mock.calls.map((c) => c[0].data.tenantId);
    expect(tenantIds).toEqual(expect.arrayContaining([10, 20]));
  });

  test('6b. one tenant\'s quote failure does NOT abort siblings', async () => {
    const goodA = makeQuote({ id: 1, tenantId: 10, status: 'Sent' });
    const badB = makeQuote({ id: 2, tenantId: 20, status: 'Draft' });
    prisma.travelQuote.findMany.mockResolvedValue([goodA, badB]);
    prisma.travelQuote.findFirst.mockImplementation(async ({ where }) => ({
      id: where.id, status: where.id === 1 ? 'Sent' : 'Draft', validUntil: goodA.validUntil, tenantId: where.id === 1 ? 10 : 20,
    }));
    prisma.travelQuote.update.mockImplementation(async ({ where }) => {
      if (where.id === 2) throw new Error('DB write failed for quote 2');
      return { id: where.id, status: 'Expired' };
    });
    const result = await sweep({ now: NOW });
    expect(result.quotesSwept).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].quoteId).toBe(2);
  });

  test('7. idempotency — re-running the sweep (findMany returns no candidates) is a no-op', async () => {
    // After a prior sweep, all formerly-expired quotes now have status=Expired.
    // The findMany WHERE filter excludes them, so the next pass sees an empty
    // list. The route loop never executes; no snapshot duplication possible.
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const result1 = await sweep({ now: NOW });
    const result2 = await sweep({ now: NOW });
    expect(result1.quotesSwept).toBe(0);
    expect(result2.quotesSwept).toBe(0);
    expect(prisma.travelQuoteSnapshot.create).not.toHaveBeenCalled();
  });

  test('7b. idempotency within one pass — concurrent operator already moved status; loop skips', async () => {
    // Race: findMany saw the quote as Sent + expired, but between then and the
    // per-quote findFirst, the operator moved it to Accepted (manual override).
    const q = makeQuote({ status: 'Sent' });
    prisma.travelQuote.findMany.mockResolvedValue([q]);
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: q.id, status: 'Accepted', validUntil: q.validUntil, tenantId: q.tenantId,
    });
    const result = await sweep({ now: NOW });
    expect(result.quotesSwept).toBe(0);
    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
    expect(prisma.travelQuoteSnapshot.create).not.toHaveBeenCalled();
  });

  test('versionNumber increments past existing snapshots on the same quote', async () => {
    const q = makeQuote({ status: 'Sent' });
    prisma.travelQuote.findMany.mockResolvedValue([q]);
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: q.id, status: q.status, validUntil: q.validUntil, tenantId: q.tenantId,
    });
    prisma.travelQuoteSnapshot.findFirst.mockResolvedValue({ versionNumber: 3 });
    await sweep({ now: NOW });
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    expect(snapArg.versionNumber).toBe(4);
  });

  test('findMany failure → returns { quotesSwept:0, errors:[findMany-stage] }', async () => {
    prisma.travelQuote.findMany.mockRejectedValue(new Error('DB unreachable'));
    const result = await sweep({ now: NOW });
    expect(result.quotesSwept).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].stage).toBe('findMany');
  });
});
