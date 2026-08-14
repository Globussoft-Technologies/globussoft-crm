// Unit tests for backend/routes/gmail.js's POST /messages/:messageId/webcheckin
// — the Travel-vertical "email → web check-in" extraction endpoint.
//
// Why this file exists
// ─────────────────────
// The route used to call the Gemini SDK directly (bare GEMINI_API_KEY, no
// tenant scoping, no credit deduction, no LlmCallLog). It now goes through
// lib/aiGateway.runAiRequest with a multimodal message (email text +
// PDF/image attachments as inline data) — the mandatory resolve/gate/log/
// deduct entry point every AI feature in the CRM shares. This file pins:
//   - the route requires a travel-vertical tenant (requireTravelTenant)
//   - it resolves the connected Gmail account, downloads attachments, and
//     sends a multimodal aiGateway.runAiRequest call
//   - the multimodal content array shape (text part + image parts for
//     image/PDF attachments only — other mimetypes are skipped)
//   - a friendly-blocked AI response (no BYOK/funded subscription) surfaces
//     as 402, not the generic 502 "AI_ERROR" path
//   - malformed / non-flight / low-confidence / incomplete extractions each
//     map to their documented 4xx code
//   - a successful extraction creates/reuses a Contact and creates a
//     WebCheckin row scoped to the requesting tenant
//
// Mocking strategy
// ─────────────────
// Mirrors test/routes/calendar-google.test.js — monkey-patch googleapis'
// `google.gmail` + `google.auth.OAuth2` on the live module object BEFORE the
// router is required (the route captures whatever they point to at
// require-time). aiGateway is mocked via vi.mock + Module._cache injection,
// same pattern used across this session's other aiGateway migrations.
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── Auth middleware bypass ─────────────────────────────────────────
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// ─── googleapis monkey-patch ────────────────────────────────────────
const googleapis = requireCJS('googleapis');

const oauth2State = {
  setCredentials: vi.fn(),
  on: vi.fn(),
};
const gmailState = {
  messages: {
    get: vi.fn(),
  },
  attachments: {
    get: vi.fn(),
  },
};

googleapis.google.auth.OAuth2 = function FakeOAuth2() {
  return {
    setCredentials: (...args) => oauth2State.setCredentials(...args),
    on: (...args) => oauth2State.on(...args),
  };
};

googleapis.google.gmail = function fakeGmail() {
  return {
    users: {
      messages: {
        get: (...args) => gmailState.messages.get(...args),
        attachments: {
          get: (...args) => gmailState.attachments.get(...args),
        },
      },
    },
  };
};

// ─── aiGateway mock (must hoist BEFORE the route is required) ────────────
const { mockRunAiRequest } = vi.hoisted(() => ({ mockRunAiRequest: vi.fn() }));
vi.mock('../../lib/aiGateway', () => ({
  default: { runAiRequest: mockRunAiRequest },
  runAiRequest: mockRunAiRequest,
}));
const aiGatewayPath = requireCJS.resolve('../../lib/aiGateway');
require('node:module')._cache[aiGatewayPath] = {
  id: aiGatewayPath, filename: aiGatewayPath, loaded: true,
  exports: { runAiRequest: mockRunAiRequest },
  children: [], paths: [],
};

// ─── Prisma singleton patching ──────────────────────────────────────
prisma.gmailIntegration = { findUnique: vi.fn(), update: vi.fn() };
prisma.tenant = { findUnique: vi.fn() };
prisma.contact = { findFirst: vi.fn(), create: vi.fn() };
prisma.webCheckin = { create: vi.fn() };

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';

import express from 'express';
import request from 'supertest';
const gmailRouter = requireCJS('../../routes/gmail');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/gmail', gmailRouter);
  return app;
}

function gmailMessagePayload({ subject = 'Your Emirates E-Ticket', from = 'noreply@emirates.com', attachments = [] } = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    payload: {
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: from },
        { name: 'Date', value: 'Mon, 10 Aug 2026 10:00:00 +0000' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from('Your flight EK-571 is confirmed. PNR: ABC123.').toString('base64url') },
      parts: attachments.length
        ? attachments.map((a, i) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            body: { attachmentId: `att-${i}` },
          }))
        : undefined,
    },
    snippet: 'Your flight is confirmed.',
  };
}

beforeEach(() => {
  oauth2State.setCredentials.mockReset();
  oauth2State.on.mockReset();
  gmailState.messages.get.mockReset();
  gmailState.attachments.get.mockReset();

  prisma.gmailIntegration.findUnique.mockReset();
  prisma.gmailIntegration.update.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.contact.create.mockReset();
  prisma.webCheckin.create.mockReset();

  mockRunAiRequest.mockReset();

  prisma.gmailIntegration.findUnique.mockResolvedValue({
    userId: 7, tenantId: 1, provider: 'google',
    accessToken: 'at-stub', refreshToken: 'rt-stub', expiresAt: new Date(Date.now() + 3600_000),
  });
  prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'travel', name: 'Acme Travel', slug: 'acme' });
  gmailState.messages.get.mockResolvedValue({ data: gmailMessagePayload() });
});

const VALID_EXTRACTION = {
  isFlightTicket: true,
  confidence: 0.92,
  passengerName: 'Jane Doe',
  passengerEmail: 'jane@example.com',
  passengerPhone: null,
  pnr: 'ABC123',
  airlineCode: 'EK',
  flightNumber: 'EK-571',
  departureAt: '2026-08-15T10:30:00Z',
  seatPref: null,
  mealPref: null,
  notes: null,
};

describe('POST /messages/:messageId/webcheckin — vertical guard', () => {
  test('403 when tenant is not travel-vertical', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'wellness', name: 'Spa Co', slug: 'spa' });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(mockRunAiRequest).not.toHaveBeenCalled();
  });
});

describe('POST /messages/:messageId/webcheckin — AI access', () => {
  test('friendly-blocked AI access (no BYOK, no funded subscription) → 402, not 502', async () => {
    const err = new Error('Your organization has not configured an AI provider yet.');
    err.friendly = true;
    err.code = 'AI_NOT_CONFIGURED';
    mockRunAiRequest.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
    expect(prisma.webCheckin.create).not.toHaveBeenCalled();
  });

  test('non-friendly AI failure → 502 AI_ERROR', async () => {
    mockRunAiRequest.mockRejectedValue(new Error('upstream 500'));

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_ERROR');
  });

  test('AI request is scoped to the requesting tenantId + userId', async () => {
    mockRunAiRequest.mockResolvedValue({ text: JSON.stringify(VALID_EXTRACTION) });
    prisma.contact.findFirst.mockResolvedValue({ id: 55 });
    prisma.webCheckin.create.mockResolvedValue({ id: 1, pnr: 'ABC123' });

    await request(makeApp({ tenantId: 3, userId: 9 }))
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(mockRunAiRequest).toHaveBeenCalledTimes(1);
    const arg = mockRunAiRequest.mock.calls[0][0];
    expect(arg.tenantId).toBe(3);
    expect(arg.userId).toBe(9);
    expect(arg.task).toBe('webcheckin-extraction');
  });

  test('multimodal content includes text + image-part attachments, skips non-image/pdf mimetypes', async () => {
    gmailState.messages.get.mockResolvedValue({
      data: gmailMessagePayload({
        attachments: [
          { filename: 'ticket.pdf', mimeType: 'application/pdf' },
          { filename: 'boarding.png', mimeType: 'image/png' },
          { filename: 'ignore.exe', mimeType: 'application/octet-stream' },
        ],
      }),
    });
    gmailState.attachments.get.mockImplementation(({ id }) =>
      Promise.resolve({ data: { data: Buffer.from(`data-${id}`).toString('base64url') } }));
    mockRunAiRequest.mockResolvedValue({ text: JSON.stringify(VALID_EXTRACTION) });
    prisma.contact.findFirst.mockResolvedValue({ id: 55 });
    prisma.webCheckin.create.mockResolvedValue({ id: 1, pnr: 'ABC123' });

    await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    const arg = mockRunAiRequest.mock.calls[0][0];
    const content = arg.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('text');
    const imageParts = content.filter((p) => p.type === 'image');
    expect(imageParts).toHaveLength(2);
    expect(imageParts.map((p) => p.mimeType).sort()).toEqual(['application/pdf', 'image/png']);
  });
});

describe('POST /messages/:messageId/webcheckin — extraction validation', () => {
  test('AI returns unparseable text → 502 AI_MALFORMED', async () => {
    mockRunAiRequest.mockResolvedValue({ text: 'not json' });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_MALFORMED');
  });

  test('isFlightTicket=false → 400 NOT_FLIGHT_TICKET', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: JSON.stringify({ isFlightTicket: false, confidence: 0 }),
    });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_FLIGHT_TICKET');
  });

  test('confidence < 0.5 → 400 LOW_CONFIDENCE', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: JSON.stringify({ ...VALID_EXTRACTION, confidence: 0.3 }),
    });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOW_CONFIDENCE');
  });

  test('missing departureAt → 400 MISSING_DEPARTURE', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: JSON.stringify({ ...VALID_EXTRACTION, departureAt: null }),
    });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEPARTURE');
  });

  test('missing required fields (e.g. pnr) → 400 INCOMPLETE_EXTRACTION', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: JSON.stringify({ ...VALID_EXTRACTION, pnr: '' }),
    });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INCOMPLETE_EXTRACTION');
  });
});

describe('POST /messages/:messageId/webcheckin — happy path', () => {
  test('creates a new Contact + WebCheckin row when no existing contact matches', async () => {
    mockRunAiRequest.mockResolvedValue({ text: JSON.stringify(VALID_EXTRACTION) });
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 77 });
    prisma.webCheckin.create.mockResolvedValue({ id: 1, pnr: 'ABC123', passengerName: 'Jane Doe' });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.contactId).toBe(77);
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 1, name: 'Jane Doe', email: 'jane@example.com', source: 'email-webcheckin',
      }),
    });
    expect(prisma.webCheckin.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 1, contactId: 77, pnr: 'ABC123', airlineCode: 'EK', flightNumber: 'EK-571',
        passengerName: 'Jane Doe', status: 'pending',
      }),
    });
  });

  test('reuses an existing Contact matched by email', async () => {
    mockRunAiRequest.mockResolvedValue({ text: JSON.stringify(VALID_EXTRACTION) });
    prisma.contact.findFirst.mockResolvedValue({ id: 55 });
    prisma.webCheckin.create.mockResolvedValue({ id: 1, pnr: 'ABC123' });

    const res = await request(makeApp())
      .post('/api/gmail/messages/msg-1/webcheckin');

    expect(res.status).toBe(201);
    expect(res.body.contactId).toBe(55);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});
