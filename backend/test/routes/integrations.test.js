// @ts-check
/**
 * Unit tests for backend/routes/integrations.js — pin the
 * Integrations-catalogue + connect/disconnect/toggle + marketplace-status +
 * Callified SSO contract.
 *
 * Why this file exists
 * ────────────────────
 * integrations.js is the catalogue surface for ALL third-party providers the
 * CRM can talk to (Slack, Google, Stripe, Razorpay, Mailchimp, QuickBooks,
 * Xero, Tally, Zapier, WhatsApp, IndiaMART, JustDial — see
 * AVAILABLE_INTEGRATIONS) PLUS the per-tenant on/off switch and the
 * marketplace-status chip data on the /marketplace-leads page header. The
 * contracts that matter:
 *
 *   1. GET / returns the full 12-entry catalogue with per-tenant isActive
 *      flags overlaid from the Integration table (defaults isActive=false
 *      and id=null when no row exists for that provider).
 *   2. POST /connect is ADMIN-only — verifyRole(['ADMIN']) gate. Body
 *      requires `provider`; 400 with `Provider required` envelope on miss.
 *      Settings JSON is stringified before persistence (the column is a
 *      TEXT JSON-string column, not Prisma JSON). Tenant scoping via the
 *      `tenantId_provider` composite unique key prevents cross-tenant
 *      collisions on upsert.
 *   3. POST /disconnect is ADMIN-only. updateMany scoped to
 *      (tenantId, provider) — flips isActive=false and clears the token.
 *      No 404 — the route is idempotent (no-op if there's no matching
 *      row).
 *   4. POST /toggle is the legacy backwards-compat switch (kept per #409),
 *      also ADMIN-only. Same upsert shape as /connect but only flips
 *      isActive — no token/settings management.
 *   5. GET /marketplace/status returns per-provider chip data for the 3
 *      marketplace providers (indiamart/justdial/tradeindia). Health hint
 *      semantics encoded inline:
 *        - `never_configured` — no MarketplaceConfig row
 *        - `inactive` — configured but isActive=false
 *        - `connected` — configured + isActive + leadsLast30d > 0
 *        - `idle` — configured + isActive + 0 leads + lastSyncAt < 24h
 *        - `stale` — configured + isActive + lastSyncAt null OR > 24h ago
 *      Non-admin readable — Owners + Managers see the row without leaking
 *      the masked API keys.
 *   6. GET /callified/auth-url returns a signed JWT URL for Callified SSO
 *      when CALLIFIED_SSO_SECRET is set; 503 with a deterministic
 *      "not yet available" envelope when the env var is absent. Roles
 *      map ADMIN→admin, MANAGER→agent, USER→viewer. JWT payload pins
 *      iss/aud/sub/email/name/role/org_id.
 *   7. GET /callified/sso is the popup-blocker-friendly 302 redirect
 *      variant of (6); same 503 plain-text shape when env is missing.
 *
 * Pattern: prisma-singleton monkey-patch + verifyToken/verifyRole bypass
 * mirrors backend/test/routes/accounting.test.js — the route's CJS
 * `require('../middleware/auth')` + destructured `verifyToken` / `verifyRole`
 * are replaced at module-load with pass-throughs (and a role-aware
 * factory) so we exercise the route logic without minting JWTs.
 *
 * What this file does NOT cover (intentional):
 *   - No real Callified SSO HTTP — the route only constructs the URL.
 *   - No real provider OAuth handshakes — the route is a catalogue +
 *     credential vault, not an OAuth client. Real OAuth flows live in
 *     provider-specific route files (calendar_google.js etc.).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch the auth middleware module BEFORE the integrations router is
// required — the router does `const { verifyToken, verifyRole } = require(...)`
// at module-load, so the destructured references capture whatever
// `authMw.verifyToken` / `authMw.verifyRole` point at THE MOMENT the route
// is required. Same pattern as accounting.test.js.
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
// verifyRole stays role-aware: routes call verifyRole(['ADMIN']) and we
// need to honor that gate so the 403 contract for non-ADMIN callers can
// be asserted. The factory receives the role list and returns a guard
// that 403s with the canonical RBAC_DENIED envelope.
authMw.verifyRole = (roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      error: "You don't have permission to perform this action. Contact your administrator.",
      code: 'RBAC_DENIED',
    });
  }
  next();
};

// Prisma singleton patching — replace the lazy $extends-proxy delegates
// with bare vi.fn() surfaces. The route touches Integration, User,
// MarketplaceConfig, MarketplaceLead.
prisma.integration = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.marketplaceConfig = {
  findMany: vi.fn(),
};
prisma.marketplaceLead = {
  count: vi.fn(),
};

import express from 'express';
import request from 'supertest';
const integrationsRouter = requireCJS('../../routes/integrations');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/integrations', integrationsRouter);
  return app;
}

beforeEach(() => {
  prisma.integration.findMany.mockReset();
  prisma.integration.findFirst.mockReset();
  prisma.integration.upsert.mockReset();
  prisma.integration.updateMany.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.marketplaceConfig.findMany.mockReset();
  prisma.marketplaceLead.count.mockReset();

  // Sensible defaults — happy-path resolves.
  prisma.integration.findMany.mockResolvedValue([]);
  prisma.integration.updateMany.mockResolvedValue({ count: 0 });
  prisma.marketplaceConfig.findMany.mockResolvedValue([]);
  prisma.marketplaceLead.count.mockResolvedValue(0);

  // Reset env for the Callified group — individual tests opt-in.
  delete process.env.CALLIFIED_SSO_SECRET;
  delete process.env.CALLIFIED_DASHBOARD_URL;
});

// ─── GET / — catalogue overlay ──────────────────────────────────────────

describe('GET /api/integrations — catalogue with per-tenant overlay', () => {
  test('empty Integration table → all 12 providers reported as inactive', async () => {
    prisma.integration.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(12);
    // Spot-check: every entry has isActive=false + id=null + connectedAt=null
    for (const entry of res.body) {
      expect(entry.isActive).toBe(false);
      expect(entry.id).toBeNull();
      expect(entry.connectedAt).toBeNull();
      // Static catalogue fields preserved.
      expect(entry).toHaveProperty('provider');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('description');
      expect(entry).toHaveProperty('category');
    }
    // Pin the canonical provider order — the catalogue order is what the
    // Settings → Integrations UI renders, downstream consumers rely on it.
    expect(res.body.map((e) => e.provider)).toEqual([
      'slack', 'google', 'stripe', 'razorpay', 'mailchimp',
      'quickbooks', 'xero', 'tally', 'zapier', 'whatsapp',
      'indiamart', 'justdial',
    ]);
  });

  test('active Integration rows overlay isActive + id + connectedAt', async () => {
    const connectedAt = new Date('2026-04-15T10:00:00Z');
    prisma.integration.findMany.mockResolvedValue([
      { id: 101, provider: 'slack', isActive: true, updatedAt: connectedAt },
      { id: 102, provider: 'zapier', isActive: false, updatedAt: connectedAt },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);

    const slack = res.body.find((e) => e.provider === 'slack');
    const zapier = res.body.find((e) => e.provider === 'zapier');
    const stripe = res.body.find((e) => e.provider === 'stripe');

    expect(slack.isActive).toBe(true);
    expect(slack.id).toBe(101);
    expect(slack.connectedAt).toBeTruthy();

    // Inactive row: id surfaces but isActive=false (so the UI can show
    // "previously connected" vs "never connected").
    expect(zapier.isActive).toBe(false);
    expect(zapier.id).toBe(102);

    // Provider with no row stays fully blank.
    expect(stripe.isActive).toBe(false);
    expect(stripe.id).toBeNull();
    expect(stripe.connectedAt).toBeNull();
  });

  test('scopes findMany to the requesting tenantId (tenant isolation)', async () => {
    prisma.integration.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 42 });
    await request(app).get('/api/integrations');
    expect(prisma.integration.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.integration.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 42 });
  });

  test('prisma failure → 500 with deterministic error envelope', async () => {
    prisma.integration.findMany.mockRejectedValue(new Error('db down'));
    const app = makeApp();
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch integrations' });
  });
});

// ─── POST /connect — credential persistence (ADMIN-only) ────────────────

describe('POST /api/integrations/connect — ADMIN gate + upsert shape', () => {
  test('non-ADMIN caller → 403 RBAC_DENIED before any DB call', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app)
      .post('/api/integrations/connect')
      .send({ provider: 'slack', token: 'xoxb-1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });

  test('MANAGER caller also blocked — only ADMIN may connect', async () => {
    const app = makeApp({ role: 'MANAGER' });
    const res = await request(app)
      .post('/api/integrations/connect')
      .send({ provider: 'slack' });
    expect(res.status).toBe(403);
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });

  test('missing provider → 400 with explicit error envelope', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/connect')
      .send({ token: 'xoxb-1', settings: { foo: 'bar' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Provider required' });
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });

  test('happy path upserts on tenantId_provider composite key with stringified settings', async () => {
    prisma.integration.upsert.mockResolvedValue({
      id: 555, provider: 'slack', isActive: true, token: 'xoxb-1',
    });
    const app = makeApp({ tenantId: 7 });
    const res = await request(app)
      .post('/api/integrations/connect')
      .send({
        provider: 'slack',
        token: 'xoxb-1',
        settings: { workspace: 'globussoft', channel: '#leads' },
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(555);

    expect(prisma.integration.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.integration.upsert.mock.calls[0][0];
    // Tenant-scoped composite key — no cross-tenant collision possible.
    expect(args.where).toEqual({
      tenantId_provider: { tenantId: 7, provider: 'slack' },
    });
    // Settings is JSON-STRINGIFIED before storage (column is TEXT, not JSON).
    expect(args.create.settings).toBe(
      JSON.stringify({ workspace: 'globussoft', channel: '#leads' }),
    );
    expect(args.create.token).toBe('xoxb-1');
    expect(args.create.isActive).toBe(true);
    expect(args.create.tenantId).toBe(7);
    expect(args.update.settings).toBe(
      JSON.stringify({ workspace: 'globussoft', channel: '#leads' }),
    );
    expect(args.update.isActive).toBe(true);
  });

  test('missing token + settings → upsert with null/null, isActive still true', async () => {
    prisma.integration.upsert.mockResolvedValue({ id: 1 });
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/connect')
      .send({ provider: 'mailchimp' });
    expect(res.status).toBe(200);
    const args = prisma.integration.upsert.mock.calls[0][0];
    expect(args.create.token).toBeNull();
    expect(args.create.settings).toBeNull();
    expect(args.update.token).toBeNull();
    expect(args.update.settings).toBeNull();
    expect(args.create.isActive).toBe(true);
  });

  test('prisma failure during connect → 500 with deterministic envelope', async () => {
    prisma.integration.upsert.mockRejectedValue(new Error('unique violation'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/connect')
      .send({ provider: 'slack', token: 't' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to connect integration' });
  });
});

// ─── POST /disconnect ──────────────────────────────────────────────────

describe('POST /api/integrations/disconnect — ADMIN gate + soft disable', () => {
  test('non-ADMIN caller → 403 RBAC_DENIED before any DB call', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app)
      .post('/api/integrations/disconnect')
      .send({ provider: 'slack' });
    expect(res.status).toBe(403);
    expect(prisma.integration.updateMany).not.toHaveBeenCalled();
  });

  test('happy path issues tenant-scoped updateMany(isActive=false, token=null)', async () => {
    prisma.integration.updateMany.mockResolvedValue({ count: 1 });
    const app = makeApp({ tenantId: 5 });
    const res = await request(app)
      .post('/api/integrations/disconnect')
      .send({ provider: 'slack' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.integration.updateMany).toHaveBeenCalledTimes(1);
    const args = prisma.integration.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 5, provider: 'slack' });
    expect(args.data).toEqual({ isActive: false, token: null });
  });

  test('idempotent — no error when no matching row exists (route does not 404)', async () => {
    prisma.integration.updateMany.mockResolvedValue({ count: 0 });
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/disconnect')
      .send({ provider: 'never-connected-provider' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('prisma failure during disconnect → 500 with deterministic envelope', async () => {
    prisma.integration.updateMany.mockRejectedValue(new Error('db down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/disconnect')
      .send({ provider: 'slack' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to disconnect' });
  });
});

// ─── POST /toggle — legacy backwards-compat switch (#409) ───────────────

describe('POST /api/integrations/toggle — legacy isActive switch', () => {
  test('non-ADMIN caller → 403 (ADMIN-only per #409 hardening)', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app)
      .post('/api/integrations/toggle')
      .send({ provider: 'slack', isActive: true });
    expect(res.status).toBe(403);
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });

  test('happy path upserts isActive without touching token/settings', async () => {
    prisma.integration.upsert.mockResolvedValue({ id: 12, isActive: true });
    const app = makeApp({ tenantId: 3 });
    const res = await request(app)
      .post('/api/integrations/toggle')
      .send({ provider: 'zapier', isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(12);
    const args = prisma.integration.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      tenantId_provider: { tenantId: 3, provider: 'zapier' },
    });
    expect(args.update).toEqual({ isActive: true });
    expect(args.create).toEqual({
      provider: 'zapier', isActive: true, tenantId: 3,
    });
    // toggle is intentionally NARROWER than connect — no token/settings
    // shape should land in either branch.
    expect(args.create.token).toBeUndefined();
    expect(args.create.settings).toBeUndefined();
  });
});

// ─── GET /marketplace/status — per-provider chip data ───────────────────

describe('GET /api/integrations/marketplace/status — health-hint matrix', () => {
  test('no MarketplaceConfig rows → all three providers report never_configured', async () => {
    prisma.marketplaceConfig.findMany.mockResolvedValue([]);
    prisma.marketplaceLead.count.mockResolvedValue(0);
    const app = makeApp();
    const res = await request(app).get('/api/integrations/marketplace/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((p) => p.provider)).toEqual([
      'indiamart', 'justdial', 'tradeindia',
    ]);
    for (const p of res.body) {
      expect(p.configured).toBe(false);
      expect(p.isActive).toBe(false);
      expect(p.lastSyncAt).toBeNull();
      expect(p.healthHint).toBe('never_configured');
    }
  });

  test('configured + isActive + leads>0 → connected (green chip)', async () => {
    const recentSync = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { provider: 'indiamart', isActive: true, lastSyncAt: recentSync },
    ]);
    // The route fires 3 parallel counts in MARKETPLACE_PROVIDERS order
    // (indiamart, justdial, tradeindia). Match that order.
    prisma.marketplaceLead.count
      .mockResolvedValueOnce(47) // indiamart
      .mockResolvedValueOnce(0)  // justdial
      .mockResolvedValueOnce(0); // tradeindia

    const app = makeApp();
    const res = await request(app).get('/api/integrations/marketplace/status');
    expect(res.status).toBe(200);
    const indiamart = res.body.find((p) => p.provider === 'indiamart');
    expect(indiamart.configured).toBe(true);
    expect(indiamart.isActive).toBe(true);
    expect(indiamart.leadsLast30d).toBe(47);
    expect(indiamart.healthHint).toBe('connected');
  });

  test('configured + isActive=false → inactive (gray chip)', async () => {
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { provider: 'justdial', isActive: false, lastSyncAt: new Date() },
    ]);
    prisma.marketplaceLead.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/integrations/marketplace/status');
    const justdial = res.body.find((p) => p.provider === 'justdial');
    expect(justdial.healthHint).toBe('inactive');
  });

  test('configured + isActive + 0 leads + lastSyncAt within 24h → idle', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { provider: 'tradeindia', isActive: true, lastSyncAt: oneHourAgo },
    ]);
    prisma.marketplaceLead.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/integrations/marketplace/status');
    const tradeindia = res.body.find((p) => p.provider === 'tradeindia');
    expect(tradeindia.healthHint).toBe('idle');
  });

  test('configured + isActive + lastSyncAt > 24h ago → stale (amber chip)', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { provider: 'indiamart', isActive: true, lastSyncAt: twoDaysAgo },
    ]);
    prisma.marketplaceLead.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/integrations/marketplace/status');
    const indiamart = res.body.find((p) => p.provider === 'indiamart');
    expect(indiamart.healthHint).toBe('stale');
  });

  test('configured + isActive + null lastSyncAt → stale (cron never ran)', async () => {
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      { provider: 'indiamart', isActive: true, lastSyncAt: null },
    ]);
    prisma.marketplaceLead.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/integrations/marketplace/status');
    const indiamart = res.body.find((p) => p.provider === 'indiamart');
    expect(indiamart.healthHint).toBe('stale');
  });

  test('non-ADMIN caller is still allowed — Owners + Managers see the row', async () => {
    // The /marketplace/status route is intentionally non-admin (see route
    // comments) because the masked-key endpoint lives elsewhere. A USER
    // caller should NOT get 403 here.
    prisma.marketplaceConfig.findMany.mockResolvedValue([]);
    prisma.marketplaceLead.count.mockResolvedValue(0);
    const app = makeApp({ role: 'USER' });
    const res = await request(app).get('/api/integrations/marketplace/status');
    expect(res.status).toBe(200);
  });

  test('config + lead queries scoped to req.user.tenantId (tenant isolation)', async () => {
    prisma.marketplaceConfig.findMany.mockResolvedValue([]);
    prisma.marketplaceLead.count.mockResolvedValue(0);
    const app = makeApp({ tenantId: 99 });
    await request(app).get('/api/integrations/marketplace/status');

    const configArgs = prisma.marketplaceConfig.findMany.mock.calls[0][0];
    expect(configArgs.where).toEqual({ tenantId: 99 });

    // All 3 count calls scoped on tenantId=99.
    for (const call of prisma.marketplaceLead.count.mock.calls) {
      expect(call[0].where.tenantId).toBe(99);
    }
  });

  test('prisma failure → 500 with deterministic error envelope', async () => {
    prisma.marketplaceConfig.findMany.mockRejectedValue(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).get('/api/integrations/marketplace/status');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch marketplace status' });
    consoleSpy.mockRestore();
  });
});

// ─── GET /callified/auth-url — Callified SSO URL ─────────────────────────

describe('GET /api/integrations/callified/auth-url — SSO JWT URL', () => {
  test('CALLIFIED_SSO_SECRET missing → 503 with "not yet available" envelope', async () => {
    delete process.env.CALLIFIED_SSO_SECRET;
    const app = makeApp();
    const res = await request(app).get('/api/integrations/callified/auth-url');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not yet available/i);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('happy path returns a signed Callified URL with token + redirect params', async () => {
    process.env.CALLIFIED_SSO_SECRET = 'test-secret-' + Date.now();
    prisma.integration.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'admin@globussoft.com', name: 'Admin User', role: 'ADMIN',
    });
    const app = makeApp({ userId: 7, tenantId: 1, role: 'ADMIN' });
    const res = await request(app).get('/api/integrations/callified/auth-url');
    expect(res.status).toBe(200);
    expect(typeof res.body.authUrl).toBe('string');
    expect(res.body.authUrl).toMatch(/^http:\/\/localhost:8001\/api\/auth\/sso\/jwt\?token=/);
    expect(res.body.authUrl).toMatch(/&redirect=/);

    // Verify JWT is valid + role-mapped + payload-pinned.
    const url = new URL(res.body.authUrl);
    const token = url.searchParams.get('token');
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.CALLIFIED_SSO_SECRET);
    expect(decoded.iss).toBe('globussoft-internal');
    expect(decoded.aud).toBe('callified');
    expect(decoded.email).toBe('admin@globussoft.com');
    expect(decoded.role).toBe('admin'); // ADMIN → admin
    expect(decoded.org_id).toBe(1);
  });

  test('user not found → 401', async () => {
    process.env.CALLIFIED_SSO_SECRET = 'test-secret';
    prisma.integration.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).get('/api/integrations/callified/auth-url');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test('role map: MANAGER→agent, USER→viewer', async () => {
    process.env.CALLIFIED_SSO_SECRET = 'test-secret';
    prisma.integration.findFirst.mockResolvedValue(null);
    const jwt = require('jsonwebtoken');

    // MANAGER → agent
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'm@e.com', name: 'Manager', role: 'MANAGER',
    });
    let res = await request(makeApp({ role: 'MANAGER' }))
      .get('/api/integrations/callified/auth-url');
    let token = new URL(res.body.authUrl).searchParams.get('token');
    expect(jwt.verify(token, 'test-secret').role).toBe('agent');

    // USER → viewer
    prisma.user.findUnique.mockResolvedValue({
      id: 8, email: 'u@e.com', name: 'Regular', role: 'USER',
    });
    res = await request(makeApp({ role: 'USER' }))
      .get('/api/integrations/callified/auth-url');
    token = new URL(res.body.authUrl).searchParams.get('token');
    expect(jwt.verify(token, 'test-secret').role).toBe('viewer');
  });

  test('integration settings.dashboardUrl + redirectPath override defaults', async () => {
    process.env.CALLIFIED_SSO_SECRET = 'test-secret';
    prisma.integration.findFirst.mockResolvedValue({
      id: 1,
      isActive: true,
      provider: 'callified',
      settings: JSON.stringify({
        dashboardUrl: 'https://callified.example.com/sso',
        redirectPath: '/custom-landing',
        orgId: '42',
        sub: 'custom-sub',
      }),
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'a@b.com', name: 'A', role: 'ADMIN',
    });
    const app = makeApp();
    const res = await request(app).get('/api/integrations/callified/auth-url');
    expect(res.status).toBe(200);
    expect(res.body.authUrl).toMatch(/^https:\/\/callified\.example\.com\/sso\?token=/);
    expect(res.body.authUrl).toMatch(/redirect=%2Fcustom-landing/);
    // org_id picked up from settings.
    const token = new URL(res.body.authUrl).searchParams.get('token');
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, 'test-secret');
    expect(decoded.org_id).toBe(42);
    expect(decoded.sub).toBe('custom-sub');
  });
});

// ─── GET /callified/sso — 302 redirect variant ───────────────────────────

describe('GET /api/integrations/callified/sso — 302 redirect', () => {
  test('CALLIFIED_SSO_SECRET missing → 503 plain-text response', async () => {
    delete process.env.CALLIFIED_SSO_SECRET;
    const app = makeApp();
    const res = await request(app).get('/api/integrations/callified/sso');
    expect(res.status).toBe(503);
    expect(res.text).toMatch(/not yet available/i);
  });

  test('happy path returns 302 redirect to Callified with token query param', async () => {
    process.env.CALLIFIED_SSO_SECRET = 'test-secret';
    prisma.integration.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'admin@globussoft.com', name: 'Admin', role: 'ADMIN',
    });
    const app = makeApp();
    const res = await request(app)
      .get('/api/integrations/callified/sso')
      .redirects(0); // don't follow — we want to assert on the 302 itself
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:8001\/api\/auth\/sso\/jwt\?token=/);
    expect(res.headers.location).toMatch(/&redirect=/);
  });

  test('user not found → 401 plain-text', async () => {
    process.env.CALLIFIED_SSO_SECRET = 'test-secret';
    prisma.integration.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).get('/api/integrations/callified/sso');
    expect(res.status).toBe(401);
    expect(res.text).toBe('User not found');
  });
});
