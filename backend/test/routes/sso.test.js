// @ts-check
/**
 * Unit tests for backend/routes/sso.js — pins the SSO route contract.
 *
 * Why this file exists
 * ────────────────────
 * routes/sso.js wires THREE distinct surfaces:
 *
 *   1. Google OAuth (start + callback)
 *   2. Microsoft OAuth (start + callback) — raw fetch, no SDK
 *   3. Tenant-scoped SsoConfig CRUD (GET + PUT) — admin-gated by
 *      verifyToken + verifyRole(['ADMIN']) on PUT
 *
 * The contract that matters for downstream consumers (the Login SPA
 * page reading `?sso_error=…`, the Settings → SSO Config UI, sister
 * tenants discovering their own SSO config rows) is:
 *
 *   GOOGLE
 *   ──────
 *   G-1. GET /google/start 500s with a plain-text error when
 *        GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing.
 *   G-2. GET /google/start 302-redirects to the Google OAuth URL
 *        when credentials are configured (the URL itself is what
 *        google.auth.OAuth2#generateAuthUrl returned).
 *   G-3. GET /google/callback redirects to /login?sso_error=… when
 *        Google passes `?error=…` (user denied / consent screen
 *        bounce). The legacy /sso/return?error= path is intentionally
 *        gone — the in-source comment pins the contract.
 *   G-4. GET /google/callback redirects to /login?sso_error=… when
 *        the `code` query param is missing.
 *   G-5. GET /google/callback redirects to /login?sso_error=… with
 *        a generic "Google SSO failed" message when token exchange
 *        throws.
 *   G-6. GET /google/callback happy path: exchanges code → fetches
 *        profile → findOrCreateSsoUser → issueJwt → 302 redirect to
 *        FRONTEND_URL/sso/return?token=…&tenant=…
 *
 *   MICROSOFT
 *   ─────────
 *   M-1. GET /microsoft/start 500s when MICROSOFT_CLIENT_ID is missing.
 *   M-2. GET /microsoft/start 302-redirects to login.microsoftonline.com
 *        with the right OAuth params (client_id, redirect_uri, scope).
 *   M-3. GET /microsoft/callback relays `?error=…` (preferring
 *        error_description over the bare error code) to /login.
 *   M-4. GET /microsoft/callback redirects on missing code.
 *   M-5. GET /microsoft/callback redirects on token-exchange HTTP
 *        failure (non-2xx response from MS token endpoint).
 *   M-6. GET /microsoft/callback redirects when Graph /me returns
 *        a profile missing `id` or both `mail` AND `userPrincipalName`.
 *   M-7. GET /microsoft/callback happy path → 302 to
 *        FRONTEND_URL/sso/return?token=…
 *
 *   CONFIG CRUD
 *   ───────────
 *   C-1. GET /config returns rows scoped to req.user.tenantId with
 *        clientSecret masked (never the plaintext secret).
 *   C-2. PUT /config/:provider rejects unsupported provider names
 *        with 400 "Unsupported SSO provider".
 *   C-3. PUT /config/:provider upserts on (tenantId, provider) and
 *        returns the masked envelope.
 *   C-4. PUT /config/:provider with empty clientSecret in body does
 *        NOT overwrite the prior secret (partial-update preserve
 *        behavior).
 *
 * Pattern
 * ───────
 *   Mirror of backend/test/routes/calendar-google.test.js + admin.test.js:
 *
 *   - Auth middleware bypass: monkey-patch `authMw.verifyToken` AND
 *     `authMw.verifyRole` at module-load so destructured references
 *     in the router capture the pass-through. Required because PUT
 *     /config/:provider uses verifyRole(['ADMIN']) — we pass through
 *     in tests since the role check is a separate concern pinned in
 *     middleware/auth.test.js.
 *
 *   - Prisma singleton patching: replace the lazy $extends-proxy
 *     delegates for user + tenant + ssoConfig with bare vi.fn()
 *     surfaces. The router only touches these three delegates.
 *
 *   - googleapis SDK mocking: same pattern as calendar-google.test.js.
 *     Monkey-patch google.auth.OAuth2 to return a fake whose
 *     generateAuthUrl + getToken + setCredentials are controllable.
 *     Also monkey-patch google.oauth2 (used by the route to fetch
 *     the userinfo from Google after token exchange).
 *
 *   - global.fetch mocking: the Microsoft callback uses bare `fetch`
 *     (Node 18+ global). We stub via vi.stubGlobal('fetch', ...).
 *
 * What this file does NOT cover (intentional):
 *   - The RBAC denial path for PUT /config/:provider — pinned by
 *     middleware/auth.test.js + the cross-route RBAC e2e spec.
 *   - End-to-end cookie / session flow — the route is stateless and
 *     issues a JWT in the redirect query.
 *   - Tenant cross-isolation — pinned in the e2e spec
 *     e2e/tests/sso.spec.js.
 */
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── Auth middleware bypass ─────────────────────────────────────────
// Pass-through verifyToken + verifyRole so we exercise the route
// logic without minting JWTs. Same pattern as accounting.test.js +
// admin.test.js.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// ─── googleapis monkey-patch ────────────────────────────────────────
// The route does `const { google } = require('googleapis')` at module
// load. We replace `google.auth.OAuth2` (used in both /start and
// /callback) and `google.oauth2` (used in /callback for the userinfo
// fetch) BEFORE the router is required.
const googleapis = requireCJS('googleapis');

const oauth2State = {
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
};
const userinfoState = {
  get: vi.fn(),
};

googleapis.google.auth.OAuth2 = function FakeOAuth2() {
  return {
    generateAuthUrl: (...args) => oauth2State.generateAuthUrl(...args),
    getToken: (...args) => oauth2State.getToken(...args),
    setCredentials: (...args) => oauth2State.setCredentials(...args),
  };
};

googleapis.google.oauth2 = function fakeOauth2() {
  return {
    userinfo: {
      get: (...args) => userinfoState.get(...args),
    },
  };
};

// ─── Prisma singleton patching ──────────────────────────────────────
prisma.user = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
};
prisma.tenant = {
  findUnique: vi.fn(),
  create: vi.fn(),
};
prisma.ssoConfig = {
  findMany: vi.fn(),
  upsert: vi.fn(),
};

// Pin env vars so /start doesn't 500 in tests that exercise the
// happy path. Tests that need to flip these clear/restore them.
const ORIG_ENV = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
  MICROSOFT_REDIRECT_URI: process.env.MICROSOFT_REDIRECT_URI,
  MICROSOFT_TENANT: process.env.MICROSOFT_TENANT,
  FRONTEND_URL: process.env.FRONTEND_URL,
  BACKEND_URL: process.env.BACKEND_URL,
};

process.env.GOOGLE_CLIENT_ID = 'test-g-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-g-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:5000/api/sso/google/callback';
process.env.MICROSOFT_CLIENT_ID = 'test-ms-id';
process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';
process.env.MICROSOFT_REDIRECT_URI = 'http://localhost:5000/api/sso/microsoft/callback';
process.env.MICROSOFT_TENANT = 'common';
process.env.FRONTEND_URL = 'http://localhost:5173';

import express from 'express';
import request from 'supertest';
const ssoRouter = requireCJS('../../routes/sso');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/sso', ssoRouter);
  return app;
}

beforeEach(() => {
  // Reset oauth + userinfo mocks.
  oauth2State.generateAuthUrl.mockReset();
  oauth2State.getToken.mockReset();
  oauth2State.setCredentials.mockReset();
  userinfoState.get.mockReset();

  // Reset prisma mocks.
  prisma.user.findFirst.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.update.mockReset();
  prisma.user.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.create.mockReset();
  prisma.ssoConfig.findMany.mockReset();
  prisma.ssoConfig.upsert.mockReset();

  // Sensible defaults — happy-path resolves.
  oauth2State.generateAuthUrl.mockReturnValue(
    'https://accounts.google.com/o/oauth2/v2/auth?stub=1'
  );
  oauth2State.getToken.mockResolvedValue({
    tokens: { access_token: 'at-stub', refresh_token: 'rt-stub' },
  });
  userinfoState.get.mockResolvedValue({
    data: {
      id: 'google-user-123',
      email: 'alice@example.com',
      name: 'Alice Example',
    },
  });

  // Default fetch stub — Microsoft token + Graph happy path.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'ms-at-stub' }),
          text: async () => '',
        };
      }
      if (u.includes('graph.microsoft.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ms-user-789',
            mail: 'bob@example.com',
            displayName: 'Bob Example',
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    })
  );

  // Pin env vars (defensive — some tests delete + restore in finally).
  process.env.GOOGLE_CLIENT_ID = 'test-g-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-g-secret';
  process.env.MICROSOFT_CLIENT_ID = 'test-ms-id';
  process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';
  process.env.FRONTEND_URL = 'http://localhost:5173';
});

afterAll(() => {
  // Restore original env so we don't leak test values to siblings.
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

// ─── GET /google/start ─────────────────────────────────────────────

describe('GET /api/sso/google/start', () => {
  test('500s with a plain-text message when GOOGLE_CLIENT_ID is missing', async () => {
    const orig = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const app = makeApp();
      const res = await request(app).get('/api/sso/google/start');
      expect(res.status).toBe(500);
      // Plain-text response (route uses res.send, not res.json).
      expect(res.text).toMatch(/Google SSO not configured/i);
      expect(oauth2State.generateAuthUrl).not.toHaveBeenCalled();
    } finally {
      process.env.GOOGLE_CLIENT_ID = orig;
    }
  });

  test('302-redirects to the Google OAuth URL when configured', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/sso/google/start');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?stub=1'
    );
    expect(oauth2State.generateAuthUrl).toHaveBeenCalledTimes(1);
    const args = oauth2State.generateAuthUrl.mock.calls[0][0];
    expect(args.access_type).toBe('offline');
    expect(args.prompt).toBe('consent');
    expect(Array.isArray(args.scope)).toBe(true);
    expect(args.scope).toEqual(expect.arrayContaining(['openid', 'profile', 'email']));
  });
});

// ─── GET /google/callback ───────────────────────────────────────────

describe('GET /api/sso/google/callback', () => {
  test('relays Google ?error=… to /login?sso_error=… (NOT /sso/return)', async () => {
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/google/callback?error=access_denied'
    );
    expect(res.status).toBe(302);
    // The contract: /login?sso_error= is the canonical redirect target.
    // The route's `redirectWithError` comment pins this — pre-fix it
    // sent users to /sso/return?error= which the SPA didn't handle.
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    expect(res.headers.location).toMatch(/access_denied/);
    expect(res.headers.location).not.toMatch(/\/sso\/return/);
    expect(oauth2State.getToken).not.toHaveBeenCalled();
  });

  test('redirects to /login?sso_error=… when ?code is missing', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/sso/google/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    expect(res.headers.location).toMatch(/Missing/i);
    expect(oauth2State.getToken).not.toHaveBeenCalled();
  });

  test('token exchange failure redirects to /login?sso_error=Google%20SSO%20failed', async () => {
    oauth2State.getToken.mockRejectedValueOnce(new Error('bad code'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/google/callback?code=abc'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    expect(res.headers.location).toMatch(/Google%20SSO%20failed/);
    consoleSpy.mockRestore();
  });

  test('happy path — existing user looked up by googleId returns JWT in redirect', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 42,
      email: 'alice@example.com',
      role: 'ADMIN',
      tenantId: 9,
      googleId: 'google-user-123',
      tenant: { id: 9, name: 'Acme', slug: 'acme', plan: 'pro' },
    });
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/google/callback?code=auth-code-xyz'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/sso\/return\?token=/);
    expect(res.headers.location).toMatch(/tenant=/);
    // The lookup was by googleId; no link/create branches fired.
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
    const findArgs = prisma.user.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ googleId: 'google-user-123' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  test('links existing local user by email — updates googleId + ssoProvider', async () => {
    // findFirst (by googleId) returns null — no prior link.
    prisma.user.findFirst.mockResolvedValueOnce(null);
    // findUnique (by email) returns the existing local user.
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 100,
      email: 'alice@example.com',
      role: 'USER',
      tenantId: 5,
      tenant: { id: 5, name: 'Legacy', slug: 'legacy', plan: 'starter' },
    });
    prisma.user.update.mockResolvedValueOnce({
      id: 100,
      email: 'alice@example.com',
      role: 'USER',
      tenantId: 5,
      googleId: 'google-user-123',
      ssoProvider: 'google',
      tenant: { id: 5, name: 'Legacy', slug: 'legacy', plan: 'starter' },
    });
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/google/callback?code=auth-code-xyz'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/sso\/return\?token=/);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 100 });
    expect(updateArgs.data.googleId).toBe('google-user-123');
    expect(updateArgs.data.ssoProvider).toBe('google');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  test('net-new user — provisions a fresh tenant + user with role=ADMIN', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValueOnce(null);
    // generateUniqueSlug calls tenant.findUnique to probe collisions.
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.tenant.create.mockResolvedValueOnce({
      id: 999,
      name: "Alice Example's Organization",
      slug: 'alice-examples-organization',
      plan: 'starter',
      ownerEmail: 'alice@example.com',
    });
    prisma.user.create.mockResolvedValueOnce({
      id: 1234,
      email: 'alice@example.com',
      role: 'ADMIN',
      tenantId: 999,
      googleId: 'google-user-123',
      ssoProvider: 'google',
      tenant: {
        id: 999,
        name: "Alice Example's Organization",
        slug: 'alice-examples-organization',
        plan: 'starter',
      },
    });
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/google/callback?code=auth-code-xyz'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/sso\/return\?token=/);
    expect(prisma.tenant.create).toHaveBeenCalledTimes(1);
    const tenantArgs = prisma.tenant.create.mock.calls[0][0];
    expect(tenantArgs.data.ownerEmail).toBe('alice@example.com');
    expect(tenantArgs.data.plan).toBe('starter');

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const userArgs = prisma.user.create.mock.calls[0][0];
    expect(userArgs.data.email).toBe('alice@example.com');
    expect(userArgs.data.role).toBe('ADMIN');
    expect(userArgs.data.googleId).toBe('google-user-123');
    expect(userArgs.data.ssoProvider).toBe('google');
    // Placeholder password is required-column compatibility — must be set.
    expect(typeof userArgs.data.password).toBe('string');
    expect(userArgs.data.password.length).toBeGreaterThan(0);
  });
});

// ─── GET /microsoft/start ───────────────────────────────────────────

describe('GET /api/sso/microsoft/start', () => {
  test('500s with a plain-text message when MICROSOFT_CLIENT_ID is missing', async () => {
    const orig = process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_ID;
    try {
      const app = makeApp();
      const res = await request(app).get('/api/sso/microsoft/start');
      expect(res.status).toBe(500);
      expect(res.text).toMatch(/Microsoft SSO not configured/i);
    } finally {
      process.env.MICROSOFT_CLIENT_ID = orig;
    }
  });

  test('302-redirects to login.microsoftonline.com with the right OAuth params', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/sso/microsoft/start');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/
    );
    expect(res.headers.location).toContain('client_id=test-ms-id');
    expect(res.headers.location).toContain('response_type=code');
    expect(res.headers.location).toContain('scope=openid');
  });
});

// ─── GET /microsoft/callback ────────────────────────────────────────

describe('GET /api/sso/microsoft/callback', () => {
  test('relays ?error=… and prefers error_description over the bare code', async () => {
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/microsoft/callback?error=access_denied&error_description=User%20cancelled'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    // error_description wins over error.
    expect(decodeURIComponent(res.headers.location)).toMatch(/User cancelled/);
  });

  test('redirects to /login?sso_error=… when ?code is missing', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/sso/microsoft/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    expect(res.headers.location).toMatch(/Missing/i);
  });

  test('redirects when token exchange returns non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
        text: async () => 'invalid_grant',
      }))
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/microsoft/callback?code=abc'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    expect(decodeURIComponent(res.headers.location)).toMatch(
      /Microsoft token exchange failed/i
    );
    consoleSpy.mockRestore();
  });

  test('redirects when Graph /me returns a profile missing both mail AND userPrincipalName', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('oauth2/v2.0/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'ms-at-stub' }),
            text: async () => '',
          };
        }
        // Graph response missing the email fields.
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'ms-789', displayName: 'NoEmail User' }),
          text: async () => '',
        };
      })
    );
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/microsoft/callback?code=abc'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    expect(decodeURIComponent(res.headers.location)).toMatch(/usable profile/i);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  test('happy path — existing user by microsoftId, redirects with JWT', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 55,
      email: 'bob@example.com',
      role: 'USER',
      tenantId: 3,
      microsoftId: 'ms-user-789',
      tenant: { id: 3, name: 'Beta', slug: 'beta', plan: 'starter' },
    });
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/microsoft/callback?code=abc'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/sso\/return\?token=/);
    expect(res.headers.location).toMatch(/tenant=/);
    const findArgs = prisma.user.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ microsoftId: 'ms-user-789' });
  });

  test('falls back to userPrincipalName when profile.mail is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('oauth2/v2.0/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'ms-at-stub' }),
            text: async () => '',
          };
        }
        // mail missing — userPrincipalName must be used as email.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ms-upn-1',
            userPrincipalName: 'carol@example.com',
            displayName: 'Carol Example',
          }),
          text: async () => '',
        };
      })
    );
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 77,
      email: 'carol@example.com',
      role: 'USER',
      tenantId: 4,
      microsoftId: 'ms-upn-1',
      tenant: { id: 4, name: 'Gamma', slug: 'gamma', plan: 'starter' },
    });
    const app = makeApp();
    const res = await request(app).get(
      '/api/sso/microsoft/callback?code=abc'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/sso\/return\?token=/);
  });
});

// ─── GET /config ────────────────────────────────────────────────────

describe('GET /api/sso/config', () => {
  test('returns rows scoped to req.user.tenantId with masked clientSecret', async () => {
    prisma.ssoConfig.findMany.mockResolvedValueOnce([
      {
        id: 1,
        provider: 'google',
        clientId: 'g-public-id',
        clientSecret: 'super-secret-google-key-1234567890',
        redirectUri: 'https://crm.example.com/api/sso/google/callback',
        isActive: true,
        tenantId: 9,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        id: 2,
        provider: 'microsoft',
        clientId: 'ms-public-id',
        clientSecret: null,
        redirectUri: null,
        isActive: false,
        tenantId: 9,
        createdAt: new Date('2026-01-03T00:00:00Z'),
        updatedAt: new Date('2026-01-04T00:00:00Z'),
      },
    ]);
    const app = makeApp({ tenantId: 9, userId: 7, role: 'ADMIN' });
    const res = await request(app).get('/api/sso/config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    // Verify the prisma lookup is scoped to the JWT tenantId.
    const findArgs = prisma.ssoConfig.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 9 });

    // The plaintext secret never appears in the response.
    const stringified = JSON.stringify(res.body);
    expect(stringified).not.toContain('super-secret-google-key-1234567890');
    // First row is masked (mask is "su" + stars + "90" by the route's helper).
    expect(res.body[0].clientSecret).toMatch(/^su\*+90$/);
    // Null secret stays null.
    expect(res.body[1].clientSecret).toBeNull();
    // ClientId stays visible (it's a public identifier, not a secret).
    expect(res.body[0].clientId).toBe('g-public-id');
  });

  test('500s with a deterministic envelope when the DB lookup throws', async () => {
    prisma.ssoConfig.findMany.mockRejectedValueOnce(
      new Error('db connection lost')
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).get('/api/sso/config');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to load SSO configuration/i);
    consoleSpy.mockRestore();
  });
});

// ─── PUT /config/:provider ──────────────────────────────────────────

describe('PUT /api/sso/config/:provider', () => {
  test('400s on an unsupported provider name', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/sso/config/facebook')
      .send({ clientId: 'x', clientSecret: 'y' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported SSO provider/i);
    expect(prisma.ssoConfig.upsert).not.toHaveBeenCalled();
  });

  test('happy path — upserts on (tenantId, provider) and returns masked envelope', async () => {
    prisma.ssoConfig.upsert.mockResolvedValueOnce({
      id: 17,
      provider: 'google',
      clientId: 'g-id-new',
      clientSecret: 'top-secret-NEW-google-secret-zzz',
      redirectUri: 'https://example.com/cb',
      isActive: true,
      tenantId: 9,
    });
    const app = makeApp({ tenantId: 9, userId: 7, role: 'ADMIN' });
    const res = await request(app)
      .put('/api/sso/config/google')
      .send({
        clientId: 'g-id-new',
        clientSecret: 'top-secret-NEW-google-secret-zzz',
        redirectUri: 'https://example.com/cb',
        isActive: true,
      });
    expect(res.status).toBe(200);

    // Verify the upsert was scoped via the unique composite key.
    expect(prisma.ssoConfig.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.ssoConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.where.tenantId_provider).toEqual({
      tenantId: 9,
      provider: 'google',
    });
    expect(upsertArgs.create.tenantId).toBe(9);
    expect(upsertArgs.create.provider).toBe('google');
    expect(upsertArgs.create.clientSecret).toBe('top-secret-NEW-google-secret-zzz');
    expect(upsertArgs.update.clientSecret).toBe('top-secret-NEW-google-secret-zzz');

    // Response masks the secret.
    expect(JSON.stringify(res.body)).not.toContain('top-secret-NEW-google-secret-zzz');
    expect(res.body.clientSecret).toMatch(/^to\*+zz$/);
    expect(res.body.clientId).toBe('g-id-new');
    expect(res.body.isActive).toBe(true);
  });

  test('partial-update — empty clientSecret in body does NOT overwrite prior secret', async () => {
    prisma.ssoConfig.upsert.mockResolvedValueOnce({
      id: 17,
      provider: 'google',
      clientId: 'g-id-new',
      clientSecret: 'previously-saved-secret-stays',
      redirectUri: 'https://example.com/cb',
      isActive: true,
      tenantId: 9,
    });
    const app = makeApp({ tenantId: 9, userId: 7, role: 'ADMIN' });
    const res = await request(app)
      .put('/api/sso/config/google')
      .send({
        clientId: 'g-id-new',
        clientSecret: '', // empty → must be omitted from the update spread
        redirectUri: 'https://example.com/cb',
        isActive: true,
      });
    expect(res.status).toBe(200);
    const upsertArgs = prisma.ssoConfig.upsert.mock.calls[0][0];
    // The update branch must NOT contain a clientSecret key — preserves
    // whatever's in the DB. The route does this via the spread:
    //   ...(clientSecret ? { clientSecret } : {})
    expect('clientSecret' in upsertArgs.update).toBe(false);
    // Create branch falls through to null when secret missing.
    expect(upsertArgs.create.clientSecret).toBeNull();
  });

  test('accepts uppercase provider names (normalised to lowercase)', async () => {
    prisma.ssoConfig.upsert.mockResolvedValueOnce({
      id: 18,
      provider: 'microsoft',
      clientId: 'ms-id',
      clientSecret: 'short',
      redirectUri: null,
      isActive: false,
      tenantId: 9,
    });
    const app = makeApp({ tenantId: 9, userId: 7, role: 'ADMIN' });
    const res = await request(app)
      .put('/api/sso/config/MICROSOFT')
      .send({ clientId: 'ms-id', clientSecret: 'short' });
    expect(res.status).toBe(200);
    const upsertArgs = prisma.ssoConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.where.tenantId_provider.provider).toBe('microsoft');
    expect(upsertArgs.create.provider).toBe('microsoft');
    // maskSecret: secret.length > 4 → first 2 + Math.max(4, len-4) stars
    // + last 2. "short" (5 chars) → "sh" + "****" (max(4, 1)=4) + "rt".
    expect(res.body.clientSecret).toBe('sh****rt');
  });

  test('500s with a deterministic envelope when the upsert throws', async () => {
    prisma.ssoConfig.upsert.mockRejectedValueOnce(
      new Error('unique constraint violation')
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app)
      .put('/api/sso/config/google')
      .send({ clientId: 'g', clientSecret: 's' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to save SSO configuration/i);
    consoleSpy.mockRestore();
  });
});
