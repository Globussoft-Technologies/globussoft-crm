import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';
prisma.webhookEvent = { create: vi.fn(), update: vi.fn() };
const { validateCatchHook, deliverZapier } = createRequire(import.meta.url)('../../lib/zapierDelivery');
const sub = { id: 5, userId: 7, targetUrl: 'https://hooks.zapier.com/hooks/catch/123/abc/' };
beforeEach(() => {
  prisma.webhookEvent.create.mockReset().mockResolvedValue({ id: 99 });
  prisma.webhookEvent.update.mockReset().mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});
afterEach(() => vi.unstubAllGlobals());
describe('Zapier Catch Hook delivery', () => {
  test.each(['http://hooks.zapier.com/hooks/catch/1/a/', 'https://localhost/hook', 'https://hooks.zapier.com.evil.test/hooks/catch/1/a/', 'https://hooks.zapier.com/hooks/catch/1/a/?secret=x', 'https://user@hooks.zapier.com/hooks/catch/1/a/'])('rejects unsafe target %s', target => {
    expect(() => validateCatchHook(target)).toThrow();
  });
  test('signs and records acceptance without storing destination or message data', async () => {
    const result = await deliverZapier(sub, 'contact.created', { contactId: 2, email: 'priya@example.invalid', portalPasswordHash: 'private' }, 3, 'secret', true);
    expect(result).toMatchObject({ ok: true, attempts: 1, httpStatus: 200 });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(sub.targetUrl);
    expect(options.redirect).toBe('error');
    expect(options.headers['X-Globussoft-Signature']).toMatch(/^t=\d+,v1=/);
    expect(JSON.parse(options.body)).toMatchObject({ test: true, data: { contactId: 2 } });
    expect(options.body).not.toContain('portalPasswordHash');
    const write = prisma.webhookEvent.update.mock.calls[0][0].data;
    expect(write.status).toBe('PROCESSED');
    expect(write.rawPayload).not.toContain('priya@');
    expect(write.rawPayload).not.toContain('hooks.zapier.com');
  });
  test('retries server failures with one stable event identifier', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue({ ok: true, status: 200 });
    expect(await deliverZapier(sub, 'deal.won', {}, 3)).toMatchObject({ ok: true, attempts: 2 });
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  });
  test('records a failed client response without retrying or logging its body', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404 });
    expect(await deliverZapier(sub, 'task.completed', {}, 3)).toMatchObject({ ok: false, attempts: 1 });
    expect(prisma.webhookEvent.update.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', errorMessage: 'HTTP 404' });
  });
  test('does not send an unrecorded delivery when persistence fails', async () => {
    prisma.webhookEvent.create.mockRejectedValue(new Error('db failed'));
    await expect(deliverZapier(sub, 'contact.created', {}, 3)).rejects.toThrow('db failed');
    expect(fetch).not.toHaveBeenCalled();
  });
});
