// Unit tests for backend/lib/bookingAvailability.js (Wave 11 Agent GG)
//
// Pins the 4-conflict-class branches with synthetic data + monkey-patched
// prisma (vi.mock doesn't intercept CJS require in this vitest setup, see
// leadJunkFilter.test.js for the same pattern).
//
// What's covered:
//   1. Module shape — exports assertVisitSlotAvailable + CONFLICT_CODES.
//   2. Happy path — no holiday, in-window, no resource overlap, no doctor
//      overlap → { ok: true }.
//   3. HOLIDAY_BLOCKED — three sub-classes (tenant-wide, location-scoped,
//      doctor-scoped). The DOCTOR_DOUBLE_BOOKED + RESOURCE_DOUBLE_BOOKED
//      checks must not fire because holiday wins precedence.
//   4. OUTSIDE_WORKING_HOURS — visit time outside the [startTime, endTime]
//      window blocks; visit time IN-window allows; visits where the doctor
//      has no rows for the day are silently allowed (operator opt-in).
//   5. RESOURCE_DOUBLE_BOOKED — same hour bucket + same resource +
//      ACTIVE_STATUSES match → blocks. Cancelled overlap is allowed.
//   6. DOCTOR_DOUBLE_BOOKED — same shape, different field. Self-update
//      (visitId-exclusion) doesn't self-conflict.
//
// IST anchor: tests synthesise visitDate as ISO with explicit +05:30 offset
// so the IST date / day-of-week / hour helpers all land deterministically
// regardless of the test runner's local TZ.

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { assertVisitSlotAvailable, CONFLICT_CODES, _internal } from '../../lib/bookingAvailability.js';

// IST wall clock 14:00 on 2026-05-15 (a Friday) → UTC 08:30 (since IST = UTC+05:30).
const IST_FRIDAY_14_00 = '2026-05-15T14:00:00+05:30';
// IST wall clock 22:00 on 2026-05-15 (outside default 09–19 working hours).
const IST_FRIDAY_22_00 = '2026-05-15T22:00:00+05:30';

beforeAll(() => {
  prisma.holiday = { findMany: vi.fn() };
  prisma.workingHours = { findMany: vi.fn() };
  prisma.visit = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.holiday.findMany.mockReset();
  prisma.workingHours.findMany.mockReset();
  prisma.visit.findFirst.mockReset();
  prisma.holiday.findMany.mockResolvedValue([]);
  prisma.workingHours.findMany.mockResolvedValue([]);
  prisma.visit.findFirst.mockResolvedValue(null);
});

describe('lib/bookingAvailability — module shape', () => {
  test('exports assertVisitSlotAvailable function', () => {
    expect(typeof assertVisitSlotAvailable).toBe('function');
  });
  test('exports CONFLICT_CODES with 4 stable keys', () => {
    expect(Object.keys(CONFLICT_CODES).sort()).toEqual([
      'DOCTOR_DOUBLE_BOOKED',
      'HOLIDAY_BLOCKED',
      'OUTSIDE_WORKING_HOURS',
      'RESOURCE_DOUBLE_BOOKED',
    ]);
  });
  test('CONFLICT_CODES is frozen — keys cannot be added at runtime', () => {
    expect(() => { CONFLICT_CODES.NEW_CODE = 'X'; }).toThrow();
  });
});

describe('lib/bookingAvailability — input validation', () => {
  test('throws when tenantId missing', async () => {
    await expect(
      assertVisitSlotAvailable({ visitDate: IST_FRIDAY_14_00 })
    ).rejects.toThrow(/tenantId/);
  });
  test('throws when visitDate missing', async () => {
    await expect(
      assertVisitSlotAvailable({ tenantId: 1 })
    ).rejects.toThrow(/visitDate/);
  });
  test('throws on unparseable visitDate', async () => {
    await expect(
      assertVisitSlotAvailable({ tenantId: 1, visitDate: 'not-a-date' })
    ).rejects.toThrow(/invalid visitDate/);
  });
});

describe('lib/bookingAvailability — happy path', () => {
  test('returns ok:true with no doctor / no resource / no holiday', async () => {
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
    });
    expect(result).toEqual({ ok: true });
  });
  test('returns ok:true when WorkingHours has zero rows for the day (opt-in)', async () => {
    prisma.workingHours.findMany.mockResolvedValue([]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('lib/bookingAvailability — HOLIDAY_BLOCKED', () => {
  test('tenant-wide holiday blocks any visit on that date', async () => {
    prisma.holiday.findMany.mockResolvedValue([
      { id: 1, name: 'Diwali', date: new Date('2026-05-15'), locationId: null, doctorId: null },
    ]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONFLICT_CODES.HOLIDAY_BLOCKED);
    expect(result.detail).toMatch(/Diwali/);
  });
  test('location-scoped holiday blocks only when visit.locationId matches', async () => {
    prisma.holiday.findMany.mockResolvedValue([
      { id: 2, name: 'Local Maintenance', date: new Date('2026-05-15'), locationId: 5, doctorId: null },
    ]);
    const blocked = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      locationId: 5,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe(CONFLICT_CODES.HOLIDAY_BLOCKED);

    const passes = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      locationId: 99, // different location
    });
    expect(passes.ok).toBe(true);
  });
  test('doctor-scoped holiday blocks only when visit.doctorId matches', async () => {
    prisma.holiday.findMany.mockResolvedValue([
      { id: 3, name: 'Dr Sharma on leave', date: new Date('2026-05-15'), locationId: null, doctorId: 7 },
    ]);
    const blocked = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe(CONFLICT_CODES.HOLIDAY_BLOCKED);
    expect(blocked.detail).toMatch(/Practitioner on leave/);

    const passes = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 99, // different doctor
    });
    expect(passes.ok).toBe(true);
  });
  test('holiday wins over resource + doctor overlap (precedence)', async () => {
    prisma.holiday.findMany.mockResolvedValue([
      { id: 1, name: 'Diwali', date: new Date('2026-05-15'), locationId: null, doctorId: null },
    ]);
    // Even though we also stage a doctor overlap, the holiday should block first.
    prisma.visit.findFirst.mockResolvedValue({ id: 999, visitDate: new Date(IST_FRIDAY_14_00) });
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
      resourceId: 3,
    });
    expect(result.code).toBe(CONFLICT_CODES.HOLIDAY_BLOCKED);
    // The resource/doctor lookup must NOT have run because holiday blocked first.
    expect(prisma.visit.findFirst).not.toHaveBeenCalled();
  });

  // Recurring-annually coverage. The route makes TWO holiday.findMany calls:
  // (a) exact-date rows for the visit's IST day, (b) all recurringAnnually
  // rows for the tenant — the latter filtered in JS to ones whose stored
  // MM-DD matches the visit's MM-DD. Mock both calls separately so we can
  // exercise the year-agnostic match independently of the exact-date path.
  test('recurringAnnually holiday blocks a visit on the same MM-DD in a different year', async () => {
    prisma.holiday.findMany
      .mockResolvedValueOnce([]) // exact-date query — no match (different year stored)
      .mockResolvedValueOnce([   // recurring query — original was 2024-05-15, visit is 2026-05-15
        { id: 10, name: 'Republic Day', date: new Date('2024-05-15'), locationId: null, doctorId: null, recurringAnnually: true },
      ]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONFLICT_CODES.HOLIDAY_BLOCKED);
    expect(result.detail).toMatch(/Republic Day/);
  });
  test('recurringAnnually holiday does NOT block a different MM-DD', async () => {
    prisma.holiday.findMany
      .mockResolvedValueOnce([]) // exact-date query — no match
      .mockResolvedValueOnce([   // recurring row for 12-25 (Christmas), visit is 05-15
        { id: 11, name: 'Christmas', date: new Date('2024-12-25'), locationId: null, doctorId: null, recurringAnnually: true },
      ]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
    });
    expect(result.ok).toBe(true);
  });
  test('recurringAnnually scope precedence — location/doctor filters still apply', async () => {
    // Recurring annual leave for a specific doctor on 05-15. Same-day visit
    // for a DIFFERENT doctor should pass; visit for THIS doctor should block.
    prisma.holiday.findMany
      .mockResolvedValueOnce([]) // exact-date — empty
      .mockResolvedValueOnce([   // recurring — doctor-scoped
        { id: 12, name: 'Dr Sharma annual leave', date: new Date('2024-05-15'), locationId: null, doctorId: 7, recurringAnnually: true },
      ]);
    const passes = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 99,
    });
    expect(passes.ok).toBe(true);

    // Reset the mock for the second call (mockResolvedValueOnce is consumed).
    prisma.holiday.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 12, name: 'Dr Sharma annual leave', date: new Date('2024-05-15'), locationId: null, doctorId: 7, recurringAnnually: true },
      ]);
    const blocked = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe(CONFLICT_CODES.HOLIDAY_BLOCKED);
  });
  test('exact-date + recurring rows are de-duped (no double-block from the same row)', async () => {
    // Same row stored as both exact-date hit AND recurring hit (admin
    // accidentally created it that way). Should not crash; should still
    // block; should not produce a "duplicate-detail" message.
    const dup = { id: 13, name: 'Diwali', date: new Date('2026-05-15'), locationId: null, doctorId: null, recurringAnnually: true };
    prisma.holiday.findMany
      .mockResolvedValueOnce([dup])
      .mockResolvedValueOnce([dup]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONFLICT_CODES.HOLIDAY_BLOCKED);
  });
});

describe('lib/bookingAvailability — OUTSIDE_WORKING_HOURS', () => {
  test('visit time outside the working window blocks', async () => {
    prisma.workingHours.findMany.mockResolvedValue([
      { id: 1, dayOfWeek: 5, startTime: '09:00', endTime: '19:00', isActive: true },
    ]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_22_00,
      doctorId: 7,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONFLICT_CODES.OUTSIDE_WORKING_HOURS);
    expect(result.detail).toMatch(/09:00/);
  });
  test('visit time IN window passes', async () => {
    prisma.workingHours.findMany.mockResolvedValue([
      { id: 1, dayOfWeek: 5, startTime: '09:00', endTime: '19:00', isActive: true },
    ]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
    });
    expect(result.ok).toBe(true);
  });
  test('OR-of-windows: matches any one window', async () => {
    // morning + evening shifts; afternoon is a break
    prisma.workingHours.findMany.mockResolvedValue([
      { id: 1, dayOfWeek: 5, startTime: '09:00', endTime: '13:00', isActive: true },
      { id: 2, dayOfWeek: 5, startTime: '17:00', endTime: '21:00', isActive: true },
    ]);
    const morning = await assertVisitSlotAvailable({
      tenantId: 1, visitDate: '2026-05-15T11:00:00+05:30', doctorId: 7,
    });
    expect(morning.ok).toBe(true);
    const evening = await assertVisitSlotAvailable({
      tenantId: 1, visitDate: '2026-05-15T18:00:00+05:30', doctorId: 7,
    });
    expect(evening.ok).toBe(true);
    const lunch = await assertVisitSlotAvailable({
      tenantId: 1, visitDate: '2026-05-15T15:00:00+05:30', doctorId: 7,
    });
    expect(lunch.ok).toBe(false);
    expect(lunch.code).toBe(CONFLICT_CODES.OUTSIDE_WORKING_HOURS);
  });
  test('no doctorId → working-hours check skipped entirely', async () => {
    // staged but should never be queried
    prisma.workingHours.findMany.mockResolvedValue([
      { id: 1, dayOfWeek: 5, startTime: '09:00', endTime: '19:00', isActive: true },
    ]);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_22_00,
    });
    expect(result.ok).toBe(true);
    expect(prisma.workingHours.findMany).not.toHaveBeenCalled();
  });
});

describe('lib/bookingAvailability — RESOURCE_DOUBLE_BOOKED', () => {
  test('overlap on same resource + same hour bucket blocks', async () => {
    prisma.visit.findFirst.mockImplementation(async (args) => {
      // Distinguish resource vs doctor query by which field is in the where clause.
      if (args.where.resourceId === 3) {
        return { id: 555, visitDate: new Date(IST_FRIDAY_14_00) };
      }
      return null;
    });
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      resourceId: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONFLICT_CODES.RESOURCE_DOUBLE_BOOKED);
    expect(result.detail).toMatch(/#555/);
  });
  test('no overlap → ok:true', async () => {
    prisma.visit.findFirst.mockResolvedValue(null);
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      resourceId: 3,
    });
    expect(result.ok).toBe(true);
  });
  test('resource query filters on ACTIVE_STATUSES (not cancelled / completed)', async () => {
    let capturedWhere = null;
    prisma.visit.findFirst.mockImplementation(async (args) => {
      capturedWhere = args.where;
      return null;
    });
    await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      resourceId: 3,
    });
    expect(capturedWhere.status.in).toEqual(_internal.ACTIVE_STATUSES);
    expect(capturedWhere.status.in).not.toContain('cancelled');
    expect(capturedWhere.status.in).not.toContain('completed');
  });
  test('PUT path — visitId exclusion prevents self-conflict', async () => {
    let capturedWhere = null;
    prisma.visit.findFirst.mockImplementation(async (args) => {
      capturedWhere = args.where;
      return null;
    });
    await assertVisitSlotAvailable({
      id: 42, // PUT path
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      resourceId: 3,
    });
    expect(capturedWhere.id).toEqual({ not: 42 });
  });
});

describe('lib/bookingAvailability — DOCTOR_DOUBLE_BOOKED', () => {
  test('overlap on same doctor + same hour bucket blocks', async () => {
    prisma.visit.findFirst.mockImplementation(async (args) => {
      if (args.where.doctorId === 7) {
        return { id: 666, visitDate: new Date(IST_FRIDAY_14_00) };
      }
      return null;
    });
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONFLICT_CODES.DOCTOR_DOUBLE_BOOKED);
    expect(result.detail).toMatch(/#666/);
  });
  test('different doctor → no conflict', async () => {
    prisma.visit.findFirst.mockImplementation(async (args) => {
      if (args.where.doctorId === 8) {
        return { id: 777, visitDate: new Date(IST_FRIDAY_14_00) };
      }
      return null;
    });
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7, // different from staged
    });
    expect(result.ok).toBe(true);
  });
  test('precedence: resource conflict beats doctor conflict (resource checked first)', async () => {
    prisma.visit.findFirst.mockImplementation(async (args) => {
      // Both resource AND doctor have overlaps; resource is first.
      if (args.where.resourceId === 3) {
        return { id: 888, visitDate: new Date(IST_FRIDAY_14_00) };
      }
      if (args.where.doctorId === 7) {
        return { id: 999, visitDate: new Date(IST_FRIDAY_14_00) };
      }
      return null;
    });
    const result = await assertVisitSlotAvailable({
      tenantId: 1,
      visitDate: IST_FRIDAY_14_00,
      doctorId: 7,
      resourceId: 3,
    });
    expect(result.code).toBe(CONFLICT_CODES.RESOURCE_DOUBLE_BOOKED);
    expect(result.detail).toMatch(/#888/);
  });
});

describe('lib/bookingAvailability — internal helpers', () => {
  test('istDateKey renders IST calendar date', () => {
    // 2026-05-15T01:00:00Z is 06:30 IST on the same day; should still be 2026-05-15
    expect(_internal.istDateKey(new Date('2026-05-15T01:00:00Z'))).toBe('2026-05-15');
    // 2026-05-15T20:00:00Z is 01:30 IST NEXT day → 2026-05-16
    expect(_internal.istDateKey(new Date('2026-05-15T20:00:00Z'))).toBe('2026-05-16');
  });
  test('istTimeKey renders zero-padded HH:mm', () => {
    expect(_internal.istTimeKey(new Date('2026-05-15T08:30:00Z'))).toBe('14:00'); // 08:30 UTC = 14:00 IST
    expect(_internal.istTimeKey(new Date('2026-05-15T03:30:00Z'))).toBe('09:00'); // 03:30 UTC = 09:00 IST
  });
  test('hourBucketUtc rounds DOWN to start of hour', () => {
    const { hourStart, hourEnd } = _internal.hourBucketUtc(new Date('2026-05-15T14:37:00Z'));
    expect(hourStart.toISOString()).toBe('2026-05-15T14:00:00.000Z');
    expect(hourEnd.toISOString()).toBe('2026-05-15T15:00:00.000Z');
  });
  test('ACTIVE_STATUSES excludes cancelled + completed', () => {
    expect(_internal.ACTIVE_STATUSES).not.toContain('cancelled');
    expect(_internal.ACTIVE_STATUSES).not.toContain('completed');
    expect(_internal.ACTIVE_STATUSES).toContain('booked');
  });
});
