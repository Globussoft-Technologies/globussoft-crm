// @ts-check
/**
 * `call_history` permission registration.
 *
 * Call History is a WELLNESS-only surface, and a call recording is a real
 * patient discussing real treatment. So visibility is split the same way
 * appointments / my_appointments is:
 *
 *   read      — open the page; you see YOUR OWN calls
 *   read_all  — see every staff member's calls
 *
 * Registration matters as much as the route check: a permission missing from
 * the catalog cannot be granted in the Roles UI, so the split would silently
 * collapse to "admins only" with no way to delegate.
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const catalog = requireCJS('../../lib/permissionCatalog');

describe('call_history permission', () => {
  test('exposes exactly the two visibility levels', () => {
    expect(catalog.PERMISSION_CATALOG.call_history).toEqual(['read', 'read_all']);
  });

  test('is grantable on a wellness tenant', () => {
    expect(catalog.isValidPermissionForVertical('call_history', 'read', 'wellness')).toBe(true);
    expect(catalog.isValidPermissionForVertical('call_history', 'read_all', 'wellness')).toBe(true);
  });

  test('wellness is the ONLY vertical that grants it', () => {
    // Not just "not generic" — anything that is not exactly wellness must be
    // refused, including verticals that do not exist yet and a missing value.
    // Callified calling was built for the wellness Appointments surface; the
    // generic CRM has its own Leads-page flow and no Call History page.
    const notWellness = [
      'generic',
      'travel',
      'retail', // a vertical that does not exist — must not default to allowed
      'WELLNESS', // casing is strict; Tenant.vertical is stored lowercase
      'Wellness',
      '',
      null,
      undefined,
    ];
    for (const vertical of notWellness) {
      for (const action of ['read', 'read_all']) {
        expect(
          catalog.isValidPermissionForVertical('call_history', action, vertical),
          `call_history.${action} must be refused for vertical ${JSON.stringify(vertical)}`,
        ).toBe(false);
      }
    }
    expect(catalog.isValidPermissionForVertical('call_history', 'read', 'wellness')).toBe(true);
  });

  test('rejects an action that does not exist', () => {
    expect(catalog.isValidPermissionForVertical('call_history', 'write', 'wellness')).toBe(false);
    expect(catalog.isValidPermissionForVertical('call_history', 'delete', 'wellness')).toBe(false);
  });
});
