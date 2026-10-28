import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  integration: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};

import {
  getGoogleMapsConfig,
  resolveGoogleMapsApiKey,
  saveGoogleMapsConfig,
  toPublicGoogleMapsConfig,
} from '../../lib/googleMapsConfig';

describe('googleMapsConfig', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prisma.integration.findUnique.mockReset();
    prisma.integration.upsert.mockReset();
  });

  it('uses an active tenant key without exposing it in the public projection', async () => {
    prisma.integration.findUnique.mockResolvedValue({
      id: 9, token: 'AIzaTenantSecret1234567890', isActive: true, updatedAt: new Date('2026-10-23T10:00:00Z'),
    });
    const config = await getGoogleMapsConfig(4, prisma);
    expect(config.effectiveKey).toBe('AIzaTenantSecret1234567890');
    expect(toPublicGoogleMapsConfig(config)).toMatchObject({
      enabled: true, configured: true, source: 'tenant', last4: '****7890',
    });
    expect(JSON.stringify(toPublicGoogleMapsConfig(config))).not.toContain('TenantSecret');
  });

  it('has no configured key when the organization has not saved one', async () => {
    prisma.integration.findUnique.mockResolvedValue(null);
    await expect(resolveGoogleMapsApiKey(4, prisma)).resolves.toBeNull();
  });

  it('does not use a saved organization key while suggestions are disabled', async () => {
    prisma.integration.findUnique.mockResolvedValue({ id: 9, token: 'AIzaTenantSecret1234567890', isActive: false });
    await expect(resolveGoogleMapsApiKey(4, prisma)).resolves.toBeNull();
  });

  it('requires a key on the first save and preserves an existing key on toggle-only saves', async () => {
    prisma.integration.findUnique.mockResolvedValueOnce(null);
    await expect(saveGoogleMapsConfig(4, { enabled: false }, prisma)).rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });

    const existing = { id: 9, token: 'AIzaExistingSecret1234567890', isActive: true, updatedAt: new Date() };
    prisma.integration.findUnique.mockResolvedValue(existing);
    prisma.integration.upsert.mockResolvedValue({ ...existing, isActive: false });
    const saved = await saveGoogleMapsConfig(4, { enabled: false }, prisma);
    expect(prisma.integration.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ token: existing.token, isActive: false }),
    }));
    expect(saved.enabled).toBe(false);
  });
});
