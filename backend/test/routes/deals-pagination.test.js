// @ts-check
/**
 * Unit tests for the GET /api/deals paginated envelope
 * (?limit=&offset=&page= → { data, total, page, limit, offset, totalPages }).
 *
 * Mirrors backend/test/routes/contacts.test.js (CJS require-cache injection:
 * auth pass-through, fieldFilter pass-through, prisma model vi.fn()s).
 * Pure pin — no source changes.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// lib/audit: writeAudit stub (loaded at require-time by deals.js).
const auditPath = requireCJS.resolve('../../lib/audit.js');
Module._cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { writeAudit: vi.fn().mockResolvedValue(undefined), diffFields: vi.fn().mockReturnValue({}) },
};

// fieldFilter: pass-through.
const fieldFilterPath = requireCJS.resolve('../../middleware/fieldFilter.js');
Module._cache[fieldFilterPath] = {
  id: fieldFilterPath,
  filename: fieldFilterPath,
  loaded: true,
  exports: {
    filterReadFields: async (rows) => rows,
    filterWriteFields: async (body) => body,
  },
};

// travelGuards: no sub-brand restriction (generic tenant) → null.
const travelGuardsPath = requireCJS.resolve('../../middleware/travelGuards.js');
Module._cache[travelGuardsPath] = {
  id: travelGuardsPath,
  filename: travelGuardsPath,
  loaded: true,
  exports: { getSubBrandAccessSet: async () => null },
};

// Auth pass-through (JWT key is `userId` per CLAUDE.md standing rule).
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (req, _res, next) => next();
authMw.verifyRole = (_roles) => (_req, _res, next) => next();

// Prisma model doubles touched by GET / list.
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.deal.count = vi.fn();

import express from 'express';
import request from 'supertest';
const dealsRouter = requireCJS('../../routes/deals');

const TENANT_ID = 1;
const USER_ID = 7;

const SAMPLE_DEAL = {
  id: 501,
  title: 'Acme Renewal',
  amount: 50000,
  stage: 'lead',
  tenantId: TENANT_ID,
  ownerId: USER_ID,
  contact: null,
};

function makeApp({ tenantId = TENANT_ID, userId = USER_ID, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/deals', dealsRouter);
  return app;
}

beforeEach(() => {
  prisma.deal.findMany.mockReset().mockResolvedValue([SAMPLE_DEAL]);
  prisma.deal.count.mockReset().mockResolvedValue(1);
});

describe('GET /api/deals — page/limit/offset pagination', () => {
  test('?page=2&limit=10 returns envelope with derived offset=10', async () => {
    prisma.deal.count.mockResolvedValueOnce(25);
    const res = await request(makeApp()).get('/api/deals?page=2&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(25);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(10);
    expect(res.body.totalPages).toBe(3);
    const args = prisma.deal.findMany.mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(10);
    expect(args.where.tenantId).toBe(TENANT_ID);
  });

  test('explicit ?offset= wins over ?page=', async () => {
    prisma.deal.count.mockResolvedValueOnce(7);
    const res = await request(makeApp()).get('/api/deals?page=3&limit=5&offset=2');

    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(2);
    expect(res.body.page).toBe(1); // floor(2/5)+1
    expect(prisma.deal.findMany.mock.calls[0][0].skip).toBe(2);
  });

  test('no ?page= keeps the legacy plain-array shape (count not called)', async () => {
    const res = await request(makeApp()).get('/api/deals?limit=10&offset=10');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(prisma.deal.count).not.toHaveBeenCalled();
    const args = prisma.deal.findMany.mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(10);
  });
});
