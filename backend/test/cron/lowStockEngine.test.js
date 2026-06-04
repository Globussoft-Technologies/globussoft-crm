// @ts-check
/**
 * Unit tests for backend/cron/lowStockEngine.js — Low-stock alert engine that
 * runs daily 09:00 IST. Per wellness tenant:
 *   - Finds Products where threshold > 0 AND currentStock <= threshold.
 *   - Creates a Notification row for every MANAGER+ user in the tenant.
 *   - Queues an email to tenant.ownerEmail (status not specified in code —
 *     a plain emailMessage row with direction='OUTBOUND').
 *
 * Idempotent within 24h: a Notification's `link` field encodes the productId,
 * so before alerting we check for any existing low-stock notification on that
 * product within the last 24h. If found → skip (already alerted).
 *
 * Why this file exists (regression class — Wave 5 Agent XX cron coverage gap):
 *   - Engine has zero existing vitest unit coverage. Awkward branches:
 *       - Threshold filter: products with threshold=0 are "not tracked" and
 *         must NOT alert even when stock is 0 (prisma WHERE clause excludes them).
 *       - Boundary: currentStock == threshold IS a breach (uses <=, not <).
 *       - 24h dedup gate: re-alerting a product within 24h is silently skipped
 *         even if stock dropped further. Bug here = notification spam.
 *       - Vertical scope: engine ONLY runs for vertical='wellness' AND
 *         isActive=true tenants. Generic tenants must never receive low-stock.
 *       - RBAC scope: notifications go to MANAGER+ADMIN only — USERs do not
 *         receive low-stock alerts (no inventory authority).
 *       - Tenant.ownerEmail null → email step skipped, notifications still fire.
 *       - Per-tenant error containment: one tenant throwing does NOT abort
 *         siblings in runLowStockForAllWellnessTenants.
 *
 * Functions / branches covered:
 *   - alreadyAlertedRecently (NOT exported; tested indirectly via dedup branch)
 *   - runLowStockForTenant
 *       Happy path: low product → notification.createMany (one per MANAGER+ADMIN)
 *         + emailMessage.create (one for tenant.ownerEmail).
 *       Multiple low products: all alerted; counts aggregate.
 *       No low products → no notifications, no emails, returns zeros.
 *       Threshold filter: prisma WHERE excludes threshold=0.
 *       Boundary: currentStock == threshold → IS a breach (lowProducts filter
 *         uses <=).
 *       24h dedup: alreadyAlertedRecently true → product skipped, no
 *         notification, no email.
 *       Recipients query: where.role IN [MANAGER, ADMIN] within tenant.
 *       Recipients empty: no createMany call (notifs=0); email still sent if
 *         ownerEmail present.
 *       Tenant.ownerEmail null: emailMessage.create NOT called, but
 *         notifications still fire.
 *       Notification link encodes productId for dedup keying.
 *   - runLowStockForAllWellnessTenants
 *       Filters tenant.findMany WHERE: vertical='wellness' + isActive=true.
 *       Per-tenant error containment: one tenant throws → siblings still run.
 *       Aggregates per-tenant results into an array.
 *
 * NOT covered (intentional):
 *   - initLowStockCron: schedule shell (cron.schedule call). No behavioural
 *     coverage beyond "we registered a cron".
 *
 * Mocking strategy:
 *   Standard prisma-singleton monkey-patch. SUT module inlined via vitest.config.js.
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runLowStockForTenant,
  runLowStockForAllWellnessTenants,
} from '../../cron/lowStockEngine.js';

beforeAll(() => {
  prisma.product = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), createMany: vi.fn() };
  prisma.user = { findMany: vi.fn() };
  prisma.emailMessage = { create: vi.fn() };
  prisma.tenant = { findMany: vi.fn() };
  // Engine now reads per-tenant alert roles via lib/tenantSettings.getSetting,
  // which queries the prisma singleton's tenantSetting model. Stub it so the
  // lookup resolves; a null row makes getSetting fall back to the DEFAULTS
  // value (JSON ["MANAGER","ADMIN"]).
  prisma.tenantSetting = { findUnique: vi.fn() };
  // Engine now wraps the dedup-check + notification insert in a $transaction.
  // The callback receives a tx client; reuse the stubbed prisma singleton.
  prisma.$transaction = vi.fn(async (arg) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
  );
});

beforeEach(() => {
  prisma.product.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.createMany.mockReset();
  prisma.user.findMany.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.tenant.findMany.mockReset();
  prisma.tenantSetting.findUnique.mockReset();

  prisma.product.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);  // no prior alert
  prisma.notification.createMany.mockResolvedValue({ count: 0 });
  prisma.user.findMany.mockResolvedValue([]);
  prisma.emailMessage.create.mockResolvedValue({});
  prisma.tenant.findMany.mockResolvedValue([]);
  prisma.tenantSetting.findUnique.mockResolvedValue(null); // fall back to DEFAULTS
});

const TENANT = {
  id: 'tenant-W',
  slug: 'enhanced-wellness',
  ownerEmail: 'rishu@enhancedwellness.in',
};

function product({ id, name = 'Botox 100u', sku = 'BTX-100', currentStock, threshold }) {
  return { id, name, sku, currentStock, threshold };
}

function manager({ id }) {
  return { id };
}

// ─── Threshold + product query shape ────────────────────────────────────────

describe('cron/lowStockEngine — product query shape', () => {
  test('queries product.findMany once per tenant with tenantId + threshold>0', async () => {
    await runLowStockForTenant(TENANT);
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.product.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe('tenant-W');
    expect(arg.where.threshold).toEqual({ gt: 0 });
  });

  test('select pins the exact column set (id, name, sku, currentStock, threshold)', async () => {
    await runLowStockForTenant(TENANT);
    const arg = prisma.product.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({
      id: true,
      name: true,
      sku: true,
      currentStock: true,
      threshold: true,
    });
  });

  test('threshold=0 products are filtered at DB layer (gt:0 in WHERE) — "not tracked" semantics', async () => {
    await runLowStockForTenant(TENANT);
    const arg = prisma.product.findMany.mock.calls[0][0];
    // The WHERE filters threshold:{gt:0}. Even if a 0-threshold row sneaked
    // through the DB layer, the lowProducts filter uses <=, so threshold=0 +
    // currentStock=0 would technically match 0<=0, but the DB-level filter
    // prevents that scenario reaching this code.
    expect(arg.where.threshold).toEqual({ gt: 0 });
  });
});

// ─── Happy path: stock breach detected ──────────────────────────────────────

describe('cron/lowStockEngine — happy path', () => {
  test('low product + recipients + ownerEmail → notification.createMany + emailMessage.create both fire', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 2, threshold: 10 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([
      manager({ id: 'u1' }),
      manager({ id: 'u2' }),
    ]);

    const res = await runLowStockForTenant(TENANT);

    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ products: 1, notifications: 2, emails: 1 });
  });

  test('notification rows are scoped per recipient (one per MANAGER+ADMIN user)', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 5, currentStock: 0, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([
      manager({ id: 'admin-1' }),
      manager({ id: 'manager-1' }),
      manager({ id: 'manager-2' }),
    ]);

    await runLowStockForTenant(TENANT);

    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(3);
    const userIds = arg.data.map((n) => n.userId).sort();
    expect(userIds).toEqual(['admin-1', 'manager-1', 'manager-2']);
    // All scoped to same tenant
    arg.data.forEach((n) => {
      expect(n.tenantId).toBe('tenant-W');
    });
  });

  test('notification link encodes productId (dedup key for 24h gate)', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 999, currentStock: 1, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    await runLowStockForTenant(TENANT);

    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data[0].link).toBe('/inventory/low-stock?productId=999');
  });

  test('notification type is "warning"', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 0, threshold: 1 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    await runLowStockForTenant(TENANT);

    expect(prisma.notification.createMany.mock.calls[0][0].data[0].type).toBe('warning');
  });

  test('notification title + message include product name + SKU + current stock + threshold', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, name: 'Restylane Lyft', sku: 'RLY-1ML', currentStock: 3, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    await runLowStockForTenant(TENANT);

    const notif = prisma.notification.createMany.mock.calls[0][0].data[0];
    expect(notif.title).toBe('Low stock: Restylane Lyft');
    expect(notif.message).toContain('Restylane Lyft');
    expect(notif.message).toContain('SKU RLY-1ML');
    expect(notif.message).toContain('3');
    expect(notif.message).toContain('5');
  });

  test('SKU-less product → message omits the (SKU ...) clause cleanly', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, name: 'Plain product', sku: null, currentStock: 2, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    await runLowStockForTenant(TENANT);

    const notif = prisma.notification.createMany.mock.calls[0][0].data[0];
    // The "(SKU ...)" parenthetical is omitted. The message still contains
    // "(threshold 5)" — that's a different parenthetical we don't pin here.
    expect(notif.message).not.toContain('SKU');
    expect(notif.message).not.toMatch(/\(SKU/);
  });

  test('email body includes threshold + currentStock + branding signature', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, name: 'Botox', currentStock: 1, threshold: 3 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    await runLowStockForTenant(TENANT);

    const emailArg = prisma.emailMessage.create.mock.calls[0][0];
    expect(emailArg.data.to).toBe('rishu@enhancedwellness.in');
    expect(emailArg.data.direction).toBe('OUTBOUND');
    expect(emailArg.data.subject).toContain('Low stock alert');
    expect(emailArg.data.subject).toContain('Botox');
    expect(emailArg.data.body).toContain('Threshold: 3');
    expect(emailArg.data.body).toContain('Current stock: 1');
    expect(emailArg.data.body).toContain('Globussoft CRM');
    expect(emailArg.data.tenantId).toBe('tenant-W');
  });
});

// ─── Boundary math: currentStock <= threshold ────────────────────────────────

describe('cron/lowStockEngine — boundary math (currentStock vs threshold)', () => {
  test('currentStock == threshold → IS a breach (engine uses <=, not <)', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 5, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const res = await runLowStockForTenant(TENANT);

    expect(res.products).toBe(1);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  test('currentStock > threshold → NOT a breach', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 10, threshold: 5 }),
    ]);

    const res = await runLowStockForTenant(TENANT);

    expect(res.products).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  test('currentStock=0 + threshold>0 → IS a breach (the most extreme case)', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 0, threshold: 1 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const res = await runLowStockForTenant(TENANT);

    expect(res.products).toBe(1);
  });

  test('mixed list: some breach, some safe → only breaching ones alerted', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 100, threshold: 10 }), // safe
      product({ id: 2, currentStock: 1, threshold: 5 }),     // breach
      product({ id: 3, currentStock: 50, threshold: 50 }),   // breach (==)
      product({ id: 4, currentStock: 999, threshold: 1 }),   // safe
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const res = await runLowStockForTenant(TENANT);

    expect(res.products).toBe(2);
    // Two notifications, ONE per breach (one user)
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(2);
  });
});

// ─── 24h dedup gate ─────────────────────────────────────────────────────────

describe('cron/lowStockEngine — 24h dedup gate', () => {
  test('alreadyAlertedRecently=true → product skipped (no notification, no email)', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 1, threshold: 5 }),
    ]);
    // Simulate prior notification within 24h
    prisma.notification.findFirst.mockResolvedValueOnce({ id: 'prior-notif' });
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const res = await runLowStockForTenant(TENANT);

    expect(res.products).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  test('dedup query keys on tenantId + link (productId-encoded) + 24h gte cutoff', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 42, currentStock: 1, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const before = Date.now();
    await runLowStockForTenant(TENANT);

    expect(prisma.notification.findFirst).toHaveBeenCalledTimes(1);
    const arg = prisma.notification.findFirst.mock.calls[0][0];
    expect(arg.where.tenantId).toBe('tenant-W');
    expect(arg.where.link).toBe('/inventory/low-stock?productId=42');
    expect(arg.where.createdAt).toHaveProperty('gte');
    const gte = arg.where.createdAt.gte.getTime();
    // Window is 24h ago — should be within ~24h ± a few seconds.
    const expected = before - 24 * 3600 * 1000;
    expect(gte).toBeGreaterThanOrEqual(expected - 100);
    expect(gte).toBeLessThanOrEqual(expected + 100);
  });

  test('mixed dedup: 2 products, 1 already-alerted → only the other is alerted', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 1, threshold: 5 }),
      product({ id: 2, currentStock: 0, threshold: 5 }),
    ]);
    // First product already alerted; second is fresh
    prisma.notification.findFirst
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce(null);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const res = await runLowStockForTenant(TENANT);

    expect(res.products).toBe(1);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
  });
});

// ─── Recipient handling ─────────────────────────────────────────────────────

describe('cron/lowStockEngine — recipient handling', () => {
  test('recipients query scopes to MANAGER+ADMIN within tenant', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 1, threshold: 5 }),
    ]);

    await runLowStockForTenant(TENANT);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe('tenant-W');
    expect(arg.where.role).toEqual({ in: ['MANAGER', 'ADMIN'] });
    expect(arg.select).toEqual({ id: true });
  });

  test('zero recipients → notifications skipped (notifs=0), email still fires if ownerEmail set', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 1, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([]); // no managers/admins

    const res = await runLowStockForTenant(TENANT);

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ products: 1, notifications: 0, emails: 1 });
  });

  test('plain USER role users do NOT receive low-stock notifications', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 1, threshold: 5 }),
    ]);

    await runLowStockForTenant(TENANT);

    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.role.in).not.toContain('USER');
  });
});

// ─── Tenant.ownerEmail handling ─────────────────────────────────────────────

describe('cron/lowStockEngine — ownerEmail handling', () => {
  test('null ownerEmail → emailMessage.create NOT called; notifications still fire', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 1, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const tenantNoEmail = { id: 'tenant-W', slug: 'w', ownerEmail: null };
    const res = await runLowStockForTenant(tenantNoEmail);

    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(res.emails).toBe(0);
    expect(res.notifications).toBe(1);
  });

  test('undefined ownerEmail (key absent) → emailMessage.create NOT called', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 1, threshold: 5 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const tenantNoEmail = { id: 'tenant-W', slug: 'w' /* no ownerEmail key */ };
    const res = await runLowStockForTenant(tenantNoEmail);

    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(res.emails).toBe(0);
  });
});

// ─── Empty product set ──────────────────────────────────────────────────────

describe('cron/lowStockEngine — no breaches', () => {
  test('no products at all → returns zeros, no DB writes', async () => {
    prisma.product.findMany.mockResolvedValueOnce([]);

    const res = await runLowStockForTenant(TENANT);

    expect(res).toEqual({ products: 0, notifications: 0, emails: 0 });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    // user.findMany also short-circuits — only called if there's at least one
    // low product.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('all products safely above threshold → returns zeros', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      product({ id: 1, currentStock: 100, threshold: 5 }),
      product({ id: 2, currentStock: 50, threshold: 5 }),
    ]);

    const res = await runLowStockForTenant(TENANT);

    expect(res).toEqual({ products: 0, notifications: 0, emails: 0 });
  });
});

// ─── runLowStockForAllWellnessTenants orchestrator ──────────────────────────

describe('cron/lowStockEngine — orchestrator (runLowStockForAllWellnessTenants)', () => {
  test('queries tenants with vertical=wellness + isActive=true', async () => {
    await runLowStockForAllWellnessTenants();

    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ vertical: 'wellness', isActive: true });
    expect(arg.select).toEqual({ id: true, slug: true, ownerEmail: true });
  });

  test('zero tenants → returns empty array, no further DB calls', async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([]);

    const res = await runLowStockForAllWellnessTenants();

    expect(res).toEqual([]);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  test('multiple tenants → each processed; aggregated array returned', async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([
      { id: 'tA', slug: 'wellness-a', ownerEmail: 'a@x.com' },
      { id: 'tB', slug: 'wellness-b', ownerEmail: 'b@x.com' },
    ]);
    // Tenant A: 1 low product. Tenant B: 0 low products.
    prisma.product.findMany
      .mockResolvedValueOnce([product({ id: 1, currentStock: 1, threshold: 5 })])
      .mockResolvedValueOnce([]);
    prisma.user.findMany.mockResolvedValueOnce([manager({ id: 'u1' })]);

    const res = await runLowStockForAllWellnessTenants();

    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ tenant: 'wellness-a', products: 1 });
    expect(res[1]).toMatchObject({ tenant: 'wellness-b', products: 0 });
  });

  test('per-tenant error containment: one tenant throws → siblings still run; error captured in result row', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.tenant.findMany.mockResolvedValueOnce([
      { id: 'tA', slug: 'wellness-a', ownerEmail: null },
      { id: 'tB', slug: 'wellness-b', ownerEmail: 'b@x.com' },
    ]);
    // Tenant A throws on product.findMany
    prisma.product.findMany
      .mockRejectedValueOnce(new Error('DB unavailable'))
      .mockResolvedValueOnce([]);

    const res = await runLowStockForAllWellnessTenants();

    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ tenant: 'wellness-a', error: 'DB unavailable' });
    expect(res[1]).toMatchObject({ tenant: 'wellness-b', products: 0 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('orchestrator filters out generic-vertical tenants at WHERE level', async () => {
    await runLowStockForAllWellnessTenants();
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where.vertical).toBe('wellness');
    expect(arg.where.vertical).not.toBe('generic');
  });
});
