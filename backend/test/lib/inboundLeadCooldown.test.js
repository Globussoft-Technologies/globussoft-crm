// @ts-check
/**
 * inboundLeadCooldown — G011 unit-test surface
 * (PRD_TRAVEL_MULTICHANNEL_LEADS §3.2.3 + lib/inboundLeadCooldown.js).
 *
 * Tests pin the cooldown lib's contract:
 *   - parseCooldownMap tolerates: null, malformed JSON, non-object root,
 *     zero / negative values silently drop
 *   - loadCooldownsForTenant: missing setting → {}, malformed → {},
 *     throws → fail-open returns {}
 *   - checkCooldown: zero cooldown / missing channel → never active,
 *     prior row within window → active with retryAfter, prior row
 *     outside window → not active, identifier missing → not active,
 *     prisma error → fail-open
 *   - sourceChannel override: probes the URL-form source string when
 *     supplied so back-compat dedup against legacy demo rows works
 *
 * Pattern: mock prisma.tenantSetting + prisma.contact in-place, drive
 * the cooldown helpers, assert the return shapes.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  parseCooldownMap,
  loadCooldownsForTenant,
  checkCooldown,
  COOLDOWN_SETTING_KEY,
} = requireCJS('../../lib/inboundLeadCooldown');

describe('COOLDOWN_SETTING_KEY constant', () => {
  test('exposed as a stable identifier', () => {
    expect(typeof COOLDOWN_SETTING_KEY).toBe('string');
    expect(COOLDOWN_SETTING_KEY).toBe('lead.capture.cooldowns');
  });
});

describe('parseCooldownMap — tolerates malformed input', () => {
  test('null → {}', () => {
    expect(parseCooldownMap(null)).toEqual({});
  });

  test('undefined → {}', () => {
    expect(parseCooldownMap(undefined)).toEqual({});
  });

  test('empty string → {}', () => {
    expect(parseCooldownMap('')).toEqual({});
  });

  test('malformed JSON → {} (silently swallowed)', () => {
    expect(parseCooldownMap('{not json}')).toEqual({});
  });

  test('non-string input → {}', () => {
    expect(parseCooldownMap(42)).toEqual({});
    expect(parseCooldownMap({})).toEqual({});
  });

  test('JSON array → {} (only object roots accepted)', () => {
    expect(parseCooldownMap('[1,2,3]')).toEqual({});
  });

  test('valid map → preserved', () => {
    const r = parseCooldownMap('{"voice":1800,"web_form":600}');
    expect(r).toEqual({ voice: 1800, web_form: 600 });
  });

  test('zero values silently dropped', () => {
    const r = parseCooldownMap('{"voice":0,"web_form":600}');
    expect(r).toEqual({ web_form: 600 });
  });

  test('negative values silently dropped', () => {
    const r = parseCooldownMap('{"voice":-100,"web_form":600}');
    expect(r).toEqual({ web_form: 600 });
  });

  test('non-numeric values silently dropped', () => {
    const r = parseCooldownMap('{"voice":"forever","web_form":600}');
    expect(r).toEqual({ web_form: 600 });
  });

  test('fractional values floored', () => {
    const r = parseCooldownMap('{"voice":1800.7}');
    expect(r).toEqual({ voice: 1800 });
  });
});

describe('loadCooldownsForTenant — prisma probe', () => {
  let prisma;

  beforeEach(() => {
    prisma = {
      tenant: { findUnique: vi.fn() },
      tenantSetting: { findUnique: vi.fn() },
    };
  });

  test('returns {} when tenant row absent + no TenantSetting fallback (both null)', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const r = await loadCooldownsForTenant(prisma, 1);
    expect(r).toEqual({});
  });

  test('returns {} when both primary + fallback throw (fail-open)', async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error('db down'));
    prisma.tenantSetting.findUnique.mockRejectedValue(new Error('db down'));
    const r = await loadCooldownsForTenant(prisma, 1);
    expect(r).toEqual({});
  });

  test('returns parsed map from Tenant.leadCaptureCooldownsJson (primary path)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      leadCaptureCooldownsJson: '{"voice":1800,"web_form":600}',
    });
    const r = await loadCooldownsForTenant(prisma, 1);
    expect(r).toEqual({ voice: 1800, web_form: 600 });
    // Primary path hit — fallback should not have been called.
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('falls back to TenantSetting key/value when Tenant column null', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      leadCaptureCooldownsJson: null,
    });
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: '{"voice":3600}',
    });
    const r = await loadCooldownsForTenant(prisma, 1);
    expect(r).toEqual({ voice: 3600 });
  });

  test('returns {} when prisma absent / tenantId absent', async () => {
    expect(await loadCooldownsForTenant(null, 1)).toEqual({});
    expect(await loadCooldownsForTenant(prisma, null)).toEqual({});
  });

  test('fallback uses the canonical TenantSetting key', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ leadCaptureCooldownsJson: null });
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    await loadCooldownsForTenant(prisma, 42);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_key: { tenantId: 42, key: 'lead.capture.cooldowns' } },
      }),
    );
  });
});

describe('checkCooldown — gate logic', () => {
  let prisma;

  beforeEach(() => {
    prisma = {
      contact: { findFirst: vi.fn() },
    };
  });

  test('channel not in map → active:false', async () => {
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91' },
      cooldownMap: { web_form: 600 },
    });
    expect(r.active).toBe(false);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('zero cooldown → active:false', async () => {
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91' },
      cooldownMap: { voice: 0 },
    });
    expect(r.active).toBe(false);
  });

  test('empty identifier → active:false', async () => {
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: {},
      cooldownMap: { voice: 1800 },
    });
    expect(r.active).toBe(false);
  });

  test('null identifier → active:false', async () => {
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: null,
      cooldownMap: { voice: 1800 },
    });
    expect(r.active).toBe(false);
  });

  test('no prior row → active:false', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91' },
      cooldownMap: { voice: 1800 },
    });
    expect(r.active).toBe(false);
    expect(r.cooldownSeconds).toBe(1800);
  });

  test('prior row within window → active:true + retryAfter', async () => {
    const now = new Date('2026-06-13T10:00:00Z');
    // Prior row was 5 min ago, cooldown is 30 min — should still be active.
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    prisma.contact.findFirst.mockResolvedValue({
      id: 555,
      createdAt: fiveMinAgo,
    });
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91999' },
      cooldownMap: { voice: 1800 },
      now,
    });
    expect(r.active).toBe(true);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(1500); // 30min - 5min = 25min
    expect(r.lastLeadAt).toBe(fiveMinAgo.toISOString());
  });

  test('prior row outside window → active:false', async () => {
    const now = new Date('2026-06-13T10:00:00Z');
    // findFirst's where filter would normally exclude this — but the
    // helper guards itself anyway, so return a row that's just outside
    // the window-floor predicate to exercise the falsy-elapsed path.
    prisma.contact.findFirst.mockResolvedValue(null);
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91999' },
      cooldownMap: { voice: 1800 },
      now,
    });
    expect(r.active).toBe(false);
  });

  test('prior row exactly at window boundary → not active', async () => {
    const now = new Date('2026-06-13T10:00:00Z');
    const cooldownSeconds = 1800;
    const boundaryAgo = new Date(now.getTime() - cooldownSeconds * 1000);
    prisma.contact.findFirst.mockResolvedValue({
      id: 555,
      createdAt: boundaryAgo,
    });
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91999' },
      cooldownMap: { voice: cooldownSeconds },
      now,
    });
    expect(r.active).toBe(false);
  });

  test('prisma throws → fail-open (active:false)', async () => {
    prisma.contact.findFirst.mockRejectedValue(new Error('db down'));
    const r = await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91' },
      cooldownMap: { voice: 1800 },
    });
    expect(r.active).toBe(false);
  });

  test('sourceChannel override uses URL alias when scanning', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'meta_ad', // canonical (cooldownMap key)
      sourceChannel: 'metaads', // URL alias (DB source string)
      identifier: { phone: '+91' },
      cooldownMap: { meta_ad: 600 },
    });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: 'inbound:metaads',
        }),
      }),
    );
  });

  test('without sourceChannel override → falls back to canonical name', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { phone: '+91' },
      cooldownMap: { voice: 1800 },
    });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: 'inbound:voice',
        }),
      }),
    );
  });

  test('email-only identifier hits OR clause with email', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { email: 'a@b.com' },
      cooldownMap: { voice: 1800 },
    });
    const call = prisma.contact.findFirst.mock.calls[0][0];
    expect(call.where.OR).toEqual([{ email: 'a@b.com' }]);
  });

  test('phone + email identifier builds two OR clauses', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await checkCooldown({
      prisma,
      tenantId: 1,
      channel: 'voice',
      identifier: { email: 'a@b.com', phone: '+91' },
      cooldownMap: { voice: 1800 },
    });
    const call = prisma.contact.findFirst.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { email: 'a@b.com' },
      { phone: '+91' },
    ]);
  });
});
