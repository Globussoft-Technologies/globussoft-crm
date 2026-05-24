/**
 * wellness/Products.test.jsx — vitest + RTL coverage for the wellness-vertical
 * Products admin list page (frontend/src/pages/wellness/Products.jsx).
 *
 * Scope (Zylu-Gap #933): pins the page-surface invariants for the inventory
 * Products admin — heading + CTAs, mount fetch, table-row rendering, the
 * "New product" form open/close + POST shape, CSV Export download flow,
 * and CSV Import file-picker.
 *
 * Test cases (6, per tick #195 floor):
 *   1. Heading "Products" + total counter + "New product" CTA render.
 *   2. Mount fires GET /api/wellness/products + GET /api/wellness/product-
 *      categories.
 *   3. Rows render name + SKU + price + stock from the mock list.
 *   4. Clicking "+ New product" opens the create form.
 *   5. Submitting the create form POSTs to /api/cpq/products (the only
 *      surfaced create endpoint for the shared Product model today — see
 *      Products.jsx header for why this isn't /api/wellness/products).
 *   6. CSV Export hits /api/csv/products/export.csv via raw fetch (auth
 *      header required, so not fetchApi). CSV Import button opens the
 *      hidden file picker via the wrapping <label>.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi + getAuthToken mocked at '../../utils/api' (relative to
 *     __tests__/wellness/) with stable fn refs.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useCallback / useEffect
 *     dep identity, causing infinite re-render hangs).
 *   - URL.createObjectURL / revokeObjectURL stubbed (jsdom does not
 *     implement them) — required by the CSV Export flow.
 *   - global.fetch stubbed (the CSV download uses raw fetch, not fetchApi).
 *
 * Drift note: Products.jsx ships list + Create + CSV today. Edit and Delete
 * are out of scope per the page header (no PUT/DELETE on the shared Product
 * model exposed yet); tests do not assert their absence so future expansion
 * doesn't have to rewrite tests, but the create POST is pinned to /api/cpq/
 * products to catch regressions if someone retargets it to a non-existent
 * /api/wellness/products POST endpoint.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// formatMoney imports from utils/money. Keep the real helper — it doesn't
// hit any browser APIs, but stub-by-default to keep the test deterministic
// across locales.
vi.mock('../../utils/money', () => ({
  formatMoney: (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
  currencySymbol: () => '₹',
}));

import Products from '../../pages/wellness/Products';

const SAMPLE_PRODUCTS = [
  {
    id: 11,
    name: 'PRP serum 10ml',
    sku: 'PRP-10',
    price: 1500,
    currentStock: 25,
    threshold: 10,
    categoryId: 401,
    description: null,
  },
  {
    id: 12,
    name: 'Botox 50u',
    sku: null,
    price: 15000,
    currentStock: 2,
    threshold: 5,
    categoryId: null,
    description: null,
  },
];

const SAMPLE_CATEGORIES = [
  { id: 401, name: 'Consumables', parentId: null, isActive: true },
];

function installFetchMock({ products = SAMPLE_PRODUCTS, categories = SAMPLE_CATEGORIES } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/products' && method === 'GET') {
      return Promise.resolve(products);
    }
    if (url === '/api/wellness/product-categories' && method === 'GET') {
      return Promise.resolve(categories);
    }
    if (url === '/api/cpq/products' && method === 'POST') {
      return Promise.resolve({ id: 999 });
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Products />
    </MemoryRouter>,
  );
}

// jsdom does not implement URL.createObjectURL / revokeObjectURL; the CSV
// Export flow calls both. Stub via direct assignment so the test doesn't
// throw mid-flight.
let originalCreateObjectURL;
let originalRevokeObjectURL;
let originalFetch;

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();

  originalCreateObjectURL = global.URL.createObjectURL;
  originalRevokeObjectURL = global.URL.revokeObjectURL;
  global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = vi.fn();

  originalFetch = global.fetch;
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob(['name,sku\n'], { type: 'text/csv' })),
      json: () => Promise.resolve({ imported: 0 }),
    }),
  );
});

afterEach(() => {
  global.URL.createObjectURL = originalCreateObjectURL;
  global.URL.revokeObjectURL = originalRevokeObjectURL;
  global.fetch = originalFetch;
});

describe('<wellness/Products /> — page surface', () => {
  it('renders heading "Products" + total counter + "New product" CTA', async () => {
    installFetchMock();
    renderPage();
    expect(screen.getByRole('heading', { name: /Products/i })).toBeInTheDocument();
    // Total counter resolves async after the mount fetch — findByText.
    expect(await screen.findByText(/2 products/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New product/i })).toBeInTheDocument();
  });

  it('mounts fire GET /api/wellness/products + /api/wellness/product-categories', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/product-categories');
  });

  it('renders rows with name / SKU / price / stock from the mock list', async () => {
    installFetchMock();
    renderPage();
    // findByText for the first row name — pins async render after mount fetch.
    expect(await screen.findByText('PRP serum 10ml')).toBeInTheDocument();
    expect(screen.getByText('Botox 50u')).toBeInTheDocument();
    // SKU cells — present row has SKU, missing-SKU row renders em-dash.
    expect(screen.getByText('PRP-10')).toBeInTheDocument();
    // Price — formatMoney mock renders Indian-grouped digits.
    expect(screen.getByText('₹1,500')).toBeInTheDocument();
    expect(screen.getByText('₹15,000')).toBeInTheDocument();
    // Stock counts — at least the two row stock values render somewhere.
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('clicking "+ New product" opens the create form', async () => {
    installFetchMock();
    renderPage();
    await screen.findByText('PRP serum 10ml');
    // Pre-click: name input should NOT be in the DOM.
    expect(screen.queryByPlaceholderText(/PRP serum 10ml/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New product/i }));
    // Form open: the name input placeholder + a Create CTA appear.
    expect(screen.getByPlaceholderText(/Name — e\.g\. PRP serum 10ml/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create product/i })).toBeInTheDocument();
    // CTA label flipped to Cancel.
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
  });

  it('submitting the create form POSTs to /api/cpq/products', async () => {
    installFetchMock();
    renderPage();
    await screen.findByText('PRP serum 10ml');
    fireEvent.click(screen.getByRole('button', { name: /New product/i }));

    // Fill out the form — name + price are required by client-side guard.
    fireEvent.change(screen.getByLabelText('Product name'), {
      target: { value: 'Hair growth tonic 50ml' },
    });
    fireEvent.change(screen.getByLabelText('Product price'), {
      target: { value: '1200' },
    });

    // Click Create product. We submit the form via the submit button.
    fireEvent.click(screen.getByRole('button', { name: /Create product/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/cpq/products' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      // Body shape pin — name + price are in the POSTed payload.
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Hair growth tonic 50ml');
      expect(body.price).toBe(1200);
    });
  });

  it('Export CSV hits /api/csv/products/export.csv; Import CSV opens the picker', async () => {
    installFetchMock();
    renderPage();
    // Wait for products to render so the Export button isn't disabled (the
    // CTA is gated on products.length > 0).
    await screen.findByText('PRP serum 10ml');

    const exportBtn = screen.getByRole('button', { name: /Export CSV/i });
    expect(exportBtn).toBeInTheDocument();
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
      const fetchCall = global.fetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/csv/products/export.csv',
      );
      expect(fetchCall).toBeTruthy();
    });

    // CSV Import: the file input is hidden inside a <label>. Verify the
    // input exists with the right accept attribute (the user-facing "open
    // the picker" effect happens via native browser behaviour when the
    // label is clicked; jsdom + RTL can't observe that, but the input is
    // the load-bearing surface).
    const importInput = screen.getByLabelText(/Import products CSV file/i);
    expect(importInput).toBeInTheDocument();
    expect(importInput.getAttribute('type')).toBe('file');
    expect(importInput.getAttribute('accept')).toMatch(/csv/i);
  });
});
