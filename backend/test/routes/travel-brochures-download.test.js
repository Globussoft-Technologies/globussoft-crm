// @ts-check
/**
 * Route-level tests for the brochure download proxy.
 *
 * The new GET /api/travel/brochures/:id/download endpoint streams a persisted
 * brochure from S3 (or local disk) through the backend so the frontend doesn't
 * depend on the S3 bucket being world-readable.
 *
 * Mocking strategy:
 *   - Prisma is patched before requiring the router (real verifyToken /
 *     requireTravelTenant / requirePermission fire).
 *   - brochureS3Store.streamBrochure is monkey-patched per test.
 *   - fs.createReadStream is used for the local-disk branch.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel Tenant',
  slug: 'test-travel-tenant',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelBrochuresRouter = requireCJS('../../routes/travel_brochures');
const brochureS3Store = requireCJS('../../lib/brochureS3Store');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelBrochuresRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel Tenant',
    slug: 'test-travel-tenant',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.travelBrochure = prisma.travelBrochure || {};
  prisma.travelBrochure.findFirst = vi.fn();
  brochureS3Store.streamBrochure = vi.fn();
  brochureS3Store.isS3Url = vi.fn().mockReturnValue(false);
  vi.spyOn(fs, 'createReadStream').mockRestore?.();
});

describe('GET /api/travel/brochures/:id/download', () => {
  test('requires authentication', async () => {
    const res = await request(makeApp()).get('/api/travel/brochures/1/download');
    expect(res.status).toBe(401);
  });

  test('requires travel tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1,
      vertical: 'wellness',
      name: 'Test Wellness Tenant',
      slug: 'test-wellness-tenant',
    });
    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
  });

  test('requires marketing:read permission', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });

  test('404 when brochure row is missing', async () => {
    prisma.travelBrochure.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/brochures/99/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  test('404 when brochure has no pdfUrl', async () => {
    prisma.travelBrochure.findFirst.mockResolvedValue({
      id: 1,
      pdfUrl: null,
      runId: 'br_test',
      goal: 'Test brochure',
    });
    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  test('streams S3 PDF with Content-Disposition attachment', async () => {
    const s3Url = 'https://test-bucket.s3.us-east-1.amazonaws.com/brochures/1/br_test.pdf';
    prisma.travelBrochure.findFirst.mockResolvedValue({
      id: 1,
      pdfUrl: s3Url,
      runId: 'br_test',
      goal: 'Japan luxury tour brochure',
    });
    brochureS3Store.isS3Url.mockReturnValue(true);
    const bodyStream = new PassThrough();
    brochureS3Store.streamBrochure.mockResolvedValue({
      stream: bodyStream,
      contentType: 'application/pdf',
    });
    // Defer the write so the framework has time to set up the pipe.
    setImmediate(() => {
      bodyStream.write('%PDF-1.4 fake brochure bytes');
      bodyStream.end();
    });

    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/attachment;/);
    expect(res.headers['content-disposition']).toMatch(/Japan-luxury-tour-brochure-br_test\.pdf/);
    const bodyText = (res.body ? Buffer.from(res.body).toString() : res.text) || '';
    expect(bodyText).toContain('%PDF-1.4 fake');
    expect(brochureS3Store.streamBrochure).toHaveBeenCalledWith(1, s3Url);
  });

  test('streams S3 HTML when stored url ends in .html', async () => {
    const s3Url = 'https://test-bucket.s3.us-east-1.amazonaws.com/brochures/1/br_test.html';
    prisma.travelBrochure.findFirst.mockResolvedValue({
      id: 1,
      pdfUrl: s3Url,
      runId: 'br_test',
      goal: 'Japan luxury tour brochure',
    });
    brochureS3Store.isS3Url.mockReturnValue(true);
    const htmlStream = new PassThrough();
    brochureS3Store.streamBrochure.mockResolvedValue({
      stream: htmlStream,
      contentType: 'text/html',
    });
    setImmediate(() => {
      htmlStream.write('<html><body>brochure</body></html>');
      htmlStream.end();
    });

    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
    expect(res.headers['content-disposition']).toMatch(/br_test\.html/);
  });

  test('streams local PDF from disk', async () => {
    const localName = 'brochure-br_test.pdf';
    const localUrl = `/api/brochure-assets/${localName}`;
    prisma.travelBrochure.findFirst.mockResolvedValue({
      id: 1,
      pdfUrl: localUrl,
      runId: 'br_test',
      goal: 'Japan luxury tour brochure',
    });

    const fakeStream = new PassThrough();
    setImmediate(() => {
      fakeStream.write('%PDF-1.4 local');
      fakeStream.end();
    });
    const accessMock = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
    const createReadStreamMock = vi.spyOn(fs, 'createReadStream').mockReturnValue(fakeStream);

    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/attachment;/);
    expect(createReadStreamMock).toHaveBeenCalledWith(expect.stringContaining(localName));
    accessMock.mockRestore();
    createReadStreamMock.mockRestore();
  });

  test('redirects external/legacy URLs instead of proxying', async () => {
    prisma.travelBrochure.findFirst.mockResolvedValue({
      id: 1,
      pdfUrl: 'https://cdn.example.com/legacy.pdf',
      runId: 'br_test',
      goal: 'Test brochure',
    });

    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://cdn.example.com/legacy.pdf');
  });

  test('502 when S3 stream fails', async () => {
    const s3Url = 'https://test-bucket.s3.us-east-1.amazonaws.com/brochures/1/br_test.pdf';
    prisma.travelBrochure.findFirst.mockResolvedValue({
      id: 1,
      pdfUrl: s3Url,
      runId: 'br_test',
      goal: 'Test brochure',
    });
    brochureS3Store.isS3Url.mockReturnValue(true);
    brochureS3Store.streamBrochure.mockRejectedValue(new Error('S3 timeout'));

    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('S3_ACCESS_FAILED');
  });

  test('?inline=1 sets Content-Disposition to inline for S3 PDF', async () => {
    const s3Url = 'https://test-bucket.s3.us-east-1.amazonaws.com/brochures/1/br_test.pdf';
    prisma.travelBrochure.findFirst.mockResolvedValue({
      id: 1,
      pdfUrl: s3Url,
      runId: 'br_test',
      goal: 'Japan luxury tour brochure',
    });
    brochureS3Store.isS3Url.mockReturnValue(true);
    const bodyStream = new PassThrough();
    brochureS3Store.streamBrochure.mockResolvedValue({
      stream: bodyStream,
      contentType: 'application/pdf',
    });
    setImmediate(() => {
      bodyStream.write('%PDF-1.4 fake');
      bodyStream.end();
    });

    const res = await request(makeApp())
      .get('/api/travel/brochures/1/download?inline=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/inline;/);
    expect(res.headers['content-disposition']).toMatch(/Japan-luxury-tour-brochure-br_test\.pdf/);
  });
});
