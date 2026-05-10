// Unit tests for backend/lib/wellnessOwnership.js — Wave 9 Agent A, 2026-05-10.
//
// What this pins — the wellness ownership policy chosen for issue #527
// (CRIT-02). The four policies in the helper's header docstring are
// asserted as code, plus the "future per-location upgrade" check that
// remains a no-op until User schema gains a locationId field.
//
// Why this lives in test/middleware/ — the helper isn't strictly Express
// middleware, but it formalizes the AUTHORIZATION POLICY that the
// phiReadGate / phiWriteGate middleware in routes/wellness.js encode.
// Co-locating with middleware/wellnessRole.test.js keeps the security-
// surface tests together.
//
// Sync contract: this file's PHI_READ_ROLES + PHI_WRITE_ROLES expectations
// MUST match the phiReadGate / phiWriteGate allowed lists at
// routes/wellness.js (commit cd664f9). If the gate changes, this file
// goes red — by design.

import { describe, test, expect } from 'vitest';
import {
  PHI_READ_ROLES,
  PHI_WRITE_ROLES,
  CLINICAL_WELLNESS_ROLES,
  canReadPhi,
  canWritePhi,
  isClinicalStaff,
  canEditVisit,
  canEditPatient,
} from '../../lib/wellnessOwnership.js';

describe('canonical role lists (sync with routes/wellness.js gates)', () => {
  test('PHI_READ_ROLES exactly matches phiReadGate (cd664f9 contract)', () => {
    // From routes/wellness.js:145 phiReadGate definition.  Order must
    // match for stability of the JSON envelope (#274 contract pins the
    // `allowed` array shape).
    expect(PHI_READ_ROLES).toEqual([
      'doctor', 'professional', 'telecaller', 'admin', 'manager',
    ]);
  });

  test('PHI_WRITE_ROLES exactly matches phiWriteGate', () => {
    expect(PHI_WRITE_ROLES).toEqual([
      'doctor', 'professional', 'admin', 'manager',
    ]);
  });

  test('PHI_READ_ROLES is a strict superset of PHI_WRITE_ROLES', () => {
    // Read-without-write is the telecaller case (POLICY 1).  This is
    // structural: telecaller has phiReadGate access but NOT phiWriteGate.
    for (const r of PHI_WRITE_ROLES) {
      expect(PHI_READ_ROLES).toContain(r);
    }
    // The exclusive read role is exactly { telecaller }.
    const readOnly = PHI_READ_ROLES.filter((r) => !PHI_WRITE_ROLES.includes(r));
    expect(readOnly).toEqual(['telecaller']);
  });

  test('CLINICAL_WELLNESS_ROLES = doctor + professional (no telecaller, no helper)', () => {
    expect(CLINICAL_WELLNESS_ROLES).toEqual(['doctor', 'professional']);
  });

  test('helper is in NEITHER read nor write list (POLICY 3)', () => {
    expect(PHI_READ_ROLES).not.toContain('helper');
    expect(PHI_WRITE_ROLES).not.toContain('helper');
  });

  test('admin and manager are aliases (special tokens, not literal wellnessRole values)', () => {
    // verifyWellnessRole's "admin" / "manager" tokens map to req.user.role
    // === 'ADMIN' / 'MANAGER'.  They live in the allowed lists so the
    // gate factory can pattern-match them; the ownership helpers below
    // route ADMIN / MANAGER through the role short-circuit instead.
    expect(PHI_READ_ROLES).toContain('admin');
    expect(PHI_READ_ROLES).toContain('manager');
    expect(PHI_WRITE_ROLES).toContain('admin');
    expect(PHI_WRITE_ROLES).toContain('manager');
  });
});

describe('canReadPhi — POLICY 1 (telecaller read-extension)', () => {
  test('telecaller CAN read', () => {
    expect(canReadPhi({ role: 'USER', wellnessRole: 'telecaller' })).toBe(true);
  });

  test('doctor CAN read', () => {
    expect(canReadPhi({ role: 'USER', wellnessRole: 'doctor' })).toBe(true);
  });

  test('professional CAN read', () => {
    expect(canReadPhi({ role: 'USER', wellnessRole: 'professional' })).toBe(true);
  });

  test('helper CANNOT read (POLICY 3)', () => {
    expect(canReadPhi({ role: 'USER', wellnessRole: 'helper' })).toBe(false);
  });

  test('USER with no wellnessRole CANNOT read (this was CRIT-02 leak surface)', () => {
    expect(canReadPhi({ role: 'USER' })).toBe(false);
  });

  test('ADMIN bypasses wellnessRole (POLICY 4)', () => {
    expect(canReadPhi({ role: 'ADMIN' })).toBe(true);
  });

  test('MANAGER bypasses wellnessRole (POLICY 4)', () => {
    expect(canReadPhi({ role: 'MANAGER' })).toBe(true);
  });

  test('null/undefined user is denied (defensive)', () => {
    expect(canReadPhi(null)).toBe(false);
    expect(canReadPhi(undefined)).toBe(false);
  });
});

describe('canWritePhi — POLICY 1 (telecaller write-block) + POLICY 2 (cross-pro)', () => {
  test('telecaller CANNOT write (POLICY 1: read-only)', () => {
    // The CRITICAL part of the policy formalization: telecaller READS
    // PHI for context but is BLOCKED from authoring clinical records.
    expect(canWritePhi({ role: 'USER', wellnessRole: 'telecaller' })).toBe(false);
  });

  test('doctor CAN write (POLICY 2: cross-professional)', () => {
    expect(canWritePhi({ role: 'USER', wellnessRole: 'doctor' })).toBe(true);
  });

  test('professional CAN write', () => {
    expect(canWritePhi({ role: 'USER', wellnessRole: 'professional' })).toBe(true);
  });

  test('helper CANNOT write (POLICY 3)', () => {
    expect(canWritePhi({ role: 'USER', wellnessRole: 'helper' })).toBe(false);
  });

  test('ADMIN can write', () => {
    expect(canWritePhi({ role: 'ADMIN' })).toBe(true);
  });

  test('MANAGER can write', () => {
    expect(canWritePhi({ role: 'MANAGER' })).toBe(true);
  });
});

describe('isClinicalStaff — practitioner-authoring distinction', () => {
  test('doctor IS clinical staff', () => {
    expect(isClinicalStaff({ wellnessRole: 'doctor' })).toBe(true);
  });

  test('professional IS clinical staff', () => {
    expect(isClinicalStaff({ wellnessRole: 'professional' })).toBe(true);
  });

  test('telecaller is NOT clinical staff (read-only support role)', () => {
    expect(isClinicalStaff({ wellnessRole: 'telecaller' })).toBe(false);
  });

  test('helper is NOT clinical staff', () => {
    expect(isClinicalStaff({ wellnessRole: 'helper' })).toBe(false);
  });

  test('ADMIN is NOT clinical staff (org role, not clinical)', () => {
    // isClinicalStaff is the "authored the clinical row" check, not the
    // "can-edit" check. ADMINs can edit (canWritePhi) but didn't AUTHOR
    // any row — they're operational, not clinical.
    expect(isClinicalStaff({ role: 'ADMIN' })).toBe(false);
  });
});

describe('canEditVisit — POLICY 2 cross-professional + tenant gate', () => {
  const visit = { tenantId: 2, locationId: 7, doctorId: 99 };

  test('doctor on same tenant CAN edit visit they did NOT author (POLICY 2)', () => {
    const user = { role: 'USER', wellnessRole: 'doctor', tenantId: 2, userId: 100 };
    // user 100 is NOT visit.doctorId (99). Edit allowed by design.
    expect(canEditVisit(user, visit)).toBe(true);
  });

  test('professional CAN edit a visit authored by a doctor (POLICY 2)', () => {
    const user = { role: 'USER', wellnessRole: 'professional', tenantId: 2 };
    expect(canEditVisit(user, visit)).toBe(true);
  });

  test('cross-tenant edit DENIED even for ADMIN (tenant boundary is hard)', () => {
    const user = { role: 'ADMIN', tenantId: 1 };
    expect(canEditVisit(user, visit)).toBe(false);
  });

  test('telecaller DENIED on visit edit (POLICY 1: read-only)', () => {
    const user = { role: 'USER', wellnessRole: 'telecaller', tenantId: 2 };
    expect(canEditVisit(user, visit)).toBe(false);
  });

  test('helper DENIED on visit edit (POLICY 3)', () => {
    const user = { role: 'USER', wellnessRole: 'helper', tenantId: 2 };
    expect(canEditVisit(user, visit)).toBe(false);
  });

  test('ADMIN on same tenant CAN edit any visit', () => {
    const user = { role: 'ADMIN', tenantId: 2 };
    expect(canEditVisit(user, visit)).toBe(true);
  });

  test('null user / null visit denied (defensive)', () => {
    expect(canEditVisit(null, visit)).toBe(false);
    expect(canEditVisit({ role: 'ADMIN', tenantId: 2 }, null)).toBe(false);
  });

  test('different locationId does NOT block edit today (PER-LOCATION TODO)', () => {
    // Pinned because the original Wave 9 prompt suggested per-location
    // narrowing, but User schema has no locationId. When the schema
    // gains it, this test should flip to expect(false) for non-ADMIN
    // cross-location users — search "PER-LOCATION TODO" in
    // backend/lib/wellnessOwnership.js for the call site.
    const user = { role: 'USER', wellnessRole: 'doctor', tenantId: 2, locationId: 99 };
    const visitDifferentLoc = { tenantId: 2, locationId: 7 };
    expect(canEditVisit(user, visitDifferentLoc)).toBe(true);
  });
});

describe('canEditPatient — POLICY 2 cross-professional + tenant gate', () => {
  const patient = { tenantId: 2, locationId: 7 };

  test('doctor on same tenant CAN edit any patient (POLICY 2)', () => {
    const user = { role: 'USER', wellnessRole: 'doctor', tenantId: 2 };
    expect(canEditPatient(user, patient)).toBe(true);
  });

  test('cross-tenant edit DENIED', () => {
    const user = { role: 'USER', wellnessRole: 'doctor', tenantId: 99 };
    expect(canEditPatient(user, patient)).toBe(false);
  });

  test('telecaller DENIED on patient edit (POLICY 1: read-only)', () => {
    const user = { role: 'USER', wellnessRole: 'telecaller', tenantId: 2 };
    expect(canEditPatient(user, patient)).toBe(false);
  });

  test('helper DENIED on patient edit (POLICY 3)', () => {
    const user = { role: 'USER', wellnessRole: 'helper', tenantId: 2 };
    expect(canEditPatient(user, patient)).toBe(false);
  });

  test('MANAGER on same tenant CAN edit any patient', () => {
    const user = { role: 'MANAGER', tenantId: 2 };
    expect(canEditPatient(user, patient)).toBe(true);
  });
});
