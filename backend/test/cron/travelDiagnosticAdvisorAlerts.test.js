/**
 * Unit tests for backend/cron/travelDiagnosticAdvisorAlerts.js — diagnostic-
 * to-advisor escalation cron. Mirrors the tripPaymentReminders.test.js
 * pattern.
 *
 * Branches covered:
 *   runDiagnosticAlertsForTenant:
 *     - query shape: tenant + contactId not null + 30m..24h window
 *     - empty fast-path: 0 diagnostics → skip outreach probe
 *     - happy path: 1 stalled diagnostic, no outreach → escalation notification created
 *     - dedup: existing escalation notification → skipped
 *     - outreach via Activity: skipped (no escalation)
 *     - outreach via Task: skipped
 *     - missing models (Activity/Task throws) → treated as no-outreach,
 *       diagnostic still escalates
 *     - race-tolerance: notification.create throws → cron continues
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runDiagnosticAlertsForTenant,
  runDiagnosticAlertsForAllTravelTenants,
} from '../../cron/travelDiagnosticAdvisorAlerts.js';

beforeAll(() => {
  prisma.travelDiagnostic = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  prisma.activity = { findFirst: vi.fn() };
  prisma.task = { findFirst: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads tenant
  // .subBrandConfigJson once per pass to compute the would-route wabaId
  // logged at escalation time.
  prisma.tenant = { findUnique: vi.fn() };
});

beforeEach(() => {
  prisma.travelDiagnostic.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.activity.findFirst.mockReset();
  prisma.task.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();

  prisma.travelDiagnostic.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.activity.findFirst.mockResolvedValue(null);
  prisma.task.findFirst.mockResolvedValue(null);
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
});

describe('cron/travelDiagnosticAdvisorAlerts — runDiagnosticAlertsForTenant', () => {
  test('query shape: tenant + contactId not null + createdAt window', async () => {
    await runDiagnosticAlertsForTenant(42);
    const arg = prisma.travelDiagnostic.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.contactId).toEqual({ not: null });
    expect(arg.where.createdAt).toHaveProperty('gte');
    expect(arg.where.createdAt).toHaveProperty('lte');
    expect(arg.where.createdAt.gte.getTime()).toBeLessThan(arg.where.createdAt.lte.getTime());
  });

  test('empty diagnostics → 0/0, no outreach probe', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([]);
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 0 });
    expect(prisma.activity.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('happy path: 1 stalled diagnostic with no outreach → notification created', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      {
        id: 100, subBrand: 'rfu', contactId: 200,
        classificationLabel: 'Confident', recommendedTier: 'primary',
        createdAt: halfHourAgo,
      },
    ]);

    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 1, skipped: 0 });
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(1);
    expect(createArg.data.entityType).toBe('TravelDiagnostic');
    expect(createArg.data.entityId).toBe(100);
    expect(createArg.data.type).toBe('warning');
    expect(createArg.data.priority).toBe('high');
  });

  test('dedup: existing warning notification → skipped, no second create', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 999 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 1 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('outreach via Activity → diagnostic skipped', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockResolvedValue({ id: 42 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 1 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('outreach via Task (when Activity has none) → diagnostic skipped', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockResolvedValue(null);
    prisma.task.findFirst.mockResolvedValue({ id: 7 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 1 });
  });

  test('Activity model unreachable (throws) → falls through to Task; still escalates if both no-hit', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockRejectedValue(new Error('Activity model missing'));
    prisma.task.findFirst.mockResolvedValue(null);
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 1, skipped: 0 });
  });

  test('race-tolerance: notification.create throws → next diagnostic still processed', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
      { id: 101, subBrand: 'tmc', contactId: 201, classificationLabel: 'Y', recommendedTier: 'primary', createdAt: halfHourAgo },
    ]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error('race'))
      .mockResolvedValueOnce({ id: 5 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result.alerted).toBe(1);
  });

  // ---- Extended coverage (tick #N: +8 cases) ----

  test('findMany query caps batch at take=500 (anti-runaway guard)', async () => {
    await runDiagnosticAlertsForTenant(7);
    const arg = prisma.travelDiagnostic.findMany.mock.calls[0][0];
    expect(arg.take).toBe(500);
    // Also pin select fields — schema-drift sentinel.
    expect(arg.select).toMatchObject({
      id: true, subBrand: true, contactId: true,
      classificationLabel: true, recommendedTier: true, createdAt: true,
    });
  });

  test('subBrand uppercased in title; tier-fallback when both labels null', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      {
        id: 300, subBrand: 'visasure', contactId: 400,
        classificationLabel: null, recommendedTier: null,
        createdAt: halfHourAgo,
      },
    ]);
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result.alerted).toBe(1);
    const createArg = prisma.notification.create.mock.calls[0][0];
    // subBrand must be uppercased in the title
    expect(createArg.data.title).toMatch(/VISASURE/);
    // Both label fields null → fallback string literal "tier"
    expect(createArg.data.title).toMatch(/\btier\b/);
    // The lowercase subBrand should NOT appear standalone in the title segment
    expect(createArg.data.title).not.toMatch(/^Diagnostic stalled: visasure/);
  });

  test('message body includes diag id, subBrand, contactId, elapsed minutes, and portal URL', async () => {
    const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      {
        id: 555, subBrand: 'tmc', contactId: 777,
        classificationLabel: 'Confident', recommendedTier: 'primary',
        createdAt: fortyMinAgo,
      },
    ]);
    await runDiagnosticAlertsForTenant(1);
    const msg = prisma.notification.create.mock.calls[0][0].data.message;
    expect(msg).toMatch(/Diagnostic #555/);
    expect(msg).toMatch(/\(tmc\)/);
    expect(msg).toMatch(/contact 777/);
    // elapsed min ~40 (between 39 and 41 to absorb test wall-clock slop)
    expect(msg).toMatch(/\b(39|40|41)m ago\b/);
    expect(msg).toMatch(/Tier: primary/);
    // Portal URL — env-overridable, defaults to crm.globusdemos.com
    expect(msg).toMatch(/\/travel\/diagnostics/);
  });

  test('mixed batch: dedup-skip + outreach-skip + escalate counted independently', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 1, subBrand: 'rfu', contactId: 10, classificationLabel: 'A', recommendedTier: 'entry', createdAt: halfHourAgo },
      { id: 2, subBrand: 'tmc', contactId: 20, classificationLabel: 'B', recommendedTier: 'primary', createdAt: halfHourAgo },
      { id: 3, subBrand: 'travelstall', contactId: 30, classificationLabel: 'C', recommendedTier: 'premium', createdAt: halfHourAgo },
    ]);
    // diag 1: already has notification → dedup-skip
    // diag 2: activity outreach exists → outreach-skip
    // diag 3: clean → escalate
    prisma.notification.findFirst
      .mockResolvedValueOnce({ id: 99 })   // diag 1
      .mockResolvedValueOnce(null)         // diag 2
      .mockResolvedValueOnce(null);        // diag 3
    prisma.activity.findFirst
      .mockResolvedValueOnce({ id: 42 })   // diag 2 has outreach
      .mockResolvedValueOnce(null);        // diag 3 no outreach
    prisma.task.findFirst.mockResolvedValue(null);

    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 1, skipped: 2 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    // Only diag 3 escalated
    expect(prisma.notification.create.mock.calls[0][0].data.entityId).toBe(3);
  });

  test('tenant.findUnique fired exactly once per pass (not per diagnostic)', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 1, subBrand: 'rfu', contactId: 10, classificationLabel: 'A', recommendedTier: 'entry', createdAt: halfHourAgo },
      { id: 2, subBrand: 'tmc', contactId: 20, classificationLabel: 'B', recommendedTier: 'primary', createdAt: halfHourAgo },
      { id: 3, subBrand: 'rfu', contactId: 30, classificationLabel: 'C', recommendedTier: 'premium', createdAt: halfHourAgo },
    ]);
    await runDiagnosticAlertsForTenant(99);
    // 3 diagnostics processed, but tenant lookup is hoisted once
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    const arg = prisma.tenant.findUnique.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 99 });
    expect(arg.select).toEqual({ subBrandConfigJson: true });
  });

  test('Task outreach query uses OR clause covering contactId + relatedToType="contact"', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 250, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockResolvedValue(null);
    // Force Task lookup (Activity returned no hit)
    await runDiagnosticAlertsForTenant(1);
    expect(prisma.task.findFirst).toHaveBeenCalledTimes(1);
    const where = prisma.task.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(Array.isArray(where.OR)).toBe(true);
    // OR must include both the contactId direct match AND the polymorphic relatedToId/relatedToType
    const orShapes = where.OR.map((c) => Object.keys(c).sort().join(','));
    expect(orShapes).toContain('contactId');
    const polymorphic = where.OR.find((c) => 'relatedToId' in c);
    expect(polymorphic).toBeDefined();
    expect(polymorphic.relatedToId).toBe(250);
    expect(polymorphic.relatedToType).toBe('contact');
    // Window guard: createdAt strictly AFTER the diagnostic timestamp
    expect(where.createdAt).toHaveProperty('gt');
  });

  test('Task model unreachable (throws) AND Activity none → still escalates (defensive no-outreach)', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockResolvedValue(null);
    prisma.task.findFirst.mockRejectedValue(new Error('Task model missing'));
    const result = await runDiagnosticAlertsForTenant(1);
    // When BOTH models are unreachable (Task throws, Activity returned null),
    // outreachExists stays false → escalate.
    expect(result).toEqual({ alerted: 1, skipped: 0 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });
});

describe('cron/travelDiagnosticAdvisorAlerts — runDiagnosticAlertsForAllTravelTenants', () => {
  test('queries vertical=travel + isActive=true; sums alerted across tenants; tolerates per-tenant errors', async () => {
    prisma.tenant.findMany = vi.fn().mockResolvedValue([
      { id: 1, slug: 'tenant-a' },
      { id: 2, slug: 'tenant-b' },
      { id: 3, slug: 'tenant-c' },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });

    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    // Tenant 1 has 1 escalation-ready diagnostic; tenant 2 throws on the findMany;
    // tenant 3 has 1 dedup-skip diagnostic (no alert).
    prisma.travelDiagnostic.findMany
      .mockResolvedValueOnce([
        { id: 1, subBrand: 'rfu', contactId: 10, classificationLabel: 'A', recommendedTier: 'entry', createdAt: halfHourAgo },
      ])
      .mockRejectedValueOnce(new Error('tenant 2 db unreachable'))
      .mockResolvedValueOnce([
        { id: 2, subBrand: 'tmc', contactId: 20, classificationLabel: 'B', recommendedTier: 'primary', createdAt: halfHourAgo },
      ]);
    // tenant 3's diagnostic is already deduped
    prisma.notification.findFirst
      .mockResolvedValueOnce(null)        // tenant 1 diag 1 — no existing notif
      .mockResolvedValueOnce({ id: 88 }); // tenant 3 diag 2 — dedup-skip

    const total = await runDiagnosticAlertsForAllTravelTenants();
    // Tenant 1 → 1 alert; tenant 2 → error (caught); tenant 3 → 0 alerts.
    expect(total).toBe(1);
    // The findMany query must scope to vertical=travel AND isActive=true
    const tenantQuery = prisma.tenant.findMany.mock.calls[0][0];
    expect(tenantQuery.where).toEqual({ vertical: 'travel', isActive: true });
    expect(tenantQuery.select).toEqual({ id: true, slug: true });
  });
});
