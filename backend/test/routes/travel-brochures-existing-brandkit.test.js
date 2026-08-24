// @ts-check
/**
 * Unit tests for mergeExistingBrandKit in the travel brochures route.
 *
 * The helper fetches a saved BrandKit and layers its identity fields (logo,
 * tagline, accent colour, contacts, socials) underneath the UI's explicit edits
 * so operators can reuse a brand while keeping placement / QR / cover logos
 * fully custom.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.brandKit = prisma.brandKit || {};
prisma.brandKit.findFirst = vi.fn();

const requireCJS = (await import('node:module')).createRequire(import.meta.url);
const { mergeExistingBrandKit } = requireCJS('../../routes/travel_brochures');

function makeKit(overrides = {}) {
  return {
    id: 42,
    tenantId: 1,
    logoUrl: 'https://cdn.example.com/logo.png',
    logoDarkUrl: null,
    tagline: 'Crafted journeys',
    accentColor: '#265855',
    supportPhone: '+91 98765 43210',
    supportEmail: 'hello@sakuratrails.in',
    socialLinksJson: JSON.stringify([
      { network: 'instagram', url: 'https://instagram.com/sakuratrails' },
      { network: 'facebook', url: 'https://facebook.com/sakuratrails' },
    ]),
    ...overrides,
  };
}

describe('mergeExistingBrandKit', () => {
  beforeEach(() => {
    prisma.brandKit.findFirst.mockReset();
  });

  test('returns body unchanged and null id for missing / invalid ids', async () => {
    const body = { name: 'Agency' };
    const r1 = await mergeExistingBrandKit(body, undefined, 1);
    expect(r1.mergedBrand).toBe(body);
    expect(r1.existingBrandKitId).toBeNull();

    const r2 = await mergeExistingBrandKit(body, 'not-a-number', 1);
    expect(r2.mergedBrand).toBe(body);
    expect(r2.existingBrandKitId).toBeNull();

    const r3 = await mergeExistingBrandKit(body, 0, 1);
    expect(r3.existingBrandKitId).toBeNull();
    expect(prisma.brandKit.findFirst).not.toHaveBeenCalled();
  });

  test('returns body unchanged when kit does not exist', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(null);
    const body = { name: 'Agency' };
    const r = await mergeExistingBrandKit(body, 99, 1);
    expect(r.mergedBrand).toBe(body);
    expect(r.existingBrandKitId).toBeNull();
    expect(prisma.brandKit.findFirst).toHaveBeenCalledWith({ where: { id: 99, tenantId: 1 } });
  });

  test('merges kit identity fields while letting explicit UI edits win', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(makeKit());
    const body = {
      name: 'Override Agency',
      tagline: 'UI tagline',
      colors: { accent: '#ff0000' },
      contact: ['ui@example.com'],
      socials: ['twitter'],
      qrData: 'https://book.ui.example',
      custom: { cover: { x: 0.2, y: 0.3, scale: 0.3 } },
    };
    const { mergedBrand, existingBrandKitId } = await mergeExistingBrandKit(body, 42, 1);
    expect(existingBrandKitId).toBe(42);
    expect(mergedBrand.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(mergedBrand.name).toBe('Override Agency');
    expect(mergedBrand.tagline).toBe('UI tagline'); // UI wins
    expect(mergedBrand.colors).toEqual({ accent: '#ff0000' }); // UI wins
    expect(mergedBrand.contact).toEqual(['ui@example.com']); // UI wins
    expect(mergedBrand.socials).toEqual(['twitter']); // UI wins
    expect(mergedBrand.qrData).toBe('https://book.ui.example');
    expect(mergedBrand.custom).toEqual(body.custom);
  });

  test('falls back to dark logo when light logo is absent', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(makeKit({ logoUrl: null, logoDarkUrl: 'https://cdn.example.com/logo-dark.png' }));
    const { mergedBrand } = await mergeExistingBrandKit({}, 42, 1);
    expect(mergedBrand.logoUrl).toBe('https://cdn.example.com/logo-dark.png');
  });

  test('falls back to primaryColor when accentColor is absent', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(
      makeKit({ accentColor: null, primaryColor: '#123456' }),
    );
    const { mergedBrand } = await mergeExistingBrandKit({}, 42, 1);
    expect(mergedBrand.colors).toEqual({ accent: '#123456' });
  });

  test('ignores malformed / unusable kit fields', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(
      makeKit({
        accentColor: 'not-a-hex',
        socialLinksJson: '{broken json',
        supportPhone: '',
        supportEmail: null,
      }),
    );
    const { mergedBrand } = await mergeExistingBrandKit({}, 42, 1);
    expect(mergedBrand.colors).toBeUndefined();
    expect(mergedBrand.contact).toBeUndefined();
    expect(mergedBrand.socials).toBeUndefined();
    expect(mergedBrand.logoUrl).toBe('https://cdn.example.com/logo.png');
  });

  test('socialLinksJson objects can use "name" instead of "network"', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(
      makeKit({
        socialLinksJson: JSON.stringify([
          { name: 'linkedin', url: 'https://linkedin.com/company/sakuratrails' },
          { url: 'https://example.com' }, // no name/network
        ]),
      }),
    );
    const { mergedBrand } = await mergeExistingBrandKit({}, 42, 1);
    expect(mergedBrand.socials).toEqual(['linkedin']);
  });

  test('scopes the query to the tenant (cross-tenant ids return null)', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(null);
    const { mergedBrand, existingBrandKitId } = await mergeExistingBrandKit({ name: 'A' }, 42, 7);
    expect(existingBrandKitId).toBeNull();
    expect(mergedBrand).toEqual({ name: 'A' });
    expect(prisma.brandKit.findFirst).toHaveBeenCalledWith({ where: { id: 42, tenantId: 7 } });
  });
});
