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

// ============================================================================
// EXTENSION WAVE — additional ≥10 cases covering uncovered card sections:
// Branding (logo placeholder + brand color save), Pipeline Stages (delete +
// reorder), Email Messages (retention toggle pins), Notification Preferences
// (category + channel toggles, save, reset), Invite (role-select), Consent
// (create + delete), Roster row controls (role-change + delete), Public
// Booking URL copy. Same stable mock pattern; preserves the existing describe
// block above. Pure pin — no SUT changes.
// ============================================================================

describe('<Settings /> — extended card coverage', () => {
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

  // 13 — Branding: blank logo renders the placeholder icon (no <img>)
  it('Branding card shows the placeholder square when no logo is set', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/^Branding$/)).toBeInTheDocument());
    // No <img alt="Current logo"> should be present when logoUrl is null.
    expect(screen.queryByAltText(/Current logo/i)).not.toBeInTheDocument();
    // The file input accepts image/* mime types.
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(fileInput.getAttribute('accept')).toMatch(/image\/png/);
  });

  // 14 — Branding: existing logo URL renders as an <img>
  it('Branding card renders <img alt="Current logo"> when logoUrl is set', async () => {
    fetchApiMock.mockImplementation(
      buildDefaultFetch({ branding: { logoUrl: 'https://cdn.example.com/logo.png', brandColor: '#265855' } })
    );
    render(<Settings />);
    const img = await screen.findByAltText(/Current logo/i);
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/logo.png');
  });

  // 15 — Branding: Save color PUTs /api/wellness/branding/color with valid hex
  it('Save color button PUTs /api/wellness/branding/color with the 6-digit hex', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/wellness/branding/color' && method === 'PUT') {
        const body = JSON.parse(opts.body);
        return Promise.resolve({ brandColor: body.brandColor });
      }
      return buildDefaultFetch()(url, opts);
    });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/^Branding$/)).toBeInTheDocument());

    // Find the hex text input by its placeholder
    const hexInput = screen.getByPlaceholderText('#3b82f6');
    await user.clear(hexInput);
    await user.type(hexInput, '#265855');

    const saveBtn = screen.getByRole('button', { name: /Save color/i });
    await user.click(saveBtn);

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/branding/color' && opts?.method === 'PUT'
      );
      expect(puts.length).toBeGreaterThan(0);
      const body = JSON.parse(puts[0][1].body);
      expect(body).toEqual({ brandColor: '#265855' });
    });
    // Success message rendered
    await waitFor(() => expect(screen.getByText(/Brand color saved/i)).toBeInTheDocument());
  });

  // 16 — Branding: invalid hex surfaces inline error WITHOUT calling PUT
  it('Save color rejects a non-6-hex value with an inline error and no PUT', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/^Branding$/)).toBeInTheDocument());

    const hexInput = screen.getByPlaceholderText('#3b82f6');
    await user.clear(hexInput);
    await user.type(hexInput, 'not-a-hex');

    const saveBtn = screen.getByRole('button', { name: /Save color/i });
    await user.click(saveBtn);

    await waitFor(() => expect(screen.getByText(/must be a 6-digit hex/i)).toBeInTheDocument());
    const puts = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/wellness/branding/color' && opts?.method === 'PUT'
    );
    expect(puts.length).toBe(0);
  });

  // 17 — Pipeline Stages: delete fires DELETE after notify.confirm resolves true
  it('Delete stage button DELETEs /api/pipeline_stages/:id after confirm', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Prospecting')).toBeInTheDocument());

    // The pipeline-stages section: locate trash buttons. There are 2 stages so 2 trash
    // buttons inside the stages section; pick the first.
    const stageRow = screen.getByText('Prospecting').closest('div').parentElement;
    const deleteBtn = stageRow.querySelectorAll('button')[2]; // up / down / delete
    await user.click(deleteBtn);

    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(
        ([url, opts]) => /^\/api\/pipeline_stages\/s1$/.test(url) && opts?.method === 'DELETE'
      );
      expect(deletes.length).toBe(1);
    });
    expect(notifyObj.confirm).toHaveBeenCalled();
  });

  // 18 — Pipeline Stages: reorder fires PUT /api/pipeline_stages/reorder
  it('Move-down on first stage PUTs /api/pipeline_stages/reorder with swapped positions', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Prospecting')).toBeInTheDocument());

    // First stage row's down-arrow button. Stage row layout: 3 buttons (Up, Down, Delete).
    const stageRow = screen.getByText('Prospecting').closest('div').parentElement;
    const downBtn = stageRow.querySelectorAll('button')[1];
    await user.click(downBtn);

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/pipeline_stages/reorder' && opts?.method === 'PUT'
      );
      expect(puts.length).toBeGreaterThan(0);
      const body = JSON.parse(puts[0][1].body);
      // After swap, Qualification (s2) → pos 0, Prospecting (s1) → pos 1
      expect(body.stages).toEqual([
        { id: 's2', position: 0 },
        { id: 's1', position: 1 },
      ]);
    });
  });

  // 19 — Email Messages card: retention checkbox is checked when emailRetention !== false
  it('Email Messages retention checkbox reflects tenant.emailRetention state', async () => {
    render(<Settings />);
    const toggle = await screen.findByTestId('email-retention-toggle');
    expect(toggle).toBeChecked();
  });

  // 20 — Email Messages card: toggling OFF surfaces the warning + PUTs the new value
  it('Toggling email retention OFF PUTs /api/tenants/current with { emailRetention: false } + warning text appears', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    const toggle = await screen.findByTestId('email-retention-toggle');
    await user.click(toggle);

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/tenants/current' &&
          opts?.method === 'PUT' &&
          JSON.parse(opts.body).emailRetention === false
      );
      expect(puts.length).toBeGreaterThan(0);
    });
    // Warning text only renders when emailRetention === false in local state
    await waitFor(() => expect(screen.getByText(/Retention is OFF/i)).toBeInTheDocument());
  });

  // 21 — Notification Preferences: renders the 7 category labels + 4 channel labels
  it('Notification Preferences card renders all 7 categories + 4 channels', async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Notification Preferences/i)).toBeInTheDocument());

    // Categories
    expect(screen.getByText('Deals & Opportunities')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Support Tickets')).toBeInTheDocument();
    expect(screen.getByText('Leads')).toBeInTheDocument();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.getByText('Leave Requests')).toBeInTheDocument();
    expect(screen.getByText('Expense Reports')).toBeInTheDocument();

    // Channels
    expect(screen.getByText('In-App Bell')).toBeInTheDocument();
    expect(screen.getByText('Real-Time Updates')).toBeInTheDocument();
    expect(screen.getByText('Browser Push')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  // 22 — Notification Preferences: Save PUTs /api/notifications/preferences with state
  it('Save Preferences PUTs /api/notifications/preferences with the toggled state', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Notification Preferences/i)).toBeInTheDocument());

    // Toggle the "Tasks" category off
    const tasksLabel = screen.getByText('Tasks').closest('label');
    const tasksCheckbox = tasksLabel.querySelector('input[type="checkbox"]');
    await user.click(tasksCheckbox);

    const saveBtn = screen.getByRole('button', { name: /Save Preferences/i });
    await user.click(saveBtn);

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/notifications/preferences' && opts?.method === 'PUT'
      );
      expect(puts.length).toBeGreaterThan(0);
      const body = JSON.parse(puts[0][1].body);
      expect(body.categoryToggles.task).toBe(false);
      // Other categories remain on
      expect(body.categoryToggles.deal).toBe(true);
    });
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/saved/i));
  });

  // 23 — Notification Preferences: Reset POSTs /api/notifications/preferences/reset
  it('Reset to Defaults POSTs /api/notifications/preferences/reset after confirm', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Notification Preferences/i)).toBeInTheDocument());

    const resetBtn = screen.getByRole('button', { name: /Reset to Defaults/i });
    await user.click(resetBtn);

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/notifications/preferences/reset' && opts?.method === 'POST'
      );
      expect(posts.length).toBe(1);
    });
    expect(notifyObj.confirm).toHaveBeenCalled();
  });

  // 24 — Invite User: role-select changes POST role to MANAGER
  it('selecting Sales Manager in invite role and submitting POSTs with role=MANAGER', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Full Name/i)).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Full Name/i), 'Vikram Shah');
    await user.type(screen.getByPlaceholderText(/Email Address/i), 'vikram@acme.com');
    await user.type(screen.getByPlaceholderText(/Temporary Password/i), 'pass1234');

    // The invite-card role select is the one with "Sales Manager" option
    const roleSelects = screen.getAllByRole('combobox');
    const inviteRoleSelect = roleSelects.find((sel) =>
      Array.from(sel.options || []).some((opt) => opt.value === 'MANAGER' && /Sales Manager/i.test(opt.text))
    );
    expect(inviteRoleSelect).toBeTruthy();
    await user.selectOptions(inviteRoleSelect, 'MANAGER');

    await user.click(screen.getByRole('button', { name: /Send Invitation & Create Account/i }));

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/auth/register' && opts?.method === 'POST'
      );
      expect(posts.length).toBeGreaterThan(0);
      const body = JSON.parse(posts[posts.length - 1][1].body);
      expect(body.role).toBe('MANAGER');
      expect(body.name).toBe('Vikram Shah');
    });
  });

  // 25 — Roster: change role on existing user PUTs /api/auth/users/:id/role
  it('changing a roster user role PUTs /api/auth/users/:id/role with the new role', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Rohan Mehta')).toBeInTheDocument());

    // Find Rohan's row → its select element
    const rohanRow = screen.getByText('Rohan Mehta').closest('div').parentElement;
    const roleSelect = rohanRow.querySelector('select');
    expect(roleSelect).toBeTruthy();
    await user.selectOptions(roleSelect, 'MANAGER');

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => /^\/api\/auth\/users\/u2\/role$/.test(url) && opts?.method === 'PUT'
      );
      expect(puts.length).toBe(1);
      const body = JSON.parse(puts[0][1].body);
      expect(body.role).toBe('MANAGER');
    });
  });

  // 26 — Roster: delete non-ADMIN user DELETEs /api/auth/users/:id after confirm
  it('clicking the trash icon on a non-ADMIN roster user DELETEs /api/auth/users/:id after confirm', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Rohan Mehta')).toBeInTheDocument());

    // Rohan is USER → trash button visible; Aditi is ADMIN → "—" placeholder.
    const rohanCard = screen.getByText('Rohan Mehta').closest('div').parentElement;
    const trashBtn = rohanCard.querySelector('button');
    expect(trashBtn).toBeTruthy();
    await user.click(trashBtn);

    await waitFor(() => {
      const deletes = fetchApiMock.mock.calls.filter(
        ([url, opts]) => /^\/api\/auth\/users\/u2$/.test(url) && opts?.method === 'DELETE'
      );
      expect(deletes.length).toBe(1);
    });
    expect(notifyObj.confirm).toHaveBeenCalled();
  });

  // 27 — Consent Templates (wellness): seeded templates render + Add Template POSTs
  it('wellness Consent Templates card lists seeded rows and Add Template POSTs new row', async () => {
    const user = userEvent.setup();
    const seededTemplates = [
      { id: 'ct1', key: 'general', label: 'General Consent', isActive: true, isSeed: true },
      { id: 'ct2', key: 'aesthetic', label: 'Aesthetic Procedure Consent', isActive: true, isSeed: true },
    ];
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/wellness/consent-templates' && method === 'GET') {
        return Promise.resolve(seededTemplates);
      }
      if (url === '/api/wellness/consent-templates' && method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return buildDefaultFetch({ tenant: { ...baseTenant, vertical: 'wellness' } })(url, opts);
    });

    render(<Settings />);
    await waitFor(() => expect(screen.getByTestId('consent-templates-card')).toBeInTheDocument());

    // Seeded labels render
    expect(screen.getByText('General Consent')).toBeInTheDocument();
    expect(screen.getByText('Aesthetic Procedure Consent')).toBeInTheDocument();
    // (starter) marker appears for seed rows — there are 2
    expect(screen.getAllByText(/\(starter\)/i).length).toBeGreaterThanOrEqual(2);

    // Create a new template
    await user.type(screen.getByPlaceholderText(/Key \(e\.g\. paediatric\)/i), 'paediatric');
    await user.type(screen.getByPlaceholderText(/Label \(e\.g\. Paediatric Consent\)/i), 'Paediatric Consent');
    const addBtn = screen.getByRole('button', { name: /Add Template/i });
    await user.click(addBtn);

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/consent-templates' && opts?.method === 'POST'
      );
      expect(posts.length).toBeGreaterThan(0);
      const body = JSON.parse(posts[0][1].body);
      expect(body.key).toBe('paediatric');
      expect(body.label).toBe('Paediatric Consent');
    });
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/Consent template created/i));
  });

  // 28 — Public Booking URL: Copy URL button writes to clipboard
  it('Copy URL button writes the booking URL to navigator.clipboard', async () => {
    const user = userEvent.setup();
    const writeTextMock = vi.fn(() => Promise.resolve());
    // jsdom marks navigator.clipboard as a getter-only prop; redefine the
    // property via Object.defineProperty so the test can inject a writeText
    // spy without TypeError.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    render(<Settings />);
    await waitFor(() => expect(screen.getByDisplayValue('acme')).toBeInTheDocument());

    const copyBtn = screen.getByRole('button', { name: /Copy URL/i });
    await user.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('/book/acme'));
    });
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/copied/i));
  });
});
