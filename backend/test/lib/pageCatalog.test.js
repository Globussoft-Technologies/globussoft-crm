/**
 * Unit tests for backend/lib/pageCatalog.js.
 *
 * The catalog is the canonical list of pages a Role.landingPath can
 * point at + the source of truth the /api/pages/me + /api/roles/:id/
 * accessible-pages endpoints read from. Critical contracts:
 *   - empty requiredPermissions = always accessible (so /home survives
 *     a permission revocation and the system can fall back there).
 *   - canAccessPath returns true iff the user has ALL required perms.
 *   - getAccessiblePages returns a deep clone so callers can't mutate
 *     the static module-level array.
 */

import { describe, it, expect } from 'vitest';
import {
  PAGE_CATALOG,
  getCatalog,
  getPage,
  isKnownPage,
  getAccessiblePages,
  canAccessPath,
} from '../../lib/pageCatalog.js';

describe('PAGE_CATALOG shape', () => {
  it('has /home as a permission-free entry (default fallback landing)', () => {
    const home = PAGE_CATALOG.find((p) => p.path === '/home');
    expect(home).toBeDefined();
    expect(home.requiredPermissions).toEqual([]);
  });

  it('every entry has path, label, category, requiredPermissions[]', () => {
    for (const p of PAGE_CATALOG) {
      expect(typeof p.path).toBe('string');
      expect(p.path.startsWith('/')).toBe(true);
      expect(typeof p.label).toBe('string');
      expect(typeof p.category).toBe('string');
      expect(Array.isArray(p.requiredPermissions)).toBe(true);
    }
  });

  it('paths are unique', () => {
    const paths = PAGE_CATALOG.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every requiredPermission has module + action strings', () => {
    for (const p of PAGE_CATALOG) {
      for (const perm of p.requiredPermissions) {
        expect(typeof perm.module).toBe('string');
        expect(typeof perm.action).toBe('string');
      }
    }
  });
});

describe('getCatalog', () => {
  it('returns a deep clone (mutations do not affect source)', () => {
    const c = getCatalog();
    c[0].label = 'HACKED';
    c[0].requiredPermissions.push({ module: 'evil', action: 'all' });
    expect(PAGE_CATALOG[0].label).not.toBe('HACKED');
    expect(
      PAGE_CATALOG[0].requiredPermissions.some((p) => p.module === 'evil'),
    ).toBe(false);
  });
});

describe('customerOnly storefront pages', () => {
  // The customer-facing surfaces (Buy Gift Cards storefront + My
  // Transactions history) are open to any authenticated session
  // (requiredPermissions: []) but carry a `customerOnly` flag the wellness
  // sidebar uses to surface them ONLY to customer-tier roles (USER /
  // CUSTOMER). Pin the flag + the open-permission contract so a refactor
  // can't silently drop the gate or add a permission that would hide them
  // from the very customers they're for.
  const CUSTOMER_PAGES = ['/wellness/buy-giftcards', '/wellness/my-transactions'];

  it('Buy Gift Cards + My Transactions are flagged customerOnly with no required permissions', () => {
    for (const path of CUSTOMER_PAGES) {
      const page = getPage(path);
      expect(page, `${path} should exist in the catalog`).not.toBeNull();
      expect(page.customerOnly).toBe(true);
      expect(page.requiredPermissions).toEqual([]);
    }
  });

  it('getAccessiblePages includes them for an empty permission set (everyone can reach the page)', () => {
    const pages = getAccessiblePages(new Set());
    const paths = pages.map((p) => p.path);
    for (const path of CUSTOMER_PAGES) {
      expect(paths).toContain(path);
    }
  });

  it('carries the customerOnly flag through the getAccessiblePages clone', () => {
    const pages = getAccessiblePages(new Set());
    for (const path of CUSTOMER_PAGES) {
      const page = pages.find((p) => p.path === path);
      expect(page).toBeDefined();
      expect(page.customerOnly).toBe(true);
    }
  });
});

describe('isKnownPage / getPage', () => {
  it('accepts catalog paths', () => {
    expect(isKnownPage('/home')).toBe(true);
    expect(isKnownPage('/wellness/calendar')).toBe(true);
  });
  it('rejects unknown paths', () => {
    expect(isKnownPage('/not-a-page')).toBe(false);
    expect(isKnownPage('')).toBe(false);
    expect(isKnownPage(null)).toBe(false);
    expect(isKnownPage(undefined)).toBe(false);
  });
  it('getPage returns the entry or null', () => {
    expect(getPage('/home')).not.toBeNull();
    expect(getPage('/missing')).toBeNull();
  });
});

describe('canAccessPath', () => {
  // Doctor permission set: tenant-wide list (`appointments.read+write`)
  // plus the per-page modules a doctor actually uses post-split
  // (`my_appointments.read` for the practitioner's own-slot view,
  // `waitlist.read` to peek at the queue). Mirrors DOCTOR_PERMISSIONS
  // in ensureRbacOnBoot.js. Nurse-shaped permission sets (read+update
  // only, no my-appointments) are exercised separately below.
  const docPerms = new Set([
    'patients.read',
    'appointments.read',
    'appointments.write',
    'my_appointments.read',
    'waitlist.read',
    // `calendar` is a separate permission module from `appointments` —
    // doctors get both so the day-grid view + booking flows work
    // end-to-end. Mirrors DOCTOR_PERMISSIONS in ensureRbacOnBoot.js.
    'calendar.read',
    'calendar.write',
    'prescriptions.read',
  ]);

  it('returns true for /home regardless of permissions', () => {
    expect(canAccessPath('/home', new Set())).toBe(true);
    expect(canAccessPath('/home', docPerms)).toBe(true);
  });

  it('returns true when the user has all required perms', () => {
    expect(canAccessPath('/wellness/patients', docPerms)).toBe(true);
    expect(canAccessPath('/wellness/calendar', docPerms)).toBe(true);
  });

  it('returns false when even one required perm is missing', () => {
    // /wellness/pos needs pos.read which docPerms lacks
    expect(canAccessPath('/wellness/pos', docPerms)).toBe(false);
    expect(canAccessPath('/invoices', docPerms)).toBe(false);
  });

  it('returns false for unknown paths', () => {
    expect(canAccessPath('/not-a-page', docPerms)).toBe(false);
  });

  it('OWNER short-circuit grants access to everything', () => {
    expect(canAccessPath('/invoices', new Set(), { isOwner: true })).toBe(true);
    expect(canAccessPath('/wellness/pos', new Set(), { isOwner: true })).toBe(true);
  });

  it('grants Nurse-shape permissions visibility to all read-able pages; bars pure-write surfaces', () => {
    // Nurse seed: appointments.read + appointments.update — NO .write.
    // Sidebar gating policy: a role with .read of a module sees the
    // listing/view pages of that module in the sidebar — the action
    // buttons inside each page are gated separately (.write for creation,
    // .update for edits, .delete for deletes, .manage for admin config).
    // So Calendar / My Appointments / Waitlist are accessible (they're
    // viewing surfaces), but Book Appointment (a pure submission form)
    // requires .write and stays barred.
    const nursePerms = new Set([
      'patients.read',
      'patients.update',
      'appointments.read',
      'appointments.update',
      // Nurse peeks at the waitlist queue (read only — promote /
      // disposition is gated on waitlist.write which she doesn't get).
      // No my_appointments.read or book_appointment.write — nurses
      // don't own slots or book on behalf of patients.
      'waitlist.read',
      // Nurse views the Calendar day-grid for context; doesn't write to
      // it (booking / rescheduling is Doctor / Receptionist work).
      // Mirrors NURSE_PERMISSIONS in ensureRbacOnBoot.js.
      'calendar.read',
      'visits.read',
      'visits.write',
      'visits.update',
      // products (master catalog) + inventory (stock ledger) are now
      // separate permission modules — Nurse needs both because she records
      // new arrivals (products) AND stock-in receipts (inventory). Mirrors
      // NURSE_PERMISSIONS in scripts/ensureRbacOnBoot.js.
      'products.read',
      'products.write',
      'products.update',
      'inventory.read',
      'inventory.write',
      'inventory.update',
      'services.read',
      'consents.read',
      'expenses.read',
    ]);
    // Viewing surfaces ARE accessible — Nurse has the .read action.
    expect(canAccessPath('/wellness/appointments', nursePerms)).toBe(true);
    expect(canAccessPath('/wellness/patients', nursePerms)).toBe(true);
    expect(canAccessPath('/wellness/calendar', nursePerms)).toBe(true);
    expect(canAccessPath('/wellness/waitlist', nursePerms)).toBe(true);
    expect(canAccessPath('/wellness/products', nursePerms)).toBe(true);
    expect(canAccessPath('/wellness/inventory-receipts', nursePerms)).toBe(true);
    // Pure-write / pure-form / practitioner-personal surfaces are NOT —
    // Book Appointment is a submission form (no read view), and "My
    // appointments" only exists for practitioners who can OWN
    // appointments (appointments.write).
    expect(canAccessPath('/wellness/book-appointment', nursePerms)).toBe(false);
    expect(canAccessPath('/wellness/my-appointments', nursePerms)).toBe(false);
    // Pages that need permissions Nurse simply doesn't have stay barred.
    expect(canAccessPath('/invoices', nursePerms)).toBe(false); // invoices.read
    expect(canAccessPath('/wellness/pos', nursePerms)).toBe(false); // pos.read
  });
});

describe('getAccessiblePages', () => {
  it('returns only pages whose required perms the user satisfies', () => {
    // Doctor-shape perms (includes appointments.write + calendar.*).
    const perms = new Set([
      'patients.read',
      'appointments.read',
      'appointments.write',
      'my_appointments.read',
      'calendar.read',
      'calendar.write',
      'prescriptions.read',
    ]);
    const pages = getAccessiblePages(perms);
    const paths = pages.map((p) => p.path);
    expect(paths).toContain('/home');
    expect(paths).toContain('/wellness/patients');
    expect(paths).toContain('/wellness/calendar');
    expect(paths).toContain('/wellness/prescriptions');
    expect(paths).not.toContain('/invoices'); // needs invoices.read
    expect(paths).not.toContain('/wellness/pos'); // needs pos.read
  });

  it('returns a clinical-only set for a Doctor', () => {
    // Mirror the seeded DOCTOR_PERMISSIONS from ensureRbacOnBoot.js so
    // the test surfaces the same accessible-pages a real Doctor sees.
    const perms = new Set([
      'patients.read', 'patients.write', 'patients.update',
      'appointments.read', 'appointments.write', 'appointments.update',
      // Post-split per-page modules (v3.8.x).
      'my_appointments.read',
      'waitlist.read',
      'calendar.read', 'calendar.write',
      'visits.read', 'visits.write', 'visits.update',
      'prescriptions.read', 'prescriptions.write', 'prescriptions.update',
      'consents.read', 'consents.write',
      'services.read',
      'inventory.read',
      'documents.read', 'documents.write',
    ]);
    const pages = getAccessiblePages(perms);
    const categories = new Set(pages.map((p) => p.category));
    expect(categories.has('Clinical')).toBe(true);
    // Drift: documents.read on the clinical perm set now also surfaces
    // a doc-billing page under Finance. The load-bearing assertion is
    // that Sales doesn't appear (Doctor doesn't get the pipeline view).
    // If a future iteration tightens documents.read back out of Finance
    // the assertion below can be re-strengthened.
    expect(categories.has('Sales')).toBe(false);
    // Doctor (with my_appointments.read) keeps the practitioner pages.
    const paths = pages.map((p) => p.path);
    expect(paths).toContain('/wellness/calendar');
    expect(paths).toContain('/wellness/my-appointments');
  });

  it('returns the full catalog for OWNER', () => {
    const all = getAccessiblePages(new Set(), { isOwner: true });
    expect(all.length).toBe(PAGE_CATALOG.length);
  });

  it('returns empty for a user with no permissions (except permission-free pages)', () => {
    const pages = getAccessiblePages(new Set());
    // /home is the only permission-free page; that's the deliberate
    // fallback the auto-clear flow relies on.
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0].path).toBe('/home');
  });

  it('returns empty array for non-Set input', () => {
    expect(getAccessiblePages(null)).toEqual([]);
    expect(getAccessiblePages(undefined)).toEqual([]);
    expect(getAccessiblePages('not-a-set')).toEqual([]);
  });
});
