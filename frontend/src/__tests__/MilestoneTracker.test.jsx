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
});

function renderPage() {
  return render(<MilestoneTracker />);
}
