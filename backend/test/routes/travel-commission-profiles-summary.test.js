// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 14 — per-contact commission summary contract.
 *
 * Pins GET /api/travel/commission-profiles/:id/summary/by-contact which
 * aggregates the same Deal × Contact join the slice 9 ledger emits, one row
 * per Contact holding the profile in commissionProfileId. Each row reports
 * dealCount + totalSale + totalCommission. This is the shape the eventual
 * monthly-statement cron (FR-3.2.4, b2bCommissionEngine — Phase 1-3 of
 * PRD §10) will iterate over — every per-Contact row maps 1:1 to a sub-agent's
 * monthly statement line item. Read-only; reuses lib/agentCommissionCalculator.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/commission-profiles/:id/summary/by-contact
 *       happy path: 5 deals across 2 contacts → 2 rows, dealCount + totalSale
 *         + totalCommission summed per-contact, grandTotalCommission = sum
 *       sort order: default totalCommission:desc; ?orderBy=dealCount:desc honored;
 *         unknown orderBy token falls back to default (graceful)
 *       sort order: ?orderBy=contactName:asc + ?orderBy=totalSale:desc both honored
 *       empty result (no deals carry this profile) → 200 with contacts=[]
 *       tenant-scoped: Deal + Contact where clauses include tenantId
 *       soft-deleted deals (deletedAt != null) are excluded by route's where
 *       ?stage=won filter narrows the where
 *       ?limit/?offset applied AFTER aggregation (slice the contacts array)
 *       cross-tenant profile id → 404 PROFILE_NOT_FOUND
 *       MANAGER restricted to ["rfu"] reading a "tmc"-scoped profile → 403 SUB_BRAND_DENIED
 *       malformed stored profileJson → 200 with per-row totalCommission=0,
 *         dealCount + totalSale still accurate
 *       invalid :id segment (non-numeric) → 400 INVALID_ID
 *       half-up rounding: per-row totalSale + totalCommission rounded to 2dp;
 *         grandTotalCommission also rounded
 *
 * Test pattern mirrors travel-commission-profiles-ledger.test.js — patch
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, drive
 * supertest with HS256 JWTs. No RBAC narrowing (read-only endpoint).
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

// Canonical "Standard 5%" flat-percent profile under TMC sub-brand. Sale of
// X yields commission of X*0.05.
const flatProfile = {
  id: 21,
  tenantId: 1,
  name: 'Standard 5%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: 'tmc',
  isActive: true,
  notes: null,
  createdAt: new Date('2026-04-15T10:00:00Z'),
  updatedAt: new Date('2026-04-15T10:00:00Z'),
};

// 5 deals across 2 contacts under tenantId=1 — used by the happy-path tests.
// Vinay: deals 1+2+3, total sale = 100000+200000+50000 = 350000 → 17500 commission
// Priya: deals 4+5,    total sale = 80000+150000        = 230000 → 11500 commission
// Grand total commission across the two contacts = 29000.
const dealsHappy = [
  {
    id: 1, title: 'Bali 7N', stage: 'won', amount: 100000, currency: 'INR',
    createdAt: new Date('2026-05-01T08:00:00Z'),
    contact: { id: 501, name: 'Vinay (TMC sub-agent Pune)' },
  },
  {
    id: 2, title: 'Goa 3N', stage: 'won', amount: 200000, currency: 'INR',
    createdAt: new Date('2026-05-05T08:00:00Z'),
    contact: { id: 501, name: 'Vinay (TMC sub-agent Pune)' },
  },
  {
    id: 3, title: 'Munnar 4N', stage: 'won', amount: 50000, currency: 'INR',
    createdAt: new Date('2026-05-10T08:00:00Z'),
    contact: { id: 501, name: 'Vinay (TMC sub-agent Pune)' },
  },
  {
    id: 4, title: 'Andamans 5N', stage: 'won', amount: 80000, currency: 'INR',
    createdAt: new Date('2026-05-12T08:00:00Z'),
    contact: { id: 502, name: 'Priya (HR Globussoft)' },
  },
  {
    id: 5, title: 'Ladakh 6N', stage: 'won', amount: 150000, currency: 'INR',
    createdAt: new Date('2026-05-18T08:00:00Z'),
    contact: { id: 502, name: 'Priya (HR Globussoft)' },
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

describe('GET /api/travel/commission-profiles/:id/summary/by-contact (slice 14)', () => {
  test('happy path 5 deals × 2 contacts → 2 rows summed correctly, default sort totalCommission:desc', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 21,
      profileName: 'Standard 5%',
      profileType: 'flat_percent',
      totalContacts: 2,
      grandTotalCommission: 29000, // 17500 + 11500
      limit: 50,
      offset: 0,
    });

    // Default sort is totalCommission:desc → Vinay (17500) before Priya (11500).
    expect(res.body.contacts).toHaveLength(2);
    expect(res.body.contacts[0]).toMatchObject({
      contactId: 501,
      contactName: 'Vinay (TMC sub-agent Pune)',
      dealCount: 3,
      totalSale: 350000,
      totalCommission: 17500,
    });
    expect(res.body.contacts[1]).toMatchObject({
      contactId: 502,
      contactName: 'Priya (HR Globussoft)',
      dealCount: 2,
      totalSale: 230000,
      totalCommission: 11500,
    });
  });

  test('?orderBy=dealCount:desc honored', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact?orderBy=dealCount:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Vinay (3 deals) before Priya (2 deals).
    expect(res.body.contacts[0].contactId).toBe(501);
    expect(res.body.contacts[0].dealCount).toBe(3);
    expect(res.body.contacts[1].contactId).toBe(502);
    expect(res.body.contacts[1].dealCount).toBe(2);
  });

  test('?orderBy=contactName:asc honored', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact?orderBy=contactName:asc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Alpha: Priya before Vinay.
    expect(res.body.contacts[0].contactName).toMatch(/^Priya/);
    expect(res.body.contacts[1].contactName).toMatch(/^Vinay/);
  });

  test('?orderBy=totalSale:desc honored', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact?orderBy=totalSale:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Vinay (350000) before Priya (230000).
    expect(res.body.contacts[0].totalSale).toBe(350000);
    expect(res.body.contacts[1].totalSale).toBe(230000);
  });

  test('unknown orderBy token falls back to default (graceful, no 400)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact?orderBy=evil:hax')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Fallback to totalCommission:desc → Vinay first.
    expect(res.body.contacts[0].contactId).toBe(501);
  });

  test('empty result (no deals carry this profile) → 200 with contacts=[]', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual([]);
    expect(res.body.totalContacts).toBe(0);
    expect(res.body.grandTotalCommission).toBe(0);
  });

  test('Deal.findMany where includes tenantId + commissionProfileId + deletedAt:null + stage filter', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact?stage=won')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({
      tenantId: 1,
      deletedAt: null,
      stage: 'won',
      contact: { commissionProfileId: 21, tenantId: 1 },
    });
  });

  test('?limit and ?offset applied AFTER aggregation', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Aggregation produces 2 contacts; offset=1 + limit=1 returns just Priya
    // (the 2nd row under default totalCommission:desc).
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].contactId).toBe(502);
    // totalContacts is the FULL aggregated size, not the page slice.
    expect(res.body.totalContacts).toBe(2);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
    // grandTotalCommission is the full sum, not just the page slice.
    expect(res.body.grandTotalCommission).toBe(29000);
  });

  test('cross-tenant profile id → 404 PROFILE_NOT_FOUND', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/9999/summary/by-contact')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["rfu"], profile.subBrand="tmc" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('malformed stored profileJson → 200 with per-row totalCommission=0, dealCount + totalSale accurate', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue({
      ...flatProfile,
      profileJson: '{not valid json',
    });
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(2);
    // dealCount + totalSale stay accurate even with parse error.
    const vinay = res.body.contacts.find((c) => c.contactId === 501);
    const priya = res.body.contacts.find((c) => c.contactId === 502);
    expect(vinay).toMatchObject({ dealCount: 3, totalSale: 350000, totalCommission: 0 });
    expect(priya).toMatchObject({ dealCount: 2, totalSale: 230000, totalCommission: 0 });
    expect(res.body.grandTotalCommission).toBe(0);
  });

  test('invalid :id segment (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/not-a-number/summary/by-contact')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
  });

  test('half-up rounding: per-row + grandTotal rounded to 2dp', async () => {
    // Profile with a percent that produces fractional commission per-deal:
    // 3.333% of 33333 = 1110.99989 → rounds to 1111.00
    prisma.travelCommissionProfile.findFirst.mockResolvedValue({
      ...flatProfile,
      profileJson: JSON.stringify({ type: 'flat_percent', percent: 3.333 }),
    });
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 7, title: 'Fractional', stage: 'won', amount: 33333, currency: 'INR',
        createdAt: new Date('2026-05-20T08:00:00Z'),
        contact: { id: 601, name: 'Fractional Agent' },
      },
      {
        id: 8, title: 'Fractional 2', stage: 'won', amount: 33333, currency: 'INR',
        createdAt: new Date('2026-05-21T08:00:00Z'),
        contact: { id: 601, name: 'Fractional Agent' },
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    // 33333 × 3.333% = 1110.98889 per deal → round2 = 1110.99; sum across 2 = 2221.98.
    // The grand total sums the already-rounded per-row commissions, so 2221.98 not
    // 2221.97778. Pinning the .98 here proves the route's round2 fires at both
    // the per-row sum AND the grandTotal (round-twice with consistent half-up).
    expect(res.body.contacts[0]).toMatchObject({
      contactId: 601,
      dealCount: 2,
      totalSale: 66666,
      totalCommission: 2221.98,
    });
    expect(res.body.grandTotalCommission).toBe(2221.98);
    // Confirm no float-fuzz leaks through (no third decimal place).
    expect(Number.isInteger(res.body.contacts[0].totalCommission * 100)).toBe(true);
    expect(Number.isInteger(res.body.grandTotalCommission * 100)).toBe(true);
  });

  test('?limit=500 is capped at 200 (DoS guard)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-contact?limit=500')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
  });
});
