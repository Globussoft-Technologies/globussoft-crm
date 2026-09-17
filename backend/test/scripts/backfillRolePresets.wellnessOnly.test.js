// @ts-check
/**
 * The role-preset backfill must not leak wellness-only grants onto other
 * verticals.
 *
 * Unlike ensureRbacOnBoot.js — which filters MANAGER through
 * filterPermsToVertical and gates USER + the clinical roles behind
 * `if (isWellness)` — this script applies ROLE_GRANTS with NO vertical
 * filtering. Its legacy cross-vertical entries (patients.read,
 * appointments.read, ...) are deliberately left alone, because narrowing them
 * now would revoke rows live tenants already depend on.
 *
 * So every permission added to the presets after the vertical split needs an
 * explicit guard, and this test is what stops the next one being added
 * without it. `call_history` is registered for wellness only in
 * permissionCatalog.js — granting it on a generic or travel tenant would
 * write a row that is not a valid permission for that tenant at all.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const catalog = requireCJS('../../lib/permissionCatalog');

const SCRIPT = fileURLToPath(new URL('../../scripts/backfill-role-preset-perms.js', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');

/** Pull a `const NAME_PERMISSIONS = [...]` literal out of the script. */
function preset(name) {
  const m = src.match(new RegExp(`^const ${name} = \\[([\\s\\S]*?)\\n\\];`, 'm'));
  if (!m) throw new Error(`preset ${name} not found`);
  return [...m[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((x) => x[1]);
}

const ROLE_PRESETS = [
  'MANAGER_PERMISSIONS',
  'USER_PERMISSIONS',
  'CUSTOMER_PERMISSIONS',
  'DOCTOR_PERMISSIONS',
  'NURSE_PERMISSIONS',
  'RECEPTIONIST_PERMISSIONS',
  'TELECALLER_PERMISSIONS',
];

describe('backfill wellness-only guard', () => {
  test('the guard exists and is keyed off the tenant vertical', () => {
    // Without this the script grants every preset entry to every tenant.
    expect(src).toContain('WELLNESS_ONLY_GRANTS');
    expect(src).toMatch(/tenant\.vertical === 'wellness'/);
  });

  test('wellness call permissions are inside the guard', () => {
    const m = src.match(/const WELLNESS_ONLY_GRANTS = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    const guarded = [...m[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((x) => x[1]);
    expect(guarded).toContain('appointments.ai_call');
    expect(guarded).toContain('appointments.manual_call');
    expect(guarded).toContain('call_history.read');
    expect(guarded).toContain('call_history.read_all');
  });

  test('every wellness call grant in every preset is guarded', () => {
    // The guard is a denylist, so a grant added to a preset but forgotten
    // here would ship straight onto generic and travel tenants.
    const m = src.match(/const WELLNESS_ONLY_GRANTS = new Set\(\[([\s\S]*?)\]\)/);
    const guarded = new Set([...m[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((x) => x[1]));

    for (const name of ROLE_PRESETS) {
      for (const perm of preset(name)) {
        if (perm.startsWith('call_history.') || ['appointments.ai_call', 'appointments.manual_call'].includes(perm)) {
          expect(guarded.has(perm), `${name} grants unguarded ${perm}`).toBe(true);
        }
      }
    }
  });

  test('the guarded set really is wellness-only in the catalog', () => {
    // If one of these became valid on another vertical, guarding it would be
    // wrong rather than merely cautious — so keep the two definitions honest
    // about each other.
    const m = src.match(/const WELLNESS_ONLY_GRANTS = new Set\(\[([\s\S]*?)\]\)/);
    const guarded = [...m[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((x) => x[1]);

    for (const perm of guarded) {
      const [mod, action] = perm.split('.');
      expect(catalog.isValidPermissionForVertical(mod, action, 'wellness')).toBe(true);
      for (const vertical of ['generic', 'travel', 'retail', '', null, undefined]) {
        expect(
          catalog.isValidPermissionForVertical(mod, action, vertical),
          `${perm} must not be valid on ${JSON.stringify(vertical)}`,
        ).toBe(false);
      }
    }
  });
});

describe('backfill generic-only guard', () => {
  test('generic grants are explicitly guarded by tenant vertical', () => {
    expect(src).toContain('GENERIC_ONLY_GRANTS');
    expect(src).toMatch(/GENERIC_ONLY_GRANTS\.has\(perm\)\) return tenant\.vertical === 'generic'/);
  });

  test('every generic preset grant is valid for generic tenants', () => {
    const m = src.match(/const GENERIC_ONLY_GRANTS = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    const guarded = [...m[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((x) => x[1]);
    expect(guarded).toContain('cpq.read');
    expect(guarded).toContain('web_forms.update');
    expect(guarded).toContain('forecasting.read');
    expect(guarded).toContain('quotas.read');
    expect(guarded).toContain('sequences.read');
    expect(guarded).toContain('settings.read');

    for (const perm of guarded) {
      const [mod, action] = perm.split('.');
      expect(catalog.isValidPermissionForVertical(mod, action, 'generic')).toBe(true);
    }
  });
});

describe('ensureRbacOnBoot needs no such guard', () => {
  const boot = readFileSync(
    fileURLToPath(new URL('../../scripts/ensureRbacOnBoot.js', import.meta.url)),
    'utf8',
  );

  test('MANAGER is filtered to the vertical catalog', () => {
    expect(boot).toContain("vertical === 'generic'");
    expect(boot).toContain('GENERIC_MANAGER_PERMISSIONS');
    expect(boot).toMatch(/filterPermsToVertical\(managerPreset, vertical\)/);
  });

  test('USER and the clinical roles are granted only on wellness tenants', () => {
    // USER carries call_history.read; without this gate it would reach a
    // generic tenant's USER role on first boot.
    expect(boot).toMatch(/if \(userCreated && isWellness\)/);
    expect(boot).toContain('if (isWellness) {');
  });
});
