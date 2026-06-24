/**
 * TravelReports.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Reports page (frontend/src/pages/travel/Reports.jsx).
 *
 * Distinct from:
 *   - frontend/src/__tests__/Reports.cellStyle.test.jsx — a style-grep
 *     test that reads a single source file via fs.readFileSync; NOT a
 *     render test of any Reports page.
 *   - frontend/src/__tests__/VisaReports.test.jsx (tick #122 commit
 *     98aae5d) — covers the Phase 3 Visa Sure analytics page at
 *     frontend/src/pages/travel/visa/Reports.jsx (3 parallel
 *     /api/travel/visa/analytics/* GETs + recharts cards). Different
 *     surface entirely.
 *
 * Scope — pins the page-surface invariants for the Travel-vertical
 * Reports surface (3 tabs, each its own one-shot GET):
 *
 *   1. Page chrome: heading "Travel Reports" + tablist with three
 *      tabs (TMC / RFU / Cross-brand) render synchronously.
 *   2. Tabs are role=tab and the default-selected tab is TMC.
 *   3. Loading state: "Loading report…" surfaces while the GET for the
 *      active tab is in flight.
 *   4. GET on mount: fires GET /api/travel/reports/tmc exactly once
 *      (the initially-active TMC tab) and DOES NOT pre-fetch the
 *      other two tabs.
 *   5. Switching to RFU tab: fires GET /api/travel/reports/rfu (and
 *      not before — pinning the lazy-per-tab fetch behaviour).
 *   6. Switching to Cross-brand tab: fires GET
 *      /api/travel/reports/cross-brand.
 *   7. TMC populated: KPI tiles render (Total revenue + Schools),
 *      "Trip status" + "Deal funnel" + "Diagnostics by classification"
 *      + "Top destinations by revenue" cards render with mocked data.
 *      ₹-formatted revenue uses en-IN locale (1,23,456 grouping).
 *   8. TMC empty: zero destinations → "No revenue recorded yet."
 *      empty card copy.
 *   9. RFU populated: KPI tiles (Itineraries + Diagnostic tier mix)
 *      + status/funnel/classification cards render.
 *  10. RFU empty (zero itineraries): "No itineraries yet." empty row.
 *  11. Cross-brand populated: sub-brand badge per row renders (uses
 *      brand string verbatim — TMC/RFU/TRAVEL_STALL/VISA_SURE per
 *      backend response).
 *  12. Cross-brand empty (no subBrands): "No deal activity across any
 *      sub-brand yet." empty-state copy.
 *  13. Error state: failed GET surfaces inline error chrome with Retry
 *      button + reload re-fires the same endpoint. notify.error is
 *      called for non-403 errors.
 *  14. 403 quiet: a 403 surfaces the inline error chrome BUT does NOT
 *      call notify.error (sub-brand access denial path, line 89 SUT).
 *
 * Backend contract pinned (per the three endpoints under
 * /api/travel/reports/*):
 *   GET /api/travel/reports/tmc → {
 *       revenue: { total, topDestinations: [{ destination, revenue }] },
 *       trips: { total, active, byStatus: {status: count} },
 *       schools: { unique, repeat, repeatRatePct },
 *       deals: { byStage: {stage: count}, amountByStage: {stage: amount} },
 *       diagnostics: { byClassification: {label: count} }
 *     }
 *   GET /api/travel/reports/rfu → {
 *       itineraries: { total, byStatus: {status: count},
 *                      amountByStatus: {status: amount} },
 *       customers: { unique, repeat, repeatRatePct },
 *       diagnostics: { byTier: {tier: count},
 *                      byClassification: {label: count} },
 *       deals: { byStage: {stage: count}, amountByStage: {stage: amount} }
 *     }
 *   GET /api/travel/reports/cross-brand → {
 *       subBrands: { brand: { won, lost, wonRevenue, conversionPct,
 *                             diagnostics } }
 *     }
 *
 * Drift pinned (prompt brief vs. actual SUT code):
 *   - Brief mentioned "filter chrome (date range / sub-brand /
 *     report-type)". SUT renders NO date-range filter, NO sub-brand
 *     selector — the three tabs (TMC / RFU / Cross-brand) ARE the
 *     scope selector. Tests OMIT all date-filter / sub-brand-dropdown
 *     assertions.
 *   - Brief mentioned "recharts passthrough mock". SUT imports NO
 *     recharts — all data renders as native HTML tables + tiles. No
 *     chart mock needed.
 *   - Brief mentioned "AuthContext via real Provider wrapper IF SUT
 *     consumes it". SUT does NOT consume AuthContext; no Provider
 *     wrapper needed.
 *   - Brief mentioned "Sub-brand badge per row (if rendered): uses
 *     real travelSubBrand or uniform CSS-vars". SUT renders a
 *     hardcoded inline `brandBadge` style (line 439-443) — it does
 *     NOT import frontend/src/utils/travelSubBrand.js at all. The
 *     badge uses CSS-var palette uniformly across brands (NOT
 *     per-brand-coloured). Tests pin the badge presence + brand text,
 *     NOT a per-brand palette assertion.
 *   - Brief mentioned "Multiple parallel GETs (URL-dispatch mock per
 *     VisaReports pattern)". SUT fires ONE GET per tab, lazily on
 *     tab switch. URL-dispatch mock still applies (tabs share the
 *     same fetchApiMock) but parallelism is SEQUENTIAL across tab
 *     clicks, not concurrent.
 *   - Brief mentioned "Empty-state per report section: backend
 *     returns zero data". SUT has multiple empty-state copies — they
 *     differ per card (No trips yet / No deals yet / No revenue
 *     recorded / No itineraries yet / etc.). Tests cover several to
 *     pin the per-card branches.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global
 *     fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify
 *     identity stays stable across renders (Wave 11 cfb5789 / Wave
 *     12 f59e91d).
 *   - Data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning).
 *   - Path: flat __tests__/ — sibling Agent A is on a DIFFERENT page;
 *     no path collision (verified: no in-flight TravelReports.test.jsx
 *     in git status).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule. The SUT closes over notify
// inside useReport's useEffect promise chain; a fresh object per render
// would re-trigger the effect.
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

import TravelReports from '../pages/travel/Reports';

// Canonical populated responses.
const TMC_POPULATED = {
  revenue: {
    total: 1234567,
    topDestinations: [
      { destination: 'Goa', revenue: 500000 },
      { destination: 'Manali', revenue: 300000 },
    ],
  },
  trips: {
    total: 12,
    active: 4,
    byStatus: { PLANNING: 4, IN_PROGRESS: 3, COMPLETED: 5 },
  },
  schools: { unique: 8, repeat: 3, repeatRatePct: 37.5 },
  deals: {
    byStage: { Prospecting: 2, Qualification: 3, Closed_Won: 4 },
    amountByStage: { Prospecting: 50000, Qualification: 100000, Closed_Won: 1234567 },
  },
  diagnostics: {
    byClassification: { fit: 6, partial: 2, unfit: 1 },
  },
};

const TMC_EMPTY = {
  revenue: { total: 0, topDestinations: [] },
  trips: { total: 0, active: 0, byStatus: {} },
  schools: { unique: 0, repeat: 0, repeatRatePct: 0 },
  deals: { byStage: {}, amountByStage: {} },
  diagnostics: { byClassification: {} },
};

const RFU_POPULATED = {
  itineraries: {
    total: 9,
    byStatus: { DRAFT: 2, CONFIRMED: 5, COMPLETED: 2 },
    amountByStatus: { DRAFT: 25000, CONFIRMED: 450000, COMPLETED: 180000 },
  },
  customers: { unique: 7, repeat: 2, repeatRatePct: 28.6 },
  diagnostics: {
    byTier: { tier_1: 3, tier_2: 4, tier_3: 1 },
    byClassification: { ready: 5, blocked: 2 },
  },
  deals: {
    byStage: { Discovery: 1, Closed_Won: 2 },
    amountByStage: { Discovery: 30000, Closed_Won: 600000 },
  },
};

const RFU_EMPTY = {
  itineraries: { total: 0, byStatus: {}, amountByStatus: {} },
  customers: { unique: 0, repeat: 0, repeatRatePct: 0 },
  diagnostics: { byTier: {}, byClassification: {} },
  deals: { byStage: {}, amountByStage: {} },
};

const CROSS_BRAND_POPULATED = {
  subBrands: {
    TMC: { won: 8, lost: 2, wonRevenue: 1234567, conversionPct: 80, diagnostics: 9, quotesTotal: 10, quotesAccepted: 8, quoteRevenue: 1234567, quoteConversionPct: 80 },
    RFU: { won: 5, lost: 3, wonRevenue: 540000, conversionPct: 62, diagnostics: 8, quotesTotal: 8, quotesAccepted: 5, quoteRevenue: 540000, quoteConversionPct: 62 },
    TRAVEL_STALL: { won: 3, lost: 4, wonRevenue: 210000, conversionPct: 43, diagnostics: 5, quotesTotal: 7, quotesAccepted: 3, quoteRevenue: 210000, quoteConversionPct: 43 },
  },
};

const CROSS_BRAND_EMPTY = { subBrands: {} };

function installFetchMock({
  tmc = TMC_POPULATED,
  rfu = RFU_POPULATED,
  crossBrand = CROSS_BRAND_POPULATED,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/travel/reports/tmc') {
      return tmc instanceof Error ? Promise.reject(tmc) : Promise.resolve(tmc);
    }
    if (url === '/api/travel/reports/rfu') {
      return rfu instanceof Error ? Promise.reject(rfu) : Promise.resolve(rfu);
    }
    if (url === '/api/travel/reports/cross-brand') {
      return crossBrand instanceof Error
        ? Promise.reject(crossBrand)
        : Promise.resolve(crossBrand);
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

describe('<TravelReports /> — page chrome + tabs', () => {
  it('renders heading + the three tabs synchronously', async () => {
    render(<TravelReports />);
    expect(
      screen.getByRole('heading', { name: /Travel Reports/i }),
    ).toBeInTheDocument();
    // All three tabs render as role=tab.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.map((t) => t.textContent.trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('TMC'),
        expect.stringContaining('RFU'),
        expect.stringContaining('Cross-brand')]),
    );
    // Let the mount-time GET settle.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });

  it('defaults to TMC tab selected (aria-selected=true)', async () => {
    render(<TravelReports />);
    const tmcTab = screen.getByRole('tab', { name: /TMC/i });
    expect(tmcTab.getAttribute('aria-selected')).toBe('true');
    const rfuTab = screen.getByRole('tab', { name: /RFU/i });
    expect(rfuTab.getAttribute('aria-selected')).toBe('false');
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });
});

describe('<TravelReports /> — mount + lazy-per-tab fetching', () => {
  it('fires GET /api/travel/reports/tmc on mount (initial tab is TMC) and does NOT pre-fetch other tabs', async () => {
    render(<TravelReports />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchApiMock.mock.calls[0][0]).toBe('/api/travel/reports/tmc');
  });

  it('shows "Loading report…" while the TMC GET is in flight', async () => {
    let resolveTmc;
    const pending = new Promise((r) => {
      resolveTmc = r;
    });
    fetchApiMock.mockImplementation(() => pending);
    render(<TravelReports />);
    // The SUT uses an HTML entity for the ellipsis (&hellip;) which RTL
    // resolves to the literal "…" character. Use the prefix substring.
    expect(screen.getByText(/Loading report/i)).toBeInTheDocument();
    resolveTmc(TMC_POPULATED);
    await waitFor(() => {
      expect(screen.queryByText(/Loading report/i)).toBeNull();
    });
  });

  it('switching to RFU tab fires GET /api/travel/reports/rfu (lazy, not pre-fetched)', async () => {
    render(<TravelReports />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    // Click the RFU tab.
    fireEvent.click(screen.getByRole('tab', { name: /RFU/i }));
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/travel/reports/rfu');
    });
  });

  it('switching to Cross-brand tab fires GET /api/travel/reports/cross-brand', async () => {
    render(<TravelReports />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /Cross-brand/i }));
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/travel/reports/cross-brand');
    });
  });
});

describe('<TravelReports /> — TMC tab content', () => {
  it('renders TMC KPI tiles + cards with populated data', async () => {
    render(<TravelReports />);
    // KPI tile labels.
    expect(
      await screen.findByText(/Total revenue \(active trips\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Schools$/i)).toBeInTheDocument();
    // Cards.
    expect(screen.getByText(/Trip status/i)).toBeInTheDocument();
    expect(screen.getByText(/Deal funnel/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Diagnostics by classification/i),
    ).toBeInTheDocument();
    // Top destinations card title includes the dynamic top-N count.
    expect(
      screen.getByText(/Top destinations by revenue \(top 2\)/i),
    ).toBeInTheDocument();
    // Destination rows.
    expect(screen.getByText('Goa')).toBeInTheDocument();
    expect(screen.getByText('Manali')).toBeInTheDocument();
  });

  it('renders en-IN ₹-formatted revenue (12,34,567 grouping)', async () => {
    render(<TravelReports />);
    // 1234567 → "12,34,567" (en-IN grouping: lakh-and-crore grouping).
    // The value appears in BOTH the KPI tile (Total revenue) AND the
    // Closed_Won row of the Deal funnel — use findAllByText per the
    // RTL standing rule (label appears in multiple chrome layers).
    await screen.findByText(/Total revenue/i);
    const matches = await screen.findAllByText(/₹12,34,567/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders TMC empty-state copy when no revenue / no schools', async () => {
    installFetchMock({ tmc: TMC_EMPTY });
    render(<TravelReports />);
    // Top destinations card → empty card copy.
    expect(
      await screen.findByText(/No revenue recorded yet\./i),
    ).toBeInTheDocument();
    // Schools tile footer falls back to "no schools yet".
    expect(screen.getByText(/no schools yet/i)).toBeInTheDocument();
    // Trip status KeyValueList empty.
    expect(screen.getByText(/No trips yet\./i)).toBeInTheDocument();
    // Deal funnel empty row.
    expect(screen.getByText(/No deals yet\./i)).toBeInTheDocument();
  });
});

describe('<TravelReports /> — RFU tab content', () => {
  it('renders RFU KPI tiles + cards after switching to RFU tab', async () => {
    render(<TravelReports />);
    // Wait for TMC mount fetch to settle so we don't race the tab switch.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /RFU/i }));
    // RFU-specific labels.
    expect(await screen.findByText(/^Itineraries$/i)).toBeInTheDocument();
    expect(screen.getByText(/Diagnostic tier mix/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Itinerary revenue by status/i),
    ).toBeInTheDocument();
    // RFU customers footer (7 customers · 2 repeat (28.6%)).
    expect(screen.getByText(/7 customers/i)).toBeInTheDocument();
  });

  it('renders RFU empty-state copy when no itineraries / no customers', async () => {
    installFetchMock({ rfu: RFU_EMPTY });
    render(<TravelReports />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /RFU/i }));
    // The "No itineraries yet." empty row.
    expect(
      await screen.findByText(/No itineraries yet\./i),
    ).toBeInTheDocument();
    // No customers → "no customers yet" footer.
    expect(screen.getByText(/no customers yet/i)).toBeInTheDocument();
    // No diagnostics → "no diagnostics" copy renders in BOTH the tier-mix
    // tile footer AND the byClassification KeyValueList empty (slightly
    // different copy: "no diagnostics yet" tile footer vs "No diagnostics
    // yet." card empty). Use findAllByText per RTL standing rule.
    const noDiag = await screen.findAllByText(/no diagnostics yet/i);
    expect(noDiag.length).toBeGreaterThanOrEqual(1);
  });
});

describe('<TravelReports /> — Cross-brand tab content', () => {
  it('renders sub-brand rows with badge + conversion% per brand', async () => {
    render(<TravelReports />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /Cross-brand/i }));
    // Card title is rendered.
    expect(
      await screen.findByText(/Won-revenue \+ conversion by sub-brand/i),
    ).toBeInTheDocument();
    // Each brand renders a badge with the brand string verbatim.
    // "TMC" + "RFU" ALSO appear as tab labels — use findAllByText per
    // the RTL standing rule (label appears in multiple chrome layers),
    // and assert at least 2 matches for those (tab + badge), exactly 1
    // for TRAVEL_STALL (badge only).
    const tmcMatches = screen.getAllByText('TMC');
    expect(tmcMatches.length).toBeGreaterThanOrEqual(2);
    const rfuMatches = screen.getAllByText('RFU');
    expect(rfuMatches.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('TRAVEL_STALL')).toBeInTheDocument();
    // Conversion % values render as "<n>%".
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('62%')).toBeInTheDocument();
    expect(screen.getByText('43%')).toBeInTheDocument();
  });

  it('renders Cross-brand empty-state when no sub-brand activity', async () => {
    installFetchMock({ crossBrand: CROSS_BRAND_EMPTY });
    render(<TravelReports />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /Cross-brand/i }));
    expect(
      await screen.findByText(
        /No deal activity across any sub-brand yet\./i,
      ),
    ).toBeInTheDocument();
  });
});

describe('<TravelReports /> — error chrome + 403 quiet path', () => {
  it('surfaces inline error chrome with Retry on non-403 failure + calls notify.error', async () => {
    const err = new Error('boom');
    err.body = { error: 'TMC report service unavailable' };
    err.status = 500;
    installFetchMock({ tmc: err });
    render(<TravelReports />);
    // Inline error chrome surfaces.
    expect(
      await screen.findByText(/TMC report service unavailable/i),
    ).toBeInTheDocument();
    // Retry button is rendered.
    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeInTheDocument();
    // notify.error called for non-403.
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledTimes(1);
      expect(notifyError.mock.calls[0][0]).toBe(
        'TMC report service unavailable',
      );
    });
    // Retry re-fires the same endpoint. Switch the mock to return success
    // on retry so we can confirm the reload path lands.
    installFetchMock({ tmc: TMC_POPULATED });
    fireEvent.click(retryBtn);
    expect(
      await screen.findByText(/Total revenue \(active trips\)/i),
    ).toBeInTheDocument();
  });

  it('403 surfaces inline error chrome BUT does NOT call notify.error (sub-brand denial)', async () => {
    const err = new Error('forbidden');
    err.body = { error: 'Sub-brand access denied' };
    err.status = 403;
    installFetchMock({ rfu: err });
    render(<TravelReports />);
    // Settle the TMC mount fetch first.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /RFU/i }));
    // Inline error chrome surfaces with the backend message.
    expect(
      await screen.findByText(/Sub-brand access denied/i),
    ).toBeInTheDocument();
    // notify.error NOT called for 403.
    expect(notifyError).not.toHaveBeenCalled();
  });
});
