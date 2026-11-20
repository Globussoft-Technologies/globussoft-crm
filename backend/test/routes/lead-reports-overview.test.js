import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const require = createRequire(import.meta.url);
const settings = require('../../lib/tenantSettings');
settings.getSetting = vi.fn().mockResolvedValue('[]');
for (const model of ['user', 'contact', 'activity', 'task', 'emailMessage', 'smsMessage', 'whatsAppMessage']) {
  prisma[model].findMany = vi.fn();
}
for (const model of ['emailMessage', 'smsMessage', 'whatsAppMessage']) prisma[model].count = vi.fn();
const router = require('../../routes/lead_reports');

beforeEach(() => {
  prisma.tenantSetting.findUnique = vi.fn().mockResolvedValue(null);
  for (const model of ['user', 'contact', 'activity', 'task', 'emailMessage', 'smsMessage', 'whatsAppMessage']) prisma[model].findMany.mockReset().mockResolvedValue([]);
  for (const model of ['emailMessage', 'smsMessage', 'whatsAppMessage']) prisma[model].count.mockReset().mockResolvedValue(0);
});

describe('lead overview', () => {
  test('scopes the lead-created population to current leads within the tenant', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { userId: 3, tenantId: 7, role: 'ADMIN' }; next(); });
    app.use('/api/lead-reports', router);
    const res = await request(app).get('/api/lead-reports/overview?range=last_7_days');
    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 7, status: 'Lead', deletedAt: null }),
    }));
  });

  test('buckets incoming leads on their workspace day across UTC midnight', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'Asia/Kolkata' });
    prisma.contact.findMany.mockResolvedValue([{ id: 1, createdAt: new Date('2026-11-18T20:00:00Z') }]);
    const app = express();
    app.use((req, _res, next) => { req.user = { userId: 3, tenantId: 7, role: 'ADMIN' }; next(); });
    app.use('/api/lead-reports', router);
    const result = await request(app).get('/api/lead-reports/overview?range=custom&from=2026-11-19&to=2026-11-19');
    expect(result.status).toBe(200);
    expect(result.body.series).toEqual([expect.objectContaining({ key: '2026-11-19', leadsCreated: 1 })]);
  });
});
