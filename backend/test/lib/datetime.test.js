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

describe('callsite patterns — pins for the 2026-05-07 datetime sweep', () => {
  // These tests pin the EXACT shape of computation the route-level
  // callsites perform. They guard against future refactors of the
  // helper that would silently break the wellness day-boundary +
  // visit-POST datetime-local sniffing migrations (#313, #244).

  describe('wellness day-boundary pattern (routes/wellness.js startOfDay/endOfDay)', () => {
    // Pin: startOfDay(d) computes the IST calendar date of `d`, then
    // returns the UTC instant that is 00:00 IST on that date. The new
    // helper-based form must produce the IDENTICAL instant as the
    // pre-migration offset-math form.
    function startOfDayHelperForm(d) {
      const istDate = formatInTenantTZ(d, 'Asia/Kolkata', 'yyyy-MM-dd');
      return parseDateTimeLocalInTZ(`${istDate}T00:00:00`, 'Asia/Kolkata');
    }
    function startOfDayOffsetMathForm(d) {
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const ist = new Date(d.getTime() + IST_OFFSET_MS);
      ist.setUTCHours(0, 0, 0, 0);
      return new Date(ist.getTime() - IST_OFFSET_MS);
    }
    function endOfDayHelperForm(d) {
      const istDate = formatInTenantTZ(d, 'Asia/Kolkata', 'yyyy-MM-dd');
      const utc = parseDateTimeLocalInTZ(`${istDate}T23:59:59`, 'Asia/Kolkata');
      return new Date(utc.getTime() + 999);
    }
    function endOfDayOffsetMathForm(d) {
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const ist = new Date(d.getTime() + IST_OFFSET_MS);
      ist.setUTCHours(23, 59, 59, 999);
      return new Date(ist.getTime() - IST_OFFSET_MS);
    }

    test('startOfDay: helper form === offset-math form (mid-day UTC)', () => {
      const d = new Date('2026-05-15T08:30:00.000Z'); // 14:00 IST
      expect(startOfDayHelperForm(d).getTime()).toBe(startOfDayOffsetMathForm(d).getTime());
    });

    test('startOfDay: helper form === offset-math form (00:30 IST = 19:00 UTC prev day)', () => {
      // 00:30 IST is the canonical "would land on previous day under UTC"
      // case — the original IST_OFFSET_MS hack existed precisely for this.
      const d = new Date('2026-05-14T19:00:00.000Z'); // 00:30 IST May 15
      const helper = startOfDayHelperForm(d);
      const offset = startOfDayOffsetMathForm(d);
      expect(helper.getTime()).toBe(offset.getTime());
      // And the answer is 18:30 UTC (which is 00:00 IST on May 15).
      expect(helper.toISOString()).toBe('2026-05-14T18:30:00.000Z');
    });

    test('endOfDay: helper form === offset-math form (incl. .999ms)', () => {
      const d = new Date('2026-05-15T08:30:00.000Z');
      expect(endOfDayHelperForm(d).getTime()).toBe(endOfDayOffsetMathForm(d).getTime());
    });

    test('endOfDay last instant of IST day = 18:29:59.999Z next day', () => {
      const d = new Date('2026-05-15T12:00:00.000Z'); // 17:30 IST May 15
      const out = endOfDayHelperForm(d);
      // Last instant of IST May 15 = 23:59:59.999 IST = 18:29:59.999 UTC
      expect(out.toISOString()).toBe('2026-05-15T18:29:59.999Z');
    });
  });

  describe('parseTenantDateInput sniffing pattern (visit POST/PUT)', () => {
    // Pin: the sniffer detects datetime-local form (no TZ marker) and
    // routes through parseDateTimeLocalInTZ; full ISO with 'Z' or '±HH:mm'
    // suffix passes to the native Date constructor.
    const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
    function parseTenantDateInput(input) {
      if (input == null) return null;
      if (input instanceof Date) return input;
      if (typeof input !== 'string') return new Date(input);
      if (DATETIME_LOCAL_RE.test(input)) {
        return parseDateTimeLocalInTZ(input, 'Asia/Kolkata');
      }
      return new Date(input);
    }

    test('datetime-local form ("10:30") routes through helper → IST=05:00Z', () => {
      const d = parseTenantDateInput('2026-05-15T10:30');
      expect(d.toISOString()).toBe('2026-05-15T05:00:00.000Z');
    });

    test('datetime-local-with-seconds form ("10:30:45")', () => {
      const d = parseTenantDateInput('2026-05-15T10:30:45');
      expect(d.toISOString()).toBe('2026-05-15T05:00:45.000Z');
    });

    test('full ISO with Z suffix passes through native Date — no drift', () => {
      const iso = '2026-05-15T05:00:00.000Z';
      const d = parseTenantDateInput(iso);
      expect(d.toISOString()).toBe(iso);
    });

    test('full ISO with explicit offset suffix passes through', () => {
      const d = parseTenantDateInput('2026-05-15T10:30:00+05:30');
      expect(d.toISOString()).toBe('2026-05-15T05:00:00.000Z');
    });

    test('full ISO with negative offset suffix passes through', () => {
      const d = parseTenantDateInput('2026-05-15T00:00:00-05:00');
      expect(d.toISOString()).toBe('2026-05-15T05:00:00.000Z');
    });

    test('null input returns null (caller can branch)', () => {
      expect(parseTenantDateInput(null)).toBeNull();
    });

    test('Date instance passes through unchanged (idempotent)', () => {
      const d = new Date('2026-05-15T05:00:00.000Z');
      expect(parseTenantDateInput(d)).toBe(d);
    });
  });

  describe('audit-viewer createdAtFormatted pattern (routes/audit_viewer.js)', () => {
    // Pin: the row decorator renders createdAt in the viewer's TZ with a
    // TZ label. Both null/Invalid (graceful '—') and valid Date inputs
    // are exercised.
    function decorateRow(row, tz) {
      if (!row) return row;
      return {
        ...row,
        createdAtFormatted: formatInTenantTZ(row.createdAt, tz),
        viewerTimezone: tz,
      };
    }

    test('valid createdAt + Asia/Kolkata → wall-clock + TZ label', () => {
      const row = { id: 1, createdAt: new Date('2026-05-15T05:00:00.000Z') };
      const out = decorateRow(row, 'Asia/Kolkata');
      expect(out.createdAtFormatted.startsWith('2026-05-15 10:30 ')).toBe(true);
      expect(out.viewerTimezone).toBe('Asia/Kolkata');
    });

    test('valid createdAt + UTC viewer → 05:00 UTC', () => {
      const row = { id: 1, createdAt: new Date('2026-05-15T05:00:00.000Z') };
      const out = decorateRow(row, 'UTC');
      expect(out.createdAtFormatted.startsWith('2026-05-15 05:00 ')).toBe(true);
    });

    test('null createdAt renders "—" (graceful sentinel)', () => {
      const row = { id: 1, createdAt: null };
      const out = decorateRow(row, 'Asia/Kolkata');
      expect(out.createdAtFormatted).toBe('—');
    });

    test('row decoration preserves all original fields', () => {
      const row = { id: 1, action: 'CREATE', entity: 'Contact', createdAt: new Date('2026-05-15T05:00:00.000Z') };
      const out = decorateRow(row, 'Asia/Kolkata');
      expect(out.id).toBe(1);
      expect(out.action).toBe('CREATE');
      expect(out.entity).toBe('Contact');
      expect(out.createdAt).toBe(row.createdAt);
    });
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
