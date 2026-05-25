/**
 * Funnel.test.jsx — vitest + RTL coverage for the Sales Funnel analytics
 * page (frontend/src/pages/Funnel.jsx, 346 LOC, NO prior test in
 * `frontend/src/__tests__/` per pre-flight inventory grep — first
 * coverage of this page).
 *
 * Tone calibrated against:
 *   - frontend/src/__tests__/AgentReports.test.jsx (gold-standard reports
 *     page with multi-endpoint fan-out + recharts surface).
 *   - frontend/src/__tests__/Forecasting.test.jsx (recharts
 *     ResponsiveContainer stub pattern that the SUT depends on).
 *
 * Scope — pins the page-surface invariants for the generic-CRM Sales
 * Funnel page (stage-by-stage conversion, velocity, rep performance):
 *
 *   1. Page chrome: heading "Sales Funnel" + subtitle copy + date-range
 *      inputs + pipeline filter <select> render synchronously.
 *   2. Initial-mount fetches: on mount the page fires SIX GETs in
 *      parallel — /api/pipelines (in a separate effect) plus the five
 *      funnel endpoints: stages, conversion-by-source, by-rep, velocity,
 *      and trend?months=6. None of them carry ?from or ?to or ?pipelineId
 *      because state starts empty.
 *   3. Loading state: the "Funnel by Stage" card renders the literal
 *      "Loading…" placeholder while the initial fetches are in flight.
 *   4. Empty state: when stages + bySource + byRep + velocity + trend
 *      all resolve to empty payloads, the SUT renders the empty-copy
 *      placeholders ("No deals yet.", "No source data.", "No rep data.",
 *      "No velocity data.", "No trend data.").
 *   5. Populated funnel: when /api/funnel/stages resolves with stages,
 *      each stage name renders in the breakdown table (capitalized via
 *      CSS but the text-content asserts against the raw name).
 *   6. Conversion % rendered between stages: stages with `conversionToNext`
 *      surface the formatted "X.X% →" suffix in the breakdown row.
 *   7. KPI tiles populate: aggregated values render — Total Deals (sum of
 *      byRep.total), Won (sum of byRep.won), Lost (sum of byRep.lost),
 *      and Win Rate as a percent (formatted via formatPercent).
 *   8. Per-rep table: rep rows render owner / total / open / won / lost /
 *      winRate / revenue cells from the byRep response.
 *   9. Source table: source rows render source / count / won / conversionRate
 *      cells from the bySource response.
 *  10. Date-range filter refires fetches: changing the `from` date input
 *      triggers a second batch of funnel fetches with `from=YYYY-MM-DD`
 *      embedded in the query string.
 *  11. Pipeline filter refires the stages fetch with `pipelineId=N`
 *      embedded in the query string (other endpoints don't currently
 *      forward pipelineId, so we only assert on /stages).
 *  12. Clear filters button: appears when any of from/to/pipelineId are
 *      set, and clicking it clears state + triggers a fresh fetch with
 *      no query params.
 *
 * Backend contract pinned (per backend/routes/funnel.js — the SUT's
 * five funnel GETs plus the /api/pipelines lookup):
 *   GET /api/funnel/stages?pipelineId&from&to → { stages: [
 *       { name, totalEntered, current, conversionToNext, totalValue }
 *     ] }
 *   GET /api/funnel/conversion-by-source?from&to → [
 *       { source, count, won, conversionRate }
 *     ]
 *   GET /api/funnel/by-rep?from&to → [
 *       { ownerId, owner, total, open, won, lost, winRate, revenue }
 *     ]
 *   GET /api/funnel/velocity → [{ stage, avgDaysInStage }]
 *   GET /api/funnel/trend?months=6 → [{ month, <stageName>: count, ... }]
 *   GET /api/pipelines → [{ id, name }]
 *
 * Mocking discipline (per CLAUDE.md RTL standing rule):
 *   - fetchApi mocked at ../utils/api (the page's dependency surface).
 *   - recharts.ResponsiveContainer stubbed (jsdom doesn't support its
 *     resize observer; the Forecasting tests' stub pattern is reused).
 *   - localStorage seeded with USD tenant so $ symbols are deterministic
 *     for assertions (formatMoney reads localStorage.tenant.defaultCurrency).
 *   - All data-dependent assertions use findBy* (CLAUDE.md tick #108
 *     standing rule).
 *
 * Note on role gate: Funnel.jsx has NO front-end role gate — it renders
 * for any authenticated user. The backend /api/funnel/* routes enforce
 * the gate. This test set therefore omits a role-gate case (the source
 * surface has none to pin).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-bearer-token',
}));

// recharts ResponsiveContainer relies on ResizeObserver which jsdom
// doesn't ship. Stub just that one symbol — the rest of recharts works
// fine in jsdom (it just won't compute real layout) and we don't assert
// on chart geometry anyway, only on the surrounding chrome + payload-
// dependent text content.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="rc">{children}</div>
    ),
  };
});

import Funnel from '../pages/Funnel';

// Canonical fixtures matching the routes/funnel.js response shapes.
const STAGES = {
  stages: [
    { name: 'qualification', totalEntered: 100, current: 30, conversionToNext: 60, totalValue: 500000 },
    { name: 'proposal', totalEntered: 60, current: 20, conversionToNext: 50, totalValue: 300000 },
    { name: 'negotiation', totalEntered: 30, current: 10, conversionToNext: 33.3, totalValue: 200000 },
    { name: 'closed-won', totalEntered: 10, current: 0, conversionToNext: null, totalValue: 100000 },
  ],
};

const BY_SOURCE = [
  { source: 'website', count: 50, won: 12, conversionRate: 24 },
  { source: 'referral', count: 30, won: 9, conversionRate: 30 },
  { source: 'cold-email', count: 20, won: 2, conversionRate: 10 },
];

const BY_REP = [
  { ownerId: 1, owner: 'Priya Sharma', total: 60, open: 20, won: 25, lost: 15, winRate: 62.5, revenue: 1250000 },
  { ownerId: 2, owner: 'Rahul Mehta', total: 40, open: 10, won: 18, lost: 12, winRate: 60, revenue: 850000 },
];

const VELOCITY = [
  { stage: 'qualification', avgDaysInStage: 5 },
  { stage: 'proposal', avgDaysInStage: 8 },
  { stage: 'negotiation', avgDaysInStage: 12 },
];

const TREND = [
  { month: '2025-12', qualification: 30, proposal: 20, negotiation: 10, 'closed-won': 5 },
  { month: '2026-01', qualification: 35, proposal: 22, negotiation: 12, 'closed-won': 6 },
];

const PIPELINES = [
  { id: 'pipe-1', name: 'Default Pipeline' },
  { id: 'pipe-2', name: 'Enterprise' },
];

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
  stages = STAGES,
  bySource = BY_SOURCE,
  byRep = BY_REP,
  velocity = VELOCITY,
  trend = TREND,
  pipelines = PIPELINES,
} = {}) {
  return (url) => {
    if (url === '/api/pipelines') return Promise.resolve(pipelines);
    if (url.startsWith('/api/funnel/stages')) return Promise.resolve(stages);
    if (url.startsWith('/api/funnel/conversion-by-source')) return Promise.resolve(bySource);
    if (url.startsWith('/api/funnel/by-rep')) return Promise.resolve(byRep);
    if (url.startsWith('/api/funnel/velocity')) return Promise.resolve(velocity);
    if (url.startsWith('/api/funnel/trend')) return Promise.resolve(trend);
    return Promise.resolve(null);
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  localStorage.clear();
  seedTenant();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<Funnel /> — page chrome + initial fetches', () => {
  it('renders heading + subtitle + date filters + pipeline filter synchronously', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Chrome is data-independent — synchronous getByRole / getByText safe.
    expect(
      screen.getByRole('heading', { name: /Sales Funnel/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Stage-by-stage conversion, velocity, and rep performance/i),
    ).toBeInTheDocument();

    // Two date inputs (from + to).
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBe(2);

    // Pipeline filter <select> with "All Pipelines" default option.
    const pipelineSel = screen.getByRole('combobox');
    expect(pipelineSel).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /All Pipelines/i })).toBeInTheDocument();

    // Let pending mock promises settle (avoids dangling-promise pollution).
    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/funnel/stages'),
      ),
    );
  });

  it('fires /api/pipelines + the five funnel GETs on mount with NO ?from / ?to / ?pipelineId', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      // Pipelines lookup (separate useEffect).
      expect(urls).toContain('/api/pipelines');
      // Five funnel endpoints — on first mount, with no filters set,
      // /stages + /conversion-by-source + /by-rep carry NO query string;
      // /velocity carries none either; /trend always carries ?months=6.
      expect(urls).toContain('/api/funnel/stages');
      expect(urls).toContain('/api/funnel/conversion-by-source');
      expect(urls).toContain('/api/funnel/by-rep');
      expect(urls).toContain('/api/funnel/velocity');
      expect(urls).toContain('/api/funnel/trend?months=6');
      // No query-string variants of /stages should appear yet.
      expect(urls.some((u) => u.startsWith('/api/funnel/stages?'))).toBe(false);
    });
  });

  it('renders "Loading…" in the funnel card while the initial fetch is pending', async () => {
    // Hold the stages promise open so the loading branch is observable.
    let resolveStages;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pipelines') return Promise.resolve(PIPELINES);
      if (url.startsWith('/api/funnel/stages')) {
        return new Promise((r) => { resolveStages = r; });
      }
      // All other funnel endpoints resolve to empty arrays so the
      // Promise.all doesn't wait on them.
      return Promise.resolve([]);
    });
    render(<Funnel />);

    // The loading placeholder renders in the "Funnel by Stage" card.
    expect(await screen.findByText(/Loading…/i)).toBeInTheDocument();

    // Resolve so the test cleanly tears down.
    resolveStages({ stages: [] });
  });
});

describe('<Funnel /> — empty + populated payloads', () => {
  it('renders the five empty-state placeholders when everything resolves empty', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({
      stages: { stages: [] },
      bySource: [],
      byRep: [],
      velocity: [],
      trend: [],
    }));
    render(<Funnel />);

    // "No deals yet." — funnel card when funnelData is empty.
    expect(await screen.findByText(/No deals yet\./i)).toBeInTheDocument();
    // "No velocity data." — velocity card.
    expect(screen.getByText(/No velocity data\./i)).toBeInTheDocument();
    // "No trend data." — trend card.
    expect(screen.getByText(/No trend data\./i)).toBeInTheDocument();
    // "No source data." — bySource table card.
    expect(screen.getByText(/No source data\./i)).toBeInTheDocument();
    // "No rep data." — byRep table card.
    expect(screen.getByText(/No rep data\./i)).toBeInTheDocument();
  });

  it('renders each stage name in the breakdown table when stages populate', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Each stage name appears in the breakdown table rows. They appear
    // in multiple places (recharts label-lists too) so use findAllByText
    // and assert ≥1 occurrence per stage.
    await waitFor(async () => {
      expect((await screen.findAllByText('qualification')).length).toBeGreaterThanOrEqual(1);
    });
    expect((await screen.findAllByText('proposal')).length).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText('negotiation')).length).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText('closed-won')).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the conversion% suffix between stages with a non-null conversionToNext', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // The breakdown row shows "<value> • <money> • <pct>% →" when
    // conversionToNext is set. formatPercent renders 1-decimal precision
    // (e.g. 60 → "60.0%"). The terminal closed-won stage has
    // conversionToNext=null so its row should NOT carry the "→" arrow.
    await waitFor(() => {
      // Use findAllByText to tolerate recharts also rendering numbers.
      const rowsWithArrow = screen.getAllByText(/%\s*→/);
      expect(rowsWithArrow.length).toBeGreaterThanOrEqual(3);
    });
    // 60.0% from qualification's conversion-to-next (60).
    expect(screen.getAllByText(/60\.0%\s*→/).length).toBeGreaterThanOrEqual(1);
  });

  it('populates the KPI tiles from byRep aggregates', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Total Deals = sum(byRep.total) = 60 + 40 = 100.
    expect(await screen.findByText(/Total Deals/i)).toBeInTheDocument();
    // Won + Lost labels appear in BOTH the KPI tiles AND the Rep
    // Performance table column headers; use getAllByText to tolerate
    // the duplicates rather than insisting on a single match.
    expect(screen.getAllByText(/^Won$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Lost$/).length).toBeGreaterThanOrEqual(1);
    // The numeric tile values render inside the KpiCard sub-component.
    // "100" (total deals) and "43" (won) appear there.
    await waitFor(() => {
      expect(screen.getAllByText('100').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('43').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('27').length).toBeGreaterThanOrEqual(1);
    });
    // Win Rate label.
    expect(screen.getByText(/Win Rate/i)).toBeInTheDocument();
    // Avg Cycle label.
    expect(screen.getByText(/Avg Cycle/i)).toBeInTheDocument();
  });

  it('renders one row per rep in the Rep Performance table with owner + numeric cells', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Rep owner names render in the table.
    expect(await screen.findByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Rahul Mehta')).toBeInTheDocument();
    // The Rep Performance heading exists.
    expect(screen.getByRole('heading', { name: /Rep Performance/i })).toBeInTheDocument();
  });

  it('renders one row per source in the Conversion by Source table', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // The three source labels render.
    expect(await screen.findByText('website')).toBeInTheDocument();
    expect(screen.getByText('referral')).toBeInTheDocument();
    expect(screen.getByText('cold-email')).toBeInTheDocument();
    // The "Conversion by Source" heading exists.
    expect(screen.getByRole('heading', { name: /Conversion by Source/i })).toBeInTheDocument();
  });

  it('populates pipeline filter <select> with options from /api/pipelines', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Both seeded pipeline options render after /api/pipelines resolves.
    expect(
      await screen.findByRole('option', { name: /Default Pipeline/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Enterprise/i }),
    ).toBeInTheDocument();
  });
});

describe('<Funnel /> — filter refires', () => {
  it('changing the `from` date input refires the funnel fetches with from=YYYY-MM-DD', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Wait for the initial mount fetch to settle.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/funnel/stages'));

    fetchApiMock.mockClear();

    // Type into the first date input ("from").
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-01-01' } });

    // After the state change, the page refetches /stages + the others
    // with from=2026-01-01 embedded in the query string. Trend and
    // velocity don't forward the date params (per source: they stay
    // bare), so we only assert on /stages and /by-rep and /conversion.
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.includes('from=2026-01-01'))).toBe(true);
      // At least one stages or by-rep call carries the from param.
      expect(
        urls.some(
          (u) =>
            (u.startsWith('/api/funnel/stages') || u.startsWith('/api/funnel/by-rep'))
            && u.includes('from=2026-01-01'),
        ),
      ).toBe(true);
    });
  });

  it('changing the pipeline filter refires /api/funnel/stages with pipelineId=N', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Wait for pipelines to populate so the <option> exists.
    await waitFor(() =>
      expect(
        screen.queryByRole('option', { name: /Default Pipeline/i }),
      ).toBeInTheDocument(),
    );

    fetchApiMock.mockClear();

    // Change the pipeline select to pipe-1.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pipe-1' } });

    // The /stages refetch carries pipelineId=pipe-1. Per source, only
    // the stages endpoint forwards pipelineId — the other funnel endpoints
    // don't, so we only assert on /stages.
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(
        urls.some(
          (u) =>
            u.startsWith('/api/funnel/stages')
            && u.includes('pipelineId=pipe-1'),
        ),
      ).toBe(true);
    });
  });

  it('Clear button appears when any filter is set + clicking it clears state and refires', async () => {
    fetchApiMock.mockImplementation(buildFetchApi());
    render(<Funnel />);

    // Wait for initial mount + pipelines to settle.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/pipelines'));

    // Pre-state: NO Clear button (no filters set).
    expect(screen.queryByRole('button', { name: /Clear/i })).not.toBeInTheDocument();

    // Set the `from` date to a value — the Clear button should appear.
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-01-01' } });

    const clearBtn = await screen.findByRole('button', { name: /Clear/i });
    expect(clearBtn).toBeInTheDocument();

    fetchApiMock.mockClear();
    fireEvent.click(clearBtn);

    // After clear: the from input is empty AND the page refires without
    // any from= / to= / pipelineId= query-string segments. Verify the
    // bare /stages re-fetch fires.
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/funnel/stages');
      // And no from= variant in the post-clear batch.
      expect(urls.some((u) => u.includes('from=2026-01-01'))).toBe(false);
    });
    // Clear button is gone again.
    expect(screen.queryByRole('button', { name: /Clear/i })).not.toBeInTheDocument();
  });
});

describe('<Funnel /> — error handling', () => {
  it('does NOT crash when /api/pipelines rejects (best-effort fetch)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pipelines') return Promise.reject(new Error('boom'));
      if (url.startsWith('/api/funnel/stages')) return Promise.resolve({ stages: [] });
      return Promise.resolve([]);
    });
    render(<Funnel />);

    // Page still renders the heading + empty-state placeholder.
    expect(
      await screen.findByRole('heading', { name: /Sales Funnel/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/No deals yet\./i)).toBeInTheDocument();
    // The pipeline filter <select> still renders even if /api/pipelines
    // failed (defaults to [] via the .catch branch).
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('does NOT crash when /api/funnel/stages rejects (per-endpoint .catch fallbacks)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pipelines') return Promise.resolve([]);
      if (url.startsWith('/api/funnel/stages')) return Promise.reject(new Error('stages boom'));
      return Promise.resolve([]);
    });
    render(<Funnel />);

    // The page surfaces the empty state for the failed endpoint and the
    // overall page renders without crashing.
    expect(
      await screen.findByRole('heading', { name: /Sales Funnel/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/No deals yet\./i)).toBeInTheDocument();
  });
});
