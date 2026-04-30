// Unit tests for backend/lib/leadSla.js
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup).
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import leadSla from '../../lib/leadSla.js';

const {
  TIER_SLA_MINUTES,
  DEFAULT_SLA_MINUTES,
  detectCategory,
  findMatchedService,
  computeFirstResponseDueAt,
  markFirstResponseIfNeeded,
} = leadSla;

beforeAll(() => {
  prisma.service = { findFirst: vi.fn() };
  prisma.contact = { findUnique: vi.fn(), update: vi.fn() };
});

beforeEach(() => {
  prisma.service.findFirst.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.contact.update.mockReset();
});

describe('lib/leadSla — constants', () => {
  test('TIER_SLA_MINUTES has high/medium/low', () => {
    expect(TIER_SLA_MINUTES.high).toBe(5);
    expect(TIER_SLA_MINUTES.medium).toBe(30);
    expect(TIER_SLA_MINUTES.low).toBe(240);
  });

  test('DEFAULT_SLA_MINUTES is medium tier', () => {
    expect(DEFAULT_SLA_MINUTES).toBe(30);
  });
});

describe('lib/leadSla — detectCategory (pure)', () => {
  test('returns null for empty/null input', () => {
    expect(detectCategory(null)).toBeNull();
    expect(detectCategory(undefined)).toBeNull();
    expect(detectCategory('')).toBeNull();
  });

  test('detects hair category', () => {
    expect(detectCategory('hair transplant inquiry')).toBe('hair');
    expect(detectCategory('PRP treatment')).toBe('hair');
    expect(detectCategory('FUE consultation')).toBe('hair');
  });

  test('detects aesthetics category', () => {
    expect(detectCategory('botox booking')).toBe('aesthetics');
    expect(detectCategory('filler enquiry')).toBe('aesthetics');
  });

  test('detects laser category', () => {
    expect(detectCategory('laser hair removal')).toBe('laser');
    expect(detectCategory('tattoo removal')).toBe('laser');
  });

  test('detects skin category', () => {
    expect(detectCategory('acne treatment')).toBe('skin');
    expect(detectCategory('hydrafacial please')).toBe('skin');
  });

  test('detects body category', () => {
    expect(detectCategory('liposuction')).toBe('body');
    expect(detectCategory('weight loss program')).toBe('body');
  });

  test('detects ayurveda category', () => {
    expect(detectCategory('shirodhara therapy')).toBe('ayurveda');
  });

  test('detects salon category', () => {
    expect(detectCategory('haircut booking')).toBe('salon');
  });

  test('returns null for non-matching text', () => {
    expect(detectCategory('hello world')).toBeNull();
    expect(detectCategory('random query')).toBeNull();
  });

  test('case-insensitive matching', () => {
    expect(detectCategory('BOTOX inquiry')).toBe('aesthetics');
    expect(detectCategory('Hair Transplant')).toBe('hair');
  });
});

describe('lib/leadSla — findMatchedService', () => {
  test('returns null when no category detected', async () => {
    const out = await findMatchedService({ tenantId: 1, text: 'random' });
    expect(out).toBeNull();
    expect(prisma.service.findFirst).not.toHaveBeenCalled();
  });

  test('queries service with detected category', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 1, name: 'Botox', category: 'aesthetics', ticketTier: 'high' });
    const out = await findMatchedService({ tenantId: 9, text: 'botox booking' });
    expect(prisma.service.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 9, isActive: true, category: 'aesthetics' },
      select: { id: true, name: true, category: true, ticketTier: true },
      orderBy: { id: 'asc' },
    });
    expect(out.ticketTier).toBe('high');
  });

  test('returns null on prisma error (fail-open)', async () => {
    prisma.service.findFirst.mockRejectedValue(new Error('db down'));
    const out = await findMatchedService({ tenantId: 1, text: 'botox' });
    expect(out).toBeNull();
  });

  test('returns null when no service found', async () => {
    prisma.service.findFirst.mockResolvedValue(null);
    const out = await findMatchedService({ tenantId: 1, text: 'botox' });
    expect(out).toBeNull();
  });
});

describe('lib/leadSla — computeFirstResponseDueAt', () => {
  test('default fallback (30 min) when no serviceId, no text', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const result = await computeFirstResponseDueAt({ tenantId: 1, now });
    expect(result.minutes).toBe(30);
    expect(result.tier).toBeNull();
    expect(result.serviceId).toBeNull();
    expect(result.dueAt.getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  test('uses serviceId path when provided', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 7, ticketTier: 'high' });
    const now = new Date('2026-01-01T00:00:00Z');
    const result = await computeFirstResponseDueAt({ tenantId: 9, serviceId: 7, now });
    expect(result.tier).toBe('high');
    expect(result.minutes).toBe(5);
    expect(result.serviceId).toBe(7);
    expect(result.dueAt.getTime()).toBe(now.getTime() + 5 * 60_000);
  });

  test('serviceId path coerces string id to number', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 7, ticketTier: 'low' });
    await computeFirstResponseDueAt({ tenantId: 1, serviceId: '7' });
    const arg = prisma.service.findFirst.mock.calls[0][0];
    expect(arg.where.id).toBe(7);
  });

  test('serviceId not found → falls through to text classification', async () => {
    prisma.service.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 11, ticketTier: 'medium', name: 'Acne', category: 'skin' });
    const result = await computeFirstResponseDueAt({ tenantId: 1, serviceId: 999, text: 'acne treatment' });
    expect(result.tier).toBe('medium');
    expect(result.serviceId).toBe(11);
  });

  test('serviceId DB error → falls through to text classification', async () => {
    prisma.service.findFirst
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 5, ticketTier: 'high', name: 'Botox', category: 'aesthetics' });
    const result = await computeFirstResponseDueAt({ tenantId: 1, serviceId: 99, text: 'botox' });
    expect(result.tier).toBe('high');
  });

  test('text classification path: high tier → 5 min', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 1, ticketTier: 'high', name: 'HT', category: 'hair' });
    const now = new Date('2026-01-01T00:00:00Z');
    const result = await computeFirstResponseDueAt({ tenantId: 1, text: 'hair transplant', now });
    expect(result.minutes).toBe(5);
    expect(result.dueAt.getTime() - now.getTime()).toBe(5 * 60 * 1000);
  });

  test('text classification path: low tier → 240 min', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 1, ticketTier: 'low', name: 'Salon', category: 'salon' });
    const result = await computeFirstResponseDueAt({ tenantId: 1, text: 'haircut' });
    expect(result.minutes).toBe(240);
  });

  test('unknown tier value → falls back to default', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 1, ticketTier: 'mystery' });
    const result = await computeFirstResponseDueAt({ tenantId: 1, serviceId: 1 });
    expect(result.minutes).toBe(30);
  });

  test('omitting now parameter uses current time', async () => {
    const before = Date.now();
    const result = await computeFirstResponseDueAt({ tenantId: 1 });
    const after = Date.now();
    const expectedMin = before + 30 * 60_000;
    const expectedMax = after + 30 * 60_000;
    expect(result.dueAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(result.dueAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  test('returns shape with all four keys', async () => {
    const result = await computeFirstResponseDueAt({ tenantId: 1 });
    expect(result).toHaveProperty('dueAt');
    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('minutes');
    expect(result).toHaveProperty('serviceId');
  });
});

describe('lib/leadSla — markFirstResponseIfNeeded', () => {
  test('returns false when contactId missing', async () => {
    expect(await markFirstResponseIfNeeded({})).toBe(false);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('returns false when contact not found', async () => {
    prisma.contact.findUnique.mockResolvedValue(null);
    expect(await markFirstResponseIfNeeded({ contactId: 1 })).toBe(false);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('returns false when firstResponseAt already set', async () => {
    prisma.contact.findUnique.mockResolvedValue({ id: 1, firstResponseAt: new Date(), status: 'Lead' });
    expect(await markFirstResponseIfNeeded({ contactId: 1 })).toBe(false);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('returns false when status is not "Lead"', async () => {
    prisma.contact.findUnique.mockResolvedValue({ id: 1, firstResponseAt: null, status: 'Customer' });
    expect(await markFirstResponseIfNeeded({ contactId: 1 })).toBe(false);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('updates contact when conditions met', async () => {
    prisma.contact.findUnique.mockResolvedValue({ id: 1, firstResponseAt: null, status: 'Lead' });
    prisma.contact.update.mockResolvedValue({});
    expect(await markFirstResponseIfNeeded({ contactId: 1 })).toBe(true);
    expect(prisma.contact.update).toHaveBeenCalledTimes(1);
    const arg = prisma.contact.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 1 });
    expect(arg.data.firstResponseAt).toBeInstanceOf(Date);
  });

  test('uses provided "when" timestamp', async () => {
    prisma.contact.findUnique.mockResolvedValue({ id: 1, firstResponseAt: null, status: 'Lead' });
    prisma.contact.update.mockResolvedValue({});
    const when = new Date('2026-01-01T00:00:00Z');
    await markFirstResponseIfNeeded({ contactId: 1, when });
    const arg = prisma.contact.update.mock.calls[0][0];
    expect(arg.data.firstResponseAt.toISOString()).toBe(when.toISOString());
  });

  test('coerces string contactId to number', async () => {
    prisma.contact.findUnique.mockResolvedValue({ id: 5, firstResponseAt: null, status: 'Lead' });
    prisma.contact.update.mockResolvedValue({});
    await markFirstResponseIfNeeded({ contactId: '5' });
    expect(prisma.contact.findUnique.mock.calls[0][0].where.id).toBe(5);
  });

  test('swallows DB errors and returns false', async () => {
    prisma.contact.findUnique.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await markFirstResponseIfNeeded({ contactId: 1 })).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
