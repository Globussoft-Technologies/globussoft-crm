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
  ENTITY_MAP,
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
