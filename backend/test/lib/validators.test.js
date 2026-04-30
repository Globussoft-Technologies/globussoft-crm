// Unit tests for backend/lib/validators.js — pure-input validators with
// no I/O. Covers every exported helper and every error-code branch.
import { describe, test, expect } from 'vitest';
import validators from '../../lib/validators.js';

const {
  EMAIL_RE,
  ensurePhone,
  ensureEmail,
  ensureNumberInRange,
  ensureEnum,
  ensureDateInRange,
  ensureDob,
  ensureVisitDate,
  ensureStringLength,
  ensureEmailList,
  conflictFromPrisma,
  httpFromPrismaError,
  isValidEmailOrEmpty,
  isValidPhoneOrEmpty,
} = validators;

describe('module shape', () => {
  test('exports all expected helpers', () => {
    expect(typeof ensurePhone).toBe('function');
    expect(typeof ensureEmail).toBe('function');
    expect(typeof ensureNumberInRange).toBe('function');
    expect(typeof ensureEnum).toBe('function');
    expect(typeof ensureDateInRange).toBe('function');
    expect(typeof ensureDob).toBe('function');
    expect(typeof ensureVisitDate).toBe('function');
    expect(typeof ensureStringLength).toBe('function');
    expect(typeof ensureEmailList).toBe('function');
    expect(typeof conflictFromPrisma).toBe('function');
    expect(typeof httpFromPrismaError).toBe('function');
    expect(typeof isValidEmailOrEmpty).toBe('function');
    expect(typeof isValidPhoneOrEmpty).toBe('function');
    expect(EMAIL_RE).toBeInstanceOf(RegExp);
  });
});

describe('isValidPhoneOrEmpty', () => {
  test('returns true on null', () => {
    expect(isValidPhoneOrEmpty(null)).toBe(true);
  });
  test('returns true on undefined', () => {
    expect(isValidPhoneOrEmpty(undefined)).toBe(true);
  });
  test('returns true on empty string', () => {
    expect(isValidPhoneOrEmpty('')).toBe(true);
  });
  test('returns false on non-string types', () => {
    expect(isValidPhoneOrEmpty(1234567890)).toBe(false);
  });
  test('accepts 10-digit phone', () => {
    expect(isValidPhoneOrEmpty('9876543210')).toBe(true);
  });
  test('accepts 15-digit phone (boundary)', () => {
    expect(isValidPhoneOrEmpty('123456789012345')).toBe(true);
  });
  test('rejects 9-digit phone (boundary)', () => {
    expect(isValidPhoneOrEmpty('123456789')).toBe(false);
  });
  test('rejects 16-digit phone (boundary)', () => {
    expect(isValidPhoneOrEmpty('1234567890123456')).toBe(false);
  });
  test('strips +, -, spaces, parens', () => {
    expect(isValidPhoneOrEmpty('+91 (987) 654-3210')).toBe(true);
  });
  test('rejects when stripping leaves too few digits', () => {
    expect(isValidPhoneOrEmpty('+1 (23) 45')).toBe(false);
  });
});

describe('ensurePhone', () => {
  test('returns null for empty', () => {
    expect(ensurePhone('')).toBeNull();
  });
  test('returns null for valid phone', () => {
    expect(ensurePhone('9876543210')).toBeNull();
  });
  test('returns INVALID_PHONE for too short', () => {
    const err = ensurePhone('123');
    expect(err).toEqual({
      status: 400,
      error: expect.stringContaining('phone'),
      code: 'INVALID_PHONE',
    });
  });
  test('returns INVALID_PHONE for non-string', () => {
    const err = ensurePhone(12345);
    expect(err.code).toBe('INVALID_PHONE');
    expect(err.status).toBe(400);
  });
});

describe('isValidEmailOrEmpty', () => {
  test('null is valid', () => {
    expect(isValidEmailOrEmpty(null)).toBe(true);
  });
  test('empty string is valid', () => {
    expect(isValidEmailOrEmpty('')).toBe(true);
  });
  test('plain valid email', () => {
    expect(isValidEmailOrEmpty('a@b.co')).toBe(true);
  });
  test('rejects no @', () => {
    expect(isValidEmailOrEmpty('foo')).toBe(false);
  });
  test('rejects no TLD', () => {
    expect(isValidEmailOrEmpty('foo@bar')).toBe(false);
  });
  test('rejects non-string', () => {
    expect(isValidEmailOrEmpty(42)).toBe(false);
  });
  test('rejects with comma', () => {
    expect(isValidEmailOrEmpty('a,b@c.co')).toBe(false);
  });
});

describe('ensureEmail', () => {
  test('returns null on empty when not required', () => {
    expect(ensureEmail('')).toBeNull();
    expect(ensureEmail(null)).toBeNull();
    expect(ensureEmail(undefined)).toBeNull();
  });
  test('returns EMAIL_REQUIRED on empty when required', () => {
    const err = ensureEmail('', { required: true });
    expect(err).toEqual({
      status: 400,
      error: 'email is required',
      code: 'EMAIL_REQUIRED',
    });
  });
  test('returns null for valid email', () => {
    expect(ensureEmail('rishu@enhancedwellness.in')).toBeNull();
  });
  test('returns INVALID_EMAIL for malformed', () => {
    const err = ensureEmail('nope');
    expect(err.code).toBe('INVALID_EMAIL');
    expect(err.status).toBe(400);
  });
});

describe('ensureNumberInRange', () => {
  test('returns null on empty when not required', () => {
    expect(ensureNumberInRange('', { field: 'qty' })).toBeNull();
    expect(ensureNumberInRange(null, { field: 'qty' })).toBeNull();
  });
  test('returns required-error code when required', () => {
    const err = ensureNumberInRange('', { field: 'qty', required: true });
    expect(err.code).toBe('QTY_REQUIRED');
    expect(err.status).toBe(400);
  });
  test('uses custom code on required', () => {
    const err = ensureNumberInRange(null, { field: 'qty', required: true, code: 'CUSTOM_REQ' });
    expect(err.code).toBe('CUSTOM_REQ');
  });
  test('rejects non-numeric', () => {
    const err = ensureNumberInRange('abc', { field: 'qty' });
    expect(err.code).toBe('INVALID_QTY');
  });
  test('rejects below min', () => {
    const err = ensureNumberInRange(0, { min: 1, field: 'qty' });
    expect(err.code).toBe('QTY_TOO_LOW');
  });
  test('accepts at min boundary', () => {
    expect(ensureNumberInRange(1, { min: 1, field: 'qty' })).toBeNull();
  });
  test('rejects above max', () => {
    const err = ensureNumberInRange(101, { max: 100, field: 'qty' });
    expect(err.code).toBe('QTY_TOO_HIGH');
  });
  test('accepts at max boundary', () => {
    expect(ensureNumberInRange(100, { max: 100, field: 'qty' })).toBeNull();
  });
  test('accepts string-coerced number', () => {
    expect(ensureNumberInRange('42', { min: 0, max: 100, field: 'qty' })).toBeNull();
  });
  test('rejects Infinity', () => {
    const err = ensureNumberInRange(Infinity, { field: 'qty' });
    expect(err.code).toBe('INVALID_QTY');
  });
});

describe('ensureEnum', () => {
  const allowed = ['draft', 'sent', 'paid'];
  test('returns null on empty when not required', () => {
    expect(ensureEnum('', allowed, { field: 'status' })).toBeNull();
  });
  test('returns required-error when required', () => {
    const err = ensureEnum(null, allowed, { field: 'status', required: true });
    expect(err.code).toBe('STATUS_REQUIRED');
  });
  test('accepts allowed value', () => {
    expect(ensureEnum('paid', allowed, { field: 'status' })).toBeNull();
  });
  test('rejects unknown value', () => {
    const err = ensureEnum('archived', allowed, { field: 'status' });
    expect(err.code).toBe('INVALID_STATUS');
    expect(err.error).toContain('draft, sent, paid');
  });
  test('accepts allowed when passed as Set', () => {
    expect(ensureEnum('paid', new Set(allowed), { field: 'status' })).toBeNull();
  });
  test('honours custom code', () => {
    const err = ensureEnum('zzz', allowed, { field: 'status', code: 'BAD_STAT' });
    expect(err.code).toBe('BAD_STAT');
  });
});

describe('ensureDateInRange', () => {
  test('returns null on empty when not required', () => {
    expect(ensureDateInRange('', { field: 'eventDate' })).toBeNull();
  });
  test('returns required-error when required', () => {
    const err = ensureDateInRange(null, { field: 'eventDate', required: true });
    expect(err.code).toBe('EVENTDATE_REQUIRED');
  });
  test('rejects invalid date string', () => {
    const err = ensureDateInRange('not-a-date', { field: 'eventDate' });
    expect(err.code).toBe('INVALID_EVENTDATE');
  });
  test('rejects below minYear', () => {
    const err = ensureDateInRange('1999-06-01', { minYear: 2000, field: 'eventDate' });
    expect(err.code).toBe('EVENTDATE_TOO_OLD');
  });
  test('accepts at minYear boundary', () => {
    expect(ensureDateInRange('2000-01-01', { minYear: 2000, field: 'eventDate' })).toBeNull();
  });
  test('rejects above maxYear', () => {
    const err = ensureDateInRange('2031-01-01', { maxYear: 2030, field: 'eventDate' });
    expect(err.code).toBe('EVENTDATE_TOO_FUTURE');
  });
  test('accepts at maxYear boundary', () => {
    expect(ensureDateInRange('2030-12-31', { maxYear: 2030, field: 'eventDate' })).toBeNull();
  });
});

describe('ensureDob', () => {
  test('returns null when empty and not required', () => {
    expect(ensureDob('')).toBeNull();
    expect(ensureDob(null)).toBeNull();
  });
  test('returns DOB_REQUIRED when required', () => {
    const err = ensureDob('', { required: true });
    expect(err.code).toBe('DOB_REQUIRED');
  });
  test('returns INVALID_DOB on garbage input', () => {
    const err = ensureDob('garbage');
    expect(err.code).toBe('INVALID_DOB');
  });
  test('returns DOB_OUT_OF_RANGE for pre-1900', () => {
    const err = ensureDob('1899-12-31');
    expect(err.code).toBe('DOB_OUT_OF_RANGE');
  });
  test('returns DOB_OUT_OF_RANGE for future date', () => {
    const future = new Date(Date.now() + 86400_000 * 30).toISOString();
    const err = ensureDob(future);
    expect(err.code).toBe('DOB_OUT_OF_RANGE');
  });
  test('accepts a normal adult DOB', () => {
    expect(ensureDob('1985-07-15')).toBeNull();
  });
  test('accepts edge of 1900', () => {
    expect(ensureDob('1900-01-01')).toBeNull();
  });
});

describe('ensureVisitDate', () => {
  test('returns null on empty when not required', () => {
    expect(ensureVisitDate('')).toBeNull();
  });
  test('returns VISIT_DATE_REQUIRED when required', () => {
    const err = ensureVisitDate('', { required: true });
    expect(err.code).toBe('VISIT_DATE_REQUIRED');
  });
  test('returns VISIT_DATE_INVALID on garbage', () => {
    const err = ensureVisitDate('xx');
    expect(err.code).toBe('VISIT_DATE_INVALID');
  });
  test('returns VISIT_DATE_OUT_OF_RANGE for too far in past', () => {
    const tenYearsAgo = new Date(Date.now() - 10 * 365 * 86400_000).toISOString();
    const err = ensureVisitDate(tenYearsAgo);
    expect(err.code).toBe('VISIT_DATE_OUT_OF_RANGE');
  });
  test('returns VISIT_DATE_OUT_OF_RANGE for too far ahead', () => {
    const twoYearsAhead = new Date(Date.now() + 2 * 365 * 86400_000).toISOString();
    const err = ensureVisitDate(twoYearsAhead);
    expect(err.code).toBe('VISIT_DATE_OUT_OF_RANGE');
  });
  test('accepts today', () => {
    expect(ensureVisitDate(new Date().toISOString())).toBeNull();
  });
  test('accepts 6 months ago', () => {
    const sixMonthsAgo = new Date(Date.now() - 180 * 86400_000).toISOString();
    expect(ensureVisitDate(sixMonthsAgo)).toBeNull();
  });
});

describe('ensureStringLength', () => {
  test('returns null on empty when not required', () => {
    expect(ensureStringLength('', { field: 'title' })).toBeNull();
    expect(ensureStringLength(null, { field: 'title' })).toBeNull();
  });
  test('returns required code on empty when required', () => {
    const err = ensureStringLength('', { field: 'title', required: true });
    expect(err.code).toBe('TITLE_REQUIRED');
  });
  test('returns required code when whitespace-only and required', () => {
    const err = ensureStringLength('   ', { field: 'title', required: true });
    expect(err.code).toBe('TITLE_REQUIRED');
  });
  test('rejects non-string', () => {
    const err = ensureStringLength(123, { field: 'title' });
    expect(err.code).toBe('TITLE_INVALID');
  });
  test('rejects under min length', () => {
    const err = ensureStringLength('ab', { min: 3, field: 'title' });
    expect(err.code).toBe('TITLE_TOO_SHORT');
  });
  test('accepts at min boundary', () => {
    expect(ensureStringLength('abc', { min: 3, field: 'title' })).toBeNull();
  });
  test('rejects over max length', () => {
    const err = ensureStringLength('abcdef', { max: 5, field: 'title' });
    expect(err.code).toBe('TITLE_TOO_LONG');
  });
  test('accepts at max boundary', () => {
    expect(ensureStringLength('abcde', { max: 5, field: 'title' })).toBeNull();
  });
  test('uses custom code', () => {
    const err = ensureStringLength('a', { min: 3, field: 'title', code: 'BAD_TITLE' });
    expect(err.code).toBe('BAD_TITLE');
  });
});

describe('ensureEmailList', () => {
  test('rejects non-array', () => {
    const err = ensureEmailList('a@b.co');
    expect(err.code).toBe('RECIPIENTS_INVALID');
  });
  test('rejects empty list', () => {
    const err = ensureEmailList([]);
    expect(err.code).toBe('RECIPIENTS_REQUIRED');
  });
  test('rejects too many entries', () => {
    const err = ensureEmailList(new Array(51).fill('a@b.co'));
    expect(err.code).toBe('RECIPIENTS_TOO_MANY');
  });
  test('rejects when list has invalid email', () => {
    const err = ensureEmailList(['ok@a.co', 'bad-email']);
    expect(err.code).toBe('INVALID_RECIPIENT');
    expect(err.error).toContain('bad-email');
  });
  test('accepts valid list', () => {
    expect(ensureEmailList(['ok@a.co', 'two@b.co'])).toBeNull();
  });
  test('honours custom min', () => {
    const err = ensureEmailList(['a@b.co'], { min: 2 });
    expect(err.code).toBe('RECIPIENTS_REQUIRED');
  });
  test('honours custom max', () => {
    const err = ensureEmailList(['a@b.co', 'c@d.co', 'e@f.co'], { max: 2 });
    expect(err.code).toBe('RECIPIENTS_TOO_MANY');
  });
});

describe('conflictFromPrisma', () => {
  test('returns null on null', () => {
    expect(conflictFromPrisma(null)).toBeNull();
  });
  test('returns null on non-P2002 error', () => {
    expect(conflictFromPrisma({ code: 'P2003' })).toBeNull();
  });
  test('extracts target from array meta', () => {
    const c = conflictFromPrisma({ code: 'P2002', meta: { target: ['email', 'tenantId'] } });
    expect(c).toEqual({
      status: 409,
      error: 'Duplicate value for email+tenantId',
      code: 'UNIQUE_CONSTRAINT',
      field: 'email+tenantId',
    });
  });
  test('extracts target from string meta', () => {
    const c = conflictFromPrisma({ code: 'P2002', meta: { target: 'email' } });
    expect(c.field).toBe('email');
  });
  test('falls back to "field" when no meta', () => {
    const c = conflictFromPrisma({ code: 'P2002' });
    expect(c.field).toBe('field');
  });
});

describe('httpFromPrismaError', () => {
  test('returns null on null', () => {
    expect(httpFromPrismaError(null)).toBeNull();
  });
  test('delegates to conflictFromPrisma for P2002', () => {
    const r = httpFromPrismaError({ code: 'P2002', meta: { target: 'email' } });
    expect(r.code).toBe('UNIQUE_CONSTRAINT');
    expect(r.status).toBe(409);
  });
  test('passes through helper-style errors', () => {
    const helperErr = { status: 400, error: 'bad', code: 'BAD' };
    expect(httpFromPrismaError(helperErr)).toBe(helperErr);
  });
  test('returns 404 NOT_FOUND for P2025', () => {
    const r = httpFromPrismaError({ code: 'P2025', meta: { cause: 'no such row' } });
    expect(r).toEqual({
      status: 404,
      error: 'no such row',
      code: 'NOT_FOUND',
    });
  });
  test('uses default message for P2025 without cause', () => {
    const r = httpFromPrismaError({ code: 'P2025' });
    expect(r.error).toBe('Record not found');
  });
  test('maps validation codes to 400 INVALID_INPUT', () => {
    for (const code of ['P2000', 'P2003', 'P2005', 'P2006', 'P2007', 'P2011', 'P2012', 'P2013', 'P2019', 'P2020']) {
      const r = httpFromPrismaError({ code, message: 'bad input' });
      expect(r.status).toBe(400);
      expect(r.code).toBe('INVALID_INPUT');
      expect(r.prismaCode).toBe(code);
    }
  });
  test('extracts last line of multi-line error message', () => {
    const r = httpFromPrismaError({ code: 'P2000', message: 'first line\nsecond line\nuseful detail' });
    expect(r.error).toBe('useful detail');
  });
  test('falls back to "Invalid input" when no message', () => {
    const r = httpFromPrismaError({ code: 'P2000' });
    expect(r.error).toBe('Invalid input');
  });
  test('handles PrismaClientValidationError by name', () => {
    const r = httpFromPrismaError({ name: 'PrismaClientValidationError' });
    expect(r).toEqual({
      status: 400,
      error: 'Invalid input shape for this resource',
      code: 'INVALID_INPUT',
    });
  });
  test('returns null for unknown errors (propagate as 500)', () => {
    expect(httpFromPrismaError({ code: 'P9999' })).toBeNull();
    expect(httpFromPrismaError(new Error('OOM'))).toBeNull();
  });
});
