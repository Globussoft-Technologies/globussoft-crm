// Unit tests for backend/lib/calendarSlots.js — the shared slot-picker math
// used by both the Google and Outlook calendar /slots endpoints. Pure
// functions, no mocks: input → output assertions.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { clampInt, parseSlotWindow, freeSlots } = requireCJS('../../lib/calendarSlots');

describe('clampInt', () => {
  test('returns the default on NaN/undefined input', () => {
    expect(clampInt(undefined, 30, 5, 480)).toBe(30);
    expect(clampInt('abc', 30, 5, 480)).toBe(30);
  });
  test('clamps to the inclusive [min,max] range', () => {
    expect(clampInt('1000', 30, 5, 480)).toBe(480);
    expect(clampInt('1', 30, 5, 480)).toBe(5);
    expect(clampInt('45', 30, 5, 480)).toBe(45);
  });
});

describe('parseSlotWindow', () => {
  test('rejects a missing or mis-formatted date', () => {
    expect(parseSlotWindow({}).error).toMatch(/date is required/i);
    expect(parseSlotWindow({ date: '15-01-2999' }).error).toMatch(/date is required/i);
  });

  test('rejects endHour <= startHour', () => {
    expect(parseSlotWindow({ date: '2999-01-15', startHour: 18, endHour: 9 }).error).toMatch(/endHour/i);
  });

  test('builds a UTC working window when tzOffset is 0', () => {
    const w = parseSlotWindow({ date: '2999-01-15', startHour: 9, endHour: 18, durationMins: 60, tzOffsetMins: 0 });
    expect(w.error).toBeUndefined();
    expect(w.durationMins).toBe(60);
    expect(new Date(w.windowStartMs).toISOString()).toBe('2999-01-15T09:00:00.000Z');
    expect(new Date(w.windowEndMs).toISOString()).toBe('2999-01-15T18:00:00.000Z');
  });

  test('applies tzOffsetMins — 09:00 IST (+330) maps to 03:30 UTC', () => {
    const w = parseSlotWindow({ date: '2999-01-15', startHour: 9, endHour: 18, tzOffsetMins: 330 });
    expect(new Date(w.windowStartMs).toISOString()).toBe('2999-01-15T03:30:00.000Z');
  });

  test('stepMins defaults to durationMins', () => {
    const w = parseSlotWindow({ date: '2999-01-15', durationMins: 45 });
    expect(w.stepMins).toBe(45);
  });
});

describe('freeSlots', () => {
  const start = Date.UTC(2999, 0, 15, 9);
  const end = Date.UTC(2999, 0, 15, 18);

  test('excludes busy windows; first free slot is after the busy block', () => {
    const busy = [{ start: Date.UTC(2999, 0, 15, 9), end: Date.UTC(2999, 0, 15, 10) }];
    const slots = freeSlots(start, end, busy, 60, 60, 0); // nowMs=0 → nothing is "past"
    expect(slots.length).toBe(8);
    expect(slots[0].start).toBe('2999-01-15T10:00:00.000Z');
    expect(new Date(slots[0].end) - new Date(slots[0].start)).toBe(60 * 60_000);
  });

  test('no busy windows → the full set of slots', () => {
    expect(freeSlots(start, end, [], 60, 60, 0).length).toBe(9);
  });

  test('slots starting before nowMs are dropped', () => {
    expect(freeSlots(start, end, [], 60, 60, end)).toEqual([]);
  });
});
