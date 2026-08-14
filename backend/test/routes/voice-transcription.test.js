// @ts-check
/**
 * Unit tests for backend/routes/voice_transcription.js — pins the call-recording
 * transcription + AI-summarization surface used by the Inbox, CRM call-log
 * page, and ad-hoc transcription tools.
 *
 * Why this file exists
 * ────────────────────
 * voice_transcription.js wraps AI-powered transcription/summarization behind
 * lib/aiGateway.js — the mandatory resolve/gate/log/deduct entry point every
 * AI feature in the CRM shares (BYOK first, then a funded CRM-managed
 * subscription). Access is resolved per-tenant; the resolved provider family
 * decides Whisper (openai-compatible) vs Gemini inline_data (gemini) for
 * transcription; summarization always goes through aiGateway.runAiRequest.
 * When no tenant has AI access, everything degrades to a "stub" transcript /
 * null summary rather than failing.
 *
 * It exposes five endpoints behind verifyToken:
 *
 *   GET  /providers                       — tenant AI-access flags
 *   POST /transcribe-url                  — ad-hoc URL → transcript, no save
 *   POST /call/:callLogId                 — CallLog.recordingUrl → notes
 *   POST /voice-session/:sessionId        — VoiceSession.recordingUrl → transcript
 *   POST /summarize/:callLogId            — AI summary appended to notes
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
 *   - provider routing — transcribeAudio resolves AI access once via
 *     aiGateway.runNonTokenAiRequest; the runFn branches on the resolved
 *     config.family ("openai-compatible" → Whisper endpoint, "gemini" →
 *     inline_data). No AI access (friendly-blocked) or an unsupported
 *     family both degrade to the stub transcript, never a 5xx.
 *
 *   - response shape — every transcribe endpoint returns
 *     `{ transcript, provider, ...idRef }` where idRef is `callLogId` for
 *     CallLog rows and `sessionId` for VoiceSession rows.
 *
 *   - summarize gating — /summarize/:id returns 200 with summary=null when
 *     AI access is unavailable (graceful degrade, NOT a 4xx). When
 *     available, it APPENDS `\n\n--- AI SUMMARY ---\n<summary>` to existing
 *     notes (it does NOT replace). 400 when notes is empty (must transcribe
 *     first).
 *
 *   - http-boundary errors — a non-friendly AI failure inside transcribeAudio
 *     is swallowed with a console.warn and falls through to the stub
 *     transcript (never surfaces as a 5xx) — mirrors the graceful-degrade
 *     contract used across every other AI feature in the CRM. downloadAudio
 *     failures (can't even fetch the source audio) DO surface as 500,
 *     since that's not an AI-access concern.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/ai.test.js — prisma singleton patch + real JWT
 * bearer signed with config/secrets.JWT_SECRET so the real verifyToken
 * middleware passes, PLUS a prisma.user mock (verifyToken's live-session-state
 * check) and an aiGateway/aiProviderManagement mock installed via
 * Module._cache injection before the router is required (the router uses
 * CJS require(), which vitest's ESM-level vi.mock doesn't otherwise
 * intercept). External boundaries (Whisper's raw fetch, Gemini's raw fetch)
 * inside the mocked runFn are exercised via global.fetch stubs so the actual
 * HTTP-shape code in transcribeWithWhisper/transcribeWithGemini stays
 * covered even though aiGateway itself is mocked.
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

// verifyToken's live-session-state check reads prisma.user on every
// authenticated request.
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ deactivatedAt: null, sessionVersion: null });

// The route now routes AI access through lib/aiGateway.runAiRequest /
// runNonTokenAiRequest and reads availability via
// lib/aiProviderManagement.getTenantAiState — mocked directly rather than
// the Gemini SDK / bare env vars (the route no longer touches either;
// access is resolved per-tenant). Pattern mirrors test/routes/ai.test.js.
const { mockRunAiRequest, mockRunNonTokenAiRequest, mockGetTenantAiState } = vi.hoisted(() => ({
  mockRunAiRequest: vi.fn(),
  mockRunNonTokenAiRequest: vi.fn(),
  mockGetTenantAiState: vi.fn(),
}));
vi.mock('../../lib/aiGateway', () => ({
  default: { runAiRequest: mockRunAiRequest, runNonTokenAiRequest: mockRunNonTokenAiRequest },
  runAiRequest: mockRunAiRequest,
  runNonTokenAiRequest: mockRunNonTokenAiRequest,
}));
vi.mock('../../lib/aiProviderManagement', () => ({
  default: { getTenantAiState: mockGetTenantAiState },
  getTenantAiState: mockGetTenantAiState,
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// Module._cache injection — the route requires aiGateway/aiProviderManagement
// via CJS; this makes that require() chain resolve to the same mock objects
// vi.mock's ESM-level factory installed above.
const aiGatewayPath = requireCJS.resolve('../../lib/aiGateway');
require('node:module')._cache[aiGatewayPath] = {
  id: aiGatewayPath, filename: aiGatewayPath, loaded: true,
  exports: { runAiRequest: mockRunAiRequest, runNonTokenAiRequest: mockRunNonTokenAiRequest },
  children: [], paths: [],
};
const aiProviderManagementPath = requireCJS.resolve('../../lib/aiProviderManagement');
require('node:module')._cache[aiProviderManagementPath] = {
  id: aiProviderManagementPath, filename: aiProviderManagementPath, loaded: true,
  exports: { getTenantAiState: mockGetTenantAiState },
  children: [], paths: [],
};

const voiceTranscriptionRouter = requireCJS('../../routes/voice_transcription');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/voice-transcription', voiceTranscriptionRouter);
  return app;
}

beforeEach(() => {
  prisma.callLog.findFirst.mockReset();
  prisma.callLog.update.mockReset();
  prisma.voiceSession.findFirst.mockReset();
  prisma.voiceSession.update.mockReset();

  mockRunAiRequest.mockReset();
  mockRunNonTokenAiRequest.mockReset();
  mockGetTenantAiState.mockReset();

  // Default: no AI access configured — resolveAccess-dependent tests
  // override runNonTokenAiRequest/runAiRequest with a friendly rejection or
  // a resolved value as needed.
  const friendlyBlocked = new Error('Your organization has not configured an AI provider yet.');
  friendlyBlocked.friendly = true;
  mockRunNonTokenAiRequest.mockRejectedValue(friendlyBlocked);
  mockRunAiRequest.mockRejectedValue(friendlyBlocked);
  mockGetTenantAiState.mockResolvedValue({ resolverAccess: 'none', byok: null });
});

// Convenience: stub global.fetch so downloadAudio's pre-transcription fetch
// succeeds with a tiny in-memory audio buffer. transcribeAudio always
// downloads first, regardless of whether AI access is available.
function stubDownloadOk() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'audio/mpeg' },
    arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x44]).buffer,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /providers — tenant AI-access flags
// ─────────────────────────────────────────────────────────────────────────

describe('GET /providers — provider availability flags', () => {
  test('returns both flags false when the tenant has no AI access', async () => {
    mockGetTenantAiState.mockResolvedValue({ resolverAccess: 'none', byok: null });

    const res = await request(makeApp())
      .get('/api/voice-transcription/providers')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ whisper: false, gemini: false });
  });

  test('returns whisper=true when BYOK is configured for openai', async () => {
    mockGetTenantAiState.mockResolvedValue({
      resolverAccess: 'byok',
      byok: { providerId: 'openai' },
    });

    const res = await request(makeApp())
      .get('/api/voice-transcription/providers')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.whisper).toBe(true);
    expect(res.body.gemini).toBe(false);
  });

  test('returns gemini=true when BYOK is configured for gemini', async () => {
    mockGetTenantAiState.mockResolvedValue({
      resolverAccess: 'byok',
      byok: { providerId: 'gemini' },
    });

    const res = await request(makeApp())
      .get('/api/voice-transcription/providers')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.whisper).toBe(false);
    expect(res.body.gemini).toBe(true);
  });

  test('a funded CRM-managed subscription reports both flags true (fallback cascade covers both)', async () => {
    mockGetTenantAiState.mockResolvedValue({ resolverAccess: 'crm-managed', byok: null });

    const res = await request(makeApp())
      .get('/api/voice-transcription/providers')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ whisper: true, gemini: true });
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

  test('returns stub transcript with provider="stub" when no AI access is configured (friendly block)', async () => {
    stubDownloadOk();
    // default beforeEach already rejects with a friendly error

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('stub');
    expect(res.body.transcript).toMatch(/Transcription not configured/);
  });

  test('happy path: Whisper transcript returned with provider="openai"', async () => {
    stubDownloadOk();
    mockRunNonTokenAiRequest.mockImplementation(async ({ runFn }) => {
      const result = await runFn({ family: 'openai-compatible', providerId: 'openai', apiKey: 'sk-test', model: 'whisper-1' });
      return { result: result.result, costUsd: result.costUsd, provider: result.provider, model: result.model };
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x44]).buffer,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ text: 'Hello, this is a test call.' }),
        text: async () => '',
      });

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'Hello, this is a test call.',
      provider: 'openai',
    });
  });

  test('happy path: Gemini audio transcript returned with provider="gemini"', async () => {
    mockRunNonTokenAiRequest.mockImplementation(async ({ runFn }) => {
      const result = await runFn({ family: 'gemini', providerId: 'gemini', apiKey: 'g-test', model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com' });
      return { result: result.result, costUsd: result.costUsd, provider: result.provider, model: result.model };
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x44]).buffer,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'Gemini transcribed this.' }] } }] }),
      });

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'Gemini transcribed this.',
      provider: 'gemini',
    });
  });

  test('500 when audio download fails (upstream non-2xx)', async () => {
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

  test('non-rate-limit AI failure is swallowed — falls back to stub, not a 5xx', async () => {
    stubDownloadOk();
    mockRunNonTokenAiRequest.mockRejectedValue(new Error('malformed provider response'));

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('stub');
  });

  test('rate-limit AI failure surfaces as 429, distinct from a generic failure', async () => {
    stubDownloadOk();
    mockRunNonTokenAiRequest.mockRejectedValue(new Error('quota exceeded'));

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('GEMINI_LIMIT_EXHAUSTED');
  });

  test('aiGateway-shaped RATE_LIMITED friendly error also surfaces as 429, not silently swallowed to the stub', async () => {
    // aiGateway.js centrally rewrites a provider quota/rate-limit failure
    // into a friendly error with unavailableReason="RATE_LIMITED" (distinct
    // from the "no BYOK / no funded subscription" friendly-block shape).
    // This must NOT be swallowed into the generic stub-transcript fallback —
    // it's an actionable, temporary condition, not "never configured".
    stubDownloadOk();
    const rateLimited = new Error(
      "Your AI provider key has hit its usage limit (rate limit or quota exceeded). Please wait a few minutes and try again, or check your provider account's billing/quota settings.",
    );
    rateLimited.code = 'AI_PROVIDER_RATE_LIMITED';
    rateLimited.friendly = true;
    rateLimited.unavailableReason = 'RATE_LIMITED';
    mockRunNonTokenAiRequest.mockRejectedValue(rateLimited);

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('GEMINI_LIMIT_EXHAUSTED');
    expect(res.body.error).toMatch(/usage limit/);
  });

  test('friendly access-blocked (no BYOK, no funded subscription) still degrades to the stub — unaffected by the RATE_LIMITED carve-out', async () => {
    stubDownloadOk();
    const blocked = new Error('Your organization has not configured an AI provider yet.');
    blocked.code = 'AI_NOT_CONFIGURED';
    blocked.friendly = true;
    blocked.unavailableReason = 'NO_CONFIGURATION';
    mockRunNonTokenAiRequest.mockRejectedValue(blocked);

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('stub');
  });

  test('resolved provider family not audio-capable → friendly-blocked, falls back to stub', async () => {
    stubDownloadOk();
    mockRunNonTokenAiRequest.mockImplementation(async ({ runFn }) => {
      // e.g. BYOK is Claude — resolveProviderConfig doesn't distinguish
      // audio-capability, so the runFn itself throws the friendly error.
      return runFn({ family: 'anthropic', providerId: 'claude', apiKey: 'sk-ant-test' });
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/transcribe-url')
      .set('Authorization', makeBearer())
      .send({ audioUrl: 'https://example.com/audio.mp3' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('stub');
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
    prisma.callLog.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, recordingUrl: 'https://example.com/call-42.mp3', notes: null,
    });
    prisma.callLog.update.mockResolvedValue({ id: 42, notes: 'Hello from the test call.' });
    mockRunNonTokenAiRequest.mockImplementation(async ({ runFn }) => {
      const result = await runFn({ family: 'openai-compatible', providerId: 'openai', apiKey: 'sk-test' });
      return { result: result.result, provider: result.provider };
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x44]).buffer,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ text: 'Hello from the test call.' }),
        text: async () => '',
      });

    const res = await request(makeApp())
      .post('/api/voice-transcription/call/42')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'Hello from the test call.',
      provider: 'openai',
      callLogId: 42,
    });
    // notes is REPLACED with the new transcript (not appended).
    expect(prisma.callLog.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { notes: 'Hello from the test call.' },
    });
  });

  test('AI request is scoped to the requesting tenantId', async () => {
    prisma.callLog.findFirst.mockResolvedValue({
      id: 42, tenantId: 9, recordingUrl: 'https://example.com/call-42.mp3', notes: null,
    });
    prisma.callLog.update.mockResolvedValue({ id: 42 });
    stubDownloadOk();
    // default beforeEach rejection (friendly) — stub path, but we can still
    // assert the tenantId threaded into the gateway call.
    await request(makeApp())
      .post('/api/voice-transcription/call/42')
      .set('Authorization', makeBearer({ tenantId: 9 }));

    expect(mockRunNonTokenAiRequest).toHaveBeenCalledTimes(1);
    expect(mockRunNonTokenAiRequest.mock.calls[0][0].tenantId).toBe(9);
    expect(mockRunNonTokenAiRequest.mock.calls[0][0].task).toBe('voice-transcription');
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
    prisma.voiceSession.findFirst.mockResolvedValue({
      id: 11, sessionId: 'CA-1', tenantId: 1, recordingUrl: 'https://example.com/vs-1.mp3',
    });
    prisma.voiceSession.update.mockResolvedValue({ id: 11, sessionId: 'CA-1', transcript: 'Recorded session text.' });
    mockRunNonTokenAiRequest.mockImplementation(async ({ runFn }) => {
      const result = await runFn({ family: 'openai-compatible', providerId: 'openai', apiKey: 'sk-test' });
      return { result: result.result, provider: result.provider };
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x44]).buffer,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ text: 'Recorded session text.' }),
        text: async () => '',
      });

    const res = await request(makeApp())
      .post('/api/voice-transcription/voice-session/CA-1')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'Recorded session text.',
      provider: 'openai',
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
// POST /summarize/:callLogId — AI summary, appended to notes
// ─────────────────────────────────────────────────────────────────────────

describe('POST /summarize/:callLogId — AI summary', () => {
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

  test('graceful degrade: returns transcript + summary=null when AI access is unavailable', async () => {
    // default beforeEach already rejects runAiRequest with a friendly error
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

  test('happy path: summary is generated and APPENDED (not replacing) existing notes', async () => {
    prisma.callLog.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, notes: 'Existing transcript content.',
    });
    prisma.callLog.update.mockResolvedValue({ id: 99 });
    mockRunAiRequest.mockResolvedValue({
      text: 'SUMMARY:\nCustomer called about billing.\n\nACTION ITEMS:\n- Follow up',
      model: 'gemini-2.5-flash-lite', provider: 'gemini', accessType: 'byok',
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    });

    const res = await request(makeApp())
      .post('/api/voice-transcription/summarize/99')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.summary).toContain('Customer called about billing.');
    expect(prisma.callLog.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: {
        notes: 'Existing transcript content.\n\n--- AI SUMMARY ---\nSUMMARY:\nCustomer called about billing.\n\nACTION ITEMS:\n- Follow up',
      },
    });
  });

  test('AI request is scoped to the requesting tenantId', async () => {
    prisma.callLog.findFirst.mockResolvedValue({
      id: 99, tenantId: 5, notes: 'Some transcript.',
    });

    await request(makeApp())
      .post('/api/voice-transcription/summarize/99')
      .set('Authorization', makeBearer({ tenantId: 5 }));

    expect(mockRunAiRequest).toHaveBeenCalledTimes(1);
    expect(mockRunAiRequest.mock.calls[0][0].tenantId).toBe(5);
    expect(mockRunAiRequest.mock.calls[0][0].task).toBe('voice-transcript-summary');
  });
});
