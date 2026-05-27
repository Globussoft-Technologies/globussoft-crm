// @ts-check
/**
 * /api/user/theme — per-user theme preference (server-side persistence for #870).
 *
 * Pins the contract for backend/routes/user_preferences.js. Theme used to
 * live in localStorage only; per DD-5.2 [RESOLVED 2026-05-24] user pref
 * wins over tenant default, so the choice must roam across browsers/devices.
 *
 * What's pinned
 * -------------
 *   - GET   /theme  with stored value      returns { theme: <stored> }
 *   - GET   /theme  with null              returns { theme: 'system' } (fallback)
 *   - GET   /theme  user vanished          404 USER_NOT_FOUND
 *   - PUT   /theme  happy path             200 + persists via updateMany
 *   - PUT   /theme  missing body           400 INVALID_BODY + allowed list
 *   - PUT   /theme  invalid value          400 INVALID_THEME + allowed list
 *   - PUT   /theme  cross-tenant filter    400/404-equivalent (updateMany scoped)
 *   - both endpoints require a valid JWT (verifyToken stays live)
 *
 * Test pattern mirrors backend/test/routes/tenant_settings.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the same fallback
 * secret the middleware uses in dev.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.user.updateMany = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const userPrefsRouter = requireCJS('../../routes/user_preferences');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/user', userPrefsRouter);
  return app;
}

function tokenFor({ userId = 7, tenantId = 1, role = 'USER' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.user.updateMany.mockReset();
});

describe('GET /api/user/theme', () => {
  test('returns the stored preference verbatim', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ themePreference: 'dark' });
    const app = makeApp();
    const res = await request(app)
      .get('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: 'dark' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { themePreference: true },
    });
  });

  test("falls back to 'system' when the column is null (DD-5.2 default)", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ themePreference: null });
    const app = makeApp();
    const res = await request(app)
      .get('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: 'system' });
  });

  test('returns 404 USER_NOT_FOUND when the user row vanished', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app)
      .get('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  test('rejects unauthenticated callers', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/user/theme');
    expect(res.status).toBe(401);
    // No prisma read happened.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('PUT /api/user/theme', () => {
  test('happy path — persists the new value and returns it', async () => {
    prisma.user.updateMany.mockResolvedValueOnce({ count: 1 });
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor({ userId: 42, tenantId: 1 })}`)
      .send({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: 'dark' });
    // Cross-tenant guard: updateMany filter must include both userId and tenantId.
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
      data: { themePreference: 'dark' },
    });
  });

  test("accepts each of {'light','dark','system'}", async () => {
    const app = makeApp();
    for (const theme of ['light', 'dark', 'system']) {
      prisma.user.updateMany.mockResolvedValueOnce({ count: 1 });
      const res = await request(app)
        .put('/api/user/theme')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ theme });
      expect(res.status).toBe(200);
      expect(res.body.theme).toBe(theme);
    }
  });

  test('400 INVALID_BODY when body.theme is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(res.body.allowed).toEqual(['light', 'dark', 'system']);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_THEME when value is out of the closed set', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ theme: 'neon' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_THEME');
    expect(res.body.allowed).toEqual(['light', 'dark', 'system']);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  test('cross-tenant isolation — tenantId from JWT scopes the update', async () => {
    // If a stolen JWT for userId=99 / tenantId=2 lands but that user was
    // moved to tenantId=1, the updateMany filter never matches → count=0.
    prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor({ userId: 99, tenantId: 2 })}`)
      .send({ theme: 'light' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 99, tenantId: 2 },
      data: { themePreference: 'light' },
    });
  });

  test('rejects unauthenticated callers', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .send({ theme: 'dark' });
    expect(res.status).toBe(401);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  // ─── Extension: additional edge cases (tick #N test-writing cron) ──────
  //
  // The existing 10 cases pin the happy paths and the 401/404/400 envelopes.
  // The 6 extensions below pin the SUT's defensive layer: the
  // `typeof theme !== 'string'` guard, case-sensitivity of the enum, the
  // 500 INTERNAL_ERROR catch in BOTH handlers, idempotency of repeated
  // writes, and the malformed-JWT rejection path. These regress when
  // someone "simplifies" the body parser or relaxes the verifyToken guard.

  test('400 INVALID_BODY when body.theme is a non-string (number)', async () => {
    // The guard is `typeof theme !== 'string'` so a number/array/object
    // must not slip through to the includes() check.
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ theme: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(res.body.allowed).toEqual(['light', 'dark', 'system']);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_BODY when body.theme is an empty string', async () => {
    // Guard reads `theme.length === 0` — empty string is INVALID_BODY,
    // not INVALID_THEME, because the missing-value envelope is more
    // useful to a misbehaving client.
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ theme: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_THEME is case-sensitive (Dark != dark)', async () => {
    // ALLOWED_THEMES is a closed lowercase set; uppercase variants must
    // be rejected so the column stays in a known shape for the frontend.
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ theme: 'Dark' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_THEME');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  test('PUT returns 500 INTERNAL_ERROR when prisma throws', async () => {
    // Pin the catch-all envelope shape so future logger/observability
    // changes don't accidentally leak the raw error to the client.
    prisma.user.updateMany.mockRejectedValueOnce(new Error('DB down'));
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ theme: 'light' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    // No raw error details leaked.
    expect(res.body.error).toBe('Failed to update theme preference');
  });

  test('idempotent — re-sending the same payload returns 200 each time', async () => {
    // Pinning idempotency lets the frontend re-fire PUT on retry/network
    // hiccups without worrying about side effects (the column is just
    // overwritten with the same value on every call).
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    const app = makeApp();
    const first = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor({ userId: 11, tenantId: 3 })}`)
      .send({ theme: 'dark' });
    const second = await request(app)
      .put('/api/user/theme')
      .set('Authorization', `Bearer ${tokenFor({ userId: 11, tenantId: 3 })}`)
      .send({ theme: 'dark' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({ theme: 'dark' });
    expect(second.body).toEqual({ theme: 'dark' });
    // Both calls hit the same scoped filter.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.user.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 11, tenantId: 3 },
      data: { themePreference: 'dark' },
    });
  });

  test('rejects PUT with a malformed JWT (not just missing header)', async () => {
    // verifyToken should reject any token that doesn't verify under
    // JWT_SECRET. Distinct from the missing-header case above (which
    // exercises the early-return path before jwt.verify is even called).
    const app = makeApp();
    const res = await request(app)
      .put('/api/user/theme')
      .set('Authorization', 'Bearer not.a.real.jwt')
      .send({ theme: 'dark' });
    expect(res.status).toBe(401);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
