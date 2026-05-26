/**
 * Unit tests for backend/cron/contactGreetingsEngine.js — Phase 2
 * birthday + anniversary greetings cron. Mirrors the
 * tripPaymentReminders.test.js mocking pattern.
 *
 * Branches covered:
 *   isTodayMonthDay (pure):
 *     - today's date → true
 *     - same month+day in a different year → true (year-agnostic)
 *     - different month+day → false
 *     - null / invalid → false
 *
 *   runContactGreetingsForTenant:
 *     - query shape: tenant + deletedAt null + OR(birthDate, anniversary)
 *     - empty result → fast-path {0,0}
 *     - contact with today-matching birthDate → birthday notification
 *     - contact with today-matching anniversary → anniversary notification
 *     - contact matching BOTH today → two notifications
 *     - dedup: existing year-tagged notification → skipped
 *     - race-tolerance: notification.create throws → cron continues
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runContactGreetingsForTenant,
  isTodayMonthDay,
} from '../../cron/contactGreetingsEngine.js';

beforeAll(() => {
  prisma.contact = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads
  // tenant.subBrandConfigJson once per pass to compute the would-route
  // wabaId logged at notification create. Mock default returns null
  // config so the resolver yields {} downstream.
  prisma.tenant = { findUnique: vi.fn() };
});

beforeEach(() => {
  prisma.contact.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.tenant.findUnique.mockReset();

  prisma.contact.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
});

describe('cron/contactGreetingsEngine — isTodayMonthDay (pure)', () => {
  test('today\'s date → true', () => {
    expect(isTodayMonthDay(new Date())).toBe(true);
  });

  test('same month+day in a different year → true (year-agnostic)', () => {
    const today = new Date();
    const fiveYearsAgo = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
    expect(isTodayMonthDay(fiveYearsAgo)).toBe(true);
  });

  test('different month → false', () => {
    const today = new Date();
    const altMonth = new Date(today.getFullYear(), (today.getMonth() + 1) % 12, today.getDate());
    expect(isTodayMonthDay(altMonth)).toBe(false);
  });

  test('null / invalid → false', () => {
    expect(isTodayMonthDay(null)).toBe(false);
    expect(isTodayMonthDay(undefined)).toBe(false);
    expect(isTodayMonthDay('not-a-date')).toBe(false);
  });
});

describe('cron/contactGreetingsEngine — runContactGreetingsForTenant', () => {
  test('query shape: tenant + deletedAt null + OR(birthDate, anniversary)', async () => {
    await runContactGreetingsForTenant(42);
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.OR).toEqual([
      { birthDate: { not: null } },
      { anniversary: { not: null } },
    ]);
  });

  test('empty contacts → fast-path {0,0}', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const result = await runContactGreetingsForTenant(1);
    expect(result).toEqual({ birthdays: 0, anniversaries: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('contact with today-matching birthDate → 1 birthday notification', async () => {
    const today = new Date();
    const birthDateLast10Years = new Date(today.getFullYear() - 10, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 100, name: 'Alice', email: 'a@x.test', phone: '+91…',
        birthDate: birthDateLast10Years, anniversary: null },
    ]);
    const result = await runContactGreetingsForTenant(1);
    expect(result).toEqual({ birthdays: 1, anniversaries: 0 });
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.entityType).toBe('Contact');
    expect(createArg.data.entityId).toBe(100);
    expect(createArg.data.title).toContain(`birthday-${today.getFullYear()}`);
  });

  test('contact with today-matching anniversary → 1 anniversary notification', async () => {
    const today = new Date();
    const annivLast3Years = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 101, name: 'Bob', email: 'b@x.test', phone: '+91…',
        birthDate: null, anniversary: annivLast3Years },
    ]);
    const result = await runContactGreetingsForTenant(1);
    expect(result).toEqual({ birthdays: 0, anniversaries: 1 });
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.title).toContain(`anniv-${today.getFullYear()}`);
  });

  test('contact matching BOTH today → 2 notifications', async () => {
    const today = new Date();
    const long = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 102, name: 'Carol', email: 'c@x.test', phone: '+91…',
        birthDate: long, anniversary: long },
    ]);
    const result = await runContactGreetingsForTenant(1);
    expect(result).toEqual({ birthdays: 1, anniversaries: 1 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  test('contact whose birthDate is a different month/day → no notification', async () => {
    const today = new Date();
    const altMonth = new Date(today.getFullYear() - 5, (today.getMonth() + 1) % 12, today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 103, name: 'Dan', email: null, phone: null,
        birthDate: altMonth, anniversary: null },
    ]);
    const result = await runContactGreetingsForTenant(1);
    expect(result).toEqual({ birthdays: 0, anniversaries: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('dedup: existing year-tagged birthday notification → skipped', async () => {
    const today = new Date();
    const birthDate = new Date(today.getFullYear() - 10, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 100, name: 'Alice', email: null, phone: null,
        birthDate, anniversary: null },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 999 });
    const result = await runContactGreetingsForTenant(1);
    expect(result).toEqual({ birthdays: 0, anniversaries: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('race-tolerance: notification.create throws → cron continues', async () => {
    const today = new Date();
    const birthDate = new Date(today.getFullYear() - 10, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 100, name: 'A', birthDate, anniversary: null },
      { id: 101, name: 'B', birthDate, anniversary: null },
    ]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error('race'))
      .mockResolvedValueOnce({ id: 5 });
    const result = await runContactGreetingsForTenant(1);
    expect(result.birthdays).toBe(1);
  });
});
