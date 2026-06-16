/**
 * Unit tests for backend/lib/widgetCatalog.js — the source-of-truth list
 * of widgets available on the /home dashboard. The bulk-PUT
 * /api/roles/:id/widgets validator calls isValidWidgetKey() on every
 * incoming widgetKey, so a bug here lets unknown keys land in the DB.
 *
 * Asserts on the SHAPE of the catalogue rather than specific entries so
 * adding/removing widgets in the future doesn't break the test pinning.
 * One specific entry assertion remains: 'today-appointments' must exist
 * because the seed-default-widget logic in ensureRbacOnBoot.js depends
 * on it being present for the DOCTOR / NURSE / RECEPTIONIST defaults.
 */

import { describe, it, expect } from 'vitest';
import {
  WIDGET_CATALOG,
  COMMON_WIDGETS,
  WELLNESS_WIDGETS,
  TRAVEL_WIDGETS,
  getCatalog,
  getCatalogForVertical,
  isValidWidgetKey,
  getWidget,
  getDefaultWidgetsForRoleKey,
} from '../../lib/widgetCatalog.js';

describe('WIDGET_CATALOG shape', () => {
  it('has at least 10 widgets registered', () => {
    expect(WIDGET_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it('every entry has key, title, category, requiredPermissions, defaultRoleKeys', () => {
    for (const w of WIDGET_CATALOG) {
      expect(typeof w.key).toBe('string');
      expect(w.key.length).toBeGreaterThan(0);
      expect(typeof w.title).toBe('string');
      expect(typeof w.category).toBe('string');
      expect(Array.isArray(w.requiredPermissions)).toBe(true);
      expect(Array.isArray(w.defaultRoleKeys)).toBe(true);
    }
  });

  it('keys are unique', () => {
    const keys = WIDGET_CATALOG.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('requiredPermissions entries have module + action strings', () => {
    for (const w of WIDGET_CATALOG) {
      for (const p of w.requiredPermissions) {
        expect(typeof p.module).toBe('string');
        expect(typeof p.action).toBe('string');
      }
    }
  });

  it("includes 'today-appointments' (a default seed widget for clinical roles)", () => {
    const todayAppts = WIDGET_CATALOG.find((w) => w.key === 'today-appointments');
    expect(todayAppts).toBeDefined();
    expect(todayAppts.defaultRoleKeys).toContain('DOCTOR');
  });
});

describe('getCatalog', () => {
  it('returns a deep-clone copy (caller mutations do not affect the source)', () => {
    const copy = getCatalog();
    copy[0].title = 'TAMPERED';
    copy[0].requiredPermissions.push({ module: 'evil', action: 'all' });
    copy[0].defaultRoleKeys.push('EVIL');
    expect(WIDGET_CATALOG[0].title).not.toBe('TAMPERED');
    expect(
      WIDGET_CATALOG[0].requiredPermissions.some((p) => p.module === 'evil'),
    ).toBe(false);
    expect(WIDGET_CATALOG[0].defaultRoleKeys).not.toContain('EVIL');
  });
});

describe('isValidWidgetKey', () => {
  it('accepts every key in the catalogue', () => {
    for (const w of WIDGET_CATALOG) {
      expect(isValidWidgetKey(w.key)).toBe(true);
    }
  });

  it('rejects unknown keys + non-strings', () => {
    expect(isValidWidgetKey('not-a-real-widget')).toBe(false);
    expect(isValidWidgetKey('')).toBe(false);
    expect(isValidWidgetKey(null)).toBe(false);
    expect(isValidWidgetKey(undefined)).toBe(false);
    expect(isValidWidgetKey(123)).toBe(false);
    expect(isValidWidgetKey({})).toBe(false);
  });
});

describe('getWidget', () => {
  it('returns the metadata for a known key', () => {
    const w = getWidget('today-appointments');
    expect(w).not.toBeNull();
    expect(w.title).toMatch(/appointments/i);
  });

  it('returns null for an unknown key', () => {
    expect(getWidget('not-a-thing')).toBeNull();
    expect(getWidget(null)).toBeNull();
  });
});

describe('getCatalogForVertical (vertical-aware filtering)', () => {
  // Pins the contract that /api/widgets/catalog returns only the
  // requesting tenant's vertical-relevant widgets. Wellness clinical
  // widgets stay hidden on a travel tenant, travel operational widgets
  // stay hidden on a wellness tenant, and generic tenants only see the
  // cross-vertical core (`quick-links`).

  it('wellness vertical returns wellness widgets + common (no travel keys)', () => {
    const list = getCatalogForVertical('wellness');
    const keys = list.map((w) => w.key);
    // Sanity: list contains both the wellness clinical widgets + the
    // shared launcher widget.
    expect(keys).toContain('today-appointments');
    expect(keys).toContain('pending-prescriptions');
    expect(keys).toContain('quick-links');
    // Travel widgets are hidden.
    for (const w of TRAVEL_WIDGETS) {
      expect(keys, `wellness should not include ${w.key}`).not.toContain(w.key);
    }
    // Length matches WELLNESS_WIDGETS + COMMON_WIDGETS.
    expect(list.length).toBe(WELLNESS_WIDGETS.length + COMMON_WIDGETS.length);
  });

  it('travel vertical returns travel widgets + common (no wellness keys)', () => {
    const list = getCatalogForVertical('travel');
    const keys = list.map((w) => w.key);
    expect(keys).toContain('travel-todays-departures');
    expect(keys).toContain('travel-pending-quotes');
    expect(keys).toContain('quick-links');
    // Wellness widgets are hidden.
    for (const w of WELLNESS_WIDGETS) {
      expect(keys, `travel should not include ${w.key}`).not.toContain(w.key);
    }
    expect(list.length).toBe(TRAVEL_WIDGETS.length + COMMON_WIDGETS.length);
  });

  it('generic vertical returns only the common widgets', () => {
    const list = getCatalogForVertical('generic');
    const keys = list.map((w) => w.key);
    expect(keys).toContain('quick-links');
    // Neither wellness nor travel widgets surface for generic tenants.
    for (const w of WELLNESS_WIDGETS) {
      expect(keys).not.toContain(w.key);
    }
    for (const w of TRAVEL_WIDGETS) {
      expect(keys).not.toContain(w.key);
    }
    expect(list.length).toBe(COMMON_WIDGETS.length);
  });

  it('unknown / null vertical falls back to common widgets only', () => {
    const unknown = getCatalogForVertical('made-up-vertical').map((w) => w.key);
    const nullV = getCatalogForVertical(null).map((w) => w.key);
    expect(unknown).toEqual(COMMON_WIDGETS.map((w) => w.key));
    expect(nullV).toEqual(COMMON_WIDGETS.map((w) => w.key));
  });

  it('returns a deep clone (mutations do not affect the union catalog)', () => {
    const list = getCatalogForVertical('travel');
    expect(list.length).toBeGreaterThan(0);
    list[0].title = 'TAMPERED';
    list[0].requiredPermissions.push({ module: 'evil', action: 'all' });
    list[0].defaultRoleKeys.push('EVIL');
    const source = WIDGET_CATALOG.find((w) => w.key === list[0].key);
    expect(source.title).not.toBe('TAMPERED');
    expect(source.requiredPermissions.some((p) => p.module === 'evil')).toBe(false);
    expect(source.defaultRoleKeys).not.toContain('EVIL');
  });

  it('union catalog contains every wellness + travel + common key (back-compat)', () => {
    // The union (WIDGET_CATALOG) is the validation surface used by
    // isValidWidgetKey on the role-widget-layout PUT endpoint. It must
    // accept any key from any vertical so a stale RoleWidget row
    // (e.g. cross-vertical perm grant artefact) doesn't trip validation.
    const unionKeys = new Set(WIDGET_CATALOG.map((w) => w.key));
    for (const w of WELLNESS_WIDGETS) expect(unionKeys.has(w.key)).toBe(true);
    for (const w of TRAVEL_WIDGETS) expect(unionKeys.has(w.key)).toBe(true);
    for (const w of COMMON_WIDGETS) expect(unionKeys.has(w.key)).toBe(true);
  });
});

describe('getDefaultWidgetsForRoleKey', () => {
  it('returns DOCTOR defaults that include today-appointments + pending-prescriptions', () => {
    const keys = getDefaultWidgetsForRoleKey('DOCTOR');
    expect(keys).toContain('today-appointments');
    expect(keys).toContain('pending-prescriptions');
  });

  it('returns RECEPTIONIST defaults that include full-clinic-calendar', () => {
    const keys = getDefaultWidgetsForRoleKey('RECEPTIONIST');
    expect(keys).toContain('full-clinic-calendar');
  });

  it('returns TELECALLER defaults that include telecaller-queue', () => {
    const keys = getDefaultWidgetsForRoleKey('TELECALLER');
    expect(keys).toContain('telecaller-queue');
  });

  it('returns [] for an unknown role key', () => {
    expect(getDefaultWidgetsForRoleKey('UNKNOWN_ROLE')).toEqual([]);
    expect(getDefaultWidgetsForRoleKey(null)).toEqual([]);
    expect(getDefaultWidgetsForRoleKey(undefined)).toEqual([]);
  });
});
