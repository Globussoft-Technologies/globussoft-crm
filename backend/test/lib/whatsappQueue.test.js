// Unit tests for backend/lib/whatsappQueue.js + whatsappQueue.db.js
//
// Pins:
//   • getQueue() returns the DB driver by default
//   • Unknown WHATSAPP_QUEUE_DRIVER falls back to DB with a warning
//   • DB driver enqueueSend / enqueueMedia / retryJob / killJob / stats
//     all translate to the expected prisma calls
//
// Mock strategy — same as test/lib/eventBus.test.js + this batch's
// test/middleware/metaWebhook.test.js: monkey-patch the prisma singleton.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

// Defensive: the new P3 model namespaces may not exist on the prisma client
// yet if `prisma generate` hasn't been re-run after the schema additions.
// The SUT and the test share the same singleton so patching here is visible
// from the SUT's view.
if (!prisma.waOutboundJob) prisma.waOutboundJob = {};
if (!prisma.waMediaJob) prisma.waMediaJob = {};
prisma.waOutboundJob.create = vi.fn();
prisma.waOutboundJob.updateMany = vi.fn();
prisma.waOutboundJob.update = vi.fn();
prisma.waOutboundJob.count = vi.fn();
prisma.waMediaJob.create = vi.fn();
prisma.waMediaJob.updateMany = vi.fn();

// SUT reads WHATSAPP_QUEUE_DRIVER per getQueue() call (cached on first match
// for that driver value) so we only need to flip the env var. No module
// reload required.
const whatsappQueue = require('../../lib/whatsappQueue');

function loadFresh(env = {}) {
  if ('WHATSAPP_QUEUE_DRIVER' in env) {
    if (env.WHATSAPP_QUEUE_DRIVER === undefined || env.WHATSAPP_QUEUE_DRIVER === null) {
      delete process.env.WHATSAPP_QUEUE_DRIVER;
    } else {
      process.env.WHATSAPP_QUEUE_DRIVER = env.WHATSAPP_QUEUE_DRIVER;
    }
  }
  return whatsappQueue;
}

beforeEach(() => {
  prisma.waOutboundJob.create.mockReset();
  prisma.waOutboundJob.updateMany.mockReset();
  prisma.waOutboundJob.update.mockReset();
  prisma.waOutboundJob.count.mockReset();
  prisma.waMediaJob.create.mockReset();
  prisma.waMediaJob.updateMany.mockReset();
});

describe('getQueue() driver selection', () => {
  test('default driver is "db"', () => {
    delete process.env.WHATSAPP_QUEUE_DRIVER;
    const { getQueue } = loadFresh();
    const q = getQueue();
    expect(typeof q.enqueueSend).toBe('function');
    expect(typeof q.enqueueMedia).toBe('function');
    expect(typeof q.retryJob).toBe('function');
    expect(typeof q.killJob).toBe('function');
    expect(typeof q.stats).toBe('function');
  });

  test('unknown driver falls back to DB with warning (not crash)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'made-up-driver-name' });
    const q = getQueue();
    expect(typeof q.enqueueSend).toBe('function');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('bullmq driver falls back to DB until implemented', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'bullmq' });
    const q = getQueue();
    expect(typeof q.enqueueSend).toBe('function');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('subsequent getQueue() calls return the same instance (cached)', () => {
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    expect(getQueue()).toBe(getQueue());
  });
});

describe('DB driver — enqueueSend', () => {
  test('creates a PENDING WaOutboundJob with runAt defaulting to now', async () => {
    prisma.waOutboundJob.create.mockResolvedValue({ id: 42, status: 'PENDING' });
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    const out = await q.enqueueSend({ messageId: 7, tenantId: 3 });
    expect(out).toEqual({ jobId: 42, status: 'PENDING' });
    expect(prisma.waOutboundJob.create).toHaveBeenCalledOnce();
    const data = prisma.waOutboundJob.create.mock.calls[0][0].data;
    expect(data.messageId).toBe(7);
    expect(data.tenantId).toBe(3);
    expect(data.status).toBe('PENDING');
    expect(data.attempts).toBe(0);
    expect(data.runAt).toBeInstanceOf(Date);
  });

  test('respects explicit runAt for delayed sends', async () => {
    prisma.waOutboundJob.create.mockResolvedValue({ id: 99, status: 'PENDING' });
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    const future = new Date(Date.now() + 60_000);
    await q.enqueueSend({ messageId: 1, tenantId: 1, runAt: future });
    expect(prisma.waOutboundJob.create.mock.calls[0][0].data.runAt).toBe(future);
  });

  test('throws on missing required fields', async () => {
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    await expect(q.enqueueSend({ messageId: 1 })).rejects.toThrow(/messageId.*tenantId/);
    await expect(q.enqueueSend({ tenantId: 1 })).rejects.toThrow(/messageId.*tenantId/);
  });
});

describe('DB driver — enqueueMedia', () => {
  test('creates a PENDING WaMediaJob with metaMediaId', async () => {
    prisma.waMediaJob.create.mockResolvedValue({ id: 5, status: 'PENDING' });
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    const out = await q.enqueueMedia({ messageId: 10, tenantId: 4, metaMediaId: 'wamid.media1', mimeType: 'image/jpeg' });
    expect(out).toEqual({ jobId: 5, status: 'PENDING' });
    const data = prisma.waMediaJob.create.mock.calls[0][0].data;
    expect(data.metaMediaId).toBe('wamid.media1');
    expect(data.mimeType).toBe('image/jpeg');
    expect(data.attempts).toBe(0);
  });

  test('throws on missing metaMediaId', async () => {
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    await expect(q.enqueueMedia({ messageId: 1, tenantId: 1 })).rejects.toThrow(/metaMediaId/);
  });
});

describe('DB driver — retryJob + killJob', () => {
  test('retryJob resets both outbound and media tables (only one matches)', async () => {
    prisma.waOutboundJob.updateMany.mockResolvedValue({ count: 0 });
    prisma.waMediaJob.updateMany.mockResolvedValue({ count: 0 });
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    await q.retryJob(123);
    expect(prisma.waOutboundJob.updateMany).toHaveBeenCalledWith({
      where: { id: 123 },
      data: expect.objectContaining({ status: 'PENDING', lockedAt: null, lockedBy: null }),
    });
    expect(prisma.waMediaJob.updateMany).toHaveBeenCalledWith({
      where: { id: 123 },
      data: expect.objectContaining({ status: 'PENDING' }),
    });
  });

  test('killJob marks DEAD on outbound + FAILED on media — never deletes', async () => {
    prisma.waOutboundJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.waMediaJob.updateMany.mockResolvedValue({ count: 0 });
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    await q.killJob(50);
    expect(prisma.waOutboundJob.updateMany.mock.calls[0][0].data.status).toBe('DEAD');
    expect(prisma.waMediaJob.updateMany.mock.calls[0][0].data.status).toBe('FAILED');
  });
});

describe('DB driver — stats', () => {
  test('aggregates the five lifecycle counts', async () => {
    prisma.waOutboundJob.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(50)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    const { getQueue } = loadFresh({ WHATSAPP_QUEUE_DRIVER: 'db' });
    const q = getQueue();
    const s = await q.stats();
    expect(s).toEqual({ pending: 10, inFlight: 2, done: 50, failed: 3, dead: 1 });
  });
});
