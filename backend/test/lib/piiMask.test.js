// Unit tests for backend/lib/piiMask.js
//
// Closes #679 (Locations) + #680 (Patient exports) + #681 (Inbox WhatsApp
// lead phones) + #682 (Staff records).
//
// piiMask exposes:
//   - 5 field-level mask primitives (maskPhone/maskEmail/maskName/maskDOB/maskUserId)
//   - viewer policy (shouldMaskForViewer)
//   - row-shaped helpers (maskRow / maskRows)
//   - audit envelope contract (auditDisclosureDetails)
//
// All primitives are PURE — no I/O, no prisma. Every branch is reachable
// from a unit test; the route-layer specs (e2e/tests/pii-masking-api.spec.js)
// exercise the integration (role-based branch + audit emission).
import { describe, test, expect } from 'vitest';

const {
  maskPhone,
  maskEmail,
  maskName,
  maskDOB,
  maskUserId,
  shouldMaskForViewer,
  maskRow,
  maskRows,
  auditDisclosureDetails,
} = await import('../../lib/piiMask.js');

describe('piiMask — maskPhone', () => {
  test('Indian E.164 phone is masked to 3-leading + 4-trailing', () => {
    expect(maskPhone('+919876543210')).toBe('+919****3210');
  });

  test('US E.164 phone is masked', () => {
    expect(maskPhone('+14155552671')).toBe('+141****2671');
  });

  test('phone with spaces and dashes is normalised before masking', () => {
    expect(maskPhone('+91 98765-43210')).toBe('+919****3210');
  });

  test('phone with parens is normalised', () => {
    expect(maskPhone('+1 (415) 555-2671')).toBe('+141****2671');
  });

  test('plain 10-digit phone (no plus) is masked', () => {
    expect(maskPhone('9876543210')).toBe('987****3210');
  });

  test('null / undefined / empty string pass through unchanged', () => {
    expect(maskPhone(null)).toBe(null);
    expect(maskPhone(undefined)).toBe(undefined);
    expect(maskPhone('')).toBe('');
  });

  test('non-string input passes through unchanged', () => {
    expect(maskPhone(12345)).toBe(12345);
    expect(maskPhone({})).toEqual({});
  });

  test('too-short string (<7 chars after normalisation) is left alone', () => {
    expect(maskPhone('123')).toBe('123');
    expect(maskPhone('12345')).toBe('12345');
  });
});

describe('piiMask — maskEmail', () => {
  test('typical email keeps first char + domain', () => {
    expect(maskEmail('rishu@enhancedwellness.in')).toBe('r****@enhancedwellness.in');
  });

  test('single-char local-part is kept', () => {
    expect(maskEmail('a@b.com')).toBe('a****@b.com');
  });

  test('null / empty pass through', () => {
    expect(maskEmail(null)).toBe(null);
    expect(maskEmail('')).toBe('');
  });

  test('email without @ passes through unchanged (caller responsible for valid input)', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });

  test('email with leading @ or trailing @ passes through (malformed)', () => {
    expect(maskEmail('@example.com')).toBe('@example.com');
    expect(maskEmail('user@')).toBe('user@');
  });

  test('non-string input is returned as-is', () => {
    expect(maskEmail(42)).toBe(42);
  });
});

describe('piiMask — maskName', () => {
  test('two-token name → initial + last name', () => {
    expect(maskName('Rishu Sharma')).toBe('R. Sharma');
  });

  test('three-token name keeps everything after the first token', () => {
    expect(maskName('Harsh Kumar Patel')).toBe('H. Kumar Patel');
  });

  test('single-token name becomes initial only', () => {
    expect(maskName('Rishu')).toBe('R.');
  });

  test('leading/trailing whitespace is trimmed', () => {
    expect(maskName('  Rishu Sharma  ')).toBe('R. Sharma');
  });

  test('null / empty pass through', () => {
    expect(maskName(null)).toBe(null);
    expect(maskName('')).toBe('');
    expect(maskName('   ')).toBe('   '); // pure-whitespace input untouched
  });
});

describe('piiMask — maskDOB', () => {
  test('ISO date string drops year, keeps MM-DD', () => {
    expect(maskDOB('1995-04-12')).toBe('****-04-12');
  });

  test('ISO datetime drops year', () => {
    expect(maskDOB('1995-04-12T00:00:00Z')).toBe('****-04-12');
  });

  test('Date object is supported', () => {
    expect(maskDOB(new Date('1980-12-25T00:00:00Z'))).toBe('****-12-25');
  });

  test('invalid date string passes through', () => {
    expect(maskDOB('not-a-date')).toBe('not-a-date');
  });

  test('null / undefined pass through', () => {
    expect(maskDOB(null)).toBe(null);
    expect(maskDOB(undefined)).toBe(undefined);
  });
});

describe('piiMask — maskUserId', () => {
  test('numeric user id is hashed to last 3 digits with # prefix', () => {
    expect(maskUserId(12345)).toBe('#345');
  });

  test('string user id is supported', () => {
    expect(maskUserId('98765')).toBe('#765');
  });

  test('user id with 3-or-fewer chars keeps the full id (still masked-prefix)', () => {
    expect(maskUserId(7)).toBe('#7');
    expect(maskUserId(99)).toBe('#99');
    expect(maskUserId(123)).toBe('#123');
  });

  test('null / undefined pass through', () => {
    expect(maskUserId(null)).toBe(null);
    expect(maskUserId(undefined)).toBe(undefined);
  });
});

describe('piiMask — shouldMaskForViewer policy', () => {
  test('ADMIN never has PHI masked', () => {
    expect(shouldMaskForViewer({ user: { role: 'ADMIN' } })).toBe(false);
  });

  test('MANAGER never has PHI masked', () => {
    expect(shouldMaskForViewer({ user: { role: 'MANAGER' } })).toBe(false);
  });

  test('doctor (wellnessRole) sees full PHI', () => {
    expect(shouldMaskForViewer({ user: { role: 'USER', wellnessRole: 'doctor' } })).toBe(false);
  });

  test('professional (wellnessRole) sees full PHI', () => {
    expect(shouldMaskForViewer({ user: { role: 'USER', wellnessRole: 'professional' } })).toBe(false);
  });

  test('telecaller sees MASKED PHI', () => {
    expect(shouldMaskForViewer({ user: { role: 'USER', wellnessRole: 'telecaller' } })).toBe(true);
  });

  test('helper sees MASKED PHI', () => {
    expect(shouldMaskForViewer({ user: { role: 'USER', wellnessRole: 'helper' } })).toBe(true);
  });

  test('USER with no wellnessRole sees MASKED PHI (fail-closed for generic CRM USER role)', () => {
    expect(shouldMaskForViewer({ user: { role: 'USER' } })).toBe(true);
  });

  test('missing req.user fails CLOSED (mask)', () => {
    expect(shouldMaskForViewer({})).toBe(true);
    expect(shouldMaskForViewer(null)).toBe(true);
    expect(shouldMaskForViewer(undefined)).toBe(true);
  });
});

describe('piiMask — maskRow / maskRows', () => {
  const sample = {
    id: 42,
    name: 'Rishu Sharma',
    phone: '+919876543210',
    email: 'rishu@enhancedwellness.in',
    dob: '1995-04-12',
    notes: 'unrelated field',
  };

  test('maskRow masks listed fields, leaves others verbatim', () => {
    const out = maskRow(sample, ['name', 'phone', 'email', 'dob']);
    expect(out).toEqual({
      id: 42,
      name: 'R. Sharma',
      phone: '+919****3210',
      email: 'r****@enhancedwellness.in',
      dob: '****-04-12',
      notes: 'unrelated field',
    });
  });

  test('maskRow does NOT mutate the original row', () => {
    const before = { ...sample };
    maskRow(sample, ['name', 'phone']);
    expect(sample).toEqual(before);
  });

  test('maskRow with unknown field redacts to "****"', () => {
    const out = maskRow({ id: 1, secret: 'hunter2', name: 'X' }, ['secret']);
    expect(out.secret).toBe('****');
    expect(out.name).toBe('X');
  });

  test('maskRow ignores fields not present on row', () => {
    const out = maskRow({ id: 1 }, ['phone', 'email']);
    expect(out).toEqual({ id: 1 });
  });

  test('maskRows handles arrays', () => {
    const out = maskRows([sample, { ...sample, id: 43 }], ['phone']);
    expect(out).toHaveLength(2);
    expect(out[0].phone).toBe('+919****3210');
    expect(out[1].phone).toBe('+919****3210');
    expect(out[1].id).toBe(43);
  });

  test('maskRows on non-array returns input unchanged', () => {
    expect(maskRows(null, ['phone'])).toBe(null);
    expect(maskRows({ phone: '12345' }, ['phone'])).toEqual({ phone: '12345' });
  });

  test('maskRow on null returns null', () => {
    expect(maskRow(null, ['phone'])).toBe(null);
  });
});

describe('piiMask — auditDisclosureDetails', () => {
  test('canonical envelope shape', () => {
    const req = { user: { role: 'ADMIN', wellnessRole: null, userId: 7 } };
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = auditDisclosureDetails(req, 'patient_list', rows, {
      fields: ['name', 'phone', 'email'],
    });
    expect(out).toEqual({
      scope: 'patient_list',
      viewerRole: 'ADMIN',
      viewerWellnessRole: null,
      recordCount: 3,
      recordIds: [1, 2, 3],
      disclosedFields: ['name', 'phone', 'email'],
    });
  });

  test('recordIds are capped at 200 (audit row size limit)', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i + 1 }));
    const out = auditDisclosureDetails(
      { user: { role: 'MANAGER' } },
      'staff_list',
      rows,
    );
    expect(out.recordIds.length).toBe(200);
    expect(out.recordCount).toBe(500); // full count preserved
  });

  test('handles missing req gracefully', () => {
    const out = auditDisclosureDetails(null, 'inbox', [{ id: 1 }]);
    expect(out.viewerRole).toBe(null);
    expect(out.recordIds).toEqual([1]);
  });

  test('rows without id are skipped from recordIds', () => {
    const rows = [{ id: 1 }, { foo: 'bar' }, { id: 3 }];
    const out = auditDisclosureDetails(
      { user: { role: 'USER', wellnessRole: 'telecaller' } },
      'mixed',
      rows,
    );
    expect(out.recordIds).toEqual([1, 3]);
    expect(out.recordCount).toBe(3);
  });

  test('viewerWellnessRole defaults to null when absent', () => {
    const out = auditDisclosureDetails(
      { user: { role: 'USER' } },
      'x',
      [],
    );
    expect(out.viewerWellnessRole).toBe(null);
  });
});
