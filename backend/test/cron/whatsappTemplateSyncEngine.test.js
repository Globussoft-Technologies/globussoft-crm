// Unit tests for backend/cron/whatsappTemplateSyncEngine.js
//
// Pins:
//   • syncTemplatesForTenant: NOT_CONNECTED when no active config exists
//   • syncTemplatesForTenant: INCOMPLETE_CONFIG when wabaId/token missing
//   • syncTemplatesForTenant: GRAPH_ERROR when Meta listTemplates fails
//   • syncTemplatesForTenant: maps Meta payload components → schema fields
//   • syncTemplatesForTenant: handles APPROVED/REJECTED/PENDING/PAUSED/FLAGGED status
//   • syncTemplatesForTenant: returns synced count + total

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

if (!prisma.whatsAppConfig) prisma.whatsAppConfig = {};
if (!prisma.whatsAppTemplate) prisma.whatsAppTemplate = {};
prisma.whatsAppConfig.findFirst = vi.fn();
prisma.whatsAppTemplate.upsert = vi.fn();

const provider = require('../../services/whatsappProvider');
provider.listTemplates = vi.fn();

const { syncTemplatesForTenant } = require('../../cron/whatsappTemplateSyncEngine');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.whatsAppConfig.findFirst.mockReset();
  prisma.whatsAppTemplate.upsert.mockReset();
  provider.listTemplates.mockReset();
});

describe('syncTemplatesForTenant', () => {
  test('NOT_CONNECTED when no active config', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue(null);
    const r = await syncTemplatesForTenant(1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_CONNECTED');
  });

  test('INCOMPLETE_CONFIG when businessAccountId missing', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({ accessToken: 'tok' });
    const r = await syncTemplatesForTenant(1);
    expect(r.code).toBe('INCOMPLETE_CONFIG');
  });

  test('INCOMPLETE_CONFIG when accessToken missing', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({ businessAccountId: 'W' });
    const r = await syncTemplatesForTenant(1);
    expect(r.code).toBe('INCOMPLETE_CONFIG');
  });

  test('GRAPH_ERROR propagates Meta failure', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({ businessAccountId: 'W', accessToken: 'tok' });
    provider.listTemplates.mockResolvedValue({ ok: false, error: 'rate limited' });
    const r = await syncTemplatesForTenant(1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('GRAPH_ERROR');
    expect(r.error).toBe('rate limited');
  });

  test('maps components → schema fields (header/body/footer/buttons)', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({ businessAccountId: 'W', accessToken: 'tok' });
    provider.listTemplates.mockResolvedValue({
      ok: true,
      data: {
        data: [{
          id: 'tpl_meta_id_1',
          name: 'appointment_reminder',
          language: 'en_US',
          status: 'APPROVED',
          category: 'utility',
          components: [
            { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' },
            { type: 'BODY', text: 'Your appointment is at {{2}}.' },
            { type: 'FOOTER', text: 'Reply STOP to opt out' },
            { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirm' }] },
          ],
          quality_score: { score: 'HIGH' },
        }],
      },
    });
    prisma.whatsAppTemplate.upsert.mockResolvedValue({});
    const r = await syncTemplatesForTenant(7);
    expect(r.ok).toBe(true);
    expect(r.synced).toBe(1);
    expect(r.total).toBe(1);
    const data = prisma.whatsAppTemplate.upsert.mock.calls[0][0].create;
    expect(data.name).toBe('appointment_reminder');
    expect(data.language).toBe('en_US');
    expect(data.category).toBe('UTILITY');
    expect(data.status).toBe('APPROVED');
    expect(data.headerType).toBe('TEXT');
    expect(data.headerContent).toBe('Hello {{1}}');
    expect(data.body).toBe('Your appointment is at {{2}}.');
    expect(data.footer).toBe('Reply STOP to opt out');
    expect(data.buttons).toBe(JSON.stringify([{ type: 'QUICK_REPLY', text: 'Confirm' }]));
    expect(data.metaTemplateId).toBe('tpl_meta_id_1');
    expect(data.qualityScore).toBe('HIGH');
    expect(data.lastSyncedAt).toBeInstanceOf(Date);
  });

  test('REJECTED status maps through unchanged', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({ businessAccountId: 'W', accessToken: 'tok' });
    provider.listTemplates.mockResolvedValue({
      ok: true,
      data: { data: [{ name: 'bad', language: 'en', status: 'REJECTED', components: [{ type: 'BODY', text: 'x' }] }] },
    });
    prisma.whatsAppTemplate.upsert.mockResolvedValue({});
    const r = await syncTemplatesForTenant(7);
    expect(r.ok).toBe(true);
    expect(prisma.whatsAppTemplate.upsert.mock.calls[0][0].create.status).toBe('REJECTED');
  });

  test('unknown status defaults to PENDING', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({ businessAccountId: 'W', accessToken: 'tok' });
    provider.listTemplates.mockResolvedValue({
      ok: true,
      data: { data: [{ name: 'x', language: 'en', status: 'WEIRD_NEW_STATE', components: [] }] },
    });
    prisma.whatsAppTemplate.upsert.mockResolvedValue({});
    const r = await syncTemplatesForTenant(7);
    expect(r.ok).toBe(true);
    expect(prisma.whatsAppTemplate.upsert.mock.calls[0][0].create.status).toBe('PENDING');
  });

  test('upsert failures are logged but the batch continues', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({ businessAccountId: 'W', accessToken: 'tok' });
    provider.listTemplates.mockResolvedValue({
      ok: true,
      data: { data: [
        { name: 'a', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'A' }] },
        { name: 'b', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'B' }] },
      ] },
    });
    prisma.whatsAppTemplate.upsert
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('DB transient'));
    const r = await syncTemplatesForTenant(7);
    expect(r.ok).toBe(true);
    expect(r.synced).toBe(1);
    expect(r.total).toBe(2);
  });
});
