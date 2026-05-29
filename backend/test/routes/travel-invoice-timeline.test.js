// @ts-check
/**
 * Arc 2 #901 slice 28 — GET /api/travel/invoices/:id/timeline contract.
 *
 * Pins GET /api/travel/invoices/:id/timeline — the operator-facing "Activity"
 * feed for a single invoice. Pure presentation layer over the existing
 * AuditLog rows that prior slices (19..27) already write via writeAudit().
 * No new audit-event types; this endpoint simply queries + merges.
 *
 * Mirrors backend/test/routes/travel-invoice-void.test.js (slice 27) — same
 * prisma-singleton-patch + supertest pattern, same JWT signing.
 *
 * Contracts asserted (9 cases):
 *   1. Happy path: returns invoice-level events sorted DESC + count + envelope.
 *   2. Line events merged when includeLines=true (default).
 *   3. includeLines=false suppresses line-row prisma call AND result.
 *   4. Line rows with non-matching invoiceId in details are filtered out.
 *   5. JSON details are parsed; non-JSON details pass through as-is.
 *   6. ?limit=5 caps the response array length.
 *   7. ?limit=999 (out of range) -> 400 INVALID_NUMERIC_QUERY.
 *   8. Cross-tenant invoice -> 404 INVOICE_NOT_FOUND (no auditLog read).
 *   9. Sub-brand denied -> 403 SUB_BRAND_DENIED.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
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
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
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

function issuedInvoice(overrides = {}) {
  return {
    id: 700,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TMC/26-27/0007',
    status: 'Issued',
    docType: 'TaxInvoice',
    totalAmount: '12000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    parentInvoiceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function auditRow({ id, action, entity = 'TravelInvoice', entityId = 700, at, details = null }) {
  return {
    id,
    action,
    entity,
    entityId,
    createdAt: new Date(at),
    userId: 7,
    details: typeof details === 'object' && details !== null ? JSON.stringify(details) : details,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
});

describe('GET /api/travel/invoices/:id/timeline — chronological event feed', () => {
  test('happy path: invoice-level events sorted DESC + envelope shape', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 700 }));
    // 3 invoice-level events: created, issued, marked-paid.
    prisma.auditLog.findMany.mockImplementation(async ({ where }) => {
      if (where.entity === 'TravelInvoice') {
        return [
          auditRow({ id: 30, action: 'TRAVEL_INVOICE_VOIDED',
            at: '2026-05-25T10:00:00Z',
            details: { prevStatus: 'Paid', reason: 'Refund', invoiceNum: 'TMC/26-27/0007', subBrand: 'tmc' } }),
          auditRow({ id: 20, action: 'TRAVEL_INVOICE_ISSUED',
            at: '2026-05-24T09:00:00Z',
            details: { invoiceNum: 'TMC/26-27/0007', totalAmount: '12000.00' } }),
          auditRow({ id: 10, action: 'CREATE',
            at: '2026-05-23T08:00:00Z',
            details: { subBrand: 'tmc', contactId: 999, invoiceNum: 'TMC/26-27/0007' } }),
        ];
      }
      return [];
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/700/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe(700);
    expect(res.body.count).toBe(3);
    expect(res.body.events).toHaveLength(3);

    // Sorted DESC (newest first).
    expect(res.body.events[0].action).toBe('TRAVEL_INVOICE_VOIDED');
    expect(res.body.events[1].action).toBe('TRAVEL_INVOICE_ISSUED');
    expect(res.body.events[2].action).toBe('CREATE');

    // Details parsed to object, not raw JSON string.
    expect(res.body.events[0].details).toMatchObject({
      prevStatus: 'Paid', reason: 'Refund', invoiceNum: 'TMC/26-27/0007',
    });
    expect(res.body.events[2].details).toMatchObject({ subBrand: 'tmc', contactId: 999 });

    // Standard event shape.
    expect(res.body.events[0]).toMatchObject({
      id: 30, entity: 'TravelInvoice', entityId: 700, userId: 7,
    });
    expect(res.body.events[0].at).toBeDefined();

    // Sub-brand scope check called.
    expect(prisma.user.findUnique).toHaveBeenCalled();
  });

  test('line events merged when includeLines defaults true', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 700 }));
    prisma.auditLog.findMany.mockImplementation(async ({ where }) => {
      if (where.entity === 'TravelInvoice') {
        return [
          auditRow({ id: 10, action: 'CREATE',
            at: '2026-05-23T08:00:00Z', details: { invoiceNum: 'TMC/26-27/0007' } }),
        ];
      }
      if (where.entity === 'TravelInvoiceLine') {
        return [
          auditRow({ id: 200, action: 'CREATE', entity: 'TravelInvoiceLine', entityId: 5001,
            at: '2026-05-23T08:30:00Z',
            details: { invoiceId: 700, lineType: 'per_pax', quantity: 30 } }),
          auditRow({ id: 201, action: 'UPDATE', entity: 'TravelInvoiceLine', entityId: 5001,
            at: '2026-05-23T09:15:00Z',
            details: { invoiceId: 700, fields: ['unitPrice'] } }),
        ];
      }
      return [];
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/700/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    // Merge sort newest-first: line UPDATE 09:15 -> line CREATE 08:30 -> invoice CREATE 08:00.
    expect(res.body.events[0]).toMatchObject({ entity: 'TravelInvoiceLine', action: 'UPDATE' });
    expect(res.body.events[1]).toMatchObject({ entity: 'TravelInvoiceLine', action: 'CREATE' });
    expect(res.body.events[2]).toMatchObject({ entity: 'TravelInvoice', action: 'CREATE' });
  });

  test('includeLines=false suppresses the TravelInvoiceLine prisma call AND result', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 700 }));
    prisma.auditLog.findMany.mockResolvedValue([
      auditRow({ id: 10, action: 'CREATE', at: '2026-05-23T08:00:00Z',
        details: { invoiceNum: 'TMC/26-27/0007' } }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/700/timeline?includeLines=false')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.events[0].entity).toBe('TravelInvoice');

    // Only ONE findMany call (invoice-level); no second call for lines.
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.findMany.mock.calls[0][0].where.entity).toBe('TravelInvoice');
  });

  test('line rows with non-matching invoiceId in details are filtered out', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 700 }));
    prisma.auditLog.findMany.mockImplementation(async ({ where }) => {
      if (where.entity === 'TravelInvoice') {
        return [
          auditRow({ id: 10, action: 'CREATE', at: '2026-05-23T08:00:00Z',
            details: { invoiceNum: 'TMC/26-27/0007' } }),
        ];
      }
      if (where.entity === 'TravelInvoiceLine') {
        return [
          // Line on OUR invoice — should pass through.
          auditRow({ id: 200, action: 'CREATE', entity: 'TravelInvoiceLine', entityId: 5001,
            at: '2026-05-23T08:30:00Z', details: { invoiceId: 700, lineType: 'per_pax' } }),
          // Line on a DIFFERENT invoice — should be filtered out.
          auditRow({ id: 201, action: 'CREATE', entity: 'TravelInvoiceLine', entityId: 6000,
            at: '2026-05-23T08:31:00Z', details: { invoiceId: 999, lineType: 'fee' } }),
          // Line with missing details — should be filtered out.
          auditRow({ id: 202, action: 'CREATE', entity: 'TravelInvoiceLine', entityId: 7000,
            at: '2026-05-23T08:32:00Z', details: null }),
        ];
      }
      return [];
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/700/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const entityIds = res.body.events.map((e) => e.entityId);
    expect(entityIds).toEqual(expect.arrayContaining([700, 5001]));
    expect(entityIds).not.toContain(6000);
    expect(entityIds).not.toContain(7000);
  });

  test('JSON details parsed to object; non-JSON details pass through as-is', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 700 }));
    prisma.auditLog.findMany.mockImplementation(async ({ where }) => {
      if (where.entity === 'TravelInvoice') {
        return [
          // JSON-shaped details — should parse.
          auditRow({ id: 10, action: 'CREATE', at: '2026-05-23T08:00:00Z',
            details: { invoiceNum: 'TMC/26-27/0007' } }),
          // Free-form description string — should NOT crash; passes through as string.
          {
            id: 11,
            action: 'LEGACY_EVENT',
            entity: 'TravelInvoice',
            entityId: 700,
            createdAt: new Date('2026-05-22T08:00:00Z'),
            userId: 7,
            details: 'free-form description that is not JSON',
          },
        ];
      }
      return [];
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/700/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.events[0].details).toMatchObject({ invoiceNum: 'TMC/26-27/0007' });
    expect(res.body.events[1].details).toBe('free-form description that is not JSON');
  });

  test('?limit=2 caps the response array length', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 700 }));
    prisma.auditLog.findMany.mockImplementation(async ({ where, take }) => {
      if (where.entity === 'TravelInvoice') {
        // Pretend Prisma honoured the take param — return 2 rows max.
        expect(take).toBe(2);
        return [
          auditRow({ id: 30, action: 'TRAVEL_INVOICE_ISSUED', at: '2026-05-24T09:00:00Z',
            details: { invoiceNum: 'TMC/26-27/0007' } }),
          auditRow({ id: 20, action: 'CREATE', at: '2026-05-23T08:00:00Z',
            details: { invoiceNum: 'TMC/26-27/0007' } }),
        ];
      }
      if (where.entity === 'TravelInvoiceLine') {
        // limit * 5 = 10 for the bounded line fetch.
        expect(take).toBe(10);
        return [
          auditRow({ id: 200, action: 'CREATE', entity: 'TravelInvoiceLine', entityId: 5001,
            at: '2026-05-23T08:30:00Z', details: { invoiceId: 700, lineType: 'per_pax' } }),
        ];
      }
      return [];
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/700/timeline?limit=2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 2 invoice + 1 line merged = 3 candidates, cap=2 -> 2 newest survive.
    expect(res.body.count).toBe(2);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].action).toBe('TRAVEL_INVOICE_ISSUED');
    expect(res.body.events[1]).toMatchObject({ entity: 'TravelInvoiceLine', action: 'CREATE' });
  });

  test('?limit=999 (out of [1,200] range) -> 400 INVALID_NUMERIC_QUERY (no DB read)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/700/timeline?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_NUMERIC_QUERY' });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('cross-tenant invoice -> 404 INVOICE_NOT_FOUND (no auditLog read)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/invoices/9999/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denied -> 403 SUB_BRAND_DENIED (no auditLog read)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 706, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/706/timeline')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});
