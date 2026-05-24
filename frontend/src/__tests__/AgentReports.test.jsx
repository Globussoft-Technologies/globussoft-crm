/**
 * AgentReports.test.jsx — vitest + RTL coverage for the Agent Reports
 * analytics page (frontend/src/pages/AgentReports.jsx, 263 LOC, NO prior
 * test in `frontend/src/__tests__/` per pre-flight inventory grep — first
 * coverage of this page).
 *
 * Tone calibrated against:
 *   - frontend/src/__tests__/AdsGPTReports.test.jsx (gold-standard cap-
 *     consumer reports admin page — stable notifyObj, fetchApiMock via
 *     ../utils/api, findByText for async data).
 *   - frontend/src/__tests__/WellnessReports.test.jsx (tab-strip reports
 *     surface with multi-endpoint fan-out).
 *
 * Scope — pins the page-surface invariants for the generic-CRM Agent
 * Reports page (per-agent sales performance: leaderboard + table + detail):
 *
 *   1. Page chrome: heading "Agent Reports" + the subtitle copy + two
 *      `type=date` filter inputs + Leaderboard heading render synchronously.
 *      The CSV + PDF export buttons render too.
 *   2. Initial-mount fetches: on mount the page fires GET on the agent-
 *      performance endpoint (`/api/reports/agent-performance?`) AND the
 *      leaderboard endpoint (`/api/reports/leaderboard?metric=revenue`).
 *      The detail endpoint is NOT pre-fetched (no selectedAgent yet).
 *   3. Loading state: literal "Loading agent data..." surfaces in the
 *      table body while the agent-performance fetch is in flight (before
 *      it resolves).
 *   4. Empty state: when the agent-performance response is `[]`, the
 *      table renders the "No agent data found" empty-row copy AND the
 *      summary StatCards row is NOT rendered (per `!loading && agents.length > 0`
 *      conditional at line 124).
 *   5. Populated table: per-row name + role + dealsWon/dealsTotal +
 *      winRate% + counts (tasks/calls/emails/contacts) render. Top-3
 *      rank emojis 🥇🥈🥉 render in the first three rows.
 *   6. Summary tiles populate: when agents.length > 0, the six StatCard
 *      tiles render their labels (Total Agents / Total Revenue / Deals
 *      Won / Total Calls / Emails Sent / Tasks Done) with aggregated
 *      values. Total Agents shows the row count; Total Revenue uses
 *      formatMoney over the .revenue reduce.
 *   7. Date-range filter refires fetches: changing the startDate input
 *      triggers a second GET on agent-performance with the new
 *      `&startDate=YYYY-MM-DD` query-string segment.
 *   8. Row click → selectedAgent state → detail fetch: clicking a table
 *      row fires GET /api/reports/agent/<id> with the date params, and
 *      renders the Agent Detail card with deals.length, tasks.length,
 *      calls.length, emails.length, contacts.length counts.
 *   9. Leaderboard metric switch: changing the metric `<select>` to
 *      "deals" refires GET /api/reports/leaderboard with `metric=deals`.
 *  10. CSV export button: clicking the "CSV" button calls global fetch
 *      with the `/api/reports/export-csv?type=agent-performance` URL and
 *      a Bearer token in headers. URL.createObjectURL is invoked on the
 *      resolved blob.
 *  11. PDF export button: clicking the "PDF" button calls global fetch
 *      with the `/api/reports/export-pdf?type=agent-performance` URL.
 *  12. Error handling: agent-performance promise rejection → page does
 *      NOT crash, loading flag still flips off (per the `.catch(() =>
 *      setLoading(false))` branch), and the empty-state copy renders.
 *
 * Backend contract pinned (per backend/routes/reports.js — the SUT's
 * three GETs):
 *   GET /api/reports/agent-performance?startDate&endDate → [
 *       { id, name, role, revenue, dealsWon, dealsTotal, winRate,
 *         tasksCompleted, callsMade, emailsSent, contactsAssigned }
 *     ]
 *   GET /api/reports/leaderboard?metric&startDate&endDate → [
 *       { id, name, value }
 *     ]
 *   GET /api/reports/agent/:id?startDate&endDate → {
 *       agent: { name | email },
 *       deals: [{ id, title, amount }],
 *       tasks: [...], calls: [...], emails: [...], contacts: [...]
 *     }
 *
 * Mocking discipline (per CLAUDE.md RTL standing rule):
 *   - fetchApi mocked at ../utils/api (the page's dependency surface).
 *   - global.fetch mocked separately — the SUT uses raw fetch (not
 *     fetchApi) inside handleExportCSV/PDF to pull a Blob.
 *   - URL.createObjectURL stubbed (jsdom doesn't ship it).
 *   - All data-dependent assertions use findBy* (CLAUDE.md tick #108
 *     standing rule).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-bearer-token',
}));

import AgentReports from '../pages/AgentReports';

// Canonical fixtures matching the routes/reports.js response shape.
const AGENTS = [
  {
    id: 1,
    name: 'Priya Sharma',
    role: 'MANAGER',
    revenue: 1250000,
    dealsWon: 12,
    dealsTotal: 18,
    winRate: 67,
    tasksCompleted: 45,
    callsMade: 88,
    emailsSent: 120,
    contactsAssigned: 30,
  },
  {
    id: 2,
    name: 'Rahul Mehta',
    role: 'USER',
    revenue: 950000,
    dealsWon: 9,
    dealsTotal: 20,
    winRate: 45,
    tasksCompleted: 38,
    callsMade: 72,
    emailsSent: 95,
    contactsAssigned: 25,
  },
  {
    id: 3,
    name: 'Anjali Singh',
    role: 'USER',
    revenue: 700000,
    dealsWon: 6,
    dealsTotal: 14,
    winRate: 43,
    tasksCompleted: 30,
    callsMade: 60,
    emailsSent: 80,
    contactsAssigned: 20,
  },
];

const LEADERBOARD_REVENUE = [
  { id: 1, name: 'Priya Sharma', value: 1250000 },
  { id: 2, name: 'Rahul Mehta', value: 950000 },
  { id: 3, name: 'Anjali Singh', value: 700000 },
];

const LEADERBOARD_DEALS = [
  { id: 1, name: 'Priya Sharma', value: 12 },
  { id: 2, name: 'Rahul Mehta', value: 9 },
];

const AGENT_DETAIL = {
  agent: { id: 1, name: 'Priya Sharma', email: 'priya@example.com' },
  deals: [
    { id: 101, title: 'Acme Corp Renewal', amount: 250000 },
    { id: 102, title: 'Globex Expansion', amount: 180000 },
  ],
  tasks: [{ id: 201 }, { id: 202 }, { id: 203 }],
  calls: [{ id: 301 }, { id: 302 }],
  emails: [{ id: 401 }],
  contacts: [{ id: 501 }, { id: 502 }, { id: 503 }, { id: 504 }],
};

// Default tenant — USD so $ symbols are deterministic for assertions
// (formatMoney reads localStorage.tenant.defaultCurrency).
function seedTenant() {
  localStorage.setItem(
    'tenant',
    JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }),
  );
}

// Build a fetchApi implementation that routes by URL prefix.
function buildFetchApi({
  agents = AGENTS,
  leaderboard = LEADERBOARD_REVENUE,
  detail = AGENT_DETAIL,
  rejectAgents = false,
} = {}) {
  return (url) => {
    if (url.startsWith('/api/reports/agent-performance')) {
      if (rejectAgents) return Promise.reject(new Error('boom'));
      return Promise.resolve(agents);
    }
    if (url.startsWith('/api/reports/leaderboard')) {
      if (url.includes('metric=deals')) return Promise.resolve(LEADERBOARD_DEALS);
      return Promise.resolve(leaderboard);
    }
    if (url.startsWith('/api/reports/agent/')) {
      return Promise.resolve(detail);
    }
    return Promise.resolve(null);
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  localStorage.clear();
  seedTenant();
  // URL.createObjectURL is not implemented in jsdom; stub it so the
  // export handlers don't throw when constructing the download link.
  global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<AgentReports /> — page chrome + initial fetches', () => {
  it('renders heading + subtitle + date filters + export buttons synchronously', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<AgentReports />);

    // Chrome is data-independent — synchronous getByRole / getByText safe.
    expect(
      screen.getByRole('heading', { name: /Agent Reports/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Performance analytics by sales agent/i),
    ).toBeInTheDocument();

    // Two date inputs (start + end).
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBe(2);

    // CSV + PDF export buttons.
    expect(screen.getByRole('button', { name: /CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PDF/i })).toBeInTheDocument();

    // Leaderboard heading renders too.
    expect(
      screen.getByRole('heading', { name: /Leaderboard/i }),
    ).toBeInTheDocument();

    // Let pending mock promises settle (avoids dangling-promise pollution).
    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/reports/agent-performance'),
      ),
    );
  });

  it('fires both /agent-performance and /leaderboard GETs on mount; NO detail fetch', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<AgentReports />);

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(
        urls.some((u) => u.startsWith('/api/reports/agent-performance')),
      ).toBe(true);
      expect(
        urls.some(
          (u) => u.startsWith('/api/reports/leaderboard') && u.includes('metric=revenue'),
        ),
      ).toBe(true);
      // No detail fetch — selectedAgent starts null.
      expect(
        urls.some((u) => u.startsWith('/api/reports/agent/')),
      ).toBe(false);
    });
  });

  it('renders "Loading agent data..." in the table while the agent-performance fetch is pending', async () => {
    // Hold the agent-performance promise open so the loading branch is observable.
    let resolveAgents;
    const pending = new Promise((res) => {
      resolveAgents = res;
    });
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/reports/agent-performance')) return pending;
      if (url.startsWith('/api/reports/leaderboard'))
        return Promise.resolve(LEADERBOARD_REVENUE);
      return Promise.resolve(null);
    });
    render(<AgentReports />);

    expect(
      await screen.findByText(/Loading agent data\.\.\./i),
    ).toBeInTheDocument();

    // Release the promise so afterEach cleanup doesn't see a leaked one.
    resolveAgents(AGENTS);
    await waitFor(() =>
      expect(screen.queryByText(/Loading agent data\.\.\./i)).toBeNull(),
    );
  });
});

describe('<AgentReports /> — empty + populated states', () => {
  it('renders "No agent data found" empty-row when /agent-performance returns []', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ agents: [] }));
    render(<AgentReports />);

    expect(
      await screen.findByText(/No agent data found/i),
    ).toBeInTheDocument();
    // Summary tiles row is gated on `agents.length > 0` — none should render.
    expect(screen.queryByText(/Total Agents/i)).toBeNull();
    expect(screen.queryByText(/Total Revenue/i)).toBeNull();
  });

  it('populated table renders per-row name + role + win-rate + counts; top-3 rank emojis', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<AgentReports />);

    // Per-row name renders. Names ALSO appear in the leaderboard recharts
    // YAxis (the same data feeds the chart) — so prefer getAllByText and
    // assert ≥1 match (CLAUDE.md "RTL: prefer getAllByText for labels that
    // appear as both filter chrome AND row badges" standing rule applies
    // to the table-vs-chart label collision too).
    await screen.findByText('Priya Sharma'); // wait for data to render
    expect(screen.getAllByText('Priya Sharma').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Rahul Mehta').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Anjali Singh').length).toBeGreaterThanOrEqual(1);
    // Role sub-label.
    expect(screen.getByText('MANAGER')).toBeInTheDocument();
    // Win-rate percentages render as "67%" / "45%" / "43%".
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(screen.getByText('43%')).toBeInTheDocument();
    // Top-3 rank emojis.
    expect(screen.getByText('🥇')).toBeInTheDocument();
    expect(screen.getByText('🥈')).toBeInTheDocument();
    expect(screen.getByText('🥉')).toBeInTheDocument();
    // Deals "12/18" composite cell (line 177: agent.dealsWon/agent.dealsTotal).
    expect(screen.getByText('12/18')).toBeInTheDocument();
  });

  it('summary StatCard tiles render labels + aggregated values when agents.length > 0', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<AgentReports />);

    // Six StatCard tile labels render. "Deals Won" and "Emails Sent" ALSO
    // appear in the leaderboard metric <select> as <option> labels, so
    // getAllByText is required for those (CLAUDE.md "filter chrome + row
    // badge dual surface" standing rule). Labels that are unique to the
    // StatCard row use getByText.
    expect(await screen.findByText('Total Agents')).toBeInTheDocument();
    expect(screen.getByText('Total Revenue')).toBeInTheDocument();
    expect(screen.getByText('Total Calls')).toBeInTheDocument();
    expect(screen.getByText('Tasks Done')).toBeInTheDocument();
    expect(screen.getAllByText('Deals Won').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Emails Sent').length).toBeGreaterThanOrEqual(1);

    // Total Agents = 3.
    const totalAgentsLabel = screen.getByText('Total Agents');
    const totalAgentsTile = totalAgentsLabel.closest('div').parentElement;
    expect(totalAgentsTile).toHaveTextContent('3');

    // Deals Won aggregate = 12 + 9 + 6 = 27. The StatCard tile is the
    // one whose label is rendered inside a <span> (per StatCard JSX); the
    // <option> form is rendered inside <option>. Filter to span-shaped match.
    const dealsLabels = screen
      .getAllByText('Deals Won')
      .filter((el) => el.tagName === 'SPAN');
    expect(dealsLabels.length).toBe(1);
    const dealsTile = dealsLabels[0].closest('div').parentElement;
    expect(dealsTile).toHaveTextContent('27');

    // Total Calls aggregate = 88 + 72 + 60 = 220 (unique label — getByText safe).
    const callsLabel = screen.getByText('Total Calls');
    const callsTile = callsLabel.closest('div').parentElement;
    expect(callsTile).toHaveTextContent('220');
  });
});

describe('<AgentReports /> — filters + interactions', () => {
  it('changing the start-date filter refires /agent-performance with &startDate', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<AgentReports />);

    // Wait for first wave of fetches to fire.
    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/reports/agent-performance'),
      ),
    );

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(buildFetchApi());

    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-01-01' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        u.startsWith('/api/reports/agent-performance'),
      );
      expect(call).toBeTruthy();
      expect(call[0]).toContain('startDate=2026-01-01');
    });
  });

  it('clicking a table row fetches /api/reports/agent/<id> and renders the detail card', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<AgentReports />);

    const priyaCell = await screen.findByText('Priya Sharma');
    const row = priyaCell.closest('tr');
    expect(row).toBeTruthy();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(buildFetchApi());

    fireEvent.click(row);

    // Detail GET fires for agent id 1.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        u.startsWith('/api/reports/agent/1'),
      );
      expect(call).toBeTruthy();
    });

    // Detail card renders. There may be MULTIPLE "Priya Sharma" texts on the
    // page (one in the row, one in the detail card heading), so use getAllByText.
    await waitFor(() => {
      const matches = screen.getAllByText('Priya Sharma');
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    // The detail card's grid shows deal/task/call/email counts.
    // deals.length=2, tasks.length=3, calls.length=2, emails.length=1, contacts.length=4.
    // Use getAllByText since the counts may collide with table values.
    expect(screen.getByText(/Deals:/i)).toBeInTheDocument();
    expect(screen.getByText(/Tasks:/i)).toBeInTheDocument();
    expect(screen.getByText(/Assigned Contacts:/i)).toBeInTheDocument();
    // "Recent Deals" sub-heading + the two deal titles render.
    expect(screen.getByText(/Recent Deals/i)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp Renewal/)).toBeInTheDocument();
    expect(screen.getByText(/Globex Expansion/)).toBeInTheDocument();
  });

  it('changing the leaderboard metric select refires /leaderboard with the new metric', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<AgentReports />);

    // Find the leaderboard <select> — only one <select> in the page.
    const selects = document.querySelectorAll('select');
    expect(selects.length).toBe(1);
    const metricSelect = selects[0];

    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/reports/leaderboard'),
      ),
    );

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(buildFetchApi());

    fireEvent.change(metricSelect, { target: { value: 'deals' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        u.startsWith('/api/reports/leaderboard'),
      );
      expect(call).toBeTruthy();
      expect(call[0]).toContain('metric=deals');
    });
  });
});

describe('<AgentReports /> — export buttons', () => {
  it('CSV export button calls global fetch with /export-csv?type=agent-performance + Bearer header', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    // Stub global fetch — the SUT uses raw fetch (not fetchApi) inside the
    // export handlers because the response is a Blob, not JSON.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['agent,revenue\n'], { type: 'text/csv' })),
    });

    render(<AgentReports />);
    const csvBtn = await screen.findByRole('button', { name: /CSV/i });
    fireEvent.click(csvBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/reports/export-csv');
      expect(url).toContain('type=agent-performance');
      expect(init.headers.Authorization).toBe('Bearer test-bearer-token');
    });
    // Blob → object-URL pipeline triggers createObjectURL.
    await waitFor(() => {
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });
  });

  it('PDF export button calls global fetch with /export-pdf?type=agent-performance', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['%PDF-stub'], { type: 'application/pdf' })),
    });

    render(<AgentReports />);
    const pdfBtn = await screen.findByRole('button', { name: /PDF/i });
    fireEvent.click(pdfBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/reports/export-pdf');
      expect(url).toContain('type=agent-performance');
    });
  });
});

describe('<AgentReports /> — error handling', () => {
  it('rejected /agent-performance does NOT crash the page; empty state + loading-off', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ rejectAgents: true }));
    // Silence the unhandled-rejection console noise from the test.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<AgentReports />);

    // After the rejection, the page settles into the empty state (agents
    // stays []; loading flips off via the .catch branch at line 46).
    expect(
      await screen.findByText(/No agent data found/i),
    ).toBeInTheDocument();
    // Loading copy is NOT lingering.
    expect(screen.queryByText(/Loading agent data\.\.\./i)).toBeNull();
    // Chrome still renders.
    expect(
      screen.getByRole('heading', { name: /Agent Reports/i, level: 1 }),
    ).toBeInTheDocument();

    errSpy.mockRestore();
  });
});
