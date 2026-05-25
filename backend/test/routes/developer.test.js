// @ts-check
/**
 * Unit tests for backend/routes/developer.js — pin the Developer/admin tooling
 * surface: agent-activity JSONL log (read + append), API-key CRUD (with #720
 * required-name + #899 sub-brand whitelist), and webhook CRUD (with #713
 * scheme + private-host SSRF allowlist).
 *
 * Why this file exists
 * ────────────────────
 * routes/developer.js (292 LOC) had ZERO vitest coverage prior to this file.
 * It owns three semantically-distinct surfaces:
 *
 *   1. Agent activity log — ADMIN-only, file-backed (.scripts-state/), used
 *      by the orchestrator + agent fleet to surface live progress in the
 *      Developer page. Silent contract drift here breaks the dashboard
 *      widget that the user polls every 3 seconds during parallel waves.
 *   2. API-key CRUD — tenant-scoped, USER-allowed (not ADMIN-only), with
 *      #720 mandatory `name` (rejects blank/whitespace with 400
 *      KEY_NAME_REQUIRED) and #899 optional `subBrand` whitelist
 *      (tmc/rfu/travelstall/visasure, anything else 400 INVALID_SUB_BRAND).
 *   3. Webhook CRUD — tenant-scoped, USER-allowed, with #713 anti-SSRF
 *      URL validator (rejects non-http/https schemes + loopback / RFC1918
 *      / link-local hosts with 400 INVALID_WEBHOOK_SCHEME or
 *      INVALID_WEBHOOK_HOST). This is the load-bearing guard against a
 *      malicious admin probing internal networks via the dispatcher.
 *
 * Endpoints under test
 * ────────────────────
 *   GET    /agent-activity              — ADMIN-only file tail (limit clamp)
 *   POST   /agent-activity              — ADMIN-only file append (validation)
 *   POST   /apikeys                     — USER+ create with #720 + #899 gates
 *   GET    /apikeys                     — tenant + user-scoped list
 *   DELETE /apikeys/:id                 — tenant-scoped revoke (404 cross-tenant)
 *   POST   /webhooks                    — USER+ create with #713 SSRF gate
 *   GET    /webhooks                    — tenant + user-scoped list
 *   DELETE /webhooks/:id                — tenant-scoped delete (404 cross-tenant)
 *
 * Cases (20 total)
 * ────────────────
 *   agent-activity GET: ADMIN gate (USER → 403); missing-file → empty envelope;
 *     file present → newest-first, limit clamp, parse-error tolerated (4)
 *   agent-activity POST: ADMIN gate (USER → 403); 400 missing agent/action;
 *     happy 201 writes JSONL line with by-field (3)
 *   apikeys POST: #720 400 KEY_NAME_REQUIRED on blank/whitespace; #899 400
 *     INVALID_SUB_BRAND on bad value; happy 201 with rawKey + tenant scope;
 *     happy 201 with valid subBrand stored (4)
 *   apikeys GET: 200 user+tenant scoped list (1)
 *   apikeys DELETE: 404 cross-tenant; happy 200 success (2)
 *   webhooks POST: #713 400 WEBHOOK_URL_REQUIRED on empty; 400
 *     INVALID_WEBHOOK_URL on garbage; 400 INVALID_WEBHOOK_SCHEME on
 *     javascript:; 400 INVALID_WEBHOOK_HOST on 127.0.0.1 + 10.x; 400
 *     WEBHOOK_EVENT_REQUIRED; happy 201 (6)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/admin.test.js — patch authMw.verifyToken to
 * a passthrough BEFORE requiring the router, install a fake-auth middleware
 * in makeApp() that populates req.user. verifyRole stays REAL so the
 * ADMIN gate assertions on /agent-activity are end-to-end.
 *
 * Filesystem isolation: every agent-activity test uses vi.spyOn(fs, ...)
 * so the real .scripts-state/agent-activity.jsonl is never touched. The
 * POST happy-path asserts appendFileSync was called with the right payload
 * shape (no real disk write).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── auth middleware patching (before router require) ───────────────────
// Pass-through verifyToken — the fake-auth middleware in makeApp() handles
// req.user. verifyRole stays REAL so the ADMIN gate on /agent-activity is
// end-to-end (assertion: USER role → 403 RBAC_DENIED).
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// ── prisma singleton patching (before router require) ──────────────────
import prisma from '../../lib/prisma.js';

prisma.apiKey = prisma.apiKey || {};
prisma.apiKey.create = vi.fn();
prisma.apiKey.findMany = vi.fn();
prisma.apiKey.findFirst = vi.fn();
prisma.apiKey.delete = vi.fn();

prisma.webhook = prisma.webhook || {};
prisma.webhook.create = vi.fn();
prisma.webhook.findMany = vi.fn();
prisma.webhook.findFirst = vi.fn();
prisma.webhook.delete = vi.fn();

import express from 'express';
import request from 'supertest';
import fs from 'node:fs';

const developerRouter = requireCJS('../../routes/developer');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Default role = ADMIN (agent-activity endpoints
 * require it); override via { role } to exercise verifyRole denial.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', email = 'admin@test.local' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, email };
    next();
  });
  app.use('/api/developer', developerRouter);
  return app;
}

beforeEach(() => {
  prisma.apiKey.create.mockReset();
  prisma.apiKey.findMany.mockReset();
  prisma.apiKey.findFirst.mockReset();
  prisma.apiKey.delete.mockReset();
  prisma.webhook.create.mockReset();
  prisma.webhook.findMany.mockReset();
  prisma.webhook.findFirst.mockReset();
  prisma.webhook.delete.mockReset();

  // Sensible defaults — individual tests override.
  prisma.apiKey.create.mockResolvedValue({ id: 1, name: 'test', keySecret: 'glbs_x' });
  prisma.apiKey.findMany.mockResolvedValue([]);
  prisma.apiKey.findFirst.mockResolvedValue(null);
  prisma.apiKey.delete.mockResolvedValue({ id: 1 });
  prisma.webhook.create.mockResolvedValue({ id: 1, event: 'lead.created' });
  prisma.webhook.findMany.mockResolvedValue([]);
  prisma.webhook.findFirst.mockResolvedValue(null);
  prisma.webhook.delete.mockResolvedValue({ id: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// GET /agent-activity — ADMIN-only file tail of .scripts-state/agent-activity.jsonl
// ─────────────────────────────────────────────────────────────────────────

describe('GET /agent-activity — admin-only file tail', () => {
  test('403 RBAC_DENIED when caller is not ADMIN', async () => {
    const res = await request(makeApp({ role: 'USER' })).get('/api/developer/agent-activity');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('200 with empty envelope + message when log file does not exist', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const res = await request(makeApp()).get('/api/developer/agent-activity');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activity: [],
      count: 0,
      message: 'No agent activity yet',
    });
  });

  test('200 returns parsed JSONL entries newest-first with totalLines + limit clamp', async () => {
    const lines = [
      JSON.stringify({ ts: '2026-05-25T10:00:00Z', agent: 'A', action: 'start' }),
      JSON.stringify({ ts: '2026-05-25T10:01:00Z', agent: 'A', action: 'commit' }),
      JSON.stringify({ ts: '2026-05-25T10:02:00Z', agent: 'A', action: 'done' }),
    ].join('\n') + '\n';

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(lines);

    const res = await request(makeApp()).get('/api/developer/agent-activity?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(2); // limit=2 honored
    expect(res.body.totalLines).toBe(3);
    // Newest-first ordering: tail-2 of the file (commit + done), reversed.
    expect(res.body.activity[0].action).toBe('done');
    expect(res.body.activity[1].action).toBe('commit');
  });

  test('200 tolerates unparseable JSONL lines (renders as agent=unparseable)', async () => {
    const lines = [
      JSON.stringify({ ts: '2026-05-25T10:00:00Z', agent: 'A', action: 'start' }),
      '{this is not valid json',
    ].join('\n') + '\n';

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(lines);

    const res = await request(makeApp()).get('/api/developer/agent-activity');

    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(2);
    // Newest first → unparseable line is index 0.
    expect(res.body.activity[0].agent).toBe('unparseable');
    expect(res.body.activity[0].action).toBe('log-error');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /agent-activity — ADMIN-only JSONL append
// ─────────────────────────────────────────────────────────────────────────

describe('POST /agent-activity — admin-only append', () => {
  test('403 RBAC_DENIED when caller is not ADMIN', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/developer/agent-activity')
      .send({ agent: 'A', action: 'start' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('400 when agent or action is missing', async () => {
    const res = await request(makeApp())
      .post('/api/developer/agent-activity')
      .send({ agent: 'A' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agent and action required/i);
  });

  test('201 writes JSONL line with by-field populated from req.user.email', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const appendSpy = vi.spyOn(fs, 'appendFileSync').mockReturnValue(undefined);

    const res = await request(makeApp({ email: 'admin@test.local' }))
      .post('/api/developer/agent-activity')
      .send({
        agent: 'orchestrator',
        action: 'commit',
        file: 'backend/routes/foo.js',
        commit: 'abc1234',
        status: 'success',
        message: 'shipped',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.entry.agent).toBe('orchestrator');
    expect(res.body.entry.action).toBe('commit');
    expect(res.body.entry.by).toBe('admin@test.local');
    expect(res.body.entry.ts).toBeDefined();
    expect(mkdirSpy).toHaveBeenCalled();
    expect(appendSpy).toHaveBeenCalled();
    // Appended payload is the JSON entry + newline.
    const writtenLine = appendSpy.mock.calls[0][1];
    expect(writtenLine).toMatch(/\n$/);
    const parsed = JSON.parse(writtenLine.trim());
    expect(parsed.agent).toBe('orchestrator');
    expect(parsed.commit).toBe('abc1234');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /apikeys — create (with #720 required-name + #899 sub-brand whitelist)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /apikeys — create API key', () => {
  test('400 KEY_NAME_REQUIRED when name is blank (#720)', async () => {
    const res = await request(makeApp())
      .post('/api/developer/apikeys')
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('KEY_NAME_REQUIRED');
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  test('400 KEY_NAME_REQUIRED when name is missing entirely (#720)', async () => {
    const res = await request(makeApp())
      .post('/api/developer/apikeys')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('KEY_NAME_REQUIRED');
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_SUB_BRAND when subBrand is not in whitelist (#899)', async () => {
    const res = await request(makeApp())
      .post('/api/developer/apikeys')
      .send({ name: 'Test Key', subBrand: 'nonsense' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
    expect(res.body.error).toMatch(/tmc, rfu, travelstall, visasure/);
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  test('201 happy: tenant-scoped create + returns rawKey starting with glbs_ + subBrand=null when omitted', async () => {
    prisma.apiKey.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 99, ...data })
    );

    const res = await request(makeApp({ tenantId: 42, userId: 7 }))
      .post('/api/developer/apikeys')
      .send({ name: 'My Integration Key' });

    expect(res.status).toBe(201);
    expect(res.body.rawKey).toMatch(/^glbs_[a-f0-9]+$/);
    expect(res.body.key.id).toBe(99);
    const createArg = prisma.apiKey.create.mock.calls[0][0].data;
    expect(createArg.name).toBe('My Integration Key');
    expect(createArg.subBrand).toBeNull(); // tenant-wide (legacy)
    expect(createArg.tenantId).toBe(42);
    expect(createArg.userId).toBe(7);
    expect(createArg.keySecret).toMatch(/^glbs_/);
  });

  test('201 with valid subBrand=tmc stored in data (#899 Part A)', async () => {
    prisma.apiKey.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 100, ...data })
    );

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/developer/apikeys')
      .send({ name: 'TMC Key', subBrand: 'tmc' });

    expect(res.status).toBe(201);
    const createArg = prisma.apiKey.create.mock.calls[0][0].data;
    expect(createArg.subBrand).toBe('tmc');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /apikeys — list (user + tenant scoped)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /apikeys — list user keys', () => {
  test('200 with user+tenant scoped findMany ordered by createdAt desc', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      { id: 1, name: 'K1', keySecret: 'glbs_a' },
      { id: 2, name: 'K2', keySecret: 'glbs_b' },
    ]);

    const res = await request(makeApp({ tenantId: 42, userId: 7 })).get('/api/developer/apikeys');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith({
      where: { userId: 7, tenantId: 42 },
      orderBy: { createdAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /apikeys/:id — revoke (cross-tenant 404)
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /apikeys/:id — revoke', () => {
  test('404 when key belongs to a different tenant (findFirst returns null)', async () => {
    prisma.apiKey.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/developer/apikeys/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.apiKey.delete).not.toHaveBeenCalled();
  });

  test('200 success on revoke (tenant-scoped existence check passed)', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.apiKey.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/developer/apikeys/50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.apiKey.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /webhooks — create (with #713 SSRF allowlist)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /webhooks — create with #713 SSRF allowlist', () => {
  test('400 WEBHOOK_URL_REQUIRED when targetUrl is missing/empty', async () => {
    const res = await request(makeApp())
      .post('/api/developer/webhooks')
      .send({ event: 'lead.created', targetUrl: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBHOOK_URL_REQUIRED');
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_WEBHOOK_URL when targetUrl is unparseable garbage', async () => {
    const res = await request(makeApp())
      .post('/api/developer/webhooks')
      .send({ event: 'lead.created', targetUrl: 'not a url at all' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK_URL');
  });

  test('400 INVALID_WEBHOOK_SCHEME when targetUrl uses javascript: (anti stored-XSS)', async () => {
    const res = await request(makeApp())
      .post('/api/developer/webhooks')
      .send({ event: 'lead.created', targetUrl: 'javascript:alert(1)' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK_SCHEME');
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_WEBHOOK_HOST when targetUrl points at 127.0.0.1 (anti-SSRF)', async () => {
    const res = await request(makeApp())
      .post('/api/developer/webhooks')
      .send({ event: 'lead.created', targetUrl: 'http://127.0.0.1:5000/hook' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK_HOST');
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_WEBHOOK_HOST when targetUrl points at RFC1918 10.x (anti-SSRF)', async () => {
    const res = await request(makeApp())
      .post('/api/developer/webhooks')
      .send({ event: 'lead.created', targetUrl: 'http://10.0.0.5/hook' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK_HOST');
  });

  test('400 WEBHOOK_EVENT_REQUIRED when event is missing despite valid URL', async () => {
    const res = await request(makeApp())
      .post('/api/developer/webhooks')
      .send({ targetUrl: 'https://hooks.example.com/in' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBHOOK_EVENT_REQUIRED');
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  test('201 happy: public https URL + valid event → tenant-scoped create', async () => {
    prisma.webhook.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 99, ...data })
    );

    const res = await request(makeApp({ tenantId: 42, userId: 7 }))
      .post('/api/developer/webhooks')
      .send({
        event: 'lead.created',
        targetUrl: 'https://hooks.example.com/inbound',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    const createArg = prisma.webhook.create.mock.calls[0][0].data;
    expect(createArg.event).toBe('lead.created');
    expect(createArg.targetUrl).toBe('https://hooks.example.com/inbound');
    expect(createArg.tenantId).toBe(42);
    expect(createArg.userId).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /webhooks/:id — delete (cross-tenant 404)
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /webhooks/:id — delete', () => {
  test('404 when webhook belongs to a different tenant', async () => {
    prisma.webhook.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/developer/webhooks/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.webhook.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.webhook.delete).not.toHaveBeenCalled();
  });
});
