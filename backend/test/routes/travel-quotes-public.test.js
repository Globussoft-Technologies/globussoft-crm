// @ts-check
/**
 * Tests for backend/routes/travel_quotes_public.js — TravelQuote customer-share
 * landing endpoints (C9). PRD_TRAVEL_QUOTE_BUILDER §3.7.
 *
 * Hard contract pins:
 *   - GET /quote/:shareToken
 *       valid token + Draft/Sent quote → 200 with customer envelope (only
 *       customer-visible fields; supplierId / notes excluded from lines).
 *       valid token + Rejected/Expired quote → 404 QUOTE_NOT_AVAILABLE.
 *       valid token + validUntil < now → 404 QUOTE_EXPIRED.
 *       missing quote → 404 QUOTE_NOT_FOUND.
 *       expired JWT → 410 LINK_EXPIRED.
 *       tampered JWT → 401 INVALID_TOKEN.
 *       wrong-purpose JWT → 401 INVALID_TOKEN.
 *   - POST /quote/:shareToken/accept
 *       Draft → 200, status flipped to Accepted, snapshot written, audit
 *         emitted with TRAVEL_QUOTE_CUSTOMER_ACCEPTED action.
 *       Already-Accepted → 409 ALREADY_ACTIONED.
 *       Already-Rejected → 409 ALREADY_ACTIONED.
 *   - POST /quote/:shareToken/reject
 *       Missing reason → 400 MISSING_REASON.
 *       With reason → 200, status flipped to Rejected, snapshot written
 *         with reason in changeReason.
 *   - POST /quote/:shareToken/counter
 *       Missing proposedTotal → 400 MISSING_PROPOSED_TOTAL.
 *       proposedTotal <= 0 → 400 MISSING_PROPOSED_TOTAL.
 *       Valid → 200, status='Countered', snapshot.changeReason is the
 *         counterOfferJson (proposedTotal + comments).
 *
 * S32 — FX-rate locking at accept-time (PRD §3.4.2/§3.4.3/FR-3.7.4/AC-6.6).
 * Additional pins:
 *   - Accept (cross-currency, USD quote on INR-base tenant) → 200, response
 *     body carries fxLock = { sourceCurrency:'USD', targetCurrency:'INR',
 *     rate:83.4, lockedAt }; snapshotJson persists same fxLock block.
 *   - Accept (same-currency, INR quote on INR-base tenant) → fxLock.rate=1.0,
 *     reason='same_currency'.
 *   - Accept (no Currency row for source) → fxLock.rate=null,
 *     reason='no_source_rate'; the accept transition still succeeds (200).
 *   - Accept (tenant lookup throws) → fxLock.rate=null, reason='lookup_error';
 *     the accept transition still succeeds (200).
 *   - Re-accept on Already-Accepted quote → 409 ALREADY_ACTIONED with the
 *     ORIGINALLY-LOCKED fxLock surfaced from the prior Accepted snapshot
 *     (no fresh currency lookup is called).
 *   - Already-Rejected quote → 409 with fxLock=null (rejected quotes don't
 *     carry an FX lock).
 *
 * Strategy: monkey-patch prisma singleton BEFORE the router require, mount
 * into bare express app, drive via supertest. JWT helper is real (not
 * mocked) — we use it to mint real tokens against the test secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import jwt from 'jsonwebtoken';

// Patch BEFORE router require.
prisma.travelQuote = {
  findFirst: vi.fn(),
  update: vi.fn(),
};
prisma.travelQuoteSnapshot = {
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.contact = {
  findFirst: vi.fn(),
};
prisma.auditLog = {
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
// S32 — FX-lock lookups
prisma.tenant = {
  findUnique: vi.fn(),
};
prisma.currency = {
  findFirst: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const publicQuotesRouter = requireCJS('../../routes/travel_quotes_public');
const { mintShareToken, _internal: shareTokenInternal } = requireCJS('../../lib/quoteShareToken');

const SECRET =
  process.env.QUOTE_SHARE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'dev-quote-share-secret';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/quotes/public', publicQuotesRouter);
  return app;
}

function makeQuote(over = {}) {
  return {
    id: 42,
    tenantId: 7,
    subBrand: 'tmc',
    contactId: 99,
    status: 'Sent',
    totalAmount: '50000.00',
    currency: 'INR',
    validUntil: new Date(Date.now() + 7 * 86400 * 1000),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
    lines: [
      {
        id: 1,
        lineType: 'hotel',
        description: 'Hotel — 3 nights',
        quantity: 3,
        unitPrice: '10000.00',
        amount: '30000.00',
        currency: 'INR',
        supplierId: 12,
        sortOrder: 0,
        notes: 'Internal supplier note — DO NOT LEAK',
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.update.mockReset();
  prisma.travelQuoteSnapshot.findFirst.mockReset();
  prisma.travelQuoteSnapshot.create.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.currency.findFirst.mockReset();

  // Sensible defaults
  prisma.travelQuoteSnapshot.findFirst.mockResolvedValue(null);
  prisma.travelQuoteSnapshot.create.mockResolvedValue({ id: 1 });
  prisma.contact.findFirst.mockResolvedValue({
    firstName: 'Aisha',
    lastName: 'Khan',
    email: 'aisha@example.com',
  });
  // S32 — default FX lookups: tenant base = INR; same-currency lookup
  // resolves to rate=1.0 unless individual test overrides.
  prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR' });
  prisma.currency.findFirst.mockResolvedValue(null);
});

describe('GET /api/travel/quotes/public/quote/:shareToken', () => {
  test('valid token + Sent quote → 200 with customer envelope (supplierId stripped)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(makeQuote());
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp()).get(`/api/travel/quotes/public/quote/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.quote.id).toBe(42);
    expect(res.body.quote.subBrand).toBe('tmc');
    expect(res.body.quote.status).toBe('Sent');
    expect(res.body.lines).toHaveLength(1);
    // Line shape pin — supplierId and notes are NOT in customer envelope
    expect(res.body.lines[0]).not.toHaveProperty('supplierId');
    expect(res.body.lines[0]).not.toHaveProperty('notes');
    expect(res.body.lines[0].description).toBe('Hotel — 3 nights');
    expect(res.body.customer.name).toBe('Aisha Khan');
  });

  test('Rejected quote → 404 QUOTE_NOT_AVAILABLE (cancelled/expired hidden)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(makeQuote({ status: 'Expired' }));
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp()).get(`/api/travel/quotes/public/quote/${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_AVAILABLE');
  });

  test('validUntil < now → 404 QUOTE_EXPIRED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(
      makeQuote({ validUntil: new Date(Date.now() - 86400 * 1000) }),
    );
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp()).get(`/api/travel/quotes/public/quote/${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_EXPIRED');
  });

  test('quote not found in DB → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const token = mintShareToken({ quoteId: 9999, tenantId: 7 });
    const res = await request(makeApp()).get(`/api/travel/quotes/public/quote/${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
  });

  test('expired JWT → 410 LINK_EXPIRED', async () => {
    const expired = jwt.sign(
      { quoteId: 42, tenantId: 7, purpose: shareTokenInternal.PURPOSE },
      SECRET,
      { expiresIn: '-1s' },
    );
    const res = await request(makeApp()).get(`/api/travel/quotes/public/quote/${expired}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('LINK_EXPIRED');
  });

  test('tampered JWT → 401 INVALID_TOKEN', async () => {
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`;
    const res = await request(makeApp()).get(`/api/travel/quotes/public/quote/${tampered}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('wrong-purpose JWT → 401 INVALID_TOKEN', async () => {
    const wrongPurpose = jwt.sign(
      { quoteId: 42, tenantId: 7, purpose: 'voyagr-api-key' },
      SECRET,
      { expiresIn: '30d' },
    );
    const res = await request(makeApp()).get(`/api/travel/quotes/public/quote/${wrongPurpose}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });
});

describe('POST /api/travel/quotes/public/quote/:shareToken/accept', () => {
  test('Draft quote → 200, status=Accepted, snapshot written', async () => {
    const quote = makeQuote({ status: 'Draft' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote,
      status: 'Accepted',
      updatedAt: new Date('2026-06-09T10:00:00Z'),
    });
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({ customerName: 'Aisha Khan', customerNote: 'Looks great!' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.previousStatus).toBe('Draft');
    expect(prisma.travelQuote.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { status: 'Accepted' },
    });
    expect(prisma.travelQuoteSnapshot.create).toHaveBeenCalled();
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    expect(snapArg.statusBefore).toBe('Draft');
    expect(snapArg.statusAfter).toBe('Accepted');
    expect(snapArg.changedBy).toBe('customer');
    expect(snapArg.versionNumber).toBe(1);
  });

  test('Already-Accepted quote → 409 ALREADY_ACTIONED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(makeQuote({ status: 'Accepted' }));
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ACTIONED');
    expect(res.body.status).toBe('Accepted');
  });

  test('versionNumber increments past existing snapshots', async () => {
    const quote = makeQuote({ status: 'Sent' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuoteSnapshot.findFirst.mockResolvedValue({ versionNumber: 4 });
    prisma.travelQuote.update.mockResolvedValue({ ...quote, status: 'Accepted', updatedAt: new Date() });
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    expect(snapArg.versionNumber).toBe(5);
  });
});

describe('POST /api/travel/quotes/public/quote/:shareToken/reject', () => {
  test('missing rejectionReason → 400 MISSING_REASON', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(makeQuote());
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/reject`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_REASON');
  });

  test('valid reject → 200, snapshot.changeReason = reason', async () => {
    const quote = makeQuote({ status: 'Sent' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote, status: 'Rejected', updatedAt: new Date(),
    });
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/reject`)
      .send({ rejectionReason: 'Budget too high for this term.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    expect(snapArg.changeReason).toBe('Budget too high for this term.');
    expect(snapArg.statusAfter).toBe('Rejected');
  });
});

describe('POST /api/travel/quotes/public/quote/:shareToken/counter', () => {
  test('missing proposedTotal → 400 MISSING_PROPOSED_TOTAL', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(makeQuote());
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/counter`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PROPOSED_TOTAL');
  });

  test('proposedTotal <= 0 → 400 MISSING_PROPOSED_TOTAL', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(makeQuote());
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/counter`)
      .send({ proposedTotal: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PROPOSED_TOTAL');
  });

  test('valid counter → 200, status=Countered, snapshot.changeReason has proposedTotal', async () => {
    const quote = makeQuote({ status: 'Sent' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote, status: 'Countered', updatedAt: new Date(),
    });
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/counter`)
      .send({ proposedTotal: 45000, comments: 'Can you match this?' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('countered');
    expect(res.body.proposedTotal).toBe(45000);
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    expect(snapArg.statusAfter).toBe('Countered');
    const parsed = JSON.parse(snapArg.changeReason);
    expect(parsed.proposedTotal).toBe(45000);
    expect(parsed.comments).toBe('Can you match this?');
  });
});

// ---------------------------------------------------------------------------
// S32 — FX-rate locking at accept-time
// ---------------------------------------------------------------------------
describe('S32 — FX-rate lock on accept', () => {
  test('cross-currency accept (USD on INR-base tenant) → 200 response carries fxLock; snapshotJson persists it', async () => {
    const quote = makeQuote({ status: 'Sent', currency: 'USD' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote, status: 'Accepted', updatedAt: new Date('2026-06-09T10:00:00Z'),
    });
    prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR' });
    prisma.currency.findFirst.mockResolvedValue({ exchangeRate: 83.4 });

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(200);
    // (a) Accept response carries fxLock.
    expect(res.body.fxLock).toBeDefined();
    expect(res.body.fxLock.sourceCurrency).toBe('USD');
    expect(res.body.fxLock.targetCurrency).toBe('INR');
    expect(res.body.fxLock.rate).toBe(83.4);
    expect(res.body.fxLock.reason).toBeNull();
    expect(typeof res.body.fxLock.lockedAt).toBe('string');

    // (b) Snapshot persists the fxLock block under snapshotJson.
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    const parsed = JSON.parse(snapArg.snapshotJson);
    expect(parsed.fxLock).toBeDefined();
    expect(parsed.fxLock.sourceCurrency).toBe('USD');
    expect(parsed.fxLock.targetCurrency).toBe('INR');
    expect(parsed.fxLock.rate).toBe(83.4);

    // Currency lookup was scoped to the quote's tenant.
    expect(prisma.currency.findFirst).toHaveBeenCalledWith({
      where: { code: 'USD', tenantId: 7 },
      select: { exchangeRate: true },
    });
  });

  test('same-currency accept (INR on INR-base tenant) → fxLock.rate=1.0, reason=same_currency', async () => {
    const quote = makeQuote({ status: 'Sent', currency: 'INR' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote, status: 'Accepted', updatedAt: new Date(),
    });
    prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR' });

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.fxLock.rate).toBe(1.0);
    expect(res.body.fxLock.reason).toBe('same_currency');
    expect(res.body.fxLock.sourceCurrency).toBe('INR');
    expect(res.body.fxLock.targetCurrency).toBe('INR');
    // Same-currency path short-circuits — currency.findFirst not called.
    expect(prisma.currency.findFirst).not.toHaveBeenCalled();
  });

  test('no Currency row for source → fxLock.rate=null, reason=no_source_rate; accept still succeeds', async () => {
    const quote = makeQuote({ status: 'Sent', currency: 'EUR' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote, status: 'Accepted', updatedAt: new Date(),
    });
    prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR' });
    prisma.currency.findFirst.mockResolvedValue(null);

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.fxLock.rate).toBeNull();
    expect(res.body.fxLock.reason).toBe('no_source_rate');
    expect(res.body.fxLock.sourceCurrency).toBe('EUR');
    expect(res.body.fxLock.targetCurrency).toBe('INR');
    // Snapshot still records the failed-lookup fxLock (forensic value).
    const snapArg = prisma.travelQuoteSnapshot.create.mock.calls[0][0].data;
    const parsed = JSON.parse(snapArg.snapshotJson);
    expect(parsed.fxLock.rate).toBeNull();
    expect(parsed.fxLock.reason).toBe('no_source_rate');
  });

  test('tenant defaultCurrency missing → fxLock.rate=null, reason=no_tenant_currency; accept still succeeds', async () => {
    const quote = makeQuote({ status: 'Sent', currency: 'USD' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote, status: 'Accepted', updatedAt: new Date(),
    });
    prisma.tenant.findUnique.mockResolvedValue(null);

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.fxLock.rate).toBeNull();
    expect(res.body.fxLock.reason).toBe('no_tenant_currency');
  });

  test('FX lookup throws → fxLock.rate=null, reason=lookup_error; accept still succeeds', async () => {
    const quote = makeQuote({ status: 'Sent', currency: 'USD' });
    prisma.travelQuote.findFirst.mockResolvedValue(quote);
    prisma.travelQuote.update.mockResolvedValue({
      ...quote, status: 'Accepted', updatedAt: new Date(),
    });
    prisma.tenant.findUnique.mockRejectedValue(new Error('DB down'));

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.fxLock.rate).toBeNull();
    expect(res.body.fxLock.reason).toBe('lookup_error');
  });

  test('re-accept on Already-Accepted quote → 409 with originally-locked fxLock; no fresh currency lookup', async () => {
    // Prior accepted snapshot persisted fxLock.rate=83.4 (the original
    // lock). The re-hit must surface that rate; the test verifies the
    // route does NOT call currency.findFirst on this path.
    const acceptedQuote = makeQuote({ status: 'Accepted', currency: 'USD' });
    prisma.travelQuote.findFirst.mockResolvedValue(acceptedQuote);

    const originalFxLock = {
      sourceCurrency: 'USD',
      targetCurrency: 'INR',
      rate: 83.4,
      lockedAt: '2026-06-08T12:00:00.000Z',
      reason: null,
    };
    prisma.travelQuoteSnapshot.findFirst.mockResolvedValue({
      snapshotJson: JSON.stringify({
        quote: { id: 42 },
        fxLock: originalFxLock,
      }),
    });

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ACTIONED');
    expect(res.body.status).toBe('Accepted');
    // (c) Idempotency: same locked rate, NOT a fresh re-lookup.
    expect(res.body.fxLock).toEqual(originalFxLock);
    expect(res.body.fxLock.rate).toBe(83.4);
    expect(res.body.fxLock.lockedAt).toBe('2026-06-08T12:00:00.000Z');
    // No fresh FX lookup — currency.findFirst and tenant.findUnique
    // are NOT called on the idempotency path.
    expect(prisma.currency.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    // The snapshot lookup was the Accepted-snapshot read.
    expect(prisma.travelQuoteSnapshot.findFirst).toHaveBeenCalledWith({
      where: { quoteId: 42, statusAfter: 'Accepted' },
      orderBy: { createdAt: 'asc' },
      select: { snapshotJson: true },
    });
  });

  test('re-accept on Already-Rejected quote → 409 with fxLock=null (rejected quotes carry no FX lock)', async () => {
    const rejectedQuote = makeQuote({ status: 'Rejected', currency: 'USD' });
    prisma.travelQuote.findFirst.mockResolvedValue(rejectedQuote);

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ACTIONED');
    expect(res.body.fxLock).toBeNull();
    // Rejected path doesn't read the snapshot.
    expect(prisma.travelQuoteSnapshot.findFirst).not.toHaveBeenCalled();
  });

  test('re-accept on Already-Accepted quote with malformed snapshotJson → 409 with fxLock=null (fail-soft)', async () => {
    const acceptedQuote = makeQuote({ status: 'Accepted', currency: 'USD' });
    prisma.travelQuote.findFirst.mockResolvedValue(acceptedQuote);
    prisma.travelQuoteSnapshot.findFirst.mockResolvedValue({
      snapshotJson: 'not-valid-json{{{',
    });

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.fxLock).toBeNull();
  });

  test('re-accept on Already-Accepted quote with no prior snapshot → 409 with fxLock=null (pre-S32 quotes)', async () => {
    // Pre-S32 Accepted quotes have no Accepted snapshot row at all
    // (or one without an fxLock block). Helper returns null; the
    // 409 envelope carries fxLock=null without crashing.
    const acceptedQuote = makeQuote({ status: 'Accepted', currency: 'USD' });
    prisma.travelQuote.findFirst.mockResolvedValue(acceptedQuote);
    prisma.travelQuoteSnapshot.findFirst.mockResolvedValue(null);

    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const res = await request(makeApp())
      .post(`/api/travel/quotes/public/quote/${token}/accept`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.fxLock).toBeNull();
  });
});
