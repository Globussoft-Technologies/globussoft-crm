/**
 * Unit tests for backend/cron/orchestratorEngine.js — pins the canonical
 * Task case (`status: "Pending"`, `priority: "High"`) on the action
 * dispatcher's `prisma.task.create()` writes.
 *
 * Why this file exists (regression class — v3.4.8 carry-over #5):
 *   - The orchestrator's `executeApproved` writes a Task row when the
 *     user approves a `campaign_boost`, `occupancy_alert`, or
 *     `schedule_gap` recommendation. Prior to v3.4.9 those writes used
 *     the drifted UPPERCASE values `"OPEN"` and `"HIGH"`, while the
 *     `Task` schema (backend/prisma/schema.prisma:773-774) declares
 *     Title-case canonical values:
 *
 *       status:   "Pending" | "Completed" | …  (Title-case)
 *       priority: "Low" | "Medium" | "High" | "Critical" (Title-case)
 *
 *     The drift forced every downstream consumer (badges, filters,
 *     reports, the v3.4.8 `normalizeStatusFilter()` reader at #436) to
 *     special-case both spellings forever.
 *
 *   - v3.4.9 aligned the writes with the schema. This file is the
 *     regression-guard: if a future refactor reintroduces uppercase
 *     literals, the case-sensitive assertions below fail at unit-test
 *     time, before the data hits prod.
 *
 * Functions / branches covered:
 *   ✅ executeApproved('campaign_boost')   → Task.status === "Pending",
 *                                            Task.priority === "High"
 *   ✅ executeApproved('occupancy_alert')  → same canonical pin
 *   ✅ executeApproved('schedule_gap')     → same canonical pin
 *                                            (shared switch arm with
 *                                             occupancy_alert)
 *   ✅ Negative regression — assert NEVER "OPEN" / "HIGH" so a partial
 *     revert (e.g. only one branch reverted) is caught.
 *
 * NOT covered (out of scope for this carry-over):
 *   - runForTenant / generateProposals / readContext — separate concern
 *     (Gemini integration, dedup hashing) and not where the case-drift
 *     bug lives.
 *   - cleanupExistingDupes — touches existing rows; case is a write
 *     concern, not a cleanup concern.
 *
 * Mocking strategy:
 *   Mirror backend/test/cron/wellnessOpsEngine.test.js — import the
 *   prisma singleton, monkey-patch the `task` accessor with vi.fn()s.
 *   The cron module is inlined via vitest.config.js → server.deps.inline
 *   so its `require('../lib/prisma')` resolves to the same singleton.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { executeApproved, ruleBasedProposals } from '../../cron/orchestratorEngine.js';

beforeAll(() => {
  prisma.task = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
});

beforeEach(() => {
  prisma.task.findFirst.mockReset();
  prisma.task.create.mockReset();
  // No pre-existing task → findOrCreateTask falls through to .create().
  prisma.task.findFirst.mockResolvedValue(null);
  prisma.task.create.mockResolvedValue({ id: 1 });
});

// ─── canonical case pin ─────────────────────────────────────────────────────

describe('cron/orchestratorEngine — canonical Task case (v3.4.8 carry-over #5)', () => {
  test('campaign_boost → Task written with status="Pending" + priority="High" (case-sensitive)', async () => {
    const rec = {
      id: 11,
      type: 'campaign_boost',
      title: 'Boost Hydrafacial',
      body: 'Lift ad spend on Hydrafacial — zero bookings this week.',
      payload: null,
      tenantId: 7,
    };

    const result = await executeApproved(rec, { actorUserId: 42 });
    expect(result.ok).toBe(true);
    expect(prisma.task.create).toHaveBeenCalledTimes(1);

    const data = prisma.task.create.mock.calls[0][0].data;
    // Schema canonical (backend/prisma/schema.prisma:773-774): "Pending" / "High".
    expect(data.status).toMatch(/^Pending$/); // case-sensitive
    expect(data.priority).toMatch(/^High$/); // case-sensitive
    // Negative regression — explicit guard against the v3.4.8 drift.
    expect(data.status).not.toBe('OPEN');
    expect(data.priority).not.toBe('HIGH');
  });

  test('occupancy_alert → Task written with status="Pending" + priority="High" (case-sensitive)', async () => {
    const rec = {
      id: 12,
      type: 'occupancy_alert',
      title: "Today's occupancy only 18%",
      body: 'Slots empty — send a same-day promo blast.',
      payload: null,
      tenantId: 7,
    };

    const result = await executeApproved(rec, { actorUserId: 42 });
    expect(result.ok).toBe(true);
    expect(prisma.task.create).toHaveBeenCalledTimes(1);

    const data = prisma.task.create.mock.calls[0][0].data;
    expect(data.status).toMatch(/^Pending$/);
    expect(data.priority).toMatch(/^High$/);
    expect(data.status).not.toBe('OPEN');
    expect(data.priority).not.toBe('HIGH');
  });

  test('schedule_gap → shares the occupancy_alert arm, same canonical case', async () => {
    const rec = {
      id: 13,
      type: 'schedule_gap',
      title: 'Schedule gap 14:00-16:00',
      body: 'Two open slots this afternoon — fill via SMS to recent inquirers.',
      payload: null,
      tenantId: 7,
    };

    const result = await executeApproved(rec, { actorUserId: 42 });
    expect(result.ok).toBe(true);
    expect(prisma.task.create).toHaveBeenCalledTimes(1);

    const data = prisma.task.create.mock.calls[0][0].data;
    expect(data.status).toMatch(/^Pending$/);
    expect(data.priority).toMatch(/^High$/);
  });
});

// ─── #579 — All-tab card body differentiation ──────────────────────────────
//
// Pre-#579 the rule-based stale-leads card emitted an identical templated
// body on every cron run, varying only in the count number. Owner Dashboard
// Top Recommendation surfaces specific output (rule #5 sla_breach with names
// + assignee), proving the producer is capable. The fix in
// backend/cron/orchestratorEngine.js (rule #1 lead_followup) now pulls the
// actual stale-lead rows + assignee + age-bucket distribution so each card
// reads with specific names and a per-day breakdown — enough variation that
// 5 cards from 5 different lead pools have 5 distinct body strings.
//
// This test asserts that contract: produce 5 cards from synthetic varied
// lead pools, expect 5 distinct body strings (set size === 5). Catches a
// regression to a templated body that varies only in numeric tokens.

describe('cron/orchestratorEngine — rule-based card bodies are differentiated (#579)', () => {
  // Build a minimal synthetic context. Only the fields that rule #1
  // reads are populated; the other rules' guards are false so only the
  // lead_followup card is emitted per call.
  function makeCtx({ leadCount, leadPool, assigneeName, ageBuckets }) {
    const now = Date.now();
    // Spread lead createdAt across the requested age-bucket distribution.
    const oldLeadsList = [];
    let i = 0;
    for (const [bucket, n] of Object.entries(ageBuckets || { d1: leadPool.length, d2_3: 0, d3plus: 0 })) {
      const ageHours = bucket === 'd1' ? 30 : bucket === 'd2_3' ? 60 : 120;
      for (let k = 0; k < n && i < leadPool.length; k++, i++) {
        oldLeadsList.push({
          id: i + 1,
          name: leadPool[i],
          source: 'IndiaMART',
          assignedToId: null,
          createdAt: new Date(now - ageHours * 3600 * 1000),
        });
      }
    }
    return {
      // Rule #1 inputs
      oldLeads: leadCount,
      oldLeadsList,
      suggestedAssignee: assigneeName ? { id: 99, name: assigneeName, email: 'tc@x.in' } : null,
      // Rule #2-5 guards: keep them false so only rule #1 fires.
      occupancyPct: 80, todayBooked: 30,
      highTickerCold: [],
      utilisationPct: 80, zeroBookingServices: [],
      slaBreachLeads: [],
      topServices: [],
      slaMinutes: 30,
    };
  }

  test('5 different lead-pool contexts produce 5 distinct card body strings (set size === 5)', () => {
    // Five contexts that vary across lead names, count, age-distribution,
    // and suggested assignee — i.e. the four axes the new producer pulls
    // from. The pre-fix body would be identical-modulo-number on all five.
    const contexts = [
      makeCtx({ leadCount: 8, leadPool: ['Arjun Mehta', 'Priya Sharma', 'Rohan Kapoor'], assigneeName: 'Ankita Verma', ageBuckets: { d1: 8, d2_3: 0, d3plus: 0 } }),
      makeCtx({ leadCount: 12, leadPool: ['Sita Iyer', 'Vikram Singh', 'Neha Joshi', 'Arpit Gupta'], assigneeName: 'Rahul Khanna', ageBuckets: { d1: 4, d2_3: 6, d3plus: 2 } }),
      makeCtx({ leadCount: 23, leadPool: ['Meera Pillai', 'Suresh Reddy', 'Kavya Nair'], assigneeName: 'Pooja Desai', ageBuckets: { d1: 0, d2_3: 0, d3plus: 23 } }),
      makeCtx({ leadCount: 6, leadPool: ['Aakash Patel', 'Tanvi Shah', 'Manish Roy'], assigneeName: null /* no assignee suggestion */, ageBuckets: { d1: 6, d2_3: 0, d3plus: 0 } }),
      makeCtx({ leadCount: 18, leadPool: ['Divya Krishnan', 'Karan Bhatia', 'Riya Saxena', 'Yash Malhotra'], assigneeName: 'Ankita Verma', ageBuckets: { d1: 8, d2_3: 4, d3plus: 6 } }),
    ];

    const cards = contexts.map((ctx) => ruleBasedProposals(ctx));
    // One lead_followup card per ctx.
    expect(cards.every((arr) => arr.length === 1 && arr[0].type === 'lead_followup')).toBe(true);

    const bodies = cards.map((arr) => arr[0].body);
    const distinct = new Set(bodies);
    expect(distinct.size).toBe(5);

    // Spot-check that the regressed templated phrase is no longer the entire
    // body — at least the lead names + assignee are surfaced.
    expect(bodies[0]).toContain('Arjun Mehta');
    expect(bodies[0]).toContain('Ankita Verma');
    expect(bodies[2]).toContain('older than 3 days');

    // Negative regression — no card should read as the pre-fix template
    // (that template started "Industry data shows first-contact within 5
    // minutes lifts conversion 9x." with NO leading lead-name clause).
    for (const b of bodies) {
      expect(b.startsWith('Industry data shows first-contact')).toBe(false);
    }
  });

  test('falls back to "the queued leads" + "the on-duty telecaller" when oldLeadsList is empty + no assignee', () => {
    // Defensive — even when context is sparse, body must not crash and
    // must not collapse to the pre-fix template.
    const ctx = {
      oldLeads: 7, oldLeadsList: [], suggestedAssignee: null,
      occupancyPct: 80, todayBooked: 30, highTickerCold: [],
      utilisationPct: 80, zeroBookingServices: [], slaBreachLeads: [],
      topServices: [], slaMinutes: 30,
    };
    const [card] = ruleBasedProposals(ctx);
    expect(card.type).toBe('lead_followup');
    expect(card.body).toContain('the queued leads');
    expect(card.body).toContain('the on-duty telecaller');
  });
});

// ─── findOrCreateTask dedup short-circuits before .create() ─────────────────

describe('cron/orchestratorEngine — dedup short-circuit (no Task.create call)', () => {
  test('existing task today → executeApproved returns task_deduped, prisma.task.create NOT invoked', async () => {
    prisma.task.findFirst.mockResolvedValue({ id: 999 });

    const rec = {
      id: 14,
      type: 'occupancy_alert',
      title: "Today's occupancy only 12%",
      body: 'Boost.',
      payload: null,
      tenantId: 7,
    };

    const result = await executeApproved(rec, { actorUserId: 42 });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('task_deduped');
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});
