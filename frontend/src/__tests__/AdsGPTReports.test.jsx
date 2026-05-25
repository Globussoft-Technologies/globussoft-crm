/**
 * AdsGPTReports.test.jsx — vitest + RTL coverage for the AdsGPT operator
 * reports admin page (frontend/src/pages/admin/AdsGPTReports.jsx, shipped
 * tick #103 commit 850391d, retrofitted tick #107 commit 93acf61 to use
 * shared CapBanners components).
 *
 * Scope — pins the page-surface invariants for the cap-consumer reports UI:
 *   1. Page chrome: heading "AdsGPT Reports" + 4 filter controls + "Fetch
 *      report" CTA render on mount (header is data-independent, asserted
 *      synchronously).
 *   2. cap-status GET on mount: fires GET /api/adsgpt/cap-status exactly
 *      once during the initial render lifecycle.
 *   3. Cap-status pill rendering: when cap-status returns withinCap=true +
 *      not-alerting, the green pill renders with the expected testid
 *      (`adsgpt-cap-pill`) and percent + dollars copy. Asserted via
 *      findByTestId (CLAUDE.md tick #108 — async-resolved UI uses findBy*).
 *   4. MANAGER 403 swallowed: cap-status 403 → NO pill renders (silent
 *      degradation per route comment "MANAGER role gets 403 swallowed").
 *   5. 402 cap-exceeded on cap-status: renders the red over-cap pill via
 *      the catch-branch synthesis of `{ percent:1, withinCap:false,
 *      alertThreshold:true }` from the err.body payload.
 *   6. Fetch report: clicking the "Fetch report" CTA fires GET
 *      /api/adsgpt/reports/ads with the filter-derived query string
 *      (subBrand defaults to ""=all, platform defaults to "all", from/to
 *      dates use the page's 30-day default window).
 *   7. Filter interaction: changing the platform filter THEN clicking
 *      Fetch fires a GET with `?platform=meta` in the query string.
 *      Changing the sub-brand to "tmc" THEN clicking Fetch fires a GET
 *      with `?subBrand=tmc`.
 *   8. Stub-mode banner: when the report response carries `stub: true`,
 *      the indigo stub banner (`adsgpt-stub-banner`) renders below the
 *      filter bar with the Q1-cred-blocked explanation copy.
 *   9. KPI tiles populate from `report.metrics`: Spend / Impressions /
 *      Clicks / Conversions / CPA / ROAS each render their formatted
 *      value via the data-testid path (`adsgpt-kpi-spend` etc.). Cents →
 *      USD round-trip for spend (5000 cents → "$50.00").
 *  10. Sub-brand badge: when the report response includes a `subBrand`,
 *      the badge renders with the friendly subBrandLabel ("TMC (School
 *      trips)").
 *  11. No-report empty state: before any Fetch click, the "No report
 *      loaded." card renders with the CTA copy.
 *  12. 402 cap-exceeded on report fetch: clicking Fetch and receiving
 *      a 402 ADSGPT_BUDGET_EXCEEDED renders the CapExceededBanner
 *      (`adsgpt-cap-exceeded-banner`) with "Monthly AdsGPT cap reached"
 *      copy, AND the report card is hidden (banner replaces report).
 *  13. Error handling on report fetch: non-402 error → notify.error fires
 *      with the server-supplied message AND the page does not crash.
 *
 * Backend contract pinned (per backend/routes/adsgpt.js):
 *   GET /api/adsgpt/cap-status        → { spentCents, capCents, percent, withinCap, alertThreshold }
 *                                       | 402 { error, code: "ADSGPT_BUDGET_EXCEEDED", spentCents, capCents }
 *                                       | 403 (MANAGER role — swallowed)
 *   GET /api/adsgpt/reports/ads?...   → { stub, tenantId, subBrand, platform, window, metrics, rows, note }
 *                                       | 402 { error, code: "ADSGPT_BUDGET_EXCEEDED", spentCents, capCents }
 *                                       | 400 { error, code: "INVALID_PLATFORM" }
 *
 * Why
 *   This is the first cap-consumer-shaped admin page (per PRD_ADSGPT_MARKETING_REPORTS
 *   §3 — wrapper pattern for cred-blocked sister-product integrations). The
 *   page's three contracts that benefit most from regression pins:
 *     (a) cap-status pill lifecycle — three branches (success / 402 / 403)
 *         that all need to render the right surface;
 *     (b) the 402-on-fetch transition that replaces the report card with
 *         the CapExceededBanner, since easy-to-silently-regress (e.g. by
 *         flipping the conditional order);
 *     (c) the stub-mode banner — load-bearing for the Q1-cred narrative
 *         (it tells operators the data is placeholder, not a real-traffic
 *         reading).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rule)
 *   - fetchApi mocked at ../utils/api (the page's dependency surface, NOT
 *     global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (the SUT closes over notify inside the
 *     async fetchReport handler).
 *   - travelSubBrand utility imported REAL (not mocked) so sub-brand-label
 *     drift is caught here rather than masked.
 *   - CapBanners imported REAL (not mocked) so the cap-pill / stub-banner /
 *     cap-exceeded-banner test surfaces match production.
 *   - All data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning: sync getBy for data-dependent text is a CI
 *     race trap).
 *
 * Path: flat __tests__/ per tick #111 path-coordination (sibling Agent B
 * owns RateHawkSearch.test.jsx in the same flat dir; no admin/ subdir to
 * avoid the concurrent-subdir-creation race).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d): re-creating the object per call causes infinite re-render
// loops when consumer pages put notify into a useCallback dep array.
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

import AdsGPTReports from '../pages/admin/AdsGPTReports';

// Helper: wrap in MemoryRouter because CapExceededBanner uses RouterLink
// (no `settingsHref` is passed by the SUT, so the link path isn't taken,
// but having the router context available is cheap insurance).
function renderPage() {
  return render(
    <MemoryRouter>
      <AdsGPTReports />
    </MemoryRouter>,
  );
}

// Canonical report response shape — mirrors backend/services/adsGptClient.js
// stub output. All metrics in cents (spend, cpa) or raw counts.
const STUB_REPORT = {
  stub: true,
  tenantId: 1,
  subBrand: null,
  platform: 'all',
  window: { fromDate: '2026-04-24', toDate: '2026-05-24' },
  metrics: {
    spendUsdCents: 5000,
    impressions: 12345,
    clicks: 678,
    conversions: 42,
    cpaCents: 119,
    roas: 2.5,
  },
  rows: [],
  note: 'Stub-mode response — AdsGPT credentials pending.',
};

const REAL_REPORT_TMC = {
  stub: false,
  tenantId: 1,
  subBrand: 'tmc',
  platform: 'meta',
  window: { fromDate: '2026-04-24', toDate: '2026-05-24' },
  metrics: {
    spendUsdCents: 7500,
    impressions: 22000,
    clicks: 900,
    conversions: 50,
    cpaCents: 150,
    roas: 3.2,
  },
  rows: [],
  note: null,
};

const CAP_STATUS_OK = {
  spentCents: 1000,
  capCents: 5000,
  percent: 0.2,
  withinCap: true,
  alertThreshold: false,
};

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
});

describe('<AdsGPTReports /> — page chrome + cap-status pill lifecycle', () => {
  it('renders heading + 4 filter controls + CTA on mount', async () => {
    // Cap-status resolves with the OK shape so the page completes its
    // initial-render cycle without a pending fetch leak.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      return Promise.resolve(null);
    });
    renderPage();
    // Heading is data-independent (chrome) — synchronous getByRole is safe.
    expect(
      screen.getByRole('heading', { name: /AdsGPT Reports/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('adsgpt-filter-subbrand')).toBeInTheDocument();
    expect(screen.getByTestId('adsgpt-filter-platform')).toBeInTheDocument();
    expect(screen.getByTestId('adsgpt-filter-from')).toBeInTheDocument();
    expect(screen.getByTestId('adsgpt-filter-to')).toBeInTheDocument();
    expect(screen.getByTestId('adsgpt-fetch-btn')).toBeInTheDocument();
    // Let cap-status resolve so dangling promise doesn't leak to next test.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });

  it('fires GET /api/adsgpt/cap-status exactly once on mount', async () => {
    fetchApiMock.mockResolvedValue(CAP_STATUS_OK);
    renderPage();
    await waitFor(() => {
      const capCalls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/adsgpt/cap-status',
      );
      expect(capCalls.length).toBe(1);
    });
  });

  it('renders the green cap-status pill when within cap + not alerting', async () => {
    fetchApiMock.mockResolvedValue(CAP_STATUS_OK);
    renderPage();
    const pill = await screen.findByTestId('adsgpt-cap-pill');
    // "20% of $50/mo cap" — formatPercent(0.2) + centsToUsd(5000) ='$50'.
    expect(pill).toHaveTextContent(/20% of \$50\/mo cap/i);
    // Green pill border colour (jsdom normalises #22c55e → rgb form).
    expect(pill.style.border).toBe('1px solid rgb(34, 197, 94)');
  });

  it('swallows cap-status 403 silently (MANAGER role) — no pill renders', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') {
        const err = new Error('Forbidden');
        err.status = 403;
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Wait until cap-status load completes (capStatusLoading flips false).
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/adsgpt/cap-status');
    });
    // After cap-status fail, the page should be stable WITHOUT the pill.
    // Use a short timeout to allow the catch + finally micro-tasks to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('adsgpt-cap-pill')).toBeNull();
  });

  it('renders the red over-cap pill on cap-status 402 (synthesises percent:1)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') {
        const err = new Error('Cap exceeded');
        err.status = 402;
        err.body = {
          error: 'AdsGPT monthly cap exceeded',
          code: 'ADSGPT_BUDGET_EXCEEDED',
          spentCents: 6000,
          capCents: 5000,
        };
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    renderPage();
    const pill = await screen.findByTestId('adsgpt-cap-pill');
    // The 402 catch synthesises percent=1 + withinCap=false → red pill.
    // Per formatPercent(1) → "100%", centsToUsd(5000) → "$50".
    expect(pill).toHaveTextContent(/100% of \$50\/mo cap/i);
    expect(pill.style.border).toBe('1px solid rgb(244, 63, 94)');
  });
});

describe('<AdsGPTReports /> — fetch report + filter interactions', () => {
  it('renders the "No report loaded." empty state before any Fetch click', async () => {
    fetchApiMock.mockResolvedValue(CAP_STATUS_OK);
    renderPage();
    expect(await screen.findByText(/No report loaded\./i)).toBeInTheDocument();
    expect(
      screen.getByText(/Pick a date range \+ platform \+ sub-brand/i),
    ).toBeInTheDocument();
  });

  it('clicking Fetch fires GET /api/adsgpt/reports/ads with default query (platform=all)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads')) return Promise.resolve(STUB_REPORT);
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByTestId('adsgpt-fetch-btn');
    fetchApiMock.mockClear();
    fetchApiMock.mockResolvedValueOnce(STUB_REPORT);

    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) =>
        url.startsWith('/api/adsgpt/reports/ads'),
      );
      expect(call).toBeTruthy();
      // Default platform=all, no subBrand. From/to dates are populated from
      // the page's 30-day default window helpers.
      expect(call[0]).toMatch(/platform=all/);
      expect(call[0]).toMatch(/fromDate=\d{4}-\d{2}-\d{2}/);
      expect(call[0]).toMatch(/toDate=\d{4}-\d{2}-\d{2}/);
      // Empty subBrand is NOT serialised into the query string (per SUT
      // `if (subBrand) qs.set(...)`).
      expect(call[0]).not.toMatch(/subBrand=/);
    });
  });

  it('changing the platform filter then clicking Fetch fires GET with ?platform=meta', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads')) return Promise.resolve(STUB_REPORT);
      return Promise.resolve(null);
    });
    renderPage();
    const platformSelect = await screen.findByTestId('adsgpt-filter-platform');
    fireEvent.change(platformSelect, { target: { value: 'meta' } });
    fetchApiMock.mockClear();
    fetchApiMock.mockResolvedValueOnce(STUB_REPORT);

    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) =>
        url.startsWith('/api/adsgpt/reports/ads'),
      );
      expect(call).toBeTruthy();
      expect(call[0]).toMatch(/platform=meta/);
    });
  });

  it('changing sub-brand to "tmc" then clicking Fetch fires GET with ?subBrand=tmc', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads'))
        return Promise.resolve(REAL_REPORT_TMC);
      return Promise.resolve(null);
    });
    renderPage();
    const subBrandSelect = await screen.findByTestId('adsgpt-filter-subbrand');
    fireEvent.change(subBrandSelect, { target: { value: 'tmc' } });
    fetchApiMock.mockClear();
    fetchApiMock.mockResolvedValueOnce(REAL_REPORT_TMC);

    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) =>
        url.startsWith('/api/adsgpt/reports/ads'),
      );
      expect(call).toBeTruthy();
      expect(call[0]).toMatch(/subBrand=tmc/);
    });
  });
});

describe('<AdsGPTReports /> — report card rendering', () => {
  it('renders the stub-mode banner when report.stub=true', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads')) return Promise.resolve(STUB_REPORT);
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByTestId('adsgpt-fetch-btn');
    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    const banner = await screen.findByTestId('adsgpt-stub-banner');
    expect(banner).toHaveTextContent(/Stub-mode response/i);
    expect(banner).toHaveTextContent(/Q1\s+cred/i);
  });

  it('populates KPI tiles from report.metrics (5000 cents → $50.00 spend)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads')) return Promise.resolve(STUB_REPORT);
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByTestId('adsgpt-fetch-btn');
    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    // Six KPI tiles per the SUT's KpiTile invocations.
    const spend = await screen.findByTestId('adsgpt-kpi-spend');
    expect(spend).toHaveTextContent('$50');
    const impressions = screen.getByTestId('adsgpt-kpi-impressions');
    expect(impressions).toHaveTextContent('12,345');
    const clicks = screen.getByTestId('adsgpt-kpi-clicks');
    expect(clicks).toHaveTextContent('678');
    const conversions = screen.getByTestId('adsgpt-kpi-conversions');
    expect(conversions).toHaveTextContent('42');
    // CPA in cents (119) → "$1.19".
    const cpa = screen.getByTestId('adsgpt-kpi-cpa');
    expect(cpa).toHaveTextContent('$1.19');
    // ROAS rendered as 2 decimal places via toFixed(2).
    const roas = screen.getByTestId('adsgpt-kpi-roas');
    expect(roas).toHaveTextContent('2.50');
  });

  it('renders the sub-brand badge with friendly label when report.subBrand is set', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads'))
        return Promise.resolve(REAL_REPORT_TMC);
      return Promise.resolve(null);
    });
    renderPage();
    // Pre-pick the tmc sub-brand so the report response is fed back.
    const subBrandSelect = await screen.findByTestId('adsgpt-filter-subbrand');
    fireEvent.change(subBrandSelect, { target: { value: 'tmc' } });

    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    // subBrandLabel('tmc') → "TMC (School trips)" per travelSubBrand.js.
    expect(await screen.findByText(/TMC \(School trips\)/i)).toBeInTheDocument();
  });
});

describe('<AdsGPTReports /> — error / cap-exceeded handling on fetch', () => {
  it('renders the CapExceededBanner on 402 ADSGPT_BUDGET_EXCEEDED + hides the report card', async () => {
    let callIdx = 0;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads')) {
        callIdx += 1;
        const err = new Error('AdsGPT monthly cap exceeded');
        err.status = 402;
        err.body = {
          error: 'AdsGPT monthly cap exceeded',
          code: 'ADSGPT_BUDGET_EXCEEDED',
          spentCents: 6000,
          capCents: 5000,
        };
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByTestId('adsgpt-fetch-btn');
    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    // CapExceededBanner appears with its testid.
    const banner = await screen.findByTestId('adsgpt-cap-exceeded-banner');
    expect(banner).toHaveTextContent(/Monthly AdsGPT cap reached/i);
    expect(banner).toHaveTextContent(/\$60 \/ \$50/);
    // Report card is hidden (the "No report loaded." empty state ALSO not
    // rendered, because the SUT's ternary returns null when capExceeded is
    // truthy).
    expect(screen.queryByText(/No report loaded\./i)).toBeNull();
    expect(callIdx).toBe(1);
  });

  it('non-cap-exceeded error → notify.error fires with server-supplied message', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/adsgpt/cap-status') return Promise.resolve(CAP_STATUS_OK);
      if (url.startsWith('/api/adsgpt/reports/ads')) {
        const err = new Error('upstream timeout');
        err.status = 500;
        err.body = { error: 'AdsGPT provider returned 503' };
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByTestId('adsgpt-fetch-btn');
    fireEvent.click(screen.getByTestId('adsgpt-fetch-btn'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      expect(notifyError.mock.calls[0][0]).toBe('AdsGPT provider returned 503');
    });
    // No crash — empty state still renders.
    expect(screen.getByText(/No report loaded\./i)).toBeInTheDocument();
    // The cap-exceeded banner is NOT shown for non-402 errors.
    expect(screen.queryByTestId('adsgpt-cap-exceeded-banner')).toBeNull();
  });
});
