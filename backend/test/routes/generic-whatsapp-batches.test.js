import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const auth = requireCJS('../../middleware/auth');
auth.verifyToken = (_req, _res, next) => next();
const messaging = requireCJS('../../lib/genericWebFormWhatsApp');
const queueContact = vi.fn();
messaging.queueGenericBulkContact = queueContact;
prisma.tenant.findUnique = vi.fn();
prisma.tenantSetting.findUnique = vi.fn();
prisma.tenantSetting.upsert = vi.fn();
prisma.whatsAppTemplate.findMany = vi.fn();
prisma.webForm.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();
const router = requireCJS('../../routes/whatsapp');
function app(role = 'ADMIN') {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => { req.user = { role, tenantId: 7, userId: 3 }; next(); });
  result.use('/api/whatsapp', router);
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'generic' });
  prisma.tenantSetting.findUnique.mockResolvedValue({ value: '{"statusTemplates":{"existingLead":11}}' });
  prisma.whatsAppTemplate.findMany.mockResolvedValue([{ id: 11 }]);
  prisma.webForm.findFirst.mockResolvedValue(null);
  prisma.contact.findMany.mockResolvedValue([]);
  queueContact.mockResolvedValue({ sent: true });
});
describe('Generic WhatsApp administrative batches', () => {
  test.each(['/templates/generic-web-form-status', '/templates/11/use-for-generic-web-forms'])('denies ordinary users changing %s', async (path) => {
    const response = await request(app('USER')).post(`/api/whatsapp${path}`).send({ status: 'newLead', templateId: 11 });
    expect(response.status).toBe(403);
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });
  test.each(['wellness', 'travel'])('does not queue messages for %s tenants', async (vertical) => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical });
    const response = await request(app()).post('/api/whatsapp/templates/generic-web-form-send-all').send({});
    expect(response.status).toBe(403);
    expect(queueContact).not.toHaveBeenCalled();
  });
  test('bounds each batch and preserves campaign identities on replay', async () => {
    prisma.contact.findMany.mockResolvedValue(Array.from({ length: 101 }, (_, index) => ({ id: index + 1, status: 'Lead', phone: '919000000000' })));
    const first = await request(app()).post('/api/whatsapp/templates/generic-web-form-send-all').send({});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ queued: 100, nextCursor: 100 });
    expect(queueContact).toHaveBeenCalledTimes(100);
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101,
      where: expect.objectContaining({ tenantId: 7, id: { gt: 0 } }) }));
    const firstId = queueContact.mock.calls[0][0].submissionId;
    queueContact.mockClear();
    await request(app()).post('/api/whatsapp/templates/generic-web-form-send-all').send({});
    expect(queueContact.mock.calls[0][0].submissionId).toBe(firstId);
  });
  test('rejects continuation when template mappings change', async () => {
    const response = await request(app()).post('/api/whatsapp/templates/generic-web-form-send-all')
      .send({ afterId: 100, campaignKey: 'old-config' });
    expect(response.status).toBe(409);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });
});
