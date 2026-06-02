/**
 * InventoryReceipts.test.jsx — vitest + RTL coverage for the wellness-vertical
 * inventory-receipts admin page (frontend/src/pages/wellness/InventoryReceipts.jsx).
 *
 * Drift pinned (test re-aligned to actual SUT 2026-05-27):
 *   - Default DateRangeFilter preset is 'all' (EMPTY_DATE_FILTER) → first GET
 *     URL is "/api/wellness/inventory/receipts" with NO ?from=&to= query
 *     string. (The earlier 'today' default in the test was wrong.)
 *   - Sub-copy: "<filtered> of <total> receipt(s) in window — total cost ₹<sum>"
 *     with the rupee total formatted via toLocaleString('en-IN') → ₹45,000
 *     (comma-grouped), not ₹45000.
 *   - Table columns are: Receipt # / Invoice # / Supplier / Tax ID / Product /
 *     Qty / Total / Received. No Unit cost column on the row table (visible in
 *     the detail modal only).
 *   - Currency formatting uses Indian grouping: 45000 → 45,000; 1500 → 1,500.
 *   - Empty search message: "No receipts match "<query>"." (literal interpolation
 *     in SUT line 272 — not "No receipts match your search.").
 *   - Mount fires THREE parallel GETs: receipts (no qs), products, vendors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Default to a fully-permissioned viewer so existing assertions on Record
// receipt / Edit / Delete buttons keep passing. The SUT now hides these
// when the viewer lacks inventory.{write,update,delete}.
const FULL_PERMS = {
  isReady: true,
  hasPermission: () => true,
  permissions: ['inventory.read', 'inventory.write', 'inventory.update', 'inventory.delete', 'inventory.manage'],
  roles: [],
  isOwner: false,
  userType: null,
  isLoading: false,
  error: null,
  refresh: () => Promise.resolve(),
  hasAllPermissions: () => true,
  hasAnyPermission: () => true,
};
const usePermissionsMock = vi.fn(() => FULL_PERMS);
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: (...args) => usePermissionsMock(...args),
}));

import InventoryReceipts from '../pages/wellness/InventoryReceipts';

const RECEIPT_DERMA = {
  id: 1101,
  receiptNumber: 'RCP-2026-00042',
  productId: 501,
  vendorId: 301,
  product: { id: 501, name: 'Derma Filler 1ml', sku: 'DF-1ML' },
  vendor: { id: 301, name: 'Sterile Supplies Pvt Ltd', phone: null, gstin: '27AAPCS1234A1Z5' },
  quantity: 10,
  unitCost: 4500,
  totalCost: 45000,
  batchNumber: 'B-2026-0517',
  receivedAt: '2026-05-17T10:00:00.000Z',
  createdAt: '2026-05-17T10:00:00.000Z',
  supplierInvoiceNumber: null,
  notes: null,
};
const RECEIPT_NEEDLES = {
  id: 1102,
  receiptNumber: 'RCP-2026-00043',
  productId: 502,
  vendorId: null,
  product: { id: 502, name: '30G Hypodermic Needles', sku: 'NDL-30G' },
  vendor: null,
  quantity: 200,
  unitCost: 7.5,
  totalCost: 1500,
  batchNumber: null,
  receivedAt: '2026-05-18T09:30:00.000Z',
  createdAt: '2026-05-18T09:30:00.000Z',
  supplierInvoiceNumber: null,
  notes: 'Restock for hub',
};

const ACTIVE_VENDOR = { id: 301, name: 'Sterile Supplies Pvt Ltd', isActive: true };
const INACTIVE_VENDOR = { id: 999, name: 'Legacy Pharma Distributors', isActive: false };

const PRODUCT_FILLER = { id: 501, name: 'Derma Filler 1ml', sku: 'DF-1ML' };
const PRODUCT_NEEDLE = { id: 502, name: '30G Hypodermic Needles', sku: 'NDL-30G' };

function installFetchMock({
  receipts = [RECEIPT_DERMA, RECEIPT_NEEDLES],
  products = [PRODUCT_FILLER, PRODUCT_NEEDLE],
  vendors = [ACTIVE_VENDOR, INACTIVE_VENDOR],
  receiptsPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (
      typeof url === 'string' &&
      url.startsWith('/api/wellness/inventory/receipts') &&
      method === 'GET'
    ) {
      if (receiptsPromise) return receiptsPromise;
      return Promise.resolve(receipts);
    }
    if (url === '/api/wellness/products' && method === 'GET') {
      return Promise.resolve(products);
    }
    if (url === '/api/wellness/vendors' && method === 'GET') {
      return Promise.resolve(vendors);
    }
    if (url === '/api/wellness/inventory/receipts' && method === 'POST') {
      return Promise.resolve({ id: 1199, receiptNumber: 'RCP-2026-00099' });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <InventoryReceipts />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
});
afterEach(() => {});

describe('<InventoryReceipts /> — page chrome', () => {
  it('renders heading "Inventory receipts" + "Record receipt" CTA + total-cost sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Inventory receipts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Record receipt/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ of \d+ receipts? in window.*total cost ₹/i.test(
            el?.textContent || '',
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading…" while the initial receipts GET is in flight', async () => {
    installFetchMock({ receiptsPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<InventoryReceipts /> — mount fetch + list render', () => {
  it('fires three parallel GETs on mount and renders receipt rows', async () => {
    installFetchMock();
    renderPage();
    // Default preset='all' → no ?from/?to qs. The receipts call is bare.
    await waitFor(() => {
      const receiptsCall = fetchApiMock.mock.calls.find(
        ([u]) =>
          typeof u === 'string' &&
          u === '/api/wellness/inventory/receipts',
      );
      expect(receiptsCall).toBeTruthy();
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/vendors');

    expect(await screen.findByText('RCP-2026-00042')).toBeInTheDocument();
    expect(screen.getByText('RCP-2026-00043')).toBeInTheDocument();
    expect(screen.getAllByText('Derma Filler 1ml').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('30G Hypodermic Needles').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Sterile Supplies Pvt Ltd')).toBeInTheDocument();
    // Em-dash fallback exists for the no-vendor / no-invoice columns.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    // Totals are en-IN grouped: 45000 → ₹45,000 ; 1500 → ₹1,500.
    expect(screen.getByText('₹45,000')).toBeInTheDocument();
    expect(screen.getByText('₹1,500')).toBeInTheDocument();
  });

  it('renders "No receipts in window." when receipts GET resolves to []; flips to interpolated "No receipts match \\"<term>\\"." copy when a search term has no hits', async () => {
    installFetchMock({ receipts: [] });
    renderPage();
    expect(
      await screen.findByText(/^No receipts in window\.$/),
    ).toBeInTheDocument();

    cleanup();
    fetchApiMock.mockReset();
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('RCP-2026-00042').length).toBeGreaterThanOrEqual(1);
    });
    const searchBox = screen.getByPlaceholderText(
      /Search by invoice #, supplier, product, batch…/,
    );
    fireEvent.change(searchBox, { target: { value: 'nonexistent-term-xyz' } });
    expect(
      await screen.findByText(/No receipts match "nonexistent-term-xyz"\./),
    ).toBeInTheDocument();
  });

  it('filters inactive vendors out of the form dropdown', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    const options = Array.from(document.querySelectorAll('select option')).map(
      (o) => o.textContent,
    );
    expect(options).toContain('Sterile Supplies Pvt Ltd');
    expect(options).not.toContain('Legacy Pharma Distributors');
  });
});

describe('<InventoryReceipts /> — free-text search', () => {
  it('narrows visible receipt rows client-side (case-insensitive across receipt # / supplier / product / batch / notes)', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    expect(screen.getByText('RCP-2026-00043')).toBeInTheDocument();

    const searchBox = screen.getByPlaceholderText(
      /Search by invoice #, supplier, product, batch…/,
    );
    fireEvent.change(searchBox, { target: { value: 'NEEDLES' } });
    await waitFor(() => {
      expect(screen.queryByText('RCP-2026-00042')).toBeNull();
    });
    expect(screen.getByText('RCP-2026-00043')).toBeInTheDocument();

    fireEvent.change(searchBox, { target: { value: 'B-2026-0517' } });
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    expect(screen.queryByText('RCP-2026-00043')).toBeNull();
  });
});

describe('<InventoryReceipts /> — form open/close + required fields', () => {
  it('"Record receipt" opens the form (label flips to "Cancel"); click again resets', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    expect(screen.getByPlaceholderText(/^Quantity$/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^Unit cost$/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^Batch number$/)).toBeInTheDocument();
    // The toggle button flipped to "Cancel".
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.queryByPlaceholderText(/^Quantity$/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /Record receipt/i }),
    ).toBeInTheDocument();
  });

  it('productId / quantity / unit-cost inputs carry the `required` attribute', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    const productSelects = document.querySelectorAll('select[required]');
    expect(productSelects.length).toBe(1);
    expect(screen.getByPlaceholderText(/^Quantity$/)).toBeRequired();
    expect(screen.getByPlaceholderText(/^Unit cost$/)).toBeRequired();
    expect(screen.getByPlaceholderText(/^Batch number$/)).not.toBeRequired();
    expect(screen.getByPlaceholderText(/^Notes$/)).not.toBeRequired();
  });
});

describe('<InventoryReceipts /> — create POST', () => {
  it('Submit → POST /api/wellness/inventory/receipts with coerced body + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('RCP-2026-00042')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Record receipt/i }));

    const productSelect = document.querySelector('select[required]');
    fireEvent.change(productSelect, { target: { value: '501' } });

    fireEvent.change(screen.getByPlaceholderText(/^Quantity$/), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Unit cost$/), {
      target: { value: '4500.50' },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Batch number$/), {
      target: { value: 'B-NEW-001' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Record receipt \+ update stock/i }),
    );

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/inventory/receipts' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        productId: 501,
        vendorId: null,
        quantity: 5,
        unitCost: 4500.5,
        batchNumber: 'B-NEW-001',
        expiryDate: null,
        notes: null,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Recorded.*RCP-2026-00099.*stock updated\./i),
    );
    const receiptsGets = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        typeof u === 'string' &&
        u.startsWith('/api/wellness/inventory/receipts') &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(receiptsGets.length).toBeGreaterThanOrEqual(2);
  });
});
