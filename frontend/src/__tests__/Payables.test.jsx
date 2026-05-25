/**
 * Payables.test.jsx — vitest + RTL coverage for the Travel-vertical
 * cross-supplier Payables page (frontend/src/pages/travel/Payables.jsx).
 *
 * Slice 6 (Arc 2 #903) — pins the page-surface invariants AFTER swapping
 * the per-supplier fan-out for the consolidated /api/travel/payables
 * endpoint (commit f7cfc364). The page now does a SINGLE GET per filter
 * change and consumes:
 *
 *   {
 *     payables: [{ id, supplierId, supplierName, supplierCategory,
 *                  subBrand, poNumber, description, amount, currency,
 *                  dueDate, status, paidAt, daysUntilDue, createdAt }],
 *     total, limit, offset,
 *     summary: { byStatus, totalPending, totalScheduled, totalPaid,
 *                currencyBreakdown }
 *   }
 *
 * Cases:
 *   1. Heading "All Payables" renders.
 *   2. Initial mount fires a SINGLE GET /api/travel/payables (no
 *      per-supplier fan-out — replaced this slice).
 *   3. KPI counts read from summary.byStatus (server is authoritative).
 *   4. KPI amounts read from summary.totalPending / totalScheduled /
 *      totalPaid.
 *   5. Status filter chip click pushes ?status=<value> into the URL.
 *   6. Sub-brand select pushes ?subBrand=<value>; supplierCategory
 *      pushes ?supplierCategory=<value>.
 *   7. dueFrom/dueTo push ?dueAfter / ?dueBefore.
 *   8. Supplier text search is CLIENT-SIDE — narrows the visible row set
 *      without re-fetching.
 *   9. Empty state ("No payables found") renders when response payables=[].
 *  10. Status badges render with the correct labels (pending / scheduled /
 *      paid / cancelled) — pinned by data-testid="payable-status-<id>".
 *  11. Days-until-due text is consumed from the server's daysUntilDue
 *      field (no client-side recompute) — positive=N days, zero=Due today,
 *      negative=N days overdue.
 *  12. Currency breakdown footer renders from summary.currencyBreakdown.
 *  13. 404 defensive fallback — endpoint not deployed → notify.error +
 *      empty state, NOT a crash.
 *  14. 5xx → notify.error generic "Failed to load payables — please try
 *      again."
 *  15. TODO marker for slice 6 is REMOVED from the source (no per-supplier
 *      fan-out comment, no `TODO #903 slice 6` directive remains).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a routing fn that resolves
 *     /api/travel/payables to a caller-provided payload.
 *   - useNotify returns a STABLE notifyObj reference for the whole file
 *     (Wave 11 cfb5789 / Wave 12 f59e91d — fresh per-call objects flap
 *     useCallback identity and infinite-render).
 *   - localStorage seeded with INR tenant so formatMoney has a baseline.
 *   - Path: flat __tests__/ — no travel/ subdir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import path from 'path';

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

import Payables from '../pages/travel/Payables';

// Helper: build a payable row (server-shape — flattened supplierName +
// supplierCategory + subBrand at the top level + server-computed
// daysUntilDue).
function makePayable(overrides = {}) {
  return {
    id: 101,
    supplierId: 1,
    supplierName: 'Hotel Alpha',
    supplierCategory: 'hotel',
    subBrand: 'tmc',
    poNumber: 'PO-2026-001',
    description: 'Room block October',
    amount: '50000.00',
    currency: 'INR',
    dueDate: '2026-07-01T00:00:00.000Z',
    status: 'pending',
    paidAt: null,
    daysUntilDue: 30,
    createdAt: '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

// Helper: build the /api/travel/payables response envelope.
function makePayablesResponse({
  payables = [],
  total = null,
  byStatus = null,
  totalPending = '0.00',
  totalScheduled = '0.00',
  totalPaid = '0.00',
  currencyBreakdown = {},
  limit = 50,
  offset = 0,
} = {}) {
  // If byStatus not supplied, derive it from the payable rows.
  let computedByStatus = byStatus;
  if (!computedByStatus) {
    computedByStatus = { pending: 0, scheduled: 0, paid: 0, cancelled: 0 };
    for (const p of payables) {
      const k = p.status || 'pending';
      computedByStatus[k] = (computedByStatus[k] || 0) + 1;
    }
  }
  return {
    payables,
    total: total == null ? payables.length : total,
    limit,
    offset,
    summary: {
      byStatus: computedByStatus,
      totalPending,
      totalScheduled,
      totalPaid,
      currencyBreakdown,
    },
  };
}

// Install a fetchApi mock that resolves any /api/travel/payables URL to
// the caller-supplied response. Tests pass `error` to make it reject
// with a given status, or `responseByMatcher` for per-URL routing (e.g.
// a status-filtered second call).
function installFetchMock({
  response = makePayablesResponse(),
  error = null,
  responseByMatcher = null,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url !== 'string') return Promise.resolve(null);
    if (!url.startsWith('/api/travel/payables')) {
      return Promise.resolve(null);
    }
    if (responseByMatcher) {
      for (const [matcher, resp] of responseByMatcher) {
        if (matcher.test(url)) return Promise.resolve(resp);
      }
    }
    if (error) return Promise.reject(error);
    return Promise.resolve(response);
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

describe('<Payables /> — page chrome', () => {
  it('renders the "All Payables" heading', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /All Payables/i }),
    ).toBeInTheDocument();
  });
});

describe('<Payables /> — consolidated endpoint fetch', () => {
  it('fires a single GET /api/travel/payables on mount (no per-supplier fan-out)', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [
          makePayable({ id: 101, supplierId: 1, supplierName: 'Hotel Alpha' }),
          makePayable({
            id: 201,
            supplierId: 2,
            supplierName: 'Hotel Beta',
            description: 'Flight charter',
          }),
        ],
      }),
    });
    renderPage();
    await waitFor(() => {
      const payablesCall = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/travel/payables'),
      );
      expect(payablesCall).toBeTruthy();
    });
    // Negative: no fan-out — the per-supplier /payables URL must NOT be hit.
    const fanOutCall = fetchApiMock.mock.calls.find(
      ([url]) =>
        typeof url === 'string' &&
        /^\/api\/travel\/suppliers\/\d+\/payables/.test(url),
    );
    expect(fanOutCall).toBeUndefined();
    // And the merged rows should render.
    expect(await screen.findByText('Room block October')).toBeInTheDocument();
    expect(screen.getByText('Flight charter')).toBeInTheDocument();
  });
});

describe('<Payables /> — KPI cards read from summary.byStatus', () => {
  it('counts come from summary.byStatus (server-authoritative)', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [],
        // Server-supplied counts — page should reflect these even if the
        // current-page row set is empty (e.g. an offset past the data).
        byStatus: { pending: 7, scheduled: 3, paid: 12, cancelled: 1 },
        totalPending: '14000.00',
        totalScheduled: '9000.00',
        totalPaid: '50000.00',
        total: 23,
      }),
    });
    renderPage();
    await waitFor(() => {
      const pendingCard = screen.getByRole('group', { name: /KPI Pending/i });
      expect(pendingCard.textContent).toContain('7');
    });
    expect(screen.getByRole('group', { name: /KPI Scheduled/i }).textContent).toContain('3');
    expect(screen.getByRole('group', { name: /KPI Paid/i }).textContent).toContain('12');
    expect(screen.getByRole('group', { name: /KPI Cancelled/i }).textContent).toContain('1');
  });

  it('amounts come from summary.totalPending / totalScheduled / totalPaid', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [],
        byStatus: { pending: 1, scheduled: 0, paid: 0, cancelled: 0 },
        totalPending: '12345.00',
        totalScheduled: '67800.00',
        totalPaid: '90123.00',
      }),
    });
    renderPage();
    // formatMoney rendering depends on locale; assert the numeric prefix
    // is visible in the pending card. Use Intl-loose match.
    await waitFor(() => {
      const pendingCard = screen.getByRole('group', { name: /KPI Pending/i });
      // 12,345 or 12345 — either way the digits should be there.
      expect(pendingCard.textContent).toMatch(/12,?345/);
    });
    const scheduledCard = screen.getByRole('group', { name: /KPI Scheduled/i });
    expect(scheduledCard.textContent).toMatch(/67,?800/);
    const paidCard = screen.getByRole('group', { name: /KPI Paid/i });
    expect(paidCard.textContent).toMatch(/90,?123/);
  });
});

describe('<Payables /> — status filter chip pushes ?status= to URL', () => {
  it('clicking "Paid" chip triggers a refetch with ?status=paid in the URL', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [makePayable({ id: 101, status: 'pending' })],
      }),
    });
    renderPage();
    await screen.findByText('Room block October');

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Filter by status: Paid/i }));

    await waitFor(() => {
      const paidCall = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.startsWith('/api/travel/payables') &&
          /[?&]status=paid(&|$)/.test(url),
      );
      expect(paidCall).toBeTruthy();
    });
  });
});

describe('<Payables /> — sub-brand + category filters push to URL', () => {
  it('sub-brand select pushes ?subBrand=<value>', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());

    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'rfu' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.startsWith('/api/travel/payables') &&
          /[?&]subBrand=rfu(&|$)/.test(url),
      );
      expect(call).toBeTruthy();
    });
  });

  it('supplierCategory select pushes ?supplierCategory=<value>', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());

    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by supplier category/i), {
      target: { value: 'hotel' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.startsWith('/api/travel/payables') &&
          /[?&]supplierCategory=hotel(&|$)/.test(url),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<Payables /> — date-range filter maps to dueAfter / dueBefore', () => {
  it('dueFrom value pushes ?dueAfter=<value>; dueTo pushes ?dueBefore=<value>', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());

    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Due date from/i), {
      target: { value: '2026-06-01' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.startsWith('/api/travel/payables') &&
          /[?&]dueAfter=2026-06-01(&|$)/.test(url),
      );
      expect(call).toBeTruthy();
    });

    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Due date to/i), {
      target: { value: '2026-07-31' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.startsWith('/api/travel/payables') &&
          /[?&]dueBefore=2026-07-31(&|$)/.test(url),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<Payables /> — supplier text search is client-side', () => {
  it('filters rows by case-insensitive substring on supplierName without re-fetching', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [
          makePayable({ id: 101, supplierId: 1, supplierName: 'Hotel Alpha', description: 'Alpha room block' }),
          makePayable({ id: 201, supplierId: 2, supplierName: 'Flight Charter Co', description: 'Charter booking' }),
        ],
      }),
    });
    renderPage();
    await screen.findByText('Alpha room block');
    expect(screen.getByText('Charter booking')).toBeInTheDocument();

    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Search supplier/i), {
      target: { value: 'alpha' },
    });
    await waitFor(() => {
      expect(screen.getByText('Alpha room block')).toBeInTheDocument();
      expect(screen.queryByText('Charter booking')).not.toBeInTheDocument();
    });
    // No new fetch should have fired — the search is client-side.
    expect(fetchApiMock).not.toHaveBeenCalled();
  });
});

describe('<Payables /> — empty state', () => {
  it('renders "No payables found" when the endpoint returns zero rows', async () => {
    installFetchMock({
      response: makePayablesResponse({ payables: [] }),
    });
    renderPage();
    expect(await screen.findByText(/No payables found/i)).toBeInTheDocument();
  });
});

describe('<Payables /> — status badges', () => {
  it('renders the status badge for each row with the right capitalised label', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [
          makePayable({ id: 101, status: 'pending' }),
          makePayable({ id: 102, status: 'scheduled' }),
          makePayable({ id: 103, status: 'paid' }),
          makePayable({ id: 104, status: 'cancelled' }),
        ],
      }),
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('payable-status-101')).toHaveTextContent(/pending/i);
    });
    expect(screen.getByTestId('payable-status-102')).toHaveTextContent(/scheduled/i);
    expect(screen.getByTestId('payable-status-103')).toHaveTextContent(/paid/i);
    expect(screen.getByTestId('payable-status-104')).toHaveTextContent(/cancelled/i);
  });
});

describe('<Payables /> — daysUntilDue consumed from server response', () => {
  it('renders the server-supplied daysUntilDue verbatim (no client recompute)', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [
          makePayable({ id: 201, description: 'Future', daysUntilDue: 5, status: 'pending' }),
          makePayable({ id: 202, description: 'Today', daysUntilDue: 0, status: 'pending' }),
          makePayable({ id: 203, description: 'Overdue', daysUntilDue: -3, status: 'pending' }),
        ],
      }),
    });
    renderPage();
    await screen.findByText('Future');
    expect(screen.getByText('5 days')).toBeInTheDocument();
    expect(screen.getByText(/Due today/i)).toBeInTheDocument();
    expect(screen.getByText(/3 days overdue/i)).toBeInTheDocument();
  });
});

describe('<Payables /> — currency breakdown footer', () => {
  it('renders currency breakdown read from summary.currencyBreakdown', async () => {
    installFetchMock({
      response: makePayablesResponse({
        payables: [
          makePayable({ id: 101, status: 'pending', amount: '10000.00', currency: 'INR' }),
          makePayable({ id: 102, status: 'pending', amount: '500.00', currency: 'USD' }),
        ],
        currencyBreakdown: { INR: '10000.00', USD: '500.00' },
      }),
    });
    renderPage();
    await screen.findByText(/Currency breakdown/i);
    const inrSpan = await screen.findByText((_, node) => node?.getAttribute?.('data-currency') === 'INR');
    expect(inrSpan).toBeInTheDocument();
    expect(inrSpan.textContent).toMatch(/INR/);
    const usdSpan = screen.getByText((_, node) => node?.getAttribute?.('data-currency') === 'USD');
    expect(usdSpan).toBeInTheDocument();
    expect(usdSpan.textContent).toMatch(/USD/);
  });
});

describe('<Payables /> — defensive 404 fallback', () => {
  it('endpoint not deployed yet → notify.error + empty state, NOT a crash', async () => {
    const err = new Error('Not Found');
    err.status = 404;
    installFetchMock({ error: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/not available/i);
    // Empty state should render — no crash.
    expect(await screen.findByText(/No payables found/i)).toBeInTheDocument();
  });
});

describe('<Payables /> — 5xx error path', () => {
  it('5xx on /api/travel/payables fires notify.error', async () => {
    const err = new Error('Internal Server Error');
    err.status = 500;
    installFetchMock({ error: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to load payables/i);
  });
});

describe('<Payables /> — slice 6 source hygiene', () => {
  it('source has the TODO #903 slice 6 marker REMOVED (fan-out retired)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../pages/travel/Payables.jsx'),
      'utf8',
    );
    expect(src).not.toMatch(/TODO #903 slice 6/);
  });
});

function renderPage() {
  return render(<Payables />);
}
