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

  // Cross-environment note: the trailing TZ label in date-fns-tz's 'zzz'
  // token is rendered by ICU. Different Node builds and host OS images
  // ship different ICU + tzdata versions, so the SAME tz on different
  // runners can produce either:
  //   - the IANA short name ('IST', 'EST', 'EDT', 'UTC'), OR
  //   - the offset form ('GMT+5:30', 'GMT-5', 'GMT-4', 'UTC').
  // Both are correct ISO-wise. CI's runner image happens to give offset
  // form for IST/EST/EDT and the local-dev box happens to give the IANA
  // names. Tests here assert on the wall-clock prefix + the presence of
  // SOME TZ label (rather than pinning the exact label), keeping the
  // helper's contract verifiable across both ICU builds.
  //
  // The wall-clock part of the render IS deterministic and IS pinned —
  // that's what #244 / #313 / #387 actually care about.
  const TZ_LABEL_RE = /(?:[A-Z]{3,5}|GMT[+-]\d{1,2}(?::\d{2})?|UTC)$/;

  test('default format renders Asia/Kolkata wall-clock + TZ label', () => {
    const out = formatInTenantTZ(utcDate, 'Asia/Kolkata');
    expect(out.startsWith('2026-05-15 10:30 ')).toBe(true);
    expect(out).toMatch(TZ_LABEL_RE);
  });

  test('default format always includes a TZ label (#387 anti-regression)', () => {
    // Regex pin: every default-format output ends with a non-empty TZ token,
    // either the IANA short name (IST/EST/UTC/…) or the offset form (GMT±N).
    expect(formatInTenantTZ(utcDate, 'Asia/Kolkata')).toMatch(TZ_LABEL_RE);
    expect(formatInTenantTZ(utcDate, 'America/New_York')).toMatch(TZ_LABEL_RE);
    expect(formatInTenantTZ(utcDate, 'Europe/London')).toMatch(TZ_LABEL_RE);
    expect(formatInTenantTZ(utcDate, 'UTC')).toMatch(TZ_LABEL_RE);
  });

  test('renders DST offset correctly: NY in January (winter, -5)', () => {
    // 15:30 UTC in Jan = 10:30 EST (winter, GMT-5). Wall-clock pinned;
    // TZ label can be either 'EST' or 'GMT-5' depending on ICU build.
    const winter = new Date('2026-01-15T15:30:00.000Z');
    const out = formatInTenantTZ(winter, 'America/New_York');
    expect(out.startsWith('2026-01-15 10:30 ')).toBe(true);
    expect(out).toMatch(TZ_LABEL_RE);
  });

  test('renders DST offset correctly: NY in July (summer, -4)', () => {
    // 14:30 UTC in Jul = 10:30 EDT (summer, GMT-4). Wall-clock pinned.
    const summer = new Date('2026-07-15T14:30:00.000Z');
    const out = formatInTenantTZ(summer, 'America/New_York');
    expect(out.startsWith('2026-07-15 10:30 ')).toBe(true);
    expect(out).toMatch(TZ_LABEL_RE);
  });

  test('renders distinct labels for NY winter vs summer (anti-DST-ignore regression)', () => {
    // We don't care WHAT the labels are (build-dependent), but they MUST
    // differ — otherwise DST is being silently dropped.
    const winterLabel = formatInTenantTZ(new Date('2026-01-15T15:30:00.000Z'), 'America/New_York').split(' ').pop();
    const summerLabel = formatInTenantTZ(new Date('2026-07-15T14:30:00.000Z'), 'America/New_York').split(' ').pop();
    expect(winterLabel).not.toBe(summerLabel);
  });

  test('UTC tenant renders wall-clock + UTC-family label', () => {
    // date-fns-tz uses 'UTC' (not 'GMT') for the UTC zone on most ICU
    // builds. We pin the wall-clock and accept either form.
    const out = formatInTenantTZ(utcDate, 'UTC');
    expect(out.startsWith('2026-05-15 05:00 ')).toBe(true);
    expect(out).toMatch(/(?:UTC|GMT)$/);
  });

  test('caller can override format string (TZ label optional then)', () => {
    expect(formatInTenantTZ(utcDate, 'Asia/Kolkata', 'yyyy-MM-dd')).toBe('2026-05-15');
    expect(formatInTenantTZ(utcDate, 'Asia/Kolkata', 'HH:mm')).toBe('10:30');
  });

  test('accepts string + numeric inputs (Date constructor coverage)', () => {
    const iso = '2026-05-15T05:00:00.000Z';
    expect(formatInTenantTZ(iso, 'Asia/Kolkata').startsWith('2026-05-15 10:30 ')).toBe(true);

    const epoch = utcDate.getTime();
    expect(formatInTenantTZ(epoch, 'Asia/Kolkata').startsWith('2026-05-15 10:30 ')).toBe(true);
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
    // Same cross-ICU caveat as the formatInTenantTZ block: accept either
    // IANA short name or GMT-offset form.
    expect(nowInTZ('Asia/Kolkata')).toMatch(/(?:IST|GMT\+5:30)$/);
    expect(nowInTZ('UTC')).toMatch(/(?:UTC|GMT)$/);
  });

  test('honours caller-supplied format', () => {
    const out = nowInTZ('Asia/Kolkata', 'yyyy');
    expect(out).toMatch(/^\d{4}$/);
  });

  test('unknown TZ returns "—"', () => {
    expect(nowInTZ('Foo/Bar')).toBe('—');
  });
});
