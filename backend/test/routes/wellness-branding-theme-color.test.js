// @ts-check
/**
 * Unit tests for the wellness theme-color endpoints in backend/routes/wellness.js.
 *
 * Pins the contract for:
 *   PUT /api/wellness/branding/theme-color  (tenant admin only, 6-digit hex)
 *   GET  /api/wellness/branding               (returns themeColor alongside logoUrl/brandColor)
 *
 * Critical behaviours covered:
 *   - 403 TENANT_ADMIN_REQUIRED for non-admin role
 *   - 400 when themeColor is not a 6-digit hex (or null/empty)
 *   - 200 PUT persists the themeColor on Tenant.themeColor
 *   - 200 GET returns the tenant's themeColor (and tolerates a stale Prisma client)
 *   - 503 PUT when the Prisma client has not yet been regenerated after the
 *     schema migration that added the themeColor column
 *
 * Test pattern mirrors backend/test/routes/wellness-branding-logo.test.js.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── prisma singleton patch ───────────────────────────────────────────────
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

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.update.mockReset();

  // Default: tenant exists with no theme color set.
  prisma.tenant.findUnique.mockResolvedValue({
    logoUrl: null,
    brandColor: null,
  });
  prisma.tenant.update.mockResolvedValue({ id: 1, themeColor: null });
});

describe('PUT /api/wellness/branding/theme-color', () => {
  test('403 TENANT_ADMIN_REQUIRED for a non-admin role', async () => {
    const res = await request(makeApp({ role: 'MANAGER' }))
      .put('/api/wellness/branding/theme-color')
      .send({ themeColor: '#C9A063' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_ADMIN_REQUIRED');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('400 when themeColor is not a 6-digit hex', async () => {
    const res = await request(makeApp())
      .put('/api/wellness/branding/theme-color')
      .send({ themeColor: '#ABC' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/6-digit hex/i);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('400 when themeColor contains non-hex characters', async () => {
    const res = await request(makeApp())
      .put('/api/wellness/branding/theme-color')
      .send({ themeColor: '#GGGGGG' });
    expect(res.status).toBe(400);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('200 happy path persists the theme color and returns it', async () => {
    prisma.tenant.update.mockResolvedValue({ id: 1, themeColor: '#C9A063' });
    const res = await request(makeApp())
      .put('/api/wellness/branding/theme-color')
      .send({ themeColor: '#C9A063' });
    expect(res.status).toBe(200);
    expect(res.body.themeColor).toBe('#C9A063');
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { themeColor: '#C9A063' },
    });
  });

  test('null themeColor clears the saved color', async () => {
    prisma.tenant.update.mockResolvedValue({ id: 1, themeColor: null });
    const res = await request(makeApp())
      .put('/api/wellness/branding/theme-color')
      .send({ themeColor: null });
    expect(res.status).toBe(200);
    expect(res.body.themeColor).toBeNull();
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { themeColor: null },
    });
  });

  test('empty string themeColor clears the saved color', async () => {
    prisma.tenant.update.mockResolvedValue({ id: 1, themeColor: null });
    const res = await request(makeApp())
      .put('/api/wellness/branding/theme-color')
      .send({ themeColor: '' });
    expect(res.status).toBe(200);
    expect(res.body.themeColor).toBeNull();
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { themeColor: null },
    });
  });

  test('503 when Prisma client is stale and does not know themeColor field', async () => {
    prisma.tenant.update.mockRejectedValue(
      Object.assign(new Error("Unknown field `themeColor`"), { message: "Unknown field `themeColor`" }),
    );
    const res = await request(makeApp())
      .put('/api/wellness/branding/theme-color')
      .send({ themeColor: '#C9A063' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/prisma generate/i);
  });
});

describe('GET /api/wellness/branding', () => {
  test('returns logoUrl, brandColor and themeColor', async () => {
    prisma.tenant.findUnique
      .mockResolvedValueOnce({ logoUrl: 'https://example.com/logo.png', brandColor: '#265855' })
      .mockResolvedValueOnce({ themeColor: '#C9A063' });
    const res = await request(makeApp()).get('/api/wellness/branding');
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBe('https://example.com/logo.png');
    expect(res.body.brandColor).toBe('#265855');
    expect(res.body.themeColor).toBe('#C9A063');
  });

  test('themeColor falls back to null when the second Prisma query fails (stale client)', async () => {
    prisma.tenant.findUnique
      .mockResolvedValueOnce({ logoUrl: null, brandColor: null })
      .mockRejectedValueOnce(new Error('Unknown field'));
    const res = await request(makeApp()).get('/api/wellness/branding');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ logoUrl: null, brandColor: null });
    expect(res.body.themeColor).toBeNull();
  });

  test('404 when tenant is not found', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/wellness/branding');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Tenant not found/i);
  });
});
