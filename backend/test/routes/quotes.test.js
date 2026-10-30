import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const cache = (path, exports) => {
  const filename = requireCJS.resolve(path);
  requireCJS.cache[filename] = { id: filename, filename, loaded: true, exports };
};
cache('../../middleware/auth', { verifyToken: (_req, _res, next) => next() });
cache('../../middleware/requirePermission', { requirePermission: () => (_req, _res, next) => next() });
cache('../../lib/audit', { writeAudit: vi.fn().mockResolvedValue(undefined) });

let records;
prisma.quote = {
  create: vi.fn(async ({ data }) => {
    const row = { ...data, id: records.length + 1, lineItems: data.lineItems.create };
    records.push(row);
    return row;
  }),
  findFirst: vi.fn(async ({ where }) => records.find((row) => row.id === where.id && row.tenantId === where.tenantId)),
  findMany: vi.fn(async ({ where }) => records.filter((row) => row.tenantId === where.tenantId)),
  update: vi.fn(async ({ where, data }) => {
    const row = { ...records.find((item) => item.id === where.id), ...data, lineItems: data.lineItems.create };
    records = records.map((item) => item.id === where.id ? row : item);
    return row;
  }),
};
prisma.$transaction = vi.fn(async (fn) => fn(prisma));
prisma.tenant = { findUnique: vi.fn() };
prisma.currency = { findMany: vi.fn() };
const quotesRouter = requireCJS('../../routes/quotes');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { tenantId: 1, userId: 7 }; next(); });
app.use('/api/quotes', quotesRouter);

const payload = (overrides = {}) => ({ subject: 'Customer proposal', currency: 'USD',
  lineItems: [{ productName: 'Implementation', quantity: 1, unitPrice: 100 }], ...overrides });
beforeEach(() => {
  records = [];
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'USD' });
  prisma.currency.findMany.mockResolvedValue([{ code: 'USD', exchangeRate: 1 }, { code: 'INR', exchangeRate: 83 }]);
});

describe('Quote pricing regressions', () => {
  test.each([1.5, 0, -1, 1000000, 'invalid'])('rejects invalid quantity %s before saving', async (quantity) => {
    const response = await request(app).post('/api/quotes').send(payload({ lineItems: [{ productName: 'Service', quantity, unitPrice: 100 }] }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_QUANTITY');
    expect(prisma.quote.create).not.toHaveBeenCalled();
  });

  test('a notes-only edit preserves pricing computed from persisted precision', async () => {
    const created = await request(app).post('/api/quotes').send(payload({ lineItems: [
      { productName: 'Service', quantity: 3, unitPrice: 100.125, discountPercent: 5.555, gstRate: 18.555 },
    ] }));
    expect(created.status).toBe(201);
    const edited = await request(app).patch(`/api/quotes/${created.body.id}`).send({ notes: 'Follow up' });
    expect(edited.status).toBe(200);
    expect(edited.body.lineItems).toEqual(created.body.lineItems);
    expect(edited.body.totalAmount).toBe(created.body.totalAmount);
  });

  test('converts mixed currencies and scopes every query to the tenant', async () => {
    records = [
      { tenantId: 1, status: 'Draft', currency: 'USD', totalAmount: 100 },
      { tenantId: 1, status: 'Sent', currency: 'INR', totalAmount: 8300 },
      { tenantId: 2, status: 'Draft', currency: 'USD', totalAmount: 9999 },
    ];
    const response = await request(app).get('/api/quotes/stats');
    expect(response.body).toMatchObject({ total: 2, currency: 'USD', totalValue: 200, missingRateCount: 0 });
    expect(prisma.quote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 1 } }));
    expect(prisma.currency.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 1 } }));
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 } }));
  });

  test('uses the tenant reporting currency rather than assuming USD', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR' });
    records = [{ tenantId: 1, status: 'Draft', currency: 'USD', totalAmount: 100 }];
    const response = await request(app).get('/api/quotes/stats');
    expect(response.body).toMatchObject({ currency: 'INR', totalValue: 8300 });
  });

  test.each([{ rates: [] }, { rates: [{ code: 'USD', exchangeRate: 1 }, { code: 'INR', exchangeRate: 0 }] }])(
    'does not publish an incomplete total when conversion rates are unavailable: %j', async ({ rates }) => {
      prisma.currency.findMany.mockResolvedValue(rates);
      records = [{ tenantId: 1, status: 'Draft', currency: 'INR', totalAmount: 8300 }];
      const response = await request(app).get('/api/quotes/stats');
      expect(response.body).toMatchObject({ totalValue: null, missingRateCount: 1, currency: 'USD' });
    });

  test('same-currency and empty totals do not require exchange rates', async () => {
    prisma.currency.findMany.mockResolvedValue([]);
    expect((await request(app).get('/api/quotes/stats')).body.totalValue).toBe(0);
    records = [{ tenantId: 1, status: 'Draft', currency: 'USD', totalAmount: 125 }];
    expect((await request(app).get('/api/quotes/stats')).body.totalValue).toBe(125);
  });

  test.each([['csv', 25], ['csv', -25], ['xlsx', 25], ['xlsx', -25]])(
    '%s export/import preserves adjustment %s and the quote total', async (format, adjustment) => {
      const created = await request(app).post('/api/quotes').send(payload({ adjustment, lineItems: [
        { productName: 'Implementation', quantity: 2, unitPrice: 100, discountPercent: 10, gstRate: 18 },
        { productName: 'Training', quantity: 1, unitPrice: 50, gstRate: 5 },
      ] }));
      expect(created.status).toBe(201);
      let exported = request(app).get(`/api/quotes/export.${format}`);
      if (format === 'xlsx') exported = exported.buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
      const downloaded = await exported;
      expect(downloaded.status).toBe(200);
      records = []; // Import into a clean destination, without quote-number conflicts.
      const imported = await request(app).post(`/api/quotes/import.${format}`)
        .attach('file', format === 'csv' ? Buffer.from(downloaded.text) : downloaded.body, `quotes.${format}`);
      expect(imported.status).toBe(200);
      expect(imported.body).toMatchObject({ imported: 1, errors: [] });
      expect(records[0].adjustment).toBe(adjustment);
      expect(records[0].totalAmount).toBe(created.body.totalAmount);
    });
});
