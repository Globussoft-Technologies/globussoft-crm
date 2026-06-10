// @ts-check
/**
 * Unit tests for backend/cron/backfillLastVisitEngine.js — S94 one-shot
 * backfill for `Patient.lastVisitDate` denorm cache.
 *
 * Contract pinned:
 *   - tick() returns { success, processed, updated, errors } envelope.
 *   - start() is a no-op (logs only) since this is one-shot, not scheduled.
 *   - Per-tenant isolation: one bad tenant doesn't poison siblings.
 *   - Per-patient isolation: one bad patient (DB throw) doesn't abort batch.
 *   - Idempotency: only touches lastVisitDate IS NULL rows. Re-running
 *     after a clean sweep yields updated=0.
 *   - Most-recent visit selection: orderBy visitDate desc, take 1.
 *   - Batching: paginates in PATIENT_BATCH_SIZE chunks via cursor.
 *   - Patient with no visits: counted as processed, NOT updated (not error).
 *   - Top-level tenant.findMany failure: returns {success:false, errors:1}.
 *
 * Mocking strategy: mirror leadSlaEngine.test.js — import the prisma singleton,
 * monkey-patch methods, assert mock-call shapes. The cron module is inlined
 * via vitest.config.js so `require('../lib/prisma')` resolves to the same
 * singleton instance.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";

import prisma from "../../lib/prisma.js";

import {
  tick,
  start,
  processTenant,
  PATIENT_BATCH_SIZE,
} from "../../cron/backfillLastVisitEngine.js";

beforeAll(() => {
  prisma.patient = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
  prisma.visit = {
    findFirst: vi.fn(),
  };
  prisma.tenant = {
    findMany: vi.fn(),
  };
});

beforeEach(() => {
  prisma.patient.findMany.mockReset();
  prisma.patient.update.mockReset();
  prisma.visit.findFirst.mockReset();
  prisma.tenant.findMany.mockReset();

  // Defaults — most tests override.
  prisma.patient.findMany.mockResolvedValue([]);
  prisma.patient.update.mockResolvedValue({ id: 1, lastVisitDate: new Date() });
  prisma.visit.findFirst.mockResolvedValue(null);
  prisma.tenant.findMany.mockResolvedValue([]);
});

const TENANT_A = { id: 1, slug: "enhanced" };
const TENANT_B = { id: 2, slug: "another" };

// ─── Envelope shape ────────────────────────────────────────────────────────

describe("backfillLastVisitEngine — envelope shape", () => {
  test("tick() with zero tenants returns success envelope with zeros", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([]);
    const res = await tick();
    expect(res).toEqual({
      success: true,
      processed: 0,
      updated: 0,
      errors: 0,
    });
  });

  test("tick() return envelope keys are exactly success/processed/updated/errors", async () => {
    const res = await tick();
    expect(Object.keys(res).sort()).toEqual(
      ["errors", "processed", "success", "updated"].sort(),
    );
  });

  test("module exports tick() and start() (engine-shape contract)", () => {
    expect(typeof tick).toBe("function");
    expect(typeof start).toBe("function");
  });

  test("start() is a no-op (returns undefined, doesn't throw)", () => {
    expect(start()).toBeUndefined();
  });

  test("PATIENT_BATCH_SIZE exported and equals 100", () => {
    expect(PATIENT_BATCH_SIZE).toBe(100);
  });
});

// ─── Happy path — patients with visits ─────────────────────────────────────

describe("backfillLastVisitEngine — happy path", () => {
  test("patients with visits → lastVisitDate populated from most-recent visit", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    prisma.patient.findMany
      .mockResolvedValueOnce([{ id: 101 }, { id: 102 }])
      .mockResolvedValueOnce([]);
    const visitA = new Date("2026-05-20T10:00:00Z");
    const visitB = new Date("2026-06-01T14:30:00Z");
    prisma.visit.findFirst
      .mockResolvedValueOnce({ visitDate: visitA })
      .mockResolvedValueOnce({ visitDate: visitB });

    const res = await tick();

    expect(res.success).toBe(true);
    expect(res.processed).toBe(2);
    expect(res.updated).toBe(2);
    expect(res.errors).toBe(0);
    expect(prisma.patient.update).toHaveBeenCalledTimes(2);
    expect(prisma.patient.update).toHaveBeenNthCalledWith(1, {
      where: { id: 101 },
      data: { lastVisitDate: visitA },
    });
    expect(prisma.patient.update).toHaveBeenNthCalledWith(2, {
      where: { id: 102 },
      data: { lastVisitDate: visitB },
    });
  });

  test("most-recent visit selection: orderBy visitDate desc + take 1", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    prisma.patient.findMany
      .mockResolvedValueOnce([{ id: 50 }])
      .mockResolvedValueOnce([]);
    prisma.visit.findFirst.mockResolvedValueOnce({
      visitDate: new Date("2026-05-15T09:00:00Z"),
    });

    await tick();

    expect(prisma.visit.findFirst).toHaveBeenCalledWith({
      where: { patientId: 50, tenantId: 1 },
      orderBy: { visitDate: "desc" },
      select: { visitDate: true },
    });
  });
});

// ─── Idempotency ───────────────────────────────────────────────────────────

describe("backfillLastVisitEngine — idempotency", () => {
  test("findMany WHERE filters on lastVisitDate IS NULL (skips already-populated rows)", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    prisma.patient.findMany.mockResolvedValueOnce([]);

    await tick();

    const arg = prisma.patient.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(1);
    expect(arg.where.lastVisitDate).toBeNull();
  });

  test("second tick after clean sweep yields updated=0 (idempotent)", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    // No null-cache patients remain — empty result page.
    prisma.patient.findMany.mockResolvedValueOnce([]);

    const res = await tick();
    expect(res.processed).toBe(0);
    expect(res.updated).toBe(0);
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  test("patient with no visit history: counted as processed, NOT updated, NOT error", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    prisma.patient.findMany
      .mockResolvedValueOnce([{ id: 999 }])
      .mockResolvedValueOnce([]);
    prisma.visit.findFirst.mockResolvedValueOnce(null); // no visits

    const res = await tick();

    expect(res.processed).toBe(1);
    expect(res.updated).toBe(0);
    expect(res.errors).toBe(0);
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });
});

// ─── Multi-tenant isolation ────────────────────────────────────────────────

describe("backfillLastVisitEngine — multi-tenant", () => {
  test("each tenant processed independently and totals aggregate", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A, TENANT_B]);
    // Both tenants return a short batch (length < PATIENT_BATCH_SIZE),
    // so each tenant's findMany is invoked exactly once.
    prisma.patient.findMany
      .mockResolvedValueOnce([{ id: 1 }]) // tenant A
      .mockResolvedValueOnce([{ id: 2 }]); // tenant B
    prisma.visit.findFirst
      .mockResolvedValueOnce({ visitDate: new Date("2026-05-01") })
      .mockResolvedValueOnce({ visitDate: new Date("2026-05-02") });

    const res = await tick();

    expect(res.processed).toBe(2);
    expect(res.updated).toBe(2);
    expect(res.errors).toBe(0);
  });

  test("per-tenant findMany is tenantId-scoped (no cross-tenant leak)", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A, TENANT_B]);
    // Short batch → single findMany per tenant.
    prisma.patient.findMany
      .mockResolvedValueOnce([]) // tenant A
      .mockResolvedValueOnce([]); // tenant B

    await tick();

    const calls = prisma.patient.findMany.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].where.tenantId).toBe(1);
    expect(calls[1][0].where.tenantId).toBe(2);
  });

  test("one tenant throwing in processTenant → siblings still processed + errors incremented", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A, TENANT_B]);
    // Tenant A's first findMany throws (top-level processTenant failure path).
    prisma.patient.findMany
      .mockRejectedValueOnce(new Error("tenant A DB blew up"))
      // Tenant B's findMany returns 1 patient + tail.
      .mockResolvedValueOnce([{ id: 77 }])
      .mockResolvedValueOnce([]);
    prisma.visit.findFirst.mockResolvedValueOnce({
      visitDate: new Date("2026-06-01"),
    });

    const res = await tick();

    expect(res.success).toBe(true); // top-level still success — tenants iterated
    expect(res.errors).toBeGreaterThanOrEqual(1);
    expect(res.processed).toBe(1); // tenant B's patient
    expect(res.updated).toBe(1);
  });
});

// ─── Per-patient error isolation ───────────────────────────────────────────

describe("backfillLastVisitEngine — per-patient error isolation", () => {
  test("one patient update throws → sibling patient still updates", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    prisma.patient.findMany
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce([]);
    prisma.visit.findFirst
      .mockResolvedValueOnce({ visitDate: new Date("2026-05-01") })
      .mockResolvedValueOnce({ visitDate: new Date("2026-05-02") });
    prisma.patient.update
      .mockRejectedValueOnce(new Error("update 1 failed"))
      .mockResolvedValueOnce({ id: 2 });

    const res = await tick();

    expect(res.processed).toBe(2);
    expect(res.updated).toBe(1);
    expect(res.errors).toBe(1);
  });

  test("visit.findFirst throwing for one patient → next patient still processed", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    prisma.patient.findMany
      .mockResolvedValueOnce([{ id: 10 }, { id: 20 }])
      .mockResolvedValueOnce([]);
    prisma.visit.findFirst
      .mockRejectedValueOnce(new Error("visit query failed"))
      .mockResolvedValueOnce({ visitDate: new Date("2026-05-10") });

    const res = await tick();

    expect(res.processed).toBe(2);
    expect(res.updated).toBe(1);
    expect(res.errors).toBe(1);
  });
});

// ─── Batching ──────────────────────────────────────────────────────────────

describe("backfillLastVisitEngine — batching", () => {
  test("first findMany has take=PATIENT_BATCH_SIZE (100), no cursor", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    prisma.patient.findMany.mockResolvedValueOnce([]);

    await tick();

    const arg = prisma.patient.findMany.mock.calls[0][0];
    expect(arg.take).toBe(100);
    expect(arg.cursor).toBeUndefined();
    expect(arg.orderBy).toEqual({ id: "asc" });
  });

  test("when batch returns full PATIENT_BATCH_SIZE → next findMany uses cursor on last id", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    // Build a full batch of 100 patients
    const fullBatch = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    prisma.patient.findMany
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([]); // tail empty
    prisma.visit.findFirst.mockResolvedValue(null); // no visits → no updates

    await tick();

    expect(prisma.patient.findMany).toHaveBeenCalledTimes(2);
    const secondArg = prisma.patient.findMany.mock.calls[1][0];
    expect(secondArg.cursor).toEqual({ id: 100 });
    expect(secondArg.skip).toBe(1);
  });

  test("short batch (< PATIENT_BATCH_SIZE) → no additional findMany invoked", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([TENANT_A]);
    // 3 patients, less than batch size
    prisma.patient.findMany.mockResolvedValueOnce([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    prisma.visit.findFirst.mockResolvedValue(null);

    await tick();

    expect(prisma.patient.findMany).toHaveBeenCalledTimes(1);
  });
});

// ─── Top-level tenant.findMany failure ─────────────────────────────────────

describe("backfillLastVisitEngine — top-level failure", () => {
  test("tenant.findMany throws → returns {success:false, errors:1}", async () => {
    prisma.tenant.findMany.mockRejectedValueOnce(
      new Error("tenant list DB down"),
    );

    const res = await tick();

    expect(res.success).toBe(false);
    expect(res.processed).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.errors).toBe(1);
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });

  test("tenant query is scoped to isActive=true (skips disabled tenants)", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([]);

    await tick();

    expect(prisma.tenant.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true, slug: true },
    });
  });
});

// ─── processTenant standalone ──────────────────────────────────────────────

describe("backfillLastVisitEngine — processTenant standalone", () => {
  test("returns {processed, updated, errors} envelope", async () => {
    prisma.patient.findMany.mockResolvedValueOnce([]);
    const res = await processTenant(TENANT_A);
    expect(res).toEqual({ processed: 0, updated: 0, errors: 0 });
  });

  test("empty tenant returns all zeros", async () => {
    prisma.patient.findMany.mockResolvedValueOnce([]);
    const res = await processTenant(TENANT_A);
    expect(res.processed).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.errors).toBe(0);
  });
});
