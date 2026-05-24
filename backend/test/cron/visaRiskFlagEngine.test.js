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
 *     - applicationType=work → flag (R1)
 *     - readinessLevel=4 → flag (R4)
 *     - advisorRiskFlag=priority → flag (R5)
 *     - applicationType=tourist + everything else null → no flag
 *     - R6 docs-incomplete: required + status≠verified + status∈{docs-pending|collected} → flag
 *     - R6 docs-incomplete: all required verified → no flag from this signal
 *     - R6 docs-incomplete: required-unverified BUT status=intake → no flag (status gate)
 *     - R7 stale-application: updatedAt > 14d ago + status=docs-collected → flag
 *     - R7 stale-application: recent updatedAt → no flag from this signal
 *     - R7 stale-application: old updatedAt BUT status=intake → no flag (status gate)
 *     - R8 stale-intake: status=intake + createdAt >7d → flag
 *     - R8 stale-intake: status=intake + recent createdAt → no flag
 *     - R8 stale-intake: old createdAt BUT status=docs-pending → no flag (status gate)
 *     - R9 rejected-reopen: outcome=rejected + updatedAt > decidedAt+grace + within 30d → flag
 *     - R9 rejected-reopen: outcome=rejected + updatedAt ≤ decidedAt+grace → no flag
 *     - R9 rejected-reopen: outcome=rejected + updatedAt > 30d ago → no flag (window expired)
 *     - R9 rejected-reopen: outcome≠rejected → no flag
 *     - R10 new-destination: context.knownDestinations omitted → no flag (back-compat)
 *     - R10 new-destination: destinationCountry NOT in knownDestinations → flag
 *     - R10 new-destination: destinationCountry IN knownDestinations → no flag
 *     - R11 complex-stale: complexCase=true + updatedAt >5d → flag (fires alongside R2)
 *     - R11 complex-stale: complexCase=true + recent updatedAt → no R11 flag (R2 still fires)
 *     - R11 complex-stale: complexCase=false + old updatedAt → no flag (complexCase gate)
 *     - R12 high-rejection-history: parsed length ≥ 2 → flag (fires alongside R3)
 *     - R12 high-rejection-history: parsed length = 1 → R3 only, no R12 escalation
 *     - R12 high-rejection-history: parsed length = 3 → both R3 + R12 fire with correct counts
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runRiskFlaggingForTenant,
  evaluateRiskShell,
  evaluateCooldownR13,
} from '../../cron/visaRiskFlagEngine.js';

beforeAll(() => {
  prisma.visaApplication = { findMany: vi.fn(), findUnique: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  prisma.embassyRule = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.visaApplication.findMany.mockReset();
  prisma.visaApplication.findUnique.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.embassyRule.findFirst.mockReset();

  prisma.visaApplication.findMany.mockResolvedValue([]);
  prisma.visaApplication.findUnique.mockResolvedValue(null);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.embassyRule.findFirst.mockResolvedValue(null);
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

  // ── R6 docs-incomplete ─────────────────────────────────────────────

  test('R6 docs-incomplete: required + status≠verified + status=docs-pending → flag', () => {
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      status: 'docs-pending',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: null,
      documentChecklist: [
        { id: 1, required: true, status: 'pending' },
        { id: 2, required: true, status: 'uploaded' },
        { id: 3, required: true, status: 'verified' },
        { id: 4, required: false, status: 'pending' }, // optional → ignored
      ],
    });
    expect(flag).toBe(true);
    // 2 required-unverified (pending + uploaded); optional + verified ignored
    expect(reasons).toContain('docs-incomplete:2');
  });

  test('R6 docs-incomplete: all required verified → no flag from this signal', () => {
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      status: 'docs-collected',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: null,
      documentChecklist: [
        { id: 1, required: true, status: 'verified' },
        { id: 2, required: true, status: 'verified' },
        { id: 3, required: false, status: 'pending' },
      ],
    });
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('R6 docs-incomplete: required-unverified BUT status=intake → no flag (status gate)', () => {
    // Intake status is too early to surface docs-incomplete — the
    // checklist isn't expected to be complete yet at intake.
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      status: 'intake',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: null,
      documentChecklist: [
        { id: 1, required: true, status: 'pending' },
      ],
    });
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  // ── R7 stale-application ───────────────────────────────────────────

  test('R7 stale-application: updatedAt > 14d ago + status=docs-collected → flag', () => {
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const OLD = new Date('2026-05-01T00:00:00Z'); // ~22 days before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'docs-collected',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        updatedAt: OLD,
      },
      NOW,
    );
    expect(flag).toBe(true);
    expect(reasons).toContain('stale-application:14d');
  });

  test('R7 stale-application: recent updatedAt → no flag from this signal', () => {
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const RECENT = new Date('2026-05-20T00:00:00Z'); // 3 days before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'docs-collected',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        updatedAt: RECENT,
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('R7 stale-application: old updatedAt BUT status=intake → no flag from R7 (status gate)', () => {
    // Stale-dwell only fires in docs-pending / docs-collected; intake
    // pre-dates the checklist gate so R7's threshold isn't meaningful.
    // Note: status=intake + old createdAt would trigger R8; this test
    // omits createdAt so only R7 is under test.
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const OLD = new Date('2026-04-01T00:00:00Z'); // 52d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'intake',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        updatedAt: OLD,
        // createdAt deliberately omitted so R8 doesn't fire either
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  // ── R8 stale-intake ────────────────────────────────────────────────

  test('R8 stale-intake: status=intake + createdAt >7d ago → flag', () => {
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const OLD_CREATE = new Date('2026-05-10T00:00:00Z'); // 13d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'intake',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        createdAt: OLD_CREATE,
      },
      NOW,
    );
    expect(flag).toBe(true);
    expect(reasons).toContain('stale-intake:7d');
  });

  test('R8 stale-intake: status=intake + recent createdAt (<7d) → no flag', () => {
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const RECENT_CREATE = new Date('2026-05-20T00:00:00Z'); // 3d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'intake',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        createdAt: RECENT_CREATE,
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('R8 stale-intake: old createdAt BUT status=docs-pending → no flag (status gate)', () => {
    // R8 fires only when status=intake. A docs-pending app with an old
    // createdAt is the territory of R7 (driven by updatedAt), not R8.
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const OLD_CREATE = new Date('2026-05-01T00:00:00Z'); // 22d before NOW
    const RECENT_UPDATE = new Date('2026-05-22T00:00:00Z'); // 1d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'docs-pending',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        createdAt: OLD_CREATE,
        updatedAt: RECENT_UPDATE, // not stale by R7 either
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  // ── R9 rejected-reopen ─────────────────────────────────────────────

  test('R9 rejected-reopen: outcome=rejected + updatedAt > decidedAt+grace + within 30d → flag', () => {
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const DECIDED = new Date('2026-05-01T00:00:00Z'); // 22d before NOW
    const TOUCHED = new Date('2026-05-15T00:00:00Z'); // 8d before NOW, 14d after decided
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'docs-pending', // re-opened — back in flight
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        outcome: 'rejected',
        decidedAt: DECIDED,
        updatedAt: TOUCHED,
      },
      NOW,
    );
    expect(flag).toBe(true);
    expect(reasons).toContain('rejected-reopen:30d');
  });

  test('R9 rejected-reopen: outcome=rejected + updatedAt = decidedAt (within grace) → no flag', () => {
    // The natural status-write that records the rejection sets
    // updatedAt = decidedAt (same transaction). Within the 1-minute
    // grace, that's not evidence of an active re-open.
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const DECIDED = new Date('2026-05-15T00:00:00Z');
    const TOUCHED = new Date('2026-05-15T00:00:30Z'); // 30s after — within grace
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'docs-pending',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        outcome: 'rejected',
        decidedAt: DECIDED,
        updatedAt: TOUCHED,
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('R9 rejected-reopen: outcome=rejected + updatedAt >30d ago → no flag (window expired)', () => {
    // Old re-open touch — advisor has moved on, no longer active recovery.
    // Note: status='pending' deliberately to keep R7 quiet (R7 fires on
    // docs-pending/docs-collected). This test isolates R9's window gate.
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const DECIDED = new Date('2026-03-01T00:00:00Z');
    const TOUCHED = new Date('2026-03-15T00:00:00Z'); // 69d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'pending', // not in STALE_STATUSES; R7 won't fire
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        outcome: 'rejected',
        decidedAt: DECIDED,
        updatedAt: TOUCHED,
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('R9 rejected-reopen: outcome≠rejected → no flag (outcome gate)', () => {
    // An approved application with recent touch is normal post-decide
    // activity (e.g. uploading post-approval docs), not a re-open.
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const DECIDED = new Date('2026-05-01T00:00:00Z');
    const TOUCHED = new Date('2026-05-15T00:00:00Z');
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'docs-pending',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        outcome: 'approved',
        decidedAt: DECIDED,
        updatedAt: TOUCHED,
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  // ── R10 new-destination ────────────────────────────────────────────

  test('R10 new-destination: context.knownDestinations omitted → no flag (back-compat)', () => {
    // Pure-function callers (e.g. existing unit tests) that don't set
    // up context must not see R10 fire — keeps the test suite stable.
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      destinationCountry: 'PT', // not in any set
      status: 'intake',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: null,
      advisorRiskFlag: null,
    });
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('R10 new-destination: destinationCountry NOT in knownDestinations → flag', () => {
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        destinationCountry: 'PT', // never filed for before
        status: 'intake',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
      },
      NOW,
      { knownDestinations: new Set(['US', 'UK', 'AE']) },
    );
    expect(flag).toBe(true);
    expect(reasons).toContain('new-destination:PT');
  });

  test('R10 new-destination: destinationCountry IN knownDestinations → no flag', () => {
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        destinationCountry: 'US', // already in the set
        status: 'intake',
        readinessLevel: 1,
        complexCase: false,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
      },
      NOW,
      { knownDestinations: new Set(['US', 'UK', 'AE']) },
    );
    expect(flag).toBe(false);
    expect(reasons).toEqual([]);
  });

  // ── R11 complex-stale ──────────────────────────────────────────────

  test('R11 complex-stale: complexCase=true + updatedAt >5d → flag (fires alongside R2)', () => {
    // 7d ago — past the 5d COMPLEX_STALE_DAYS threshold. R2 (complex-case)
    // fires from the column presence; R11 (complex-stale) escalates with
    // a neglect-risk reason. Both reasons land in the list together.
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const UPDATED = new Date('2026-05-16T00:00:00Z'); // 7d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'pending', // keep R7 quiet (R7 fires on docs-pending/docs-collected)
        readinessLevel: 1,
        complexCase: true,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        updatedAt: UPDATED,
      },
      NOW,
    );
    expect(flag).toBe(true);
    expect(reasons).toContain('complex-case'); // R2 sanity
    expect(reasons).toContain('complex-stale:5d'); // R11
  });

  test('R11 complex-stale: complexCase=true + recent updatedAt → R2 only, no R11 escalation', () => {
    // 2d ago — well within the 5d threshold. R2 still fires (complex-case
    // column presence), but R11's neglect signal does NOT.
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const UPDATED = new Date('2026-05-21T00:00:00Z'); // 2d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'pending',
        readinessLevel: 1,
        complexCase: true,
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        updatedAt: UPDATED,
      },
      NOW,
    );
    expect(flag).toBe(true); // R2 still fires
    expect(reasons).toContain('complex-case');
    expect(reasons).not.toContain('complex-stale:5d');
  });

  test('R11 complex-stale: complexCase=false + old updatedAt → no R11 flag (complexCase gate)', () => {
    // Old updatedAt on a NON-complex case → R11 must not fire. R7 stays
    // quiet because status is 'pending' (not docs-pending/docs-collected).
    const NOW = new Date('2026-05-23T00:00:00Z').getTime();
    const UPDATED = new Date('2026-05-01T00:00:00Z'); // 22d before NOW
    const { flag, reasons } = evaluateRiskShell(
      {
        applicationType: 'tourist',
        status: 'pending',
        readinessLevel: 1,
        complexCase: false, // gate closed
        rejectionHistoryJson: null,
        advisorRiskFlag: null,
        updatedAt: UPDATED,
      },
      NOW,
    );
    expect(flag).toBe(false);
    expect(reasons).not.toContain('complex-stale:5d');
  });

  // ── R12 high-rejection-history ─────────────────────────────────────

  test('R12 high-rejection-history: parsed length ≥ 2 → flag (fires alongside R3)', () => {
    // 2 prior rejections crosses HIGH_REJECTION_HISTORY_THRESHOLD. Both
    // R3 (base history signal) and R12 (severity escalation) land in
    // the reason list, surfacing this applicant as a compounding-risk
    // case to the advisor queue.
    const history = [
      { country: 'US', date: '2024-01-01', reason: 'incomplete docs' },
      { country: 'UK', date: '2024-06-01', reason: 'insufficient ties' },
    ];
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: JSON.stringify(history),
      advisorRiskFlag: null,
    });
    expect(flag).toBe(true);
    expect(reasons).toContain('rejection-history:2'); // R3
    expect(reasons).toContain('high-rejection-history:2'); // R12
  });

  test('R12 high-rejection-history: parsed length = 1 → R3 fires, R12 does NOT escalate', () => {
    // Single prior rejection — R3 base signal fires, but the severity
    // tier (≥2) is not crossed, so R12 stays quiet.
    const history = [
      { country: 'US', date: '2024-01-01', reason: 'incomplete docs' },
    ];
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: JSON.stringify(history),
      advisorRiskFlag: null,
    });
    expect(flag).toBe(true); // R3 still fires
    expect(reasons).toContain('rejection-history:1');
    expect(reasons).not.toContain('high-rejection-history:1');
  });

  test('R12 high-rejection-history: parsed length = 3 → both R3 + R12 fire with correct counts', () => {
    // Three prior rejections — both reasons carry the actual count so
    // advisor-queue sorting / dashboards can rank by severity tier AND
    // raw count. Pins the format contract (`:${len}` suffix on both).
    const history = [
      { country: 'US', date: '2023-01-01', reason: 'incomplete docs' },
      { country: 'UK', date: '2023-06-01', reason: 'insufficient ties' },
      { country: 'CA', date: '2024-03-01', reason: 'misrepresentation' },
    ];
    const { flag, reasons } = evaluateRiskShell({
      applicationType: 'tourist',
      readinessLevel: 1,
      complexCase: false,
      rejectionHistoryJson: JSON.stringify(history),
      advisorRiskFlag: null,
    });
    expect(flag).toBe(true);
    expect(reasons).toContain('rejection-history:3');
    expect(reasons).toContain('high-rejection-history:3');
  });
});

// ── R13 rejection-recovery cooldown enforcement (PC-4 RESOLVED 2026-05-24) ─
//
// Async rule because it needs two prisma lookups (prior app + EmbassyRule
// for the cooldown period). Tests pass a stub prismaClient directly to
// `evaluateCooldownR13` so they don't depend on the module-level prisma
// mock. Time-window assertions pin a fixed `now` Unix-ms value and a
// fixed `priorApp.decidedAt` ISO string — no fake timers needed because
// the function is pure aside from the injected prisma client.
describe('cron/visaRiskFlagEngine — R13 evaluateCooldownR13 (cooldown)', () => {
  const FIXED_NOW = new Date('2026-05-24T00:00:00Z').getTime();

  function stubPrisma({ priorApp = null, rule = null } = {}) {
    return {
      visaApplication: {
        findUnique: vi.fn().mockResolvedValue(priorApp),
      },
      embassyRule: {
        findFirst: vi.fn().mockResolvedValue(rule),
      },
    };
  }

  test('R13 fires: prior rejected + cooldown not elapsed → cooldown reason with ISO date', async () => {
    // priorApp decided 30 days before NOW; rule says 90-day cooldown →
    // cooldownEnd is 60 days AFTER NOW → R13 fires.
    const decidedAt = new Date('2026-04-24T00:00:00Z'); // 30d before NOW
    const stub = stubPrisma({
      priorApp: {
        id: 50,
        destinationCountry: 'US',
        outcome: 'rejected',
        status: 'rejected',
        decidedAt,
      },
      rule: {
        conditionJson: JSON.stringify({ days: 90 }),
        severity: 'warning',
      },
    });

    const result = await evaluateCooldownR13(
      { id: 100, tenantId: 1, priorApplicationId: 50 },
      FIXED_NOW,
      stub,
    );

    // cooldownEnd = decidedAt + 90d = 2026-07-23
    expect(result).toEqual({ reason: 'cooldown:until-2026-07-23' });
    expect(stub.visaApplication.findUnique).toHaveBeenCalledWith({
      where: { id: 50 },
      select: expect.objectContaining({
        id: true,
        destinationCountry: true,
        outcome: true,
        status: true,
        decidedAt: true,
      }),
    });
    expect(stub.embassyRule.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        destinationCountry: 'US',
        ruleType: 'cooldown_period',
        isActive: true,
      },
      select: { conditionJson: true, severity: true },
    });
  });

  test('R13 silent: prior rejected + cooldown elapsed → no flag', async () => {
    // priorApp decided 120 days before NOW; rule says 90-day cooldown →
    // cooldownEnd is 30 days BEFORE NOW → cooldown satisfied, no flag.
    const decidedAt = new Date('2026-01-24T00:00:00Z'); // 120d before NOW
    const stub = stubPrisma({
      priorApp: {
        id: 50,
        destinationCountry: 'US',
        outcome: 'rejected',
        status: 'rejected',
        decidedAt,
      },
      rule: {
        conditionJson: JSON.stringify({ days: 90 }),
        severity: 'warning',
      },
    });

    const result = await evaluateCooldownR13(
      { id: 100, tenantId: 1, priorApplicationId: 50 },
      FIXED_NOW,
      stub,
    );

    expect(result).toEqual({ reason: null });
  });

  test('R13 silent: no priorApplicationId on the app → no lookup, no flag', async () => {
    const stub = stubPrisma();
    const result = await evaluateCooldownR13(
      { id: 100, tenantId: 1, priorApplicationId: null },
      FIXED_NOW,
      stub,
    );
    expect(result).toEqual({ reason: null });
    expect(stub.visaApplication.findUnique).not.toHaveBeenCalled();
    expect(stub.embassyRule.findFirst).not.toHaveBeenCalled();
  });

  test('R13 silent: priorApp loaded but outcome ≠ rejected → no flag', async () => {
    // App linked to a prior application but the prior was approved, not
    // rejected — so cooldown enforcement is N/A.
    const stub = stubPrisma({
      priorApp: {
        id: 50,
        destinationCountry: 'US',
        outcome: 'approved',
        status: 'approved',
        decidedAt: new Date('2026-04-24T00:00:00Z'),
      },
    });

    const result = await evaluateCooldownR13(
      { id: 100, tenantId: 1, priorApplicationId: 50 },
      FIXED_NOW,
      stub,
    );

    expect(result).toEqual({ reason: null });
    expect(stub.embassyRule.findFirst).not.toHaveBeenCalled();
  });

  test('R13 silent: no EmbassyRule for destination → no flag', async () => {
    // Prior was rejected for a destination that has no configured
    // cooldown rule — so we can't enforce a window. Silent skip.
    const stub = stubPrisma({
      priorApp: {
        id: 50,
        destinationCountry: 'PT', // no rule configured
        outcome: 'rejected',
        status: 'rejected',
        decidedAt: new Date('2026-04-24T00:00:00Z'),
      },
      rule: null,
    });

    const result = await evaluateCooldownR13(
      { id: 100, tenantId: 1, priorApplicationId: 50 },
      FIXED_NOW,
      stub,
    );

    expect(result).toEqual({ reason: null });
  });

  test('R13 silent: EmbassyRule conditionJson is malformed → no flag, no crash', async () => {
    // Operator-side data quality issue: the rule row exists but the
    // conditionJson can't be parsed. R13 silently degrades instead of
    // throwing — the engine continues processing other rules / apps.
    const stub = stubPrisma({
      priorApp: {
        id: 50,
        destinationCountry: 'US',
        outcome: 'rejected',
        status: 'rejected',
        decidedAt: new Date('2026-04-24T00:00:00Z'),
      },
      rule: {
        conditionJson: '{ not valid json',
        severity: 'warning',
      },
    });

    const result = await evaluateCooldownR13(
      { id: 100, tenantId: 1, priorApplicationId: 50 },
      FIXED_NOW,
      stub,
    );

    expect(result).toEqual({ reason: null });
  });

  test('R13 silent: conditionJson parses but days is not a positive number → no flag', async () => {
    // Defensive against `{days: "ninety"}` or `{days: -5}` or `{days: 0}` —
    // the cooldown logic requires a strictly-positive finite number.
    const stub = stubPrisma({
      priorApp: {
        id: 50,
        destinationCountry: 'US',
        outcome: 'rejected',
        status: 'rejected',
        decidedAt: new Date('2026-04-24T00:00:00Z'),
      },
      rule: {
        conditionJson: JSON.stringify({ days: 'ninety' }),
        severity: 'warning',
      },
    });

    const result = await evaluateCooldownR13(
      { id: 100, tenantId: 1, priorApplicationId: 50 },
      FIXED_NOW,
      stub,
    );

    expect(result).toEqual({ reason: null });
  });
});
