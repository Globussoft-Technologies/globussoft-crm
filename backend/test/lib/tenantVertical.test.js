import { describe, expect, test, afterEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import {
  normalizeTenantVertical,
  resolveTenantVertical,
} from '../../lib/tenantVertical.js';

const originalFindUnique = prisma.tenant.findUnique;

afterEach(() => {
  prisma.tenant.findUnique = originalFindUnique;
});

describe('tenant vertical resolution', () => {
  test('normalizes only supported verticals', () => {
    expect(normalizeTenantVertical(' WELLNESS ')).toBe('wellness');
    expect(normalizeTenantVertical('travel')).toBe('travel');
    expect(normalizeTenantVertical('other')).toBeNull();
    expect(normalizeTenantVertical(null)).toBeNull();
  });

  test('prefers the tenant row over a fallback claim', async () => {
    prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

    await expect(resolveTenantVertical(11, 'travel')).resolves.toBe('wellness');
  });

  test('uses a fallback only when the database lookup fails', async () => {
    prisma.tenant.findUnique = vi.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(resolveTenantVertical(11, 'wellness')).resolves.toBe('wellness');
  });

  test('does not use a fallback when the tenant row is missing or malformed', async () => {
    prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'unknown' });

    await expect(resolveTenantVertical(11, 'travel')).resolves.toBeNull();
  });
});
