/**
 * Unit tests for backend/cron/appointmentRemindersEngine.js — wellness
 * vertical engine that runs every 15 minutes and queues SMS reminder rows
 * for Visit rows landing inside two windows:
 *   - T-24h: visitDate ∈ [now+23h, now+25h] → body says "tomorrow at <time>"
 *   - T-1h : visitDate ∈ [now+50min, now+70min] → body says "in 1 hour"
 *
 * Why this file exists (regression class):
 *   - The engine has api-level coverage via e2e/tests/appointment-reminders-api.spec.js
 *     (G-6, commit cdbca1e) but ZERO unit-level tests. Branches awkward to
 *     exercise through the api spec:
 *       - Window math at exact boundaries (23h/25h, 50min/70min). The api
 *         spec seeds happy-path visits inside the windows; out-of-window
 *         visits would require time-travel which costs DB roundtrips.
 *       - 48h dedup branching — pins the customer-friendly phrase used as
 *         the dedup signal ("tomorrow at" for 24h, "in 1 hour" for 1h).
 *       - Junk-contact suppression via Patient.contactId → Contact.status.
 *         Verifies a Junk-status contact silently skips the reminder.
 *       - Per-visit error containment — one failing visit doesn't kill the
 *         loop (try/catch in `handle`). API specs can't easily inject
 *         a controlled prisma failure mid-run.
 *
 * #182 regression guards (2026-05-04 reopen):
 *   - body must NOT contain "[reminder:24h]" or "[reminder:1h]" debug
 *     markers (they used to leak to the customer SMS).
 *   - body must NOT contain the double-word "appointment appointment"
 *     (when serviceName was null, the previous template rendered
 *     "your appointment appointment at <clinic>").
 *
 * Functions / branches covered:
 *   - processTenant
 *       T-24h happy path — OUTBOUND/QUEUED, contact link, customer-friendly body.
 *       T-1h happy path.
 *       null patient skipped (counted as skipped).
 *       no-phone patient skipped.
 *       Junk-contact patient skipped (contact.findUnique returns Junk).
 *       dedup hit → SmsMessage.create NOT called.
 *       per-visit error caught → loop continues, returns counters for siblings.
 *   - alreadySent (via processTenant)
 *       findFirst probe shape — `createdAt: { gte: now-48h }` + body contains
 *       "tomorrow at" or "in 1 hour" + OR over (contactId, to:phone).
 *   - composeBody (indirect via SmsMessage.create.body assertion)
 *       carries patientName / clinic / serviceName.
 *       falls back to bare "appointment" when service missing (NOT "appointment appointment").
 *       falls back to "there" when patient name null.
 *       NO debug markers leak.
 *   - findDueVisits (via window assertions on findMany calls)
 *       status='booked' (the engine's enum casing).
 *       visitDate window is bounded gte+lte.
 *   - tickAppointmentReminders (top-level orchestrator)
 *       tenant query: vertical='wellness' + isActive=true + scoped select.
 *       aggregates per-tenant counters across N tenants.
 *       per-tenant error isolation — one failing tenant doesn't abort siblings.
 *       top-level findMany failure caught → returns zeroed summary.
 *
 * Mocking strategy:
 *   Mirror backend/test/cron/recurringInvoiceEngine.test.js — import the
 *   prisma singleton, monkey-patch model methods. The cron module is inlined
 *   via vitest.config.js → server.deps.inline so its `require('../lib/prisma')`
 *   resolves to the same singleton instance.
 *
 *   NOTE: `processTenant` makes TWO prisma.visit.findMany calls per run (one
 *   per window) via Promise.all. We program them in the order
 *   findMany→[24h-result, 1h-result] using mockResolvedValueOnce twice. Each
 *   test that wants to drive only one window passes [] for the other.
 *
 *   NOTE: `alreadySent` makes ONE call to prisma.smsMessage.findFirst per
 *   visit (a "body contains <kind-phrase>" probe). By default we resolve
 *   null → engine falls through to create.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  processTenant,
  tickAppointmentReminders,
} from '../../cron/appointmentRemindersEngine.js';

beforeAll(() => {
  prisma.visit = { findMany: vi.fn() };
  prisma.smsMessage = { findFirst: vi.fn(), create: vi.fn() };
  prisma.contact = { findUnique: vi.fn() };
  prisma.tenant = { findMany: vi.fn() };
});

beforeEach(() => {
  prisma.visit.findMany.mockReset();
  prisma.smsMessage.findFirst.mockReset();
  prisma.smsMessage.create.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.tenant.findMany.mockReset();

  // Defaults — every test overrides what it cares about.
  prisma.visit.findMany.mockResolvedValue([]);
  prisma.smsMessage.findFirst.mockResolvedValue(null); // no dedup hit
  prisma.smsMessage.create.mockResolvedValue({ id: 'sms-x' });
  prisma.contact.findUnique.mockResolvedValue(null);
  prisma.tenant.findMany.mockResolvedValue([]);
});

const TENANT = { id: 'tenant-A', name: 'Enhanced Wellness', slug: 'enhanced' };

function visit({ id, mins = null, hours = null, patient, service = null, status = 'booked' }) {
  const offsetMs =
    hours != null ? hours * 3600 * 1000 : mins * 60 * 1000;
  return {
    id,
    status,
    visitDate: new Date(Date.now() + offsetMs),
    patient,
    service,
  };
}

// ─── Window queries ─────────────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — findDueVisits window queries', () => {
  test('issues TWO findMany calls per processTenant run (24h + 1h windows)', async () => {
    await processTenant(TENANT);
    expect(prisma.visit.findMany).toHaveBeenCalledTimes(2);
  });

  test('both queries scope to tenant + status="booked" + bounded visitDate', async () => {
    await processTenant(TENANT);
    for (const call of prisma.visit.findMany.mock.calls) {
      const arg = call[0];
      expect(arg.where.tenantId).toBe('tenant-A');
      expect(arg.where.status).toBe('booked'); // lowercase, matches engine enum
      expect(arg.where.visitDate).toHaveProperty('gte');
      expect(arg.where.visitDate).toHaveProperty('lte');
      expect(arg.where.visitDate.gte.getTime()).toBeLessThan(
        arg.where.visitDate.lte.getTime(),
      );
    }
  });

  test('24h window: gte ≈ now+23h, lte ≈ now+25h', async () => {
    const before = Date.now();
    await processTenant(TENANT);
    const win24 = prisma.visit.findMany.mock.calls[0][0];
    const gte = win24.where.visitDate.gte.getTime();
    const lte = win24.where.visitDate.lte.getTime();
    expect(gte).toBeGreaterThanOrEqual(before + 23 * 3600 * 1000 - 50);
    expect(gte).toBeLessThanOrEqual(Date.now() + 23 * 3600 * 1000 + 50);
    expect(lte).toBeGreaterThanOrEqual(before + 25 * 3600 * 1000 - 50);
    expect(lte).toBeLessThanOrEqual(Date.now() + 25 * 3600 * 1000 + 50);
  });

  test('1h window: gte ≈ now+50min, lte ≈ now+70min', async () => {
    const before = Date.now();
    await processTenant(TENANT);
    const win1 = prisma.visit.findMany.mock.calls[1][0];
    const gte = win1.where.visitDate.gte.getTime();
    const lte = win1.where.visitDate.lte.getTime();
    expect(gte).toBeGreaterThanOrEqual(before + 50 * 60 * 1000 - 50);
    expect(gte).toBeLessThanOrEqual(Date.now() + 50 * 60 * 1000 + 50);
    expect(lte).toBeGreaterThanOrEqual(before + 70 * 60 * 1000 - 50);
    expect(lte).toBeLessThanOrEqual(Date.now() + 70 * 60 * 1000 + 50);
  });

  test('include shape pulls patient + service.name (composeBody dependency)', async () => {
    await processTenant(TENANT);
    const arg = prisma.visit.findMany.mock.calls[0][0];
    expect(arg.include.patient).toBe(true);
    expect(arg.include.service).toEqual({ select: { id: true, name: true } });
  });
});

// ─── 24h reminder happy path ────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — T-24h reminder dispatch', () => {
  test('happy path → queues OUTBOUND/QUEUED SMS with customer-friendly body', async () => {
    const v = visit({
      id: 'v-24',
      hours: 24,
      patient: {
        id: 'pat-1',
        name: 'Rishu Sharma',
        phone: '+919876543210',
        contactId: 'contact-1',
      },
      service: { id: 'svc-1', name: 'Hydrafacial' },
    });
    prisma.visit.findMany
      .mockResolvedValueOnce([v]) // 24h window
      .mockResolvedValueOnce([]); // 1h window

    const res = await processTenant(TENANT);
    expect(res.queued24).toBe(1);
    expect(res.queued1).toBe(0);
    expect(res.skipped).toBe(0);

    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const arg = prisma.smsMessage.create.mock.calls[0][0];
    expect(arg.data.to).toBe('+919876543210');
    expect(arg.data.direction).toBe('OUTBOUND');
    expect(arg.data.status).toBe('QUEUED');
    expect(arg.data.tenantId).toBe('tenant-A');
    expect(arg.data.contactId).toBe('contact-1');
    expect(arg.data.body).toMatch(/Rishu Sharma/);
    expect(arg.data.body).toMatch(/Hydrafacial appointment/);
    expect(arg.data.body).toMatch(/Enhanced Wellness/);
    // 24h-ahead body says "tomorrow at <time>", not "in 1 hour"
    expect(arg.data.body).toMatch(/tomorrow at/i);
    expect(arg.data.body).not.toMatch(/in 1 hour/i);
    // #182 regression guards: no debug markers, no double-word
    expect(arg.data.body).not.toMatch(/\[reminder:24h\]/);
    expect(arg.data.body).not.toMatch(/\[reminder:1h\]/);
    expect(arg.data.body).not.toMatch(/appointment appointment/);
  });

  test('contactId optional → SmsMessage.create gets contactId:null', async () => {
    const v = visit({
      id: 'v-no-contact',
      hours: 24,
      patient: {
        id: 'pat-x',
        name: 'Walk-in',
        phone: '+919999999999',
        contactId: null,
      },
      service: { id: 'svc', name: 'Consult' },
    });
    prisma.visit.findMany.mockResolvedValueOnce([v]).mockResolvedValueOnce([]);

    await processTenant(TENANT);
    const arg = prisma.smsMessage.create.mock.calls[0][0];
    expect(arg.data.contactId).toBeNull();
    // Junk-contact lookup also skipped (no contactId to look up).
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('falls back to bare "appointment" when service missing — NOT "appointment appointment" (#182)', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-no-svc',
          hours: 24,
          patient: { id: 'p', name: 'Asha', phone: '+91900', contactId: null },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);

    await processTenant(TENANT);
    const arg = prisma.smsMessage.create.mock.calls[0][0];
    expect(arg.data.body).toMatch(/your appointment at/i);
    // Pre-fix the body rendered "your appointment appointment at <clinic>"
    // because svc defaulted to "appointment" and the template appended a
    // second "appointment" suffix. Pin the post-fix shape.
    expect(arg.data.body).not.toMatch(/appointment appointment/);
  });

  test('falls back to "there" when patient name is null', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-no-name',
          hours: 24,
          patient: { id: 'p', name: null, phone: '+91900', contactId: null },
          service: { id: 's', name: 'Botox' },
        }),
      ])
      .mockResolvedValueOnce([]);

    await processTenant(TENANT);
    const arg = prisma.smsMessage.create.mock.calls[0][0];
    expect(arg.data.body).toMatch(/^Hi there,/);
  });

  test('falls back to "Enhanced Wellness" clinic name when tenant.name absent', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-A',
          hours: 24,
          patient: { id: 'p', name: 'Asha', phone: '+91900', contactId: null },
          service: { id: 's', name: 'Botox' },
        }),
      ])
      .mockResolvedValueOnce([]);

    await processTenant({ id: 'tenant-A', name: null, slug: 'foo' });
    const arg = prisma.smsMessage.create.mock.calls[0][0];
    expect(arg.data.body).toMatch(/Enhanced Wellness/);
  });
});

// ─── 1h reminder happy path ─────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — T-1h reminder dispatch', () => {
  test('happy path → queues OUTBOUND/QUEUED SMS with "in 1 hour" phrase', async () => {
    const v = visit({
      id: 'v-1h',
      mins: 60,
      patient: {
        id: 'pat-2',
        name: 'Asha Verma',
        phone: '+918888888888',
        contactId: null,
      },
      service: { id: 'svc-2', name: 'Botox' },
    });
    prisma.visit.findMany
      .mockResolvedValueOnce([]) // 24h window empty
      .mockResolvedValueOnce([v]); // 1h window

    const res = await processTenant(TENANT);
    expect(res.queued24).toBe(0);
    expect(res.queued1).toBe(1);
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const arg = prisma.smsMessage.create.mock.calls[0][0];
    expect(arg.data.body).toMatch(/Botox appointment/);
    expect(arg.data.body).toMatch(/in 1 hour/i);
    expect(arg.data.body).not.toMatch(/tomorrow at/i);
    // #182 regression guards
    expect(arg.data.body).not.toMatch(/\[reminder:1h\]/);
    expect(arg.data.body).not.toMatch(/\[reminder:24h\]/);
  });
});

// ─── Skip / suppress branches ───────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — patient/contact suppression', () => {
  test('null patient relation → counted as skipped, no SMS created', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        {
          id: 'v-orphan',
          status: 'booked',
          visitDate: new Date(Date.now() + 24 * 3600 * 1000),
          patient: null,
          service: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const res = await processTenant(TENANT);
    expect(res.queued24).toBe(0);
    expect(res.skipped).toBe(1);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('patient.phone null → skipped, no SMS created', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-nophone',
          hours: 24,
          patient: { id: 'p', name: 'X', phone: null, contactId: null },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);

    const res = await processTenant(TENANT);
    expect(res.skipped).toBe(1);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('Junk-status contact → looked up via Patient.contactId, then skipped', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-junk',
          hours: 24,
          patient: {
            id: 'p',
            name: 'Spammer',
            phone: '+91900',
            contactId: 'contact-junk',
          },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    prisma.contact.findUnique.mockResolvedValue({ status: 'Junk' });

    const res = await processTenant(TENANT);
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { id: 'contact-junk' },
      select: { status: true },
    });
    expect(res.skipped).toBe(1);
    expect(res.queued24).toBe(0);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('non-Junk contact (e.g. Active) → reminder still queued', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-active',
          hours: 24,
          patient: {
            id: 'p',
            name: 'Real Customer',
            phone: '+91901',
            contactId: 'contact-active',
          },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    prisma.contact.findUnique.mockResolvedValue({ status: 'Active' });

    const res = await processTenant(TENANT);
    expect(res.queued24).toBe(1);
    expect(res.skipped).toBe(0);
  });
});

// ─── 48h dedup ──────────────────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — 48h dedup (alreadySent)', () => {
  test('24h: prior body containing "tomorrow at" → SmsMessage.create NOT called, skipped++', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-dup-24',
          hours: 24,
          patient: { id: 'p', name: 'Dup', phone: '+91900', contactId: 'c-1' },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    // findFirst probe (body contains "tomorrow at") returns a hit.
    prisma.smsMessage.findFirst.mockResolvedValueOnce({ id: 'sms-prev-24' });

    const res = await processTenant(TENANT);
    expect(res.queued24).toBe(0);
    expect(res.skipped).toBe(1);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();

    // Probe shape — keyed on (contactId OR phone) within last 48h, body
    // contains the unique-to-engine phrase "tomorrow at".
    const probe = prisma.smsMessage.findFirst.mock.calls[0][0];
    expect(probe.where.body).toEqual({ contains: 'tomorrow at' });
    expect(probe.where.createdAt).toHaveProperty('gte');
    const gte = probe.where.createdAt.gte.getTime();
    expect(gte).toBeGreaterThanOrEqual(Date.now() - 48 * 3600 * 1000 - 1000);
    expect(gte).toBeLessThanOrEqual(Date.now() - 48 * 3600 * 1000 + 1000);
    // OR clause covers both (contactId, to:phone).
    expect(probe.where.OR).toEqual(
      expect.arrayContaining([{ contactId: 'c-1' }, { to: '+91900' }]),
    );
  });

  test('1h: prior body containing "in 1 hour" → SmsMessage.create NOT called, skipped++', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        visit({
          id: 'v-dup-1',
          mins: 60,
          patient: { id: 'p', name: 'Dup', phone: '+91900', contactId: null },
          service: null,
        }),
      ]);
    prisma.smsMessage.findFirst.mockResolvedValueOnce({ id: 'sms-prev-1' });

    const res = await processTenant(TENANT);
    expect(res.queued1).toBe(0);
    expect(res.skipped).toBe(1);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();

    const probe = prisma.smsMessage.findFirst.mock.calls[0][0];
    expect(probe.where.body).toEqual({ contains: 'in 1 hour' });
  });

  test('probe miss → reminder is dispatched (single probe per visit, no fallback)', async () => {
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-fresh',
          hours: 24,
          patient: { id: 'p', name: 'Fresh', phone: '+91900', contactId: 'c-1' },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    prisma.smsMessage.findFirst.mockResolvedValueOnce(null);

    const res = await processTenant(TENANT);
    expect(res.queued24).toBe(1);
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    // The fallback marker probe was removed in #182 (no more visible markers).
    // Only ONE findFirst per visit now.
    expect(prisma.smsMessage.findFirst).toHaveBeenCalledTimes(1);
  });

  test('no contactId AND no phone → alreadySent returns false (no probes), but no-phone branch already skipped earlier', async () => {
    // Defense-in-depth: if a future change lets the no-phone gate slip,
    // alreadySent's empty-OR fallback returns false, and the engine would
    // attempt to write. Cover the upstream gate's contract.
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-empty',
          hours: 24,
          patient: { id: 'p', name: 'X', phone: null, contactId: null },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);

    const res = await processTenant(TENANT);
    expect(res.skipped).toBe(1);
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
    // No phone → no dedup probe runs.
    expect(prisma.smsMessage.findFirst).not.toHaveBeenCalled();
  });
});

// ─── Per-visit error containment ────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — per-visit error isolation', () => {
  test('one failing visit does NOT break the loop — siblings still dispatched', async () => {
    // Two 24h-window visits — first SmsMessage.create throws, second succeeds.
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-fail',
          hours: 24,
          patient: { id: 'pf', name: 'Fail', phone: '+91900', contactId: null },
          service: null,
        }),
        visit({
          id: 'v-ok',
          hours: 24,
          patient: { id: 'po', name: 'OK', phone: '+91901', contactId: null },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([]);

    prisma.smsMessage.create
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ id: 'sms-ok' });

    // Suppress the engine's expected console.error for this test.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await processTenant(TENANT);
    expect(res.queued24).toBe(1); // sibling succeeded
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── Aggregate / shape ──────────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — return shape', () => {
  test('returns { tenant, queued24, queued1, skipped } summary', async () => {
    const res = await processTenant(TENANT);
    expect(res).toEqual({
      tenant: 'enhanced',
      queued24: 0,
      queued1: 0,
      skipped: 0,
    });
  });

  test('falls back to tenant.id for the summary key when slug missing', async () => {
    const res = await processTenant({ id: 'tenant-Z', name: null, slug: null });
    expect(res.tenant).toBe('tenant-Z');
  });
});

// ─── tickAppointmentReminders (top-level orchestrator) ─────────────────────
// The cron tick wraps processTenant() across every wellness tenant. We pin
// its tenant query, error-isolation between tenants, and aggregate counters.

describe('cron/appointmentRemindersEngine — tickAppointmentReminders orchestrator', () => {
  test('queries only ACTIVE wellness tenants', async () => {
    // Suppress the tick's own console.log summary line.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await tickAppointmentReminders();
    logSpy.mockRestore();

    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where.vertical).toBe('wellness');
    expect(arg.where.isActive).toBe(true);
    expect(arg.select).toEqual({ id: true, name: true, slug: true });
  });

  test('zero tenants → returns aggregate of zeros, no per-tenant prisma calls', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await tickAppointmentReminders();
    logSpy.mockRestore();

    expect(res).toEqual({
      tenantsProcessed: 0,
      totalQueued24: 0,
      totalQueued1: 0,
      totalSkipped: 0,
    });
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
  });

  test('aggregates counters across multiple tenants', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'T1', name: 'Tenant 1', slug: 't1' },
      { id: 'T2', name: 'Tenant 2', slug: 't2' },
    ]);
    // Tenant 1: one 24h visit, one 1h visit. Tenant 2: nothing.
    prisma.visit.findMany
      .mockResolvedValueOnce([
        visit({
          id: 'v-1-24',
          hours: 24,
          patient: { id: 'p1', name: 'Asha', phone: '+91', contactId: null },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([
        visit({
          id: 'v-1-1',
          mins: 60,
          patient: { id: 'p1b', name: 'Bali', phone: '+92', contactId: null },
          service: null,
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await tickAppointmentReminders();
    logSpy.mockRestore();

    expect(res.tenantsProcessed).toBe(2);
    expect(res.totalQueued24).toBe(1);
    expect(res.totalQueued1).toBe(1);
    expect(prisma.visit.findMany).toHaveBeenCalledTimes(4); // 2 tenants × 2 windows
  });

  test('one failing tenant does NOT abort the loop — sibling tenant still runs', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'T-fail', name: 'Fail', slug: 'fail' },
      { id: 'T-ok', name: 'OK', slug: 'ok' },
    ]);
    // Tenant T-fail's 24h findMany throws; Tenant T-ok succeeds.
    prisma.visit.findMany
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await tickAppointmentReminders();

    // Snapshot call count BEFORE restoring spies (mockRestore wipes history).
    const errCallCount = errSpy.mock.calls.length;
    logSpy.mockRestore();
    errSpy.mockRestore();

    // T-fail aborted before incrementing tenantsProcessed; T-ok still counted.
    expect(res.tenantsProcessed).toBe(1);
    expect(errCallCount).toBeGreaterThan(0);
  });

  test('top-level prisma.tenant.findMany failure → caught, returns zeros', async () => {
    prisma.tenant.findMany.mockRejectedValue(new Error('DB unavailable'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await tickAppointmentReminders();
    const errCallCount = errSpy.mock.calls.length;
    logSpy.mockRestore();
    errSpy.mockRestore();

    expect(res.tenantsProcessed).toBe(0);
    expect(errCallCount).toBeGreaterThan(0);
  });
});
