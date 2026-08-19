// Unit tests for backend/lib/leadReportMetrics.js
//
// These are the pure helpers behind the Lead Reports cluster
// (routes/lead_reports.js): period bucketing for the daily/weekly/monthly
// productivity report, call-status + score-band classification for the lead
// quality report, stage matching for the lead-stage funnel builder, and the
// visit / follow-up classifiers behind the meetings and visited-but-not-booked
// reports.
//
// No DB, no clock reads that aren't injected — every "now" is passed in so the
// assertions can't drift with the calendar.
import { describe, test, expect } from 'vitest';

const M = await import('../../lib/leadReportMetrics.js');

describe('normalizeCallStatus', () => {
  test('folds legacy hot/cold values forward like the Leads grid does', () => {
    expect(M.normalizeCallStatus('hot')).toBe('qualified');
    expect(M.normalizeCallStatus('cold')).toBe('junk');
  });

  test('recognises the canonical values regardless of case / spacing', () => {
    expect(M.normalizeCallStatus('QUALIFIED')).toBe('qualified');
    expect(M.normalizeCallStatus('Yet To Call')).toBe('yet_to_call');
    expect(M.normalizeCallStatus('  Junk ')).toBe('junk');
  });

  test('maps DNP synonyms', () => {
    expect(M.normalizeCallStatus('dnp')).toBe('dnp');
    expect(M.normalizeCallStatus('not_picked')).toBe('dnp');
    expect(M.normalizeCallStatus('no_answer')).toBe('dnp');
  });

  test('null / unknown falls back to yet_to_call, never undefined', () => {
    expect(M.normalizeCallStatus(null)).toBe('yet_to_call');
    expect(M.normalizeCallStatus('')).toBe('yet_to_call');
    expect(M.normalizeCallStatus('something-else')).toBe('yet_to_call');
  });
});

describe('rate', () => {
  test('returns a one-decimal percentage', () => {
    expect(M.rate(1, 3)).toBe(33.3);
    expect(M.rate(50, 200)).toBe(25);
  });

  test('a zero denominator yields 0, not NaN or Infinity', () => {
    expect(M.rate(5, 0)).toBe(0);
    expect(M.rate(0, 0)).toBe(0);
  });
});

describe('bucketKey', () => {
  test('daily key is the UTC calendar date', () => {
    expect(M.bucketKey('2026-08-17T22:15:00.000Z', 'daily')).toBe('2026-08-17');
  });

  test('weekly key anchors to the Monday of that week', () => {
    // 2026-08-17 is a Monday; 2026-08-19 (Wed) and 2026-08-23 (Sun) share it.
    expect(M.bucketKey('2026-08-17T00:00:00.000Z', 'weekly')).toBe('2026-08-17');
    expect(M.bucketKey('2026-08-19T12:00:00.000Z', 'weekly')).toBe('2026-08-17');
    expect(M.bucketKey('2026-08-23T23:59:00.000Z', 'weekly')).toBe('2026-08-17');
    expect(M.bucketKey('2026-08-24T00:00:00.000Z', 'weekly')).toBe('2026-08-24');
  });

  test('monthly key is YYYY-MM', () => {
    expect(M.bucketKey('2026-08-01T00:00:00.000Z', 'monthly')).toBe('2026-08');
    expect(M.bucketKey('2026-08-31T23:59:59.000Z', 'monthly')).toBe('2026-08');
  });

  test('an unparseable date returns null rather than an "Invalid Date" bucket', () => {
    expect(M.bucketKey('not-a-date', 'daily')).toBeNull();
    expect(M.bucketKey(undefined, 'monthly')).toBeNull();
  });

  test('an unknown period falls back to daily', () => {
    expect(M.bucketKey('2026-08-17T00:00:00.000Z', 'hourly')).toBe('2026-08-17');
  });
});

describe('buildBuckets', () => {
  test('produces a gap-free daily skeleton inclusive of both ends', () => {
    const b = M.buildBuckets('2026-08-01T00:00:00.000Z', '2026-08-05T23:59:59.000Z', 'daily');
    expect(b.map((x) => x.key)).toEqual([
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05',
    ]);
  });

  test('monthly skeleton walks calendar months, not 30-day steps', () => {
    const b = M.buildBuckets('2026-01-15T00:00:00.000Z', '2026-04-02T00:00:00.000Z', 'monthly');
    expect(b.map((x) => x.key)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  test('weekly skeleton steps 7 days from the Monday of the start week', () => {
    const b = M.buildBuckets('2026-08-19T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'weekly');
    expect(b.map((x) => x.key)).toEqual(['2026-08-17', '2026-08-24', '2026-08-31']);
  });

  test('an inverted or unparseable range yields an empty skeleton, never a runaway loop', () => {
    expect(M.buildBuckets('2026-08-10', '2026-08-01', 'daily')).toEqual([]);
    expect(M.buildBuckets('nope', '2026-08-01', 'daily')).toEqual([]);
  });

  test('honours the maxBuckets ceiling', () => {
    const b = M.buildBuckets('2020-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', 'daily', { maxBuckets: 10 });
    expect(b).toHaveLength(10);
  });
});

describe('bucketLabel', () => {
  test('weekly labels read as a week-of date', () => {
    expect(M.bucketLabel('2026-08-17', 'weekly')).toBe('Week of 17 Aug');
  });

  test('monthly labels read as month + year', () => {
    expect(M.bucketLabel('2026-08', 'monthly')).toBe('Aug 2026');
  });

  test('daily labels read as day + month', () => {
    expect(M.bucketLabel('2026-08-17', 'daily')).toBe('17 Aug');
  });
});

describe('scoreBand', () => {
  test('bands are inclusive at both edges', () => {
    expect(M.scoreBand(0)).toBe('0-20');
    expect(M.scoreBand(20)).toBe('0-20');
    expect(M.scoreBand(21)).toBe('21-40');
    expect(M.scoreBand(81)).toBe('81-100');
    expect(M.scoreBand(100)).toBe('81-100');
  });

  test('out-of-range and non-numeric scores clamp instead of returning undefined', () => {
    expect(M.scoreBand(140)).toBe('81-100');
    expect(M.scoreBand(-5)).toBe('0-20');
    expect(M.scoreBand(null)).toBe('0-20');
    expect(M.scoreBand('abc')).toBe('0-20');
  });
});

describe('matchesStage / resolveStage', () => {
  const stages = M.DEFAULT_LEAD_STAGES;

  test('matches on contact status', () => {
    expect(M.matchesStage({ status: 'Customer' }, { statuses: ['customer'] })).toBe(true);
    expect(M.matchesStage({ status: 'Lead' }, { statuses: ['customer'] })).toBe(false);
  });

  test('matches on call status through the normaliser', () => {
    expect(M.matchesStage({ callifiedLeadStatus: 'hot' }, { callStatuses: ['qualified'] })).toBe(true);
  });

  test('matches on a minimum lead score', () => {
    expect(M.matchesStage({ aiScore: 80 }, { minScore: 70 })).toBe(true);
    expect(M.matchesStage({ aiScore: 60 }, { minScore: 70 })).toBe(false);
  });

  test('the later stage wins over a stale shallower signal', () => {
    // A converted customer whose callStatus was never updated past "connected"
    // must report as converted, not as contacted.
    const contact = { status: 'Customer', callifiedLeadStatus: 'connected' };
    expect(M.resolveStage(contact, stages)).toBe('converted');
  });

  test('a junked lead lands in the drop-out bucket, not at the top of the funnel', () => {
    // Junking a lead does not change Contact.status — it stays "Lead" forever,
    // which also matches the `new` stage. The call disposition is the newer
    // signal, so last-match-wins has to put this row in `junk`.
    expect(M.resolveStage({ status: 'Lead', callifiedLeadStatus: 'junk' }, stages)).toBe('junk');
    expect(M.resolveStage({ status: 'Lead', callifiedLeadStatus: 'dnp' }, stages)).toBe('dnp');
    expect(M.resolveStage({ status: 'Churned' }, stages)).toBe('churned');
  });

  test('a contact matching nothing resolves to null so the route can count it as unclassified', () => {
    expect(M.resolveStage({ status: 'Archived', callifiedLeadStatus: null }, [
      { key: 'won', label: 'Won', statuses: ['customer'] },
    ])).toBeNull();
  });

  test('an empty stage list falls back to the shipped defaults', () => {
    expect(M.resolveStage({ status: 'Customer' }, [])).toBe('converted');
  });
});

describe('sanitizeStages', () => {
  const ok = [{ key: 'new', label: 'New', statuses: ['Lead'] }];

  test('accepts a minimal valid config and normalises the key', () => {
    const out = M.sanitizeStages([{ key: ' New Stage! ', label: 'New', statuses: ['Lead'] }]);
    expect(out[0].key).toBe('newstage');
    expect(out[0].label).toBe('New');
    expect(out[0].leak).toBe(false);
  });

  test('clamps minScore into 0..100', () => {
    const out = M.sanitizeStages([{ key: 'hot', label: 'Hot', minScore: 500 }]);
    expect(out[0].minScore).toBe(100);
  });

  test('rejects a non-array or empty list', () => {
    expect(() => M.sanitizeStages(null)).toThrow(/non-empty array/);
    expect(() => M.sanitizeStages([])).toThrow(/non-empty array/);
  });

  test('rejects duplicate keys', () => {
    expect(() => M.sanitizeStages([...ok, { key: 'new', label: 'Dup', statuses: ['Lead'] }]))
      .toThrow(/Duplicate stage key/);
  });

  test('rejects a stage with no match rule', () => {
    expect(() => M.sanitizeStages([{ key: 'x', label: 'X' }])).toThrow(/no match rule/);
  });

  test('rejects a config that is entirely drop-out buckets', () => {
    expect(() => M.sanitizeStages([{ key: 'junk', label: 'Junk', callStatuses: ['junk'], leak: true }]))
      .toThrow(/at least one stage must be a funnel stage/i);
  });

  test('rejects more than 20 stages', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ key: `s${i}`, label: `S${i}`, statuses: ['Lead'] }));
    expect(() => M.sanitizeStages(many)).toThrow(/at most 20 stages/);
  });

  test('carries a machine-readable code on every rejection', () => {
    try {
      M.sanitizeStages([]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('INVALID_STAGES');
    }
  });
});

describe('isVisitTask', () => {
  test('an explicit Meeting / Site Visit type always counts', () => {
    expect(M.isVisitTask({ type: 'Meeting', title: 'Anything' })).toBe(true);
    expect(M.isVisitTask({ type: 'Site Visit', title: 'Anything' })).toBe(true);
  });

  test('an explicit non-visit type is excluded even if the title says "meeting"', () => {
    expect(M.isVisitTask({ type: 'Call', title: 'Book the meeting' })).toBe(false);
  });

  test('legacy rows (type null) fall back to a title probe', () => {
    expect(M.isVisitTask({ type: null, title: 'Site visit with Mr Rao' })).toBe(true);
    expect(M.isVisitTask({ title: 'Client meeting at 4pm' })).toBe(true);
    expect(M.isVisitTask({ title: 'Send the revised quote' })).toBe(false);
  });

  test('notes are not probed — they mention "meeting" in passing too often', () => {
    expect(M.isVisitTask({ title: 'Send quote', notes: 'discussed at the meeting' })).toBe(false);
  });

  test('null-safe', () => {
    expect(M.isVisitTask(null)).toBe(false);
    expect(M.isVisitTask({})).toBe(false);
  });
});

describe('resolveVisitType', () => {
  test('a set Type is reported verbatim', () => {
    expect(M.resolveVisitType({ type: 'Site Visit', title: 'anything' }))
      .toEqual({ label: 'Site Visit', source: 'set' });
    expect(M.resolveVisitType({ type: 'Meeting', title: 'Site visit with Mr Rao' }))
      .toEqual({ label: 'Meeting', source: 'set' });
  });

  test('an untyped row titled "Site visit" is labelled Site Visit, not Meeting', () => {
    // Regression: the fallback used to hard-code "Meeting", so a task the
    // operator titled "Site visit" came back displayed as a Meeting.
    expect(M.resolveVisitType({ type: null, title: 'Site visit ' }))
      .toEqual({ label: 'Site Visit', source: 'inferred' });
    expect(M.resolveVisitType({ title: 'Walk-in at the Whitefield site' }))
      .toEqual({ label: 'Site Visit', source: 'inferred' });
  });

  test('an untyped row with no site-visit phrasing falls back to Meeting', () => {
    expect(M.resolveVisitType({ title: 'Schedule GulfStar demo with procurement' }))
      .toEqual({ label: 'Meeting', source: 'inferred' });
  });

  test('always reports whether the label was set or guessed', () => {
    expect(M.resolveVisitType({}).source).toBe('inferred');
    expect(M.resolveVisitType({ type: 'Call' }).source).toBe('set');
  });
});

describe('normalizeVisitOutcome / isBookedOutcome', () => {
  test('canonical values pass through', () => {
    expect(M.normalizeVisitOutcome('booked')).toBe('booked');
    expect(M.normalizeVisitOutcome('no_show')).toBe('no_show');
  });

  test('common phrasings are folded onto the canonical set', () => {
    expect(M.normalizeVisitOutcome('Booking Done')).toBe('booked');
    expect(M.normalizeVisitOutcome('Not Interested')).toBe('not_interested');
    expect(M.normalizeVisitOutcome('Interested')).toBe('interested');
    expect(M.normalizeVisitOutcome('Rescheduled')).toBe('reschedule');
    expect(M.normalizeVisitOutcome('No Show')).toBe('no_show');
  });

  test('"not interested" is not mis-read as "interested"', () => {
    expect(M.normalizeVisitOutcome('not interested')).toBe('not_interested');
    expect(M.isBookedOutcome('not interested')).toBe(false);
  });

  test('missing / unknown outcomes read as pending', () => {
    expect(M.normalizeVisitOutcome(null)).toBe('pending');
    expect(M.normalizeVisitOutcome('mystery')).toBe('pending');
  });

  test('isBookedOutcome only fires on a booked result', () => {
    expect(M.isBookedOutcome('booked')).toBe(true);
    expect(M.isBookedOutcome('Closed Won')).toBe(true);
    expect(M.isBookedOutcome('pending')).toBe(false);
  });
});

describe('followUpState', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');

  test('a completed task is completed regardless of its due date', () => {
    expect(M.followUpState({ status: 'Completed', dueDate: '2020-01-01' }, now)).toBe('completed');
  });

  test('yesterday is overdue, today is due_today, tomorrow is upcoming', () => {
    expect(M.followUpState({ status: 'Pending', dueDate: '2026-08-16T23:00:00.000Z' }, now)).toBe('overdue');
    expect(M.followUpState({ status: 'Pending', dueDate: '2026-08-17T01:00:00.000Z' }, now)).toBe('due_today');
    expect(M.followUpState({ status: 'Pending', dueDate: '2026-08-18T00:30:00.000Z' }, now)).toBe('upcoming');
  });

  test('a task due later today is still due_today, not overdue', () => {
    expect(M.followUpState({ status: 'Pending', dueDate: '2026-08-17T23:30:00.000Z' }, now)).toBe('due_today');
  });

  test('no due date (or an unparseable one) is undated, not overdue', () => {
    expect(M.followUpState({ status: 'Pending', dueDate: null }, now)).toBe('undated');
    expect(M.followUpState({ status: 'Pending', dueDate: 'garbage' }, now)).toBe('undated');
  });

  test('null-safe', () => {
    expect(M.followUpState(null, now)).toBe('undated');
  });
});

describe('daysBetween', () => {
  test('returns a one-decimal day delta', () => {
    expect(M.daysBetween('2026-08-01T00:00:00.000Z', '2026-08-04T12:00:00.000Z')).toBe(3.5);
  });

  test('returns null on missing or unparseable input rather than NaN', () => {
    expect(M.daysBetween(null, '2026-08-04')).toBeNull();
    expect(M.daysBetween('nope', '2026-08-04')).toBeNull();
  });
});
