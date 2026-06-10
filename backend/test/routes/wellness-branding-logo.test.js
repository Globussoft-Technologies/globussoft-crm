// @ts-check
/**
 * Unit tests for the branding-logo upload in backend/routes/wellness.js.
 *
 * Pins the contract for:
 *   POST /api/wellness/branding/logo  (multer single-file → S3, replaces old)
 *
 * Critical behaviours covered:
 *   - 403 TENANT_ADMIN_REQUIRED for a non-admin role (requireTenantAdmin gate)
 *   - 400 when no `logo` file part is attached
 *   - 200 happy path: uploads to S3 via uploadImage, persists the returned S3
 *     URL on Tenant.logoUrl, and does NOT delete anything when no prior logo
 *   - 200 REPLACE path: the PREVIOUS S3 object is deleted (the "no orphan
 *     logos" guarantee the user explicitly asked for)
 *   - 200 replace continues even when the old-key delete throws (best-effort,
 *     never blocks the upload)
 *
 * Test pattern: mirrors backend/test/routes/auth-profile-picture.test.js —
 * prisma singleton monkey-patch + s3Service mock + supertest, with req.user
 * injected by a middleware (bypassing the JWT verifyToken layer like the
 * other wellness route unit tests do).
 *
 * IMPORTANT: routes/wellness.js DESTRUCTURES the S3 helpers at import time
 *   (`const { uploadImage, deleteFile, extractKeyFromUrl, BUCKET_NAME } = ...`)
 * so the s3Service exports + AWS_S3_BUCKET_NAME env MUST be patched/set BEFORE
 * the router is required, or the destructure captures the originals. This is
 * the CJS self-mocking seam — patch the shared module object first, then
 * require the consumer.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── env MUST be set before s3Service is required so BUCKET_NAME (and thus
// the route's `useS3` branch) is truthy. ────────────────────────────────
process.env.AWS_S3_BUCKET_NAME = 'test-bucket';
process.env.AWS_S3_URL = 'https://test-bucket.s3.amazonaws.com';

// ── prisma singleton patch ───────────────────────────────────────────
prisma.tenant = {
  findUnique: vi.fn(),
  update: vi.fn(),
};
// Permissive stub — wellness.js may touch auditLog on import paths.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// ── s3Service mock — patched on the shared singleton BEFORE the router is
// required (the router destructures these at import time). ───────────────
const S3_BASE = 'https://test-bucket.s3.amazonaws.com';
const s3Service = requireCJS('../../services/s3Service');
s3Service.uploadImage = vi.fn();
s3Service.deleteFile = vi.fn().mockResolvedValue(undefined);
s3Service.extractKeyFromUrl = vi.fn((url) =>
  url && url.startsWith(S3_BASE) ? url.slice(S3_BASE.length + 1) : null,
);

const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

// A minimal valid-looking PNG payload (header bytes) — enough for multer to
// populate req.file.buffer; '.png' filename → image/png mimetype.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.update.mockReset();
  s3Service.uploadImage.mockReset();
  s3Service.deleteFile.mockReset();
  s3Service.deleteFile.mockResolvedValue(undefined);

  // Defaults: no prior logo, upload returns a fresh S3 URL, update echoes.
  prisma.tenant.findUnique.mockResolvedValue({ logoUrl: null });
  prisma.tenant.update.mockResolvedValue({ id: 1 });
  s3Service.uploadImage.mockResolvedValue(
    `${S3_BASE}/branding/tenant-1/123-logo.png`,
  );
});

describe('POST /api/wellness/branding/logo — S3 upload + replace-deletes-old', () => {
  test('403 TENANT_ADMIN_REQUIRED for a non-admin role', async () => {
    const res = await request(makeApp({ role: 'MANAGER' }))
      .post('/api/wellness/branding/logo')
      .attach('logo', PNG, 'logo.png');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_ADMIN_REQUIRED');
    expect(s3Service.uploadImage).not.toHaveBeenCalled();
  });

  test('400 when no logo file part is attached', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/branding/logo')
      .field('foo', 'bar');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no logo file/i);
    expect(s3Service.uploadImage).not.toHaveBeenCalled();
  });

  test('200 happy path: uploads to S3, persists the URL, deletes nothing when no prior logo', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/branding/logo')
      .attach('logo', PNG, 'logo.png');

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBe(`${S3_BASE}/branding/tenant-1/123-logo.png`);

    // Uploaded to the tenant-scoped branding subfolder.
    expect(s3Service.uploadImage).toHaveBeenCalledTimes(1);
    const [, , , subfolder] = s3Service.uploadImage.mock.calls[0];
    expect(subfolder).toBe('branding/tenant-1');

    // Persisted onto Tenant.logoUrl (scoped to the JWT tenant).
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { logoUrl: `${S3_BASE}/branding/tenant-1/123-logo.png` },
    });

    // Nothing to clean up — no orphan delete fired.
    expect(s3Service.deleteFile).not.toHaveBeenCalled();
  });

  test('200 REPLACE path: the previous S3 object is deleted (no orphan logos)', async () => {
    // A logo is already set on this tenant.
    prisma.tenant.findUnique.mockResolvedValue({
      logoUrl: `${S3_BASE}/branding/tenant-1/OLD-logo.png`,
    });
    // The new upload lands at a distinct key.
    s3Service.uploadImage.mockResolvedValue(
      `${S3_BASE}/branding/tenant-1/999-new.png`,
    );

    const res = await request(makeApp())
      .post('/api/wellness/branding/logo')
      .attach('logo', PNG, 'logo.png');

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBe(`${S3_BASE}/branding/tenant-1/999-new.png`);

    // The OLD object's key was deleted — the load-bearing assertion.
    expect(s3Service.deleteFile).toHaveBeenCalledTimes(1);
    expect(s3Service.deleteFile).toHaveBeenCalledWith('branding/tenant-1/OLD-logo.png');
  });

  test('200 replace continues even when the old-key delete throws (best-effort)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      logoUrl: `${S3_BASE}/branding/tenant-1/OLD-logo.png`,
    });
    s3Service.uploadImage.mockResolvedValue(
      `${S3_BASE}/branding/tenant-1/999-new.png`,
    );
    s3Service.deleteFile.mockRejectedValue(new Error('s3 unreachable'));

    const res = await request(makeApp())
      .post('/api/wellness/branding/logo')
      .attach('logo', PNG, 'logo.png');

    // Upload still succeeds — cleanup failure never blocks the user.
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBe(`${S3_BASE}/branding/tenant-1/999-new.png`);
    expect(prisma.tenant.update).toHaveBeenCalledTimes(1);
  });
});
