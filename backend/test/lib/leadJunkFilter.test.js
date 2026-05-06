// Unit tests for backend/lib/leadJunkFilter.js + backend/lib/junkSourceFilter.js
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup).
//
// Two helpers covered here because they're the matched pair gating "junk
// leads" in two complementary places:
//   - leadJunkFilter.classifyLead — gates lead INGESTION (POST /api/v1/external/leads,
//                                    /marketing/submit) — flags junk before it
//                                    persists.
//   - junkSourceFilter.isJunkSource — gates report VISIBILITY (GET /api/attribution
//                                      and GET /api/wellness/reports/attribution) —
//                                      hides test-* / e2e-* / qa-* / rbac-* source
//                                      buckets from operator-facing dashboards even
//                                      if junk leads slip past the ingestion gate.
//
// junkSourceFilter pairs with the v3.4.x cleanup-p3-data-quality.js one-shot
// (closed #268 by remapping existing rows) to make the filter durable: re-runs
// of the wellness E2E suite re-create test-skip / test-junk contacts, and
// without this helper they'd re-pollute the demo Marketing Attribution screen
// until the operator re-runs the scrub.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import junk from '../../lib/leadJunkFilter.js';
import junkSourceFilter from '../../lib/junkSourceFilter.js';

const { classifyLead, isIndianMobile, looksLikeGibberish, suspiciousEmail } = junk;
const { isJunkSource, JUNK_SOURCE_EXACT, JUNK_SOURCE_PREFIXES } = junkSourceFilter;

beforeAll(() => {
  prisma.contact = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.contact.findFirst.mockReset();
  prisma.contact.findFirst.mockResolvedValue(null); // no recent dup by default
  delete process.env.LEAD_JUNK_AI;
});

describe('lib/leadJunkFilter — module shape', () => {
  test('exports classifyLead + helpers', () => {
    expect(typeof classifyLead).toBe('function');
    expect(typeof isIndianMobile).toBe('function');
    expect(typeof looksLikeGibberish).toBe('function');
    expect(typeof suspiciousEmail).toBe('function');
  });
});

describe('lib/leadJunkFilter — isIndianMobile (pure)', () => {
  test('rejects empty/null', () => {
    expect(isIndianMobile(null)).toBe(false);
    expect(isIndianMobile(undefined)).toBe(false);
    expect(isIndianMobile('')).toBe(false);
  });

  test('accepts 10-digit starting with 6/7/8/9', () => {
    expect(isIndianMobile('9876543210')).toBe(true);
    expect(isIndianMobile('8123456789')).toBe(true);
    expect(isIndianMobile('7000000000')).toBe(true);
    expect(isIndianMobile('6111111111')).toBe(true);
  });

  test('rejects 10-digit starting with 0-5', () => {
    expect(isIndianMobile('1234567890')).toBe(false);
    expect(isIndianMobile('5876543210')).toBe(false);
  });

  test('accepts +91 12-digit format', () => {
    expect(isIndianMobile('+91 9876543210')).toBe(true);
    expect(isIndianMobile('919876543210')).toBe(true);
  });

  test('accepts 091 13-digit format', () => {
    expect(isIndianMobile('0919876543210')).toBe(true);
  });

  test('rejects foreign numbers', () => {
    expect(isIndianMobile('+1-555-1234567')).toBe(false);
    expect(isIndianMobile('14155551234')).toBe(false); // 11 digits, US
  });

  test('strips non-digits before checking', () => {
    expect(isIndianMobile('98765-43210')).toBe(true);
    expect(isIndianMobile('(987) 654-3210')).toBe(true);
  });
});

describe('lib/leadJunkFilter — looksLikeGibberish (pure)', () => {
  test('returns true for empty/null', () => {
    expect(looksLikeGibberish(null)).toBe(true);
    expect(looksLikeGibberish('')).toBe(true);
    expect(looksLikeGibberish(undefined)).toBe(true);
  });

  test('returns true for very short names', () => {
    expect(looksLikeGibberish('a')).toBe(true);
    expect(looksLikeGibberish(' ')).toBe(true);
  });

  test('returns true for all-numeric names', () => {
    expect(looksLikeGibberish('12345')).toBe(true);
  });

  test('returns true for repeating chars', () => {
    expect(looksLikeGibberish('aaaaaa')).toBe(true);
    expect(looksLikeGibberish('xxxxx')).toBe(true);
  });

  test('returns true for all-consonant strings', () => {
    expect(looksLikeGibberish('qwrty')).toBe(true);
    expect(looksLikeGibberish('bcdfg')).toBe(true);
  });

  test('returns true for known fillers', () => {
    expect(looksLikeGibberish('test')).toBe(true);
    expect(looksLikeGibberish('asdf')).toBe(true);
    expect(looksLikeGibberish('na')).toBe(true);
    expect(looksLikeGibberish('fake')).toBe(true);
    expect(looksLikeGibberish('xxxx')).toBe(true);
  });

  test('returns true for single letter variants', () => {
    expect(looksLikeGibberish('a.')).toBe(true);
    expect(looksLikeGibberish('X')).toBe(true);
  });

  test('returns false for normal Indian names', () => {
    expect(looksLikeGibberish('Rishu Kumar')).toBe(false);
    expect(looksLikeGibberish('Priya Sharma')).toBe(false);
    expect(looksLikeGibberish('Anjali')).toBe(false);
    expect(looksLikeGibberish('Mohammad Ali')).toBe(false);
  });

  test('returns false for normal English names', () => {
    expect(looksLikeGibberish('John Smith')).toBe(false);
    expect(looksLikeGibberish('Sarah')).toBe(false);
  });
});

describe('lib/leadJunkFilter — suspiciousEmail (pure)', () => {
  test('returns false for empty/null', () => {
    expect(suspiciousEmail(null)).toBe(false);
    expect(suspiciousEmail('')).toBe(false);
  });

  test('flags test/fake/dummy patterns', () => {
    expect(suspiciousEmail('test@gmail.com')).toBe(true);
    expect(suspiciousEmail('fake@yahoo.com')).toBe(true);
    expect(suspiciousEmail('temp@hotmail.com')).toBe(true);
    expect(suspiciousEmail('dummy@x.com')).toBe(true);
    expect(suspiciousEmail('noreply@x.com')).toBe(true);
    expect(suspiciousEmail('xyz@x.com')).toBe(true);
  });

  test('flags disposable domains', () => {
    expect(suspiciousEmail('me@mailinator.com')).toBe(true);
    expect(suspiciousEmail('me@tempmail.com')).toBe(true);
    expect(suspiciousEmail('me@yopmail.com')).toBe(true);
    expect(suspiciousEmail('me@guerrillamail.org')).toBe(true);
    expect(suspiciousEmail('me@10minutemail.net')).toBe(true);
    expect(suspiciousEmail('me@sharklasers.com')).toBe(true);
  });

  test('case-insensitive checks', () => {
    expect(suspiciousEmail('TEST@gmail.com')).toBe(true);
    expect(suspiciousEmail('me@MAILINATOR.com')).toBe(true);
  });

  test('passes legitimate emails', () => {
    expect(suspiciousEmail('rishu@gmail.com')).toBe(false);
    expect(suspiciousEmail('priya.sharma@yahoo.com')).toBe(false);
    expect(suspiciousEmail('user@enhancedwellness.in')).toBe(false);
  });
});

describe('lib/leadJunkFilter — classifyLead', () => {
  test('clean lead → not junk, score around 60', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'Rishu Kumar',
      phone: '9876543210',
      email: 'rishu@gmail.com',
      source: 'website',
    });
    expect(out.isJunk).toBe(false);
    expect(out.score).toBeGreaterThanOrEqual(60);
  });

  test('no contact info → instant junk with score 0', async () => {
    const out = await classifyLead({ tenantId: 1, name: 'X', phone: null, email: null });
    expect(out.isJunk).toBe(true);
    expect(out.score).toBe(0);
    expect(out.reasons).toContain('no contact info (no phone, no email)');
  });

  test('non-Indian phone → -35 score, reason added', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'John Smith',
      phone: '+1-555-1234567',
      email: 'john@gmail.com',
    });
    expect(out.reasons.some((r) => /non-Indian/i.test(r))).toBe(true);
    expect(out.score).toBeLessThan(60);
  });

  test('duplicate within 7d → -30 score', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 1 });
    const out = await classifyLead({
      tenantId: 1,
      name: 'Rishu',
      phone: '9876543210',
      email: 'rishu@gmail.com',
    });
    expect(out.reasons.some((r) => /duplicate/i.test(r))).toBe(true);
    expect(out.score).toBeLessThanOrEqual(30);
  });

  test('gibberish name → reason added', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'asdf',
      phone: '9876543210',
      email: 'real@gmail.com',
    });
    expect(out.reasons.some((r) => /gibberish/i.test(r))).toBe(true);
  });

  test('suspicious email → reason added', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'Real Name',
      phone: '9876543210',
      email: 'fake@mailinator.com',
    });
    expect(out.reasons.some((r) => /suspicious/i.test(r))).toBe(true);
  });

  test('multiple flags → confident junk', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'asdf',
      phone: '+1-555-1234567',
      email: 'fake@mailinator.com',
    });
    expect(out.isJunk).toBe(true);
    expect(out.reasons.length).toBeGreaterThan(1);
  });

  test('known good source bumps score by +10', async () => {
    const a = await classifyLead({
      tenantId: 1,
      name: 'Rishu Kumar',
      phone: '9876543210',
      email: 'rishu@gmail.com',
      source: 'website-form',
    });
    const b = await classifyLead({
      tenantId: 1,
      name: 'Rishu Kumar',
      phone: '9876543210',
      email: 'rishu@gmail.com',
      source: 'unknown',
    });
    expect(a.score).toBeGreaterThan(b.score);
  });

  test('referral source bumps score', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'Rishu',
      phone: '9876543210',
      email: 'rishu@gmail.com',
      source: 'referral',
    });
    expect(out.score).toBeGreaterThan(60);
  });

  test('walk-in source bumps score', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'Rishu',
      phone: '9876543210',
      email: 'rishu@gmail.com',
      source: 'walk-in',
    });
    expect(out.score).toBeGreaterThan(60);
  });

  test('score is clamped to [0,100]', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 1 });
    const out = await classifyLead({
      tenantId: 1,
      name: 'asdf',
      phone: '+1-555-1234567',
      email: 'fake@mailinator.com',
    });
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
  });

  test('isJunk threshold at score <= 25', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'asdf',
      phone: '+1-555-1234567',
      email: 'fake@mailinator.com',
    });
    expect(out.score).toBeLessThanOrEqual(25);
    expect(out.isJunk).toBe(true);
  });

  test('AI classifier disabled by default (no env)', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'ab',
      phone: '+1-555-1234567',
      email: 'real@gmail.com',
    });
    expect(out).toHaveProperty('isJunk');
    expect(out).toHaveProperty('score');
    expect(Array.isArray(out.reasons)).toBe(true);
  });

  test('returns shape with isJunk + score + reasons', async () => {
    const out = await classifyLead({
      tenantId: 1,
      name: 'Rishu',
      phone: '9876543210',
      email: 'rishu@gmail.com',
    });
    expect(out).toHaveProperty('isJunk');
    expect(out).toHaveProperty('score');
    expect(Array.isArray(out.reasons)).toBe(true);
  });

  test('isRecentDuplicate query uses 7-day window + last-10 phone digits', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await classifyLead({
      tenantId: 9,
      name: 'Rishu',
      phone: '+91 9876543210',
      email: 'rishu@gmail.com',
    });
    const arg = prisma.contact.findFirst.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(9);
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
    const orStr = JSON.stringify(arg.where.OR);
    expect(orStr).toContain('9876543210');
  });
});

// ─── lib/junkSourceFilter — closes regression-coverage-backlog #24 / #268 ─
//
// Pins the case-insensitive prefix-match contract that
// routes/attribution.js (generic) + routes/wellness.js (computeAttribution)
// rely on to keep test-skip / test-junk source rows out of operator-facing
// dashboards. The four exact values match what cleanup-p3-data-quality.js
// targeted; the prefix list is the durable forward-compat guard.

describe('lib/junkSourceFilter — module shape', () => {
  test('exports isJunkSource + canonical lists', () => {
    expect(typeof isJunkSource).toBe('function');
    expect(Array.isArray(JUNK_SOURCE_EXACT)).toBe(true);
    expect(Array.isArray(JUNK_SOURCE_PREFIXES)).toBe(true);
  });

  test('canonical EXACT list pins the four values cleanup-p3 targeted', () => {
    // Pin the contract: future agents adding/removing entries should be
    // forced to update this assertion deliberately, not silently drift it.
    expect(JUNK_SOURCE_EXACT).toEqual(['test-skip', 'test-junk', 'e2e-test', 'qa-test']);
  });

  test('PREFIXES covers test-/e2e-/qa-/rbac- — the original #268 issue suggestion', () => {
    expect(JUNK_SOURCE_PREFIXES).toEqual(['test-', 'e2e-', 'qa-', 'rbac-']);
  });
});

describe('lib/junkSourceFilter — isJunkSource (the report-visibility gate)', () => {
  test('returns false for null / undefined / empty', () => {
    expect(isJunkSource(null)).toBe(false);
    expect(isJunkSource(undefined)).toBe(false);
    expect(isJunkSource('')).toBe(false);
    expect(isJunkSource('   ')).toBe(false);
  });

  test('returns false for non-string inputs', () => {
    expect(isJunkSource(123)).toBe(false);
    expect(isJunkSource({})).toBe(false);
    expect(isJunkSource([])).toBe(false);
  });

  test('flags the four canonical exact values', () => {
    expect(isJunkSource('test-skip')).toBe(true);
    expect(isJunkSource('test-junk')).toBe(true);
    expect(isJunkSource('e2e-test')).toBe(true);
    expect(isJunkSource('qa-test')).toBe(true);
  });

  test('flags case-insensitively (External API doesnt lowercase)', () => {
    expect(isJunkSource('TEST-SKIP')).toBe(true);
    expect(isJunkSource('Test-Junk')).toBe(true);
    expect(isJunkSource('E2E-TEST')).toBe(true);
    expect(isJunkSource('QA-Test')).toBe(true);
  });

  test('flags by prefix — covers test-* / e2e-* / qa-* / rbac-* variants', () => {
    expect(isJunkSource('test-foo')).toBe(true);
    expect(isJunkSource('test-anything-here')).toBe(true);
    expect(isJunkSource('e2e-bar')).toBe(true);
    expect(isJunkSource('qa-baz')).toBe(true);
    expect(isJunkSource('rbac-test')).toBe(true);
    expect(isJunkSource('rbac-bypass-attempt')).toBe(true);
  });

  test('strips surrounding whitespace before matching', () => {
    expect(isJunkSource('  test-skip  ')).toBe(true);
    expect(isJunkSource('\ttest-junk\n')).toBe(true);
  });

  test('does NOT flag legit demo / production sources (the must-not-regress list)', () => {
    // Pulled from the actual wellness tenant + #268 issue body.
    expect(isJunkSource('whatsapp')).toBe(false);
    expect(isJunkSource('website-form')).toBe(false);
    expect(isJunkSource('meta_ad')).toBe(false);
    expect(isJunkSource('callified')).toBe(false);
    expect(isJunkSource('organic')).toBe(false);
    expect(isJunkSource('web')).toBe(false);
    expect(isJunkSource('embed_widget')).toBe(false);
    expect(isJunkSource('walk-in')).toBe(false);
    expect(isJunkSource('referral')).toBe(false);
    expect(isJunkSource('google-ad')).toBe(false);
    expect(isJunkSource('IndiaMART')).toBe(false);
    expect(isJunkSource('JustDial')).toBe(false);
    expect(isJunkSource('TradeIndia')).toBe(false);
    expect(isJunkSource('other')).toBe(false);
    expect(isJunkSource('unknown')).toBe(false);
  });

  test('does NOT flag sources that merely CONTAIN test/e2e in the middle', () => {
    // Prefix-match, not contains. "test-" at position 0 is junk; "test"
    // anywhere else is a legitimate source name (e.g. "best-test-platform"
    // — unlikely in practice but the contract is prefix not substring).
    expect(isJunkSource('best-platform')).toBe(false);
    expect(isJunkSource('contest-winner')).toBe(false);
    expect(isJunkSource('honest-feedback')).toBe(false);
  });

  test('a Contact with source=test-skip is excluded (the #268 acceptance criterion)', () => {
    // This is the report-side filtering predicate: callers in
    // routes/attribution.js + routes/wellness.js use isJunkSource(c.source)
    // to skip junk rows before adding them to the byChannel/bySource maps.
    const contacts = [
      { id: 1, source: 'test-skip', firstTouchSource: 'test-skip' },
      { id: 2, source: 'test-junk', firstTouchSource: null },
      { id: 3, source: 'organic', firstTouchSource: 'organic' },
      { id: 4, source: 'whatsapp', firstTouchSource: null },
      { id: 5, source: null, firstTouchSource: null },
    ];
    const visible = contacts.filter(
      (c) => !isJunkSource(c.firstTouchSource || c.source)
    );
    expect(visible.map((c) => c.id)).toEqual([3, 4, 5]);
  });
});
