// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 9 — commission-ledger endpoint contract.
 *
 * Pins GET /api/travel/commission-profiles/:id/ledger which derives a
 * per-Deal commission row for every Deal whose linked Contact carries
 * this profile's id in commissionProfileId (the slice-6 bulk-assign target
 * column). Each row is calculated with the same lib/agentCommissionCalculator.js
 * the slice-7 preview route uses, so a number an operator sees in "preview"
 * matches what shows up here once the deal exists. Read-only; no mutation.
 *
 * Why "derived" and not "stored": the dedicated SubAgentCommission table
 * (PRD §3 FR-3.2.2) is Phase 1-3 work — multi-day, gated on DD-5.3 + the
 * b2bCommissionEngine cron. Until those land, the ledger is a pure read
 * over Deal × Contact joined on commissionProfileId. Frontend can be built
 * against this contract today; the storage swap (Phase 1) keeps the response
 * shape.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/commission-profiles/:id/ledger
 *       happy path: 3 deals across 2 contacts → 3 entries + totalCommission sum
 *       empty ledger (no deals carry this profile) → 200 with entries=[]
 *       tenant-scoped: deal/contact where clauses include tenantId
 *       soft-deleted deals (deletedAt != null) are excluded by route's where
 *       ?stage=won filter narrows the where
 *       ?limit/?offset pagination capped at 200
 *       cross-tenant profile id → 404 PROFILE_NOT_FOUND
 *       MANAGER restricted to ["rfu"] reading a "tmc"-scoped profile → 403 SUB_BRAND_DENIED
 *       malformed stored profileJson → 200 commission=0 per row with diagnostic
 *       invalid :id segment (non-numeric) → 400 INVALID_ID
 *
 * Test pattern mirrors travel-commission-profiles-preview.test.js — patch
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, drive
 * supertest with HS256 JWTs. verifyToken + sub-brand gates stay in the
 * chain. No RBAC narrowing (read-only endpoint).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCommissionProfile = prisma.travelCommissionProfile || {};
prisma.travelCommissionProfile.findFirst = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.deal.count = vi.fn();
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
const profilesRouter = requireCJS('../../routes/travel_commission_profiles');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', profilesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Canonical profile rows (mirror preview-test shapes).
const FLAT_5PCT_PROFILE = {
  id: 42,
  tenantId: 1,
  name: 'Standard 5%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: null,
  isActive: true,
};

const TMC_PROFILE = {
  id: 45,
  tenantId: 1,
  name: 'TMC schools 8%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 8 }),
  subBrand: 'tmc',
  isActive: true,
};

const MALFORMED_PROFILE = {
  id: 46,
  tenantId: 1,
  name: 'Hand-edited garbage',
  profileType: 'flat_percent',
  profileJson: '{not-valid-json',
  subBrand: null,
  isActive: true,
};

// Sample Deal rows (post-Prisma-include shape — `contact` is an object).
const SAMPLE_DEALS = [
  {
    id: 101,
    title: 'Goa 5-day deal',
    stage: 'won',
    amount: 100000,
    currency: 'INR',
    createdAt: new Date('2026-05-01T10:00:00Z'),
    contact: { id: 11, name: 'Vinay Reseller' },
  },
  {
    id: 102,
    title: 'Bali honeymoon',
    stage: 'won',
    amount: 200000,
    currency: 'INR',
    createdAt: new Date('2026-05-02T10:00:00Z'),
    contact: { id: 11, name: 'Vinay Reseller' },
  },
  {
    id: 103,
    title: 'Dubai weekend',
    stage: 'proposal',
    amount: 50000,
    currency: 'INR',
    createdAt: new Date('2026-05-03T10:00:00Z'),
    contact: { id: 12, name: 'Priya Reseller' },
  },
];

beforeEach(() => {
  prisma.travelCommissionProfile.findFirst.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.deal.count.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/commission-profiles/:id/ledger', () => {
  test('happy path: 3 deals → 3 entries + totalCommission sums (5% of 100000+200000+50000 = 17500)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(FLAT_5PCT_PROFILE);
    prisma.deal.findMany.mockResolvedValue(SAMPLE_DEALS);
    prisma.deal.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/42/ledger')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 42,
      profileName: 'Standard 5%',
      profileType: 'flat_percent',
      totalEntries: 3,
      totalCommission: 17500, // 5% of (100000 + 200000 + 50000)
      limit: 50,
      offset: 0,
    });
    expect(res.body.entries).toHaveLength(3);
    // Each entry must surface dealId / contactName / commission / breakdown.
    expect(res.body.entries[0]).toMatchObject({
      dealId: 101,
      dealTitle: 'Goa 5-day deal',
      dealStage: 'won',
      dealAmount: 100000,
      dealCurrency: 'INR',
      contactId: 11,
      contactName: 'Vinay Reseller',
      commission: 5000,
    });
    expect(res.body.entries[0].breakdown).toMatch(/5/);
    // Deal where clause must scope contact.commissionProfileId AND tenantId
    // (defence in depth on both Deal.tenantId and Contact.tenantId).
    expect(prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          deletedAt: null,
          contact: expect.objectContaining({
            commissionProfileId: 42,
            tenantId: 1,
          }),
        }),
      }),
    );
  });

  test('empty ledger (profile assigned but no deals yet) returns 200 with entries=[] + totalCommission=0', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(FLAT_5PCT_PROFILE);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.deal.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/42/ledger')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 42,
      totalEntries: 0,
      totalCommission: 0,
    });
    expect(res.body.entries).toEqual([]);
  });

  test('?stage=won filter narrows the deal where clause', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(FLAT_5PCT_PROFILE);
    prisma.deal.findMany.mockResolvedValue([SAMPLE_DEALS[0], SAMPLE_DEALS[1]]);
    prisma.deal.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/42/ledger?stage=won')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalEntries).toBe(2);
    // Won-only commission: 5% of (100000 + 200000) = 15000.
    expect(res.body.totalCommission).toBe(15000);
    expect(prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stage: 'won' }),
      }),
    );
  });

  test('?limit and ?offset are honored and capped at 200', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(FLAT_5PCT_PROFILE);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.deal.count.mockResolvedValue(0);

    // Request 9999 — should be capped to 200.
    await request(makeApp())
      .get('/api/travel/commission-profiles/42/ledger?limit=9999&offset=20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, skip: 20 }),
    );
  });

  test('cross-tenant profile id returns 404 PROFILE_NOT_FOUND (no deal query fires)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/9999/ledger')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["rfu"] reading a "tmc"-scoped profile gets 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(TMC_PROFILE);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/45/ledger')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('malformed stored profileJson → 200 + every row commission=0 + diagnostic breakdown', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(MALFORMED_PROFILE);
    prisma.deal.findMany.mockResolvedValue([SAMPLE_DEALS[0]]);
    prisma.deal.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/46/ledger')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({
      dealId: 101,
      commission: 0,
    });
    expect(res.body.entries[0].breakdown).toMatch(/malformed profileJson/);
    expect(res.body.totalCommission).toBe(0);
  });

  test('invalid :id segment (non-numeric) returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/not-an-int/ledger')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });
});
