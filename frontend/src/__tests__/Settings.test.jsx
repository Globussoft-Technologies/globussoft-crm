/**
 * Settings.test.jsx — vitest + RTL coverage for the tenant-admin Organization
 * Settings page (frontend/src/pages/Settings.jsx, 987 LOC).
 *
 * What this SUT actually is: a single-page card-grid layout (NOT a tabbed
 * page). The Settings page renders a 2-column grid of cards: Organization,
 * Appearance (theme radio group), Email Messages (retention toggle — already
 * pinned by Settings.emailRetention.test.jsx), Branding (logo + brand color),
 * Pipeline Stages, User Roster, Invite User, Notification Preferences, plus
 * a wellness-only ConsentTemplates card. This test pins the page-shell +
 * representative card behaviours WITHOUT duplicating Settings.emailRetention's
 * scope.
 *
 * Scope: pins the page-surface invariants:
 *   1. Smoke render — page renders with the "Organization Settings" header
 *      and the high-level subtitle.
 *   2. Initial-mount fetchApi calls — /api/tenants/current, /api/wellness/branding,
 *      /api/auth/users, /api/pipeline_stages, /api/notifications/preferences
 *      all fire on mount.
 *   3. Organization card renders Name + Slug + Owner Email + Plan inputs
 *      after the tenant load resolves.
 *   4. Organization save — submitting the form PUTs to /api/tenants/current
 *      with { name, ownerEmail } only (slug is read-only).
 *   5. Appearance card — the three theme radio options (Light / Dark / System)
 *      are rendered; clicking one calls setTheme + notify.success.
 *   6. Pipeline Stages card — loading state shown initially, then the loaded
 *      stages render with their position labels.
 *   7. Add pipeline stage — submitting the form POSTs to /api/pipeline_stages
 *      with { name, color, position } and then re-fetches the list.
 *   8. Invite user — submitting the invite form POSTs to /api/auth/register
 *      with the form values.
 *   9. User Roster card — loaded users render with their name + email + role
 *      badge.
 *  10. Loading state — while initial fetches are in-flight, the Organization
 *      card shows "Loading organization details…" and the roster shows
 *      "Loading team...".
 *  11. Slug field is read-only — its readOnly attribute and the helper text
 *      "Slug is read-only after organization creation." render together.
 *  12. Wellness-only Consent Templates card — does NOT render for generic
 *      vertical; DOES render when tenant.vertical === 'wellness'.
 *
 * Backend contracts pinned:
 *   GET  /api/tenants/current             → tenant row
 *   PUT  /api/tenants/current  { name, ownerEmail }
 *   GET  /api/auth/users                  → User[]
 *   POST /api/auth/register   { name, email, password, role }
 *   GET  /api/pipeline_stages             → PipelineStage[]
 *   POST /api/pipeline_stages  { name, color, position }
 *   GET  /api/wellness/branding           → { logoUrl, brandColor }
 *   GET  /api/notifications/preferences   → NotificationPreference
 *
 * Mocking discipline (per CLAUDE.md 2026-05-23 standing rule):
 *   - notifyObj is a STABLE module-level reference; useNotify always returns
 *     the same object identity to avoid re-render flap (the SUT uses notify
 *     inside callback closures whose hook-dep stability matters).
 *   - fetchApi is mocked at ../utils/api (the SUT's dependency surface, NOT
 *     window.fetch — only the logo upload uses raw fetch and isn't exercised
 *     here).
 *   - ThemeContext + AuthContext stubbed via ../App so the page renders
 *     standalone without booting the full app.
 *   - All data-dependent assertions use await waitFor / findBy.
 *
 * Out of scope (intentionally):
 *   - Email retention toggle (covered by Settings.emailRetention.test.jsx)
 *   - Logo upload (uses raw fetch + FormData; render-only smoke is enough)
 *   - Color picker drag interaction (dense embedded widget; render-only)
 *   - Notification Preferences sub-form (covered by UserSettings.test.jsx
 *     which mounts the same shape against the UserSettings page)
 *   - Stage reorder / delete (POST contract is the load-bearing one)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// --- Stable mocks per 2026-05-23 standing rule -------------------------------
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Settings.jsx pulls ThemeContext + AuthContext from App.jsx; stub the module
// so the page renders standalone without booting the full app. vi.hoisted
// keeps setThemeMock available inside the (hoisted) vi.mock factory.
const { setThemeMock } = vi.hoisted(() => ({ setThemeMock: vi.fn() }));
vi.mock('../App', () => {
  const React = require('react');
  return {
    ThemeContext: React.createContext({
      theme: 'light',
      setTheme: setThemeMock,
      toggleTheme: () => {},
    }),
    AuthContext: React.createContext({ tenant: null, setTenant: () => {} }),
  };
});

import Settings from '../pages/Settings';

const baseTenant = {
  id: 1,
  name: 'Acme Corp',
  slug: 'acme',
  plan: 'starter',
  vertical: 'generic',
  ownerEmail: 'admin@acme.com',
  emailRetention: true,
};

const baseStages = [
  { id: 's1', name: 'Prospecting', color: '#3b82f6', position: 0 },
  { id: 's2', name: 'Qualification', color: '#10b981', position: 1 },
];

const baseUsers = [
  { id: 'u1', name: 'Aditi Sharma', email: 'aditi@acme.com', role: 'ADMIN' },
  { id: 'u2', name: 'Rohan Mehta', email: 'rohan@acme.com', role: 'USER' },
];

const basePrefs = {
  categoryToggles: { deal: true, task: true, ticket: true, lead: true, approval: true, leave: true, expense: true },
  channels: { db: true, socket: true, push: false, email: true },
  timezone: 'Asia/Kolkata',
  quietHoursStart: null,
  quietHoursEnd: null,
};

function buildDefaultFetch(overrides = {}) {
  const tenant = overrides.tenant ?? baseTenant;
  const stages = overrides.stages ?? baseStages;
  const users = overrides.users ?? baseUsers;
  const branding = overrides.branding ?? { logoUrl: null, brandColor: '' };
  const prefs = overrides.prefs ?? basePrefs;

  return function defaultFetch(url, opts) {
    const method = opts?.method || 'GET';
    if (url === '/api/tenants/current' && method === 'GET') return Promise.resolve(tenant);
    if (url === '/api/tenants/current' && method === 'PUT') {
      const body = JSON.parse(opts.body);
      return Promise.resolve({ ...tenant, ...body });
    }
    if (url === '/api/wellness/branding' && method === 'GET') return Promise.resolve(branding);
    if (url === '/api/auth/users' && method === 'GET') return Promise.resolve(users);
    if (url === '/api/auth/register' && method === 'POST') return Promise.resolve({ ok: true });
    if (url === '/api/pipeline_stages' && method === 'GET') return Promise.resolve(stages);
    if (url === '/api/pipeline_stages' && method === 'POST') return Promise.resolve({ ok: true });
    if (url === '/api/notifications/preferences' && method === 'GET') return Promise.resolve(prefs);
    if (url === '/api/wellness/consent-templates') return Promise.resolve([]);
    return Promise.resolve([]);
  };
}

describe('<Settings /> — page shell + representative card pin', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.success.mockReset();
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.confirm.mockReset();
    notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
    setThemeMock.mockReset();
    fetchApiMock.mockImplementation(buildDefaultFetch());
  });

  // 1 — Smoke render
  it('renders the page header "Organization Settings" + subtitle', async () => {
    render(<Settings />);
    expect(screen.getByRole('heading', { name: /Organization Settings/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Manage team members, roles, and administrative security/i)).toBeInTheDocument();
  });

  // 2 — Initial fetches on mount
  it('fires the load-settings fetchApi calls on initial mount', async () => {
    render(<Settings />);
    await waitFor(() => {
      const calledUrls = fetchApiMock.mock.calls.map(([url]) => url);
      expect(calledUrls).toContain('/api/tenants/current');
      expect(calledUrls).toContain('/api/wellness/branding');
      expect(calledUrls).toContain('/api/auth/users');
      expect(calledUrls).toContain('/api/pipeline_stages');
      expect(calledUrls).toContain('/api/notifications/preferences');
    });
  });

  // 3 — Organization card renders inputs
  it('renders Organization card inputs after tenant load (Name + Slug + Owner Email + Plan)', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByDisplayValue('Acme Corp')).toBeInTheDocument());
    expect(screen.getByDisplayValue('acme')).toBeInTheDocument();
    expect(screen.getByDisplayValue('admin@acme.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('starter')).toBeInTheDocument();
  });

  // 4 — Organization save PUTs name + ownerEmail (not slug)
  it('submitting the Organization form PUTs /api/tenants/current with { name, ownerEmail }', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByDisplayValue('Acme Corp')).toBeInTheDocument());

    const nameInput = screen.getByDisplayValue('Acme Corp');
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme Wellness Ltd');

    const saveBtn = screen.getByRole('button', { name: /Save Organization Details/i });
    await user.click(saveBtn);

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/tenants/current' && opts?.method === 'PUT'
      );
      expect(puts.length).toBeGreaterThan(0);
      const body = JSON.parse(puts[0][1].body);
      // Slug intentionally not in body — it's read-only.
      expect(body).toEqual({ name: 'Acme Wellness Ltd', ownerEmail: 'admin@acme.com' });
      expect('slug' in body).toBe(false);
    });
  });

  // 5 — Appearance card theme radios
  it('renders the three theme options under the Appearance card and clicking one calls setTheme + notify.success', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Light mode')).toBeInTheDocument());
    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    expect(screen.getByText('Based on system preference')).toBeInTheDocument();

    const darkRadio = screen.getByRole('radio', { name: /Dark mode/i });
    await user.click(darkRadio);

    expect(setThemeMock).toHaveBeenCalledWith('dark');
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/Theme set to Dark mode/i));
  });

  // 6 — Pipeline stages loaded list
  it('renders loaded pipeline stages with their names + position labels', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Prospecting')).toBeInTheDocument());
    expect(screen.getByText('Qualification')).toBeInTheDocument();
    expect(screen.getByText(/Position 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Position 2/i)).toBeInTheDocument();
  });

  // 7 — Add pipeline stage POSTs
  it('submitting Add Stage form POSTs /api/pipeline_stages with { name, color, position }', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Prospecting')).toBeInTheDocument());

    const stageNameInput = screen.getByPlaceholderText(/Stage name/i);
    await user.type(stageNameInput, 'Negotiation');
    const addBtn = screen.getByRole('button', { name: /Add Stage/i });
    await user.click(addBtn);

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/pipeline_stages' && opts?.method === 'POST'
      );
      expect(posts.length).toBeGreaterThan(0);
      const body = JSON.parse(posts[0][1].body);
      expect(body.name).toBe('Negotiation');
      // position should match the current stages length (2 in baseStages)
      expect(body.position).toBe(2);
      expect(typeof body.color).toBe('string');
    });
  });

  // 8 — Invite user POSTs
  it('submitting the Invite Team Member form POSTs /api/auth/register with the form values', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Full Name/i)).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Full Name/i), 'Priya Kapoor');
    await user.type(screen.getByPlaceholderText(/Email Address/i), 'priya@acme.com');
    await user.type(screen.getByPlaceholderText(/Temporary Password/i), 'tempPass123!');

    const submitBtn = screen.getByRole('button', { name: /Send Invitation & Create Account/i });
    await user.click(submitBtn);

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/auth/register' && opts?.method === 'POST'
      );
      expect(posts.length).toBeGreaterThan(0);
      const body = JSON.parse(posts[0][1].body);
      expect(body.name).toBe('Priya Kapoor');
      expect(body.email).toBe('priya@acme.com');
      expect(body.password).toBe('tempPass123!');
      expect(body.role).toBe('USER'); // default
    });
  });

  // 9 — User Roster renders loaded users
  it('renders the loaded users in the Access Control Roster with name + email + role badge', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Aditi Sharma')).toBeInTheDocument());
    expect(screen.getByText('aditi@acme.com')).toBeInTheDocument();
    expect(screen.getByText('Rohan Mehta')).toBeInTheDocument();
    expect(screen.getByText('rohan@acme.com')).toBeInTheDocument();
    // ADMIN badge text appears for Aditi
    const adminBadges = screen.getAllByText('ADMIN');
    expect(adminBadges.length).toBeGreaterThan(0);
  });

  // 10 — Loading states (initial mount before fetches resolve)
  it('shows the loading copy ("Loading organization details…" + "Loading team...") before fetches resolve', async () => {
    // Make all fetches hang so the loading state stays visible.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    render(<Settings />);
    expect(screen.getByText(/Loading organization details/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading team/i)).toBeInTheDocument();
  });

  // 11 — Slug field is read-only
  it('renders the Slug input as read-only with helper text', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByDisplayValue('acme')).toBeInTheDocument());
    const slugInput = screen.getByDisplayValue('acme');
    expect(slugInput).toHaveAttribute('readonly');
    expect(slugInput).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByText(/Slug is read-only after organization creation/i)).toBeInTheDocument();
  });

  // 12a — Consent Templates does NOT render for generic vertical
  it('does NOT render the Consent Templates card for generic vertical', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByDisplayValue('Acme Corp')).toBeInTheDocument());
    expect(screen.queryByText(/Consent Templates/i)).not.toBeInTheDocument();
  });

  // 12b — Consent Templates DOES render when wellness
  it('renders the Consent Templates card when tenant.vertical === "wellness"', async () => {
    fetchApiMock.mockImplementation(
      buildDefaultFetch({ tenant: { ...baseTenant, vertical: 'wellness' } })
    );
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByTestId('consent-templates-card')).toBeInTheDocument()
    );
  });
});
