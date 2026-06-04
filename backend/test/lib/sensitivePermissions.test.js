/**
 * Unit tests for backend/lib/sensitivePermissions.js — pure helper
 * module (no prisma, no I/O), so no mocking needed.
 *
 * Pins the SPEC §6a contract:
 *   - The sensitive set covers ROLES manage, STAFF mutate-tier, SETTINGS/
 *     DEVELOPER/INTEGRATIONS write-tier, BILLING/ACCOUNTING mutate-tier,
 *     and clinical PII destruction (PATIENTS/PRESCRIPTIONS/CONSENTS .delete).
 *   - getSensitiveGrants accepts either flat strings or {module,action}
 *     objects (both shapes the call sites use).
 *   - getNewlyGrantedSensitive returns only NET-NEW sensitive grants
 *     (the spec calls for confirming added-since-last-save, not the full
 *     current sensitive subset).
 */

import { describe, test, expect } from 'vitest';
import {
  SENSITIVE_PERMISSIONS,
  getSensitiveGrants,
  getNewlyGrantedSensitive,
  hasAnySensitive,
} from '../../lib/sensitivePermissions.js';

describe('sensitivePermissions catalog', () => {
  test('covers the SPEC §6a items', () => {
    // ROLES write
    expect(SENSITIVE_PERMISSIONS.has('roles.manage')).toBe(true);
    // STAFF write-tier
    expect(SENSITIVE_PERMISSIONS.has('staff.write')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('staff.update')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('staff.delete')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('staff.manage')).toBe(true);
    // SETTINGS / DEVELOPER / INTEGRATIONS write-tier
    expect(SENSITIVE_PERMISSIONS.has('settings.manage')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('developer.manage')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('integrations.write')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('integrations.manage')).toBe(true);
    // INVOICES / GIFT_CARDS / PATIENT_WALLETS / ACCOUNTING write-tier
    // (billing was split into three surface-specific modules in v3.8.x)
    expect(SENSITIVE_PERMISSIONS.has('invoices.write')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('invoices.manage')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('gift_cards.write')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('gift_cards.manage')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('patient_wallets.write')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('patient_wallets.manage')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('accounting.write')).toBe(true);
    // Clinical PII destruction
    expect(SENSITIVE_PERMISSIONS.has('patients.delete')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('prescriptions.delete')).toBe(true);
    expect(SENSITIVE_PERMISSIONS.has('consents.delete')).toBe(true);
  });

  test('does NOT flag routine clinical mutations as sensitive', () => {
    // Per SPEC §6a — only DELETE on patients/prescriptions/consents is
    // sensitive. Read / write / update are routine clinical work.
    expect(SENSITIVE_PERMISSIONS.has('patients.read')).toBe(false);
    expect(SENSITIVE_PERMISSIONS.has('patients.write')).toBe(false);
    expect(SENSITIVE_PERMISSIONS.has('patients.update')).toBe(false);
    expect(SENSITIVE_PERMISSIONS.has('prescriptions.write')).toBe(false);
    expect(SENSITIVE_PERMISSIONS.has('consents.write')).toBe(false);
    expect(SENSITIVE_PERMISSIONS.has('roles.read')).toBe(false);
    expect(SENSITIVE_PERMISSIONS.has('staff.read')).toBe(false);
  });
});

describe('getSensitiveGrants', () => {
  test('accepts flat string permissions', () => {
    const grants = getSensitiveGrants([
      'patients.read',
      'patients.delete',
      'roles.manage',
      'leads.write',
    ]);
    expect(grants.sort()).toEqual(['patients.delete', 'roles.manage'].sort());
  });

  test('accepts {module, action} object permissions', () => {
    const grants = getSensitiveGrants([
      { module: 'patients', action: 'read' },
      { module: 'staff', action: 'manage' },
      { module: 'invoices', action: 'write' },
    ]);
    expect(grants.sort()).toEqual(['invoices.write', 'staff.manage'].sort());
  });

  test('returns empty array for empty / invalid input', () => {
    expect(getSensitiveGrants([])).toEqual([]);
    expect(getSensitiveGrants(null)).toEqual([]);
    expect(getSensitiveGrants(undefined)).toEqual([]);
    expect(getSensitiveGrants([null, undefined, {}])).toEqual([]);
  });

  test('skips malformed entries without throwing', () => {
    const grants = getSensitiveGrants([
      { module: 'staff' }, // missing action
      { action: 'manage' }, // missing module
      { module: 'staff', action: 'manage' }, // valid
      'malformed_no_dot',
    ]);
    expect(grants).toEqual(['staff.manage']);
  });
});

describe('getNewlyGrantedSensitive', () => {
  test('returns only NET-NEW sensitive grants vs previous set', () => {
    const previous = [
      { module: 'roles', action: 'manage' },
      { module: 'leads', action: 'read' },
    ];
    const next = [
      { module: 'roles', action: 'manage' }, // already had — should NOT be flagged
      { module: 'leads', action: 'read' },
      { module: 'staff', action: 'write' }, // newly added sensitive — flagged
      { module: 'patients', action: 'delete' }, // newly added sensitive — flagged
      { module: 'contacts', action: 'read' }, // newly added non-sensitive — not flagged
    ];
    const result = getNewlyGrantedSensitive(previous, next);
    expect(result.sort()).toEqual(
      ['patients.delete', 'staff.write'].sort(),
    );
  });

  test('returns all sensitive grants if previous is empty', () => {
    const next = [
      { module: 'roles', action: 'manage' },
      { module: 'leads', action: 'read' },
    ];
    expect(getNewlyGrantedSensitive([], next)).toEqual(['roles.manage']);
  });

  test('returns empty array if no sensitive grants in next', () => {
    expect(
      getNewlyGrantedSensitive(
        [{ module: 'roles', action: 'manage' }],
        [{ module: 'contacts', action: 'read' }],
      ),
    ).toEqual([]);
  });

  test('mixes string and object shapes in either side', () => {
    const prev = ['roles.manage'];
    const next = [{ module: 'staff', action: 'write' }];
    expect(getNewlyGrantedSensitive(prev, next)).toEqual(['staff.write']);
  });
});

describe('hasAnySensitive', () => {
  test('returns true when any sensitive grant is present', () => {
    expect(hasAnySensitive([{ module: 'staff', action: 'manage' }])).toBe(true);
    expect(hasAnySensitive(['roles.manage', 'leads.read'])).toBe(true);
  });

  test('returns false when no sensitive grant is present', () => {
    expect(hasAnySensitive([])).toBe(false);
    expect(hasAnySensitive([{ module: 'leads', action: 'read' }])).toBe(false);
    expect(hasAnySensitive(['patients.read', 'visits.write'])).toBe(false);
  });
});
