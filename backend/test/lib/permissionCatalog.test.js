/**
 * Unit tests for backend/lib/permissionCatalog.js.
 *
 * The catalog is the source of truth for RBAC permission validation.
 * Two contracts pinned here:
 *   1. UNION catalog (PERMISSION_CATALOG / getCatalog / isValidPermission)
 *      stays the validation surface — accepts any cross-vertical perm so
 *      legacy RolePermission rows (e.g. travel tenant carrying a stale
 *      `patients.read` grant) don't reject at validate time.
 *   2. VERTICAL-FILTERED catalogs (getCatalogForVertical /
 *      getGroupedCatalogForVertical) drive /api/roles/catalog so the
 *      Roles & Permissions matrix on a travel tenant only shows
 *      COMMON + TRAVEL modules and a wellness tenant only shows
 *      COMMON + WELLNESS. Generic tenants only see COMMON.
 *
 * Added 2026-06-15 alongside the Phase 1 vertical-aware refactor.
 */

import { describe, it, expect } from 'vitest';
import {
  PERMISSION_CATALOG,
  PERMISSION_DOMAINS,
  COMMON_MODULES,
  WELLNESS_MODULES,
  TRAVEL_MODULES,
  PERMISSION_CATALOG_GENERIC,
  PERMISSION_CATALOG_WELLNESS,
  PERMISSION_CATALOG_TRAVEL,
  isValidPermission,
  getModules,
  getActions,
  getCatalog,
  getGroupedCatalog,
  getCatalogForVertical,
  getGroupedCatalogForVertical,
} from '../../lib/permissionCatalog.js';

describe('PERMISSION_CATALOG shape', () => {
  it('exposes COMMON, WELLNESS, and TRAVEL module maps', () => {
    expect(typeof COMMON_MODULES).toBe('object');
    expect(typeof WELLNESS_MODULES).toBe('object');
    expect(typeof TRAVEL_MODULES).toBe('object');
    expect(Object.keys(COMMON_MODULES).length).toBeGreaterThan(0);
    expect(Object.keys(WELLNESS_MODULES).length).toBeGreaterThan(0);
    expect(Object.keys(TRAVEL_MODULES).length).toBeGreaterThan(0);
  });

  it('union catalog is the merge of common + wellness + travel modules', () => {
    const unionKeys = new Set(Object.keys(PERMISSION_CATALOG));
    for (const k of Object.keys(COMMON_MODULES)) expect(unionKeys.has(k)).toBe(true);
    for (const k of Object.keys(WELLNESS_MODULES)) expect(unionKeys.has(k)).toBe(true);
    for (const k of Object.keys(TRAVEL_MODULES)) expect(unionKeys.has(k)).toBe(true);
  });

  it('every module entry maps to an array of action strings', () => {
    for (const [module, actions] of Object.entries(PERMISSION_CATALOG)) {
      expect(typeof module).toBe('string');
      expect(Array.isArray(actions)).toBe(true);
      for (const a of actions) expect(typeof a).toBe('string');
    }
  });

  it('PERMISSION_DOMAINS references only catalog modules', () => {
    for (const { modules } of PERMISSION_DOMAINS) {
      for (const m of modules) {
        expect(
          PERMISSION_CATALOG[m],
          `domain references unknown module ${m}`,
        ).toBeDefined();
      }
    }
  });
});

describe('isValidPermission (union surface)', () => {
  it('accepts cross-vertical permissions regardless of tenant', () => {
    // The validation surface is intentionally the union — a wellness perm
    // must remain valid even on a travel tenant so a stale RolePermission
    // row (e.g. legacy migration artifact) doesn't reject at validate
    // time. The UI hides such rows via the vertical-filtered endpoint.
    expect(isValidPermission('patients', 'read')).toBe(true);
    expect(isValidPermission('itineraries', 'read')).toBe(true);
    expect(isValidPermission('contacts', 'read')).toBe(true);
  });

  it('rejects unknown module or action', () => {
    expect(isValidPermission('unknown_module', 'read')).toBe(false);
    expect(isValidPermission('contacts', 'evil')).toBe(false);
    expect(isValidPermission('', '')).toBe(false);
  });
});

describe('getModules / getActions', () => {
  it('getModules returns every union catalog key', () => {
    const modules = getModules();
    expect(modules).toEqual(Object.keys(PERMISSION_CATALOG));
  });

  it('getActions returns the action array for a known module', () => {
    expect(getActions('contacts')).toContain('read');
    expect(getActions('contacts')).toContain('write');
  });

  it('getActions returns [] for unknown module', () => {
    expect(getActions('not-a-module')).toEqual([]);
  });
});

describe('getCatalog (back-compat union)', () => {
  it('returns a deep clone (mutations do not affect source)', () => {
    const c = getCatalog();
    c.contacts.push('hacked');
    expect(PERMISSION_CATALOG.contacts).not.toContain('hacked');
  });
});

describe('getGroupedCatalog (back-compat union grouping)', () => {
  it('returns one entry per domain with non-empty modules', () => {
    const grouped = getGroupedCatalog();
    expect(Array.isArray(grouped)).toBe(true);
    for (const g of grouped) {
      expect(typeof g.domain).toBe('string');
      expect(Array.isArray(g.modules)).toBe(true);
      expect(g.modules.length).toBeGreaterThan(0);
      for (const m of g.modules) {
        expect(typeof m.module).toBe('string');
        expect(Array.isArray(m.actions)).toBe(true);
      }
    }
  });

  it('includes modules from every vertical (union shape)', () => {
    const grouped = getGroupedCatalog();
    const allModules = new Set();
    for (const g of grouped) for (const m of g.modules) allModules.add(m.module);
    expect(allModules.has('contacts')).toBe(true); // common
    expect(allModules.has('patients')).toBe(true); // wellness
    expect(allModules.has('itineraries')).toBe(true); // travel
  });
});

describe('getCatalogForVertical (vertical-aware filtering)', () => {
  it('wellness vertical = COMMON_MODULES + WELLNESS_MODULES', () => {
    const cat = getCatalogForVertical('wellness');
    // Common is in
    expect(cat.contacts).toBeDefined();
    expect(cat.invoices).toBeDefined();
    // Wellness is in
    expect(cat.patients).toBeDefined();
    expect(cat.appointments).toBeDefined();
    expect(cat.prescriptions).toBeDefined();
    // Travel is OUT
    expect(cat.itineraries).toBeUndefined();
    expect(cat.suppliers).toBeUndefined();
    expect(cat.tmc_catalogue).toBeUndefined();
  });

  it('travel vertical = COMMON_MODULES + TRAVEL_MODULES', () => {
    const cat = getCatalogForVertical('travel');
    // Common is in
    expect(cat.contacts).toBeDefined();
    expect(cat.invoices).toBeDefined();
    // Travel is in
    expect(cat.itineraries).toBeDefined();
    expect(cat.suppliers).toBeDefined();
    expect(cat.tmc_catalogue).toBeDefined();
    expect(cat.passport).toBeDefined();
    expect(cat.visa).toBeDefined();
    // Wellness is OUT
    expect(cat.patients).toBeUndefined();
    expect(cat.appointments).toBeUndefined();
    expect(cat.prescriptions).toBeUndefined();
    expect(cat.gift_cards).toBeUndefined();
  });

  it('generic / unknown vertical = COMMON_MODULES only', () => {
    const generic = getCatalogForVertical('generic');
    const unknown = getCatalogForVertical('made-up');
    const nullV = getCatalogForVertical(null);
    for (const cat of [generic, unknown, nullV]) {
      expect(cat.contacts).toBeDefined();
      expect(cat.invoices).toBeDefined();
      expect(cat.patients).toBeUndefined();
      expect(cat.itineraries).toBeUndefined();
    }
    expect(Object.keys(generic).length).toBe(Object.keys(COMMON_MODULES).length);
  });

  it('matches the bundled PERMISSION_CATALOG_* constants', () => {
    expect(Object.keys(getCatalogForVertical('wellness')).sort()).toEqual(
      Object.keys(PERMISSION_CATALOG_WELLNESS).sort(),
    );
    expect(Object.keys(getCatalogForVertical('travel')).sort()).toEqual(
      Object.keys(PERMISSION_CATALOG_TRAVEL).sort(),
    );
    expect(Object.keys(getCatalogForVertical('generic')).sort()).toEqual(
      Object.keys(PERMISSION_CATALOG_GENERIC).sort(),
    );
  });

  it('returns a deep clone (mutations do not affect source)', () => {
    const cat = getCatalogForVertical('travel');
    cat.itineraries.push('hacked');
    expect(TRAVEL_MODULES.itineraries).not.toContain('hacked');
    expect(PERMISSION_CATALOG.itineraries).not.toContain('hacked');
  });
});

describe('getGroupedCatalogForVertical (vertical-aware grouping)', () => {
  it('wellness grouping omits Travel-* domains', () => {
    const grouped = getGroupedCatalogForVertical('wellness');
    const domains = grouped.map((g) => g.domain);
    expect(domains).toContain('Wellness Clinical');
    expect(domains).toContain('Wellness Inventory');
    expect(domains).toContain('Admin & Platform');
    for (const d of domains) {
      expect(d.startsWith('Travel '), `wellness leaked travel domain: ${d}`).toBe(false);
    }
  });

  it('travel grouping omits Wellness-* domains', () => {
    const grouped = getGroupedCatalogForVertical('travel');
    const domains = grouped.map((g) => g.domain);
    expect(domains).toContain('Travel Sales');
    expect(domains).toContain('Travel Itineraries & Trips');
    expect(domains).toContain('Travel Suppliers');
    expect(domains).toContain('Admin & Platform');
    for (const d of domains) {
      expect(d.startsWith('Wellness '), `travel leaked wellness domain: ${d}`).toBe(false);
    }
  });

  it('generic grouping has only common + Admin & Platform domains', () => {
    const grouped = getGroupedCatalogForVertical('generic');
    const domains = grouped.map((g) => g.domain);
    expect(domains).toContain('CRM Core');
    expect(domains).toContain('Admin & Platform');
    for (const d of domains) {
      expect(d.startsWith('Travel '), `generic leaked travel domain: ${d}`).toBe(false);
      expect(d.startsWith('Wellness '), `generic leaked wellness domain: ${d}`).toBe(false);
    }
  });

  it('every grouped module references a module in the per-vertical catalog', () => {
    for (const vertical of ['wellness', 'travel', 'generic']) {
      const grouped = getGroupedCatalogForVertical(vertical);
      const catalog = getCatalogForVertical(vertical);
      for (const g of grouped) {
        for (const m of g.modules) {
          expect(
            catalog[m.module],
            `${vertical} grouping references unknown module ${m.module}`,
          ).toBeDefined();
        }
      }
    }
  });
});
