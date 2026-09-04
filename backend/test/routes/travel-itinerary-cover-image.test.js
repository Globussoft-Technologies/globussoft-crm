// @ts-check
/**
 * Per-itinerary cover photo.
 *
 *   POST   /api/travel/itineraries/:id/cover-image   upload, becomes the hero
 *   DELETE /api/travel/itineraries/:id/cover-image   back to the destination photo
 *
 * Why it exists: without a cover, the PDF hero is the destination's Wikipedia
 * lead image, so every Goa itinerary ships with the identical photograph.
 *
 * What's pinned
 * -------------
 *   - The URL is stored on templateDataJson and the OTHER template values
 *     survive the write (they share one column).
 *   - Non-images are rejected before anything is stored.
 *   - Delete removes only the cover key.
 *   - Tenant scoping, RBAC and auth gates run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findFirst = vi.fn();
prisma.itinerary.findUnique = vi.fn();
prisma.itinerary.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
process.env.AWS_S3_URL = 'https://cdn.example.com';
const s3Service = requireCJS('../../services/s3Service');
const itinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', itinerariesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function itineraryRow(overrides = {}) {
  return {
    id: 42,
    tenantId: 1,
    title: 'Goa',
    destination: 'Goa, India',
    subBrand: null,
    templateDataJson: JSON.stringify({ tripStyle: 'Summer vacation' }),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset().mockResolvedValue(itineraryRow());
  prisma.itinerary.findUnique.mockReset().mockResolvedValue(itineraryRow());
  prisma.itinerary.update.mockReset().mockImplementation(({ data }) => ({ id: 42, ...data }));
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  s3Service.uploadFile = vi.fn().mockResolvedValue('https://cdn.example.com/travel-itinerary-covers/1-cover.png');
});

describe('POST /itineraries/:id/cover-image', () => {
  test('stores the uploaded URL without losing the other template values', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/42/cover-image')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .attach('file', PNG, { filename: 'cover.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.coverImageUrl).toBe('https://cdn.example.com/travel-itinerary-covers/1-cover.png');

    const saved = JSON.parse(prisma.itinerary.update.mock.calls[0][0].data.templateDataJson);
    expect(saved.coverImageUrl).toBe('https://cdn.example.com/travel-itinerary-covers/1-cover.png');
    // templateDataJson is one column shared with the detected template fields —
    // writing the cover must not wipe what the operator already filled in.
    expect(saved.tripStyle).toBe('Summer vacation');
  });

  test('uploads into its own folder rather than a shared one', async () => {
    await request(makeApp())
      .post('/api/travel/itineraries/42/cover-image')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .attach('file', PNG, { filename: 'cover.png', contentType: 'image/png' });

    expect(s3Service.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer), 'cover.png', 'image/png', 'travel-itinerary-covers',
    );
  });

  test('rejects a non-image before storing anything', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/42/cover-image')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
  });

  test('400s when no file is attached', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/42/cover-image')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_REQUIRED');
  });

  test('401s without a token', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/42/cover-image')
      .attach('file', PNG, { filename: 'cover.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /itineraries/:id/cover-image', () => {
  test('removes only the cover key', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(
      itineraryRow({ templateDataJson: JSON.stringify({ tripStyle: 'Summer vacation', coverImageUrl: 'https://cdn.example.com/x.png' }) }),
    );

    const res = await request(makeApp())
      .delete('/api/travel/itineraries/42/cover-image')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    const saved = JSON.parse(prisma.itinerary.update.mock.calls[0][0].data.templateDataJson);
    expect(saved.coverImageUrl).toBeUndefined();
    expect(saved.tripStyle).toBe('Summer vacation');
  });

  test('is a no-op when no cover was set', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/itineraries/42/cover-image')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(false);
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
  });
});
