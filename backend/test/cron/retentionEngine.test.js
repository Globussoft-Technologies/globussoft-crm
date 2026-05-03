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
import { runRetentionSweep } from '../../cron/retentionEngine.js';

beforeAll(() => {
  prisma.retentionPolicy = { findMany: vi.fn() };
  prisma.auditLog = { create: vi.fn() };
  prisma.emailMessage = { deleteMany: vi.fn() };
  prisma.callLog = { deleteMany: vi.fn() };
  prisma.activity = { deleteMany: vi.fn() };
  prisma.smsMessage = { deleteMany: vi.fn() };
  prisma.whatsAppMessage = { deleteMany: vi.fn() };
});

beforeEach(() => {
  prisma.retentionPolicy.findMany.mockReset();
  prisma.emailMessage.deleteMany.mockReset();
  prisma.callLog.deleteMany.mockReset();
  prisma.activity.deleteMany.mockReset();
  prisma.smsMessage.deleteMany.mockReset();
  prisma.whatsAppMessage.deleteMany.mockReset();
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
