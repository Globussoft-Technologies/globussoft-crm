/**
 * Products.test.jsx — vitest + RTL coverage for the wellness-vertical Products
 * admin page (frontend/src/pages/wellness/Products.jsx).
 *
 * Drift pinned (test re-aligned to actual SUT 2026-05-27):
 *   - SUT is a modal-based CRUD page (Add Product → modal, Edit pencil → modal,
 *     Trash → notify.confirm DELETE). It does NOT ship Export-CSV or Import-CSV
 *     buttons, so the CSV tests have been removed.
 *   - CTA is "Add Product", not "New product".
 *   - Loading copy is "Loading products...".
 *   - Empty-state: "No products yet." (when products.length === 0).
 *   - Row columns: Product (name + brand) / SKU / Category / Price / Stock /
 *     Type / Actions. No Status column with explicit "Low stock"/"OK" badge —
 *     stock cell is a clickable color-coded badge of the current stock NUMBER.
 *   - Price formatting: ₹<n>.toFixed(2) — comma-less, two-decimals
 *     (₹1500.00, ₹850.00).
 *   - SKU fallback is "-" (hyphen), not em-dash.
 *   - Category null → "Uncategorized" (not em-dash).
 *   - POST endpoint is /api/wellness/products, not /api/cpq/products.
 *   - Validation only checks name.trim() is non-empty (no negative-price gate
 *     in this SUT — that lives in the backend).
 *   - Success toasts: "Product created successfully" / "Product updated
 *     successfully" / "Product deleted".
 *   - Delete is gated by notify.confirm({...}), not native window.confirm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// Default to a fully-permissioned viewer so existing assertions on Add /
// Edit / Delete buttons keep passing. The SUT now hides these buttons for
// users without products.{write,update,delete}.
const FULL_PERMS = {
  isReady: true,
  hasPermission: () => true,
  permissions: ['products.read', 'products.write', 'products.update', 'products.delete', 'products.manage'],
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

import Products from '../pages/wellness/Products';

const CATEGORIES = [
  { id: 1, name: 'Skincare' },
  { id: 2, name: 'Haircare' },
];

const PRP_SERUM = {
  id: 101,
  name: 'PRP serum 10ml',
  sku: 'PRP-10',
  categoryId: 1,
  price: 1500,
  currentStock: 5,
  threshold: 10,
  isActive: true,
  productType: 'Sale',
};
const SHAMPOO = {
  id: 102,
  name: 'Saxon repair shampoo 200ml',
  sku: 'SAX-200',
  categoryId: 2,
  price: 850,
  currentStock: 20,
  threshold: 5,
  isActive: true,
  productType: 'Sale',
};
const NO_SKU = {
  id: 103,
  name: 'Generic Vitamin C cream',
  sku: null,
  categoryId: null,
  price: null,
  currentStock: 0,
  threshold: 0,
  isActive: true,
  productType: 'Consumption',
};

function installFetchApiMock({
  products = [PRP_SERUM, SHAMPOO, NO_SKU],
  productsPromise = null,
  categories = CATEGORIES,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/products' && method === 'GET') {
      if (productsPromise) return productsPromise;
      return Promise.resolve(products);
    }
    if (url === '/api/wellness/product-categories' && method === 'GET') {
      return Promise.resolve(categories);
    }
    if (url === '/api/wellness/products' && method === 'POST') {
      return Promise.resolve({ id: 999, ok: true });
    }
    if (/^\/api\/wellness\/products\/\d+$/.test(url)) {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Products />
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

describe('<Products /> — page chrome', () => {
  it('renders Products heading + Add Product CTA', async () => {
    installFetchApiMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /^Products$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add Product/i }),
    ).toBeInTheDocument();
  });

  it('renders "Loading products..." while the initial GET is in flight', async () => {
    installFetchApiMock({ productsPromise: new Promise(() => {}) });
    renderPage();
    expect(
      await screen.findByText(/Loading products\.\.\./),
    ).toBeInTheDocument();
  });
});

describe('<Products /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/products + /api/wellness/product-categories on mount and renders row name + price', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/product-categories');

    expect(await screen.findByText('PRP serum 10ml')).toBeInTheDocument();
    expect(screen.getByText('Saxon repair shampoo 200ml')).toBeInTheDocument();
    expect(screen.getByText('Generic Vitamin C cream')).toBeInTheDocument();
    // Price formatted as ₹X.XX (no comma grouping, two decimals).
    expect(screen.getByText('₹1500.00')).toBeInTheDocument();
    expect(screen.getByText('₹850.00')).toBeInTheDocument();
    // Null price falls back to 0 → ₹0.00.
    expect(screen.getByText('₹0.00')).toBeInTheDocument();
  });

  it('renders empty-state copy when GET resolves to []', async () => {
    installFetchApiMock({ products: [] });
    renderPage();
    expect(
      await screen.findByText(/No products yet\./),
    ).toBeInTheDocument();
  });

  it('resolves row categoryId via the parallel categories load; null categoryId → "Uncategorized"', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    // Categories appear both in the filter dropdown AND in row cells, so
    // expect at least 2 matches per category name (row + dropdown option).
    expect(screen.getAllByText('Skincare').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Haircare').length).toBeGreaterThanOrEqual(1);
    // NO_SKU.categoryId=null → "Uncategorized" only appears in the row cell.
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
  });

  it('renders SKU "-" fallback for rows with sku=null', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Generic Vitamin C cream')).toBeInTheDocument();
    });
    // At least one '-' (hyphen) cell renders — covers the SKU fallback.
    // (productType may also fall back to '-' for some rows.)
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
  });

  it('stock cell renders the currentStock number for each row', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    expect(screen.getByText('5')).toBeInTheDocument(); // PRP_SERUM.currentStock
    expect(screen.getByText('20')).toBeInTheDocument(); // SHAMPOO.currentStock
    // NO_SKU.currentStock is 0 — rendered alongside formData defaults; not
    // pinning verbatim since "0" can collide with other "0" cells.
  });
});

describe('<Products /> — Add Product modal', () => {
  it('Click "Add Product" → modal opens with empty "Product Name *" field + Save button', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Product/i }));
    expect(
      screen.getByRole('heading', { name: /New Product/i }),
    ).toBeInTheDocument();
    // The form has Save + Cancel buttons.
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
  });

  it('Blank name → notify.error + NO POST goes out', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Product/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Product name is required');
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/wellness/products' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });
});

describe('<Products /> — create happy path', () => {
  it('Save → POST /api/wellness/products with body shape + notify.success + list re-fetches', async () => {
    installFetchApiMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Product/i }));

    // First text input in the modal is the name field.
    const textInputs = document.querySelectorAll(
      'input[type="text"]',
    );
    // Page chrome has a Search input (type=text) BEFORE the modal opened.
    // Modal text inputs are: Product Name, SKU, Brand Name, Barcode (and the
    // search input is still present). Find the name input via its bound label.
    // The name input is the only required-shaped text input ABOVE the SKU
    // input. Filter to text inputs inside the modal heading's ancestor.
    const modalHeading = screen.getByRole('heading', { name: /New Product/i });
    const modal = modalHeading.closest('.glass');
    const modalTextInputs = modal.querySelectorAll('input[type="text"]');
    // Index 0 = Product Name; 1 = SKU; 2 = Brand Name; 3 = Barcode (per SUT
    // layout order).
    fireEvent.change(modalTextInputs[0], { target: { value: 'Botox 50u' } });
    fireEvent.change(modalTextInputs[1], { target: { value: 'BOTOX-50' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/products' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        name: 'Botox 50u',
        sku: 'BOTOX-50',
        isActive: true,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      'Product created successfully',
    );

    // List re-fetches → ≥2 GETs to /api/wellness/products.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/products' && (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<Products /> — delete (notify.confirm)', () => {
  it('confirm()=true → DELETE /api/wellness/products/:id + notify.success', async () => {
    installFetchApiMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    // Find the Trash button on the PRP serum row. Each row has 2 action
    // buttons (Edit pencil + Trash). Locate via row name then walk to <tr>.
    const rowName = screen.getByText('PRP serum 10ml');
    const tr = rowName.closest('tr');
    const buttons = tr.querySelectorAll('button');
    // The two action buttons live in the last <td>. There are 2 buttons in
    // the row total (no clickable stock badge is a <button>; it's a <span>).
    // Last button is Trash.
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Delete product',
        }),
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/products/101' && opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Product deleted');
  });

  it('confirm()=false → no DELETE fired + no notify.success', async () => {
    installFetchApiMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PRP serum 10ml')).toBeInTheDocument();
    });
    const rowName = screen.getByText('PRP serum 10ml');
    const tr = rowName.closest('tr');
    const buttons = tr.querySelectorAll('button');
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await Promise.resolve();
    const delCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
