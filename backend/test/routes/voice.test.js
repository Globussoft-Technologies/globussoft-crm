// @ts-check
/**
 * Unit + integration tests for backend/routes/voice.js — pins the Twilio
 * softphone integration surface: browser-SDK access token endpoint, REST
 * outbound-call initiation, Twilio status-callback webhook (unauthed CDR
 * ingest), TwiML routing webhook, recent-sessions listing, and the
 * end-call endpoint.
 *
 * Why this file exists
 * ────────────────────
 *   routes/voice.js is a 249-LOC six-endpoint module mixing four distinct
 *   concerns that have ZERO unit coverage before this file:
 *     1. POST /token — authed; mints a Twilio Voice JS SDK Access Token
 *        for the calling user when ALL of TWILIO_ACCOUNT_SID,
 *        TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID
 *        are set. Falls back to `{ error, token: null }` (still HTTP 200!)
 *        when any are missing — the frontend treats null-token as
 *        "softphone unavailable" rather than crashing.
 *     2. POST /call — authed; REST-initiates an outbound call and
 *        records a VoiceSession row tagged with the caller's userId +
 *        tenantId + (optional) contactId.
 *     3. POST /webhook/status — UNAUTHED status callback from Twilio.
 *        Maps Twilio's lowercase statuses ("ringing"/"completed"/"busy")
 *        to the schema's enum-style values (RINGING/COMPLETED/FAILED),
 *        updates the VoiceSession by sessionId, and on COMPLETED also
 *        backfills a CallLog row so historical reporting picks it up.
 *     4. POST /webhook/twiml — UNAUTHED; emits the <Dial> TwiML XML
 *        Twilio fetches when routing the outgoing leg. The `To` value
 *        from the body is interpolated into the XML, so the route MUST
 *        strip XML-unsafe characters (< > & ' ") to prevent injection.
 *     5. GET /sessions — authed; recent-50 VoiceSessions for the caller's
 *        tenant, ordered desc by createdAt.
 *     6. POST /end/:sessionId — authed; cross-tenant guard, optional
 *        twilio REST update (best-effort), DB update to COMPLETED.
 *
 * What this file pins (13 cases)
 * ──────────────────────────────
 *   POST /token (configured/unconfigured)
 *   1. /token returns `{ error: 'Twilio not configured', token: null }`
 *      with HTTP 200 when API-key env vars are missing — the route
 *      DELIBERATELY does not 500 here so the frontend can no-op the
 *      softphone widget without showing a hard error.
 *
 *   POST /call
 *   2. /call returns 400 when `to` is missing from the body.
 *   3. /call returns `{ error: 'Twilio not configured', token: null }`
 *      (HTTP 200, not 500) when env is missing — same no-op contract
 *      as /token.
 *
 *   POST /webhook/status (no auth)
 *   4. /webhook/status → 400 when CallSid is missing (the lookup key).
 *   5. /webhook/status → maps Twilio's lowercase "ringing" / "completed" /
 *      "busy" / "no-answer" / "canceled" / "failed" to the schema's
 *      uppercase enum-style values. Unknown statuses fall through to
 *      "IN_PROGRESS" (defensive default).
 *   6. /webhook/status → updates the VoiceSession matched by CallSid,
 *      stamps endedAt when status is COMPLETED or FAILED, and uses
 *      `?? session.duration` so a missing CallDuration does NOT
 *      overwrite a previously-stamped duration with null.
 *   7. /webhook/status → on COMPLETED, ALSO creates a CallLog row with
 *      the session's tenantId + userId + contactId + the Twilio-supplied
 *      From/To phone numbers, so completed calls land in historical
 *      reporting.
 *   8. /webhook/status → if VoiceSession is NOT found (rogue/replay
 *      webhook for an unknown CallSid), the route still 200s with
 *      <Response/> and does NOT create a CallLog (no silent-orphan).
 *
 *   POST /webhook/twiml (no auth)
 *   9. /webhook/twiml → strips XML-unsafe characters from the body's
 *      `To` value before interpolating into <Dial>. Prevents XML
 *      injection via crafted Twilio callbacks.
 *  10. /webhook/twiml → accepts both `To` (Twilio's canonical casing)
 *      and `to` (lowercase legacy) — pinned because the body shape
 *      from Twilio occasionally varies.
 *
 *   GET /sessions
 *  11. /sessions → scopes findMany by req.user.tenantId, orders by
 *      createdAt desc, caps at take:50 (recent-sessions pagination
 *      window). Returns the rows as-is — no PII redaction.
 *
 *   POST /end/:sessionId
 *  12. /end → 404 when sessionId doesn't exist.
 *  13. /end → 403 when sessionId belongs to a different tenant
 *      (cross-tenant guard — the load-bearing isolation pin).
 *  14. /end → happy path: updates the VoiceSession to COMPLETED with
 *      endedAt stamped, returns the updated row.
 *
 * Test pattern mirrors backend/test/routes/telephony.test.js (sister
 * voice-route file, commit 88bd0b38) — prisma singleton monkey-patch
 * BEFORE the router is required, pass-through verifyToken so we exercise
 * route logic without minting real JWTs, no real twilio package calls
 * (we steer around them by either being in the "not configured" env
 * branch or by patching `prisma` so the success branches never reach
 * a real Twilio HTTP call). No real DB, no real HTTP to twilio.com,
 * pure contract pins.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Auth middleware bypass — pass-through verifyToken so we exercise the
// route logic without minting real JWTs.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — MUST happen BEFORE the router is required.
// voice.js's top-level `require('../lib/prisma')` resolves at import time
// and captures whatever shape these models point at then.
prisma.voiceSession = {
  create: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};
prisma.callLog = prisma.callLog || {};
prisma.callLog.create = vi.fn();

import express from 'express';
import request from 'supertest';

const voiceRouter = requireCJS('../../routes/voice');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false })); // Twilio webhooks are form-urlencoded
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/voice', voiceRouter);
  return app;
}

beforeEach(() => {
  prisma.voiceSession.create.mockReset();
  prisma.voiceSession.findUnique.mockReset();
  prisma.voiceSession.findMany.mockReset();
  prisma.voiceSession.update.mockReset();
  prisma.callLog.create.mockReset();

  // Sensible defaults.
  prisma.voiceSession.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 101, ...data, createdAt: new Date() })
  );
  prisma.voiceSession.findUnique.mockResolvedValue(null);
  prisma.voiceSession.findMany.mockResolvedValue([]);
  prisma.voiceSession.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: 101, sessionId: where.sessionId, ...data })
  );
  prisma.callLog.create.mockResolvedValue({ id: 9001 });
});

// ─── POST /token ─────────────────────────────────────────────────────

describe('POST /api/voice/token', () => {
  test('returns { error, token: null } at HTTP 200 when Twilio env is missing (no-op contract)', async () => {
    // Test environment has no TWILIO_ACCOUNT_SID/API_KEY/etc set (the
    // backend/.env does not configure them, and CI does not either).
    // The route MUST 200 with a null token rather than 500 — the
    // frontend softphone widget treats null-token as "feature
    // unavailable" and silently hides the dialer.
    const app = makeApp();
    const res = await request(app).post('/api/voice/token').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: 'Twilio not configured', token: null });
  });
});

// ─── POST /call ──────────────────────────────────────────────────────

describe('POST /api/voice/call', () => {
  test('400 when `to` phone number is missing from the body', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/voice/call').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone number is required/i);
    // No VoiceSession should be persisted on validation failure.
    expect(prisma.voiceSession.create).not.toHaveBeenCalled();
  });

  test('returns { error, token: null } at HTTP 200 when env is missing (same no-op contract as /token)', async () => {
    // `to` is supplied so we get past the 400 guard, but the route
    // then hits `isConfigured() === false` (env missing) and falls
    // back to the same soft-fail envelope as /token.
    const app = makeApp();
    const res = await request(app)
      .post('/api/voice/call')
      .send({ to: '+919876543210' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: 'Twilio not configured', token: null });
    expect(prisma.voiceSession.create).not.toHaveBeenCalled();
  });
});

// ─── POST /webhook/status (no auth) ──────────────────────────────────

describe('POST /api/voice/webhook/status', () => {
  test('400 when CallSid is missing (lookup key absent)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/voice/webhook/status')
      .send({ CallStatus: 'completed' });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Missing CallSid/i);
    expect(prisma.voiceSession.findUnique).not.toHaveBeenCalled();
    expect(prisma.voiceSession.update).not.toHaveBeenCalled();
  });

  test('maps Twilio status strings to schema enum-style values (ringing→RINGING, busy→FAILED, etc.)', async () => {
    const app = makeApp();
    prisma.voiceSession.findUnique.mockResolvedValue({
      id: 101,
      sessionId: 'CA-test-1',
      status: 'INITIATED',
      duration: null,
      recordingUrl: null,
      endedAt: null,
      tenantId: 1,
      userId: 7,
      contactId: null,
      fromNumber: '+912000000000',
      toNumber: '+919876543210',
    });

    // "ringing" → RINGING
    let res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({ CallSid: 'CA-test-1', CallStatus: 'ringing' });
    expect(res.status).toBe(200);
    expect(prisma.voiceSession.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { sessionId: 'CA-test-1' },
        data: expect.objectContaining({ status: 'RINGING' }),
      })
    );

    // "busy" → FAILED
    res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({ CallSid: 'CA-test-1', CallStatus: 'busy' });
    expect(res.status).toBe(200);
    expect(prisma.voiceSession.update.mock.calls.at(-1)[0].data.status).toBe('FAILED');

    // "no-answer" → FAILED
    res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({ CallSid: 'CA-test-1', CallStatus: 'no-answer' });
    expect(prisma.voiceSession.update.mock.calls.at(-1)[0].data.status).toBe('FAILED');

    // "canceled" → FAILED
    res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({ CallSid: 'CA-test-1', CallStatus: 'canceled' });
    expect(prisma.voiceSession.update.mock.calls.at(-1)[0].data.status).toBe('FAILED');

    // Unknown status string → defensive fallback to IN_PROGRESS.
    res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({ CallSid: 'CA-test-1', CallStatus: 'martian-status' });
    expect(prisma.voiceSession.update.mock.calls.at(-1)[0].data.status).toBe('IN_PROGRESS');
  });

  test('preserves existing duration via `?? session.duration` when CallDuration is missing on the callback', async () => {
    const app = makeApp();
    prisma.voiceSession.findUnique.mockResolvedValue({
      id: 101,
      sessionId: 'CA-keep-dur',
      status: 'IN_PROGRESS',
      duration: 42, // previously stamped
      recordingUrl: null,
      endedAt: null,
      tenantId: 1,
      userId: 7,
      contactId: null,
      fromNumber: '+912000000000',
      toNumber: '+919876543210',
    });

    // Send a ringing update with NO CallDuration — the route's
    // `dur ?? session.duration` must NOT overwrite the existing 42.
    const res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({ CallSid: 'CA-keep-dur', CallStatus: 'ringing' });

    expect(res.status).toBe(200);
    const updateData = prisma.voiceSession.update.mock.calls[0][0].data;
    expect(updateData.duration).toBe(42); // preserved, not nulled
    expect(updateData.status).toBe('RINGING');
    // endedAt is NOT stamped on a ringing update (only on COMPLETED/FAILED).
    expect(updateData.endedAt).toBeNull();
  });

  test('on COMPLETED, also creates a CallLog row with the session\'s tenant + user + contact + provider phones', async () => {
    const app = makeApp();
    prisma.voiceSession.findUnique.mockResolvedValue({
      id: 101,
      sessionId: 'CA-complete-1',
      status: 'IN_PROGRESS',
      duration: null,
      recordingUrl: null,
      endedAt: null,
      tenantId: 42,
      userId: 7,
      contactId: 555,
      fromNumber: '+912000000000',
      toNumber: '+919876543210',
    });

    const res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({
        CallSid: 'CA-complete-1',
        CallStatus: 'completed',
        CallDuration: '125',
        RecordingUrl: 'https://api.twilio.com/recordings/rec-1.mp3',
        From: '+912000000000',
        To: '+919876543210',
      });

    expect(res.status).toBe(200);

    // VoiceSession was updated with COMPLETED + stamped endedAt + recordingUrl.
    const updateData = prisma.voiceSession.update.mock.calls[0][0].data;
    expect(updateData.status).toBe('COMPLETED');
    expect(updateData.duration).toBe(125);
    expect(updateData.recordingUrl).toBe('https://api.twilio.com/recordings/rec-1.mp3');
    expect(updateData.endedAt).toBeInstanceOf(Date);

    // CallLog row backfilled for historical reporting — load-bearing pin.
    expect(prisma.callLog.create).toHaveBeenCalledTimes(1);
    const logData = prisma.callLog.create.mock.calls[0][0].data;
    expect(logData).toMatchObject({
      duration: 125,
      direction: 'OUTBOUND',
      recordingUrl: 'https://api.twilio.com/recordings/rec-1.mp3',
      provider: 'twilio',
      providerCallId: 'CA-complete-1',
      status: 'COMPLETED',
      callerNumber: '+912000000000',
      calleeNumber: '+919876543210',
      tenantId: 42,
      userId: 7,
      contactId: 555,
    });
  });

  test('unknown CallSid → still 200s with <Response/> and does NOT create a CallLog (no silent-orphan)', async () => {
    const app = makeApp();
    // findUnique returns null — session does not exist (rogue webhook
    // or replay for an unknown CallSid).
    prisma.voiceSession.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/voice/webhook/status')
      .type('form')
      .send({
        CallSid: 'CA-rogue-replay',
        CallStatus: 'completed',
        CallDuration: '60',
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    // No update on a missing session.
    expect(prisma.voiceSession.update).not.toHaveBeenCalled();
    // CRITICAL: no orphan CallLog created from a webhook with no
    // matching VoiceSession. The completed-row backfill ONLY runs
    // when the session was found.
    expect(prisma.callLog.create).not.toHaveBeenCalled();
  });
});

// ─── POST /webhook/twiml (no auth) ───────────────────────────────────

describe('POST /api/voice/webhook/twiml', () => {
  test('strips XML-unsafe characters (< > & \' ") from the `To` value before interpolating into <Dial>', async () => {
    const app = makeApp();
    // Attempt a TwiML-injection: < > & ' " all stripped by the route's
    // `replace(/[<>&'"]/g, '')`. Result must be the bare phone number
    // surface with NO injected tags surviving.
    const res = await request(app)
      .post('/api/voice/webhook/twiml')
      .type('form')
      .send({ To: '+91987</Dial><Say>pwned</Say>654321' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    // Extract the body BETWEEN the <Dial> open and </Dial> close tags —
    // this is the interpolated user-controlled segment. (The XML
    // prologue `<?xml ... encoding="UTF-8"?>` legitimately contains
    // double-quotes, so we cannot scan the whole response text for them.)
    const dialMatch = res.text.match(/<Dial[^>]*>([\s\S]*?)<\/Dial>/);
    expect(dialMatch).not.toBeNull();
    const dialBody = dialMatch[1];
    // All XML-unsafe chars stripped from the interpolated segment.
    expect(dialBody).not.toMatch(/[<>&'"]/);
    // The injection's closing </Dial><Say> sequence is broken — the
    // stripped chars leave behind just the bare letter-digits.
    expect(dialBody).toMatch(/\+91987\/DialSaypwned\/Say654321/);
    // The wrapping <Response><Dial>...</Dial></Response> structure is intact.
    expect(res.text).toMatch(/<Response>[\s\S]*<Dial[^>]*>[\s\S]*<\/Dial>[\s\S]*<\/Response>/);
  });

  test('accepts both `To` (canonical) and `to` (lowercase) body shapes', async () => {
    const app = makeApp();

    // Canonical `To`
    let res = await request(app)
      .post('/api/voice/webhook/twiml')
      .type('form')
      .send({ To: '+919876543210' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('+919876543210');

    // Lowercase `to`
    res = await request(app)
      .post('/api/voice/webhook/twiml')
      .type('form')
      .send({ to: '+918888888888' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('+918888888888');
  });
});

// ─── GET /sessions ───────────────────────────────────────────────────

describe('GET /api/voice/sessions', () => {
  test('scopes findMany by req.user.tenantId, orders desc by createdAt, caps at take:50', async () => {
    const app = makeApp({ tenantId: 42, userId: 7 });
    prisma.voiceSession.findMany.mockResolvedValue([
      { id: 1, sessionId: 'CA-a', status: 'COMPLETED', tenantId: 42 },
      { id: 2, sessionId: 'CA-b', status: 'IN_PROGRESS', tenantId: 42 },
    ]);

    const res = await request(app).get('/api/voice/sessions');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    // Pin the load-bearing query shape — tenant filter, sort, and cap.
    expect(prisma.voiceSession.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.voiceSession.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 42 });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.take).toBe(50);
  });
});

// ─── POST /end/:sessionId ────────────────────────────────────────────

describe('POST /api/voice/end/:sessionId', () => {
  test('404 when sessionId does not exist', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.voiceSession.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/voice/end/CA-missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Session not found/i);
    expect(prisma.voiceSession.update).not.toHaveBeenCalled();
  });

  test('403 when sessionId belongs to a different tenant (cross-tenant guard)', async () => {
    const app = makeApp({ tenantId: 42 });
    // Session exists but is owned by tenant 99 — caller is tenant 42.
    prisma.voiceSession.findUnique.mockResolvedValue({
      id: 101,
      sessionId: 'CA-other-tenant',
      status: 'IN_PROGRESS',
      tenantId: 99,
    });

    const res = await request(app).post('/api/voice/end/CA-other-tenant');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Forbidden/i);
    // No update on a forbidden cross-tenant end attempt.
    expect(prisma.voiceSession.update).not.toHaveBeenCalled();
  });

  test('happy path: updates VoiceSession to COMPLETED with endedAt stamped, returns the updated row', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.voiceSession.findUnique.mockResolvedValue({
      id: 101,
      sessionId: 'CA-end-1',
      status: 'IN_PROGRESS',
      tenantId: 42,
    });

    const res = await request(app).post('/api/voice/end/CA-end-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId: 'CA-end-1',
      status: 'COMPLETED',
    });
    // Update was called with COMPLETED + a stamped endedAt.
    expect(prisma.voiceSession.update).toHaveBeenCalledTimes(1);
    const args = prisma.voiceSession.update.mock.calls[0][0];
    expect(args.where).toEqual({ sessionId: 'CA-end-1' });
    expect(args.data.status).toBe('COMPLETED');
    expect(args.data.endedAt).toBeInstanceOf(Date);
  });
});
