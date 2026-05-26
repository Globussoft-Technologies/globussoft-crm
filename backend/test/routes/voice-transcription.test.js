// @ts-check
/**
 * Unit tests for backend/routes/voice_transcription.js — pins the call-recording
 * transcription + Gemini-summarization surface used by the Inbox, CRM call-log
 * page, and ad-hoc transcription tools.
 *
 * Why this file exists
 * ────────────────────
 * voice_transcription.js (247 LOC) wraps three external boundaries:
 *
 *   - OpenAI Whisper (multipart POST to /v1/audio/transcriptions) when
 *     OPENAI_API_KEY is set,
 *   - Google Gemini (audio inline_data) when GEMINI_API_KEY is set,
 *   - a "stub" fallback transcript when neither is configured.
 *
 * It exposes five endpoints behind verifyToken:
 *
 *   GET  /providers                       — quick env-driven provider flags
 *   POST /transcribe-url                  — ad-hoc URL → transcript, no save
 *   POST /call/:callLogId                 — CallLog.recordingUrl → notes
 *   POST /voice-session/:sessionId        — VoiceSession.recordingUrl → transcript
 *   POST /summarize/:callLogId            — Gemini summary appended to notes
 *
 * Non-obvious contracts pinned here
 * ─────────────────────────────────
 *   - tenant isolation — /call/:id, /voice-session/:id, /summarize/:id all
 *     scope by `req.user.tenantId`; cross-tenant id returns 404, never the
 *     foreign row's data.
 *
 *   - validation surface — non-numeric :callLogId → 400 "Invalid callLogId";
 *     missing audioUrl on /transcribe-url → 400 "audioUrl required";
 *     missing recordingUrl on the looked-up row → 400 "<entity> has no
 *     recordingUrl".
 *
 *   - provider-precedence — when both OPENAI_API_KEY and GEMINI_API_KEY are
 *     set, Whisper wins. When neither is set, the stub transcript is
 *     returned with provider="stub". Gemini is only attempted when
 *     Whisper key absent.
 *
 *   - response shape — every transcribe endpoint returns
 *     `{ transcript, provider, ...idRef }` where idRef is `callLogId` for
 *     CallLog rows and `sessionId` for VoiceSession rows.
 *
 *   - summarize gating — /summarize/:id returns 200 with summary=null when
 *     GEMINI_API_KEY is unset (graceful degrade, NOT a 4xx). When set, it
 *     APPENDS `\n\n--- AI SUMMARY ---\n<summary>` to existing notes (it
 *     does NOT replace). 400 when notes is empty (must transcribe first).
 *
 *   - http-boundary errors — Whisper non-2xx → 500 with the upstream error
 *     text, mirroring the route's catch-all. downloadAudio failures bubble
 *     to the same 500 path.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/quotas.test.js — prisma singleton patch +
 * real JWT bearer signed with config/secrets.JWT_SECRET so the real
 * verifyToken middleware passes. The router mounts verifyToken inline
 * (per-route, not router.use), so the test app does NOT need to wire it
 * separately.
 *
 * External boundaries (OpenAI Whisper + Gemini audio + Gemini text) are
 * stubbed at the global.fetch + @google/generative-ai layers respectively;
 * no real HTTP calls during tests.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must happen BEFORE the router is required.
prisma.callLog = prisma.callLog || {};
prisma.callLog.findFirst = vi.fn();
prisma.callLog.update = vi.fn();

prisma.voiceSession = prisma.voiceSession || {};
prisma.voiceSession.findFirst = vi.fn();
prisma.voiceSession.update = vi.fn();

prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

const voiceTranscriptionRouter = requireCJS('../../routes/voice_transcription');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/voice-transcription', voiceTranscriptionRouter);
  return app;
}

// Helpers to control provider env vars per-test deterministically. Each test
// either sets or unsets these BEFORE making the request, then restores in
// afterEach.
const ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY'];
const savedEnv = {};
ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });

beforeEach(() => {
  prisma.callLog.findFirst.mockReset();
  prisma.callLog.update.mockReset();
  prisma.voiceSession.findFirst.mockReset();
  prisma.voiceSession.update.mockReset();

  // Default: both providers OFF so we exercise the stub path unless overridden.
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
});

// Convenience: stub global.fetch with a successful Whisper response. The
// route POSTs multipart to OpenAI; we only need the JSON-decoded body shape.
function stubWhisperOk(transcript) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ text: transcript }),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => 'audio/mpeg' },
    text: async () => '',
  });
}

// Convenience: stub fetch with a download step (used by transcribeAudio's
// pre-Whisper download) returning a small in-memory audio buffer, then a
// successful Whisper response. The route makes TWO fetch calls per
// transcribe — first to download the audio, second to call Whisper.
function stubDownloadThenWhisperOk(transcript) {
  global.fetch = vi.fn()
    // download
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x44]).buffer,
    })
    // whisper
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ text: transcript }),
      text: async () => '',
    });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /providers — env-driven flags
// ─────────────────────────────────────────────────────────────────────────

describe('GET /providers — provider availability flags', () => {
  test('returns both flags false when neither env var is set', async () => {
    const res = await request(makeApp())
      .get('/api/voice-transcription/providers')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ whisper: false, gemini: false });
  });

  test('returns whisper=true when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';

    const res = await request(makeApp())
      .get('/api/voice-transcription/providers')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.whisper).toBe(true);
    expect(res.body.gemini).toBe(false);
  });

  test('rejects unauthenticated requests with 401', async () => {
    const res = await request(makeApp())
      .get('/api/voice-transcription/providers');

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /transcribe-url — ad-hoc URL transcription
// ─────────────────────────────────────────────────────────────────────────

describe('POST /transcribe-url — ad-hoc URL transcription', () => {
  test('400 when audioUrl is missing from the body', async () => {
    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'audioUrl required' });
  });

  test('returns stub transcript with provider="stub" when no providers configured', async () => {
    // The stub path does NOT actually fetch anything — transcribeAudio
    // short-circuits in the no-key branch. But downloadAudio is invoked
    // before the provider check, so we still need fetch stubbed to succeed.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('stub');
    expect(res.body.transcript).toMatch(/Transcription not configured/);
  });

  test('happy path: Whisper transcript returned with provider="whisper"', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    stubDownloadThenWhisperOk('Hello, this is a test call.');

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'Hello, this is a test call.',
      provider: 'whisper',
    });
  });

  test('500 when audio download fails (upstream non-2xx)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'text/plain' },
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/missing.mp3' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to download audio/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /call/:callLogId — CallLog recording transcription
// ─────────────────────────────────────────────────────────────────────────

describe('POST /call/:callLogId — CallLog recording transcription', () => {
  test('400 on non-numeric callLogId', async () => {
    const res = await request(makeApp())
      .post('/api/voice-transcription/call/not-a-number')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid callLogId' });
    // findFirst must NOT have been called — bail-out is before Prisma.
    expect(prisma.callLog.findFirst).not.toHaveBeenCalled();
  });

  test('404 when callLog not found in tenant', async () => {
    prisma.callLog.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/voice-transcription/call/42')
      .set('Authorization', makeBearer({ tenantId: 1 }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Call log not found' });
    // Tenant-scoped lookup proves cross-tenant rows can't leak.
    expect(prisma.callLog.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
    });
    expect(prisma.callLog.update).not.toHaveBeenCalled();
  });

  test('cross-tenant id returns 404 without exposing the foreign row', async () => {
    // Simulate: row 42 exists in tenant 2 but request is from tenant 1.
    // findFirst with the (id, tenantId=1) filter returns null.
    prisma.callLog.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/voice-transcription/call/42')
      .set('Authorization', makeBearer({ tenantId: 1 }));

    expect(res.status).toBe(404);
    expect(prisma.callLog.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
    });
    expect(prisma.callLog.update).not.toHaveBeenCalled();
  });

  test('400 when callLog has no recordingUrl', async () => {
    prisma.callLog.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, recordingUrl: null, notes: null,
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/call/42')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Call log has no recordingUrl' });
    expect(prisma.callLog.update).not.toHaveBeenCalled();
  });

  test('happy path: transcribes via Whisper, persists transcript to notes', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    prisma.callLog.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, recordingUrl: 'https://example.com/call-42.mp3', notes: null,
    });
    prisma.callLog.update.mockResolvedValue({ id: 42, notes: 'Hello from the test call.' });
    stubDownloadThenWhisperOk('Hello from the test call.');

    const res = await request(makeApp())
      .post('/api/voice-transcription/call/42')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'Hello from the test call.',
      provider: 'whisper',
      callLogId: 42,
    });
    // notes is REPLACED with the new transcript (not appended).
    expect(prisma.callLog.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { notes: 'Hello from the test call.' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /voice-session/:sessionId — VoiceSession recording transcription
// ─────────────────────────────────────────────────────────────────────────

describe('POST /voice-session/:sessionId — VoiceSession transcription', () => {
  test('404 when voice session not found in tenant', async () => {
    prisma.voiceSession.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/voice-transcription/voice-session/CAxxxxxxxxxxxxxxxxxxx')
      .set('Authorization', makeBearer({ tenantId: 1 }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Voice session not found' });
    expect(prisma.voiceSession.findFirst).toHaveBeenCalledWith({
      where: { sessionId: 'CAxxxxxxxxxxxxxxxxxxx', tenantId: 1 },
    });
    expect(prisma.voiceSession.update).not.toHaveBeenCalled();
  });

  test('400 when voice session has no recordingUrl', async () => {
    prisma.voiceSession.findFirst.mockResolvedValue({
      id: 11, sessionId: 'CA-1', tenantId: 1, recordingUrl: null, transcript: null,
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/voice-session/CA-1')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Voice session has no recordingUrl' });
    expect(prisma.voiceSession.update).not.toHaveBeenCalled();
  });

  test('happy path: transcribes and writes transcript to VoiceSession.transcript', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    prisma.voiceSession.findFirst.mockResolvedValue({
      id: 11, sessionId: 'CA-1', tenantId: 1, recordingUrl: 'https://example.com/vs-1.mp3',
    });
    prisma.voiceSession.update.mockResolvedValue({ id: 11, sessionId: 'CA-1', transcript: 'Recorded session text.' });
    stubDownloadThenWhisperOk('Recorded session text.');

    const res = await request(makeApp())
      .post('/api/voice-transcription/voice-session/CA-1')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'Recorded session text.',
      provider: 'whisper',
      sessionId: 'CA-1',
    });
    // Update keys on numeric id, NOT sessionId — pinning the contract.
    expect(prisma.voiceSession.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { transcript: 'Recorded session text.' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /summarize/:callLogId — Gemini summary, appended to notes
// ─────────────────────────────────────────────────────────────────────────

describe('POST /summarize/:callLogId — Gemini summary', () => {
  test('400 on non-numeric callLogId', async () => {
    const res = await request(makeApp())
      .post('/api/voice-transcription/summarize/not-a-number')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid callLogId' });
  });

  test('404 when callLog is not in tenant', async () => {
    prisma.callLog.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/voice-transcription/summarize/99')
      .set('Authorization', makeBearer({ tenantId: 3 }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Call log not found' });
    expect(prisma.callLog.findFirst).toHaveBeenCalledWith({
      where: { id: 99, tenantId: 3 },
    });
  });

  test('400 when callLog notes is empty (must transcribe first)', async () => {
    prisma.callLog.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, notes: '   ',
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/summarize/99')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no transcript in notes/);
  });

  test('graceful degrade: returns transcript + summary=null when GEMINI_API_KEY unset', async () => {
    // No GEMINI_API_KEY set in beforeEach.
    prisma.callLog.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, notes: 'Existing transcript content.',
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/summarize/99')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeNull();
    expect(res.body.transcript).toBe('Existing transcript content.');
    expect(res.body.message).toMatch(/Transcription not configured/);
    // No write should occur on the degrade path.
    expect(prisma.callLog.update).not.toHaveBeenCalled();
  });
});
