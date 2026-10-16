import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  normalizePhoneValue,
  normalizeGenericCrmPhone,
  normalizeGenericWhatsAppThreadPhone,
} = requireCJS('../../lib/phoneFormatting');

describe('phoneFormatting — normalizePhoneValue', () => {
  test('preserves normal phone strings', () => {
    expect(normalizePhoneValue('+919876543210')).toBe('+919876543210');
    expect(normalizePhoneValue('  +91 98765 43210  ')).toBe('+91 98765 43210');
  });

  test('expands scientific notation strings into plain digits', () => {
    expect(normalizePhoneValue('9.1956E+11')).toBe('919560000000');
    expect(normalizePhoneValue('9.1956e+11')).toBe('919560000000');
  });

  test('stringifies numeric values', () => {
    expect(normalizePhoneValue(919560000000)).toBe('919560000000');
  });
});

describe('normalizeGenericCrmPhone', () => {
  test('converts formatted international numbers to E.164-style values', () => {
    expect(normalizeGenericCrmPhone('+91 7896541230')).toBe('+917896541230');
    expect(normalizeGenericCrmPhone('+91-7896541230')).toBe('+917896541230');
    expect(normalizeGenericCrmPhone('+91 (789) 654-1230')).toBe('+917896541230');
  });

  test('leaves already normalized numbers unchanged and uses a supplied country code', () => {
    expect(normalizeGenericCrmPhone('+917896541230')).toBe('+917896541230');
    expect(normalizeGenericCrmPhone('7896541230', '+91')).toBe('+917896541230');
    expect(normalizeGenericCrmPhone('+44 7911123456')).toBe('+447911123456');
  });
});

describe('normalizeGenericWhatsAppThreadPhone', () => {
  test('gives manual and automatic forms of one number the same thread key', () => {
    expect(normalizeGenericWhatsAppThreadPhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizeGenericWhatsAppThreadPhone('919876543210')).toBe('+919876543210');
    expect(normalizeGenericWhatsAppThreadPhone('9876543210')).toBe('+919876543210');
  });

  test('keeps non-Indian international numbers canonical without guessing', () => {
    expect(normalizeGenericWhatsAppThreadPhone('+1 555 166 2807')).toBe('+15551662807');
    expect(normalizeGenericWhatsAppThreadPhone('15551662807')).toBe('+15551662807');
  });
});
