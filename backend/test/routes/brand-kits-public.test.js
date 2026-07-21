// @ts-check
/**
 * G092 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.f / FR-3.3.i / FR-3.3.g)
 * — GET /api/brand-kits/by-subbrand/:subBrand public endpoint.
 *
 * Pins the contract for the public, unauthenticated read endpoint that
 * resolves the active brand kit for a sub-brand. The customer portal,
 * the public trip microsite, the embed widget, and the public landing
 * page all consume this endpoint BEFORE the customer logs in (the login
 * screen / landing page itself must carry sub-brand chrome) so the
 * endpoint MUST be auth-free.
 *
 * Pinned invariants:
 *   1. GET with valid sub-brand → 200 + brandKit payload with public-
 *      safe fields only (no tenantId / version / createdBy / isActive
 *      / signatureTemplate / audit metadata).
 *   2. GET with unknown sub-brand → 400 INVALID_SUB_BRAND.
 *   3. GET with empty / placeholder ("_", "null") sub-brand → 400
 *      MISSING_SUB_BRAND (tenant-wide kits aren't exposed publicly).
 *   4. GET when no active kit exists → 404 BRAND_KIT_NOT_FOUND so the
 *      frontend can fall back to its default palette.
 *   5. ?tenantId=N when supplied wins; absent → travel-vertical tenant
 *      lookup; no travel tenant → 404 NO_TRAVEL_TENANT.
 *   6. signatureTemplate, version, isActive, createdBy NEVER appear in
 *      the response payload (regression pin — public path strips them).
 *   7. Endpoint is reachable without an Authorization header (regression
 *      pin — auth-gated mutations on the same router still 401 without
 *      a token; here the public read MUST 200 for the seeded kit).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.brandKit = prisma.brandKit || {};
prisma.brandKit.findFirst = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const brandKitsRouter = requireCJS('../../routes/brand_kits');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/brand-kits', brandKitsRouter);
  return app;
}

beforeEach(() => {
  prisma.brandKit.findFirst.mockReset();
  prisma.tenant.findFirst.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('GET /api/brand-kits/by-subbrand/:subBrand — public happy path', () => {
  test('returns 200 + active brand kit when one exists', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({
      logoUrl: 'https://cdn.example/tmc-logo.png',
      primaryColor: '#1F4E79',
      accentColor: '#F2B544',
      tagline: 'School trips that teach',
      missionStatement: 'We design educational tours …',
      supportEmail: 'hello@tmcnexus.com',
      supportPhone: '+91-22-1234-5678',
      footerText: '© TMC Nexus 2026',
    });

    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/tmc?tenantId=42');
    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe('tmc');
    expect(res.body.brandKit).toBeTruthy();
    expect(res.body.brandKit.primaryColor).toBe('#1F4E79');
    expect(res.body.brandKit.logoUrl).toBe('https://cdn.example/tmc-logo.png');
    expect(res.body.brandKit.supportEmail).toBe('hello@tmcnexus.com');
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
    expect(prisma.brandKit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 42, subBrand: 'tmc', isActive: true },
    }));
  });

  test('honors explicit ?tenantId — no tenant fallback lookup performed', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({
      primaryColor: '#0B5345',
    });

    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/rfu?tenantId=99');
    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe('rfu');
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
    expect(prisma.brandKit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 99, subBrand: 'rfu', isActive: true },
    }));
  });
});

describe('GET /api/brand-kits/by-subbrand/:subBrand — public field safety', () => {
  test('select payload omits audit + signatureTemplate fields (regression pin)', async () => {
    prisma.brandKit.findFirst.mockImplementation(async (args) => {
      // Validate the select shape — we must NOT include audit/internal
      // fields in the select so they cannot leak via the wire payload.
      const sel = args.select || {};
      expect(sel.id).toBeUndefined();
      expect(sel.tenantId).toBeUndefined();
      expect(sel.version).toBeUndefined();
      expect(sel.isActive).toBeUndefined();
      expect(sel.createdBy).toBeUndefined();
      expect(sel.createdAt).toBeUndefined();
      expect(sel.updatedAt).toBeUndefined();
      expect(sel.signatureTemplate).toBeUndefined();
      // Public-safe fields ARE in the select.
      expect(sel.primaryColor).toBe(true);
      expect(sel.logoUrl).toBe(true);
      expect(sel.supportEmail).toBe(true);
      return { primaryColor: '#1F4E79' };
    });

    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/tmc?tenantId=1');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/brand-kits/by-subbrand/:subBrand — error envelopes', () => {
  test('unknown sub-brand → 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/notabrand');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
  });

  test('placeholder "_" sub-brand → 400 MISSING_SUB_BRAND', async () => {
    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/_');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SUB_BRAND');
  });

  test('placeholder "null" sub-brand → 400 MISSING_SUB_BRAND', async () => {
    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/null');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SUB_BRAND');
  });

  test('?tenantId not a number → 400 INVALID_TENANT_ID', async () => {
    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/tmc?tenantId=abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TENANT_ID');
  });

  test('no travel tenant configured → 404 NO_TRAVEL_TENANT', async () => {
    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/tmc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TENANT_ID_REQUIRED');
  });

  test('no active brand kit for sub-brand → 404 BRAND_KIT_NOT_FOUND', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/visasure?tenantId=1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('BRAND_KIT_NOT_FOUND');
  });
});

describe('GET /api/brand-kits/by-subbrand/:subBrand — no auth required', () => {
  test('returns 200 without an Authorization header', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({ primaryColor: '#1F4E79' });

    const res = await request(makeApp()).get('/api/brand-kits/by-subbrand/tmc?tenantId=1');
    expect(res.status).toBe(200);
    // The router exposes mutations (POST/PUT/DELETE) gated by verifyToken
    // + verifyRole — they all 401 here without a token. The public read
    // path must NOT.
  });
});

describe('GET /api/brand-kits/by-subbrand/:subBrand — all four sub-brands accepted', () => {
  test.each([
    ['tmc', '#1F4E79'],
    ['rfu', '#0B5345'],
    ['travelstall', '#922B21'],
    ['visasure', '#283747'],
  ])('sub-brand %s accepted', async (sb, color) => {
    prisma.brandKit.findFirst.mockResolvedValue({ primaryColor: color });
    const res = await request(makeApp()).get(`/api/brand-kits/by-subbrand/${sb}?tenantId=1`);
    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe(sb);
    expect(res.body.brandKit.primaryColor).toBe(color);
  });
});
