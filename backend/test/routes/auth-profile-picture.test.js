/**
 * Unit tests for backend/routes/auth.js — profile-picture endpoints.
 *
 * Pins the contract for:
 *   POST   /api/auth/me/profile-picture (multer single-file upload to S3)
 *   DELETE /api/auth/me/profile-picture (clears the column + deletes S3 key)
 *   GET    /api/auth/me                  (the new profilePicture field is returned)
 *
 * Critical behaviours covered:
 *   - 401 without Authorization header (verifyToken gate)
 *   - 400 when no file is attached
 *   - 415 when the image MIME type is unsupported (s3Service rejects it)
 *   - 503 when AWS_S3_BUCKET_NAME is not configured at runtime
 *   - 413 when the multer 5 MB cap fires
 *   - 200 happy path: returns the new profilePicture URL, writes audit row
 *   - 200 replace path: the PREVIOUS S3 key is deleted (the "no orphan
 *     avatars" guarantee — this is the load-bearing assertion the user
 *     explicitly asked for)
 *   - 200 replace continues even when the old-key delete throws (best-effort,
 *     never blocks the user)
 *   - DELETE 200 with profilePicture:null when one was set + S3 key removed
 *   - DELETE 200 idempotent when nothing was set (no S3 call, no audit row)
 *   - GET /me returns the profilePicture field on the envelope
 *
 * Test pattern: prisma singleton monkey-patch + s3Service mock + supertest.
 * Mirrors auth.test.js exactly so the two files compose cleanly.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patch ───────────────────────────────────────────
prisma.user = {
  findUnique: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.auditLog = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({}),
};
prisma.smsConfig = {
  findFirst: vi.fn().mockResolvedValue(null),
};
// T37 / Class B6 — RBAC self-heal seam. GET /api/auth/me invokes
// resolvePrimaryRole (lib/roleResolution.js) which queries
// prisma.userRole.findFirst → prisma.role.findFirst on the fallback
// path. Without stubs the real Prisma client tries demo MySQL and the
// 5s test timeout fires (errors are caught but each attempt blocks
// while sockets retry). Permissive null returns let resolvePrimaryRole
// short-circuit to null cleanly.
prisma.userRole = {
  count: vi.fn().mockResolvedValue(1),
  findUnique: vi.fn().mockResolvedValue(null),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({}),
};
prisma.role = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({ id: 999 }),
};
prisma.rolePermission = {
  findFirst: vi.fn().mockResolvedValue({ id: 999 }),
  create: vi.fn().mockResolvedValue({}),
};
prisma.roleWidget = {
  create: vi.fn().mockResolvedValue({}),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue(null);
prisma.tenant.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// s3Service mock — patched directly on the singleton module exports
// BEFORE the router is required. The router does
// `const s3Service = require('../services/s3Service')` and calls
// `s3Service.uploadImage(...)` / `.deleteFile(...)` / `.extractKeyFromUrl(...)`,
// so replacing the exports here is observed by the route handler.
// (vi.mock does NOT reliably intercept require() from inside a module
//  that itself was loaded via createRequire — see auth.test.js's prisma
//  singleton-patch pattern, mirrored here.)
const s3Service = requireCJS('../../services/s3Service');
s3Service.uploadImage = vi.fn();
s3Service.deleteFile = vi.fn().mockResolvedValue(undefined);
s3Service.extractKeyFromUrl = vi.fn((url) => {
  if (!url) return null;
  const base = 'https://test-bucket.s3.amazonaws.com';
  return url.startsWith(base) ? url.slice(base.length + 1) : null;
});

const authRouter = requireCJS('../../routes/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  return app;
}

function bearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '5m' });
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
]);

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.user.update.mockReset();
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({});
  prisma.smsConfig.findFirst.mockReset().mockResolvedValue(null);
  s3Service.uploadImage.mockReset();
  s3Service.deleteFile.mockReset().mockResolvedValue(undefined);
  // T37 / Class B6 — keep self-heal seam permissive across tests.
  prisma.userRole.count.mockReset().mockResolvedValue(1);
  prisma.userRole.findUnique.mockReset().mockResolvedValue(null);
  prisma.userRole.findFirst.mockReset().mockResolvedValue(null);
  prisma.userRole.findMany.mockReset().mockResolvedValue([]);
  prisma.role.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue(null);
});

// ── GET /api/auth/me — surfaces the new field ───────────────────────

describe('GET /api/auth/me — profilePicture in envelope', () => {
  test('returns the persisted profilePicture URL', async () => {
    const pictureUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1700000000-me.png';
    prisma.user.findUnique.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN',
      wellnessRole: null, profilePicture: pictureUrl,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      tenant: { id: 1, name: 'Globussoft', slug: 'globussoft', plan: 'PRO', vertical: 'generic', country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null },
    });

    const res = await request(makeApp())
      .get('/api/auth/me')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBe(pictureUrl);
  });

  test('returns null when no picture is set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN',
      wellnessRole: null, profilePicture: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      tenant: { id: 1, name: 'Globussoft', vertical: 'generic' },
    });

    const res = await request(makeApp())
      .get('/api/auth/me')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBeNull();
  });
});

// ── POST /api/auth/me/profile-picture ────────────────────────────────

describe('POST /api/auth/me/profile-picture', () => {
  test('401 without Authorization header — verifyToken short-circuits before multer', async () => {
    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .attach('file', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
    expect(s3Service.uploadImage).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('400 NO_FILE when no file part is attached', async () => {
    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .set('Authorization', bearer())
      .field('foo', 'bar');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_FILE');
    expect(s3Service.uploadImage).not.toHaveBeenCalled();
  });

  test('happy path (no previous picture): uploads, writes DB, emits audit, no S3 delete', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: null });
    const newUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1700000000-me.png';
    s3Service.uploadImage.mockResolvedValue(newUrl);
    prisma.user.update.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN', profilePicture: newUrl,
    });

    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .set('Authorization', bearer())
      .attach('file', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBe(newUrl);

    // Upload called with the image buffer + user-scoped subfolder so two
    // different users can't trample each other's keys.
    expect(s3Service.uploadImage).toHaveBeenCalledTimes(1);
    const [, fileName, mime, subfolder] = s3Service.uploadImage.mock.calls[0];
    expect(fileName).toBe('me.png');
    expect(mime).toBe('image/png');
    expect(subfolder).toBe('avatars/7');

    // No previous picture → no S3 delete attempted.
    expect(s3Service.deleteFile).not.toHaveBeenCalled();

    // DB write persists the new URL.
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: { profilePicture: newUrl },
    }));

    // #179: audit row written. `replaced: false` because no prior picture.
    const auditCall = prisma.auditLog.create.mock.calls.find(
      (c) => c[0]?.data?.action === 'UPDATE_PROFILE_PICTURE',
    );
    expect(auditCall).toBeDefined();
    expect(JSON.parse(auditCall[0].data.details || '{}').replaced).toBe(false);
  });

  test('replace path: previous S3 key is deleted so the bucket does not leak orphans', async () => {
    const oldUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1600000000-old.png';
    const newUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1700000000-me.png';
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: oldUrl });
    s3Service.uploadImage.mockResolvedValue(newUrl);
    prisma.user.update.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN', profilePicture: newUrl,
    });

    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .set('Authorization', bearer())
      .attach('file', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBe(newUrl);

    // Load-bearing assertion: the OLD S3 key is removed. This is the
    // "no orphan avatars on replace" guarantee the user explicitly asked
    // for. extractKeyFromUrl strips the base URL so we delete by key.
    expect(s3Service.deleteFile).toHaveBeenCalledTimes(1);
    expect(s3Service.deleteFile).toHaveBeenCalledWith('avatars/7/1600000000-old.png');

    // Audit row says `replaced: true` so the audit log distinguishes
    // first-upload from replace.
    const auditCall = prisma.auditLog.create.mock.calls.find(
      (c) => c[0]?.data?.action === 'UPDATE_PROFILE_PICTURE',
    );
    expect(JSON.parse(auditCall[0].data.details || '{}').replaced).toBe(true);
  });

  test('replace path: still returns 200 when the S3 delete of the old key fails', async () => {
    const oldUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1600000000-old.png';
    const newUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1700000000-me.png';
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: oldUrl });
    s3Service.uploadImage.mockResolvedValue(newUrl);
    s3Service.deleteFile.mockRejectedValue(new Error('AccessDenied'));
    prisma.user.update.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN', profilePicture: newUrl,
    });

    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .set('Authorization', bearer())
      .attach('file', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' });

    // Critical: a stale orphan in S3 must NOT block the user from
    // updating their avatar — the new picture is already uploaded.
    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBe(newUrl);
  });

  test('415 when s3Service rejects the MIME type', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: null });
    s3Service.uploadImage.mockRejectedValue(new Error('Invalid image MIME type: application/pdf'));

    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .set('Authorization', bearer())
      .attach('file', PNG_BYTES, { filename: 'me.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA');
    // No DB write when upload failed.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('503 when the S3 bucket is not configured at runtime', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: null });
    s3Service.uploadImage.mockRejectedValue(new Error('S3 bucket not configured. Set AWS_S3_BUCKET_NAME env var.'));

    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .set('Authorization', bearer())
      .attach('file', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STORAGE_UNCONFIGURED');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('413 when the upload exceeds the multer 5 MB cap', async () => {
    // 6 MB payload — multer rejects before the route handler runs.
    const oversized = Buffer.alloc(6 * 1024 * 1024, 0xff);
    const res = await request(makeApp())
      .post('/api/auth/me/profile-picture')
      .set('Authorization', bearer())
      .attach('file', oversized, { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(s3Service.uploadImage).not.toHaveBeenCalled();
  });
});

// ── DELETE /api/auth/me/profile-picture ──────────────────────────────

describe('DELETE /api/auth/me/profile-picture', () => {
  test('401 without Authorization header', async () => {
    const res = await request(makeApp()).delete('/api/auth/me/profile-picture');
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('happy path: deletes the S3 key, clears the column, writes audit row', async () => {
    const oldUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1600000000-old.png';
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: oldUrl });
    prisma.user.update.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN', profilePicture: null,
    });

    const res = await request(makeApp())
      .delete('/api/auth/me/profile-picture')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBeNull();
    expect(s3Service.deleteFile).toHaveBeenCalledWith('avatars/7/1600000000-old.png');
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { profilePicture: null },
    }));

    const auditCall = prisma.auditLog.create.mock.calls.find(
      (c) => c[0]?.data?.action === 'DELETE_PROFILE_PICTURE',
    );
    expect(auditCall).toBeDefined();
  });

  test('idempotent: returns 200 with no S3 call + no audit row when nothing was set', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: null });
    prisma.user.update.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN', profilePicture: null,
    });

    const res = await request(makeApp())
      .delete('/api/auth/me/profile-picture')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBeNull();
    // No picture to delete → no S3 call, no audit row. Caller can poke
    // this endpoint repeatedly without polluting the audit log.
    expect(s3Service.deleteFile).not.toHaveBeenCalled();
    const auditCall = prisma.auditLog.create.mock.calls.find(
      (c) => c[0]?.data?.action === 'DELETE_PROFILE_PICTURE',
    );
    expect(auditCall).toBeUndefined();
  });

  test('still returns 200 when the S3 delete fails — DB still cleared', async () => {
    const oldUrl = 'https://test-bucket.s3.amazonaws.com/avatars/7/1600000000-old.png';
    prisma.user.findUnique.mockResolvedValue({ id: 7, profilePicture: oldUrl });
    s3Service.deleteFile.mockRejectedValue(new Error('AccessDenied'));
    prisma.user.update.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN', profilePicture: null,
    });

    const res = await request(makeApp())
      .delete('/api/auth/me/profile-picture')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.profilePicture).toBeNull();
    // DB pointer is the canonical signal — clearing it is what matters
    // for the user; the S3 orphan is a janitorial concern.
    expect(prisma.user.update).toHaveBeenCalled();
  });
});
