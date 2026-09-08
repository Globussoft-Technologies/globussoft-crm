// @ts-check
/**
 * Unit tests for backend/lib/doctorAvailability.js — the double-booking guard.
 *
 * TWO BUGS THIS PINS
 *
 *   1. Hour-bucket granularity. The old check truncated to the top of the clock
 *      hour with `setMinutes(0, 0, 0)`, which truncates in the SERVER's
 *      timezone. Clinics run IST, servers run UTC: 14:00 IST sits in
 *      [08:00,09:00) UTC and 14:30 IST in [09:00,10:00) UTC, so two
 *      appointments half an hour apart landed in different buckets and never
 *      registered as a conflict — even for a 50-minute service.
 *
 *   2. Start-time-only comparison in the slot grid. A 50-minute visit at 14:00
 *      only marked 14:00 as taken, leaving 14:30 offered to the next patient.
 *
 *   Both are replaced by half-open interval overlap on INSTANTS, which needs no
 *   timezone handling because visitDate is already a true UTC instant.
 *
 * The half-open part is deliberate: an appointment ending at 14:00 and the next
 * starting at 14:00 must NOT collide, or back-to-back scheduling is impossible.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");

prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();

const {
  OCCUPYING_STATUSES,
  DEFAULT_DURATION_MIN,
  durationOf,
  intervalsOverlap,
  visitInterval,
  findDoctorConflict,
  findConflictsForDoctors,
  markSlotAvailability,
} = requireCJS("../../lib/doctorAvailability");

/** An IST wall-clock time as the UTC instant the DB actually stores. */
const ist = (day, hhmm) => new Date(`2026-09-${day}T${hhmm}:00+05:30`);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.visit.findMany.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────
// The overlap primitive
// ─────────────────────────────────────────────────────────────────────────

describe("intervalsOverlap", () => {
  test("detects a genuine overlap", () => {
    expect(intervalsOverlap(10, 20, 15, 25)).toBe(true);
    expect(intervalsOverlap(15, 25, 10, 20)).toBe(true);
  });

  test("back-to-back does NOT collide — half-open on purpose", () => {
    // 13:00–14:00 followed by 14:00–15:00 is how clinics actually run.
    expect(intervalsOverlap(10, 20, 20, 30)).toBe(false);
    expect(intervalsOverlap(20, 30, 10, 20)).toBe(false);
  });

  test("full containment counts", () => {
    expect(intervalsOverlap(10, 40, 20, 25)).toBe(true);
    expect(intervalsOverlap(20, 25, 10, 40)).toBe(true);
  });
});

describe("durationOf / visitInterval", () => {
  test("uses the service duration when present", () => {
    expect(durationOf({ service: { durationMin: 50 } })).toBe(50);
  });

  test("falls back to the schema default when absent or unusable", () => {
    // A zero-length visit would collide with nothing, so it must not be zero.
    expect(durationOf({})).toBe(DEFAULT_DURATION_MIN);
    expect(durationOf({ service: { durationMin: 0 } })).toBe(DEFAULT_DURATION_MIN);
    expect(durationOf({ service: null })).toBe(DEFAULT_DURATION_MIN);
  });

  test("an interval runs from visitDate for the service duration", () => {
    const iv = visitInterval({ visitDate: ist("10", "14:00"), service: { durationMin: 50 } });
    expect(iv.endMs - iv.startMs).toBe(50 * 60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// findDoctorConflict
// ─────────────────────────────────────────────────────────────────────────

describe("findDoctorConflict", () => {
  test("catches the 14:00 vs 14:30 case the hour-bucket check missed", async () => {
    // THE regression. 14:00 IST + 50min runs to 14:50, so a 14:30 booking
    // overlaps — but the two fall in different UTC clock-hour buckets.
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, visitDate: ist("10", "14:00"), service: { name: "Basic FUE", durationMin: 50 } },
    ]);

    const clash = await findDoctorConflict({
      tenantId: 1,
      doctorId: 7,
      startsAt: ist("10", "14:30"),
      durationMin: 30,
    });

    expect(clash).toBeTruthy();
    expect(clash.id).toBe(1);
    expect(clash.serviceName).toBe("Basic FUE");
  });

  test("allows a booking that starts exactly when the previous one ends", async () => {
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, visitDate: ist("10", "14:00"), service: { durationMin: 30 } },
    ]);
    const clash = await findDoctorConflict({
      tenantId: 1,
      doctorId: 7,
      startsAt: ist("10", "14:30"),
      durationMin: 30,
    });
    expect(clash).toBeNull();
  });

  test("a long new booking that swallows an existing one conflicts", async () => {
    prisma.visit.findMany.mockResolvedValue([
      { id: 2, visitDate: ist("10", "14:30"), service: { durationMin: 15 } },
    ]);
    const clash = await findDoctorConflict({
      tenantId: 1,
      doctorId: 7,
      startsAt: ist("10", "14:00"),
      durationMin: 120,
    });
    expect(clash.id).toBe(2);
  });

  test("no doctor means nothing to double-book", async () => {
    expect(await findDoctorConflict({ tenantId: 1, doctorId: null, startsAt: new Date() })).toBeNull();
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
  });

  test("only occupying statuses are considered", async () => {
    await findDoctorConflict({
      tenantId: 1, doctorId: 7, startsAt: ist("10", "14:00"), durationMin: 30,
    });
    const where = prisma.visit.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(OCCUPYING_STATUSES);
    // A cancelled or completed visit releases the slot.
    expect(where.status.in).not.toContain("cancelled");
    expect(where.status.in).not.toContain("completed");
  });

  test("is tenant-scoped and excludes the visit being edited", async () => {
    await findDoctorConflict({
      tenantId: 42, doctorId: 7, startsAt: ist("10", "14:00"), durationMin: 30, excludeVisitId: 99,
    });
    const where = prisma.visit.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(42);
    expect(where.doctorId).toBe(7);
    expect(where.id).toEqual({ not: 99 });
  });

  test("reads a padded window so a long earlier visit is still seen", async () => {
    await findDoctorConflict({
      tenantId: 1, doctorId: 7, startsAt: ist("10", "14:00"), durationMin: 30,
    });
    const range = prisma.visit.findMany.mock.calls[0][0].where.visitDate;
    expect(range.gte.getTime()).toBeLessThan(ist("10", "14:00").getTime());
    expect(range.lte.getTime()).toBeGreaterThan(ist("10", "14:00").getTime());
  });

  test("an existing visit with no service still reserves the default block", async () => {
    prisma.visit.findMany.mockResolvedValue([
      { id: 3, visitDate: ist("10", "14:00"), service: null },
    ]);
    // 14:00 + default 30min = 14:30, so 14:15 overlaps.
    const clash = await findDoctorConflict({
      tenantId: 1, doctorId: 7, startsAt: ist("10", "14:15"), durationMin: 30,
    });
    expect(clash.id).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// findConflictsForDoctors — the Assign Doctor dropdown
// ─────────────────────────────────────────────────────────────────────────

describe("findConflictsForDoctors", () => {
  test("reports busy and free doctors from ONE query", async () => {
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, doctorId: 7, visitDate: ist("10", "14:00"), service: { name: "Consult", durationMin: 60 } },
    ]);

    const map = await findConflictsForDoctors({
      tenantId: 1,
      doctorIds: [7, 8, 9],
      startsAt: ist("10", "14:30"),
      durationMin: 30,
    });

    expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
    expect(map.get(7)).toBeTruthy();
    expect(map.get(8)).toBeNull();
    expect(map.get(9)).toBeNull();
  });

  test("a doctor whose only visit is elsewhere in the day stays free", async () => {
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, doctorId: 7, visitDate: ist("10", "09:00"), service: { durationMin: 30 } },
    ]);
    const map = await findConflictsForDoctors({
      tenantId: 1, doctorIds: [7], startsAt: ist("10", "14:00"), durationMin: 30,
    });
    expect(map.get(7)).toBeNull();
  });

  test("empty input short-circuits", async () => {
    expect((await findConflictsForDoctors({ tenantId: 1, doctorIds: [], startsAt: new Date() })).size).toBe(0);
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// markSlotAvailability — the patient-facing grid
// ─────────────────────────────────────────────────────────────────────────

describe("markSlotAvailability", () => {
  const grid = ["14:00", "14:30", "15:00", "15:30"].map((t) => ({
    time: t,
    startsAt: ist("10", t),
  }));

  test("a 50-minute visit blocks BOTH the slots it spans", () => {
    // The bug: comparing start times alone left 14:30 bookable while the
    // doctor was mid-treatment until 14:50.
    const marked = markSlotAvailability(
      grid,
      [{ id: 1, visitDate: ist("10", "14:00"), service: { durationMin: 50 } }],
      30,
    );
    const byTime = Object.fromEntries(marked.map((m) => [m.time, m.available]));
    expect(byTime["14:00"]).toBe(false);
    expect(byTime["14:30"]).toBe(false);
    expect(byTime["15:00"]).toBe(true);
    expect(byTime["15:30"]).toBe(true);
  });

  test("a 30-minute visit blocks exactly its own slot", () => {
    const marked = markSlotAvailability(
      grid,
      [{ id: 1, visitDate: ist("10", "14:00"), service: { durationMin: 30 } }],
      30,
    );
    const byTime = Object.fromEntries(marked.map((m) => [m.time, m.available]));
    expect(byTime["14:00"]).toBe(false);
    expect(byTime["14:30"]).toBe(true);
  });

  test("a long requested slot cannot be squeezed into a short gap", () => {
    // 15:00 is free, but a 60-minute treatment would run into a 15:30 booking.
    const marked = markSlotAvailability(
      grid,
      [{ id: 1, visitDate: ist("10", "15:30"), service: { durationMin: 30 } }],
      60,
    );
    const byTime = Object.fromEntries(marked.map((m) => [m.time, m.available]));
    expect(byTime["15:00"]).toBe(false);
    expect(byTime["14:00"]).toBe(true);
  });

  test("reports which visit took the slot", () => {
    const marked = markSlotAvailability(
      grid,
      [{ id: 77, visitDate: ist("10", "14:00"), service: { durationMin: 30 } }],
      30,
    );
    expect(marked.find((m) => m.time === "14:00").conflictVisitId).toBe(77);
  });

  test("an empty day leaves every slot open", () => {
    const marked = markSlotAvailability(grid, [], 30);
    expect(marked.every((m) => m.available)).toBe(true);
  });
});
