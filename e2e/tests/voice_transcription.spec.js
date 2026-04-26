// @ts-check
/**
 * Voice transcription routes — /api/voice-transcription/*
 *   Auth:    GET /providers, POST /transcribe-url, POST /call/:callLogId,
 *            POST /voice-session/:sessionId, POST /summarize/:callLogId
 *
 * Real Whisper/Gemini calls require API keys + an actual audio file. We test
 * the validation/auth layer only and skip happy paths that need providers.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

// Mounted at /api/voice-transcription based on conventional naming. Verify by
// hitting both possibilities in the providers smoke test.
const MOUNT = '/voice-transcription';

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('voice_transcription.js — Whisper / Gemini transcription', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /providers requires auth', async ({ request }) => {
    const res = await request.get(`${API}${MOUNT}/providers`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /providers returns whisper/gemini availability flags', async ({ request }) => {
    const res = await request.get(`${API}${MOUNT}/providers`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.whisper).toBe('boolean');
    expect(typeof body.gemini).toBe('boolean');
  });

  test('POST /transcribe-url rejects missing audioUrl', async ({ request }) => {
    const res = await request.post(`${API}${MOUNT}/transcribe-url`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /call/:callLogId rejects non-numeric id', async ({ request }) => {
    const res = await request.post(`${API}${MOUNT}/call/notanumber`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /call/:callLogId 404s for unknown id', async ({ request }) => {
    const res = await request.post(`${API}${MOUNT}/call/99999999`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  test('POST /voice-session/:sessionId 404s for unknown session', async ({ request }) => {
    const res = await request.post(`${API}${MOUNT}/voice-session/CA_unknown_${Date.now()}`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  test('POST /summarize/:callLogId rejects invalid id', async ({ request }) => {
    const res = await request.post(`${API}${MOUNT}/summarize/notanumber`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /summarize/:callLogId 404s for unknown id', async ({ request }) => {
    const res = await request.post(`${API}${MOUNT}/summarize/99999999`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  test.skip('POST /transcribe-url happy path requires real audio + Whisper/Gemini key', () => {
    // Skipped: depends on OPENAI_API_KEY / GEMINI_API_KEY + a real audio URL the
    // server can fetch. Out of scope for an offline smoke test.
  });
});
