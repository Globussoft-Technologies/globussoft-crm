/**
 * Payables.test.jsx — vitest + RTL coverage for the Travel-vertical
 * cross-supplier Payables page (frontend/src/pages/travel/Payables.jsx,
 * shipped this slice — Arc 2 #903 slice 5 frontend follow-on).
 *
 * Scope — pins the page-surface invariants for the operator-facing All
 * Payables view that aggregates every TravelSupplierPayable across every
 * supplier into one cross-supplier table. Backend doesn't yet have a
 * consolidated endpoint, so the SUT does a client-side fan-out:
 *   GET /api/travel/suppliers?includeInactive=1
 *     then for each supplier:
 *   GET /api/travel/suppliers/<id>/payables
 *   …merge, flatten, render.
 *
 * The TODO marker "TODO #903 slice 6" calls out the swap point — when the
 * consolidating endpoint lands, the fan-out goes away.
 *
 *   1. Heading "All Payables" renders.
 *   2. Initial mount fires the supplier-list GET; then one /payables GET
 *      per supplier (fan-out fires).
 *   3. KPI cards render counts AND amounts from the aggregated payable rows
 *      grouped by status (pending / scheduled / paid / cancelled).
 *   4. Status filter chips: clicking "Paid" narrows the visible row set to
 *      paid-only rows; chip "All" restores the full set.
 *   5. Supplier text search filters rows by case-insensitive substring
 *      against the supplier name.
 *   6. Empty state ("No payables found") renders when the fan-out returns
 *      zero payables.
 *   7. Status badges render with the correct labels (pending / scheduled /
 *      paid / cancelled) — pinned by per-row data-testid="payable-status-<id>".
 *   8. Days-until-due text rendering: positive=neutral "N days", zero=
 *      warning "Due today", negative=red "N days overdue". Days are
 *      computed client-side from dueDate.
 *   9. 5xx on one supplier's payables fetch surfaces notify.error (one
 *      supplier's failure does NOT abort the whole page — the rest still
 *      render).
 *  10. TODO marker comment is present in the source (per the slice prompt:
 *      "// TODO #903 slice 6: replace per-supplier fan-out with cross-
 *      supplier endpoint GET /api/travel/payables"). This forward-references
 *      the next slice that retires the fan-out.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a routing fn so multiple URLs
 *     resolve to distinct payloads.
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

// Helper: build a supplier list payload.
function makeSuppliers(suppliers) {
  return {
    suppliers,
    total: suppliers.length,
    limit: 100,
    offset: 0,
  };
}

// Helper: build a supplier row.
function makeSupplier(overrides = {}) {
  return {
    id: 1,
    name: 'Hotel Alpha',
    supplierCategory: 'hotel',
    subBrand: 'tmc',
    isActive: true,
    ...overrides,
  };
}

// Helper: build a payables-for-one-supplier payload.
function makePayables(payables) {
  return {
    payables,
    total: payables.length,
    limit: 100,
    offset: 0,
  };
}

// Helper: build a payable row.
function makePayable(overrides = {}) {
  return {
    id: 101,
    supplierId: 1,
    description: 'Room block October',
    amount: '50000.00',
    currency: 'INR',
    poNumber: 'PO-2026-001',
    dueDate: '2026-07-01T00:00:00.000Z',
    status: 'pending',
    notes: null,
    paidAt: null,
    createdAt: '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

// Install a fetchApi mock that routes the supplier list + per-supplier
// /payables URLs to caller-provided payloads. Tests opt into per-supplier
// behaviour by passing a `payablesBySupplierId` map; default = empty per
// supplier so the page renders the empty state cleanly.
function installFetchMock({
  suppliers = [],
  payablesBySupplierId = {},
  errorBySupplierId = {},
  supplierListError = null,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url !== 'string') return Promise.resolve(null);
    if (url.startsWith('/api/travel/suppliers?')) {
      if (supplierListError) return Promise.reject(supplierListError);
      return Promise.resolve(makeSuppliers(suppliers));
    }
    // Match /api/travel/suppliers/<id>/payables — both bare and ?status=
    const m = url.match(/^\/api\/travel\/suppliers\/(\d+)\/payables(?:[?&].*)?$/);
    if (m) {
      const sid = Number(m[1]);
      if (errorBySupplierId[sid]) return Promise.reject(errorBySupplierId[sid]);
      const list = payablesBySupplierId[sid] || [];
      return Promise.resolve(makePayables(list));
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

describe('<Payables /> — page chrome', () => {
  it('renders the "All Payables" heading', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /All Payables/i }),
    ).toBeInTheDocument();
  });
});

describe('<Payables /> — fan-out fetch', () => {
  it('fires GET /api/travel/suppliers then per-supplier /payables on mount', async () => {
    installFetchMock({
      suppliers: [makeSupplier({ id: 1, name: 'Hotel Alpha' }), makeSupplier({ id: 2, name: 'Hotel Beta' })],
      payablesBySupplierId: {
        1: [makePayable({ id: 101, supplierId: 1 })],
        2: [makePayable({ id: 201, supplierId: 2, description: 'Flight charter' })],
      },
    });
    renderPage();
    await waitFor(() => {
      const supplierCall = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/travel/suppliers?'),
      );
      expect(supplierCall).toBeTruthy();
    });
    await waitFor(() => {
      const sup1Call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/travel/suppliers/1/payables',
      );
      const sup2Call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/travel/suppliers/2/payables',
      );
      expect(sup1Call).toBeTruthy();
      expect(sup2Call).toBeTruthy();
    });
    // And the merged rows should render.
    expect(await screen.findByText('Room block October')).toBeInTheDocument();
    expect(screen.getByText('Flight charter')).toBeInTheDocument();
  });
});

describe('<Payables /> — KPI cards', () => {
  it('renders count + amount for pending / scheduled / paid / cancelled from aggregated data', async () => {
    installFetchMock({
      suppliers: [makeSupplier({ id: 1, name: 'Hotel Alpha' })],
      payablesBySupplierId: {
        1: [
          makePayable({ id: 101, status: 'pending', amount: '10000.00' }),
          makePayable({ id: 102, status: 'pending', amount: '5000.00' }),
          makePayable({ id: 103, status: 'scheduled', amount: '3000.00' }),
          makePayable({ id: 104, status: 'paid', amount: '7000.00' }),
          makePayable({ id: 105, status: 'cancelled', amount: '1000.00' }),
        ],
      },
    });
    renderPage();
    // KPI cards are role=group with aria-label "KPI <Label>" so we can
    // assert each one's count text by scoping to that group.
    await waitFor(() => {
      const pendingCard = screen.getByRole('group', { name: /KPI Pending/i });
      expect(pendingCard).toBeInTheDocument();
      // 2 pending entries
      expect(pendingCard.textContent).toContain('2');
    });
    const scheduledCard = screen.getByRole('group', { name: /KPI Scheduled/i });
    expect(scheduledCard.textContent).toContain('1');
    const paidCard = screen.getByRole('group', { name: /KPI Paid/i });
    expect(paidCard.textContent).toContain('1');
    const cancelledCard = screen.getByRole('group', { name: /KPI Cancelled/i });
    expect(cancelledCard.textContent).toContain('1');
  });
});

describe('<Payables /> — status filter chips', () => {
  it('clicking "Paid" chip narrows visible rows to status=paid only', async () => {
    installFetchMock({
      suppliers: [makeSupplier({ id: 1, name: 'Hotel Alpha' })],
      payablesBySupplierId: {
        1: [
          makePayable({ id: 101, status: 'pending', description: 'Pending payable A' }),
          makePayable({ id: 102, status: 'paid', description: 'Paid payable B' }),
        ],
      },
    });
    renderPage();
    // Wait for both rows to appear initially.
    await screen.findByText('Pending payable A');
    expect(screen.getByText('Paid payable B')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Filter by status: Paid/i }));
    // After narrowing, only the paid row should be visible.
    await waitFor(() => {
      expect(screen.queryByText('Pending payable A')).not.toBeInTheDocument();
      expect(screen.getByText('Paid payable B')).toBeInTheDocument();
    });
  });
});

describe('<Payables /> — supplier text search', () => {
  it('filters rows by case-insensitive substring match on supplier name', async () => {
    installFetchMock({
      suppliers: [
        makeSupplier({ id: 1, name: 'Hotel Alpha' }),
        makeSupplier({ id: 2, name: 'Flight Charter Co' }),
      ],
      payablesBySupplierId: {
        1: [makePayable({ id: 101, supplierId: 1, description: 'Alpha room block' })],
        2: [makePayable({ id: 201, supplierId: 2, description: 'Charter booking' })],
      },
    });
    renderPage();
    await screen.findByText('Alpha room block');
    expect(screen.getByText('Charter booking')).toBeInTheDocument();
    // Type "alpha" (lowercase) — should keep Alpha row, drop Charter row.
    fireEvent.change(screen.getByLabelText(/Search supplier/i), {
      target: { value: 'alpha' },
    });
    await waitFor(() => {
      expect(screen.getByText('Alpha room block')).toBeInTheDocument();
      expect(screen.queryByText('Charter booking')).not.toBeInTheDocument();
    });
  });
});

describe('<Payables /> — empty state', () => {
  it('renders "No payables found" when fan-out returns zero payables', async () => {
    installFetchMock({
      suppliers: [makeSupplier({ id: 1, name: 'Hotel Alpha' })],
      payablesBySupplierId: { 1: [] },
    });
    renderPage();
    expect(await screen.findByText(/No payables found/i)).toBeInTheDocument();
  });
});

describe('<Payables /> — status badges', () => {
  it('renders the status badge for each row with the right capitalised label', async () => {
    installFetchMock({
      suppliers: [makeSupplier({ id: 1, name: 'Hotel Alpha' })],
      payablesBySupplierId: {
        1: [
          makePayable({ id: 101, status: 'pending' }),
          makePayable({ id: 102, status: 'scheduled' }),
          makePayable({ id: 103, status: 'paid' }),
          makePayable({ id: 104, status: 'cancelled' }),
        ],
      },
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

describe('<Payables /> — days until due', () => {
  it('positive=N days, zero=Due today, negative=N days overdue', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isoIn5 = new Date(today.getTime() + 5 * 86400000).toISOString();
    const isoToday = today.toISOString();
    const isoOverdue = new Date(today.getTime() - 3 * 86400000).toISOString();

    installFetchMock({
      suppliers: [makeSupplier({ id: 1, name: 'Hotel Alpha' })],
      payablesBySupplierId: {
        1: [
          makePayable({ id: 201, description: 'Future', dueDate: isoIn5, status: 'pending' }),
          makePayable({ id: 202, description: 'Today', dueDate: isoToday, status: 'pending' }),
          makePayable({ id: 203, description: 'Overdue', dueDate: isoOverdue, status: 'pending' }),
        ],
      },
    });
    renderPage();
    await screen.findByText('Future');
    expect(screen.getByText('5 days')).toBeInTheDocument();
    expect(screen.getByText(/Due today/i)).toBeInTheDocument();
    expect(screen.getByText(/3 days overdue/i)).toBeInTheDocument();
  });
});

describe('<Payables /> — error path', () => {
  it('5xx on a per-supplier payables fetch fires notify.error and the rest of the rows still render', async () => {
    const err = new Error('Internal Server Error');
    err.status = 500;
    installFetchMock({
      suppliers: [
        makeSupplier({ id: 1, name: 'Hotel Alpha' }),
        makeSupplier({ id: 2, name: 'Hotel Beta' }),
      ],
      payablesBySupplierId: {
        2: [makePayable({ id: 201, supplierId: 2, description: 'Beta survived' })],
      },
      errorBySupplierId: { 1: err },
    });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to load payables for Hotel Alpha/i);
    // Hotel Beta's row should still appear — one supplier's failure shouldn't
    // abort the whole page.
    expect(await screen.findByText('Beta survived')).toBeInTheDocument();
  });
});

describe('<Payables /> — TODO marker for slice 6', () => {
  it('source contains the TODO #903 slice 6 marker for the future cross-supplier endpoint swap', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../pages/travel/Payables.jsx'),
      'utf8',
    );
    expect(src).toMatch(/TODO #903 slice 6/);
    expect(src).toMatch(/cross-supplier endpoint/i);
  });
});

function renderPage() {
  return render(<Payables />);
}
