import { beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.tenantSetting = {
  findMany: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
};
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  router,
  WEBSITE_KEY,
  SFTP_KEY,
  normalizeWebsiteUrl,
  validateSftp,
  maskConfig,
} = requireCJS('../../routes/travel_promotional_website');
const publisher = requireCJS('../../services/travelPromotionalWebsitePublisher');
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/promotional-website', router);
  return app;
}

function tokenFor({ role = 'ADMIN', vertical = 'travel', tenantId = 1 } = {}) {
  return jwt.sign({ userId: 7, tenantId, role, vertical }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  prisma.tenantSetting.findMany.mockReset().mockResolvedValue([]);
  prisma.tenantSetting.upsert.mockReset();
  prisma.tenantSetting.delete.mockReset();
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.count.mockReset().mockResolvedValue(0);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  vi.restoreAllMocks();
});

describe('travel promotional website settings', () => {
  test('normalizes the setting to the client website origin', () => {
    expect(normalizeWebsiteUrl('https://client.example.com/marketing/')).toBe('https://client.example.com');
    expect(() => normalizeWebsiteUrl('javascript:alert(1)')).toThrow();
  });

  test('validates FTP and FTPS credentials with their default port', () => {
    expect(validateSftp({ protocol: 'ftp', host: 'ftp.example.com', username: 'deploy', password: 'secret', remotePath: '/' })).toMatchObject({
      protocol: 'ftp', port: 21,
    });
    expect(validateSftp({ protocol: 'ftps', host: 'secure.example.com', username: 'deploy', password: 'secret', remotePath: '/' })).toMatchObject({
      protocol: 'ftps', port: 21,
    });
    expect(() => validateSftp({ protocol: 'ftp', host: 'ftp.example.com', username: 'deploy', remotePath: '/' })).toThrow(/password is required/i);
  });

  test('treats a legacy trailing trips path as the existing website root', () => {
    expect(validateSftp({
      protocol: 'ftp', host: 'ftp.example.com', username: 'deploy', password: 'secret',
      remotePath: '/home/modernclassroom/public_html/main-forms/trips',
    }).remotePath).toBe('/home/modernclassroom/public_html/main-forms');
  });

  test('masks protocol-specific credential state without exposing secrets', () => {
    expect(maskConfig('https://client.example.com', {
      protocol: 'ftp', host: 'ftp.example.com', username: 'deploy', password: 'secret', remotePath: '/',
    })).toMatchObject({
      configured: true,
      sftp: { protocol: 'ftp', port: 21, hasPassword: true, hasPrivateKey: false },
    });
  });

  test('requires a travel tenant and admin role', async () => {
    const generic = await request(makeApp())
      .get('/api/travel/promotional-website')
      .set('Authorization', `Bearer ${tokenFor({ vertical: 'generic' })}`);
    expect(generic.status).toBe(403);

    const user = await request(makeApp())
      .put('/api/travel/promotional-website')
      .set('Authorization', `Bearer ${tokenFor({ role: 'USER' })}`)
      .send({ websiteUrl: 'https://client.example.com' });
    expect(user.status).toBe(403);
  });

  test('masks stored secrets on GET', async () => {
    prisma.tenantSetting.findMany.mockResolvedValue([
      { id: 1, key: WEBSITE_KEY, value: 'https://client.example.com' },
      { id: 2, key: SFTP_KEY, value: JSON.stringify({ host: 'sftp.example.com', username: 'deploy', password: 'secret', remotePath: '/' }) },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/promotional-website')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ websiteUrl: 'https://client.example.com', configured: true, sftp: { host: 'sftp.example.com', username: 'deploy', hasPassword: true } });
    expect(res.body.sftp.password).toBeUndefined();
  });

  test('rejects an invalid website before writing settings', async () => {
    const res = await request(makeApp())
      .put('/api/travel/promotional-website')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ websiteUrl: 'javascript:alert(1)', sftp: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROMOTIONAL_WEBSITE_SETTINGS');
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test('stores website and SFTP configuration without returning the secret', async () => {
    prisma.tenantSetting.upsert
      .mockResolvedValueOnce({ id: 11, key: WEBSITE_KEY })
      .mockResolvedValueOnce({ id: 12, key: SFTP_KEY });
    const res = await request(makeApp())
      .put('/api/travel/promotional-website')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        websiteUrl: 'https://client.example.com/',
        sftp: { host: 'sftp.example.com', port: 22, username: 'deploy', password: 'secret', remotePath: '/' },
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ websiteUrl: 'https://client.example.com', configured: true });
    const sftpWrite = prisma.tenantSetting.upsert.mock.calls[1][0];
    if (sftpWrite.create.value.startsWith('ENC:v1:')) {
      expect(sftpWrite.create.value).not.toContain('secret');
    } else {
      expect(JSON.parse(sftpWrite.create.value).password).toBe('secret');
    }
  });

  test('tests FTP credentials without requiring a trip folder to exist', async () => {
    const list = vi.fn();
    const withRemoteClient = vi.spyOn(publisher, 'withRemoteClient').mockImplementation(async (config, callback) => {
      expect(config).toMatchObject({ protocol: 'ftp', host: 'ftp.example.com', port: 21 });
      return callback({ list });
    });

    const res = await request(makeApp())
      .post('/api/travel/promotional-website/test')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        sftp: { protocol: 'ftp', host: 'ftp.example.com', username: 'deploy', password: 'secret', remotePath: '/' },
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, protocol: 'ftp', remotePath: '/' });
    expect(withRemoteClient).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });
});
