// Travel CRM — Supplier Timeline composer unit tests.
//
// Pins composeSupplierTimeline(sources, opts) — the pure helper that feeds
// the Travel admin's supplier-detail-page Activity / Timeline widget via the
// /api/travel/suppliers/:id/timeline endpoint. Slice 21 of #903 lives at
// backend/lib/supplierTimeline.js (185 LOC, zero IO).
//
// What's pinned:
//   - SUPPLIER_CREATED emitted from supplier.createdAt
//   - SUPPLIER_UPDATED only when updatedAt > createdAt + 1000ms (Prisma
//     auto-mirrors updatedAt on insert; the 1s threshold suppresses that)
//   - PAYABLE_CREATED / PAYABLE_PAID / PAYABLE_CANCELLED triplet from one
//     payable row (cancelled requires status === 'cancelled')
//   - CREDENTIAL_CREATED carries the credential.category payload
//   - Access-log kind normalisation: uppercase + non-alphanum → '_' (so
//     'used in checkin' → CREDENTIAL_USED_IN_CHECKIN, 'ROTATED' →
//     CREDENTIAL_ROTATED)
//   - Access-log rows without `at` are skipped (defensive against partial
//     audit-log writes)
//   - Sort: DESC by `at`, tiebreak by (kind ASC, id ASC) — deterministic
//     across calls so cursor pagination is stable
//   - opts.since: strict-after filter (events with at === since are dropped)
//   - opts.limit: applied AFTER merge+sort, clamped to MAX_LIMIT=500,
//     non-integer / <1 falls back to DEFAULT_LIMIT=100
//   - Payable.amount coerced via Number() (string "100" → 100); null stays null
//   - Mixed Date + ISO-string `at` inputs both handled

import { describe, it, expect } from 'vitest';

const {
  composeSupplierTimeline,
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
} = await import('../../lib/supplierTimeline.js');

describe('composeSupplierTimeline — empty + supplier baseline', () => {
  it('empty sources → empty array', () => {
    const out = composeSupplierTimeline({});
    expect(out).toEqual([]);
  });

  it('null sources → empty array (defensive)', () => {
    const out = composeSupplierTimeline(null);
    expect(out).toEqual([]);
  });

  it('supplier with createdAt only → 1 event SUPPLIER_CREATED', () => {
    const out = composeSupplierTimeline({
      supplier: { id: 'sup-1', createdAt: new Date('2026-05-01T10:00:00Z') },
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('SUPPLIER_CREATED');
    expect(out[0].supplierId).toBe('sup-1');
    expect(out[0].id).toBe('supplier-created-sup-1');
    expect(out[0].at).toBeInstanceOf(Date);
  });

  it('supplier with updatedAt within 1s of createdAt → only SUPPLIER_CREATED (no UPDATED)', () => {
    const created = new Date('2026-05-01T10:00:00.000Z');
    // 500ms after — under the 1s threshold (Prisma auto-mirror noise)
    const updated = new Date('2026-05-01T10:00:00.500Z');
    const out = composeSupplierTimeline({
      supplier: { id: 'sup-2', createdAt: created, updatedAt: updated },
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('SUPPLIER_CREATED');
  });

  it('supplier with updatedAt exactly 1s after createdAt → still only SUPPLIER_CREATED (>1000 strict)', () => {
    // Boundary check: strict greater-than (1000ms exact == NOT updated)
    const created = new Date('2026-05-01T10:00:00.000Z');
    const updated = new Date('2026-05-01T10:00:01.000Z');
    const out = composeSupplierTimeline({
      supplier: { id: 'sup-3', createdAt: created, updatedAt: updated },
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('SUPPLIER_CREATED');
  });

  it('supplier with updatedAt >1s after createdAt → 2 events (CREATED + UPDATED)', () => {
    const created = new Date('2026-05-01T10:00:00.000Z');
    const updated = new Date('2026-05-02T10:00:00.000Z'); // +1 day
    const out = composeSupplierTimeline({
      supplier: { id: 'sup-4', createdAt: created, updatedAt: updated },
    });
    expect(out).toHaveLength(2);
    // Sorted DESC by `at` — UPDATED is newer, comes first
    expect(out[0].kind).toBe('SUPPLIER_UPDATED');
    expect(out[0].id).toBe('supplier-updated-sup-4');
    expect(out[1].kind).toBe('SUPPLIER_CREATED');
  });
});

describe('composeSupplierTimeline — payables', () => {
  it('payable with createdAt + paidAt + status="cancelled" → 3 events (CREATED, PAID, CANCELLED)', () => {
    const out = composeSupplierTimeline({
      payables: [
        {
          id: 'pay-1',
          createdAt: new Date('2026-05-01T10:00:00Z'),
          paidAt: new Date('2026-05-02T10:00:00Z'),
          updatedAt: new Date('2026-05-03T10:00:00Z'),
          status: 'cancelled',
          amount: 1500,
          currency: 'USD',
          poNumber: 'PO-001',
        },
      ],
    });
    expect(out).toHaveLength(3);
    const kinds = out.map((e) => e.kind).sort();
    expect(kinds).toEqual(['PAYABLE_CANCELLED', 'PAYABLE_CREATED', 'PAYABLE_PAID']);
    // Each event carries amount / currency / poNumber
    out.forEach((e) => {
      expect(e.amount).toBe(1500);
      expect(e.currency).toBe('USD');
      expect(e.poNumber).toBe('PO-001');
      expect(e.payableId).toBe('pay-1');
    });
  });

  it('payable status !== "cancelled" → no CANCELLED event', () => {
    const out = composeSupplierTimeline({
      payables: [
        {
          id: 'pay-2',
          createdAt: new Date('2026-05-01T10:00:00Z'),
          updatedAt: new Date('2026-05-03T10:00:00Z'),
          status: 'pending', // not cancelled
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('PAYABLE_CREATED');
  });

  it('payable with no paidAt → no PAID event', () => {
    const out = composeSupplierTimeline({
      payables: [
        {
          id: 'pay-3',
          createdAt: new Date('2026-05-01T10:00:00Z'),
          // paidAt absent
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('PAYABLE_CREATED');
  });

  it('payable amount coerced via Number() (string "100" → 100); null stays null', () => {
    const out = composeSupplierTimeline({
      payables: [
        {
          id: 'pay-4',
          createdAt: new Date('2026-05-01T10:00:00Z'),
          amount: '100', // Prisma Decimal often serialises as string
        },
        {
          id: 'pay-5',
          createdAt: new Date('2026-05-01T11:00:00Z'),
          amount: null,
        },
      ],
    });
    expect(out).toHaveLength(2);
    const pay4 = out.find((e) => e.payableId === 'pay-4');
    const pay5 = out.find((e) => e.payableId === 'pay-5');
    expect(pay4.amount).toBe(100);
    expect(typeof pay4.amount).toBe('number');
    expect(pay5.amount).toBe(null);
  });
});

describe('composeSupplierTimeline — credentials + access log', () => {
  it('credential CREATED event includes `category` payload', () => {
    const out = composeSupplierTimeline({
      credentials: [
        {
          id: 'cred-1',
          createdAt: new Date('2026-05-01T10:00:00Z'),
          category: 'airline-portal',
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('CREDENTIAL_CREATED');
    expect(out[0].credentialId).toBe('cred-1');
    expect(out[0].category).toBe('airline-portal');
  });

  it('access-log normalisation: "used in checkin" → CREDENTIAL_USED_IN_CHECKIN; "ROTATED" → CREDENTIAL_ROTATED', () => {
    const out = composeSupplierTimeline({
      accessLog: [
        {
          id: 'al-1',
          at: new Date('2026-05-01T10:00:00Z'),
          action: 'used in checkin',
          credentialId: 'cred-x',
          userId: 'u-1',
        },
        {
          id: 'al-2',
          at: new Date('2026-05-02T10:00:00Z'),
          action: 'ROTATED',
          credentialId: 'cred-y',
          userId: 'u-2',
        },
      ],
    });
    expect(out).toHaveLength(2);
    const usedEvent = out.find((e) => e.id === 'accesslog-al-1');
    const rotatedEvent = out.find((e) => e.id === 'accesslog-al-2');
    expect(usedEvent.kind).toBe('CREDENTIAL_USED_IN_CHECKIN');
    expect(rotatedEvent.kind).toBe('CREDENTIAL_ROTATED');
    expect(usedEvent.credentialId).toBe('cred-x');
    expect(usedEvent.userId).toBe('u-1');
  });

  it('access-log row with no `at` is skipped', () => {
    const out = composeSupplierTimeline({
      accessLog: [
        {
          id: 'al-skip',
          at: null,
          action: 'viewed',
          credentialId: 'cred-z',
          userId: 'u-3',
        },
        {
          id: 'al-keep',
          at: new Date('2026-05-01T10:00:00Z'),
          action: 'viewed',
          credentialId: 'cred-z',
          userId: 'u-3',
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('accesslog-al-keep');
  });

  it('access-log with missing action defaults to "unknown" → CREDENTIAL_UNKNOWN', () => {
    const out = composeSupplierTimeline({
      accessLog: [
        {
          id: 'al-noaction',
          at: new Date('2026-05-01T10:00:00Z'),
          // action absent
          credentialId: 'cred-z',
          userId: 'u-3',
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('CREDENTIAL_UNKNOWN');
  });
});

describe('composeSupplierTimeline — sort, tiebreak, since, limit', () => {
  it('sort: DESC by `at` (newest first)', () => {
    const out = composeSupplierTimeline({
      payables: [
        { id: 'p-oldest', createdAt: new Date('2026-05-01T10:00:00Z') },
        { id: 'p-newest', createdAt: new Date('2026-05-05T10:00:00Z') },
        { id: 'p-middle', createdAt: new Date('2026-05-03T10:00:00Z') },
      ],
    });
    expect(out.map((e) => e.payableId)).toEqual(['p-newest', 'p-middle', 'p-oldest']);
  });

  it('tiebreaker: same `at`, sort by (kind ASC, id ASC) — deterministic across calls', () => {
    // Two events at exactly the same `at`; tiebreak by kind first then id
    const sameAt = new Date('2026-05-01T10:00:00Z');
    const out1 = composeSupplierTimeline({
      payables: [
        { id: 'p-b', createdAt: sameAt },
        { id: 'p-a', createdAt: sameAt },
      ],
      credentials: [{ id: 'c-1', createdAt: sameAt, category: 'x' }],
    });
    // Kinds at same `at`: CREDENTIAL_CREATED, PAYABLE_CREATED, PAYABLE_CREATED
    // ASC sort: CREDENTIAL_CREATED < PAYABLE_CREATED, then id-ASC for same kind
    expect(out1[0].kind).toBe('CREDENTIAL_CREATED');
    expect(out1[1].id).toBe('payable-created-p-a');
    expect(out1[2].id).toBe('payable-created-p-b');

    // Re-run with input shuffled — output should be identical (determinism)
    const out2 = composeSupplierTimeline({
      credentials: [{ id: 'c-1', createdAt: sameAt, category: 'x' }],
      payables: [
        { id: 'p-a', createdAt: sameAt },
        { id: 'p-b', createdAt: sameAt },
      ],
    });
    expect(out2.map((e) => e.id)).toEqual(out1.map((e) => e.id));
  });

  it('opts.since: strict-after filter (event with at === since is excluded)', () => {
    const since = new Date('2026-05-02T10:00:00Z');
    const out = composeSupplierTimeline(
      {
        payables: [
          { id: 'p-before', createdAt: new Date('2026-05-01T10:00:00Z') },
          { id: 'p-equal', createdAt: since }, // exactly at since — excluded
          { id: 'p-after', createdAt: new Date('2026-05-03T10:00:00Z') },
        ],
      },
      { since },
    );
    expect(out).toHaveLength(1);
    expect(out[0].payableId).toBe('p-after');
  });

  it('opts.since accepts an ISO string', () => {
    const out = composeSupplierTimeline(
      {
        payables: [
          { id: 'p-before', createdAt: new Date('2026-05-01T10:00:00Z') },
          { id: 'p-after', createdAt: new Date('2026-05-03T10:00:00Z') },
        ],
      },
      { since: '2026-05-02T10:00:00Z' },
    );
    expect(out).toHaveLength(1);
    expect(out[0].payableId).toBe('p-after');
  });

  it('opts.limit applied AFTER merge + sort (newest N kept)', () => {
    const payables = [];
    for (let i = 0; i < 10; i++) {
      payables.push({
        id: `p-${i}`,
        createdAt: new Date(`2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
      });
    }
    const out = composeSupplierTimeline({ payables }, { limit: 3 });
    expect(out).toHaveLength(3);
    // Top 3 newest = p-9, p-8, p-7
    expect(out.map((e) => e.payableId)).toEqual(['p-9', 'p-8', 'p-7']);
  });

  it('opts.limit clamped to MAX_LIMIT=500 when over', () => {
    expect(TIMELINE_MAX_LIMIT).toBe(500);
    const payables = [];
    for (let i = 0; i < 510; i++) {
      payables.push({
        id: `p-${i}`,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      });
    }
    const out = composeSupplierTimeline({ payables }, { limit: 9999 });
    expect(out).toHaveLength(500);
  });

  it('opts.limit non-integer or <1 falls back to DEFAULT_LIMIT=100', () => {
    expect(TIMELINE_DEFAULT_LIMIT).toBe(100);
    const payables = [];
    for (let i = 0; i < 150; i++) {
      payables.push({
        id: `p-${i}`,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      });
    }
    // limit = 0 → default
    const outZero = composeSupplierTimeline({ payables }, { limit: 0 });
    expect(outZero).toHaveLength(100);

    // limit = 1.5 (non-integer) → default
    const outFloat = composeSupplierTimeline({ payables }, { limit: 1.5 });
    expect(outFloat).toHaveLength(100);

    // limit = -5 → default
    const outNeg = composeSupplierTimeline({ payables }, { limit: -5 });
    expect(outNeg).toHaveLength(100);
  });

  it('mixed Date and ISO-string `at` inputs both handled', () => {
    const out = composeSupplierTimeline({
      supplier: { id: 's', createdAt: '2026-05-01T10:00:00Z' }, // ISO string
      payables: [
        { id: 'p-1', createdAt: new Date('2026-05-02T10:00:00Z') }, // Date object
        { id: 'p-2', createdAt: '2026-05-03T10:00:00Z' }, // ISO string
      ],
      accessLog: [
        {
          id: 'al-1',
          at: '2026-05-04T10:00:00Z', // ISO string
          action: 'viewed',
          credentialId: 'c',
          userId: 'u',
        },
      ],
    });
    expect(out).toHaveLength(4);
    // DESC sort — newest (al-1, 2026-05-04) first
    expect(out[0].kind).toBe('CREDENTIAL_VIEWED');
    expect(out[3].kind).toBe('SUPPLIER_CREATED');
    // All `at` fields normalised to Date instances
    out.forEach((e) => expect(e.at).toBeInstanceOf(Date));
  });
});
