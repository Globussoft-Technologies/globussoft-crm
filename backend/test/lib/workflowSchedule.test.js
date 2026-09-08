// @ts-check
/**
 * Unit tests for backend/lib/workflowSchedule.js — the date arithmetic behind
 * time-based ("scheduled") workflows.
 *
 * Why this file exists
 * ────────────────────
 * Time-based triggers are the half of the Freshsales workflow feature the CRM
 * never had: every trigger was record-event driven, so "3 days before a deal's
 * expected close" and "every Monday at 9am" were inexpressible. All the maths
 * that decides WHEN a rule fires lives in this module, and every function takes
 * `now` as an argument rather than reading the clock, precisely so it can be
 * pinned here without fake timers.
 *
 * The cases that matter are the ones that are easy to get quietly wrong:
 *   • an annual anchor (birthday) must match on month+day, not on the stored
 *     year — otherwise a birthday rule fires exactly once, in the year the
 *     contact was born;
 *   • a January birthday evaluated in December must resolve FORWARD to next
 *     year rather than reporting a date ten months in the past;
 *   • monthly recurrence is capped at day 28 so a month-end rule does not skip
 *     February entirely;
 *   • `anchorWindow` must produce a range that actually CONTAINS the anchors
 *     whose occurrence is due, because it is used to narrow the Prisma query —
 *     a wrong window silently drops reminders rather than erroring;
 *   • the record key must carry the occurrence date, so moving a deal's close
 *     date re-arms its reminder while a repeated tick does not double-fire.
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const sut = requireCJS('../../lib/workflowSchedule');

const {
  SCHEDULE_ENTITIES,
  SCHEDULE_TRIGGERS,
  isScheduleTrigger,
  parseTimeOfDay,
  atTimeOfDay,
  occurrenceFor,
  anchorWindow,
  nextRecurringRun,
  validateScheduleConfig,
  occurrenceRecordKey,
  clampMaxRecords,
} = sut;

describe('module shape', () => {
  test('exposes the schedulable entities with date fields', () => {
    expect(Object.keys(SCHEDULE_ENTITIES).sort()).toEqual(['contact', 'deal', 'task', 'ticket']);
    for (const entity of Object.values(SCHEDULE_ENTITIES)) {
      expect(typeof entity.model).toBe('string');
      expect(typeof entity.idKey).toBe('string');
      expect(Array.isArray(entity.dateFields)).toBe(true);
      expect(entity.dateFields.length).toBeGreaterThan(0);
    }
  });

  test('advertises exactly the two scheduled triggers', () => {
    expect(SCHEDULE_TRIGGERS.map((t) => t.value)).toEqual(['schedule.date_field', 'schedule.recurring']);
  });

  test('isScheduleTrigger distinguishes scheduled from event-driven', () => {
    expect(isScheduleTrigger('schedule.date_field')).toBe(true);
    expect(isScheduleTrigger('schedule.recurring')).toBe(true);
    expect(isScheduleTrigger('deal.won')).toBe(false);
    expect(isScheduleTrigger(null)).toBe(false);
    expect(isScheduleTrigger(undefined)).toBe(false);
  });
});

describe('parseTimeOfDay', () => {
  test('parses HH:MM', () => {
    expect(parseTimeOfDay('09:30')).toEqual({ hours: 9, minutes: 30 });
    expect(parseTimeOfDay('9:05')).toEqual({ hours: 9, minutes: 5 });
    expect(parseTimeOfDay('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  test('falls back to midnight on garbage rather than NaN', () => {
    // NaN hours would propagate into an Invalid Date and silently stop a rule
    // from ever firing, with no error anywhere.
    for (const bad of ['', null, undefined, 'noon', '9', '09:5', {}]) {
      expect(parseTimeOfDay(bad)).toEqual({ hours: 0, minutes: 0 });
    }
  });

  test('clamps out-of-range components', () => {
    expect(parseTimeOfDay('99:99')).toEqual({ hours: 23, minutes: 59 });
  });
});

describe('atTimeOfDay', () => {
  test('snaps a date to the configured time without moving the day', () => {
    const result = atTimeOfDay(new Date('2026-08-27T18:44:12'), '09:15');
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(7); // August
    expect(result.getDate()).toBe(27);
    expect(result.getHours()).toBe(9);
    expect(result.getMinutes()).toBe(15);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });

  test('does not mutate its argument', () => {
    const input = new Date('2026-08-27T18:44:12');
    const before = input.getTime();
    atTimeOfDay(input, '09:00');
    expect(input.getTime()).toBe(before);
  });
});

describe('occurrenceFor — dated anchors', () => {
  const now = new Date('2026-08-27T10:00:00');

  test('negative offset fires BEFORE the anchor', () => {
    const occurrence = occurrenceFor(new Date('2026-09-10T00:00:00'), {
      offsetDays: -3, timeOfDay: '09:00',
    }, now);
    expect(occurrence.getMonth()).toBe(8); // September
    expect(occurrence.getDate()).toBe(7);
    expect(occurrence.getHours()).toBe(9);
  });

  test('positive offset fires AFTER the anchor', () => {
    const occurrence = occurrenceFor(new Date('2026-08-20T00:00:00'), {
      offsetDays: 5, timeOfDay: '08:30',
    }, now);
    expect(occurrence.getDate()).toBe(25);
    expect(occurrence.getHours()).toBe(8);
    expect(occurrence.getMinutes()).toBe(30);
  });

  test('zero offset fires on the anchor day itself', () => {
    const occurrence = occurrenceFor(new Date('2026-08-27T23:00:00'), {
      offsetDays: 0, timeOfDay: '09:00',
    }, now);
    expect(occurrence.getDate()).toBe(27);
    expect(occurrence.getHours()).toBe(9);
  });

  test('offset crossing a month boundary lands in the previous month', () => {
    const occurrence = occurrenceFor(new Date('2026-09-02T00:00:00'), {
      offsetDays: -5, timeOfDay: '09:00',
    }, now);
    expect(occurrence.getMonth()).toBe(7); // August
    expect(occurrence.getDate()).toBe(28);
  });

  test('returns null for an unusable anchor rather than an Invalid Date', () => {
    expect(occurrenceFor(null, { offsetDays: 0, timeOfDay: '09:00' }, now)).toBeNull();
    expect(occurrenceFor('not-a-date', { offsetDays: 0, timeOfDay: '09:00' }, now)).toBeNull();
  });

  test('accepts an ISO string as well as a Date', () => {
    const occurrence = occurrenceFor('2026-09-10T00:00:00', { offsetDays: 0, timeOfDay: '09:00' }, now);
    expect(occurrence.getDate()).toBe(10);
  });
});

describe('occurrenceFor — annual anchors (birthdays / anniversaries)', () => {
  test('projects a decades-old birthday onto the CURRENT year', () => {
    // The whole point: keying on the stored year would fire a birthday rule
    // exactly once, in 1987.
    const now = new Date('2026-08-27T10:00:00');
    const occurrence = occurrenceFor(new Date('1987-08-27T00:00:00'), {
      annual: true, offsetDays: 0, timeOfDay: '09:00', lookbackDays: 1,
    }, now);
    expect(occurrence.getFullYear()).toBe(2026);
    expect(occurrence.getMonth()).toBe(7);
    expect(occurrence.getDate()).toBe(27);
    expect(occurrence.getHours()).toBe(9);
  });

  test('resolves FORWARD to next year once this year is past the grace window', () => {
    // A January birthday evaluated in December must not report a date eleven
    // months in the past — that would make the rule permanently "overdue".
    const now = new Date('2026-12-15T10:00:00');
    const occurrence = occurrenceFor(new Date('1990-01-05T00:00:00'), {
      annual: true, offsetDays: 0, timeOfDay: '09:00', lookbackDays: 1,
    }, now);
    expect(occurrence.getFullYear()).toBe(2027);
    expect(occurrence.getMonth()).toBe(0);
    expect(occurrence.getDate()).toBe(5);
  });

  test('keeps this year inside the lookback grace window so a late tick still fires', () => {
    // Yesterday's birthday, cron a day behind: must still resolve to THIS
    // year's occurrence so the greeting goes out rather than waiting 12 months.
    const now = new Date('2026-08-27T10:00:00');
    const occurrence = occurrenceFor(new Date('1990-08-26T00:00:00'), {
      annual: true, offsetDays: 0, timeOfDay: '09:00', lookbackDays: 2,
    }, now);
    expect(occurrence.getFullYear()).toBe(2026);
    expect(occurrence.getDate()).toBe(26);
  });

  test('applies the day offset on top of the annual projection', () => {
    const now = new Date('2026-08-01T10:00:00');
    const occurrence = occurrenceFor(new Date('1990-08-27T00:00:00'), {
      annual: true, offsetDays: -7, timeOfDay: '09:00', lookbackDays: 1,
    }, now);
    expect(occurrence.getFullYear()).toBe(2026);
    expect(occurrence.getDate()).toBe(20);
  });
});

describe('anchorWindow', () => {
  test('returns null for annual configs (a stored-year range is meaningless)', () => {
    expect(anchorWindow({ annual: true, offsetDays: 0 }, new Date('2026-08-27T10:00:00'))).toBeNull();
  });

  test('CONTAINS the anchor of a record that is genuinely due', () => {
    // This is the assertion that matters: the window narrows the Prisma query,
    // so an anchor that falls outside it is silently never reminded about.
    const now = new Date('2026-08-27T10:00:00');
    const config = { offsetDays: -3, timeOfDay: '09:00', lookbackDays: 2 };
    const window = anchorWindow(config, now);

    // A deal closing on the 30th is due today (30th minus 3 days = 27th).
    const dueAnchor = new Date('2026-08-30T00:00:00');
    expect(dueAnchor >= window.gte).toBe(true);
    expect(dueAnchor <= window.lte).toBe(true);
  });

  test('EXCLUDES an anchor far outside the lookback window', () => {
    const now = new Date('2026-08-27T10:00:00');
    const window = anchorWindow({ offsetDays: -3, timeOfDay: '09:00', lookbackDays: 2 }, now);
    const farFuture = new Date('2027-01-01T00:00:00');
    const longPast = new Date('2025-01-01T00:00:00');
    expect(farFuture <= window.lte).toBe(false);
    expect(longPast >= window.gte).toBe(false);
  });

  test('a wider lookback widens the window', () => {
    const now = new Date('2026-08-27T10:00:00');
    const narrow = anchorWindow({ offsetDays: 0, lookbackDays: 1 }, now);
    const wide = anchorWindow({ offsetDays: 0, lookbackDays: 10 }, now);
    expect(wide.gte < narrow.gte).toBe(true);
  });
});

describe('nextRecurringRun', () => {
  test('daily rolls to tomorrow once today has passed', () => {
    const from = new Date('2026-08-27T18:00:00');
    const next = nextRecurringRun({ frequency: 'daily', timeOfDay: '09:00' }, from);
    expect(next.getDate()).toBe(28);
    expect(next.getHours()).toBe(9);
  });

  test('daily stays on today when the time is still ahead', () => {
    const from = new Date('2026-08-27T06:00:00');
    const next = nextRecurringRun({ frequency: 'daily', timeOfDay: '09:00' }, from);
    expect(next.getDate()).toBe(27);
  });

  test('hourly advances to the next hour', () => {
    const from = new Date('2026-08-27T06:45:00');
    const next = nextRecurringRun({ frequency: 'hourly', timeOfDay: '00:30' }, from);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(30);
  });

  test('weekly lands on the configured weekday, strictly in the future', () => {
    // 2026-08-27 is a Thursday (day 4); next Monday (day 1) is the 31st.
    const from = new Date('2026-08-27T10:00:00');
    const next = nextRecurringRun({ frequency: 'weekly', dayOfWeek: 1, timeOfDay: '09:00' }, from);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(31);
    expect(next > from).toBe(true);
  });

  test('weekly on today-but-later stays today', () => {
    const from = new Date('2026-08-27T06:00:00'); // Thursday
    const next = nextRecurringRun({ frequency: 'weekly', dayOfWeek: 4, timeOfDay: '09:00' }, from);
    expect(next.getDate()).toBe(27);
  });

  test('monthly rolls into the next month once the day has passed', () => {
    const from = new Date('2026-08-27T10:00:00');
    const next = nextRecurringRun({ frequency: 'monthly', dayOfMonth: 1, timeOfDay: '09:00' }, from);
    expect(next.getMonth()).toBe(8); // September
    expect(next.getDate()).toBe(1);
  });

  test('monthly never produces a day past 28, so February is never skipped', () => {
    const from = new Date('2026-01-30T10:00:00');
    const next = nextRecurringRun({ frequency: 'monthly', dayOfMonth: 31, timeOfDay: '09:00' }, from);
    expect(next.getDate()).toBeLessThanOrEqual(28);
  });

  test('every frequency returns a moment strictly after `from`', () => {
    const from = new Date('2026-08-27T09:00:00');
    for (const frequency of ['hourly', 'daily', 'weekly', 'monthly']) {
      const next = nextRecurringRun({ frequency, timeOfDay: '09:00', dayOfWeek: 4, dayOfMonth: 27 }, from);
      expect(next > from).toBe(true);
    }
  });
});

describe('validateScheduleConfig', () => {
  test('accepts a well-formed date_field config and canonicalises it', () => {
    const result = validateScheduleConfig(
      { entity: 'deal', field: 'expectedClose', offsetDays: -3, timeOfDay: '09:00' },
      'schedule.date_field',
    );
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      mode: 'date_field', entity: 'deal', field: 'expectedClose', offsetDays: -3, timeOfDay: '09:00',
    });
    expect(result.value.maxRecords).toBeGreaterThan(0);
  });

  test('accepts a JSON string as well as an object', () => {
    const result = validateScheduleConfig(
      JSON.stringify({ entity: 'deal', field: 'expectedClose', offsetDays: 0 }),
      'schedule.date_field',
    );
    expect(result.ok).toBe(true);
  });

  test('defaults `annual` from the field when not supplied', () => {
    const birthday = validateScheduleConfig({ entity: 'contact', field: 'birthDate', offsetDays: 0 }, 'schedule.date_field');
    expect(birthday.value.annual).toBe(true);
    const created = validateScheduleConfig({ entity: 'contact', field: 'createdAt', offsetDays: 0 }, 'schedule.date_field');
    expect(created.value.annual).toBe(false);
  });

  test('rejects an unknown entity', () => {
    const result = validateScheduleConfig({ entity: 'unicorn', field: 'x' }, 'schedule.date_field');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_SCHEDULE');
  });

  test('rejects a date field that does not exist on the entity', () => {
    const result = validateScheduleConfig({ entity: 'deal', field: 'birthDate' }, 'schedule.date_field');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/field must be one of/);
  });

  test('rejects a malformed timeOfDay', () => {
    const result = validateScheduleConfig(
      { entity: 'deal', field: 'expectedClose', offsetDays: 0, timeOfDay: 'noon' },
      'schedule.date_field',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HH:MM/);
  });

  test('rejects an absurd offset', () => {
    const result = validateScheduleConfig(
      { entity: 'deal', field: 'expectedClose', offsetDays: 5000 },
      'schedule.date_field',
    );
    expect(result.ok).toBe(false);
  });

  test('rejects an out-of-range dayOfWeek / dayOfMonth', () => {
    expect(validateScheduleConfig({ entity: 'deal', frequency: 'weekly', dayOfWeek: 9 }, 'schedule.recurring').ok).toBe(false);
    expect(validateScheduleConfig({ entity: 'deal', frequency: 'monthly', dayOfMonth: 31 }, 'schedule.recurring').ok).toBe(false);
  });

  test('rejects an unknown frequency', () => {
    const result = validateScheduleConfig({ entity: 'deal', frequency: 'fortnightly' }, 'schedule.recurring');
    expect(result.ok).toBe(false);
  });

  test('rejects a schedule attached to an EVENT-driven trigger', () => {
    // Otherwise a half-converted rule renders as scheduled in the builder and
    // then never runs, because no cron is looking at it.
    const result = validateScheduleConfig({ entity: 'deal', frequency: 'daily' }, 'deal.won');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only valid for schedule/);
  });

  test('allows an absent schedule on an event-driven trigger', () => {
    expect(validateScheduleConfig(null, 'deal.won')).toEqual({ ok: true, value: null });
    expect(validateScheduleConfig('', 'deal.won')).toEqual({ ok: true, value: null });
    expect(validateScheduleConfig({}, 'deal.won')).toEqual({ ok: true, value: null });
  });

  test('requires a schedule on a scheduled trigger', () => {
    expect(validateScheduleConfig(null, 'schedule.recurring').ok).toBe(false);
    expect(validateScheduleConfig('{not json', 'schedule.recurring').ok).toBe(false);
    expect(validateScheduleConfig([], 'schedule.recurring').ok).toBe(false);
  });
});

describe('clampMaxRecords', () => {
  test('defaults to 500 for absent or nonsensical input', () => {
    for (const bad of [undefined, null, 0, -5, 'lots', NaN]) {
      expect(clampMaxRecords(bad)).toBe(500);
    }
  });

  test('caps at 5000 so one rule cannot fan out unbounded work', () => {
    expect(clampMaxRecords(1_000_000)).toBe(5000);
  });

  test('passes a sane value through', () => {
    expect(clampMaxRecords(250)).toBe(250);
  });
});

describe('occurrenceRecordKey', () => {
  test('stamps the occurrence date so each occurrence dedupes separately', () => {
    const key = occurrenceRecordKey('dealId', 42, new Date('2026-09-07T09:00:00Z'));
    expect(key).toBe('dealId:42@2026-09-07');
  });

  test('a DIFFERENT occurrence date yields a different key', () => {
    // This is what re-arms a reminder when someone pushes a deal's close date
    // out. Keying on the record id alone would swallow the second reminder.
    const first = occurrenceRecordKey('dealId', 42, new Date('2026-09-07T09:00:00Z'));
    const second = occurrenceRecordKey('dealId', 42, new Date('2026-10-07T09:00:00Z'));
    expect(first).not.toBe(second);
  });

  test('the SAME occurrence yields a stable key, so a repeated tick cannot double-fire', () => {
    const a = occurrenceRecordKey('contactId', 7, new Date('2026-09-07T09:00:00Z'));
    const b = occurrenceRecordKey('contactId', 7, new Date('2026-09-07T23:30:00Z'));
    expect(a).toBe(b);
  });

  test('degrades to a marker rather than throwing on a bad date', () => {
    expect(occurrenceRecordKey('dealId', 1, null)).toBe('dealId:1@na');
    expect(occurrenceRecordKey('dealId', 1, new Date('nonsense'))).toBe('dealId:1@na');
  });
});
