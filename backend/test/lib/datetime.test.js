// Unit tests for backend/lib/datetime.js — tenant-aware datetime helpers
// that back the wellness vertical's visit timestamps, datetime-local form
// inputs, and audit-log rendering.
//
// Why this exists: regression class #244 / #313 / #387.
//   - #313 datetime-local form input drift: a user entering '10:30' on an
//     Asia/Kolkata tenant saw '05:00' after refresh because the browser's
//     <input type="datetime-local"> emits the wall-clock time without a TZ
//     suffix and the backend interpreted it as UTC. This suite pins the
//     round-trip: parse('2026-05-15T10:30', 'Asia/Kolkata') → UTC Date
//     '2026-05-15T05:00:00.000Z', then format(...) back to '2026-05-15T10:30'.
//   - #244 Visit timestamps render UTC, not tenant TZ. The format helper's
//     default produces a tenant-local rendering with a TZ label.
//   - #387 AuditLog timestamps need a TZ label so reviewers can read the
//     local-time-of-action without doing offset math. The default format
//     always includes the trailing TZ token (' IST', ' GMT-5', etc.).
//
// Pure-function pattern: no mocks, just input → output assertions. See
// backend/test/utils/formatMoney.test.js for the same shape.
//
// Closes regression-coverage-backlog #23; covers GitHub issues #244, #313,
// #387. Note this test pins the HELPER's contract — the callsite migration
// (routes/wellness.js IST_OFFSET_MS shortcut, naive `new Date(req.body)`
// constructions, the audit-log render layer in lib/audit.js) is OUT OF
// SCOPE; that remains a follow-up sweep tracked in TODOS.md.

import { describe, test, expect } from 'vitest';
const {
  parseDateTimeLocalInTZ,
  formatInTenantTZ,
  toDateTimeLocalInTZ,
  nowInTZ,
  DEFAULT_DATETIME_LOCAL_FORMAT,
  DEFAULT_DISPLAY_FORMAT,
} = require('../../lib/datetime');

describe('datetime — module shape', () => {
  test('exports parseDateTimeLocalInTZ + formatInTenantTZ + toDateTimeLocalInTZ + nowInTZ', () => {
    expect(typeof parseDateTimeLocalInTZ).toBe('function');
    expect(typeof formatInTenantTZ).toBe('function');
    expect(typeof toDateTimeLocalInTZ).toBe('function');
    expect(typeof nowInTZ).toBe('function');
  });

  test('exports format-string constants for callers that want to override', () => {
    expect(DEFAULT_DATETIME_LOCAL_FORMAT).toBe("yyyy-MM-dd'T'HH:mm");
    expect(DEFAULT_DISPLAY_FORMAT).toBe('yyyy-MM-dd HH:mm zzz');
  });
});

describe('parseDateTimeLocalInTZ — #313 round-trip (verbatim acceptance)', () => {
  // The exact assertion from regression-coverage-backlog.md line 447:
  //   datetime-local input '2026-05-15T10:30' with tenant TZ Asia/Kolkata
  //   stores as UTC '2026-05-15T05:00:00Z' and reads back as '2026-05-15T10:30'.
  test('"2026-05-15T10:30" + Asia/Kolkata → UTC "2026-05-15T05:00:00.000Z"', () => {
    const d = parseDateTimeLocalInTZ('2026-05-15T10:30', 'Asia/Kolkata');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-05-15T05:00:00.000Z');
  });

  test('round-trip: parse → format → original input string', () => {
    const d = parseDateTimeLocalInTZ('2026-05-15T10:30', 'Asia/Kolkata');
    expect(toDateTimeLocalInTZ(d, 'Asia/Kolkata')).toBe('2026-05-15T10:30');
  });

  test('parse accepts seconds-form input as well', () => {
    const d = parseDateTimeLocalInTZ('2026-05-15T10:30:45', 'Asia/Kolkata');
    // 10:30:45 IST = 05:00:45 UTC
    expect(d.toISOString()).toBe('2026-05-15T05:00:45.000Z');
  });
});

describe('parseDateTimeLocalInTZ — non-IST tenants (DST coverage)', () => {
  // America/New_York is the canonical DST test — the offset changes from
  // EST (-5) to EDT (-4) twice a year. The helper must not assume a fixed
  // offset.
  test('Jan 15 (EST, -5) — "10:30" → 15:30 UTC', () => {
    const d = parseDateTimeLocalInTZ('2026-01-15T10:30', 'America/New_York');
    expect(d.toISOString()).toBe('2026-01-15T15:30:00.000Z');
  });

  test('Jul 15 (EDT, -4) — "10:30" → 14:30 UTC', () => {
    const d = parseDateTimeLocalInTZ('2026-07-15T10:30', 'America/New_York');
    expect(d.toISOString()).toBe('2026-07-15T14:30:00.000Z');
  });

  test('UTC tenant — "10:30" → 10:30 UTC (offset 0)', () => {
    const d = parseDateTimeLocalInTZ('2026-05-15T10:30', 'UTC');
    expect(d.toISOString()).toBe('2026-05-15T10:30:00.000Z');
  });
});

describe('parseDateTimeLocalInTZ — boundary cases', () => {
  test('midnight rollover at IST: 00:30 IST = 19:00 UTC previous day', () => {
    const d = parseDateTimeLocalInTZ('2026-05-15T00:30', 'Asia/Kolkata');
    expect(d.toISOString()).toBe('2026-05-14T19:00:00.000Z');
  });

  test('end-of-month rollover: 23:30 IST on Jan 31 = 18:00 UTC Jan 31', () => {
    const d = parseDateTimeLocalInTZ('2026-01-31T23:30', 'Asia/Kolkata');
    expect(d.toISOString()).toBe('2026-01-31T18:00:00.000Z');
  });

  test('leap year Feb 29 in Asia/Kolkata', () => {
    // 2024 is a leap year. 12:00 IST Feb 29 2024 = 06:30 UTC.
    const d = parseDateTimeLocalInTZ('2024-02-29T12:00', 'Asia/Kolkata');
    expect(d.toISOString()).toBe('2024-02-29T06:30:00.000Z');
  });
});

describe('parseDateTimeLocalInTZ — bad input', () => {
  test('malformed datetime-local string returns Invalid Date', () => {
    const d = parseDateTimeLocalInTZ('not-a-date', 'Asia/Kolkata');
    expect(isNaN(d.getTime())).toBe(true);
  });

  test('empty string returns Invalid Date', () => {
    const d = parseDateTimeLocalInTZ('', 'Asia/Kolkata');
    expect(isNaN(d.getTime())).toBe(true);
  });

  test('null input returns Invalid Date (no throw)', () => {
    const d = parseDateTimeLocalInTZ(null, 'Asia/Kolkata');
    expect(isNaN(d.getTime())).toBe(true);
  });

  test('unknown TZ returns Invalid Date (date-fns-tz signals via NaN)', () => {
    const d = parseDateTimeLocalInTZ('2026-05-15T10:30', 'Foo/Bar');
    expect(isNaN(d.getTime())).toBe(true);
  });

  test('empty TZ returns Invalid Date', () => {
    const d = parseDateTimeLocalInTZ('2026-05-15T10:30', '');
    expect(isNaN(d.getTime())).toBe(true);
  });
});

describe('formatInTenantTZ — #244 + #387 (TZ-aware render with TZ label)', () => {
  // The exact UTC Date produced by the #313 round-trip.
  const utcDate = new Date('2026-05-15T05:00:00.000Z');

  test('default format renders Asia/Kolkata wall-clock with " IST" label', () => {
    expect(formatInTenantTZ(utcDate, 'Asia/Kolkata')).toBe('2026-05-15 10:30 IST');
  });

  test('default format always includes a TZ label (#387 anti-regression)', () => {
    // Regex pin: every default-format output ends with a non-empty TZ token.
    // IST tenant gets ' IST'; non-IST gets ' GMT±N'.
    const out1 = formatInTenantTZ(utcDate, 'Asia/Kolkata');
    expect(out1).toMatch(/ [A-Z]+$|GMT[+-]\d+$/);

    const out2 = formatInTenantTZ(utcDate, 'America/New_York');
    expect(out2).toMatch(/ [A-Z]+$|GMT[+-]\d+$/);

    const out3 = formatInTenantTZ(utcDate, 'Europe/London');
    expect(out3).toMatch(/ [A-Z]+$|GMT[+-]\d+$/);
  });

  test('renders DST offset correctly: NY in January is GMT-5', () => {
    // 15:30 UTC in Jan = 10:30 EST (winter, GMT-5).
    const winter = new Date('2026-01-15T15:30:00.000Z');
    expect(formatInTenantTZ(winter, 'America/New_York')).toBe('2026-01-15 10:30 GMT-5');
  });

  test('renders DST offset correctly: NY in July is GMT-4', () => {
    // 14:30 UTC in Jul = 10:30 EDT (summer, GMT-4).
    const summer = new Date('2026-07-15T14:30:00.000Z');
    expect(formatInTenantTZ(summer, 'America/New_York')).toBe('2026-07-15 10:30 GMT-4');
  });

  test('UTC tenant renders with " UTC" label', () => {
    // date-fns-tz uses the IANA short name 'UTC' (not 'GMT') for the
    // UTC zone. Either is correct ISO-wise; we pin the actual library
    // output so callers know what to expect.
    expect(formatInTenantTZ(utcDate, 'UTC')).toBe('2026-05-15 05:00 UTC');
  });

  test('caller can override format string (TZ label optional then)', () => {
    expect(formatInTenantTZ(utcDate, 'Asia/Kolkata', 'yyyy-MM-dd')).toBe('2026-05-15');
    expect(formatInTenantTZ(utcDate, 'Asia/Kolkata', 'HH:mm')).toBe('10:30');
  });

  test('accepts string + numeric inputs (Date constructor coverage)', () => {
    const iso = '2026-05-15T05:00:00.000Z';
    expect(formatInTenantTZ(iso, 'Asia/Kolkata')).toBe('2026-05-15 10:30 IST');

    const epoch = utcDate.getTime();
    expect(formatInTenantTZ(epoch, 'Asia/Kolkata')).toBe('2026-05-15 10:30 IST');
  });
});

describe('formatInTenantTZ — bad input', () => {
  test('null Date returns "—" (graceful sentinel, no throw)', () => {
    expect(formatInTenantTZ(null, 'Asia/Kolkata')).toBe('—');
  });

  test('Invalid Date returns "—"', () => {
    expect(formatInTenantTZ(new Date('not-a-date'), 'Asia/Kolkata')).toBe('—');
  });

  test('unknown TZ returns "—" (no throw)', () => {
    expect(formatInTenantTZ(new Date('2026-05-15T05:00:00Z'), 'Foo/Bar')).toBe('—');
  });

  test('empty TZ returns "—"', () => {
    expect(formatInTenantTZ(new Date('2026-05-15T05:00:00Z'), '')).toBe('—');
  });
});

describe('toDateTimeLocalInTZ — round-trip render half', () => {
  test('renders UTC Date as datetime-local string in tenant TZ (no offset suffix)', () => {
    const d = new Date('2026-05-15T05:00:00.000Z');
    expect(toDateTimeLocalInTZ(d, 'Asia/Kolkata')).toBe('2026-05-15T10:30');
  });

  test('round-trip parse + render is the identity on valid inputs', () => {
    const original = '2026-08-22T14:45';
    const parsed = parseDateTimeLocalInTZ(original, 'Asia/Kolkata');
    expect(toDateTimeLocalInTZ(parsed, 'Asia/Kolkata')).toBe(original);
  });

  test('round-trip across DST boundary in America/New_York', () => {
    // Mid-summer EDT — round-trip stable.
    const original = '2026-07-15T10:30';
    const parsed = parseDateTimeLocalInTZ(original, 'America/New_York');
    expect(toDateTimeLocalInTZ(parsed, 'America/New_York')).toBe(original);
  });

  test('Invalid Date renders as "—"', () => {
    expect(toDateTimeLocalInTZ(new Date('garbage'), 'Asia/Kolkata')).toBe('—');
  });
});

describe('nowInTZ — convenience for current time render', () => {
  test('produces a non-empty string in the default display format', () => {
    const out = nowInTZ('Asia/Kolkata');
    // Shape: 'YYYY-MM-DD HH:mm <TZ-label>'
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
  });

  test('default-format output ends with a TZ label (#387 anti-regression)', () => {
    expect(nowInTZ('Asia/Kolkata')).toMatch(/ IST$/);
    expect(nowInTZ('UTC')).toMatch(/ UTC$/);
  });

  test('honours caller-supplied format', () => {
    const out = nowInTZ('Asia/Kolkata', 'yyyy');
    expect(out).toMatch(/^\d{4}$/);
  });

  test('unknown TZ returns "—"', () => {
    expect(nowInTZ('Foo/Bar')).toBe('—');
  });
});
