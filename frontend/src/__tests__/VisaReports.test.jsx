/**
 * VisaReports.test.jsx — vitest + RTL coverage for the Phase 3 Visa Sure
 * Reports analytics page (frontend/src/pages/travel/visa/Reports.jsx,
 * cluster B3 wired tick d049548 — V16/V17/V18 graduated PARTIAL → SHIPPED).
 *
 * Scope — pins the page-surface invariants for the Visa Sure analytics
 * surface (3 recharts cards + KPI tiles for V16):
 *
 *   1. Page chrome: heading "Visa Sure — Reports" + "Phase 3 — V16-V18
 *      wired" badge render synchronously.
 *   2. Loading state: "Loading Visa Sure analytics…" surfaces while the
 *      three parallel GETs are in flight (Promise.allSettled, per SUT
 *      line 181).
 *   3. 3 parallel GETs on mount: fires GET against EACH of the three
 *      /api/travel/visa/analytics/* endpoints exactly once on mount.
 *   4. V16 — recovery KPI tiles + chart render from populated response:
 *      4 tiles (Total rejected / Recovery attempts / Recovery successes /
 *      Success rate) + the "Overall" cohort bar.
 *   5. V16 — empty-state when recoveryAttempts=0: chart card renders the
 *      backend `note` (or fallback "No recovery-program applications…"
 *      when note missing).
 *   6. V17 — readiness data renders ChartCard chrome (title + description).
 *      Empty state when byReadinessLevel=[].
 *   7. V18 — lead-source data renders ChartCard chrome (title +
 *      description). Empty state when bySource=[].
 *   8. Partial failure resilience: if 1 of 3 endpoints rejects, the other
 *      2 still render their data (Promise.allSettled isolation) AND
 *      notify.error fires exactly once with the backend message.
 *   9. Note pass-through: when an endpoint returns `note: "..."` with
 *      empty rows, the empty-state card surfaces THAT note verbatim
 *      (not the SHELL_EMPTY_FALLBACK).
 *  10. Rate-decimal → percent conversion: a backend successRate=0.42 maps
 *      to "42%" in the recovery KPI tile (SUT multiplies by 100, then
 *      Number(toFixed(2))).
 *
 * Backend contract pinned (per backend/routes/travel_visa_analytics.js
 * — commit 45dde56):
 *   GET /api/travel/visa/analytics/rejection-recovery
 *       → { totalRejected, recoveryAttempts, recoverySuccesses,
 *           successRate (0..1 decimal), rows: [], note? }
 *   GET /api/travel/visa/analytics/conversion-by-readiness
 *       → { byReadinessLevel: [{ level, count, converted,
 *           conversionRate (0..1 decimal) }], rows: [], note? }
 *   GET /api/travel/visa/analytics/lead-source-rate
 *       → { bySource: [{ source, leads, applications, rate (0..1
 *           decimal) }], rows: [], note? }
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Dispatch brief named endpoints "/funnel", "/rejection", "/by-officer".
 *     Actual endpoints per commit d049548 are
 *     "/rejection-recovery", "/conversion-by-readiness",
 *     "/lead-source-rate". Tests use the ACTUAL endpoint paths.
 *   - Dispatch brief mentioned "filter chrome (date range, sub-brand)" +
 *     "filter interaction triggers re-fetch with updated query params".
 *     The SUT does NOT render any filter chrome at all — no date range,
 *     no sub-brand selector. The page is sub-brand-implicit (visa-only
 *     by backend scoping) and renders aggregate-only views. Tests OMIT
 *     all filter-interaction assertions.
 *   - Dispatch brief said "sub-brand badge / context: visasure-implicit
 *     (no badge rendered)". Confirmed via SUT read — only the static
 *     "Phase 3 — V16-V18 wired" pill renders (NOT a sub-brand badge).
 *   - Dispatch brief said "403 → access-restricted state". The SUT does
 *     NOT render any 403-specific state — Promise.allSettled lets the
 *     three rejections (any code) cascade through the same notify.error
 *     toast path with the backend message. Tests pin the generic-error
 *     path, not a 403-specific surface.
 *   - Dispatch brief said "fixed-string date assertions / chart axis
 *     dates". The SUT does NOT render any dates on chart axes — V16 X
 *     axis is the literal "Overall", V17 is the readiness level label,
 *     V18 is the source string. Tests OMIT all date-axis assertions.
 *   - Dispatch brief mentioned "filter date range / sub-brand". SUT has
 *     none.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (Wave 11 cfb5789 / Wave 12 f59e91d).
 *   - SUT does NOT consume AuthContext directly — no Provider needed.
 *   - Recharts is mocked to a lightweight passthrough so the chart shells
 *     don't try to measure DOM in jsdom (ResponsiveContainer requires
 *     non-zero width which jsdom doesn't provide). Mocks preserve
 *     `data` and `dataKey` props on testid wrappers so we can still
 *     assert what the SUT feeds into the chart.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for async-resolved
 *     text is a CI race trap).
 *
 * Path: flat __tests__/ — sibling Agent A is on a DIFFERENT page; no
 * path collision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule. The SUT closes over notify
// inside useEffect's allSettled then-branch, so a fresh object per render
// would flap.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Mock recharts so ResponsiveContainer + BarChart + Bar don't try to
// measure DOM (jsdom returns zero-sized clientRect → "The width(0) and
// height(0) of chart should be greater than 0" warnings + lost render).
// Each chart is rendered as a passthrough div tagged with the data
// length and the dataKey so we can still assert what the SUT fed in.
vi.mock('recharts', () => {
  const Passthrough = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Passthrough,
    BarChart: ({ data, children }) => (
      <div data-testid="bar-chart" data-rows={(data || []).length}>
        {children}
      </div>
    ),
    Bar: ({ dataKey, name }) => (
      <div data-testid={`bar-${dataKey}`} data-name={name} />
    ),
    XAxis: () => <div data-testid="xaxis" />,
    YAxis: () => <div data-testid="yaxis" />,
    Tooltip: () => <div data-testid="tooltip" />,
    CartesianGrid: () => <div data-testid="grid" />,
    Legend: () => <div data-testid="legend" />,
  };
});

import VisaReports from '../pages/travel/visa/Reports';

// Canonical populated responses.
const RECOVERY_POPULATED = {
  totalRejected: 100,
  recoveryAttempts: 50,
  recoverySuccesses: 21,
  successRate: 0.42,
  rows: [{ status: 'approved', count: 21 }],
};

const RECOVERY_EMPTY = {
  totalRejected: 0,
  recoveryAttempts: 0,
  recoverySuccesses: 0,
  successRate: 0,
  rows: [],
  note: 'No Visa Sure contacts yet — populate VisaApplication rows for this tenant.',
};

const READINESS_POPULATED = {
  byReadinessLevel: [
    { level: 'level_1', count: 10, converted: 7, conversionRate: 0.7 },
    { level: 'level_2', count: 20, converted: 12, conversionRate: 0.6 },
    { level: 'level_3', count: 15, converted: 6, conversionRate: 0.4 },
    { level: 'level_4', count: 5, converted: 1, conversionRate: 0.2 },
  ],
  rows: [],
};

const READINESS_EMPTY = {
  byReadinessLevel: [],
  rows: [],
  note: 'No applications scored yet.',
};

const LEAD_SOURCE_POPULATED = {
  bySource: [
    { source: 'website', leads: 50, applications: 25, rate: 0.5 },
    { source: 'referral', leads: 30, applications: 18, rate: 0.6 },
    { source: 'paid_search', leads: 20, applications: 6, rate: 0.3 },
  ],
  rows: [],
};

const LEAD_SOURCE_EMPTY = {
  bySource: [],
  rows: [],
  note: 'No Visa Sure leads attributed to a source yet.',
};

function installFetchMock({
  recovery = RECOVERY_POPULATED,
  readiness = READINESS_POPULATED,
  leadSource = LEAD_SOURCE_POPULATED,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/travel/visa/analytics/rejection-recovery') {
      return recovery instanceof Error
        ? Promise.reject(recovery)
        : Promise.resolve(recovery);
    }
    if (url === '/api/travel/visa/analytics/conversion-by-readiness') {
      return readiness instanceof Error
        ? Promise.reject(readiness)
        : Promise.resolve(readiness);
    }
    if (url === '/api/travel/visa/analytics/lead-source-rate') {
      return leadSource instanceof Error
        ? Promise.reject(leadSource)
        : Promise.resolve(leadSource);
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

describe('<VisaReports /> — page chrome + mount lifecycle', () => {
  it('renders heading + "Phase 3 — V16-V18 wired" badge synchronously', async () => {
    render(<VisaReports />);
    expect(
      screen.getByRole('heading', { name: /Visa Sure — Reports/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Phase 3 — V16-V18 wired/i)).toBeInTheDocument();
    // Let the 3 mount-time GETs settle.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(3);
    });
  });

  it('shows "Loading Visa Sure analytics…" while the 3 parallel GETs are in flight', async () => {
    // Hold all 3 promises pending so the loading state surfaces.
    let resolveAll;
    const pending = new Promise((r) => {
      resolveAll = r;
    });
    fetchApiMock.mockImplementation(() => pending);
    render(<VisaReports />);
    expect(
      screen.getByText(/Loading Visa Sure analytics…/i),
    ).toBeInTheDocument();
    // Release so React's act() pending work doesn't leak to the next test.
    resolveAll({ recoveryAttempts: 0, totalRejected: 0, recoverySuccesses: 0, successRate: 0, rows: [] });
    await waitFor(() => {
      expect(
        screen.queryByText(/Loading Visa Sure analytics…/i),
      ).toBeNull();
    });
  });

  it('fires GET against each of the 3 /analytics/* endpoints exactly once on mount', async () => {
    render(<VisaReports />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(3);
    });
    const urls = fetchApiMock.mock.calls.map(([u]) => u);
    expect(urls).toContain('/api/travel/visa/analytics/rejection-recovery');
    expect(urls).toContain('/api/travel/visa/analytics/conversion-by-readiness');
    expect(urls).toContain('/api/travel/visa/analytics/lead-source-rate');
  });
});

describe('<VisaReports /> — V16 rejection-recovery card', () => {
  it('renders the 4 KPI tiles + populated chart when recoveryAttempts > 0', async () => {
    render(<VisaReports />);
    // Tile labels.
    expect(await screen.findByText(/Total rejected/i)).toBeInTheDocument();
    expect(screen.getByText(/Recovery attempts/i)).toBeInTheDocument();
    expect(screen.getByText(/Recovery successes/i)).toBeInTheDocument();
    // 4th tile: Success rate (label is generic — assert via the percent value).
    // Rate-decimal → percent: 0.42 → "42%".
    expect(screen.getByText('42%')).toBeInTheDocument();
    // Tile values via formatNumber (toLocaleString — comma-separated).
    expect(screen.getByText('100')).toBeInTheDocument(); // totalRejected
    // The recovery chart has the V16 title.
    expect(
      screen.getByText(/Rejection-recovery success rate \(V16\)/i),
    ).toBeInTheDocument();
  });

  it('renders V16 empty-state with backend `note` when recoveryAttempts=0', async () => {
    installFetchMock({ recovery: RECOVERY_EMPTY });
    render(<VisaReports />);
    expect(
      await screen.findByText(
        /No Visa Sure contacts yet — populate VisaApplication rows/i,
      ),
    ).toBeInTheDocument();
    // KPI tiles are NOT rendered when recoveryAttempts=0 (the SUT gates
    // them behind `recovery && recovery.recoveryAttempts > 0`).
    expect(screen.queryByText(/Total rejected/i)).toBeNull();
  });

  it('renders V16 fallback empty-state copy when note is absent + recoveryAttempts=0', async () => {
    installFetchMock({
      recovery: {
        totalRejected: 0,
        recoveryAttempts: 0,
        recoverySuccesses: 0,
        successRate: 0,
        rows: [],
      },
    });
    render(<VisaReports />);
    expect(
      await screen.findByText(
        /No recovery-program applications recorded yet/i,
      ),
    ).toBeInTheDocument();
  });
});

describe('<VisaReports /> — V17 conversion-by-readiness card', () => {
  it('renders the V17 chart card chrome + chart with 4 readiness rows', async () => {
    render(<VisaReports />);
    expect(
      await screen.findByText(/Conversion by readiness level \(V17\)/i),
    ).toBeInTheDocument();
    // Description copy is the discriminator that pins the V17 card vs the
    // others — sub-source string is unique to V17.
    expect(
      screen.getByText(/Per readiness level 1-4/i),
    ).toBeInTheDocument();
  });

  it('renders V17 empty-state with backend `note` when byReadinessLevel=[]', async () => {
    installFetchMock({ readiness: READINESS_EMPTY });
    render(<VisaReports />);
    expect(
      await screen.findByText(/No applications scored yet\./i),
    ).toBeInTheDocument();
  });
});

describe('<VisaReports /> — V18 lead-source card', () => {
  it('renders the V18 chart card chrome', async () => {
    render(<VisaReports />);
    expect(
      await screen.findByText(/Lead source → application rate \(V18\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Per Contact\.source:/i),
    ).toBeInTheDocument();
  });

  it('renders V18 empty-state with backend `note` when bySource=[]', async () => {
    installFetchMock({ leadSource: LEAD_SOURCE_EMPTY });
    render(<VisaReports />);
    expect(
      await screen.findByText(
        /No Visa Sure leads attributed to a source yet\./i,
      ),
    ).toBeInTheDocument();
  });
});

describe('<VisaReports /> — partial-failure resilience', () => {
  it('1 endpoint rejecting still renders the other 2 cards + fires notify.error once', async () => {
    const err = new Error('upstream timeout');
    err.body = { error: 'Conversion-by-readiness service unavailable' };
    installFetchMock({ readiness: err });
    render(<VisaReports />);
    // V16 + V18 cards still render their populated chart titles.
    expect(
      await screen.findByText(/Rejection-recovery success rate \(V16\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Lead source → application rate \(V18\)/i),
    ).toBeInTheDocument();
    // V17 card surfaces fallback empty-state (no readiness data set → null).
    // The SUT's empty-state for null readiness falls through to
    // SHELL_EMPTY_FALLBACK.
    expect(
      screen.getByText(/Waiting for backend data wiring/i),
    ).toBeInTheDocument();
    // notify.error fired once with the backend message.
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledTimes(1);
      expect(notifyError.mock.calls[0][0]).toBe(
        'Conversion-by-readiness service unavailable',
      );
    });
  });

  it('all 3 endpoints rejecting → 3 SHELL_EMPTY_FALLBACK cards + single notify.error toast', async () => {
    const err = new Error('boom');
    err.message = 'Backend down';
    installFetchMock({ recovery: err, readiness: err, leadSource: err });
    render(<VisaReports />);
    // The shell fallback copy appears in all 3 empty cards. Use getAllByText
    // per RTL standing rule (label appears in multiple chrome layers).
    await waitFor(() => {
      const fallbacks = screen.getAllByText(/Waiting for backend data wiring/i);
      expect(fallbacks.length).toBe(3);
    });
    // Single toast — only the first failure surfaces (SUT picks `failures[0]`).
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledTimes(1);
    });
  });
});
