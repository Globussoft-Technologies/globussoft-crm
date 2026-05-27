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
  runContactGreetingsForAllTravelTenants,
  isTodayMonthDay,
} from '../../cron/contactGreetingsEngine.js';

beforeAll(() => {
  prisma.contact = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads
  // tenant.subBrandConfigJson once per pass to compute the would-route
  // wabaId logged at notification create. Mock default returns null
  // config so the resolver yields {} downstream.
  prisma.tenant = { findUnique: vi.fn(), findMany: vi.fn() };
});

beforeEach(() => {
  prisma.contact.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.findMany.mockReset();

  prisma.contact.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
  prisma.tenant.findMany.mockResolvedValue([]);
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

  // ------------------------------------------------------------------
  // Extension wave (+8 cases) — coverage gaps in the original 12:
  //   - findMany query caps + select fields
  //   - tenant.findUnique pull shape (Q9 cut-over plumbing)
  //   - dedup query shape (entityType / entityId / title contains tag)
  //   - notification row defaults (type, priority) + PORTAL_BASE link
  //   - name-null fallback ("Contact #<id>")
  //   - phone+email both null → "no contact info" fallback
  //   - anniversary dedup is independent of birthday dedup
  //   - runContactGreetingsForAllTravelTenants tenant query + aggregation +
  //     per-tenant exception isolation
  // ------------------------------------------------------------------

  test('findMany request caps + select fields (take: 2000, subBrand selected)', async () => {
    await runContactGreetingsForTenant(7);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.take).toBe(2000);
    expect(arg.select).toMatchObject({
      id: true,
      name: true,
      email: true,
      phone: true,
      birthDate: true,
      anniversary: true,
      subBrand: true,
    });
  });

  test('tenant.findUnique pulls subBrandConfigJson once for the Q9 cut-over plumbing', async () => {
    const today = new Date();
    const birthDate = new Date(today.getFullYear() - 8, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 200, name: 'Eve', email: null, phone: null,
        birthDate, anniversary: null, subBrand: 'tmc' },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandConfigJson: JSON.stringify({ tmc: { wabaId: 'WABA_TMC' } }),
    });

    await runContactGreetingsForTenant(55);

    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    const tArg = prisma.tenant.findUnique.mock.calls[0][0];
    expect(tArg.where.id).toBe(55);
    expect(tArg.select.subBrandConfigJson).toBe(true);
  });

  test('dedup query shape: entityType=Contact, entityId, title contains year-tag', async () => {
    const today = new Date();
    const year = today.getFullYear();
    const birthDate = new Date(year - 4, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 301, name: 'Frank', email: null, phone: null,
        birthDate, anniversary: null },
    ]);
    await runContactGreetingsForTenant(9);

    expect(prisma.notification.findFirst).toHaveBeenCalledTimes(1);
    const findArg = prisma.notification.findFirst.mock.calls[0][0];
    expect(findArg.where.tenantId).toBe(9);
    expect(findArg.where.entityType).toBe('Contact');
    expect(findArg.where.entityId).toBe(301);
    expect(findArg.where.title.contains).toBe(`[birthday-${year}]`);
  });

  test('notification row defaults: type=info, priority=normal, PORTAL_BASE in message', async () => {
    const today = new Date();
    const birthDate = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 401, name: 'Grace', email: 'g@x.test', phone: '+91 99999 12345',
        birthDate, anniversary: null },
    ]);
    await runContactGreetingsForTenant(3);

    const createArg = prisma.notification.create.mock.calls[0][0].data;
    expect(createArg.type).toBe('info');
    expect(createArg.priority).toBe('normal');
    expect(createArg.tenantId).toBe(3);
    // PORTAL_BASE defaults to https://crm.globusdemos.com when unset in env;
    // either way the URL must reference the contact id.
    expect(createArg.message).toMatch(/\/contacts\/401/);
    expect(createArg.message).toMatch(/Grace/);
    expect(createArg.message).toMatch(/\+91 99999 12345/);
  });

  test('name-null fallback uses "Contact #<id>" in title + message', async () => {
    const today = new Date();
    const birthDate = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 555, name: null, email: 'h@x.test', phone: null,
        birthDate, anniversary: null },
    ]);
    await runContactGreetingsForTenant(1);

    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.title).toContain('Contact #555');
    expect(data.message).toContain('Contact #555');
  });

  test('phone+email both null → "no contact info" placeholder in message', async () => {
    const today = new Date();
    const anniversary = new Date(today.getFullYear() - 6, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 666, name: 'Ivan', email: null, phone: null,
        birthDate: null, anniversary },
    ]);
    await runContactGreetingsForTenant(1);

    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.message).toContain('no contact info');
    expect(data.title).toContain('Anniversary today: Ivan');
  });

  test('anniversary dedup is independent of birthday dedup (same contact, both hit, only birthday pre-existing)', async () => {
    const today = new Date();
    const year = today.getFullYear();
    const d = new Date(year - 2, today.getMonth(), today.getDate());
    prisma.contact.findMany.mockResolvedValue([
      { id: 700, name: 'Jane', email: null, phone: null,
        birthDate: d, anniversary: d },
    ]);
    // First call (birthday lookup) → pre-existing; second (anniversary) → null.
    prisma.notification.findFirst
      .mockResolvedValueOnce({ id: 9001 })
      .mockResolvedValueOnce(null);

    const result = await runContactGreetingsForTenant(1);

    expect(result).toEqual({ birthdays: 0, anniversaries: 1 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create.mock.calls[0][0].data.title).toContain(`anniv-${year}`);
  });

  test('runContactGreetingsForAllTravelTenants: iterates travel-only tenants + aggregates + isolates per-tenant errors', async () => {
    const today = new Date();
    const birthDate = new Date(today.getFullYear() - 9, today.getMonth(), today.getDate());

    prisma.tenant.findMany.mockResolvedValue([
      { id: 11, slug: 'tenant-a' },
      { id: 12, slug: 'tenant-b' },
      { id: 13, slug: 'tenant-c' },
    ]);
    // Tenant 11: 1 birthday hit.
    // Tenant 12: contact.findMany throws → per-tenant catch isolates.
    // Tenant 13: 1 birthday hit.
    prisma.contact.findMany
      .mockResolvedValueOnce([
        { id: 800, name: 'K', email: null, phone: null, birthDate, anniversary: null },
      ])
      .mockRejectedValueOnce(new Error('tenant 12 boom'))
      .mockResolvedValueOnce([
        { id: 801, name: 'L', email: null, phone: null, birthDate, anniversary: null },
      ]);

    const result = await runContactGreetingsForAllTravelTenants();

    // Tenants query gates on travel + active.
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    const tArg = prisma.tenant.findMany.mock.calls[0][0];
    expect(tArg.where.vertical).toBe('travel');
    expect(tArg.where.isActive).toBe(true);

    // Aggregated counts across surviving tenants (11 + 13 only).
    expect(result).toEqual({ birthdays: 2, anniversaries: 0 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });
});
