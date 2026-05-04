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

import { executeApproved } from '../../cron/orchestratorEngine.js';

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
