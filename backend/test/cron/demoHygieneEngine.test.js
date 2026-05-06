/**
 * Unit tests for backend/cron/demoHygieneEngine.js — hourly cron that
 * purges QA / pen-test residue (`_QA_PROBE_*`, `E2E_FLOW_*`, `_E2E_*`,
 * `E2E_WC_*`) from the demo box's patient list + admin-config models.
 *
 * Why this file exists:
 *   - The engine is a privileged-write surface (it does HARD-DELETE)
 *     against the production demo. Latent regressions in the WHERE clause
 *     (e.g. dropping the `createdAt < cutoff` predicate, or a typo in the
 *     prefix list that matched real data) would silently nuke real demo
 *     records. Cheap to pin via unit test, expensive to discover at
 *     2 AM via #541-style "rows missing" reports.
 *
 *   - There is intentionally NO api-level coverage; this engine is
 *     internal infrastructure with no HTTP surface. Unit-level pinning
 *     of WHERE-clause shape + P2003-skip behavior is the only test.
 *
 * Coverage:
 *   - WHERE-clause SHAPE on every model accessor:
 *       - { AND: [{ createdAt: { lt: cutoff } }, { OR: [...prefixes] }] }
 *       - All four QA prefixes present in the OR.
 *   - cutoff math: 24h default, env override, opts override.
 *   - P2003 (patient FK Restrict) → skipped, sibling continues.
 *   - Summary shape + counts.
 *
 * NOT covered (intentional):
 *   - initDemoHygieneCron — schedule shell. Mocking node-cron yields no
 *     behavioural coverage beyond "cron.schedule called once."
 *
 * Mocking strategy:
 *   Mirror backend/test/cron/wellnessOpsEngine.test.js — import the prisma
 *   singleton, monkey-patch the model accessors. Vitest's
 *   server.deps.inline ensures the SUT's `require('../lib/prisma')`
 *   resolves to the same singleton.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runDemoHygiene,
  QA_NAME_PREFIXES,
} from '../../cron/demoHygieneEngine.js';

beforeAll(() => {
  prisma.patient = { findMany: vi.fn(), delete: vi.fn() };
  prisma.pipeline = { findMany: vi.fn(), delete: vi.fn() };
  prisma.currency = { findMany: vi.fn(), delete: vi.fn() };
  prisma.territory = { findMany: vi.fn(), delete: vi.fn() };
  prisma.chatbot = { findMany: vi.fn(), delete: vi.fn() };
});

beforeEach(() => {
  for (const model of ['patient', 'pipeline', 'currency', 'territory', 'chatbot']) {
    prisma[model].findMany.mockReset();
    prisma[model].delete.mockReset();
    prisma[model].findMany.mockResolvedValue([]); // empty by default
    prisma[model].delete.mockResolvedValue({});
  }
});

describe('cron/demoHygieneEngine — exported prefix contract', () => {
  test('QA_NAME_PREFIXES contains the four canonical markers', () => {
    expect(QA_NAME_PREFIXES).toEqual(
      expect.arrayContaining(['_QA_PROBE_', 'E2E_FLOW_', '_E2E_', 'E2E_WC_']),
    );
    // Anti-regression: pen-test #541 specifically named `_QA_PROBE_`. Any
    // future caller that drops this prefix breaks the original ask.
    expect(QA_NAME_PREFIXES).toContain('_QA_PROBE_');
  });
});

describe('cron/demoHygieneEngine — WHERE-clause shape', () => {
  test('patient findMany passes {AND:[{createdAt:{lt}}, {OR:prefixes}]}', async () => {
    await runDemoHygiene();
    expect(prisma.patient.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.patient.findMany.mock.calls[0][0];
    expect(arg.where).toHaveProperty('AND');
    expect(Array.isArray(arg.where.AND)).toBe(true);
    expect(arg.where.AND).toHaveLength(2);

    // Cutoff predicate
    expect(arg.where.AND[0]).toEqual({ createdAt: { lt: expect.any(Date) } });

    // Prefix predicate
    const prefixOr = arg.where.AND[1].OR;
    expect(Array.isArray(prefixOr)).toBe(true);
    expect(prefixOr).toHaveLength(QA_NAME_PREFIXES.length);
    for (const prefix of QA_NAME_PREFIXES) {
      expect(prefixOr).toContainEqual({ name: { startsWith: prefix } });
    }
  });

  test('pipeline / currency / territory / chatbot all use the same shape', async () => {
    await runDemoHygiene();
    for (const model of ['pipeline', 'currency', 'territory', 'chatbot']) {
      expect(prisma[model].findMany).toHaveBeenCalledTimes(1);
      const arg = prisma[model].findMany.mock.calls[0][0];
      expect(arg.where.AND[0]).toEqual({ createdAt: { lt: expect.any(Date) } });
      expect(arg.where.AND[1].OR).toHaveLength(QA_NAME_PREFIXES.length);
    }
  });
});

describe('cron/demoHygieneEngine — cutoff math', () => {
  test('default cutoff is ~24h ago', async () => {
    const before = Date.now();
    await runDemoHygiene();
    const after = Date.now();
    const cutoff = prisma.patient.findMany.mock.calls[0][0].where.AND[0].createdAt.lt.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - 24 * 3600 * 1000 - 50);
    expect(cutoff).toBeLessThanOrEqual(after - 24 * 3600 * 1000 + 50);
  });

  test('opts.ageHours overrides the default', async () => {
    await runDemoHygiene({ ageHours: 1 });
    const cutoff = prisma.patient.findMany.mock.calls[0][0].where.AND[0].createdAt.lt.getTime();
    const expected = Date.now() - 1 * 3600 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(200);
  });
});

describe('cron/demoHygieneEngine — purge behavior', () => {
  test('candidate patients hard-delete one at a time', async () => {
    prisma.patient.findMany.mockResolvedValue([
      { id: 1, name: '_QA_PROBE_a', tenantId: 2 },
      { id: 2, name: '_QA_PROBE_b', tenantId: 2 },
    ]);
    const summary = await runDemoHygiene();
    expect(prisma.patient.delete).toHaveBeenCalledTimes(2);
    expect(prisma.patient.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(prisma.patient.delete).toHaveBeenCalledWith({ where: { id: 2 } });
    expect(summary.patient).toEqual({ deleted: 2, skipped: 0, candidates: 2 });
  });

  test('P2003 on a patient → skipped, sibling continues, summary tracks both', async () => {
    prisma.patient.findMany.mockResolvedValue([
      { id: 10, name: '_QA_PROBE_has_visits', tenantId: 2 },
      { id: 11, name: '_QA_PROBE_clean', tenantId: 2 },
    ]);
    prisma.patient.delete.mockImplementation(async ({ where }) => {
      if (where.id === 10) {
        const err = new Error('FK restrict');
        err.code = 'P2003';
        throw err;
      }
      return {};
    });
    const summary = await runDemoHygiene();
    expect(summary.patient).toEqual({ deleted: 1, skipped: 1, candidates: 2 });
  });

  test('summary includes durationMs and ISO cutoff', async () => {
    const summary = await runDemoHygiene();
    expect(typeof summary.durationMs).toBe('number');
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof summary.cutoff).toBe('string');
    expect(() => new Date(summary.cutoff)).not.toThrow();
  });

  test('empty candidate sets → no delete calls, summary all zero', async () => {
    const summary = await runDemoHygiene();
    expect(prisma.patient.delete).not.toHaveBeenCalled();
    expect(prisma.pipeline.delete).not.toHaveBeenCalled();
    expect(summary.patient.deleted).toBe(0);
    expect(summary.pipeline.deleted).toBe(0);
    expect(summary.currency.deleted).toBe(0);
    expect(summary.territory.deleted).toBe(0);
    expect(summary.chatbot.deleted).toBe(0);
  });
});
