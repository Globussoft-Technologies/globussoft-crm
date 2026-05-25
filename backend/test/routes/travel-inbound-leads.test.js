// @ts-check
/**
 * Arc 2 #904 slice 1 — POST /api/travel/inbound/leads/:channel contract
 * tests (PRD_TRAVEL_MULTICHANNEL_LEADS §3).
 *
 * Pins the inbound-webhook scaffold added in backend/routes/travel_inbound_leads.js:
 *
 *   POST /api/travel/inbound/leads/:channel    no auth in tests; X-API-Key
 *                                              middleware wires in at slice 2
 *
 * Contracts asserted
 * ------------------
 *   - Channel enum gate (voyagr | webform | whatsapp | ads | adsgpt |
 *     metaads | manual). Anything else → 400 INVALID_CHANNEL with no DB call.
 *   - tenantSlug REQUIRED; absent → 400 MISSING_TENANT_SLUG.
 *   - email OR phone REQUIRED (at least one); both absent → 400 MISSING_CONTACT.
 *   - tenantSlug must resolve to an existing Tenant; miss → 404 TENANT_NOT_FOUND.
 *   - Tenant.vertical MUST be "travel"; mismatch → 400 WRONG_VERTICAL.
 *   - Happy path: Contact.create called with tenantId from the looked-up
 *     Tenant (NOT from req.body — the global stripDangerous middleware
 *     deletes req.body.tenantId; we resolve via tenantSlug).
 *   - source defaults to `inbound:<channel>` when the body omits it; an
 *     explicit body-supplied `source` overrides the default.
 *   - name resolution: prefers `name`, then `firstName + lastName`,
 *     finally falls back to "Inbound Lead" so the NOT-NULL constraint
 *     never fires.
 *   - email synthesis: when only phone is supplied, the handler synthesizes
 *     a deterministic placeholder (`inbound-<channel>-<ts>@imported.local`)
 *     so the @@unique([email, tenantId]) constraint never fires on a NULL
 *     insert. Real-email reconciliation moves to slice 4.
 *   - subBrand passes through to Contact.subBrand when supplied.
 *   - 500 generic envelope on unexpected prisma errors.
 *
 * STUB markers in slice 1
 * -----------------------
 *   - Channel-specific verification (Q9 Wati / Q1 AdsGPT / Voyagr HMAC)
 *     pending creds — handler trusts the payload today.
 *   - LeadAutoRouter + Touchpoint chain deferred to slice 3; the response
 *     envelope returns `routed: false` so callers wire to the eventual
 *     truth-value flip without a contract change.
 *   - Idempotency key + cross-channel merge prompt land in slices 4 + 5.
 *
 * Test pattern mirrors backend/test/routes/travel-rfu-profiles.test.js +
 * travel-quote-lines.test.js — patch the prisma singleton with vi.fn()
 * shapes BEFORE requiring the router, then drive supertest against the
 * mounted router directly (no JWT, no X-API-Key middleware — those wire
 * in at slice 2 in server.js).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router so the route's
// `require('../lib/prisma')` resolves to this stub.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.create = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const inboundLeadsRouter = requireCJS('../../routes/travel_inbound_leads');

function makeApp() {
  const app = express();
  app.use(express.json());
  // Mount the router under the namespace the production wire-in will use.
  app.use('/api/travel', inboundLeadsRouter);
  return app;
}

const TRAVEL_TENANT = {
  id: 42,
  vertical: 'travel',
};

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue(TRAVEL_TENANT);
  prisma.contact.create.mockReset().mockImplementation(async ({ data }) => ({
    id: 1001,
    ...data,
    createdAt: new Date(),
  }));
});

// ─── Channel-enum gate ────────────────────────────────────────────────

describe('POST /api/travel/inbound/leads/:channel — channel-enum gate', () => {
  test('happy path channel=voyagr → 201, Contact created', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        firstName: 'Amita',
        lastName: 'Rao',
        email: 'amita@example.com',
        phone: '+919876543210',
        subBrand: 'tmc',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 1001,
      contactId: 1001,
      tenantId: 42,
      channel: 'voyagr',
      status: 'received',
      routed: false,
    });
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
  });

  test('channel=webform → 201', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/webform')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Suresh K',
        email: 'suresh@example.com',
      });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('webform');
  });

  test('channel=whatsapp → 201', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Priya M',
        phone: '+919812345678',
      });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('whatsapp');
  });

  test('channel=manual → 201 (CRM walk-in scaffold)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/manual')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Walk-in Customer',
        phone: '+919900000001',
      });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('manual');
  });

  test('invalid channel "bogus" → 400 INVALID_CHANNEL, no DB call', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/bogus')
      .send({
        tenantSlug: 'travel-stall',
        email: 'x@y.com',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CHANNEL' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});

// ─── Body validation ──────────────────────────────────────────────────

describe('POST /api/travel/inbound/leads/:channel — body validation', () => {
  test('missing tenantSlug → 400 MISSING_TENANT_SLUG', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({ email: 'x@y.com' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TENANT_SLUG' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('missing both email and phone → 400 MISSING_CONTACT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({ tenantSlug: 'travel-stall', name: 'Anon' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_CONTACT' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('email-only valid → 201', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Email Only',
        email: 'only@example.com',
      });

    expect(res.status).toBe(201);
    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.email).toBe('only@example.com');
    expect(callArg.data.phone).toBeNull();
  });

  test('phone-only valid → 201, email synthesized as inbound-<channel>-<ts>@imported.local', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Phone Only',
        phone: '+919900000099',
      });

    expect(res.status).toBe(201);
    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.email).toMatch(/^inbound-whatsapp-\d+@imported\.local$/);
    expect(callArg.data.phone).toBe('+919900000099');
  });
});

// ─── Tenant resolution ────────────────────────────────────────────────

describe('POST /api/travel/inbound/leads/:channel — tenant resolution', () => {
  test('unknown tenantSlug → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'missing-tenant',
        email: 'x@y.com',
      });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('non-travel tenant → 400 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1,
      vertical: 'generic',
    });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'generic-tenant',
        email: 'x@y.com',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('wellness tenant rejected → 400 WRONG_VERTICAL (envelope is travel-only in slice 1)', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 2,
      vertical: 'wellness',
    });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'wellness-tenant',
        email: 'x@y.com',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
  });
});

// ─── Persistence shape ────────────────────────────────────────────────

describe('POST /api/travel/inbound/leads/:channel — Contact.create shape', () => {
  test('Contact.create called with tenantId from the looked-up tenant (not req.body)', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Tenant Scope Probe',
        email: 'probe@example.com',
      });

    expect(prisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 42, // from TRAVEL_TENANT.id, not from body
        }),
      }),
    );
  });

  test('source defaults to "inbound:<channel>" when body omits it', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Default Source',
        email: 'def@example.com',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.source).toBe('inbound:metaads');
  });

  test('explicit source in body overrides the default', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/webform')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Override Source',
        email: 'over@example.com',
        source: 'tmcedu.com/contact',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.source).toBe('tmcedu.com/contact');
  });

  test('name resolution: firstName + lastName combined into Contact.name', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        firstName: 'Rakesh',
        lastName: 'Iyer',
        email: 'rakesh@example.com',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.name).toBe('Rakesh Iyer');
  });

  test('name resolution: name field wins over firstName/lastName when both present', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Explicit Name',
        firstName: 'Should',
        lastName: 'Ignore',
        email: 'name@example.com',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.name).toBe('Explicit Name');
  });

  test('name resolution: falls back to "Inbound Lead" when nothing supplied', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        phone: '+919900000033',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.name).toBe('Inbound Lead');
  });

  test('subBrand passes through to Contact.subBrand', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Sub Brand Probe',
        email: 'sb@example.com',
        subBrand: 'rfu',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.subBrand).toBe('rfu');
  });

  test('subBrand omitted → Contact.subBrand stored as null (back-compat for generic flows)', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'No Sub Brand',
        email: 'nsb@example.com',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.subBrand).toBeNull();
  });

  test('status set to "Lead" so downstream pipeline sees it', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Status Probe',
        email: 'st@example.com',
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.status).toBe('Lead');
  });
});

// ─── Error envelope ───────────────────────────────────────────────────

describe('POST /api/travel/inbound/leads/:channel — error envelope', () => {
  test('500 on prisma error → generic envelope (no stack leak)', async () => {
    prisma.contact.create.mockRejectedValueOnce(
      new Error('P2002 unique constraint violated'),
    );

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Boom',
        email: 'boom@example.com',
      });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to ingest inbound lead' });
    // No stack trace / no raw prisma message leak.
    expect(res.body.error).not.toMatch(/P2002/);
  });
});
