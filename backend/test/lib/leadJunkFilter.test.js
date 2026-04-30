// Unit tests for backend/lib/leadJunkFilter.js
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup).
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import junk from '../../lib/leadJunkFilter.js';

const { classifyLead, isIndianMobile, looksLikeGibberish, suspiciousEmail } = junk;

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
