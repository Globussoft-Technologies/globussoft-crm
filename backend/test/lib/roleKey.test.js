/**
 * Bug 6 — pins the shared role-key regex + validator so frontend
 * (frontend/src/utils/roleKey.js) cannot drift from backend
 * (backend/lib/roleKey.js). The drift is what shipped Bug 6 in the
 * QA cycle: helper text read "Uppercase + underscores only" while
 * the validator required "must start with a letter" — two surfaces
 * disagreed, admins were confused.
 *
 * If the regex changes, update BOTH files in the same commit and
 * extend these assertions to cover the new shape.
 */

import { describe, it, expect } from 'vitest';
import {
  ROLE_KEY_REGEX,
  ROLE_KEY_DESCRIPTION,
  ROLE_KEY_MAX_LENGTH,
  validateRoleKey,
} from '../../lib/roleKey';

describe('ROLE_KEY_REGEX', () => {
  it('matches plain uppercase keys', () => {
    expect(ROLE_KEY_REGEX.test('ADMIN')).toBe(true);
    expect(ROLE_KEY_REGEX.test('CUSTOMER')).toBe(true);
    expect(ROLE_KEY_REGEX.test('RECEPTIONIST')).toBe(true);
  });

  it('allows digits and underscores after the leading letter', () => {
    expect(ROLE_KEY_REGEX.test('TIER_1_SALES')).toBe(true);
    expect(ROLE_KEY_REGEX.test('A_B_C')).toBe(true);
    expect(ROLE_KEY_REGEX.test('AGENT2026')).toBe(true);
  });

  it('rejects lowercase, leading digit, dash, space, and empty', () => {
    expect(ROLE_KEY_REGEX.test('admin')).toBe(false);
    expect(ROLE_KEY_REGEX.test('Admin')).toBe(false);
    expect(ROLE_KEY_REGEX.test('1ADMIN')).toBe(false);
    expect(ROLE_KEY_REGEX.test('_ADMIN')).toBe(false);
    expect(ROLE_KEY_REGEX.test('ADMIN-USER')).toBe(false);
    expect(ROLE_KEY_REGEX.test('ADMIN USER')).toBe(false);
    expect(ROLE_KEY_REGEX.test('')).toBe(false);
  });

  it('helper text mentions the start-with-letter rule', () => {
    expect(ROLE_KEY_DESCRIPTION).toMatch(/start.*letter/i);
    expect(ROLE_KEY_DESCRIPTION).toMatch(/uppercase/i);
    expect(ROLE_KEY_DESCRIPTION).toMatch(/underscore/i);
    expect(ROLE_KEY_DESCRIPTION).toMatch(/digit/i);
  });
});

describe('validateRoleKey()', () => {
  it('returns null for valid keys', () => {
    expect(validateRoleKey('ADMIN')).toBeNull();
    expect(validateRoleKey('TIER_1')).toBeNull();
  });

  it('returns a message for empty / whitespace inputs', () => {
    expect(validateRoleKey('')).toMatch(/required/i);
    expect(validateRoleKey('   ')).toMatch(/required/i);
    expect(validateRoleKey(null)).toMatch(/required/i);
    expect(validateRoleKey(undefined)).toMatch(/required/i);
  });

  it('returns a message for shape violations', () => {
    expect(validateRoleKey('admin')).toMatch(/start with letter/i);
    expect(validateRoleKey('1ADMIN')).toMatch(/start with letter/i);
    expect(validateRoleKey('ADMIN USER')).toMatch(/start with letter/i);
  });

  it('returns a length-specific message when over the max', () => {
    const tooLong = 'A'.repeat(ROLE_KEY_MAX_LENGTH + 1);
    expect(validateRoleKey(tooLong)).toMatch(/too long/i);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(validateRoleKey('  ADMIN  ')).toBeNull();
  });
});
