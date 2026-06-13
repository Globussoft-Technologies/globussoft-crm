// @ts-check
/**
 * PRD_TRAVEL_QUOTE_BUILDER G018 (DD-5.4) — /api/fx tests.
 *
 * Pins the contract for backend/routes/travel_fx.js:
 *   GET  /api/fx/latest?base=INR&quote=USD   → 200 { rate, fetchedAt }
 *   GET  /api/fx/latest                       → 400 MISSING_FIELDS
 *   GET  /api/fx/latest?base=foo&quote=bar    → 400 INVALID_CURRENCY_CODE
 *   GET  /api/fx/latest?base=INR&quote=XYZ    → 404 NO_RATE
 *   GET  /api/fx/history?base=INR&quote=USD   → 200 { rows: [...] }
 *   GET  /api/fx/history?... &from=garbage    → 400 INVALID_DATE
 *
 * Test pattern mirrors adsgpt.test.js — patch prisma.fxRate prior to
 * router require, JWT-auth real-mode (no middleware bypass).
 */

import { describe, test, expect, beforeAll, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

prisma.fxRate = prisma.fxRate || {};
prisma.fxRate.findFirst = vi.fn();
prisma.fxRate.findMany = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ id: 7, role: 'ADMIN', tenantId: 1, isActive: true });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const fxRouter = requireCJS('../../routes/travel_fx');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/fx', fxRouter);
  return app;
}

function token() {
  return jwt.sign(
    { userId: 7, tenantId: 1, role: 'ADMIN', email: 'admin@test.local' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
}

describe('GET /api/fx/latest', () => {
  beforeAll(() => {
    prisma.fxRate.findFirst.mockReset();
  });

  test('200 with rate envelope on hit', async () => {
    prisma.fxRate.findFirst.mockResolvedValue({
      id: 1, baseCurrency: 'INR', quoteCurrency: 'USD', rate: 0.012, fetchedAt: new Date('2026-06-13T10:00:00Z'), source: 'frankfurter',
    });
    const res = await request(makeApp())
      .get('/api/fx/latest?base=INR&quote=USD')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      base: 'INR', quote: 'USD', rate: 0.012, source: 'frankfurter',
    });
  });

  test('400 MISSING_FIELDS when base or quote missing', async () => {
    const res = await request(makeApp())
      .get('/api/fx/latest')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('400 INVALID_CURRENCY_CODE when base is non-3-letter', async () => {
    const res = await request(makeApp())
      .get('/api/fx/latest?base=IN&quote=USD')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENCY_CODE');
  });

  test('404 NO_RATE when no row exists for the pair', async () => {
    prisma.fxRate.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/fx/latest?base=INR&quote=XYZ')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_RATE');
  });

  test('uppercases lowercase currency codes', async () => {
    prisma.fxRate.findFirst.mockResolvedValue({
      id: 1, baseCurrency: 'INR', quoteCurrency: 'USD', rate: 0.012, fetchedAt: new Date(), source: 'frankfurter',
    });
    const res = await request(makeApp())
      .get('/api/fx/latest?base=inr&quote=usd')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const call = prisma.fxRate.findFirst.mock.calls.at(-1)[0];
    expect(call.where.baseCurrency).toBe('INR');
    expect(call.where.quoteCurrency).toBe('USD');
  });

  test('401 when JWT missing', async () => {
    const res = await request(makeApp()).get('/api/fx/latest?base=INR&quote=USD');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/fx/history', () => {
  beforeAll(() => {
    prisma.fxRate.findMany.mockReset();
  });

  test('200 with rows array', async () => {
    prisma.fxRate.findMany.mockResolvedValue([
      { id: 1, rate: 0.012, fetchedAt: new Date('2026-06-01'), source: 'frankfurter' },
      { id: 2, rate: 0.0121, fetchedAt: new Date('2026-06-02'), source: 'frankfurter' },
    ]);
    const res = await request(makeApp())
      .get('/api/fx/history?base=INR&quote=USD')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(2);
    expect(res.body.rows[0]).toHaveProperty('rate');
    expect(res.body.rows[0]).toHaveProperty('fetchedAt');
  });

  test('honours from/to bounds when supplied', async () => {
    prisma.fxRate.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/fx/history?base=INR&quote=USD&from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${token()}`);
    const call = prisma.fxRate.findMany.mock.calls.at(-1)[0];
    expect(call.where.fetchedAt.gte).toBeDefined();
    expect(call.where.fetchedAt.lte).toBeDefined();
  });

  test('400 INVALID_DATE on unparseable from', async () => {
    const res = await request(makeApp())
      .get('/api/fx/history?base=INR&quote=USD&from=garbage')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('400 MISSING_FIELDS when base/quote missing', async () => {
    const res = await request(makeApp())
      .get('/api/fx/history')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });
});
