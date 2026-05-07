/**
 * Unit tests for backend/cron/demoHygieneEngine.js — hourly cron that
 * purges QA / pen-test residue (`_QA_PROBE_*`, `E2E_FLOW_*`, `_E2E_*`,
 * `E2E_WC_*`, `E2E_SLA_*`, `e2e_audit_*`, `e2e_flow_*`) from the demo
 * box's customer-facing screens.
 *
 * Why this file exists:
 *   - The engine is a privileged-write surface (it does HARD-DELETE)
 *     against the production demo. Latent regressions in the WHERE clause
 *     (e.g. dropping the `createdAt < cutoff` predicate, or a typo in the
 *     prefix list that matched real data) would silently nuke real demo
 *     records. Cheap to pin via unit test, expensive to discover at
 *     2 AM via #541 / #578-style "rows missing" reports.
 *
 *   - There is intentionally NO api-level coverage; this engine is
 *     internal infrastructure with no HTTP surface. Unit-level pinning
 *     of WHERE-clause shape + P2003-skip behavior is the only test.
 *
 * Coverage:
 *   - Prefix contract — all seven canonical markers exported.
 *   - WHERE-clause SHAPE on every model accessor:
 *       - { AND: [{ <dateField>: { lt: cutoff } }, { OR: [...prefixes] }] }
 *       - All seven QA prefixes present in the OR.
 *       - Field-by-field correctness: name vs title vs subject.
 *   - MarketplaceLead's name-OR-email special-case shape.
 *   - cutoff math: 24h default, opts override.
 *   - P2003 (patient FK Restrict) → skipped, sibling continues.
 *   - Summary shape + counts across all 12 models.
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

// All 12 models the engine sweeps. Field column tracks WHICH text field
// the engine searches on for that model — this MUST match the
// purgeNamedModel(...textField) call sites in the engine.
const SWEPT_MODELS = [
  // Original 5 (#541 / #405)
  { model: 'patient', field: 'name' },
  { model: 'pipeline', field: 'name' },
  { model: 'currency', field: 'name' },
  { model: 'territory', field: 'name' },
  { model: 'chatbot', field: 'name' },
  // #578 widening — 7 new customer-facing surfaces
  { model: 'slaPolicy', field: 'name' },
  { model: 'task', field: 'title' },
  { model: 'agentRecommendation', field: 'title' },
  { model: 'landingPage', field: 'title' },
  { model: 'ticket', field: 'subject' },
  { model: 'emailMessage', field: 'subject' },
  // marketplaceLead has a special-case (name OR email) shape — covered
  // separately below.
  { model: 'marketplaceLead', field: '__special__' },
];

beforeAll(() => {
  for (const { model } of SWEPT_MODELS) {
    prisma[model] = { findMany: vi.fn(), delete: vi.fn() };
  }
});

beforeEach(() => {
  for (const { model } of SWEPT_MODELS) {
    prisma[model].findMany.mockReset();
    prisma[model].delete.mockReset();
    prisma[model].findMany.mockResolvedValue([]); // empty by default
    prisma[model].delete.mockResolvedValue({});
  }
});

describe('cron/demoHygieneEngine — exported prefix contract', () => {
  test('QA_NAME_PREFIXES contains the seven canonical markers', () => {
    // Anti-regression: pen-test #541 specifically named `_QA_PROBE_`.
    // Pen-test #578 added the lowercase variants and SLA/SCREAMING_CASE
    // ones. Any future caller that drops one breaks the original ask.
    expect(QA_NAME_PREFIXES).toEqual(
      expect.arrayContaining([
        '_QA_PROBE_',
        'E2E_FLOW_',
        '_E2E_',
        'E2E_WC_',
        'E2E_SLA_',
        'e2e_audit_',
        'e2e_flow_',
      ]),
    );
    expect(QA_NAME_PREFIXES).toContain('_QA_PROBE_');
    expect(QA_NAME_PREFIXES).toHaveLength(7);
  });
});

describe('cron/demoHygieneEngine — WHERE-clause shape (name field)', () => {
  test('patient findMany passes {AND:[{createdAt:{lt}}, {OR:prefixes-on-name}]}', async () => {
    await runDemoHygiene();
    expect(prisma.patient.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.patient.findMany.mock.calls[0][0];
    expect(arg.where).toHaveProperty('AND');
    expect(Array.isArray(arg.where.AND)).toBe(true);
    expect(arg.where.AND).toHaveLength(2);

    // Cutoff predicate
    expect(arg.where.AND[0]).toEqual({ createdAt: { lt: expect.any(Date) } });

    // Prefix predicate on `name`
    const prefixOr = arg.where.AND[1].OR;
    expect(Array.isArray(prefixOr)).toBe(true);
    expect(prefixOr).toHaveLength(QA_NAME_PREFIXES.length);
    for (const prefix of QA_NAME_PREFIXES) {
      expect(prefixOr).toContainEqual({ name: { startsWith: prefix } });
    }
  });

  test('pipeline / currency / territory / chatbot / slaPolicy all use the name field', async () => {
    await runDemoHygiene();
    for (const model of ['pipeline', 'currency', 'territory', 'chatbot', 'slaPolicy']) {
      expect(prisma[model].findMany).toHaveBeenCalledTimes(1);
      const arg = prisma[model].findMany.mock.calls[0][0];
      expect(arg.where.AND[0]).toEqual({ createdAt: { lt: expect.any(Date) } });
      const orList = arg.where.AND[1].OR;
      expect(orList).toHaveLength(QA_NAME_PREFIXES.length);
      // Every clause keys on `name`, not title/subject
      for (const clause of orList) {
        expect(Object.keys(clause)).toEqual(['name']);
      }
    }
  });
});

describe('cron/demoHygieneEngine — WHERE-clause shape (title field, #578)', () => {
  test('task / agentRecommendation / landingPage all sweep on the title field', async () => {
    await runDemoHygiene();
    for (const model of ['task', 'agentRecommendation', 'landingPage']) {
      expect(prisma[model].findMany).toHaveBeenCalledTimes(1);
      const arg = prisma[model].findMany.mock.calls[0][0];
      expect(arg.where.AND[0]).toEqual({ createdAt: { lt: expect.any(Date) } });
      const orList = arg.where.AND[1].OR;
      expect(orList).toHaveLength(QA_NAME_PREFIXES.length);
      // Every clause keys on `title` — NOT name (would miss the surfaces)
      // and NOT subject (would crash Prisma).
      for (const clause of orList) {
        expect(Object.keys(clause)).toEqual(['title']);
      }
      // Spot-check: every prefix is present
      for (const prefix of QA_NAME_PREFIXES) {
        expect(orList).toContainEqual({ title: { startsWith: prefix } });
      }
    }
  });
});

describe('cron/demoHygieneEngine — WHERE-clause shape (subject field, #578)', () => {
  test('ticket / emailMessage sweep on the subject field', async () => {
    await runDemoHygiene();
    for (const model of ['ticket', 'emailMessage']) {
      expect(prisma[model].findMany).toHaveBeenCalledTimes(1);
      const arg = prisma[model].findMany.mock.calls[0][0];
      expect(arg.where.AND[0]).toEqual({ createdAt: { lt: expect.any(Date) } });
      const orList = arg.where.AND[1].OR;
      expect(orList).toHaveLength(QA_NAME_PREFIXES.length);
      for (const clause of orList) {
        expect(Object.keys(clause)).toEqual(['subject']);
      }
      for (const prefix of QA_NAME_PREFIXES) {
        expect(orList).toContainEqual({ subject: { startsWith: prefix } });
      }
    }
  });
});

describe('cron/demoHygieneEngine — MarketplaceLead special-case (name OR email)', () => {
  test('marketplaceLead findMany OR-joins prefix-on-name with prefix-on-email', async () => {
    await runDemoHygiene();
    expect(prisma.marketplaceLead.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.marketplaceLead.findMany.mock.calls[0][0];
    expect(arg.where.AND[0]).toEqual({ createdAt: { lt: expect.any(Date) } });

    // The OR list has 2 * QA_NAME_PREFIXES.length entries: one set for
    // `name` and one set for `email`. Issue #578 specifically reported
    // `e2e_audit_…@example.com` on /marketplace-leads — the email-prefix
    // half of this filter is what catches that surface.
    const orList = arg.where.AND[1].OR;
    expect(orList).toHaveLength(QA_NAME_PREFIXES.length * 2);
    for (const prefix of QA_NAME_PREFIXES) {
      expect(orList).toContainEqual({ name: { startsWith: prefix } });
      expect(orList).toContainEqual({ email: { startsWith: prefix } });
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

  test('empty candidate sets → no delete calls, summary all zero across 12 models', async () => {
    const summary = await runDemoHygiene();
    for (const { model } of SWEPT_MODELS) {
      expect(prisma[model].delete).not.toHaveBeenCalled();
    }
    // Every keyed slot in the summary is { deleted: 0, ...candidates: 0 }
    expect(summary.patient.deleted).toBe(0);
    expect(summary.pipeline.deleted).toBe(0);
    expect(summary.currency.deleted).toBe(0);
    expect(summary.territory.deleted).toBe(0);
    expect(summary.chatbot.deleted).toBe(0);
    expect(summary.slaPolicy.deleted).toBe(0);
    expect(summary.ticket.deleted).toBe(0);
    expect(summary.marketplaceLead.deleted).toBe(0);
    expect(summary.landingPage.deleted).toBe(0);
    expect(summary.task.deleted).toBe(0);
    expect(summary.agentRecommendation.deleted).toBe(0);
    expect(summary.emailMessage.deleted).toBe(0);
  });

  test('#578 — sla policy / ticket / landing page / task / recommendation / email each delete their candidates', async () => {
    // One candidate per surface — proves the delete pipeline is wired
    // for each of the 7 new models added in #578, not just shape-pinned.
    prisma.slaPolicy.findMany.mockResolvedValue([{ id: 100 }]);
    prisma.ticket.findMany.mockResolvedValue([{ id: 200 }]);
    prisma.landingPage.findMany.mockResolvedValue([{ id: 300 }]);
    prisma.task.findMany.mockResolvedValue([{ id: 400 }]);
    prisma.agentRecommendation.findMany.mockResolvedValue([{ id: 500 }]);
    prisma.emailMessage.findMany.mockResolvedValue([{ id: 600 }]);
    prisma.marketplaceLead.findMany.mockResolvedValue([{ id: 700 }]);
    const summary = await runDemoHygiene();
    expect(prisma.slaPolicy.delete).toHaveBeenCalledWith({ where: { id: 100 } });
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 200 } });
    expect(prisma.landingPage.delete).toHaveBeenCalledWith({ where: { id: 300 } });
    expect(prisma.task.delete).toHaveBeenCalledWith({ where: { id: 400 } });
    expect(prisma.agentRecommendation.delete).toHaveBeenCalledWith({ where: { id: 500 } });
    expect(prisma.emailMessage.delete).toHaveBeenCalledWith({ where: { id: 600 } });
    expect(prisma.marketplaceLead.delete).toHaveBeenCalledWith({ where: { id: 700 } });
    expect(summary.slaPolicy.deleted).toBe(1);
    expect(summary.ticket.deleted).toBe(1);
    expect(summary.landingPage.deleted).toBe(1);
    expect(summary.task.deleted).toBe(1);
    expect(summary.agentRecommendation.deleted).toBe(1);
    expect(summary.emailMessage.deleted).toBe(1);
    expect(summary.marketplaceLead.deleted).toBe(1);
  });

  test('#578 — P2003 on a marketplaceLead → skipped, summary tracks skipped count', async () => {
    // MarketplaceLead.contactId is SetNull on Contact delete, so a probe
    // shouldn't normally hit P2003 — but the engine handles it
    // gracefully if it does (e.g. an unknown FK we haven't seen).
    prisma.marketplaceLead.findMany.mockResolvedValue([{ id: 999 }]);
    prisma.marketplaceLead.delete.mockImplementation(async () => {
      const err = new Error('FK restrict');
      err.code = 'P2003';
      throw err;
    });
    const summary = await runDemoHygiene();
    expect(summary.marketplaceLead).toEqual({ deleted: 0, skipped: 1, candidates: 1 });
  });
});
