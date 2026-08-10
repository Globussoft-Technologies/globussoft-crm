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

function renderTravelReports() {
  return render(<TravelReports />);
}

// Canonical populated responses.
const TMC_POPULATED = {
  revenue: {
    total: 1234567,
    topDestinations: [
      { destination: 'Goa', revenue: 500000 },
      { destination: 'Manali', revenue: 300000 },
    ],
    rows: [
      { id: 101, tripCode: 'tmc-goa-2026', destination: 'Goa', schoolName: 'Bharat Public School', schoolId: 501, status: 'confirmed', pax: 25, pricePerStudent: 20000, revenue: 500000, departDate: '2026-03-28T00:00:00.000Z', returnDate: '2026-04-04T00:00:00.000Z' },
      { id: 102, tripCode: 'tmc-manali-2026', destination: 'Manali', schoolName: 'Bharat Public School', schoolId: 501, status: 'completed', pax: 15, pricePerStudent: 20000, revenue: 300000, departDate: '2026-05-10T00:00:00.000Z', returnDate: '2026-05-15T00:00:00.000Z' },
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
  revenue: { total: 0, topDestinations: [], rows: [] },
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
    byClassification: { level_1: 1, level_2: 2, level_3: 3 },
  },
  deals: {
    byStage: { Discovery: 1, Closed_Won: 2 },
    amountByStage: { Discovery: 30000, Closed_Won: 600000 },
  },
  quotes: {
    byStatus: { Accepted: 4, advance_paid: 1, Draft: 1, Sent: 1 },
    amountByStatus: { Accepted: 1949543.2, advance_paid: 198257.15, Draft: 225523.13, Sent: 256352.65 },
  },
  revenueRows: [
    { id: 301, destination: 'Dubai Umrah support', status: 'advance_paid', amount: 198257.15, currency: 'INR', pax: 2, contactName: 'Mohit', updatedAt: '2026-08-03T08:00:00.000Z' },
  ],
  agentProductivity: {
    agents: [{ userId: 44, name: 'RFU Advisor', totalActions: 7, createdQuotes: 2, sentQuotes: 2, acceptedQuotes: 1, declinedQuotes: 0, updatedQuotes: 1, paidQuotes: 1, paymentAmount: 98257.15 }],
    payments: [{ paymentId: 9001, userId: 44, agentName: 'RFU Advisor', quoteId: 21, quoteStatus: 'advance_paid', quoteTotal: 198257.15, amount: 98257.15, paidAt: '2026-08-03T08:00:00.000Z' }],
  },
};

const RFU_EMPTY = {
  itineraries: { total: 0, byStatus: {}, amountByStatus: {} },
  customers: { unique: 0, repeat: 0, repeatRatePct: 0 },
  diagnostics: { byTier: {}, byClassification: {} },
  deals: { byStage: {}, amountByStage: {} },
  quotes: { byStatus: {}, amountByStatus: {} },
  revenueRows: [],
  agentProductivity: { agents: [], payments: [] },
};

const CROSS_BRAND_POPULATED = {
  subBrands: {
    TMC: { won: 8, lost: 2, wonRevenue: 1234567, conversionPct: 80, diagnostics: 9, quotesTotal: 10, quotesAccepted: 8, quoteRevenue: 1234567, quoteConversionPct: 80 },
    RFU: { won: 5, lost: 3, wonRevenue: 540000, conversionPct: 62, diagnostics: 8, quotesTotal: 8, quotesAccepted: 5, quoteRevenue: 540000, quoteConversionPct: 62 },
    TRAVEL_STALL: { won: 3, lost: 4, wonRevenue: 210000, conversionPct: 43, diagnostics: 5, quotesTotal: 7, quotesAccepted: 3, quoteRevenue: 210000, quoteConversionPct: 43 },
  },
};

const CROSS_BRAND_EMPTY = { subBrands: {} };

const SUMMARY_POPULATED = {
  tmc: { trips: { total: 12, active: 4 }, revenue: { total: 1234567, currency: 'INR' }, schools: { unique: 8, repeat: 3, repeatRatePct: 37.5 } },
  rfu: { itineraries: { total: 9, revenue: 655000 }, customers: { unique: 7, repeat: 2, repeatRatePct: 28.6 }, currency: 'INR' },
  crossBrand: { subBrandCount: 3, totalWon: 16, totalLost: 9, totalWonRevenue: 1984567, conversionPct: 64, currency: 'INR' },
  salesFunnel: { total: 25, accepted: 16, rejected: 9, conversionPct: 64, byStatus: { Accepted: 16, Rejected: 9 }, bySubBrand: {}, currency: 'INR' },
  agentProductivity: { agents: [{ userId: 10, name: 'Asha Advisor', totalActions: 8, createdQuotes: 2, sentQuotes: 1, acceptedQuotes: 4, declinedQuotes: 0, updatedQuotes: 0, paidQuotes: 1, paymentAmount: 100000, byAction: { CREATE: 2, QUOTE_SHARE: 1, TRAVEL_QUOTE_ACCEPTED: 4, TRAVEL_QUOTE_PAYMENT_COLLECTED: 1 } }] },
  subBrandPnl: { rows: { tmc: { revenue: 500000, capturedCost: 320000, grossProfit: 180000, marginPct: 36, invoiceCount: 2 } }, currency: 'INR' },
  visaApproval: { total: 10, approved: 7, rejected: 3, decided: 10, approvalRatePct: 70, byStatus: { approved: 7, rejected: 3 } },
  checkinMiss: { total: 12, completed: 10, missed: 2, missRatePct: 16.67, byStatus: { done: 10, failed: 1, 'fallback-agent': 1 } },
  generatedAt: '2026-07-31T08:00:00.000Z',
};

function installFetchMock({
  tmc = TMC_POPULATED,
  rfu = RFU_POPULATED,
  crossBrand = CROSS_BRAND_POPULATED,
  summary = SUMMARY_POPULATED,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/travel/reports/summary') {
      return summary instanceof Error ? Promise.reject(summary) : Promise.resolve(summary);
    }
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
    expect(tabs).toHaveLength(4);
    expect(tabs.map((t) => t.textContent.trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('Overview'), expect.stringContaining('TMC'),
        expect.stringContaining('RFU'),
        expect.stringContaining('Cross-brand')]),
    );
    // Let the mount-time GET settle.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });

  it('defaults to Overview tab selected (aria-selected=true)', async () => {
    renderTravelReports();
    const overviewTab = screen.getByRole('tab', { name: /Overview/i });
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    const tmcTab = screen.getByRole('tab', { name: /TMC/i });
    expect(tmcTab.getAttribute('aria-selected')).toBe('false');
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
  });
});

describe('<TravelReports /> — mount + lazy-per-tab fetching', () => {
  it('fires GET /api/travel/reports/summary on mount (initial tab is Overview) and does NOT pre-fetch detail tabs', async () => {
    renderTravelReports();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchApiMock.mock.calls[0][0]).toBe('/api/travel/reports/summary');
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
    resolveTmc(SUMMARY_POPULATED);
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


describe('<TravelReports /> - overview baseline cards', () => {
  it('renders complete overview baseline report cards', async () => {
    renderTravelReports();
    expect(await screen.findByText(/Sales funnel/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent productivity/i)).toBeInTheDocument();
    expect(screen.getByText(/Sub-brand P&L/i)).toBeInTheDocument();
    expect(screen.getByText(/Visa approval rate/i)).toBeInTheDocument();
    expect(screen.getByText(/Check-in miss rate/i)).toBeInTheDocument();
    expect(screen.getByText(/64% quote conversion/i)).toBeInTheDocument();
    expect(screen.getByText(/Asha Advisor: 8 actions \(2 created, 1 sent, 4 accepted, 1 paid, .*1,00,000.* collected\)/i)).toBeInTheDocument();
  });
});

describe('<TravelReports /> — TMC tab content', () => {
  it('renders TMC KPI tiles + cards with populated data', async () => {
    renderTravelReports();
    await screen.findByText(/Sales funnel/i);
    fireEvent.click(screen.getByRole('tab', { name: /TMC/i }));
    // KPI tile labels.
    expect(
      await screen.findByText(/Total revenue \(active trips\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Schools$/i)).toBeInTheDocument();
    // Cards.
    expect(screen.getByText(/Trip status/i)).toBeInTheDocument();
    expect(screen.getByText(/Deal funnel/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Diagnostics by lead type/i),
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
    await screen.findByText(/Sales funnel/i);
    fireEvent.click(screen.getByRole('tab', { name: /TMC/i }));
    await screen.findByText(/Total revenue/i);
    const matches = await screen.findAllByText(/₹12,34,567/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders TMC empty-state copy when no revenue / no schools', async () => {
    installFetchMock({ tmc: TMC_EMPTY });
    renderTravelReports();
    await screen.findByText(/Sales funnel/i);
    fireEvent.click(screen.getByRole('tab', { name: /TMC/i }));
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
    // RFU-specific analytics.
    expect(await screen.findByText(/RFU itinerary revenue/i)).toBeInTheDocument();
    expect(screen.getByText(/Advisor activity/i)).toBeInTheDocument();
    expect(screen.getByText(/Revenue health/i)).toBeInTheDocument();
    expect(screen.getByText(/Diagnostics intelligence/i)).toBeInTheDocument();
    expect(screen.getByText(/Diagnostics by lead type/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Standard readiness/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Confident readiness/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Premium readiness/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/level_1/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/RFU Advisor/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/7 actions/i)).toBeInTheDocument();
    expect(screen.getByText(/1 paid, .*98,257.15.* collected/i)).toBeInTheDocument();
    expect(screen.getByText(/7 customers/i)).toBeInTheDocument();
  });

  it('opens RFU report-native revenue and advisor drilldowns', async () => {
    renderTravelReports();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /RFU/i }));

    fireEvent.click(await screen.findByRole('button', { name: /Revenue health - View revenue detail/i }));
    expect(screen.getByText(/RFU revenue source detail/i)).toBeInTheDocument();
    expect(screen.getByText(/Itinerary #301/i)).toBeInTheDocument();
    expect(screen.getByText(/Dubai Umrah support/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Quote #21/i).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole('button', { name: /Advisor activity - View advisor detail/i }));
    expect(screen.getByText(/RFU advisor deal and collection detail/i)).toBeInTheDocument();
    expect(screen.getAllByText(/RFU Advisor/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/INR 98,257.15/i).length).toBeGreaterThanOrEqual(1);
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
    expect(screen.getByText(/0 repeat from 0 customers/i)).toBeInTheDocument();
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
    expect(await screen.findByText(/Brand comparison/i)).toBeInTheDocument();
    expect(screen.getByText(/Sub-brands active/i)).toBeInTheDocument();
    expect(screen.getByText(/Accepted quotes/i)).toBeInTheDocument();
    expect(screen.getByText(/Raw brand metrics/i)).toBeInTheDocument();

    // Each brand renders a badge with the brand string verbatim. TMC + RFU
    // also appear as tabs/details, so assert at least one visible match.
    expect(screen.getAllByText('TMC').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('RFU').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('TRAVEL_STALL').length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText(/TMC detailed view/i)).toBeInTheDocument();
    expect(screen.getByText(/Quote acceptance/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /RFU.*accepted/i }));
    expect(screen.getByText(/RFU detailed view/i)).toBeInTheDocument();
    expect(screen.getByText(/62%/i)).toBeInTheDocument();
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
    renderTravelReports();
    await screen.findByText(/Sales funnel/i);
    fireEvent.click(screen.getByRole('tab', { name: /TMC/i }));
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
