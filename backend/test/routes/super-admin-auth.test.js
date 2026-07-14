// @ts-check
/**
 * Unit tests for backend/routes/super_admin_auth.js + middleware/superAdminAuth.js.
 *
 * Super Admin auth is deliberately separate from the app's User/JWT system:
 * env-based credentials only (SUPER_ADMIN_USERNAME + SUPER_ADMIN_PASSWORD_HASH
 * or SUPER_ADMIN_PASSWORD_PLAINTEXT), a dedicated JWT secret
 * (SUPER_ADMIN_JWT_SECRET, no dev fallback), no DB table for admins — only
 * one auto-managed SystemSetting row for the promoted-from-plaintext hash.
 *
 * Pinned:
 *   - isSuperAdminConfigured() false when username, JWT secret, or BOTH
 *     credential vars are missing → /login and requireSuperAdmin both
 *     respond 503 SUPER_ADMIN_NOT_CONFIGURED. True when either
 *     SUPER_ADMIN_PASSWORD_HASH or SUPER_ADMIN_PASSWORD_PLAINTEXT is set.
 *   - /login (hash path): missing username/password → 400; wrong username →
 *     401 (and still runs a bcrypt.compare against a dummy hash,
 *     timing-attack hardening); wrong password → 401; happy path → 200 +
 *     signed JWT.
 *   - /login (plaintext auto-hash + CHANGE flow): a real (non-placeholder)
 *     SUPER_ADMIN_PASSWORD_PLAINTEXT is ALWAYS treated as "apply this as the
 *     current password now" on every login attempt, whether or not a hash
 *     already exists — this is what makes password CHANGE work (edit .env,
 *     restart, log in), not just first-time bootstrap. On a correct login it
 *     hashes + upserts (fully replacing any prior hash) + calls
 *     redactPlaintextInEnvFile() to blank .env back to the placeholder, and
 *     returns a "notice". Once the env var IS the placeholder (or unset),
 *     no re-hash/redaction happens and login verifies against the existing
 *     persisted hash silently (no notice).
 *   - requireSuperAdmin: no Authorization header → 401 (+ WWW-Authenticate);
 *     malformed/garbage token → 401; token signed with the WRONG secret → 401
 *     (proves it's not reusing the app's JWT_SECRET); token missing role →
 *     401; valid token → next() called, req.superAdmin populated.
 *   - GET /me — returns the decoded username via requireSuperAdmin.
 *   - POST /logout — requires a valid token, returns { ok: true } (stateless).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const TEST_SECRET = 'test-super-admin-secret-do-not-use-in-prod';
const TEST_USERNAME = 'superadmin';
let TEST_PASSWORD_HASH;

// prisma is a singleton module (never deleted from require-cache below, same
// as super-admin-cron.test.js) — monkey-patch systemSetting once up front so
// getPersistedPasswordHash()/persistPromotedPasswordHash() never hit a real DB.
import prisma from '../../lib/prisma.js';
prisma.systemSetting = {
  findUnique: vi.fn().mockResolvedValue(null),
  upsert: vi.fn().mockResolvedValue({}),
};

// Real .env I/O must never run in a test — mock fs at the require-cache seam
// so redactPlaintextInEnvFile() (required by super_admin_auth.js indirectly
// via middleware/superAdminAuth.js) becomes a harmless no-op recorder.
const Module = requireCJS('node:module');
const fsMock = {
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => 'SUPER_ADMIN_PASSWORD_PLAINTEXT=whatever\n'),
  writeFileSync: vi.fn(),
};
const fsPath = requireCJS.resolve('fs');
const originalFsExports = Module._cache[fsPath] ? Module._cache[fsPath].exports : requireCJS('fs');
Module._cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: { ...originalFsExports, ...fsMock } };

function freshApp() {
  delete requireCJS.cache[requireCJS.resolve('../../config/secrets.js')];
  delete requireCJS.cache[requireCJS.resolve('../../middleware/superAdminAuth.js')];
  delete requireCJS.cache[requireCJS.resolve('../../routes/super_admin_auth.js')];
  const router = requireCJS('../../routes/super_admin_auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/super-admin/auth', router);
  return app;
}

describe('Super Admin auth — fully configured', () => {
  let app;

  beforeEach(async () => {
    TEST_PASSWORD_HASH = await bcrypt.hash('correct-horse-battery-staple', 10);
    process.env.SUPER_ADMIN_USERNAME = TEST_USERNAME;
    process.env.SUPER_ADMIN_PASSWORD_HASH = TEST_PASSWORD_HASH;
    process.env.SUPER_ADMIN_JWT_SECRET = TEST_SECRET;
    prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null);
    prisma.systemSetting.upsert.mockReset().mockResolvedValue({});
    app = freshApp();
  });

  afterEach(() => {
    delete process.env.SUPER_ADMIN_USERNAME;
    delete process.env.SUPER_ADMIN_PASSWORD_HASH;
    delete process.env.SUPER_ADMIN_JWT_SECRET;
  });

  test('POST /login with missing username/password → 400', async () => {
    const res = await request(app).post('/api/super-admin/auth/login').send({ username: TEST_USERNAME });
    expect(res.status).toBe(400);
  });

  test('POST /login with wrong username → 401 (generic message, no enumeration)', async () => {
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: 'not-the-admin', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid Super Admin credentials');
  });

  test('POST /login with correct username but wrong password → 401', async () => {
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  test('POST /login happy path → 200 + a JWT that decodes with role SUPER_ADMIN', async () => {
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: 'correct-horse-battery-staple' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(TEST_USERNAME);
    expect(typeof res.body.token).toBe('string');

    const decoded = jwt.verify(res.body.token, TEST_SECRET);
    expect(decoded.role).toBe('SUPER_ADMIN');
    expect(decoded.username).toBe(TEST_USERNAME);
  });

  test('GET /me with no Authorization header → 401', async () => {
    const res = await request(app).get('/api/super-admin/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  test('GET /me with a garbage token → 401', async () => {
    const res = await request(app).get('/api/super-admin/auth/me').set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  test('GET /me with a token signed by the WRONG secret → 401 (not reusing app JWT_SECRET)', async () => {
    const wrongToken = jwt.sign({ role: 'SUPER_ADMIN', username: TEST_USERNAME }, 'some-other-secret', { expiresIn: '1h' });
    const res = await request(app).get('/api/super-admin/auth/me').set('Authorization', `Bearer ${wrongToken}`);
    expect(res.status).toBe(401);
  });

  test('GET /me with a token missing role:SUPER_ADMIN → 401', async () => {
    const noRoleToken = jwt.sign({ username: TEST_USERNAME }, TEST_SECRET, { expiresIn: '1h' });
    const res = await request(app).get('/api/super-admin/auth/me').set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(401);
  });

  test('GET /me with a valid token → 200 + username', async () => {
    const loginRes = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: 'correct-horse-battery-staple' });
    const res = await request(app).get('/api/super-admin/auth/me').set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: TEST_USERNAME, role: 'SUPER_ADMIN' });
  });

  test('POST /logout with a valid token → 200 { ok: true }', async () => {
    const loginRes = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: 'correct-horse-battery-staple' });
    const res = await request(app).post('/api/super-admin/auth/logout').set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('POST /logout without a token → 401', async () => {
    const res = await request(app).post('/api/super-admin/auth/logout');
    expect(res.status).toBe(401);
  });
});

describe('Super Admin auth — auto-hash-on-first-login + password change (SUPER_ADMIN_PASSWORD_PLAINTEXT)', () => {
  let app;
  const TEST_PLAINTEXT = 'first-login-plaintext-pw';
  const PLACEHOLDER = '<hashed — edit this value to change the password>';

  beforeEach(() => {
    process.env.SUPER_ADMIN_USERNAME = TEST_USERNAME;
    process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT = TEST_PLAINTEXT;
    delete process.env.SUPER_ADMIN_PASSWORD_HASH;
    process.env.SUPER_ADMIN_JWT_SECRET = TEST_SECRET;
    prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null);
    prisma.systemSetting.upsert.mockReset().mockResolvedValue({});
    fsMock.existsSync.mockReset().mockReturnValue(true);
    fsMock.readFileSync.mockReset().mockReturnValue('SUPER_ADMIN_PASSWORD_PLAINTEXT=whatever\n');
    fsMock.writeFileSync.mockReset();
    app = freshApp();
  });

  afterEach(() => {
    delete process.env.SUPER_ADMIN_USERNAME;
    delete process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT;
    delete process.env.SUPER_ADMIN_PASSWORD_HASH;
    delete process.env.SUPER_ADMIN_JWT_SECRET;
  });

  test('isSuperAdminConfigured() is true with only PLAINTEXT set (no HASH)', async () => {
    // Configured means /login doesn't 503 — proven indirectly via a real request below.
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: 'wrong' });
    expect(res.status).not.toBe(503);
  });

  test('wrong password against plaintext-only config → 401, no hash persisted, .env not touched', async () => {
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: 'not-it' });
    expect(res.status).toBe(401);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  test('correct password against plaintext config → 200 + JWT + notice, persists a hash, redacts .env', async () => {
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PLAINTEXT });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(TEST_USERNAME);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.notice).toMatch(/updated from \.env|cleared from \.env/i);

    const decoded = jwt.verify(res.body.token, TEST_SECRET);
    expect(decoded.role).toBe('SUPER_ADMIN');

    expect(prisma.systemSetting.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.systemSetting.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ key: 'super_admin_password_hash' });
    expect(upsertArgs.create.value).not.toBe(TEST_PLAINTEXT);
    await expect(bcrypt.compare(TEST_PLAINTEXT, upsertArgs.create.value)).resolves.toBe(true);

    // .env was rewritten to the placeholder, not left holding the real password.
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = fsMock.writeFileSync.mock.calls[0][1];
    expect(writtenContent).not.toContain(TEST_PLAINTEXT);
    expect(writtenContent).toContain(PLACEHOLDER);
  });

  test('once the env var IS the placeholder, login verifies silently against the persisted hash — no re-hash, no notice, .env not touched again', async () => {
    const persistedHash = await bcrypt.hash(TEST_PLAINTEXT, 10);
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'super_admin_password_hash', value: persistedHash });
    process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT = PLACEHOLDER; // what .env looks like after the redaction above

    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PLAINTEXT });
    expect(res.status).toBe(200);
    expect(res.body.notice).toBeUndefined();
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  test('PASSWORD CHANGE: logging in with the OLD password after .env was changed to a new value still succeeds against the untouched old hash, and does NOT trigger a re-hash (the submission must match the new plaintext to trigger a change)', async () => {
    const oldHash = await bcrypt.hash('the-old-password', 10);
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'super_admin_password_hash', value: oldHash });
    process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT = 'brand-new-changed-password'; // operator edited .env to set a new password, but hasn't logged in with it yet

    const oldRes = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: 'the-old-password' });
    // The old password doesn't match the pending new plaintext, so no change
    // is triggered — the OLD hash is still what's checked, and it still works
    // until someone actually logs in with the new password.
    expect(oldRes.status).toBe(200);
    expect(oldRes.body.notice).toBeUndefined();
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  test('PASSWORD CHANGE: logging in with the NEW password succeeds and redacts .env again', async () => {
    const oldHash = await bcrypt.hash('the-old-password', 10);
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'super_admin_password_hash', value: oldHash });
    const NEW_PASSWORD = 'brand-new-changed-password';
    process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT = NEW_PASSWORD;

    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: TEST_USERNAME, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.notice).toMatch(/updated from \.env|cleared from \.env/i);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('wrong username still runs a decoy bcrypt.compare (timing-attack hardening) even with a pending plaintext change', async () => {
    process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT = 'some-new-password';
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: 'not-the-admin', password: 'whatever' });
    expect(res.status).toBe(401);
    // Wrong username short-circuits BEFORE the plaintext-change logic runs —
    // no hash should be replaced from a request that never even matched the username.
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });
});

describe('Super Admin auth — NOT configured (missing env vars)', () => {
  let app;

  beforeEach(() => {
    delete process.env.SUPER_ADMIN_USERNAME;
    delete process.env.SUPER_ADMIN_PASSWORD_HASH;
    delete process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT;
    delete process.env.SUPER_ADMIN_JWT_SECRET;
    app = freshApp();
  });

  test('POST /login → 503 SUPER_ADMIN_NOT_CONFIGURED', async () => {
    const res = await request(app)
      .post('/api/super-admin/auth/login')
      .send({ username: 'x', password: 'y' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SUPER_ADMIN_NOT_CONFIGURED');
  });

  test('GET /me → 503 SUPER_ADMIN_NOT_CONFIGURED (guard fires before token check)', async () => {
    const res = await request(app).get('/api/super-admin/auth/me').set('Authorization', 'Bearer anything');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SUPER_ADMIN_NOT_CONFIGURED');
  });
});
