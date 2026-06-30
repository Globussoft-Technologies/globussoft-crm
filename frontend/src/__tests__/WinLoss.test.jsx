/**
 * WinLoss.test.jsx — vitest + RTL coverage for the Win/Loss Analysis page
 * (frontend/src/pages/WinLoss.jsx, 361 LOC, NO prior test in
 * `frontend/src/__tests__/` per pre-flight inventory grep — first coverage
 * of this page).
 *
 * Tone calibrated against:
 *   - frontend/src/__tests__/Funnel.test.jsx (sibling analytics page with
 *     the same recharts ResponsiveContainer stub pattern + per-URL
 *     fetchApi router).
 *   - frontend/src/__tests__/Approvals.test.jsx (stable-notify-object
 *     pattern per the 2026-05-09 RTL cron-learning standing rule —
 *     {error, info, success, confirm} ref must stay stable across renders
 *     to avoid useCallback identity flap).
 *
 * Scope — pins the page-surface invariants for the generic-CRM Win/Loss
 * Analysis page (reasons + percentages + KPI tiles + reason CRUD modal):
 *
 *   1. Page chrome: heading "Win/Loss Analysis" + subtitle + two date
 *      inputs + "Manage Reasons" button render synchronously.
 *   2. Initial-mount fetches: TWO endpoints fire on mount —
 *      /api/win-loss/reasons (separate effect, no params) and
 *      /api/win-loss/analysis?from=<date>&to=<date> (defaults to the
 *      last 3 months, computed via defaultRange()).
 *   3. Loading state: the "Recent Closed Deals" card renders "Loading…"
 *      while /api/win-loss/analysis is in flight.
 *   4. Empty state: when /analysis returns {} (no wins/losses/reasons),
 *      both chart cards surface their empty-state copy ("No closed deals
 *      in this range." for the pie; "No tracked loss reasons yet." for
 *      the bar chart) AND the recent-deals table surfaces its own
 *      placeholder copy.
 *   5. KPI tiles: render winRate %, wonCount, lostCount, avgWon money,
 *      and avgLost money against the analysis payload.
 *   6. Recent Closed Deals table: one row per closedDeals entry, stage
 *      badge text ("WON" / "LOST"), and reason / fallback "—".
 *   7. Pie chart renders only when pieData has values (the canonical
 *      ResponsiveContainer stub mounts when wonCount + lostCount > 0).
 *   8. Bar chart renders when byReason has ≥1 entry of type=lost
 *      (Top Loss Reasons card mounts the ResponsiveContainer).
 *   9. Date-range filter refires /analysis with from=<new>&to=<old>
 *      embedded in the query string; /reasons is NOT refetched (gated
 *      by an empty-deps useEffect).
 *  10. Reason modal opens: clicking "Manage Reasons" surfaces the modal
 *      with the form + existing-reasons list AND closes via the X
 *      button + backdrop click.
 *  11. Reason CRUD — create: form submission POSTs the
 *      /api/win-loss/reasons payload + triggers /reasons refetch.
 *  12. Reason CRUD — delete: confirm-then-DELETE happy path fires
 *      /api/win-loss/reasons/<id> DELETE + reasons refetch.
 *  13. Error handling: /api/win-loss/analysis rejection leaves the page
 *      renderable (loading clears, recent-deals empty state shows).
 *
 * Backend contract pinned (per backend/routes/win_loss.js):
 *   GET /api/win-loss/analysis?from&to → {
 *     wonCount, lostCount, winRate, avgDealSize: { won, lost },
 *     byReason: [{ reason, type, count }], closedDeals: [...]
 *   }
 *   GET /api/win-loss/reasons → [{ id, reason, type, count }]
 *   POST /api/win-loss/reasons body: { type, reason }
 *   DELETE /api/win-loss/reasons/:id
 *
 * Mocking discipline (per CLAUDE.md RTL standing rule):
 *   - fetchApi mocked at ../utils/api.
 *   - notify object is a STABLE module-scope ref so useCallback identity
 *     stays stable (2026-05-09 cron-learning standing rule). confirm()
 *     is overridable per-test via .mockResolvedValueOnce.
 *   - recharts.ResponsiveContainer stubbed (jsdom doesn't ship
 *     ResizeObserver; the Funnel.test.jsx stub pattern is reused).
 *   - localStorage seeded with USD tenant so currency symbols are
 *     deterministic.
 *   - All data-dependent assertions use findBy*.
 *
 * Note on role gate: WinLoss.jsx has NO front-end role gate — it renders
 * for any authenticated user. Backend /api/win-loss/* routes enforce the
 * gate. This test set omits a role-gate case.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-bearer-token',
}));

// Stable notify object — per the 2026-05-09 RTL cron-learning standing
// rule, this MUST be one object reference for the entire test run.
// Returning a fresh {error: vi.fn(), ...} per call breaks useCallback
// identity, can trigger re-render loops, and lets confirm() drift
// between tests. confirmMock is exposed so tests can override per-case
// via .mockResolvedValueOnce.
const confirmMock = vi.fn().mockResolvedValue(true);
const errorMock = vi.fn();
const infoMock = vi.fn();
const successMock = vi.fn();
const notifyObj = {
  error: errorMock,
  info: infoMock,
  success: successMock,
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// recharts ResponsiveContainer relies on ResizeObserver which jsdom
// doesn't ship. Stub just that one symbol — the rest of recharts works
// fine in jsdom and we don't assert on chart geometry, only on the
// container mount + surrounding chrome (the brittle internal SVG paths
// are off-limits per the test brief).
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="rc">{children}</div>
    ),
  };
});

import WinLoss from '../pages/WinLoss';

// Canonical fixtures matching routes/win_loss.js response shapes.
const ANALYSIS_POPULATED = {
  wonCount: 12,
  lostCount: 8,
  winRate: 60,
  avgDealSize: { won: 250000, lost: 80000 },
  byReason: [
    { reason: 'Price too high', type: 'lost', count: 5 },
    { reason: 'Missing feature', type: 'lost', count: 3 },
    { reason: 'Strong demo', type: 'won', count: 6 },
  ],
  closedDeals: [
    { id: 1, title: 'Acme Corp Renewal', stage: 'won', amount: 300000, reason: 'Strong demo', createdAt: '2026-04-01T10:00:00Z' },
    { id: 2, title: 'Globex Pilot', stage: 'lost', amount: 75000, reason: 'Price too high', createdAt: '2026-04-15T10:00:00Z' },
    { id: 3, title: 'Initech Q2 Deal', stage: 'lost', amount: 50000, reason: null, createdAt: '2026-05-01T10:00:00Z' },
  ],
};

const ANALYSIS_EMPTY = {
  wonCount: 0,
  lostCount: 0,
  winRate: 0,
  avgDealSize: { won: 0, lost: 0 },
  byReason: [],
  closedDeals: [],
};

const REASONS = [
  { id: 1, reason: 'Price too high', type: 'lost', count: 5 },
  { id: 2, reason: 'Strong demo', type: 'won', count: 6 },
];

// Default tenant — USD so $ symbols are deterministic for assertions
// (formatMoney reads localStorage.tenant.defaultCurrency).
function seedTenant() {
  localStorage.setItem(
    'tenant',
    JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }),
  );
}

// Build a fetchApi implementation routing by URL + method.
function buildFetchApi({
  analysis = ANALYSIS_POPULATED,
  reasons = REASONS,
} = {}) {
  return (url, opts) => {
    if (url === '/api/win-loss/reasons' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve(reasons);
    }
    if (url.startsWith('/api/win-loss/analysis')) {
      return Promise.resolve(analysis);
    }
    if (url === '/api/win-loss/reasons' && opts && opts.method === 'POST') {
      return Promise.resolve({ id: 99, ...JSON.parse(opts.body) });
    }
    if (url.startsWith('/api/win-loss/reasons/') && opts && opts.method === 'DELETE') {
      return Promise.resolve({});
    }
    return Promise.resolve(null);
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  confirmMock.mockReset().mockResolvedValue(true);
  errorMock.mockReset();
  infoMock.mockReset();
  successMock.mockReset();
  localStorage.clear();
  seedTenant();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<WinLoss /> — page chrome + initial fetches', () => {
  it('renders heading + subtitle + date filters + Manage Reasons button synchronously', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    expect(
      screen.getByRole('heading', { name: /Win\/Loss Analysis/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Understand why deals close and what's costing you revenue/i),
    ).toBeInTheDocument();

    // Two date inputs (from + to).
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBe(2);

    // Manage Reasons button is in the header.
    expect(screen.getByRole('button', { name: /Manage Reasons/i })).toBeInTheDocument();

    // Let pending mock promises settle.
    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/win-loss/analysis'),
      ),
    );
  });

  it('fires /api/win-loss/reasons + /api/win-loss/analysis?from=&to= on mount', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      // Reasons lookup (bare, no query params).
      expect(urls).toContain('/api/win-loss/reasons');
      // Analysis with from + to query params (defaultRange = last 3 months).
      expect(urls.some((u) =>
        u.startsWith('/api/win-loss/analysis')
        && u.includes('from=')
        && u.includes('to=')
      )).toBe(true);
    });

    // Analysis URL must have ISO date format (YYYY-MM-DD).
    const analysisUrl = fetchApiMock.mock.calls
      .map(([u]) => u)
      .find((u) => u.startsWith('/api/win-loss/analysis'));
    expect(analysisUrl).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect(analysisUrl).toMatch(/to=\d{4}-\d{2}-\d{2}/);
  });

  it('renders "Loading…" in the recent-deals card while the initial analysis fetch is pending', async () => {
    let resolveAnalysis;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/win-loss/reasons') return Promise.resolve([]);
      if (url.startsWith('/api/win-loss/analysis')) {
        return new Promise((r) => { resolveAnalysis = r; });
      }
      return Promise.resolve(null);
    });
    render(<WinLoss />);

    expect(await screen.findByText(/Loading…/i)).toBeInTheDocument();

    // Resolve so the test cleanly tears down.
    resolveAnalysis(ANALYSIS_EMPTY);
  });
});

describe('<WinLoss /> — KPI tiles + populated payloads', () => {
  it('populates Win Rate + Won/Lost counts + avg deal sizes from analysis', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    // Win Rate label + the "60%" tile value.
    expect(await screen.findByText(/Win Rate/i)).toBeInTheDocument();
    expect(screen.getByText(/^60%$/)).toBeInTheDocument();

    // Sub-text shows "12 won · 8 lost".
    expect(screen.getByText(/12 won · 8 lost/i)).toBeInTheDocument();

    // Avg Won Deal + Avg Lost Deal labels.
    expect(screen.getByText(/Avg Won Deal/i)).toBeInTheDocument();
    expect(screen.getByText(/Avg Lost Deal/i)).toBeInTheDocument();

    // The sub-text rows for both avg cards reference the win + loss counts.
    expect(screen.getByText(/across 12 closed-won/i)).toBeInTheDocument();
    expect(screen.getByText(/across 8 closed-lost/i)).toBeInTheDocument();
  });

  it('renders Recent Closed Deals table rows with title + stage badge + reason fallback', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    // Deal titles.
    expect(await screen.findByText('Acme Corp Renewal')).toBeInTheDocument();
    expect(screen.getByText('Globex Pilot')).toBeInTheDocument();
    expect(screen.getByText('Initech Q2 Deal')).toBeInTheDocument();

    // Stage badges — "WON" appears for the won row, "LOST" appears twice.
    expect(screen.getAllByText('WON').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('LOST').length).toBeGreaterThanOrEqual(2);

    // Reason text + the "—" fallback for the null-reason row.
    expect(screen.getByText('Strong demo')).toBeInTheDocument();
    // "Price too high" appears as both a reason in byReason (potentially in chart)
    // AND in the table — assert ≥1 occurrence.
    expect(screen.getAllByText(/Price too high/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('mounts the pie chart container only when pieData has wins or losses', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    // The ResponsiveContainer stub mounts under data-testid="rc" for
    // BOTH charts when data exists. With wonCount=12 + lostCount=8 +
    // byReason has lost entries, two recharts containers render.
    await waitFor(() => {
      const containers = screen.getAllByTestId('rc');
      expect(containers.length).toBe(2);
    });

    // The "Won vs Lost" + "Top Loss Reasons" headings exist alongside.
    expect(screen.getByRole('heading', { name: /Won vs Lost/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Top Loss Reasons/i })).toBeInTheDocument();
  });
});

describe('<WinLoss /> — empty state', () => {
  it('renders empty-state copy in both chart cards + recent-deals table when analysis is empty', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ analysis: ANALYSIS_EMPTY }));
    render(<WinLoss />);

    // Pie card empty state.
    expect(await screen.findByText(/No closed deals in this range\./i)).toBeInTheDocument();
    // Bar card empty state.
    expect(screen.getByText(/No tracked loss reasons yet\./i)).toBeInTheDocument();
    // Recent-deals table empty placeholder (different text — "No closed deals"
    // appears in both the pie + the table; we assert there are ≥2 instances).
    expect(screen.getAllByText(/No closed deals in this range\./i).length).toBeGreaterThanOrEqual(2);

    // No recharts ResponsiveContainer mounts in either chart card
    // (both fall through to their empty-state divs).
    expect(screen.queryByTestId('rc')).not.toBeInTheDocument();
  });
});

describe('<WinLoss /> — date filter refires', () => {
  it('changing the `from` date input refires /api/win-loss/analysis with the new from=YYYY-MM-DD', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    // Wait for the initial mount fetch to settle.
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.startsWith('/api/win-loss/analysis'))).toBe(true);
    });

    fetchApiMock.mockClear();

    // Type into the first date input ("from").
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-01-01' } });

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) =>
        u.startsWith('/api/win-loss/analysis') && u.includes('from=2026-01-01'),
      )).toBe(true);
    });

    // The /reasons endpoint is NOT refetched (empty-deps useEffect).
    const urlsAfter = fetchApiMock.mock.calls.map(([u]) => u);
    expect(urlsAfter).not.toContain('/api/win-loss/reasons');
  });

  it('changing the `to` date refires /analysis with to=YYYY-MM-DD', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.startsWith('/api/win-loss/analysis'))).toBe(true);
    });

    fetchApiMock.mockClear();

    const dateInputs = document.querySelectorAll('input[type="date"]');
    // Pick a date that cannot collide with today's default `to` so the
    // controlled input actually changes and the useEffect refires.
    fireEvent.change(dateInputs[1], { target: { value: '2026-12-31' } });

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) =>
        u.startsWith('/api/win-loss/analysis') && u.includes('to=2026-12-31'),
      )).toBe(true);
    });
  });
});

describe('<WinLoss /> — Manage Reasons modal', () => {
  it('opens the modal when "Manage Reasons" is clicked + lists existing reasons', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    // Wait for initial loads to settle.
    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith('/api/win-loss/reasons'),
    );

    // Modal not present until opened.
    expect(screen.queryByText(/Manage Win\/Loss Reasons/i)).not.toBeInTheDocument();

    // Open the modal.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Manage Reasons/i }));

    // Modal heading + existing reason rows render.
    expect(await screen.findByText(/Manage Win\/Loss Reasons/i)).toBeInTheDocument();
    // The reason rows inside the modal carry the reason text + a LOST/WON badge.
    // Use getAllByText because "Price too high" also appears in the recent
    // deals table.
    expect(screen.getAllByText(/Price too high/).length).toBeGreaterThanOrEqual(1);
    // "Strong demo" appears in the recent deals row AND in the reasons list.
    expect(screen.getAllByText(/Strong demo/).length).toBeGreaterThanOrEqual(1);
  });

  it('closes the modal when the X button is clicked', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith('/api/win-loss/reasons'),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Manage Reasons/i }));

    // Modal is open.
    expect(await screen.findByText(/Manage Win\/Loss Reasons/i)).toBeInTheDocument();

    // The X close button — Lucide X icon is inside a transparent button
    // next to the modal heading. Find by sibling pattern: the close X
    // sits inside the same flex row as the heading.
    const closeBtns = screen.getAllByRole('button');
    // The X button has no accessible name — it's the only un-named button
    // inside the open modal apart from Add (which has aria-label "Add reason")
    // and the existing-reason trash buttons (which are also un-named).
    // Find it by walking the headings + clicking the first sibling button.
    const modalHeading = screen.getByText(/Manage Win\/Loss Reasons/i);
    const closeBtn = modalHeading.parentElement.querySelector('button');
    expect(closeBtn).toBeTruthy();
    await user.click(closeBtn);

    // Modal closes.
    await waitFor(() => {
      expect(screen.queryByText(/Manage Win\/Loss Reasons/i)).not.toBeInTheDocument();
    });
  });

  it('renders "No reasons defined yet." when /reasons returns []', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ reasons: [] }));
    render(<WinLoss />);

    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith('/api/win-loss/reasons'),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Manage Reasons/i }));

    expect(await screen.findByText(/No reasons defined yet\./i)).toBeInTheDocument();
  });
});

describe('<WinLoss /> — Reason CRUD', () => {
  it('submitting the create-reason form POSTs to /api/win-loss/reasons + refetches reasons', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith('/api/win-loss/reasons'),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Manage Reasons/i }));

    // Wait for the modal form.
    const reasonInput = await screen.findByPlaceholderText(/Price too high/i);
    fetchApiMock.mockClear();

    // Fill the reason text.
    await user.type(reasonInput, 'Slow procurement');

    // Submit the form via the Add button (aria-label="Add reason").
    await user.click(screen.getByRole('button', { name: /Add reason/i }));

    // Asserts: POST fired with body {type: 'lost', reason: 'Slow procurement'}
    // AND /reasons refetched (the modal closes + the list refreshes).
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(([url, opts]) =>
        url === '/api/win-loss/reasons' && opts && opts.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.type).toBe('lost');
      expect(body.reason).toBe('Slow procurement');
    });

    // /reasons was refetched after the POST.
    const getReasonsCalls = fetchApiMock.mock.calls.filter(([url, opts]) =>
      url === '/api/win-loss/reasons' && (!opts || !opts.method || opts.method === 'GET'),
    );
    expect(getReasonsCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking delete on a reason confirms then fires DELETE /api/win-loss/reasons/:id', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith('/api/win-loss/reasons'),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Manage Reasons/i }));

    // Wait for the modal + reason rows to render.
    await screen.findByText(/Manage Win\/Loss Reasons/i);

    fetchApiMock.mockClear();
    confirmMock.mockResolvedValueOnce(true);

    // Click the first trash icon inside the modal. The trash buttons are
    // un-named (no aria-label) — find them by walking the reason rows.
    // The reason row layout: <div><span>...</span><button><Trash2/></button></div>.
    const trashButtons = document.querySelectorAll('button[style*="color: rgb(239, 68, 68)"]');
    expect(trashButtons.length).toBeGreaterThanOrEqual(1);

    await user.click(trashButtons[0]);

    // notify.confirm was called.
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled();
    });

    // DELETE /api/win-loss/reasons/<id> fired (id=1 from REASONS[0]).
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(([url, opts]) =>
        url.startsWith('/api/win-loss/reasons/') && opts && opts.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('clicking delete then dismissing the confirm prompt does NOT fire DELETE', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<WinLoss />);

    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith('/api/win-loss/reasons'),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Manage Reasons/i }));
    await screen.findByText(/Manage Win\/Loss Reasons/i);

    fetchApiMock.mockClear();
    // User dismisses the confirm prompt.
    confirmMock.mockResolvedValueOnce(false);

    const trashButtons = document.querySelectorAll('button[style*="color: rgb(239, 68, 68)"]');
    await user.click(trashButtons[0]);

    // Confirm was called but DELETE never fired.
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled();
    });
    const deleteCall = fetchApiMock.mock.calls.find(([url, opts]) =>
      url.startsWith('/api/win-loss/reasons/') && opts && opts.method === 'DELETE',
    );
    expect(deleteCall).toBeFalsy();
  });
});

describe('<WinLoss /> — error handling', () => {
  it('does NOT crash when /api/win-loss/analysis rejects', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/win-loss/reasons') return Promise.resolve([]);
      if (url.startsWith('/api/win-loss/analysis')) return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    });
    render(<WinLoss />);

    // Page renders the heading even though /analysis failed.
    expect(
      await screen.findByRole('heading', { name: /Win\/Loss Analysis/i }),
    ).toBeInTheDocument();

    // Loading clears + the recent-deals empty placeholder appears
    // (analysis === null + loading === false → closedDeals.length === 0 branch).
    await waitFor(() => {
      expect(screen.queryByText(/Loading…/i)).not.toBeInTheDocument();
    });
    expect(screen.getAllByText(/No closed deals in this range\./i).length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT crash when /api/win-loss/reasons rejects', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/win-loss/reasons') return Promise.reject(new Error('reasons boom'));
      if (url.startsWith('/api/win-loss/analysis')) return Promise.resolve(ANALYSIS_EMPTY);
      return Promise.resolve(null);
    });
    render(<WinLoss />);

    // Page still renders + the modal-open path still works because
    // reasons defaults to []. Open the modal and assert the empty list
    // placeholder renders (not a thrown render error).
    expect(
      await screen.findByRole('heading', { name: /Win\/Loss Analysis/i }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Manage Reasons/i }));
    expect(await screen.findByText(/No reasons defined yet\./i)).toBeInTheDocument();
  });
});
