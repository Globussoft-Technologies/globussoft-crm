/**
 * Unit tests for backend/cron/visaRiskFlagEngine.js — Visa Sure
 * risk-flagging cron SHELL (PRD Phase 3 §3 FR-3, rows V5-V7, cluster B3).
 *
 * Mirrors the travelDiagnosticAdvisorAlerts.test.js scaffold (prisma
 * model mocking via vi.fn + per-test reset).
 *
 * Branches covered:
 *   runRiskFlaggingForTenant:
 *     - return-shape: { evaluated, flagged } per the SHELL contract
 *     - query shape: tenant + status in {pending, intake, docs-pending, docs-collected}
 *     - happy path: 1 complex-type application → flagged, notification created
 *     - dedup: existing warning notification → not re-flagged
 *     - non-risk application: simple tourist + no flags → evaluated but not flagged
 *     - rejection-history JSON parse: non-empty array → flagged
 *     - rejection-history JSON parse: malformed → degrades gracefully (no crash)
 *
 *   evaluateRiskShell (pure-function tests):
 *     - applicationType=work → flag
 *     - readinessLevel=4 → flag
 *     - advisorRiskFlag=priority → flag
 *     - applicationType=tourist + everything else null → no flag
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runRiskFlaggingForTenant,
  evaluateRiskShell,
} from '../../cron/visaRiskFlagEngine.js';

beforeAll(() => {
  prisma.visaApplication = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
});

beforeEach(() => {
  prisma.visaApplication.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();

  prisma.visaApplication.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
});

describe('cron/visaRiskFlagEngine — runRiskFlaggingForTenant', () => {
  test('return-shape: { evaluated, flagged } on empty input', async () => {
    prisma.visaApplication.findMany.mockResolvedValue([]);
    const result = await runRiskFlaggingForTenant(1);
    expect(result).toEqual({ evaluated: 0, flagged: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('query shape: tenantId + status in pending/intake/docs-pending/docs-collected', async () => {
    await runRiskFlaggingForTenant(42);
    const arg = prisma.visaApplication.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.status).toEqual({
      in: ['pending', 'intake', 'docs-pending', 'docs-collected'],
    });
  });

  test('happy path: complex-type application → flagged, notification created', async () => {
    prisma.visaApplication.findMany.mockResolvedValue([
      {
        id: 100,
        applicationType: 'work', // complex per FR-3.1(a)
        destinationCountry: 'US',
        status: 'intake',
        readinessLevel: 2,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        contactId: 200,
      },
    ]);

    const result = await runRiskFlaggingForTenant(1);
    expect(result).toEqual({ evaluated: 1, flagged: 1 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);

    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(1);
    expect(createArg.data.entityType).toBe('VisaApplication');
    expect(createArg.data.entityId).toBe(100);
    expect(createArg.data.type).toBe('warning');
    expect(createArg.data.priority).toBe('high');
  });

  test('dedup: existing warning notification → evaluated but no second create', async () => {
    prisma.visaApplication.findMany.mockResolvedValue([
      {
        id: 100,
        applicationType: 'work',
        destinationCountry: 'US',
        status: 'intake',
        readinessLevel: 4,
        complexCase: true,
        rejectionHistoryJson: null,
        advisorRiskFlag: 'high',
        contactId: 200,
      },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 999 });

    const result = await runRiskFlaggingForTenant(1);
    expect(result.evaluated).toBe(1);
    expect(result.flagged).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('non-risk application: simple tourist + no flags → evaluated but not flagged', async () => {
    prisma.visaApplication.findMany.mockResolvedValue([
      {
        id: 100,
        applicationType: 'tourist', // NOT in complex set
        destinationCountry: 'TH',
        status: 'intake',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        contactId: 200,
      },
    ]);

    const result = await runRiskFlaggingForTenant(1);
    expect(result).toEqual({ evaluated: 1, flagged: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('rejection-history JSON: non-empty array → flagged', async () => {
    prisma.visaApplication.findMany.mockResolvedValue([
      {
        id: 100,
        applicationType: 'tourist',
        destinationCountry: 'US',
        status: 'intake',
        readinessLevel: 2,
        complexCase: false,
        rejectionHistoryJson: JSON.stringify([
          { country: 'US', date: '2024-01-01', reason: 'incomplete docs' },
        ]),
        advisorRiskFlag: null,
        contactId: 200,
      },
    ]);

    const result = await runRiskFlaggingForTenant(1);
    expect(result).toEqual({ evaluated: 1, flagged: 1 });
    const msg = prisma.notification.create.mock.calls[0][0].data.message;
    expect(msg).toContain('rejection-history:1');
  });

  test('rejection-history JSON: malformed → degrades gracefully (no crash, no flag from that signal)', async () => {
    prisma.visaApplication.findMany.mockResolvedValue([
      {
        id: 100,
        applicationType: 'tourist', // not complex
        destinationCountry: 'TH',
        status: 'intake',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: '{ not valid json', // malformed
        advisorRiskFlag: null,
        contactId: 200,
      },
    ]);

    const result = await runRiskFlaggingForTenant(1);
    // No crash; no other signals fire → not flagged
    expect(result).toEqual({ evaluated: 1, flagged: 0 });
  });

  test('multiple applications: only the risky ones get notifications', async () => {
    prisma.visaApplication.findMany.mockResolvedValue([
      // Risky — work type
      { id: 100, applicationType: 'work', destinationCountry: 'US', status: 'intake', readinessLevel: 2, complexCase: false, rejectionHistoryJson: null, advisorRiskFlag: null, contactId: 200 },
      // Not risky — tourist + no flags
      { id: 101, applicationType: 'tourist', destinationCountry: 'TH', status: 'intake', readinessLevel: 1, complexCase: false, rejectionHistoryJson: null, advisorRiskFlag: null, contactId: 201 },
      // Risky — readinessLevel 4
      { id: 102, applicationType: 'tourist', destinationCountry: 'TH', status: 'docs-pending', readinessLevel: 4, complexCase: false, rejectionHistoryJson: null, advisorRiskFlag: null, contactId: 202 },
    ]);

    const result = await runRiskFlaggingForTenant(1);
    expect(result.evaluated).toBe(3);
    expect(result.flagged).toBe(2);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });
});

describe('cron/visaRiskFlagEngine — evaluateRiskShell pure-function', () => {
  test('applicationType=work → flag (complex-type)', () => {
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'work',
      readinessLevel: null,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: null,
    });
    expect(flag).toBe(true);
    expect(reasons).toContain('complex-type:work');
  });

  test('readinessLevel=4 → flag', () => {
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      readinessLevel: 4,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: null,
    });
    expect(flag).toBe(true);
    expect(reasons).toContain('readiness-level-4');
  });

  test('advisorRiskFlag=priority → flag', () => {
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: 'priority',
    });
    expect(flag).toBe(true);
    expect(reasons).toContain('flag:priority');
  });

  test('tourist + everything else null → no flag', () => {
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: null,
    });
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });
});
