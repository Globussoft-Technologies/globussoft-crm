/**
 * MilestoneTracker.test.jsx — vitest + RTL coverage for the Travel-vertical
 * cross-invoice milestone tracker page (frontend/src/pages/travel/
 * MilestoneTracker.jsx, shipped this slice — Arc 2 #901 slice 7 frontend).
 *
 * Scope — pins the page-surface invariants for the operator-facing
 * milestone-tracker view consuming
 * GET /api/travel/payment-schedules/upcoming (shipped backend-side in
 * commit e4832fee):
 *
 *   1. Page chrome — "Milestone Tracker" heading + 4 KPI cards (Pending /
 *      Partial / Paid / Overdue).
 *   2. Initial mount fires GET /api/travel/payment-schedules/upcoming with
 *      the default window=30 + limit=PAGE_SIZE + offset=0.
 *   3. Loaded milestones populate the table (one row per milestones[]
 *      entry; invoiceNum + sub-brand + milestoneOrder rendered).
 *   4. Empty state ([] milestones) → "No upcoming milestones in this
 *      window." copy renders verbatim.
 *   5. Status chip click ("Pending") → re-fetches with ?status=pending in
 *      the querystring.
 *   6. Window dropdown change (30 → 7) → re-fetches with ?within=7.
 *   7. Overdue-only checkbox toggle → re-fetches with ?overdueOnly=true
 *      (which suppresses ?within= per backend contract).
 *   8. Sub-brand dropdown change ("tmc") → re-fetches with ?subBrand=tmc.
 *   9. Pagination "Next" button → re-fetches with offset=PAGE_SIZE; "Prev"
 *      then re-fetches with offset=0.
 *  10. daysUntilDue cell rendering: positive=neutral text, zero=warning
 *      ("Due today"), negative=red ("N days overdue"). Pinned via row text.
 *  11. Currency breakdown footer renders both INR + USD totals from
 *      summary.currencyBreakdown.
 *  12. 5xx error from GET fires notify.error (the page surfaces an explicit
 *      toast on 5xx in addition to fetchApi's auto-toast).
 *
 * Backend contract pinned (per backend/routes/travel_invoices.js lines
 * 1788+, 10 vitest cases at backend/test/routes/
 * travel-payment-schedule-summary.test.js):
 *   GET /api/travel/payment-schedules/upcoming?status&within&subBrand&overdueOnly&limit&offset
 *     → 200 { milestones: [...], total, limit, offset, summary: {...} }
 *     | 403 (USER role on tenants where Travel is locked)
 *
 * Status enum (lowercase, matches assertValidScheduleStatus):
 *   pending | partial | paid | overdue | waived
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api.
 *   - useNotify returns a STABLE notifyObj reference for the whole file
 *     (Wave 11 cfb5789 / Wave 12 f59e91d — fresh per-call objects flap
 *     useCallback identity and cause infinite-render loops).
 *   - localStorage seeded with INR tenant so formatMoney has a baseline.
 *   - Data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning).
 *
 * Path: flat __tests__/ — no travel/ subdir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule.
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

import MilestoneTracker from '../pages/travel/MilestoneTracker';

function makeMilestone(overrides = {}) {
  return {
    id: 1,
    invoiceId: 101,
    invoiceNum: 'TINV-2026-0001',
    subBrand: 'tmc',
    contactId: 42,
    milestoneOrder: 1,
    dueDate: '2026-07-01T00:00:00.000Z',
    expectedAmount: '50000.00',
    expectedCurrency: 'INR',
    status: 'pending',
    receivedAmount: '0.00',
    daysUntilDue: 30,
    createdAt: '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

function makeResponse({
  milestones = [makeMilestone()],
  total = null,
  limit = 50,
  offset = 0,
  summary = null,
} = {}) {
  const resolvedTotal = total == null ? milestones.length : total;
  // Compute a default summary from the milestones array unless one was
  // explicitly passed (the backend computes summary across the returned
  // page; tests pinning the summary should pass it explicitly).
  const resolvedSummary =
    summary || {
      byStatus: milestones.reduce((acc, m) => {
        acc[m.status] = (acc[m.status] || 0) + 1;
        return acc;
      }, {}),
      totalExpected: milestones
        .reduce((s, m) => s + Number(m.expectedAmount || 0), 0)
        .toFixed(2),
      totalReceived: milestones
        .reduce((s, m) => s + Number(m.receivedAmount || 0), 0)
        .toFixed(2),
      currencyBreakdown: milestones.reduce((acc, m) => {
        const cur = m.expectedCurrency || 'INR';
        const prev = Number(acc[cur] || 0);
        acc[cur] = (prev + Number(m.expectedAmount || 0)).toFixed(2);
        return acc;
      }, {}),
    };
  return { milestones, total: resolvedTotal, limit, offset, summary: resolvedSummary };
}

// Install a fetchApi mock that always answers the upcoming endpoint with the
// most-recent payload. Tests opt-in to per-call shapes via mockResolvedValueOnce.
function installFetchMock(payload = makeResponse()) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url === 'string' && url.startsWith('/api/travel/payment-schedules/upcoming')) {
      if (payload instanceof Error) return Promise.reject(payload);
      return Promise.resolve(payload);
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
  try {
    localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'INR', locale: 'en-IN' }));
  } catch {
    /* jsdom always has localStorage; guard for completeness */
  }
  installFetchMock();
});

describe('<MilestoneTracker /> — page chrome', () => {
  it('renders the heading + 4 KPI cards (Pending / Partial / Paid / Overdue)', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Milestone Tracker/i }),
    ).toBeInTheDocument();
    // KPI labels appear as both card text AND status chip — use getAllByText.
    expect(screen.getAllByText(/Pending/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Partial/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Paid$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Overdue/i).length).toBeGreaterThanOrEqual(1);
    // KPI cards are role=group with aria-label "KPI <Label>" so we can target them deterministically.
    expect(screen.getByRole('group', { name: /KPI Pending/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /KPI Partial/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /KPI Paid/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /KPI Overdue/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) =>
          typeof url === 'string' && url.startsWith('/api/travel/payment-schedules/upcoming'),
        ),
      ).toBe(true);
    });
  });
});

describe('<MilestoneTracker /> — initial fetch + table render', () => {
  it('GETs /api/travel/payment-schedules/upcoming on mount with ?within=30 (default)', async () => {
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string' && url.startsWith('/api/travel/payment-schedules/upcoming'),
      );
      expect(call).toBeTruthy();
      expect(call[0]).toContain('within=30');
      expect(call[0]).toContain('limit=50');
      expect(call[0]).toContain('offset=0');
    });
  });

  it('renders milestone rows from the response payload', async () => {
    installFetchMock(
      makeResponse({
        milestones: [
          makeMilestone({ id: 1, invoiceNum: 'TINV-2026-0001', subBrand: 'tmc' }),
          makeMilestone({ id: 2, invoiceNum: 'TINV-2026-0007', subBrand: 'rfu', status: 'overdue', daysUntilDue: -3 }),
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText('TINV-2026-0001')).toBeInTheDocument();
    expect(screen.getByText('TINV-2026-0007')).toBeInTheDocument();
  });

  it('empty state: zero milestones → "No upcoming milestones in this window." copy', async () => {
    installFetchMock(makeResponse({ milestones: [] }));
    renderPage();
    expect(
      await screen.findByText(/No upcoming milestones in this window/i),
    ).toBeInTheDocument();
  });
});

describe('<MilestoneTracker /> — filter chrome', () => {
  it('status chip click ("Pending") re-fetches with ?status=pending', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    // Pending appears multiple times (KPI label, chip aria-label, row badge).
    // Use the chip's aria-label to disambiguate.
    fireEvent.click(
      screen.getByRole('button', { name: /Filter by status: Pending/i }),
    );
    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('status=pending'),
      );
      expect(filtered).toBeTruthy();
    });
  });

  it('window dropdown change (30 → 7) re-fetches with ?within=7', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Window \(days from now\)/i), {
      target: { value: '7' },
    });
    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('within=7'),
      );
      expect(filtered).toBeTruthy();
    });
  });

  it('"Overdue only" toggle re-fetches with ?overdueOnly=true and suppresses ?within=', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByLabelText(/Overdue only/i));
    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('overdueOnly=true'),
      );
      expect(filtered).toBeTruthy();
      // When overdueOnly is set, the page should NOT send ?within= per
      // backend contract (overdueOnly overrides ?within).
      expect(filtered[0]).not.toContain('within=');
    });
  });

  it('sub-brand dropdown change ("tmc") re-fetches with ?subBrand=tmc', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'tmc' },
    });
    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('subBrand=tmc'),
      );
      expect(filtered).toBeTruthy();
    });
  });
});

describe('<MilestoneTracker /> — pagination', () => {
  it('"Next" button re-fetches with offset=50 (PAGE_SIZE) when total > limit', async () => {
    // 120 total milestones, only the first 50 returned this call.
    installFetchMock(
      makeResponse({
        milestones: [makeMilestone()],
        total: 120,
      }),
    );
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    await waitFor(() => {
      const next = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('offset=50'),
      );
      expect(next).toBeTruthy();
    });
  });
});

describe('<MilestoneTracker /> — daysUntilDue display', () => {
  it('positive daysUntilDue renders as "N days"; zero renders as "Due today"; negative renders as "N days overdue"', async () => {
    installFetchMock(
      makeResponse({
        milestones: [
          makeMilestone({ id: 11, invoiceNum: 'TINV-2026-0011', daysUntilDue: 5, status: 'pending' }),
          makeMilestone({ id: 12, invoiceNum: 'TINV-2026-0012', daysUntilDue: 0, status: 'pending' }),
          makeMilestone({ id: 13, invoiceNum: 'TINV-2026-0013', daysUntilDue: -3, status: 'overdue' }),
        ],
      }),
    );
    renderPage();
    await screen.findByText('TINV-2026-0011');
    // Positive — "5 days"
    expect(screen.getByText('5 days')).toBeInTheDocument();
    // Zero — "Due today"
    expect(screen.getByText(/Due today/i)).toBeInTheDocument();
    // Negative — "3 days overdue"
    expect(screen.getByText(/3 days overdue/i)).toBeInTheDocument();
  });
});

describe('<MilestoneTracker /> — currency breakdown footer', () => {
  it('renders INR + USD currency breakdown entries from summary.currencyBreakdown', async () => {
    installFetchMock(
      makeResponse({
        milestones: [
          makeMilestone({ id: 21, invoiceNum: 'TINV-2026-0021', expectedAmount: '50000.00', expectedCurrency: 'INR' }),
          makeMilestone({ id: 22, invoiceNum: 'TINV-2026-0022', expectedAmount: '1200.00', expectedCurrency: 'USD' }),
        ],
        summary: {
          byStatus: { pending: 2 },
          totalExpected: '51200.00',
          totalReceived: '0.00',
          currencyBreakdown: { INR: '50000.00', USD: '1200.00' },
        },
      }),
    );
    renderPage();
    await screen.findByText('TINV-2026-0021');
    // The footer region carries data-currency attrs per (currency, amount)
    // entry — assert both are present.
    const inrEntry = await screen.findByText(/INR:/);
    expect(inrEntry).toBeInTheDocument();
    expect(inrEntry.getAttribute('data-currency')).toBe('INR');
    const usdEntry = screen.getByText(/USD:/);
    expect(usdEntry).toBeInTheDocument();
    expect(usdEntry.getAttribute('data-currency')).toBe('USD');
  });
});

describe('<MilestoneTracker /> — error path', () => {
  it('5xx response fires notify.error with the page-level message', async () => {
    const err = new Error('Internal Server Error');
    err.status = 500;
    installFetchMock(err);
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to load milestones/i);
  });

  it('4xx response does NOT fire page-level notify.error (only fetchApi auto-toast)', async () => {
    const err = new Error('Forbidden');
    err.status = 403;
    installFetchMock(err);
    renderPage();
    // Wait for the empty state to render — confirms the catch ran.
    expect(
      await screen.findByText(/No upcoming milestones in this window/i),
    ).toBeInTheDocument();
    // The page-level explicit toast is gated on >=500; 4xx falls through to
    // fetchApi's auto-toast only, so notify.error must NOT be called from
    // the SUT's own error branch.
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe('<MilestoneTracker /> — extended coverage (cron-extension)', () => {
  it('KPI card values reflect summary.byStatus counts (Pending=7 / Partial=3 / Paid=10 / Overdue=2)', async () => {
    installFetchMock(
      makeResponse({
        milestones: [makeMilestone({ id: 1, invoiceNum: 'TINV-K-001' })],
        total: 22,
        summary: {
          byStatus: { pending: 7, partial: 3, paid: 10, overdue: 2 },
          totalExpected: '999.00',
          totalReceived: '111.00',
          currencyBreakdown: { INR: '999.00' },
        },
      }),
    );
    renderPage();
    await screen.findByText('TINV-K-001');
    const pendingCard = screen.getByRole('group', { name: /KPI Pending/i });
    expect(pendingCard).toHaveTextContent('7');
    const partialCard = screen.getByRole('group', { name: /KPI Partial/i });
    expect(partialCard).toHaveTextContent('3');
    const paidCard = screen.getByRole('group', { name: /KPI Paid/i });
    expect(paidCard).toHaveTextContent('10');
    const overdueCard = screen.getByRole('group', { name: /KPI Overdue/i });
    expect(overdueCard).toHaveTextContent('2');
  });

  it('header copy pluralises: total=1 reads "1 milestone match" (singular); total=5 reads "5 milestones match"', async () => {
    installFetchMock(
      makeResponse({
        milestones: [makeMilestone({ id: 31, invoiceNum: 'TINV-P-001' })],
        total: 1,
      }),
    );
    const { unmount } = renderPage();
    await screen.findByText('TINV-P-001');
    expect(screen.getByText(/1 milestone match/i)).toBeInTheDocument();
    // Ensure it's the SINGULAR form — "1 milestones match" must not appear.
    expect(screen.queryByText(/1 milestones match/i)).toBeNull();
    unmount();

    // Re-mount with total=5 to assert plural form.
    fetchApiMock.mockReset();
    installFetchMock(
      makeResponse({
        milestones: [makeMilestone({ id: 32, invoiceNum: 'TINV-P-002' })],
        total: 5,
      }),
    );
    renderPage();
    await screen.findByText('TINV-P-002');
    expect(screen.getByText(/5 milestones match/i)).toBeInTheDocument();
  });

  it('"All" chip click after a status filter is set clears ?status= from the next fetch', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    // First narrow to pending so ?status=pending is in flight.
    fireEvent.click(
      screen.getByRole('button', { name: /Filter by status: Pending/i }),
    );
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) =>
          typeof url === 'string' && url.includes('status=pending'),
        ),
      ).toBe(true);
    });
    fetchApiMock.mockClear();
    // Then click "All" — ?status= should NOT appear in the next fetch.
    fireEvent.click(
      screen.getByRole('button', { name: /Filter by status: All/i }),
    );
    await waitFor(() => {
      const last = fetchApiMock.mock.calls.at(-1);
      expect(last).toBeTruthy();
      expect(last[0]).not.toContain('status=');
    });
  });

  it('window select is DISABLED when overdueOnly is checked, and re-enabled when unchecked', async () => {
    renderPage();
    await screen.findByText('TINV-2026-0001');
    const windowSelect = screen.getByLabelText(/Window \(days from now\)/i);
    expect(windowSelect).not.toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Overdue only/i));
    await waitFor(() => {
      expect(windowSelect).toBeDisabled();
    });
    // Untoggle — should re-enable.
    fireEvent.click(screen.getByLabelText(/Overdue only/i));
    await waitFor(() => {
      expect(windowSelect).not.toBeDisabled();
    });
  });

  it('"Previous" button: disabled at offset=0; enabled after Next; click re-fetches with offset=0', async () => {
    installFetchMock(
      makeResponse({
        milestones: [makeMilestone()],
        total: 200, // 4 pages
      }),
    );
    renderPage();
    await screen.findByText('TINV-2026-0001');
    const prevBtn = screen.getByRole('button', { name: /Previous page/i });
    expect(prevBtn).toBeDisabled();
    // Advance to offset=50.
    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) =>
          typeof url === 'string' && url.includes('offset=50'),
        ),
      ).toBe(true);
    });
    // After advancing, prev should be enabled.
    await waitFor(() => {
      expect(prevBtn).not.toBeDisabled();
    });
    fetchApiMock.mockClear();
    fireEvent.click(prevBtn);
    await waitFor(() => {
      const back = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string' && url.includes('offset=0'),
      );
      expect(back).toBeTruthy();
    });
  });

  it('changing a filter after Next-paginating resets offset to 0', async () => {
    installFetchMock(
      makeResponse({
        milestones: [makeMilestone()],
        total: 200,
      }),
    );
    renderPage();
    await screen.findByText('TINV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(([url]) =>
          typeof url === 'string' && url.includes('offset=50'),
        ),
      ).toBe(true);
    });
    fetchApiMock.mockClear();
    // Now flip the sub-brand filter — offset must reset to 0.
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'rfu' },
    });
    await waitFor(() => {
      const resetCall = fetchApiMock.mock.calls.find(([url]) =>
        typeof url === 'string'
          && url.includes('subBrand=rfu')
          && url.includes('offset=0'),
      );
      expect(resetCall).toBeTruthy();
    });
    // The SUT has TWO useEffects firing on a filter change: the load effect
    // sees the stale offset=50 once before the reset effect collapses it to
    // 0. After the dust settles, the FINAL call for ?subBrand=rfu must be
    // offset=0 — i.e. operator's view doesn't end up paginated past empty
    // results for the new filter.
    await waitFor(() => {
      const subBrandRfuCalls = fetchApiMock.mock.calls.filter(([url]) =>
        typeof url === 'string' && url.includes('subBrand=rfu'),
      );
      const lastRfuCall = subBrandRfuCalls.at(-1);
      expect(lastRfuCall).toBeTruthy();
      expect(lastRfuCall[0]).toContain('offset=0');
    });
  });

  it('milestone fallbacks: missing invoiceNum renders "#<invoiceId>"; null subBrand / milestoneOrder render "—"', async () => {
    installFetchMock(
      makeResponse({
        milestones: [
          makeMilestone({
            id: 41,
            invoiceId: 9999,
            invoiceNum: null,
            subBrand: null,
            milestoneOrder: null,
            daysUntilDue: null,
            dueDate: null,
          }),
        ],
      }),
    );
    renderPage();
    // invoiceNum fallback uses the invoiceId.
    expect(await screen.findByText('#9999')).toBeInTheDocument();
    // null subBrand / null milestoneOrder / null daysUntilDue / null dueDate
    // all collapse to "—" — at least four em-dash cells render.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  it('currency-breakdown footer is ABSENT when summary.currencyBreakdown is empty', async () => {
    installFetchMock(
      makeResponse({
        milestones: [],
        summary: {
          byStatus: {},
          totalExpected: '0.00',
          totalReceived: '0.00',
          currencyBreakdown: {}, // empty — footer must not render
        },
      }),
    );
    renderPage();
    await screen.findByText(/No upcoming milestones in this window/i);
    expect(screen.queryByLabelText(/Currency breakdown/i)).toBeNull();
    expect(screen.queryByText(/Currency breakdown \(this page\)/i)).toBeNull();
  });
});

function renderPage() {
  return render(<MilestoneTracker />);
}
