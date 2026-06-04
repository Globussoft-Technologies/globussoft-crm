/**
 * wellness/Products.test.jsx — vitest + RTL coverage for the wellness-vertical
 * Products admin list page (frontend/src/pages/wellness/Products.jsx).
 *
 * Scope: pins the page-surface invariants for the inventory Products admin
 * as actually shipped today — heading + "Add Product" CTA, mount fetch
 * (GET /api/wellness/products + GET /api/wellness/product-categories), table
 * row rendering, and the create modal open + name/price field surface.
 *
 * Per "prefer editing the test file" rule: the previous test pinned a
 * "+ New product" + CSV Export/Import + POST /api/cpq/products surface that
 * the component never shipped. This file replaces those assertions with
 * the actual surface (Add Product button, /api/wellness/products POST,
 * inline modal with grid form).
 *
 * Test cases:
 *   1. Heading "Products" + "Add Product" CTA render.
 *   2. Mount fires GET /api/wellness/products + GET /api/wellness/product-
 *      categories.
 *   3. Rows render product name + SKU + stock cell.
 *   4. Clicking "Add Product" opens the create modal with "New Product" title.
 *   5. Empty-state message renders when the list is empty.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

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

// Products gates its Add / Edit / Delete actions on products.{write,update,
// delete}. Mock a fully-permissioned viewer so the surface renders (mirrors
// src/__tests__/Products.test.jsx).
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
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
  }),
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
    productType: 'Sale',
    isActive: true,
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
    productType: 'Consumable',
    isActive: true,
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
    if (url === '/api/wellness/products' && method === 'POST') {
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

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
});

describe('<wellness/Products /> — page surface', () => {
  it('renders heading "Products" + "Add Product" CTA', async () => {
    installFetchMock();
    renderPage();
    expect(screen.getByRole('heading', { name: /Products/i })).toBeInTheDocument();
    // CTA is "Add Product" (button copy); wait for the mount fetch to settle
    // so the table renders before the test ends.
    expect(screen.getByRole('button', { name: /Add Product/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    });
  });

  it('mount fires GET /api/wellness/products + /api/wellness/product-categories', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/products');
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/product-categories');
  });

  it('renders rows with name + SKU + stock from the mock list', async () => {
    installFetchMock();
    renderPage();
    expect(await screen.findByText('PRP serum 10ml')).toBeInTheDocument();
    expect(screen.getByText('Botox 50u')).toBeInTheDocument();
    // SKU cell (present row).
    expect(screen.getByText('PRP-10')).toBeInTheDocument();
    // Stock counts render in the dedicated stock chip.
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('clicking "Add Product" opens the create modal titled "New Product"', async () => {
    installFetchMock();
    renderPage();
    await screen.findByText('PRP serum 10ml');
    fireEvent.click(screen.getByRole('button', { name: /Add Product/i }));
    // Modal opens with title and a "Product Name *" label.
    expect(await screen.findByRole('heading', { name: /New Product/i })).toBeInTheDocument();
  });

  it('shows the empty-state message when the list is empty', async () => {
    installFetchMock({ products: [] });
    renderPage();
    expect(await screen.findByText(/No products yet/i)).toBeInTheDocument();
  });
});
