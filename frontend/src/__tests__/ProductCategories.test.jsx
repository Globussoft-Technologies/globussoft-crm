/**
 * ProductCategories.test.jsx — vitest + RTL coverage for the wellness-vertical
 * inventory ProductCategory admin page
 * (frontend/src/pages/wellness/ProductCategories.jsx).
 *
 * Drift pinned (test re-aligned to actual SUT 2026-05-27):
 *   - SUT renders modal-based CRUD (Add Category button → modal). No inline
 *     New-category form, no Cancel-toggle flip.
 *   - Heading is "Product Categories"; CTA is "Add Category", not "New
 *     category".
 *   - Loading copy is "Loading categories...", not bare "Loading…".
 *   - Empty-state: "No categories yet. Create one to organize your products."
 *   - Row layout is glass-card list — name in <h3>, "<N> products • <M>
 *     subcategories" inline (NOT separate parent column / status badge).
 *   - Edit/Trash buttons have no aria-labels — query via Pencil/Trash icons
 *     via document.querySelectorAll('button').
 *   - Delete uses notify.confirm({...}) — not native window.confirm.
 *   - Create payload shape: { name, parentId, imageUrl, color, isActive }.
 *   - Success toast: "Category created successfully" / "Category updated
 *     successfully" / "Category deleted".
 *   - Save button inside modal is labelled just "Save".
 *   - No top-of-page search input; no row-level filter; no inline parent-
 *     column rendering.
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

import ProductCategories from '../pages/wellness/ProductCategories';

const ROOT_CATEGORY = {
  id: 401,
  name: 'Consumables',
  parentId: null,
  isActive: true,
  imageUrl: null,
  color: null,
  _count: { products: 12, children: 2 },
};
const CHILD_CATEGORY = {
  id: 402,
  name: 'Syringes & Needles',
  parentId: 401,
  isActive: true,
  imageUrl: 'https://cdn.example.com/syringes.png',
  color: '#265855',
  _count: { products: 5, children: 0 },
};
const INACTIVE_CATEGORY = {
  id: 403,
  name: 'Discontinued Pharma',
  parentId: null,
  isActive: false,
  imageUrl: null,
  color: null,
  _count: { products: 0, children: 0 },
};

function installFetchMock({
  categories = [ROOT_CATEGORY, CHILD_CATEGORY, INACTIVE_CATEGORY],
  categoriesPromise = null,
  categoriesReject = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/product-categories' && method === 'GET') {
      if (categoriesPromise) return categoriesPromise;
      if (categoriesReject) return Promise.reject(categoriesReject);
      return Promise.resolve(categories);
    }
    if (/^\/api\/wellness\/product-categories(\/\d+)?$/.test(url)) {
      if (method === 'POST') return Promise.resolve({ id: 999 });
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ProductCategories />
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

describe('<ProductCategories /> — page chrome', () => {
  it('renders "Product Categories" heading + "Add Category" CTA', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Product Categories/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add Category/i }),
    ).toBeInTheDocument();
  });

  it('renders "Loading categories..." while the initial GET is in flight', async () => {
    installFetchMock({ categoriesPromise: new Promise(() => {}) });
    renderPage();
    expect(
      await screen.findByText(/^Loading categories\.\.\.$/),
    ).toBeInTheDocument();
  });
});

describe('<ProductCategories /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/product-categories on mount and renders rows', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/product-categories',
      );
    });
    expect(
      await screen.findByText('Syringes & Needles'),
    ).toBeInTheDocument();
    expect(screen.getByText('Discontinued Pharma')).toBeInTheDocument();
    expect(screen.getByText('Consumables')).toBeInTheDocument();
  });

  it('renders empty-state copy when GET resolves to []', async () => {
    installFetchMock({ categories: [] });
    renderPage();
    expect(
      await screen.findByText(/No categories yet\./i),
    ).toBeInTheDocument();
  });

  it('renders row sub-copy: "<products> products • <children> subcategories"', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    // Each row renders a single span with "<N> products • <M> subcategories".
    // The text cascades through parent elements' textContent, so use
    // getAllByText and assert ≥1 match for each pattern.
    expect(
      screen.getAllByText((_t, el) =>
        /12 products.*•.*2 subcategories/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) =>
        /5 products.*•.*0 subcategories/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('<ProductCategories /> — create flow', () => {
  it('Click "Add Category" → modal opens with empty name field + Save button', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Category/i }));
    expect(
      screen.getByRole('heading', { name: /New Category/i }),
    ).toBeInTheDocument();
    // Save button is labelled "Save" inside the modal.
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    // Cancel button is rendered too.
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
  });

  it('Blank name → notify.error + NO POST goes out', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Category/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Category name is required');
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) =>
        u === '/api/wellness/product-categories' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Save → POST /api/wellness/product-categories with payload shape + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Category/i }));

    // Two `input[type="text"]` elements now live on the page: the page-
    // level search input (SUT line 213) and the modal's Category Name
    // input (SUT line 378). Querying by `[type="text"]` and taking [0]
    // would hit the SEARCH box (DOM order: search comes before modal),
    // which would leave the name field empty and silently abort the
    // submit via the "name is required" guard. Pick the LAST text input —
    // the modal's Name field is always the most-recently-mounted text
    // input on the page.
    const nameInputs = document.querySelectorAll('input[type="text"]');
    const nameInput = nameInputs[nameInputs.length - 1];
    fireEvent.change(nameInput, {
      target: { value: 'Topical Anaesthetics' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/product-categories' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Topical Anaesthetics');
      expect(body.isActive).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      'Category created successfully',
    );
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u === '/api/wellness/product-categories' &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<ProductCategories /> — edit flow', () => {
  it('Edit (Pencil) on a row opens the modal pre-filled; Save → PUT /:id', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    // Find the Edit button on the "Syringes & Needles" row. The button
    // sits as a sibling of the .glass card whose <h3> contains the row name.
    // Each row renders 2 action buttons (Pencil + Trash) — Pencil is the
    // first button of each row group; we identify the row via its name <h3>.
    const rowName = screen.getByText('Syringes & Needles');
    const row = rowName.closest('.glass');
    const buttons = row.querySelectorAll('button');
    // First action button in the row is the Edit pencil; second is Trash.
    fireEvent.click(buttons[0]);

    // Modal heading flips to "Edit Category".
    expect(
      await screen.findByRole('heading', { name: /Edit Category/i }),
    ).toBeInTheDocument();

    // Pre-fill: the name input now reads 'Syringes & Needles'. Same
    // search-input collision as the create test — the page-level search
    // input is the FIRST text input in DOM order; the modal's Name field
    // is the LAST. Take the last.
    const allTextInputs = document.querySelectorAll('input[type="text"]');
    const nameInput = allTextInputs[allTextInputs.length - 1];
    expect(nameInput.value).toBe('Syringes & Needles');

    fireEvent.change(nameInput, {
      target: { value: 'Syringes & Needles (sterile)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/product-categories/402' &&
          opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Syringes & Needles (sterile)');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      'Category updated successfully',
    );
  });
});

describe('<ProductCategories /> — delete (notify.confirm)', () => {
  it('confirm()=true → DELETE /api/wellness/product-categories/:id + notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    // Click Trash button on the Consumables row.
    const row = screen.getByText('Consumables').closest('.glass');
    const buttons = row.querySelectorAll('button');
    // Second action button is the Trash.
    fireEvent.click(buttons[1]);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Delete category',
          message: expect.stringMatching(/Delete this category/),
        }),
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/product-categories/401' &&
          opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Category deleted');
  });

  it('confirm()=false → no DELETE fired + no notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Syringes & Needles')).toBeInTheDocument();
    });
    const row = screen.getByText('Consumables').closest('.glass');
    const buttons = row.querySelectorAll('button');
    fireEvent.click(buttons[1]);
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
