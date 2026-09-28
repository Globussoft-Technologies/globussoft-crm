import { describe, expect, test } from 'vitest';
import identityFields from '../../lib/diagnosticIdentityFields.js';

const { normalizeIdentityFields, validateIdentityFieldConfiguration, validateIdentitySubmission } = identityFields;

describe('diagnosticIdentityFields', () => {
  test('preserves arbitrary valid fields and their validation metadata', () => {
    expect(normalizeIdentityFields([{
      id: 'school_name', label: 'School name', type: 'text', required: true,
      minLength: 3, maxLength: 120, pattern: '^[A-Za-z ]+$', helper: 'Official name',
    }])).toEqual([expect.objectContaining({
      id: 'school_name', label: 'School name', required: true,
      minLength: 3, maxLength: 120, pattern: '^[A-Za-z ]+$', helper: 'Official name',
    })]);
  });

  test('validates required, type, length, numeric range, and custom patterns', () => {
    const fields = normalizeIdentityFields([
      { id: 'email', label: 'Work email', type: 'email', required: true },
      { id: 'students', label: 'Students', type: 'number', min: 10, max: 100 },
      { id: 'code', label: 'School code', type: 'text', pattern: '^SCH-[0-9]+$' },
    ]);
    expect(validateIdentitySubmission({ fields, identity: {} }).error.reason).toBe('required');
    expect(validateIdentitySubmission({ fields, identity: { email: 'bad', students: 20, code: 'SCH-1' } }).error.fieldId).toBe('email');
    expect(validateIdentitySubmission({ fields, identity: { email: 'a@b.com', students: 5, code: 'SCH-1' } }).error.reason).toBe('min');
    expect(validateIdentitySubmission({ fields, identity: { email: 'a@b.com', students: 20, code: 'bad' } }).error.reason).toBe('pattern');
    expect(validateIdentitySubmission({ fields, identity: { email: 'a@b.com', students: 20, code: 'SCH-1' } }).error).toBeNull();
  });

  test('supports legacy top-level name, email, and phone values', () => {
    const fields = normalizeIdentityFields(undefined, {});
    const result = validateIdentitySubmission({
      fields,
      identity: {},
      legacyValues: { name: 'Asha', email: 'asha@example.com', phone: '+91 99999 99999' },
    });
    expect(result.error).toBeNull();
    expect(result.values).toMatchObject({ name: 'Asha', email: 'asha@example.com' });
  });

  test('rejects duplicate keys and malformed validation rules in templates', () => {
    expect(validateIdentityFieldConfiguration([{ id: 'school', label: 'School' }, { id: 'school', label: 'Other' }])).toMatch(/duplicate/i);
    expect(validateIdentityFieldConfiguration([{ id: 'school', label: 'School', pattern: '[' }])).toMatch(/regular expression/i);
    expect(validateIdentityFieldConfiguration([{ id: 'school', label: 'School', minLength: 20, maxLength: 10 }])).toMatch(/cannot exceed/i);
  });
});
