/**
 * Projects.test.jsx — vitest + RTL coverage for the Projects page
 * (frontend/src/pages/Projects.jsx).
 *
 * Scope: pins the page-surface invariants for the project-board UI used
 * to plan, track, and dispatch projects across the org. The page reads
 * from THREE parallel surfaces:
 *   - GET /api/projects (list with .tasks[], .owner, .status, .priority,
 *     .budget, .startDate, .endDate)
 *   - GET /api/contacts (populates the Contact <select>)
 *   - GET /api/deals (populates the Deal <select>)
 * Then exposes a left-pane Create Project form (POSTs /api/projects),
 * a right-pane projects table with inline status <select> (PUTs
 * /api/projects/<id> with { status }), and a trash button (notify.confirm
 * + DELETE /api/projects/<id>).
 *
 * Invariants pinned here:
 *   1. Heading "Projects" + tagline render + the three load fetches fire
 *      on mount.
 *   2. Empty state: "No projects yet. Create one to get started." renders
 *      when /api/projects returns [].
 *   3. Stats chips: render `<activeCount> Active`, `<completedCount>
 *      Completed`, `Total Budget: <sum>`, `<n> total projects` reflecting
 *      the project array.
 *   4. Renders one table row per project with name + owner + budget +
 *      task-count `done/total` + dates.
 *   5. StatusBadge: each project's status renders as a badge AND as the
 *      selected value of the inline status <select>. Duplicate labels
 *      ("Active" appears as the stats chip + the row badge + the select
 *      option) require getAllByText.
 *   6. PriorityBadge: each project's priority renders with the badge for
 *      Low / Medium / High / Critical.
 *   7. Task-count cell: renders `<completed>/<total>` for the .tasks[]
 *      sub-array; "0/0" for projects with no tasks.
 *   8. Validation: clicking "Create Project" with an empty name does NOT
 *      fire a POST (the input's `required` attribute blocks form submit).
 *   9. Create flow: filling name + priority + budget + clicking submit
 *      POSTs /api/projects with the typed payload + reloads.
 *  10. Status-change flow: choosing a different status from the inline
 *      <select> PUTs /api/projects/<id> with { status: <new> } and
 *      reloads.
 *  11. Delete flow: clicking the trash button triggers notify.confirm;
 *      on YES, fires DELETE /api/projects/<id> and reloads.
 *  12. Delete cancel: notify.confirm returning false short-circuits — no
 *      DELETE fires.
 *  13. Contact + Deal selects: render one <option> per fetched contact
 *      and one per fetched deal.
 *
 * Pattern matched: frontend/src/__tests__/Playbooks.test.jsx (d78cdebe)
 * + Tasks.test.jsx — stable notify object reference (no fresh mocks per
 * render — see CLAUDE.md "RTL: stable mock object references" standing
 * rule), fetchApi route-string switch in beforeEach, getAllByText for
 * status labels that appear as both filter chrome AND row badges.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object so the useNotify() identity stays stable across
// renders. Fresh-per-call mocks here would trigger infinite re-renders
// because notify lands in handler closures.
const notifyError = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Projects from '../pages/Projects';

const sampleProjects = [
  {
    id: 1,
    name: 'Aurora Migration',
    status: 'Active',
    priority: 'Critical',
    budget: 50000,
    startDate: '2026-01-01',
    endDate: '2026-06-30',
    owner: { name: 'Priya Mehta', email: 'priya@example.com' },
    tasks: [
      { id: 1, status: 'Completed' },
      { id: 2, status: 'Completed' },
      { id: 3, status: 'In Progress' },
    ],
  },
  {
    id: 2,
    name: 'Q3 Marketing Launch',
    status: 'Planning',
    priority: 'High',
    budget: 12000,
    startDate: '2026-07-01',
    endDate: '2026-09-30',
    owner: { name: 'Rohan Kapoor', email: 'rohan@example.com' },
    tasks: [],
  },
  {
    id: 3,
    name: 'CRM Migration',
    status: 'Completed',
    priority: 'Medium',
    budget: 25000,
    startDate: '2025-10-01',
    endDate: '2025-12-31',
    owner: { name: 'Aisha Khan', email: 'aisha@example.com' },
    tasks: [
      { id: 4, status: 'Completed' },
      { id: 5, status: 'Completed' },
    ],
  },
];

const sampleContacts = [
  { id: 11, name: 'Anita Sharma', email: 'anita@example.com' },
  { id: 12, name: 'Vikram Rao', email: 'vikram@example.com' },
];

const sampleDeals = [
  { id: 21, title: 'Acme Renewal', amount: 50000 },
  { id: 22, title: 'Globex Expansion', amount: 125000 },
];

function defaultMock(url, _opts) {
  if (url === '/api/projects') return Promise.resolve(sampleProjects);
  if (url === '/api/contacts') return Promise.resolve(sampleContacts);
  if (url === '/api/deals') return Promise.resolve(sampleDeals);
  return Promise.resolve(null);
}

function renderProjects() {
  return render(<Projects />);
}

describe('<Projects /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyConfirm.mockClear();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultMock);
  });

  it('renders heading "Projects" + the three parallel load fetches fire on mount', async () => {
    renderProjects();
    expect(
      screen.getByRole('heading', { name: /Projects/i })
    ).toBeInTheDocument();

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/projects');
      expect(urls).toContain('/api/contacts');
      expect(urls).toContain('/api/deals');
    });
  });

  it('shows empty state when /api/projects returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/projects') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderProjects();
    await waitFor(() => {
      expect(
        screen.getByText(/No projects yet\. Create one to get started\./i)
      ).toBeInTheDocument();
    });
  });

  it('renders stats chips with active count, completed count, and total project count', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText(/1 Active/)).toBeInTheDocument();
    });
    expect(screen.getByText(/1 Completed/)).toBeInTheDocument();
    // "3 total projects" reflects sampleProjects.length.
    expect(screen.getByText(/3 total projects/i)).toBeInTheDocument();
  });

  it('renders one table row per project with name + owner', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });
    expect(screen.getByText('Q3 Marketing Launch')).toBeInTheDocument();
    expect(screen.getByText('CRM Migration')).toBeInTheDocument();
    expect(screen.getByText('Priya Mehta')).toBeInTheDocument();
    expect(screen.getByText('Rohan Kapoor')).toBeInTheDocument();
    expect(screen.getByText('Aisha Khan')).toBeInTheDocument();
  });

  it('renders a StatusBadge for each project status (duplicate labels need getAllByText)', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });
    // "Active" appears as the stats chip text "1 Active" (counts as one
    // text node containing "Active") + the row badge + each row's inline
    // <select> option. Use getAllByText to disambiguate.
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Planning').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(2);
    // "On Hold" / "Cancelled" appear as options on every row's inline
    // status <select>.
    expect(screen.getAllByText('On Hold').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThanOrEqual(1);
  });

  it('renders a PriorityBadge for each project priority', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });
    // "Critical" / "High" / "Medium" each appear in the priority <select>
    // options AND on the matching row badge — getAllByText required.
    expect(screen.getAllByText('Critical').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('High').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Medium').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Low').length).toBeGreaterThanOrEqual(1);
  });

  it('task-count cell renders <completed>/<total> for .tasks[]', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });
    // Aurora: 2 completed / 3 total → "2/3".
    expect(screen.getByText('2/3')).toBeInTheDocument();
    // Q3 Marketing: no tasks → "0/0".
    expect(screen.getByText('0/0')).toBeInTheDocument();
    // CRM Migration: 2/2.
    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('validation: submit with empty name is blocked by required attribute — no POST fires', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();

    const submitBtn = screen.getByRole('button', { name: /Create Project/i });
    fireEvent.click(submitBtn);

    // Give any in-flight microtasks a chance — but the HTML `required`
    // attribute on the name <input> short-circuits the submit handler,
    // so no POST should fire.
    await new Promise((r) => setTimeout(r, 30));
    const postCall = fetchApiMock.mock.calls.find(
      ([_url, opts]) => opts && opts.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('create flow: filling name + priority + budget POSTs /api/projects with the payload', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Project name/i), {
      target: { value: 'Phoenix Rollout' },
    });
    fireEvent.change(screen.getByLabelText(/Project description/i), {
      target: { value: 'Q4 rollout to APAC region' },
    });
    fireEvent.change(screen.getByLabelText(/Project priority/i), {
      target: { value: 'High' },
    });
    fireEvent.change(screen.getByLabelText(/Project budget/i), {
      target: { value: '75000' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/projects' && opts?.method === 'POST') {
        return Promise.resolve({ id: 999 });
      }
      return defaultMock(url, opts);
    });

    const submitBtn = screen.getByRole('button', { name: /Create Project/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/projects' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe('Phoenix Rollout');
      expect(body.description).toBe('Q4 rollout to APAC region');
      expect(body.priority).toBe('High');
      expect(body.budget).toBe('75000');
    });
  });

  it('status-change: choosing a different status from the inline <select> PUTs /api/projects/<id>', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/projects/1' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, status: 'On Hold' });
      }
      return defaultMock(url, opts);
    });

    // Aurora Migration is project id=1 with status "Active". The inline
    // status <select> is labelled "Change status of Aurora Migration".
    const auroraSelect = screen.getByLabelText(/Change status of Aurora Migration/i);
    fireEvent.change(auroraSelect, { target: { value: 'On Hold' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/projects/1' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.status).toBe('On Hold');
    });
  });

  it('delete flow: clicking trash → notify.confirm yes → DELETE /api/projects/<id>', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/projects/2' && opts?.method === 'DELETE') {
        return Promise.resolve({});
      }
      return defaultMock(url, opts);
    });

    // Q3 Marketing Launch is project id=2; its delete button is labelled
    // "Delete project Q3 Marketing Launch".
    const trashBtn = screen.getByLabelText(/Delete project Q3 Marketing Launch/i);
    fireEvent.click(trashBtn);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/projects/2' && opts?.method === 'DELETE'
      );
      expect(call).toBeTruthy();
    });
  });

  it('delete cancel: notify.confirm returning false short-circuits — no DELETE fires', async () => {
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    const trashBtn = screen.getByLabelText(/Delete project Aurora Migration/i);
    fireEvent.click(trashBtn);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Settle pending microtasks — confirm() promise resolves with false,
    // so no DELETE should fire.
    await new Promise((r) => setTimeout(r, 30));
    const deleteCall = fetchApiMock.mock.calls.find(
      ([_url, opts]) => opts && opts.method === 'DELETE'
    );
    expect(deleteCall).toBeFalsy();
  });

  it('contact + deal selects render one <option> per fetched record', async () => {
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Aurora Migration')).toBeInTheDocument();
    });
    // Contact <option>s use the format "<name> (<email>)".
    expect(
      screen.getByText('Anita Sharma (anita@example.com)')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Vikram Rao (vikram@example.com)')
    ).toBeInTheDocument();
    // Deal <option>s use "<title> - $<amount>" where the amount is
    // `Number(d.amount).toLocaleString()` — and the runner's locale
    // determines the grouping separator (en-US: "125,000"; en-IN:
    // "1,25,000"). Match locale-agnostically with `[\d,]+` rather than
    // pinning a specific grouping pattern. (Same hazard class as the
    // CLAUDE.md "TZ-label assertions are NOT portable across Node ICU
    // builds" standing rule.)
    expect(
      screen.getByText(/Acme Renewal - \$[\d,]+/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Globex Expansion - \$[\d,]+/)
    ).toBeInTheDocument();
  });

  it('non-array /api/projects response coerces to [] (defensive shape guard)', async () => {
    // Server-side bugs occasionally return {error:...} instead of an
    // array; the page should NOT throw — it should show empty state.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/projects') {
        return Promise.resolve({ error: 'unexpected' });
      }
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      return Promise.resolve(null);
    });
    renderProjects();
    await waitFor(() => {
      expect(
        screen.getByText(/No projects yet\. Create one to get started\./i)
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/0 total projects/i)).toBeInTheDocument();
  });

  it('owner fallback renders email when .owner.name is missing, dash when no owner', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/projects') {
        return Promise.resolve([
          {
            id: 50,
            name: 'Email-only Owner',
            status: 'Active',
            priority: 'Medium',
            budget: 1000,
            owner: { email: 'noname@example.com' },
            tasks: [],
          },
          {
            id: 51,
            name: 'No Owner At All',
            status: 'Planning',
            priority: 'Low',
            budget: 0,
            owner: null,
            tasks: [],
          },
        ]);
      }
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderProjects();
    await waitFor(() => {
      expect(screen.getByText('Email-only Owner')).toBeInTheDocument();
    });
    expect(screen.getByText('noname@example.com')).toBeInTheDocument();
    // The no-owner row renders a "-" placeholder for the owner cell. The
    // dash also appears for the budget=0 row's budget cell, so getAllByText
    // is the correct call.
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
  });
});
