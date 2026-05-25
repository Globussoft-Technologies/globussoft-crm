// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 7 — commission-preview endpoint contract.
 *
 * Pins POST /api/travel/commission-profiles/:id/preview which loads a stored
 * TravelCommissionProfile by id, parses its profileJson, and runs the pure
 * lib/agentCommissionCalculator.js (slice 1, commit cb284098) against an
 * operator-supplied sale amount + paxCount. Read-only; no mutation. Used by
 * the operator UI for "what-if" preview before assigning a profile to a
 * contact, and by the eventual invoice-render layer (slice 3 consumer) for
 * dry-run sanity checks before persisting commission line items.
 *
 * What's pinned
 * -------------
 *   - POST /api/travel/commission-profiles/:id/preview
 *       happy path flat_percent: 100000 sale @ 5% → commission=5000
 *       happy path tiered: slab math matches lib semantics
 *       missing saleAmount → 400 MISSING_FIELDS
 *       negative saleAmount → 400 INVALID_SALE_AMOUNT
 *       zero saleAmount → 200 commission=0 (allowed; defensive)
 *       paxCount default 1 (per_pax_flat sanity, paxCount omitted)
 *       invalid paxCount (negative) → 400 INVALID_PAX_COUNT
 *       cross-tenant profile id → 404 PROFILE_NOT_FOUND
 *       MANAGER restricted to ["rfu"] previewing a "tmc"-scoped profile → 403 SUB_BRAND_DENIED
 *       malformed stored profileJson → 200 commission=0 with diagnostic breakdown
 *       invalid :id segment (non-numeric) → 400 INVALID_ID
 *
 * Test pattern mirrors travel-commission-profiles-assign.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, drive
 * supertest with HS256 JWTs signed against the fallback secret. verifyToken
 * stays in the chain so auth + sub-brand gates all run. Endpoint is open to
 * any verified token (no RBAC narrowing) so the USER 403 case is intentionally
 * absent — preview is read-only and safe for the broader role surface.
 *
 * Defensive-malformed-profileJson decision
 * ----------------------------------------
 * Mirrors the lib's "no profile / unknown profile type → commission=0 with a
 * diagnostic breakdown" contract (see lib/agentCommissionCalculator.js:60-63).
 * A row whose profileJson was hand-edited into garbage after write-time
 * validation should surface as an operator-visible $0 row at preview/use-time,
 * NOT crash the calling UI with a 500. The 200-with-zero shape lets the UI
 * render the misconfig prominently and surface the breakdown string for
 * triage; the audit-log layer downstream sees the misconfigured profile.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCommissionProfile = prisma.travelCommissionProfile || {};
prisma.travelCommissionProfile.findFirst = vi.fn();
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

// Canonical sample profile rows. Stored profileJson is a JSON string per
// schema (column is @db.Text). Shapes match lib/agentCommissionCalculator.js.
const FLAT_PERCENT_PROFILE = {
  id: 42,
  tenantId: 1,
  name: 'Standard 5%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: null,
  isActive: true,
};

const TIERED_PROFILE = {
  id: 43,
  tenantId: 1,
  name: 'Slab tiers',
  profileType: 'tiered',
  profileJson: JSON.stringify({
    type: 'tiered',
    tiers: [
      { uptoCents: 50000, percent: 10 },
      { uptoCents: 200000, percent: 5 },
      { uptoCents: null, percent: 2 },
    ],
  }),
  subBrand: null,
  isActive: true,
};

const PER_PAX_PROFILE = {
  id: 44,
  tenantId: 1,
  name: 'Per pax ₹500',
  profileType: 'per_pax_flat',
  profileJson: JSON.stringify({ type: 'per_pax_flat', amountPerPax: 500 }),
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

beforeEach(() => {
  prisma.travelCommissionProfile.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/commission-profiles/:id/preview', () => {
  test('happy path flat_percent: 100000 sale @ 5% → commission=5000', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(FLAT_PERCENT_PROFILE);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 42,
      profileName: 'Standard 5%',
      profileType: 'flat_percent',
      saleAmount: 100000,
      paxCount: 1,
      commission: 5000,
    });
    expect(res.body.breakdown).toMatch(/5/);
  });

  test('happy path tiered: slab math matches lib semantics', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(TIERED_PROFILE);

    // From lib doc: sale=100000 against tiers [50000@10%, 200000@5%, ∞@2%]
    //   band 0–50000 @ 10% = 5000
    //   band 50000–100000 @ 5% = 2500
    //   total 7500
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/43/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 43,
      profileType: 'tiered',
      saleAmount: 100000,
      commission: 7500,
    });
    expect(res.body.breakdown).toMatch(/10%/);
    expect(res.body.breakdown).toMatch(/5%/);
  });

  test('missing saleAmount → 400 MISSING_FIELDS (findFirst NOT called)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(res.body.error).toMatch(/saleAmount/);
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
  });

  test('negative saleAmount → 400 INVALID_SALE_AMOUNT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: -100 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SALE_AMOUNT' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
  });

  test('zero saleAmount → 200 commission=0 (allowed; defensive)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(FLAT_PERCENT_PROFILE);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 42,
      saleAmount: 0,
      commission: 0,
    });
  });

  test('paxCount defaults to 1 when omitted (per_pax_flat sanity)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(PER_PAX_PROFILE);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/44/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000 }); // paxCount omitted

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 44,
      profileType: 'per_pax_flat',
      paxCount: 1,
      commission: 500, // 1 pax * 500/pax
    });
  });

  test('paxCount explicit > 1 multiplies per_pax_flat correctly', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(PER_PAX_PROFILE);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/44/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000, paxCount: 4 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      paxCount: 4,
      commission: 2000, // 4 pax * 500/pax
    });
  });

  test('invalid paxCount (negative) → 400 INVALID_PAX_COUNT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000, paxCount: -2 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAX_COUNT' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant profile id → 404 PROFILE_NOT_FOUND', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/9999/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000 });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(prisma.travelCommissionProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });

  test('MANAGER restricted to ["rfu"] previewing a "tmc"-scoped profile → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(TMC_PROFILE);
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/45/preview')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ saleAmount: 100000 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });

  test('malformed stored profileJson → 200 commission=0 with diagnostic breakdown (defensive)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(MALFORMED_PROFILE);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/46/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 46,
      commission: 0,
    });
    expect(res.body.breakdown).toMatch(/malformed/i);
  });

  test('invalid :id segment (non-numeric) → 400 INVALID_ID (findFirst NOT called)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/not-an-int/preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ saleAmount: 100000 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
  });
});
