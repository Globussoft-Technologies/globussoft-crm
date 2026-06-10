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
  getCatalog,
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
