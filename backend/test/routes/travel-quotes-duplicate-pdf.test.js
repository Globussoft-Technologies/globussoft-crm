// @ts-check
/**
 * Arc 2 #900 slice 1 — TravelQuote duplicate + PDF endpoint contract.
 *
 * Pins the two operator features added to backend/routes/travel_quotes.js
 * on top of the existing CRUD scaffold (commit fdb793e + travel_quotes
 * tests at backend/test/routes/travel_quotes.test.js):
 *
 *   POST /api/travel/quotes/:id/duplicate
 *     - ADMIN+MANAGER gate, USER → 403 RBAC_DENIED.
 *     - Tenant-scoped source lookup; cross-tenant → 404 QUOTE_NOT_FOUND.
 *     - Optional body { subBrand, contactId } overrides the duplicate's
 *       target fields (otherwise inherited from source).
 *     - New row enters with status='Draft' regardless of source status.
 *     - Audit row stamped with action='TRAVEL_QUOTE_DUPLICATED' carries
 *       sourceId + newId in the details JSON.
 *
 *   GET /api/travel/quotes/:id/pdf
 *     - ADMIN+MANAGER gate, USER → 403 RBAC_DENIED.
 *     - Tenant-scoped source lookup; cross-tenant → 404 QUOTE_NOT_FOUND.
 *     - Malformed :id (non-numeric) → 400 INVALID_ID.
 *     - Content-Type=application/pdf + Content-Disposition with
 *       filename="quote-<id>.pdf"; body is a Buffer with %PDF magic.
 *     - Audit row stamped with action='TRAVEL_QUOTE_PDF_DOWNLOADED'
 *       carries quoteId in the details JSON.
 *
 * Pattern mirrors backend/test/routes/travel_quotes.test.js (HS256 JWT
 * via the dev fallback secret; prisma singleton patched BEFORE the
 * router is required so verifyToken's revokedToken probe + the route's
 * findFirst/create probes both hit the stubs).
 *
 * PDF render runs the REAL services/pdfRenderer.generateTravelQuotePdf
 * — the function is pure-cpu (no I/O, no external deps beyond pdfkit
 * which is already in the dependency tree), so mocking would only test
 * the mock. We assert on the response Buffer's %PDF magic + length to
 * pin that a real PDF byte stream flowed through.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router (matches travel_quotes.test).
prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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
const travelQuotesRouter = requireCJS('../../routes/travel_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelQuotesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function sourceQuote(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    status: 'Sent',
    totalAmount: '45000.00',
    currency: 'INR',
    validUntil: new Date(Date.now() + 7 * 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Parse the binary response body as a Buffer (supertest defaults to
// string, which corrupts the PDF bytes on .toString() round-trip).
function bufferParser(r, cb) {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelQuote.findMany.mockReset();
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.count.mockReset();
  prisma.travelQuote.create.mockReset();
  prisma.travelQuote.update.mockReset();
  prisma.travelQuote.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/quotes/:id/duplicate', () => {
  test('happy path: returns 201 with new row, status=Draft, same contactId + subBrand inherited', async () => {
    const src = sourceQuote({ id: 100, status: 'Sent', subBrand: 'tmc', contactId: 999 });
    prisma.travelQuote.findFirst.mockResolvedValue(src);
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 200,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 200,
      tenantId: 1,
      subBrand: 'tmc',
      contactId: 999,
      status: 'Draft', // ALWAYS Draft regardless of source status
      currency: 'INR',
    });

    // The create call must inherit financial + temporal fields from source.
    expect(prisma.travelQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          contactId: 999,
          status: 'Draft',
          totalAmount: src.totalAmount,
          currency: 'INR',
        }),
      }),
    );
  });

  test('body { subBrand: "rfu" } override produces a duplicate under the new sub-brand', async () => {
    const src = sourceQuote({ id: 100, subBrand: 'tmc', contactId: 999 });
    prisma.travelQuote.findFirst.mockResolvedValue(src);
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 201,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subBrand: 'rfu', contactId: 999, status: 'Draft' });
    expect(prisma.travelQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subBrand: 'rfu' }),
      }),
    );
  });

  test('body { contactId: 555 } override produces a duplicate against the new contact', async () => {
    const src = sourceQuote({ id: 100, contactId: 999 });
    prisma.travelQuote.findFirst.mockResolvedValue(src);
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 202,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 555 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ contactId: 555, status: 'Draft' });
  });

  test('cross-tenant source returns 404 QUOTE_NOT_FOUND (no create or audit fire)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/quotes/9999/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    expect(prisma.travelQuote.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('USER role returns 403 RBAC_DENIED (gate blocks before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelQuote.create).not.toHaveBeenCalled();
  });

  test('malformed :id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/not-a-number/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
  });

  test('audit row written with action=TRAVEL_QUOTE_DUPLICATED + sourceId/newId in details', async () => {
    const src = sourceQuote({ id: 100, subBrand: 'tmc', contactId: 999 });
    prisma.travelQuote.findFirst.mockResolvedValue(src);
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 250,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelQuote',
      action: 'TRAVEL_QUOTE_DUPLICATED',
      entityId: 250,
      userId: 7,
      tenantId: 1,
    });
    // writeAudit stores `details` as a JSON-stringified column — parse and assert.
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({ sourceId: 100, newId: 250 });
  });
});

describe('GET /api/travel/quotes/:id/pdf', () => {
  test('happy path: returns 200 with Content-Type=application/pdf and a valid %PDF Buffer', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(sourceQuote({ id: 100 }));

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(100); // any real PDF is well over 100 bytes
    // PDF magic bytes — pdfkit always emits "%PDF-" at the start.
    expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('Content-Disposition is attachment with filename="quote-<id>.pdf"', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(sourceQuote({ id: 100 }));

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toMatch(/filename="quote-100\.pdf"/);
  });

  test('cross-tenant lookup returns 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/quotes/9999/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('USER role returns 403 RBAC_DENIED (gate blocks before findFirst)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
  });

  test('malformed :id (non-numeric) returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/oops/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
  });

  test('audit row written with action=TRAVEL_QUOTE_PDF_DOWNLOADED + quoteId in details', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(sourceQuote({ id: 100 }));

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelQuote',
      action: 'TRAVEL_QUOTE_PDF_DOWNLOADED',
      entityId: 100,
      userId: 7,
      tenantId: 1,
    });
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({ quoteId: 100 });
  });

  test('MANAGER role can also download the PDF (mirrors ADMIN path)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(sourceQuote({ id: 100 }));
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(100);
  });
});
