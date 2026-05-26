// @ts-check
/**
 * Unit tests for backend/routes/currencies.js — pins the contract for
 * currency CRUD, base-currency atomic switching, conversion math, and
 * the open-deal pivot aggregation.
 *
 * Route surface pinned
 * ────────────────────
 *   - GET    /api/currencies                 list (or DEFAULTS fallback) for the tenant
 *   - POST   /api/currencies          ADMIN  create (409 on duplicate code per tenant)
 *   - POST   /api/currencies/seed     ADMIN  initialize DEFAULTS (400 if any exist)
 *   - PUT    /api/currencies/:id      ADMIN  update; isBase=true demotes prior base
 *   - DELETE /api/currencies/:id      ADMIN  204 (400 when isBase=true)
 *   - POST   /api/currencies/:id/set-base  ADMIN  atomic base-currency switch; rate→1.0
 *   - POST   /api/currencies/convert        amount/from/to math (open to any role)
 *   - GET    /api/currencies/pivot/deals    open-deal totals converted to base
 *
 * What this file pins
 * ───────────────────
 *   1. Empty-tenant GET falls back to the 6-currency DEFAULTS list (USD base).
 *      Pseudo-ids are NEGATIVE (-1..-6) so callers can distinguish synthesised
 *      vs persisted rows. Regression pin for the "first-login dashboard shows
 *      no currencies until admin seeds" UX gap that DEFAULTS was added to fix.
 *   2. POST happy path uppercases the code, defaults exchangeRate=1.0 when
 *      omitted, and writes tenantId from req.user (NOT body).
 *   3. POST with isBase=true atomically demotes any prior isBase=true rows
 *      for the same tenant before inserting the new base row. Runs inside
 *      prisma.$transaction so a mid-flight crash never leaves "two bases."
 *   4. POST returns 409 with a clean message on Prisma P2002 (the
 *      @@unique([code, tenantId]) constraint firing).
 *   5. POST /seed refuses with 400 when ANY currency exists for the tenant.
 *   6. PUT /:id with isBase=true demotes other bases EXCEPT itself (the
 *      NOT: { id } guard); isBase=false flips without demoting.
 *   7. DELETE refuses to remove the base currency (400) — base must be
 *      switched first via /:id/set-base.
 *   8. DELETE returns 204 (not 200) on success — pinned per #550 sweep.
 *   9. POST /:id/set-base atomically demotes all priors and forces the
 *      new base's exchangeRate to 1.0.
 *  10. POST /convert math: rate = toRate / fromRate. Identity (from===to)
 *      yields rate=1.0 and converted=amount unchanged. Round to 4 decimals.
 *  11. POST /convert returns 404 when either currency code is missing.
 *  12. GET /pivot/deals aggregates open deals (NOT in won/lost) by currency
 *      code AND converts every amount into the base currency. usingDefaults
 *      flag flips true when the tenant has no Currency rows yet.
 *  13. ADMIN gate: non-ADMIN tokens get 403 RBAC_DENIED on every mutating
 *      endpoint. verifyToken: missing auth header gets 401.
 *  14. Tenant isolation: every read+write scopes by req.user.tenantId.
 *
 * Test pattern
 * ────────────
 *   Prisma singleton-monkey-patch BEFORE requiring the router. Same shape
 *   as backend/test/routes/communications.test.js + brand_kits.test.js.
 *   prisma.$transaction is stubbed to invoke its callback with the prisma
 *   singleton itself, so tx.* calls land on the same vi.fn() mocks the
 *   route would otherwise hit.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — must happen BEFORE the router is required,
// since routes/currencies.js's top-level `require('../lib/prisma')`
// resolves at import time.
prisma.currency = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
// verifyToken does a revokedToken lookup; stub it cleanly so JWTs don't
// hit a real DB.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// $transaction stub — when called with a callback, invoke it with the
// prisma singleton itself so tx.* calls hit the same mocks. When called
// with an array of promises, Promise.all them.
prisma.$transaction = vi.fn().mockImplementation(async (arg) => {
  if (typeof arg === 'function') return arg(prisma);
  if (Array.isArray(arg)) return Promise.all(arg);
  return arg;
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const currenciesRouter = requireCJS('../../routes/currencies');

// In production, server.js mounts a global auth guard that decodes the JWT
// and sets req.user BEFORE per-route middleware runs. The currencies route
// relies on req.user.tenantId in handlers that DON'T pass through
// verifyToken (GET /, POST /convert, GET /pivot/deals are open by design
// per the #527 comment in the source). Mirror that production wiring with
// a tiny header-decoder middleware so those handlers see req.user.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
      } catch {
        // Fall through — admin-gated routes will re-run verifyToken and
        // produce the correct 401; open routes will hit the 500 path,
        // which is precisely what production does today on a bad token
        // outside the gated set (the global guard rejects first).
      }
    }
    next();
  });
  app.use('/api/currencies', currenciesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.currency.findMany.mockReset();
  prisma.currency.findFirst.mockReset();
  prisma.currency.count.mockReset();
  prisma.currency.create.mockReset();
  prisma.currency.update.mockReset();
  prisma.currency.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.currency.delete.mockReset();
  prisma.deal.findMany.mockReset().mockResolvedValue([]);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.$transaction.mockClear();
});

// ─── GET /api/currencies — list + DEFAULTS fallback ──────────────────

describe('GET /api/currencies', () => {
  test('returns persisted rows for the tenant when present', async () => {
    prisma.currency.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, code: 'USD', symbol: '$', name: 'US Dollar', exchangeRate: 1.0, isBase: true },
      { id: 2, tenantId: 1, code: 'EUR', symbol: '€', name: 'Euro', exchangeRate: 0.92, isBase: false },
    ]);

    const res = await request(makeApp())
      .get('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body[0].code).toBe('USD');
    expect(res.body[0].isBase).toBe(true);
    // Scoped by req.user.tenantId, ordered base-first then code asc.
    const args = prisma.currency.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 1 });
    expect(args.orderBy).toEqual([{ isBase: 'desc' }, { code: 'asc' }]);
  });

  test('falls back to DEFAULTS (USD base + 5 others) when the tenant has zero rows', async () => {
    prisma.currency.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    // Pseudo-ids must be NEGATIVE so callers can tell synth from persisted.
    for (const row of res.body) {
      expect(row.id).toBeLessThan(0);
      expect(row.tenantId).toBe(1);
    }
    const codes = res.body.map((r) => r.code);
    expect(codes).toEqual(['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD']);
    const usd = res.body.find((r) => r.code === 'USD');
    expect(usd.isBase).toBe(true);
    expect(usd.exchangeRate).toBe(1.0);
  });
});

// ─── POST /api/currencies — create + base demotion + 409 dedup ───────

describe('POST /api/currencies', () => {
  test('happy path: uppercases code, defaults exchangeRate=1.0, scopes tenant from req.user', async () => {
    prisma.currency.create.mockImplementation(async ({ data }) => ({
      id: 99,
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ code: 'jpy', symbol: '¥', name: 'Japanese Yen' });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe('JPY'); // uppercased
    expect(res.body.exchangeRate).toBe(1.0); // defaulted
    expect(res.body.isBase).toBe(false);
    expect(res.body.tenantId).toBe(1); // from req.user, NOT body
    expect(prisma.$transaction).toHaveBeenCalled();
    // No demotion fired since isBase was falsy.
    expect(prisma.currency.updateMany).not.toHaveBeenCalled();
  });

  test('isBase=true atomically demotes prior base rows for the same tenant', async () => {
    prisma.currency.create.mockImplementation(async ({ data }) => ({
      id: 100,
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ code: 'EUR', symbol: '€', name: 'Euro', exchangeRate: 1.0, isBase: true });

    expect(res.status).toBe(201);
    expect(res.body.isBase).toBe(true);
    expect(prisma.currency.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, isBase: true },
      data: { isBase: false },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  test('validation: missing code/symbol/name returns 400', async () => {
    const res = await request(makeApp())
      .post('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ symbol: '€', name: 'Euro' }); // no code

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code, symbol, and name/i);
    expect(prisma.currency.create).not.toHaveBeenCalled();
  });

  test('duplicate code (Prisma P2002) returns 409 with a clear message', async () => {
    const err = new Error('Unique constraint failed');
    /** @type {any} */ (err).code = 'P2002';
    prisma.currency.create.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ code: 'USD', symbol: '$', name: 'US Dollar' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('403 RBAC_DENIED when the caller is not ADMIN', async () => {
    const res = await request(makeApp())
      .post('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ code: 'USD', symbol: '$', name: 'US Dollar' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.currency.create).not.toHaveBeenCalled();
  });

  test('401 when the Authorization header is missing', async () => {
    const res = await request(makeApp())
      .post('/api/currencies')
      .send({ code: 'USD', symbol: '$', name: 'US Dollar' });

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer$/i);
  });
});

// ─── POST /api/currencies/seed — DEFAULTS initialization ─────────────

describe('POST /api/currencies/seed', () => {
  test('seeds the DEFAULTS list when the tenant has zero currencies', async () => {
    prisma.currency.count.mockResolvedValue(0);
    prisma.currency.create.mockImplementation(async ({ data }) => ({ id: Math.floor(Math.random() * 10000), ...data }));

    const res = await request(makeApp())
      .post('/api/currencies/seed')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(6);
    expect(prisma.currency.create).toHaveBeenCalledTimes(6);
    // tenantId must be req.user.tenantId on every row.
    for (const call of prisma.currency.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(1);
    }
  });

  test('400 when any currency already exists for the tenant', async () => {
    prisma.currency.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .post('/api/currencies/seed')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already initialized/i);
    expect(prisma.currency.create).not.toHaveBeenCalled();
  });
});

// ─── PUT /api/currencies/:id — update + base demotion ────────────────

describe('PUT /api/currencies/:id', () => {
  test('happy path updates code (uppercased), symbol, name, rate', async () => {
    prisma.currency.findFirst.mockResolvedValue({ id: 5, tenantId: 1, code: 'EUR', isBase: false, exchangeRate: 0.92 });
    prisma.currency.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));

    const res = await request(makeApp())
      .put('/api/currencies/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ code: 'eur', symbol: '€', name: 'Euro Updated', exchangeRate: '0.95' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('EUR'); // uppercased
    expect(res.body.exchangeRate).toBe(0.95); // parseFloat'd
    expect(res.body.name).toBe('Euro Updated');
    // findFirst scoped by tenant
    const findArgs = prisma.currency.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 5, tenantId: 1 });
  });

  test('isBase=true demotes OTHER bases (NOT itself) atomically', async () => {
    prisma.currency.findFirst.mockResolvedValue({ id: 7, tenantId: 1, code: 'INR', isBase: false });
    prisma.currency.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data, code: 'INR' }));

    const res = await request(makeApp())
      .put('/api/currencies/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ isBase: true });

    expect(res.status).toBe(200);
    expect(res.body.isBase).toBe(true);
    // Demote MUST scope by tenant AND exclude the current id.
    expect(prisma.currency.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, isBase: true, NOT: { id: 7 } },
      data: { isBase: false },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  test('404 when the id is not found within the caller tenant', async () => {
    prisma.currency.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/currencies/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.currency.update).not.toHaveBeenCalled();
  });

  test('400 on non-numeric :id', async () => {
    const res = await request(makeApp())
      .put('/api/currencies/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'New' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  test('403 RBAC_DENIED when the caller is not ADMIN', async () => {
    const res = await request(makeApp())
      .put('/api/currencies/5')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ name: 'Manager-edit' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});

// ─── DELETE /api/currencies/:id — 204 + base-currency lock ───────────

describe('DELETE /api/currencies/:id', () => {
  test('204 No Content on successful delete (non-base row)', async () => {
    prisma.currency.findFirst.mockResolvedValue({ id: 5, tenantId: 1, code: 'EUR', isBase: false });
    prisma.currency.delete.mockResolvedValue({ id: 5 });

    const res = await request(makeApp())
      .delete('/api/currencies/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    // #550 sweep: DELETE → 204 No Content with empty body.
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.currency.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  test('refuses to delete the base currency (400)', async () => {
    prisma.currency.findFirst.mockResolvedValue({ id: 1, tenantId: 1, code: 'USD', isBase: true });

    const res = await request(makeApp())
      .delete('/api/currencies/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base currency/i);
    expect(prisma.currency.delete).not.toHaveBeenCalled();
  });

  test('404 when the id is not in the caller tenant', async () => {
    prisma.currency.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/currencies/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
  });

  test('403 RBAC_DENIED when the caller is not ADMIN', async () => {
    const res = await request(makeApp())
      .delete('/api/currencies/5')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});

// ─── POST /api/currencies/:id/set-base — atomic switch ───────────────

describe('POST /api/currencies/:id/set-base', () => {
  test('atomically demotes all priors, sets new base, forces exchangeRate=1.0', async () => {
    prisma.currency.findFirst.mockResolvedValue({ id: 7, tenantId: 1, code: 'INR', isBase: false, exchangeRate: 83.0 });
    prisma.currency.update.mockImplementation(async ({ where, data }) => ({ id: where.id, code: 'INR', tenantId: 1, ...data }));

    const res = await request(makeApp())
      .post('/api/currencies/7/set-base')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.isBase).toBe(true);
    // The new base's exchangeRate is forced to 1.0 — this is load-bearing,
    // every other rate is expressed relative to base, so a base != 1.0
    // breaks the conversion math.
    expect(res.body.exchangeRate).toBe(1.0);
    expect(prisma.currency.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, isBase: true },
      data: { isBase: false },
    });
    expect(prisma.currency.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { isBase: true, exchangeRate: 1.0 },
    });
  });

  test('404 when the id is not in the caller tenant', async () => {
    prisma.currency.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/currencies/999/set-base')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
  });

  test('403 RBAC_DENIED when the caller is not ADMIN', async () => {
    const res = await request(makeApp())
      .post('/api/currencies/5/set-base')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});

// ─── POST /api/currencies/convert — math contract ────────────────────

describe('POST /api/currencies/convert', () => {
  test('converts using rate = toRate / fromRate, rounds to 4 decimals', async () => {
    prisma.currency.findMany.mockResolvedValue([
      { id: 1, code: 'USD', symbol: '$', name: 'US Dollar', exchangeRate: 1.0, isBase: true },
      { id: 2, code: 'INR', symbol: '₹', name: 'Indian Rupee', exchangeRate: 83.0, isBase: false },
    ]);

    const res = await request(makeApp())
      .post('/api/currencies/convert')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 10, from: 'usd', to: 'inr' });

    expect(res.status).toBe(200);
    expect(res.body.from).toBe('USD'); // uppercased
    expect(res.body.to).toBe('INR');
    expect(res.body.rate).toBe(83); // 83 / 1
    expect(res.body.converted).toBe(830); // 10 * 83
  });

  test('identity convert (from === to) returns rate=1.0 and amount unchanged', async () => {
    prisma.currency.findMany.mockResolvedValue([
      { id: 1, code: 'USD', symbol: '$', name: 'US Dollar', exchangeRate: 1.0, isBase: true },
    ]);

    const res = await request(makeApp())
      .post('/api/currencies/convert')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 42.5, from: 'USD', to: 'USD' });

    expect(res.status).toBe(200);
    expect(res.body.rate).toBe(1);
    expect(res.body.converted).toBe(42.5);
  });

  test('uses DEFAULTS when tenant has no Currency rows (USD → EUR @ 0.92)', async () => {
    prisma.currency.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/currencies/convert')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 100, from: 'USD', to: 'EUR' });

    expect(res.status).toBe(200);
    expect(res.body.rate).toBe(0.92);
    expect(res.body.converted).toBe(92);
  });

  test('400 when amount/from/to are missing', async () => {
    const res = await request(makeApp())
      .post('/api/currencies/convert')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount, from, and to/i);
  });

  test('404 when either currency code is missing from the tenant + DEFAULTS', async () => {
    prisma.currency.findMany.mockResolvedValue([
      { id: 1, code: 'USD', symbol: '$', name: 'US Dollar', exchangeRate: 1.0, isBase: true },
    ]);

    const res = await request(makeApp())
      .post('/api/currencies/convert')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 10, from: 'USD', to: 'ZZZ' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─── GET /api/currencies/pivot/deals — open-deal aggregation ─────────

describe('GET /api/currencies/pivot/deals', () => {
  test('aggregates open deals by currency and converts totals into base', async () => {
    prisma.currency.findMany.mockResolvedValue([
      { id: 1, code: 'USD', symbol: '$', name: 'US Dollar', exchangeRate: 1.0, isBase: true },
      { id: 2, code: 'INR', symbol: '₹', name: 'Indian Rupee', exchangeRate: 83.0, isBase: false },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { amount: 100, currency: 'USD' },
      { amount: 50,  currency: 'USD' },
      { amount: 8300, currency: 'INR' }, // 8300 / 83 = 100 USD
    ]);

    const res = await request(makeApp())
      .get('/api/currencies/pivot/deals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.baseCode).toBe('USD');
    expect(res.body.baseSymbol).toBe('$');
    expect(res.body.dealCount).toBe(3);
    expect(res.body.usingDefaults).toBe(false);
    expect(res.body.byCurrency).toEqual({
      USD: { amount: 150, count: 2 },
      INR: { amount: 8300, count: 1 },
    });
    // Total in base = 100 + 50 + (8300/83) = 250 USD.
    expect(res.body.totalInBase).toBe(250);

    // The deal-findMany scope MUST exclude won/lost stages AND scope by tenant.
    const dealArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(dealArgs.where.tenantId).toBe(1);
    expect(dealArgs.where.stage).toEqual({ notIn: ['won', 'lost'] });
  });

  test('flags usingDefaults=true when no Currency rows exist for tenant', async () => {
    prisma.currency.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/currencies/pivot/deals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.usingDefaults).toBe(true);
    expect(res.body.baseCode).toBe('USD'); // DEFAULTS' base
    expect(res.body.dealCount).toBe(0);
    expect(res.body.totalInBase).toBe(0);
    expect(res.body.byCurrency).toEqual({});
  });

  test('deals with no currency field bucket under the base code', async () => {
    prisma.currency.findMany.mockResolvedValue([
      { id: 1, code: 'USD', symbol: '$', name: 'US Dollar', exchangeRate: 1.0, isBase: true },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { amount: 200, currency: null },
      { amount: 300, currency: undefined },
    ]);

    const res = await request(makeApp())
      .get('/api/currencies/pivot/deals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.byCurrency).toEqual({
      USD: { amount: 500, count: 2 },
    });
    expect(res.body.totalInBase).toBe(500);
  });
});

// ─── Tenant isolation — cross-tenant tokens never reach another tenant ─

describe('tenant isolation', () => {
  test('GET scopes findMany by req.user.tenantId (not body, not query)', async () => {
    prisma.currency.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('USER', { tenantId: 42 })}`);

    const args = prisma.currency.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 42 });
  });

  test('POST persists tenantId from req.user even when body smuggles a different tenantId', async () => {
    prisma.currency.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    // Note: the global stripDangerous middleware in production would also
    // delete req.body.tenantId before this route handler runs. Here we
    // mount the router in isolation (no stripDangerous), and the route's
    // OWN code path still pins tenantId to req.user.tenantId by ignoring
    // body.tenantId entirely. That's what this test pins.
    await request(makeApp())
      .post('/api/currencies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 7 })}`)
      .send({ code: 'EUR', symbol: '€', name: 'Euro', tenantId: 999 });

    const createArgs = prisma.currency.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(7); // req.user.tenantId, NOT body.tenantId
  });
});
