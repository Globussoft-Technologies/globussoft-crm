// @ts-check
/**
 * Unit tests for the C8 finance endpoints in backend/routes/travel_invoices.js:
 *
 *   GET /api/travel/invoices/aged-receivable-report  (PRD_TRAVEL_BILLING FR-3.6.b)
 *   GET /api/travel/invoices/aged-payable-report     (PRD_TRAVEL_BILLING FR-3.6.c)
 *   GET /api/travel/invoices/tcs/27eq                (PRD_TRAVEL_BILLING FR-3.5.b
 *                                                     — Section 206C(1G) Form 27EQ)
 *
 * Why this file exists (gap classes the C8 endpoints introduce):
 *   - Bucket label format is a public contract surface — "Current (0-30 days)",
 *     "31-60 days", "61-90 days", "Over 90 days" — that the Finance dashboard
 *     consumes verbatim. A regression renaming labels would silently break
 *     dashboard widgets.
 *   - Buckets must be returned for every label even when invoiceCount=0 so the
 *     dashboard renders all 4 bars / rows. A regression dropping zero-count
 *     buckets would surface as missing widgets, not as a test failure.
 *   - Aged-receivable's outstanding math must subtract sum(schedule.receivedAmount)
 *     from totalAmount. A regression dropping the subtraction would over-state
 *     the receivable by the value already collected.
 *   - 27EQ FY parsing must reject the wrong YY (e.g. "2025-27" should 400).
 *     The end-year-short component MUST equal (startYear+1) % 100 — a regression
 *     accepting arbitrary YY would let an operator file the wrong return.
 *   - 27EQ excludes invoices where tcsAmount=0 / tcsAppliedAt=null — the form
 *     is "TCS collected at source", not "TCS that should have been collected".
 *   - Cross-tenant isolation: req.travelTenant.id is enforced at the prisma
 *     where clause; a regression dropping the filter would leak rows across
 *     tenants.
 *   - USER role gate: requirePermission('invoices', 'read') — USER must get 403
 *     before any DB read (finance reports are not surfaced to USER).
 *
 * Mock seam: prisma singleton monkey-patched before requiring the router;
 * supertest drives real HS256 JWTs. Same pattern as
 * backend/test/routes/travel-invoice-aged-receivable.test.js (slice 23).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelPaymentSchedule = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  count: vi.fn().mockResolvedValue(0),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelSupplierPayable = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  count: vi.fn().mockResolvedValue(0),
};
prisma.contact = {
  ...(prisma.contact || {}),
  findMany: vi.fn().mockResolvedValue([]),
  findUnique: vi.fn().mockResolvedValue({ stateCode: '07' }),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN', subBrandAccess: null,
});
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const AS_OF = '2026-06-09';
const AS_OF_DATE = new Date('2026-06-09T00:00:00.000Z');
function daysAgo(n) {
  return new Date(AS_OF_DATE.getTime() - n * 86_400_000);
}
function daysAhead(n) {
  return new Date(AS_OF_DATE.getTime() + n * 86_400_000);
}

function invoice({
  id = 100,
  subBrand = 'tmc',
  contactId = 999,
  invoiceNum = 'TINV-2026-0001',
  status = 'Issued',
  totalAmount = '30000.00',
  currency = 'INR',
  dueDate = null,
  schedule = [],
  tcsAmount = null,
  tcsAppliedAt = null,
} = {}) {
  return {
    id,
    tenantId: 1,
    subBrand,
    contactId,
    invoiceNum,
    status,
    totalAmount,
    currency,
    dueDate,
    paidAt: null,
    docType: 'TaxInvoice',
    schedule,
    tcsAmount,
    tcsAppliedAt,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

function payable({
  id = 1,
  supplierId = 10,
  poNumber = 'PO-2026-0001',
  amount = '100000.00',
  currency = 'INR',
  status = 'pending',
  dueDate = null,
  supplier = { id: 10, name: 'Air India', subBrand: 'rfu' },
} = {}) {
  return {
    id,
    tenantId: 1,
    supplierId,
    poNumber,
    amount,
    currency,
    status,
    dueDate,
    supplier,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.travelSupplierPayable.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
});

// ───────────────────────────── Aged Receivable ─────────────────────────────

describe('GET /api/travel/invoices/aged-receivable-report', () => {
  test('case 1 — happy path: 4 buckets present with C8 named labels + outstanding math', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoice({
        id: 1,
        totalAmount: '30000.00',
        dueDate: daysAgo(10),
        schedule: [{ receivedAmount: '5000.00' }],
      }),
      invoice({
        id: 2,
        totalAmount: '60000.00',
        dueDate: daysAgo(45),
        schedule: [],
      }),
      invoice({
        id: 3,
        totalAmount: '90000.00',
        dueDate: daysAgo(75),
        schedule: [{ receivedAmount: '20000.00' }],
      }),
      invoice({
        id: 4,
        totalAmount: '15000.00',
        dueDate: daysAgo(120),
      }),
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/invoices/aged-receivable-report?asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.asOfDate).toBe(AS_OF);
    expect(res.body.currency).toBe('INR');
    expect(res.body.buckets).toHaveLength(4);

    const labels = res.body.buckets.map((b) => b.label);
    expect(labels).toEqual([
      'Current (0-30 days)',
      '31-60 days',
      '61-90 days',
      'Over 90 days',
    ]);

    // bucket totals — 10d→Current, 45d→31-60, 75d→61-90, 120d→90+
    const cur = res.body.buckets.find((b) => b.label === 'Current (0-30 days)');
    const b3160 = res.body.buckets.find((b) => b.label === '31-60 days');
    const b6190 = res.body.buckets.find((b) => b.label === '61-90 days');
    const b90 = res.body.buckets.find((b) => b.label === 'Over 90 days');

    expect(cur.invoiceCount).toBe(1);
    expect(cur.totalAmount).toBe(25000); // 30000 - 5000
    expect(b3160.invoiceCount).toBe(1);
    expect(b3160.totalAmount).toBe(60000);
    expect(b6190.invoiceCount).toBe(1);
    expect(b6190.totalAmount).toBe(70000); // 90000 - 20000
    expect(b90.invoiceCount).toBe(1);
    expect(b90.totalAmount).toBe(15000);

    expect(res.body.totalReceivable).toBe(170000);
    expect(res.body.invoices).toHaveLength(4);
    // Drill-down sorted by daysOverdue DESC.
    expect(res.body.invoices[0].id).toBe(4);
    expect(res.body.invoices[3].id).toBe(1);
  });

  test('case 2 — no invoices → all 4 buckets present with invoiceCount=0 + totalAmount=0', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get(`/api/travel/invoices/aged-receivable-report?asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(4);
    for (const b of res.body.buckets) {
      expect(b.invoiceCount).toBe(0);
      expect(b.totalAmount).toBe(0);
    }
    expect(res.body.totalReceivable).toBe(0);
    expect(res.body.invoices).toEqual([]);
  });

  test('case 3 — ?subBrand filter narrows prisma where clause', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get(`/api/travel/invoices/aged-receivable-report?subBrand=tmc&asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const whereArg = prisma.travelInvoice.findMany.mock.calls[0][0].where;
    expect(whereArg.subBrand).toBe('tmc');
  });

  test('case 4 — cross-tenant isolation: where.tenantId matches req.travelTenant.id', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get(`/api/travel/invoices/aged-receivable-report?asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const whereArg = prisma.travelInvoice.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(1);
    // Status filter excludes Paid + Voided.
    expect(whereArg.status).toEqual({ notIn: ['Paid', 'Voided'] });
  });

  test('case 5 — USER role → 403 (verifyRole gate blocks before findMany)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    const res = await request(makeApp())
      .get(`/api/travel/invoices/aged-receivable-report?asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────── Aged Payable ───────────────────────────────

describe('GET /api/travel/invoices/aged-payable-report', () => {
  test('case 6 — happy path: 4 buckets present + payable totals match', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      payable({ id: 1, amount: '50000.00', dueDate: daysAgo(5) }), // Current
      payable({ id: 2, amount: '80000.00', dueDate: daysAgo(40) }), // 31-60
      payable({ id: 3, amount: '20000.00', dueDate: daysAgo(80) }), // 61-90
      payable({ id: 4, amount: '10000.00', dueDate: daysAgo(200) }), // Over 90
    ]);
    const res = await request(makeApp())
      .get(`/api/travel/invoices/aged-payable-report?asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(4);
    const cur = res.body.buckets.find((b) => b.label === 'Current (0-30 days)');
    const b90 = res.body.buckets.find((b) => b.label === 'Over 90 days');
    expect(cur.invoiceCount).toBe(1);
    expect(cur.totalAmount).toBe(50000);
    expect(b90.invoiceCount).toBe(1);
    expect(b90.totalAmount).toBe(10000);
    expect(res.body.totalPayable).toBe(160000);
    expect(res.body.payables).toHaveLength(4);
  });

  test('case 7 — empty payable list → all 4 buckets present + zeros', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get(`/api/travel/invoices/aged-payable-report?asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(4);
    for (const b of res.body.buckets) {
      expect(b.invoiceCount).toBe(0);
      expect(b.totalAmount).toBe(0);
    }
    expect(res.body.totalPayable).toBe(0);
    expect(res.body.payables).toEqual([]);
  });

  test('aged-payable status filter excludes paid + cancelled', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get(`/api/travel/invoices/aged-payable-report?asOfDate=${AS_OF}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const whereArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0].where;
    expect(whereArg.status).toEqual({ notIn: ['paid', 'cancelled'] });
    expect(whereArg.tenantId).toBe(1);
  });
});

// ───────────────────────────────── 27EQ ─────────────────────────────────────

function bufferParser(r, cb) {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('GET /api/travel/invoices/tcs/27eq', () => {
  test('case 8 — json mode happy path: per-buyer totals + dateRange + totals envelope', async () => {
    // Two buyers; buyer A has 2 invoices, buyer B has 1.
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoice({
        id: 1, contactId: 11, tcsAmount: '5000.00',
        tcsAppliedAt: new Date('2025-04-15'),
      }),
      invoice({
        id: 2, contactId: 11, tcsAmount: '3500.50',
        tcsAppliedAt: new Date('2025-05-20'),
      }),
      invoice({
        id: 3, contactId: 22, tcsAmount: '12000.17',
        tcsAppliedAt: new Date('2025-06-10'),
      }),
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 11, name: 'Acme School', gst: '07ABCDE1234F1Z5' },
      { id: 22, name: 'Globus Travels', gst: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?fy=2025-26&quarter=Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.fy).toBe('2025-26');
    expect(res.body.quarter).toBe('Q1');
    expect(res.body.dateRange).toEqual({
      from: '2025-04-01',
      to: '2025-06-30',
    });
    expect(res.body.rows).toHaveLength(2);

    // Rows sorted DESC by totalTcsCollected — buyer B (12000.17) > buyer A (8500.50).
    expect(res.body.rows[0]).toMatchObject({
      buyerName: 'Globus Travels',
      buyerPan: null,
      totalTcsCollected: 12000.17,
      invoiceCount: 1,
    });
    expect(res.body.rows[1]).toMatchObject({
      buyerName: 'Acme School',
      buyerPan: 'ABCDE1234F', // derived from GSTIN chars 3..12
      totalTcsCollected: 8500.50,
      invoiceCount: 2,
    });

    expect(res.body.totals.totalRows).toBe(2);
    expect(res.body.totals.totalTcs).toBe(20500.67);
  });

  test('case 9 — csv mode: Content-Disposition + CSV columns + BOM + CRLF', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoice({
        id: 1, contactId: 11, tcsAmount: '5000.00',
        tcsAppliedAt: new Date('2025-04-15'),
      }),
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 11, name: 'Acme School', gst: '07ABCDE1234F1Z5' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?fy=2025-26&quarter=Q1&format=csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /filename="tcs-27eq-2025-26-Q1\.csv"/,
    );
    const body = res.body.toString('utf8');
    expect(body.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    expect(body).toMatch(/\r\n/); // CRLF
    expect(body).toContain('Buyer_Name,Buyer_PAN,Total_TCS,Invoice_Count');
    expect(body).toContain('Acme School');
    expect(body).toContain('ABCDE1234F');
    expect(body).toContain('5000.00');
  });

  test('case 10 — missing fy → 400 MISSING_FY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?quarter=Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FY' });
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 10b — missing quarter → 400 MISSING_QUARTER', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?fy=2025-26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_QUARTER' });
  });

  test('case 10c — invalid fy YY (e.g. 2025-27) → 400 INVALID_FY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?fy=2025-27&quarter=Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FY' });
  });

  test('case 10d — invalid quarter (Q5) → 400 INVALID_QUARTER', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?fy=2025-26&quarter=Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUARTER' });
  });

  test('case 11 — FY parsing: 2025-26 maps to 2025-04-01 → 2026-03-31 across all 4 quarters', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const ranges = {
      Q1: { from: '2025-04-01', to: '2025-06-30' },
      Q2: { from: '2025-07-01', to: '2025-09-30' },
      Q3: { from: '2025-10-01', to: '2025-12-31' },
      Q4: { from: '2026-01-01', to: '2026-03-31' },
    };

    for (const [q, expected] of Object.entries(ranges)) {
      const res = await request(makeApp())
        .get(`/api/travel/invoices/tcs/27eq?fy=2025-26&quarter=${q}`)
        .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
      expect(res.status).toBe(200);
      expect(res.body.dateRange).toEqual(expected);
    }
  });

  test('case 12 — only TCS-applicable invoices included (tcsAmount>0 + tcsAppliedAt set)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?fy=2025-26&quarter=Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const whereArg = prisma.travelInvoice.findMany.mock.calls[0][0].where;
    expect(whereArg.tcsAmount).toEqual({ gt: 0 });
    expect(whereArg.tcsAppliedAt.gte.toISOString().slice(0, 10)).toBe('2025-04-01');
    expect(whereArg.tcsAppliedAt.lt.toISOString().slice(0, 10)).toBe('2025-07-01');
    expect(whereArg.tenantId).toBe(1);
  });

  test('USER role → 403 (verifyRole gate blocks before findMany)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .get('/api/travel/invoices/tcs/27eq?fy=2025-26&quarter=Q1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });
});
