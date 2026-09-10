// @ts-check

import { afterEach, describe, expect, test, vi } from 'vitest';

import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const lib = requireCJS('../../lib/landingFormConfig');

const ENV_KEYS = ['LANDING_FORM_ADMIN_EMAILS', 'PUBLIC_LEAD_TENANT_ID'];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('getLandingFormAdminEmails / isLandingFormAdminEmail', () => {
  test('empty env → nobody is admin (fail closed)', () => {
    delete process.env.LANDING_FORM_ADMIN_EMAILS;
    expect(lib.getLandingFormAdminEmails().size).toBe(0);
    expect(lib.isLandingFormAdminEmail('owner@example.com')).toBe(false);
  });

  test('parses comma-separated list, trims + lowercases', () => {
    process.env.LANDING_FORM_ADMIN_EMAILS = ' Owner@Example.com ,admin@example.com,, ';
    expect(lib.getLandingFormAdminEmails().has('owner@example.com')).toBe(true);
    expect(lib.isLandingFormAdminEmail('OWNER@example.com')).toBe(true);
    expect(lib.isLandingFormAdminEmail('  admin@EXAMPLE.com  ')).toBe(true);
    expect(lib.isLandingFormAdminEmail('stranger@example.com')).toBe(false);
  });

  test('blank / null email never matches', () => {
    process.env.LANDING_FORM_ADMIN_EMAILS = 'owner@example.com';
    expect(lib.isLandingFormAdminEmail('')).toBe(false);
    expect(lib.isLandingFormAdminEmail(null)).toBe(false);
    expect(lib.isLandingFormAdminEmail(undefined)).toBe(false);
  });
});

describe('resolvePublicLeadTenantId', () => {
  test('unset / garbage → null', () => {
    delete process.env.PUBLIC_LEAD_TENANT_ID;
    expect(lib.resolvePublicLeadTenantId()).toBeNull();
    process.env.PUBLIC_LEAD_TENANT_ID = 'abc';
    expect(lib.resolvePublicLeadTenantId()).toBeNull();
    process.env.PUBLIC_LEAD_TENANT_ID = '0';
    expect(lib.resolvePublicLeadTenantId()).toBeNull();
  });

  test('valid int string → int', () => {
    process.env.PUBLIC_LEAD_TENANT_ID = '7';
    expect(lib.resolvePublicLeadTenantId()).toBe(7);
  });
});

describe('isSelectableLandingForm', () => {
  test('requires same tenant + active + generic scope', () => {
    expect(lib.isSelectableLandingForm(null, 1)).toBe(false);
    expect(
      lib.isSelectableLandingForm({ tenantId: 1, isActive: true, scope: 'generic' }, 1),
    ).toBe(true);
    expect(
      lib.isSelectableLandingForm({ tenantId: 2, isActive: true, scope: 'generic' }, 1),
    ).toBe(false);
    expect(
      lib.isSelectableLandingForm({ tenantId: 1, isActive: false, scope: 'generic' }, 1),
    ).toBe(false);
    expect(
      lib.isSelectableLandingForm({ tenantId: 1, isActive: true, scope: 'travel' }, 1),
    ).toBe(false);
  });
});

describe('resolveLandingWebFormId', () => {
  function mockPrisma({ setting = null, stored = null, bySlug = null, latest = null } = {}) {
    return {
      tenantSetting: {
        findUnique: vi.fn().mockResolvedValue(setting ? { value: setting } : null),
      },
      webForm: {
        findFirst: vi.fn().mockImplementation(async (args) => {
          if (args.where && args.where.id !== undefined) return stored;
          if (args.where && args.where.slug) return bySlug;
          return latest;
        }),
      },
    };
  }

  test('valid stored setting wins', async () => {
    const prisma = mockPrisma({
      setting: JSON.stringify({ webFormId: 9 }),
      stored: { id: 9, tenantId: 1, isActive: true, scope: 'generic' },
    });
    await expect(lib.resolveLandingWebFormId(prisma, 1)).resolves.toBe(9);
  });

  test('plain-int legacy setting value also parses', async () => {
    const prisma = mockPrisma({
      setting: '9',
      stored: { id: 9, tenantId: 1, isActive: true, scope: 'generic' },
    });
    await expect(lib.resolveLandingWebFormId(prisma, 1)).resolves.toBe(9);
  });

  test('stored form from another tenant falls back to slug', async () => {
    const prisma = mockPrisma({
      setting: JSON.stringify({ webFormId: 9 }),
      stored: { id: 9, tenantId: 2, isActive: true, scope: 'generic' },
      bySlug: { id: 3, tenantId: 1, isActive: true, scope: 'generic' },
    });
    await expect(lib.resolveLandingWebFormId(prisma, 1)).resolves.toBe(3);
  });

  test('no setting + no slug → latest active generic form', async () => {
    const prisma = mockPrisma({ latest: { id: 5 } });
    await expect(lib.resolveLandingWebFormId(prisma, 1)).resolves.toBe(5);
  });

  test('nothing selectable → null', async () => {
    const prisma = mockPrisma({});
    await expect(lib.resolveLandingWebFormId(prisma, 1)).resolves.toBeNull();
  });
});
