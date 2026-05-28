// Unit tests for backend/services/digilockerClient.js
//
// What this module does:
//   Stub-mode wrapper for DigiLocker Aadhaar verification. Real OAuth
//   flow lands when Q3 creds (DIGILOCKER_CLIENT_ID/_SECRET) drop. Three
//   functions:
//     - digilockerEnabled()              — true iff both env vars set
//     - initiateSession({ participantId, redirectUri }) → { state, oauthUrl }
//     - exchangeCallback({ state, code }) → { aadhaarLast4, aadhaarTokenId }
//
// Surface area covered:
//   - module shape (all three functions exported)
//   - digilockerEnabled
//       - false when either env var is missing
//       - true when both env vars are set
//   - initiateSession
//       - returns a 32-char hex state (16 random bytes)
//       - oauthUrl contains the state query param verbatim
//       - oauthUrl uses the stub base (won't accidentally hit real DigiLocker)
//       - two calls return different state values (randomness)
//   - exchangeCallback
//       - throws when state is missing
//       - returns deterministic last4 "9999"
//       - tokenId is derived from state hash (same state → same token)
//       - different states yield different tokenIds
//
// Pin the contract that the REAL implementation MUST honour when the
// stub gets swapped — the route layer + DB shape depend on the
// { state, oauthUrl } / { aadhaarLast4, aadhaarTokenId } envelopes.

import { describe, test, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

const ORIGINAL_CLIENT_ID = process.env.DIGILOCKER_CLIENT_ID;
const ORIGINAL_CLIENT_SECRET = process.env.DIGILOCKER_CLIENT_SECRET;
const ORIGINAL_APISETU_KEY = process.env.APISETU_PARTNER_API_KEY;
const ORIGINAL_APISETU_CLIENT_ID = process.env.APISETU_CLIENT_ID;

afterEach(() => {
  // Restore env between tests so digilockerEnabled() flip-flops cleanly.
  if (ORIGINAL_CLIENT_ID === undefined) delete process.env.DIGILOCKER_CLIENT_ID;
  else process.env.DIGILOCKER_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_CLIENT_SECRET === undefined) delete process.env.DIGILOCKER_CLIENT_SECRET;
  else process.env.DIGILOCKER_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET;
  if (ORIGINAL_APISETU_KEY === undefined) delete process.env.APISETU_PARTNER_API_KEY;
  else process.env.APISETU_PARTNER_API_KEY = ORIGINAL_APISETU_KEY;
  if (ORIGINAL_APISETU_CLIENT_ID === undefined) delete process.env.APISETU_CLIENT_ID;
  else process.env.APISETU_CLIENT_ID = ORIGINAL_APISETU_CLIENT_ID;
});

// Reload the module fresh so any cached state doesn't bleed across tests.
function loadClient() {
  // The module has no top-level side effects beyond reading process.env
  // inside digilockerEnabled() (lazy) — but use require so we get the
  // singleton-friendly CommonJS shape that routes consume.
  delete requireCjs.cache[requireCjs.resolve('../../services/digilockerClient.js')];
  return requireCjs('../../services/digilockerClient.js');
}

describe('digilockerClient — module shape', () => {
  test('exports digilockerEnabled, initiateSession, exchangeCallback', () => {
    const client = loadClient();
    expect(typeof client.digilockerEnabled).toBe('function');
    expect(typeof client.initiateSession).toBe('function');
    expect(typeof client.exchangeCallback).toBe('function');
  });
});

describe('digilockerEnabled', () => {
  test('returns false when neither env var is set', () => {
    delete process.env.DIGILOCKER_CLIENT_ID;
    delete process.env.DIGILOCKER_CLIENT_SECRET;
    const client = loadClient();
    expect(client.digilockerEnabled()).toBe(false);
  });

  test('returns false when only CLIENT_ID is set', () => {
    process.env.DIGILOCKER_CLIENT_ID = 'real-client-id';
    delete process.env.DIGILOCKER_CLIENT_SECRET;
    const client = loadClient();
    expect(client.digilockerEnabled()).toBe(false);
  });

  test('returns false when only CLIENT_SECRET is set', () => {
    delete process.env.DIGILOCKER_CLIENT_ID;
    process.env.DIGILOCKER_CLIENT_SECRET = 'real-client-secret';
    const client = loadClient();
    expect(client.digilockerEnabled()).toBe(false);
  });

  test('returns true when both env vars are set', () => {
    process.env.DIGILOCKER_CLIENT_ID = 'real-client-id';
    process.env.DIGILOCKER_CLIENT_SECRET = 'real-client-secret';
    const client = loadClient();
    expect(client.digilockerEnabled()).toBe(true);
  });
});

describe('initiateSession', () => {
  test('returns a 32-char hex state (16 random bytes)', async () => {
    const client = loadClient();
    const out = await client.initiateSession({
      participantId: 42,
      redirectUri: 'https://example.com/callback',
    });
    expect(out.state).toMatch(/^[0-9a-f]{32}$/);
  });

  test('oauthUrl embeds the state query param verbatim', async () => {
    const client = loadClient();
    const out = await client.initiateSession({
      participantId: 7,
      redirectUri: 'https://example.com/cb',
    });
    expect(out.oauthUrl).toContain(`state=${out.state}`);
  });

  test('oauthUrl uses the stub base (NOT real DigiLocker)', async () => {
    const client = loadClient();
    const out = await client.initiateSession({
      participantId: 1,
      redirectUri: 'https://example.com/cb',
    });
    expect(out.oauthUrl).toMatch(/^https:\/\/digilocker-stub\.invalid\/oauth\/authorize\?/);
  });

  test('oauthUrl carries redirect_uri + response_type + scope query params', async () => {
    const client = loadClient();
    const out = await client.initiateSession({
      participantId: 1,
      redirectUri: 'https://example.com/cb',
    });
    expect(out.oauthUrl).toContain('response_type=code');
    expect(out.oauthUrl).toContain('scope=aadhaar');
    expect(out.oauthUrl).toContain('redirect_uri=https');
  });

  test('two calls return different state values (CSRF randomness)', async () => {
    const client = loadClient();
    const a = await client.initiateSession({ participantId: 1, redirectUri: 'r' });
    const b = await client.initiateSession({ participantId: 1, redirectUri: 'r' });
    expect(a.state).not.toBe(b.state);
  });
});

describe('exchangeCallback', () => {
  test('throws when state is missing', async () => {
    const client = loadClient();
    await expect(client.exchangeCallback({ code: 'c' })).rejects.toThrow(/state required/);
  });

  test('throws when state is empty string', async () => {
    const client = loadClient();
    await expect(client.exchangeCallback({ state: '', code: 'c' })).rejects.toThrow(/state required/);
  });

  test('returns deterministic last4 "9999" (stub-mode synthetic)', async () => {
    const client = loadClient();
    const out = await client.exchangeCallback({ state: 'deadbeef', code: 'auth-code' });
    expect(out.aadhaarLast4).toBe('9999');
  });

  test('tokenId is deterministically derived from state hash', async () => {
    const client = loadClient();
    const a = await client.exchangeCallback({ state: 'same-state', code: 'c' });
    const b = await client.exchangeCallback({ state: 'same-state', code: 'different-code' });
    // Same state → same token (verifies the hash-derivation contract).
    expect(a.aadhaarTokenId).toBe(b.aadhaarTokenId);
    expect(a.aadhaarTokenId).toMatch(/^stub-token-[0-9a-f]{24}$/);
  });

  test('different states yield different tokenIds', async () => {
    const client = loadClient();
    const a = await client.exchangeCallback({ state: 'state-a', code: 'c' });
    const b = await client.exchangeCallback({ state: 'state-b', code: 'c' });
    expect(a.aadhaarTokenId).not.toBe(b.aadhaarTokenId);
  });
});

// ─── APISetu real-mode coverage (Travel customer-portal KYC) ─────────
//
// The Travel customer portal added support for APISETU_PARTNER_API_KEY
// (Indian gov partner programme — https://partners.apisetu.gov.in/).
// When the key is present the client switches from stub to real DigiLocker
// calls. These tests pin the mode-detection + initiate-URL shape without
// actually hitting the network (no fetch mocking needed for these — the
// real-mode network paths get exercised by the portal-kyc API spec).

describe('digilockerEnabled — APISetu partner mode', () => {
  test('returns true when APISETU_PARTNER_API_KEY is set (legacy OAuth2 vars unset)', () => {
    delete process.env.DIGILOCKER_CLIENT_ID;
    delete process.env.DIGILOCKER_CLIENT_SECRET;
    process.env.APISETU_PARTNER_API_KEY = 'apisetu-bearer-key-xyz';
    const client = loadClient();
    expect(client.digilockerEnabled()).toBe(true);
  });

  test('APISetu key alone is sufficient — DIGILOCKER_CLIENT_SECRET not required', () => {
    delete process.env.DIGILOCKER_CLIENT_SECRET;
    process.env.APISETU_PARTNER_API_KEY = 'k';
    const client = loadClient();
    expect(client.digilockerEnabled()).toBe(true);
  });
});

describe('authMode — mode detection precedence', () => {
  test('exports authMode() function', () => {
    const client = loadClient();
    expect(typeof client.authMode).toBe('function');
  });

  test('returns "stub" when no env vars are set', () => {
    delete process.env.DIGILOCKER_CLIENT_ID;
    delete process.env.DIGILOCKER_CLIENT_SECRET;
    delete process.env.APISETU_PARTNER_API_KEY;
    const client = loadClient();
    expect(client.authMode()).toBe('stub');
  });

  test('returns "apisetu-partner" when APISETU_PARTNER_API_KEY is set (precedence over OAuth2)', () => {
    process.env.APISETU_PARTNER_API_KEY = 'k';
    process.env.DIGILOCKER_CLIENT_ID = 'legacy-id';
    process.env.DIGILOCKER_CLIENT_SECRET = 'legacy-secret';
    const client = loadClient();
    expect(client.authMode()).toBe('apisetu-partner');
  });

  test('returns "oauth2" when only DIGILOCKER_CLIENT_ID/SECRET pair is set', () => {
    delete process.env.APISETU_PARTNER_API_KEY;
    process.env.DIGILOCKER_CLIENT_ID = 'legacy-id';
    process.env.DIGILOCKER_CLIENT_SECRET = 'legacy-secret';
    const client = loadClient();
    expect(client.authMode()).toBe('oauth2');
  });
});

describe('initiateSession — real-mode authorize URL', () => {
  test('builds real DigiLocker authorize URL when APISetu key + APISETU_CLIENT_ID set', async () => {
    process.env.APISETU_PARTNER_API_KEY = 'apisetu-key';
    process.env.APISETU_CLIENT_ID = 'apisetu-client-123';
    const client = loadClient();
    const out = await client.initiateSession({
      subjectId: 99,
      subjectType: 'contact',
      redirectUri: 'http://localhost:5173/travel/portal/kyc/callback',
    });
    expect(out.oauthUrl).toMatch(/^https:\/\/api\.digitallocker\.gov\.in\/public\/oauth2\/1\/authorize/);
    expect(out.oauthUrl).toContain('client_id=apisetu-client-123');
    expect(out.oauthUrl).toContain(`state=${out.state}`);
  });

  test('throws when real-mode enabled but no client_id available', async () => {
    process.env.APISETU_PARTNER_API_KEY = 'apisetu-key';
    delete process.env.APISETU_CLIENT_ID;
    delete process.env.DIGILOCKER_CLIENT_ID;
    const client = loadClient();
    await expect(
      client.initiateSession({ subjectId: 1, subjectType: 'contact', redirectUri: 'r' }),
    ).rejects.toThrow(/APISETU_CLIENT_ID/);
  });

  test('falls back to DIGILOCKER_CLIENT_ID when APISETU_CLIENT_ID is unset', async () => {
    process.env.APISETU_PARTNER_API_KEY = 'k';
    delete process.env.APISETU_CLIENT_ID;
    process.env.DIGILOCKER_CLIENT_ID = 'legacy-client-id';
    const client = loadClient();
    const out = await client.initiateSession({
      subjectId: 1,
      subjectType: 'contact',
      redirectUri: 'r',
    });
    expect(out.oauthUrl).toContain('client_id=legacy-client-id');
  });

  test('back-compat: legacy callers using `participantId` (not `subjectId`) still work', async () => {
    delete process.env.APISETU_PARTNER_API_KEY;
    delete process.env.DIGILOCKER_CLIENT_ID;
    delete process.env.DIGILOCKER_CLIENT_SECRET;
    const client = loadClient();
    const out = await client.initiateSession({
      participantId: 42,
      redirectUri: 'https://example.com/cb',
    });
    // Falls back to stub since no creds set; existing TripParticipant
    // call-sites in routes/travel_trips.js depend on this back-compat.
    expect(out.state).toMatch(/^[0-9a-f]{32}$/);
    expect(out.oauthUrl).toContain('digilocker-stub.invalid');
  });
});

describe('exchangeCallback — real-mode error paths', () => {
  test('throws when code is missing in real mode', async () => {
    process.env.APISETU_PARTNER_API_KEY = 'k';
    process.env.APISETU_CLIENT_ID = 'cid';
    const client = loadClient();
    await expect(
      client.exchangeCallback({ state: 'abc' }),
    ).rejects.toThrow(/code required/);
  });

  test('stub mode does NOT require code (back-compat)', async () => {
    delete process.env.APISETU_PARTNER_API_KEY;
    delete process.env.DIGILOCKER_CLIENT_ID;
    delete process.env.DIGILOCKER_CLIENT_SECRET;
    const client = loadClient();
    // No `code` arg — stub mode generates synthetic values from state alone.
    const out = await client.exchangeCallback({ state: 'state-x' });
    expect(out.aadhaarLast4).toBe('9999');
  });
});
