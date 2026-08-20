import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { normalizePhoneValue } = requireCJS('../../lib/phoneFormatting');

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
