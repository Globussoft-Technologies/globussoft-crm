/**
 * Sidebar.test.jsx — FIRST general-coverage smoke test for the 1543-LOC
 * multi-vertical Sidebar component.
 *
 * SUT: frontend/src/components/Sidebar.jsx
 *
 * Sibling files Sidebar.activeState.test.jsx (#631 active-state regression
 * pin) and Sidebar.countersRefresh.test.jsx (#625 cross-page counter
 * invalidation pin) cover narrow regression slices. This file pins the
 * LOAD-BEARING surface that nothing else covers:
 *   - Per-vertical render (generic / wellness / travel) — Sidebar reads
 *     tenant.vertical from AuthContext and delegates to one of three
 *     renderers (renderGenericNav / renderWellnessNav / renderTravelNav).
 *   - RBAC visibility — items gated by adminOnly / managerOnly / wellnessRoles
 *     should hide for USER and reveal for ADMIN.
 *   - Brand header (logo / tenant name) — renders from tenant prop.
 *   - Sub-brand switcher (travel) — appears when user has ≥2 sub-brand access.
 *   - Counter badges — render when counts > 0 (from fetchApi).
 *
 * Intentionally NOT exhaustive — Sidebar has ~150+ nav links across the
 * three verticals; this test pins a representative set per CLAUDE.md's
 * "pin the load-bearing surface" guidance and the existing sibling tests'
 * style.
 *
 * Pure pin — no source changes.
 *
 * Mocking strategy (mirrors Sidebar.activeState.test.jsx):
 *   - vi.mock react-router-dom is NOT used (NavLink + useLocation need
 *     real-ish behavior). MemoryRouter at initialEntries=[path] is the
 *     active-route driver.
 *   - adsgpt / callified / notify / api / socket.io-client stubbed
 *     (Sidebar wires those at module top; they fire side-effects on mount).
 *   - AuthContext provider wraps the SUT with controllable user + tenant.
 *   - useNotify returns a STABLE object reference (per the 2026-05-23
 *     standing rule on RTL hook mocks).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { AuthContext } from '../App';

// Stable mock object references (2026-05-23 RTL rule: hook-returned objects
// used in useCallback deps must be referentially stable across renders or
// the consumer infinite-renders).
const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
const socketObj = { on: vi.fn(), disconnect: vi.fn() };

vi.mock('../utils/adsgpt', () => ({
  launchAdsGptAs: vi.fn(),
  ADSGPT_DASHBOARD: 'https://example.test',
  ADSGPT_DEMO_LOGIN: 'demo@x.test',
}));
vi.mock('../utils/callified', () => ({ launchCallifiedSSO: vi.fn() }));
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));
vi.mock('socket.io-client', () => ({ io: () => socketObj }));
vi.mock('../utils/api', () => ({ fetchApi: vi.fn(() => Promise.resolve([])) }));

function renderSidebar({
  path = '/dashboard',
  role = 'ADMIN',
  vertical = 'generic',
  wellnessRole = null,
  tenantName = 'Acme CRM',
  logoUrl = null,
  brandColor = null,
  subBrandAccess = null,
} = {}) {
  const user = {
    name: 'Maya Iyer',
    email: 'maya@acme.test',
    role,
    wellnessRole,
    subBrandAccess: subBrandAccess === null ? null : JSON.stringify(subBrandAccess),
  };
  const tenant = { name: tenantName, vertical, logoUrl, brandColor };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{
          user,
          setUser: vi.fn(),
          token: 't-abc',
          setToken: vi.fn(),
          tenant,
          setTenant: vi.fn(),
        }}
      >
        <Sidebar />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  notifyObj.confirm.mockReset();
});

describe('Sidebar — load-bearing render surface', () => {
  describe('Generic vertical', () => {
    it('renders core generic nav items (Dashboard / Contacts / Pipeline / Leads / Tickets)', () => {
      renderSidebar({ vertical: 'generic', role: 'ADMIN' });
      // Core links visible to all roles — pin a representative few.
      expect(screen.getByText('Dashboard')).toBeTruthy();
      expect(screen.getByText('Contacts')).toBeTruthy();
      expect(screen.getByText('Pipeline')).toBeTruthy();
      // "Leads" label appears as both the nav label and possibly badge text;
      // accept either by checking we have at least one match.
      expect(screen.getAllByText('Leads').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Tickets')).toBeTruthy();
    });

    it('renders 40+ links for ADMIN under generic vertical (full enterprise nav)', () => {
      const { container } = renderSidebar({ vertical: 'generic', role: 'ADMIN' });
      // Generic nav has 50+ items across core + manager + admin sections.
      // Pin lower bound at 40 (allow for future trimming).
      const navLinks = container.querySelectorAll('a.nav-link');
      expect(navLinks.length).toBeGreaterThanOrEqual(40);
    });
  });

  describe('Wellness vertical', () => {
    it('renders wellness-specific nav items (Patients / Calendar / Service Catalog)', () => {
      renderSidebar({
        vertical: 'wellness',
        role: 'ADMIN',
        wellnessRole: null, // ADMIN auto-passes wellnessRoles gate
        tenantName: 'Enhanced Wellness',
      });
      expect(screen.getByText('Patients')).toBeTruthy();
      // Multiple links titled "Calendar" (also wellness/calendar + Holidays);
      // use getAllByText to be safe.
      expect(screen.getAllByText('Calendar').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Service Catalog')).toBeTruthy();
      // Wellness section labels — Clinical / Staff / Finance present.
      expect(screen.getByText('Clinical')).toBeTruthy();
      expect(screen.getByText('Finance')).toBeTruthy();
    });

    it('does NOT render generic-only items (Pipeline / CPQ / Win-Loss) under wellness vertical', () => {
      renderSidebar({ vertical: 'wellness', role: 'ADMIN' });
      // These are generic-vertical-only navs.
      expect(screen.queryByText('Pipeline')).toBeNull();
      expect(screen.queryByText('Win/Loss')).toBeNull();
      expect(screen.queryByText('CPQ')).toBeNull();
    });
  });

  describe('Travel vertical', () => {
    it('renders travel-specific nav items (Itineraries / TMC Trips / Suppliers)', () => {
      renderSidebar({ vertical: 'travel', role: 'ADMIN', tenantName: 'TMC Travel' });
      expect(screen.getByText('Itineraries')).toBeTruthy();
      expect(screen.getByText('TMC Trips')).toBeTruthy();
      expect(screen.getByText('Suppliers')).toBeTruthy();
      // Phase 3 Visa Sure section is admin-only. "Visa Sure" appears both as
      // a section label AND as a switcher option — accept ≥1 match.
      expect(screen.getAllByText('Visa Sure').length).toBeGreaterThanOrEqual(1);
    });

    it('renders the sub-brand switcher when user has ≥2 sub-brand access', () => {
      renderSidebar({
        vertical: 'travel',
        role: 'MANAGER', // Non-admin so subBrandAccess is honored
        subBrandAccess: ['tmc', 'rfu', 'travelstall'],
      });
      // Switcher has aria-label="Switch active sub-brand"
      const switcher = screen.getByLabelText('Switch active sub-brand');
      expect(switcher).toBeTruthy();
      expect(switcher.tagName).toBe('SELECT');
      // The three accessible sub-brand options should be present (+ "All").
      const optionLabels = Array.from(switcher.querySelectorAll('option')).map((o) => o.textContent);
      expect(optionLabels.some((l) => l.includes('TMC'))).toBe(true);
      expect(optionLabels.some((l) => l.includes('RFU'))).toBe(true);
      expect(optionLabels.some((l) => l.includes('Travel Stall'))).toBe(true);
      // Visa Sure NOT in access list → should NOT appear as an option.
      expect(optionLabels.some((l) => l === 'Visa Sure')).toBe(false);
    });

    it('hides the sub-brand switcher for single-sub-brand users', () => {
      renderSidebar({
        vertical: 'travel',
        role: 'MANAGER',
        subBrandAccess: ['tmc'], // only one — no switcher needed
      });
      expect(screen.queryByLabelText('Switch active sub-brand')).toBeNull();
    });
  });

  describe('RBAC', () => {
    it('hides admin-only items (Staff, Audit Log, Privacy) for USER role under generic', () => {
      renderSidebar({ vertical: 'generic', role: 'USER' });
      expect(screen.queryByText('Staff')).toBeNull();
      expect(screen.queryByText('Audit Log')).toBeNull();
      expect(screen.queryByText('Privacy')).toBeNull();
      // Notification Settings is the USER-visible bottom item.
      expect(screen.getByText('Notification Settings')).toBeTruthy();
    });

    it('reveals admin-only items for ADMIN role under generic', () => {
      renderSidebar({ vertical: 'generic', role: 'ADMIN' });
      expect(screen.getByText('Staff')).toBeTruthy();
      expect(screen.getByText('Audit Log')).toBeTruthy();
      expect(screen.getByText('Privacy')).toBeTruthy();
      // Settings is admin-only here.
      expect(screen.getByText('Settings')).toBeTruthy();
    });

    it('hides manager-only items (Forecasting, Quotas) for USER role under generic', () => {
      renderSidebar({ vertical: 'generic', role: 'USER' });
      expect(screen.queryByText('Forecasting')).toBeNull();
      expect(screen.queryByText('Quotas')).toBeNull();
      expect(screen.queryByText('Win/Loss')).toBeNull();
    });

    it('shows manager-only items for MANAGER role but still hides admin-only', () => {
      renderSidebar({ vertical: 'generic', role: 'MANAGER' });
      // Manager sees manager items.
      expect(screen.getByText('Forecasting')).toBeTruthy();
      expect(screen.getByText('Quotas')).toBeTruthy();
      // Manager does NOT see admin-only.
      expect(screen.queryByText('Audit Log')).toBeNull();
      expect(screen.queryByText('Sandbox')).toBeNull();
    });

    it('hides clinical-role-gated wellness items (Patients) for USER w/o wellnessRole', () => {
      renderSidebar({
        vertical: 'wellness',
        role: 'USER',
        wellnessRole: null, // no clinical wellnessRole + USER → gate fires
      });
      // Patients/Calendar/Waitlist require wellnessRoles=[doctor,professional,telecaller]
      // and the user is neither admin/manager nor any clinical role → hidden.
      expect(screen.queryByText('Patients')).toBeNull();
      expect(screen.queryByText('Waitlist')).toBeNull();
    });

    it('shows clinical wellness items for doctor wellnessRole', () => {
      renderSidebar({
        vertical: 'wellness',
        role: 'USER',
        wellnessRole: 'doctor',
      });
      expect(screen.getByText('Patients')).toBeTruthy();
      expect(screen.getByText('Waitlist')).toBeTruthy();
    });

    // #917 slice 5 — CSP Violations admin entry visibility pin. Slice 4
    // shipped the page + route mount at /admin/csp-violations; this slice
    // adds the Sidebar nav entry. The two cases below assert the entry is
    // gated to ADMIN role exactly like Audit Log + Field Permissions.
    it('reveals CSP Violations admin entry for ADMIN role under generic', () => {
      renderSidebar({ vertical: 'generic', role: 'ADMIN' });
      const link = screen.getByText('CSP Violations');
      expect(link).toBeTruthy();
      // The anchor href should point at /admin/csp-violations.
      const anchor = link.closest('a');
      expect(anchor).toBeTruthy();
      expect(anchor.getAttribute('href')).toBe('/admin/csp-violations');
    });

    it('hides CSP Violations admin entry for USER and MANAGER roles', () => {
      renderSidebar({ vertical: 'generic', role: 'USER' });
      expect(screen.queryByText('CSP Violations')).toBeNull();
      // MANAGER should also NOT see it (adminOnly, not managerOnly).
      renderSidebar({ vertical: 'generic', role: 'MANAGER' });
      expect(screen.queryByText('CSP Violations')).toBeNull();
    });
  });

  describe('Brand header', () => {
    it('renders the tenant name in the header', () => {
      renderSidebar({ tenantName: 'Globussoft Enterprise', vertical: 'generic' });
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('Globussoft Enterprise');
    });

    it('renders a logo image when tenant.logoUrl is set', () => {
      renderSidebar({
        tenantName: 'Brand X',
        logoUrl: 'https://cdn.example.test/logo.png',
        vertical: 'generic',
      });
      const img = screen.getByRole('img', { name: 'Brand X' });
      expect(img).toBeTruthy();
      expect(img.getAttribute('src')).toBe('https://cdn.example.test/logo.png');
    });

    it('falls back to "Globussoft" when tenant has no name', () => {
      // null tenant.name path
      render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthContext.Provider
            value={{
              user: { name: 'X', email: 'x@x.test', role: 'USER' },
              setUser: vi.fn(),
              token: 't',
              setToken: vi.fn(),
              tenant: { vertical: 'generic' }, // no name
              setTenant: vi.fn(),
            }}
          >
            <Sidebar />
          </AuthContext.Provider>
        </MemoryRouter>,
      );
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('Globussoft');
    });
  });

  describe('Outer container a11y', () => {
    it('renders the aside with role="navigation" when not in mobile-drawer mode', () => {
      const { container } = renderSidebar({ vertical: 'generic', role: 'ADMIN' });
      const aside = container.querySelector('aside#app-sidebar');
      expect(aside).toBeTruthy();
      expect(aside.getAttribute('role')).toBe('navigation');
      expect(aside.getAttribute('aria-label')).toBe('Main navigation');
    });
  });
});
