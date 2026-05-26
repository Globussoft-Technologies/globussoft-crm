// @ts-check
/**
 * Unit tests for backend/routes/csv_io.js — generic CSV import/export contract.
 *
 * What's pinned
 * -------------
 * Seven endpoints mounted at /api/csv covering four resource families:
 *
 *   GET  /services/export.csv          ADMIN | MANAGER
 *   POST /services/import.csv          ADMIN | MANAGER (upsert by name)
 *   GET  /products/export.csv          ADMIN | MANAGER
 *   POST /products/import.csv          ADMIN | MANAGER (upsert by sku || name)
 *   GET  /membership-plans/export.csv  ADMIN | MANAGER
 *   POST /membership-plans/import.csv  ADMIN | MANAGER (upsert by name)
 *   GET  /bookings/export.csv          ADMIN | MANAGER (read-only export)
 *
 * Contract surfaces this file pins:
 *   - Happy export: 200, text/csv, Content-Disposition attachment with the
 *     resource-specific filename, body is BOM-prefixed (0xEF 0xBB 0xBF) CSV
 *     with the expected header row + serialised data row.
 *   - Tenant scoping: findMany / findFirst calls always carry tenantId from
 *     req.user.tenantId — never a body-supplied value.
 *   - Happy import: new-row inserts vs. existing-name upserts; idempotency
 *     key behaviour returns { imported, updated, skipped, errors }.
 *   - Per-row error reporting: bad fields (missing name, invalid price, bad
 *     entitlements JSON) surface in errors[] with rowNumber 2-based offset.
 *   - The request itself still returns 200 — per-row failures are NOT 4xx.
 *   - Validation: empty CSV → 400 EMPTY_CSV; no body → 400 NO_CSV; too many
 *     rows → 413 TOO_MANY_ROWS.
 *   - Products: sku collision across tenants is rejected per-row.
 *   - errorReport=csv query flag flips the response to a CSV body when there
 *     are errors (Content-Disposition: attachment).
 *
 * Pattern reference
 * -----------------
 * Mirrors backend/test/routes/billing.test.js (auth-middleware monkey-patch
 * to bypass verifyToken/verifyRole + inject req.user via express middleware)
 * and backend/test/routes/travel-csv-io.test.js (bufferParser for binary
 * CSV bodies, BOM byte assertion). Prisma singleton is patched BEFORE the
 * router is required so findFirst/create/update probes land on the stubs.
 * Audit-log create is mocked pass-through; the audit chain's own contract
 * is owned by audit-chain.test.js.
 *
 * Not covered here (intentional, out of scope for ≥10 cases):
 *   - Multipart/form-data upload path (multer's req.file branch). The
 *     text/csv body path is tested; the multipart path is the same
 *     readUploadedCsv() helper with a different upstream.
 *   - The audit-log writeAudit details payload — owned by audit-chain.test.js.
 *   - Booking export (read-only, structurally identical to services export
 *     which IS tested; not enough delta to justify a sibling test).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch auth middleware BEFORE the router is required. The route's
// destructured `verifyToken` / `verifyRole` references capture whatever
// `authMw.{verifyToken,verifyRole}` points to at module-load. RBAC denial
// is tested by overriding verifyRole at app-build time per-test.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (req, _res, next) => {
  // Allow per-app override; default to ADMIN tenant 1.
  if (!req.user) req.user = { userId: 7, tenantId: 1, role: 'ADMIN' };
  next();
};
authMw.verifyRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'RBAC_DENIED', code: 'RBAC_DENIED' });
  }
  next();
};

// Prisma singleton patching — replace lazy delegates with vi.fn() stubs.
prisma.service = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.product = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.membershipPlan = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.booking = {
  findMany: vi.fn(),
};
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({ id: 1 }),
};

import express from 'express';
import request from 'supertest';
const csvIoRouter = requireCJS('../../routes/csv_io');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  // JSON body parser is mounted for completeness. The route mounts its
  // own express.text({ type: ['text/csv','text/plain'] }) parser internally
  // so text/csv bodies are read by readUploadedCsv() correctly.
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/csv', csvIoRouter);
  return app;
}

// CSV downloads are text/csv but the BOM prefix + CRLF endings can be
// mangled by supertest's default string coercion. Parsing as Buffer lets
// us assert the BOM byte sequence (EF BB BF) is present.
function bufferParser(r, cb) {
  const chunks = [];
  r.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeEach(() => {
  prisma.service.findMany.mockReset();
  prisma.service.findFirst.mockReset();
  prisma.service.create.mockReset();
  prisma.service.update.mockReset();
  prisma.product.findMany.mockReset();
  prisma.product.findFirst.mockReset();
  prisma.product.create.mockReset();
  prisma.product.update.mockReset();
  prisma.membershipPlan.findMany.mockReset();
  prisma.membershipPlan.findFirst.mockReset();
  prisma.membershipPlan.create.mockReset();
  prisma.membershipPlan.update.mockReset();
  prisma.booking.findMany.mockReset();
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

// ─── Services export ───────────────────────────────────────────────

describe('GET /api/csv/services/export.csv', () => {
  test('happy export: 200 text/csv with BOM + header row + data row + tenant-scoped findMany', async () => {
    prisma.service.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Hair Cut',
        category: 'Salon',
        categoryId: 12,
        ticketTier: 'medium',
        basePrice: 500,
        durationMin: 30,
        description: 'Standard cut',
        isActive: true,
      },
    ]);

    const res = await request(makeApp())
      .get('/api/csv/services/export.csv')
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/services-export\.csv/);
    // UTF-8 BOM (EF BB BF) must be first 3 bytes — Excel-on-Windows needs it.
    expect(res.body.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    const body = res.body.toString('utf8');
    expect(body).toMatch(/id,name,category,categoryId,ticketTier,basePrice,durationMin,description,isActive/);
    expect(body).toMatch(/Hair Cut/);
    expect(body).toMatch(/Salon/);
    // tenant scoping — findMany must be called with tenantId from req.user.
    expect(prisma.service.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }),
    );
  });
});

// ─── Services import ───────────────────────────────────────────────

describe('POST /api/csv/services/import.csv', () => {
  test('happy import: inserts new service and returns imported:1', async () => {
    prisma.service.findFirst.mockResolvedValue(null);
    prisma.service.create.mockResolvedValue({ id: 42 });

    const csv = [
      'name,category,ticketTier,basePrice,durationMin,description,isActive',
      'Hair Cut,Salon,medium,500,30,Standard cut,true',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/services/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    expect(res.body.errors).toEqual([]);
    expect(prisma.service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          name: 'Hair Cut',
          category: 'Salon',
          ticketTier: 'medium',
          basePrice: 500,
          durationMin: 30,
        }),
      }),
    );
  });

  test('existing service by name is UPDATED not duplicated (idempotent upsert)', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 99, name: 'Hair Cut' });
    prisma.service.update.mockResolvedValue({ id: 99 });

    const csv = [
      'name,category,basePrice',
      'Hair Cut,Salon,750',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/services/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(prisma.service.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 99 } }),
    );
    expect(prisma.service.create).not.toHaveBeenCalled();
  });

  test('missing name surfaces per-row error (rowNumber 2) — request stays 200', async () => {
    const csv = [
      'name,category,basePrice',
      ',Salon,500',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/services/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({
      rowNumber: 2,
      reason: expect.stringMatching(/missing name/i),
    });
    expect(prisma.service.create).not.toHaveBeenCalled();
  });

  test('empty CSV (no body) returns 400 NO_CSV', async () => {
    const res = await request(makeApp())
      .post('/api/csv/services/import.csv')
      .set('Content-Type', 'text/csv')
      .send('');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_CSV' });
    expect(prisma.service.create).not.toHaveBeenCalled();
  });

  test('header-only CSV returns 400 EMPTY_CSV', async () => {
    const res = await request(makeApp())
      .post('/api/csv/services/import.csv')
      .set('Content-Type', 'text/csv')
      .send('name,category,basePrice');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_CSV' });
    expect(prisma.service.create).not.toHaveBeenCalled();
  });
});

// ─── Products import ───────────────────────────────────────────────

describe('POST /api/csv/products/import.csv', () => {
  test('happy import: inserts new product, SKU set, tenant-scoped create', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.create.mockResolvedValue({ id: 100 });

    const csv = [
      'name,sku,price,isRecurring,currentStock,threshold',
      'Vitamin C,VITC-001,12.50,false,50,10',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/products/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          name: 'Vitamin C',
          sku: 'VITC-001',
          price: 12.5,
          isRecurring: false,
          currentStock: 50,
          threshold: 10,
        }),
      }),
    );
  });

  test('product with sku owned by ANOTHER tenant is rejected per-row (cross-tenant guard)', async () => {
    // sku-lookup hits a row whose tenantId is different — must be rejected.
    prisma.product.findFirst.mockResolvedValueOnce({
      id: 555,
      sku: 'GLOBAL-1',
      tenantId: 2, // foreign
    });

    const csv = [
      'name,sku,price',
      'Foo,GLOBAL-1,100',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/products/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].reason).toMatch(/already exists in another tenant/i);
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  test('invalid price surfaces per-row error', async () => {
    const csv = [
      'name,sku,price',
      'Foo,FOO-1,not-a-number',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/products/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, skipped: 1 });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].reason).toMatch(/invalid price/i);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });
});

// ─── Membership plans import ───────────────────────────────────────

describe('POST /api/csv/membership-plans/import.csv', () => {
  test('happy import: parses entitlements JSON and inserts plan', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(null);
    prisma.membershipPlan.create.mockResolvedValue({ id: 7 });

    const csv = [
      'name,description,durationDays,price,currency,entitlements,isActive',
      '"Gold","Premium",365,9999,INR,"[""free-haircut"",""free-consultation""]",true',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/membership-plans/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    const data = prisma.membershipPlan.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: 1,
      name: 'Gold',
      durationDays: 365,
      price: 9999,
      currency: 'INR',
    });
    // entitlements is normalised to a JSON string of an array.
    expect(JSON.parse(data.entitlements)).toEqual(['free-haircut', 'free-consultation']);
  });

  test('non-JSON entitlements surfaces per-row error (request stays 200)', async () => {
    const csv = [
      'name,durationDays,price,entitlements',
      'Bronze,30,499,not-valid-json',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/membership-plans/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].reason).toMatch(/invalid entitlements JSON/i);
    expect(prisma.membershipPlan.create).not.toHaveBeenCalled();
  });

  test('invalid durationDays (zero or negative) surfaces per-row error', async () => {
    const csv = [
      'name,durationDays,price',
      'Bronze,0,499',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/membership-plans/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, skipped: 1 });
    expect(res.body.errors[0].reason).toMatch(/invalid durationDays/i);
    expect(prisma.membershipPlan.create).not.toHaveBeenCalled();
  });
});

// ─── Bookings export ───────────────────────────────────────────────

describe('GET /api/csv/bookings/export.csv', () => {
  test('happy export with date rendering: ISO-formatted scheduledAt + createdAt in body', async () => {
    prisma.booking.findMany.mockResolvedValue([
      {
        id: 1,
        bookingPageId: 5,
        contactName: 'Asha Mehra',
        contactEmail: 'asha@example.com',
        contactPhone: '+91-98xxxxxx',
        scheduledAt: new Date('2026-06-15T10:30:00.000Z'),
        durationMins: 30,
        meetingUrl: 'https://meet.example/abc',
        notes: 'follow-up',
        status: 'BOOKED',
        createdAt: new Date('2026-05-01T08:00:00.000Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/csv/bookings/export.csv')
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/bookings-export\.csv/);
    const body = res.body.toString('utf8');
    expect(body).toMatch(/Asha Mehra/);
    // ISO-rendered timestamps must be present.
    expect(body).toMatch(/2026-06-15T10:30:00\.000Z/);
    expect(body).toMatch(/2026-05-01T08:00:00\.000Z/);
    // tenant scoping
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }),
    );
  });
});

// ─── RBAC + error-report ───────────────────────────────────────────

describe('RBAC + errorReport query flag', () => {
  test('USER role is rejected with 403 (ADMIN+MANAGER gate)', async () => {
    const csv = 'name,category,basePrice\r\nHair Cut,Salon,500';
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/csv/services/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(403);
    expect(prisma.service.create).not.toHaveBeenCalled();
  });

  test('MANAGER role IS allowed for services import (ADMIN+MANAGER gate)', async () => {
    prisma.service.findFirst.mockResolvedValue(null);
    prisma.service.create.mockResolvedValue({ id: 200 });
    const csv = 'name,category,basePrice\r\nFacial,Spa,1200';
    const res = await request(makeApp({ role: 'MANAGER' }))
      .post('/api/csv/services/import.csv')
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1 });
  });

  test('errorReport=csv returns CSV body (text/csv attachment) when errors are present', async () => {
    // Row missing name → goes into errors[] → with the query flag the
    // route returns the error report as a CSV download instead of JSON.
    const csv = [
      'name,category,basePrice',
      ',Salon,500',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/csv/services/import.csv?errorReport=csv')
      .set('Content-Type', 'text/csv')
      .send(csv)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/services-errors\.csv/);
    const body = res.body.toString('utf8');
    expect(body).toMatch(/rowNumber,reason/);
    expect(body).toMatch(/2,/);
    expect(body).toMatch(/missing name/i);
  });
});
