import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const auth = requireCJS('../../middleware/auth');
auth.verifyToken = (req, _res, next) => {
  req.user = { userId: 7, tenantId: 4, role: req.headers['x-test-role'] || 'ADMIN' };
  next();
};
auth.verifyRole = (roles) => (req, res, next) => (
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'denied', code: 'RBAC_DENIED' })
);

prisma.tenant = { findUnique: vi.fn() };
const config = requireCJS('../../lib/googleMapsConfig');
Object.assign(config, {
  getGoogleMapsConfig: vi.fn(),
  saveGoogleMapsConfig: vi.fn(),
  toPublicGoogleMapsConfig: vi.fn((value) => ({
    enabled: value.enabled,
    configured: value.configured,
    source: value.source,
    last4: value.last4,
    updatedAt: value.updatedAt || null,
  })),
});
const audit = requireCJS('../../lib/audit');
audit.writeAudit = vi.fn();
const writeAudit = audit.writeAudit;

const router = requireCJS('../../routes/google_maps_settings');

const app = express();
app.use(express.json());
app.use('/api/settings/google-maps', router);

describe('Google Maps settings routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'generic' });
    config.getGoogleMapsConfig.mockResolvedValue({
      enabled: true, configured: true, source: 'tenant', last4: '****1234', effectiveKey: 'secret', row: { id: 12 },
    });
    config.saveGoogleMapsConfig.mockResolvedValue({
      enabled: true, configured: true, source: 'tenant', last4: '****5678', effectiveKey: 'new-secret', row: { id: 12 },
    });
  });

  test('GET returns masked metadata without the API key', async () => {
    const response = await request(app).get('/api/settings/google-maps');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ enabled: true, configured: true, source: 'tenant', last4: '****1234' });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  test('PUT saves tenant-scoped settings and audits without logging the key', async () => {
    const response = await request(app)
      .put('/api/settings/google-maps')
      .send({ enabled: true, apiKey: 'AIzaNewSecretValue123456' });
    expect(response.status).toBe(200);
    expect(config.saveGoogleMapsConfig).toHaveBeenCalledWith(4, { enabled: true, apiKey: 'AIzaNewSecretValue123456' });
    expect(writeAudit).toHaveBeenCalledWith(
      'Integration', 'UPDATE', 12, 7, 4,
      { provider: 'google_maps', enabled: true, credentialRotated: true },
    );
    expect(JSON.stringify(response.body)).not.toContain('NewSecretValue');
  });

  test('rejects non-generic tenants before reading or writing configuration', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'travel' });
    const response = await request(app).get('/api/settings/google-maps');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('WRONG_VERTICAL');
    expect(config.getGoogleMapsConfig).not.toHaveBeenCalled();
  });

  test('requires ADMIN role', async () => {
    const response = await request(app).get('/api/settings/google-maps').set('x-test-role', 'USER');
    expect(response.status).toBe(403);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
