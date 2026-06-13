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

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router so the route's
// `require('../lib/prisma')` resolves to this stub.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.create = vi.fn();
// Slice 9 dedup surface — both calls default to "no existing Contact"
// so legacy tests stay on the "created" branch unmodified.
prisma.contact.findMany = vi.fn();
prisma.contact.findUnique = vi.fn();
// G002 idempotency-key fast-path + G003 marketplace short-circuit +
// G011 cooldown probe all use findFirst. Default returns null (no
// match → fall-through to create branch).
prisma.contact.findFirst = vi.fn();
// Slice 10 rollup surface — GET /inbound/leads/by-channel uses groupBy.
prisma.contact.groupBy = vi.fn();
// G001 Touchpoint write — best-effort append after create / merge. Default
// returns a synthetic row so happy-path tests pick up touchpointId.
prisma.touchpoint = prisma.touchpoint || {};
prisma.touchpoint.create = vi.fn();
// G011 — cooldown loader hits TenantSetting (key/value JSON store).
// Default returns null (no cooldown configured), so legacy tests stay
// on the fast path.
prisma.tenantSetting = prisma.tenantSetting || {};
prisma.tenantSetting.findUnique = vi.fn();
// G003 — merge-prompt notification on cross-channel dedupe. Best-effort
// fan-out; default returns a synthetic row.
prisma.notification = prisma.notification || {};
prisma.notification.create = vi.fn();

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
  // Slice 9 dedup defaults: no phone match, no email match → "created"
  // branch is the default behavior for legacy tests.
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  // G002 + G003 + G011 defaults: no idempotency hit, no marketplace
  // dedupe, no cooldown prior — legacy tests stay on the create branch.
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  // Slice 10 rollup default: empty groupBy result.
  prisma.contact.groupBy.mockReset().mockResolvedValue([]);
  // G001 touchpoint default: synthetic row id surfaced in envelope.
  prisma.touchpoint.create.mockReset().mockResolvedValue({ id: 5001 });
  // G011 cooldown default: no setting row (null) → cooldown disabled.
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  // G003 merge-prompt default: synthetic notification row.
  prisma.notification.create.mockReset().mockResolvedValue({ id: 9001 });
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

// ─── Slice 4: verification wire-in (lib/inboundLeadVerification) ──────
//
// Contracts asserted (slice-4 additions):
//   - Voyagr HMAC: when VOYAGR_HMAC_SECRET is SET, the route verifies the
//     X-Voyagr-Signature header against an HMAC-SHA256 of the raw body.
//     Valid sig → 201. Mismatch → 400 VERIFICATION_FAILED + reason
//     SIGNATURE_MISMATCH.
//   - Voyagr STUB mode: when VOYAGR_HMAC_SECRET is UNSET, the route logs
//     a WARN and persists anyway (preserves dev/test flow + slice-1
//     legacy assertions that send no signature).
//   - Webform: honeypot field "website_url" — empty → 201; non-empty
//     → 400 VERIFICATION_FAILED + reason HONEYPOT_TRIPPED.
//   - Anti-spam: viagra / <script tag → 400 VERIFICATION_FAILED with
//     reason `SPAM_PATTERN_*`.
//   - Format: email without @ → 400 INVALID_EMAIL; phone <7 digits →
//     400 INVALID_PHONE.
//   - WhatsApp STUB: helper returns {ok:true, stub:true} — route persists
//     unchanged.
//
// All cases stub prisma.contact.create so no real DB IO fires.

const crypto = require('crypto');

describe('POST /api/travel/inbound/leads/:channel — slice 4 verification', () => {
  // Save + restore the env per test so the test order is independent.
  const ORIGINAL_SECRET = process.env.VOYAGR_HMAC_SECRET;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.VOYAGR_HMAC_SECRET;
    } else {
      process.env.VOYAGR_HMAC_SECRET = ORIGINAL_SECRET;
    }
  });

  test('voyagr happy: VALID HMAC + VOYAGR_HMAC_SECRET set → 201', async () => {
    process.env.VOYAGR_HMAC_SECRET = 'test-secret-v4';
    const body = {
      tenantSlug: 'travel-stall',
      name: 'Voyagr Verified',
      email: 'verified@example.com',
    };
    const payload = JSON.stringify(body);
    const sig = crypto
      .createHmac('sha256', 'test-secret-v4')
      .update(payload)
      .digest('hex');

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .set('X-Voyagr-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('voyagr');
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
  });

  test('voyagr INVALID signature → 400 VERIFICATION_FAILED reason=SIGNATURE_MISMATCH', async () => {
    process.env.VOYAGR_HMAC_SECRET = 'test-secret-v4';

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .set(
        'X-Voyagr-Signature',
        // 64-char hex string but wrong value (length must match for the
        // helper to reach the timing-safe compare branch).
        'a'.repeat(64),
      )
      .send({
        tenantSlug: 'travel-stall',
        name: 'Bad Sig',
        email: 'bad@example.com',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VERIFICATION_FAILED',
      reason: 'SIGNATURE_MISMATCH',
      channel: 'voyagr',
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('voyagr WITHOUT env (STUB mode) → 201 + console.warn called', async () => {
    delete process.env.VOYAGR_HMAC_SECRET;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Stub Voyagr',
        email: 'stub@example.com',
      });

    expect(res.status).toBe(201);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) =>
      String(c[0] || '').includes('VOYAGR_HMAC_SECRET unset'),
    )).toBe(true);
    warnSpy.mockRestore();
  });

  test('webform happy (no honeypot) → 201', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/webform')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Real Human',
        email: 'real@example.com',
      });

    expect(res.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
  });

  test('webform with honeypot filled → 400 VERIFICATION_FAILED reason=HONEYPOT_TRIPPED', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/webform')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Bot Filler',
        email: 'bot@example.com',
        website_url: 'http://bot-site.example',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VERIFICATION_FAILED',
      reason: 'HONEYPOT_TRIPPED',
      channel: 'webform',
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('anti-spam: body containing "viagra" → 400 VERIFICATION_FAILED', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/manual')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Buy viagra now',
        email: 'spam@example.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERIFICATION_FAILED');
    expect(res.body.reason).toMatch(/SPAM_PATTERN_VIAGRA/);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('anti-spam: body containing "<script>" → 400 VERIFICATION_FAILED', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/manual')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Inline note',
        email: 'xss@example.com',
        // Body field value contains <script — caught by anti-spam before
        // sanitization layer. The global sanitizeBody middleware would
        // strip the tag anyway, but anti-spam runs first so we get the
        // rejection envelope.
        notes: 'hi <script>alert(1)</script>',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERIFICATION_FAILED');
    expect(res.body.reason).toMatch(/SPAM_PATTERN/);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('email format invalid (no @) → 400 INVALID_EMAIL', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/manual')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Bad Email',
        email: 'not-an-email',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_EMAIL' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('phone format invalid (too short) → 400 INVALID_PHONE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/manual')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Bad Phone',
        phone: '12345', // 5 digits — below helper's 7-digit floor
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PHONE' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('whatsapp channel STUB-mode → 201 (helper returns ok:true, stub:true)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        name: 'WA Stub',
        phone: '+919812340000',
      });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('whatsapp');
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
  });
});

// ─── Slice 9: dedup-on-ingest (PRD §3.2.1 + §3.2.2) ──────────────────
//
// Contracts asserted (slice-9 additions):
//   - Phone PRIMARY: incoming phone normalized digits-only ("+91 98765-43210"
//     → "919876543210"); same canonical key as an existing tenant Contact →
//     200 + action:'merged' + contactId set to the existing row. NO new
//     Contact.create call.
//   - Phone normalization: 10-digit incoming auto-prepends "91" so a 10-digit
//     producer matches an existing 12-digit (+91) stored row.
//   - Email SECONDARY (phone absent): exact (email, tenantId) compound match
//     → 200 + action:'merged'. Synthesized inbound placeholders never
//     trigger secondary lookup (the route only honors caller-supplied real
//     emails for dedup).
//   - No match (neither phone nor email) → 201 + action:'created' (legacy
//     branch, preserves slice-1 behavior).
//   - Cross-tenant safety: the tenant-scoped findMany predicate prevents
//     cross-tenant phone bleed — verified by inspecting the findMany call
//     args (tenantId=42 + phone:{not:null} + deletedAt:null).

describe('POST /api/travel/inbound/leads/:channel — slice 9 dedup on ingest', () => {
  test('phone match (existing tenant Contact) → 200 + action=merged + no new Contact.create', async () => {
    // Existing Contact in tenant=42 with phone "+919876543210" (stored).
    prisma.contact.findMany.mockResolvedValueOnce([
      { id: 777, phone: '+919876543210', email: 'asha@example.com', name: 'Asha V' },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Asha V (re-arrival)',
        // Same human, different surface form — normalize both to 919876543210.
        phone: '+91 98765-43210',
        email: 'asha@example.com',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 777,
      contactId: 777,
      tenantId: 42,
      channel: 'voyagr',
      action: 'merged',
      status: 'received',
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('phone match: 10-digit incoming matches existing 12-digit stored (auto-prepend 91)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { id: 778, phone: '919812345678', email: null, name: 'Priya M' },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Priya again',
        phone: '9812345678', // 10 digits, IN local form
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('merged');
    expect(res.body.contactId).toBe(778);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('email match (phone absent) → 200 + action=merged via secondary key', async () => {
    // No phone-match candidates returned (findMany default is []).
    prisma.contact.findUnique.mockResolvedValueOnce({
      id: 779,
      phone: null,
      email: 'duplicate@example.com',
      name: 'Email Dup',
    });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/webform')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Email Dup retry',
        email: 'duplicate@example.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('merged');
    expect(res.body.contactId).toBe(779);
    expect(prisma.contact.create).not.toHaveBeenCalled();
    // Verify the compound finder shape (PRD §3.2.2's email+tenantId key).
    expect(prisma.contact.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email_tenantId: { email: 'duplicate@example.com', tenantId: 42 } },
      }),
    );
  });

  test('no match → 201 + action=created (legacy branch preserved)', async () => {
    // findMany returns no candidates, findUnique returns null — fallthrough.
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Brand New',
        email: 'newlead@example.com',
        phone: '+919900000123',
      });

    expect(res.status).toBe(201);
    expect(res.body.action).toBe('created');
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
  });

  test('phone-only payload with no existing match → 201 + action=created (synthesized email NOT used for secondary lookup)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Phone Only New',
        phone: '+919900000456',
      });

    expect(res.status).toBe(201);
    expect(res.body.action).toBe('created');
    // Email-secondary lookup MUST be skipped when no real email supplied
    // (the route only triggers findUnique when caller-supplied email is
    // truthy + trimmed — synthesized placeholders never flow here).
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('dedup scopes to tenant.id (cross-tenant phones do NOT merge)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([]);

    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Cross Tenant Probe',
        phone: '+919900000789',
      });

    // The phone-key scan MUST pass tenantId=42 + exclude soft-deleted rows.
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 42,
          phone: { not: null },
          deletedAt: null,
        }),
      }),
    );
  });
});

// ─── Slice 10: per-channel attribution rollup ─────────────────────────
//
// Contracts asserted (slice-10 additions):
//   - GET /api/travel/inbound/leads/by-channel?tenantSlug=… returns the
//     per-channel inbound count over the requested window (default 30d
//     retro). Buckets are seeded for every VALID_CHANNEL so the shape is
//     stable even when a channel has 0 leads.
//   - Unknown source suffixes (e.g. legacy 'inbound:indiamart' from
//     before the enum tightened) bucket into 'unknown' so the total
//     reconciles.
//   - tenantSlug missing → 400 MISSING_TENANT_SLUG. Tenant miss → 404.
//     Non-travel tenant → 400 WRONG_VERTICAL. Range inverted or beyond
//     the 365d cap → 400 INVALID_RANGE.
//   - groupBy predicate scopes to tenantId + inbound: source prefix +
//     deletedAt:null + the requested createdAt window.
//   - 500 generic envelope on prisma error.

describe('GET /api/travel/inbound/leads/by-channel — slice 10 rollup', () => {
  test('happy path: groupBy result mapped to byChannel array + total reconciles', async () => {
    prisma.contact.groupBy.mockResolvedValueOnce([
      { source: 'inbound:voyagr', _count: { _all: 12 } },
      { source: 'inbound:webform', _count: { _all: 5 } },
      { source: 'inbound:whatsapp', _count: { _all: 8 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 42,
      tenantSlug: 'travel-stall',
      total: 25,
    });
    // byChannel has one entry per VALID_CHANNEL (10 after slice 16
    // wired indiamart/justdial/tradeindia), in the canonical enum order.
    // Channels not in the groupBy result default to 0.
    const expectedShape = [
      { channel: 'voyagr', count: 12 },
      { channel: 'webform', count: 5 },
      { channel: 'whatsapp', count: 8 },
      { channel: 'ads', count: 0 },
      { channel: 'adsgpt', count: 0 },
      { channel: 'metaads', count: 0 },
      { channel: 'manual', count: 0 },
      { channel: 'indiamart', count: 0 },
      { channel: 'justdial', count: 0 },
      { channel: 'tradeindia', count: 0 },
    ];
    expect(res.body.byChannel).toEqual(expectedShape);
    // No unknown bucket when every source maps cleanly.
    expect(res.body.byChannel.some((b) => b.channel === 'unknown')).toBe(false);
  });

  test('unknown source suffix buckets into "unknown" + total still reconciles', async () => {
    // Legacy or future-enum source we don't recognize today. Slice 16
    // promoted indiamart/justdial/tradeindia into VALID_CHANNELS, so
    // pick a placeholder source that's still genuinely outside the enum
    // (e.g. an old/decommissioned channel identifier).
    prisma.contact.groupBy.mockResolvedValueOnce([
      { source: 'inbound:voyagr', _count: { _all: 2 } },
      { source: 'inbound:legacydialer', _count: { _all: 3 } }, // not in VALID_CHANNELS
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    const unknown = res.body.byChannel.find((b) => b.channel === 'unknown');
    expect(unknown).toEqual({ channel: 'unknown', count: 3 });
    expect(res.body.total).toBe(5);
  });

  test('groupBy predicate scopes to tenantId + inbound: prefix + deletedAt + window', async () => {
    await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({
        tenantSlug: 'travel-stall',
        since: '2026-05-01T00:00:00.000Z',
        until: '2026-05-25T23:59:59.999Z',
      });

    expect(prisma.contact.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['source'],
        where: expect.objectContaining({
          tenantId: 42,
          deletedAt: null,
          source: { startsWith: 'inbound:' },
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
        _count: { _all: true },
      }),
    );
    // since/until echoed back as ISO strings (timezone-safe contract).
    const calledWith = prisma.contact.groupBy.mock.calls[0][0];
    expect(calledWith.where.createdAt.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(calledWith.where.createdAt.lte.toISOString()).toBe('2026-05-25T23:59:59.999Z');
  });

  test('default window: no since/until → 30d retro from now', async () => {
    const before = Date.now();
    await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({ tenantSlug: 'travel-stall' });
    const after = Date.now();

    const calledWith = prisma.contact.groupBy.mock.calls[0][0];
    const since = calledWith.where.createdAt.gte.getTime();
    const until = calledWith.where.createdAt.lte.getTime();
    // Window is ~30d; allow envelope for test execution latency.
    expect(until - since).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 5_000);
    expect(until - since).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 5_000);
    expect(until).toBeGreaterThanOrEqual(before);
    expect(until).toBeLessThanOrEqual(after);
  });

  test('missing tenantSlug → 400 MISSING_TENANT_SLUG, no DB call', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TENANT_SLUG' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });

  test('unknown tenantSlug → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({ tenantSlug: 'no-such-tenant' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });

  test('non-travel tenant → 400 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 7,
      vertical: 'wellness',
    });

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({ tenantSlug: 'wellness-tenant' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });

  test('inverted range (until < since) → 400 INVALID_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({
        tenantSlug: 'travel-stall',
        since: '2026-05-20T00:00:00.000Z',
        until: '2026-05-01T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_RANGE' });
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });

  test('range beyond 365d cap → 400 INVALID_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({
        tenantSlug: 'travel-stall',
        since: '2024-01-01T00:00:00.000Z',
        until: '2026-05-25T00:00:00.000Z', // ~875 days
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_RANGE' });
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });

  test('non-parseable date → 400 INVALID_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({
        tenantSlug: 'travel-stall',
        since: 'not-a-date',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_RANGE' });
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });

  test('zero inbound leads → 200 with all-zero buckets + total=0', async () => {
    // Default mock returns [] — no groupBy rows.
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byChannel).toHaveLength(10); // VALID_CHANNELS.length (slice 16: + indiamart/justdial/tradeindia), no unknown
    expect(res.body.byChannel.every((b) => b.count === 0)).toBe(true);
  });

  test('500 generic envelope on prisma groupBy error (no stack leak)', async () => {
    prisma.contact.groupBy.mockRejectedValueOnce(
      new Error('P1001 cannot reach database'),
    );

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-channel')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Failed to roll up inbound leads by channel',
    });
    expect(res.body.error).not.toMatch(/P1001/);
  });
});

// ─── Slice 11 — junk-classification integration ───────────────────────
//
// Pins the route's behaviour when classifyInboundJunk returns junk:true:
//   - Contact.create called with status='Junk' (NOT 'Lead')
//   - Response envelope carries junk:true + junkReasons[]
//   - Existing-Contact merge branch is NOT affected (status stays
//     untouched; junk only applies to brand-new Contact creation)

describe('POST /api/travel/inbound/leads/:channel — slice 11 junk classification', () => {
  test('whatsapp (STUB) + only phone, no name, no email → status="Junk" + junk:true', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        phone: '+919811111111',
      });

    expect(res.status).toBe(201);
    expect(res.body.junk).toBe(true);
    expect(res.body.junkReasons).toEqual(
      expect.arrayContaining([
        'VERIFICATION_STUB',
        'NO_NAME',
        'NO_REAL_EMAIL',
        'NO_SECONDARY_SIGNAL',
      ]),
    );
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
    expect(prisma.contact.create.mock.calls[0][0].data.status).toBe('Junk');
  });

  test('whatsapp (STUB) + name supplied → status="Lead" + junk:false', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Priya Sharma',
        phone: '+919822222222',
      });

    expect(res.status).toBe(201);
    expect(res.body.junk).toBe(false);
    expect(res.body.junkReasons).toEqual([]);
    expect(prisma.contact.create.mock.calls[0][0].data.status).toBe('Lead');
  });

  test('whatsapp (STUB) + real email supplied → not junk (email = identity)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        email: 'real@example.com',
        phone: '+919833333333',
      });

    expect(res.status).toBe(201);
    expect(res.body.junk).toBe(false);
    expect(prisma.contact.create.mock.calls[0][0].data.status).toBe('Lead');
  });

  test('whatsapp (STUB) + subBrand supplied → not junk (form-routing signal)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        phone: '+919844444444',
        subBrand: 'rfu',
      });

    expect(res.status).toBe(201);
    expect(res.body.junk).toBe(false);
    expect(prisma.contact.create.mock.calls[0][0].data.status).toBe('Lead');
  });

  test('voyagr without VOYAGR_HMAC_SECRET (bypass) + zero signal → junk:true with VERIFICATION_BYPASSED', async () => {
    // Slice 1 + 11 — when env-missing, the route synthesizes a bypassed
    // verification verdict. With no name + no real email + no extras, the
    // junk classifier fires.
    const prevSecret = process.env.VOYAGR_HMAC_SECRET;
    delete process.env.VOYAGR_HMAC_SECRET;
    try {
      const res = await request(makeApp())
        .post('/api/travel/inbound/leads/voyagr')
        .send({
          tenantSlug: 'travel-stall',
          phone: '+919855555555',
        });

      expect(res.status).toBe(201);
      expect(res.body.junk).toBe(true);
      expect(res.body.junkReasons).toContain('VERIFICATION_BYPASSED');
      expect(prisma.contact.create.mock.calls[0][0].data.status).toBe('Junk');
    } finally {
      if (prevSecret !== undefined) process.env.VOYAGR_HMAC_SECRET = prevSecret;
    }
  });

  test('manual channel (signed/JWT) + minimal payload → never junk (real auth)', async () => {
    // manual channel's verification returns {ok:true} with no stub/bypassed
    // flag (the surrounding JWT middleware already authenticated). Junk
    // classifier never fires regardless of how thin the payload is.
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/manual')
      .send({
        tenantSlug: 'travel-stall',
        phone: '+919866666666',
      });

    expect(res.status).toBe(201);
    expect(res.body.junk).toBe(false);
    expect(prisma.contact.create.mock.calls[0][0].data.status).toBe('Lead');
  });

  test('dedup merge branch does NOT carry junk flag in envelope (status untouched)', async () => {
    // When the phone matches an existing Contact, the merge branch fires
    // BEFORE the junk classifier — the existing Contact's status is not
    // overwritten and the junk fields are absent from the envelope.
    prisma.contact.findMany.mockResolvedValueOnce([
      { id: 99, phone: '+919877777777', email: 'existing@example.com', name: 'Existing' },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        phone: '+919877777777', // matches the existing Contact
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('merged');
    expect(res.body.contactId).toBe(99);
    // Junk fields are only on the "created" branch — merge envelope
    // intentionally omits them so operator UI doesn't show a "junk" badge
    // on an already-converted Contact.
    expect(res.body.junk).toBeUndefined();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});

// ─── Slice 12 — Meta lead-ads field_data normalizer integration ────────
//
// Contracts asserted (slice-12 additions):
//   - Route accepts Meta's raw webhook shape ({ field_data: [{name, values}] })
//     when channel=metaads and persists a Contact with the extracted
//     canonical fields (name / email / phone). field_data is NOT carried
//     through to Contact.create.
//   - Meta attribution tokens (leadgen_id / form_id / ad_id / campaign_id /
//     created_time) are preserved upstream of route consumption — the helper
//     attaches them to metaJson (route's _metaJson destructure discards
//     before contact.create, but the normalization itself is verified).
//   - The normalizer is a NO-OP for non-metaads channels — voyagr / whatsapp /
//     webform requests with an accidental field_data field pass through
//     untouched.
//   - Pre-normalized metaads callers (flat shape, no field_data) still work.

describe('POST /api/travel/inbound/leads/metaads — slice 12 Meta payload normalization', () => {
  test('raw Meta webhook payload → 201 + Contact created with extracted fields', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        leadgen_id: '1234567890',
        form_id: '987654321',
        ad_id: '111',
        campaign_id: '222',
        created_time: '2026-05-25T10:00:00+0000',
        field_data: [
          { name: 'full_name', values: ['Asha Verma'] },
          { name: 'email', values: ['asha@example.com'] },
          { name: 'phone_number', values: ['+919876543210'] },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('metaads');
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);

    const callArg = prisma.contact.create.mock.calls[0][0];
    // Extracted Meta fields landed on Contact.create.
    expect(callArg.data.name).toBe('Asha Verma');
    expect(callArg.data.email).toBe('asha@example.com');
    expect(callArg.data.phone).toBe('+919876543210');
    // tenantId came from the looked-up Tenant, NOT from the body.
    expect(callArg.data.tenantId).toBe(42);
    // source defaults to inbound:metaads.
    expect(callArg.data.source).toBe('inbound:metaads');
  });

  test('Meta payload with first_name + last_name field_data → buildName combines them', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        field_data: [
          { name: 'first_name', values: ['Rohan'] },
          { name: 'last_name', values: ['Kapoor'] },
          { name: 'email', values: ['rohan@example.com'] },
        ],
      });

    expect(res.status).toBe(201);
    const callArg = prisma.contact.create.mock.calls[0][0];
    // No `name` token in field_data → route's buildName() combines
    // firstName + lastName into "Rohan Kapoor".
    expect(callArg.data.name).toBe('Rohan Kapoor');
    expect(callArg.data.email).toBe('rohan@example.com');
  });

  test('Meta payload with only phone_number → email synthesized to placeholder (route default)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        leadgen_id: '999',
        field_data: [
          { name: 'full_name', values: ['Phone Only Lead'] },
          { name: 'phone_number', values: ['+919811112222'] },
        ],
      });

    expect(res.status).toBe(201);
    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.phone).toBe('+919811112222');
    expect(callArg.data.email).toMatch(/^inbound-metaads-\d+@imported\.local$/);
  });

  test('Meta payload missing both email and phone field_data → 400 MISSING_CONTACT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        leadgen_id: '1',
        field_data: [
          { name: 'full_name', values: ['No Contact Field'] },
          { name: 'custom_q', values: ['why are you here'] },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_CONTACT' });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('field_data is NOT carried through to Contact.create (route does not persist Meta-shape arrays)', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        field_data: [
          { name: 'full_name', values: ['Asha'] },
          { name: 'email', values: ['asha@example.com'] },
        ],
      });

    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.field_data).toBeUndefined();
  });

  test('pre-normalized metaads caller (flat body, no field_data) still works → 201', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        // Already-normalized flat shape (adapter pre-processed the
        // webhook payload before forwarding to the envelope).
        name: 'Pre-Normalized',
        email: 'pre@example.com',
        phone: '+919833334444',
      });

    expect(res.status).toBe(201);
    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.name).toBe('Pre-Normalized');
    expect(callArg.data.email).toBe('pre@example.com');
  });

  test('field_data on non-metaads channel is IGNORED (only metaads runs the normalizer)', async () => {
    // Voyagr (or any other channel) sending field_data is a producer bug;
    // the route does NOT run normalization for non-Meta channels. The
    // missing-contact check fires because field_data didn't get unpacked
    // into top-level fields.
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        field_data: [
          { name: 'email', values: ['leaked@example.com' ] },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_CONTACT' });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('Meta payload with caller-supplied flat field WINS over field_data', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        // Operator override (e.g. adapter that pre-applied a manual fix).
        name: 'Explicit Override',
        field_data: [
          { name: 'full_name', values: ['From Meta'] },
          { name: 'email', values: ['meta@example.com'] },
        ],
      });

    expect(res.status).toBe(201);
    const callArg = prisma.contact.create.mock.calls[0][0];
    expect(callArg.data.name).toBe('Explicit Override');
    // Email had no override → field_data wins.
    expect(callArg.data.email).toBe('meta@example.com');
  });

  test('Meta payload triggers anti-spam check on extracted text (viagra in full_name)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        field_data: [
          { name: 'full_name', values: ['Buy viagra now'] },
          { name: 'email', values: ['spam@example.com'] },
        ],
      });

    // Anti-spam runs over the normalized body (which now contains
    // "viagra" in the `name` field). The check serializes the body and
    // matches against patterns.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERIFICATION_FAILED');
    expect(res.body.reason).toMatch(/SPAM_PATTERN_VIAGRA/);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('Meta payload extraction handles 1-element values array semantics correctly', async () => {
    // Verifies the route doesn't accidentally pass through the array
    // shape ["Asha"] instead of the scalar "Asha".
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/metaads')
      .send({
        tenantSlug: 'travel-stall',
        field_data: [
          { name: 'full_name', values: ['Single Value'] },
          { name: 'email', values: ['sv@example.com'] },
        ],
      });

    expect(res.status).toBe(201);
    const callArg = prisma.contact.create.mock.calls[0][0];
    // Critical: must be a string, NOT an array.
    expect(typeof callArg.data.name).toBe('string');
    expect(callArg.data.name).toBe('Single Value');
    expect(typeof callArg.data.email).toBe('string');
    expect(callArg.data.email).toBe('sv@example.com');
  });
});

// ─── G001 — Touchpoint write per inbound lead (FR-3.5.1) ────────────────

describe('POST /inbound/leads/:channel — G001 Touchpoint write', () => {
  test('happy path → Touchpoint.create called once, touchpointId surfaced in envelope', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        name: 'Touchpoint Probe',
        email: 'tp@example.com',
        sourceUrl: 'https://tmc.voyagr.in/landing',
      });

    expect(res.status).toBe(201);
    expect(prisma.touchpoint.create).toHaveBeenCalledTimes(1);
    expect(res.body.touchpointId).toBe(5001);
  });

  test('touchpoint write failure does NOT block intake response (best-effort)', async () => {
    prisma.touchpoint.create.mockRejectedValueOnce(new Error('FK constraint'));

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'still@works.com',
      });

    expect(res.status).toBe(201);
    expect(res.body.touchpointId).toBeNull();
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
  });

  test('Touchpoint carries channel + source + tenantId from intake context', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp')
      .send({
        tenantSlug: 'travel-stall',
        phone: '+919876543210',
      });

    const tpCall = prisma.touchpoint.create.mock.calls[0][0];
    expect(tpCall.data).toMatchObject({
      tenantId: 42,
      channel: 'whatsapp',
      source: 'inbound:whatsapp',
    });
  });

  test('G005 — UTM + producer attribution fields pass through to Touchpoint', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'utm@example.com',
        utmCampaign: 'spring-tmc',
        utmTerm: 'school-trip',
        utmContent: 'banner-A',
        siteSlug: 'tmc',
        advertiserId: 'fb_advertiser_123',
        formId: 'voyagr_form_99',
        landingPage: 'https://tmc.voyagr.in/landing?ref=spring',
      });

    const tpCall = prisma.touchpoint.create.mock.calls[0][0];
    expect(tpCall.data).toMatchObject({
      utmCampaign: 'spring-tmc',
      utmTerm: 'school-trip',
      utmContent: 'banner-A',
      siteSlug: 'tmc',
      advertiserId: 'fb_advertiser_123',
      formId: 'voyagr_form_99',
      landingPage: 'https://tmc.voyagr.in/landing?ref=spring',
    });
    expect(tpCall.data.firstTouchAt).toBeInstanceOf(Date);
  });
});

// ─── G002 — idempotencyKey + (tenantId, source, idempotencyKey) UNIQUE ──

describe('POST /inbound/leads/:channel — G002 idempotency', () => {
  test('idempotencyKey persisted on Contact.create', async () => {
    await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'idem@example.com',
        idempotencyKey: 'voyagr_lead_abc123',
      });

    const call = prisma.contact.create.mock.calls[0][0];
    expect(call.data.idempotencyKey).toBe('voyagr_lead_abc123');
  });

  test('replay with same idempotencyKey → 200 + action=duplicate_suppressed (no Contact.create)', async () => {
    // First call's idemHit probe returns the existing Contact.
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 7777 });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'idem@example.com',
        idempotencyKey: 'voyagr_lead_abc123',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 7777,
      action: 'duplicate_suppressed',
      matchedRoutingRuleId: null,
      touchpointId: null,
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('P2002 race fallback → look up winner + return duplicate_suppressed', async () => {
    // Contact.create throws P2002; the catch block re-probes for the winner.
    const p2002 = new Error('Unique constraint failed');
    // @ts-ignore — synthesise the Prisma error shape
    p2002.code = 'P2002';
    prisma.contact.create.mockRejectedValueOnce(p2002);
    // The race-recovery findFirst (separate mock-call sequence) returns the winner.
    prisma.contact.findFirst
      .mockResolvedValueOnce(null) // initial idemHit probe — no hit pre-create
      .mockResolvedValueOnce({ id: 8888 }); // race-recovery lookup

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'race@example.com',
        idempotencyKey: 'race_key',
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('duplicate_suppressed');
    expect(res.body.id).toBe(8888);
  });

  test('intake without idempotencyKey skips the fast-path probe', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'noidem@example.com',
      });

    expect(res.status).toBe(201);
    const call = prisma.contact.create.mock.calls[0][0];
    expect(call.data.idempotencyKey).toBeNull();
  });
});

// ─── G006 — Intake response envelope (action / matchedRoutingRuleId /
//            touchpointId / subStatus) ─────────────────────────────────

describe('POST /inbound/leads/:channel — G006 envelope', () => {
  test('created branch envelope shape', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'envelope@example.com',
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('action', 'created');
    expect(res.body).toHaveProperty('matchedRoutingRuleId', null);
    expect(res.body).toHaveProperty('touchpointId');
  });

  test('merged branch envelope shape (cross-channel) — action=merged', async () => {
    // Email-only dedup (no phone), prior contact in webform channel
    prisma.contact.findUnique.mockResolvedValueOnce({
      id: 333,
      phone: null,
      email: 'merged@example.com',
      name: 'Merged Lead',
      source: 'inbound:webform',
      assignedToId: 55,
    });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/whatsapp') // cross-channel
      .send({
        tenantSlug: 'travel-stall',
        email: 'merged@example.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('merged');
    expect(res.body.touchpointId).toBe(5001);
  });

  test('merged branch same-channel → action=touchpoint_appended', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce({
      id: 333,
      phone: null,
      email: 'same@example.com',
      name: 'Same Channel',
      source: 'inbound:voyagr',
      assignedToId: null,
    });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'same@example.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('touchpoint_appended');
  });
});

// ─── G011 — Per-channel cooldowns ────────────────────────────────────

describe('POST /inbound/leads/:channel — G011 cooldowns', () => {
  test('no cooldown configured → request passes through unchanged', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'nocool@example.com',
      });

    expect(res.status).toBe(201);
  });

  test('cooldown active for this channel + identifier → 429 COOLDOWN_ACTIVE', async () => {
    // tenant.findUnique is called twice during intake — initial tenant
    // lookup AND the cooldown loader. The second call needs to return
    // the leadCaptureCooldownsJson value (G009 column shape).
    prisma.tenant.findUnique
      .mockResolvedValueOnce(TRAVEL_TENANT)
      .mockResolvedValueOnce({
        leadCaptureCooldownsJson: '{"voyagr":1800}',
      });
    // Cooldown probe is the FIRST findFirst call (idempotency + marketplace
    // short-circuit are skipped because we didn't send idempotencyKey or
    // externalLeadId). Returns a recent prior Contact for the same identifier.
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    prisma.contact.findFirst.mockResolvedValueOnce({
      id: 999,
      createdAt: twoMinAgo,
    });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'cooldown@example.com',
      });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: 'COOLDOWN_ACTIVE',
      action: 'cooldown_active',
      channel: 'voyagr',
    });
    expect(res.body.retryAfter).toBeGreaterThan(0);
    expect(res.body.lastLeadAt).toBeTruthy();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('cooldown for a DIFFERENT channel → does NOT block this intake', async () => {
    prisma.tenant.findUnique
      .mockResolvedValueOnce(TRAVEL_TENANT)
      .mockResolvedValueOnce({
        leadCaptureCooldownsJson: '{"voice":1800}',
      });

    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'other@example.com',
      });

    expect(res.status).toBe(201);
  });
});

// ─── G012 — Referral channel + referrerContactId ─────────────────────

describe('POST /inbound/leads/:channel — G012 referral', () => {
  test('referral channel without referrerContactId → 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/referral')
      .send({
        tenantSlug: 'travel-stall',
        email: 'ref@example.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAYLOAD');
    expect(res.body.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'referrerContactId' }),
      ]),
    );
  });

  test('referral happy path persists referrerContactId on Contact', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/referral')
      .send({
        tenantSlug: 'travel-stall',
        email: 'referee@example.com',
        referrerContactId: 1234,
      });

    expect(res.status).toBe(201);
    const call = prisma.contact.create.mock.calls[0][0];
    expect(call.data.referrerContactId).toBe(1234);
  });
});

// ─── G013 — Voice channel + subStatus=callback_pending ───────────────

describe('POST /inbound/leads/:channel — G013 voice', () => {
  test('voice channel happy → 201 + subStatus=callback_pending', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voice')
      .send({
        tenantSlug: 'travel-stall',
        callId: 'call_42',
        direction: 'inbound',
        phone: '+919876543210',
      });

    expect(res.status).toBe(201);
    expect(res.body.subStatus).toBe('callback_pending');
  });

  test('voice channel without callId → 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voice')
      .send({
        tenantSlug: 'travel-stall',
        direction: 'inbound',
        phone: '+919876543210',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAYLOAD');
  });

  test('non-voice channel → subStatus is null', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/voyagr')
      .send({
        tenantSlug: 'travel-stall',
        email: 'nonvoice@example.com',
      });

    expect(res.status).toBe(201);
    expect(res.body.subStatus).toBeNull();
  });
});

// ─── G004 — Channel-enum expansion + alias map ──────────────────────

describe('POST /inbound/leads/:channel — G004 channel expansion', () => {
  test('new G004 channel sms → 201 (validator passes with from + body)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/sms')
      .send({
        tenantSlug: 'travel-stall',
        from: '+919876543210',
        body: 'I want to book a Mecca trip',
        phone: '+919876543210',
      });

    expect(res.status).toBe(201);
  });

  test('new G004 channel email → 201 with subject + email', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/email')
      .send({
        tenantSlug: 'travel-stall',
        email: 'inbound@example.com',
        subject: 'Quote for school trip',
      });

    expect(res.status).toBe(201);
  });

  test('new G004 channel chat → 201 (universal validator only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/chat')
      .send({
        tenantSlug: 'travel-stall',
        email: 'chat@example.com',
      });

    expect(res.status).toBe(201);
  });

  test('canonical web_form alias accepted (back-compat with new producers)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/web_form')
      .send({
        tenantSlug: 'travel-stall',
        email: 'web@example.com',
      });

    expect(res.status).toBe(201);
  });

  test('canonical meta_ad alias accepted', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/meta_ad')
      .send({
        tenantSlug: 'travel-stall',
        email: 'meta@example.com',
      });

    expect(res.status).toBe(201);
  });

  test('truly bogus channel → 400 INVALID_CHANNEL', async () => {
    const res = await request(makeApp())
      .post('/api/travel/inbound/leads/quantum_fax')
      .send({
        tenantSlug: 'travel-stall',
        email: 'x@y.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CHANNEL');
  });
});

// ─── G015 — Canonical /api/leads/intake alias ──────────────────────

describe('POST /api/leads/intake — G015 canonical alias', () => {
  function makeAliasApp() {
    const app = express();
    app.use(express.json());
    const aliasRouter = requireCJS('../../routes/leads_intake');
    app.use('/api/leads', aliasRouter);
    return app;
  }

  test('body-channel mode forwards to the canonical handler → 201', async () => {
    const res = await request(makeAliasApp())
      .post('/api/leads/intake')
      .send({
        channel: 'voyagr',
        tenantSlug: 'travel-stall',
        email: 'alias@example.com',
      });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('voyagr');
  });

  test('missing body.channel → 400 MISSING_CHANNEL', async () => {
    const res = await request(makeAliasApp())
      .post('/api/leads/intake')
      .send({
        tenantSlug: 'travel-stall',
        email: 'no-channel@example.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_CHANNEL');
  });

  test('canonical channel name (voice) works through the alias', async () => {
    const res = await request(makeAliasApp())
      .post('/api/leads/intake')
      .send({
        channel: 'voice',
        tenantSlug: 'travel-stall',
        callId: 'call_99',
        direction: 'inbound',
        phone: '+919876543210',
      });

    expect(res.status).toBe(201);
  });

  test('empty channel string → 400', async () => {
    const res = await request(makeAliasApp())
      .post('/api/leads/intake')
      .send({
        channel: '   ',
        tenantSlug: 'travel-stall',
        email: 'x@y.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_CHANNEL');
  });
});
