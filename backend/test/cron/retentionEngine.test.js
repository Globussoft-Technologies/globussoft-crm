// Unit tests for backend/cron/retentionEngine.js — verifies the engine
// writes an AuditLog row for EVERY retention sweep, including no-op
// runs where deleted=0.
//
// Why this matters (closes #411): GDPR Art. 30 + SOC-2 require a
// complete trail of when retention was *attempted*, not just when it
// actually deleted rows. The engine previously only wrote AuditLog when
// `deleted > 0`, leaving long stretches of no-op runs indistinguishable
// from "the cron didn't run" in an audit. The manual trigger at
// POST /api/gdpr/retention/run (G-11, commit cb96793) already wrote the
// audit row regardless; the cron path now matches the same contract.
//
// Mocking strategy mirrors backend/test/lib/notificationService.test.js:
// import the prisma singleton, monkey-patch model methods. The cron
// module is inlined via vitest.config.js → server.deps.inline so its
// require("../lib/prisma") resolves to the same singleton instance.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

// The SUT looks up models lazily via prisma[propName] inside runRetentionSweep
// (not at module load), so replacing the singleton's model accessors here
// is sufficient. See the ENTITY_MAP comment in retentionEngine.js for why
// the lazy-lookup form was chosen.
import {
  runRetentionSweep,
  WELLNESS_DEFAULT_POLICIES,
  seedWellnessRetentionPolicies,
  TRAVEL_DEFAULT_POLICIES,
  seedTravelRetentionPolicies,
  ENTITY_MAP,
  ENTITY_GUARDS,
  SOFT_DELETE_ENTITIES,
} from '../../cron/retentionEngine.js';

beforeAll(() => {
  prisma.retentionPolicy = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  prisma.auditLog = { create: vi.fn() };
  prisma.emailMessage = { deleteMany: vi.fn() };
  prisma.callLog = { deleteMany: vi.fn() };
  prisma.activity = { deleteMany: vi.fn() };
  prisma.smsMessage = { deleteMany: vi.fn() };
  prisma.whatsAppMessage = { deleteMany: vi.fn() };
  // #576 — clinical / medical models added to ENTITY_MAP.
  prisma.patient = { deleteMany: vi.fn(), updateMany: vi.fn() };
  prisma.visit = { deleteMany: vi.fn(), updateMany: vi.fn() };
  prisma.prescription = { deleteMany: vi.fn(), updateMany: vi.fn() };
  prisma.consentForm = { deleteMany: vi.fn(), updateMany: vi.fn() };
  prisma.treatmentPlan = { deleteMany: vi.fn(), updateMany: vi.fn() };
  prisma.attachment = { deleteMany: vi.fn(), updateMany: vi.fn() };
  // Gap A4 (Q14) — travel models added to ENTITY_MAP.
  prisma.contactAttachment = { deleteMany: vi.fn() };
  prisma.voiceSession = { deleteMany: vi.fn() };
  prisma.travelInvoice = { deleteMany: vi.fn() };
});

beforeEach(() => {
  prisma.retentionPolicy.findMany.mockReset();
  prisma.retentionPolicy.findUnique.mockReset();
  prisma.retentionPolicy.create.mockReset();
  prisma.emailMessage.deleteMany.mockReset();
  prisma.callLog.deleteMany.mockReset();
  prisma.activity.deleteMany.mockReset();
  prisma.smsMessage.deleteMany.mockReset();
  prisma.whatsAppMessage.deleteMany.mockReset();
  prisma.patient.deleteMany.mockReset();
  prisma.patient.updateMany.mockReset();
  prisma.visit.deleteMany.mockReset();
  prisma.visit.updateMany.mockReset();
  prisma.prescription.deleteMany.mockReset();
  prisma.prescription.updateMany.mockReset();
  prisma.consentForm.deleteMany.mockReset();
  prisma.consentForm.updateMany.mockReset();
  prisma.treatmentPlan.deleteMany.mockReset();
  prisma.treatmentPlan.updateMany.mockReset();
  prisma.attachment.deleteMany.mockReset();
  prisma.attachment.updateMany.mockReset();
  prisma.contactAttachment.deleteMany.mockReset();
  prisma.voiceSession.deleteMany.mockReset();
  prisma.travelInvoice.deleteMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({});
});

describe('cron/retentionEngine — AuditLog written even on no-op (closes #411)', () => {
  test('no policies → no audit, no delete (early return)', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([]);

    const summary = await runRetentionSweep();
    expect(summary).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.emailMessage.deleteMany).not.toHaveBeenCalled();
  });

  test('eligible rows exist → audit row written with deleted > 0', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 7, retainDays: 30 },
    ]);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 5 });

    const summary = await runRetentionSweep();

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ tenantId: 7, entity: 'EmailMessage', deleted: 5 });

    // AuditLog row written exactly once.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.action).toBe('DELETE');
    expect(arg.data.entity).toBe('EmailMessage');
    expect(arg.data.tenantId).toBe(7);
    const details = JSON.parse(arg.data.details);
    expect(details.source).toBe('RetentionEngine');
    expect(details.deleted).toBe(5);
    expect(details.retainDays).toBe(30);
    expect(details.via).toBe('cron');
    expect(typeof details.cutoff).toBe('string');
  });

  test('NO eligible rows → audit row STILL written with deleted=0 (the fix)', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 7, retainDays: 30 },
    ]);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 0 });

    const summary = await runRetentionSweep();
    expect(summary[0].deleted).toBe(0);

    // Critical assertion — pre-fix this would be 0 calls.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.action).toBe('DELETE');
    expect(arg.data.entity).toBe('EmailMessage');
    expect(arg.data.tenantId).toBe(7);
    const details = JSON.parse(arg.data.details);
    expect(details.deleted).toBe(0);
    expect(details.source).toBe('RetentionEngine');
    expect(details.via).toBe('cron');
  });

  test('multi-policy run writes one AuditLog per policy (mix of deleted>0 and =0)', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 1, retainDays: 30 },
      { id: 2, isActive: true, entity: 'CallLog', tenantId: 1, retainDays: 60 },
      { id: 3, isActive: true, entity: 'Activity', tenantId: 2, retainDays: 90 },
    ]);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 12 });
    prisma.callLog.deleteMany.mockResolvedValue({ count: 0 });
    prisma.activity.deleteMany.mockResolvedValue({ count: 3 });

    await runRetentionSweep();

    // One audit per policy regardless of whether deleted > 0.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(3);
    const calls = prisma.auditLog.create.mock.calls.map(c => c[0].data);
    const entities = calls.map(d => d.entity).sort();
    expect(entities).toEqual(['Activity', 'CallLog', 'EmailMessage']);

    // Find the no-op CallLog audit and confirm it's still written + has deleted=0.
    const callLogAudit = calls.find(d => d.entity === 'CallLog');
    expect(callLogAudit).toBeDefined();
    expect(JSON.parse(callLogAudit.details).deleted).toBe(0);
  });

  test('unknown entity in policy → skipped, no audit, no crash', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'UnknownModel', tenantId: 1, retainDays: 30 },
    ]);

    const summary = await runRetentionSweep();
    expect(summary).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('deleteMany throws → audit NOT written for that policy, sweep continues', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 1, retainDays: 30 },
      { id: 2, isActive: true, entity: 'CallLog', tenantId: 1, retainDays: 60 },
    ]);
    prisma.emailMessage.deleteMany.mockRejectedValue(new Error('DB unreachable'));
    prisma.callLog.deleteMany.mockResolvedValue({ count: 4 });

    await expect(runRetentionSweep()).resolves.toBeDefined();

    // Only the second policy's audit row is written — failed deleteMany is
    // caught by the inner try/catch and skips the audit step.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.entity).toBe('CallLog');
  });

  test('auditLog.create rejection is swallowed (best-effort)', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 1, retainDays: 30 },
    ]);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 2 });
    prisma.auditLog.create.mockRejectedValue(new Error('audit table down'));

    // Engine must not throw — audit write is best-effort.
    await expect(runRetentionSweep()).resolves.toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// #576 — Clinical / Medical Records retention (wellness vertical).
// ────────────────────────────────────────────────────────────────────
describe('cron/retentionEngine — clinical entities (#576)', () => {
  test('ENTITY_MAP exposes the 6 medical entities', () => {
    expect(ENTITY_MAP).toMatchObject({
      Patient: 'patient',
      Visit: 'visit',
      Prescription: 'prescription',
      ConsentForm: 'consentForm',
      TreatmentPlan: 'treatmentPlan',
      MedicalAttachment: 'attachment',
    });
  });

  test('SOFT_DELETE_ENTITIES includes Patient (and only Patient at v1)', () => {
    expect(SOFT_DELETE_ENTITIES.has('Patient')).toBe(true);
    // Other clinical entities are direct hard-delete on cutoff.
    expect(SOFT_DELETE_ENTITIES.has('Visit')).toBe(false);
    expect(SOFT_DELETE_ENTITIES.has('ConsentForm')).toBe(false);
  });

  test('Visit retention sweep hard-deletes rows older than retainDays', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 9, isActive: true, entity: 'Visit', tenantId: 5, retainDays: 2555 },
    ]);
    prisma.visit.deleteMany.mockResolvedValue({ count: 4 });

    const summary = await runRetentionSweep();
    expect(summary[0]).toMatchObject({ tenantId: 5, entity: 'Visit', deleted: 4 });
    expect(prisma.visit.deleteMany).toHaveBeenCalledTimes(1);
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.entity).toBe('Visit');
    expect(JSON.parse(audit.details).deleted).toBe(4);
  });

  test('Patient retention sweep does TWO-PHASE soft-delete then hard-delete', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 11, isActive: true, entity: 'Patient', tenantId: 7, retainDays: 3650 },
    ]);
    prisma.patient.updateMany.mockResolvedValue({ count: 2 }); // soft-deleted
    prisma.patient.deleteMany.mockResolvedValue({ count: 1 }); // hard-purged

    const summary = await runRetentionSweep();

    expect(summary[0]).toMatchObject({
      tenantId: 7,
      entity: 'Patient',
      deleted: 1,
      softDeleted: 2,
    });

    // Phase 1 — updateMany sets deletedAt for rows older than cutoff.
    expect(prisma.patient.updateMany).toHaveBeenCalledTimes(1);
    const phase1Args = prisma.patient.updateMany.mock.calls[0][0];
    expect(phase1Args.where.tenantId).toBe(7);
    expect(phase1Args.where.deletedAt).toBeNull();
    expect(phase1Args.data.deletedAt).toBeInstanceOf(Date);

    // Phase 2 — deleteMany hard-purges rows whose deletedAt is older than
    // the tombstone (retainDays * 1.5) cutoff.
    expect(prisma.patient.deleteMany).toHaveBeenCalledTimes(1);
    const phase2Args = prisma.patient.deleteMany.mock.calls[0][0];
    expect(phase2Args.where.tenantId).toBe(7);
    expect(phase2Args.where.deletedAt.not).toBeNull();
    expect(phase2Args.where.deletedAt.lt).toBeInstanceOf(Date);

    // Audit row written.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const details = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(details.deleted).toBe(1);
    expect(details.softDeleted).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// #576 — seedWellnessRetentionPolicies idempotent helper.
// ────────────────────────────────────────────────────────────────────
describe('seedWellnessRetentionPolicies (#576)', () => {
  test('creates the 6 default rows when none exist', async () => {
    prisma.retentionPolicy.findUnique.mockResolvedValue(null);
    prisma.retentionPolicy.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    const created = await seedWellnessRetentionPolicies(99);

    expect(created.length).toBe(6);
    const entities = created.map(r => r.entity).sort();
    expect(entities).toEqual([
      'ConsentForm', 'MedicalAttachment', 'Patient', 'Prescription', 'TreatmentPlan', 'Visit',
    ]);
  });

  test('skips rows that already exist (idempotent)', async () => {
    // Pretend Patient + Visit exist; the other 4 don't.
    prisma.retentionPolicy.findUnique.mockImplementation(async ({ where }) => {
      const e = where.tenantId_entity.entity;
      return (e === 'Patient' || e === 'Visit') ? { id: 1, entity: e } : null;
    });
    prisma.retentionPolicy.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    const created = await seedWellnessRetentionPolicies(99);

    expect(created.length).toBe(4);
    expect(created.map(r => r.entity).sort()).toEqual([
      'ConsentForm', 'MedicalAttachment', 'Prescription', 'TreatmentPlan',
    ]);
  });

  test('returns [] for falsy tenantId', async () => {
    expect(await seedWellnessRetentionPolicies(null)).toEqual([]);
    expect(await seedWellnessRetentionPolicies(0)).toEqual([]);
    expect(prisma.retentionPolicy.create).not.toHaveBeenCalled();
  });

  test('default windows match the issue brief: 7y for clinical, 10y for Patient', () => {
    const byEntity = Object.fromEntries(WELLNESS_DEFAULT_POLICIES.map(p => [p.entity, p]));
    // 2555 days ~ 7y; 3650 days ~ 10y.
    expect(byEntity.Patient.retainDays).toBe(3650);
    expect(byEntity.Visit.retainDays).toBe(2555);
    expect(byEntity.Prescription.retainDays).toBe(2555);
    expect(byEntity.ConsentForm.retainDays).toBe(2555);
    expect(byEntity.TreatmentPlan.retainDays).toBe(2555);
    expect(byEntity.MedicalAttachment.retainDays).toBe(2555);
    // Default isActive=false — admins must explicitly enable purge.
    WELLNESS_DEFAULT_POLICIES.forEach(p => {
      expect(p.isActive).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Extended coverage (tick #N of test-writing cron) — fills gaps around
// outer-try/catch resilience, query-shape pinning (isActive filter,
// tenant scoping, cutoff math), retainDays edge cases (0 and huge),
// per-tenant audit isolation, and soft-delete tombstone-multiplier math.
// ────────────────────────────────────────────────────────────────────
describe('cron/retentionEngine — extended coverage', () => {
  test('retentionPolicy.findMany rejection → outer try/catch swallows, returns []', async () => {
    // Outer try at runRetentionSweep top catches the findMany throw so the
    // daily cron tick can't crash the process. Without this guard, a single
    // transient DB blip in the policy fetch would take down the engine.
    prisma.retentionPolicy.findMany.mockRejectedValue(new Error('connection lost'));

    const summary = await runRetentionSweep();
    expect(summary).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.emailMessage.deleteMany).not.toHaveBeenCalled();
  });

  test('findMany is called with where: { isActive: true } — inactive policies excluded', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([]);

    await runRetentionSweep();

    expect(prisma.retentionPolicy.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.retentionPolicy.findMany.mock.calls[0][0];
    expect(arg).toEqual({ where: { isActive: true } });
  });

  test('tenant isolation — deleteMany where-clause is scoped to policy.tenantId', async () => {
    // Two policies on the same entity, different tenants — each sweep
    // call must filter to its own tenantId or PHI leaks cross-tenant.
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 100, retainDays: 30 },
      { id: 2, isActive: true, entity: 'EmailMessage', tenantId: 200, retainDays: 60 },
    ]);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 1 });

    await runRetentionSweep();

    expect(prisma.emailMessage.deleteMany).toHaveBeenCalledTimes(2);
    const calls = prisma.emailMessage.deleteMany.mock.calls.map(c => c[0]);
    const tenantIds = calls.map(c => c.where.tenantId).sort();
    expect(tenantIds).toEqual([100, 200]);
    // Each call has its own createdAt cutoff (no shared where reference).
    expect(calls[0].where.createdAt.lt).toBeInstanceOf(Date);
    expect(calls[1].where.createdAt.lt).toBeInstanceOf(Date);
  });

  test('cutoff is computed as retainDays * 86,400,000 ms before now', async () => {
    // Pin the cutoff math so a future "let's switch to startOfDay() / change
    // ms-per-day constant" refactor surfaces here, not silently in production.
    const retainDays = 30;
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 1, retainDays },
    ]);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 0 });

    const before = Date.now();
    await runRetentionSweep();
    const after = Date.now();

    const cutoff = prisma.emailMessage.deleteMany.mock.calls[0][0].where.createdAt.lt;
    const expectedMin = before - retainDays * 86_400_000;
    const expectedMax = after - retainDays * 86_400_000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  test('retainDays=0 edge — cutoff ≈ now, sweep still runs (no divide-by-zero / no skip)', async () => {
    // retainDays=0 is a valid (if aggressive) "purge everything older than
    // now" policy. The engine must not short-circuit on it — that would
    // make "purge everything immediately" indistinguishable from a typo.
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 1, retainDays: 0 },
    ]);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 99 });

    const summary = await runRetentionSweep();
    expect(summary[0].deleted).toBe(99);
    expect(prisma.emailMessage.deleteMany).toHaveBeenCalledTimes(1);
    // Cutoff is now-ish (within a couple seconds either way is fine).
    const cutoff = prisma.emailMessage.deleteMany.mock.calls[0][0].where.createdAt.lt;
    expect(Math.abs(cutoff.getTime() - Date.now())).toBeLessThan(5000);
    // Audit still written.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details).retainDays).toBe(0);
  });

  test('Patient tombstone cutoff = retainDays * 1.5 * 86_400_000 ms ago (#628)', async () => {
    // The SOFT_DELETE_ENTITIES two-phase purge uses TOMBSTONE_MULTIPLIER=1.5.
    // Pin the math: phase 2 deleteMany's deletedAt.lt cutoff must be
    // retainDays * 1.5 days back from now, NOT retainDays days back.
    const retainDays = 100;
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'Patient', tenantId: 1, retainDays },
    ]);
    prisma.patient.updateMany.mockResolvedValue({ count: 0 });
    prisma.patient.deleteMany.mockResolvedValue({ count: 0 });

    const before = Date.now();
    await runRetentionSweep();
    const after = Date.now();

    // Phase 1 cutoff = retainDays days back (used by updateMany on createdAt).
    const phase1Cutoff = prisma.patient.updateMany.mock.calls[0][0].where.createdAt.lt;
    expect(phase1Cutoff.getTime()).toBeGreaterThanOrEqual(before - retainDays * 86_400_000);
    expect(phase1Cutoff.getTime()).toBeLessThanOrEqual(after - retainDays * 86_400_000);

    // Phase 2 tombstone cutoff = retainDays * 1.5 days back (deletedAt.lt).
    const phase2Cutoff = prisma.patient.deleteMany.mock.calls[0][0].where.deletedAt.lt;
    const tombMs = retainDays * 1.5 * 86_400_000;
    expect(phase2Cutoff.getTime()).toBeGreaterThanOrEqual(before - tombMs);
    expect(phase2Cutoff.getTime()).toBeLessThanOrEqual(after - tombMs);
    // Phase 2 cutoff is STRICTLY older than phase 1 cutoff.
    expect(phase2Cutoff.getTime()).toBeLessThan(phase1Cutoff.getTime());
  });

  test('per-tenant audit isolation — same-entity policies write tenant-tagged audit rows', async () => {
    // Two tenants with EmailMessage policies; each audit row must carry
    // its own tenantId so downstream consumers (gdpr.js viewer, SOC-2
    // exports) can filter the trail per tenant cleanly.
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'EmailMessage', tenantId: 100, retainDays: 30 },
      { id: 2, isActive: true, entity: 'EmailMessage', tenantId: 200, retainDays: 30 },
    ]);
    prisma.emailMessage.deleteMany
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 7 });

    await runRetentionSweep();

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    const auditCalls = prisma.auditLog.create.mock.calls.map(c => c[0].data);
    const byTenant = Object.fromEntries(auditCalls.map(d => [d.tenantId, d]));
    expect(byTenant[100]).toBeDefined();
    expect(byTenant[200]).toBeDefined();
    expect(JSON.parse(byTenant[100].details).deleted).toBe(5);
    expect(JSON.parse(byTenant[200].details).deleted).toBe(7);
  });

});

// ────────────────────────────────────────────────────────────────────
// Gap A4 (Q14) — travel-vertical per-type retention.
// PRD §4.7 + Q14 accepted GS defaults: passport/Aadhaar/PAN docs 24m,
// call recordings 12m, financial 84m, diagnostic responses lifetime.
// ────────────────────────────────────────────────────────────────────
describe('cron/retentionEngine — travel entities (gap A4 / Q14)', () => {
  test('ENTITY_MAP exposes the 3 travel entities; TravelDiagnostic is intentionally absent', () => {
    expect(ENTITY_MAP).toMatchObject({
      ContactAttachment: 'contactAttachment',
      VoiceSession: 'voiceSession',
      TravelInvoice: 'travelInvoice',
    });
    // Q14: diagnostic responses = lifetime of profile. No ENTITY_MAP
    // entry means even a manually-created policy row can never purge it.
    expect(ENTITY_MAP).not.toHaveProperty('TravelDiagnostic');
  });

  test('travel entities are hard-delete (not in SOFT_DELETE_ENTITIES)', () => {
    expect(SOFT_DELETE_ENTITIES.has('ContactAttachment')).toBe(false);
    expect(SOFT_DELETE_ENTITIES.has('VoiceSession')).toBe(false);
    expect(SOFT_DELETE_ENTITIES.has('TravelInvoice')).toBe(false);
  });

  test('ContactAttachment sweep hard-deletes tenant-scoped rows older than cutoff', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 21, isActive: true, entity: 'ContactAttachment', tenantId: 9, retainDays: 730 },
    ]);
    prisma.contactAttachment.deleteMany.mockResolvedValue({ count: 3 });

    const summary = await runRetentionSweep();
    expect(summary[0]).toMatchObject({ tenantId: 9, entity: 'ContactAttachment', deleted: 3 });
    expect(prisma.contactAttachment.deleteMany).toHaveBeenCalledTimes(1);
    const where = prisma.contactAttachment.deleteMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(9);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // No status guard on document sweeps — only tenant + cutoff.
    expect(where.status).toBeUndefined();
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.entity).toBe('ContactAttachment');
    expect(JSON.parse(audit.details).deleted).toBe(3);
  });

  test('VoiceSession sweep hard-deletes tenant-scoped rows older than cutoff', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 22, isActive: true, entity: 'VoiceSession', tenantId: 9, retainDays: 365 },
    ]);
    prisma.voiceSession.deleteMany.mockResolvedValue({ count: 2 });

    const summary = await runRetentionSweep();
    expect(summary[0]).toMatchObject({ tenantId: 9, entity: 'VoiceSession', deleted: 2 });
    const where = prisma.voiceSession.deleteMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(9);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });

  test('TravelInvoice sweep applies the open-receivable guard (Issued/Partial never purged)', async () => {
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 23, isActive: true, entity: 'TravelInvoice', tenantId: 9, retainDays: 2555 },
    ]);
    prisma.travelInvoice.deleteMany.mockResolvedValue({ count: 4 });

    const summary = await runRetentionSweep();
    expect(summary[0]).toMatchObject({ tenantId: 9, entity: 'TravelInvoice', deleted: 4 });

    expect(prisma.travelInvoice.deleteMany).toHaveBeenCalledTimes(1);
    const where = prisma.travelInvoice.deleteMany.mock.calls[0][0].where;
    // Status allowlist — open receivables (Issued/Partial) excluded.
    expect(where.status).toEqual({ in: ['Draft', 'Paid', 'Voided'] });
    expect(where.status.in).not.toContain('Issued');
    expect(where.status.in).not.toContain('Partial');
    // Guard merges in FIRST — tenant scope + cutoff still win.
    expect(where.tenantId).toBe(9);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });

  test('ENTITY_GUARDS shape is pinned — TravelInvoice only, allowlist form', () => {
    expect(Object.keys(ENTITY_GUARDS)).toEqual(['TravelInvoice']);
    expect(ENTITY_GUARDS.TravelInvoice).toEqual({ status: { in: ['Draft', 'Paid', 'Voided'] } });
  });

  test('a guard can never widen the sweep — tenantId/createdAt are spread after the guard', async () => {
    // Even if a (hypothetical, misconfigured) guard carried tenantId or
    // createdAt keys, the engine spreads the mandatory scoping LAST so
    // the policy's tenant + cutoff always apply. Pin via the real
    // TravelInvoice guard: tenantId in the final where equals the
    // policy's tenant, not anything guard-derived.
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 24, isActive: true, entity: 'TravelInvoice', tenantId: 314, retainDays: 2555 },
    ]);
    prisma.travelInvoice.deleteMany.mockResolvedValue({ count: 0 });

    await runRetentionSweep();
    const where = prisma.travelInvoice.deleteMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(314);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });
});

// ────────────────────────────────────────────────────────────────────
// Gap A4 (Q14) — seedTravelRetentionPolicies idempotent helper.
// ────────────────────────────────────────────────────────────────────
describe('seedTravelRetentionPolicies (gap A4 / Q14)', () => {
  test('creates the 4 default rows when none exist', async () => {
    prisma.retentionPolicy.findUnique.mockResolvedValue(null);
    prisma.retentionPolicy.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    const created = await seedTravelRetentionPolicies(42);

    expect(created.length).toBe(4);
    expect(created.map(r => r.entity).sort()).toEqual([
      'CallLog', 'ContactAttachment', 'TravelInvoice', 'VoiceSession',
    ]);
  });

  test('skips rows that already exist (idempotent — admin tweaks survive re-runs)', async () => {
    prisma.retentionPolicy.findUnique.mockImplementation(async ({ where }) => {
      const e = where.tenantId_entity.entity;
      return (e === 'CallLog' || e === 'TravelInvoice') ? { id: 1, entity: e } : null;
    });
    prisma.retentionPolicy.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    const created = await seedTravelRetentionPolicies(42);

    expect(created.length).toBe(2);
    expect(created.map(r => r.entity).sort()).toEqual(['ContactAttachment', 'VoiceSession']);
  });

  test('returns [] for falsy tenantId', async () => {
    expect(await seedTravelRetentionPolicies(null)).toEqual([]);
    expect(await seedTravelRetentionPolicies(0)).toEqual([]);
    expect(prisma.retentionPolicy.create).not.toHaveBeenCalled();
  });

  test('default windows match Q14: docs 24m, calls 12m, financial 84m; all isActive=false', () => {
    const byEntity = Object.fromEntries(TRAVEL_DEFAULT_POLICIES.map(p => [p.entity, p]));
    // 730 days = 24 months (passport/Aadhaar/PAN documents).
    expect(byEntity.ContactAttachment.retainDays).toBe(730);
    // 365 days = 12 months (call recordings, both telephony surfaces).
    expect(byEntity.CallLog.retainDays).toBe(365);
    expect(byEntity.VoiceSession.retainDays).toBe(365);
    // 2555 days = ~84 months / 7y (financial records).
    expect(byEntity.TravelInvoice.retainDays).toBe(2555);
    // Q14: diagnostic responses = lifetime of profile → NO policy row.
    expect(byEntity.TravelDiagnostic).toBeUndefined();
    expect(TRAVEL_DEFAULT_POLICIES.length).toBe(4);
    // isActive=false — admins must explicitly enable purge (mirrors the
    // wellness clinical-defaults convention).
    TRAVEL_DEFAULT_POLICIES.forEach(p => {
      expect(p.isActive).toBe(false);
    });
  });
});

describe('cron/retentionEngine — extended coverage (cont.)', () => {
  test('hard-delete entities report softDeleted=0 in summary (no double-counting)', async () => {
    // The summary shape always carries softDeleted, but for non-SOFT_DELETE
    // entities it must be 0 — never inherit a stale value from a prior loop
    // iteration or get set to the deleted count by accident.
    prisma.retentionPolicy.findMany.mockResolvedValue([
      { id: 1, isActive: true, entity: 'CallLog', tenantId: 1, retainDays: 60 },
      { id: 2, isActive: true, entity: 'Activity', tenantId: 1, retainDays: 90 },
    ]);
    prisma.callLog.deleteMany.mockResolvedValue({ count: 8 });
    prisma.activity.deleteMany.mockResolvedValue({ count: 3 });

    const summary = await runRetentionSweep();

    expect(summary).toHaveLength(2);
    summary.forEach(row => {
      expect(row.softDeleted).toBe(0);
    });
    // And the audit details mirror the same 0.
    const auditDetails = prisma.auditLog.create.mock.calls.map(c => JSON.parse(c[0].data.details));
    auditDetails.forEach(d => {
      expect(d.softDeleted).toBe(0);
    });
  });
});
