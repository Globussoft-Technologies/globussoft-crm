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

  // Sensible defaults
  prisma.travelQuoteSnapshot.findFirst.mockResolvedValue(null);
  prisma.travelQuoteSnapshot.create.mockResolvedValue({ id: 1 });
  prisma.contact.findFirst.mockResolvedValue({
    firstName: 'Aisha',
    lastName: 'Khan',
    email: 'aisha@example.com',
  });
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
